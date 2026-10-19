"""Look up a KNOWN paper by its title, arXiv ID or DOI.

MEASURED ON cycle-b-20260918, 2026-09-18/19: 4,617 retrieved candidates
and 290 accepted papers, and not one of Diffusion Policy, RT-2, OpenVLA, pi0,
Octo, ACT/ALOHA, Open X-Embodiment, DROID, ManiSkill3, Eureka, RMA or legged_gym
was accepted; most were never retrieved at all. Keyword search ranks by the
query's words, so a landmark whose title does not share them is invisible to it,
and CoRL/RSS/NeurIPS proceedings are thinly indexed by the registries that
search reached. A scout that KNEW the field's reference points had no way to
ask for one by name.

This module answers "fetch THIS paper". It never decides that a paper is
relevant or good: a resolved paper enters the same pending abstract-review
queue as a keyword hit, and the same screening and quality rules decide it.

Resolution is conservative. Each source's candidates are scored by normalized
title similarity to the request; only one clearly best WORK is reported as
matched. Two different works that both fit, or a near miss, is "ambiguous" and
nothing is admitted to the queue -- the caller learns the candidate titles and
can ask again with the exact title or an identifier.
"""

from __future__ import annotations

import concurrent.futures
import difflib
import re
import unicodedata

from .citation_graph import bare_arxiv_id, bare_doi
from .http_client import clean_text
from .normalize import (
    normalize_arxiv_paper,
    normalize_crossref_paper,
    normalize_paper,
    normalize_semanticscholar_paper,
)
from .providers import (
    fetch_arxiv_ids,
    lookup_crossref_doi,
    lookup_openalex_doi,
    search_arxiv_title,
    search_crossref_title,
    search_openalex_title,
    semanticscholar_match_title,
    semanticscholar_paper,
)

TITLE_LOOKUP_SOURCES = ("arxiv", "semanticscholar", "openalex", "crossref")
# At or above this similarity a candidate IS the requested title (casing,
# punctuation and a trailing period aside). Measured against the six landmark
# titles of the cycle-b-20260918 smoke run, every true match scored 1.0.
MATCH_THRESHOLD = 0.90
# Below the match threshold but above this, the request probably meant this
# paper and said it differently. Reported, never admitted.
AMBIGUOUS_FLOOR = 0.75
# Two distinct works whose scores are this close are indistinguishable by title.
TIE_MARGIN = 0.03
# Candidates whose titles are this similar and whose years are this close are
# the same work in two indexes (preprint and proceedings, say).
SAME_WORK_SIMILARITY = 0.95
SAME_WORK_YEAR_SPAN = 3
# Where each field comes from when several sources carry it. The author's own
# preprint abstract first: it is verbatim, where a registry abstract is often
# stripped markup or missing.
ABSTRACT_PREFERENCE = ("arxiv", "semanticscholar", "openalex", "crossref")


def normalize_title(value: str | None) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def title_similarity(requested: str, candidate: str) -> float:
    """How well a candidate title answers the request, 0..1.

    A request that names only the part before a subtitle ("Diffusion Policy")
    scores MATCH_THRESHOLD exactly against "Diffusion Policy: Visuomotor ...",
    so it can match -- but a second work with the same head then ties it and
    the lookup reports ambiguity instead of picking one.
    """
    wanted, found = normalize_title(requested), normalize_title(candidate)
    if not wanted or not found:
        return 0.0
    if wanted == found:
        return 1.0
    score = difflib.SequenceMatcher(None, wanted, found).ratio()
    head = normalize_title(re.split(r"[:–—]|\s-\s", clean_text(candidate), maxsplit=1)[0])
    if head and head == wanted and ":" not in clean_text(requested):
        score = max(score, MATCH_THRESHOLD)
    return round(score, 4)


def _record_arxiv_id(paper: dict) -> str:
    for field in ("arxiv_id", "url", "metadata_provenance"):
        value = paper.get(field)
        if isinstance(value, dict):
            value = value.get("source_url")
        found = bare_arxiv_id(value) if value else ""
        if found:
            return found
    doi = bare_doi(paper.get("doi"))
    if doi.startswith("10.48550/arxiv."):
        return bare_arxiv_id(doi[len("10.48550/arxiv."):])
    return ""


def _year(paper: dict) -> int | None:
    try:
        return int(paper.get("year"))
    except (TypeError, ValueError):
        return None


def _same_work(left: dict, right: dict) -> bool:
    left_doi, right_doi = bare_doi(left.get("doi")), bare_doi(right.get("doi"))
    if left_doi and left_doi == right_doi:
        return True
    left_arxiv, right_arxiv = _record_arxiv_id(left), _record_arxiv_id(right)
    if left_arxiv and left_arxiv == right_arxiv:
        return True
    if left_arxiv and right_arxiv and left_arxiv != right_arxiv:
        return False
    similar = difflib.SequenceMatcher(
        None, normalize_title(left.get("title")), normalize_title(right.get("title"))
    ).ratio() >= SAME_WORK_SIMILARITY
    years = (_year(left), _year(right))
    close_in_time = None in years or abs(years[0] - years[1]) <= SAME_WORK_YEAR_SPAN
    return similar and close_in_time


def _group_works(scored: list[tuple[float, dict]]) -> list[dict]:
    """Candidates joined into works, transitively.

    A Semantic Scholar record often links the other two: it shares the arXiv ID
    with the preprint and the DOI with the journal version, which share nothing
    with each other. Grouping must follow that chain, or one paper splits into
    two "works" that tie and read as ambiguous.
    """
    works: list[dict] = []
    for score, paper in scored:
        joined = [work for work in works if any(_same_work(paper, member) for member in work["members"])]
        merged = {"score": score, "members": [paper]}
        for work in joined:
            merged["score"] = max(merged["score"], work["score"])
            merged["members"] = work["members"] + merged["members"]
            works.remove(work)
        works.append(merged)
    works.sort(key=lambda work: -work["score"])
    return works


def _preferred_doi(members: list[dict]) -> str:
    """A publisher DOI when one exists, else the arXiv DataCite DOI a source reported."""
    dois = [bare_doi(member.get("doi")) for member in members]
    dois = [doi for doi in dois if doi]
    for doi in dois:
        if not doi.startswith("10.48550/"):
            return doi
    return dois[0] if dois else ""


def _venue(members: list[dict]) -> str:
    for member in members:
        journal = clean_text(member.get("journal"))
        if journal and "arxiv" not in journal.lower():
            return journal
    return ""


def merge_work(members: list[dict]) -> dict:
    """One record for one work, with every source's contribution attributed.

    Fields come from the most trustworthy source that carries them; a citation
    count is the largest SOURCED observation, never a sum, exactly as
    screening.merge_candidate_records treats one. The earliest publication date
    wins, which can only make the recency track stricter.
    """
    order = {source: index for index, source in enumerate(ABSTRACT_PREFERENCE)}
    ordered = sorted(members, key=lambda member: order.get(member.get("source"), len(order)))
    merged = dict(ordered[0])
    for member in ordered[1:]:
        if not clean_text(merged.get("abstract")) and clean_text(member.get("abstract")):
            for field in ("abstract", "abstract_snippet", "abstract_available", "full_text_status", "kg_seed_basis", "kg_usable"):
                if field in member:
                    merged[field] = member[field]
            merged["abstract_provenance"] = member.get("metadata_provenance")
        for field, value in member.items():
            if merged.get(field) in (None, "", []):
                merged[field] = value
    if clean_text(merged.get("abstract")) and not merged.get("abstract_provenance"):
        merged["abstract_provenance"] = merged.get("metadata_provenance")
    observations = []
    for member in ordered:
        provenance = member.get("citation_count_provenance")
        if isinstance(provenance, dict) and provenance.get("source_url") and provenance not in observations:
            observations.append(provenance)
    counted = [item for item in observations if isinstance(item.get("value"), int)]
    if counted:
        best = max(counted, key=lambda item: item["value"])
        merged["cited_by_count"] = best["value"]
        merged["citation_count_provenance"] = best
        merged["citation_observations"] = observations
    dates = sorted(clean_text(member.get("publication_date")) for member in ordered if clean_text(member.get("publication_date")))
    if dates:
        merged["publication_date"] = dates[0]
        if dates[0][:4].isdigit():
            merged["year"] = int(dates[0][:4])
    doi = _preferred_doi(ordered)
    merged["doi"] = doi or None
    arxiv_id = next((found for found in (_record_arxiv_id(member) for member in ordered) if found), "")
    if arxiv_id:
        merged["arxiv_id"] = arxiv_id
    for field in ("openalex_id", "semanticscholar_id", "pmid"):
        value = next((member.get(field) for member in ordered if member.get(field)), None)
        if value:
            merged[field] = value
    venue = _venue(ordered)
    if venue:
        merged["journal"] = venue
        if merged.get("type") == "preprint":
            merged["type"] = next(
                (member.get("type") for member in ordered if member.get("type") not in (None, "", "preprint")),
                "article",
            )
    merged["retrieved_from_sources"] = sorted({str(member.get("source")) for member in ordered if member.get("source")})
    return merged


def _attempt(source: str, call, failures: list[dict], label: str) -> list[dict]:
    # Imported here for the same reason citation_graph does: collect imports the
    # providers, and the throttle classification must be the collector's own.
    from .collect import _is_throttle_error

    try:
        return [paper for paper in call() if isinstance(paper, dict) and paper.get("title")]
    except Exception as error:  # noqa: BLE001 - every failure is recorded, none is fatal
        failures.append({
            "source": source,
            "query": label,
            "error": str(error),
            "throttled": _is_throttle_error(error),
        })
        return []


def _title_calls(title: str) -> dict:
    return {
        "arxiv": lambda: [normalize_arxiv_paper(item) for item in search_arxiv_title(title)],
        "semanticscholar": lambda: [normalize_semanticscholar_paper(item) for item in semanticscholar_match_title(title)],
        "openalex": lambda: [normalize_paper(item) for item in search_openalex_title(title)],
        "crossref": lambda: [normalize_crossref_paper(item) for item in search_crossref_title(title)],
    }


def _arxiv_calls(arxiv_id: str) -> dict:
    def s2():
        found = semanticscholar_paper(f"arXiv:{arxiv_id}")
        return [normalize_semanticscholar_paper(found)] if found else []

    return {
        "arxiv": lambda: [normalize_arxiv_paper(item) for item in fetch_arxiv_ids([arxiv_id])],
        "semanticscholar": s2,
    }


def _doi_calls(doi: str) -> dict:
    def s2():
        found = semanticscholar_paper(f"DOI:{doi}")
        return [normalize_semanticscholar_paper(found)] if found else []

    def crossref():
        found = lookup_crossref_doi(doi)
        return [normalize_crossref_paper(found)] if found else []

    return {
        "semanticscholar": s2,
        "crossref": crossref,
        "openalex": lambda: [normalize_paper(item) for item in lookup_openalex_doi(doi)],
    }


def _run_sources(calls: dict, label: str) -> tuple[dict[str, list[dict]], list[dict]]:
    failures: list[dict] = []
    found: dict[str, list[dict]] = {}
    # One thread per source: each host keeps its own cross-process pacing, so
    # asking four different hosts at once costs nothing in politeness.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(calls))) as executor:
        futures = {executor.submit(_attempt, source, call, failures, label): source for source, call in calls.items()}
        for future in concurrent.futures.as_completed(futures):
            found[futures[future]] = future.result()
    return found, failures


def _candidate_summary(score: float, paper: dict) -> dict:
    return {
        "title": paper.get("title"), "year": paper.get("year"), "source": paper.get("source"),
        "similarity": score, "doi": bare_doi(paper.get("doi")) or None,
        "arxiv_id": _record_arxiv_id(paper) or None,
        "semanticscholar_id": paper.get("semanticscholar_id"),
        "abstract_available": bool(clean_text(paper.get("abstract"))),
    }


def _identifier_matches(kind: str, value: str, paper: dict) -> bool:
    if kind == "doi":
        return bare_doi(paper.get("doi")) == value
    return _record_arxiv_id(paper) == value


def resolve_reference(kind: str, value: str) -> dict:
    """Resolve one title / arXiv ID / DOI to at most one work.

    Returns the per-request resolution record, with the merged paper under
    ``paper`` when -- and only when -- the status is ``matched``.
    """
    requested = clean_text(value)
    resolution = {"request": {"kind": kind, "value": requested}, "status": "not_found",
                  "sources_attempted": [], "source_hits": {}, "source_failures": [],
                  "candidates": [], "paper": None}
    if kind == "title":
        if len(normalize_title(requested)) < 4:
            resolution["status"] = "invalid_request"
            return resolution
        label = f"title:{requested}"
        calls = _title_calls(requested)
    elif kind == "arxiv_id":
        requested = bare_arxiv_id(requested)
        if not requested:
            resolution["status"] = "invalid_request"
            return resolution
        label = f"arxiv:{requested}"
        calls = _arxiv_calls(requested)
    elif kind == "doi":
        requested = bare_doi(requested)
        if not requested:
            resolution["status"] = "invalid_request"
            return resolution
        label = f"doi:{requested}"
        calls = _doi_calls(requested)
    else:
        raise ValueError(f"unknown lookup kind {kind!r}")
    resolution["request"]["value"] = requested
    resolution["query"] = label
    found, failures = _run_sources(calls, label)
    # Threads finish in any order; read the sources in their declared order.
    found = {source: found.get(source) or [] for source in calls}
    resolution["sources_attempted"] = list(calls)
    resolution["source_hits"] = {source: len(found.get(source) or []) for source in calls}
    resolution["source_failures"] = failures

    if kind == "title":
        scored = [(title_similarity(requested, paper.get("title")), paper)
                  for papers in found.values() for paper in papers]
    else:
        # An identifier lookup matches only a record that CARRIES the
        # identifier; other records join it only as the same work by title.
        anchors = [paper for papers in found.values() for paper in papers
                   if _identifier_matches(kind, requested, paper)]
        anchor_title = anchors[0].get("title") if anchors else ""
        scored = [(1.0 if _identifier_matches(kind, requested, paper)
                   else title_similarity(anchor_title, paper.get("title")) if anchor_title else 0.0, paper)
                  for papers in found.values() for paper in papers]
    works = _group_works([(score, paper) for score, paper in scored if score >= AMBIGUOUS_FLOOR])
    resolution["candidates"] = [
        _candidate_summary(score, paper)
        for score, paper in sorted(scored, key=lambda item: -item[0])[:5]
    ]
    if not works:
        return resolution
    best = works[0]
    rivals = [work for work in works[1:]
              if work["score"] >= MATCH_THRESHOLD and best["score"] - work["score"] <= TIE_MARGIN]
    # An exact title beats a near one; two exact titles, or two near ones, are
    # different works the request cannot tell apart.
    tied = bool(rivals) and (best["score"] < 1.0 or any(work["score"] >= 1.0 for work in rivals))
    if best["score"] < MATCH_THRESHOLD or tied:
        resolution["status"] = "ambiguous"
        return resolution
    members = best["members"]
    # An arXiv-backed work with no abstract anywhere: the preprint has one.
    if not any(clean_text(member.get("abstract")) for member in members):
        arxiv_id = next((found_id for found_id in (_record_arxiv_id(member) for member in members) if found_id), "")
        if arxiv_id and "arxiv" not in calls:
            extra, extra_failures = _run_sources(_arxiv_calls(arxiv_id), label)
            resolution["source_failures"].extend(extra_failures)
            members.extend(paper for paper in extra.get("arxiv") or [] if _record_arxiv_id(paper) == arxiv_id)
    paper = merge_work(members)
    paper["title_resolution"] = {
        "request": dict(resolution["request"]),
        "status": "matched",
        "similarity": best["score"],
        "matched_sources": sorted({str(member.get("source")) for member in members}),
        "ids": {key: paper.get(key) for key in ("doi", "arxiv_id", "semanticscholar_id", "openalex_id") if paper.get(key)},
    }
    resolution.update({
        "status": "matched",
        "similarity": best["score"],
        "matched_sources": paper["title_resolution"]["matched_sources"],
        "ids": paper["title_resolution"]["ids"],
        "title": paper.get("title"),
        "year": paper.get("year"),
        "abstract_available": bool(clean_text(paper.get("abstract"))),
        "paper": paper,
    })
    return resolution


def align_with_existing(papers: list[dict], existing: list[dict]) -> list[dict]:
    """Give a resolved paper the identity the lane already knows it by.

    Without this a landmark that a keyword probe had already queued (as an
    OpenAlex record, say) would come back from a title lookup under its
    publisher DOI and sit in the review queue twice. The identity fields are
    copied from the existing record so the screening merge folds the two
    together -- keeping the existing abstract, and so any review already bound
    to its hash -- while the resolved record's own IDs stay under
    ``title_resolution``.
    """
    aligned = []
    for paper in papers:
        twin = next((item for item in existing if isinstance(item, dict) and _same_work(paper, item)), None)
        if twin is not None:
            paper = dict(paper)
            for field in ("doi", "pmid", "openalex_id", "arxiv_id", "url"):
                paper[field] = twin.get(field)
        aligned.append(paper)
    return aligned


def lookup_references(titles: list[str] | None = None, arxiv_ids: list[str] | None = None,
                      dois: list[str] | None = None) -> dict:
    """Resolve every requested reference; shaped like a --query probe result."""
    requests = [("title", item) for item in titles or []]
    requests += [("arxiv_id", item) for item in arxiv_ids or []]
    requests += [("doi", item) for item in dois or []]
    resolutions = [resolve_reference(kind, value) for kind, value in requests]
    papers = [item["paper"] for item in resolutions if item.get("paper")]
    attempted: list[str] = []
    hits: dict[str, int] = {}
    failures: list[dict] = []
    for item in resolutions:
        for source in item["sources_attempted"]:
            if source not in attempted:
                attempted.append(source)
        for source, count in item["source_hits"].items():
            hits[source] = hits.get(source, 0) + count
        failures.extend(item["source_failures"])
    summaries = [{key: value for key, value in item.items() if key != "paper"} for item in resolutions]
    query = " | ".join(item.get("query") or f"{item['request']['kind']}:{item['request']['value']}" for item in resolutions)
    counts = {status: sum(1 for item in resolutions if item["status"] == status)
              for status in ("matched", "ambiguous", "not_found", "invalid_request")}
    source_stats = {
        "query": query,
        "inquiry_intent": "known_item_lookup",
        "sources_attempted": attempted,
        "source_hits": hits,
        "source_failures": failures,
        "title_resolutions": summaries,
        "resolution_counts": counts,
        "evidence_status": "retrieval_candidates_only",
    }
    return {
        "query": query,
        "inquiry_intent": "known_item_lookup",
        "sources": attempted,
        "lookups": summaries,
        "resolution_counts": counts,
        "paper_count": len(papers),
        "source_stats": source_stats,
        "evidence_status": "retrieval_candidates_only",
        "papers": papers,
    }
