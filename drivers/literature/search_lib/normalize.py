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

from .http_client import clean_text
from .queries import reconstruct_abstract, snippet
from .providers import access_metadata


def _citation_count(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    return count if count >= 0 and str(value).strip() == str(count) else None


def _provenance(paper: dict, result: dict, source_url: str | None) -> dict:
    """Keep unknown metrics unknown and name the record supplying each number."""
    observed_at = result.get("_metadata_observed_at") or datetime.now(timezone.utc).isoformat()
    paper["metadata_provenance"] = {
        "source": paper["source"], "source_url": source_url,
        "observed_at": observed_at,
        "record_updated_at": result.get("updated_date"),
        "note": "Metadata observed from provider response or HTTP cache; not a live citation refresh guarantee.",
    }
    count = _citation_count(paper.get("cited_by_count"))
    paper["cited_by_count"] = count
    paper["citation_count_provenance"] = (
        {"value": count, "source": paper["source"], "source_url": source_url,
         "observed_at": observed_at, "record_updated_at": result.get("updated_date")}
        if count is not None and source_url else None
    )
    # Keep supplied source metrics, without inferring impact from venue names.
    paper["venue_metrics"] = result.get("_verified_venue_metrics") or []
    paper["field_normalized_citation_percentile"] = result.get("_verified_field_normalized_citation_percentile")
    return paper


def normalize_paper(result: dict) -> dict:
    abstract = reconstruct_abstract(result.get("abstract_inverted_index"))
    authorships = result.get("authorships", []) or []
    authors = ", ".join(
        author.get("author", {}).get("display_name", "")
        for author in authorships[:6]
        if author.get("author", {}).get("display_name")
    )
    primary_location = result.get("primary_location", {}) or {}
    source = primary_location.get("source", {}) or {}
    open_access = result.get("open_access", {}) or {}
    is_oa = bool(open_access.get("is_oa"))
    paper = {
        "title": clean_text(result.get("display_name")),
        "authors": clean_text(authors),
        "journal": clean_text(source.get("display_name")),
        "year": result.get("publication_year"),
        "publication_date": result.get("publication_date"),
        "doi": result.get("doi"),
        "openalex_id": result.get("id"),
        "type": result.get("type"),
        "cited_by_count": result.get("cited_by_count"),
        "citation_normalized_percentile_raw": result.get("citation_normalized_percentile"),
        "pmid": result.get("ids", {}).get("pmid"),
        "pmcid": result.get("ids", {}).get("pmcid"),
        "source": "openalex",
        "url": primary_location.get("landing_page_url") or result.get("doi"),
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
    }
    paper.update(access_metadata(
        open_access=is_oa,
        oa_status=open_access.get("oa_status"),
        has_full_text=is_oa or bool(result.get("ids", {}).get("pmcid")),
        abstract=abstract,
    ))
    record_id = clean_text(result.get("id")).rstrip("/").split("/")[-1]
    return _provenance(paper, result, f"https://api.openalex.org/works/{record_id}" if record_id else None)


def normalize_crossref_paper(result: dict) -> dict:
    title = clean_text((result.get("title") or [""])[0] if isinstance(result.get("title"), list) else result.get("title"))
    container = result.get("container-title") or [""]
    if isinstance(container, list):
        container = container[0] if container else ""
    authors = []
    for author in result.get("author", [])[:6]:
        given = clean_text(author.get("given"))
        family = clean_text(author.get("family"))
        full = clean_text(f"{given} {family}")
        if full:
            authors.append(full)
    issued = result.get("issued", {}) or result.get("published-print", {}) or result.get("published-online", {})
    year = None
    date_parts = issued.get("date-parts", [])
    if date_parts and date_parts[0]:
        year = date_parts[0][0]
    abstract = clean_text(re.sub(r"<[^>]+>", " ", result.get("abstract") or ""))
    paper = {
        "title": title,
        "authors": ", ".join(authors),
        "journal": clean_text(container),
        "year": year,
        "doi": result.get("DOI"),
        "openalex_id": None,
        "type": "article" if result.get("type") in {"journal-article", "proceedings-article"} else result.get("type"),
        "cited_by_count": result.get("is-referenced-by-count"),
        "pmid": None,
        "pmcid": None,
        "source": "crossref",
        "url": result.get("URL") or (f"https://doi.org/{result.get('DOI')}" if result.get("DOI") else None),
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
    }
    paper.update(access_metadata(open_access=None, has_full_text=False, abstract=abstract))
    doi = clean_text(result.get("DOI"))
    return _provenance(paper, result, f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}" if doi else None)


def normalize_arxiv_paper(result: dict) -> dict:
    title = clean_text(result.get("title"))
    abstract = clean_text(result.get("summary"))
    published = result.get("published") or ""
    year = int(published[:4]) if len(published) >= 4 and published[:4].isdigit() else None
    doi = clean_text(result.get("doi")) or None
    arxiv_url = clean_text(result.get("id")) or None
    authors = ", ".join(
        clean_text(author)
        for author in (result.get("authors") or [])[:6]
        if clean_text(author)
    )
    # Preserve the arXiv subject categories (cs.GR, cs.CV, physics.optics, ...).
    # They were dropped before, which left the downstream literature-graph gate
    # with no way to tell an on-domain paper from an off-domain one (a rendering
    # cycle's corpus came out 4% graphics / 83% off-topic). The primary category
    # is the first listed; keep the full list too.
    categories = [
        clean_text(term)
        for term in (result.get("categories") or [])
        if clean_text(term)
    ]
    paper = {
        "title": title,
        "authors": authors,
        "journal": "arXiv",
        "year": year,
        "publication_date": published[:10] or None,
        "doi": doi,
        "openalex_id": None,
        "type": "preprint",
        "cited_by_count": None,
        "pmid": None,
        "pmcid": None,
        "source": "arxiv",
        "url": (f"https://doi.org/{doi}" if doi else arxiv_url),
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
        "categories": categories,
        "primary_category": categories[0] if categories else None,
    }
    # arXiv entries are open-access preprints with full text always available.
    paper.update(access_metadata(open_access=True, has_full_text=True, abstract=abstract))
    return _provenance(paper, result, arxiv_url)


# Graph API publicationTypes, in the order one decides a record's type.
_S2_TYPE_MAP = (
    ("review", "review"), ("metaanalysis", "review"),
    ("conference", "proceedings-article"), ("journalarticle", "article"),
    ("study", "article"), ("clinicaltrial", "article"), ("casereport", "article"),
    ("booksection", "book-chapter"), ("book", "book"), ("dataset", "dataset"),
    ("editorial", "editorial"), ("lettersandcomments", "letter"), ("news", "news"),
)


def normalize_semanticscholar_paper(result: dict) -> dict:
    """A Semantic Scholar Graph record in the shape every other source uses.

    Its citationCount is a SOURCED observation: the provenance names the Graph
    API record it was read from, exactly as an OpenAlex or Crossref count is
    attributed, so quality_eligibility checks it under the same rule and the
    same threshold. Nothing about the rule changes; a source that measures
    citations for arXiv-first work is simply added.
    """
    external = result.get("externalIds") or {}
    if not isinstance(external, dict):
        external = {}
    doi = clean_text(external.get("DOI")) or None
    arxiv_id = clean_text(external.get("ArXiv")) or None
    venue_record = result.get("publicationVenue") if isinstance(result.get("publicationVenue"), dict) else {}
    journal_record = result.get("journal") if isinstance(result.get("journal"), dict) else {}
    venue = clean_text(venue_record.get("name") or result.get("venue") or journal_record.get("name"))
    types = {str(item).lower() for item in (result.get("publicationTypes") or []) if item}
    paper_type = next((mapped for key, mapped in _S2_TYPE_MAP if key in types), None)
    if paper_type is None:
        paper_type = "preprint" if arxiv_id and not venue else "article"
    paper_id = clean_text(result.get("paperId"))
    abstract = clean_text(result.get("abstract"))
    authors = ", ".join(
        clean_text(author.get("name"))
        for author in (result.get("authors") or [])[:6]
        if isinstance(author, dict) and clean_text(author.get("name"))
    )
    influential = result.get("influentialCitationCount")
    open_pdf = result.get("openAccessPdf") if isinstance(result.get("openAccessPdf"), dict) else {}
    paper = {
        "title": clean_text(result.get("title")),
        "authors": authors,
        "journal": venue or ("arXiv" if arxiv_id else ""),
        "year": result.get("year"),
        "publication_date": clean_text(result.get("publicationDate")) or None,
        "doi": doi,
        "openalex_id": None,
        "arxiv_id": arxiv_id,
        "semanticscholar_id": paper_id or None,
        "type": paper_type,
        "cited_by_count": result.get("citationCount"),
        "influential_citation_count": influential if isinstance(influential, int) else None,
        "pmid": clean_text(external.get("PubMed")) or None,
        "pmcid": clean_text(external.get("PubMedCentral")) or None,
        "source": "semanticscholar",
        "url": clean_text(result.get("url")) or (f"https://www.semanticscholar.org/paper/{paper_id}" if paper_id else None),
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
    }
    paper.update(access_metadata(
        open_access=bool(clean_text(open_pdf.get("url"))) or bool(arxiv_id),
        oa_status=clean_text(open_pdf.get("status")) or None,
        has_full_text=bool(clean_text(open_pdf.get("url"))) or bool(arxiv_id),
        abstract=abstract,
    ))
    return _provenance(
        paper, result,
        f"https://api.semanticscholar.org/graph/v1/paper/{paper_id}" if paper_id else None,
    )


def normalize_pubmed_paper(result: dict) -> dict:
    authors = []
    for author in result.get("authors", [])[:6]:
        name = clean_text(author.get("name"))
        if name:
            authors.append(name)
    article_ids = result.get("articleids", []) or []
    doi = None
    for article_id in article_ids:
        if article_id.get("idtype") == "doi":
            doi = article_id.get("value")
            break
    journal = clean_text(result.get("fulljournalname") or result.get("source"))
    title = clean_text(result.get("title"))
    abstract = clean_text(result.get("_abstract"))
    pmcid = None
    for article_id in article_ids:
        if article_id.get("idtype") == "pmc":
            pmcid = article_id.get("value")
            break
    paper = {
        "title": title,
        "authors": ", ".join(authors),
        "journal": journal,
        "year": result.get("pubdate", "").split(" ")[0] if result.get("pubdate") else None,
        "doi": doi,
        "openalex_id": None,
        "type": "article",
        "cited_by_count": None,
        "pmid": str(result.get("uid") or ""),
        "pmcid": pmcid,
        "source": "pubmed",
        "url": f"https://pubmed.ncbi.nlm.nih.gov/{result.get('uid')}/" if result.get("uid") else None,
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
    }
    paper.update(access_metadata(open_access=bool(pmcid), has_full_text=bool(pmcid), abstract=abstract))
    return _provenance(paper, result, paper.get("url"))




def normalize_scopus_paper(result: dict) -> dict:
    cover_date = clean_text(result.get("prism:coverDate"))
    year = None
    if cover_date:
        head = cover_date.split("-")[0]
        year = int(head) if head.isdigit() else None
    cited = _citation_count(result.get("citedby-count"))
    doi = result.get("prism:doi")
    pmid = clean_text(result.get("pubmed-id")) or None
    url = None
    for link in result.get("link", []) or []:
        if isinstance(link, dict) and link.get("@ref") == "scopus":
            url = link.get("@href")
            break
    if not url and doi:
        url = f"https://doi.org/{doi}"
    abstract = clean_text(result.get("dc:description"))
    paper = {
        "title": clean_text(result.get("dc:title")),
        "authors": clean_text(result.get("dc:creator")),
        "journal": clean_text(result.get("prism:publicationName")),
        "year": year,
        "publication_date": cover_date or None,
        "doi": doi,
        "openalex_id": None,
        "type": clean_text(result.get("subtypeDescription")) or "article",
        "cited_by_count": cited,
        "pmid": pmid,
        "pmcid": None,
        "source": "scopus",
        "url": url,
        "abstract": abstract,
        "abstract_snippet": snippet(abstract),
    }
    paper.update(access_metadata(open_access=None, has_full_text=False, abstract=abstract))
    return _provenance(paper, result, url)
