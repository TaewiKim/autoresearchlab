from __future__ import annotations

import argparse
import base64
import bz2
import gzip
import hashlib
import importlib.util
import json
import lzma
import math
import os
import re
import subprocess
import sys
import time
import traceback
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .io_utils import _slugify, _write_json
from .pip_install import _maybe_install_blueprint_packages
from .blueprint_model import Blueprint
from .execution_model import BlueprintExecution, _extract_metrics_from_stdout, _scan_blueprint_artifacts

if __package__ == "python_stats_lib":
    from research_llm import research_api_environment
else:
    from ..research_llm import research_api_environment


# A blueprint that decodes itself at runtime cannot be reviewed, cannot be
# diffed, and -- measured on cycle-g-v86 -- cannot be reproduced by the model
# that wrote it. runner-44/-45/-46 shipped an identical 7,920-character base64
# gzip blob whose DEFLATE payload produced zero bytes before erroring, and -47 a
# 10,392-character one that failed the same way. Refuse the shape up front, with
# a message the analyst can act on.
_SELF_EXTRACTING_MARKERS = (
    "gzip.decompress",
    "zlib.decompress",
    "bz2.decompress",
    "lzma.decompress",
    "base64.b64decode",
    "base64.b85decode",
    "codecs.decode",
)


def _self_extracting_blueprint_reason(source: str) -> Optional[str]:
    """Why this script cannot be accepted as written, or None if it is fine."""
    text = source or ""
    if "exec(" not in text and "eval(" not in text:
        return None
    hits = [marker for marker in _SELF_EXTRACTING_MARKERS if marker in text]
    if not hits:
        return None
    longest = 0
    for chunk in re.findall(r"['\"]([A-Za-z0-9+/=]{200,})['\"]", text):
        longest = max(longest, len(chunk))
    if not longest:
        return None
    return (
        "blueprint_self_extracting: the script decodes and exec()s an embedded "
        f"{'/'.join(hits)} payload ({longest} encoded characters). Emit the Python "
        "source directly. A model cannot reproduce a long base64 string faithfully: "
        "cycle-g-v86 lost four lanes to a blob whose base64 and gzip header were "
        "valid and whose compressed stream yielded zero bytes."
    )

def _source_has_no_statement(script_code: str) -> bool:
    """True when the script parses but contains nothing but comments and docstrings.

    MEASURED ON cycle-g-v91, 2026-09-14: followup-analyst-98's code field was a
    single comment pointing at a source file stored elsewhere, and
    followup-runner-110 ran it, exited 0 in 0.15 seconds, and recorded a
    completed blueprint that had measured nothing. Only the code field is
    delivered to the runner, so a pointer is not a blueprint.
    """
    import ast

    try:
        tree = ast.parse(script_code)
    except SyntaxError:
        # The compile check reports a script that does not parse, by name.
        return False
    for node in tree.body:
        is_docstring = (
            isinstance(node, ast.Expr)
            and isinstance(getattr(node, "value", None), ast.Constant)
            and isinstance(node.value.value, str)
        )
        if not is_docstring:
            return False
    return True


def _referenced_table_header(dataset: Any, blueprint_dir: Path) -> Optional[List[str]]:
    """Column names of the table a check reads from an earlier lane of this cycle.

    A check that reads another lane's output names it as `<scheme>://<lane>/<file>`.
    That table is already on disk, so its header is a fact to report, not a guess.
    Returns None whenever the reference cannot be resolved to exactly that file.
    """
    import csv

    text = str(dataset or "").strip()
    if "://" not in text:
        return None
    parts = [part for part in text.split("://", 1)[1].split("/") if part]
    if len(parts) < 2:
        return None
    try:
        prior_root = blueprint_dir.resolve().parents[2]
    except IndexError:
        return None
    lane_dir = prior_root / parts[0]
    if not lane_dir.is_dir():
        return None
    matches = sorted(path for path in lane_dir.rglob(parts[-1]) if path.is_file())
    if not matches:
        return None
    try:
        with matches[0].open(newline="", encoding="utf-8", errors="replace") as handle:
            header = next(csv.reader(handle), None)
    except OSError:
        return None
    return [column for column in (header or []) if column] or None


_TIMEOUT_MARKER = re.compile(r"\[driver\] blueprint timed out after (\d+)s")


def _prior_design_overruns(script_code: str, blueprint_dir: Path, timeout_seconds: int) -> List[str]:
    """Earlier lanes of this cycle that ran this exact script and overran the budget.

    MEASURED ON cycle-g-v91, 2026-09-14. One analyst handoff's blueprint timed
    out at 1494s in followup-runner-66, and then again, byte for byte, in -67,
    -69, -70, -71 and -72: six lanes and two and a half hours of the only
    runner slots, while two newer handoffs waited. Earlier in the same cycle one
    design ran seven times the same way. The remedy recorded on the first
    overrun says not to re-submit the same design; nothing stopped the harness
    from doing it, because several kinds of follow-up become a runner lane bound
    to whatever handoff was latest when it was planned.

    The evidence is what the driver itself wrote, not what an agent reported: a
    sibling blueprint directory whose script.py has identical source and whose
    stderr.log carries this module's timeout line for a budget at least as large
    as this one. A changed script, or a larger budget, is a different run.
    """

    try:
        prior_root = blueprint_dir.resolve().parents[2]
        own_lane = blueprint_dir.resolve().parents[1]
    except IndexError:
        return []
    # Text, not bytes: script.py is written with write_text, which translates
    # newlines on some platforms, so identical sources can differ on disk.
    wanted = script_code.replace("\r\n", "\n")
    matches: List[str] = []
    try:
        lanes = sorted(p for p in prior_root.iterdir() if p.is_dir())
    except OSError:
        return []
    for lane in lanes:
        if lane == own_lane:
            continue
        blueprints_dir = lane / "blueprints"
        if not blueprints_dir.is_dir():
            continue
        for candidate in blueprints_dir.iterdir():
            script = candidate / "script.py"
            stderr_log = candidate / "stderr.log"
            try:
                if not script.is_file() or not stderr_log.is_file():
                    continue
                if script.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n") != wanted:
                    continue
                marker = _TIMEOUT_MARKER.search(stderr_log.read_text(encoding="utf-8", errors="replace")[-4000:])
            except OSError:
                continue
            if marker and int(marker.group(1)) >= timeout_seconds:
                matches.append(lane.name)
    return matches


def _prior_artifacts_root(blueprint: Blueprint, blueprint_dir: Path) -> Optional[Path]:
    """Return the narrowest cycle-local root containing a pinned prior artifact."""
    try:
        stats_cycle_root = blueprint_dir.resolve().parents[2]
        runtime_root = stats_cycle_root.parents[2]
    except IndexError:
        return None

    mapping = blueprint.raw.get("column_mapping")
    if isinstance(mapping, list):
        mapping = {
            str(item.get("key")): item.get("column")
            for item in mapping
            if isinstance(item, dict) and item.get("key")
        }
    if not isinstance(mapping, dict):
        return stats_cycle_root
    pinned_hash = str(mapping.get("artifact_sha256") or "").lower()
    declared_name = Path(
        str(mapping.get("artifact_filename") or mapping.get("artifact_glob") or "")
    ).name
    if not re.fullmatch(r"[0-9a-f]{64}", pinned_hash) or not declared_name:
        return stats_cycle_root

    sealed_cycle_root = runtime_root / "sealed-datasets" / stats_cycle_root.name
    # MEASURED ON cycle-a-20260919, 2026-10-14: runner 288 was given
    # artifacts/stats/<cycle>, although its hash-pinned eval_log.json had been
    # copied to sealed-datasets/<cycle>; the valid prior evidence was invisible.
    for candidate in sorted(sealed_cycle_root.glob(f"{pinned_hash[:16]}-*")):
        marker = candidate / ".sealed.json"
        try:
            metadata = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        data_file = candidate / str(metadata.get("data_file") or "")
        if (
            str(metadata.get("sha256") or "").lower() == pinned_hash
            and data_file.name == declared_name
            and data_file.is_file()
        ):
            return candidate
    return stats_cycle_root


def _run_blueprint(
    blueprint: Blueprint,
    *,
    csv_root: Path,
    output_root: Path,
    timeout_seconds: int,
    derived_indicators_for_blueprint: List[Dict[str, Any]],
) -> BlueprintExecution:
    blueprint_dir = output_root / "blueprints" / _slugify(blueprint.check_id)
    blueprint_dir.mkdir(parents=True, exist_ok=True)
    script_path = blueprint_dir / "script.py"
    stdout_path = blueprint_dir / "stdout.log"
    stderr_path = blueprint_dir / "stderr.log"
    check_spec_path = blueprint_dir / "check.json"
    derived_spec_path = blueprint_dir / "derived-indicators.json"
    script_code = blueprint.code

    if blueprint.check_id == "analysis_master_table_created":
        try:
            from drivers.literature import search as literature_search

            script_code = literature_search._analysis_master_table_blueprint_code()
        except Exception:
            # Fall back to the analyst-provided script if the canonical
            # infrastructure blueprint is unavailable in a partial install.
            script_code = blueprint.code

    if not script_code.strip():
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="skipped",
            script_path=None,
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=0.0,
            return_code=None,
            metrics={},
            figures=[],
            tables=[],
            error="blueprint had no executable code",
        )

    # Recorded as the overrun it already is, so every consumer that reads a
    # timeout -- the design_overrun summary the analyst sees, fail-closed lane
    # status, recovery -- reads this one the same way, minus the wasted slot.
    repeated_in = _prior_design_overruns(script_code, blueprint_dir, timeout_seconds)
    if repeated_in:
        message = (
            f"design_overrun_repeat: this exact script already overran the {timeout_seconds}s "
            f"budget in {', '.join(repeated_in[-5:])}; not re-executed"
        )
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(message + "\n", encoding="utf-8")
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="timeout",
            script_path=None,
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=0.0,
            return_code=None,
            metrics={
                "design_overrun": True,
                "design_overrun_repeat": True,
                "blueprint_id": blueprint.blueprint_id,
                "check_id": blueprint.check_id,
                "wall_clock_budget_seconds": timeout_seconds,
                "observed_seconds": 0.0,
                "partial_tables": 0,
                "partial_figures": 0,
                "previous_overruns": repeated_in,
                "remedy": (
                    "This script has already exceeded "
                    f"{timeout_seconds}s unchanged. Shrink the sweep to fit: cut arms, "
                    "seeds, scenes or spp, or split the check across blueprints. "
                    "Re-submitting it unchanged will be refused again."
                ),
            },
            figures=[],
            tables=[],
            error=message,
        )

    if _source_has_no_statement(script_code):
        message = (
            "blueprint_has_no_executable_source: the code field holds only comments or a docstring "
            "(for example a pointer to a file stored elsewhere). Only the code field is delivered to "
            "the runner, so it must contain the complete executable source."
        )
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(message + "\n", encoding="utf-8")
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="failed",
            script_path=None,
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=0.0,
            return_code=None,
            metrics={},
            figures=[],
            tables=[],
            error=message,
        )

    # Honour analyst-declared pip dependencies before we run the
    # blueprint script — see _maybe_install_blueprint_packages above
    # for the safety constraints.
    pip_log = _maybe_install_blueprint_packages(blueprint, blueprint_dir) or None

    script_path.write_text(script_code, encoding="utf-8")
    # Skills layer: copy the vetted domain helper modules next to the blueprint
    # so it can ``import omics_helpers`` / ``import cs_helpers`` (the script's own
    # dir is on sys.path[0]) instead of re-deriving data/asset loading and
    # crashing on real inputs. Both are placed regardless of domain — they are
    # tiny and lazy-import their heavy deps — and the analyst's domain-gated
    # blueprint rules (see src/agents/analyst/query_plan.js) decide which one the
    # generated code actually imports. General conventions only; no task-specific
    # knowledge.
    for helper_name in ("omics_helpers.py", "cs_helpers.py", "research_llm.py"):
        try:
            helper_src = Path(__file__).resolve().parents[1] / helper_name
            if helper_src.is_file():
                (blueprint_dir / helper_name).write_text(
                    helper_src.read_text(encoding="utf-8"), encoding="utf-8"
                )
        except Exception:
            pass
    _write_json(check_spec_path, blueprint.raw)
    # Surface derived-indicator specs the analyst assigned to this blueprint so
    # the script can introspect them at runtime without reparsing the role
    # plan. Always written (possibly an empty list) so scripts can rely on the
    # file's existence.
    _write_json(derived_spec_path, derived_indicators_for_blueprint)

    env = research_api_environment(os.environ)
    env["RESEARCHLAB_BLUEPRINT_ID"] = blueprint.blueprint_id
    env["RESEARCHLAB_CHECK_ID"] = blueprint.check_id
    env["RESEARCHLAB_CSV_ROOT"] = str(csv_root.resolve())
    env["RESEARCHLAB_OUTPUT_DIR"] = str(blueprint_dir.resolve())
    env["RESEARCHLAB_CHECK_SPEC"] = str(check_spec_path.resolve())
    if blueprint.raw.get("analysis_contract"):
        contract_path = blueprint_dir / "analysis-contract.json"
        _write_json(contract_path, blueprint.raw["analysis_contract"])
        env["RESEARCHLAB_ANALYSIS_CONTRACT"] = str(contract_path.resolve())
    # Tables written by EARLIER lanes of this same cycle. A follow-up blueprint
    # that re-analyses a previous run ("no-rerender" checks) had no documented
    # way to reach them: csv_root is the dataset root, so v85's
    # CHK-SURROGATE-UTILITY-LOSO-01 died three times with "required pre-existing
    # no-rerender table missing: benchmark_results.csv" while three copies of
    # that file sat under sibling lanes. Travels as an env var, not a CLI arg,
    # for the same reason as RESEARCHLAB_CHECK_SPEC: a strict argparse would
    # reject an unknown flag.
    prior_artifacts_root = _prior_artifacts_root(blueprint, blueprint_dir)
    if prior_artifacts_root is not None:
        env["RESEARCHLAB_PRIOR_ARTIFACTS_ROOT"] = str(prior_artifacts_root)
    env["RESEARCHLAB_DERIVED_INDICATORS"] = str(derived_spec_path.resolve())
    env["MPLBACKEND"] = env.get("MPLBACKEND", "Agg")  # headless matplotlib

    # Fail a blueprint that does not even PARSE with a clear, named, actionable
    # error BEFORE spawning it — instead of an opaque runtime traceback tail that
    # degrades the lane silently. LLM-authored (analyst) blueprints occasionally
    # emit invalid Python (e.g. an unindented body after an `if:`); this makes
    # that a first-class blueprint_compile_error so runner-recovery can hand the
    # exact line back to the analyst for regeneration.
    self_extracting = _self_extracting_blueprint_reason(
        script_path.read_text(encoding="utf-8")
    )
    if self_extracting:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(self_extracting + "\n", encoding="utf-8")
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="failed",
            script_path=str(script_path),
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=0.0,
            return_code=None,
            metrics={},
            figures=[],
            tables=[],
            error=self_extracting,
            pip_install=pip_log,
        )

    try:
        compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec")
    except SyntaxError as exc:
        message = (
            f"blueprint_compile_error: {type(exc).__name__}: {exc.msg} "
            f"(line {exc.lineno})"
        )
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text(message + "\n", encoding="utf-8")
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="failed",
            script_path=str(script_path),
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=0.0,
            return_code=None,
            metrics={},
            figures=[],
            tables=[],
            error=message,
            pip_install=pip_log,
        )

    started = time.monotonic()
    run_argv = [sys.executable, str(script_path.resolve()), "--csv-root", str(csv_root.resolve()),
                "--output-dir", str(blueprint_dir.resolve())]
    try:
        # The blueprint contract passes --csv-root / --output-dir on the CLI, but
        # the check-spec path travels ONLY via the RESEARCHLAB_CHECK_SPEC env var
        # (set above). It is deliberately NOT passed as a --check-file CLI arg:
        # blueprints that declare only --csv-root/--output-dir with a strict
        # argparse.parse_args() (the common analyst-authored shape) would reject an
        # unknown --check-file and die with "unrecognized arguments". Render/omics
        # blueprints read the check spec from RESEARCHLAB_CHECK_SPEC (their
        # --check-file argparse default), so this is a lossless, contract-compatible
        # channel for every blueprint type.
        completed = subprocess.run(
            run_argv,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            cwd=str(blueprint_dir),
        )
        duration = time.monotonic() - started
        _write_json(blueprint_dir / "driver-execution-receipt.json", {
            "executable": sys.executable, "argv": run_argv, "working_directory": str(blueprint_dir.resolve()),
            "python_version": sys.version, "return_code": completed.returncode, "duration_seconds": duration,
            "script_sha256": hashlib.sha256(script_path.read_bytes()).hexdigest(),
            "check_spec_path": str(check_spec_path.resolve()),
            "check_spec_sha256": hashlib.sha256(check_spec_path.read_bytes()).hexdigest(),
            "environment": {key: env[key] for key in ("RESEARCHLAB_CSV_ROOT", "RESEARCHLAB_OUTPUT_DIR", "RESEARCHLAB_CHECK_SPEC", "RESEARCHLAB_ANALYSIS_CONTRACT") if key in env},
        })
        stdout_text = completed.stdout or ""
        stderr_text = completed.stderr or ""
        stdout_path.write_text(stdout_text, encoding="utf-8")
        stderr_path.write_text(stderr_text, encoding="utf-8")
        figures, tables = _scan_blueprint_artifacts(blueprint, blueprint_dir)
        metrics = _extract_metrics_from_stdout(stdout_text)
        status = "completed" if completed.returncode == 0 else "failed"
        error = None if status == "completed" else (
            stderr_text.strip().splitlines()[-1] if stderr_text.strip() else "blueprint script exited with non-zero status"
        )
        # The script can say which semantic keys it is missing; only the table
        # says what they could map to. On cycle-g-v91 three successive handoffs
        # were told the first and never shown the second. Report the header of
        # the table this check reads, when it resolves to a file on disk.
        if error and "column_mapping" in error:
            dataset = blueprint.dataset or (blueprint.raw or {}).get("dataset")
            header = _referenced_table_header(dataset, blueprint_dir)
            if header:
                error = (
                    f"{error} | the table this check reads ({dataset}) has columns: {header[:80]}. "
                    f"Declare handoff_checks[{blueprint.check_id}].column_mapping mapping each required "
                    "semantic key to one of these columns, or change the design if a concept has no column."
                )
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status=status,
            script_path=str(script_path),
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=duration,
            return_code=completed.returncode,
            metrics=metrics,
            figures=figures,
            tables=tables,
            error=error,
            pip_install=pip_log,
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - started

        def _timeout_output_to_text(value):
            if value is None:
                return ""
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            return str(value)

        stdout_path.write_text(_timeout_output_to_text(exc.stdout), encoding="utf-8")
        stderr_path.write_text(
            _timeout_output_to_text(exc.stderr) + f"\n[driver] blueprint timed out after {timeout_seconds}s",
            encoding="utf-8",
        )
        figures, tables = _scan_blueprint_artifacts(blueprint, blueprint_dir)
        # A timeout is a DESIGN overrun, not a mystery crash: the sweep the
        # analyst specified does not fit the per-blueprint wall-clock budget.
        # v85 burned BP-RESERVOIR-CROSSOVER-01 three times at the identical
        # 1494s cap because nothing downstream ever told the designer what the
        # cap was. Record it in a shape the planner can act on.
        overrun = {
            "design_overrun": True,
            "blueprint_id": blueprint.blueprint_id,
            "check_id": blueprint.check_id,
            "wall_clock_budget_seconds": timeout_seconds,
            "observed_seconds": round(duration, 1),
            "partial_tables": len(tables),
            "partial_figures": len(figures),
            "remedy": (
                "Shrink the sweep to fit "
                f"{timeout_seconds}s: cut arms, seeds, scenes or spp, or split "
                "the check across blueprints. Size it against the measured "
                "instrument inventory rather than re-submitting the same design."
            ),
        }
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="timeout",
            script_path=str(script_path),
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=duration,
            return_code=None,
            metrics=overrun,
            figures=figures,
            tables=tables,
            error=(
                f"timeout after {timeout_seconds}s "
                f"(design_overrun: budget={timeout_seconds}s)"
            ),
            pip_install=pip_log,
        )
    except Exception as exc:  # noqa: BLE001 — capture so we can persist
        duration = time.monotonic() - started
        stderr_path.write_text(f"[driver] spawn failed: {exc!r}\n", encoding="utf-8")
        return BlueprintExecution(
            blueprint_id=blueprint.blueprint_id,
            check_id=blueprint.check_id,
            status="failed",
            script_path=str(script_path),
            output_dir=str(blueprint_dir),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            timeout_seconds=timeout_seconds,
            duration_seconds=duration,
            return_code=None,
            metrics={},
            figures=[],
            tables=[],
            error=str(exc),
            pip_install=pip_log,
        )


# ---------------------------------------------------------------------------
# Aggregation
#
# These helpers turn per-blueprint execution records into the shapes that the
# Rust and JS consumers already know how to render. They do NOT invent numbers;
# if blueprints do not emit correlations/evidence grades, the aggregate fields
# are simply empty.
