from __future__ import annotations

import argparse
import concurrent.futures
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

from .constants import MAX_TOTAL_PAPERS, QUERY_CACHE_SCHEMA_VERSION
from .http_client import clean_text, query_cache_path, scopus_enabled
from .queries import infer_frontier_catalog
from .providers import load_local_scout_papers, search_arxiv, search_crossref, search_openalex, search_pubmed, search_scopus, search_semanticscholar
from .normalize import normalize_arxiv_paper, normalize_crossref_paper, normalize_paper, normalize_pubmed_paper, normalize_scopus_paper, normalize_semanticscholar_paper
from .ranking import diversify_ranked_papers, paper_is_relevant, paper_score
from .objective import objective_is_biomedical
from .synthesis import generate_hypothesis_scenarios
from .citation_metadata import attach_citation_evidence
from .screening import merge_candidate_records, objective_from_plan, screening_context, screen_papers

APPROVED_SCHOLARLY_NETWORK_POLICY = "approved-scholarly-metadata-v1"
# MEASURED ON cycle-b-20260918, 2026-09-18/19: with these three alone,
# 4,617 candidates held none of the field's landmark robot-learning papers.
# Semantic Scholar indexes the CoRL/RSS/NeurIPS proceedings they appear in,
# with arXiv IDs, abstracts and a sourced citation count.
from .key_gates import enabled_sources

APPROVED_SCHOLARLY_SOURCES = ("openalex", "crossref", "arxiv", "semanticscholar")
# Every source a caller may name. Retrieval still goes only to the ones the
# network policy allows.
KNOWN_LITERATURE_SOURCES = ("openalex", "crossref", "arxiv", "semanticscholar", "pubmed", "scopus")


def approved_scholarly_network_policy_enabled() -> bool:
    return os.environ.get("RESEARCHLAB_LITERATURE_NETWORK_POLICY", "").strip() == APPROVED_SCHOLARLY_NETWORK_POLICY


def allowed_literature_sources(sources: Sequence[str]) -> list[str]:
    """Apply the explicit network allowlist without inventing providers.

    Under the opt-in policy, PubMed and Scopus are excluded even when an older
    caller passes them explicitly. A source that needs a key the operator has
    not set is excluded too (key_gates.py): it is turned on by entering the key.
    """
    normalized = enabled_sources([str(source).strip().lower() for source in sources if str(source).strip()])
    if not approved_scholarly_network_policy_enabled():
        return normalized
    allowed = set(APPROVED_SCHOLARLY_SOURCES)
    return [source for source in normalized if source in allowed]


def default_literature_sources(objective_text: str = "") -> list[str]:
    """Keyless, multi-domain literature sources.

    OpenAlex + Crossref are cross-domain and cover graphics, ML, physics,
    economics, biomedicine, etc. The domain-specific source is chosen SYMMETRICALLY
    from the objective/query text: PubMed (biomedical-only) for a biomedical intent,
    arXiv (graphics/ML/physics/math preprints) for everything else. This stops a
    computer-graphics objective from being flooded with off-topic biomedical papers
    (which left the gatekeeper with no relevant prior-art baseline to score novelty
    against) and instead gives it a real cs/graphics prior-art baseline. Scopus is
    added only when an Elsevier key is configured.
    """
    if approved_scholarly_network_policy_enabled():
        return enabled_sources(APPROVED_SCHOLARLY_SOURCES)
    sources = enabled_sources(["openalex", "crossref"])
    if objective_is_biomedical(objective_text):
        sources.append("pubmed")
    else:
        sources.extend(enabled_sources(["arxiv", "semanticscholar"]))
    if scopus_enabled():
        sources.append("scopus")
    return sources


def collect_from_source(source_name: str, query: str) -> list[dict]:
    if source_name == "openalex":
        return [normalize_paper(result) for result in search_openalex(query)]
    if source_name == "crossref":
        return [normalize_crossref_paper(result) for result in search_crossref(query)]
    if source_name == "arxiv":
        return [normalize_arxiv_paper(result) for result in search_arxiv(query)]
    if source_name == "pubmed":
        return [normalize_pubmed_paper(result) for result in search_pubmed(query)]
    if source_name == "scopus":
        return [normalize_scopus_paper(result) for result in search_scopus(query)]
    if source_name == "semanticscholar":
        return [normalize_semanticscholar_paper(result) for result in search_semanticscholar(query)]
    return []


def select_literature_sources(requested: Sequence[str] | None, objective_text: str = "") -> list[str]:
    """The sources one probe asks: the caller's choice, else the defaults.

    ``requested`` holds names or comma-separated lists (``--sources`` values).
    An unknown name is refused rather than silently dropped, and the network
    policy still removes any source it does not allow.
    """
    names: list[str] = []
    for item in requested or []:
        for name in str(item).split(","):
            name = name.strip().lower()
            if name and name not in names:
                names.append(name)
    if not names:
        return default_literature_sources(objective_text)
    unknown = [name for name in names if name not in KNOWN_LITERATURE_SOURCES]
    if unknown:
        raise ValueError(
            f"unknown literature source(s) {unknown}; known: {', '.join(KNOWN_LITERATURE_SOURCES)}"
        )
    return allowed_literature_sources(names)


def _is_throttle_error(error: Exception) -> bool:
    """True when the provider refused this request for rate, not for content.

    429 and 503 are the two codes the polite-fetch layer already retries; by the
    time a failure reaches here those retries are spent, so the source dropped
    out of this round for a reason no amount of re-querying the SAME round will
    fix -- and equally, a reason a later lane may well get past.
    """
    code = getattr(error, "code", None)
    if code in (429, 503):
        return True
    text = str(error)
    return "429" in text or "Too Many Requests" in text or "503" in text


def collect_query_papers(query: str, sources: list[str], objective: str = "") -> tuple[list[dict], dict]:
    # Retrieval caches are context-bound. A changed objective/source set/policy
    # must not silently reuse a former corpus as current accepted evidence.
    sources = allowed_literature_sources(sources)
    context = screening_context(objective or query, sources)
    cache_key = json.dumps({"query": query, "context": context}, sort_keys=True)
    cache_path = query_cache_path(cache_key)
    if cache_path.exists():
        try:
            payload = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            payload = {}
        if (payload.get("schema_version") == QUERY_CACHE_SCHEMA_VERSION
                and payload.get("screening_context") == context):
            # A former all-provider failure is not a completed empty search.
            # Ignore (and remove when possible) any legacy partial/failure cache
            # so repaired providers are retried with the same objective/context.
            if not (payload.get("source_stats") or {}).get("source_failures"):
                return payload.get("papers", []), payload.get("source_stats", {})
            try:
                cache_path.unlink()
            except OSError:
                pass

    papers: list[dict] = []
    source_hits: dict[str, int] = {}
    source_failures: list[dict] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(sources))) as executor:
        future_to_source = {
            executor.submit(collect_from_source, source_name, query): source_name
            for source_name in sources
        }
        for future in concurrent.futures.as_completed(future_to_source):
            source_name = future_to_source[future]
            try:
                source_results = future.result()
            except Exception as error:
                source_failures.append(
                    {
                        "source": source_name,
                        "query": query,
                        "error": str(error),
                        # Classified here rather than string-matched downstream.
                        # A source the provider refused for a moment and a source
                        # that genuinely holds nothing are the same empty result
                        # otherwise, and cycle-g-v91 could not tell them apart:
                        # OpenAlex 429'd, contributed 0 of 109 papers, and the
                        # cycle concluded the foundational literature did not
                        # exist rather than that it had not been fetched.
                        "throttled": _is_throttle_error(error),
                    }
                )
                continue

            hit_count = 0
            for paper in source_results:
                if not paper.get("title"):
                    continue
                if not paper_is_relevant(paper):
                    continue
                papers.append(paper)
                hit_count += 1
            source_hits[source_name] = hit_count

    papers = merge_candidate_records(papers)
    papers.sort(key=paper_score, reverse=True)
    payload = {
        "schema_version": QUERY_CACHE_SCHEMA_VERSION,
        "screening_context": context,
        # Each provider already enforces its page size. Do not globally truncate
        # the union by citation score: that silently erases recent low-citation
        # preprints before a reviewer can compare the two evidence tracks.
        "papers": papers,
        "source_stats": {
            "query": query,
            "sources_attempted": sources,
            "source_hits": source_hits,
            "source_failures": source_failures,
            "evidence_status": "retrieval_candidates_only",
        },
    }
    # Retrieval failures are transient and must not become a durable empty (or
    # partial) corpus. Semantic abstract reviews live in their own review store,
    # so declining to cache this provider result never discards a completed read.
    if not source_failures:
        cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload["papers"], payload["source_stats"]

def expansion_queries(
    seed_queries: list[str],
    papers: list[dict],
    scenarios: list[dict] | None = None,
    frontier_catalog: dict | None = None,
) -> list[str]:
    """Compatibility surface: query expansions require a semantic reviewer.

    A title-derived term or generic methodology tail can drift to another field.
    The scout authors refinements after reading the abstract-review queue; the
    driver never invents expansions or pads an evidence-count target.
    """
    return []


def collect_papers(queries: list[str], role_plan: dict | None = None) -> tuple[list[dict], dict]:
    """Retrieve candidates, then admit only reviewed, quality-eligible evidence.

    Generated expansions previously used unreviewed titles and padded a minimum
    count with off-topic papers. Query refinement now belongs to the semantic
    reviewer; this pass retrieves only explicitly authored queries.
    """
    objective = objective_from_plan(role_plan, queries)
    sources = default_literature_sources(objective)
    source_stats = {
        "queries": len(queries), "sources_attempted": sources,
        "source_hits": {}, "source_failures": [], "seed_queries": queries,
        "discovered_queries": [], "hypothesis_scenarios": [],
        "frontier_catalog": {"primary_variable_families": [], "family_support_counts": {}},
    }
    candidates = []
    for query in queries:
        query_papers, query_stats = collect_query_papers(query, sources, objective)
        source_stats["source_failures"].extend(query_stats.get("source_failures", []))
        for source_name, count in query_stats.get("source_hits", {}).items():
            source_stats["source_hits"][source_name] = source_stats["source_hits"].get(source_name, 0) + count
        candidates.extend(query_papers)
    # Ranking orders a review queue; it is not a relevance judgment.
    candidates = merge_candidate_records(candidates)
    candidates = diversify_ranked_papers(candidates, len(candidates))
    reviews = (role_plan or {}).get("literature_reviews")
    # Attach citation evidence BEFORE the quality gate decides, for the papers
    # that cannot clear it on recency. The gate's established-impact track needs
    # a verified count; nothing supplied one, so on cycle-g-v91 nothing older
    # than 2021 was admitted and the foundational audit could never close. An
    # enrichment step existed but ran AFTER admission, where it cannot help a
    # paper the gate has already dropped.
    source_stats["citation_evidence"] = attach_citation_evidence(candidates)
    papers, screening = screen_papers(candidates, objective, sources, reviews)
    source_stats["screening"] = screening
    source_stats["evidence_status"] = "reviewed_evidence" if papers else "no_admitted_evidence"
    if papers:
        source_stats["frontier_catalog"] = infer_frontier_catalog(papers, role_plan)
        source_stats["hypothesis_scenarios"] = generate_hypothesis_scenarios(papers, role_plan)[:6]
    return papers, source_stats


def synthesize_from_local_papers(queries: list[str], output_dir: Path,
                                 role_plan: dict | None = None) -> tuple[list[dict], dict]:
    """Revalidate local records against this objective; no lexical backfill."""
    candidates = load_local_scout_papers(output_dir)
    objective = objective_from_plan(role_plan, queries)
    sources = default_literature_sources(objective)
    papers, screening = screen_papers(
        candidates, objective, sources, (role_plan or {}).get("literature_reviews")
    )
    return papers, {
        "queries": len(queries), "sources_attempted": ["local-scout-cache"],
        "source_hits": {"local-scout-cache": len(candidates)}, "source_failures": [],
        "screening": screening,
    }


def merge_paper_lists(primary: list[dict], supplemental: list[dict], limit: int = MAX_TOTAL_PAPERS) -> list[dict]:
    merged: list[dict] = []
    seen: set[tuple[str | None, str]] = set()
    for paper in [*primary, *supplemental]:
        key = (
            paper.get("doi") or paper.get("pmid") or paper.get("openalex_id"),
            paper.get("title", ""),
        )
        if key in seen or not paper.get("title"):
            continue
        seen.add(key)
        merged.append(paper)
        if len(merged) >= limit:
            break
    return diversify_ranked_papers(merged, limit)


def merge_source_stats(primary: dict, supplemental: dict) -> dict:
    sources_attempted = []
    for source_name in [*(primary.get("sources_attempted") or []), *(supplemental.get("sources_attempted") or [])]:
        if source_name not in sources_attempted:
            sources_attempted.append(source_name)
    source_hits: dict[str, int] = {}
    for payload in [primary, supplemental]:
        for source_name, hit_count in (payload.get("source_hits") or {}).items():
            source_hits[source_name] = source_hits.get(source_name, 0) + int(hit_count or 0)
    return {
        "queries": max(int(primary.get("queries") or 0), int(supplemental.get("queries") or 0)),
        "sources_attempted": sources_attempted,
        "source_hits": source_hits,
        "source_failures": [*(primary.get("source_failures") or []), *(supplemental.get("source_failures") or [])],
        "seed_queries": primary.get("seed_queries") or supplemental.get("seed_queries") or [],
        "discovered_queries": primary.get("discovered_queries") or supplemental.get("discovered_queries") or [],
        "hypothesis_scenarios": primary.get("hypothesis_scenarios") or supplemental.get("hypothesis_scenarios") or [],
        "frontier_catalog": primary.get("frontier_catalog") or supplemental.get("frontier_catalog") or {},
    }
