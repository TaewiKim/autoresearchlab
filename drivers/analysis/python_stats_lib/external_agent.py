from __future__ import annotations

import argparse
import base64
import bz2
import gzip
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

from .io_utils import _coerce_str, _read_json, _slugify, _write_json
from .execution_model import ExternalAgentExecution

if __package__ == "python_stats_lib":
    from research_llm import research_api_environment
else:
    from ..research_llm import research_api_environment


EXTERNAL_AGENT_SMOKE_TIMEOUT_SECONDS = 90
EXTERNAL_AGENT_APPLICATION_TIMEOUT_SECONDS = 600


def _string_or_none(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _normalize_external_agent_spec(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    name = _string_or_none(value.get("name")) or _string_or_none(value.get("url"))
    if not name:
        return None
    return dict(value)


def _selected_external_agent_specs(handoff: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Return selected reusable analysis-agent specs from the analyst handoff.

    The function is deliberately tool-agnostic. It accepts both the compact
    top-level `selected_open_source_analysis_agent` shape and the richer
    `open_source_agent_discovery.selected_agent` / candidates shape.
    """

    specs: List[Dict[str, Any]] = []

    top_level = _normalize_external_agent_spec(
        handoff.get("selected_open_source_analysis_agent")
    )
    if top_level:
        specs.append(top_level)

    discovery = handoff.get("open_source_agent_discovery")
    if isinstance(discovery, dict):
        selected = _normalize_external_agent_spec(discovery.get("selected_agent"))
        if selected:
            specs.append(selected)
        candidates = discovery.get("candidates")
        if isinstance(candidates, list):
            for candidate in candidates:
                normalized = _normalize_external_agent_spec(candidate)
                if not normalized:
                    continue
                decision = _coerce_str(normalized.get("reuse_decision")).lower()
                if decision in {"reuse", "adapt"}:
                    specs.append(normalized)

    deduped: List[Dict[str, Any]] = []
    seen: Dict[tuple[str, str, str], Dict[str, Any]] = {}
    for spec in specs:
        key = (
            _coerce_str(spec.get("name")),
            _coerce_str(spec.get("url")),
            _coerce_str(spec.get("local_path")),
        )
        existing = seen.get(key)
        if existing is not None:
            for field, value in spec.items():
                if existing.get(field) in (None, "", [], {}):
                    existing[field] = value
            continue
        seen[key] = spec
        deduped.append(spec)
    return deduped


def _is_generic_package_adapter(spec: Dict[str, Any]) -> bool:
    text = " ".join(
        _coerce_str(spec.get(key)).lower()
        for key in ["name", "url", "download_command", "local_path", "source_kind"]
    )
    return (
        "python-open-source-workflow-adapter" in text
        or "generic_package_adapter" in text
        or "no git clone required" in text
        or (
            "pandas.pydata.org" in text
            and "numpy.org" in text
            and "scikit-learn.org" in text
        )
    )


def _requires_repository_agent(handoff: Dict[str, Any], role_plan: Dict[str, Any] | None) -> bool:
    # A computer-graphics / rendering objective validates with a self-contained
    # in-code Mitsuba render; it neither needs nor can satisfy an external
    # omics/high-dimensional repository agent. The analyst-handoff side already
    # drops the requirement (part_06/part_08), but the driver re-derives it from
    # the role_plan mandate, so gate it here too: a handoff carrying a render-
    # and-measure check does not require a repository agent.
    _render_items = list((handoff or {}).get("handoff_checks") or []) + list(
        (handoff or {}).get("validation_code_blueprints") or []
    )
    for _item in _render_items:
        if not isinstance(_item, dict):
            continue
        if str(_item.get("model_family") or "") == "render-and-measure-convergence":
            return False
        if "render_quality_convergence" in str(_item.get("check_id") or ""):
            return False
    discovery = handoff.get("open_source_agent_discovery")
    requirement = handoff.get("open_source_agent_requirement")
    planner_metadata = (role_plan or {}).get("planner_metadata") or {}
    mandate = planner_metadata.get("open_source_analysis_agent_mandate") or {}
    mandatory = bool(
        (isinstance(discovery, dict) and discovery.get("mandatory"))
        or (isinstance(requirement, dict) and requirement.get("repository_agent_required"))
        or planner_metadata.get("require_open_source_analysis_agent_discovery")
        or mandate.get("mandatory")
    )
    if not mandatory:
        return False
    text = json.dumps(
        {
            "discovery": discovery or {},
            "requirement": requirement or {},
            "mandate": mandate or {},
            "summary": handoff.get("summary") or "",
            "candidate_primary_families": handoff.get("candidate_primary_families") or [],
            "dataset_profile": handoff.get("dataset_profile") or {},
        },
        sort_keys=True,
        default=str,
    ).lower()
    return any(
        needle in text
        for needle in [
            "omics",
            "transcript",
            "rna",
            "rnaseq",
            "gene",
            "expression",
            "proteom",
            "metabolom",
            "methyl",
            "single-cell",
            "single cell",
            "high-dimensional",
            "high_dimensional",
            "large-scale",
            "large scale",
        ]
    )


def _read_external_agent_json(output_dir: str, filename: str) -> Optional[Dict[str, Any]]:
    if not output_dir:
        return None
    path = Path(output_dir) / filename
    payload = _read_json(path)
    return payload if isinstance(payload, dict) else None


def _external_agent_artifact_path(output_dir: str, *filenames: str) -> str:
    if not output_dir:
        return ""
    root = Path(output_dir)
    for filename in filenames:
        candidate = root / filename
        if candidate.exists():
            return str(candidate)
    return str(root / filenames[0]) if filenames else str(root)


def _external_agent_workflow_summary(execution: ExternalAgentExecution) -> Dict[str, Any]:
    summary = (
        _read_external_agent_json(execution.output_dir, "external_repository_workflow_result.json")
        or _read_external_agent_json(execution.output_dir, "external_repository_agent_summary.json")
        or _read_external_agent_json(execution.output_dir, "open_source_workflow_summary.json")
        or {}
    )
    workflow_runs = summary.get("repo_workflow_runs")
    if not isinstance(workflow_runs, list):
        workflow_runs = []
    substantive_outputs = summary.get("substantive_workflow_outputs")
    if not isinstance(substantive_outputs, list):
        substantive_outputs = []
    blockers = summary.get("substantive_workflow_blockers")
    if not isinstance(blockers, list):
        blockers = []
    substantive = bool(summary.get("substantive_repository_workflow_applied")) or any(
        isinstance(run, dict)
        and run.get("status") == "completed"
        and run.get("substantive") is True
        for run in workflow_runs
    )
    return {
        "agent_name": execution.agent_name,
        "stage": execution.stage,
        "status": execution.status,
        "output_dir": execution.output_dir,
        "summary_path": _external_agent_artifact_path(
            execution.output_dir,
            "external_repository_agent_summary.json",
            "open_source_workflow_summary.json",
        ),
        "workflow_result_path": _external_agent_artifact_path(
            execution.output_dir,
            "external_repository_workflow_result.json",
            "open_source_workflow_summary.json",
        ),
        "substantive_repository_workflow_applied": substantive,
        "repo_workflow_runs": workflow_runs,
        "substantive_workflow_outputs": substantive_outputs,
        "substantive_workflow_blockers": blockers,
    }



def _repository_agent_requirement_summary(
    handoff: Dict[str, Any],
    role_plan: Dict[str, Any] | None,
    external_agent_executions: List[ExternalAgentExecution],
) -> Dict[str, Any]:
    selected_specs = _selected_external_agent_specs(handoff)
    required = _requires_repository_agent(handoff, role_plan)
    generic_names = {
        _coerce_str(spec.get("name")) or _coerce_str(spec.get("url"))
        for spec in selected_specs
        if _is_generic_package_adapter(spec)
    }
    real_specs = [spec for spec in selected_specs if not _is_generic_package_adapter(spec)]
    completed_application_names = {
        e.agent_name
        for e in external_agent_executions
        if e.stage == "application" and e.status == "completed"
    }
    workflow_summaries = [
        _external_agent_workflow_summary(e)
        for e in external_agent_executions
        if e.stage == "application" and e.status == "completed"
    ]
    substantive_application_names = {
        item["agent_name"]
        for item in workflow_summaries
        if item.get("substantive_repository_workflow_applied")
    }
    real_names = {
        _coerce_str(spec.get("name")) or _coerce_str(spec.get("url"))
        for spec in real_specs
    }
    real_application_completed = any(
        name in completed_application_names for name in real_names if name
    )
    real_substantive_completed = any(
        name in substantive_application_names for name in real_names if name
    )
    workflow_blocked_resolved = bool(
        required
        and real_application_completed
        and not real_substantive_completed
        and any(
            any(
                isinstance(run, dict)
                and run.get("status") == "blocked"
                and (_coerce_str(run.get("reason")) or _coerce_str(run.get("blocker")))
                for run in (summary.get("repo_workflow_runs") or [])
            )
            for summary in workflow_summaries
            if isinstance(summary, dict)
        )
    )
    repository_agent_applied = (not required) or real_application_completed
    if required and not real_application_completed:
        blocker = (
            "mandatory omics/high-dimensional analysis has not applied a real external "
            "repository/workflow/domain package; generic package adapters do not satisfy the gate"
        )
    elif required and not real_substantive_completed:
        blocker = (
            "a real external repository application completed, but it did not run a "
            "repository-native workflow/skill/domain command that produced hypothesis-relevant "
            "outputs; repository inventory or CSV profiling alone is insufficient"
        )
    else:
        blocker = None
    return {
        "repository_agent_required": required,
        "repository_agent_applied": repository_agent_applied,
        "repository_agent_application_completed": (not required) or real_application_completed,
        "substantive_repository_workflow_applied": (not required) or real_substantive_completed,
        "substantive_repository_workflow_executed": (not required) or real_substantive_completed,
        "repository_workflow_blocked_resolved": workflow_blocked_resolved,
        "selected_agent_count": len(selected_specs),
        "real_repository_agent_count": len(real_specs),
        "generic_adapter_agent_names": sorted(name for name in generic_names if name),
        "real_repository_agent_names": sorted(name for name in real_names if name),
        "completed_application_agent_names": sorted(completed_application_names),
        "completed_substantive_agent_names": sorted(substantive_application_names),
        "external_agent_workflow_summaries": workflow_summaries,
        "generic_adapter_satisfies_requirement": False if required else None,
        "blocker": blocker,
    }


def _external_agent_cwd(spec: Dict[str, Any], output_dir: Path) -> Path:
    """Where to run the selected tool.

    This asked only whether the path EXISTS, and a file exists. cycle-g-v91's
    followup-analyst-16 named its own blueprint script as `local_path`, the file
    was really there, and the runner tried to change directory into it:

        NotADirectoryError: [Errno 20] Not a directory:
          .../state/followup-analyst-16-phase-sham-blueprint.py

    That killed the first runner lane to attempt a real execution after the
    instrument inventory finally reported a renderer.

    A file named here says where the tool LIVES, not where to run, so its
    directory is what was meant. Refusing it instead would be defensible and
    useless -- the path is right, only its kind is wrong.
    """
    local_path = _string_or_none(spec.get("local_path"))
    if local_path:
        candidate = Path(local_path).expanduser()
        if candidate.is_dir():
            return candidate.resolve()
        if candidate.is_file():
            return candidate.resolve().parent
    return output_dir.resolve()


def _run_external_agent_command(
    *,
    agent_name: str,
    stage: str,
    command_text: Optional[str],
    cwd: Path,
    csv_root: Path,
    output_root: Path,
    timeout_seconds: int,
    spec: Dict[str, Any],
) -> ExternalAgentExecution:
    agent_slug = _slugify(agent_name)
    stage_slug = _slugify(stage)
    run_dir = output_root / "external-agents" / agent_slug
    run_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = run_dir / f"{stage_slug}-stdout.log"
    stderr_path = run_dir / f"{stage_slug}-stderr.log"
    selected_agent_path = run_dir / "selected-agent.json"
    _write_json(selected_agent_path, spec)

    if not command_text:
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("command not supplied\n", encoding="utf-8")
        return ExternalAgentExecution(
            agent_name=agent_name,
            stage=stage,
            status="skipped",
            command=None,
            cwd=str(cwd),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            duration_seconds=0.0,
            return_code=None,
            error="command not supplied",
            output_dir=str(run_dir),
        )

    env = research_api_environment(os.environ)
    env["RESEARCHLAB_CSV_ROOT"] = str(csv_root.resolve())
    env["RESEARCHLAB_OUTPUT_DIR"] = str(output_root.resolve())
    env["RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR"] = str(run_dir.resolve())
    env["RESEARCHLAB_SELECTED_AGENT_JSON"] = str(selected_agent_path.resolve())
    env["PYTHONUNBUFFERED"] = env.get("PYTHONUNBUFFERED", "1")
    env["RESEARCHLAB_PYTHON"] = sys.executable
    # Repository workflows can explicitly import the same Luna-only helper.
    # Preserve their existing import paths after the vetted helper directory.
    helper_dir = str(Path(__file__).resolve().parents[1])
    env["PYTHONPATH"] = helper_dir + (
        os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""
    )
    # External-agent command templates are authored as shell snippets and often
    # use `python3`. Prefer the interpreter that is running this validated
    # driver (normally the project venv with pandas/scipy installed) so a
    # system Python without scientific deps does not create a false blocker.
    interpreter_bin = str(Path(sys.executable).resolve().parent)
    env["PATH"] = interpreter_bin + (os.pathsep + env["PATH"] if env.get("PATH") else "")

    started = time.monotonic()
    try:
        completed = subprocess.run(
            command_text,
            shell=True,
            executable="/bin/bash",
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env=env,
            cwd=str(cwd),
        )
        duration = time.monotonic() - started
        stdout_path.write_text(completed.stdout or "", encoding="utf-8")
        stderr_path.write_text(completed.stderr or "", encoding="utf-8")
        status = "completed" if completed.returncode == 0 else "failed"
        error = None
        if status == "failed":
            stderr_lines = (completed.stderr or "").strip().splitlines()
            stdout_lines = (completed.stdout or "").strip().splitlines()
            error = (
                stderr_lines[-1]
                if stderr_lines
                else stdout_lines[-1]
                if stdout_lines
                else "external analysis agent command exited with non-zero status"
            )
        return ExternalAgentExecution(
            agent_name=agent_name,
            stage=stage,
            status=status,
            command=command_text,
            cwd=str(cwd),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            duration_seconds=duration,
            return_code=completed.returncode,
            error=error,
            output_dir=str(run_dir),
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.monotonic() - started

        def _timeout_output(value: Any) -> str:
            if value is None:
                return ""
            if isinstance(value, bytes):
                return value.decode("utf-8", errors="replace")
            return str(value)

        stdout_path.write_text(_timeout_output(exc.stdout), encoding="utf-8")
        stderr_path.write_text(
            _timeout_output(exc.stderr)
            + f"\n[driver] external analysis agent {stage} timed out after {timeout_seconds}s",
            encoding="utf-8",
        )
        return ExternalAgentExecution(
            agent_name=agent_name,
            stage=stage,
            status="timeout",
            command=command_text,
            cwd=str(cwd),
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            duration_seconds=duration,
            return_code=None,
            error=f"timeout after {timeout_seconds}s",
            output_dir=str(run_dir),
        )


def _run_open_source_analysis_agents(
    handoff: Dict[str, Any],
    *,
    csv_root: Path,
    output_root: Path,
) -> List[ExternalAgentExecution]:
    executions: List[ExternalAgentExecution] = []
    for spec in _selected_external_agent_specs(handoff):
        agent_name = (
            _string_or_none(spec.get("name"))
            or _string_or_none(spec.get("url"))
            or "open-source-analysis-agent"
        )
        cwd = _external_agent_cwd(spec, output_root)
        smoke = _run_external_agent_command(
            agent_name=agent_name,
            stage="smoke_test",
            command_text=_string_or_none(spec.get("smoke_test_command")),
            cwd=cwd,
            csv_root=csv_root,
            output_root=output_root,
            timeout_seconds=int(spec.get("smoke_timeout_seconds") or EXTERNAL_AGENT_SMOKE_TIMEOUT_SECONDS),
            spec=spec,
        )
        executions.append(smoke)

        application_command = _string_or_none(spec.get("application_command"))
        if smoke.status in {"completed", "skipped"} and application_command:
            apply_run = _run_external_agent_command(
                agent_name=agent_name,
                stage="application",
                command_text=application_command,
                cwd=cwd,
                csv_root=csv_root,
                output_root=output_root,
                timeout_seconds=int(
                    spec.get("application_timeout_seconds")
                    or EXTERNAL_AGENT_APPLICATION_TIMEOUT_SECONDS
                ),
                spec=spec,
            )
            executions.append(apply_run)
        elif application_command:
            skipped = _run_external_agent_command(
                agent_name=agent_name,
                stage="application",
                command_text=None,
                cwd=cwd,
                csv_root=csv_root,
                output_root=output_root,
                timeout_seconds=0,
                spec=spec,
            )
            skipped.command = application_command
            skipped.error = f"skipped because smoke_test status was {smoke.status}"
            Path(skipped.stderr_path).write_text(skipped.error + "\n", encoding="utf-8")
            executions.append(skipped)
    return executions

