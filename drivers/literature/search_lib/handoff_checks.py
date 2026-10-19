from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from .templates.reference_baseline import _reference_baseline_audit_blueprint_code
from .templates.same_dataset_baseline import _same_dataset_baseline_reproduction_blueprint_code
from .templates.confounder_sensitivity import _confounder_sensitivity_blueprint_code
from .templates.term_table_topic import _term_table_topic_blueprint_code
from .templates.wide_table_stability import _wide_table_stability_blueprint_code
from .templates.signature_score_contest import _signature_score_contest_blueprint_code
from .templates.render_quality import _render_quality_blueprint_code
from .templates.open_source_adapter import _open_source_workflow_adapter_code
from .http_client import clean_text
from .providers import cycle_id_from_output_dir
from .dataset_inspect import _infer_comparison_groups, _looks_like_effect_table, _looks_like_term_table, _looks_like_wide_measurement_csv, _signature_score_groups, _topic_groups_from_text
from .data_graph import _validation_context_text


def _append_reference_baseline_audit(
    *,
    checks: list[dict],
    blueprints: list[dict],
    primary_hypothesis_id: str,
    reference_context: dict,
) -> None:
    if not reference_context:
        return
    check_id = f"{re.sub(r'[^a-z0-9_]+', '_', primary_hypothesis_id.lower()).strip('_') or 'hypothesis'}_reference_baseline_audit_01"
    check = {
        "check_id": check_id,
        "goal": "Audit the reference paper data/code availability and materialize a baseline reproduction plan before treating the new hypothesis as stronger than the cited baseline.",
        "dataset": "selected_cycle_scoped_bundle",
        "outcome": "reference_baseline_reproducibility_readiness",
        "exposures": ["reference_methods_baseline", "available_data_resources", "available_code_resources"],
        "reference_context": reference_context,
        "model_family": "reference-baseline-resource-audit",
        "success_criteria": {
            "minimum_effect_description": "Reference papers, baseline methods, data resources, code-like resources, and explicit reproduction steps are all visible to the runner.",
        },
        "failure_criteria": [
            "No reference papers or baseline methods are supplied in the handoff.",
            "The selected bundle lacks tabular data resources needed for reproduction.",
            "No code-like resources, notebook, script, README, or manifest is available for auditing the cited baseline.",
        ],
    }
    checks.append(check)
    blueprints.append({
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "code": _reference_baseline_audit_blueprint_code(),
        "dependencies": ["pandas"],
        "execution_notes": [
            "Uses reference_context supplied by LabDirector/Analyst; no dataset-specific accession, gene set, or paper title is hardcoded in the script.",
            "Writes reference-resource-audit.csv and baseline-reproduction-plan.csv for downstream analyst/gatekeeper review.",
            "Does not claim reproduction success unless data and code-like resources are actually visible in the selected bundle.",
        ],
        "review_focus": ["reference code availability", "baseline method reproducibility", "supplementary data coverage"],
        "review_status": "ready_for_runner",
    })



def _append_same_dataset_baseline_reproduction(
    *,
    checks: list[dict],
    blueprints: list[dict],
    primary_hypothesis_id: str,
    reference_context: dict,
    dataset_path: str | None,
) -> None:
    check_id = f"{re.sub(r'[^a-z0-9_]+', '_', primary_hypothesis_id.lower()).strip('_') or 'hypothesis'}_same_dataset_baseline_reproduction_01"
    check = {
        "check_id": check_id,
        "goal": "Quantify an executable same-dataset baseline delta proxy against the cited reference baseline and flag missing reference code as a reproducibility blocker.",
        "dataset": "selected_cycle_scoped_bundle",
        "dataset_path": dataset_path,
        "outcome": "same_dataset_baseline_delta",
        "exposures": ["reference_methods_baseline", "current_hypothesis_signal"],
        "reference_context": reference_context,
        "reference_code_resource_count": 0,
        "model_family": "same-dataset-baseline-reproduction-audit",
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": "A numeric delta proxy is reported, baseline methods map to available columns, and reference code/resources are available or explicitly marked absent.",
        },
        "failure_criteria": [
            "Reference papers or baseline steps are missing.",
            "Baseline methods cannot be mapped to available data columns.",
            "Reference code or supplementary execution resources are unavailable.",
            "No numeric delta proxy can be quantified.",
        ],
    }
    checks.append(check)
    blueprints.append({
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": dataset_path,
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "code": _same_dataset_baseline_reproduction_blueprint_code(),
        "dependencies": ["pandas", "numpy", "matplotlib"],
        "execution_notes": [
            "Uses only the supplied reference_context and cycle-scoped bundle; no reference paper or accession is hardcoded.",
            "Produces baseline-reproduction-summary.csv and a baseline delta proxy figure.",
            "If reference code is absent, reports reproducibility_blocker=reference_code_unavailable instead of inflating the claim.",
        ],
        "review_focus": ["same-dataset baseline", "delta quantification", "reference code availability"],
        "review_status": "ready_for_runner",
    })


def _append_confounder_sensitivity(
    *,
    checks: list[dict],
    blueprints: list[dict],
    primary_hypothesis_id: str,
    dataset_path: str | None,
    sample_metadata_path: str | None = None,
) -> None:
    check_id = f"{re.sub(r'[^a-z0-9_]+', '_', primary_hypothesis_id.lower()).strip('_') or 'hypothesis'}_confounder_sensitivity_01"
    check = {
        "check_id": check_id,
        "goal": "Audit which of the covariates the sample metadata actually carries could explain the claim instead of the mechanism, and whether the claim survives adjusting for each one that is observable",
        "dataset": "selected_cycle_scoped_bundle",
        "dataset_path": dataset_path,
        "sample_metadata_path": sample_metadata_path,
        "outcome": "confounder_adjusted_claim",
        "exposures": ["current_hypothesis_signal"],
        # Read from the sample metadata rather than listed here: a fixed list is one
        # field's covariates, and a column it does not name is a confounder this
        # check would silently skip.
        "adjustment_set": "every covariate column the sample metadata carries, named in the result",
        "fixed_effects": ["the grouping the metadata records, when one is observable"],
        "sample_filters": [],
        "model_family": "generic-adjusted-partial-correlation-sensitivity",
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": "Adjusted effect is estimable, bootstrap sign stability >= 0.8, permutation p <= 0.05, held-out sign agrees, and missing critical confounder fields are explicitly reported.",
        },
        "failure_criteria": [
            "Age/sex/repeated-subject/leukocyte-composition fields are absent from the selected bundle.",
            "No numeric confounder columns can be used for adjustment.",
            "Adjusted effect is not estimable or bootstrap stability is weak.",
        ],
    }
    checks.append(check)
    blueprints.append({
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": dataset_path,
        "sample_metadata_path": sample_metadata_path,
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "code": _confounder_sensitivity_blueprint_code(),
        "dependencies": ["pandas", "numpy", "matplotlib"],
        "execution_notes": [
            "Detects confounder fields structurally from column names; does not hardcode dataset-specific fields.",
            "Reports missing age/sex/repeated-subject/leukocyte-composition fields as blockers.",
            "Uses partial-correlation residualization and bootstrap sign stability when enough numeric controls are present.",
        ],
        "review_focus": ["confounder observability", "adjusted effect", "bootstrap sensitivity", "claim downgrade triggers"],
        "review_status": "ready_for_runner",
    })



def _render_quality_checks_and_blueprints(check_prefix, director_hypothesis, mapping):
    """CS/rendering validation: a concrete Mitsuba render-and-measure check (spp
    convergence vs a converged reference, PSNR/SSIM/MSE + render time). Replaces
    the omics-shaped term/measurement checks so a rendering cycle produces a real
    render the lab-runner can execute and the gate can score."""
    check_id = f"{check_prefix}_render_quality_convergence_01"
    # THE HYPOTHESIS THIS CLAIMS TO TEST, ACTUALLY WRITTEN DOWN.
    #
    # `director_hypothesis` was accepted as a parameter and then never read: this
    # template emits ONE fixed experiment - variance-guided adaptive tile
    # allocation versus uniform sampling - no matter what the director proposed,
    # and stamps the lead's id onto it via `check_prefix`. So a lead reaches the
    # gate wearing a check_id that names it, over a run that tested something
    # else entirely.
    #
    # MEASURED ON cycle-g-v81. The director's lead was an INVERSION candidate -
    # use the unclamped high-contribution path tail renderers normally suppress
    # to predict stale-reuse failure. The handoff carried
    # primary_hypothesis_id=hyp-director-provisional-inversion-candidate-... and
    # a check whose success criterion was "adaptive PSNR > uniform PSNR at
    # matched budget". The gatekeeper caught it and said so - "the
    # hypothesis-misaligned adaptive-allocation run risk being conflated with
    # candidate validation" - and bound the gate at technical_quality=12 with
    # "Zero aligned validation results are available".
    #
    # `hypothesis_text` was empty on 82 of 82 handoff checks across v79 and v81,
    # so nothing downstream could tell an aligned run from a generic one. It is
    # populated here, and the check declares plainly whether it is bound to the
    # lead, so a generic capability baseline can no longer pass itself off as
    # validation of the hypothesis.
    hypothesis_statement = str((director_hypothesis or {}).get("statement") or "").strip()
    hypothesis_id = str((director_hypothesis or {}).get("hypothesis_id") or "").strip()
    generic_baseline_notice = (
        "GENERIC CAPABILITY BASELINE, NOT A TEST OF THE CURRENT LEAD. This check is the "
        "fixed adaptive-vs-uniform render template; it does not test the hypothesis named in "
        "check_id. Treat it as evidence that the renderer and measurement pipeline work, and "
        "do NOT score the lead's technical_quality or reproducibility from it. A hypothesis-"
        "specific design must come from the analyst."
    )
    check = {
        "check_id": check_id,
        "hypothesis_text": hypothesis_statement,
        "hypothesis_id": hypothesis_id,
        "hypothesis_bound": False,
        "alignment_notice": generic_baseline_notice,
        "goal": "Validate the core hypothesis directly: does a VARIANCE-GUIDED ADAPTIVE tile sample allocation beat UNIFORM per-pixel sampling at a MATCHED sample budget? Implement both samplers in Mitsuba, compare PSNR/SSIM/MSE vs a converged reference on two scenes across 5 independent seeds, and report the adaptive-minus-uniform PSNR gain (mean +/- std). Close the rival-explanation gap (uniform baseline) and the falsification gap (a low-variance scene where adaptive should NOT win).",
        "dataset": "procedural_mitsuba_scenes",
        "outcome": "adaptive_vs_uniform_psnr_gain_at_matched_budget",
        "exposures": ["sampling_strategy", "random_seed", "scene"],
        "adjustment_set": ["matched_sample_budget"],
        "fixed_effects": [],
        "sample_filters": [],
        "model_family": "render-and-measure-convergence",
        "success_criteria": {
            "expected_sign": "adaptive PSNR > uniform PSNR at matched budget on the high-variance scene",
            "minimum_effect_description": "Both samplers run at a matched average spp; on the high-variance (glossy) scene the mean adaptive-minus-uniform PSNR gain across 5 seeds is positive with a reported standard deviation (reproducible), the uniform rival baseline is measured, and on the low-variance (diffuse) scene the gain is not larger than on the high-variance scene (falsification boundary holds).",
            "required_checks": "adaptive_beats_uniform=true, rival_uniform_baseline_compared=true, adaptive_gain_reproducible=true, falsification_boundary_holds=true, multi_scene_generalization=true",
        },
        "failure_criteria": [
            "Mitsuba is unavailable or a scene fails to render.",
            "Adaptive and uniform PSNR vs the converged reference cannot be computed at a matched budget.",
            "Adaptive does not beat uniform on the high-variance scene (hypothesis not supported).",
            "Adaptive 'wins' equally on the low-variance scene (falsification boundary violated -> the variance estimator is not actually driving the gain).",
            "No across-seed variance is reported for the gain (a single deterministic run is not reproducibility evidence).",
        ],
    }
    blueprint = {
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "code": _render_quality_blueprint_code(),
        "dependencies": ["mitsuba", "numpy"],
        "pip_install_packages": ["mitsuba", "numpy"],
        "execution_notes": [
            "Self-contained: builds two distinct Mitsuba scenes in-code with mi.load_dict (a high-variance glossy roughconductor sphere and a low-variance diffuse sphere) and renders with mi.render (scalar_rgb variant); no external scene download needed.",
            "Implements the ADAPTIVE method: a two-render pilot estimates per-tile Monte-Carlo noise, then a greedy allocator raises high-noise tiles to higher per-tile spp while holding the AVERAGE spp equal to the uniform budget; the adaptive image is composited from the per-level renders.",
            "Implements the UNIFORM rival baseline at the same matched budget, and compares both to a converged reference (spp=256) via PSNR/SSIM/MSE.",
            "Repeats across 5 independent seeds and reports the adaptive-minus-uniform PSNR gain (mean +/- std); runs both scenes so the high-variance scene shows the gain and the low-variance scene tests the falsification boundary.",
            "Emits result.json, render.png (adaptive composite), render_metrics.csv (per-seed uniform vs adaptive), and render_reproducibility_summary.csv (per-scene gain mean/std + adaptive_wins).",
        ],
        "review_focus": ["adaptive-vs-uniform PSNR gain at matched budget", "rival uniform baseline", "across-seed reproducibility of the gain", "falsification boundary on the low-variance scene", "cross-scene generalization"],
        "review_status": "ready_for_runner",
    }
    mapping["render_scene_mode"] = "procedural_in_code_mitsuba"
    mapping["render_metric_targets"] = ["psnr", "ssim", "mse", "render_time_s"]
    return [check], [blueprint], mapping


# The reproducibility design, STAMPED onto every handoff check this module emits.
#
# WHY HERE AND NOT IN THE OUTPUT CONTRACT. The analyst output contract in
# codex_prompt.rs asks for a reproducibility_design, and it cannot reach these
# checks at all: 48 of cycle-g-v84's 68 analyst handoffs come from the
# literature-search-driver, which builds them in Python and never sees a codex
# prompt. The 20 that do see the contract ignored it -- followup-analyst-70's
# prompt carried the field, verified in its prompt.txt, and its result omitted it.
# So the requirement has to be GENERATED, not requested.
#
# WHAT IT COSTS, MEASURED. The instrument probe ran in this container: seeds are
# bitwise reproducible, a 2-arm x 5-seed x 3-scene sweep is ~36s of render, and
# three converged references ~49s. Five seeds is seconds, not a trade-off.
#
# WHAT ITS ABSENCE COST. Of v84's 17 hypothesis-bound runner lanes, 17 emitted no
# seed field, 16 named no comparator, 15 reported no dispersion. The gate scored
# technical_quality 35 and reproducibility 76 on that evidence and would not move
# -- an honest reading of runs that could not support either axis.
REPRODUCIBILITY_SEEDS = [0, 1, 2, 3, 4]


def _reproducibility_design(check: dict) -> dict:
    """The seeds, comparator and dispersion this check must report."""
    exposures = [str(x) for x in (check.get("exposures") or [])]
    # Prefer an exposure that already names the contrast; fall back to saying
    # plainly that the analyst must name one rather than inventing a comparator.
    comparator = next(
        (x for x in exposures if any(t in x.lower() for t in ("strategy", "method", "arm", "variant", "condition"))),
        None,
    )
    return {
        "seeds": REPRODUCIBILITY_SEEDS,
        "seed_count": len(REPRODUCIBILITY_SEEDS),
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
            "measured in this container by the instrument probe: bitwise-reproducible seeds, "
            "a 2-arm x 5-seed x 3-scene sweep at about 36s of render, three converged "
            "references at about 49s - a single-seed, comparator-free run here is a design "
            "choice, not a budget limit"
        ),
    }


def _stamp_reproducibility_design(checks: list[dict]) -> list[dict]:
    """Attach the design to every check that does not already carry one."""
    for check in checks or []:
        if isinstance(check, dict) and not check.get("reproducibility_design"):
            check["reproducibility_design"] = _reproducibility_design(check)
    return checks


_CS_BASELINE_CHECK_TOKEN = "render_quality_convergence"


def _cs_cycle_stats_root(role_plan) -> tuple:
    """(stats_root, cycle_id) for this cycle, or (None, None).

    The requirement-driven builder is not handed an output_dir, but the role plan
    carries absolute state paths (``<runtime>/state/<cycle>-instrument-inventory.json``
    and friends), which pin both the runtime root and the cycle id without adding
    a parameter to five call sites.

    Walks the plan's string values rather than matching a regex against
    ``json.dumps(role_plan)``: dumps doubles backslashes, so the blob form worked
    on POSIX and silently resolved nothing on Windows -- and a resolution that
    silently fails here reads as "no baseline has run yet", which is the exact
    wrong default.
    """
    import re as _re
    from pathlib import Path as _Path

    marker = _re.compile(
        r"^(.*[/\\]\.research-lab)[/\\]state[/\\]([A-Za-z0-9_.-]+?)-"
        r"(?:instrument-inventory|analyst-research-notes|hypothesis-progress|cycle-run-state)"
    )

    def walk(value, depth=0):
        if depth > 8:
            return None
        if isinstance(value, str):
            hit = marker.match(value)
            return (hit.group(1), hit.group(2)) if hit else None
        if isinstance(value, dict):
            for item in value.values():
                found = walk(item, depth + 1)
                if found:
                    return found
        elif isinstance(value, (list, tuple)):
            for item in value:
                found = walk(item, depth + 1)
                if found:
                    return found
        return None

    found = walk(role_plan or {})
    if not found:
        return (None, None)
    runtime_root, cycle_id = found
    return (_Path(runtime_root) / "artifacts" / "stats" / cycle_id, cycle_id)


def _cs_lane_summaries(stats_root):
    """Every executed lane's (check_ids, validation_summary) for this cycle."""
    import json as _json

    out = []
    if stats_root is None:
        return out
    try:
        lane_dirs = sorted(p for p in stats_root.iterdir() if p.is_dir())
    except Exception:
        return out
    for lane_dir in lane_dirs:
        result_path = lane_dir / "result.json"
        if not result_path.is_file():
            continue
        try:
            data = _json.loads(result_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            continue
        checks = [
            str((execution or {}).get("check_id") or "")
            for execution in (data.get("blueprint_executions") or [])
        ]
        out.append((lane_dir.name, checks, data.get("validation_summary") or {}))
    return out


def _cs_baseline_decision(role_plan, primary_hypothesis_id: str) -> dict:
    """Whether this CG handoff should emit the generic baseline, and why not.

    Three reasons to withhold it, in the order they are checked:
      1. a capability baseline already PASSED this cycle -- the renderer and the
         measurement pipeline are proven, and proving them a twelfth time costs a
         runner dispatch and a gate round while producing no evidence for any lead;
      2. an analyst-designed check is already bound to this lead -- the lead has
         its experiment, and a baseline wearing its name only dilutes the record;
      3. neither, but the lead still needs a design -- emitting the baseline here
         is what let six lanes report "completed" while the lead had nothing.
    """
    stats_root, cycle_id = _cs_cycle_stats_root(role_plan)
    lanes = _cs_lane_summaries(stats_root)
    lead = str(primary_hypothesis_id or "").strip()

    baseline_passed = []
    bound_designs = []
    for lane_id, check_ids, summary in lanes:
        is_baseline = any(_CS_BASELINE_CHECK_TOKEN in check_id for check_id in check_ids)
        overall = str(summary.get("overall_status") or "")
        if is_baseline and overall == "passed":
            baseline_passed.append(lane_id)
            continue
        alignment = summary.get("hypothesis_alignment") or {}
        if not alignment.get("bound_to_handed_hypothesis"):
            continue
        handed = str(alignment.get("handed_hypothesis_id") or "").strip()
        if lead and handed and handed == lead:
            bound_designs.append(lane_id)

    decision = {
        "cycle_id": cycle_id,
        "lead": lead or None,
        "baseline_passed_lanes": baseline_passed[:6],
        "baseline_passed_count": len(baseline_passed),
        "lead_bound_design_lanes": bound_designs[:6],
        "scanned_lanes": len(lanes),
    }
    if stats_root is None:
        # No cycle context to reason from. Emit, exactly as before: a missing
        # measurement must not silently become a new policy.
        decision["emit_baseline"] = True
        decision["reason"] = "no_cycle_context_available"
        return decision
    if bound_designs:
        decision["emit_baseline"] = False
        decision["reason"] = "lead_already_has_an_analyst_designed_check"
        return decision
    if baseline_passed:
        decision["emit_baseline"] = False
        decision["reason"] = "capability_baseline_already_passed_this_cycle"
        return decision
    decision["emit_baseline"] = True
    decision["reason"] = "first_capability_baseline_of_the_cycle"
    return decision


def _cs_analyst_design_request(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    role_plan: dict | None,
    decision: dict,
):
    """What to hand back instead of a twelfth copy of the baseline.

    Deliberately NOT executable: no blueprint, so
    ``_handoff_is_scientifically_executable`` is False and the reason travels to
    the LabDirector as a blocker. That is the point -- the old behaviour returned
    something that ran, passed, and told nobody the lead was still untested. The
    deadlock this template was written to prevent stays prevented because rule 1
    still lets the baseline run once, so the cycle always has a completed runner
    before this path can trigger.
    """
    statement = str((director_hypothesis or {}).get("statement") or "").strip()
    check_prefix = re.sub(r"[^a-z0-9_]+", "_", str(primary_hypothesis_id).lower()).strip("_") or "hypothesis"
    if decision.get("reason") == "lead_already_has_an_analyst_designed_check":
        why = (
            "This lead already has an analyst-designed check bound to it ("
            + ", ".join(decision.get("lead_bound_design_lanes") or []) + "). "
            "A capability baseline stamped with the lead's id would add no evidence and would "
            "dilute what the gate reads."
        )
    else:
        why = (
            "The capability baseline already passed this cycle ("
            + ", ".join(decision.get("baseline_passed_lanes") or []) + "), so the renderer, the "
            "seeds and the measurement pipeline are proven. Running it again produces no evidence "
            "for this lead: cycle-g-v85 ran the byte-identical blueprint twelve times, six of them "
            "stamped with the then-current lead, and three gatekeepers correctly scored that lead "
            "as having no successful validation result."
        )
    check = {
        "check_id": f"{check_prefix}_analyst_design_required_01",
        "hypothesis_text": statement,
        "hypothesis_id": str(primary_hypothesis_id or ""),
        "hypothesis_bound": False,
        "executable": False,
        "model_family": "analyst-design-required",
        "goal": (
            "Design an experiment that tests THIS lead. " + why + " State the arms, the pinned "
            "seeds, the comparator, the matched budget and the falsification condition, and size "
            "the sweep against role_plan.planner_metadata.instrument_inventory."
        ),
        "dataset": "procedural_mitsuba_scenes",
        "outcome": "declared_by_analyst",
        "exposures": ["declared_by_analyst"],
        "adjustment_set": [],
        "fixed_effects": [],
        "sample_filters": [],
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": (
                "Not applicable: this is a request for a design, not a measurement."
            ),
        },
        "failure_criteria": [
            "A design that re-runs the adaptive-vs-uniform capability baseline under a new name.",
            "A design whose success criterion does not mention the mechanism named in the lead.",
        ],
        "analyst_design_request": decision,
    }
    mapping = {
        "primary_family": primary_family,
        "hypothesis_statement": statement,
        "handoff_generation_mode": "cs_analyst_design_required",
        "cs_baseline_decision": decision,
    }
    return _stamp_reproducibility_design([check]), [], mapping


def _explicit_mitsuba_render_selected(role_plan: dict | None) -> bool:
    """Select the fixed render capability check only for the selected renderer.

    A broad ``cs`` label (or a mention of a previous Mitsuba failure) is not a
    tool selection. The explicit plan takes precedence over inventory and the
    cycle environment, so a different selected backend cannot be overridden by
    stale renderer evidence.
    """
    # The selected backend names itself; that IS the fact this asks for. It used
    # to be gated first on the objective's wording, so a cycle that had selected
    # this backend was told it had not, whenever the objective was phrased in
    # terms the word list did not carry.
    rp = role_plan if isinstance(role_plan, dict) else {}
    metadata = rp.get("planner_metadata") or {}
    metadata = metadata if isinstance(metadata, dict) else {}
    inventory = metadata.get("instrument_inventory") or {}
    inventory = inventory if isinstance(inventory, dict) else {}
    selections = (
        rp.get("probe_config"),
        metadata.get("probe_config"),
        inventory.get("probe_config"),
        inventory,
    )
    for selection in selections:
        if isinstance(selection, dict) and "backend" in selection:
            return str(selection["backend"]).strip().lower() == "mitsuba"
    return os.environ.get("RESEARCHLAB_INSTRUMENT_PROBE_BACKEND", "").strip().lower() == "mitsuba"


def _build_requirement_handoff_checks_and_blueprints(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    role_plan: dict | None,
    memo: dict | None,
    bundle: dict,
    keywords: set[str],
) -> tuple[list[dict], list[dict], dict] | None:
    validation_text = _validation_context_text(
        role_plan=role_plan,
        director_hypothesis=director_hypothesis,
        memo=memo,
        primary_family=primary_family,
    )
    csvs = [csv for csv in (bundle.get("csvs") or []) if isinstance(csv, dict)]
    wide_csvs = sorted(csvs, key=_looks_like_wide_measurement_csv, reverse=True)
    wide_csv = wide_csvs[0] if wide_csvs and _looks_like_wide_measurement_csv(wide_csvs[0]) > 0 else None
    effect_csvs = [csv for csv in csvs if _looks_like_effect_table(csv)]
    effect_csv = effect_csvs[0] if effect_csvs else None
    term_csvs = [csv for csv in sorted(csvs, key=_looks_like_term_table, reverse=True) if _looks_like_term_table(csv) > 0]
    topic_groups = _topic_groups_from_text(validation_text, keywords)

    checks: list[dict] = []
    blueprints: list[dict] = []
    mapping: dict = {
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
        "handoff_generation_mode": "requirement_driven_bundle_validation",
    }
    check_prefix = re.sub(r"[^a-z0-9_]+", "_", primary_hypothesis_id.lower()).strip("_") or "hypothesis"

    # This capability template uses Mitsuba APIs. A generic CS domain must use
    # the ordinary input-driven handoff path unless that renderer was selected.
    if _explicit_mitsuba_render_selected(role_plan):
        # The baseline is a capability check, not a lead's experiment. Emit it
        # once per cycle; after that, ask for the design instead of shipping a
        # twelfth identical run wearing the lead's name. See _cs_baseline_decision.
        decision = _cs_baseline_decision(role_plan, primary_hypothesis_id)
        if not decision.get("emit_baseline"):
            return _cs_analyst_design_request(
                primary_hypothesis_id=primary_hypothesis_id,
                primary_family=primary_family,
                director_hypothesis=director_hypothesis,
                role_plan=role_plan,
                decision=decision,
            )
        generic_checks, generic_blueprints, generic_mapping = _render_quality_checks_and_blueprints(
            check_prefix, director_hypothesis, mapping
        )
        generic_mapping["cs_baseline_decision"] = decision
        return _stamp_reproducibility_design(generic_checks), generic_blueprints, generic_mapping

    comparison_groups = _infer_comparison_groups(wide_csv, effect_csv)
    score_groups = _signature_score_groups(
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        topic_groups=topic_groups,
    )
    if wide_csv and comparison_groups and len(score_groups) >= 2:
        check_id = f"{check_prefix}_signature_score_contest_01"
        term_paths = [
            {"name": csv.get("name"), "path": csv.get("csv_path")}
            for csv in term_csvs[:8]
            if csv.get("csv_path")
        ]
        check = {
            "check_id": check_id,
            "goal": "Compute the claim-level sample signature score and all declared rival scores from the same measurement matrix, then require the primary score to separate the two sample groups at least as consistently as the rivals.",
            "dataset": wide_csv.get("name") or "wide_measurement_table",
            "dataset_path": wide_csv.get("csv_path"),
            "term_tables": term_paths,
            "score_groups": score_groups,
            "outcome": "sample_level_signature_score",
            "exposures": [group.get("label") for group in score_groups],
            "comparison_groups": comparison_groups[:2],
            "adjustment_set": [],
            "fixed_effects": [],
            "sample_filters": [],
            "model_family": "sample-level-signature-score-contest",
            "success_criteria": {
                "expected_sign": "n/a",
                "minimum_effect_description": "The primary signature must have >=3 mapped members, direction-free rank separation AUC >=0.89, directionally consistent leave-one-sample-out effects, and separation/effect at least as strong as computable rival signatures.",
            },
            "failure_criteria": [
                "The primary signature cannot be mapped to enough measurement rows.",
                "Fewer than two rival scores can be computed under the same protocol.",
                "The primary score does not separate sample groups at the sample level.",
                "A rival score matches or exceeds the primary signature's separation or effect size.",
                "Leave-one-sample-out direction changes after removing one sample.",
            ],
        }
        checks.append(check)
        blueprints.append({
            "blueprint_id": f"blueprint:{check_id}",
            "check_id": check_id,
            "language": "python",
            "entrypoint": "main",
            "dataset": check["dataset"],
            "dataset_path": check["dataset_path"],
            "outcome": check["outcome"],
            "exposures": check["exposures"],
            "code": _signature_score_contest_blueprint_code(),
            "dependencies": ["pandas", "numpy", "matplotlib"],
            "execution_notes": [
                "Builds score groups from the hypothesis/review context and materialized bundle metadata, not from a hardcoded ontology.",
                "Maps signature members through annotation columns, declared anchor identifiers, and term-table gene/member columns when available.",
                "Writes sample-level score, signature ranking, member table, and two rendered figures for paper/figure downstream use.",
            ],
            "review_focus": ["direct claim score", "rival score contest", "leave-one-sample-out sensitivity", "figure readiness"],
            "review_status": "ready_for_runner",
        })
        mapping["score_groups"] = score_groups
        mapping["signature_score_table"] = wide_csv.get("csv_path")

    if wide_csv and comparison_groups:
        check_id = f"{check_prefix}_sample_stability_01"
        effect_paths = [
            {"name": csv.get("name"), "path": csv.get("csv_path")}
            for csv in effect_csvs[:3]
            if csv.get("csv_path")
        ]
        check = {
            "check_id": check_id,
            "goal": "Recompute the primary group contrast from sample-level measurement columns, then test QC, normalization sensitivity, leave-one-sample-out stability, label-shuffle null behavior, and supplied-effect reproducibility.",
            "dataset": wide_csv.get("name") or "wide_measurement_table",
            "dataset_path": wide_csv.get("csv_path"),
            "effect_tables": effect_paths,
            "outcome": "computed_group_log2_effect",
            "exposures": comparison_groups[:2],
            "comparison_groups": comparison_groups[:2],
            "adjustment_set": [],
            "fixed_effects": [],
            "sample_filters": [],
            "model_family": "wide-table-replicate-stability",
            "success_criteria": {
                "expected_sign": "n/a",
                "minimum_effect_description": "Leave-one-sample-out effect correlation >= 0.8 and rank-normalized contrast correlation >= 0.7.",
            },
            "failure_criteria": [
                "No replicate-like measurement groups can be inferred from numeric columns.",
                "Leave-one-sample-out stability falls below threshold.",
                "Rank-normalized sensitivity materially changes the contrast.",
                "A supplied effect table is present but disagrees with the recomputed effect direction.",
            ],
        }
        checks.append(check)
        blueprints.append({
            "blueprint_id": f"blueprint:{check_id}",
            "check_id": check_id,
            "language": "python",
            "entrypoint": "main",
            "dataset": check["dataset"],
            "dataset_path": check["dataset_path"],
            "outcome": check["outcome"],
            "exposures": check["exposures"],
            "code": _wide_table_stability_blueprint_code(),
            "dependencies": ["pandas", "numpy", "matplotlib"],
            "execution_notes": [
                "Infers replicate groups from column structure and uses comparison_groups declared in the handoff.",
                "Produces QC, leave-one-sample-out, permutation-null, normalization-sensitivity, and supplied-effect comparison artifacts where supported by the bundle.",
                "Domain-neutral: no marker list or dataset-specific column name is embedded in the code.",
            ],
            "review_focus": ["sample-level QC", "stability", "normalization sensitivity", "label-shuffle null", "effect reproducibility"],
            "review_status": "ready_for_runner",
        })
        mapping["comparison_groups"] = comparison_groups[:2]
        mapping["wide_measurement_table"] = wide_csv.get("csv_path")

    if term_csvs and len(topic_groups) >= 2:
        check_id = f"{check_prefix}_topic_dominance_01"
        primary_topic = topic_groups[0]["label"]
        check = {
            "check_id": check_id,
            "goal": "Quantify whether analyst-requested mechanism/topic groups dominate rival groups across term-like statistical tables at multiple error-rate thresholds.",
            "dataset": "term_statistic_tables",
            "term_tables": [
                {"name": csv.get("name"), "path": csv.get("csv_path")}
                for csv in term_csvs[:6]
                if csv.get("csv_path")
            ],
            "topic_groups": topic_groups,
            "primary_topic": primary_topic,
            "thresholds": [0.05, 0.1, 0.25],
            "outcome": "topic_term_count",
            "exposures": [group["label"] for group in topic_groups],
            "adjustment_set": [],
            "fixed_effects": [],
            "sample_filters": [],
            "model_family": "term-table-topic-dominance",
            "success_criteria": {
                "expected_sign": "n/a",
                "minimum_effect_description": "The primary topic has at least as many q/FDR < 0.1 term hits as any rival topic, with threshold sensitivity reported.",
            },
            "failure_criteria": [
                "Term-like tables or q/FDR/p-value columns cannot be detected.",
                "The primary topic has no thresholded support.",
                "A rival topic has stronger thresholded support than the primary topic.",
            ],
        }
        checks.append(check)
        blueprints.append({
            "blueprint_id": f"blueprint:{check_id}",
            "check_id": check_id,
            "language": "python",
            "entrypoint": "main",
            "dataset": check["dataset"],
            "outcome": check["outcome"],
            "exposures": check["exposures"],
            "code": _term_table_topic_blueprint_code(),
            "dependencies": ["pandas", "matplotlib"],
            "execution_notes": [
                "Topic groups are extracted from the review/hypothesis text and matched against term-like tables.",
                "Reports q/FDR threshold sensitivity at 0.05, 0.1, and 0.25.",
                "Domain-neutral: the code detects term and statistic columns structurally rather than using a fixed ontology.",
            ],
            "review_focus": ["rival topic dominance", "threshold sensitivity", "term-table provenance"],
            "review_status": "ready_for_runner",
        })
        mapping["topic_groups"] = topic_groups
        mapping["term_tables"] = [csv.get("csv_path") for csv in term_csvs[:6]]

    if not checks:
        return None
    return _stamp_reproducibility_design(checks), blueprints, mapping



def _write_open_source_workflow_adapter(output_dir: Path | None) -> Path | None:
    if output_dir is None:
        return None
    cycle_id = cycle_id_from_output_dir(output_dir) or "cycle"
    runtime_root = output_dir.parents[3] if len(output_dir.parents) > 3 else output_dir.parent
    tool_dir = runtime_root / "tools" / cycle_id / "python-open-source-workflow-adapter"
    tool_dir.mkdir(parents=True, exist_ok=True)
    script_path = tool_dir / "open_source_workflow_adapter.py"
    script_path.write_text(_open_source_workflow_adapter_code().lstrip(), encoding="utf-8")
    return tool_dir


def _bundle_modality_summary(bundle: dict | None) -> dict:
    csvs = [csv for csv in (bundle or {}).get("csvs", []) if isinstance(csv, dict)]
    wide_count = sum(1 for csv in csvs if _looks_like_wide_measurement_csv(csv) > 0)
    term_count = sum(1 for csv in csvs if _looks_like_term_table(csv) > 0)
    effect_count = sum(1 for csv in csvs if _looks_like_effect_table(csv))
    numeric_column_count = 0
    column_count = 0
    for csv in csvs:
        columns = csv.get("columns") or []
        if isinstance(columns, list):
            column_count += len(columns)
            numeric_column_count += sum(
                1 for column in columns
                if re.search(r"(sample|count|expr|score|effect|log|fold|value|p[_ -]?value|q[_ -]?value|fdr|stat)", str(column), re.I)
            )
    modality = "high_dimensional_tabular"
    if wide_count or term_count or effect_count:
        modality = "omics_or_high_dimensional_expression"
    return {
        "csv_count": len(csvs),
        "wide_measurement_tables": wide_count,
        "term_statistic_tables": term_count,
        "effect_tables": effect_count,
        "column_count": column_count,
        "numeric_or_stat_column_hints": numeric_column_count,
        "modality": modality,
    }


def _looks_like_omics_or_high_dimensional_modality(modality: dict | None) -> bool:
    text = json.dumps(modality or {}, sort_keys=True).lower()
    return any(
        needle in text
        for needle in [
            "omics",
            "transcript",
            "rna",
            "gene",
            "expression",
            "proteom",
            "metabolom",
            "methyl",
            "single-cell",
            "single cell",
            "high_dimensional",
            "high-dimensional",
        ]
    )


def _requires_real_repository_agent(
    *,
    role_plan: dict | None,
    modality: dict | None,
    mandatory: bool,
) -> bool:
    if not mandatory:
        return False
    # A cycle that constructs its own inputs in code cannot satisfy an external
    # repository agent, and requiring one degrades a lane that is running fine.
    # That used to be decided from the objective's words; it is decided below
    # from the bundle's own measured modality, which is the same question asked
    # of the data instead of the phrasing.
    mandate = ((role_plan or {}).get("planner_metadata") or {}).get(
        "open_source_analysis_agent_mandate"
    ) or {}
    reason_text = json.dumps(
        {
            "modality": modality or {},
            "detection_reasons": mandate.get("detection_reasons") or [],
            "tool_discovery_rule": mandate.get("tool_discovery_rule") or "",
        },
        sort_keys=True,
    ).lower()
    return _looks_like_omics_or_high_dimensional_modality(modality) or any(
        needle in reason_text
        for needle in [
            "omics",
            "transcript",
            "rna",
            "high-dimensional",
            "high dimensional",
            "large-scale",
            "large scale",
        ]
    )


def _generic_adapter_candidate(tool_dir: Path | None, modality: dict, reuse_decision: str) -> dict:
    local_path = str(tool_dir) if tool_dir is not None else None
    return {
        "name": "python-open-source-workflow-adapter",
        "url": "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
        "license": "BSD-3-Clause/BSD-style open-source package workflow",
        "domain": modality.get("modality") or "high_dimensional_tabular",
        "fit_score": 78 if modality.get("modality") == "omics_or_high_dimensional_expression" else 68,
        "reuse_decision": reuse_decision,
        "source_kind": "generic_package_adapter",
        "download_command": "No git clone required: reuse installed open-source Python packages; lab-runner verifies imports in smoke_test_command.",
        "download_verified": False,
        "local_path": local_path,
        "setup_commands": [],
        "smoke_test_command": "python3 open_source_workflow_adapter.py --smoke" if local_path else None,
        "application_command": (
            "python3 open_source_workflow_adapter.py --csv-root \"$RESEARCHLAB_CSV_ROOT\" --output-dir \"$RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR\""
            if local_path
            else None
        ),
        "expected_outputs": [
            "open_source_workflow_numeric_profile.csv",
            "open_source_workflow_summary.json",
        ],
        "debug_attempts": [
            {
                "command": "python3 open_source_workflow_adapter.py --smoke",
                "status": "delegated_to_lab_runner" if local_path else "blocked",
                "stderr_excerpt": "",
                "fix_or_blocker": (
                    "lab-runner records stdout/stderr/return code in external_agent_runs before executing blueprints"
                    if reuse_decision != "reject"
                    else "generic pandas/numpy/sklearn adapter is auxiliary only and cannot satisfy mandatory omics/high-dimensional open-source repository-agent discovery"
                ),
            }
        ],
        "evidence": (
            "The selected dataset is tabular/high-dimensional; this local adapter can profile table shape but is not a domain-specific external repository or workflow."
        ),
        "reason": (
            "Use as a deterministic pre-blueprint workflow audit; retain self-contained blueprints for claim-specific statistics."
            if reuse_decision != "reject"
            else "Rejected as selected agent because mandatory omics/high-dimensional analysis requires a real external repository/workflow/domain package to be discovered, downloaded or installed, smoke-tested, debugged, and applied."
        ),
    }


def _tool_slug(value: str, *, fallback: str = "external-repo-agent") -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", clean_text(value).lower()).strip("-._")
    return (slug or fallback)[:80]
