"""The instrument-probe lane, run inside the python-stats driver.

WHY IT LIVES HERE. A lab-runner lane is dispatched as `mode: driver-exec`,
`runtime_class: external-driver` - it does not get a free shell, it runs
`drivers/analysis/python_stats.py`. So a role plan that merely *asks* a runner to
execute a command would never execute anything. This module is the hook that
makes the probe lane real work.

WHY THE LANE EXISTS AT ALL. cycle-g-v82's lab-director was required to justify
every research problem with `answerable_here_because` - the instrument in THIS
environment that can answer it - and nothing in the harness could confirm an
instrument. It invented an "executable-instrument gate", cleared nothing through
it, retired 100 candidate problems in a row and declared a "terminal no-survivor
restart". 285 lanes completed, 22.4MB of prompt spent, ZERO gate rounds in 5.5
hours. Its four lab-runner lanes never ran at all: a runner waits on an analyst
handoff, and a cycle with no hypothesis can never produce one.

So this lane deliberately bypasses the handoff machinery below it. It needs no
dataset, no hypothesis and no analyst - which is the whole point, because it runs
before any of those exist.
"""
from __future__ import annotations

import json
import os
import importlib.util
import sys
import time
from uuid import uuid4
from pathlib import Path
from typing import Any, Dict, Optional

PROBE_DRIVER_RELATIVE = "drivers/analysis/instrument_probe.py"


def is_instrument_probe_lane(role_plan: Optional[Dict[str, Any]]) -> bool:
    """A probe lane declares itself; nothing is inferred from the lane id.

    `lane_kind` is set by src/agents/lab_runner/instrument_probe_plan.js, which is
    selected in buildRolePlan only while the cycle has no verified inventory.
    """
    if not isinstance(role_plan, dict):
        return False
    return str(role_plan.get("lane_kind") or "") == "instrument_probe"


def _probe_driver_path() -> Path:
    """Locate the probe next to this package, not relative to the process cwd.

    The driver is invoked with cwd=/opt/researchlab today, but a path that only
    works from one directory is the kind of thing that breaks silently two
    refactors later and reads afterwards as "the probe never ran".
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / PROBE_DRIVER_RELATIVE
        if candidate.exists():
            return candidate
    # python_stats_lib/ -> analysis/ -> instrument_probe.py
    return here.parent.parent / "instrument_probe.py"


def run_instrument_probe_lane(
    role_plan: Dict[str, Any],
    output_dir: Path,
    role_plan_file: Optional[Path],
    task_file: Optional[Path],
) -> Dict[str, Any]:
    """Run the probe, write the inventory, and report honestly.

    The lane reports `completed` only if the probe exited successfully and verified at least one
    instrument. A probe that ran and verified nothing is a FAILED lane: the
    director would otherwise cite an empty inventory as if it were a capability
    record, which is the same class of error as v81's gate scoring a lead from a
    generic capability run.
    """
    from . import constants  # local: keep import cost off the normal driver path

    output_dir.mkdir(parents=True, exist_ok=True)
    probe = _probe_driver_path()
    declared_out = str(role_plan.get("probe_output_path") or "").strip()
    inventory_path = Path(declared_out) if declared_out else None
    if inventory_path is not None and not inventory_path.is_absolute():
        inventory_path = Path.cwd() / inventory_path

    stdout_path = output_dir / "instrument-probe-stdout.txt"
    local_copy = output_dir / "instrument-inventory.json"

    started = time.time()
    status = "failed"
    error: Optional[str] = None
    inventory: Dict[str, Any] = {}
    probe_config = role_plan.get("probe_config")
    probe_exit_code = None

    if not probe.exists():
        error = f"probe driver missing at {probe}"
    else:
        # Import and call main() directly: the probe writes the inventory itself
        # (emit() honours RESEARCHLAB_INSTRUMENT_INVENTORY_OUT), and running
        # in-process keeps import failures - a missing LLVM backend is the classic
        # one, see the v65-v68 launcher corruption - attached to this lane's
        # traceback instead of an opaque exit code.
        # A fresh path prevents an import/crash from reusing a prior successful
        # inventory. Keep this per-attempt artifact, including negative evidence.
        target = output_dir / f"instrument-inventory-run-{uuid4().hex}.json"
        prior_out = os.environ.get("RESEARCHLAB_INSTRUMENT_INVENTORY_OUT")
        os.environ["RESEARCHLAB_INSTRUMENT_INVENTORY_OUT"] = str(target)
        captured = _Tee(stdout_path)
        real_stdout, sys.stdout = sys.stdout, captured
        try:
            spec = importlib.util.spec_from_file_location("_instrument_probe", probe)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            code = module.main(probe_config)
            probe_exit_code = code
            if code not in (0, None):
                error = f"probe reported failure (exit {code})"
        except SystemExit as exc:
            probe_exit_code = exc.code
            if exc.code not in (0, None):
                error = f"probe exited with code {exc.code}"
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"[:400]
        finally:
            sys.stdout = real_stdout
            captured.close()
            if prior_out is None:
                os.environ.pop("RESEARCHLAB_INSTRUMENT_INVENTORY_OUT", None)
            else:
                os.environ["RESEARCHLAB_INSTRUMENT_INVENTORY_OUT"] = prior_out

        source = target
        if source.exists():
            try:
                inventory = json.loads(source.read_text(encoding="utf-8"))
                if not isinstance(inventory, dict):
                    raise ValueError("inventory must be a JSON object")
            except Exception as exc:  # noqa: BLE001
                inventory = {}
                error = f"inventory unreadable: {type(exc).__name__}: {exc}"[:300]
        elif error is None:
            error = f"probe produced no inventory at {target}"

    verified = [v for v in (inventory.get("verified_instruments") or []) if v]
    unavailable = list(inventory.get("unavailable_instruments") or [])
    quantities = list(inventory.get("measurable_quantities") or [])
    if verified and error is None and inventory.get("status") != "failed" and inventory.get("exit_code", 0) in (0, None):
        status = "completed"
    elif error is None:
        error = inventory.get("error") or "the probe failed or verified no instrument"

    if not inventory:
        inventory = {"backend": (probe_config or {}).get("backend", "python") if isinstance(probe_config, (dict, type(None))) else None,
                     "probe_config": probe_config, "status": "failed", "error": error,
                     "verified_instruments": [], "unavailable_instruments": [], "measurable_quantities": []}
    if status != "completed":
        inventory["status"] = "failed"
        inventory["error"] = error
    for destination in dict.fromkeys([local_copy, inventory_path]):
        if destination is None:
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            # Preserve the prior evidence before updating the stable pointer.
            previous = output_dir / f"instrument-inventory-previous-{uuid4().hex}.json"
            previous.write_bytes(destination.read_bytes())
        destination.write_text(json.dumps(inventory, indent=2), encoding="utf-8")

    summary = _summary_for_director(inventory, verified, unavailable, quantities, error)
    (output_dir / "summary.md").write_text(summary, encoding="utf-8")

    result = {
        "status": status,
        "driver": constants.DRIVER_NAME,
        "lane_kind": "instrument_probe",
        "probe_config": inventory.get("probe_config"),
        "probe_exit_code": probe_exit_code,
        "pip_installs": inventory.get("pip_installs", []),
        "role_plan_path": str(role_plan_file) if role_plan_file else None,
        "role_plan": role_plan,
        "summary_path": str(output_dir / "summary.md"),
        "instrument_inventory_path": str(inventory_path or local_copy),
        "instrument_probe_stdout_path": str(stdout_path),
        "verified_instruments": verified,
        "unavailable_instruments": unavailable,
        "measurable_quantities": quantities,
        "renderer": inventory.get("renderer"),
        "duration_seconds": round(time.time() - started, 3),
        "error": error,
        # A probe measures capability, not a hypothesis. Saying so in the result
        # keeps the gate from scoring it: on v81 a generic capability run WAS
        # mistaken for hypothesis validation and bound technical_quality at 12.
        "validation_summary": {
            "overall_status": "not_applicable",
            "score": None,
            "reason": "instrument probe: capability measurement, not hypothesis validation",
        },
        "extracted_json": {
            "summary": summary,
            "instrument_inventory": {
                "status": inventory.get("status") or ("measured" if verified else "empty"),
                "verified_instruments": verified,
                "unavailable_instruments": unavailable,
                "measurable_quantities": quantities,
            },
        },
        "task_file_summary": (task_file.read_text(encoding="utf-8")[:2000] if task_file and task_file.exists() else ""),
    }
    (output_dir / "result.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


def _summary_for_director(inventory, verified, unavailable, quantities, error) -> str:
    lines = ["# Instrument inventory", "", f"Selected backend: {inventory.get('backend', 'unknown')}"]
    if "renderer" in inventory:
        renderer = inventory["renderer"] or {}
        if renderer.get("available"):
            lines.append(f"Renderer: {renderer.get('package')} {renderer.get('version')} (variant {renderer.get('variant')})")
        else:
            lines.append(f"Selected renderer unavailable: {renderer.get('error', 'probe did not return a renderer')}")
    lines += ["", f"## Verified ({len(verified)})"]
    lines += [f"- {name}" for name in verified] or ["- (none)"]
    lines += ["", f"## Not available ({len(unavailable)})"]
    lines += [f"- {name}" for name in unavailable] or ["- (none)"]
    lines += ["", "## Quantities a hypothesis can be posed over"]
    lines += [f"- {q}" for q in quantities] or ["- (none)"]
    if error:
        lines += ["", f"## Probe error", f"- {error}"]
    lines += [
        "",
        "A research problem may cite any verified instrument or measurable quantity as its",
        "`answerable_here_because`. A problem needing something in the not-available list is",
        "NOT retired: restate it over a verified observable, or request one runner lane to",
        "build the instrument and re-probe.",
        "This records capability measurements only, not hypothesis validation or hardware readiness.",
    ]
    return "\n".join(lines) + "\n"


class _Tee:
    """Capture probe stdout to a file while leaving the lane log readable."""

    def __init__(self, path: Path, append: bool = False):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = path.open("a" if append else "w", encoding="utf-8")

    def write(self, text):
        self._fh.write(text)
        return len(text)

    def flush(self):
        self._fh.flush()

    def close(self):
        try:
            self._fh.close()
        except Exception:  # noqa: BLE001
            pass
