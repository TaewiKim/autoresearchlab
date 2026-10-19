#!/usr/bin/env python3
"""Import ScienceAgentBench (verified split) task metadata into the repo's
adapter format. External benchmark data stays out of git (evals/sab/_real/ is
gitignored); only this converter is committed.

Tasks come from the HF dataset osunlp/ScienceAgentBench (verified split,
102 tasks). The datasets / gold programs / eval scripts live in the separate
benchmark_verified.zip (password documented in the upstream README).

  python3 scripts/dev/import_sab.py --out evals/sab/_real [--split verified]
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.request

PARQUET_URL = (
    "https://huggingface.co/api/datasets/osunlp/ScienceAgentBench/parquet/{config}/{split}/0.parquet"
)


def load_rows(split: str):
    try:
        from datasets import load_dataset  # type: ignore

        ds = load_dataset("osunlp/ScienceAgentBench", split=split)
        return [dict(r) for r in ds]
    except Exception:
        import pandas as pd

        url = PARQUET_URL.format(config="default", split=split)
        tmp = "/tmp/sab_tasks.parquet"
        urllib.request.urlretrieve(url, tmp)
        return pd.read_parquet(tmp).to_dict("records")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="evals/sab/_real")
    ap.add_argument("--split", default="verified")
    a = ap.parse_args()
    rows = load_rows(a.split)
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "tasks.jsonl")
    keep = [
        "instance_id",
        "domain",
        "subtask_categories",
        "task_inst",
        "domain_knowledge",
        "dataset_folder_tree",
        "dataset_preview",
        "src_file_or_path",
        "gold_program_name",
        "output_fname",
        "eval_script_name",
    ]
    with open(path, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps({k: r.get(k) for k in keep}, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} tasks -> {path}")


if __name__ == "__main__":
    main()
