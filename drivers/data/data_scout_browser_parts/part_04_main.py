

# ----------------------------------------------------------------------
# Main

def _probe_data_query(query: str, max_candidates: int = 8) -> dict:
    """Single-query PROBE mode: run ONE dataset/benchmark query across the
    multi-domain registries and return candidates as JSON. This is the retrieval
    primitive the reasoning (codex-agent) data scout calls to author queries
    iteratively (probe -> read -> refine). Registry-only (no browser fetch, no
    role-plan pipeline), so it is fast and side-effect free."""
    probe_registries = [
        ("datacite", _search_datacite),
        ("zenodo", _search_zenodo),
        ("figshare", _search_figshare),
        ("huggingface", _search_huggingface),
        ("paperswithcode", _search_paperswithcode),
    ]
    candidates: list[dict] = []
    hits_by_source: dict[str, int] = {}
    failures: list[dict] = []
    for source_name, search_fn in probe_registries:
        try:
            raw = search_fn(query, max_candidates)
        except Exception as exc:  # pylint: disable=broad-except
            failures.append({"source": source_name, "error": str(exc)[:160]})
            continue
        hits = [h for h in raw if _hit_passes_relevance(h, query)]
        hits_by_source[source_name] = len(hits)
        for h in hits:
            candidates.append({
                "title": h.get("title"),
                "url": h.get("url"),
                "source": source_name,
                "doi": h.get("datacite_doi") or None,
                "description": (h.get("datacite_description") or h.get("description") or "")[:240],
            })
    return {
        "query": query,
        "candidate_count": len(candidates),
        "source_hits": hits_by_source,
        "source_failures": failures,
        "candidates": candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir")
    parser.add_argument("--runtime-root")
    parser.add_argument("--cycle-id")
    parser.add_argument("--role-plan-file")
    parser.add_argument(
        "--query",
        help="Single-query PROBE mode: run one dataset/benchmark query across the "
        "multi-domain registries and print candidates as JSON to stdout (for a "
        "reasoning agent to refine). Skips the role-plan pipeline; other args not required.",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Registry-only: skip the Playwright/DuckDuckGo browser fallback and "
        "the reference-paper web pass. Used when the driver is invoked from a "
        "codex-agent lane (the browser's tty/stdin handling fails under codex "
        "exec_command); the keyless multi-domain registries are the primary source.",
    )
    # Default raised from 5 → 12 so the multi-variant query generator
    # (gene-only / gene+concept / concept-only / family-tag /
    # compact-pair) plus accession-shaped specs all get registry
    # round-trips. The earlier cap throttled out at the first
    # variant's three suffix expansions, leaving GSE / DOI specs at
    # the back of the queue silent.
    parser.add_argument("--max-queries", type=int, default=12)
    parser.add_argument("--max-candidates-per-query", type=int, default=6)
    parser.add_argument("--per-page-timeout", type=int, default=20)
    # Phase 1 data fetcher (Phase 1 of docs/data-fetcher-2026-04-28.md):
    # after discovering candidate URLs, attempt to materialise the
    # tabular ones into on-disk bundles under
    # ``<runtime>/datasets/<cycle_id>/<slug>/``. Disable with
    # ``--no-fetch`` (used by smoke tests that should not hit external
    # repositories).
    parser.add_argument(
        "--fetch",
        dest="fetch_enabled",
        action="store_true",
        default=True,
        help="Fetch tabular files from open-data repositories after discover/verify (default: on).",
    )
    parser.add_argument(
        "--no-fetch",
        dest="fetch_enabled",
        action="store_false",
        help="Skip the file-materialisation step (discover-and-verify only).",
    )
    parser.add_argument("--max-fetched-datasets", type=int, default=4,
                        help="Cap on the number of candidates to attempt fetching per scout pass.")
    args = parser.parse_args()

    if args.query:
        print(json.dumps(_probe_data_query(args.query), ensure_ascii=False, indent=2))
        return 0
    if not (args.output_dir and args.runtime_root and args.cycle_id):
        parser.error("--output-dir, --runtime-root, --cycle-id are required unless --query (probe mode) is used")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    runtime_root = Path(args.runtime_root)
    cycle_id = args.cycle_id
    state_dir = runtime_root / "state"
    data_request_path = state_dir / f"{cycle_id}-data-request.json"
    data_graph_path = state_dir / f"{cycle_id}-data-graph.json"
    completion_path = state_dir / f"{cycle_id}-data-acquisition-completed.json"
    result_path = output_dir / "result.json"
    driver_timeout_env = os.environ.get("RESEARCHLAB_EXTERNAL_DRIVER_TIMEOUT_SECONDS")
    try:
        driver_timeout_seconds = int(driver_timeout_env) if driver_timeout_env else 0
    except Exception:
        driver_timeout_seconds = 0
    driver_deadline = None
    if driver_timeout_seconds > 0:
        driver_deadline = time.monotonic() + max(15, driver_timeout_seconds - 8)

    def _time_budget_exhausted() -> bool:
        return driver_deadline is not None and time.monotonic() >= driver_deadline

    role_plan = _safe_read_json(Path(args.role_plan_file)) if args.role_plan_file else None
    lane_id = (role_plan or {}).get("lane_id") or "followup-scout-data"
    forbidden_dataset_terms = _forbidden_dataset_terms_from_role_plan(role_plan)

    # Prefer an explicit data-request.json artefact when lab-director emits
    # one; otherwise fall back to whatever the dispatch role_plan says,
    # so the scout still does useful work when called purely by
    # chronicle's recommended_action pathway.
    if data_request_path.is_file():
        data_request = _safe_read_json(data_request_path) or {}
        request_source = "data-request.json"
    elif role_plan:
        data_request = _data_request_from_role_plan(role_plan)
        request_source = "role_plan"
        # v31 lesson: when a data_acquisition_followup runs, the role
        # plan's ``objective`` is the cycle's generic 8-hour boilerplate;
        # the actual biology-specific seed lives in the lab-director
        # hypothesis emitted earlier in the same cycle. Pull its
        # statement + primary_family and inject as the highest-priority
        # spec so registry queries hit the actual prompt domain
        # ("ELOVL2 methylation cohort") rather than the meta-objective
        # text ("Run a sustained multi-agent research cycle ...").
        director_hypothesis = _load_lab_director_hypothesis(runtime_root, cycle_id)
        if isinstance(director_hypothesis, dict):
            statement = str(director_hypothesis.get("statement") or "").strip()
            # primary_family can be a plain string or a nested dict
            # (newer lab-director schema). Prefer label / id when it's
            # a dict; coerce to string when it's already one.
            pf_raw = director_hypothesis.get("primary_family")
            if isinstance(pf_raw, dict):
                primary_family = str(
                    pf_raw.get("label") or pf_raw.get("id") or ""
                ).strip()
            else:
                primary_family = str(pf_raw or "").strip()
            # Multiple query variants — different registries rank
            # different shapes (gene-only vs gene+concept vs
            # concept-only) very differently, so a hypothesis gets
            # several independent chances at a hit instead of relying
            # on a single seed.
            variants = _build_query_variants(statement, primary_family)
            specs = data_request.setdefault("required_dataset_specs", [])
            # IMPORTANT: variants insert AFTER any accession-shaped
            # spec the identifier extractor already prepended. The
            # bare accession (GSE40279, 10.5281/zenodo.X, …) is the
            # most discriminative query the registries can index, so
            # it must reach the registry round-trip before
            # multi-token prose variants exhaust the per-pass query
            # budget. We insert at the position right after the
            # already-existing accession specs (which the identifier
            # extractor in _data_request_from_role_plan put at the
            # top).
            insert_at = sum(
                1 for spec in specs
                if isinstance(spec, dict)
                and isinstance(spec.get("topic"), str)
                and any(ch.isdigit() for ch in spec["topic"])
                and len(spec["topic"].split()) <= 1
            )
            for offset, variant in enumerate(variants):
                specs.insert(insert_at + offset, {"topic": variant})
            # Also surface explicit dataset labels named in the
            # hypothesis. The lab-director schema is not stable —
            # ``open_datasets`` may live under identification_strategy,
            # primary_family, or nested deeper — so walk the tree
            # once and collect every occurrence.
            def _collect_open_datasets(value):
                acc = []
                if isinstance(value, dict):
                    if isinstance(value.get("open_datasets"), list):
                        acc.extend(value["open_datasets"])
                    for v in value.values():
                        acc.extend(_collect_open_datasets(v))
                elif isinstance(value, list):
                    for v in value:
                        acc.extend(_collect_open_datasets(v))
                return acc

            seen_labels = set()
            for ds in _collect_open_datasets(director_hypothesis)[:12]:
                label = ""
                dsid = ""
                if isinstance(ds, dict):
                    label = str(
                        ds.get("label")
                        or ds.get("name")
                        or ds.get("accession")
                        or ""
                    ).strip()
                    dsid = str(
                        ds.get("dataset_id")
                        or ds.get("id")
                        or ""
                    ).strip()
                elif isinstance(ds, str):
                    label = ds.strip()
                for token in (label, dsid):
                    if token and token.lower() not in seen_labels:
                        seen_labels.add(token.lower())
                        data_request.setdefault("required_dataset_specs", []).append({"topic": token})
    else:
        payload = {
            "status": "skipped",
            "reason": "neither data-request.json nor role_plan available",
            "driver": "data-scout-browser",
            "cycle_id": cycle_id,
            "candidate_count": 0,
            "candidates": [],
        }
        _atomic_write_json(result_path, payload)
        _atomic_write_json(completion_path, {
            "cycle_id": cycle_id,
            "status": "skipped",
            "reason": "no data request or role_plan",
            "completed_at": _now_iso(),
        })
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    queries = [
        query for query in _build_queries(data_request, args.max_queries)
        if not _contains_forbidden_dataset_term(query, forbidden_dataset_terms)
    ]

# Open-data registry backends in priority order. DataCite first (best
    # coverage of DOI-registered datasets across every discipline),
    # then per-platform direct APIs that catch records DataCite has not
    # harvested yet or that were registered without a DataCite DOI.
    # Each entry is (discovery_source, search_function). Failures in one
    # backend never stop the others — _http_get_json returns None and
    # the per-query loop just records a 0 count for that source.
    BROAD_REGISTRIES: list[tuple[str, "callable"]] = [
        ("datacite", _search_datacite),
        ("zenodo", _search_zenodo),
        ("figshare", _search_figshare),
        ("openaire", _search_openaire),
        ("osf", _search_osf),
        ("dryad", _search_dryad),
        ("dataverse", _search_dataverse),
        ("huggingface", _search_huggingface),
        ("paperswithcode", _search_paperswithcode),
        ("re3data", _search_re3data),
    ]
    # Specialized archives are useful when the request explicitly names
    # their repository or accession identifiers, but querying them for
    # every generic topic would reintroduce a domain-specific search bias.
    SPECIALIZED_REGISTRIES: list[tuple[str, "callable"]] = [
        ("ncbi_geo", _search_ncbi_geo),
        ("ebi_biostudies", _search_ebi_biostudies),
        ("ebi_ena", _search_ebi_ena),
    ]
    # User-supplied extra registries (drivers/data/extra_registries.json
    # and / or $RESEARCHLAB_EXTRA_REGISTRIES). Appended last so they
    # do not displace the built-in coverage but still get every query.
    EXTRA_REGISTRIES = _load_extra_registries()

    # Thin post-filter: keep only hits whose title/description contains
    # a substantive query keyword. The helper deliberately ignores broad
    # research boilerplate so unrelated open-data records do not become
    # false-positive fetched bundles.

    def _hit_to_candidate(hit: dict, *, query: str, source: str, lane: str) -> dict:
        cand = {
            "title": hit.get("title"),
            "url": hit.get("url"),
            "matched_query": query,
            "lane_id": lane,
            "discovery_source": source,
            # All registry-sourced candidates are treated as "open"
            # because the backend already filters to publicly listable
            # records. The verification_method tag records which path
            # produced the candidate so downstream lanes can audit.
            "access_status": "open",
            "verification_method": f"{source}_registry",
        }
        doi = (hit.get("datacite_doi") or "").strip()
        accessions: list[dict] = []
        if doi:
            accessions.append({"repository": "DOI", "accession": doi})
        # Preserve secondary identifiers each backend may carry so the
        # data-graph and downstream fetcher have richer hooks.
        if hit.get("huggingface_repo_id"):
            accessions.append({
                "repository": "HuggingFace",
                "accession": hit["huggingface_repo_id"],
            })
        if hit.get("re3data_id"):
            accessions.append({
                "repository": "re3data",
                "accession": hit["re3data_id"],
            })
        # NCBI GEO Series accessions (GSE...) — registered as a
        # first-class fetchable repository so the dataset_fetcher's
        # ncbi_geo adapter can grab the series-matrix file directly.
        if hit.get("geo_accession"):
            accessions.append({
                "repository": "GEO",
                "accession": hit["geo_accession"],
            })
        # EBI accessions surfaced by ena / biostudies backends —
        # carried through for data-graph visibility; the fetcher
        # falls back to the generic landing-page adapter for these.
        if hit.get("ena_accession"):
            accessions.append({
                "repository": "ENA",
                "accession": hit["ena_accession"],
            })
        if hit.get("biostudies_accession"):
            accessions.append({
                "repository": "BioStudies",
                "accession": hit["biostudies_accession"],
            })
        # Generic web candidates may already have accessions extracted from
        # title/url/body (including GitHub owner/repo). Keep them when a
        # registry-specific field did not produce the same identifier.
        for accession in hit.get("accessions") or []:
            if not isinstance(accession, dict):
                continue
            repo = accession.get("repository")
            value = accession.get("accession")
            if not repo or not value:
                continue
            key = (str(repo).lower(), str(value).lower())
            if not any(
                (str(item.get("repository") or "").lower(), str(item.get("accession") or "").lower()) == key
                for item in accessions
            ):
                accessions.append({"repository": repo, "accession": value})
        if accessions:
            cand["accessions"] = accessions
        publisher = hit.get("datacite_publisher")
        if publisher:
            cand["publisher"] = publisher
        if hit.get("datacite_description"):
            cand["description"] = hit["datacite_description"]
        parsed_host = urlparse(hit.get("url") or "").netloc
        if parsed_host:
            cand["host"] = parsed_host
        return cand

    candidates: list[dict] = []
    queries_attempted: list[dict] = []
    err: str | None = None
    browser_cm = None  # lazy-init on first fallback need
    try:
        for query in queries:
            if _time_budget_exhausted():
                err = "driver_time_budget_exhausted_before_query_completion"
                break
            attempt: dict = {"query": query, "browser_count": 0}
            registry_total_hits = 0
            try:
                query_registries = (
                    BROAD_REGISTRIES +
                    (SPECIALIZED_REGISTRIES if _needs_specialized_archives(query) else []) +
                    EXTRA_REGISTRIES
                )
                for source_name, search_fn in query_registries:
                    if _time_budget_exhausted():
                        attempt["time_budget_exhausted"] = True
                        err = "driver_time_budget_exhausted_during_registry_search"
                        break
                    if source_name == "re3data" and _should_skip_re3data_for_query(query):
                        attempt[f"{source_name}_raw_count"] = 0
                        attempt[f"{source_name}_count"] = 0
                        attempt[f"{source_name}_skipped"] = "cohort_or_accession_request"
                        continue
                    try:
                        raw_hits = search_fn(query, args.max_candidates_per_query)
                    except Exception as src_exc:  # pylint: disable=broad-except
                        attempt[f"{source_name}_error"] = str(src_exc)[:200]
                        raw_hits = []
                    attempt[f"{source_name}_raw_count"] = len(raw_hits)
                    # Relevance-gate every registry, including re3data.
                    # Repository landing pages are not enough to unblock
                    # hypothesis design unless they actually match the
                    # cycle request.
                    hits = [
                        h for h in raw_hits
                        if _hit_passes_relevance(h, query)
                        and not _contains_forbidden_dataset_term(h, forbidden_dataset_terms)
                    ]
                    attempt[f"{source_name}_count"] = len(hits)
                    registry_total_hits += len(hits)
                    for hit in hits:
                        candidates.append(
                            _hit_to_candidate(
                                hit,
                                query=query,
                                source=source_name,
                                lane=lane_id,
                            )
                        )

                # Broad-web fallback (DuckDuckGo via Playwright) — only
                # when ALL registries returned nothing for this query.
                # Catches datasets not registered in any of the indexed
                # platforms: government portals, author pages, project
                # microsites.
                if registry_total_hits == 0 and not args.no_browser and not _time_budget_exhausted():
                    if browser_cm is None:
                        browser_cm = _BrowserSession(args.per_page_timeout * 1000)
                        browser_cm.__enter__()
                    ddg_hits = _search_duckduckgo(
                        browser_cm, query, args.max_candidates_per_query
                    )
                    attempt["browser_count"] = len(ddg_hits)
                    for hit in ddg_hits:
                        cand = {
                            "title": hit.get("title"),
                            "url": hit.get("url"),
                            "matched_query": query,
                            "lane_id": lane_id,
                            "discovery_source": "duckduckgo",
                        }
                        cand = _verify_candidate(browser_cm, cand)
                        if _contains_forbidden_dataset_term(cand, forbidden_dataset_terms):
                            continue
                        cand.setdefault("verification_method", "browser_fetch")
                        candidates.append(cand)
                        time.sleep(0.4)
            except Exception as inner_exc:  # pylint: disable=broad-except
                attempt["error"] = str(inner_exc)[:240]
            queries_attempted.append(attempt)

        # Reference-paper resource pass: once LabDirector has chosen a
        # same-dataset baseline, mine the cited papers for their own Data /
        # Code Availability links. This is deliberately web-search based
        # rather than registry-only because GitHub/software repositories and
        # journal supplementary pages are often absent from DataCite-style
        # dataset indexes.
        reference_queries = [] if args.no_browser else _reference_paper_resource_queries(
            _load_lab_director_hypothesis(runtime_root, cycle_id),
            max_queries=min(args.max_queries, 12),
        )
        for ref_query in reference_queries:
            if _time_budget_exhausted():
                err = "driver_time_budget_exhausted_before_reference_resource_search_completion"
                break
            query = ref_query["query"]
            attempt = {
                "query": query,
                "reference_paper_resource_search": True,
                "resource_kind": ref_query.get("resource_kind"),
                "reference_paper": ref_query.get("reference_paper"),
                "browser_count": 0,
            }
            try:
                if browser_cm is None:
                    browser_cm = _BrowserSession(args.per_page_timeout * 1000)
                    browser_cm.__enter__()
                ddg_hits = _search_duckduckgo(
                    browser_cm, query, args.max_candidates_per_query
                )
                attempt["browser_count"] = len(ddg_hits)
                for hit in ddg_hits:
                    url = hit.get("url") or ""
                    title = hit.get("title") or ""
                    # Keep the pass focused on resources, not generic citation
                    # pages. Candidate verification may still discover GEO /
                    # DOI / GitHub identifiers from journal pages that pass
                    # the lightweight title/url screen.
                    resource_text = f"{title} {url}".lower()
                    if not any(
                        token in resource_text
                        for token in (
                            "github.com/", "geo", "ncbi", "zenodo", "dryad",
                            "figshare", "osf.io", "supplement", "data availability",
                            "code availability", "bioconductor",
                        )
                    ):
                        continue
                    cand = {
                        "title": title,
                        "url": url,
                        "matched_query": query,
                        "lane_id": lane_id,
                        "discovery_source": "reference_paper_web",
                        "reference_paper": ref_query.get("reference_paper"),
                        "reference_resource_kind": ref_query.get("resource_kind"),
                    }
                    # Preserve identifiers already visible in the search result
                    # even if the page body cannot be fetched.
                    visible_accessions = _extract_accessions(f"{title} {url}")
                    if visible_accessions:
                        cand["accessions"] = visible_accessions
                    cand = _verify_candidate(browser_cm, cand)
                    if _contains_forbidden_dataset_term(cand, forbidden_dataset_terms):
                        continue
                    cand.setdefault("verification_method", "reference_paper_web_search")
                    candidates.append(cand)
                    time.sleep(0.4)
            except Exception as ref_exc:  # pylint: disable=broad-except
                attempt["error"] = str(ref_exc)[:240]
            queries_attempted.append(attempt)
    except Exception as exc:  # pylint: disable=broad-except
        err = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    finally:
        if browser_cm is not None:
            try:
                browser_cm.__exit__(None, None, None)
            except Exception:
                pass

    # Deduplicate by URL + keep best access status.
    by_url: dict[str, dict] = {}
    for c in candidates:
        u = c.get("url") or ""
        if not u:
            continue
        existing = by_url.get(u)
        if not existing:
            by_url[u] = c
        else:
            # Prefer candidates flagged "open" over "gated" / "fetch_error"
            if existing.get("access_status") != "open" and c.get("access_status") == "open":
                by_url[u] = c
    deduped = [
        item for item in by_url.values()
        if not _contains_forbidden_dataset_term(item, forbidden_dataset_terms)
    ]

    # ------------------------------------------------------------------
    # Fetch tabular candidates into on-disk bundles. The lab-runner
    # downstream needs CSVs at known paths; without this step the cycle
    # has no materialized dataset bundle and promotion stalls at 0.
    bundles_summary: list[dict] = []
    if args.fetch_enabled and _dataset_fetcher is not None and not _time_budget_exhausted():
        bundle_root = runtime_root / "datasets" / cycle_id
        # Fetch-eligible repositories: any candidate with a stable
        # accession the dataset_fetcher knows how to resolve. DOI is
        # the dominant case for general repositories; specialized
        # archive accessions are handled only when explicitly named.
        # Other registry-only
        # entries (re3data, OpenAIRE without DOI) are deferred — they
        # become data-graph nodes for analyst reference but the
        # fetcher won't try them.
        FETCHABLE_REPOS = {"DOI", "GEO"}
        eligible: list[dict] = []
        seen_fetch_keys: set[str] = set()
        def _fetch_priority(candidate: dict) -> tuple[int, str]:
            repos = {
                (a.get("repository") or "").upper()
                for a in (candidate.get("accessions") or [])
            }
            # In omics cycles, a GEO Series matrix is usually more
            # immediately analyzable than a generic DOI landing page;
            # pick it first when only one bundle can be fetched.
            if "GEO" in repos:
                return (0, str(candidate.get("title") or ""))
            if "DOI" in repos:
                return (1, str(candidate.get("title") or ""))
            return (9, str(candidate.get("title") or ""))

        for c in sorted(deduped, key=_fetch_priority):
            if c.get("access_status") != "open":
                continue
            if not any(
                (a.get("repository") or "").upper() in FETCHABLE_REPOS
                for a in (c.get("accessions") or [])
            ):
                continue
            fetch_keys = _fetch_dedupe_keys(c)
            if fetch_keys and seen_fetch_keys.intersection(fetch_keys):
                c["fetch_skipped_reason"] = "duplicate_accession"
                continue
            eligible.append(c)
            seen_fetch_keys.update(fetch_keys)
            if len(eligible) >= args.max_fetched_datasets:
                break
        for cand in eligible:
            primary_acc = ""
            for a in cand.get("accessions") or []:
                repo = (a.get("repository") or "").upper()
                if repo in FETCHABLE_REPOS:
                    primary_acc = str(a.get("accession") or "")
                    break
            slug = _slug(primary_acc or cand.get("title") or "dataset")
            target_dir = bundle_root / slug
            try:
                summary = _dataset_fetcher.fetch_dataset(cand, target_dir)
            except Exception as exc:  # pylint: disable=broad-except
                summary = {
                    "status": "fetch_error",
                    "bundle_path": str(target_dir),
                    "error": str(exc)[:200],
                }
            bundles_summary.append(summary)
            # Annotate the candidate so _append_dataset_nodes records
            # the bundle path on the graph node.
            cand["bundle_path"] = summary.get("bundle_path")
            cand["bundle_status"] = summary.get("status")
            cand["bundle_csv_count"] = summary.get("csv_count", 0)
            csv_files = []
            for entry in summary.get("manifest") or []:
                if entry.get("fetch_status") == "fetched" and entry.get("csv_path"):
                    csv_files.append({
                        "name": entry.get("name"),
                        "path": entry.get("csv_path"),
                        "row_count": entry.get("row_count"),
                        "columns": entry.get("columns"),
                    })
            cand["bundle_csv_files"] = csv_files

        # Emit a per-cycle bundle index so the harness / lab-director
        # can enumerate cycle-scoped bundles without crawling the
        # filesystem.
        bundle_index_path = state_dir / f"{cycle_id}-data-bundles.json"
        _write_bundle_index(
            bundle_index_path,
            cycle_id=cycle_id,
            bundle_root=bundle_root,
            incoming_summaries=bundles_summary,
        )

    # Seed a minimal data-graph if the chronicle bootstrap never created one
    # (e.g. it timed out). Without this, _append_dataset_nodes no-ops forever
    # because it requires the file to already exist, so materialization can
    # never succeed and the cycle livelocks on scout_discovery_without_
    # materialization_stagnation. Seeding lets discovered open accessions be
    # appended even when chronicle is degraded; chronicle (or its retry)
    # overlays the richer literature-derived structure later.
    if not data_graph_path.is_file():
        _seed_empty_data_graph(data_graph_path, cycle_id)
    appended = _append_dataset_nodes(data_graph_path, deduped, cycle_id, data_request)

    resource_index_path = state_dir / f"{cycle_id}-reference-resources.json"
    _write_reference_resource_index(
        resource_index_path,
        cycle_id=cycle_id,
        incoming_candidates=deduped,
    )

    open_count = sum(1 for c in deduped if c.get("access_status") == "open")
    accession_count = sum(1 for c in deduped if c.get("accessions"))
    fetched_bundle_count = sum(1 for s in bundles_summary if s.get("status") == "fetched")

    payload = {
        "status": "completed" if err is None else "completed_with_warning",
        "driver": "data-scout-browser",
        "cycle_id": cycle_id,
        "lane_id": lane_id,
        "queries_attempted": queries_attempted,
        "candidate_count": len(deduped),
        "open_candidate_count": open_count,
        "candidates_with_accession": accession_count,
        "fetched_bundle_count": fetched_bundle_count,
        "bundles": bundles_summary,
        "candidates": deduped,
        "data_graph_update_path": str(data_graph_path) if appended else None,
        "reference_resource_index_path": str(resource_index_path) if resource_index_path.is_file() else None,
        "completion_marker_path": str(completion_path),
        "error": err,
    }
    _atomic_write_json(result_path, payload)
    _atomic_write_json(completion_path, {
        "cycle_id": cycle_id,
        "status": payload["status"],
        "candidate_count": payload["candidate_count"],
        "open_candidate_count": payload["open_candidate_count"],
        "candidates_with_accession": payload["candidates_with_accession"],
        "fetched_bundle_count": fetched_bundle_count,
        "data_graph_appended": appended,
        "completed_at": _now_iso(),
    })
    print(json.dumps(payload, ensure_ascii=False)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
