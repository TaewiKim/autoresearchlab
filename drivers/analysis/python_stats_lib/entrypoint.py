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

from .constants import BLUEPRINT_TIMEOUT_SECONDS_DEFAULT, DRIVER_NAME, DRIVER_WALL_CLOCK_BUDGET_SECONDS
from .io_utils import _read_json, _read_text, _sanitize_nonfinite, _slugify, _write_json
from .handoff_selection import _dataset_root_from_handoff, _dataset_root_from_plan, _resolve_dataset_root, _find_analyst_handoff, _find_latest_handoff_from_cycle, _select_analyst_handoff
from .column_mapping import _collect_derived_indicator_specs
from .blueprint_model import _collect_blueprints
from .execution_model import BlueprintExecution
from .external_agent import _run_open_source_analysis_agents
from .blueprint_run import _run_blueprint
from .evidence import _aggregate_correlations, _execution_produced_evidence
from .validation_status import _aggregate_evidence_grade, _aggregate_selected_hypotheses, _figures_spec, _quality_gates, _result_status, _unmeasured_completion, _validation_summary, _write_summary_md
from .instrument_probe_lane import is_instrument_probe_lane, run_instrument_probe_lane
from .analysis_contract import current_contract, preflight, verify_outputs


def run_driver(
    csv_root: Path,
    output_dir: Path,
    task_file: Optional[Path],
    role_plan_file: Optional[Path],
) -> Dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    role_plan = _read_json(role_plan_file)

    # The instrument-probe lane runs BEFORE any hypothesis exists, so every step
    # below it - handoff selection, dataset root, blueprint collection - has
    # nothing to work with. cycle-g-v82's four lab-runner lanes never executed at
    # all for exactly that reason, while its director retired 100 research
    # problems for want of a verified instrument record. See
    # instrument_probe_lane.py.
    if is_instrument_probe_lane(role_plan):
        return run_instrument_probe_lane(role_plan, output_dir, role_plan_file, task_file)

    embedded_handoff = _find_analyst_handoff(role_plan)
    latest_handoff = _find_latest_handoff_from_cycle(role_plan, role_plan_file)
    handoff = _select_analyst_handoff(embedded_handoff, latest_handoff, role_plan_file)
    canonical_contract = current_contract(role_plan_file)
    contract_binding = preflight(handoff, canonical_contract, role_plan_file)
    executed_handoff_path = handoff.get("_source_path") or (role_plan or {}).get("planner_metadata", {}).get("analysis_request", {}).get("handoff_path")
    if contract_binding and contract_binding["evidence_role"] == "primary":
        # Rebind dispatch metadata only AFTER the authored handoff passed the
        # canonical preflight, and BEFORE its immutable script is executed.
        if role_plan.get("assigned_hypotheses") != [canonical_contract["statement"]]:
            role_plan.setdefault("planner_metadata", {})["analysis_contract_previous_assignment"] = role_plan.get("assigned_hypotheses")
        role_plan["assigned_hypotheses"] = [canonical_contract["statement"]]
        role_plan.setdefault("planner_metadata", {})["analysis_contract"] = canonical_contract
        if executed_handoff_path:
            role_plan["planner_metadata"]["analyst_handoff_path"] = executed_handoff_path
        if role_plan_file:
            temporary = Path(str(role_plan_file) + f".{os.getpid()}.contract.tmp")
            _write_json(temporary, role_plan)
            temporary.replace(role_plan_file)
    dataset_root, dataset_root_source = _resolve_dataset_root(handoff, role_plan, csv_root)

    # Output file paths (stable — engine.rs references these via artifact list).
    summary_path = output_dir / "summary.md"
    tidy_path = output_dir / "tidy.csv"
    correlations_path = output_dir / "correlations.json"
    robustness_path = output_dir / "robustness.json"
    region_correlations_path = output_dir / "region-correlations.json"
    hypothesis_results_path = output_dir / "hypothesis-results.json"
    figure_spec_path = output_dir / "figure-spec.json"
    validation_path = output_dir / "validation-summary.json"
    analysis_trace_path = output_dir / "analysis-trace.json"
    result_path = output_dir / "result.json"

    # Stamp the reproducibility design HERE, where the handoff is consumed, so it
    # does not matter which path built it.
    #
    # It was first added to handoff_checks.py, which is where the
    # literature-search-driver builds its 48 handoffs. Two new handoffs arrived
    # from `codex-agent-executor` instead and carried nothing -- a second builder
    # for the same artifact, so a fix at one builder covers one builder. The codex
    # path had also been given the requirement in its output contract and ignored
    # it three lanes running (followup-analyst-70, -71, -72), each with the field
    # present in its prompt.txt.
    #
    # There is exactly one consumer. Stamping at the point of execution is the only
    # place that covers every producer, present and future, and it cannot be
    # skipped by an agent choosing not to fill a field.
    handoff = _stamp_handoff_reproducibility(handoff)
    blueprints = _collect_blueprints(handoff)
    # A supporting audit reads the contract too: the analyst instruction tells
    # every contract-bound blueprint to read it from RESEARCHLAB_ANALYSIS_CONTRACT.
    # MEASURED ON cycle-a-20260919, 2026-10-18: the six supporting
    # audits run (runners 491, 499-503) each died on its first line with
    # "RESEARCHLAB_ANALYSIS_CONTRACT is required", because only a primary
    # execution was given the file. Its role still decides how the outputs are
    # verified (analysis_contract.verify_outputs).
    for blueprint in blueprints:
        _give_blueprint_contract(blueprint, contract_binding, canonical_contract)
    derived_indicator_buckets = _collect_derived_indicator_specs(handoff)
    # Specs that do not point at a specific blueprint are surfaced to every
    # executed blueprint so the analyst's derivation intent is never silently
    # dropped by a missing ``blueprint_id_reference``.
    unassigned_derived_specs = derived_indicator_buckets.pop("", [])
    # Also write a top-level manifest so downstream inspection tools can see
    # exactly what derivations the analyst proposed for this lane.
    _write_json(
        output_dir / "derived-indicators.json",
        handoff.get("derived_indicators") if isinstance(handoff.get("derived_indicators"), list) else [],
    )
    # Per-blueprint time comes from the budget that is actually free, not from a
    # fixed ceiling.
    #
    # WHAT THE CEILING COST (cycle-g-v74, followup-runner-61 and -63). The old rule
    # was min(240, 1500 // n): with a SINGLE blueprint requested it handed out 240s
    # and left 1260s of the driver's own wall-clock budget unused. Both runners died
    # at exactly 240.3s on the same visibility-hazard prospective design — a
    # multi-seed sweep with held-out AUC, TINMSE/FLIP, latency and memory telemetry,
    # against a budget that had five times the room to give. 240 was written as a
    # DEFAULT and was silently acting as a CAP.
    #
    # It is also the same shape as every other failure this cycle: a fixed number
    # decides the experiment's scale, and the agent that designed the experiment
    # never sees it. So the analyst may now state what its own sweep needs
    # (requested_timeout_seconds) and that is honoured up to what the budget can
    # actually afford; the default survives only as a FLOOR for the common case
    # where it says nothing.
    if blueprints:
        fair_share = DRIVER_WALL_CLOCK_BUDGET_SECONDS // len(blueprints)
        per_blueprint_timeout = max(60, BLUEPRINT_TIMEOUT_SECONDS_DEFAULT, fair_share)
    else:
        per_blueprint_timeout = BLUEPRINT_TIMEOUT_SECONDS_DEFAULT

    driver_started = time.monotonic()
    driver_started_wall = time.time()
    executions: List[BlueprintExecution] = []
    for blueprint in blueprints:
        specs_for_blueprint = list(
            derived_indicator_buckets.get(blueprint.blueprint_id, [])
        )
        specs_for_blueprint.extend(unassigned_derived_specs)
        elapsed = time.monotonic() - driver_started
        remaining = DRIVER_WALL_CLOCK_BUDGET_SECONDS - elapsed
        if remaining <= 10:
            # Out of wall-clock time — record remaining blueprints as skipped
            # with a clear reason so the planner can retry rather than silently
            # treating them as failures.
            executions.append(
                BlueprintExecution(
                    blueprint_id=blueprint.blueprint_id,
                    check_id=blueprint.check_id,
                    status="skipped",
                    script_path=None,
                    output_dir=str(output_dir / "blueprints" / _slugify(blueprint.check_id)),
                    stdout_path="",
                    stderr_path="",
                    timeout_seconds=per_blueprint_timeout,
                    duration_seconds=0.0,
                    return_code=None,
                    metrics={},
                    figures=[],
                    tables=[],
                    error="driver wall-clock budget exhausted before this blueprint",
                    derived_indicator_specs=specs_for_blueprint,
                )
            )
            continue
        # The analyst's own estimate wins over the share when it asked for more,
        # since it is the only party that knows how heavy its sweep is — but never
        # over what the remaining wall clock can actually pay for.
        wanted = max(per_blueprint_timeout, blueprint.requested_timeout_seconds or 0)
        timeout = int(min(wanted, max(30, remaining - 5)))
        execution = _run_blueprint(
            blueprint,
            csv_root=dataset_root,
            output_root=output_dir,
            timeout_seconds=timeout,
            derived_indicators_for_blueprint=specs_for_blueprint,
        )
        execution.derived_indicator_specs = specs_for_blueprint
        # Pick up any indicator outcomes the blueprint reported on stdout so
        # result.json can surface the evidence (value, formula, realized stats)
        # alongside the spec.
        reported = execution.metrics.get("derived_indicators") if isinstance(execution.metrics, dict) else None
        if isinstance(reported, list):
            execution.derived_indicator_outcomes = [
                item for item in reported if isinstance(item, dict)
            ]
        executions.append(execution)

    # Repository-native tools need access to the analysis artifacts produced by
    # the blueprints, not just the original dataset bundle. This is especially
    # important for modality-specific differential feature tables derived from
    # GeoMx program-score contrasts.
    external_agent_executions = _run_open_source_analysis_agents(
        handoff,
        csv_root=dataset_root,
        output_root=output_dir,
    )

    correlations = _aggregate_correlations(executions)
    evidence_grade = _aggregate_evidence_grade(executions)
    figure_specs = _figures_spec(executions)
    validation_summary = _validation_summary(
        executions,
        handoff,
        role_plan=role_plan,
        external_agent_executions=external_agent_executions,
    )
    contract_binding = verify_outputs(executions, canonical_contract, contract_binding)
    if contract_binding:
        validation_summary["analysis_contract_validation"] = contract_binding
        if contract_binding["status"] == "mismatch":
            validation_summary["overall_status"] = "degraded"
            validation_summary["failed_checks"].append("analysis_contract_output_mismatch")
            validation_summary["checks"]["analysis_contract_output_matches"] = False
            validation_summary["checks_total"] = len(validation_summary["checks"])
            validation_summary["checks_passed"] = sum(value is True for value in validation_summary["checks"].values())
            validation_summary["checks_failed"] = len(validation_summary["failed_checks"])
    validation_summary["external_agent_runs_total"] = len(external_agent_executions)
    validation_summary["external_agent_runs_passed"] = sum(
        1 for e in external_agent_executions if e.status == "completed"
    )
    validation_summary["external_agent_runs_failed"] = sum(
        1 for e in external_agent_executions if e.status in {"failed", "timeout"}
    )
    validation_summary["external_agent_runs_skipped"] = sum(
        1 for e in external_agent_executions if e.status == "skipped"
    )
    selected_hypotheses = _aggregate_selected_hypotheses(
        handoff,
        validation_summary=validation_summary,
    )
    quality_gates = _quality_gates(validation_summary)

    analysis_trace = {
        "driver": DRIVER_NAME,
        "mode": "blueprint-execution",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(driver_started_wall)),
        "duration_seconds": time.monotonic() - driver_started,
        "external_analysis_agents": [
            {
                "agent_name": e.agent_name,
                "stage": e.stage,
                "status": e.status,
                "return_code": e.return_code,
                "duration_seconds": e.duration_seconds,
                "command": e.command,
                "cwd": e.cwd,
                "stdout_path": e.stdout_path,
                "stderr_path": e.stderr_path,
                "error": e.error,
            }
            for e in external_agent_executions
        ],
        "blueprints": [
            {
                "blueprint_id": e.blueprint_id,
                "check_id": e.check_id,
                "status": e.status,
                "return_code": e.return_code,
                "duration_seconds": e.duration_seconds,
                "figures": len(e.figures),
                "tables": len(e.tables),
                "error": e.error,
            }
            for e in executions
        ],
    }

    hypothesis_results = [
        {
            "hypothesis_id": item.get("hypothesis_id"),
            "statement": item.get("statement"),
            "status": item.get("status"),
            "family": item.get("family"),
        }
        for item in selected_hypotheses
    ]

    # Persist peripheral files. We write empty/minimal payloads for artifacts
    # that blueprints did not produce rather than skipping them, because
    # downstream consumers (engine.rs artifact list, live-view snapshot) read
    # these paths unconditionally.
    _write_json(correlations_path, correlations)
    _write_json(robustness_path, {})
    _write_json(region_correlations_path, [])
    _write_json(hypothesis_results_path, hypothesis_results)
    _write_json(
        figure_spec_path,
        {
            "figure_strategy": "blueprint-rendered",
            "figures": figure_specs,
        },
    )
    _write_json(validation_path, validation_summary)
    _write_json(analysis_trace_path, analysis_trace)

    # ``tidy.csv`` is intentionally left empty by default; a blueprint that
    # wants to publish a normalized analysis frame can write it at this path
    # itself (the path is exposed via ``RESEARCHLAB_OUTPUT_DIR``).
    if not tidy_path.is_file():
        tidy_path.write_text("", encoding="utf-8")

    _write_summary_md(
        summary_path=summary_path,
        dataset_root=dataset_root,
        handoff=handoff,
        executions=executions,
        external_agent_executions=external_agent_executions,
        validation_summary=validation_summary,
    )

    # Figure + table artifacts as flat lists, useful for the live-view gallery.
    figure_artifacts: List[Dict[str, Any]] = []
    table_artifacts: List[Dict[str, Any]] = []
    for execution in executions:
        for figure in execution.figures:
            figure_artifacts.append(figure)
        for table in execution.tables:
            table_artifacts.append(table)

    stats = {
        "correlations": correlations,
        "evidence_grade": evidence_grade,
        "row_count": 0,  # unknown at driver level — blueprints can report via metrics
        "country_count": 0,
        "year_range": None,
        "region_correlations": [],
        "region_summary": [],
        "robustness": {},
    }

    # Fail-closed: reflect what the blueprints actually produced instead of
    # always claiming success. See _result_status — a lane whose every blueprint
    # died (e.g. the proposed integrator plugin does not exist) must not report
    # "completed", or the gate/watchdog/self-healing layers never see the failure.
    result = {
        "status": _result_status(executions),
        "driver": DRIVER_NAME,
        "dataset_root": str(dataset_root),
        "dataset_root_source": dataset_root_source,
        "dataset_mapping": {},
        "column_mapping": {},
        "summary_path": str(summary_path),
        "tidy_path": str(tidy_path),
        "role_plan_path": str(role_plan_file) if role_plan_file else None,
        "role_plan": role_plan,
        "executed_handoff_path": executed_handoff_path,
        "correlations_path": str(correlations_path),
        "robustness_path": str(robustness_path),
        "region_correlations_path": str(region_correlations_path),
        "hypothesis_results_path": str(hypothesis_results_path),
        "figure_spec_path": str(figure_spec_path),
        "validation_summary_path": str(validation_path),
        "analysis_trace_path": str(analysis_trace_path),
        "stats": stats,
        "validation_summary": validation_summary,
        "analysis_contract": canonical_contract,
        "analysis_contract_validation": contract_binding,
        "execution_receipts": [_read_json(Path(e.output_dir) / "driver-execution-receipt.json") for e in executions
                               if (Path(e.output_dir) / "driver-execution-receipt.json").is_file()],
        "open_source_agent_requirements": validation_summary.get("open_source_agent_requirements"),
        "quality_gates": quality_gates,
        "analysis_trace": analysis_trace,
        "hypothesis_results": hypothesis_results,
        "selected_hypotheses": selected_hypotheses,
        "scientist_mode": "blueprint-executor",
        "primary_scientist_result_path": None,
        "primary_scientist_result": None,
        "validation_coding_result_path": None,
        "validation_coding_result": None,
        "experiment_result_path": None,
        "experiment_result": None,
        "blueprint_executions": [
            {
                "blueprint_id": e.blueprint_id,
                "check_id": e.check_id,
                "status": e.status,
                "return_code": e.return_code,
                "duration_seconds": e.duration_seconds,
                "script_path": e.script_path,
                "stdout_path": e.stdout_path,
                "stderr_path": e.stderr_path,
                "output_dir": e.output_dir,
                "timeout_seconds": e.timeout_seconds,
                "figures": e.figures,
                "tables": e.tables,
                "metrics": e.metrics,
                "error": e.error,
                "derived_indicator_specs": e.derived_indicator_specs,
                "derived_indicator_outcomes": e.derived_indicator_outcomes,
                "pip_install": e.pip_install,
                # Whether this execution left real evidence behind, as this driver
                # judges it. "completed" above only means the process exited.
                "produced_evidence": _execution_produced_evidence(e),
            }
            for e in executions
        ],
        "external_agent_runs": [
            {
                "agent_name": e.agent_name,
                "stage": e.stage,
                "status": e.status,
                "command": e.command,
                "cwd": e.cwd,
                "stdout_path": e.stdout_path,
                "stderr_path": e.stderr_path,
                "duration_seconds": e.duration_seconds,
                "return_code": e.return_code,
                "error": e.error,
                "output_dir": e.output_dir,
            }
            for e in external_agent_executions
        ],
        "pip_installs": [
            e.pip_install for e in executions if e.pip_install
        ],
        "figure_artifacts": figure_artifacts,
        "table_artifacts": table_artifacts,
        # Top-level roll-up: specs the analyst proposed + whatever the
        # blueprints reported back about each indicator (value, stats, chart
        # paths). Chronicle and the live view use this to render the
        # derived-indicator card without re-parsing per-blueprint stdout.
        "derived_indicators_declared": handoff.get("derived_indicators")
            if isinstance(handoff.get("derived_indicators"), list)
            else [],
        "derived_indicator_outcomes": [
            outcome
            for execution in executions
            for outcome in execution.derived_indicator_outcomes
        ],
        "task_file_summary": _read_text(task_file)[:2000] if task_file else "",
    }
    # A completed run that measured nothing carries its own degraded flag and
    # category, which the harness copies onto the lane. See _unmeasured_completion.
    result.update(_unmeasured_completion(result["status"], executions))

    result_path.write_text(
        json.dumps(_sanitize_nonfinite(result), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result


def _give_blueprint_contract(blueprint: Any, contract_binding: Optional[Dict[str, Any]], canonical_contract: Optional[Dict[str, Any]]) -> None:
    """Hand a contract-bound blueprint, primary or supporting, its contract file."""
    if contract_binding and canonical_contract:
        blueprint.raw["analysis_contract"] = canonical_contract


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--task-file")
    parser.add_argument("--role-plan-file")
    args = parser.parse_args()

    try:
        result = run_driver(
            Path(args.csv_root),
            Path(args.output_dir),
            Path(args.task_file) if args.task_file else None,
            Path(args.role_plan_file) if args.role_plan_file else None,
        )
        validation_summary = result.get("validation_summary")
        stdout_summary = {
            "status": result.get("status"),
            "driver": result.get("driver"),
            "result_path": str(Path(args.output_dir) / "result.json"),
            "validation_summary": {
                "overall_status": validation_summary.get("overall_status"),
                "score": validation_summary.get("score"),
                "open_source_agent_requirements": validation_summary.get(
                    "open_source_agent_requirements"
                ),
            }
            if isinstance(validation_summary, dict)
            else None,
        }
        print(json.dumps(_sanitize_nonfinite(stdout_summary), ensure_ascii=False, indent=2))
        # Capability probes are execution checks. A failed probe must be a failed
        # process, even if it emitted partial inventory. Preserve the existing
        # exit semantics of scientific hypothesis/falsification lanes.
        if result.get("lane_kind") == "instrument_probe" and result.get("status") != "completed":
            return 1
        return 0
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    raise SystemExit(main())


# Seed literals a blueprint may use to preregister its run. cycle-g-v87 used
# `SEEDS=[...]` in 7 of 10 blueprints; the others are accepted so a blueprint that
# spells it differently is not silently overridden.
_BLUEPRINT_SEED_PATTERNS = (
    re.compile(r"\bSEEDS\s*=\s*\[([0-9,\s]+)\]"),
    re.compile(r"\bSEED_LIST\s*=\s*\[([0-9,\s]+)\]"),
    re.compile(r"\bseeds\s*=\s*\[([0-9,\s]+)\]"),
    re.compile(r"\bPINNED_SEEDS\s*=\s*\[([0-9,\s]+)\]"),
)
_BLUEPRINT_CHECK_ID = re.compile(r"CHECK_ID\s*=\s*['\"]([^'\"]+)['\"]")


def _seeds_from_blueprint_code(code: Any) -> Optional[List[int]]:
    """The seed list a blueprint pins in its own source, if it pins one."""
    if not isinstance(code, str) or not code:
        return None
    for pattern in _BLUEPRINT_SEED_PATTERNS:
        match = pattern.search(code)
        if not match:
            continue
        try:
            seeds = [int(part) for part in match.group(1).split(",") if part.strip()]
        except ValueError:
            continue
        if seeds:
            return seeds
    return None


def _blueprint_seeds_for_check(handoff: Dict[str, Any], check: Dict[str, Any]) -> Optional[List[int]]:
    """Seeds preregistered by the blueprint that implements this check.

    Bound by blueprint_id/check_id first, then by the CHECK_ID literal in the
    source. When the handoff carries exactly one check and one blueprint they are
    bound regardless: 3 of v87's 10 blueprints declared no CHECK_ID at all, and a
    single-check handoff leaves nothing to confuse it with.
    """
    blueprints = handoff.get("validation_code_blueprints")
    if not isinstance(blueprints, list) or not blueprints:
        return None
    check_id = str(check.get("check_id") or check.get("id") or "").strip()
    checks = handoff.get("handoff_checks")
    single = isinstance(checks, list) and len(checks) == 1 and len(blueprints) == 1

    for blueprint in blueprints:
        if not isinstance(blueprint, dict):
            continue
        code = blueprint.get("code")
        declared = str(blueprint.get("check_id") or "").strip()
        if not declared:
            match = _BLUEPRINT_CHECK_ID.search(code) if isinstance(code, str) else None
            declared = match.group(1).strip() if match else ""
        if check_id and declared and declared != check_id:
            continue
        if not (check_id and declared) and not single:
            continue
        seeds = _seeds_from_blueprint_code(code)
        if seeds:
            return seeds
    return None


def _stamp_handoff_reproducibility(handoff: Dict[str, Any]) -> Dict[str, Any]:
    """Give every check in this handoff a reproducibility design, whoever wrote it.

    Measured on cycle-g-v84: of 17 hypothesis-bound runner lanes, 17 emitted no
    seed field, 16 named no comparator, 15 reported no dispersion. The gate held
    technical_quality at 35 and reproducibility at 76 on that evidence, which was
    an honest reading of runs that could not support either axis.

    THE BLUEPRINT DECIDES THE SEEDS. It is the artifact that runs, and on
    cycle-g-v87 it hard-failed when the check spec disagreed with it:

        ValueError: reproducibility seeds must be exactly [101, 211, 307, 401, 503];
        got [0, 1, 2, 3, 4]

    Both numbers came from the same handoff. The analyst preregistered its seeds in
    `validation_code_blueprints[*].code`, left `reproducibility_design` unset, and
    this function read the silence and filled its default -- which then reached the
    blueprint through RESEARCHLAB_CHECK_SPEC and was rejected. Ten executions died
    that way, every lead-bound run of the cycle, and the reproducibility rubric
    honestly scored 8 on the resulting `unsupported` rigor profile.

    So blueprint-declared seeds are adopted even over a design the analyst wrote,
    because a design that disagrees with the code it configures kills the run. The
    rest of an analyst-written design is left exactly as it is, and the v84 default
    still fills genuine silence -- a handoff whose blueprints pin nothing.
    """
    if not isinstance(handoff, dict):
        return handoff
    checks = handoff.get("handoff_checks")
    if not isinstance(checks, list):
        return handoff
    for check in checks:
        if not isinstance(check, dict):
            continue
        blueprint_seeds = _blueprint_seeds_for_check(handoff, check)
        existing = check.get("reproducibility_design")
        if existing:
            # Only the seeds are overridden, and only when the blueprint pinned
            # some: everything else the analyst wrote is its own.
            if blueprint_seeds and isinstance(existing, dict):
                if list(existing.get("seeds") or []) != blueprint_seeds:
                    existing["seeds"] = list(blueprint_seeds)
                    existing["seed_count"] = len(blueprint_seeds)
                    existing["seeds_source"] = "blueprint (preregistered in code)"
            continue
        exposures = [str(x) for x in (check.get("exposures") or [])]
        comparator = next(
            (
                x
                for x in exposures
                if any(t in x.lower() for t in ("strategy", "method", "arm", "variant", "condition"))
            ),
            None,
        )
        seeds = blueprint_seeds or [0, 1, 2, 3, 4]
        check["reproducibility_design"] = {
            "seeds": list(seeds),
            "seed_count": len(seeds),
            "seeds_source": (
                "blueprint (preregistered in code)"
                if blueprint_seeds
                else "python-stats-driver default (no blueprint pinned any)"
            ),
            "comparator": comparator
            or "NAME THE RIVAL ARM this result is measured against - current practice, the "
            "cheaper obvious alternative, or the ablation that removes the mechanism. A number "
            "with nothing beside it is not evidence.",
            "dispersion_statistic": "std",
            "required_output_shape": (
                "one result row PER SEED, each row carrying its seed value, so the across-seed "
                "spread can be recomputed from the output instead of taken on trust"
            ),
            "matched_budget": "hold sample budget or wall time equal between arms so the comparison is fair",
            "why_affordable": (
                "Not established by this default. Cite measured cost from the selected instrument "
                "and scale it to the declared experiment before claiming affordability."
            ),
            "stamped_by": "python-stats-driver (handoff carried no design)",
        }
    return handoff
