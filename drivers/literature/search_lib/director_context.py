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

from .http_client import clean_text
from .providers import cycle_id_from_output_dir, research_lab_runtime_root


def _load_lab_director_hypothesis(output_dir: Path) -> dict | None:
    """Look up the lab-director hypothesis emitted earlier in this cycle.

    The unification contract: chronicle (codex-agent) builds the literature
    and data graphs; lab-director (codex-agent) reads those graphs and
    emits ONE hypothesis to .research-lab/state/<cycle_id>-lab-director-
    hypothesis.json; the analyst (external-driver) then VERIFIES that
    hypothesis here. If the artifact is missing, fall back to the
    deterministic family-discovery path so the analyst still produces
    a usable handoff for lab-runner.
    """
    cycle_id = cycle_id_from_output_dir(output_dir)
    if not cycle_id:
        return None
    runtime_root = research_lab_runtime_root(output_dir)
    hypothesis_path = runtime_root / "state" / f"{cycle_id}-lab-director-hypothesis.json"
    if not hypothesis_path.is_file():
        return None
    try:
        hypothesis = json.loads(hypothesis_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(hypothesis, dict):
        return None

    # Lab-director recovery artifacts sometimes use the requery/replacement
    # shape (`selected_hypothesis`) rather than the original flat contract
    # (`statement`, `primary_family`, `identification_strategy`, ...).  The
    # analyst driver consumes the flat shape; without normalization it falls
    # back to `unclassified_family`, loses the selected statement/accession,
    # and then emits generic schema-audit handoffs that never produce supported
    # claim deltas.  Preserve the raw artifact but project the selected lead
    # into the fields the handoff builder expects without injecting a
    # dataset-specific family, id, or outcome.
    selected = hypothesis.get("selected_hypothesis")
    if isinstance(selected, dict):
        normalized = dict(hypothesis)
        statement = clean_text(str(selected.get("statement") or hypothesis.get("summary") or "")).strip()
        dataset = clean_text(str(selected.get("dataset_or_accession") or selected.get("accession_or_cohort") or "")).strip()
        if statement and not normalized.get("statement"):
            normalized["statement"] = statement
        if dataset and not normalized.get("dataset_or_accession"):
            normalized["dataset_or_accession"] = dataset
        selected_family = clean_text(str(selected.get("primary_family") or selected.get("family") or selected.get("family_root") or "")).strip()
        if selected_family and not normalized.get("primary_family"):
            normalized["primary_family"] = selected_family
        if not normalized.get("hypothesis_id"):
            seed = dataset or statement or "selected_hypothesis"
            normalized["hypothesis_id"] = f"hyp-director-{re.sub(r'[^a-z0-9]+', '-', seed.lower()).strip('-')[:80] or 'selected'}"
        if not normalized.get("identification_strategy"):
            selected_strategy = selected.get("identification_strategy") if isinstance(selected.get("identification_strategy"), dict) else {}
            estimands = selected.get("estimands") or selected_strategy.get("estimands") or []
            if isinstance(estimands, str):
                estimands = [estimands]
            normalized["identification_strategy"] = {
                "design": selected_strategy.get("design") or selected.get("design") or "schema_aware_validation",
                "dataset_or_accession": dataset,
                "outcome": selected_strategy.get("outcome") or selected.get("outcome") or selected.get("primary_outcome") or None,
                "estimands": estimands,
            }
        if selected.get("same_dataset_reference_papers") and not normalized.get("supporting_literature_paper_ids"):
            normalized["same_dataset_reference_papers"] = selected.get("same_dataset_reference_papers")
        return normalized
    return hypothesis


def _bundle_matches_director_dataset(bundle: dict, director_hypothesis: dict | None) -> bool:
    if not isinstance(bundle, dict) or not isinstance(director_hypothesis, dict):
        return False
    wanted = str(
        director_hypothesis.get("dataset_or_accession")
        or director_hypothesis.get("accession_or_cohort")
        or ""
    ).lower()
    if not wanted:
        return False
    haystack = " ".join(
        str(bundle.get(key) or "")
        for key in ["bundle_path", "candidate_title", "candidate_url", "candidate_doi", "provider"]
    ).lower()
    return any(token and token in haystack for token in re.split(r"[^a-z0-9]+", wanted) if len(token) >= 5)



def _compact_role_plan_for_result(role_plan: dict) -> dict:
    """Return a small, result-safe role-plan summary.

    Full role plans can include chronicle/data/reasoning contexts that are tens
    of megabytes.  Echoing them into every literature-driver result makes later
    refresh passes parse gigabytes of duplicate JSON.  Keep identifiers and
    planning fields needed by downstream synthesis; leave the authoritative full
    plan at role_plan_path.
    """
    if not isinstance(role_plan, dict):
        return {}
    keep = [
        "lane_id",
        "role",
        "action_type",
        "objective",
        "screening_objective",
        "search_agent_contract",
        "followup_description",
        "source",
        "source_brief_id",
        "candidate_primary_families",
        "candidate_outcomes",
        "focus_families",
        "focus_outcomes",
        "queries",
        "validation_profile",
        "dataset_root",
    ]
    compact = {key: role_plan.get(key) for key in keep if key in role_plan}
    planner = role_plan.get("planner_metadata")
    if isinstance(planner, dict):
        compact["planner_metadata"] = {
            key: planner.get(key)
            for key in [
                "hypothesis_generation_basis",
                "pivot_attempt",
                "manual_validation_reason",
                "original_lane_id",
                "recovery_reason",
                "runtime_class",
            ]
            if key in planner
        }
    compact["compacted"] = True
    compact["full_role_plan_available_at"] = "role_plan_path"
    return compact


def _reference_context_from_director(director_hypothesis: dict | None) -> dict:
    if not isinstance(director_hypothesis, dict):
        return {}
    selected = director_hypothesis.get("selected_hypothesis")
    sources = [director_hypothesis]
    if isinstance(selected, dict):
        sources.insert(0, selected)
    papers: list[dict] = []
    validation_changes: list[str] = []
    for source in sources:
        for key in ["same_dataset_reference_papers", "reference_papers", "baseline_papers", "supporting_literature"]:
            value = source.get(key)
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, dict):
                        papers.append(item)
                    elif str(item).strip():
                        papers.append({"title": str(item).strip()})
        for key in ["validation_changes", "required_reproductions", "baseline_reproduction_steps"]:
            value = source.get(key)
            if isinstance(value, list):
                validation_changes.extend(str(item).strip() for item in value if str(item).strip())
    seen = set()
    deduped_papers = []
    for paper in papers:
        key = str(paper.get("doi") or paper.get("title") or paper).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped_papers.append(paper)
    baseline = next(
        (
            str(source.get("reference_methods_baseline") or source.get("baseline_methods") or "").strip()
            for source in sources
            if str(source.get("reference_methods_baseline") or source.get("baseline_methods") or "").strip()
        ),
        "",
    )
    improvement = next(
        (
            str(source.get("why_better_than_reference_baseline") or source.get("baseline_delta") or "").strip()
            for source in sources
            if str(source.get("why_better_than_reference_baseline") or source.get("baseline_delta") or "").strip()
        ),
        "",
    )
    if not deduped_papers and not baseline and not validation_changes:
        return {}
    return {
        "reference_papers": deduped_papers[:8],
        "reference_methods_baseline": baseline,
        "claimed_baseline_delta": improvement,
        "required_reproduction_steps": validation_changes[:12],
    }
