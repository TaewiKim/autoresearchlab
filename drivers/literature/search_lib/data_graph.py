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
from .dataset_inspect import _HYPOTHESIS_STOPWORDS, _looks_like_geo_sample_metadata, _looks_like_wide_expression_csv


def _append_data_graph_analysis_edge(output_dir: Path, *, primary_family: str, identification_strategy: str, lane_id: str, status: str = "pending_lab_runner") -> str | None:
    """Append a `pending` analysis_result edge — using chronicle's
    canonical edge shape — to the cycle's data_graph.

    The analyst's role under the unified pipeline is to verify the
    lab-director hypothesis through analysis AND to push the
    verification state back into the data-graph. The handoff is not
    yet a completed verification (lab-runner runs the blueprints), so
    this edge is annotated ``status="pending_lab_runner"`` until
    lab-runner overwrites it with the realised verdict.

    Shape conforms to ``createDataGraph()`` in
    ``src/agents/chronicle/data_graph_artifacts.js``: ``{id, from, to,
    relation, status, metadata, provenance}``. Auxiliary fields live
    under ``metadata``. The new ``relation`` is registered into the
    graph's vocabulary so post-cycle lints can see it.
    """
    cycle_id = cycle_id_from_output_dir(output_dir)
    if not cycle_id:
        return None
    runtime_root = research_lab_runtime_root(output_dir)
    graph_path = runtime_root / "state" / f"{cycle_id}-data-graph.json"
    if not graph_path.is_file():
        return None
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(graph, dict):
        return None
    nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    edges = graph.get("edges") if isinstance(graph.get("edges"), list) else []
    vocab = graph.get("vocabulary") if isinstance(graph.get("vocabulary"), dict) else {}
    node_types = list(vocab.get("node_types") or [])
    edge_relations = list(vocab.get("edge_relations") or [])
    seen_node_types = set(node_types)
    seen_relations = set(edge_relations)
    appended_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    family_id = f"family:{primary_family}" if primary_family else None
    lane_node_id = f"analysis_lane:{lane_id}" if lane_id else None
    if not family_id or not lane_node_id:
        return None

    # Create the analysis_lane node if it doesn't exist yet, so the edge
    # below has both endpoints.
    if not any(n.get("id") == lane_node_id for n in nodes):
        nodes.append({
            "id": lane_node_id,
            "type": "analysis_lane",
            "label": lane_id,
            "score": {},
            "state": status,
            "metadata": {
                "lane_id": lane_id,
                "identification_strategy": identification_strategy,
                "created_at": appended_at,
            },
            "provenance": [f"lane:{lane_id}"],
        })
        if "analysis_lane" not in seen_node_types:
            seen_node_types.add("analysis_lane")
            node_types.append("analysis_lane")

    edge_id = f"edge:{family_id}:{lane_node_id}:analysis_result"
    if not any(e.get("id") == edge_id for e in edges):
        edges.append({
            "id": edge_id,
            "from": family_id,
            "to": lane_node_id,
            "relation": "analysis_result",
            "status": status,
            "metadata": {
                "primary_family": primary_family,
                "identification_strategy": identification_strategy,
                "verdict": "pending",
                "lane_id": lane_id,
                "appended_at": appended_at,
            },
            "provenance": [f"lane:{lane_id}"],
        })
        if "analysis_result" not in seen_relations:
            seen_relations.add("analysis_result")
            edge_relations.append("analysis_result")

    graph["nodes"] = nodes
    graph["edges"] = edges
    graph["vocabulary"] = {
        "node_types": sorted(seen_node_types),
        "edge_relations": sorted(seen_relations),
    }
    try:
        graph_path.write_text(json.dumps(graph, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        return None
    return str(graph_path)



def _score_bundle_columns(bundle: dict, keywords: set[str]) -> int:
    """Return the count of (csv, column) pairs whose column tokens
    match hypothesis keywords.

    Operates on the ``csvs`` array shape that
    ``cycle_fetched_data_bundles`` (Rust harness) emits — each csv has a
    ``columns`` list that the column-name matcher walks once.

    Matching is token-based rather than arbitrary substring-based. This
    prevents false bundle selection where a non-omics metadata sheet with
    columns like ``number`` / ``Cite Score`` accidentally satisfies a
    biological hypothesis through generic words such as "copy-number" or
    "topology score".
    """
    if not keywords:
        return 0
    keywords = {kw for kw in keywords if kw and kw not in _HYPOTHESIS_STOPWORDS}
    score = 0
    for csv in bundle.get("csvs") or []:
        if not isinstance(csv, dict):
            continue
        cols = csv.get("columns") or []
        if not isinstance(cols, list):
            continue
        for raw_col in cols:
            col_tokens = {
                token
                for token in re.split(r"[^A-Za-z0-9]+", str(raw_col).lower())
                if len(token) > 3 and token not in _HYPOTHESIS_STOPWORDS
            }
            if not col_tokens:
                continue
            for kw in keywords:
                if kw in col_tokens or any(
                    (len(kw) >= 5 and token.startswith(kw))
                    or (len(token) >= 5 and kw.startswith(token))
                    for token in col_tokens
                ):
                    score += 1
                    break
    # GEO-style expression bundles often expose outcomes only in sample
    # metadata while matrix columns are opaque sample/library ids.  Keyword
    # scoring alone then assigns zero overlap and prevents the specialized
    # sample-level blueprint from ever being emitted.  Give schema-complete
    # wide-expression + sample-metadata bundles a modest positive score so
    # they can be selected and then validated by the stricter blueprint
    # builder.
    has_wide_expression = False
    has_sample_metadata = False
    for csv in bundle.get("csvs") or []:
        if not isinstance(csv, dict):
            continue
        if _looks_like_wide_expression_csv(csv):
            has_wide_expression = True
        if _looks_like_geo_sample_metadata(csv):
            has_sample_metadata = True
    if has_wide_expression and has_sample_metadata:
        score = max(score, 5)
    return score



def _geo_series_matrix_schema_columns(path: Path) -> list[str]:
    """Return bounded sample-schema column names from a GEO series matrix.

    This intentionally extracts only metadata keys/characteristic labels and
    never serializes sample values. It lets Analyst reason about real
    variables such as age, location, batch, and library identifiers instead of
    falling back to topic/path tokens when the manifest classified the matrix
    file as unsupported.
    """
    if not path.is_file():
        return []
    columns: list[str] = ["Sample_geo_accession"]
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            for line_index, line in enumerate(handle):
                if line_index >= 600:
                    break
                if not line.startswith("!Sample_"):
                    continue
                parts = [part.strip().strip('"') for part in line.rstrip("\n").split("\t")]
                if not parts:
                    continue
                key = parts[0]
                if key == "!Sample_characteristics_ch1":
                    for raw in parts[1:]:
                        if ":" not in raw:
                            continue
                        name = clean_text(raw.split(":", 1)[0]).strip()
                        if name and name not in columns:
                            columns.append(name)
                elif key in {"!Sample_title", "!Sample_description", "!Sample_source_name_ch1", "!Sample_platform_id"}:
                    col = key.replace("!Sample_", "sample_")
                    if col not in columns:
                        columns.append(col)
                    if any("library" in raw.lower() for raw in parts[1:]) and "library_id" not in columns:
                        columns.append("library_id")
    except Exception:
        return ["Sample_geo_accession"]
    return columns

def _cycle_candidate_datasets_from_state(output_dir: Path | None) -> list[dict]:
    if output_dir is None:
        return []
    cycle_id = cycle_id_from_output_dir(output_dir)
    if not cycle_id:
        return []
    runtime_root = research_lab_runtime_root(output_dir)
    index_path = runtime_root / "state" / f"{cycle_id}-data-bundles.json"
    if not index_path.is_file():
        return []
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
    except Exception:
        return []
    bundles = index.get("bundles") if isinstance(index, dict) else None
    if not isinstance(bundles, list):
        return []
    enriched: list[dict] = []
    for bundle in bundles:
        if not isinstance(bundle, dict) or bundle.get("status") != "fetched":
            continue
        manifest_entries = []
        manifest_path = bundle.get("manifest_path")
        if manifest_path:
            try:
                manifest_payload = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
                if isinstance(manifest_payload, list):
                    manifest_entries = manifest_payload
                elif isinstance(manifest_payload, dict) and isinstance(manifest_payload.get("manifest"), list):
                    manifest_entries = manifest_payload["manifest"]
            except Exception:
                manifest_entries = []
        csvs = []
        for entry in manifest_entries:
            if not isinstance(entry, dict):
                continue
            if entry.get("fetch_status") == "fetched":
                csvs.append({
                    "name": entry.get("name"),
                    "csv_path": entry.get("csv_path"),
                    "row_count": entry.get("row_count"),
                    "columns": entry.get("columns") or [],
                    "format_hint": entry.get("format_hint"),
                    "source_url": entry.get("source_url"),
                })
                continue
            # GEO series-matrix files are often marked skipped_unsupported by
            # the fetch manifest because they are not row/column CSVs, but for
            # Analyst design they contain the scientifically important sample
            # schema (age, site, batch, library/sample ids). Surface bounded
            # schema only so the Analyst can design against real variables
            # without ingesting full raw data into the prompt.
            raw_meta = entry.get("gunzipped_to") or entry.get("raw_path")
            if raw_meta and "series_matrix" in str(raw_meta).lower():
                columns = _geo_series_matrix_schema_columns(Path(str(raw_meta)))
                if columns:
                    csvs.append({
                        "name": entry.get("name") or Path(str(raw_meta)).stem,
                        "csv_path": str(raw_meta),
                        "row_count": None,
                        "columns": columns,
                        "format_hint": "geo_sample_metadata",
                        "source_url": entry.get("source_url"),
                    })
        # Some GEO/SRA mirrors materialize analysis-ready CSVs during local
        # conversion even when the original manifest rows are marked
        # ``skipped_unsupported`` (for example txt/gz series matrices).  The
        # previous handoff generator trusted only fetched manifest entries, so
        # lab-runner received an empty bundle and fell back to a generic
        # Pearson smoke test despite real cycle-scoped CSVs being present on
        # disk.  Scan the bundle's csv/ directory as a second source of schema
        # truth and surface headers to the dataset picker.
        bundle_path = bundle.get("bundle_path")
        if bundle_path:
            csv_root = Path(str(bundle_path)) / "csv"
            if csv_root.is_dir():
                known_paths = {str(item.get("csv_path")) for item in csvs if item.get("csv_path")}
                for csv_path in sorted(csv_root.glob("*.csv")):
                    if str(csv_path) in known_paths:
                        continue
                    columns: list[str] = []
                    try:
                        with csv_path.open("r", encoding="utf-8", errors="ignore") as handle:
                            header = handle.readline().strip()
                        columns = [col.strip() for col in header.split(",") if col.strip()]
                    except Exception:
                        columns = []
                    csvs.append({
                        "name": csv_path.stem,
                        "csv_path": str(csv_path),
                        "row_count": None,
                        "columns": columns,
                        "format_hint": "materialized_csv_scan",
                        "source_url": bundle.get("candidate_url"),
                    })
                for metadata_path in sorted(csv_root.glob("*.geo-metadata.txt")):
                    if str(metadata_path) in known_paths:
                        continue
                    columns = _geo_series_matrix_schema_columns(metadata_path)
                    csvs.append({
                        "name": metadata_path.stem,
                        "csv_path": str(metadata_path),
                        "row_count": None,
                        "columns": columns or ["Sample_geo_accession"],
                        "format_hint": "geo_sample_metadata",
                        "source_url": bundle.get("candidate_url"),
                    })
                raw_root = Path(str(bundle_path)) / "raw"
                if raw_root.is_dir():
                    for metadata_path in sorted(raw_root.glob("*series_matrix*.txt*")):
                        if metadata_path.suffix == ".gz" or str(metadata_path) in known_paths:
                            continue
                        columns = _geo_series_matrix_schema_columns(metadata_path)
                        if not columns:
                            continue
                        csvs.append({
                            "name": metadata_path.stem,
                            "csv_path": str(metadata_path),
                            "row_count": None,
                            "columns": columns,
                            "format_hint": "geo_sample_metadata",
                            "source_url": bundle.get("candidate_url"),
                        })
        enriched.append({
            **bundle,
            "csvs": csvs,
        })
    return enriched


ANALYST_GRAPH_NODE_SCAN_LIMIT = 500
ANALYST_GRAPH_EDGE_SCAN_LIMIT = 1000
ANALYST_AUDIT_TABLE_LIMIT = 20
ANALYST_AUDIT_COLUMN_PREVIEW_LIMIT = 30


def _load_cycle_data_graph(output_dir: Path | None) -> dict | None:
    if output_dir is None:
        return None
    cycle_id = cycle_id_from_output_dir(output_dir)
    if not cycle_id:
        return None
    graph_path = research_lab_runtime_root(output_dir) / "state" / f"{cycle_id}-data-graph.json"
    if not graph_path.is_file():
        return None
    try:
        payload = json.loads(graph_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _schema_tokens(value: str) -> set[str]:
    return {
        token
        for token in re.split(r"[^a-z0-9]+", str(value or "").lower())
        if len(token) >= 3 and token not in {"the", "and", "for", "with", "from", "into", "than", "this", "that"}
    }


def _summarize_graph_for_handoff(data_graph: dict | None, hypothesis_text: str) -> dict:
    if not isinstance(data_graph, dict):
        return {"available": False, "node_count": 0, "edge_count": 0, "matched_nodes": [], "matched_edges": []}
    nodes = data_graph.get("nodes") if isinstance(data_graph.get("nodes"), list) else []
    edges = data_graph.get("edges") if isinstance(data_graph.get("edges"), list) else []
    query = _schema_tokens(hypothesis_text)
    matched_nodes = []
    for node in nodes[:ANALYST_GRAPH_NODE_SCAN_LIMIT]:
        if not isinstance(node, dict):
            continue
        label = str(node.get("label") or node.get("name") or node.get("id") or "")
        node_type = str(node.get("type") or node.get("node_type") or "")
        # Analyst blueprint selection should inspect graph vocabulary only:
        # ids/labels/types/relations.  Do not serialize node metadata or
        # evidence payloads into the audit context.
        tokens = _schema_tokens(" ".join([label, node_type]))
        overlap = sorted(query & tokens)
        if overlap:
            matched_nodes.append({"id": node.get("id"), "label": label, "type": node_type, "matched_terms": overlap[:6]})
    matched_node_ids = {item.get("id") for item in matched_nodes if item.get("id")}
    matched_edges = []
    for edge in edges[:ANALYST_GRAPH_EDGE_SCAN_LIMIT]:
        if not isinstance(edge, dict):
            continue
        if edge.get("from") in matched_node_ids or edge.get("to") in matched_node_ids or edge.get("source") in matched_node_ids or edge.get("target") in matched_node_ids:
            matched_edges.append({
                "id": edge.get("id"),
                "from": edge.get("from") or edge.get("source"),
                "to": edge.get("to") or edge.get("target"),
                "relation": edge.get("relation") or edge.get("type"),
                "status": edge.get("status"),
            })
    return {
        "available": True,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "node_scan_limit": ANALYST_GRAPH_NODE_SCAN_LIMIT,
        "edge_scan_limit": ANALYST_GRAPH_EDGE_SCAN_LIMIT,
        "matched_nodes": matched_nodes[:20],
        "matched_edges": matched_edges[:20],
    }


def _build_schema_graph_audit(bundle: dict, *, data_graph: dict | None, director_hypothesis: dict | None, hypothesis_text: str, keywords: set[str]) -> dict:
    csvs = [csv for csv in (bundle.get("csvs") or []) if isinstance(csv, dict)]
    tables = []
    for csv in csvs:
        columns = [str(col) for col in (csv.get("columns") or [])]
        lowered = [col.lower() for col in columns]
        table_kind = "generic_table"
        if _looks_like_wide_expression_csv(csv):
            table_kind = "wide_feature_matrix"
        elif _looks_like_geo_sample_metadata(csv):
            table_kind = "sample_metadata"
        column_tokens = set().union(*[_schema_tokens(col) for col in columns]) if columns else set()
        matched_terms = sorted((keywords or set()) & column_tokens)
        tables.append({
            "name": csv.get("name"),
            "path": csv.get("csv_path"),
            "kind": table_kind,
            "column_count": len(columns),
            "columns_preview": columns[:ANALYST_AUDIT_COLUMN_PREVIEW_LIMIT],
            "matched_hypothesis_terms": matched_terms[:12],
            "format_hint": csv.get("format_hint"),
        })
    expression_tables = [t for t in tables if t["kind"] == "wide_feature_matrix"]
    metadata_tables = [t for t in tables if t["kind"] == "sample_metadata"]
    graph_summary = _summarize_graph_for_handoff(data_graph, hypothesis_text)
    strategy = "schema_audit_required"
    if expression_tables and metadata_tables:
        strategy = "sample_level_feature_matrix_with_metadata_join"
    elif any(t.get("matched_hypothesis_terms") for t in tables):
        strategy = "matched_column_statistical_check"
    return {
        "audit_version": "schema-graph-blueprint-audit-v1",
        "dataset_root": bundle.get("bundle_path"),
        "hypothesis_id": (director_hypothesis or {}).get("hypothesis_id"),
        "hypothesis_statement": (director_hypothesis or {}).get("statement"),
        "strategy_recommendation": strategy,
        "tables_total": len(tables),
        "tables": tables[:ANALYST_AUDIT_TABLE_LIMIT],
        "wide_feature_matrix_candidates": expression_tables[:5],
        "sample_metadata_candidates": metadata_tables[:5],
        "data_graph": graph_summary,
        "audit_io_policy": {
            "raw_data_rows_read": False,
            "csv_access": "header_only_first_line",
            "metadata_access": "bounded_schema_lines_only",
            "graph_access": "bounded_ids_labels_types_relations_only",
            "table_limit": ANALYST_AUDIT_TABLE_LIMIT,
            "column_preview_limit": ANALYST_AUDIT_COLUMN_PREVIEW_LIMIT,
        },
        "blueprint_requirements": [
            "Do not choose arbitrary numeric columns when schema/graph audit identifies feature matrices or sample metadata.",
            "Use matched graph/hypothesis terms to pick outcome/exposure candidates before falling back to generic association.",
            "Emit explicit checks_total/checks_passed/checks_failed and keep non-improving models inconclusive.",
        ],
    }


def _attach_schema_graph_audit(checks: list[dict], blueprints: list[dict], audit: dict) -> None:
    for check in checks or []:
        if isinstance(check, dict):
            check["schema_graph_audit"] = audit
            check.setdefault("pre_blueprint_audit_required", True)
    for blueprint in blueprints or []:
        if isinstance(blueprint, dict):
            blueprint["schema_graph_audit"] = audit
            notes = blueprint.setdefault("execution_notes", [])
            if isinstance(notes, list):
                notes.insert(0, "Blueprint was selected after analyst schema+data-graph audit; do not ignore schema_graph_audit when executing/reviewing this check.")





def _validation_context_text(
    *,
    role_plan: dict | None,
    director_hypothesis: dict | None,
    memo: dict | None,
    primary_family: str,
) -> str:
    parts: list[str] = [primary_family]
    if isinstance(director_hypothesis, dict):
        for key in (
            "statement",
            "primary_family",
            "identification_strategy",
            "falsification_rule",
        ):
            value = director_hypothesis.get(key)
            if isinstance(value, str):
                parts.append(value)
        for key in ("rival_mechanisms", "falsification_conditions", "secondary_families"):
            value = director_hypothesis.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value[:12])
    if isinstance(memo, dict):
        for key in ("estimands", "priority_confounders", "falsification_tests", "selection_bias_risks"):
            value = memo.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value[:12])
    planner_metadata = (role_plan or {}).get("planner_metadata") if isinstance(role_plan, dict) else {}
    if isinstance(planner_metadata, dict):
        review_action = planner_metadata.get("review_action")
        if isinstance(review_action, dict):
            parts.append(str(review_action.get("description") or ""))
            parts.append(str(review_action.get("type") or ""))
        for key in ("blocker_reasons", "validation_objective", "target_rubric"):
            value = planner_metadata.get(key)
            if isinstance(value, list):
                parts.extend(str(item) for item in value[:16])
            elif isinstance(value, str):
                parts.append(value)
        for item in planner_metadata.get("candidate_hypotheses") or []:
            if isinstance(item, dict):
                parts.append(str(item.get("statement") or ""))
    return clean_text(" ".join(part for part in parts if part))
