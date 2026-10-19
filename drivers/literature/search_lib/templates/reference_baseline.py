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


def _reference_baseline_audit_blueprint_code() -> str:
    return r'''
import argparse
import json
import re
from pathlib import Path

import pandas as pd


def load_spec(path):
    if path and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return {}


def tokens_from_reference(reference_context):
    chunks = []
    for paper in reference_context.get("reference_papers") or []:
        chunks.extend([str(paper.get("title") or ""), str(paper.get("doi") or "")])
        chunks.extend(str(item) for item in (paper.get("analysis_methods") or []))
    chunks.append(str(reference_context.get("reference_methods_baseline") or ""))
    chunks.extend(str(item) for item in (reference_context.get("required_reproduction_steps") or []))
    tokens = []
    for token in re.split(r"[^A-Za-z0-9_.-]+", " ".join(chunks).lower()):
        if len(token) >= 4:
            tokens.append(token)
    return sorted(set(tokens))[:200]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--check-file", default=__import__("os").environ.get("RESEARCHLAB_CHECK_SPEC"))
    args = parser.parse_args()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    spec = load_spec(args.check_file)
    root = Path(args.csv_root)
    reference_context = spec.get("reference_context") or {}
    ref_tokens = tokens_from_reference(reference_context)

    files = list(root.rglob("*")) if root.exists() else []
    code_ext = {".py", ".r", ".R", ".ipynb", ".jl", ".sh", ".do", ".sas", ".qmd", ".Rmd"}
    tabular_ext = {".csv", ".tsv", ".txt", ".xlsx", ".xls", ".parquet", ".gz"}
    code_files = [p for p in files if p.is_file() and p.suffix in code_ext]
    tabular_files = [p for p in files if p.is_file() and (p.suffix.lower() in tabular_ext or any(str(p).lower().endswith(ext) for ext in [".csv.gz", ".txt.gz", ".tsv.gz"]))]
    manifest_files = [p for p in files if p.is_file() and p.name.lower() in {"manifest.json", "readme", "readme.txt", "readme.md"}]

    rows = []
    for p in files:
        if not p.is_file():
            continue
        rel = str(p.relative_to(root)) if root in p.parents or p == root else str(p)
        hay = rel.lower()
        hit_tokens = [tok for tok in ref_tokens if tok in hay][:20]
        rows.append({
            "path": rel,
            "suffix": p.suffix,
            "size_bytes": p.stat().st_size,
            "is_code_like": p.suffix in code_ext,
            "is_tabular_like": p.suffix.lower() in tabular_ext or any(str(p).lower().endswith(ext) for ext in [".csv.gz", ".txt.gz", ".tsv.gz"]),
            "reference_token_hits": ";".join(hit_tokens),
        })
    pd.DataFrame(rows).to_csv(output_dir / "reference-resource-audit.csv", index=False)

    reproduction_steps = reference_context.get("required_reproduction_steps") or []
    step_rows = []
    for idx, step in enumerate(reproduction_steps, start=1):
        step_text = str(step)
        step_tokens = [tok for tok in re.split(r"[^A-Za-z0-9_.-]+", step_text.lower()) if len(tok) >= 4]
        matched_files = []
        for row in rows:
            hay = row["path"].lower()
            if any(tok in hay for tok in step_tokens[:40]):
                matched_files.append(row["path"])
        step_rows.append({
            "step_index": idx,
            "reproduction_step": step_text,
            "matched_resource_count": len(matched_files),
            "matched_resources_preview": ";".join(matched_files[:8]),
        })
    pd.DataFrame(step_rows).to_csv(output_dir / "baseline-reproduction-plan.csv", index=False)

    metrics = {
        "reference_paper_count": len(reference_context.get("reference_papers") or []),
        "baseline_methods_declared": bool(reference_context.get("reference_methods_baseline")),
        "required_reproduction_step_count": len(reproduction_steps),
        "dataset_file_count": len(files),
        "tabular_resource_count": len(tabular_files),
        "code_resource_count": len(code_files),
        "manifest_or_readme_count": len(manifest_files),
    }
    pass_fail = "pass" if metrics["reference_paper_count"] and metrics["tabular_resource_count"] and metrics["required_reproduction_step_count"] else "inconclusive"
    if metrics["code_resource_count"] == 0:
        pass_fail = "inconclusive"
    reproducibility_blocker = "reference_code_unavailable" if metrics["code_resource_count"] == 0 else None
    print(json.dumps({
        "check_id": spec.get("check_id", "reference_baseline_audit"),
        "pass_fail": pass_fail,
        "reproducibility_blocker": reproducibility_blocker,
        "metrics": metrics,
        "evidence_grade": {"reference_baseline_reproduction": "exploratory" if pass_fail == "pass" else "weak"},
        "notes": "Audited papers/methods/code/supplementary resources/benchmarks for the cited baseline. Missing code is reported as reproducibility_blocker=reference_code_unavailable rather than hidden.",
    }))


if __name__ == "__main__":
    main()
'''.strip() + "\n"
