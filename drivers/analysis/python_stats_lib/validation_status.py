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

from .constants import DRIVER_NAME
from .io_utils import _coerce_list, _coerce_str, _slugify
from .execution_model import BlueprintExecution, ExternalAgentExecution
from .external_agent import _repository_agent_requirement_summary
from .evidence import _UNRUNNABLE_NOTE_MARKERS, _aggregate_unrunnable_methods, _execution_is_clean_falsification, _execution_produced_evidence, _measured_quantities, _table_rigor_evidence


def _execution_hard_failed(execution: BlueprintExecution) -> bool:
    """True when this execution failed outright rather than merely finding a null result.

    A null *scientific* result (ran fine, effect ~0) is NOT a failure. A crash,
    a timeout, an un-instantiable method, or degenerate inf metrics IS.
    """

    if execution.status in {"failed", "timeout"}:
        return True
    if execution.error:
        return True
    metrics = execution.metrics or {}
    if str(metrics.get("pass_fail", "")).strip().lower() == "fail":
        # v85: a clean falsification backed by real tables is resolved evidence,
        # not a failed blueprint. See _execution_is_clean_falsification.
        return not _execution_is_clean_falsification(execution)
    notes = str(metrics.get("notes", "")).lower()
    if any(marker in notes for marker in _UNRUNNABLE_NOTE_MARKERS):
        return True
    if "=inf" in notes.replace(" ", ""):
        return True
    return False


def _result_status(executions: Iterable[BlueprintExecution]) -> str:
    """Fail-closed lane status derived from what the blueprints actually produced.

    The driver used to hardcode ``"completed"``. Because the gate, the watchdog
    and every self-healing layer read lane status, a lane whose blueprints all
    failed still looked like a success: v61/v62/v63 each burned their entire
    review budget on evidence that was never produced (v63: 22 executions died on
    ``Plugin "h_rps" not found`` while reporting completed/error=null).

    Deliberately conservative so working cycles are unaffected: with no explicit
    failure signal the status stays ``completed`` exactly as before. Only an
    execution that positively signals failure can demote the lane — to
    ``degraded`` when some other blueprint still produced real evidence, and to
    ``failed`` when nothing usable came out at all.
    """

    real = [execution for execution in executions if execution is not None]
    if not real:
        return "failed"
    if not any(_execution_hard_failed(execution) for execution in real):
        return "completed"
    if any(_execution_produced_evidence(execution) for execution in real):
        return "degraded"
    return "failed"


# A run that finished and measured nothing is not a finished measurement.
#
# _result_status is deliberately conservative: with no execution that positively
# signals failure the lane stays "completed", so a working cycle is unaffected.
# That leaves one shape reading as a success it is not -- every blueprint exited
# cleanly and not one of them produced evidence. The run did not fail; it
# declined to measure.
#
# MEASURED ON cycle-g-v91, 2026-09-14. The handoff from followup-analyst-79 told
# the runner to measure nothing until an audit file existed that no role
# produces. followup-runner-63 and -64 each exited 0 in about a second with
# pass_fail "inconclusive" and zero measurements. This driver already judged both
# correctly -- validation_summary.overall_status "degraded" -- and both lanes
# still read completed with degraded false, because the verdict never reached
# the fields the harness copies onto the lane (engine.rs takes `degraded` and
# `failure_category` from this result). No rubric moved for five gate rounds and
# the watchdog halted the cycle, with nothing but a gatekeeper's prose saying why.
#
# The status stays "completed" on purpose: the run did not break, and "failed"
# would send it through failure recovery and the self-healer's reset. The flag
# and the category are what say it produced nothing. A falsification that
# measured is evidence (see _execution_produced_evidence) and is never flagged.
NO_MEASUREMENT_FAILURE_CATEGORY = "no_measurement_produced"


def _unmeasured_completion(status: str, executions: Iterable[BlueprintExecution]) -> Dict[str, Any]:
    """Lane flags for a completed run in which no execution produced evidence."""

    real = [execution for execution in executions if execution is not None]
    if status != "completed" or not real:
        return {}
    if any(_execution_produced_evidence(execution) for execution in real):
        return {}
    return {"degraded": True, "failure_category": NO_MEASUREMENT_FAILURE_CATEGORY}


def _aggregate_evidence_grade(
    executions: Iterable[BlueprintExecution],
) -> Dict[str, str]:
    """Collect evidence grade labels keyed as ``<outcome>_link``."""

    out: Dict[str, str] = {}
    for execution in executions:
        metrics = execution.metrics or {}
        grades = metrics.get("evidence_grade")
        if isinstance(grades, dict):
            for key, value in grades.items():
                if isinstance(key, str) and isinstance(value, str):
                    out[key] = value
    return out


def _aggregate_selected_hypotheses(
    handoff: Dict[str, Any],
    validation_summary: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Surface the analyst's own candidate hypotheses as the lane's selection.

    The previous driver invented 33 hypotheses internally; this driver defers
    entirely to the analyst's handoff contract. If the analyst named a primary
    hypothesis we list it first, then each candidate family in priority order.
    """

    selected: List[Dict[str, Any]] = []
    primary_id = _coerce_str(handoff.get("primary_hypothesis_id"))
    summary = _coerce_str(handoff.get("summary"))
    checks = _coerce_list(handoff.get("handoff_checks"))
    primary_check = checks[0] if checks and isinstance(checks[0], dict) else {}
    families = _coerce_list(handoff.get("candidate_primary_families"))
    primary_family = ""
    if families and isinstance(families[0], dict):
        primary_family = _coerce_str(families[0].get("family_root")) or _coerce_str(families[0].get("family"))
    outcome = _coerce_str(primary_check.get("outcome"))
    exposures = [x for x in _coerce_list(primary_check.get("exposures")) if isinstance(x, str)]
    success = primary_check.get("success_criteria") if isinstance(primary_check.get("success_criteria"), dict) else {}
    validation_passed = (validation_summary or {}).get("overall_status") == "passed"
    method_score = (validation_summary or {}).get("method_appropriateness_score")
    accuracy_score = (validation_summary or {}).get("analysis_accuracy_score")
    validation_checks = (validation_summary or {}).get("checks")
    checks_passed = sum(1 for value in (validation_checks or {}).values() if value is True) if isinstance(validation_checks, dict) else 0
    primary_status = "robust" if validation_passed else "exploratory"
    falsification_tests = [
        x for x in _coerce_list(handoff.get("falsification_ideas")) if isinstance(x, str)
    ]
    validation_plan = [
        _coerce_str(item.get("goal")) or _coerce_str(item.get("check_id"))
        for item in checks
        if isinstance(item, dict)
    ]
    evidence = {
        "blueprints_passed": float((validation_summary or {}).get("blueprints_passed") or 0),
        "checks_passed_count": float(checks_passed),
    }
    try:
        if method_score is not None:
            evidence["method_appropriateness_score"] = float(method_score)
        if accuracy_score is not None:
            evidence["analysis_accuracy_score"] = float(accuracy_score)
    except (TypeError, ValueError):
        pass
    if primary_id:
        selected.append(
            {
                "hypothesis_id": primary_id,
                "statement": summary or primary_id,
                "status": primary_status,
                "family": primary_family,
                "family_root": primary_family,
                "x_variable": exposures[0] if exposures else None,
                "y_variable": outcome or None,
                "direction": _coerce_str(success.get("expected_sign")) or "unknown",
                "mechanism": primary_family or None,
                "mechanisms": [_coerce_str(item) for item in _coerce_list(handoff.get("candidate_estimands")) if item],
                "confounders": [_coerce_str(item) for item in _coerce_list(handoff.get("confounders")) if item],
                "rivals": [
                    _coerce_str(item.get("rival")) if isinstance(item, dict) else _coerce_str(item)
                    for item in _coerce_list(handoff.get("rival_dags"))
                ],
                "falsification_tests": falsification_tests,
                "falsification_rule": "; ".join(falsification_tests[:2]) if falsification_tests else None,
                "validation_plan": validation_plan,
                "validation_protocol": {
                    "dataset": _coerce_str(primary_check.get("dataset")) or _coerce_str(handoff.get("dataset_root")),
                    "model": _coerce_str(primary_check.get("model_family")) or "blueprint validation",
                    "comparison": " vs ".join(exposures[:2]) if exposures else _coerce_str(primary_check.get("goal")),
                    "acceptance_criterion": _coerce_str(success.get("minimum_effect_description")) or "blueprint pass_fail == pass",
                },
                "evidence": evidence,
                "expected_impact": 0.72 if validation_passed else 0.45,
                "verifiability": min(1.0, float(accuracy_score or 0) / 100.0) if accuracy_score is not None else 0.5,
                "structural_novelty": min(1.0, float(method_score or 0) / 120.0) if method_score is not None else 0.5,
                "total_score": (
                    min(1.0, ((float(method_score or 0) + float(accuracy_score or 0)) / 200.0))
                    if method_score is not None and accuracy_score is not None
                    else 0.55
                ),
                "claims": [
                    {
                        "claim_id": f"claim:{_slugify(primary_id)}",
                        "statement": summary or primary_id,
                        "status": primary_status,
                        "x_variable": exposures[0] if exposures else None,
                        "y_variable": outcome or None,
                        "direction": _coerce_str(success.get("expected_sign")) or "unknown",
                    }
                ],
            }
        )
    for idx, family in enumerate(_coerce_list(handoff.get("candidate_primary_families"))):
        if not isinstance(family, dict):
            continue
        family_root = _coerce_str(family.get("family_root")) or _coerce_str(family.get("family"))
        if not family_root:
            continue
        selected.append(
            {
                "hypothesis_id": f"hyp-{_slugify(family_root)}-{idx:02d}",
                "statement": _coerce_str(family.get("why_competitive"))
                or f"Candidate family: {family_root}",
                "status": "exploratory",
                "family": family_root,
            }
        )
    return selected


def _figures_spec(executions: Iterable[BlueprintExecution]) -> List[Dict[str, Any]]:
    """Emit a figure-spec entry per rendered figure.

    The shape mirrors the old ``figure-spec.json`` so the illustrator / live
    view can discover rendered images, but the entries only reference files
    that actually exist on disk (produced by blueprint scripts).
    """

    specs: List[Dict[str, Any]] = []
    for execution in executions:
        for figure in execution.figures:
            specs.append(
                {
                    "id": f"{execution.blueprint_id}::{figure['name']}",
                    "blueprint_id": execution.blueprint_id,
                    "check_id": execution.check_id,
                    "path": figure["path"],
                    "kind": "rendered",
                    "suffix": figure["suffix"],
                    "size_bytes": figure["size_bytes"],
                }
            )
    return specs



def _as_optional_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_optional_int(value: Any) -> Optional[int]:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None



def _metric_truthy(metrics: Dict[str, Any], *keys: str) -> bool:
    truthy_tokens = {"true", "yes", "1", "resolved", "valid", "impossible", "not_applicable"}
    for key in keys:
        value = metrics.get(key)
        if isinstance(value, bool):
            if value:
                return True
        elif isinstance(value, str) and value.strip().lower() in truthy_tokens:
            return True
    return False


def _execution_resolution(execution: BlueprintExecution) -> Dict[str, Any]:
    metrics = execution.metrics or {}
    # MEASURED ON cycle-a-20260919, 2026-09-30: 54 blueprints that
    # failed before measuring anything had empty metrics, so the unconditional
    # fallback wrote pass_fail="pass" into their handoff check resolutions.
    # Preserve the legacy default for completed blueprints, but fail closed when
    # the process itself did not complete and therefore emitted no verdict.
    default_pass_fail = "pass" if execution.status == "completed" else "inconclusive"
    pass_fail = str(metrics.get("pass_fail") or default_pass_fail).strip().lower()
    resolution_status = str(
        metrics.get("resolution_status")
        or metrics.get("check_resolution")
        or metrics.get("scientific_resolution")
        or ""
    ).strip().lower()
    accepted_resolution = resolution_status in {
        "resolved",
        "valid_falsification",
        "valid_negative",
        "blocked",
        "data_unavailable",
        "impossible",
        "irrecoverable",
        "not_applicable",
        "not_supported_by_data",
        "schema_blocked",
        "unsupported",
        "unsupported_by_available_data",
        "escalate_to_labdirector",
        "escalated_to_labdirector",
        "escalate_to_gatekeeper",
    }
    valid_falsification = _metric_truthy(
        metrics,
        "valid_falsification_result",
        "valid_negative_result",
    )
    # The blueprint SHOULD declare resolution_status/valid_falsification_result
    # when it falsifies its own hypothesis, but v85 measured that analyst-authored
    # blueprints simply print pass_fail="fail" and leave both fields unset. Infer
    # it from what the run actually produced, and keep the declared and inferred
    # forms separate so a relabelled run stays auditable.
    inferred_falsification = (
        pass_fail == "fail" and _execution_is_clean_falsification(execution)
    )
    resolved = execution.status == "completed" and (
        pass_fail == "pass"
        or valid_falsification
        or accepted_resolution
        or inferred_falsification
    )
    return {
        "check_id": execution.check_id,
        "status": execution.status,
        "pass_fail": pass_fail,
        "resolution_status": resolution_status or None,
        "resolved": bool(resolved),
        "valid_falsification_result": bool(valid_falsification),
        "inferred_clean_falsification": bool(inferred_falsification),
        "notes": metrics.get("notes"),
    }

def _analyst_quality_standard_result(
    handoff: Dict[str, Any],
    *,
    validation_summary: Dict[str, Any],
    checks: Dict[str, bool],
    external_agent_executions: List[ExternalAgentExecution],
    executions: Optional[List[BlueprintExecution]] = None,
) -> Dict[str, Any]:
    standard = handoff.get("analyst_quality_standard")
    if not isinstance(standard, dict):
        return {
            "declared": False,
            "satisfied": True,
            "failed_requirements": [],
            "notes": "Legacy handoff did not declare an analyst quality standard; no additional analyst-standard gate was applied.",
        }

    failed: List[str] = []
    # Criteria the attached blueprints cannot observe (a score floor whose metric
    # no blueprint emits, or a prose sentence in required_validation_checks that
    # can never equal a check_id) are NOT scientific failures — they are contract
    # mismatches authored for a different validation modality. Report them
    # separately so the gatekeeper sees them, instead of silently degrading every
    # run of a modality that cannot produce the metric (113/123 v55 validations
    # were auto-degraded this way). Checks that ARE slug-like ids but never ran
    # still fail closed below.
    inapplicable: List[str] = []
    # Declared, satisfiable by this modality, and unverified. Reported only.
    observed_not_enforced: List[str] = []
    evaluated_requirements: List[Dict[str, Any]] = []
    min_passed = _as_optional_int(standard.get("minimum_blueprints_passed"))
    if min_passed is not None and (validation_summary.get("blueprints_passed") or 0) < min_passed:
        failed.append("minimum_blueprints_passed")

    if bool(standard.get("require_no_blueprint_failures")) and (validation_summary.get("blueprints_failed") or 0) > 0:
        failed.append("require_no_blueprint_failures")

    if bool(standard.get("require_all_handoff_checks_pass")) and validation_summary.get("checks_failed", 0) > 0:
        failed.append("require_all_handoff_checks_pass")

    handoff_resolutions = [
        item
        for item in (validation_summary.get("handoff_check_resolutions") or [])
        if isinstance(item, dict)
    ]
    unresolved = [
        item.get("check_id") or "unknown_check"
        for item in handoff_resolutions
        if not item.get("resolved")
    ]
    if bool(standard.get("require_all_handoff_checks_resolved")):
        for check_id in unresolved:
            failed.append(f"handoff_check_unresolved:{check_id}")

    def _check_lineage(name: str) -> str:
        return re.sub(r"_v\d+$", "", str(name or "").strip())

    required_checks = standard.get("required_validation_checks")
    if isinstance(required_checks, list):
        for item in required_checks:
            if not (isinstance(item, str) and item):
                continue
            if item in checks:
                if not checks[item]:
                    failed.append(f"required_validation_check:{item}")
                continue
            # A numeric condition is not a check id. Compare the original
            # emitted value, before _validation_summary coerces checks to bool.
            expression = re.fullmatch(
                r"\s*([A-Za-z_][\w.-]*)\s*(>=|<=|==|!=|>|<|=)\s*"
                r"(true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*",
                item, re.IGNORECASE,
            )
            if expression:
                name, operator, literal = expression.groups()
                boolean = literal.lower() in ("true", "false")
                expected = literal.lower() == "true" if boolean else float(literal)
                values = []
                for execution in executions or []:
                    if execution.status != "completed":
                        continue
                    metrics = execution.metrics or {}
                    reported = metrics.get("checks") or {}
                    if isinstance(reported, dict) and name in reported:
                        values.append(reported[name])
                    elif name in metrics:
                        values.append(metrics[name])

                def matches(value):
                    if boolean:
                        if not isinstance(value, bool) or operator not in ("=", "==", "!="):
                            return False
                    elif isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not math.isfinite(expected):
                        return False
                    return {
                        "=": lambda: value == expected, "==": lambda: value == expected,
                        "!=": lambda: value != expected, ">=": lambda: value >= expected,
                        "<=": lambda: value <= expected, ">": lambda: value > expected,
                        "<": lambda: value < expected,
                    }[operator]()

                satisfied = bool(values) and all(matches(value) for value in values)
                evaluated_requirements.append({
                    "requirement": item, "metric": name,
                    "observed_values": [str(value) if isinstance(value, float) and not math.isfinite(value) else value for value in values],
                    "satisfied": satisfied,
                })
                if not satisfied:
                    failed.append(f"required_validation_check:{item}")
                continue
            # Analysts version-bump check ids (_vNN); match by lineage before
            # declaring the requirement unmet.
            lineage_hits = [key for key in checks if _check_lineage(key) == _check_lineage(item)]
            if lineage_hits:
                if not all(checks[key] for key in lineage_hits):
                    failed.append(f"required_validation_check:{item}")
                continue
            if any(ch.isspace() for ch in item.strip()):
                # Prose expectation, not a check id — it can never match the
                # executed-check registry. Surface it instead of phantom-failing.
                #
                # But "written as prose" is not the same as "this modality cannot
                # produce it", and the waiver had grown to cover both.
                #
                # MEASURED ON cycle-g-v81: 560 requirements were waived against
                # 152 enforced — a 79% waiver rate. Of the 448 waived prose
                # requirements, 167 were ordinary statistical rigour that
                # procedural rendering can absolutely deliver: held-out scene
                # folds, bootstrap draws, permutation tests, AUROC/ECE/Brier,
                # both outcome classes present in every partition. A run that
                # reported two correlations and nothing else came back
                # `satisfied: true` with `failed_requirements: []`.
                #
                # OBSERVE-ONLY FOR NOW. These move to their own bucket so the
                # next cycle can measure how many runs would fail if they were
                # enforced, WITHOUT failing anything yet. `satisfied` still
                # depends on `failed` alone, so behaviour is unchanged. The
                # previous attempt to tighten this (c187938, from the other
                # direction) auto-degraded 113 of 123 validations, so the
                # enforcement switch waits for that measurement.
                if _RIGOUR_REQUIREMENT.search(item):
                    observed_not_enforced.append(f"rigour_prose:{item[:120]}")
                else:
                    inapplicable.append(f"required_validation_check_prose:{item[:80]}")
            else:
                # A slug-like declared check that never executed is a real
                # gap — keep failing closed.
                failed.append(f"required_validation_check:{item}")

    # The analysis-accuracy/method scores belong to the tabular (master-table)
    # analytics contract. A handoff whose validation is render-and-measure or
    # procedural/simulation (master-table gate not required) has blueprints that
    # never emit them, so an unmeasured floor there is a modality mismatch, not
    # a quality failure. The master-table requirement is merged from the role
    # plan, so an omics cycle cannot opt out by omitting it from the handoff.
    master_table_required = bool(
        (validation_summary.get("analysis_master_table_gate") or {}).get("required")
    )
    score_floor_applicable = master_table_required and not _handoff_carries_render_check(handoff)

    min_method = _as_optional_float(standard.get("minimum_method_appropriateness_score"))
    method_score = _as_optional_float(validation_summary.get("method_appropriateness_score"))
    if min_method is not None:
        if method_score is not None and method_score < min_method:
            failed.append("minimum_method_appropriateness_score")
        elif method_score is None:
            if score_floor_applicable:
                failed.append("minimum_method_appropriateness_score")
            else:
                inapplicable.append("minimum_method_appropriateness_score:metric_not_emitted_by_this_modality")

    min_accuracy = _as_optional_float(standard.get("minimum_analysis_accuracy_score"))
    accuracy_score = _as_optional_float(validation_summary.get("analysis_accuracy_score"))
    if min_accuracy is not None:
        if accuracy_score is not None and accuracy_score < min_accuracy:
            failed.append("minimum_analysis_accuracy_score")
        elif accuracy_score is None:
            if score_floor_applicable:
                failed.append("minimum_analysis_accuracy_score")
            else:
                inapplicable.append("minimum_analysis_accuracy_score:metric_not_emitted_by_this_modality")

    min_external = _as_optional_int(standard.get("minimum_external_agent_runs_passed"))
    if min_external is not None:
        external_passed = sum(1 for run in external_agent_executions if run.status == "completed")
        if external_passed < min_external:
            failed.append("minimum_external_agent_runs_passed")

    allow_inconclusive = bool(standard.get("allow_inconclusive_for_gate_review"))
    status = str(validation_summary.get("overall_status") or "").lower()
    resolved_nonpass_is_actionable = bool(standard.get("require_all_handoff_checks_resolved")) and handoff_resolutions and not unresolved and not failed
    if not allow_inconclusive and status != "passed" and not resolved_nonpass_is_actionable:
        failed.append("overall_status_not_passed")

    deduped_failed = list(dict.fromkeys(failed))
    deduped_inapplicable = list(dict.fromkeys(inapplicable))
    deduped_observed = list(dict.fromkeys(observed_not_enforced))
    return {
        "declared": True,
        "standard": standard,
        "satisfied": not deduped_failed,
        "failed_requirements": deduped_failed,
        "evaluated_requirements": evaluated_requirements,
        "inapplicable_requirements": deduped_inapplicable,
        # Requirements the analyst declared, that this modality CAN produce, and
        # that were not checked. Reported, deliberately not enforced yet.
        "observed_but_not_enforced": deduped_observed,
        "notes": "Analyst-declared quality standard evaluated after blueprint and external-agent execution. Inapplicable requirements reference observables the attached blueprints do not produce (modality mismatch); they are reported for gate review, not counted as failures. observed_but_not_enforced lists declared statistical-rigour requirements that this modality COULD satisfy and that nothing verified — measurement only, pending an enforcement decision.",
    }

# Statistical rigour a procedural/rendering modality can deliver: scene folds,
# repeated seeds, resampling, calibration and discrimination metrics, explicit
# comparators. Deliberately narrow - it must not catch modality-specific
# artifacts ("emit render_metrics.csv") or pipeline preconditions ("non-null
# selected_hypothesis"), which are separate concerns.
_RIGOUR_REQUIREMENT = re.compile(
    r"seed|bootstrap|permutation|confidence|interval|\bCI\b|variance|std\b|error bar"
    r"|repeat|replicat|fold|cross-?valid|hold-?out|held-?out|ablation|baseline|comparator"
    r"|control|significan|p-value|power|calibrat|\bECE\b|Brier|balanced accuracy"
    r"|AUROC|AUPRC|outcome class",
    re.IGNORECASE,
)


def _handoff_carries_render_check(handoff: Dict[str, Any]) -> bool:
    """True when the handoff validates via a render-and-measure check (a
    computer-graphics / rendering objective), which produces a rendered image +
    render_metrics.csv rather than a tabular analysis master table."""
    if not isinstance(handoff, dict):
        return False
    items = list(handoff.get("handoff_checks") or []) + list(handoff.get("validation_code_blueprints") or [])
    for item in items:
        if not isinstance(item, dict):
            continue
        if str(item.get("model_family") or "") == "render-and-measure-convergence":
            return True
        if "render_quality_convergence" in str(item.get("check_id") or ""):
            return True
    return False


def _master_table_gate_result(
    executions: List[BlueprintExecution],
    handoff: Dict[str, Any],
    role_plan: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    # A render objective has no tabular master table; the render-and-measure
    # check IS the substantive validation. Do not require the omics master-table
    # gate for it (even if a stale role_plan still carries required=true).
    if _handoff_carries_render_check(handoff):
        return {
            "required": False,
            "satisfied": True,
            "failed_requirements": [],
            "notes": "Render-and-measure objective: no tabular analysis master table applies.",
        }
    gate = {}
    if isinstance(role_plan, dict) and isinstance(role_plan.get("pre_validation_master_table_gate"), dict):
        gate.update(role_plan.get("pre_validation_master_table_gate") or {})
    for key in ("pre_validation_master_table_gate", "analysis_master_table_gate"):
        if isinstance(handoff.get(key), dict):
            gate.update(handoff.get(key) or {})

    master_table_contract = None
    for key in ("analysis_master_table", "master_table", "pre_validation_master_table"):
        if isinstance(handoff.get(key), dict):
            master_table_contract = handoff.get(key)
            break

    required = bool(gate.get("required")) or master_table_contract is not None
    if not required:
        return {
            "required": False,
            "satisfied": True,
            "failed_requirements": [],
            "notes": "No pre-validation analysis master table gate was declared.",
        }

    required_check_id = _coerce_str(gate.get("required_check_id")) or "analysis_master_table_created"
    artifact_pattern = (
        _coerce_str(gate.get("required_artifact_name_pattern"))
        or _coerce_str((master_table_contract or {}).get("artifact_name_pattern"))
        or "master_table"
    ).lower()
    declared_path = _coerce_str((master_table_contract or {}).get("path") or (master_table_contract or {}).get("output_path"))

    metric_pass = False
    resolved_check = False
    matching_tables: List[Dict[str, Any]] = []
    for execution in executions:
        metrics = execution.metrics or {}
        metric_checks = metrics.get("checks")
        if isinstance(metric_checks, dict) and bool(metric_checks.get(required_check_id)):
            metric_pass = True
        if execution.check_id == required_check_id and execution.status == "completed":
            resolution = _execution_resolution(execution)
            resolved_check = bool(resolution.get("resolved"))
        for table in execution.tables or []:
            haystack = f"{table.get('name') or ''} {table.get('path') or ''}".lower()
            if artifact_pattern and artifact_pattern in haystack:
                matching_tables.append(table)

    declared_path_exists = bool(declared_path and Path(declared_path).exists())
    satisfied = bool((metric_pass or resolved_check) and (matching_tables or declared_path_exists))
    failed: List[str] = []
    if not (metric_pass or resolved_check):
        failed.append(f"required_check:{required_check_id}")
    if not (matching_tables or declared_path_exists):
        failed.append(f"required_table_artifact:{artifact_pattern}")

    return {
        "required": True,
        "satisfied": satisfied,
        "failed_requirements": failed,
        "required_check_id": required_check_id,
        "artifact_name_pattern": artifact_pattern,
        "matching_tables": matching_tables,
        "declared_path": declared_path or None,
        "declared_path_exists": declared_path_exists,
        "contract": master_table_contract,
        "notes": "Hypothesis validation requires an explicit analysis master table before gate review.",
    }


def _validation_summary(
    executions: List[BlueprintExecution],
    handoff: Dict[str, Any],
    role_plan: Dict[str, Any] | None = None,
    external_agent_executions: Optional[List[ExternalAgentExecution]] = None,
) -> Dict[str, Any]:
    total = len(executions)
    # ``e.status == "completed"`` only means the blueprint PROCESS exited; it says
    # nothing about whether the science ran. v63 had 22 executions that exited 0
    # while reporting pass_fail="fail" because the proposed Mitsuba integrator did
    # not exist (``Plugin "h_rps" not found``) — they were counted as passed, so
    # overall_status came out "passed" on 36 lanes that produced no evidence at
    # all, and the gate never saw a negative validation. Count by what the
    # execution actually produced instead.
    passed = sum(
        1 for e in executions if e.status == "completed" and not _execution_hard_failed(e)
    )
    failed = sum(
        1
        for e in executions
        if e.status in ("failed", "timeout") or _execution_hard_failed(e)
    )
    skipped = sum(1 for e in executions if e.status == "skipped")
    def mean_metric(key: str) -> Optional[float]:
        values: List[float] = []
        for execution in executions:
            metrics = execution.metrics or {}
            try:
                value = float(metrics.get(key))
            except (TypeError, ValueError):
                continue
            values.append(value)
        if not values:
            return None
        return sum(values) / len(values)

    method_score = mean_metric("method_appropriateness_score")
    accuracy_score = mean_metric("analysis_accuracy_score")
    preserve_method_scores_on_failed_checks = any(
        bool((execution.metrics or {}).get("method_score_independent_of_pass_fail"))
        or bool((execution.metrics or {}).get("valid_falsification_result"))
        for execution in executions
    )
    checks: Dict[str, bool] = {}
    handoff_check_resolutions = [_execution_resolution(execution) for execution in executions]
    for execution, resolution in zip(executions, handoff_check_resolutions):
        metrics = execution.metrics or {}
        if execution.check_id:
            checks[execution.check_id] = bool(resolution.get("resolved"))
        metric_checks = metrics.get("checks")
        if isinstance(metric_checks, dict):
            for key, value in metric_checks.items():
                if isinstance(key, str):
                    checks[key] = bool(value)
    open_source_requirements = _repository_agent_requirement_summary(
        handoff,
        role_plan,
        external_agent_executions or [],
    )
    if open_source_requirements.get("repository_agent_required"):
        checks["open_source_repository_agent_applied"] = bool(
            open_source_requirements.get("repository_agent_applied")
        )
        checks["open_source_repository_workflow_applied"] = bool(
            open_source_requirements.get("substantive_repository_workflow_applied")
        )
    master_table_gate = _master_table_gate_result(
        executions,
        handoff,
        role_plan=role_plan,
    )
    if master_table_gate.get("required"):
        checks["analysis_master_table_gate_satisfied"] = bool(master_table_gate.get("satisfied"))
    # A method the blueprint could not even instantiate is an implementation gap,
    # not a scientific finding. Record it as an explicit failing check (and as a
    # machine-readable list below) so the planner can route the hypothesis to
    # "implementation required" instead of re-dispatching the same impossible
    # validation — v63 paid for the identical unimplementable check 22 times.
    unrunnable_methods = _aggregate_unrunnable_methods(executions)
    if unrunnable_methods:
        checks["proposed_method_implementation_available"] = False
    failed_checks = sorted(key for key, passed_check in checks.items() if not passed_check)
    checks_total = len(checks)
    checks_passed = checks_total - len(failed_checks)

    if total == 0:
        overall_status = "no-blueprints"
    elif passed == 0:
        overall_status = "degraded"
    elif failed > 0:
        overall_status = "degraded"
    elif failed_checks:
        overall_status = "inconclusive"
    else:
        overall_status = "passed"

    if failed_checks and not preserve_method_scores_on_failed_checks:
        if method_score is not None:
            method_score = min(method_score, 75.0)
        if accuracy_score is not None:
            accuracy_score = min(accuracy_score, 75.0)
    if (
        open_source_requirements.get("repository_agent_required")
        and not open_source_requirements.get("repository_agent_applied")
    ):
        overall_status = "degraded"

    summary = {
        "driver": DRIVER_NAME,
        "mode": "blueprint-execution",
        "blueprints_total": total,
        "blueprints_passed": passed,
        "blueprints_failed": failed,
        "blueprints_skipped": skipped,
        "primary_hypothesis_id": _reported_hypothesis_id(executions, handoff),
        # The id the lane was HANDED, kept beside the one it may claim, so a
        # relabelled run is auditable rather than quietly renamed.
        "handed_hypothesis_id": handoff.get("primary_hypothesis_id"),
        "hypothesis_alignment": _hypothesis_alignment(executions, handoff),
        "handoff_generation_mode": handoff.get("handoff_generation_mode"),
        "handoff_check_resolutions": handoff_check_resolutions,
        "overall_status": overall_status,
        # Empty for every normal run; non-empty means the lane tried to validate a
        # method that does not exist as executable code yet.
        "unrunnable_methods": unrunnable_methods,
        # Blueprints whose design did not fit the per-blueprint wall-clock
        # budget. Distinct from a crash: the science is sound, the sweep is too
        # big. Empty on every run that fits.
        "blueprint_design_overruns": [
            dict(e.metrics or {}) for e in executions
            if (e.metrics or {}).get("design_overrun")
        ],
        "method_appropriateness_score": round(method_score, 3) if method_score is not None else None,
        "analysis_accuracy_score": round(accuracy_score, 3) if accuracy_score is not None else None,
        # The numbers the blueprints actually measured. Without this the summary
        # that reaches the LabDirector and the gate is workflow bookkeeping only
        # ("checks 13/13"), so neither can compare a claim against its evidence —
        # see _measured_quantities.
        "measured_quantities": _measured_quantities(executions),
        # What this run actually established, as a fact rather than an inference.
        "rigor_profile": _rigor_profile(executions),
        "checks": checks,
        "checks_total": checks_total,
        "checks_passed": checks_passed,
        "checks_failed": len(failed_checks),
        "failed_checks": failed_checks,
        "open_source_agent_requirements": open_source_requirements,
        "analysis_master_table_gate": master_table_gate,
    }
    analyst_quality = _analyst_quality_standard_result(
        handoff,
        validation_summary=summary,
        checks=checks,
        external_agent_executions=external_agent_executions or [],
        executions=executions,
    )
    summary["analyst_quality_standard"] = analyst_quality
    checks["analyst_quality_standard_satisfied"] = bool(analyst_quality.get("satisfied"))
    if not analyst_quality.get("satisfied"):
        if "analyst_quality_standard_satisfied" not in failed_checks:
            failed_checks.append("analyst_quality_standard_satisfied")
        summary["overall_status"] = "degraded"
        summary["checks_failed"] = len(failed_checks)
        summary["failed_checks"] = sorted(failed_checks)
    summary["checks_total"] = len(checks)
    summary["checks_passed"] = sum(1 for passed_check in checks.values() if passed_check)
    return summary


def _quality_gates(validation_summary: Dict[str, Any]) -> Dict[str, Any]:
    # Generic gates that do not encode any domain. The labdirector uses these
    # to decide whether to promote results; previously they were hard-wired
    # to WHO-specific thresholds.
    status = validation_summary.get("overall_status")
    passed = validation_summary.get("blueprints_passed", 0) or 0
    master_table_gate = validation_summary.get("analysis_master_table_gate") or {}
    master_table_required = bool(master_table_gate.get("required"))
    master_table_satisfied = bool(master_table_gate.get("satisfied"))
    return {
        "scope_gate": {"status": "passed"},
        "analysis_master_table_gate": {
            "status": "passed" if (not master_table_required or master_table_satisfied) else "blocked",
            "required": master_table_required,
            "notes": (
                "requires an explicit pre-validation analysis master table artifact"
                if master_table_required
                else "not required by this handoff"
            ),
            "failed_requirements": master_table_gate.get("failed_requirements") or [],
        },
        "data_quality_gate": {
            "status": "passed" if passed > 0 else "pending",
            "notes": "requires at least one blueprint to execute successfully",
        },
        "family_competition_gate": {
            "status": "pending",
            "notes": "rival families compared by the planner, not the driver",
        },
        "reproducibility_gate": {
            "status": "passed" if passed > 0 else "pending",
        },
        "validation_gate": {
            "status": status,
            "notes": "aggregated from blueprint executions",
        },
    }


# ---------------------------------------------------------------------------
# Driver top-level


def _write_summary_md(
    *,
    summary_path: Path,
    dataset_root: Path,
    handoff: Dict[str, Any],
    executions: List[BlueprintExecution],
    external_agent_executions: List[ExternalAgentExecution],
    validation_summary: Dict[str, Any],
) -> None:
    lines: List[str] = []
    lines.append("# Blueprint Executor Summary")
    lines.append("")
    lines.append(f"- Dataset root: `{dataset_root}`")
    lines.append(f"- Driver: {DRIVER_NAME}")
    lines.append(f"- Blueprints total: {validation_summary['blueprints_total']}")
    lines.append(f"- Blueprints passed: {validation_summary['blueprints_passed']}")
    lines.append(f"- Blueprints failed: {validation_summary['blueprints_failed']}")
    lines.append(f"- Blueprints skipped: {validation_summary['blueprints_skipped']}")
    if external_agent_executions:
        lines.append(
            "- External analysis agent runs: {total} ({completed} completed, {failed} failed, {skipped} skipped)".format(
                total=len(external_agent_executions),
                completed=sum(1 for e in external_agent_executions if e.status == "completed"),
                failed=sum(
                    1 for e in external_agent_executions if e.status in {"failed", "timeout"}
                ),
                skipped=sum(1 for e in external_agent_executions if e.status == "skipped"),
            )
        )
    primary_id = _coerce_str(handoff.get("primary_hypothesis_id"))
    if primary_id:
        lines.append(f"- Primary hypothesis: `{primary_id}`")
    summary_text = _coerce_str(handoff.get("summary"))
    if summary_text:
        lines.append(f"- Analyst summary: {summary_text}")
    lines.append("")
    lines.append("## Blueprint executions")
    if not executions:
        lines.append("_No blueprints were present in the analyst handoff._")
    else:
        lines.append("")
        lines.append("| check_id | status | duration (s) | figures | tables | error |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for execution in executions:
            error_cell = (execution.error or "").replace("|", "/").strip()[:120] or ""
            lines.append(
                "| `{check}` | {status} | {duration:.2f} | {fig} | {tab} | {err} |".format(
                    check=execution.check_id,
                    status=execution.status,
                    duration=execution.duration_seconds,
                    fig=len(execution.figures),
                    tab=len(execution.tables),
                    err=error_cell,
                )
            )
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# Regexes over the measured quantities, not over the analyst's prose. A design
# that DECLARES five seeds and reports one number has one seed.
_RIGOR_SIGNALS = {
    # >= 2 distinct seed values actually present in the output
    "multi_seed": re.compile(r'"seeds?"\s*:|per_seed|seed_\d', re.IGNORECASE),
    "dispersion": re.compile(r"\bstd\b|stdev|std_dev|variance|\bsd\b|iqr|spread|dispersion", re.IGNORECASE),
    "comparator": re.compile(r"baseline|uniform_|comparator|\bcontrol\b|rival|reference_method", re.IGNORECASE),
    "interval": re.compile(r"\bci\b|ci_low|ci_high|confidence[_ ]interval|credible", re.IGNORECASE),
    "significance": re.compile(r"p_value|pvalue|p_val|permutation|bootstrap", re.IGNORECASE),
    "effect_size": re.compile(r"effect_size|\bdelta\b|_gain\b|improvement|difference", re.IGNORECASE),
}


# Column names are tokens, not prose. `_RIGOR_SIGNALS["dispersion"]` is
# `\bstd\b`, which correctly refuses to fire on the word "std" inside
# "std_rmse_gain" when reading a sentence -- and just as incorrectly refuses when
# reading a CSV header, where that column IS the dispersion statistic. These
# patterns treat `_` as a token boundary so an emitted column is read as what it
# is. Applied only to header names, never to the prose blob.
_COLUMN_SIGNALS = {
    "dispersion": re.compile(
        r"(?:^|_)(std|stdev|stddev|sd|var|variance|iqr|mad|sem|se|stderr|spread|dispersion)(?:_|$)",
        re.IGNORECASE,
    ),
    "interval": re.compile(
        r"(?:^|_)(\d*ci|ci|cilow|cihigh|ci_?low|ci_?high|lower|upper|credible|hdi)(?:_|$)",
        re.IGNORECASE,
    ),
    "significance": re.compile(
        r"(?:^|_)(p|pval|pvalue|wilcoxon|ttest|mannwhitney|permutation|bootstrap|significance)(?:_|$)",
        re.IGNORECASE,
    ),
    "effect_size": re.compile(
        r"(?:^|_)(gain|delta|diff|difference|effect|effectsize|improvement|cohend)(?:_|$)",
        re.IGNORECASE,
    ),
}


def _rigor_profile(executions) -> Dict[str, Any]:
    """Which reproducibility signals this run actually produced.

    WHY THIS IS MEASURED AND NOT ASSUMED. On cycle-g-v84, of the 17 runner lanes
    whose check was bound to the director's hypothesis, 24% reported more than one
    seed, 18% named a comparator, and 12% reported any dispersion at all. The gate
    scored technical_quality 35 and reproducibility 76 and would not move -- which
    was an HONEST reading, because the evidence for those axes was not there.
    Nothing in the summary said so, so every layer above had to infer it from raw
    numbers, and the analyst's declared standard ("bootstrap x300, held-out scene
    folds") was prose that no run had to honour.
    Signals are read out of the measured quantities, never out of the analyst's
    intent: a design that declares five seeds and reports one number has one seed.
    """
    blob = json.dumps(_measured_quantities(executions), ensure_ascii=False)
    present = {name: bool(rx.search(blob)) for name, rx in _RIGOR_SIGNALS.items()}
    # ...and out of the tables the run actually wrote. The blob truncates
    # metrics.notes, so a five-seed three-arm sweep could report multi_seed=false
    # purely because its seed list sat past the cut (v85 followup-runner-08). An
    # emitted column with two or more distinct values is direct evidence, so it
    # may only ADD a signal here, never clear one.
    table_evidence = _table_rigor_evidence(executions)
    for axis in ("multi_seed", "comparator"):
        if table_evidence.get(axis):
            present[axis] = True
    columns = table_evidence.get("header_columns") or []
    for axis, rx in _COLUMN_SIGNALS.items():
        if not present[axis] and any(rx.search(column) for column in columns):
            present[axis] = True
    # The three that reproducibility actually rests on.
    core = ("multi_seed", "dispersion", "comparator")
    have = [k for k in core if present[k]]
    return {
        "signals": present,
        "core_present": have,
        "core_missing": [k for k in core if not present[k]],
        "reproducibility_grade": (
            "supported" if len(have) == 3
            else "partial" if len(have) >= 1
            else "unsupported"
        ),
        # Named columns and distinct counts, so a reviewer can check the claim
        # against the file instead of taking the boolean on trust.
        "table_evidence": {k: v for k, v in table_evidence.items() if k != "header_columns"},
        "basis": "measured quantities plus the per-row tables emitted by the executed blueprints",
    }


# A run only gets to wear the lead's name if it tested the lead.
_GENERIC_TEMPLATE_CHECK = re.compile(r"render_quality_convergence", re.IGNORECASE)
GENERIC_BASELINE_ID = "generic_capability_baseline"


def _reported_hypothesis_id(executions, handoff: Dict[str, Any]):
    """The hypothesis id this run may claim, which is not always the one it was handed.

    `_render_quality_checks_and_blueprints` emits a FIXED adaptive-vs-uniform
    render comparison. It is a useful capability baseline -- it proves the renderer
    and the measurement pipeline work -- and it is not a test of anything the
    director proposed. The template already says so: hypothesis_bound is False and
    an alignment_notice spells it out.

    The validation summary said otherwise. It stamped the director's
    primary_hypothesis_id on the run regardless, so cycle-g-v84's followup-runner-65
    and -67 reached the gate as
    "hyp-director-across-frozen-procedural-mitsuba-..." over an experiment that
    measured adaptive versus uniform sampling. 14 of 31 runner lanes on that cycle
    were this template. v81 bound technical_quality at 12 after its gatekeeper
    noticed - "the hypothesis-misaligned adaptive-allocation run risk being
    conflated with candidate validation" - which is the gate doing the harness's
    job by hand, and only when a reviewer happened to catch it.

    A generic run now reports GENERIC_BASELINE_ID and keeps the intended id under
    `handed_hypothesis_id`, so nothing is hidden and nothing is misattributed.
    Fixing the label, not the experiment: the baseline is still worth running, it
    just may not be counted as evidence for a lead it never touched.
    """
    handed = handoff.get("primary_hypothesis_id")
    check_ids = []
    for e in executions or []:
        for attr in ("check_id", "blueprint_id"):
            value = getattr(e, attr, None)
            if value:
                check_ids.append(str(value))
    if not check_ids:
        return handed
    # Only when EVERY executed check is the template. A lane that ran the baseline
    # alongside a real hypothesis check has still tested the hypothesis.
    if all(_GENERIC_TEMPLATE_CHECK.search(c) for c in check_ids):
        return GENERIC_BASELINE_ID
    return handed


def _hypothesis_alignment(executions, handoff: Dict[str, Any]) -> Dict[str, Any]:
    """Whether this run tested the lead it was handed, stated rather than implied."""
    reported = _reported_hypothesis_id(executions, handoff)
    handed = handoff.get("primary_hypothesis_id")
    generic = reported == GENERIC_BASELINE_ID
    return {
        "bound_to_handed_hypothesis": not generic,
        "handed_hypothesis_id": handed,
        "reported_as": reported,
        "notice": (
            "GENERIC CAPABILITY BASELINE. Every executed check in this lane was the fixed "
            "adaptive-vs-uniform render template, which does not test the handed hypothesis. "
            "It is evidence that the renderer and the measurement pipeline work. Do NOT score "
            "this lead's technical_quality or reproducibility from it - a hypothesis-specific "
            "design has to come from the analyst."
            if generic
            else "This lane executed at least one check bound to the handed hypothesis."
        ),
    }
