#!/usr/bin/env python3
"""dataset-fetcher — Phase 1 tabular data materializer.

Pulls tabular data files from DOI-registered open-data repositories
(Zenodo, Figshare, Dataverse, Mendeley Data, EnviDat, OSF) plus a
best-effort generic fallback. Normalises whatever it finds into the
standard on-disk bundle layout that the existing python_stats lab-runner
already understands:

    .research-lab/datasets/<cycle_id>/<dataset_slug>/
        manifest.json      ← per-CSV records (csv_path, columns, row_count, ...)
        csv/               ← normalised tabular files
        raw/               ← original downloads (preserved for traceability)

Phase 1 scope (per docs/data-fetcher-2026-04-28.md): tabular formats only —
csv, tsv, xlsx, parquet, json (1-d records), zip-of-the-above. Raster /
spatial / HDF5 are explicitly out of scope and surface as
``fetch_status: "skipped_unsupported"`` in the manifest.

Entry point::

    fetch_dataset(candidate, target_dir, *, max_bytes=...) -> dict

Returns a dict with ``status``, ``manifest``, ``bundle_path``, and an
``error`` field (``None`` on success). ``status`` is one of:

    "fetched"               at least one tabular file successfully normalised
    "skipped_unsupported"   no tabular file found (or only unsupported formats)
    "fetch_error"           transient I/O / HTTP failure; safe to retry next cycle

Never raises. The scout treats this as a soft-pipeline step — failures
record a manifest entry and the cycle continues.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


# ----------------------------------------------------------------------
# Constants

USER_AGENT = "ResearchLab-DatasetFetcher"
HTTP_CONNECT_TIMEOUT_SEC = 15.0
HTTP_LISTING_TIMEOUT_SEC = 30.0
DOWNLOAD_STALL_TIMEOUT_SEC = 3600.0  # abort only after 1 hour with no byte progress
HTTP_DOWNLOAD_TIMEOUT_SEC = DOWNLOAD_STALL_TIMEOUT_SEC  # backwards-compatible alias
DEFAULT_MAX_BYTES_PER_FILE = 20 * 1024 * 1024 * 1024   # 20 GiB
DEFAULT_MAX_BYTES_PER_BUNDLE = 20 * 1024 * 1024 * 1024  # 20 GiB
DEFAULT_MAX_FILES_PER_BUNDLE = 6
DOWNLOAD_PROGRESS_LOG_INTERVAL_SEC = 60.0

TABULAR_EXTENSIONS = {".csv", ".tsv", ".tab", ".txt", ".xlsx", ".parquet", ".json"}
ARCHIVE_EXTENSIONS = {".zip", ".gz"}
SUPPORTED_EXTENSIONS = TABULAR_EXTENSIONS | ARCHIVE_EXTENSIONS

# DOI prefix → adapter name. Generic fallback for anything else with a
# resolvable DOI / landing page.
DOI_PREFIX_ROUTING: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^10\.5281/zenodo\.\d+", re.IGNORECASE), "zenodo"),
    (re.compile(r"^10\.6084/m9\.figshare\.\d+", re.IGNORECASE), "figshare"),
    (re.compile(r"^10\.7910/dvn", re.IGNORECASE), "dataverse"),
    (re.compile(r"^10\.5072", re.IGNORECASE), "dataverse"),
    (re.compile(r"^10\.17632/[\w\.\-]+", re.IGNORECASE), "mendeley"),
    (re.compile(r"^10\.16904/envidat", re.IGNORECASE), "envidat"),
    (re.compile(r"^10\.17605/osf\.io", re.IGNORECASE), "osf"),
]

# Provider host detection for cases where the DOI doesn't help (e.g.,
# scout discovered via DDG and the URL is a direct repo link).
HOST_ROUTING: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"zenodo\.org", re.IGNORECASE), "zenodo"),
    (re.compile(r"figshare\.com", re.IGNORECASE), "figshare"),
    (re.compile(r"dataverse\.[a-z0-9.\-]+", re.IGNORECASE), "dataverse"),
    (re.compile(r"data\.mendeley\.com", re.IGNORECASE), "mendeley"),
    (re.compile(r"envidat\.ch", re.IGNORECASE), "envidat"),
    (re.compile(r"osf\.io", re.IGNORECASE), "osf"),
]


# ----------------------------------------------------------------------
# Helpers


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalise_doi(value: str | None) -> str:
    doi = (value or "").strip().lower()
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi)
    doi = re.sub(r"^doi:\s*", "", doi)
    return doi.strip().strip("/")


def _doi_cache_keys(value: str | None) -> set[str]:
    doi = _normalise_doi(value)
    if not doi:
        return set()
    keys = {doi}
    # Only collapse explicit version suffixes such as ``.v2`` or ``-v3``.
    # Do not strip a bare numeric tail: for repositories such as Zenodo the
    # final number is the record id, and collapsing ``10.5281/zenodo.20107202``
    # to ``10.5281/zenodo`` incorrectly reuses unrelated cached datasets.
    base = re.sub(r"([._-]v\d+)$", "", doi)
    if base and base != doi:
        keys.add(base)
    return keys


def _slug(value: str | None, fallback: str = "dataset") -> str:
    text = (value or fallback).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = re.sub(r"^-+|-+$", "", text)
    return text or fallback


def _http_request(url: str, *, accept: str = "application/json") -> dict | list | None:
    """GET a JSON resource. Returns parsed JSON or None on any failure."""
    req = urllib.request.Request(
        url,
        headers={"Accept": accept, "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_CONNECT_TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _set_response_read_timeout(resp: Any, timeout_sec: float) -> None:
    """Best-effort read timeout update for urllib HTTPResponse sockets."""
    candidates = [
        getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None),
        getattr(getattr(resp, "raw", None), "_sock", None),
        getattr(resp, "_sock", None),
    ]
    for sock in candidates:
        settimeout = getattr(sock, "settimeout", None)
        if callable(settimeout):
            try:
                settimeout(timeout_sec)
                return
            except OSError:
                return


def _is_timeout_error(exc: BaseException) -> bool:
    text = str(exc).lower()
    return isinstance(exc, TimeoutError) or "timed out" in text or "timeout" in text


def _http_download(url: str, dest: Path, max_bytes: int) -> tuple[bool, int, str | None]:
    """Stream a URL into *dest*. Returns (success, bytes_written, error).

    ``DOWNLOAD_STALL_TIMEOUT_SEC`` is an inactivity timeout, not a total
    file-duration timeout: every successful chunk write resets progress.
    The response is first written outside ``raw/`` and atomically moved into
    place so concurrent readers never inspect a partial archive.
    """
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT},
    )
    written = 0
    last_progress_at = time.monotonic()
    last_log_at = last_progress_at
    tmp_path: Path | None = None
    completed = False
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        staging_dir = dest.parent.parent / f".{dest.parent.name}-downloads"
        staging_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="wb",
            delete=False,
            dir=staging_dir,
            prefix=f".{dest.name}.",
            suffix=".part",
        ) as tmp_fh:
            tmp_path = Path(tmp_fh.name)
        with urllib.request.urlopen(req, timeout=HTTP_CONNECT_TIMEOUT_SEC) as resp:
            _set_response_read_timeout(resp, DOWNLOAD_STALL_TIMEOUT_SEC)
            with os.fdopen(os.open(tmp_path, os.O_WRONLY | os.O_TRUNC), "wb") as fh:
                while True:
                    try:
                        chunk = resp.read(64 * 1024)
                    except OSError as exc:
                        if _is_timeout_error(exc):
                            stalled_for = max(0, int(time.monotonic() - last_progress_at))
                            return False, written, f"download_stalled_no_progress:{stalled_for}s"
                        raise
                    if not chunk:
                        break
                    if written + len(chunk) > max_bytes:
                        return False, written, f"file_exceeds_max_bytes:{max_bytes}"
                    fh.write(chunk)
                    written += len(chunk)
                    last_progress_at = time.monotonic()
                    if last_progress_at - last_log_at >= DOWNLOAD_PROGRESS_LOG_INTERVAL_SEC:
                        print(
                            json.dumps({
                                "event": "download_progress",
                                "url": url,
                                "dest": str(dest),
                                "bytes_written": written,
                            }),
                            file=sys.stderr,
                            flush=True,
                        )
                        last_log_at = last_progress_at
        tmp_path.replace(dest)
        completed = True
        return True, written, None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if _is_timeout_error(reason):
            stalled_for = max(0, int(time.monotonic() - last_progress_at))
            return False, written, f"download_stalled_no_progress:{stalled_for}s"
        return False, written, str(exc)[:200]
    finally:
        if tmp_path is not None and not completed:
            try:
                if tmp_path.exists():
                    tmp_path.unlink()
            except Exception:
                pass
        try:
            staging_dir = dest.parent.parent / f".{dest.parent.name}-downloads"
            if staging_dir.exists():
                staging_dir.rmdir()
        except Exception:
            pass


def _atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _safe_read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _detect_extension(filename: str | None, content_type: str | None = None) -> str:
    """Best-effort file extension detection — prefer filename, fall back
    to MIME content-type. Returns lowercase extension with leading dot
    or empty string."""
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in SUPPORTED_EXTENSIONS:
            return suffix
    if content_type:
        ct = content_type.lower()
        if "csv" in ct:
            return ".csv"
        if "tab-separated" in ct or "tsv" in ct:
            return ".tsv"
        if "spreadsheet" in ct or "openxmlformats" in ct or ct.endswith("xlsx"):
            return ".xlsx"
        if "parquet" in ct:
            return ".parquet"
        if ct.startswith("application/json"):
            return ".json"
        if "zip" in ct:
            return ".zip"
    return Path(filename or "").suffix.lower()


# ----------------------------------------------------------------------
# Provider routing


def _classify_candidate(candidate: dict) -> tuple[str, dict]:
    """Return ``(provider, hints)`` where provider is one of the adapter
    names or "generic". hints carries provider-specific identifiers
    (record_id, doi, host) extracted up-front so the adapter doesn't
    need to re-parse."""
    accessions = candidate.get("accessions") or []
    doi = ""
    geo_accession = ""
    for acc in accessions:
        if not isinstance(acc, dict):
            continue
        repo = (acc.get("repository") or "").upper()
        value = str(acc.get("accession") or "").strip()
        if not value:
            continue
        if repo == "DOI" and not doi:
            doi = value
        elif repo == "GEO" and not geo_accession:
            geo_accession = value
    url = str(candidate.get("url") or "").strip()
    parsed_url = urllib.parse.urlparse(url) if url else urllib.parse.urlparse("")
    host = parsed_url.netloc.lower() if url else ""
    path = parsed_url.path.lower() if url else ""
    hints: dict = {
        "doi": doi,
        "url": url,
        "host": host,
        "geo_accession": geo_accession,
    }

    # NCBI GEO routing wins when a GEO accession is present — the
    # GEO Series file layout is well-known and stable, so a dedicated
    # adapter hits it directly without having to crawl an HTML
    # landing page like the generic fallback would.
    if geo_accession.upper().startswith("GSE"):
        return "ncbi_geo", hints
    if host.endswith("ncbi.nlm.nih.gov") and path.startswith("/geo/"):
        # URL-only path: extract the accession from ``?acc=GSEnnn``.
        from urllib.parse import parse_qs
        params = parse_qs(parsed_url.query)
        acc = (params.get("acc") or [""])[0].strip().upper()
        if acc.startswith("GSE"):
            hints["geo_accession"] = acc
            return "ncbi_geo", hints

    if doi:
        for pattern, name in DOI_PREFIX_ROUTING:
            if pattern.match(doi):
                return name, hints
    if host:
        for pattern, name in HOST_ROUTING:
            if pattern.search(host):
                return name, hints
    return "generic", hints


# ----------------------------------------------------------------------
# Provider adapters
#
# Each adapter receives ``hints`` plus the target raw directory. It
# returns a list of (raw_path, source_url, original_filename) tuples for
# files that were successfully downloaded. Non-tabular extensions are
# filtered here so the normaliser never sees them.


@dataclass
class _DownloadedFile:
    raw_path: Path
    source_url: str
    original_filename: str
    bytes_written: int


def _filter_to_tabular(files: list[dict]) -> list[dict]:
    """Given a list of {filename, url, ...} dicts, keep only tabular /
    archive extensions."""
    keep: list[dict] = []
    for f in files:
        ext = _detect_extension(f.get("filename"), f.get("content_type"))
        if ext in SUPPORTED_EXTENSIONS:
            f["_ext"] = ext
            keep.append(f)
    return keep


def _download_files(
    files: list[dict],
    raw_dir: Path,
    *,
    max_bytes_per_file: int,
    max_bytes_total: int,
    max_files: int,
) -> tuple[list[_DownloadedFile], list[dict]]:
    """Download a list of {filename, url, _ext} entries with the
    provided caps. Returns (downloaded, errors)."""
    downloaded: list[_DownloadedFile] = []
    errors: list[dict] = []
    total_bytes = 0
    for f in files[:max_files]:
        url = str(f.get("url") or "").strip()
        if not url:
            errors.append({"filename": f.get("filename"), "error": "missing_url"})
            continue
        original = str(f.get("filename") or Path(url).name or "file").strip() or "file"
        # Sanitise filename — never let it escape raw_dir
        safe_name = re.sub(r"[^A-Za-z0-9_.\-]+", "_", original).lstrip(".")
        if not safe_name:
            safe_name = f"file_{len(downloaded) + 1}{f.get('_ext') or ''}"
        dest = raw_dir / safe_name
        # Avoid collisions
        n = 1
        while dest.exists():
            dest = raw_dir / f"{Path(safe_name).stem}_{n}{Path(safe_name).suffix}"
            n += 1
        per_file_cap = min(max_bytes_per_file, max(0, max_bytes_total - total_bytes))
        if per_file_cap <= 0:
            errors.append({"filename": original, "error": "bundle_size_cap_reached"})
            continue
        ok, written, err = _http_download(url, dest, per_file_cap)
        if not ok:
            errors.append({"filename": original, "error": err or "download_failed"})
            try:
                if dest.exists():
                    dest.unlink()
            except Exception:
                pass
            continue
        total_bytes += written
        downloaded.append(_DownloadedFile(
            raw_path=dest,
            source_url=url,
            original_filename=original,
            bytes_written=written,
        ))
    return downloaded, errors


def _fetch_zenodo(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Zenodo: GET /api/records/<id> → files[].links.self."""
    record_id = ""
    m = re.search(r"zenodo\.(\d+)", hints.get("doi") or "", re.IGNORECASE)
    if m:
        record_id = m.group(1)
    else:
        m = re.search(r"zenodo\.org/record(?:s)?/(\d+)", hints.get("url") or "", re.IGNORECASE)
        if m:
            record_id = m.group(1)
    if not record_id:
        return [], [{"error": "zenodo_record_id_not_found"}]
    api = f"https://zenodo.org/api/records/{record_id}"
    payload = _http_request(api)
    if not isinstance(payload, dict):
        return [], [{"error": "zenodo_api_failed", "url": api}]
    files = []
    for f in payload.get("files") or []:
        if not isinstance(f, dict):
            continue
        link = (f.get("links") or {}).get("self") or f.get("download_url")
        if not link:
            continue
        files.append({
            "filename": f.get("key") or f.get("filename") or "",
            "url": link,
            "size": f.get("size"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _fetch_figshare(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Figshare: GET /v2/articles/<id>/files → download_url per file."""
    article_id = ""
    m = re.search(r"figshare\.(\d+)", hints.get("doi") or "", re.IGNORECASE)
    if m:
        article_id = m.group(1)
    else:
        m = re.search(r"figshare\.com/(?:articles|s)/[^/]+/(\d+)", hints.get("url") or "", re.IGNORECASE)
        if m:
            article_id = m.group(1)
    if not article_id:
        return [], [{"error": "figshare_article_id_not_found"}]
    api = f"https://api.figshare.com/v2/articles/{article_id}/files"
    payload = _http_request(api)
    if not isinstance(payload, list):
        return [], [{"error": "figshare_api_failed", "url": api}]
    files = []
    for f in payload:
        if not isinstance(f, dict):
            continue
        url = f.get("download_url") or f.get("supplied_md5")
        if not url:
            continue
        files.append({
            "filename": f.get("name") or "",
            "url": url,
            "size": f.get("size"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _fetch_dataverse(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Dataverse: GET <host>/api/datasets/:persistentId/?persistentId=<doi>."""
    doi = hints.get("doi") or ""
    if not doi:
        return [], [{"error": "dataverse_doi_required"}]
    host = hints.get("host") or "dataverse.harvard.edu"
    if not host or not host.startswith("dataverse."):
        host = "dataverse.harvard.edu"
    api = f"https://{host}/api/datasets/:persistentId/?persistentId=doi:{doi}"
    payload = _http_request(api)
    if not isinstance(payload, dict):
        return [], [{"error": "dataverse_api_failed", "url": api}]
    data = payload.get("data") or {}
    latest = data.get("latestVersion") or {}
    files = []
    for f in latest.get("files") or []:
        df = (f or {}).get("dataFile") or {}
        file_id = df.get("id")
        if not file_id:
            continue
        files.append({
            "filename": df.get("filename") or "",
            "url": f"https://{host}/api/access/datafile/{file_id}",
            "size": df.get("filesize"),
            "content_type": df.get("contentType"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _fetch_mendeley(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Mendeley Data: dataset id + version come from the DOI suffix."""
    m = re.search(r"10\.17632/([A-Za-z0-9\-]+)(?:\.(\d+))?$", hints.get("doi") or "", re.IGNORECASE)
    if not m:
        return [], [{"error": "mendeley_doi_parse_failed"}]
    dataset_id = m.group(1)
    version = m.group(2) or "1"
    api = f"https://data.mendeley.com/public-api/datasets/{dataset_id}/files?folder_id=root&version={version}"
    payload = _http_request(api)
    if not isinstance(payload, list):
        return [], [{"error": "mendeley_api_failed", "url": api}]
    files = []
    for f in payload:
        if not isinstance(f, dict):
            continue
        url = (f.get("content_details") or {}).get("download_url") or f.get("download_url")
        if not url:
            continue
        files.append({
            "filename": f.get("filename") or "",
            "url": url,
            "size": f.get("size"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _fetch_envidat(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """EnviDat: CKAN package_show by name (slugged from the DOI)."""
    m = re.search(r"envidat\.([\w\.\-]+)", hints.get("doi") or "", re.IGNORECASE)
    package = m.group(1) if m else ""
    if not package:
        # Try landing-page style
        m = re.search(r"envidat\.ch/.+?/metadata/([\w\.\-]+)", hints.get("url") or "", re.IGNORECASE)
        package = m.group(1) if m else ""
    if not package:
        return [], [{"error": "envidat_package_not_found"}]
    api = f"https://www.envidat.ch/api/3/action/package_show?id={urllib.parse.quote(package)}"
    payload = _http_request(api)
    if not isinstance(payload, dict) or not payload.get("success"):
        return [], [{"error": "envidat_api_failed", "url": api}]
    files = []
    for r in (payload.get("result") or {}).get("resources") or []:
        if not isinstance(r, dict):
            continue
        url = r.get("url")
        if not url:
            continue
        files.append({
            "filename": r.get("name") or Path(urllib.parse.urlparse(url).path).name or "",
            "url": url,
            "size": r.get("size"),
            "content_type": r.get("mimetype"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _fetch_osf(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """OSF: /v2/nodes/<id>/files/osfstorage/."""
    m = re.search(r"osf\.io/(\w{4,8})", hints.get("doi") or "", re.IGNORECASE)
    if not m:
        m = re.search(r"osf\.io/(\w{4,8})", hints.get("url") or "", re.IGNORECASE)
    if not m:
        return [], [{"error": "osf_node_id_not_found"}]
    node_id = m.group(1)
    api = f"https://api.osf.io/v2/nodes/{node_id}/files/osfstorage/"
    payload = _http_request(api)
    if not isinstance(payload, dict):
        return [], [{"error": "osf_api_failed", "url": api}]
    files = []
    for entry in payload.get("data") or []:
        attr = (entry or {}).get("attributes") or {}
        link = ((entry or {}).get("links") or {}).get("download")
        if not link or attr.get("kind") != "file":
            continue
        files.append({
            "filename": attr.get("name") or "",
            "url": link,
            "size": attr.get("size"),
        })
    return _download_files(_filter_to_tabular(files), raw_dir, **caps)


def _geo_bucket_for(accession: str) -> str:
    """GEO archive bucket for a Series accession.

    GSE40279  → GSE40nnn
    GSE285251 → GSE285nnn
    GSE100    → GSEnnn (only 3 digits)
    """
    accession = accession.strip().upper()
    if not accession.startswith("GSE"):
        return "GSEnnn"
    digits = accession[3:]
    if not digits.isdigit() or len(digits) <= 3:
        return "GSEnnn"
    return f"GSE{digits[:-3]}nnn"


def _fetch_ncbi_geo(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Fetch a GEO Series matrix file directly from NCBI's FTP/HTTPS
    mirror. The matrix file is the canonical tabular form of a GEO
    Series — a gzipped tab-separated text file with sample metadata
    in the header rows and feature × sample values in the body
    (e.g., methylation beta values, RNA-seq counts).

    URL pattern (stable for years):
        https://ftp.ncbi.nlm.nih.gov/geo/series/{bucket}/{acc}/matrix/{acc}_series_matrix.txt.gz

    Multi-platform Series have one matrix file per platform with
    suffix ``-GPL<N>``; we try the single-platform file first and fall
    back to listing the matrix directory if that 404s.

    Specialized archive matrices can routinely exceed the default
    per-file cap. The adapter raises the per-file ceiling and the
    per-bundle ceiling for this repository-specific format; the smaller
    global defaults still apply to every other adapter.
    """
    accession = (hints.get("geo_accession") or "").strip().upper()
    if not accession.startswith("GSE"):
        return [], [{"error": "ncbi_geo_no_accession"}]
    bucket = _geo_bucket_for(accession)
    series_base_url = f"https://ftp.ncbi.nlm.nih.gov/geo/series/{bucket}/{accession}/"
    base_url = series_base_url + "matrix/"
    primary_filename = f"{accession}_series_matrix.txt.gz"
    primary_url = base_url + primary_filename
    candidates = [{"filename": primary_filename, "url": primary_url}]

    geo_caps = {
        **caps,
        "max_bytes_per_file": max(caps.get("max_bytes_per_file", 0), 4 * 1024 * 1024 * 1024),
        "max_bytes_total": max(caps.get("max_bytes_total", 0), 8 * 1024 * 1024 * 1024),
    }
    downloaded, errors = _download_files(candidates, raw_dir, **geo_caps)

    # GEO Series Matrix files are often metadata-only for RNA-seq and
    # single-cell studies; the analyzable count/TPM/matrix files usually live
    # under the sibling ``suppl/`` directory.  Always inspect that directory as
    # well, even when the canonical matrix file exists, so downstream role
    # plans see real supplementary data rather than a fetched-but-unusable
    # metadata table.
    suppl_url = series_base_url + "suppl/"
    try:
        with urllib.request.urlopen(suppl_url, timeout=HTTP_CONNECT_TIMEOUT_SEC) as resp:
            _set_response_read_timeout(resp, HTTP_LISTING_TIMEOUT_SEC)
            suppl_html = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        errors.append({"error": "ncbi_geo_suppl_listing_failed", "url": suppl_url,
                       "exception": "".join(traceback.format_exception_only(type(exc), exc)).strip()})
        suppl_files: list[dict] = []
    else:
        suppl_files = []
        for href in re.findall(r'href="([^"]+)"', suppl_html, flags=re.IGNORECASE):
            filename = urllib.parse.unquote(href.split("?", 1)[0].rstrip("/"))
            if not filename or "/" in filename or filename in {".", ".."}:
                continue
            if _detect_extension(filename) not in SUPPORTED_EXTENSIONS:
                continue
            suppl_files.append({"filename": filename, "url": urllib.parse.urljoin(suppl_url, href)})
    if suppl_files:
        remaining_files = max(0, int(geo_caps.get("max_files", 0)) - len(downloaded))
        remaining_bytes = max(0, int(geo_caps.get("max_bytes_total", 0)) - sum(item.bytes_written for item in downloaded))
        if remaining_files > 0 and remaining_bytes > 0:
            extra, extra_errors = _download_files(
                _filter_to_tabular(suppl_files),
                raw_dir,
                max_bytes_per_file=geo_caps["max_bytes_per_file"],
                max_bytes_total=remaining_bytes,
                max_files=remaining_files,
            )
            downloaded.extend(extra)
            errors.extend(extra_errors)
        else:
            errors.append({"error": "ncbi_geo_suppl_cap_reached", "url": suppl_url})

    if downloaded:
        return downloaded, errors

    # Fall through: list the matrix directory and grab every .txt.gz
    # file (multi-platform Series put one per platform). Use a small
    # HTTP GET on the directory and pull hrefs out of the index page.
    try:
        with urllib.request.urlopen(base_url, timeout=HTTP_CONNECT_TIMEOUT_SEC) as resp:
            _set_response_read_timeout(resp, HTTP_LISTING_TIMEOUT_SEC)
            html = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        errors.append({"error": "ncbi_geo_dir_listing_failed", "url": base_url,
                       "exception": "".join(traceback.format_exception_only(type(exc), exc)).strip()})
        return [], errors
    href_pattern = re.compile(r'href="([^"]+_series_matrix\.txt\.gz)"', re.IGNORECASE)
    files: list[dict] = []
    for match in href_pattern.findall(html):
        files.append({"filename": match, "url": base_url + match})
    if not files:
        errors.append({"error": "ncbi_geo_matrix_not_found",
                       "bucket": bucket, "accession": accession,
                       "tried": [primary_url, base_url]})
        return [], errors
    return _download_files(files, raw_dir, **geo_caps)


def _fetch_generic(hints: dict, raw_dir: Path, **caps) -> tuple[list[_DownloadedFile], list[dict]]:
    """Best-effort fallback for arbitrary DOI / landing pages.

    Phase 1 keeps this conservative: try DOI content negotiation
    (request CSV / Excel directly via Accept header), and if the
    landing URL itself ends in a tabular extension, fetch it. Anything
    requiring HTML parsing of the landing page is deferred to Phase 2
    (Playwright fallback) to avoid pulling Playwright into the fetcher
    hot path.
    """
    candidates: list[dict] = []
    url = hints.get("url") or ""
    if url:
        ext = _detect_extension(Path(urllib.parse.urlparse(url).path).name)
        if ext in SUPPORTED_EXTENSIONS:
            candidates.append({"filename": Path(urllib.parse.urlparse(url).path).name, "url": url})
    doi = hints.get("doi") or ""
    if not candidates and doi:
        # DOI content negotiation — try direct https://doi.org/<doi> with
        # text/csv accept; servers that support it return the CSV directly,
        # others return the landing page (which we then ignore).
        resolver = f"https://doi.org/{doi}"
        candidates.append({
            "filename": f"{_slug(doi)}.csv",
            "url": resolver,
            "content_type": "text/csv",
        })
    if not candidates:
        return [], [{"error": "generic_no_candidate_url"}]
    return _download_files(_filter_to_tabular(candidates), raw_dir, **caps)


_PROVIDERS: dict[str, Any] = {
    "zenodo": _fetch_zenodo,
    "figshare": _fetch_figshare,
    "dataverse": _fetch_dataverse,
    "mendeley": _fetch_mendeley,
    "envidat": _fetch_envidat,
    "osf": _fetch_osf,
    "ncbi_geo": _fetch_ncbi_geo,
    "generic": _fetch_generic,
}


# ----------------------------------------------------------------------
# Normaliser

def _read_csv_to_csv(src: Path, dest: Path, sep: str | None = None) -> tuple[bool, dict]:
    """Round-trip a delimited file through pandas to normalise encoding
    and produce a manifest entry. Pandas is used both for the read
    (handles BOM, mixed encodings) and the write.

    When *sep* is None, the delimiter is auto-detected — many European
    or locale-specific CSVs use semicolons; defaulting to comma collapses
    them to a single column. We sniff the first ~8 KB for the dominant
    delimiter (``,`` / ``;`` / ``\\t`` / ``|``) before falling back to
    pandas' python engine sniff.
    """
    try:
        import pandas as pd  # imported lazily so the module loads in
                             # environments where pandas hasn't been
                             # installed yet.
    except ImportError:
        return False, {"error": "pandas_not_installed"}
    detected_sep = sep
    if detected_sep is None:
        try:
            sample = src.read_bytes()[:8192].decode("utf-8", errors="replace")
            counts = {d: sample.count(d) for d in (",", ";", "\t", "|")}
            best = max(counts.items(), key=lambda kv: kv[1])
            detected_sep = best[0] if best[1] > 0 else ","
        except Exception:
            detected_sep = ","
    try:
        df = pd.read_csv(src, sep=detected_sep, dtype=str, keep_default_na=False, encoding_errors="replace")
    except Exception as exc:
        return False, {"error": f"csv_read_failed:{exc}"[:200]}
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(dest, index=False)
    except Exception as exc:
        return False, {"error": f"csv_write_failed:{exc}"[:200]}
    return True, {
        "row_count": int(len(df)),
        "columns": [str(c) for c in df.columns][:200],
        "detected_delimiter": detected_sep,
    }


def _read_xlsx_to_csv(src: Path, dest_dir: Path) -> tuple[list[dict], dict]:
    try:
        import pandas as pd
    except ImportError:
        return _read_xlsx_to_csv_stdlib(src, dest_dir)
    try:
        sheets = pd.read_excel(src, sheet_name=None, dtype=str)
    except Exception as exc:
        return [], {"error": f"xlsx_read_failed:{exc}"[:200]}
    out: list[dict] = []
    base = src.stem
    for sheet_name, df in (sheets or {}).items():
        slug = _slug(f"{base}-{sheet_name}", base)
        dest = dest_dir / f"{slug}.csv"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            df.to_csv(dest, index=False)
        except Exception as exc:
            out.append({"sheet": sheet_name, "error": f"csv_write_failed:{exc}"[:200]})
            continue
        out.append({
            "name": slug,
            "csv_path": str(dest),
            "row_count": int(len(df)),
            "columns": [str(c) for c in df.columns][:200],
            "format_hint": "xlsx-sheet",
            "sheet": sheet_name,
        })
    return out, {}


def _xlsx_column_name(cell_ref: str) -> str:
    match = re.match(r"([A-Z]+)", cell_ref or "")
    letters = match.group(1) if match else ""
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - ord("A") + 1)
    return str(col or 1)


def _xlsx_col_index(cell_ref: str) -> int:
    match = re.match(r"([A-Z]+)", cell_ref or "")
    letters = match.group(1) if match else ""
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - ord("A") + 1)
    return max(0, col - 1)


def _xlsx_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except Exception:
        return []
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    strings: list[str] = []
    for si in root.findall(f"{ns}si"):
        parts = [node.text or "" for node in si.iter(f"{ns}t")]
        strings.append("".join(parts))
    return strings


def _xlsx_sheet_names(zf: zipfile.ZipFile) -> dict[str, str]:
    try:
        workbook = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    except Exception:
        return {"xl/worksheets/sheet1.xml": "sheet1"}
    rel_map = {
        rel.attrib.get("Id"): rel.attrib.get("Target", "")
        for rel in rels
        if rel.attrib.get("Id")
    }
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel_ns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    out: dict[str, str] = {}
    for sheet in workbook.findall(f"{ns}sheets/{ns}sheet"):
        name = sheet.attrib.get("name") or "sheet"
        rid = sheet.attrib.get(f"{rel_ns}id")
        target = rel_map.get(rid, "")
        if not target:
            continue
        path = target if target.startswith("xl/") else f"xl/{target.lstrip('/')}"
        out[path] = name
    return out or {"xl/worksheets/sheet1.xml": "sheet1"}
