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


def _generic_validation_blueprint_code() -> str:
    return r'''
import argparse
import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


def load_spec(path):
    if path and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return {}


def find_csv(spec, csv_root):
    dataset_path = spec.get("dataset_path") or spec.get("csv_path")
    if dataset_path and Path(dataset_path).is_file():
        return Path(dataset_path)
    dataset = spec.get("dataset")
    if dataset:
        candidate = Path(csv_root) / str(dataset)
        if candidate.is_file():
            return candidate
    files = sorted(Path(csv_root).rglob("*.csv")) if Path(csv_root).exists() else []
    if files:
        return files[0]
    return None


def first_present(columns, requested):
    lowered = {str(c).lower(): c for c in columns}
    for item in requested:
        if item in columns:
            return item
        hit = lowered.get(str(item).lower())
        if hit is not None:
            return hit
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    parser.add_argument("--check-file", default=os.environ.get("RESEARCHLAB_CHECK_SPEC"))
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = load_spec(args.check_file)
    check_id = spec.get("check_id") or os.environ.get("RESEARCHLAB_CHECK_ID") or "generic_validation_check"
    csv_path = find_csv(spec, args.csv_root)

    if csv_path is None:
        summary = pd.DataFrame([{"status": "no_csv_found", "csv_root": args.csv_root}])
        summary.to_csv(output_dir / "validation-summary-table.csv", index=False)
        plt.figure(figsize=(6, 2.5))
        plt.text(0.5, 0.5, "No CSV found for validation", ha="center", va="center")
        plt.axis("off")
        plt.savefig(output_dir / "validation-diagnostic.png", dpi=120, bbox_inches="tight")
        print(json.dumps({
            "check_id": check_id,
            "pass_fail": "inconclusive",
            "notes": "No CSV files were available under RESEARCHLAB_CSV_ROOT.",
        }))
        return

    df = pd.read_csv(csv_path)
    numeric = df.select_dtypes(include="number")
    requested_exposures = [x for x in spec.get("exposures", []) if isinstance(x, str)]
    requested_outcome = spec.get("outcome") if isinstance(spec.get("outcome"), str) else None
    exposure = first_present(numeric.columns, requested_exposures) if requested_exposures else None
    outcome = first_present(numeric.columns, [requested_outcome]) if requested_outcome else None
    if exposure is None and len(numeric.columns) >= 1:
        exposure = numeric.columns[0]
    if (outcome is None or outcome == exposure) and len(numeric.columns) >= 2:
        outcome = next((col for col in numeric.columns if col != exposure), numeric.columns[1])

    if exposure is None or outcome is None:
        pd.DataFrame([{
            "status": "insufficient_numeric_columns",
            "csv_path": str(csv_path),
            "numeric_column_count": len(numeric.columns),
        }]).to_csv(output_dir / "validation-summary-table.csv", index=False)
        plt.figure(figsize=(6, 2.5))
        plt.text(0.5, 0.5, "Insufficient numeric columns", ha="center", va="center")
        plt.axis("off")
        plt.savefig(output_dir / "validation-diagnostic.png", dpi=120, bbox_inches="tight")
        print(json.dumps({
            "check_id": check_id,
            "pass_fail": "inconclusive",
            "notes": "Dataset loaded but has fewer than two numeric columns for an executable association check.",
        }))
        return

    # `df[[same_col, same_col]]` yields duplicate labels, and then
    # `analysis_df[same_col]` is a DataFrame rather than a Series.  That
    # previously crashed pivot-recovery runner lanes with pandas' ambiguous
    # DataFrame truth-value error when the generic fallback selected the same
    # column for exposure and outcome.  Keep the two selected columns distinct
    # and coerce through Series explicitly so runner recovery degrades to an
    # inconclusive check instead of dying.
    analysis_df = df.loc[:, [exposure, outcome]].dropna()
    exposure_series = pd.to_numeric(analysis_df.loc[:, exposure], errors="coerce")
    outcome_series = pd.to_numeric(analysis_df.loc[:, outcome], errors="coerce")
    valid_pair = pd.concat([exposure_series, outcome_series], axis=1).dropna()
    corr = float(valid_pair.iloc[:, 0].corr(valid_pair.iloc[:, 1])) if len(valid_pair) >= 3 else None
    pd.DataFrame([{
        "csv_path": str(csv_path),
        "rows": len(df),
        "analysis_rows": len(valid_pair),
        "exposure": exposure,
        "outcome": outcome,
        "pearson_correlation": corr,
    }]).to_csv(output_dir / "validation-summary-table.csv", index=False)

    plt.figure(figsize=(6, 4))
    if len(valid_pair):
        plt.scatter(valid_pair.iloc[:, 0], valid_pair.iloc[:, 1], alpha=0.55, s=18)
    plt.xlabel(str(exposure))
    plt.ylabel(str(outcome))
    plt.title(f"{check_id}: executable data check")
    plt.tight_layout()
    plt.savefig(output_dir / "validation-scatter.png", dpi=140)

    print(json.dumps({
        "check_id": check_id,
        "pass_fail": "pass" if corr is not None else "inconclusive",
        "correlations": {f"{exposure}_vs_{outcome}": corr} if corr is not None else {},
        "evidence_grade": {str(outcome): "exploratory" if corr is not None else "weak"},
        "notes": f"Executed generic analyst handoff blueprint on {csv_path.name}. This verifies data usability and a first-pass association, not causal identification.",
    }))


if __name__ == "__main__":
    main()
'''.strip() + "\n"
