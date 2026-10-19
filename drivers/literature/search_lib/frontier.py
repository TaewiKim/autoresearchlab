"""Forward-citation frontier harvest: the post-horizon work a landscape cannot recall.

A field-landscape scout names canonical and frontier works from its model's own
memory, then verifies them by lookup. A model cannot name what was published
after its knowledge horizon, so the newest frontier of every subfield reaches a
landscape only by accident.

MEASURED ON cycle-b-20260919, 2026-09-19. The owner named SimToolReal
(Kedia, Lum, Bohg, Liu; RSS 2026; arXiv 2602.16863; 17 citations about seven
months after release) as a representative SOTA paper the harness never found.
A gatekeeper's prior-art search had retrieved it exactly once; it sat in
`pending_abstract_review`, was never reviewed, and never reached the landscape.
It cites five of the landscape's canonical anchors (Diffusion Policy, ACT/ALOHA,
learning dexterous in-hand manipulation, RMA, Isaac Gym). Semantic Scholar's
single-paper recommendations for Diffusion Policy (from=recent, 100 results) did
not include it.

So discovery is by the citation graph, from data the cycle already verified: for
each anchor (a canonical work of the cycle's published landscape) page through
the papers that cite it, keep those published on or after ``since`` (the
knowledge horizon), and rank them by how many DISTINCT anchors each cites and by
how fast it is being cited. Nothing here names a venue, an author, a keyword or a
paper; the anchors and the horizon are inputs.

Scoring (documented because the ranking is the whole point):

    velocity    = citationCount / max(1, months since publication)
    co_citation = number of distinct anchors the paper cites
    score       = co_citation * log1p(1 + velocity)

A candidate needs ``co_citation >= 2`` (``RESEARCHLAB_FRONTIER_MIN_CO_CITATION``)
unless fewer than two anchors resolved, so one popular anchor's long tail of
citers cannot flood the ranking. The log keeps a single viral paper from
outranking one that builds on several of the field's foundations.

Previously retrieved but never reviewed candidates from the cycle's own lanes are
revived through the same filter: their dates are checked against ``since`` and
their co-citation is measured from their own reference lists, so a paper the
page cap missed is still scored by the same rule.

Only GET requests reach the network, through the shared polite fetch layer
(per-host pacing across processes and the bounded 429 backoff). Citation pages
are cached under the literature cache with a TTL, and the number of pages per
anchor is capped; a capped anchor is reported as truncated.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

from .constants import CACHE_ROOT, SEMANTIC_SCHOLAR_API_URL
from .key_gates import disabled_reason, source_enabled
from .http_client import REQUEST_STATS, _fetch_body, clean_text
from .normalize import normalize_semanticscholar_paper
from .screening import paper_identity

FRONTIER_CITATION_FIELDS = "title,year,publicationDate,venue,externalIds,citationCount,abstract"
_ANCHOR_FIELDS = "paperId,title,year,citationCount,externalIds"
FRONTIER_CACHE_ROOT = CACHE_ROOT / "frontier-citations"
SCHEMA_VERSION = "frontier-harvest-v1"
SCORE_FORMULA = "score = co_citation * log1p(1 + velocity); velocity = citationCount / max(1, months since publication)"
# The Graph API refuses an offset past this on citation lists.
_MAX_OFFSET = 9_999
_S2_HEX_ID = re.compile(r"^[0-9a-f]{40}$")
_ARXIV_ID = re.compile(r"^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$", re.IGNORECASE)

Fetch = Callable[[str], dict]


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    try:
        value = int(str(os.environ.get(name, "")).strip())
    except ValueError:
        return default
    return value if value >= minimum else default


def max_pages_per_anchor() -> int:
    return _env_int("RESEARCHLAB_FRONTIER_MAX_PAGES_PER_ANCHOR", 10, 1)


def page_size() -> int:
    return min(_env_int("RESEARCHLAB_FRONTIER_PAGE_SIZE", 1000, 1), 1000)


def cache_ttl_seconds() -> float:
    return _env_int("RESEARCHLAB_FRONTIER_CACHE_TTL_HOURS", 72, 0) * 3600.0


def default_top_k() -> int:
    return _env_int("RESEARCHLAB_FRONTIER_TOP_K", 20, 1)


def max_revived() -> int:
    return _env_int("RESEARCHLAB_FRONTIER_MAX_REVIVED", 30, 0)


def throttle_retries() -> int:
    return _env_int("RESEARCHLAB_FRONTIER_THROTTLE_RETRIES", 4, 0)


def throttle_wait_seconds() -> float:
    return float(_env_int("RESEARCHLAB_FRONTIER_THROTTLE_WAIT_SECONDS", 15, 0))


def deadline_seconds() -> int:
    """Wall-clock budget for one harvest; 0 means none. The harness sets it just
    under the lane's timeout so the lane always writes what it has."""
    return _env_int("RESEARCHLAB_FRONTIER_DEADLINE_SECONDS", 0, 0)


def _past_deadline(stats: dict) -> bool:
    deadline = stats.get("deadline_at")
    return bool(deadline) and time.monotonic() >= deadline


_sleep = time.sleep


# --- the horizon -----------------------------------------------------------------


def _subtract_months(day: date, months: int) -> date:
    index = day.year * 12 + (day.month - 1) - months
    year, month = divmod(index, 12)
    month += 1
    # Clamp the day to the target month's length.
    next_month = date(year + (month // 12), (month % 12) + 1, 1)
    last_day = (next_month - timedelta(days=1)).day
    return date(year, month, min(day.day, last_day))


def knowledge_horizon(cycle_date: date | None = None) -> tuple[date, str]:
    """``since`` for a harvest, and where it came from.

    ``RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON`` (YYYY-MM-DD) is the model's horizon
    as configured by the owner. Without it, the horizon is the cycle date minus
    ``RESEARCHLAB_FRONTIER_WINDOW_MONTHS`` (default 18). No date lives in code.
    """
    raw = clean_text(os.environ.get("RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON"))
    if raw:
        try:
            return date.fromisoformat(raw[:10]), "RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON"
        except ValueError:
            pass
    window = _env_int("RESEARCHLAB_FRONTIER_WINDOW_MONTHS", 18, 0)
    base = cycle_date or datetime.now(timezone.utc).date()
    return _subtract_months(base, window), f"cycle_date {base.isoformat()} minus {window} months"


def publication_date(record: dict) -> tuple[date | None, str]:
    """(date, precision). A year-only record is dated to the END of its year, so
    a paper is never dropped for a missing month; its precision says so."""
    raw = clean_text(record.get("publicationDate") or record.get("publication_date"))
    if raw:
        try:
            return date.fromisoformat(raw[:10]), "day"
        except ValueError:
            pass
    try:
        year = int(str(record.get("year") or "").strip()[:4])
    except ValueError:
        return None, "unknown"
    return date(year, 12, 31), "year"


def months_between(start: date, end: date) -> float:
    return max(0.0, (end - start).days / 30.4375)


def score_candidate(co_citation: int, citation_count: int | None, published: date | None, as_of: date) -> dict:
    months = months_between(published, as_of) if published else None
    count = max(0, int(citation_count or 0))
    velocity = count / max(1.0, months if months is not None else 1.0)
    return {
        "co_citation": co_citation,
        "citation_count": count,
        "months_since_publication": round(months, 2) if months is not None else None,
        "velocity": round(velocity, 4),
        "score": round(co_citation * math.log1p(1.0 + velocity), 4),
    }


# --- identifiers -----------------------------------------------------------------


def graph_id(paper_id: str) -> str:
    """A Semantic Scholar Graph identifier for a cycle paper id, or "".

    The cycle stamps ids as the screening gate's ``paper_identity``:
    ``doi:<doi>``, ``arxiv_id:<id>``, ``pmid:<id>``; a DataCite arXiv DOI is
    asked for by its arXiv id, which the Graph API resolves more reliably.
    """
    text = clean_text(paper_id)
    lower = text.lower()
    for prefix in ("doi:10.48550/arxiv.", "10.48550/arxiv.", "https://doi.org/10.48550/arxiv."):
        if lower.startswith(prefix):
            return "arXiv:" + text[len(prefix):]
    for prefix in ("arxiv_id:", "arxiv:"):
        if lower.startswith(prefix):
            return "arXiv:" + text[len(prefix):].strip()
    for prefix in ("semanticscholar_id:", "s2:", "corpusid:"):
        if lower.startswith(prefix):
            rest = text[len(prefix):].strip()
            return ("CorpusId:" + rest) if prefix == "corpusid:" else rest
    if lower.startswith("pmid:"):
        return "PMID:" + text[5:].strip()
    if lower.startswith("doi:"):
        return "DOI:" + text[4:].strip()
    if lower.startswith("10.") and "/" in text:
        return "DOI:" + text
    if _S2_HEX_ID.match(lower):
        return lower
    if _ARXIV_ID.match(text):
        return "arXiv:" + text
    return ""


def normalized_title(title: str | None) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", clean_text(title).lower()))


def paper_aliases(paper: dict) -> list[str]:
    """Every key by which the same work is recognised across lanes and sources."""
    aliases = []
    doi = clean_text(paper.get("doi")).lower()
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi)
    if doi:
        aliases.append("doi:" + doi)
        match = re.match(r"^10\.48550/arxiv\.(.+)$", doi)
        if match:
            aliases.append("arxiv:" + re.sub(r"v\d+$", "", match.group(1)))
    arxiv = clean_text(paper.get("arxiv_id"))
    if arxiv:
        aliases.append("arxiv:" + re.sub(r"v\d+$", "", arxiv.lower()))
    s2 = clean_text(paper.get("semanticscholar_id") or paper.get("paperId")).lower()
    if s2:
        aliases.append("s2:" + s2)
    title = normalized_title(paper.get("title"))
    if title:
        aliases.append("title:" + title)
    return list(dict.fromkeys(aliases))


# --- the network, cached with a TTL ------------------------------------------------


def _cache_path(url: str) -> Path:
    return FRONTIER_CACHE_ROOT / (hashlib.sha256(url.encode("utf-8")).hexdigest() + ".json")


def cached_get(url: str, fetch: Fetch | None = None, stats: dict | None = None) -> dict:
    """One Graph API GET, from the TTL cache when it is fresh enough."""
    stats = stats if stats is not None else {}
    ttl = cache_ttl_seconds()
    path = _cache_path(url)
    if ttl > 0 and path.is_file():
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
            if time.time() - float(entry.get("fetched_at", 0)) <= ttl:
                stats["cache_hits"] = stats.get("cache_hits", 0) + 1
                return entry.get("payload") or {}
        except (OSError, ValueError, TypeError):
            pass
    # The shared fetch layer already backs off a 429 for a bounded ~20 s, which
    # suits a probe that has other sources to fall back on. A harvest has none:
    # a refused page is a hole in an anchor's citation list. MEASURED ON the
    # 2026-09-19 smoke from this host: 24 anonymous-pool 429s in 33 requests,
    # and two of five anchors left unresolved by a single refused lookup. So a
    # throttled request is retried here, patiently, a bounded number of times.
    attempt = 0
    while True:
        stats["requests"] = stats.get("requests", 0) + 1
        try:
            payload = fetch(url) if fetch is not None else json.loads(_fetch_body(url))
            break
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503) or attempt >= throttle_retries() or _past_deadline(stats):
                raise
            attempt += 1
            stats["throttled_retries"] = stats.get("throttled_retries", 0) + 1
            _sleep(throttle_wait_seconds() * attempt)
    try:
        FRONTIER_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"url": url, "fetched_at": time.time(), "payload": payload},
                                   ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return payload if isinstance(payload, dict) else {}


def _paper_url(identifier: str, fields: str) -> str:
    path = urllib.parse.quote(clean_text(identifier), safe=":/")
    return f"{SEMANTIC_SCHOLAR_API_URL}/paper/{path}?{urllib.parse.urlencode({'fields': fields})}"


def _failure(error: Exception) -> dict:
    code = getattr(error, "code", None)
    return {"error": str(error)[:300], "http_status": code, "throttled": code in (429, 503)}


def resolve_anchor(anchor: dict, fetch: Fetch | None, stats: dict) -> dict:
    """The Graph records of one anchor: its id lookup, plus every search hit with
    the SAME normalized title (a journal version and its proceedings version are
    often two records; together they hold the work's citations)."""
    records: dict[str, dict] = {}
    failures = []
    identifier = graph_id(anchor.get("paper_id") or "") or graph_id(anchor.get("arxiv_id") or "")
    if identifier:
        try:
            record = cached_get(_paper_url(identifier, _ANCHOR_FIELDS), fetch, stats)
            if record.get("paperId"):
                records[record["paperId"]] = record
        except urllib.error.HTTPError as error:
            if error.code != 404:
                failures.append({"lookup": identifier, **_failure(error)})
        except Exception as error:  # noqa: BLE001 - recorded, never fatal
            failures.append({"lookup": identifier, **_failure(error)})
    title = clean_text(anchor.get("title")) or clean_text(next(iter(records.values()), {}).get("title"))
    wanted = normalized_title(title)
    if wanted:
        query = urllib.parse.urlencode({"query": title[:300], "limit": "5", "fields": _ANCHOR_FIELDS})
        try:
            payload = cached_get(f"{SEMANTIC_SCHOLAR_API_URL}/paper/search?{query}", fetch, stats)
            for record in payload.get("data") or []:
                if isinstance(record, dict) and record.get("paperId") and normalized_title(record.get("title")) == wanted:
                    records.setdefault(record["paperId"], record)
        except urllib.error.HTTPError as error:
            if error.code != 404:
                failures.append({"lookup": f"title:{title[:80]}", **_failure(error)})
        except Exception as error:  # noqa: BLE001
            failures.append({"lookup": f"title:{title[:80]}", **_failure(error)})
    return {
        "anchor_id": clean_text(anchor.get("paper_id")) or identifier,
        "title": title or None,
        "graph_id": identifier or None,
        "records": [
            {"paperId": record["paperId"], "title": record.get("title"), "year": record.get("year"),
             "citationCount": record.get("citationCount")}
            for record in records.values()
        ],
        "failures": failures,
    }


def harvest_citations(s2_id: str, since: date, fetch: Fetch | None, stats: dict,
                      pages: int | None = None, limit: int | None = None) -> dict:
    """Every page of one record's citing papers, up to the page cap."""
    pages = pages or max_pages_per_anchor()
    limit = limit or page_size()
    kept: list[dict] = []
    seen = 0
    fetched = 0
    offset = 0
    truncated = False
    failure = None
    while True:
        if _past_deadline(stats):
            failure = {"error": "harvest deadline reached", "http_status": None, "throttled": False}
            truncated = True
            break
        if fetched >= pages:
            truncated = True
            break
        if offset > _MAX_OFFSET:
            truncated = True
            break
        params = urllib.parse.urlencode({
            "fields": FRONTIER_CITATION_FIELDS,
            "limit": str(min(limit, _MAX_OFFSET + 1 - offset)),
            "offset": str(offset),
        })
        url = f"{SEMANTIC_SCHOLAR_API_URL}/paper/{urllib.parse.quote(s2_id, safe=':/')}/citations?{params}"
        try:
            payload = cached_get(url, fetch, stats)
        except Exception as error:  # noqa: BLE001 - one anchor's refusal never ends the harvest
            failure = _failure(error)
            truncated = True
            break
        fetched += 1
        rows = [row.get("citingPaper") for row in payload.get("data") or [] if isinstance(row, dict)]
        rows = [row for row in rows if isinstance(row, dict) and row.get("paperId") and row.get("title")]
        seen += len(rows)
        for row in rows:
            published, _ = publication_date(row)
            if published is not None and published >= since:
                kept.append(row)
        next_offset = payload.get("next")
        if not rows or next_offset is None:
            break
        try:
            offset = int(next_offset)
        except (TypeError, ValueError):
            break
    return {"paperId": s2_id, "pages_fetched": fetched, "citing_seen": seen,
            "citing_since": len(kept), "truncated": truncated, "failure": failure, "papers": kept}


def reference_ids(s2_id: str, fetch: Fetch | None, stats: dict) -> set[str]:
    """The Graph paperIds a paper cites (one page: a reference list is short)."""
    params = urllib.parse.urlencode({"fields": "paperId", "limit": "1000"})
    url = f"{SEMANTIC_SCHOLAR_API_URL}/paper/{urllib.parse.quote(s2_id, safe=':/')}/references?{params}"
    payload = cached_get(url, fetch, stats)
    found = set()
    for row in payload.get("data") or []:
        cited = row.get("citedPaper") if isinstance(row, dict) else None
        if isinstance(cited, dict) and cited.get("paperId"):
            found.add(str(cited["paperId"]))
    return found


# --- the cycle's own unreviewed candidates -------------------------------------------


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _walk(root: Path, name: str, depth: int = 4) -> Iterable[Path]:
    if depth < 0 or not root.is_dir():
        return
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.is_file() and entry.name == name:
            yield entry
        elif entry.is_dir() and entry.name not in {"superseded-literature-handoffs", "sota-cards", "__pycache__"}:
            yield from _walk(entry, name, depth - 1)


def cycle_screening_state(roots: Iterable[Path]) -> tuple[dict[str, dict], set[str]]:
    """(stale, resolved): candidates pending review somewhere in the cycle and
    reviewed or excluded nowhere, keyed by their first alias; and every alias
    the cycle has resolved (accepted, or excluded/quarantined with reasons)."""
    pending: dict[str, dict] = {}
    resolved: set[str] = set()
    for root in roots:
        root = Path(root)
        for audit_path in _walk(root, "literature-screening-audit.json"):
            audit = _read_json(audit_path) or {}
            for key in ("excluded", "quarantined"):
                for item in audit.get(key) or []:
                    paper = item.get("paper") if isinstance(item, dict) else None
                    if isinstance(paper, dict) and (item.get("reasons") or item.get("review")):
                        resolved.update(paper_aliases(paper))
        for papers_path in _walk(root, "papers.json"):
            papers = _read_json(papers_path)
            papers = papers.get("papers") if isinstance(papers, dict) else papers
            for paper in papers if isinstance(papers, list) else []:
                if isinstance(paper, dict) and (paper.get("literature_screening") or {}).get("status") == "accepted":
                    resolved.update(paper_aliases(paper))
        for queue_path in _walk(root, "abstract-review-queue.json"):
            queue = _read_json(queue_path) or {}
            for item in queue.get("candidates") or []:
                paper = item.get("paper") if isinstance(item, dict) else None
                if not isinstance(paper, dict) or not str(item.get("status") or "").startswith("pending"):
                    continue
                aliases = paper_aliases(paper)
                if not aliases:
                    continue
                entry = pending.setdefault(aliases[0], {"paper": paper, "aliases": aliases, "retrieved_in": []})
                entry["retrieved_in"].append(str(queue_path.parent))
    stale = {key: entry for key, entry in pending.items() if not resolved.intersection(entry["aliases"])}
    return stale, resolved


# --- the harvest -----------------------------------------------------------------------


def load_anchors(path: Path) -> list[dict]:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        payload = payload.get("anchors") or payload.get("papers") or []
    anchors = []
    for item in payload if isinstance(payload, list) else []:
        if isinstance(item, str) and clean_text(item):
            anchors.append({"paper_id": clean_text(item)})
        elif isinstance(item, dict) and (clean_text(item.get("paper_id")) or clean_text(item.get("title"))):
            anchors.append(dict(item))
    seen, unique = set(), []
    for anchor in anchors:
        key = clean_text(anchor.get("paper_id")).lower() or normalized_title(anchor.get("title"))
        if key not in seen:
            seen.add(key)
            unique.append(anchor)
    return unique


def min_co_citation(resolved_anchor_count: int) -> int:
    configured = _env_int("RESEARCHLAB_FRONTIER_MIN_CO_CITATION", 2, 1)
    return 1 if resolved_anchor_count < 2 else configured


def rank_candidates(aggregated: dict[str, dict], since: date, as_of: date, minimum: int) -> list[dict]:
    """Apply the since/co-citation filter and the score; highest first."""
    ranked = []
    for entry in aggregated.values():
        record = entry["record"]
        published, precision = publication_date(record)
        if published is None or published < since:
            continue
        co_citation = len(entry["anchors"])
        if co_citation < minimum:
            continue
        # A year-only record passes the date filter at the END of its year (never
        # dropped for a missing month) but is aged from the START of it: dated to
        # December, a paper cited 19 times scored a velocity of 19 per month in the
        # 2026-09-19 smoke.
        aged_from = date(published.year, 1, 1) if precision == "year" else published
        scored = score_candidate(co_citation, record.get("citationCount"), aged_from, as_of)
        ranked.append({**scored, "record": record, "cites_anchors": sorted(entry["anchors"]),
                       "date_precision": precision, "publication_date": published.isoformat(),
                       "sources": sorted(entry.get("sources") or {"forward_citation"}),
                       "previously_retrieved_in": entry.get("retrieved_in") or []})
    ranked.sort(key=lambda item: (-item["score"], -item["co_citation"], -item["velocity"],
                                  clean_text(item["record"].get("title")).lower()))
    return ranked


def _candidate_paper(item: dict, since: date) -> dict:
    paper = dict(normalize_semanticscholar_paper(item["record"]))
    paper["frontier_harvest"] = {
        "post_horizon": True, "since": since.isoformat(), "score": item["score"],
        "co_citation": item["co_citation"], "velocity": item["velocity"],
        "cites_anchors": item["cites_anchors"], "sources": item["sources"],
    }
    return paper


def run_frontier_harvest(
    anchors: list[dict],
    since: date,
    *,
    output_dir: Path | None = None,
    role_plan: dict | None = None,
    top_k: int | None = None,
    revive_roots: Iterable[Path] = (),
    as_of: date | None = None,
    fetch: Fetch | None = None,
    horizon_source: str = "",
) -> dict:
    """Harvest, rank, write frontier-candidates.json and queue the top-K for review."""
    started = time.time()
    top_k = top_k or default_top_k()
    as_of = as_of or datetime.now(timezone.utc).date()
    stats: dict = {"requests": 0, "cache_hits": 0}
    if deadline_seconds():
        stats["deadline_at"] = time.monotonic() + deadline_seconds()
    base_rate_limited = REQUEST_STATS.get("rate_limited", 0)
    base_network = REQUEST_STATS.get("requests", 0)

    anchor_reports = []
    anchor_s2: dict[str, set[str]] = {}
    aggregated: dict[str, dict] = {}
    if fetch is None and not source_enabled("semanticscholar"):
        stats["source_disabled"] = disabled_reason("semanticscholar")
        anchors = []
    for anchor in anchors:
        if _past_deadline(stats):
            key = clean_text(anchor.get("paper_id")) or clean_text(anchor.get("title"))
            anchor_reports.append({"anchor_id": key, "title": anchor.get("title"), "graph_id": None, "records": [],
                                   "failures": [{"error": "harvest deadline reached before this anchor"}],
                                   "harvest": [], "truncated": True})
            anchor_s2[key] = set()
            continue
        report = resolve_anchor(anchor, fetch, stats)
        key = report["anchor_id"] or (report["title"] or "")
        ids = {record["paperId"] for record in report["records"]}
        anchor_s2[key] = ids
        report["harvest"] = []
        for s2_id in sorted(ids):
            harvested = harvest_citations(s2_id, since, fetch, stats)
            report["harvest"].append({k: v for k, v in harvested.items() if k != "papers"})
            for row in harvested["papers"]:
                entry = aggregated.setdefault(row["paperId"], {"record": row, "anchors": set(), "sources": {"forward_citation"}})
                entry["anchors"].add(key)
        report["truncated"] = any(item["truncated"] for item in report["harvest"])
        anchor_reports.append(report)

    resolved_anchor_count = sum(1 for ids in anchor_s2.values() if ids)
    minimum = min_co_citation(resolved_anchor_count)

    # Revive the cycle's own retrieved-but-never-reviewed candidates.
    revived_report = {"roots": [str(root) for root in revive_roots], "stale_found": 0, "checked": 0,
                      "already_harvested": 0, "skipped_before_since": 0, "skipped_no_graph_id": 0,
                      "over_cap": 0, "deadline_skipped": 0, "failures": []}
    stale, _resolved = cycle_screening_state(revive_roots) if revive_roots else ({}, set())
    revived_report["stale_found"] = len(stale)
    by_alias = {alias: s2 for s2, entry in aggregated.items()
                for alias in paper_aliases(normalize_semanticscholar_paper({**entry["record"], "paperId": s2}))}
    budget = max_revived()
    for entry in stale.values():
        paper = entry["paper"]
        published, _ = publication_date(paper)
        if published is None or published < since:
            revived_report["skipped_before_since"] += 1
            continue
        known = next((by_alias[alias] for alias in entry["aliases"] if alias in by_alias), None)
        if known:
            aggregated[known]["sources"].add("revived_unreviewed")
            aggregated[known]["retrieved_in"] = sorted(set(aggregated[known].get("retrieved_in", []) + entry["retrieved_in"]))
            revived_report["already_harvested"] += 1
            continue
        identifier = (clean_text(paper.get("semanticscholar_id"))
                      or graph_id(f"doi:{paper['doi']}" if clean_text(paper.get("doi")) else "")
                      or graph_id(f"arxiv_id:{paper['arxiv_id']}" if clean_text(paper.get("arxiv_id")) else ""))
        if not identifier:
            revived_report["skipped_no_graph_id"] += 1
            continue
        if revived_report["checked"] >= budget:
            revived_report["over_cap"] += 1
            continue
        if _past_deadline(stats):
            revived_report["deadline_skipped"] += 1
            continue
        revived_report["checked"] += 1
        try:
            cited = reference_ids(identifier, fetch, stats)
        except Exception as error:  # noqa: BLE001
            revived_report["failures"].append({"paper": identifier, **_failure(error)})
            continue
        anchors_cited = {key for key, ids in anchor_s2.items() if ids & cited}
        if not anchors_cited:
            continue
        record = {
            "paperId": clean_text(paper.get("semanticscholar_id")) or identifier,
            "title": paper.get("title"), "abstract": paper.get("abstract"),
            "year": paper.get("year"), "publicationDate": paper.get("publication_date"),
            "venue": paper.get("journal"), "citationCount": paper.get("cited_by_count"),
            "externalIds": {key: value for key, value in (("DOI", paper.get("doi")), ("ArXiv", paper.get("arxiv_id"))) if value},
        }
        aggregated[record["paperId"]] = {"record": record, "anchors": anchors_cited,
                                         "sources": {"revived_unreviewed"}, "retrieved_in": entry["retrieved_in"]}

    ranked = rank_candidates(aggregated, since, as_of, minimum)
    top = ranked[:top_k]
    candidates_out = []
    for rank, item in enumerate(ranked[:max(top_k, 200)], start=1):
        paper = _candidate_paper(item, since)
        candidates_out.append({
            "rank": rank, "top_k": rank <= top_k, "paper_id": paper_identity(paper),
            "aliases": paper_aliases(paper), "title": paper.get("title"),
            "publication_date": item["publication_date"], "date_precision": item["date_precision"],
            "year": paper.get("year"), "venue": paper.get("journal") or None,
            "semanticscholar_id": paper.get("semanticscholar_id"), "arxiv_id": paper.get("arxiv_id"),
            "doi": paper.get("doi"), "post_horizon": True,
            "co_citation": item["co_citation"], "cites_anchors": item["cites_anchors"],
            "citation_count": item["citation_count"],
            "months_since_publication": item["months_since_publication"],
            "velocity": item["velocity"], "score": item["score"], "sources": item["sources"],
            "previously_retrieved_in": item["previously_retrieved_in"],
            "abstract_available": bool(clean_text(paper.get("abstract"))),
        })

    import_report = {"status": "skipped", "reason": "no --output-dir"}
    if output_dir is not None:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        if not top:
            import_report = {"status": "nothing_to_import"}
        elif not (role_plan or {}).get("objective"):
            import_report = {"status": "skipped", "reason": "no role plan objective to review against"}
        else:
            from .entrypoint import persist_candidate_batch

            batch = {
                "query": f"frontier-harvest:since={since.isoformat()}",
                "inquiry_intent": "forward_citation",
                "sources": ["semanticscholar"],
                "source_stats": {"frontier_harvest": True, "anchors": len(anchors), "top_k": top_k},
                "papers": [_candidate_paper(item, since) for item in top],
            }
            inquiry = persist_candidate_batch(output_dir, batch, role_plan or {})
            import_report = {"status": "imported", "papers": len(batch["papers"]), **inquiry}

    elapsed = round(time.time() - started, 2)
    report = {
        "schema": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "since": since.isoformat(),
        "horizon_source": horizon_source or None,
        "as_of": as_of.isoformat(),
        "scoring": {"formula": SCORE_FORMULA, "min_co_citation": minimum,
                    "resolved_anchor_count": resolved_anchor_count},
        "limits": {"max_pages_per_anchor": max_pages_per_anchor(), "page_size": page_size(),
                   "cache_ttl_hours": cache_ttl_seconds() / 3600.0, "top_k": top_k,
                   "max_revived": max_revived(), "deadline_seconds": deadline_seconds()},
        "deadline_reached": _past_deadline(stats),
        "anchors": anchor_reports,
        "truncated_anchors": [report_item["anchor_id"] for report_item in anchor_reports if report_item["truncated"]],
        "unresolved_anchors": [report_item["anchor_id"] for report_item in anchor_reports if not report_item["records"]],
        "revived": revived_report,
        "aggregated_citing_papers": len(aggregated),
        "candidate_count": len(ranked),
        "top_k": top_k,
        "top_k_ids": [item["paper_id"] for item in candidates_out if item["top_k"]],
        "candidates": candidates_out,
        "request_stats": {
            "graph_requests": stats.get("requests", 0),
            "cache_hits": stats.get("cache_hits", 0),
            "throttled_retries": stats.get("throttled_retries", 0),
            "network_requests": REQUEST_STATS.get("requests", 0) - base_network,
            "rate_limited_responses": REQUEST_STATS.get("rate_limited", 0) - base_rate_limited,
            "elapsed_seconds": elapsed,
        },
        "import": import_report,
        "evidence_status": "retrieval_candidates_only",
    }
    if output_dir is not None:
        (Path(output_dir) / "frontier-candidates.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        result_path = Path(output_dir) / "result.json"
        result = _read_json(result_path) or {"driver": "literature-search-driver", "role": "scout",
                                             "status": "no_admitted_evidence", "papers": [], "paper_count": 0}
        result["frontier_harvest"] = {
            "path": str(Path(output_dir) / "frontier-candidates.json"), "since": report["since"],
            "candidate_count": report["candidate_count"], "top_k_ids": report["top_k_ids"],
            "truncated_anchors": report["truncated_anchors"], "request_stats": report["request_stats"],
        }
        # The lane's status is the review state of what it queued, never the
        # adaptive-search verdict persist_candidate_batch stamps: this lane
        # searched nothing by query, so "insufficient_corpus" would send it to a
        # search resume. Pending top-K go to abstract review; nothing pending is done.
        pending = int(((import_report.get("counts") or {}).get("pending_review")) or 0)
        result["status"] = "pending_review" if pending else "completed"
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
