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

from .queries import role_plan_primary_families


def ranked_terms_from_papers(papers: list[dict], limit: int = 12) -> list[str]:
    counts: dict[str, int] = {}
    blocked = {
        "study", "analysis", "dataset", "datasets", "estimate", "estimates", "data",
        "result", "results", "method", "methods", "evidence", "research",
    }
    for paper in papers[:24]:
        text = f"{paper.get('title', '')} {paper.get('abstract', '')}".lower()
        for token in re.split(r"[^a-z0-9]+", text):
            token = token.strip()
            if len(token) < 5 or token in blocked:
                continue
            counts[token] = counts.get(token, 0) + 1
    return [token for token, _count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def generate_hypothesis_scenarios(papers: list[dict], role_plan: dict | None = None) -> list[dict]:
    """Emit DOMAIN-GENERAL structural hypothesis scenarios.

    These are universal robustness / rival angles that apply to any empirical
    hypothesis in any field — subgroup/condition dependence, threshold/non-
    linearity, measurement/metric artifact, rival mechanism/baseline. The
    hypothesis text is domain-neutral (the analyst fills the domain-specific
    nouns); the SEARCH TERMS are derived from the objective + retrieved papers.

    There is NO per-domain branching and NO hardcoded per-domain vocabulary
    (no epidemiology exposure/strata, no graphics PSNR/rendering, no WHO
    outcomes). Whatever field the prompt is about is the field the scout
    searches, because the vocabulary is read from the prompt, not a fixed
    table. This is the multi-domain contract.
    """
    ranked_terms = ranked_terms_from_papers(papers, 8)
    scenarios: list[dict] = []

    # Domain vocabulary for the scout's follow-up queries comes from the
    # OBJECTIVE (prompt / selected family / hypothesis) and the retrieved
    # papers -- NOT a hardcoded per-domain term list. This is what keeps the
    # agent multi-domain: an omics prompt searches omics, a graphics prompt
    # searches graphics, an economics prompt searches economics, purely because
    # the vocabulary is read from the prompt rather than a fixed table.
    rp = role_plan or {}
    pm = rp.get("planner_metadata") if isinstance(rp.get("planner_metadata"), dict) else {}
    hypo = rp.get("hypothesis")
    parts = [
        rp.get("objective"), rp.get("prompt"), rp.get("primary_family"), rp.get("family_root"),
        hypo.get("statement") if isinstance(hypo, dict) else hypo,
        pm.get("objective"), pm.get("prompt"),
    ]
    for fam in (pm.get("candidate_primary_families") or []):
        parts.append(fam if isinstance(fam, str) else (fam.get("family_root") if isinstance(fam, dict) else None))
    objective_text = " ".join(str(p) for p in parts if p).lower()
    _stop = {
        "study", "studies", "analysis", "research", "using", "based", "approach", "method",
        "methods", "data", "dataset", "result", "results", "primary", "family", "families",
        "objective", "prompt", "hypothesis", "across", "rather", "effect", "candidate",
        "selected", "director", "scenario", "variable", "variables", "leading", "algorithm",
        "algorithms", "problem", "problems", "system", "systems",
    }
    topic_terms: list[str] = []
    for tok in re.findall(r"[a-z][a-z0-9\-]{3,}", objective_text):
        if tok in _stop or tok in topic_terms:
            continue
        topic_terms.append(tok)
        if len(topic_terms) >= 4:
            break
    if not topic_terms:
        topic_terms = list((ranked_terms or [])[:4])

    def add_scenario(label: str, hypothesis: str, validation: str, method_anchors: list[str]) -> None:
        # Search terms = the objective's own domain vocabulary + neutral,
        # field-agnostic methodology anchors (subgroup / threshold / baseline /
        # ablation) -- never a hardcoded domain term.
        terms: list[str] = []
        for term in list(topic_terms) + list(method_anchors):
            term = str(term).strip()
            if term and term not in terms:
                terms.append(term)
        scenarios.append({
            "label": label,
            "hypothesis": hypothesis,
            "validation_scenario": validation,
            "search_terms": terms[:5] or list(method_anchors),
        })

    # Universal structural robustness / rival angles that apply to ANY empirical
    # hypothesis, worded domain-neutrally (the analyst fills the domain nouns).
    add_scenario(
        "subgroup-moderator",
        "The primary effect may vary across conditions or subgroups rather than holding as a single pooled effect.",
        "Validate with subgroup / leave-one-condition-out / interaction comparisons against the pooled estimate.",
        ["subgroup analysis", "interaction"],
    )
    add_scenario(
        "threshold-regime",
        "The relationship may be non-linear — governed by a threshold, saturation point, or regime change rather than a smooth average response.",
        "Validate with threshold search, low-/high-regime partition tests, and piecewise model comparisons.",
        ["threshold", "nonlinear regime"],
    )
    add_scenario(
        "measurement-artifact",
        "Part of the observed effect may be an artifact of measurement, metric, or experimental setup rather than the mechanism of interest.",
        "Validate with sensitivity checks around the measurement/metric, replicates, or setup variations.",
        ["measurement artifact", "sensitivity analysis"],
    )
    add_scenario(
        "rival-mechanism",
        "The apparent effect may be explained by an alternative mechanism, confounder, or a simpler baseline that has not yet been tested.",
        "Validate with an alternative-mechanism contest and a matched-budget comparison against the simplest credible baseline.",
        ["baseline comparison", "alternative mechanism", "ablation"],
    )

    return scenarios[:6]


def build_statistical_review_memo(papers: list[dict], role_plan: dict | None = None) -> dict:
    """Domain-neutral statistical-review memo.

    The prior revision pattern-matched WHO-specific token groups (health
    system, maternal/newborn, inequality/equity, measurement/surveillance)
    and emitted them as confounder names. That meant every cycle — even
    non-WHO ones — received "health_system_capacity", "maternal_newborn_
    care", "equity_gap", "measurement_quality" as its priority
    confounders. The estimand text was also pinned to "cross-country
    association … mortality outcome".

    Level 3 emits only generic confounder categories inferred from
    abstract vocabulary. The analyst Codex agent is expected to fill in
    domain-specific confounder names from the retrieved papers.
    """
    joined = " ".join(
        f"{paper.get('title', '')} {paper.get('abstract', '')}".lower()
        for paper in papers[:32]
    )
    candidate_families = role_plan_primary_families(role_plan)
    family_labels = [str(item.get("family", "")).strip() for item in candidate_families[:5] if str(item.get("family", "")).strip()]

    confounders: list[str] = []
    if "batch" in joined or "technical replicate" in joined:
        confounders.append("technical_batch_effect")
    if "population structure" in joined or "genetic ancestry" in joined:
        confounders.append("population_structure")
    if "age" in joined and "sex" in joined:
        confounders.append("age_and_sex")
    if "comorbid" in joined or "co-morbid" in joined:
        confounders.append("comorbidity_burden")
    if "selection" in joined or "recruitment" in joined:
        confounders.append("selection_bias")
    if "confound" in joined and not confounders:
        confounders.append("unspecified_measured_confounders")
    if not confounders:
        confounders.append("unspecified_measured_confounders")

    falsification: list[str] = []
    if "measurement" in joined or "technical" in joined or "batch" in joined:
        falsification.append("measurement_artifact_test")
    falsification.extend(["family_pairwise_contest", "negative_control_test"])

    estimands = [
        "average association between the candidate exposure family and the primary outcome in the study sample",
        "covariate-adjusted association after controlling for confounders derived from the retrieved literature",
        "within-unit change association where repeated measurements exist (subjects, donors, or cell lines)",
    ]
    if family_labels:
        estimands.append(f"pairwise family contrast between {' and '.join(family_labels[:2])}")

    data_kg_digest = (role_plan or {}).get("data_kg_digest") or {}
    challenged_incumbent_edges = data_kg_digest.get("challenged_incumbent_edges") or []
    rival_family_digest = data_kg_digest.get("rival_family_digest") or []
    unresolved_data_gaps = data_kg_digest.get("unresolved_data_gaps") or []

    modality_risks: list[str] = []
    if any(token in joined for token in ["rna", "transcript", "expression", "omics", "single-cell", "single cell"]):
        modality_risks.extend([
            "expression signal may reflect batch, platform, library size, cell-composition, purity, or sampling-region artifacts",
            "pathway/module scores must be benchmarked against shuffled-gene, housekeeping-gene, or unrelated-pathway negative controls",
        ])
    if any(token in joined for token in ["spatial", "visium", "region", "microenvironment"]):
        modality_risks.append(
            "spatial or regional effects may be confounded by tissue compartment, tumor purity, capture quality, or annotation granularity"
        )
    if not modality_risks:
        modality_risks.extend([
            "observed associations may be driven by measurement error, preprocessing choices, or unmeasured sample-selection mechanisms",
            "negative controls and permutation/null checks must be dataset-specific before promotion",
        ])

    return {
        "analyst_identity": "statistician",
        "estimands": estimands,
        "priority_confounders": list(dict.fromkeys(confounders)) or ["unspecified_measured_confounders", "measurement_quality_or_batch"],
        "negative_controls": [
            "schema-backed placebo outcome or unrelated feature module",
            "permuted sample labels or family-pair label shuffle",
            "technical/batch-only proxy that should not reproduce the biological claim",
        ],
        "falsification_tests": list(dict.fromkeys(falsification)),
        "selection_bias_risks": [
            "sample inclusion may depend on data completeness, tissue quality, cohort composition, or phenotype availability",
            "case/control or subtype labels may be imbalanced across batches, platforms, donors, or collection sites",
        ],
        "measurement_risks": modality_risks,
        "family_adjudication_rule": "prefer the family with the strongest identified contrast after confounder, falsification, and measurement checks",
        "data_kg_priorities": {
            "incumbent_family": data_kg_digest.get("incumbent_family"),
            "challenged_incumbent_edges": challenged_incumbent_edges[:6],
            "rival_family_digest": rival_family_digest[:6],
            "unresolved_data_gaps": unresolved_data_gaps[:6],
        },
    }


def build_analysis_lane_proposals(role_plan: dict | None = None) -> list[dict]:
    data_kg_digest = (role_plan or {}).get("data_kg_digest") or {}
    proposals: list[dict] = []
    incumbent_family = data_kg_digest.get("incumbent_family")
    challenged_edges = data_kg_digest.get("challenged_incumbent_edges") or []
    rival_digest = data_kg_digest.get("rival_family_digest") or []

    if challenged_edges:
        top = challenged_edges[0]
        proposals.append(
            {
                "type": "confound_or_sensitivity_check",
                "description": f"run a focused confound or sensitivity lane for incumbent family {incumbent_family or 'unknown_family'} on {top.get('target') or top.get('relation') or 'the most challenged edge'}",
                "preferred_role": "lab-runner",
                "preferred_role_alias": "validation-coder",
                "priority": "high",
                "family_root": incumbent_family,
                "target_edge_id": top.get("edge_id"),
                "validation_focus": "challenged_incumbent_edge",
                "hypothesis_focus": f"test whether the incumbent family {incumbent_family or 'unknown_family'} remains viable after a focused confound or sensitivity check",
                "figure_questions": [
                    "Which comparison most clearly shows whether the incumbent survives the confound-adjusted check?",
                    "What plot would make falsification of the incumbent easiest to see?",
                ],
                "validation_coding_task": "write one compact validation script that runs the requested confound or sensitivity check and emits a support/falsification verdict",
            }
        )

    for item in rival_digest[:2]:
        family_root = str(item.get("family_root") or "").strip()
        if not family_root or family_root == incumbent_family:
            continue
        proposals.append(
            {
                "type": "robust_analysis_lane",
                "description": f"run a pairwise robust analysis lane to compare rival family {family_root} against incumbent {incumbent_family or 'current lead'} using matched adjustments and falsification checks",
                "preferred_role": "lab-runner",
                "preferred_role_alias": "validation-coder",
                "priority": "high" if int(item.get("supported_edge_count") or 0) > 0 else "medium",
                "family_root": family_root,
                "validation_focus": "rival_family_pairwise_contest",
                "hypothesis_focus": f"test whether rival family {family_root} outperforms incumbent {incumbent_family or 'current lead'} under the same adjustment and falsification regime",
                "figure_questions": [
                    f"What figure best compares rival family {family_root} against incumbent {incumbent_family or 'current lead'}?",
                    "What robustness view would most change the family ranking?",
                ],
                "validation_coding_task": "write one compact validation script that runs a pairwise rival-family contest and emits a winner, loser, or inconclusive verdict",
            }
        )

    deduped = []
    seen = set()
    for item in proposals:
        key = (item.get("type"), item.get("family_root"), item.get("target_edge_id"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:4]


def analyst_family_to_check(family: str) -> dict | None:
    """Return None unconditionally.

    The prior revision held 3 WHO-specific check templates (DTP3 /
    zero-dose / measurement-quality over the WHO country-year panel,
    outcome=neonatal_mortality) and returned one of them when the
    analyst's external-driver path needed a fallback. Under Level 3
    the analyst runs as a codex-agent and produces its own
    handoff_checks; this function is retained as a no-op so existing
    callers do not crash, but no WHO-shaped template is ever emitted.
    """
    _ = family
    return None
