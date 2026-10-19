"""
open-data-bootstrap driver (URL-driven fetcher).

This driver is invoked by the Rust harness when a scout lane declares that it
needs to materialise open datasets on disk before an analyst/runner lane can
execute. The previous implementation hardcoded WHO indicators, the WHO GHO
OData API, and a semantic keyword taxonomy; this version is completely
provider-agnostic.

The driver accepts a role plan containing a list of data sources — each
source is a dict with at minimum a ``url`` — downloads each URL, writes the
payload to disk under ``--output-root``, and emits a manifest describing the
downloaded files. No WHO-specific logic remains.

Contract:

CLI:
    open_data_bootstrap.py
        --output-root <dir>             (required)
        [--role-plan-file <path>]       (required in practice — the driver
                                         needs at least one data source)
        [--result-path <json>]          (optional — copy of the final result)
        [--summary-path <md>]           (optional — markdown summary)
        [--force-refetch]               (optional — skip cache validation)

Role-plan shape consumed (first non-empty match wins):
    role_plan.data_acquisition.sources: [
        { "name": <slug>, "url": <url>,
          "format": "csv" | "json" | "raw" (default inferred from URL),
          "value_path": <dotted pointer for JSON -> tabular extraction>,
          "notes": <free text> }
    ]
    role_plan.planner_metadata.data_sources: [...]
    role_plan.scout.sources: [...]

Manifest emitted to ``<output_root>/manifest.json``:
    [ { "name", "url", "local_path", "csv_path", "format", "bytes",
        "row_count", "fetched_at", "cache_hit", "status",
        "value_path" (optional), "notes" (optional) }, ... ]
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import json
import re
import sys
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


DRIVER_NAME = "open-data-bootstrap"
DEFAULT_TIMEOUT_SECONDS = 120
USER_AGENT = "researchlab-open-data-bootstrap/2.0"


# ---------------------------------------------------------------------------
# Helpers


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_]+", "-", value or "").strip("-").lower()
    return slug or "source"


def _read_json(path: Optional[Path]) -> Any:
    if path is None or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _iso_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _coerce_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


# ---------------------------------------------------------------------------
# Source extraction from the role plan


def _extract_sources(role_plan: Any) -> List[Dict[str, Any]]:
    if not isinstance(role_plan, dict):
        return []
    for path in (
        ("data_acquisition", "sources"),
        ("planner_metadata", "data_sources"),
        ("scout", "sources"),
        ("sources",),
    ):
        cursor: Any = role_plan
        for key in path:
            if not isinstance(cursor, dict):
                cursor = None
                break
            cursor = cursor.get(key)
        if isinstance(cursor, list) and cursor:
            normalised: List[Dict[str, Any]] = []
            for idx, item in enumerate(cursor):
                if not isinstance(item, dict):
                    continue
                url = _coerce_str(item.get("url"))
                if not url.strip():
                    continue
                name = _coerce_str(item.get("name")) or f"source_{idx + 1:02d}"
                fmt = _coerce_str(item.get("format")).lower()
                if fmt not in ("csv", "json", "raw"):
                    lowered = url.lower()
                    if lowered.endswith(".csv"):
                        fmt = "csv"
                    elif lowered.endswith(".json"):
                        fmt = "json"
                    else:
                        fmt = "raw"
                normalised.append(
                    {
                        "name": name,
                        "url": url,
                        "format": fmt,
                        "value_path": _coerce_str(item.get("value_path")) or None,
                        "notes": _coerce_str(item.get("notes")),
                    }
                )
            if normalised:
                return normalised
    return []


# ---------------------------------------------------------------------------
# Download + cache


def _fetch_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
        return response.read()


def _resolve_value_path(payload: Any, value_path: str) -> List[Dict[str, Any]]:
    """Resolve a dotted path like ``value`` or ``data.rows`` into a list.

    Intentionally permissive — unknown paths return ``[]`` so the fetcher can
    still write the raw JSON blob even when the tabular extraction fails.
    """

    if not value_path:
        return []
    cursor: Any = payload
    for segment in value_path.split("."):
        if isinstance(cursor, dict):
            cursor = cursor.get(segment)
        else:
            cursor = None
            break
    if isinstance(cursor, list):
        rows: List[Dict[str, Any]] = []
        for item in cursor:
            if isinstance(item, dict):
                rows.append(item)
        return rows
    return []


def _json_rows_to_csv(rows: List[Dict[str, Any]], csv_path: Path) -> int:
    """Write rows as CSV using the union of keys as the header."""

    if not rows:
        return 0
    header: List[str] = []
    seen: set = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                header.append(key)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        for row in rows:
            writer.writerow(
                [row.get(key) if row.get(key) is not None else "" for key in header]
            )
    return len(rows)


def _load_existing_manifest(manifest_path: Path) -> Dict[str, Dict[str, Any]]:
    if not manifest_path.is_file():
        return {}
    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(raw, list):
        return {}
    index: Dict[str, Dict[str, Any]] = {}
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = _coerce_str(item.get("url"))
        if url:
            index[url] = item
    return index


def _cache_still_valid(item: Dict[str, Any]) -> bool:
    local_path = _coerce_str(item.get("local_path"))
    if not local_path:
        return False
    return Path(local_path).is_file()


# ---------------------------------------------------------------------------
# Per-source processing


def _write_raw_blob(output_root: Path, source: Dict[str, Any], blob: bytes) -> Path:
    ext_guess = {
        "csv": ".csv",
        "json": ".json",
        "raw": ".bin",
    }.get(source["format"], ".bin")
    local_path = output_root / (_slugify(source["name"]) + ext_guess)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(blob)
    return local_path


def _persist_json_source(
    output_root: Path, source: Dict[str, Any], blob: bytes
) -> Tuple[Path, Optional[Path], int]:
    slug = _slugify(source["name"])
    json_path = output_root / f"{slug}.json"
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_bytes(blob)
    try:
        payload = json.loads(blob.decode("utf-8"))
    except Exception:
        return json_path, None, 0
    rows = _resolve_value_path(payload, source.get("value_path") or "")
    if not rows and isinstance(payload, list):
        rows = [item for item in payload if isinstance(item, dict)]
    csv_path: Optional[Path] = None
    row_count = 0
    if rows:
        csv_path = output_root / f"{slug}.csv"
        row_count = _json_rows_to_csv(rows, csv_path)
    return json_path, csv_path, row_count


def _process_source(
    source: Dict[str, Any],
    *,
    output_root: Path,
    cached: Dict[str, Dict[str, Any]],
    force_refetch: bool,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "name": source["name"],
        "url": source["url"],
        "format": source["format"],
        "value_path": source.get("value_path"),
        "fetched_at": None,
        "cache_hit": False,
        "local_path": None,
        "csv_path": None,
        "row_count": 0,
        "bytes": 0,
        "status": "pending",
        "notes": source.get("notes") or "",
    }
    existing = cached.get(source["url"])
    if not force_refetch and existing and _cache_still_valid(existing):
        record.update(
            {
                "local_path": existing.get("local_path"),
                "csv_path": existing.get("csv_path"),
                "row_count": existing.get("row_count") or 0,
                "bytes": existing.get("bytes") or 0,
                "fetched_at": existing.get("fetched_at"),
                "cache_hit": True,
                "status": "cached",
            }
        )
        return record
    try:
        blob = _fetch_bytes(source["url"])
    except HTTPError as exc:
        record["status"] = "failed"
        record["error"] = f"HTTP {exc.code}: {exc.reason}"
        return record
    except URLError as exc:
        record["status"] = "failed"
        record["error"] = f"URL error: {exc.reason}"
        return record
    except Exception as exc:
        record["status"] = "failed"
        record["error"] = str(exc)
        return record
    record["bytes"] = len(blob)
    record["fetched_at"] = _iso_now()
    if source["format"] == "json":
        json_path, csv_path, rows = _persist_json_source(output_root, source, blob)
        record["local_path"] = str(json_path)
        record["csv_path"] = str(csv_path) if csv_path else None
        record["row_count"] = rows
    else:
        local_path = _write_raw_blob(output_root, source, blob)
        record["local_path"] = str(local_path)
        if source["format"] == "csv":
            try:
                text = blob.decode("utf-8")
                record["row_count"] = max(0, len(text.splitlines()) - 1)
            except Exception:
                record["row_count"] = 0
    record["status"] = "completed"
    return record


# ---------------------------------------------------------------------------
# Summary markdown


def _write_summary_md(summary_path: Path, manifest: List[Dict[str, Any]]) -> None:
    lines: List[str] = ["# Open-data bootstrap summary", ""]
    lines.append(f"- Sources processed: {len(manifest)}")
    completed = sum(1 for item in manifest if item.get("status") == "completed")
    cached = sum(1 for item in manifest if item.get("status") == "cached")
    failed = sum(1 for item in manifest if item.get("status") == "failed")
    lines.append(f"- Completed: {completed}")
    lines.append(f"- Cached: {cached}")
    lines.append(f"- Failed: {failed}")
    lines.append("")
    if manifest:
        lines.append("| name | url | status | rows | bytes |")
        lines.append("| --- | --- | --- | --- | --- |")
        for item in manifest:
            lines.append(
                "| `{name}` | {url} | {status} | {rows} | {bytes} |".format(
                    name=item.get("name"),
                    url=item.get("url"),
                    status=item.get("status"),
                    rows=item.get("row_count", 0),
                    bytes=item.get("bytes", 0),
                )
            )
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Driver top-level


def run_driver(
    *,
    output_root: Path,
    role_plan_file: Optional[Path],
    result_path: Optional[Path],
    summary_path: Optional[Path],
    force_refetch: bool,
) -> Dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    cached = _load_existing_manifest(manifest_path)
    role_plan = _read_json(role_plan_file)
    sources = _extract_sources(role_plan)

    records: List[Dict[str, Any]] = []
    for source in sources:
        records.append(
            _process_source(
                source,
                output_root=output_root,
                cached=cached,
                force_refetch=force_refetch,
            )
        )

    _write_json(manifest_path, records)
    if summary_path is not None:
        _write_summary_md(summary_path, records)

    dataset_root = str(output_root)
    result = {
        "status": "completed" if sources else "no-sources",
        "driver": DRIVER_NAME,
        "output_root": dataset_root,
        "dataset_root": dataset_root,
        "manifest_path": str(manifest_path),
        "files_downloaded": sum(
            1 for item in records if item.get("status") == "completed"
        ),
        "files_cached": sum(1 for item in records if item.get("status") == "cached"),
        "files_failed": sum(1 for item in records if item.get("status") == "failed"),
        "sources_requested": len(records),
        "manifest": records,
    }
    if result_path is not None:
        _write_json(result_path, result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--role-plan-file")
    parser.add_argument("--result-path")
    parser.add_argument("--summary-path")
    parser.add_argument("--force-refetch", action="store_true")
    args = parser.parse_args()

    try:
        result = run_driver(
            output_root=Path(args.output_root),
            role_plan_file=Path(args.role_plan_file) if args.role_plan_file else None,
            result_path=Path(args.result_path) if args.result_path else None,
            summary_path=Path(args.summary_path) if args.summary_path else None,
            force_refetch=bool(args.force_refetch),
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception:
        traceback.print_exc()
        raise


if __name__ == "__main__":
    main()
