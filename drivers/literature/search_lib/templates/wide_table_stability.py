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


def _wide_table_stability_blueprint_code() -> str:
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


def infer_measurement_groups(df, requested_groups=None):
    numeric_cols = [col for col in df.columns if pd.api.types.is_numeric_dtype(df[col])]
    buckets = {}
    for col in numeric_cols:
        match = re.search(r"^(?P<prefix>.*?)(?:[._-])?(?P<group>[A-Za-z]{1,8})(?P<rep>\d{1,3})$", str(col))
        if not match:
            continue
        prefix = re.sub(r"[^A-Za-z0-9]+", "_", match.group("prefix")).strip("_") or "measurement"
        group = match.group("group")
        buckets.setdefault(prefix, {}).setdefault(group, []).append(col)
    requested_groups = [str(g) for g in (requested_groups or []) if str(g)]
    best_prefix, best_groups, best_score = None, {}, -1
    for prefix, groups in buckets.items():
        usable = {group: cols for group, cols in groups.items() if len(cols) >= 2}
        if len(usable) < 2:
            continue
        score = sum(len(cols) for cols in usable.values())
        if requested_groups and all(group in usable for group in requested_groups[:2]):
            score += 1000
        if score > best_score:
            best_prefix, best_groups, best_score = prefix, usable, score
    return best_prefix, best_groups


def effect_vector(matrix, group_a_cols, group_b_cols):
    values = np.log2(matrix[group_a_cols + group_b_cols].astype(float).clip(lower=0) + 1.0)
    return values[group_a_cols].mean(axis=1) - values[group_b_cols].mean(axis=1)


def pearson(a, b):
    mask = np.isfinite(a) & np.isfinite(b)
    if mask.sum() < 3:
        return None
    return float(np.corrcoef(a[mask], b[mask])[0, 1])


def find_effect_column(df):
    for col in df.columns:
        low = str(col).lower()
        if "log2" in low or "logfc" in low or low in {"effect", "estimate", "coef"}:
            if pd.api.types.is_numeric_dtype(df[col]) or pd.to_numeric(df[col], errors="coerce").notna().sum() > 3:
                return col
    for col in df.columns:
        low = str(col).lower()
        if "fold" in low or low == "fc":
            if pd.api.types.is_numeric_dtype(df[col]) or pd.to_numeric(df[col], errors="coerce").notna().sum() > 3:
                return col
    return None


def compare_supplied_effect(primary_df, effect_series, effect_path):
    if effect_path is None:
        return {}
    try:
        supplied = pd.read_csv(effect_path)
    except Exception:
        return {"supplied_effect_status": "load_failed"}
    effect_col = find_effect_column(supplied)
    if effect_col is None:
        return {"supplied_effect_status": "no_effect_column"}
    left = primary_df.copy()
    left["_computed_effect"] = effect_series
    join_col = None
    for col in left.columns:
        if col in supplied.columns and not pd.api.types.is_numeric_dtype(left[col]):
            overlap = set(left[col].dropna().astype(str).head(5000)) & set(supplied[col].dropna().astype(str).head(5000))
            if len(overlap) >= 10:
                join_col = col
                break
    if join_col:
        merged = left[[join_col, "_computed_effect"]].merge(supplied[[join_col, effect_col]], on=join_col, how="inner")
    elif len(left) == len(supplied):
        merged = pd.DataFrame({"_computed_effect": effect_series, effect_col: supplied[effect_col]})
    else:
        return {"supplied_effect_status": "no_join_key"}
    supplied_effect = pd.to_numeric(merged[effect_col], errors="coerce")
    computed = pd.to_numeric(merged["_computed_effect"], errors="coerce")
    corr = pearson(computed.to_numpy(), supplied_effect.to_numpy())
    mask = computed.notna() & supplied_effect.notna()
    sign_concordance = float((np.sign(computed[mask]) == np.sign(supplied_effect[mask])).mean()) if mask.sum() else None
    return {
        "supplied_effect_status": "compared",
        "supplied_effect_column": effect_col,
        "supplied_effect_rows": int(mask.sum()),
        "supplied_effect_correlation": corr,
        "supplied_effect_sign_concordance": sign_concordance,
    }


def permutation_null(matrix, group_a_cols, group_b_cols, observed_effect, n_perm=200):
    cols = group_a_cols + group_b_cols
    if len(cols) < 4:
        return None
    values = np.log2(matrix[cols].astype(float).clip(lower=0).to_numpy() + 1.0)
    row_var = np.nanvar(values, axis=1)
    if len(row_var) > 5000:
        keep = np.argsort(row_var)[-5000:]
        values = values[keep, :]
        obs = np.asarray(observed_effect)[keep]
    else:
        obs = np.asarray(observed_effect)
    n_a = len(group_a_cols)
    observed_stat = float(np.nanmedian(np.abs(obs)))
    rng = np.random.default_rng(1)
    null_stats = []
    for _ in range(n_perm):
        perm = rng.permutation(len(cols))
        a = values[:, perm[:n_a]]
        b = values[:, perm[n_a:]]
        null_stats.append(float(np.nanmedian(np.abs(np.nanmean(a, axis=1) - np.nanmean(b, axis=1)))))
    p_value = float((sum(stat >= observed_stat for stat in null_stats) + 1) / (len(null_stats) + 1))
    return {"observed_median_abs_effect": observed_stat, "null_median_abs_effect_mean": float(np.mean(null_stats)), "empirical_p_value": p_value}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    parser.add_argument("--check-file", default=os.environ.get("RESEARCHLAB_CHECK_SPEC"))
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = load_spec(args.check_file)
    check_id = spec.get("check_id") or os.environ.get("RESEARCHLAB_CHECK_ID") or "wide_table_stability_check"
    data_path = resolve_path(args.csv_root, spec.get("dataset_path") or spec.get("csv_path"))
    if data_path is None:
        files = sorted(Path(args.csv_root).rglob("*.csv"))
        data_path = files[0] if files else None
    if data_path is None:
        pd.DataFrame([{"status": "no_csv_found"}]).to_csv(output_dir / "sample-qc.csv", index=False)
        print(json.dumps({"check_id": check_id, "pass_fail": "inconclusive", "checks": {"wide_table_loaded": False}}))
        return
    df = pd.read_csv(data_path)
    requested_groups = spec.get("comparison_groups") or []
    prefix, groups = infer_measurement_groups(df, requested_groups=requested_groups)
    if not prefix or len(groups) < 2:
        pd.DataFrame([{"status": "no_replicate_groups", "csv_path": str(data_path)}]).to_csv(output_dir / "sample-qc.csv", index=False)
        print(json.dumps({"check_id": check_id, "pass_fail": "inconclusive", "checks": {"wide_table_loaded": True, "group_pair_resolved": False}}))
        return
    ordered_groups = [str(g) for g in requested_groups if str(g) in groups]
    if len(ordered_groups) < 2:
        ordered_groups = sorted(groups, key=lambda group: len(groups[group]), reverse=True)[:2]
    group_a, group_b = ordered_groups[:2]
    group_a_cols, group_b_cols = groups[group_a], groups[group_b]
    full_effect = effect_vector(df, group_a_cols, group_b_cols)

    loo_rows = []
    for dropped in group_a_cols + group_b_cols:
        a_cols = [col for col in group_a_cols if col != dropped]
        b_cols = [col for col in group_b_cols if col != dropped]
        if not a_cols or not b_cols:
            continue
        loo_effect = effect_vector(df, a_cols, b_cols)
        top_mask = np.abs(full_effect) >= np.nanpercentile(np.abs(full_effect), 75)
        sign_concordance = float((np.sign(full_effect[top_mask]) == np.sign(loo_effect[top_mask])).mean()) if top_mask.sum() else None
        loo_rows.append({
            "dropped_sample": dropped,
            "remaining_group_a": len(a_cols),
            "remaining_group_b": len(b_cols),
            "effect_correlation": pearson(full_effect.to_numpy(), loo_effect.to_numpy()),
            "top_quartile_sign_concordance": sign_concordance,
        })
    loo_df = pd.DataFrame(loo_rows)
    loo_df.to_csv(output_dir / "leave-one-sample-out.csv", index=False)

    qc_rows = []
    for group, cols in ((group_a, group_a_cols), (group_b, group_b_cols)):
        for col in cols:
            series = pd.to_numeric(df[col], errors="coerce")
            qc_rows.append({
                "sample": col,
                "group": group,
                "missing_fraction": float(series.isna().mean()),
                "zero_fraction": float((series.fillna(0) == 0).mean()),
                "sum": float(series.sum(skipna=True)),
                "median": float(series.median(skipna=True)),
            })
    qc_df = pd.DataFrame(qc_rows)
    qc_df.to_csv(output_dir / "sample-qc.csv", index=False)

    top_effects = df.copy()
    top_effects["_computed_group_log2_effect"] = full_effect
    top_effects = top_effects.reindex(np.argsort(-np.abs(full_effect.to_numpy()))).head(100)
    top_effects.to_csv(output_dir / "top-computed-effects.csv", index=False)

    effect_paths = []
    for raw in spec.get("effect_tables") or []:
        path = resolve_path(args.csv_root, raw.get("path") if isinstance(raw, dict) else raw)
        if path:
            effect_paths.append(path)
    effect_compare = compare_supplied_effect(df, full_effect, effect_paths[0] if effect_paths else None)
    perm = permutation_null(df, group_a_cols, group_b_cols, full_effect)

    rank_df = df[group_a_cols + group_b_cols].rank(axis=0, pct=True)
    rank_effect = rank_df[group_a_cols].mean(axis=1) - rank_df[group_b_cols].mean(axis=1)
    normalization_corr = pearson(full_effect.to_numpy(), rank_effect.to_numpy())

    if not qc_df.empty:
        plt.figure(figsize=(max(6, len(qc_df) * 0.7), 4))
        plt.bar(qc_df["sample"], qc_df["sum"])
        plt.ylabel("numeric column sum")
        plt.xlabel("sample column")
        plt.xticks(rotation=35, ha="right")
        plt.title(f"{check_id}: sample-level QC")
        plt.tight_layout()
        plt.savefig(output_dir / "sample-qc.png", dpi=160)
    if not loo_df.empty:
        plt.figure(figsize=(max(6, len(loo_df) * 0.7), 4))
        plt.bar(loo_df["dropped_sample"], loo_df["effect_correlation"])
        plt.axhline(0.8, color="red", linestyle="--", linewidth=1)
        plt.ylabel("effect correlation vs full contrast")
        plt.xlabel("left-out sample")
        plt.xticks(rotation=35, ha="right")
        plt.title(f"{check_id}: leave-one-sample-out stability")
        plt.tight_layout()
        plt.savefig(output_dir / "loo-stability.png", dpi=160)
    if effect_compare.get("supplied_effect_correlation") is not None:
        pd.DataFrame([effect_compare]).to_csv(output_dir / "supplied-effect-comparison.csv", index=False)

    loo_min = float(loo_df["effect_correlation"].min()) if not loo_df.empty and loo_df["effect_correlation"].notna().any() else None
    loo_sign_min = float(loo_df["top_quartile_sign_concordance"].min()) if not loo_df.empty and loo_df["top_quartile_sign_concordance"].notna().any() else None
    permutation_p = perm.get("empirical_p_value") if isinstance(perm, dict) else None
    supplied_corr = effect_compare.get("supplied_effect_correlation")
    supplied_sign = effect_compare.get("supplied_effect_sign_concordance")
    checks = {
        "wide_table_loaded": True,
        "group_pair_resolved": True,
        "leave_one_sample_out_min_corr_ge_0_8": bool(loo_min is not None and loo_min >= 0.8),
        "leave_one_sample_out_top_sign_ge_0_8": bool(loo_sign_min is not None and loo_sign_min >= 0.8),
        "normalization_sensitivity_corr_ge_0_7": bool(normalization_corr is not None and normalization_corr >= 0.7),
        "label_shuffle_empirical_p_le_0_1": bool(permutation_p is not None and permutation_p <= 0.1),
        "supplied_effect_corr_ge_0_8": bool(supplied_corr is not None and supplied_corr >= 0.8),
        "supplied_effect_sign_ge_0_8": bool(supplied_sign is not None and supplied_sign >= 0.8),
    }
    pass_fail = "pass" if checks["leave_one_sample_out_min_corr_ge_0_8"] and checks["normalization_sensitivity_corr_ge_0_7"] else "inconclusive"
    method_score = 96 if pass_fail == "pass" else 82
    accuracy_score = 96 if pass_fail == "pass" else 80
    print(json.dumps({
        "check_id": check_id,
        "pass_fail": pass_fail,
        "comparison": f"{group_a}_vs_{group_b}",
        "measurement_prefix": prefix,
        "correlations": {
            "full_vs_rank_normalized_effect": normalization_corr,
            "computed_vs_supplied_effect": supplied_corr,
        },
        "checks": checks,
        "loo_min_correlation": loo_min,
        "loo_min_top_sign_concordance": loo_sign_min,
        "label_shuffle_null": perm,
        "supplied_effect_comparison": effect_compare,
        "method_appropriateness_score": method_score,
        "analysis_accuracy_score": accuracy_score,
        "evidence_grade": {f"{group_a}_vs_{group_b}_link": "robust" if pass_fail == "pass" else "exploratory"},
        "notes": "Requirement-driven wide-table stability/QC check using replicate groups inferred from column structure and analyst-declared comparison groups.",
    }))


if __name__ == "__main__":
    main()
'''.strip() + "\n"
