

# ----------------------------------------------------------------------
# DataCite Commons REST (primary discover backend — domain-neutral)

def _search_datacite(query: str, max_results: int) -> list[dict]:
    """Search DataCite Commons for DOI-registered datasets matching
    *query*. Returns ``{title, url, datacite_*}`` dicts in the same
    shape as the DDG fallback so the crawl step can treat them
    uniformly.

    DataCite is domain-neutral: every discipline that registers DOIs
    (Zenodo, Figshare, Dataverse, OSF, university and government
    repositories, etc.) appears in this index. We restrict to
    ``resource-type-id=Dataset`` so software/papers don't dominate.
    """
    if not query:
        return []
    params = [
        ("query", query),
        ("resource-type-id", "Dataset"),
        ("page[size]", str(max(1, min(max_results, 50)))),
        ("page[number]", "1"),
    ]
    request_url = f"{DATACITE_SEARCH_URL}?{urlencode(params)}"
    req = urllib.request.Request(
        request_url,
        headers={
            "Accept": "application/vnd.api+json",
            "User-Agent": SCOUT_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=DATACITE_TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return []
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return []
    items = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    results: list[dict] = []
    for entry in items[:max_results]:
        if not isinstance(entry, dict):
            continue
        attrs = entry.get("attributes") or {}
        if not isinstance(attrs, dict):
            continue
        doi = attrs.get("doi") or entry.get("id") or ""
        landing_url = attrs.get("url") or (f"https://doi.org/{doi}" if doi else "")
        if not landing_url:
            continue
        # Title: take the first non-empty title in the array
        title = ""
        titles_field = attrs.get("titles")
        if isinstance(titles_field, list):
            for t in titles_field:
                if isinstance(t, dict) and t.get("title"):
                    title = str(t["title"]).strip()
                    break
        if not title:
            title = doi or landing_url
        # Publisher / repository hint
        publisher = attrs.get("publisher") or ""
        if isinstance(publisher, dict):
            publisher = publisher.get("name") or ""
        # Brief description (first one)
        description = ""
        descs = attrs.get("descriptions")
        if isinstance(descs, list):
            for d in descs:
                if isinstance(d, dict) and d.get("description"):
                    description = str(d["description"])[:400]
                    break
        results.append({
            "title": title[:240],
            "url": landing_url,
            "datacite_doi": doi,
            "datacite_publisher": str(publisher)[:160] if publisher else "",
            "datacite_description": description,
        })
    return results


def _http_get_json(url: str, *, timeout: float = REGISTRY_TIMEOUT_SEC,
                   accept: str = "application/json") -> dict | list | None:
    """Fetch *url* and parse the body as JSON. Returns None on any
    transport / decode error so callers can fall through to other
    backends instead of crashing the whole scout pass."""
    req = urllib.request.Request(url, headers={
        "Accept": accept,
        "User-Agent": SCOUT_USER_AGENT,
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def _search_zenodo(query: str, max_results: int) -> list[dict]:
    """Direct Zenodo record search.

    Returns dicts shaped like ``_search_datacite`` so the crawl step
    can union the result lists without per-source branching. Filters
    to ``type=dataset`` so software releases / publications don't
    crowd out the index. Each Zenodo record has a DOI starting
    ``10.5281/zenodo.<id>`` which the dataset_fetcher's Zenodo adapter
    handles directly.
    """
    if not query:
        return []
    params = {
        "q": query,
        "type": "dataset",
        "size": str(max(1, min(max_results, 50))),
        "sort": "mostrecent",
    }
    payload = _http_get_json(f"{ZENODO_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    hits = (payload.get("hits") or {}).get("hits") or []
    if not isinstance(hits, list):
        return []
    out: list[dict] = []
    for hit in hits[:max_results]:
        if not isinstance(hit, dict):
            continue
        meta = hit.get("metadata") or {}
        doi = (hit.get("doi") or meta.get("doi") or "").strip()
        title = str(meta.get("title") or doi or hit.get("id") or "").strip()
        if not title:
            continue
        landing = (hit.get("links") or {}).get("html") or (
            f"https://doi.org/{doi}" if doi else ""
        )
        if not landing:
            continue
        description = str(meta.get("description") or "")[:400]
        publisher = "Zenodo"
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi,
            "datacite_publisher": publisher,
            "datacite_description": description,
        })
    return out


def _search_figshare(query: str, max_results: int) -> list[dict]:
    """Figshare direct article search.

    Figshare exposes its own search endpoint that POSTs a JSON body;
    we issue it as a GET-style URL with a query parameter to keep the
    code path uniform with the other backends. ``item_type=3`` is the
    Figshare code for dataset articles.
    """
    if not query:
        return []
    # Figshare's search_for + GET-style URL convention.
    params = {
        "search_for": query,
        "item_type": "3",
        "page_size": str(max(1, min(max_results, 50))),
    }
    payload = _http_get_json(f"{FIGSHARE_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, list):
        return []
    out: list[dict] = []
    for item in payload[:max_results]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        doi = str(item.get("doi") or "").strip()
        landing = item.get("url_public_html") or item.get("url") or (
            f"https://doi.org/{doi}" if doi else ""
        )
        if not title or not landing:
            continue
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi,
            "datacite_publisher": "Figshare",
            "datacite_description": str(item.get("description") or "")[:400],
        })
    return out


def _search_openaire(query: str, max_results: int) -> list[dict]:
    """OpenAIRE Explore datasets search (EU research federation).

    OpenAIRE aggregates roughly 1500 institutional repositories that
    DataCite does not directly index. The free tier returns JSON when
    ``format=json`` is requested.
    """
    if not query:
        return []
    params = {
        "keywords": query,
        "format": "json",
        "size": str(max(1, min(max_results, 50))),
        "page": "1",
    }
    payload = _http_get_json(f"{OPENAIRE_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    # OpenAIRE's response is a deeply-nested JSON-LD-ish envelope.
    # Drill in defensively — schema drift here must not crash the scout.
    results = (
        payload.get("response", {})
        .get("results", {})
        .get("result")
        or []
    )
    if isinstance(results, dict):
        results = [results]
    if not isinstance(results, list):
        return []
    out: list[dict] = []
    for entry in results[:max_results]:
        if not isinstance(entry, dict):
            continue
        meta = (
            entry.get("metadata", {})
            .get("oaf:entity", {})
            .get("oaf:result", {})
        )
        title = ""
        title_field = meta.get("title")
        if isinstance(title_field, dict):
            title = str(title_field.get("$") or "").strip()
        elif isinstance(title_field, list) and title_field:
            first = title_field[0]
            if isinstance(first, dict):
                title = str(first.get("$") or "").strip()
            elif isinstance(first, str):
                title = first.strip()
        elif isinstance(title_field, str):
            title = title_field.strip()
        # PIDs include DOI / handle / URL — pick the first DOI we see
        doi = ""
        landing = ""
        pid_field = meta.get("pid")
        pid_list = pid_field if isinstance(pid_field, list) else (
            [pid_field] if isinstance(pid_field, dict) else []
        )
        for pid in pid_list:
            if not isinstance(pid, dict):
                continue
            classid = (pid.get("@classid") or "").lower()
            value = str(pid.get("$") or "").strip()
            if classid == "doi" and value:
                doi = value
                landing = f"https://doi.org/{value}"
                break
        if not landing:
            web_field = meta.get("children", {}).get("instance")
            if isinstance(web_field, list) and web_field:
                first = web_field[0]
                if isinstance(first, dict):
                    webresource = first.get("webresource") or {}
                    if isinstance(webresource, dict):
                        url_field = webresource.get("url")
                        if isinstance(url_field, dict):
                            landing = str(url_field.get("$") or "").strip()
                        elif isinstance(url_field, str):
                            landing = url_field.strip()
                    elif isinstance(webresource, list) and webresource:
                        first_wr = webresource[0]
                        if isinstance(first_wr, dict):
                            url_field = first_wr.get("url")
                            if isinstance(url_field, dict):
                                landing = str(url_field.get("$") or "").strip()
                            elif isinstance(url_field, str):
                                landing = url_field.strip()
        if not title or not landing:
            continue
        description_field = meta.get("description")
        description = ""
        if isinstance(description_field, dict):
            description = str(description_field.get("$") or "")[:400]
        elif isinstance(description_field, list) and description_field:
            first = description_field[0]
            if isinstance(first, dict):
                description = str(first.get("$") or "")[:400]
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi,
            "datacite_publisher": "OpenAIRE",
            "datacite_description": description,
        })
    return out


def _search_dryad(query: str, max_results: int) -> list[dict]:
    """Dryad search (datadryad.org).

    Dryad publishes biological / biomedical / ecological research
    datasets — directly relevant to the medical / cohort prompts that
    DataCite alone has not been able to satisfy with a fetchable
    bundle. Each Dryad dataset has a DOI starting ``10.5061/dryad.``;
    the dataset_fetcher's generic-DOI adapter handles these via the
    landing page.
    """
    if not query:
        return []
    params = {
        "q": query,
        "per_page": str(max(1, min(max_results, 50))),
    }
    payload = _http_get_json(f"{DRYAD_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    items = (payload.get("_embedded") or {}).get("stash:datasets") or []
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for entry in items[:max_results]:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("title") or "").strip()
        doi = str(entry.get("identifier") or "").strip().replace("doi:", "")
        if not doi or not title:
            continue
        landing = f"https://doi.org/{doi}"
        description = str(entry.get("abstract") or "")[:400]
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi,
            "datacite_publisher": "Dryad",
            "datacite_description": description,
        })
    return out


def _search_huggingface(query: str, max_results: int) -> list[dict]:
    """Hugging Face Datasets search.

    HF hosts a very large index of research datasets including many
    medical / clinical (e.g. MIMIC-derived chunks released under
    research licenses), public health, climate, and tabular benchmark
    datasets. The fetcher has no native HF adapter yet — we surface
    these candidates as ``access_status: open`` so the analyst can
    reference them, and they pass through the
    ``_fetch_generic_doi`` Playwright fallback when the listing page
    has direct CSV / parquet links.
    """
    if not query:
        return []
    params = {
        "search": query,
        "limit": str(max(1, min(max_results, 50))),
        "full": "true",
    }
    payload = _http_get_json(f"{HUGGINGFACE_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, list):
        return []
    out: list[dict] = []
    for entry in payload[:max_results]:
        if not isinstance(entry, dict):
            continue
        repo_id = str(entry.get("id") or "").strip()
        if not repo_id:
            continue
        title = repo_id
        # Card data sometimes carries a friendlier title.
        card = entry.get("cardData") or {}
        if isinstance(card, dict) and card.get("pretty_name"):
            title = str(card["pretty_name"]).strip() or repo_id
        landing = f"https://huggingface.co/datasets/{repo_id}"
        description = str(entry.get("description") or "")[:400]
        out.append({
            "title": title[:240],
            "url": landing,
            # HF datasets are not always DOI-registered. Use the repo
            # id as the accession so the candidate carries a stable
            # identifier even without a DOI.
            "datacite_doi": "",
            "huggingface_repo_id": repo_id,
            "datacite_publisher": "Hugging Face",
            "datacite_description": description,
        })
    return out


def _search_paperswithcode(query: str, max_results: int) -> list[dict]:
    """Papers with Code datasets/benchmarks search.

    Papers with Code indexes standard BENCHMARK datasets and leaderboards
    across ML and adjacent fields (computer vision, graphics/rendering,
    NLP, RL, …). This is the key source for "which benchmark does this
    field use" — e.g. rendering/denoising benchmark suites, NeRF datasets,
    image-quality datasets. Domain-neutral; returns [] on any error.
    """
    if not query:
        return []
    params = {"q": query, "items_per_page": str(max(1, min(max_results, 50)))}
    payload = _http_get_json(
        f"https://paperswithcode.com/api/v1/datasets/?{urlencode(params)}"
    )
    if not isinstance(payload, dict):
        return []
    results = payload.get("results") or []
    if not isinstance(results, list):
        return []
    out: list[dict] = []
    for entry in results[:max_results]:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("full_name") or "").strip()
        if not name:
            continue
        pwc_url = str(entry.get("url") or "").strip()
        landing = pwc_url or f"https://paperswithcode.com/dataset/{str(entry.get('id') or '').strip()}"
        out.append({
            "title": name[:240],
            "url": landing,
            "datacite_doi": "",
            "paperswithcode_id": str(entry.get("id") or "").strip(),
            "datacite_publisher": "Papers with Code",
            "datacite_description": str(entry.get("description") or "")[:400],
        })
    return out


def _search_dataverse(query: str, max_results: int) -> list[dict]:
    """Harvard Dataverse federated search.

    Dataverse is the dominant academic data-publishing platform; a
    keyword search on the Harvard instance also surfaces records from
    other federated installations. Dataset-only results via
    ``type=dataset``.
    """
    if not query:
        return []
    params = {
        "q": query,
        "type": "dataset",
        "per_page": str(max(1, min(max_results, 50))),
        "start": "0",
    }
    payload = _http_get_json(f"{DATAVERSE_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    items = (payload.get("data") or {}).get("items") or []
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for entry in items[:max_results]:
        if not isinstance(entry, dict):
            continue
        title = str(entry.get("name") or "").strip()
        landing = str(entry.get("url") or "").strip()
        doi = ""
        global_id = str(entry.get("global_id") or "").strip()
        if global_id.lower().startswith("doi:"):
            doi = global_id[4:]
        if not title or not landing:
            continue
        description = str(entry.get("description") or "")[:400]
        publisher = str(entry.get("publisher") or "Dataverse")[:160]
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi,
            "datacite_publisher": publisher,
            "datacite_description": description,
        })
    return out


def _search_re3data(query: str, max_results: int) -> list[dict]:
    """re3data.org meta-registry search.

    re3data lists ~3000 research-data repositories; for a given query
    it returns repository landing pages, not individual datasets. We
    surface those as ``access_status: open`` candidates so the
    analyst sees additional venues to consult; the fetcher does not
    download these (no DOI accession), but the data-graph node makes
    them visible to lab-director and lab-runner.

    re3data's API returns XML by default; we ask for a small page and
    parse it defensively. Failures degrade to an empty list.
    """
    if not query:
        return []
    params = {"query": query}
    req = urllib.request.Request(
        f"{RE3DATA_SEARCH_URL}?{urlencode(params)}",
        headers={"Accept": "application/xml", "User-Agent": SCOUT_USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=REGISTRY_TIMEOUT_SEC) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return []
    try:
        import xml.etree.ElementTree as _ET
        root = _ET.fromstring(body)
    except Exception:  # pylint: disable=broad-except
        return []
    out: list[dict] = []
    # re3data uses a default namespace; iterate via tag-suffix matching
    # so we don't have to bind it explicitly.
    for repo in root.iter():
        tag = repo.tag.split("}")[-1] if "}" in repo.tag else repo.tag
        if tag != "repository":
            continue
        title = ""
        repo_id = ""
        url = ""
        for child in repo:
            ctag = child.tag.split("}")[-1] if "}" in child.tag else child.tag
            text = (child.text or "").strip()
            if ctag == "name":
                title = text
            elif ctag == "id":
                repo_id = text
            elif ctag == "link":
                href = child.attrib.get("href") or child.attrib.get("{http://www.w3.org/1999/xlink}href")
                if href:
                    url = href
        if not title:
            continue
        if not url and repo_id:
            url = f"https://www.re3data.org/repository/{repo_id}"
        if not url:
            continue
        out.append({
            "title": title[:240],
            "url": url,
            "datacite_doi": "",
            "re3data_id": repo_id,
            "datacite_publisher": "re3data",
            "datacite_description": "Registry entry — repository landing page (not a dataset).",
        })
        if len(out) >= max_results:
            break
    return out


def _search_ncbi_geo(query: str, max_results: int) -> list[dict]:
    """NCBI GEO DataSets search via eutils (db=gds).

    Two-call pattern: esearch returns numeric ids, esummary turns
    them into accession + title + summary. DOI registries (DataCite,
    Zenodo) do not consistently index these accessions, so this backend
    is only activated when the request explicitly names a supported
    repository or accession-shaped identifier.

    Returned candidates carry the GEO Series accession as a non-DOI
    accession so the fetcher's DOI-only adapters skip them
    gracefully; the data-graph still gets the link, and a future
    Phase 2 GEO-matrix fetcher can pick them up.
    """
    if not query:
        return []
    esearch_params = {
        "db": "gds",
        "term": query,
        "retmax": str(max(1, min(max_results, 25))),
        "retmode": "json",
    }
    es_payload = _http_get_json(f"{NCBI_ESEARCH_URL}?{urlencode(esearch_params)}")
    if not isinstance(es_payload, dict):
        return []
    idlist = (es_payload.get("esearchresult") or {}).get("idlist") or []
    if not isinstance(idlist, list) or not idlist:
        return []
    summary_params = {
        "db": "gds",
        "id": ",".join(str(i) for i in idlist[:max_results]),
        "retmode": "json",
    }
    su_payload = _http_get_json(f"{NCBI_ESUMMARY_URL}?{urlencode(summary_params)}")
    if not isinstance(su_payload, dict):
        return []
    result = su_payload.get("result") or {}
    uids = result.get("uids") or []
    if not isinstance(uids, list):
        return []
    out: list[dict] = []
    for uid in uids:
        entry = result.get(str(uid))
        if not isinstance(entry, dict):
            continue
        accession = str(entry.get("accession") or "").strip()
        if not accession:
            continue
        # eutils returns both Series (GSE), DataSets (GDS), Samples
        # (GSM) and Platforms (GPL). Keep only Series for now —
        # they're the "study" granularity our fetcher targets.
        if not accession.upper().startswith("GSE"):
            continue
        title = str(entry.get("title") or accession)
        summary = str(entry.get("summary") or "")[:400]
        landing = f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={accession}"
        out.append({
            "title": title[:240],
            "url": landing,
            # GEO series do not get DataCite DOIs by default; surface
            # them as a non-DOI accession so the fetcher's DOI-only
            # adapters do not mis-handle them.
            "datacite_doi": "",
            "geo_accession": accession,
            "datacite_publisher": "NCBI GEO",
            "datacite_description": summary,
        })
    return out


def _search_ebi_biostudies(query: str, max_results: int) -> list[dict]:
    """EBI BioStudies search (covers former ArrayExpress + assorted
    biomedical study deposits). JSON API at
    https://www.ebi.ac.uk/biostudies/api/v1/search.
    """
    if not query:
        return []
    params = {
        "query": query,
        "pageSize": str(max(1, min(max_results, 25))),
        "page": "0",
    }
    payload = _http_get_json(f"{EBI_BIOSTUDIES_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    hits = payload.get("hits") or []
    if not isinstance(hits, list):
        return []
    out: list[dict] = []
    for h in hits[:max_results]:
        if not isinstance(h, dict):
            continue
        accno = str(h.get("accession") or h.get("accno") or "").strip()
        title = str(h.get("title") or accno)
        if not accno or not title:
            continue
        landing = f"https://www.ebi.ac.uk/biostudies/studies/{accno}"
        # ArrayExpress accessions look like ``E-MTAB-XXXX``; keep them
        # accessible to the fetcher via the dataset_fetcher's
        # generic-DOI / landing-page adapter as a last resort.
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": "",
            "biostudies_accession": accno,
            "datacite_publisher": "EBI BioStudies",
            "datacite_description": str(h.get("summary") or "")[:400],
        })
    return out


def _search_ebi_ena(query: str, max_results: int) -> list[dict]:
    """EBI ENA portal study search.

    ENA hosts the European mirror of nucleotide / sequencing studies.
    The portal API returns plain JSON (no auth) and supports a
    ``study_title`` keyword filter. PRJ-prefixed accessions are
    returned as the project handle.
    """
    if not query:
        return []
    params = {
        "result": "study",
        "query": f'study_title="*{query}*"',
        "fields": "study_accession,study_title,study_description",
        "format": "json",
        "limit": str(max(1, min(max_results, 25))),
    }
    payload = _http_get_json(f"{EBI_ENA_PORTAL_URL}?{urlencode(params)}")
    if not isinstance(payload, list):
        return []
    out: list[dict] = []
    for entry in payload[:max_results]:
        if not isinstance(entry, dict):
            continue
        acc = str(entry.get("study_accession") or "").strip()
        title = str(entry.get("study_title") or acc)
        if not acc or not title:
            continue
        landing = f"https://www.ebi.ac.uk/ena/browser/view/{acc}"
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": "",
            "ena_accession": acc,
            "datacite_publisher": "EBI ENA",
            "datacite_description": str(entry.get("study_description") or "")[:400],
        })
    return out


def _build_extra_registry_search(entry: dict) -> "callable":
    """Compile one entry from the extra-registries JSON config into
    an executable ``search(query, max_results)`` function. Lets the
    user / lab-director add new DBs to the scout's registry list at
    runtime without code changes — drop a new object into
    ``drivers/data/extra_registries.json`` and the scout picks it up
    on the next pass.

    The schema is intentionally narrow so callers can write valid
    config without reading source. Fields:
      name           — display name (used as discovery_source)
      search_url     — URL with ``{query}`` and ``{max}`` placeholders
      kind           — "json_array" (top-level list) or "json_object"
                       (nested under items_path)
      items_path     — dotted path to the items list inside the
                       response (only used when kind=="json_object")
      title_field    — JSON key for the item's title
      url_field      — JSON key for the item's landing URL
      doi_field      — JSON key for an optional DOI accession
      description_field — JSON key for an optional summary string
      publisher      — string label (defaults to ``name``)
      accept         — Accept header (defaults to application/json)
      timeout_sec    — per-request timeout (default 12 s)

    Schema deliberately mirrors the simplest backends we already
    have (Zenodo, Figshare, OSF) so existing mental model carries
    over to user-added entries.
    """
    name = str(entry.get("name") or "").strip() or "extra"
    template = str(entry.get("search_url") or "").strip()
    kind = str(entry.get("kind") or "json_array").strip()
    items_path = str(entry.get("items_path") or "").strip()
    title_field = str(entry.get("title_field") or "title").strip()
    url_field = str(entry.get("url_field") or "url").strip()
    doi_field = str(entry.get("doi_field") or "doi").strip()
    desc_field = str(entry.get("description_field") or "description").strip()
    publisher = str(entry.get("publisher") or name).strip()
    accept = str(entry.get("accept") or "application/json").strip()
    timeout = float(entry.get("timeout_sec") or REGISTRY_TIMEOUT_SEC)

    def _resolve(value, dotted: str):
        if not dotted or value is None:
            return value
        cursor = value
        for part in dotted.split("."):
            if isinstance(cursor, dict):
                cursor = cursor.get(part)
            else:
                return None
        return cursor

    def _search(query: str, max_results: int) -> list[dict]:
        if not query or not template:
            return []
        # Substitute placeholders without urlencode of the whole URL —
        # the template author is expected to URL-encode static parts;
        # we url-encode only the {query} value.
        url = template.replace("{query}", quote_plus(query))
        url = url.replace("{max}", str(max(1, min(max_results, 50))))
        payload = _http_get_json(url, timeout=timeout, accept=accept)
        if payload is None:
            return []
        if kind == "json_array":
            items = payload if isinstance(payload, list) else []
        else:
            items = _resolve(payload, items_path) or []
            if isinstance(items, dict):
                items = [items]
            if not isinstance(items, list):
                items = []
        out: list[dict] = []
        for item in items[:max_results]:
            if not isinstance(item, dict):
                continue
            title = str(_resolve(item, title_field) or "").strip()
            landing = str(_resolve(item, url_field) or "").strip()
            if not title or not landing:
                continue
            doi = str(_resolve(item, doi_field) or "").strip()
            description = str(_resolve(item, desc_field) or "")[:400]
            out.append({
                "title": title[:240],
                "url": landing,
                "datacite_doi": doi,
                "datacite_publisher": publisher,
                "datacite_description": description,
            })
        return out

    _search.__name__ = f"_search_extra_{name}"  # for diagnostics
    return _search


def _load_extra_registries() -> list[tuple[str, "callable"]]:
    """Read ``drivers/data/extra_registries.json`` (relative to this
    file) plus an optional override at
    ``$RESEARCHLAB_EXTRA_REGISTRIES`` — both contain a JSON array of
    entries that ``_build_extra_registry_search`` compiles.

    Failures are silent: a malformed config must not break the
    scout. Each loaded entry becomes a (discovery_source, search_fn)
    tuple appended to REGISTRIES at main()-time.
    """
    paths_to_try: list[Path] = []
    here = Path(__file__).resolve().parent
    paths_to_try.append(here / "extra_registries.json")
    env = os.environ.get("RESEARCHLAB_EXTRA_REGISTRIES", "").strip()
    if env:
        paths_to_try.append(Path(env))
    seen_names: set[str] = set()
    out: list[tuple[str, "callable"]] = []
    for p in paths_to_try:
        if not p.is_file():
            continue
        try:
            entries = json.loads(p.read_text(encoding="utf-8"))
        except Exception:  # pylint: disable=broad-except
            continue
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("name") or "").strip()
            if not name or name in seen_names:
                continue
            try:
                fn = _build_extra_registry_search(entry)
            except Exception:  # pylint: disable=broad-except
                continue
            seen_names.add(name)
            out.append((name, fn))
    return out


def _search_osf(query: str, max_results: int) -> list[dict]:
    """OSF (Open Science Framework) registration search.

    OSF hosts both data and pre-registered studies; their datasets are
    referenced by DOI ``10.17605/osf.io/<short>``. The dataset_fetcher's
    OSF adapter knows how to follow these.
    """
    if not query:
        return []
    params = {
        "filter[title]": query,
        "page[size]": str(max(1, min(max_results, 50))),
    }
    payload = _http_get_json(f"{OSF_SEARCH_URL}?{urlencode(params)}")
    if not isinstance(payload, dict):
        return []
    items = payload.get("data") or []
    if not isinstance(items, list):
        return []
    out: list[dict] = []
    for item in items[:max_results]:
        if not isinstance(item, dict):
            continue
        attrs = item.get("attributes") or {}
        title = str(attrs.get("title") or "").strip()
        node_id = str(item.get("id") or "").strip()
        if not title or not node_id:
            continue
        landing = f"https://osf.io/{node_id}/"
        doi = ""
        ids_attr = attrs.get("identifiers") or {}
        if isinstance(ids_attr, dict):
            doi = str(ids_attr.get("doi") or "").strip()
        out.append({
            "title": title[:240],
            "url": landing,
            "datacite_doi": doi or f"10.17605/osf.io/{node_id}",
            "datacite_publisher": "OSF",
            "datacite_description": str(attrs.get("description") or "")[:400],
        })
    return out


# ----------------------------------------------------------------------
# Browser session

class _BrowserSession:
    """Thin wrapper around Playwright sync_api. Encapsulates start /
    stop / fetch with resilient error handling."""

    def __init__(self, per_page_timeout_ms: int):
        self.per_page_timeout_ms = per_page_timeout_ms
        self._pw = None
        self._browser = None
        self._context = None

    def __enter__(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True)
        self._context = self._browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 ResearchLab-DataScout"
            )
        )
        return self

    def __exit__(self, *_):
        try:
            if self._context:
                self._context.close()
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()

    def fetch(self, url: str) -> tuple[str, int]:
        """Open *url*, return (page text, http status). On any failure
        return ("", -1) so the caller can record a non-blocking miss."""
        page = self._context.new_page()
        try:
            response = page.goto(url, timeout=self.per_page_timeout_ms, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=min(self.per_page_timeout_ms, 8000))
            except Exception:
                # networkidle is best-effort; many JS-heavy sites never hit
                # idle and we don't want to block the whole pass on them.
                pass
            text = page.inner_text("body", timeout=5000) or ""
            html = page.content() or ""
            status = response.status if response else 0
            return text + "\n" + html, status
        except Exception as exc:  # pylint: disable=broad-except
            return f"__ERROR__:{exc}", -1
        finally:
            try:
                page.close()
            except Exception:
                pass
