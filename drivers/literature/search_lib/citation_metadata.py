"""Citation evidence for papers that cannot use the recency track.

The quality gate offers four alternative tracks. `recent_frontier` needs nothing
but a publication date; the other three -- verified citation count, verified
field-normalized percentile, verified Q1 venue metric -- all need measurements
with provenance. Nothing attached those measurements, so in practice only the
recency track was reachable.

MEASURED ON cycle-g-v91: 107 of 109 accepted papers came in on recency, 3 on
established impact, and NOTHING older than 2021 was admitted at all. 90 of the
109 carried no citation count of any kind: arXiv supplied 92 of them and gives a
citation count on 2. The scout then recorded, correctly, that the foundational
literature "lacks accepted full-abstract evidence" -- and the cycle deadlocked
behind a scout that could never complete.

The gate is not wrong. Its second door had no handle on the outside.

Why the cache is keyed by PAPER and kept
----------------------------------------
The existing HTTP cache is keyed by URL, so the same paper reached through a
search query, a DOI filter and a title lookup is three entries and no reuse.
This one is keyed by the paper identity the screening policy already computes,
so one lookup serves every query, round, lane and cycle that ever sees it.

It is kept indefinitely on purpose. A citation count only ever GROWS, so a stale
cached value understates impact: it can wrongly exclude a paper that has since
crossed the threshold, and it can never wrongly admit one. Staleness makes the
gate stricter, never looser, which is the safe direction for an evidence gate.
Refreshing is therefore an optimisation rather than a correctness requirement,
and only a value near the threshold is worth re-reading.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path

from .constants import CACHE_ROOT, CONTACT_MAILTO
from .http_client import clean_text, fetch_json
from .screening import paper_identity

CITATION_CACHE_ROOT = CACHE_ROOT / "citation-metadata"
CITATION_CACHE_SCHEMA_VERSION = 1

# Only a count near the admission threshold can change the verdict by growing,
# so only those are worth re-reading, and not often.
REFRESH_BAND = (50, 99)
REFRESH_AFTER_DAYS = float(os.environ.get("RESEARCHLAB_CITATION_REFRESH_DAYS") or 90)


def _cache_path(paper_id: str) -> Path:
    digest = hashlib.sha256(paper_id.encode("utf-8")).hexdigest()
    return CITATION_CACHE_ROOT / f"{digest}.json"


def _read_cached(paper_id: str) -> dict | None:
    try:
        record = json.loads(_cache_path(paper_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if record.get("schema_version") != CITATION_CACHE_SCHEMA_VERSION:
        return None
    if record.get("paper_id") != paper_id:
        return None
    return record


def _is_stale(record: dict) -> bool:
    """Only a count that could still cross the threshold is worth re-reading."""
    count = record.get("cited_by_count")
    if not isinstance(count, int) or not (REFRESH_BAND[0] <= count <= REFRESH_BAND[1]):
        return False
    observed = clean_text((record.get("citation_count_provenance") or {}).get("observed_at"))
    if not observed:
        return True
    try:
        seen = date.fromisoformat(observed[:10])
    except ValueError:
        return True
    return (date.today() - seen).days >= REFRESH_AFTER_DAYS


def _write_cached(record: dict) -> None:
    try:
        CITATION_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
        path = _cache_path(record["paper_id"])
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        # A cache that cannot be written is a slower lookup, not a failed one.
        pass


def needs_citation_evidence(paper: dict, as_of: date | None = None) -> bool:
    """True when this paper cannot clear the gate on recency alone.

    This is the whole volume argument: a paper inside the recency window needs
    no measurement at all, and on cycle-g-v91 that was 107 of 109. Only the rest
    is ever looked up, and only the first time it is seen.
    """
    today = as_of or date.today()
    published = clean_text(paper.get("publication_date"))
    if published:
        try:
            return not (today.replace(year=today.year - 3) <= date.fromisoformat(published[:10]) <= today)
        except ValueError:
            pass
    year = paper.get("year")
    try:
        year = int(year)
    except (TypeError, ValueError):
        # No date at all: a lookup is the only thing that can help it.
        return True
    return not (0 <= today.year - year <= 3)


def _openalex_record(paper_id: str, work: dict) -> dict:
    count = work.get("cited_by_count")
    source_url = clean_text(work.get("id"))
    observed_at = datetime.now(timezone.utc).date().isoformat()
    provenance = None
    if isinstance(count, int) and source_url.startswith("http"):
        provenance = {
            "value": count,
            "source": "openalex",
            "source_url": source_url,
            "observed_at": observed_at,
        }
    return {
        "schema_version": CITATION_CACHE_SCHEMA_VERSION,
        "paper_id": paper_id,
        "cited_by_count": count if isinstance(count, int) else None,
        "citation_count_provenance": provenance,
        "fetched_at": observed_at,
    }


def _lookup_openalex(paper: dict) -> dict | None:
    """One exact lookup, by DOI when there is one and by title otherwise."""
    doi = clean_text(paper.get("doi")).lower()
    doi = doi.replace("https://doi.org/", "").replace("http://dx.doi.org/", "").replace("doi:", "").strip()
    mailto = urllib.parse.quote(CONTACT_MAILTO)
    if doi:
        url = (
            "https://api.openalex.org/works?filter=doi:"
            + urllib.parse.quote(f"https://doi.org/{doi}", safe="")
            + f"&per-page=1&mailto={mailto}"
        )
    else:
        title = clean_text(paper.get("title"))
        if not title:
            return None
        url = (
            "https://api.openalex.org/works?search="
            + urllib.parse.quote(title)
            + f"&per-page=1&mailto={mailto}"
        )
    try:
        response = fetch_json(url)
    except Exception:
        # A throttled or unreachable provider is recorded by the collector that
        # called us; here it simply means no evidence this round.
        return None
    results = response.get("results") if isinstance(response, dict) else None
    if isinstance(results, list) and results:
        return results[0]
    return response if isinstance(response, dict) and response.get("id") else None


def attach_citation_evidence(papers: list[dict], as_of: date | None = None) -> dict:
    """Attach verified citation counts to the papers that need one.

    Mutates each paper in place with `cited_by_count` and
    `citation_count_provenance` in exactly the shape `quality_eligibility`
    checks, and returns a small summary for the lane result.
    """
    stats = {"considered": 0, "cache_hits": 0, "looked_up": 0, "attached": 0, "no_evidence": 0}
    for paper in papers:
        if not isinstance(paper, dict):
            continue
        # Never overwrite provenance the source already supplied.
        if paper.get("citation_count_provenance"):
            continue
        if not needs_citation_evidence(paper, as_of):
            continue
        stats["considered"] += 1
        paper_id = paper_identity(paper)
        record = _read_cached(paper_id)
        if record is not None and not _is_stale(record):
            stats["cache_hits"] += 1
        else:
            work = _lookup_openalex(paper)
            stats["looked_up"] += 1
            if work is None:
                if record is None:
                    stats["no_evidence"] += 1
                    continue
            else:
                record = _openalex_record(paper_id, work)
                _write_cached(record)
        provenance = (record or {}).get("citation_count_provenance")
        count = (record or {}).get("cited_by_count")
        if provenance and isinstance(count, int):
            paper["cited_by_count"] = count
            paper["citation_count_provenance"] = provenance
            stats["attached"] += 1
        else:
            stats["no_evidence"] += 1
    return stats
