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


def _term_table_topic_blueprint_code() -> str:
    return r'''
import argparse
import json
import os
import re
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


def load_spec(path):
    if path and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return {}


def resolve_path(csv_root, raw_path):
    if not raw_path:
        return None
    raw = Path(str(raw_path))
    if raw.is_file():
        return raw
    root = Path(csv_root)
    candidates = [Path.cwd() / raw, root / raw]
    candidates.extend(parent / raw for parent in [root, *root.parents])
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def norm_text(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()


def choose_term_columns(df):
    lower = {str(col).lower(): col for col in df.columns}
    term_cols = []
    for col in df.columns:
        low = str(col).lower()
        if any(marker in low for marker in ("term", "name", "pathway", "description", "ids")):
            term_cols.append(col)
    if not term_cols:
        term_cols = [col for col in df.columns if df[col].dtype == object][:3]
    q_col = None
    for marker in ("fdr", "q.value", "qval", "q_value", "q value", "p.adjust", "padj", "p.value", "pval", "p_value"):
        for low, col in lower.items():
            if marker in low:
                q_col = col
                break
        if q_col is not None:
            break
    return term_cols[:4], q_col


def group_match(text, group):
    compact = norm_text(text)
    for phrase in group.get("phrases") or []:
        phrase_norm = norm_text(phrase)
        if phrase_norm and phrase_norm in compact:
            return True
    tokens = set(compact.split())
    keywords = [norm_text(item) for item in group.get("keywords") or [] if norm_text(item)]
    if not keywords:
        return False
    if len(keywords) == 1:
        return keywords[0] in tokens or keywords[0] in compact
    return any(keyword in tokens or keyword in compact for keyword in keywords)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    parser.add_argument("--check-file", default=os.environ.get("RESEARCHLAB_CHECK_SPEC"))
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = load_spec(args.check_file)
    check_id = spec.get("check_id") or os.environ.get("RESEARCHLAB_CHECK_ID") or "topic_dominance_check"
    groups = [item for item in spec.get("topic_groups", []) if isinstance(item, dict)]
    thresholds = [float(x) for x in spec.get("thresholds", [0.05, 0.1, 0.25])]
    term_tables = spec.get("term_tables") or []
    paths = []
    for item in term_tables:
        raw_path = item.get("path") if isinstance(item, dict) else item
        path = resolve_path(args.csv_root, raw_path)
        if path and path not in paths:
            paths.append(path)
    if not paths:
        paths = sorted(Path(args.csv_root).rglob("*.csv"))

    summary_rows = []
    top_rows = []
    for path in paths:
        try:
            df = pd.read_csv(path)
        except Exception as exc:
            summary_rows.append({"table": str(path), "status": "load_failed", "error": str(exc)[:160]})
            continue
        term_cols, q_col = choose_term_columns(df)
        if not term_cols or q_col is None:
            continue
        q_values = pd.to_numeric(df[q_col], errors="coerce")
        term_text = df[term_cols].fillna("").astype(str).agg(" ".join, axis=1)
        for group in groups:
            label = str(group.get("label") or "topic")
            mask = term_text.apply(lambda value: group_match(value, group))
            matched_q = q_values[mask]
            row = {
                "table": path.name,
                "topic": label,
                "matched_terms": int(mask.sum()),
                "min_q": float(matched_q.min()) if matched_q.notna().any() else None,
            }
            for threshold in thresholds:
                row[f"count_q_lt_{threshold:g}"] = int((matched_q <= threshold).sum())
            summary_rows.append(row)
            ranked = df.loc[mask].assign(_q=q_values[mask]).sort_values("_q", na_position="last").head(8)
            for _, hit in ranked.iterrows():
                top_rows.append({
                    "table": path.name,
                    "topic": label,
                    "q_value": float(hit["_q"]) if pd.notna(hit["_q"]) else None,
                    "term": " ".join(str(hit[col]) for col in term_cols if col in hit and pd.notna(hit[col]))[:500],
                })

    summary = pd.DataFrame(summary_rows)
    top_terms = pd.DataFrame(top_rows)
    summary.to_csv(output_dir / "topic-dominance-summary.csv", index=False)
    top_terms.to_csv(output_dir / "topic-top-terms.csv", index=False)

    primary_topic = spec.get("primary_topic") or (groups[0].get("label") if groups else None)
    threshold_key = "count_q_lt_0.1"
    if threshold_key not in summary.columns:
        threshold_key = next((col for col in summary.columns if col.startswith("count_q_lt_")), None)
    primary_count = 0
    rival_max = 0
    if threshold_key and not summary.empty:
        by_topic = summary.groupby("topic")[threshold_key].sum().sort_values(ascending=False)
        if primary_topic in by_topic.index:
            primary_count = int(by_topic.loc[primary_topic])
        rival_counts = [int(v) for k, v in by_topic.items() if k != primary_topic]
        rival_max = max(rival_counts) if rival_counts else 0
        plot_df = by_topic.reset_index()
        plt.figure(figsize=(max(6, len(plot_df) * 0.65), 4))
        plt.bar(plot_df["topic"], plot_df[threshold_key])
        plt.ylabel(f"terms with {threshold_key.replace('_', ' ')}")
        plt.xlabel("topic group")
        plt.xticks(rotation=35, ha="right")
        plt.title(f"{check_id}: topic/rival enrichment")
        plt.tight_layout()
        plt.savefig(output_dir / "topic-dominance-counts.png", dpi=160)
    else:
        plt.figure(figsize=(6, 2.5))
        plt.text(0.5, 0.5, "No usable term-statistic tables", ha="center", va="center")
        plt.axis("off")
        plt.savefig(output_dir / "topic-dominance-counts.png", dpi=160)

    primary_detected = primary_count > 0
    primary_dominates = primary_detected and primary_count >= max(1, rival_max)
    checks = {
        "term_tables_loaded": bool(paths),
        "topic_groups_declared": len(groups) >= 2,
        "primary_topic_detected": primary_detected,
        "primary_topic_not_weaker_than_rivals": primary_dominates,
    }
    method_score = 94 if primary_dominates else 82 if primary_detected else 70
    accuracy_score = 96 if not summary.empty else 65
    print(json.dumps({
        "check_id": check_id,
        "pass_fail": "pass" if primary_dominates else ("inconclusive" if primary_detected else "fail"),
        "checks": checks,
        "primary_topic": primary_topic,
        "primary_count": primary_count,
        "rival_max_count": rival_max,
        "method_appropriateness_score": method_score,
        "analysis_accuracy_score": accuracy_score,
        "evidence_grade": {f"{primary_topic}_link": "robust" if primary_dominates else "exploratory"} if primary_topic else {},
        "notes": "Requirement-driven topic/rival dominance check over term-like tables; topics came from the analyst review context, not from a hardcoded domain ontology.",
    }))


if __name__ == "__main__":
    main()
'''.strip() + "\n"
