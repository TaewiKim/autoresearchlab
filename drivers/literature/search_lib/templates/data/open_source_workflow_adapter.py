
import argparse
import csv
import json
import os
from pathlib import Path

try:
    import numpy as np  # type: ignore
except Exception as exc:  # pragma: no cover - environment dependent
    np = None
    NUMPY_IMPORT_ERROR = str(exc)[:200]
else:
    NUMPY_IMPORT_ERROR = None

try:
    import pandas as pd  # type: ignore
except Exception as exc:  # pragma: no cover - environment dependent
    pd = None
    PANDAS_IMPORT_ERROR = str(exc)[:200]
else:
    PANDAS_IMPORT_ERROR = None


def smoke():
    payload = {
        "status": "ok",
        "pandas": getattr(pd, "__version__", None),
        "pandas_import_error": PANDAS_IMPORT_ERROR,
        "numpy": getattr(np, "__version__", None),
        "numpy_import_error": NUMPY_IMPORT_ERROR,
    }
    try:
        import sklearn  # type: ignore
        payload["sklearn"] = getattr(sklearn, "__version__", "available")
    except Exception as exc:
        payload["sklearn"] = None
        payload["sklearn_import_error"] = str(exc)[:200]
    print(json.dumps(payload, sort_keys=True))


def csv_numeric_profile(path):
    if pd is None:
        return csv_numeric_profile_stdlib(path)
    try:
        frame = pd.read_csv(path, nrows=5000, low_memory=False)
    except Exception as exc:
        return {"path": str(path), "status": "load_failed", "error": str(exc)[:200]}
    numeric = []
    for column in frame.columns:
        series = pd.to_numeric(frame[column], errors="coerce")
        if series.notna().sum() >= max(3, int(0.2 * len(series))):
            numeric.append(str(column))
    return {
        "path": str(path),
        "status": "profiled",
        "rows_read": int(len(frame)),
        "columns": int(len(frame.columns)),
        "numeric_columns": int(len(numeric)),
        "numeric_column_examples": numeric[:12],
    }


def csv_numeric_profile_stdlib(path):
    try:
        with open(path, newline="", encoding="utf-8", errors="replace") as handle:
            reader = csv.DictReader(handle)
            columns = list(reader.fieldnames or [])
            numeric_counts = {column: 0 for column in columns}
            rows = 0
            for row in reader:
                rows += 1
                if rows > 5000:
                    break
                for column in columns:
                    value = (row.get(column) or "").strip()
                    if not value:
                        continue
                    try:
                        float(value)
                    except Exception:
                        continue
                    numeric_counts[column] += 1
    except Exception as exc:
        return {"path": str(path), "status": "load_failed", "error": str(exc)[:200]}
    threshold = max(3, int(0.2 * max(rows, 1)))
    numeric = [column for column, count in numeric_counts.items() if count >= threshold]
    return {
        "path": str(path),
        "status": "profiled",
        "rows_read": int(rows),
        "columns": int(len(columns)),
        "numeric_columns": int(len(numeric)),
        "numeric_column_examples": numeric[:12],
    }


def application(csv_root, output_dir):
    root = Path(csv_root)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    profiles = []
    for path in sorted(root.rglob("*.csv"))[:80]:
        profiles.append(csv_numeric_profile(path))
    profile_path = out / "open_source_workflow_numeric_profile.csv"
    if pd is not None:
        profile_frame = pd.DataFrame(profiles)
        profile_frame.to_csv(profile_path, index=False)
    else:
        fieldnames = sorted({key for item in profiles for key in item.keys()}) or ["status"]
        with open(profile_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for item in profiles:
                writer.writerow({key: json.dumps(value) if isinstance(value, (list, dict)) else value for key, value in item.items()})
    best = None
    profiled = [item for item in profiles if item.get("status") == "profiled"]
    if profiled:
        best = sorted(profiled, key=lambda item: (item.get("numeric_columns") or 0, item.get("columns") or 0), reverse=True)[0]
    summary = {
        "status": "completed",
        "csv_root": str(root),
        "files_profiled": len(profiled),
        "selected_table": best,
        "method": "open-source pandas/numpy workflow adapter with stdlib fallback when optional packages are unavailable; optional sklearn availability checked in smoke stage",
        "interpretation": "This pre-blueprint agent profiles numeric/high-dimensional structure so runner blueprints can be reviewed against actual table shape.",
    }
    (out / "open_source_workflow_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, sort_keys=True))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--csv-root", default=os.environ.get("RESEARCHLAB_CSV_ROOT", "."))
    parser.add_argument("--output-dir", default=os.environ.get("RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR") or os.environ.get("RESEARCHLAB_OUTPUT_DIR", "."))
    args = parser.parse_args()
    if args.smoke:
        smoke()
    else:
        application(args.csv_root, args.output_dir)


if __name__ == "__main__":
    main()
