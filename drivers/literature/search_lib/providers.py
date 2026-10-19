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

from .constants import ARXIV_API_URL, ARXIV_ATOM_NS, CONTACT_MAILTO, CROSSREF_WORKS_URL, MAX_PAPERS_PER_QUERY, OPENALEX_WORKS_URL, PUBMED_EFETCH_URL, PUBMED_ESEARCH_URL, PUBMED_ESUMMARY_URL, SCOPUS_SEARCH_URL, SEMANTIC_SCHOLAR_API_URL, SEMANTIC_SCHOLAR_PAPER_FIELDS
from .http_client import approved_scholarly_metadata_policy_enabled, clean_text, fetch_json, fetch_json_with_headers, fetch_text, scopus_api_key
from .queries import build_literature_query
from .ranking import paper_score


def search_openalex(query: str, page_size: int = MAX_PAPERS_PER_QUERY) -> list[dict]:
    query = build_literature_query(query, source="openalex")
    if not query:
        return []
    params = urllib.parse.urlencode(
        {
            "search": query,
            "per-page": str(page_size),
            "mailto": CONTACT_MAILTO,
        }
    )
    payload = fetch_json(f"{OPENALEX_WORKS_URL}?{params}")
    return payload.get("results", [])


def search_crossref(query: str, page_size: int = MAX_PAPERS_PER_QUERY) -> list[dict]:
    query = build_literature_query(query, source="crossref")
    if not query:
        return []
    params = urllib.parse.urlencode(
        {
            "query": query,
            "rows": str(page_size),
            "mailto": CONTACT_MAILTO,
            "select": "DOI,title,author,container-title,published-print,published-online,issued,type,URL,is-referenced-by-count,abstract",
        }
    )
    payload = fetch_json(f"{CROSSREF_WORKS_URL}?{params}")
    return payload.get("message", {}).get("items", [])


_ARXIV_FIELD_OPERATOR_RE = re.compile(r"\b(cat|ti|abs|au|all|co|jr|rn):", re.IGNORECASE)


def _arxiv_query_has_field_operator(query: str) -> bool:
    """True when the scout already scoped the query with arXiv field syntax.

    arXiv's Atom API accepts field-prefixed terms — ``cat:`` (subject category
    such as cs.GR / cs.LG / physics.optics), ``ti:`` (title), ``abs:`` (abstract),
    ``au:`` (author), and ``all:`` — combined with AND/OR/ANDNOT. When any is
    present the scout has expressed an explicit scope we must neither override
    with a broad ``all:`` wrap nor mangle through the (biomedical-oriented)
    ``build_literature_query`` normalizer.
    """
    return bool(_ARXIV_FIELD_OPERATOR_RE.search(query or ""))


def search_arxiv(query: str, page_size: int = MAX_PAPERS_PER_QUERY) -> list[dict]:
    """Retrieve preprints from the keyless arXiv Atom API.

    arXiv is the primary prior-art source for computer-graphics / ML / physics /
    math. Returns raw entry dicts (title/summary/authors/published/id/doi/
    categories) for normalize_arxiv_paper; parsing failures degrade to [] so a
    transient arXiv hiccup never breaks the whole multi-source query.
    """
    # The scout DECIDES the domain scope, per query — nothing is hardcoded here.
    # If the scout already expressed arXiv field syntax (e.g.
    # ``cat:cs.GR AND all:path guiding``, or ``ti:``/``abs:``/``au:``, or a
    # boolean over them), honor it VERBATIM: skip the biomedical-oriented query
    # normalizer (which would quote/expand and break the operator) and use it as
    # the search expression directly, so a ``cat:cs.GR`` scope actually
    # constrains the search. Only an un-scoped query falls back to the old broad
    # ``all:`` wrap. This lets an agentic scout keep a rendering corpus
    # on-domain (cat:cs.GR) without the driver imposing any fixed category.
    if _arxiv_query_has_field_operator(query):
        search_query = query.strip()[:2048]
    else:
        query = build_literature_query(query, source="arxiv")
        if not query:
            return []
        search_query = f"all:{query}"
    params = urllib.parse.urlencode(
        {
            "search_query": search_query,
            "start": "0",
            "max_results": str(page_size),
            "sortBy": "relevance",
            "sortOrder": "descending",
        }
    )
    return _parse_arxiv_entries(fetch_text(f"{ARXIV_API_URL}?{params}"))


def _parse_arxiv_entries(text: str) -> list[dict]:
    if not text:
        return []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    entries: list[dict] = []
    for entry in root.findall("atom:entry", ARXIV_ATOM_NS):
        entries.append(
            {
                "title": entry.findtext("atom:title", default="", namespaces=ARXIV_ATOM_NS),
                "summary": entry.findtext("atom:summary", default="", namespaces=ARXIV_ATOM_NS),
                "published": entry.findtext("atom:published", default="", namespaces=ARXIV_ATOM_NS),
                "id": entry.findtext("atom:id", default="", namespaces=ARXIV_ATOM_NS),
                "doi": entry.findtext("arxiv:doi", default="", namespaces=ARXIV_ATOM_NS),
                "authors": [
                    author.findtext("atom:name", default="", namespaces=ARXIV_ATOM_NS)
                    for author in entry.findall("atom:author", ARXIV_ATOM_NS)
                ],
                "categories": [
                    category.get("term", "")
                    for category in entry.findall("atom:category", ARXIV_ATOM_NS)
                ],
            }
        )
    return entries


def fetch_arxiv_ids(arxiv_ids: Sequence[str]) -> list[dict]:
    """arXiv entries for exact identifiers (id_list), newest version of each."""
    ids = [clean_text(item) for item in arxiv_ids if clean_text(item)]
    if not ids:
        return []
    params = urllib.parse.urlencode(
        {"id_list": ",".join(ids), "start": "0", "max_results": str(len(ids))}
    )
    entries = _parse_arxiv_entries(fetch_text(f"{ARXIV_API_URL}?{params}"))
    # An unknown ID comes back as an entry titled "Error"; it is not a paper.
    return [entry for entry in entries if clean_text(entry.get("title")).lower() != "error"]


def _title_words(title: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+", clean_text(title))


def search_arxiv_title(title: str, page_size: int = 5) -> list[dict]:
    """arXiv entries whose TITLE carries this title, phrase first.

    The phrase form finds the paper when arXiv tokenizes the title as the
    request does; when it finds nothing (punctuation such as "RT-2:" or a
    Greek letter can split differently), every significant word is required in
    the title instead. Ranking the result is the caller's job.
    """
    words = _title_words(title)
    if not words:
        return []
    phrase = 'ti:"' + " ".join(words) + '"'
    entries = search_arxiv(phrase[:2048], page_size=page_size)
    if entries:
        return entries
    significant = sorted({word for word in words if len(word) >= 3}, key=lambda word: (-len(word), word))[:8]
    if len(significant) < 2:
        return []
    return search_arxiv(" AND ".join(f"ti:{word}" for word in significant), page_size=page_size)


def search_openalex_title(title: str, page_size: int = 5) -> list[dict]:
    """OpenAlex works by title (the filter's own syntax characters removed)."""
    words = _title_words(title)
    if not words:
        return []
    params = urllib.parse.urlencode(
        {"filter": "title.search:" + " ".join(words), "per-page": str(page_size), "mailto": CONTACT_MAILTO}
    )
    return fetch_json(f"{OPENALEX_WORKS_URL}?{params}").get("results", []) or []


def lookup_openalex_doi(doi: str) -> list[dict]:
    params = urllib.parse.urlencode(
        {"filter": f"doi:https://doi.org/{doi}", "per-page": "1", "mailto": CONTACT_MAILTO}
    )
    return fetch_json(f"{OPENALEX_WORKS_URL}?{params}").get("results", []) or []


_CROSSREF_SELECT = "DOI,title,author,container-title,published-print,published-online,issued,type,URL,is-referenced-by-count,abstract"


def search_crossref_title(title: str, page_size: int = 5) -> list[dict]:
    params = urllib.parse.urlencode(
        {"query.title": clean_text(title), "rows": str(page_size), "mailto": CONTACT_MAILTO, "select": _CROSSREF_SELECT}
    )
    return fetch_json(f"{CROSSREF_WORKS_URL}?{params}").get("message", {}).get("items", []) or []


def lookup_crossref_doi(doi: str) -> dict | None:
    try:
        payload = fetch_json(f"{CROSSREF_WORKS_URL}/{urllib.parse.quote(doi, safe='')}")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    message = payload.get("message") if isinstance(payload, dict) else None
    return message if isinstance(message, dict) and message.get("DOI") else None


# --- Semantic Scholar ---------------------------------------------------------


def semanticscholar_api_key() -> str:
    """Optional key; without one the shared anonymous pool is used."""
    return (os.environ.get("RESEARCHLAB_S2_API_KEY") or "").strip()


def _semanticscholar_get(url: str, fetch=None) -> dict:
    """One Graph API GET through the shared polite fetch layer.

    Pacing (about 1 request/s, shared across threads AND processes by the
    per-host throttle) and the bounded 429 backoff live in http_client. The key
    is the one header the approved scholarly metadata policy allows, and only
    to this host: it is a credential for an approved service, not content from
    this machine. ``fetch`` lets a caller that owns a patched fetch route
    through it.
    """
    if fetch is not None:
        return fetch(url)
    key = semanticscholar_api_key()
    if key:
        return fetch_json_with_headers(url, {"x-api-key": key})
    return fetch_json(url)


_ARXIV_FIELD_TERM_RE = re.compile(r"\b(?:ti|abs|au|all|co|jr|rn):", re.IGNORECASE)


def semanticscholar_plain_query(query: str) -> str:
    """The Graph search takes plain words: no field syntax, operators or quotes.

    Its documentation also warns that a hyphenated term matches nothing, so
    hyphens become spaces ("sim-to-real" -> "sim to real").
    """
    text = clean_text(query)
    for prefix in ("[pm:raw]", "[oa:raw]", "[cr:raw]", "[raw]"):
        if text.lower().startswith(prefix):
            text = text[len(prefix):]
    text = re.sub(r"\bcat:\S+", " ", text, flags=re.IGNORECASE)
    text = _ARXIV_FIELD_TERM_RE.sub(" ", text)
    text = re.sub(r"\b(?:AND|OR|ANDNOT|NOT)\b", " ", text)
    text = re.sub(r"[\"()\[\]{}]", " ", text)
    text = re.sub(r"(?<=\w)-(?=\w)", " ", text)
    return clean_text(text)[:300]


def search_semanticscholar(query: str, page_size: int = MAX_PAPERS_PER_QUERY, fetch=None) -> list[dict]:
    text = semanticscholar_plain_query(query)
    if not text:
        return []
    params = urllib.parse.urlencode(
        {"query": text, "limit": str(min(int(page_size), 100)), "fields": SEMANTIC_SCHOLAR_PAPER_FIELDS}
    )
    payload = _semanticscholar_get(f"{SEMANTIC_SCHOLAR_API_URL}/paper/search?{params}", fetch)
    return [item for item in (payload or {}).get("data") or [] if isinstance(item, dict)]


def semanticscholar_match_title(title: str, fetch=None) -> list[dict]:
    """The Graph API's own best title match; [] when it has none (HTTP 404)."""
    text = semanticscholar_plain_query(title)
    if not text:
        return []
    params = urllib.parse.urlencode({"query": text, "fields": SEMANTIC_SCHOLAR_PAPER_FIELDS})
    try:
        payload = _semanticscholar_get(f"{SEMANTIC_SCHOLAR_API_URL}/paper/search/match?{params}", fetch)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return []
        raise
    return [item for item in (payload or {}).get("data") or [] if isinstance(item, dict)]


def semanticscholar_paper(identifier: str, fetch=None) -> dict | None:
    """One paper by Graph identifier: ``arXiv:2303.04137``, ``DOI:10.x/y`` or a paperId."""
    params = urllib.parse.urlencode({"fields": SEMANTIC_SCHOLAR_PAPER_FIELDS})
    path = urllib.parse.quote(clean_text(identifier), safe=":/")
    try:
        payload = _semanticscholar_get(f"{SEMANTIC_SCHOLAR_API_URL}/paper/{path}?{params}", fetch)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    return payload if isinstance(payload, dict) and payload.get("paperId") else None


def semanticscholar_neighbours(identifier: str, direction: str, limit: int = 40, fetch=None) -> list[dict]:
    """Papers the parent cites (``references``) or that cite it (``citations``).

    Each neighbour comes back with the same fields as a search hit, abstract
    and citation count included, so no second metadata round trip is needed.
    """
    if direction not in ("references", "citations"):
        raise ValueError("direction must be references or citations")
    params = urllib.parse.urlencode(
        {"fields": SEMANTIC_SCHOLAR_PAPER_FIELDS, "limit": str(max(1, min(int(limit), 1000)))}
    )
    path = urllib.parse.quote(clean_text(identifier), safe=":/")
    payload = _semanticscholar_get(f"{SEMANTIC_SCHOLAR_API_URL}/paper/{path}/{direction}?{params}", fetch)
    key = "citedPaper" if direction == "references" else "citingPaper"
    neighbours = []
    for row in (payload or {}).get("data") or []:
        paper = row.get(key) if isinstance(row, dict) else None
        if isinstance(paper, dict) and paper.get("title"):
            neighbours.append(paper)
    return neighbours


def search_scopus(query: str, page_size: int = MAX_PAPERS_PER_QUERY) -> list[dict]:
    key = scopus_api_key()
    if not key:
        # No entitlement configured — surface a clear, catchable signal so the
        # caller records "scopus unavailable (no api key)" rather than silently
        # returning nothing.
        raise RuntimeError("scopus_api_key_missing")
    query = build_literature_query(query, source="scopus")
    if not query:
        return []
    params = urllib.parse.urlencode(
        {
            "query": f"TITLE-ABS-KEY({query})",
            "count": str(page_size),
            "sort": "-citedby-count",
        }
    )
    payload = fetch_json_with_headers(
        f"{SCOPUS_SEARCH_URL}?{params}",
        {"X-ELS-APIKey": key, "Accept": "application/json"},
    )
    return payload.get("search-results", {}).get("entry", []) or []



def search_pubmed(query: str, page_size: int = MAX_PAPERS_PER_QUERY) -> list[dict]:
    query = build_literature_query(query, source="pubmed")
    if not query:
        return []
    params = urllib.parse.urlencode(
        {
            "db": "pubmed",
            "retmode": "json",
            "retmax": str(page_size),
            "sort": "relevance",
            "term": query,
        }
    )
    payload = fetch_json(f"{PUBMED_ESEARCH_URL}?{params}")
    ids = payload.get("esearchresult", {}).get("idlist", [])
    if not ids:
        return []
    abstracts_by_pmid = fetch_pubmed_abstracts(ids)
    summary_params = urllib.parse.urlencode(
        {
            "db": "pubmed",
            "retmode": "json",
            "id": ",".join(ids),
        }
    )
    summary = fetch_json(f"{PUBMED_ESUMMARY_URL}?{summary_params}")
    result = summary.get("result", {})
    docs = []
    for pmid in ids:
        doc = result.get(str(pmid))
        if doc:
            doc["_abstract"] = abstracts_by_pmid.get(str(pmid), "")
            docs.append(doc)
    return docs


def fetch_pubmed_abstracts(pmids: list[str]) -> dict[str, str]:
    """Fetch PubMed abstracts for KG seeding when full text is unavailable.

    ESummary intentionally omits abstracts. Without this EFetch pass, a
    non-open PubMed article can survive as a title-only record, which is too
    thin for Chronicle's literature KG. PubMed abstracts are public metadata,
    so they are safe to retain as an abstract-only evidence source even when
    no PMCID/open full text exists.
    """
    ids = [str(pmid).strip() for pmid in pmids if str(pmid).strip()]
    if not ids:
        return {}
    params = urllib.parse.urlencode(
        {
            "db": "pubmed",
            "retmode": "xml",
            "rettype": "abstract",
            "id": ",".join(ids),
        }
    )
    try:
        payload = fetch_text(f"{PUBMED_EFETCH_URL}?{params}")
        root = ET.fromstring(payload)
    except Exception:
        return {}

    abstracts: dict[str, str] = {}
    for article in root.findall(".//PubmedArticle"):
        pmid = clean_text(article.findtext(".//MedlineCitation/PMID"))
        parts: list[str] = []
        for node in article.findall(".//Abstract/AbstractText"):
            text = clean_text("".join(node.itertext()))
            if not text:
                continue
            label = clean_text(node.attrib.get("Label"))
            parts.append(f"{label}: {text}" if label else text)
        if pmid and parts:
            abstracts[pmid] = clean_text(" ".join(parts))
    return abstracts


def access_metadata(*, open_access: bool | None = None, oa_status: str | None = None, has_full_text: bool | None = None, abstract: str = "") -> dict:
    abstract_present = bool(clean_text(abstract))
    if has_full_text is None:
        has_full_text = bool(open_access)
    if has_full_text:
        full_text_status = "open_full_text"
    elif abstract_present:
        full_text_status = "abstract_only"
    else:
        full_text_status = "metadata_only"
    return {
        "open_access": bool(open_access) if open_access is not None else False,
        "oa_status": clean_text(oa_status) or None,
        "full_text_status": full_text_status,
        "kg_seed_basis": "abstract" if full_text_status == "abstract_only" else full_text_status,
        "abstract_available": abstract_present,
        "kg_usable": abstract_present or bool(has_full_text),
    }



def cycle_id_from_output_dir(output_dir: Path) -> str | None:
    if output_dir.parent.name:
        return output_dir.parent.name
    return None


def research_lab_runtime_root(output_dir: Path) -> Path:
    """Return the `.research-lab` runtime root for lane/artifact paths."""
    for candidate in [output_dir, *output_dir.parents]:
        if candidate.name == ".research-lab":
            return candidate
    return output_dir.parents[3]


def load_local_scout_papers(output_dir: Path) -> list[dict]:
    cycle_id = cycle_id_from_output_dir(output_dir)
    if not cycle_id:
        return []
    runtime_root = research_lab_runtime_root(output_dir)
    artifacts_root = output_dir.parent
    lanes_root = runtime_root / "lanes" / cycle_id
    papers: list[dict] = []
    seen: set[tuple[str | None, str]] = set()
    candidate_dirs = []
    if artifacts_root.exists():
        candidate_dirs.extend([item for item in artifacts_root.iterdir() if item.is_dir()])
    if lanes_root.exists():
        candidate_dirs.extend([item for item in lanes_root.iterdir() if item.is_dir()])
    for lane_dir in candidate_dirs:
        lane_id = lane_dir.name
        if not lane_id.startswith("scout-") and not lane_id.startswith("followup-scout-"):
            continue
        candidate_files = [lane_dir / "papers.json", lane_dir / "result.json"]
        for candidate_file in candidate_files:
            if not candidate_file.exists():
                continue
            try:
                payload = json.loads(candidate_file.read_text(encoding="utf-8"))
            except Exception:
                continue
            lane_papers = payload if isinstance(payload, list) else payload.get("papers", [])
            if not isinstance(lane_papers, list):
                continue
            for paper in lane_papers:
                key = (
                    paper.get("doi") or paper.get("pmid") or paper.get("openalex_id"),
                    paper.get("title", ""),
                )
                if key in seen or not paper.get("title"):
                    continue
                seen.add(key)
                papers.append(paper)
    papers.sort(key=paper_score, reverse=True)
    return papers
