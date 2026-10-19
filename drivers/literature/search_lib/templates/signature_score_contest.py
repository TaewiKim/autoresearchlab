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


def _signature_score_contest_blueprint_code() -> str:
    return r'''
import argparse
import json
import os
import re
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
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


def tokenise(value):
    return [item for item in re.split(r"[^A-Za-z0-9_.-]+", str(value)) if len(item) > 1]


def group_match(text, group):
    compact = norm_text(text)
    if not compact:
        return False
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


def infer_measurement_groups(df, requested_groups=None):
    groups = {}
    for col in df.columns:
        match = re.search(r"(?:^|[._-])([A-Za-z]{1,8})(\d{1,3})$", str(col))
        if not match:
            continue
        values = pd.to_numeric(df[col], errors="coerce")
        if values.notna().sum() == 0:
            continue
        groups.setdefault(match.group(1), []).append(col)
    groups = {key: cols for key, cols in groups.items() if len(cols) >= 2}
    ordered = [str(item) for item in (requested_groups or []) if str(item) in groups]
    if len(ordered) < 2:
        ordered = sorted(groups, key=lambda key: len(groups[key]), reverse=True)[:2]
    return ordered[:2], groups


def choose_annotation_columns(df, sample_cols):
    sample_set = set(sample_cols)
    cols = []
    markers = ("gene", "symbol", "name", "id", "description", "term", "pathway", "go", "kegg", "reactome", "annotation")
    for col in df.columns:
        if col in sample_set:
            continue
        low = str(col).lower()
        if any(marker in low for marker in markers) or df[col].dtype == object:
            cols.append(col)
    return cols[:24]


def choose_identifier_columns(df, sample_cols):
    sample_set = set(sample_cols)
    cols = []
    markers = ("gene", "symbol", "name", "entrez", "ensembl", "transcript", "id")
    for col in df.columns:
        if col in sample_set:
            continue
        low = str(col).lower()
        if any(marker in low for marker in markers):
            cols.append(col)
    return cols[:12]


def choose_term_and_gene_columns(df):
    term_cols = []
    gene_cols = []
    for col in df.columns:
        low = str(col).lower()
        if any(marker in low for marker in ("term", "name", "pathway", "description", "category")):
            term_cols.append(col)
        if any(marker in low for marker in ("gene", "id", "ids", "up", "down", "leading")):
            gene_cols.append(col)
    if not term_cols:
        term_cols = [col for col in df.columns if df[col].dtype == object][:4]
    return term_cols[:8], gene_cols[:12]


def collect_gene_tokens_for_group(group, term_paths):
    tokens = {str(item).upper() for item in group.get("anchor_genes") or [] if str(item).strip()}
    for path in term_paths:
        try:
            table = pd.read_csv(path)
        except Exception:
            continue
        term_cols, gene_cols = choose_term_and_gene_columns(table)
        if not term_cols:
            continue
        text = table[term_cols].fillna("").astype(str).agg(" ".join, axis=1)
        matched = text.apply(lambda value: group_match(value, group))
        if not matched.any():
            continue
        for col in gene_cols:
            for value in table.loc[matched, col].dropna().astype(str):
                for token in tokenise(value):
                    tokens.add(token.upper())
    return tokens


def member_mask_for_group(df, sample_cols, annotation_cols, identifier_cols, group, gene_tokens):
    id_mask = pd.Series(False, index=df.index)
    if gene_tokens and identifier_cols:
        token_set = {str(item).upper() for item in gene_tokens if str(item).strip()}
        if token_set:
            id_text = df[identifier_cols].fillna("").astype(str).agg(" ".join, axis=1)
            id_mask = id_text.apply(lambda value: any(token.upper() in token_set for token in tokenise(value)))
            if int(id_mask.sum()) >= 3:
                return id_mask
    if annotation_cols:
        annotation_text = df[annotation_cols].fillna("").astype(str).agg(" ".join, axis=1)
        return annotation_text.apply(lambda value: group_match(value, group))
    return id_mask


def separation_auc(group_a_scores, group_b_scores):
    a = [float(x) for x in group_a_scores if pd.notna(x)]
    b = [float(x) for x in group_b_scores if pd.notna(x)]
    if not a or not b:
        return None
    wins = []
    for av in a:
        for bv in b:
            wins.append(1.0 if av > bv else 0.5 if av == bv else 0.0)
    raw = float(np.mean(wins))
    return max(raw, 1.0 - raw)


def effect_stats(scores, group_a_cols, group_b_cols):
    a = pd.to_numeric(scores[group_a_cols], errors="coerce")
    b = pd.to_numeric(scores[group_b_cols], errors="coerce")
    effect = float(a.mean() - b.mean()) if a.notna().any() and b.notna().any() else None
    pooled = pd.concat([a, b]).std(ddof=1)
    cohen_d = float(effect / pooled) if effect is not None and pooled and not pd.isna(pooled) else None
    auc = separation_auc(a, b)
    loo_signs = []
    if effect is not None:
        full_sign = np.sign(effect)
        for dropped in list(group_a_cols) + list(group_b_cols):
            aa = a.drop(labels=[dropped], errors="ignore")
            bb = b.drop(labels=[dropped], errors="ignore")
            if aa.empty or bb.empty:
                continue
            loo_effect = float(aa.mean() - bb.mean())
            loo_signs.append(np.sign(loo_effect) == full_sign and abs(loo_effect) > 0)
    return {
        "effect": effect,
        "abs_effect": abs(effect) if effect is not None else None,
        "cohen_d": cohen_d,
        "abs_cohen_d": abs(cohen_d) if cohen_d is not None else None,
        "separation_auc": auc,
        "loo_direction_consistent": bool(loo_signs and all(loo_signs)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    parser.add_argument("--check-file", default=os.environ.get("RESEARCHLAB_CHECK_SPEC"))
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = load_spec(args.check_file)
    check_id = spec.get("check_id") or os.environ.get("RESEARCHLAB_CHECK_ID") or "signature_score_contest"
    data_path = resolve_path(args.csv_root, spec.get("dataset_path") or spec.get("csv_path"))
    if data_path is None:
        files = sorted(Path(args.csv_root).rglob("*.csv"))
        data_path = files[0] if files else None
    if data_path is None:
        pd.DataFrame([{"status": "no_csv_found"}]).to_csv(output_dir / "signature-score-table.csv", index=False)
        print(json.dumps({"check_id": check_id, "pass_fail": "fail", "checks": {"wide_table_loaded": False}}))
        return

    df = pd.read_csv(data_path)
    requested_groups = spec.get("comparison_groups") or []
    ordered_groups, groups = infer_measurement_groups(df, requested_groups=requested_groups)
    if len(ordered_groups) < 2:
        pd.DataFrame([{"status": "no_replicate_groups", "csv_path": str(data_path)}]).to_csv(output_dir / "signature-score-table.csv", index=False)
        print(json.dumps({"check_id": check_id, "pass_fail": "fail", "checks": {"wide_table_loaded": True, "group_pair_resolved": False}}))
        return
    group_a, group_b = ordered_groups[:2]
    group_a_cols, group_b_cols = groups[group_a], groups[group_b]
    sample_cols = group_a_cols + group_b_cols
    expression = df[sample_cols].apply(pd.to_numeric, errors="coerce")
    log_expression = np.log2(expression.clip(lower=0) + 1.0)
    row_mean = log_expression.mean(axis=1)
    row_sd = log_expression.std(axis=1, ddof=1).replace(0, np.nan)
    z_expression = log_expression.sub(row_mean, axis=0).div(row_sd, axis=0)

    score_groups = [item for item in spec.get("score_groups") or [] if isinstance(item, dict)]
    term_paths = []
    for item in spec.get("term_tables") or []:
        raw_path = item.get("path") if isinstance(item, dict) else item
        path = resolve_path(args.csv_root, raw_path)
        if path and path not in term_paths:
            term_paths.append(path)
    annotation_cols = choose_annotation_columns(df, sample_cols)
    identifier_cols = choose_identifier_columns(df, sample_cols)

    score_rows = []
    member_rows = []
    ranking_rows = []
    for idx, group in enumerate(score_groups):
        label = str(group.get("label") or f"signature_{idx}")
        gene_tokens = collect_gene_tokens_for_group(group, term_paths)
        mask = member_mask_for_group(df, sample_cols, annotation_cols, identifier_cols, group, gene_tokens)
        member_count = int(mask.sum())
        scores = z_expression.loc[mask, sample_cols].mean(axis=0) if member_count > 0 else pd.Series(np.nan, index=sample_cols)
        if member_count == 0 and any(norm_text(token) in {"zero", "missing", "sparse", "sparsity"} for token in group.get("keywords") or []):
            scores = (expression == 0).mean(axis=0)
            member_count = int(expression.shape[0])
        for sample, value in scores.items():
            score_rows.append({"signature": label, "sample": sample, "group": group_a if sample in group_a_cols else group_b, "score": float(value) if pd.notna(value) else None})
        stats = effect_stats(scores, group_a_cols, group_b_cols)
        ranking_rows.append({
            "signature": label,
            "role": "primary" if idx == 0 else "rival",
            "gene_count": member_count,
            **stats,
        })
        if member_count > 0:
            preview = df.loc[mask, identifier_cols].head(200) if identifier_cols else pd.DataFrame(index=df.loc[mask].head(200).index)
            if preview.empty:
                for row_idx in df.loc[mask].head(200).index:
                    member_rows.append({"signature": label, "row_index": int(row_idx)})
            else:
                for row_idx, row in preview.iterrows():
                    member_rows.append({"signature": label, "row_index": int(row_idx), "identifiers": " ".join(str(v) for v in row.dropna().tolist())[:500]})

    scores_df = pd.DataFrame(score_rows)
    ranking = pd.DataFrame(ranking_rows)
    members = pd.DataFrame(member_rows)
    scores_df.to_csv(output_dir / "signature-score-table.csv", index=False)
    ranking.to_csv(output_dir / "signature-ranking.csv", index=False)
    members.to_csv(output_dir / "signature-gene-members.csv", index=False)

    if not scores_df.empty:
        pivot = scores_df.pivot_table(index="sample", columns="signature", values="score", aggfunc="mean")
        plt.figure(figsize=(max(7, len(pivot.columns) * 1.2), 4.8))
        x = np.arange(len(pivot.index))
        width = 0.8 / max(1, len(pivot.columns))
        for idx, col in enumerate(pivot.columns):
            plt.bar(x + idx * width, pivot[col], width=width, label=str(col)[:28])
        plt.xticks(x + width * max(0, len(pivot.columns) - 1) / 2, pivot.index, rotation=35, ha="right")
        plt.ylabel("mean z-scored signature expression")
        plt.xlabel("sample")
        plt.title(f"{check_id}: sample-level signature scores")
        plt.legend(fontsize=7)
        plt.tight_layout()
        plt.savefig(output_dir / "signature-score-contest.png", dpi=180)
    else:
        plt.figure(figsize=(6, 2.5))
        plt.text(0.5, 0.5, "No signature scores computed", ha="center", va="center")
        plt.axis("off")
        plt.savefig(output_dir / "signature-score-contest.png", dpi=180)

    if not ranking.empty:
        plot_df = ranking.copy()
        plot_df["plot_value"] = pd.to_numeric(plot_df["separation_auc"], errors="coerce").fillna(0)
        plot_df = plot_df.sort_values(["role", "plot_value"], ascending=[True, False])
        plt.figure(figsize=(max(7, len(plot_df) * 0.8), 4.2))
        colors = ["#2f6f6d" if role == "primary" else "#9a6a3a" for role in plot_df["role"]]
        plt.bar(plot_df["signature"], plot_df["plot_value"], color=colors)
        plt.axhline(0.89, color="red", linestyle="--", linewidth=1)
        plt.ylabel("rank separation AUC, direction-free")
        plt.xlabel("signature group")
        plt.xticks(rotation=35, ha="right")
        plt.title(f"{check_id}: primary vs rival separation")
        plt.tight_layout()
        plt.savefig(output_dir / "signature-effect-ranking.png", dpi=180)

    primary = ranking.iloc[0].to_dict() if not ranking.empty else {}
    rivals = ranking.iloc[1:] if len(ranking) > 1 else pd.DataFrame()
    primary_auc = primary.get("separation_auc")
    primary_abs_effect = primary.get("abs_effect")
    rival_auc = pd.to_numeric(rivals.get("separation_auc"), errors="coerce") if not rivals.empty else pd.Series(dtype=float)
    rival_abs = pd.to_numeric(rivals.get("abs_effect"), errors="coerce") if not rivals.empty else pd.Series(dtype=float)
    computable_rivals = int(rivals["gene_count"].gt(0).sum()) if not rivals.empty and "gene_count" in rivals else 0
    checks = {
        "wide_table_loaded": True,
        "group_pair_resolved": True,
        "score_groups_declared_ge_2": len(score_groups) >= 2,
        "primary_signature_gene_count_ge_3": int(primary.get("gene_count") or 0) >= 3,
        "at_least_two_rival_scores_computed": computable_rivals >= 2,
        "primary_sample_separation_auc_ge_0_89": bool(primary_auc is not None and float(primary_auc) >= 0.89),
        "primary_beats_rivals_by_separation": bool(primary_auc is not None and (rival_auc.empty or float(primary_auc) >= float(rival_auc.max()))),
        "primary_beats_rivals_by_effect": bool(primary_abs_effect is not None and (rival_abs.empty or float(primary_abs_effect) >= float(rival_abs.max()))),
        "primary_leave_one_sample_out_direction_consistent": bool(primary.get("loo_direction_consistent")),
    }
    pass_fail = "pass" if all(checks.values()) else "inconclusive"
    method_score = 97 if pass_fail == "pass" else 74 if checks["primary_signature_gene_count_ge_3"] else 60
    accuracy_score = 96 if pass_fail == "pass" else 74 if checks["group_pair_resolved"] else 55
    print(json.dumps({
        "check_id": check_id,
        "pass_fail": pass_fail,
        "comparison": f"{group_a}_vs_{group_b}",
        "checks": checks,
        "primary_signature": primary.get("signature"),
        "primary_gene_count": int(primary.get("gene_count") or 0),
        "primary_separation_auc": primary_auc,
        "primary_abs_effect": primary_abs_effect,
        "max_rival_separation_auc": float(rival_auc.max()) if not rival_auc.empty and rival_auc.notna().any() else None,
        "max_rival_abs_effect": float(rival_abs.max()) if not rival_abs.empty and rival_abs.notna().any() else None,
        "correlations": {},
        "method_appropriateness_score": method_score,
        "analysis_accuracy_score": accuracy_score,
        "evidence_grade": {"signature_score_contest_link": "robust" if pass_fail == "pass" else "exploratory"},
        "notes": "Requirement-derived sample-level signature score contest. Signature membership is inferred from declared score groups, term tables, anchor identifiers, and annotation columns; no domain-specific marker list is embedded in the code.",
    }))


if __name__ == "__main__":
    main()
'''.strip() + "\n"
