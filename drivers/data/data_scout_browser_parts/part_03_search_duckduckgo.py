

# ----------------------------------------------------------------------
# Search-engine wrappers

def _search_duckduckgo(session: _BrowserSession, query: str, max_results: int) -> list[dict]:
    """Use DuckDuckGo's lite HTML endpoint to enumerate top results.

    DuckDuckGo's HTML-only endpoint (https://html.duckduckgo.com/html)
    is friendlier to scraping than Google: no CAPTCHA, no JS required,
    and the HTML structure is stable. We also intentionally use
    DuckDuckGo (not Google) because it imposes no aggressive bot
    detection on headless browsers.
    """
    url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
    text, status = session.fetch(url)
    if status not in (0, 200, 202) or text.startswith("__ERROR__"):
        return []
    # Result links live on lines with "result__a" CSS class. Pull href +
    # title via a regex over the rendered HTML (text is the body inner
    # text, which DuckDuckGo populates with the link text — but href
    # only lives in the HTML half we appended). The split below recovers
    # both.
    results: list[dict] = []
    seen_urls: set[str] = set()
    href_iter = re.finditer(
        r'class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in href_iter:
        href = match.group(1)
        title = re.sub(r"<[^>]+>", "", match.group(2)).strip()
        # DDG wraps real hrefs in /l/?uddg=...
        m = re.search(r"uddg=([^&]+)", href)
        if m:
            from urllib.parse import unquote
            href = unquote(m.group(1))
        if href in seen_urls:
            continue
        seen_urls.add(href)
        results.append({"title": title, "url": href})
        if len(results) >= max_results:
            break
    return results


# ----------------------------------------------------------------------
# Candidate verification

def _verify_candidate(session: _BrowserSession, candidate: dict) -> dict:
    """Visit *candidate.url*, extract any accessions on the landing page,
    and tag the candidate with a coarse access status."""
    url = candidate.get("url") or ""
    if not url:
        candidate["access_status"] = "no_url"
        return candidate
    body, status = session.fetch(url)
    if body.startswith("__ERROR__") or status == -1:
        candidate["access_status"] = "fetch_error"
        candidate["http_status"] = status
        return candidate
    candidate["http_status"] = status
    # Cheap login/paywall/access-control heuristic — if the body
    # strongly suggests the page wants a sign-in or formal request,
    # mark it gated. Avoids passing false positives forward as "open".
    # Signals span subscription paywalls, account walls, and
    # controlled-access registries (dbGaP-style "request access"
    # patterns). All domain-neutral.
    lowered_body = body.lower()
    gated_signals = [
        "sign in to access",
        "please log in",
        "subscription required",
        "purchase access",
        "institutional login",
        "create an account",
        "register to access",
        "data use agreement",
        "request access",
        "controlled access",
        "access controlled",
    ]
    if any(sig in lowered_body for sig in gated_signals):
        candidate["access_status"] = "gated"
    elif status >= 400:
        candidate["access_status"] = "not_accessible"
    else:
        candidate["access_status"] = "open"
    accessions = _extract_accessions(body)
    if accessions:
        existing = candidate.get("accessions") or []
        seen = {
            (
                str(item.get("repository") or "").lower(),
                str(item.get("accession") or "").lower(),
            )
            for item in existing
            if isinstance(item, dict)
        }
        for item in accessions:
            key = (
                str(item.get("repository") or "").lower(),
                str(item.get("accession") or "").lower(),
            )
            if key not in seen:
                existing.append(item)
                seen.add(key)
        candidate["accessions"] = existing
    parsed = urlparse(url)
    if parsed.netloc:
        candidate["host"] = parsed.netloc
    return candidate


# ----------------------------------------------------------------------
# Data-graph integration

# Slug rule mirrors src/agents/chronicle/graph_schema.js::slug — keep
# byte-for-byte compatible so type strings round-trip across JS/Python.
_SLUG_NON_ALPHA = re.compile(r"[^a-z0-9]+")
_SLUG_TRIM = re.compile(r"^-+|-+$")


def _slug(value: str | None, fallback: str = "item") -> str:
    text = (value or fallback).lower()
    text = _SLUG_NON_ALPHA.sub("-", text)
    text = _SLUG_TRIM.sub("", text)
    return text or fallback


def _normalise_doi_accession(value: str) -> str:
    doi = (value or "").strip().lower()
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi)
    doi = re.sub(r"^doi:\s*", "", doi)
    return doi.strip().strip("/")


def _fetch_dedupe_keys(candidate: dict) -> set[str]:
    """Return repository accession keys that should be fetched only once.

    Discovery APIs often surface both a versioned DOI and its versionless
    landing DOI for the same dataset. Collapse those variants before
    downloading, while keeping the rule repository-agnostic and accession-based.
    """
    keys: set[str] = set()
    for accession in candidate.get("accessions") or []:
        repo = (accession.get("repository") or "").upper()
        value = str(accession.get("accession") or "").strip()
        if not repo or not value:
            continue
        if repo == "DOI":
            doi = _normalise_doi_accession(value)
            if not doi:
                continue
            keys.add(f"doi:{doi}")
            base = re.sub(r"([._-]v?\d+)$", "", doi)
            if base and base != doi:
                keys.add(f"doi:{base}")
            continue
        if repo == "GEO":
            keys.add(f"geo:{value.upper()}")
    return keys


_BUNDLE_STATUS_RANK = {
    "fetched": 4,
    "completed": 3,
    "completed_with_warning": 3,
    "skipped_unsupported": 2,
    "fetch_error": 1,
}


def _bundle_record_key(record: dict) -> str:
    """Stable bundle identity used when multiple scouts update the cycle index."""
    path = str(record.get("bundle_path") or "").strip()
    if path:
        return f"path:{path}"
    doi = _normalise_doi_accession(str(record.get("candidate_doi") or ""))
    if doi:
        return f"doi:{doi}"
    accession = str(record.get("candidate_accession") or "").strip().lower()
    if accession:
        return f"accession:{accession}"
    provider = str(record.get("provider") or "").strip().lower()
    status = str(record.get("status") or "").strip().lower()
    return f"fallback:{provider}:{status}:{len(json.dumps(record, sort_keys=True, default=str))}"


def _bundle_record_score(record: dict) -> tuple[int, int, int]:
    """Prefer records that are more usable by downstream analyst/runner lanes."""
    status_rank = _BUNDLE_STATUS_RANK.get(str(record.get("status") or ""), 0)
    csv_count = int(record.get("csv_count") or 0)
    downloaded_count = int(record.get("downloaded_count") or 0)
    return (status_rank, csv_count, downloaded_count)


def _bundle_record_from_summary(summary: dict) -> dict:
    return {
        "bundle_path": summary.get("bundle_path"),
        "manifest_path": summary.get("manifest_path"),
        "provider": summary.get("provider"),
        "status": summary.get("status"),
        "csv_count": summary.get("csv_count", 0),
        "downloaded_count": summary.get("downloaded_count", 0),
        "candidate_doi": summary.get("candidate_doi"),
        "candidate_url": summary.get("candidate_url"),
        "candidate_title": summary.get("candidate_title"),
    }


def _merge_bundle_records(existing: list[dict], incoming: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    order: list[str] = []
    for record in [*existing, *incoming]:
        if not isinstance(record, dict):
            continue
        key = _bundle_record_key(record)
        if key not in merged:
            merged[key] = record
            order.append(key)
            continue
        if _bundle_record_score(record) >= _bundle_record_score(merged[key]):
            merged[key] = {**merged[key], **record}
    return [merged[key] for key in order]


def _write_bundle_index(
    bundle_index_path: Path,
    *,
    cycle_id: str,
    bundle_root: Path,
    incoming_summaries: list[dict],
) -> None:
    """Append/merge bundle records instead of letting follow-up scouts erase prior data."""
    existing_payload = _safe_read_json(bundle_index_path)
    existing_bundles = (
        existing_payload.get("bundles", [])
        if isinstance(existing_payload, dict) and isinstance(existing_payload.get("bundles"), list)
        else []
    )
    incoming = [_bundle_record_from_summary(s) for s in incoming_summaries]
    _atomic_write_json(bundle_index_path, {
        "cycle_id": cycle_id,
        "generated_at": (
            existing_payload.get("generated_at")
            if isinstance(existing_payload, dict)
            else _now_iso()
        ),
        "updated_at": _now_iso(),
        "bundle_root": str(bundle_root),
        "bundles": _merge_bundle_records(existing_bundles, incoming),
    })


def _resource_record_key(record: dict) -> str:
    url = str(record.get("url") or "").strip()
    if url:
        return f"url:{url}"
    for accession in record.get("accessions") or []:
        if not isinstance(accession, dict):
            continue
        repo = str(accession.get("repository") or "").strip().lower()
        value = str(accession.get("accession") or "").strip().lower()
        if repo and value:
            return f"accession:{repo}:{value}"
    return f"fallback:{_slug(record.get('title') or 'resource')}"


def _candidate_reference_resource_record(candidate: dict) -> dict | None:
    """Convert a discovered reference-paper resource candidate to index shape."""
    accessions = [a for a in (candidate.get("accessions") or []) if isinstance(a, dict)]
    github_repos = [
        str(a.get("accession") or "")
        for a in accessions
        if str(a.get("repository") or "").lower() == "github" and a.get("accession")
    ]
    is_reference_resource = candidate.get("discovery_source") == "reference_paper_web"
    is_github = bool(github_repos) or "github.com/" in str(candidate.get("url") or "").lower()
    if not (is_reference_resource or is_github):
        return None
    if candidate.get("access_status") not in (None, "open"):
        return None
    return {
        "title": candidate.get("title"),
        "url": candidate.get("url"),
        "host": candidate.get("host"),
        "access_status": candidate.get("access_status"),
        "accessions": accessions,
        "github_repos": github_repos,
        "reference_paper": candidate.get("reference_paper"),
        "reference_resource_kind": candidate.get("reference_resource_kind") or (
            "code_repository" if is_github else "paper_data_link"
        ),
        "matched_query": candidate.get("matched_query"),
        "discovery_source": candidate.get("discovery_source"),
        "lane_id": candidate.get("lane_id"),
        "discovered_at": _now_iso(),
        "downstream_usage_hint": (
            "Treat GitHub/data-availability resources as high-value reproducibility context: "
            "inspect README/scripts/notebooks, extract dataset URLs/accessions, reuse preprocessing "
            "and validation code when compatible, and cite repository provenance in analyst handoff."
        ),
    }


def _merge_resource_records(existing: list[dict], incoming: list[dict]) -> list[dict]:
    merged: dict[str, dict] = {}
    order: list[str] = []
    for record in [*existing, *incoming]:
        if not isinstance(record, dict):
            continue
        key = _resource_record_key(record)
        if key not in merged:
            merged[key] = record
            order.append(key)
        else:
            merged[key] = {**merged[key], **record}
    return [merged[key] for key in order]


def _write_reference_resource_index(
    resource_index_path: Path,
    *,
    cycle_id: str,
    incoming_candidates: list[dict],
) -> None:
    existing_payload = _safe_read_json(resource_index_path)
    existing_resources = (
        existing_payload.get("resources", [])
        if isinstance(existing_payload, dict) and isinstance(existing_payload.get("resources"), list)
        else []
    )
    incoming = [
        record for record in (_candidate_reference_resource_record(c) for c in incoming_candidates)
        if record is not None
    ]
    if not incoming and not existing_resources:
        return
    _atomic_write_json(resource_index_path, {
        "cycle_id": cycle_id,
        "generated_at": (
            existing_payload.get("generated_at")
            if isinstance(existing_payload, dict)
            else _now_iso()
        ),
        "updated_at": _now_iso(),
        "resources": _merge_resource_records(existing_resources, incoming),
        "usage_policy": {
            "lab_director": "Prefer hypotheses whose same-dataset reference resources expose reusable data/code/provenance; ask for follow-up when a repository likely contains missing accessions or scripts.",
            "analyst": "Inspect GitHub/data-availability resources before designing validation; reuse compatible preprocessing/model code, extract hidden dataset links, and document divergence from reference code.",
            "lab_runner": "Treat linked repositories as executable provenance; use scripts/notebooks as implementation references but keep generated validation code reproducible in-cycle.",
        },
    })


def _derive_node_type(data_request: dict, candidate: dict) -> str:
    """Build a domain-derived type string for a discovered dataset node.

    The lab-director's data-request describes *what kind of dataset is
    needed* in free-form fields (modality / kind / topic). The scout
    converts whichever field the director chose to populate into a slug
    and namespaces it under ``dataset:``. With no hint at all we fall
    back to the bare token ``dataset`` — never ``dataset_candidate``,
    which previously reified a generic placeholder as if it were a
    domain.
    """
    specs = data_request.get("required_dataset_specs") if isinstance(data_request, dict) else None
    if isinstance(specs, list) and specs:
        for spec in specs:
            if not isinstance(spec, dict):
                continue
            for field in ("modality", "kind", "topic", "type"):
                token = spec.get(field)
                if token:
                    return f"dataset:{_slug(str(token))}"
    directive = data_request.get("scout_directive") if isinstance(data_request, dict) else None
    if directive:
        return f"dataset:{_slug(str(directive))}"
    matched = candidate.get("matched_query")
    if matched:
        return f"dataset:{_slug(str(matched))}"
    return "dataset"


def _append_dataset_nodes(
    graph_path: Path,
    candidates: list[dict],
    cycle_id: str,
    data_request: dict,
) -> bool:
    """Append discovered datasets to the cycle's data-graph using
    chronicle's canonical node shape and dynamically register the new
    type into ``graph.vocabulary``.

    We only add — never overwrite — so chronicle's earlier structure
    remains intact. The type string is derived from *data_request* so
    each cycle's vocabulary describes that cycle's domain.
    """
    if not graph_path.is_file():
        return False
    graph = _safe_read_json(graph_path)
    if not isinstance(graph, dict):
        return False
    nodes = graph.get("nodes") if isinstance(graph.get("nodes"), list) else []
    vocab = graph.get("vocabulary") if isinstance(graph.get("vocabulary"), dict) else {}
    node_types = list(vocab.get("node_types") or [])
    edge_relations = list(vocab.get("edge_relations") or [])
    seen_types = set(node_types)
    seen_relations = set(edge_relations)
    appended = 0
    for cand in candidates:
        # Only register candidates that look reachable AND carry at
        # least one stable identifier. Drops noisy DDG hits with no
        # accession from the graph entirely.
        if cand.get("access_status") != "open":
            continue
        accessions = cand.get("accessions") or []
        if not accessions:
            continue
        primary = accessions[0]
        node_type = _derive_node_type(data_request, cand)
        node_id = f"{node_type}:{_slug(primary['repository'])}:{_slug(primary['accession'])}"
        if any(n.get("id") == node_id for n in nodes):
            continue
        provenance: list[str] = []
        lane = cand.get("lane_id")
        if lane:
            provenance.append(f"lane:{lane}")
        if cand.get("matched_query"):
            provenance.append(f"query:{cand['matched_query']}")
        if cand.get("discovery_source"):
            provenance.append(f"source:{cand['discovery_source']}")
        node_metadata: dict = {
            "repository": primary["repository"],
            "accession": primary["accession"],
            "additional_accessions": accessions[1:],
            "url": cand.get("url"),
            "host": cand.get("host"),
            "publisher": cand.get("publisher"),
            "description": cand.get("description"),
            "discovery_source": cand.get("discovery_source"),
            "verification_method": cand.get("verification_method"),
            "matched_query": cand.get("matched_query"),
            "discovered_at": _now_iso(),
            "cycle_id": cycle_id,
        }
        # Phase 1 data fetcher: when the scout fetched a tabular bundle
        # for this candidate, surface bundle_path / fetch_status /
        # csv_files onto the graph node so lab-director's planner can
        # enumerate fetched datasets directly from the data-graph
        # (docs/data-fetcher-2026-04-28.md §D.2).
        if cand.get("bundle_path"):
            node_metadata["bundle_path"] = cand.get("bundle_path")
        if cand.get("bundle_status"):
            node_metadata["fetch_status"] = cand.get("bundle_status")
        if cand.get("bundle_csv_files"):
            node_metadata["csv_files"] = cand.get("bundle_csv_files")
        nodes.append({
            "id": node_id,
            "type": node_type,
            "label": (cand.get("title") or "")[:160] or primary["accession"],
            "score": {},
            "state": cand.get("access_status"),
            "metadata": node_metadata,
            "provenance": provenance,
        })
        if node_type not in seen_types:
            seen_types.add(node_type)
            node_types.append(node_type)
        appended += 1
    if appended == 0:
        return False
    graph["nodes"] = nodes
    graph["vocabulary"] = {
        "node_types": sorted(seen_types),
        "edge_relations": sorted(seen_relations),
    }
    graph.setdefault("_data_acquisition_appends", []).append({
        "cycle_id": cycle_id,
        "appended_at": _now_iso(),
        "appended_count": appended,
    })
    _atomic_write_json(graph_path, graph)
    return True


def _seed_empty_data_graph(graph_path: Path, cycle_id: str) -> None:
    """Create a minimal, valid empty data-graph when the chronicle bootstrap
    never wrote one (e.g. it timed out).

    Without a graph file, ``_append_dataset_nodes`` no-ops forever (it requires
    the file to already exist), so dataset materialization can never succeed and
    the cycle livelocks on ``scout_discovery_without_materialization_stagnation``.
    Seeding lets discovered open accessions be appended even when chronicle is
    degraded. The shape mirrors chronicle's canonical ``createDataGraph()``
    output (nodes/edges/vocabulary); chronicle (or its retry) overlays the richer
    literature-derived structure later — we only add, never overwrite.
    """
    seed = {
        "cycle_id": cycle_id,
        "generated_at": _now_iso(),
        "graph_kind": "data_graph",
        "nodes": [],
        "edges": [],
        "vocabulary": {"node_types": [], "edge_relations": []},
        "metadata": {
            "seeded_by": "data_scout_fallback",
            "reason": "chronicle_bootstrap_absent",
        },
    }
    _atomic_write_json(graph_path, seed)
