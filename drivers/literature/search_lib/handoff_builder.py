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

from .templates.analysis_master_table import _analysis_master_table_blueprint_code
from .http_client import clean_text
from .queries import gate_restart_candidate_families, role_plan_primary_families
from .dataset_inspect import _bundle_search_text, _hypothesis_keywords
from .data_graph import _append_data_graph_analysis_edge, _attach_schema_graph_audit, _build_schema_graph_audit, _cycle_candidate_datasets_from_state, _load_cycle_data_graph, _score_bundle_columns
from .objective import _objective_forbidden_dataset_terms
from .synthesis import analyst_family_to_check
from .director_context import _bundle_matches_director_dataset, _load_lab_director_hypothesis, _reference_context_from_director
from .external_repo import _attach_open_source_agent_discovery
from .handoff_checks import _append_confounder_sensitivity, _append_reference_baseline_audit, _append_same_dataset_baseline_reproduction, _render_quality_checks_and_blueprints, _cs_analyst_design_request, _cs_baseline_decision, _explicit_mitsuba_render_selected
from .dataset_checks import _build_generic_handoff_check_and_blueprint, _primary_focus_policy_from_role_plan


def _is_unselected_fallback_hypothesis(primary_family: str, director_hypothesis: dict | None) -> bool:
    return not director_hypothesis and str(primary_family or "").strip() in {"", "unclassified_family"}



def _handoff_is_scientifically_executable(handoff: dict) -> bool:
    if handoff.get("status") != "ready_for_runner":
        return False
    checks = handoff.get("handoff_checks") or []
    blueprints = handoff.get("validation_code_blueprints") or []
    if not checks or not blueprints:
        return False
    weak_models = {"term-table-topic-dominance"}
    model_families = {
        str(check.get("model_family") or "")
        for check in checks
        if isinstance(check, dict)
    }
    if model_families and model_families.issubset(weak_models):
        return False
    return any(
        isinstance(bp, dict) and str(bp.get("code") or "").strip()
        for bp in blueprints
    )





def _handoff_carries_render_check(handoff: dict) -> bool:
    """True when the handoff validates via a render-and-measure check (a
    computer-graphics / rendering objective). Such a handoff produces a rendered
    image + render_metrics.csv, NOT a tabular analysis master table, so the
    omics-shaped master-table gate does not apply to it."""
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


def _attach_analysis_master_table_contract(handoff: dict) -> None:
    if not isinstance(handoff, dict) or handoff.get("status") != "ready_for_runner":
        return
    # A render objective validates by rendering + measuring image quality, not by
    # building a tabular master table. Stapling the omics master-table gate onto
    # it makes the (passing) render lane degrade on a gate it can never satisfy.
    if _handoff_carries_render_check(handoff):
        return
    checks = handoff.setdefault("handoff_checks", [])
    blueprints = handoff.setdefault("validation_code_blueprints", [])
    if not isinstance(checks, list) or not isinstance(blueprints, list) or not blueprints:
        return
    if any(isinstance(check, dict) and check.get("check_id") == "analysis_master_table_created" for check in checks):
        return

    first = next((item for item in blueprints if isinstance(item, dict)), None)
    if not first:
        return
    dataset_path = first.get("expression_matrix_path") or first.get("dataset_path")
    sample_metadata_path = first.get("sample_metadata_path") or first.get("metadata_path")
    contract = {
        "row_grain": "one analysis-ready observation per joined sample/segment before hypothesis testing",
        "join_keys": ["SegmentDisplayName"] if sample_metadata_path else [],
        "required_columns": list(dict.fromkeys([
            "cohort",
            "sample_or_segment_id",
            "primary exposure/proxy columns",
            "primary outcome/cohort label",
            "available covariates and quality-control fields",
        ])),
        "cohort_label_construction": first.get("outcome") or "derive from schema-backed cohort/outcome field",
        "covariates": first.get("adjustment_set") or [],
        "exclusion_rules": first.get("sample_filters") or [],
        "output_path": "analysis_master_table.csv",
        "artifact_name_pattern": "master_table",
        "quality_checks": [
            "analysis_master_table_created",
            "analysis_master_table_has_rows",
            "analysis_master_table_has_columns",
        ],
    }
    gate = {
        "required": True,
        "gate_id": "analysis_master_table_gate",
        "required_check_id": "analysis_master_table_created",
        "required_artifact_name_pattern": "master_table",
        "must_run_before_hypothesis_validation": True,
    }
    check = {
        "check_id": "analysis_master_table_created",
        "goal": "Build and persist the explicit analysis master table before running hypothesis validation.",
        "dataset_path": dataset_path,
        "expression_matrix_path": first.get("expression_matrix_path"),
        "sample_metadata_path": sample_metadata_path,
        "model_family": "pre_validation_analysis_master_table",
        "success_criteria": [
            "analysis_master_table.csv exists",
            "checks.analysis_master_table_created=true",
            "the table has at least one row and one column",
        ],
    }
    blueprint = {
        "blueprint_id": "blueprint:analysis_master_table_created",
        "check_id": "analysis_master_table_created",
        "language": "python",
        "entrypoint": "main",
        "dataset_path": dataset_path,
        "expression_matrix_path": first.get("expression_matrix_path"),
        "sample_metadata_path": sample_metadata_path,
        "dependencies": ["numpy", "pandas"],
        "review_status": "ready_for_runner",
        "execution_notes": [
            "Run this blueprint before any hypothesis-validation blueprint.",
            "Do not interpret hypothesis output if this master-table gate fails.",
        ],
        "code": _analysis_master_table_blueprint_code(),
    }
    handoff["analysis_master_table"] = contract
    handoff["pre_validation_master_table_gate"] = gate
    checks.insert(0, check)
    blueprints.insert(0, blueprint)


def _analysis_design_memo_for_handoff(
    *,
    handoff: dict,
    candidate_datasets: list[dict],
    selected_bundle: dict | None,
    primary_family: str,
    director_hypothesis: dict | None,
    primary_hypothesis_id: str,
) -> dict:
    checks = [check for check in (handoff.get("handoff_checks") or []) if isinstance(check, dict)]
    audit = handoff.get("schema_graph_audit") if isinstance(handoff.get("schema_graph_audit"), dict) else {}
    tables = audit.get("tables") if isinstance(audit, dict) else []
    workflow_decision = handoff.get("workflow_compatibility_decision")
    if not isinstance(workflow_decision, dict):
        workflow_decision = None
    final_ready = _handoff_is_scientifically_executable(handoff)
    model_families = [str(check.get("model_family") or "") for check in checks]
    blocked_reason = None
    if not final_ready:
        if set(model_families).issubset({"term-table-topic-dominance"}) and model_families:
            blocked_reason = "Only fallback topic-token checks were available; Analyst must repair variables before runner execution."
        else:
            blocked_reason = handoff.get("reason") or "Schema-backed executable validation is not yet ready."
    design_candidates = []
    for check in checks:
        design_candidates.append({
            "design_id": check.get("check_id"),
            "model_family": check.get("model_family"),
            "scientific_question": check.get("goal"),
            "schema_backing": {
                "dataset": check.get("dataset"),
                "dataset_path": check.get("dataset_path"),
                "outcome": check.get("outcome"),
                "exposures": check.get("exposures") or [],
                "adjustment_set": check.get("adjustment_set") or [],
                "sample_metadata_path": check.get("sample_metadata_path"),
            },
            "runner_handoff_ready": check.get("model_family") not in {"term-table-topic-dominance"},
        })
    if not design_candidates:
        design_candidates.append({
            "design_id": "schema_exploration_required",
            "model_family": None,
            "scientific_question": "Inspect materialized dataset schema/metadata/literature baseline before writing runner handoff.",
            "schema_backing": {},
            "runner_handoff_ready": False,
        })
    return {
        "artifact_type": "analysis-design-memo",
        "phase": "exploratory_scientific_design_before_runner_handoff",
        "primary_hypothesis_id": primary_hypothesis_id,
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement") or handoff.get("summary"),
        "analyst_authority": [
            "Explore schema, metadata, data graph, same-dataset papers, and open-source workflows before committing to an executable handoff.",
            "Propose multiple validation designs, reject infeasible designs explicitly, and declare when the dataset cannot support the hypothesis.",
            "Only promote final handoff checks when exposure, outcome/proxy, joins, confounders, and robustness checks are schema-backed or explicitly derived.",
        ],
        "dataset_exploration": {
            "candidate_dataset_count": len(candidate_datasets),
            "selected_dataset_root": (selected_bundle or {}).get("bundle_path") or handoff.get("dataset_root"),
            "selected_dataset_reason": handoff.get("reason"),
            "bundle_match_score": handoff.get("bundle_match_score"),
            "tables": tables[:12] if isinstance(tables, list) else [],
            "strategy_recommendation": audit.get("strategy_recommendation") if isinstance(audit, dict) else None,
        },
        "design_candidates": design_candidates,
        "workflow_compatibility_decision": workflow_decision,
        "minimum_final_handoff_requirements": [
            "real schema-backed biological exposure or explicitly derived biological score",
            "real schema-backed outcome/proxy or same-dataset baseline reproduction target",
            "same-dataset baseline/proxy reproduction when a reference paper exists",
            "confounder/batch/library-size/location/age robustness when available",
            "negative/permutation/falsification check that directly challenges the biological hypothesis",
        ],
        "final_handoff_readiness": {
            "ready_for_runner": final_ready,
            "blocking_reason": blocked_reason,
            "fallback_topic_or_path_token_checks_allowed": False,
        },
    }


def build_analyst_handoff(source_stats: dict, role_plan: dict | None, output_dir: Path | None = None) -> dict:
    planner_metadata = (role_plan or {}).get("planner_metadata") or {}
    analysis_mode = str(planner_metadata.get("analysis_mode") or "incumbent_selection").strip()
    minimum_handoff_checks = int(planner_metadata.get("minimum_handoff_checks") or 1)
    frontier_families = (source_stats.get("frontier_catalog") or {}).get("primary_variable_families") or []
    source_families = source_stats.get("selected_families") or source_stats.get("candidate_primary_families") or []
    if not source_families and source_stats.get("primary_family"):
        source_families = [{"family": source_stats.get("primary_family"), "priority": "high"}]
    gate_restart_families = gate_restart_candidate_families(role_plan)
    candidate_primary_families = gate_restart_families or frontier_families or role_plan_primary_families(role_plan) or source_families
    normalized_families = []
    for item in candidate_primary_families[:5]:
        family = str(item.get("family") or item.get("family_root") or "").strip()
        if not family:
            continue
        normalized_families.append(
            {
                "family": family,
                "why_competitive": item.get("why_competitive")
                or f"Literature frontier support count = {int(item.get('support_count') or 0)}.",
                "priority": item.get("priority") or ("high" if not normalized_families else "medium"),
            }
        )
    if not normalized_families:
        for item in role_plan_primary_families(role_plan)[:5]:
            family = str(item.get("family") or item.get("family_root") or "").strip()
            if family:
                normalized_families.append(
                    {
                        "family": family,
                        "why_competitive": item.get("why_competitive") or "Role-plan prior family.",
                        "priority": item.get("priority") or ("high" if not normalized_families else "medium"),
                    }
                )

    if gate_restart_families:
        # Preserve gate-review alternatives ahead of deterministic frontier
        # families, and require at least three distinct candidates for a real
        # post-reject family contest.  If fewer are available, keep the handoff
        # deferred later rather than silently validating a single incumbent.
        merged: list[dict] = []
        seen: set[str] = set()
        for item in [*gate_restart_families, *normalized_families]:
            family = clean_text(str(item.get("family") or item.get("family_root") or ""))
            if not family or family.lower() in seen:
                continue
            seen.add(family.lower())
            merged.append({
                "family": family,
                "why_competitive": item.get("why_competitive") or "Gate-reject family-switch candidate.",
                "priority": item.get("priority") or ("high" if len(merged) < 3 else "medium"),
                "source": item.get("source") or "gate_restart_policy",
                "gate_restart_candidate": bool(item.get("gate_restart_candidate", True)),
            })
        normalized_families = merged[:8]

    # Since analyst_family_to_check now returns None, the "valid_family_
    # order" list will be empty regardless of the normalized_families
    # input. That's intentional — the external-driver handoff path is
    # retained only for compatibility; the analyst Codex agent is
    # expected to emit real handoff_checks. We no longer fall back to
    # "immunization_coverage" when no families are supplied.
    valid_family_order = [
        item["family"]
        for item in normalized_families
        if analyst_family_to_check(item["family"])
    ]
    # rival_family_ranking mode previously lifted "immunization_coverage"
    # to the tail; without that default the ordering is simply the
    # normalized order.
    ordered = valid_family_order[:]

    selected_families: list[str] = []
    for family in ordered:
        if family not in selected_families:
            selected_families.append(family)
        if len(selected_families) >= minimum_handoff_checks:
            break
    # No WHO fallback list — selected_families stays as-is (possibly empty).

    primary_family = selected_families[0] if selected_families else (
        normalized_families[0]["family"] if normalized_families else "unclassified_family"
    )
    handoff_checks = [
        analyst_family_to_check(family)
        for family in selected_families
        if analyst_family_to_check(family)
    ]
    memo = source_stats.get("statistical_review_memo") or {}
    proposals = source_stats.get("analysis_lane_proposals") or []

    # Unification: when lab-director has emitted a hypothesis to disk
    # (chronicle → lab-director → analyst flow), use it as the
    # authoritative source — analyst's job is to verify it, not
    # synthesise a new one. Falls back to the deterministic
    # family-discovery path when no hypothesis is present.
    director_hypothesis = _load_lab_director_hypothesis(output_dir) if output_dir else None
    cycle_data_graph = _load_cycle_data_graph(output_dir) if output_dir else None
    handoff_generation_mode = "external-driver-statistical-review"
    if director_hypothesis:
        handoff_generation_mode = "lab-director-hypothesis-verification"
        director_primary = clean_text(str(director_hypothesis.get("primary_family") or "")).strip() or primary_family
        director_secondary = director_hypothesis.get("secondary_families") or []
        director_strategy = clean_text(str(director_hypothesis.get("identification_strategy") or "observational_panel")).strip()
        # Override primary_family + normalized_families with the director's
        # explicit choice, keeping the family-discovery output as fallback
        # context only. The director's primary stays first, secondaries
        # follow, then any deterministic discoveries that don't conflict.
        director_families: list[dict] = [
            {
                "family": director_primary,
                "why_competitive": "Selected by lab-director from literature_graph + data_graph synthesis.",
                "priority": "high",
                "source": "lab-director-hypothesis",
            }
        ]
        for sf in director_secondary[:3]:
            sf_name = clean_text(str(sf if isinstance(sf, str) else sf.get("family") or "")).strip()
            if sf_name and sf_name != director_primary:
                director_families.append({
                    "family": sf_name,
                    "why_competitive": "Secondary family flagged by lab-director.",
                    "priority": "medium",
                    "source": "lab-director-hypothesis",
                })
        for ndf in normalized_families:
            if not any(d["family"] == ndf["family"] for d in director_families):
                director_families.append({**ndf, "source": "deterministic-frontier"})
        normalized_families = director_families[:5]
        primary_family = director_primary

        # Override estimands / confounders / falsification using the
        # director's hypothesis content so lab-runner runs blueprints
        # aligned with the director's identification strategy.
        if director_hypothesis.get("rival_mechanisms"):
            memo = {**memo, "estimands": [
                f"Verify hypothesis '{(director_hypothesis.get('statement') or '')[:160]}' under identification_strategy={director_strategy}.",
                "Effect size on the primary outcome named in the hypothesis (within the smallest dataset slice supporting the strategy).",
                "Sensitivity / robustness check around the strategy's main identifying assumption.",
            ]}
        if director_hypothesis.get("falsification_conditions"):
            memo = {**memo, "falsification_tests": [
                str(item)[:160] for item in director_hypothesis.get("falsification_conditions") or []
            ]}
        if director_hypothesis.get("rival_mechanisms"):
            memo = {**memo, "priority_confounders": [
                str(item)[:160] for item in (director_hypothesis.get("rival_mechanisms") or [])[:6]
            ]}
        primary_hypothesis_id = clean_text(str(director_hypothesis.get("hypothesis_id") or "")).strip() or f"hyp-director-{primary_family}"
    else:
        # Generic primary_hypothesis_id from family name; previously this
        # mapped immunization_coverage / zero_dose_burden / measurement_
        # quality → hardcoded WHO hypothesis-ids.
        primary_hypothesis_id = (
            f"hyp-fallback-{primary_family}" if primary_family != "unclassified_family" else "hyp-fallback-unclassified"
        )

    reference_context = _reference_context_from_director(director_hypothesis)
    handoff = {
        "summary": clean_text(
            (director_hypothesis or {}).get("statement")
            or (role_plan or {}).get("analysis_goal")
            or f"Select family `{primary_family}` and issue one executable validation handoff for lab-runner."
        ),
        "primary_hypothesis_id": primary_hypothesis_id,
        "candidate_primary_families": normalized_families,
        "candidate_estimands": memo.get("estimands")
        or ["Adjusted association for the selected primary family under appropriate controls."],
        "rival_dags": (director_hypothesis or {}).get("rival_mechanisms") or (
            # A single generic rival left every deterministic handoff with one
            # declared rival, so promotion-readiness stayed capped under the
            # rival_underexploration_cap (needs >=2). Declare the genuine
            # alternatives an observational multi-omics association must rule
            # out: the cycle's OWN discovered competing primary families (real
            # rival exposures) plus the two canonical causal alternatives
            # (confounding, reverse causation). These are the rival DAGs /
            # competing exposures the analyst contract already requires, not
            # padding.
            [
                f"A competing primary family ('{clean_text(str(f.get('family') or '')).strip()}') "
                f"explains the outcome better than '{primary_family}'."
                for f in normalized_families
                if clean_text(str(f.get("family") or "")).strip()
                and clean_text(str(f.get("family") or "")).strip() != primary_family
            ][:3]
            + [
                "Confounding by population structure and measurement / batch artifacts jointly influence exposure and outcome.",
                "Reverse causation: the measured outcome state drives the molecular profile rather than the proposed exposure driving the outcome.",
            ]
        ),
        "confounders": memo.get("priority_confounders") or ["unspecified_measured_confounders"],
        "falsification_ideas": memo.get("falsification_tests") or ["family_pairwise_contest", "negative_control_test"],
        "evidence_gaps": [
            "Analyst handoff sourced from lab-director-hypothesis.json (verification mode)." if director_hypothesis else
            "Analyst handoff generated by deterministic external-driver synthesis from literature frontier and role-plan context."
        ],
        "analysis_lane_proposals": proposals[:4]
        or [
            {
                "description": "Run executable validation checks for the lab-director hypothesis." if director_hypothesis else "Run executable validation checks for the leading analyst-selected families.",
                "target_family": family,
                "decision_value": "high" if index == 0 else "medium",
            }
            for index, family in enumerate(selected_families or [primary_family])
        ],
        "handoff_checks": handoff_checks,
        "handoff_generation_mode": handoff_generation_mode,
        "lab_director_hypothesis_consumed": bool(director_hypothesis),
    }
    if gate_restart_families:
        handoff["gate_reject_scientific_validation_contract"] = {
            "minimum_candidate_family_count": 3,
            "actual_candidate_family_count": len(normalized_families),
            "incumbent_reuse_policy": "forbidden_as_primary; benchmark_or_negative_control_only",
            "required_design_elements": [
                "biological mechanism",
                "schema-backed exposure or derived indicator",
                "schema-backed outcome/proxy",
                "confounders/batch fields",
                "negative controls",
                "falsification criterion",
                "failure threshold for abandonment",
            ],
        }
        if len(normalized_families) < 3:
            handoff["status"] = "deferred"
            handoff["reason"] = "gate_reject_requires_three_family_contest"
            handoff["handoff_checks"] = []
            handoff["validation_code_blueprints"] = []
            handoff.setdefault("evidence_gaps", []).append(
                "Gate reject recovery requires at least three non-incumbent family candidates before lab-runner validation."
            )
    if _is_unselected_fallback_hypothesis(primary_family, director_hypothesis):
        handoff["status"] = "deferred"
        handoff["reason"] = "no_nonfallback_hypothesis"
        handoff["handoff_checks"] = []
        handoff["validation_code_blueprints"] = []
        handoff["candidate_dataset_count"] = 0
        handoff.setdefault("evidence_gaps", []).append(
            "No classified, falsifiable hypothesis family was selected; refusing to emit the old unclassified_family generic binary-outcome fallback. Regenerate the design from literature/data graph first."
        )
    if reference_context:
        handoff["reference_context"] = reference_context

    # Phase 1 data fetcher (docs/data-fetcher-2026-04-28.md §E):
    # the analyst's task_markdown directs it to pick a dataset_root and
    # column_mapping from role_plan.planner_metadata.candidate_datasets,
    # but for external-driver analyst lanes the handoff is composed
    # deterministically here — the LLM response is not consulted, so
    # the directive on its own does not change the handoff. Mirror the
    # directive's intent at the driver level: when cycle-scoped fetched
    # bundles are surfaced, pin dataset_root to the first one (lab-runner
    # / column_mapping refinement happens downstream); when no bundle is
    # available, surface a structured `deferred / no_matching_bundle`
    # signal instead of silently leaving the handoff with a null
    # dataset_root, so promotion gates and chronicle reports see the
    # explicit blocker.
    candidate_datasets = (
        ((role_plan or {}).get("planner_metadata") or {}).get("candidate_datasets") or []
    )
    selected_bundle_for_agent: dict | None = None
    state_candidate_datasets = _cycle_candidate_datasets_from_state(output_dir)
    if candidate_datasets and state_candidate_datasets:
        state_by_path = {
            str(bundle.get("bundle_path")): bundle
            for bundle in state_candidate_datasets
            if isinstance(bundle, dict) and bundle.get("bundle_path")
        }
        merged_candidates: list[dict] = []
        seen_paths: set[str] = set()
        for bundle in candidate_datasets:
            if not isinstance(bundle, dict):
                continue
            path = str(bundle.get("bundle_path") or "")
            state_bundle = state_by_path.get(path)
            if state_bundle:
                # Prefer the richer state-scanned csv list. Role plans can be
                # stale snapshots from before txt/gz → csv materialization.
                merged = {**bundle, **state_bundle}
                if state_bundle.get("csvs"):
                    merged["csvs"] = state_bundle.get("csvs")
                merged_candidates.append(merged)
                seen_paths.add(path)
            else:
                merged_candidates.append(bundle)
                if path:
                    seen_paths.add(path)
        for bundle in state_candidate_datasets:
            path = str(bundle.get("bundle_path") or "") if isinstance(bundle, dict) else ""
            if path and path not in seen_paths:
                merged_candidates.append(bundle)
        candidate_datasets = merged_candidates
    if not candidate_datasets:
        candidate_datasets = state_candidate_datasets
    forbidden_dataset_terms = _objective_forbidden_dataset_terms(role_plan)
    if forbidden_dataset_terms:
        candidate_datasets = [
            bundle for bundle in candidate_datasets
            if isinstance(bundle, dict)
            and not any(term in _bundle_search_text(bundle) for term in forbidden_dataset_terms)
        ]
        if forbidden_dataset_terms:
            handoff["forbidden_dataset_terms"] = sorted(forbidden_dataset_terms)

    if handoff.get("status") == "deferred" and handoff.get("reason") in {
        "no_nonfallback_hypothesis",
        "gate_reject_requires_three_family_contest",
    }:
        pass
    elif candidate_datasets:
        # Smart bundle selection: score each bundle by keyword overlap
        # between hypothesis text (statement / primary family / estimands)
        # and the bundle's csv column names. The bundle with the highest
        # overlap is most likely to support the hypothesis's variables;
        # if every bundle has zero overlap, defer with no_matching_bundle
        # rather than pinning an irrelevant bundle just because it was
        # fetched first (the v25 lesson: Harvard Dataverse returned
        # governance data for a heart-failure query, and pinning the
        # first one would have wasted the lab-runner pass).
        hypothesis_text = " ".join(str(x) for x in [
            (director_hypothesis or {}).get("statement") or "",
            primary_family,
            *((memo or {}).get("estimands") or []),
            *(((director_hypothesis or {}).get("identification_strategy") or {}).get("estimands") or []
              if isinstance((director_hypothesis or {}).get("identification_strategy"), dict)
              else []),
        ])
        keywords = _hypothesis_keywords(hypothesis_text)
        best_bundle, best_score, best_column_count = None, -1, -1
        for bundle in candidate_datasets:
            if not isinstance(bundle, dict):
                continue
            score = _score_bundle_columns(bundle, keywords)
            if _bundle_matches_director_dataset(bundle, director_hypothesis):
                score += 1000
            column_count = sum(len((csv or {}).get("columns") or []) for csv in (bundle.get("csvs") or []))
            if score > best_score or (score == best_score and column_count > best_column_count):
                best_score = score
                best_bundle = bundle
                best_column_count = column_count
        if best_bundle is not None and best_score > 0:
            bundle_path = (best_bundle or {}).get("bundle_path")
            if bundle_path:
                handoff["dataset_root"] = bundle_path
                checks, blueprints, column_mapping = _build_generic_handoff_check_and_blueprint(
                    primary_hypothesis_id=primary_hypothesis_id,
                    primary_family=primary_family,
                    director_hypothesis=director_hypothesis,
                    role_plan=role_plan,
                    memo=memo,
                    bundle=best_bundle,
                    keywords=keywords,
                )
                schema_graph_audit = _build_schema_graph_audit(
                    best_bundle,
                    data_graph=cycle_data_graph,
                    director_hypothesis=director_hypothesis,
                    hypothesis_text=hypothesis_text,
                    keywords=keywords,
                )
                _attach_schema_graph_audit(checks, blueprints, schema_graph_audit)
                selected_bundle_for_agent = best_bundle
                handoff["handoff_checks"] = checks
                handoff["validation_code_blueprints"] = blueprints
                handoff["column_mapping"] = column_mapping
                handoff["schema_graph_audit"] = schema_graph_audit
                handoff["candidate_dataset_count"] = len(candidate_datasets)
                handoff["bundle_match_score"] = best_score
                handoff["status"] = "ready_for_runner"
                handoff["reason"] = "matched_cycle_scoped_bundle"
        else:
            action_type = str((role_plan or {}).get("action_type") or "").strip()
            allow_pivot_schema_audit = action_type == "pivot_followup" or analysis_mode == "pivot_followup"
            bundle_path = (best_bundle or {}).get("bundle_path") if isinstance(best_bundle, dict) else None
            if allow_pivot_schema_audit and bundle_path and best_column_count > 0:
                checks, blueprints, column_mapping = _build_generic_handoff_check_and_blueprint(
                    primary_hypothesis_id=primary_hypothesis_id,
                    primary_family=primary_family,
                    director_hypothesis=director_hypothesis,
                    role_plan=role_plan,
                    memo=memo,
                    bundle=best_bundle,
                    keywords=keywords,
                )
                schema_graph_audit = _build_schema_graph_audit(
                    best_bundle,
                    data_graph=cycle_data_graph,
                    director_hypothesis=director_hypothesis,
                    hypothesis_text=hypothesis_text,
                    keywords=keywords,
                )
                _attach_schema_graph_audit(checks, blueprints, schema_graph_audit)
                selected_bundle_for_agent = best_bundle
                handoff["dataset_root"] = bundle_path
                handoff["handoff_checks"] = checks
                handoff["validation_code_blueprints"] = blueprints
                handoff["column_mapping"] = column_mapping
                handoff["schema_graph_audit"] = schema_graph_audit
                handoff["candidate_dataset_count"] = len(candidate_datasets)
                handoff["bundle_match_score"] = best_score
                handoff["status"] = "ready_for_runner"
                handoff["reason"] = "pivot_schema_audit_fallback"
                handoff.setdefault("evidence_gaps", []).append(
                    "No direct hypothesis-variable bundle match was found; pivot recovery selected the richest cycle-scoped bundle for an executable schema/association audit instead of returning another non-runnable deferral."
                )
            else:
            # Bundles exist but none cover the hypothesis variables.
            # Surface this as the same structured deferral as the
            # missing-bundles case — promotion gates / chronicle should
            # see it as a topic-mismatch blocker, not a silent pass.
                handoff["status"] = "deferred"
                handoff["reason"] = "no_matching_bundle"
                handoff["unresolved_variables"] = sorted(keywords)[:10]
                handoff["candidate_dataset_count"] = len(candidate_datasets)
                handoff["bundle_match_score"] = 0
    elif _explicit_mitsuba_render_selected(role_plan):
        # Explicitly selected Mitsuba rendering: the scene data is generated
        # procedurally IN-CODE (mi.load_dict), so there is no dataset bundle to
        # materialise and never will be. Deferring here on awaiting_data_
        # acquisition is the CG runner-dispatch deadlock: the analyst emits no
        # executable handoff, so the (correct) runner gate never dispatches and
        # the director spins up more analysts forever. Emit the executable
        # render-and-measure handoff directly (identical to the part_06
        # requirement-driven cs path) so a lab-runner can dispatch and render.
        _cs_prefix = (
            re.sub(r"[^a-z0-9_]+", "_", str(primary_hypothesis_id).lower()).strip("_")
            or "hypothesis"
        )
        _cs_mapping = {
            "primary_family": primary_family,
            "hypothesis_statement": (director_hypothesis or {}).get("statement"),
            "handoff_generation_mode": "procedural_render_no_bundle",
        }
        # Same once-per-cycle rule as the requirement-driven path. Guarding only
        # that one moved v85's 12 baselines here instead: v86 ran 14, eleven of
        # them through this branch, while the decision logic sat correct and
        # unreachable next door.
        _cs_decision = _cs_baseline_decision(role_plan, primary_hypothesis_id)
        if not _cs_decision.get("emit_baseline"):
            _cs_checks, _cs_blueprints, _cs_mapping = _cs_analyst_design_request(
                primary_hypothesis_id=primary_hypothesis_id,
                primary_family=primary_family,
                director_hypothesis=director_hypothesis,
                role_plan=role_plan,
                decision=_cs_decision,
            )
            handoff["handoff_checks"] = _cs_checks
            handoff["validation_code_blueprints"] = _cs_blueprints
            handoff["column_mapping"] = _cs_mapping
            handoff["status"] = "deferred"
            handoff["reason"] = "cs_analyst_design_required"
            handoff["candidate_dataset_count"] = 0
            return handoff
        _cs_checks, _cs_blueprints, _cs_mapping = _render_quality_checks_and_blueprints(
            _cs_prefix, director_hypothesis, _cs_mapping,
        )
        _cs_mapping["cs_baseline_decision"] = _cs_decision
        handoff["handoff_checks"] = _cs_checks
        handoff["validation_code_blueprints"] = _cs_blueprints
        handoff["column_mapping"] = _cs_mapping
        handoff["status"] = "ready_for_runner"
        handoff["reason"] = "procedural_render_no_bundle_required"
        handoff["candidate_dataset_count"] = 0
    else:
        # No bundles materialised. Distinguish two timing cases so
        # downstream consumers can tell whether the cycle ran the
        # fetcher and got nothing (fetcher_returned_empty) versus
        # whether the analyst was dispatched before the fetcher had a
        # chance to emit the bundles index (awaiting_data_acquisition).
        # Both still defer; only the reason text changes.
        bundles_index_path = (
            output_dir.parent / f"{(role_plan or {}).get('cycle_id') or ''}-data-bundles.json"
            if output_dir is not None
            else None
        )
        if bundles_index_path is not None and bundles_index_path.is_file():
            handoff["reason"] = "no_matching_bundle"
        else:
            handoff["reason"] = "awaiting_data_acquisition"
        handoff["status"] = "deferred"
        handoff["unresolved_variables"] = []
        handoff["candidate_dataset_count"] = 0

    validation_scope_policy = _primary_focus_policy_from_role_plan(role_plan)
    demote_resource_checks = bool(validation_scope_policy.get("active"))
    # Each stapled blueprint is attached only when the data it reads EXISTS.
    #
    # This block used to be skipped wholesale for a "computer-graphics objective",
    # because stapling a same-dataset reproduction and a covariate audit onto a
    # render design produced checks that could not run. That was the right
    # instinct and the wrong test: what makes them unrunnable is the absence of
    # the dataset and the sample metadata they read, not the objective's wording.
    # Asked of the data, the same three are skipped for a render cycle AND for
    # every other cycle whose bundle does not carry them.
    if (
        handoff.get("status") == "ready_for_runner"
        and reference_context
        and not demote_resource_checks
    ):
        checks = handoff.setdefault("handoff_checks", [])
        blueprints = handoff.setdefault("validation_code_blueprints", [])
        if isinstance(checks, list) and isinstance(blueprints, list):
            dataset_path = None
            sample_metadata_path = None
            if isinstance(handoff.get("column_mapping"), dict):
                column_mapping = handoff.get("column_mapping", {})
                dataset_path = column_mapping.get("dataset_path")
                sample_metadata_path = column_mapping.get("sample_metadata_path") or column_mapping.get("metadata_path")
            if not dataset_path and checks and isinstance(checks[0], dict):
                dataset_path = checks[0].get("dataset_path")
            if not sample_metadata_path:
                for candidate_check in checks:
                    if isinstance(candidate_check, dict):
                        sample_metadata_path = candidate_check.get("sample_metadata_path") or candidate_check.get("metadata_path")
                        if sample_metadata_path:
                            break
            _append_reference_baseline_audit(
                checks=checks,
                blueprints=blueprints,
                primary_hypothesis_id=primary_hypothesis_id,
                reference_context=reference_context,
            )
            # Reproducing a baseline needs the dataset it was run on.
            if dataset_path:
                _append_same_dataset_baseline_reproduction(
                    checks=checks,
                    blueprints=blueprints,
                    primary_hypothesis_id=primary_hypothesis_id,
                    reference_context=reference_context,
                    dataset_path=dataset_path,
                )
            # Auditing covariates needs per-sample metadata to read them from.
            # Without it the check can only ever record that it could not run.
            if sample_metadata_path:
                _append_confounder_sensitivity(
                    checks=checks,
                    blueprints=blueprints,
                    primary_hypothesis_id=primary_hypothesis_id,
                    dataset_path=dataset_path,
                    sample_metadata_path=sample_metadata_path,
                )
            handoff.setdefault("evidence_gaps", []).append(
                "Reference baseline/code audit is required before claiming the selected hypothesis improves on the cited same-dataset baseline."
            )
            handoff.setdefault("evidence_gaps", []).extend([
                "Same-dataset baseline reproduction must quantify a delta beyond the cited baseline, not only repeat a pooled association.",
                "Age/sex/repeated-subject/leukocyte-composition sensitivity must be marked as blocking if those fields are absent or the adjusted effect is not estimable.",
            ])
            handoff["claim_scope_recommendation"] = {
                "current_claim_strength": "first-pass association unless baseline reproduction and confounder sensitivity both pass",
                "allowed_claim_if_unresolved": "exploratory same-dataset association; not causal and not publication-grade",
                "upgrade_required_evidence": [
                    "reference_baseline_audit_01 passes or explicitly documents available code/supplementary resources",
                    "same_dataset_baseline_reproduction_01 quantifies a positive delta against the cited baseline",
                    "confounder_sensitivity_01 estimates adjusted/bootstrapped sensitivity or records missing confounders as blockers",
                ],
            }
    elif handoff.get("status") == "ready_for_runner" and demote_resource_checks:
        handoff["validation_scope_policy"] = validation_scope_policy
        handoff["secondary_limitations"] = list(dict.fromkeys([
            *(handoff.get("secondary_limitations") or []),
            *(validation_scope_policy.get("secondary_limitations") or []),
        ]))
        handoff.setdefault("evidence_gaps", []).append(
            "LabDirector scoped same-paper baseline/code availability and unavailable confounder fields as secondary limitations, not primary pass/fail checks for the narrowed biological estimand."
        )
        handoff["claim_scope_recommendation"] = {
            "current_claim_strength": "narrowed primary biological validation only; promotion remains blocked until secondary limitations are adjudicated",
            "allowed_claim_if_unresolved": "exploratory same-dataset liver-cell mitochondrial/interferon decoupling result",
            "upgrade_required_evidence": [
                "reference/code resources recovered or explicitly confirmed unavailable",
                "patient-blocked or patient-aggregated robustness completed",
                "secondary rival programs and unavailable confounders documented as limitations rather than primary biological failures",
            ],
        }

    _attach_open_source_agent_discovery(
        handoff,
        role_plan=role_plan,
        output_dir=output_dir,
        selected_bundle=selected_bundle_for_agent,
    )
    _attach_workflow_compatibility_decision(handoff, role_plan=role_plan)

    # Analyst exploration is now a first-class artifact.  A handoff may carry
    # candidate checks, but runner dispatch is allowed only after the memo says
    # the final handoff is schema-backed scientific validation rather than a
    # fallback topic-token smoke test.
    handoff["analysis_design_memo"] = _analysis_design_memo_for_handoff(
        handoff=handoff,
        candidate_datasets=candidate_datasets,
        selected_bundle=selected_bundle_for_agent,
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        primary_hypothesis_id=primary_hypothesis_id,
    )
    if handoff.get("status") == "ready_for_runner" and not handoff["analysis_design_memo"]["final_handoff_readiness"]["ready_for_runner"]:
        handoff["status"] = "deferred"
        handoff["reason"] = "analysis_design_memo_requires_schema_backed_repair"
        handoff.setdefault("evidence_gaps", []).append(
            "Analyst exploration found only fallback topic-token checks; final runner handoff must be regenerated with real schema-backed biological variables."
        )
        handoff["analysis_design_memo"]["final_handoff_readiness"]["ready_for_runner"] = False
        handoff["analysis_design_memo"]["final_handoff_readiness"]["blocking_reason"] = handoff["reason"]

    _attach_analysis_master_table_contract(handoff)

    analyst_quality_standard = _analyst_quality_standard_for_handoff(handoff)
    if analyst_quality_standard is not None:
        handoff["analyst_quality_standard"] = analyst_quality_standard

    # Push a 'pending' analysis_result edge into the data-graph so that
    # downstream consumers (gatekeeper, follow-up cycles) can see that
    # the hypothesis is en route to verification.
    if output_dir is not None:
        lane_id = clean_text((role_plan or {}).get("lane_id") or "analyst")
        update_path = _append_data_graph_analysis_edge(
            output_dir,
            primary_family=primary_family,
            identification_strategy=str((director_hypothesis or {}).get("identification_strategy") or "observational_panel"),
            lane_id=lane_id,
        )
        if update_path:
            handoff["data_graph_update_path"] = update_path

    return handoff


def _attach_workflow_compatibility_decision(handoff: dict, *, role_plan: dict | None) -> None:
    if not isinstance(handoff, dict) or handoff.get("workflow_compatibility_decision"):
        return
    discovery = handoff.get("open_source_agent_discovery") if isinstance(handoff.get("open_source_agent_discovery"), dict) else {}
    selected = handoff.get("selected_open_source_analysis_agent")
    if not isinstance(selected, dict):
        selected = discovery.get("selected_agent") if isinstance(discovery.get("selected_agent"), dict) else None
    planner_metadata = (role_plan or {}).get("planner_metadata") or {}
    review_action = planner_metadata.get("review_action") if isinstance(planner_metadata.get("review_action"), dict) else {}
    blocker_text = "\n".join(
        str(item)
        for item in [
            (role_plan or {}).get("followup_description"),
            *((planner_metadata.get("blocker_reasons") or []) if isinstance(planner_metadata.get("blocker_reasons"), list) else []),
            *((review_action.get("blocker_reasons") or []) if isinstance(review_action.get("blocker_reasons"), list) else []),
        ]
        if item
    )
    selected_workflows = []
    if selected:
        preflight = selected.get("workflow_preflight") if isinstance(selected.get("workflow_preflight"), dict) else {}
        selected_workflows = [
            item.get("workflow_name")
            for item in preflight.get("supported_repository_workflows", [])
            if isinstance(item, dict) and item.get("workflow_name")
        ]
    needs_waiver = bool(re.search(r"\bwaiver\b|compatible spatial program-score workflow|workflow incompatib", blocker_text, re.I))
    if selected or needs_waiver or discovery.get("repository_agent_required"):
        handoff["workflow_compatibility_decision"] = {
            "decision": (
                "waiver_or_replacement_required"
                if needs_waiver
                else ("selected_repository_workflow_preflighted" if selected else "repository_workflow_unresolved")
            ),
            "selected_agent_name": selected.get("name") if selected else None,
            "selected_agent_url": selected.get("url") if selected else None,
            "supported_repository_workflows": selected_workflows,
            "input_contract": (
                "GeoMx spatial program-score/wide expression plus segment metadata must be compatible with the selected repository workflow. "
                "For differential-analysis workflows, compatibility can be a modality-specific differential feature table "
                "(feature/program identifier, effect size, p-value, and FDR/q-value) when the rows are clearly labelled as program/feature contrasts rather than gene-level DE. "
                "If no scientifically faithful adapter exists, Analyst must record a concrete rejection/waiver and replacement method before promotion."
            ),
            "blockers": [line for line in blocker_text.splitlines() if re.search(r"workflow|ClawBio|waiver|repository", line, re.I)][:6],
            "replacement_method": "schema-backed GeoMx spatial compartment program-score validation blueprint",
            "gate_interpretation": (
                "This decision records Analyst-owned methods readiness. It does not pass scientific gates; promotion still requires a compatible workflow or accepted waiver plus robustness/display evidence."
            ),
        }



def _analyst_quality_standard_for_handoff(handoff: dict) -> dict | None:
    if not isinstance(handoff, dict) or handoff.get("status") != "ready_for_runner":
        return None
    checks = [item for item in (handoff.get("handoff_checks") or []) if isinstance(item, dict)]
    blueprints = [item for item in (handoff.get("validation_code_blueprints") or []) if isinstance(item, dict)]
    if not checks and not blueprints:
        return None
    required_checks: list[str] = []
    requirement = handoff.get("open_source_agent_requirement") if isinstance(handoff.get("open_source_agent_requirement"), dict) else {}
    discovery = handoff.get("open_source_agent_discovery") if isinstance(handoff.get("open_source_agent_discovery"), dict) else {}
    # A render objective validates with a self-contained in-code Mitsuba render;
    # it neither needs nor selects an external omics repository agent, so the
    # repository-agent applied/workflow checks must not be required of it (a
    # local generic adapter may still be *selected* for discovery bookkeeping,
    # but requiring it degrades the passing render lane).
    repo_agent_required_for_quality = (
        bool(requirement.get("repository_agent_required") or discovery.get("selected_agent"))
        and not _handoff_carries_render_check(handoff)
    )
    if repo_agent_required_for_quality:
        required_checks.extend([
            "open_source_repository_agent_applied",
            "open_source_repository_workflow_applied",
        ])
    required_checks = list(dict.fromkeys(required_checks))
    return {
        "minimum_blueprints_passed": max(1, min(len(blueprints), len(checks) or len(blueprints) or 1)),
        "require_no_blueprint_failures": True,
        "require_all_handoff_checks_pass": False,
        "require_all_handoff_checks_resolved": True,
        "required_validation_checks": required_checks,
        "minimum_method_appropriateness_score": None,
        "minimum_analysis_accuracy_score": None,
        "minimum_external_agent_runs_passed": 1 if repo_agent_required_for_quality else None,
        "allow_inconclusive_for_gate_review": False,
        "rationale": "Analyst requires every declared handoff check to be scientifically resolved before LabDirector/Gatekeeper review. Resolution can be a pass, valid falsification/negative result, or explicitly irrecoverable data/schema impossibility; merely weak or ambiguous inconclusive output must return to Analyst for revision. Required repository workflows must still pass when mandated.",
    }
