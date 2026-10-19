

def _read_xlsx_to_csv_stdlib(src: Path, dest_dir: Path) -> tuple[list[dict], dict]:
    """Minimal XLSX reader for environments without pandas/openpyxl.

    Handles common worksheet XML with shared or inline strings. This is
    intentionally conservative but lets GEO supplementary .xlsx count
    matrices become CSV bundles instead of failing solely because pandas
    is absent from the runtime image.
    """
    out: list[dict] = []
    try:
        with zipfile.ZipFile(src) as zf:
            shared = _xlsx_shared_strings(zf)
            sheet_names = _xlsx_sheet_names(zf)
            ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
            for sheet_path, sheet_name in sheet_names.items():
                if sheet_path not in zf.namelist():
                    continue
                root = ET.fromstring(zf.read(sheet_path))
                rows: list[list[str]] = []
                max_cols = 0
                for row in root.findall(f".//{ns}sheetData/{ns}row"):
                    cells: dict[int, str] = {}
                    for cell in row.findall(f"{ns}c"):
                        idx = _xlsx_col_index(cell.attrib.get("r", ""))
                        cell_type = cell.attrib.get("t", "")
                        value = ""
                        if cell_type == "inlineStr":
                            value = "".join(node.text or "" for node in cell.iter(f"{ns}t"))
                        else:
                            v = cell.find(f"{ns}v")
                            value = v.text if v is not None and v.text is not None else ""
                            if cell_type == "s" and value.isdigit():
                                value = shared[int(value)] if int(value) < len(shared) else value
                        cells[idx] = value
                        max_cols = max(max_cols, idx + 1)
                    if cells:
                        rows.append([cells.get(i, "") for i in range(max_cols)])
                if not rows:
                    continue
                for row in rows:
                    row.extend([""] * (max_cols - len(row)))
                header = rows[0]
                if not any(str(item).strip() for item in header):
                    header = [_xlsx_column_name(chr(ord('A') + i) if i < 26 else str(i + 1)) for i in range(max_cols)]
                slug = _slug(f"{src.stem}-{sheet_name}", src.stem)
                dest = dest_dir / f"{slug}.csv"
                dest.parent.mkdir(parents=True, exist_ok=True)
                import csv
                with dest.open("w", newline="", encoding="utf-8") as fh:
                    writer = csv.writer(fh)
                    writer.writerow(header)
                    writer.writerows(rows[1:])
                out.append({
                    "name": slug,
                    "csv_path": str(dest),
                    "row_count": max(0, len(rows) - 1),
                    "columns": [str(c) for c in header][:200],
                    "format_hint": "xlsx-sheet-stdlib",
                    "sheet": sheet_name,
                })
    except Exception as exc:
        return [], {"error": f"xlsx_stdlib_read_failed:{exc}"[:200]}
    if not out:
        return [], {"error": "xlsx_no_readable_sheets"}
    return out, {}


def _read_parquet_to_csv(src: Path, dest: Path) -> tuple[bool, dict]:
    try:
        import pandas as pd
    except ImportError:
        return False, {"error": "pandas_not_installed"}
    try:
        df = pd.read_parquet(src)
    except Exception as exc:
        return False, {"error": f"parquet_read_failed:{exc}"[:200]}
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        df.astype(str).to_csv(dest, index=False)
    except Exception as exc:
        return False, {"error": f"csv_write_failed:{exc}"[:200]}
    return True, {
        "row_count": int(len(df)),
        "columns": [str(c) for c in df.columns][:200],
    }


def _read_json_to_csv(src: Path, dest: Path) -> tuple[bool, dict]:
    try:
        import pandas as pd
    except ImportError:
        return False, {"error": "pandas_not_installed"}
    try:
        with src.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except Exception as exc:
        return False, {"error": f"json_read_failed:{exc}"[:200]}
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        return False, {"error": "unsupported_json_shape"}
    try:
        df = pd.json_normalize(payload)
        dest.parent.mkdir(parents=True, exist_ok=True)
        df.to_csv(dest, index=False)
    except Exception as exc:
        return False, {"error": f"json_normalize_failed:{exc}"[:200]}
    return True, {
        "row_count": int(len(df)),
        "columns": [str(c) for c in df.columns][:200],
    }


def _is_zip_sidecar_member(member: str) -> bool:
    stem = Path(member).stem.lower()
    return stem in {"readme", "read_me", "license", "licence", "citation", "citations"}


def _slice_geo_series_matrix(src: Path, csv_dir: Path) -> tuple[dict | None, dict]:
    """Carve the data table out of a GEO Series matrix .txt file and
    write it as a plain CSV. Also writes a sidecar JSON with the
    ``!Series_*`` / ``!Sample_*`` header metadata so downstream
    consumers retain experimental context (e.g., the per-sample age
    annotations a methylation aging hypothesis depends on).

    Returns ``(manifest_entry, info)`` — manifest_entry is None when
    the file does not look like a series matrix, in which case the
    caller falls back to its normal tab-separated path.
    """
    try:
        import pandas as pd
    except ImportError:
        return None, {"error": "pandas_not_installed"}

    table_lines: list[str] = []
    metadata_lines: list[str] = []
    in_table = False
    saw_marker = False
    try:
        with src.open("r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.rstrip("\n").rstrip("\r")
                if not in_table:
                    if line.startswith("!series_matrix_table_begin"):
                        in_table = True
                        saw_marker = True
                        continue
                    if line.startswith("^") or line.startswith("!"):
                        metadata_lines.append(line)
                        continue
                else:
                    if line.startswith("!series_matrix_table_end"):
                        break
                    if line:
                        table_lines.append(line)
    except Exception as exc:
        return None, {"error": f"geo_matrix_read_failed:{exc}"[:200]}

    if not saw_marker:
        # Not a GEO series matrix — let the caller try plain TSV.
        return None, {}

    if not table_lines:
        return None, {"error": "geo_matrix_table_empty"}

    base_slug = _slug(src.stem, "geo-matrix")
    csv_path = csv_dir / f"{base_slug}.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)

    # Reparse the table block via pandas so encoding / quoting
    # quirks get normalised consistently with the other adapters.
    import io
    buf = io.StringIO("\n".join(table_lines))
    try:
        df = pd.read_csv(buf, sep="\t", low_memory=False)
        df.to_csv(csv_path, index=False)
    except Exception as exc:
        return None, {"error": f"geo_matrix_pandas_failed:{exc}"[:200]}

    # Persist the metadata header alongside the CSV so analyst lanes
    # can read the per-sample annotations without re-downloading.
    if metadata_lines:
        meta_path = csv_dir / f"{base_slug}.geo-metadata.txt"
        try:
            meta_path.write_text("\n".join(metadata_lines), encoding="utf-8")
        except Exception:
            meta_path = None  # best-effort
    else:
        meta_path = None

    return {
        "name": base_slug,
        "kind": "indicator",
        "csv_path": str(csv_path),
        "raw_path": str(src),
        "row_count": int(len(df)),
        "columns": [str(c) for c in df.columns][:200],
        "format_hint": "geo-series-matrix",
        "fetch_status": "fetched",
        "geo_metadata_sidecar": str(meta_path) if meta_path else None,
    }, {}


def _normalize_file(src: Path, csv_dir: Path) -> list[dict]:
    """Convert a single raw file into one or more manifest entries.
    Returns at least one entry per non-empty result, with status fields.
    Entries always carry ``raw_path`` so traceability survives."""
    ext = src.suffix.lower()
    base_slug = _slug(src.stem, "dataset")

    if ext in {".csv"}:
        dest = csv_dir / f"{base_slug}.csv"
        # sep=None → auto-detect (handles ;-delimited European CSVs).
        ok, info = _read_csv_to_csv(src, dest, sep=None)
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": "csv",
                "fetch_status": "fetched",
            }]
        return [{"name": base_slug, "raw_path": str(src), "format_hint": "csv",
                 "fetch_status": "normalize_error", "error": info.get("error")}]

    if ext in {".tsv"}:
        dest = csv_dir / f"{base_slug}.csv"
        ok, info = _read_csv_to_csv(src, dest, sep="\t")
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": "tsv",
                "fetch_status": "fetched",
            }]
        return [{"name": base_slug, "raw_path": str(src), "format_hint": "tsv",
                 "fetch_status": "normalize_error", "error": info.get("error")}]

    if ext in {".xlsx"}:
        sheets, err = _read_xlsx_to_csv(src, csv_dir)
        if not sheets:
            return [{"name": base_slug, "raw_path": str(src), "format_hint": "xlsx",
                     "fetch_status": "normalize_error", "error": err.get("error", "no_sheets")}]
        for s in sheets:
            s["raw_path"] = str(src)
            s.setdefault("kind", "indicator")
            s.setdefault("fetch_status", "fetched")
        return sheets

    if ext in {".parquet"}:
        dest = csv_dir / f"{base_slug}.csv"
        ok, info = _read_parquet_to_csv(src, dest)
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": "parquet",
                "fetch_status": "fetched",
            }]
        return [{"name": base_slug, "raw_path": str(src), "format_hint": "parquet",
                 "fetch_status": "normalize_error", "error": info.get("error")}]

    if ext in {".json"}:
        dest = csv_dir / f"{base_slug}.csv"
        ok, info = _read_json_to_csv(src, dest)
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": "json-records",
                "fetch_status": "fetched",
            }]
        return [{"name": base_slug, "raw_path": str(src), "format_hint": "json",
                 "fetch_status": "skipped_unsupported", "error": info.get("error")}]

    # GEO Series matrix files have a non-standard layout: a long
    # header of ``^`` and ``!`` metadata lines, then a marker
    # ``!series_matrix_table_begin`` followed by the actual TSV data
    # block, terminated by ``!series_matrix_table_end``. A naive
    # pd.read_csv on the whole file collapses because the metadata
    # lines have inconsistent column counts. Detect this layout up
    # front and slice out just the data block before normalising.
    if ext in {".tab", ".txt"} and src.name.lower().endswith("_series_matrix.txt"):
        sliced, info = _slice_geo_series_matrix(src, csv_dir)
        if sliced:
            return [sliced]
        # If slicing did not apply, fall through to the normal
        # tab-separated path below; the caller still gets a CSV (or
        # a normalize_error entry) without a special-case branch.
        if info.get("error"):
            return [{"name": base_slug, "raw_path": str(src),
                     "format_hint": "geo-matrix",
                     "fetch_status": "normalize_error",
                     "error": info.get("error")}]

    # .tab and .txt are treated as tab-separated by default — this covers
    # the canonical NCBI GEO series-matrix format and many supplementary
    # files. Auto-detect ``;`` / ``,`` / ``|`` as a
    # fallback for files that mis-use these extensions.
    if ext in {".tab", ".txt"}:
        dest = csv_dir / f"{base_slug}.csv"
        ok, info = _read_csv_to_csv(src, dest, sep="\t")
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": ext.lstrip("."),
                "fetch_status": "fetched",
            }]
        # Fall back to delimiter sniffing before declaring a failure.
        ok, info = _read_csv_to_csv(src, dest, sep=None)
        if ok:
            return [{
                "name": base_slug,
                "kind": "indicator",
                "csv_path": str(dest),
                "raw_path": str(src),
                "row_count": info["row_count"],
                "columns": info["columns"],
                "format_hint": ext.lstrip("."),
                "fetch_status": "fetched",
            }]
        return [{"name": base_slug, "raw_path": str(src), "format_hint": ext.lstrip("."),
                 "fetch_status": "normalize_error", "error": info.get("error")}]

    # .gz: decompress to a temp file, derive the inner extension from
    # the doubled suffix (``foo.txt.gz`` → ``.txt``), and recurse.
    if ext == ".gz":
        try:
            import gzip as _gzip
            inner_name = src.stem  # strip .gz
            inner_path = src.with_suffix("")  # writes alongside raw/
            with _gzip.open(src, "rb") as gf, inner_path.open("wb") as out:
                while True:
                    chunk = gf.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        except Exception as exc:
            return [{"name": base_slug, "raw_path": str(src), "format_hint": "gz",
                     "fetch_status": "normalize_error",
                     "error": f"gunzip_failed:{exc}"[:200]}]
        sub = _normalize_file(inner_path, csv_dir)
        for entry in sub:
            entry["raw_path"] = str(src)
            entry["gunzipped_to"] = str(inner_path)
        return sub

    if ext in {".zip"}:
        results: list[dict] = []
        try:
            with zipfile.ZipFile(src) as zf:
                with tempfile.TemporaryDirectory() as tmp:
                    tmp_dir = Path(tmp)
                    for member in zf.namelist():
                        if _is_zip_sidecar_member(member):
                            continue
                        member_ext = Path(member).suffix.lower()
                        if member_ext not in TABULAR_EXTENSIONS:
                            continue
                        try:
                            extracted = Path(zf.extract(member, tmp_dir))
                        except Exception as exc:
                            results.append({
                                "raw_path": str(src), "format_hint": "zip-member",
                                "fetch_status": "normalize_error",
                                "error": f"zip_extract_failed:{exc}"[:200],
                            })
                            continue
                        # Recurse with the extracted path
                        sub = _normalize_file(extracted, csv_dir)
                        for entry in sub:
                            entry["raw_path"] = str(src)
                            entry["zip_member"] = member
                        results.extend(sub)
        except Exception as exc:
            return [{"name": base_slug, "raw_path": str(src), "format_hint": "zip",
                     "fetch_status": "normalize_error",
                     "error": f"zip_open_failed:{exc}"[:200]}]
        if not results:
            return [{"name": base_slug, "raw_path": str(src), "format_hint": "zip",
                     "fetch_status": "skipped_unsupported",
                     "error": "no_tabular_members"}]
        return results

    return [{"name": base_slug, "raw_path": str(src), "format_hint": ext.lstrip(".") or "unknown",
             "fetch_status": "skipped_unsupported"}]


# ----------------------------------------------------------------------
# Public entry point


def _try_reuse_cached_bundle(candidate: dict, hints: dict, target_dir: Path) -> dict | None:
    """Materialise an already-fetched DOI bundle into the current cycle.

    This preserves cycle isolation: downstream lanes only see files under
    the current cycle's bundle path. The cache key is the repository DOI,
    not a domain-specific provider rule.
    """
    wanted_keys = _doi_cache_keys(hints.get("doi"))
    if not wanted_keys:
        return None
    try:
        datasets_root = target_dir.parent.parent
    except Exception:
        return None
    if not datasets_root.is_dir() or datasets_root.name != "datasets":
        return None

    manifest_path = target_dir / "manifest.json"
    csv_dir = target_dir / "csv"
    for cached_manifest_path in sorted(datasets_root.glob("*/*/manifest.json")):
        if cached_manifest_path == manifest_path:
            continue
        cached_summary = _safe_read_json(cached_manifest_path)
        if not isinstance(cached_summary, dict):
            continue
        if cached_summary.get("status") != "fetched":
            continue
        cached_keys = _doi_cache_keys(cached_summary.get("candidate_doi"))
        if not wanted_keys.intersection(cached_keys):
            continue

        copied_manifest: list[dict] = []
        for entry in cached_summary.get("manifest") or []:
            if not isinstance(entry, dict):
                continue
            if entry.get("fetch_status") != "fetched" or not entry.get("csv_path"):
                continue
            source_csv = Path(str(entry.get("csv_path")))
            if not source_csv.is_file():
                continue
            destination_csv = csv_dir / source_csv.name
            stem = destination_csv.stem
            suffix = destination_csv.suffix
            collision = 1
            while destination_csv.exists() and source_csv.resolve() != destination_csv.resolve():
                destination_csv = csv_dir / f"{stem}_{collision}{suffix}"
                collision += 1
            if source_csv.resolve() != destination_csv.resolve():
                shutil.copy2(source_csv, destination_csv)
            copied_entry = dict(entry)
            copied_entry["csv_path"] = str(destination_csv)
            copied_entry["cache_source_csv_path"] = str(source_csv)
            copied_entry["cache_source_bundle_path"] = cached_summary.get("bundle_path")
            copied_manifest.append(copied_entry)

        if not copied_manifest:
            continue

        provider = cached_summary.get("provider") or hints.get("provider")
        summary = {
            "status": "fetched",
            "provider": provider,
            "bundle_path": str(target_dir),
            "manifest_path": str(manifest_path),
            "downloaded_count": 0,
            "csv_count": len(copied_manifest),
            "errors": [],
            "manifest": copied_manifest,
            "candidate_doi": hints.get("doi") or cached_summary.get("candidate_doi") or None,
            "candidate_url": hints.get("url") or cached_summary.get("candidate_url") or None,
            "candidate_title": candidate.get("title") or cached_summary.get("candidate_title") or None,
            "candidate_accessions": candidate.get("accessions") or cached_summary.get("candidate_accessions") or [],
            "cache_reused": True,
            "cache_source_manifest_path": str(cached_manifest_path),
            "cache_source_bundle_path": cached_summary.get("bundle_path"),
            "completed_at": _now_iso(),
        }
        _atomic_write_json(manifest_path, summary)
        return summary

    return None


def fetch_dataset(
    candidate: dict,
    target_dir: Path,
    *,
    max_bytes_per_file: int = DEFAULT_MAX_BYTES_PER_FILE,
    max_bytes_per_bundle: int = DEFAULT_MAX_BYTES_PER_BUNDLE,
    max_files: int = DEFAULT_MAX_FILES_PER_BUNDLE,
) -> dict:
    """Materialise a dataset candidate into *target_dir*.

    *target_dir* will be created (with raw/ and csv/ subdirs) and a
    ``manifest.json`` written. Returns a status dict shaped::

        {
          "status": "fetched" | "skipped_unsupported" | "fetch_error",
          "bundle_path": "<absolute target_dir>",
          "manifest_path": "<absolute manifest path>",
          "manifest": [...entries...],
          "downloaded_count": <int>,
          "csv_count": <int>,
          "errors": [...],
          "provider": "<name>",
          "completed_at": "<iso ts>",
        }

    Never raises. All failures degrade to status fields.
    """
    target_dir = Path(target_dir)
    raw_dir = target_dir / "raw"
    csv_dir = target_dir / "csv"
    raw_dir.mkdir(parents=True, exist_ok=True)
    csv_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = target_dir / "manifest.json"

    provider, hints = _classify_candidate(candidate)
    cached_summary = _try_reuse_cached_bundle(candidate, hints, target_dir)
    if cached_summary is not None:
        return cached_summary

    adapter = _PROVIDERS.get(provider, _fetch_generic)
    caps = {
        "max_bytes_per_file": max_bytes_per_file,
        "max_bytes_total": max_bytes_per_bundle,
        "max_files": max_files,
    }

    downloaded: list[_DownloadedFile] = []
    errors: list[dict] = []
    try:
        downloaded, errors = adapter(hints, raw_dir, **caps)
    except Exception as exc:  # noqa: BLE001 — fetcher must never raise
        errors.append({
            "error": "adapter_exception",
            "provider": provider,
            "exception": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
        })

    manifest: list[dict] = []
    normalized_raw: set[str] = set()
    for f in downloaded:
        entries = _normalize_file(f.raw_path, csv_dir)
        normalized_raw.add(str(Path(f.raw_path).resolve()))
        for entry in entries:
            entry.setdefault("source_url", f.source_url)
            entry.setdefault("original_filename", f.original_filename)
            entry["bytes_written"] = f.bytes_written
            manifest.append(entry)

    # Idempotent raw-dir sweep: some real data lands in raw/ outside the
    # adapter's `downloaded` list (e.g. GEO supplementary .xlsx fetched by a
    # sibling path, or files left by a prior partial run). If a tabular raw
    # file was never normalised, the analysis-visible csv/ dir can end up with
    # only manifest/file-list CSVs while the actual expression/proteomics
    # matrix sits unconverted — the dominant cause of master-table build
    # failures. Convert any such leftover so the source of truth reaches csv/.
    seen_raw_paths = {
        str(Path(e["raw_path"]).resolve())
        for e in manifest
        if e.get("raw_path")
    }
    try:
        raw_candidates = sorted(p for p in raw_dir.iterdir() if p.is_file())
    except Exception:
        raw_candidates = []
    for raw_file in raw_candidates:
        resolved = str(raw_file.resolve())
        if resolved in normalized_raw or resolved in seen_raw_paths:
            continue
        if _detect_extension(raw_file.name) not in TABULAR_EXTENSIONS:
            continue
        for entry in _normalize_file(raw_file, csv_dir):
            entry.setdefault("source_url", None)
            entry.setdefault("original_filename", raw_file.name)
            entry["recovered_from_raw_sweep"] = True
            manifest.append(entry)

    csv_count = sum(1 for e in manifest if e.get("fetch_status") == "fetched" and e.get("csv_path"))
    if csv_count > 0:
        # usable CSVs were produced — whether from the adapter's downloads or
        # recovered by the raw-dir sweep — so the dataset is fetched.
        status = "fetched"
    elif not downloaded:
        status = "fetch_error" if errors else "skipped_unsupported"
    else:
        # Files came down but none normalised to CSV
        status = "skipped_unsupported"

    summary = {
        "status": status,
        "provider": provider,
        "bundle_path": str(target_dir),
        "manifest_path": str(manifest_path),
        "downloaded_count": len(downloaded),
        "csv_count": csv_count,
        "errors": errors,
        "manifest": manifest,
        "candidate_doi": hints.get("doi") or None,
        "candidate_url": hints.get("url") or None,
        "candidate_title": candidate.get("title") or None,
        "candidate_accessions": candidate.get("accessions") or [],
        "completed_at": _now_iso(),
    }
    _atomic_write_json(manifest_path, summary)
    return summary


# ----------------------------------------------------------------------
# CLI (for standalone testing / smoke runs)

def _main() -> int:
    parser = argparse.ArgumentParser(description="Fetch a dataset candidate into a bundle directory.")
    parser.add_argument("--target-dir", required=True, help="Bundle root directory (raw/, csv/, manifest.json will be written here)")
    parser.add_argument("--doi", help="DOI (e.g. 10.5281/zenodo.123456)")
    parser.add_argument("--url", help="Landing or direct file URL")
    parser.add_argument("--max-bytes-per-file", type=int, default=DEFAULT_MAX_BYTES_PER_FILE)
    parser.add_argument("--max-bytes-per-bundle", type=int, default=DEFAULT_MAX_BYTES_PER_BUNDLE)
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES_PER_BUNDLE)
    args = parser.parse_args()

    if not args.doi and not args.url:
        parser.error("provide at least --doi or --url")

    candidate: dict = {
        "url": args.url,
        "accessions": [{"repository": "DOI", "accession": args.doi}] if args.doi else [],
    }
    summary = fetch_dataset(
        candidate,
        Path(args.target_dir),
        max_bytes_per_file=args.max_bytes_per_file,
        max_bytes_per_bundle=args.max_bytes_per_bundle,
        max_files=args.max_files,
    )
    # Trim manifest in stdout summary so logs don't blow up
    out = {k: v for k, v in summary.items() if k != "manifest"}
    out["manifest_count"] = len(summary["manifest"])
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(_main())
