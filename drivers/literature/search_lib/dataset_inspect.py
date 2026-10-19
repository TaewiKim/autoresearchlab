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


_HYPOTHESIS_STOPWORDS = frozenset({
    "this", "that", "with", "from", "into", "have", "will", "should",
    "than", "more", "less", "most", "least", "over", "under", "above",
    "below", "across", "among", "between", "after", "before", "their",
    "which", "where", "when", "while", "what", "would", "could", "must",
    "make", "made", "take", "given", "using", "based", "shows", "show",
    "such", "also", "data", "dataset", "datasets", "study", "studies",
    "analysis", "analyses", "model", "models", "result", "results",
    "value", "values", "variable", "variables", "single", "primary",
    "outcome", "outcomes", "predict", "predicts", "predicting",
    "number", "score", "effect", "effects", "size", "local", "phase",
    "decision", "string", "title", "author", "authors", "year", "quality",
    "category", "categorization", "unnamed",
})


def _hypothesis_keywords(text: str) -> set[str]:
    """Extract content-bearing keywords from a hypothesis blob.

    Lowercase, strip non-word characters, drop stopwords and tokens of
    length <= 3. Intentionally permissive — we want enough surface to
    catch column-name overlap (e.g. ``ntprobnp`` ↔ ``BNP/NT-proBNP``,
    ``readmit`` ↔ ``readmit_30d``) without manually maintaining a
    domain ontology.
    """
    if not text:
        return set()
    raw = re.split(r"[^A-Za-z0-9]+", str(text).lower())
    out: set[str] = set()
    for token in raw:
        if len(token) <= 3 or token in _HYPOTHESIS_STOPWORDS:
            continue
        out.add(token)
        # Common biomedical prefix slicing: bnp, ntprobnp, troponin,
        # creatinine, etc. don't always match column names verbatim.
        # Add a 5-char prefix as a fuzzy hook.
        if len(token) > 5:
            out.add(token[:5])
    return out

def _best_csv_for_bundle(bundle: dict, keywords: set[str]) -> dict:
    best_csv = {}
    best_score = -1
    for csv in bundle.get("csvs") or []:
        if not isinstance(csv, dict):
            continue
        cols = csv.get("columns") if isinstance(csv.get("columns"), list) else []
        score = 0
        for raw_col in cols:
            col = str(raw_col).lower()
            if any(kw in col for kw in keywords):
                score += 1
        if score > best_score:
            best_csv = csv
            best_score = score
    return best_csv





def _sample_group_columns(columns: list[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}
    for col in columns:
        match = re.search(r"(?:^|[._-])([A-Za-z]{1,8})(\d{1,3})$", col)
        if not match:
            continue
        group = match.group(1)
        groups.setdefault(group, []).append(col)
    return groups


def _looks_like_wide_measurement_csv(csv: dict) -> int:
    groups = _sample_group_columns(_csv_columns(csv))
    usable = [cols for cols in groups.values() if len(cols) >= 2]
    if len(usable) < 2:
        return 0
    return sum(len(cols) for cols in usable)


def _looks_like_effect_table(csv: dict) -> int:
    cols = [col.lower() for col in _csv_columns(csv)]
    has_effect = any(
        "log2" in col or "logfc" in col or "fold" in col or col in {"fc", "effect", "estimate", "coef"}
        for col in cols
    )
    has_uncertainty = any("qval" in col or "q.value" in col or "fdr" in col or "pval" in col or "p.value" in col for col in cols)
    return int(has_effect and has_uncertainty)


def _looks_like_term_table(csv: dict) -> int:
    cols = [col.lower() for col in _csv_columns(csv)]
    term_score = sum(
        1
        for col in cols
        if "term" in col or "name" in col or "pathway" in col or "description" in col or col == "ids"
    )
    stat_score = sum(1 for col in cols if "qval" in col or "q.value" in col or "fdr" in col or "pval" in col or "p.value" in col)
    return term_score * 2 + stat_score


def _infer_comparison_groups(wide_csv: dict | None, effect_csv: dict | None) -> list[str]:
    sources = [effect_csv, wide_csv]
    for csv in sources:
        if not isinstance(csv, dict):
            continue
        groups = _sample_group_columns(_csv_columns(csv))
        ordered = [group for group, cols in groups.items() if len(cols) >= 2]
        if len(ordered) >= 2:
            return ordered[:2]
    return []



_TOPIC_GROUP_STOPWORDS = _HYPOTHESIS_STOPWORDS | {
    "canonical",
    "generic",
    "dominance",
    "dominant",
    "signal",
    "signals",
    "program",
    "programs",
    "table",
    "tables",
    "source",
    "sources",
    "exact",
    "term",
    "terms",
    "count",
    "counts",
    "where",
    "available",
    "supporting",
    "contradicting",
    "final",
    "gate",
    "artifact",
    "workspace",
    "autoresearch",
    "researchlab",
    "dataset",
    "datasets",
    "cycle",
    "cache",
    "fresh",
    "paper",
    "complete",
    "http",
    "https",
    "www",
    "com",
}


def _topic_tokens(phrase: str) -> list[str]:
    tokens = [
        token.lower()
        for token in re.split(r"[^A-Za-z0-9]+", phrase)
        if len(token) > 2 and token.lower() not in _TOPIC_GROUP_STOPWORDS
    ]
    # Avoid broad matches from generic scaffolding words in multi-word topics.
    return [token for token in tokens if token not in {"cell", "cells"}] or tokens


def _add_topic_group(groups: list[dict], seen: set[str], label: str, phrase: str) -> None:
    tokens = _topic_tokens(phrase)
    if not tokens:
        return
    compact_label = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "_".join(tokens)
    key = "|".join(sorted(tokens))
    if key in seen:
        return
    seen.add(key)
    phrases = [clean_text(phrase).lower()]
    groups.append({
        "label": compact_label,
        "keywords": tokens,
        "phrases": [item for item in phrases if item],
    })


def _topic_groups_from_text(text: str, fallback_keywords: set[str]) -> list[dict]:
    groups: list[dict] = []
    seen: set[str] = set()
    normalized = clean_text(text).lower()

    # Preserve explicit slash/hyphen comparisons as analyst-requested topic
    # groups without knowing the scientific domain in advance.
    for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9-]*(?:/[A-Za-z][A-Za-z0-9-]*)+\b", normalized):
        raw = match.group(0)
        label = raw.replace("/", "_")
        _add_topic_group(groups, seen, label, raw.replace("/", " "))

    cue_pattern = re.compile(
        r"(?:versus|against|rather than|stronger than|checks? for|sensitivity across|term counts? for|panel checks? for)\s+([^.;:]+)",
        re.IGNORECASE,
    )
    for match in cue_pattern.finditer(normalized):
        fragment = match.group(1)
        for part in re.split(r",|\band\b|\bor\b|/|;", fragment):
            phrase = clean_text(part)
            if not phrase:
                continue
            words = _topic_tokens(phrase)
            if not words or len(words) > 5:
                continue
            _add_topic_group(groups, seen, phrase, phrase)

    # Hyphenated phrases such as "cell-cycle" should remain phrase-level
    # rival groups rather than decomposing into unrelated single words.
    for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9]+-[A-Za-z][A-Za-z0-9-]+\b", normalized):
        raw = match.group(0)
        _add_topic_group(groups, seen, raw, raw.replace("-", " "))

    if len(groups) < 2:
        for token in sorted(fallback_keywords)[:8]:
            if token not in _TOPIC_GROUP_STOPWORDS:
                _add_topic_group(groups, seen, token, token)
            if len(groups) >= 3:
                break
    return groups[:8]



def _materialized_dataset_from_hypothesis(director_hypothesis: dict | None) -> dict:
    if not isinstance(director_hypothesis, dict):
        return {}
    strategy = director_hypothesis.get("identification_strategy")
    if not isinstance(strategy, dict):
        return {}
    materialized = strategy.get("materialized_dataset")
    return materialized if isinstance(materialized, dict) else {}


def _signature_score_groups(
    *,
    primary_family: str,
    director_hypothesis: dict | None,
    topic_groups: list[dict],
) -> list[dict]:
    materialized = _materialized_dataset_from_hypothesis(director_hypothesis)
    primary_phrases = [
        str(item)
        for item in (materialized.get("candidate_gene_or_pathway_families") or [])
        if str(item).strip()
    ]
    anchor_genes = [
        str(item)
        for item in (materialized.get("example_anchor_genes_from_enrichment_tables") or [])
        if str(item).strip()
    ]
    if not primary_phrases and topic_groups:
        primary_phrases = [str(item) for item in (topic_groups[0].get("phrases") or []) if str(item).strip()]
    groups: list[dict] = []
    seen: set[str] = set()
    if primary_phrases or anchor_genes:
        label = f"{re.sub(r'[^a-z0-9]+', '_', primary_family.lower()).strip('_') or 'primary'}_signature"
        tokens: list[str] = []
        for phrase in primary_phrases:
            tokens.extend(_topic_tokens(phrase))
        group = {
            "label": label,
            "keywords": sorted(set(tokens))[:24],
            "phrases": primary_phrases[:16],
            "anchor_genes": anchor_genes[:80],
            "role": "primary",
        }
        groups.append(group)
        seen.add(label)
    for topic in topic_groups:
        if not isinstance(topic, dict):
            continue
        label = str(topic.get("label") or "").strip()
        if not label or label in seen:
            continue
        # Drop infrastructural fragments that may leak from file paths, URLs,
        # cycle ids, or local workspace names. This remains domain-neutral.
        tokens = [str(token).lower() for token in topic.get("keywords") or []]
        if not tokens or all(token in _TOPIC_GROUP_STOPWORDS for token in tokens):
            continue
        if any(token.startswith("v") and any(ch.isdigit() for ch in token) for token in tokens):
            continue
        copied = dict(topic)
        copied["role"] = "rival"
        groups.append(copied)
        seen.add(label)
        if len(groups) >= 8:
            break
    return groups



def _normalize_column_name(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _csv_columns(csv: dict) -> list[str]:
    return [str(col) for col in (csv.get("columns") or [])]


def _csv_schema_role(csv: dict) -> str:
    """Classify CSV role from schema shape before using any file-name hint.

    The Analyst handoff policy is role-based: expression matrices can feed
    exposure/program scores, segment/sample metadata can feed outcomes and
    covariates, and annotation dictionaries cannot be silently promoted to an
    expression matrix just because they contain gene/probe identifiers.
    """
    raw_columns = _csv_columns(csv)
    if not raw_columns:
        return "unknown"
    columns = [_normalize_column_name(col) for col in raw_columns]
    first = columns[0]
    column_set = set(columns)
    metadata_first = any(token in first for token in ["sample", "subject", "patient", "participant"])

    segment_keys = {"segmentdisplayname", "cohort"}
    segment_context = {"patientcode", "region", "livercells", "roilabel", "segmentlabel", "slidename", "scanlabel"}
    if segment_keys.issubset(column_set) and len(column_set.intersection(segment_context)) >= 2:
        return "segment_metadata"

    sample_keys = {"samplegeoaccession", "geoaccession", "sampletitle", "cohort", "condition", "phenotype", "diagnosis", "disease"}
    if any(key in column_set for key in ["samplegeoaccession", "geoaccession", "sampletitle"]) and len(column_set.intersection(sample_keys)) >= 2:
        return "sample_metadata"

    annotation_terms = {
        "accessions",
        "genomebuild",
        "genomicposition",
        "globaloutlier",
        "outlierfrequency",
        "codeclass",
        "probepool",
        "numberofprobesincluded",
        "numberofprobestotal",
        "geneid",
        "targetgroup",
        "analyte",
        "analytetype",
    }
    feature_identifier = any(token in first for token in ["target", "gene", "probe", "transcript", "feature", "idref", "id"])
    sample_like_headers = 0
    for col in raw_columns[1:]:
        low = str(col).lower()
        if "|" in low or any(token in low for token in ["sample", "gsm", "roi", "segment", "full roi", "liver cells"]):
            sample_like_headers += 1
    if feature_identifier and len(column_set.intersection(annotation_terms)) >= 2 and sample_like_headers < 3:
        return "feature_annotation"

    if len(raw_columns) >= 5 and feature_identifier and not metadata_first:
        return "wide_expression_matrix"

    name = _csv_name_or_path(csv)
    matrix_hint = any(token in name for token in ["expression", "tpm", "count", "matrix", "fpkm", "rpkm"])
    if len(raw_columns) >= 5 and matrix_hint and not metadata_first:
        return "wide_expression_matrix"
    return "generic_table"


def _looks_like_wide_expression_csv(csv: dict) -> bool:
    return _csv_schema_role(csv) == "wide_expression_matrix"


def _looks_like_geo_sample_metadata(csv: dict) -> bool:
    columns = [str(col).lower() for col in (csv.get("columns") or [])]
    path = str(csv.get("csv_path") or "").lower()
    fmt = str(csv.get("format_hint") or "").lower()
    if "geo-metadata" in path or fmt == "geo_sample_metadata":
        return True
    has_sample = any(any(token in col for token in ["sample", "library", "geo_accession", "accession"]) for col in columns)
    has_outcome = any(any(token in col for token in ["outcome", "disease", "diagnosis", "status", "group", "condition", "phenotype", "response", "progress"]) for col in columns)
    return has_sample and has_outcome


def _csv_name_or_path(csv: dict | None) -> str:
    return str((csv or {}).get("name") or (csv or {}).get("csv_path") or "").lower()


def _looks_like_geomx_expression_matrix(csv: dict) -> bool:
    if _csv_schema_role(csv) != "wide_expression_matrix":
        return False
    sample_like_headers = 0
    for col in _csv_columns(csv)[1:]:
        low = str(col).lower()
        if "|" in low and any(token in low for token in ["roi", "liver", "segment", "full"]):
            sample_like_headers += 1
    return sample_like_headers >= 3


def _looks_like_spatial_segment_metadata(csv: dict) -> bool:
    return _csv_schema_role(csv) == "segment_metadata"


def _geomx_pair_key(csv: dict) -> str:
    value = _csv_name_or_path(csv)
    value = re.sub(r"(?:expression|counts?|matrix|metadata|properties|segments?|samples?)", "", value)
    value = re.sub(r"[^a-z0-9]+", "_", value).strip("_")
    return value


def _find_spatial_expression_segment_pair(bundle: dict) -> tuple[dict, dict] | None:
    csvs = [csv for csv in (bundle.get("csvs") or []) if isinstance(csv, dict)]
    expressions = [csv for csv in csvs if _looks_like_geomx_expression_matrix(csv)]
    segments = [csv for csv in csvs if _looks_like_spatial_segment_metadata(csv)]
    if not expressions or not segments:
        return None
    segments_by_key = {_geomx_pair_key(csv): csv for csv in segments}
    for expression in sorted(expressions, key=lambda item: str(item.get("name") or item.get("csv_path") or "")):
        segment = segments_by_key.get(_geomx_pair_key(expression))
        if segment is not None:
            return expression, segment
    return expressions[0], segments[0]

def _bundle_search_text(bundle: dict) -> str:
    chunks: list[str] = []
    for key in ("bundle_path", "provider", "candidate_title", "candidate_url", "candidate_doi", "accession"):
        value = bundle.get(key) if isinstance(bundle, dict) else None
        if value:
            chunks.append(str(value))
    for csv in (bundle.get("csvs") or []) if isinstance(bundle, dict) else []:
        if not isinstance(csv, dict):
            continue
        for key in ("name", "csv_path", "source_url", "format_hint"):
            value = csv.get(key)
            if value:
                chunks.append(str(value))
        chunks.extend(str(col) for col in (csv.get("columns") or [])[:80])
    return "\n".join(chunks).lower()
