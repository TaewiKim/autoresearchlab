#!/usr/bin/env python3
"""Import the real LitQA2 (LAB-Bench) parquet into this repo's LitQA2 adapter
format. External data is kept out of git (evals/litqa2/_real/.gitignore); only
this converter is committed.

  python3 scripts/dev/import_litqa2.py --src <lab-bench/LitQA2/*.parquet> \
      --out evals/litqa2/_real/questions [--limit N]

Each row -> {id, question, options (ideal + distractors, deterministically
shuffled, + an "unsure" option), answer_index, source_doi}.
"""
import argparse
import hashlib
import json
import os

import pandas as pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default="evals/litqa2/_real/questions")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    df = pd.read_parquet(a.src)
    if a.limit:
        df = df.head(a.limit)
    n = 0
    for _, r in df.iterrows():
        qid = str(r["id"])
        ideal = str(r["ideal"])
        distractors = [str(x) for x in list(r["distractors"])]
        pairs = [(o, o == ideal) for o in [ideal] + distractors]
        # deterministic shuffle by hash(id+option) to avoid positional bias
        pairs.sort(key=lambda x: hashlib.sha1((qid + x[0]).encode()).hexdigest())
        options = [o for o, _ in pairs] + ["Insufficient information to answer"]
        answer_index = next(i for i, (_, is_id) in enumerate(pairs) if is_id)
        sources = list(r["sources"]) if r["sources"] is not None else []
        src_doi = str(sources[0]).replace("https://doi.org/", "") if len(sources) else None
        rec = {
            "id": qid,
            "question": str(r["question"]),
            "options": options,
            "answer_index": answer_index,
            "source_doi": src_doi,
        }
        with open(os.path.join(a.out, f"{qid}.json"), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
        n += 1
    print(f"imported {n} LitQA2 questions -> {a.out}")


if __name__ == "__main__":
    main()
