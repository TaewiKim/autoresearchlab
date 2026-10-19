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

from .templates.geo_binary_outcome import _geo_binary_outcome_blueprint_code
from .templates.published_8_gene_audit import _published_8_gene_audit_blueprint_code
from .templates.geomx_spatial import _geomx_spatial_blueprint_code
from .templates.generic_validation import _generic_validation_blueprint_code
from .dataset_inspect import _best_csv_for_bundle, _csv_schema_role, _find_spatial_expression_segment_pair, _looks_like_geo_sample_metadata, _looks_like_wide_expression_csv
from .handoff_checks import _build_requirement_handoff_checks_and_blueprints


def _role_plan_text_values(value: object, *, depth: int = 0) -> list[str]:
    if depth > 4:
        return []
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, list):
        out: list[str] = []
        for item in value[:24]:
            out.extend(_role_plan_text_values(item, depth=depth + 1))
        return out
    if isinstance(value, dict):
        out: list[str] = []
        for key in (
            "description",
            "summary",
            "rationale",
            "validation_changes",
            "next_actions",
            "required_validation_before_promotion",
            "lab_director_next_action",
            "analysis_request",
            "review_action",
        ):
            if key in value:
                out.extend(_role_plan_text_values(value.get(key), depth=depth + 1))
        return out
    return []


def _primary_focus_policy_from_role_plan(role_plan: dict | None) -> dict:
    """Parse LabDirector validation-scoping instructions into handoff policy.

    This is intentionally policy-driven rather than dataset-id driven.  When a
    LabDirector says the primary estimand is "only" a subset and asks other
    dimensions to move to secondary rivals/limitations, the deterministic
    Analyst handoff must not keep those secondary dimensions in the primary
    pass/fail gate.
    """
    metadata = (role_plan or {}).get("planner_metadata") or {}
    text = " ".join(_role_plan_text_values(metadata)).lower()
    if not text:
        text = " ".join(_role_plan_text_values(role_plan or {})).lower()
    narrowed_interferon_decoupling = bool(
        re.search(r"\binterferon\b", text)
        and re.search(r"\bmitochondrial|oxidative\b", text)
        and re.search(r"\bdecoupl|liver[- ]?cell|liver cells\b", text)
    )
    primary_only = bool(
        re.search(r"\b(primary|estimand|gate|success criterion|pass/fail)\b", text)
        and re.search(r"\b(only|sole|single)\b", text)
    )
    move_secondary = bool(re.search(r"\b(move|demote|secondary|rival|limitation)\b", text))
    primary_programs: list[str] = []
    if re.search(r"\bmitochondrial|oxidative\b", text):
        primary_programs.append("mitochondrial_oxidative")
    if "interferon" in text:
        primary_programs.append("interferon")
    secondary_programs: list[str] = []
    program_terms = {
        "cd8_cytotoxic": ["cd8", "cytotoxic"],
        "cd4_helper": ["cd4"],
        "b_plasma": ["b-plasma", "b plasma", "plasma"],
        "generic_inflammation": ["generic inflammation", "inflammation"],
    }
    for program, terms in program_terms.items():
        if any(term in text for term in terms):
            secondary_programs.append(program)
    secondary_limitations: list[str] = []
    limitation_terms = {
        "reference_code_or_metric_availability": ["reference", "code", "metric", "same-paper"],
        "age_field_unavailable": ["age"],
        "sex_field_unavailable": ["sex"],
        "repeated_subject_field_unavailable": ["repeated-subject", "repeated subject"],
        "leukocyte_composition_field_unavailable": ["leukocyte"],
        "external_de_workflow_contract": ["clawbio", "de-contract", "de contract"],
    }
    for label, terms in limitation_terms.items():
        if any(term in text for term in terms):
            secondary_limitations.append(label)
    if narrowed_interferon_decoupling and "cd8_cytotoxic" not in secondary_programs:
        secondary_programs.append("cd8_cytotoxic")
    active = (primary_only or narrowed_interferon_decoupling) and bool(primary_programs)
    return {
        "active": active,
        "source_text_excerpt": text[:500],
        "primary_programs": list(dict.fromkeys(primary_programs)),
        "secondary_programs": list(dict.fromkeys(secondary_programs)),
        "secondary_limitations": list(dict.fromkeys(secondary_limitations)),
    }


def _published_8_gene_panel() -> list[dict]:
    return [
        {"symbol": "ARRDC4", "ensembl_ids": ["ENSG00000140450"]},
        {"symbol": "PRRC2A", "ensembl_ids": ["ENSG00000204469", "ENSG00000226618", "ENSG00000225748", "ENSG00000225164", "ENSG00000231825", "ENSG00000206427", "ENSG00000231370"]},
        {"symbol": "RORC", "ensembl_ids": ["ENSG00000143365"]},
        {"symbol": "TMEM187", "ensembl_ids": ["ENSG00000177854"]},
        {"symbol": "RABEPK", "ensembl_ids": ["ENSG00000136933"]},
        {"symbol": "ZC3H3", "ensembl_ids": ["ENSG00000014164", "ENSG00000282684"]},
        {"symbol": "MC1R", "ensembl_ids": ["ENSG00000258839"]},
        {"symbol": "TNNI2", "ensembl_ids": ["ENSG00000130598", "ENSG00000288219"]},
    ]


def _looks_like_published_8_gene_audit(primary_family: str, director_hypothesis: dict | None, role_plan: dict | None) -> bool:
    text = " ".join([
        str(primary_family or ""),
        str((director_hypothesis or {}).get("statement") or ""),
        str((director_hypothesis or {}).get("reference_methods_baseline") or ""),
        str((role_plan or {}).get("followup_description") or ""),
        json.dumps((director_hypothesis or {}).get("lab_director_decision") or {}, ensure_ascii=False),
    ]).lower()
    return (
        "reproducibility_audit" in text
        or ("8-gene" in text and ("p-mci" in text or "s-mci" in text))
        or ("leakage audit" in text and "gse282742" in text)
    )





def _build_published_8_gene_audit_handoff_check_and_blueprint(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    role_plan: dict | None,
    bundle: dict,
) -> tuple[list[dict], list[dict], dict] | None:
    if not _looks_like_published_8_gene_audit(primary_family, director_hypothesis, role_plan):
        return None
    csvs = [csv for csv in (bundle.get("csvs") or []) if isinstance(csv, dict)]
    expression_csvs = [csv for csv in csvs if str(csv.get("csv_path") or "").lower().endswith(".csv") and _looks_like_wide_expression_csv(csv)]
    metadata_csvs = [csv for csv in csvs if _looks_like_geo_sample_metadata(csv)]
    if not expression_csvs or not metadata_csvs:
        return None
    expression_csvs = sorted(expression_csvs, key=lambda item: ("tpm" not in str(item.get("name") or "").lower(), str(item.get("name") or "")))
    expr = expression_csvs[0]
    meta = metadata_csvs[0]
    check_prefix = re.sub(r"[^a-z0-9_]+", "_", primary_hypothesis_id.lower()).strip("_") or "hypothesis"
    check_id = f"{check_prefix}_published_8gene_leakage_audit_01"
    gene_panel = _published_8_gene_panel()
    check = {
        "check_id": check_id,
        "goal": "Execute the exact published 8-gene P-MCI versus S-MCI reproducibility and leakage audit under earliest-subject deduplication, with age-only, sex-only, age-plus-sex, panel-only, and panel-plus-age-sex LOOCV comparators against the published AUC 0.93 reference.",
        "dataset": expr.get("name") or "geo_expression_matrix",
        "dataset_path": expr.get("csv_path"),
        "expression_matrix_path": expr.get("csv_path"),
        "sample_metadata_path": meta.get("csv_path"),
        "outcome": "P-MCI_vs_S-MCI",
        "positive_label": "P-MCI",
        "negative_label": "S-MCI",
        "gene_panel": gene_panel,
        "published_auc_reference": 0.93,
        "exposures": [item["symbol"] for item in gene_panel],
        "adjustment_set": ["age", "sex"],
        "fixed_effects": ["subject_id_grouping_for_deduplication"],
        "sample_filters": ["P-MCI and S-MCI samples only", "earliest sample per subject for primary analysis"],
        "hypothesis_text": (director_hypothesis or {}).get("statement") or "",
        "model_family": "published-8gene-subject-grouped-reproducibility-audit",
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": "The exact 8-gene panel must be mapped and benchmarked under subject-deduplicated LOOCV; the audit supports the reframed claim if AUC drops materially below 0.93 and does not materially beat age/sex-only baseline.",
        },
        "failure_criteria": [
            "Any published panel gene cannot be mapped to expression rows.",
            "P-MCI/S-MCI outcome or subject grouping cannot be inferred from metadata.",
            "The 8-gene panel remains near the published AUC 0.93 under leakage-controlled validation.",
            "The panel materially outperforms age/sex baseline, contradicting the audit claim.",
        ],
    }
    blueprint = {
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": check["dataset_path"],
        "expression_matrix_path": check["expression_matrix_path"],
        "sample_metadata_path": check["sample_metadata_path"],
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "gene_panel": gene_panel,
        "code": _published_8_gene_audit_blueprint_code(),
        "dependencies": ["pandas", "numpy", "matplotlib"],
        "execution_notes": [
            "Uses the declared 8-gene panel and Ensembl mappings from the handoff spec; no other disease genes are selected.",
            "Writes published-8gene-benchmark-summary.csv, strobe-participant-flow.csv, panel mapping, sample scores, and model AUC/coefficient figures.",
            "Returns pass when the audit, not predictor-superiority, is supported: subject-deduplicated 8-gene performance drops materially from published AUC 0.93 and does not materially exceed age/sex baseline.",
        ],
        "review_focus": ["exact 8-gene mapping", "subject-grouped leakage control", "age/sex comparators", "STROBE participant flow", "published AUC 0.93 audit"],
        "review_status": "ready_for_runner",
    }
    mapping = {
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
        "handoff_generation_mode": "published_8gene_reproducibility_audit",
        "expression_matrix_path": expr.get("csv_path"),
        "sample_metadata_path": meta.get("csv_path"),
        "outcome": "P-MCI versus S-MCI",
        "exposure": "published 8-gene panel",
        "gene_panel": gene_panel,
        "adjustment_set": ["age", "sex"],
        "join_key": "inferred sample identifier overlap",
        "subject_key": "inferred subject identifier when present",
    }
    return [check], [blueprint], mapping


def _build_geo_binary_outcome_handoff_check_and_blueprint(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    bundle: dict,
) -> tuple[list[dict], list[dict], dict] | None:
    csvs = [csv for csv in (bundle.get("csvs") or []) if isinstance(csv, dict)]
    expression_csvs = [csv for csv in csvs if str(csv.get("csv_path") or "").lower().endswith(".csv") and _looks_like_wide_expression_csv(csv)]
    metadata_csvs = [csv for csv in csvs if _looks_like_geo_sample_metadata(csv)]
    if not expression_csvs or not metadata_csvs:
        return None
    expression_csvs = sorted(expression_csvs, key=lambda item: ("tpm" not in str(item.get("name") or "").lower(), str(item.get("name") or "")))
    expr = expression_csvs[0]
    meta = metadata_csvs[0]
    check_prefix = re.sub(r"[^a-z0-9_]+", "_", primary_hypothesis_id.lower()).strip("_") or "hypothesis"
    check_id = f"{check_prefix}_sample_level_binary_outcome_adjusted_01"
    check = {
        "check_id": check_id,
        "goal": "Run schema-aware sample-level binary-outcome validation: transpose a wide expression matrix, infer a sample-metadata join key and binary outcome, deduplicate repeated subjects when such a field exists, fit a covariate-adjusted logistic model with expression PCs, and compare against a covariate-only baseline with cross-validation and permutation sensitivity.",
        "dataset": expr.get("name") or "geo_expression_matrix",
        "dataset_path": expr.get("csv_path"),
        "expression_matrix_path": expr.get("csv_path"),
        "sample_metadata_path": meta.get("csv_path"),
        "outcome": "binary_outcome_inferred_from_sample_metadata",
        "exposures": ["expression_pcs_from_transposed_matrix"],
        "adjustment_set": ["available_numeric_or_binary_metadata_covariates"],
        "fixed_effects": [],
        "sample_filters": ["binary outcome groups inferred from metadata", "one row per subject when subject identifier exists"],
        "hypothesis_text": (director_hypothesis or {}).get("statement") or "",
        "model_family": "sample-level-logistic-ridge-pca-covariate-adjusted",
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": "Expression+covariate model must execute on joined sample metadata, compute LOOCV AUC, and outperform covariate-only baseline; otherwise evidence remains exploratory/inconclusive.",
        },
        "failure_criteria": [
            "Expression matrix cannot be joined to sample metadata by an inferred sample identifier.",
            "A binary outcome cannot be inferred from metadata without dataset-specific assumptions.",
            "Covariate-adjusted model or cross-validation cannot be estimated.",
            "Expression model does not improve over covariate-only baseline.",
        ],
    }
    blueprint = {
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": check["dataset_path"],
        "expression_matrix_path": check["expression_matrix_path"],
        "sample_metadata_path": check["sample_metadata_path"],
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "code": _geo_binary_outcome_blueprint_code(),
        "dependencies": ["pandas", "numpy", "matplotlib"],
        "execution_notes": [
            "Schema-aware GEO-style validation: infers sample identifiers, binary outcome, subject key, and available covariates from metadata rather than using dataset-specific labels.",
            "Builds sample-level rows, deduplicates when repeated-subject metadata exists, compares expression PCs to a covariate-only baseline, and reports explicit checks_total/checks_passed via stdout JSON.",
            "If expression PCs do not beat the baseline, the blueprint intentionally returns inconclusive rather than promoting a weak association.",
        ],
        "review_focus": ["sample-level join", "covariate adjustment", "subject deduplication", "baseline comparison", "permutation sensitivity"],
        "review_status": "ready_for_runner",
    }
    mapping = {
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
        "handoff_generation_mode": "geo_sample_level_binary_outcome_validation",
        "expression_matrix_path": expr.get("csv_path"),
        "sample_metadata_path": meta.get("csv_path"),
        "outcome": "binary outcome inferred from sample metadata",
        "exposure": "expression PCs from transposed matrix",
        "adjustment_set": ["available metadata covariates"],
        "join_key": "inferred sample identifier overlap",
        "subject_key": "inferred subject identifier when present",
    }
    return [check], [blueprint], mapping





def _build_geomx_spatial_handoff_check_and_blueprint(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    role_plan: dict | None = None,
    bundle: dict,
) -> tuple[list[dict], list[dict], dict] | None:
    pair = _find_spatial_expression_segment_pair(bundle)
    if pair is None:
        return None
    target, segment = pair
    text = " ".join([
        str(primary_family or ""),
        str((director_hypothesis or {}).get("statement") or ""),
        str((director_hypothesis or {}).get("reference_methods_baseline") or ""),
    ]).lower()
    if not any(token in text for token in ["geomx", "spatial", "compartment", "liver", "roi"]):
        return None
    focus_policy = _primary_focus_policy_from_role_plan(role_plan)
    if not focus_policy.get("active") and re.search(r"\binterferon\b", text) and re.search(r"\bmitochondrial|oxidative\b", text) and re.search(r"\bdecoupl|liver[- ]?cell|liver cells\b", text):
        focus_policy = {
            "active": True,
            "source_text_excerpt": text[:500],
            "primary_programs": ["mitochondrial_oxidative", "interferon"],
            "secondary_programs": ["cd8_cytotoxic"],
            "secondary_limitations": [],
        }
    primary_programs = focus_policy.get("primary_programs") if focus_policy.get("active") else []
    if not primary_programs:
        primary_programs = ["mitochondrial_oxidative", "interferon", "cd8_cytotoxic"]
    secondary_programs = focus_policy.get("secondary_programs") if focus_policy.get("active") else []
    secondary_limitations = focus_policy.get("secondary_limitations") if focus_policy.get("active") else []
    primary_directional_requirements = []
    for program in primary_programs:
        if program == "interferon":
            primary_directional_requirements.append({"program": program, "compartment": "liver_cells", "direction": "negative"})
        else:
            primary_directional_requirements.append({"program": program, "compartment": "liver_cells", "direction": "positive"})
    if not focus_policy.get("active") and "cd8_cytotoxic" in primary_programs:
        primary_directional_requirements = [
            {"program": "mitochondrial_oxidative", "compartment": "liver_cells", "direction": "positive"},
            {"program": "interferon", "compartment": "liver_cells", "direction": "negative"},
            {"program": "cd8_cytotoxic", "compartment": "full_roi_or_other", "direction": "positive"},
        ]
    exposure_labels = [f"{program}_program" for program in primary_programs]
    if not exposure_labels:
        exposure_labels = [
            "mitochondrial_oxidative_program",
            "interferon_program",
            "cd8_cytotoxic_program",
        ]
    if focus_policy.get("active"):
        expected_sign = "VILI higher mitochondrial/oxidative and lower interferon in liver-cell segments."
        minimum_effect = "Primary program effects and permutation checks must be computed after expression-matrix-to-segment-metadata join; secondary rivals/limitations are reported but do not control primary pass/fail."
        failure_criteria = [
            "expression matrix cannot be joined to segment metadata by SegmentDisplayName.",
            "Cohort labels do not include both VILI and AIH.",
            "Primary liver-cell mitochondrial/oxidative and interferon program effects cannot be computed.",
            "The primary liver-cell mitochondrial/oxidative-high plus interferon-low directional pattern is not observed or remains statistically inconclusive.",
            "Patient-aggregated liver-cell effects fail the primary mitochondrial/oxidative-high plus interferon-low directional pattern.",
        ]
    else:
        expected_sign = "VILI higher mitochondrial/oxidative in liver-cell segments, lower interferon in liver-cell segments, and higher CD8 cytotoxic context outside liver-cell segments."
        minimum_effect = "Program effects and permutation checks must be computed after an expression-matrix-to-segment-metadata join."
        failure_criteria = [
            "expression matrix cannot be joined to segment metadata by SegmentDisplayName.",
            "Cohort labels do not include both VILI and AIH.",
            "Program effects cannot be computed in liver-cell and Full ROI/other compartments.",
            "Directional hypothesis pattern is not observed or remains statistically inconclusive.",
        ]
    check_prefix = re.sub(r"[^a-z0-9_]+", "_", primary_hypothesis_id.lower()).strip("_") or "hypothesis"
    check_id = f"{check_prefix}_geomx_spatial_compartment_program_01"
    check = {
        "check_id": check_id,
        "goal": "Join the spatial wide expression matrix to segment metadata and test VILI-versus-AIH program differences by spatial compartment without using feature-annotation tables or generic binary fallback.",
        "dataset": target.get("name") or "spatial_expression_matrix",
        "dataset_path": target.get("csv_path"),
        "dataset_schema_role": _csv_schema_role(target),
        "expression_matrix_path": target.get("csv_path"),
        "segment_metadata_path": segment.get("csv_path"),
        "segment_metadata_schema_role": _csv_schema_role(segment),
        "sample_metadata_path": segment.get("csv_path"),
        "outcome": "Cohort",
        "exposures": exposure_labels,
        "primary_directional_requirements": primary_directional_requirements,
        "secondary_rival_programs": secondary_programs,
        "secondary_limitations": secondary_limitations,
        "patient_aware_validation": {
            "required": True,
            "aggregation_unit": "Patient_Code",
            "sensitivity_groups": ["Patient_Code", "SlideName", "TMA"],
            "rival_programs": secondary_programs,
        },
        "validation_scope_policy": focus_policy if focus_policy.get("active") else None,
        "adjustment_set": ["Patient_Code", "Region", "TMA", "sequencing_qc_fields"],
        "fixed_effects": ["patient_or_slide_blocking_when_estimable"],
        "sample_filters": ["VILI and AIH Cohort rows", "SegmentDisplayName present in expression-matrix sample columns"],
        "hypothesis_text": (director_hypothesis or {}).get("statement") or "",
        "model_family": "geomx-spatial-compartment-program-difference",
        "success_criteria": {
            "expected_sign": expected_sign,
            "minimum_effect_description": minimum_effect,
        },
        "failure_criteria": failure_criteria,
    }
    blueprint = {
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": check["dataset_path"],
        "expression_matrix_path": check["expression_matrix_path"],
        "segment_metadata_path": check["segment_metadata_path"],
        "sample_metadata_path": check["sample_metadata_path"],
        "dataset_schema_role": check["dataset_schema_role"],
        "segment_metadata_schema_role": check["segment_metadata_schema_role"],
        "outcome": check["outcome"],
        "exposures": check["exposures"],
        "primary_directional_requirements": primary_directional_requirements,
        "secondary_rival_programs": secondary_programs,
        "secondary_limitations": secondary_limitations,
        "patient_aware_validation": check["patient_aware_validation"],
        "code": _geomx_spatial_blueprint_code(),
        "dependencies": ["pandas", "numpy", "matplotlib"],
        "execution_notes": [
            "Use the CSV classified as wide_expression_matrix for expression values and the CSV classified as segment_metadata for cohort/covariates; do not use feature_annotation tables as expression input.",
            "Join columns to SegmentDisplayName and evaluate Cohort, Patient_Code, Region, Liver cells/Full ROI, TMA/SlideName, and QC fields.",
            "Aggregate liver-cell program scores by Patient_Code and run leave-one Patient_Code/SlideName/TMA sensitivity; treat secondary immune programs as rival/context checks, not primary pass/fail.",
            "Report inconclusive rather than promoting if the directional compartment-decoupling pattern is not observed.",
        ],
        "review_focus": ["expression-to-segment join", "spatial compartment", "program effects", "patient/slide blocking readiness", "permutation sensitivity"],
        "review_status": "ready_for_runner",
    }
    mapping = {
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
        "handoff_generation_mode": "geomx_spatial_compartment_validation",
        "expression_matrix_path": target.get("csv_path"),
        "segment_metadata_path": segment.get("csv_path"),
        "sample_metadata_path": segment.get("csv_path"),
        "outcome": "Cohort from segment metadata",
        "exposure": "program scores from wide expression matrix",
        "primary_directional_requirements": primary_directional_requirements,
        "secondary_rival_programs": secondary_programs,
        "secondary_limitations": secondary_limitations,
        "patient_aware_validation": check["patient_aware_validation"],
        "validation_scope_policy": focus_policy if focus_policy.get("active") else None,
        "adjustment_set": ["Patient_Code", "Region", "TMA", "sequencing QC fields"],
        "join_key": "SegmentDisplayName equals expression-matrix sample column",
        "forbidden_input_roles": ["feature_annotation", "generic binary outcome fallback"],
        "selected_input_roles": {
            "expression_matrix_path": _csv_schema_role(target),
            "segment_metadata_path": _csv_schema_role(segment),
        },
    }
    return [check], [blueprint], mapping





def _build_generic_handoff_check_and_blueprint(
    *,
    primary_hypothesis_id: str,
    primary_family: str,
    director_hypothesis: dict | None,
    role_plan: dict | None,
    memo: dict | None,
    bundle: dict,
    keywords: set[str],
) -> tuple[list[dict], list[dict], dict]:
    # Each builder below decides for itself, from the DATA: it returns None
    # unless the bundle holds the shape it needs. That is the whole gate now.
    # There used to be a second one keyed on the objective's words, which
    # skipped these builders for a "CS/rendering objective" -- so a bundle that
    # genuinely held an expression matrix was refused for how the objective was
    # worded, and every field nobody had enumerated fell on the wrong side.
    published_8_gene_audit = _build_published_8_gene_audit_handoff_check_and_blueprint(
        primary_hypothesis_id=primary_hypothesis_id,
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        role_plan=role_plan,
        bundle=bundle,
    )
    if published_8_gene_audit is not None:
        return published_8_gene_audit

    geomx_spatial = _build_geomx_spatial_handoff_check_and_blueprint(
        primary_hypothesis_id=primary_hypothesis_id,
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        role_plan=role_plan,
        bundle=bundle,
    )
    if geomx_spatial is not None:
        return geomx_spatial

    geo_binary_outcome = _build_geo_binary_outcome_handoff_check_and_blueprint(
        primary_hypothesis_id=primary_hypothesis_id,
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        bundle=bundle,
    )
    if geo_binary_outcome is not None:
        return geo_binary_outcome

    requirement_driven = _build_requirement_handoff_checks_and_blueprints(
        primary_hypothesis_id=primary_hypothesis_id,
        primary_family=primary_family,
        director_hypothesis=director_hypothesis,
        role_plan=role_plan,
        memo=memo,
        bundle=bundle,
        keywords=keywords,
    )
    if requirement_driven is not None:
        return requirement_driven

    csv = _best_csv_for_bundle(bundle, keywords)
    columns = [str(c) for c in (csv.get("columns") or [])] if isinstance(csv, dict) else []
    matched = [c for c in columns if any(kw in c.lower() for kw in keywords)]
    exposure = matched[0] if matched else (columns[0] if columns else "auto_numeric_exposure")
    outcome = matched[1] if len(matched) > 1 else (columns[1] if len(columns) > 1 else "auto_numeric_outcome")
    check_id = f"{re.sub(r'[^a-z0-9_]+', '_', primary_hypothesis_id.lower()).strip('_') or 'hypothesis'}_generic_01"
    dataset_path = csv.get("csv_path") if isinstance(csv, dict) else None
    check = {
        "check_id": check_id,
        "goal": "Execute a first-pass, domain-neutral data-usability and association check for the lab-director hypothesis using the selected cycle-scoped bundle.",
        "dataset": csv.get("name") if isinstance(csv, dict) else "auto_discovered_csv",
        "dataset_path": dataset_path,
        "outcome": outcome,
        "exposures": [exposure],
        "adjustment_set": [],
        "fixed_effects": [],
        "sample_filters": [],
        "model_family": "generic-pearson-association",
        "success_criteria": {
            "expected_sign": "n/a",
            "minimum_effect_description": "Blueprint executes and emits an interpretable numeric association or an explicit inconclusive data-coverage verdict.",
        },
        "failure_criteria": [
            "No CSV files can be loaded from the selected bundle.",
            "The selected CSV has fewer than two numeric columns.",
            "The result conflicts with the lab-director hypothesis or remains too weak for causal interpretation.",
        ],
    }
    blueprint = {
        "blueprint_id": f"blueprint:{check_id}",
        "check_id": check_id,
        "language": "python",
        "entrypoint": "main",
        "dataset": check["dataset"],
        "dataset_path": dataset_path,
        "outcome": outcome,
        "exposures": [exposure],
        "code": _generic_validation_blueprint_code(),
        "dependencies": ["pandas", "matplotlib"],
        "execution_notes": [
            "Uses RESEARCHLAB_CHECK_SPEC and RESEARCHLAB_CSV_ROOT; does not hardcode domain columns.",
            "Falls back to the first two numeric columns when exact hypothesis-variable matches are unavailable.",
            "Treat the result as exploratory unless a later analyst emits a causal-design-specific blueprint.",
        ],
        "review_focus": ["data availability", "column mapping", "first-pass association"],
        "review_status": "ready_for_runner",
    }
    mapping = {
        "exposure": exposure,
        "outcome": outcome,
        "dataset_path": dataset_path,
        "primary_family": primary_family,
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
    }
    return [check], [blueprint], mapping


