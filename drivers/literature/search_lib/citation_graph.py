"""Backward and forward citation lookups for one parent paper, by DOI.

The adaptive search contract requires a backward-citation inquiry (what a
relevant parent cites) and a forward-citation inquiry (what cites it). Until now
the only way to run either was for the agent to assemble a batch by hand from a
source that exposes a citation graph -- and on cycle-g-v91 the one such source
the driver used stopped answering: OpenAlex returned 429 on every request, then
reported that the anonymous daily budget was spent. Forty-eight scouts failed,
nineteen of them on exactly these two intents, and the gate kept listing
"search-agent contract pending" as its blocker.

The graph comes from a keyless citation index; the metadata for each neighbour
comes from the DOI registry's own record, because the index's bibliographic
fields are not reliable enough to review against (it named a psychology journal
as the venue of a graphics paper). When the index cannot answer a backward
lookup, the parent's deposited reference list is the fallback.

Every request is recorded as a source attempt with its failure and a throttle
classification, in the same shape a keyword probe records, so a refused lookup
reads as refused rather than as a field with nothing in it.

When neither answers -- the index refused, or holds no links for the parent --
Semantic Scholar's citation graph is asked, and a parent may also be named by
its arXiv ID. MEASURED ON cycle-b-20260918, 2026-09-18/19: the field's
landmark robot-learning papers are arXiv-first proceedings papers, most with no
registry DOI and few links in the citation index, so a citation inquiry from
one of them had nowhere to go.
"""

from __future__ import annotations

import re
import urllib.parse

from .constants import CROSSREF_WORKS_URL, OPENCITATIONS_INDEX_URL
from .http_client import clean_text, fetch_json
from .normalize import normalize_crossref_paper, normalize_semanticscholar_paper
from .providers import semanticscholar_neighbours
from .key_gates import source_enabled

# The two directions and the inquiry intent each one satisfies.
DIRECTIONS = {"references": "backward_citation", "citations": "forward_citation"}
DEFAULT_NEIGHBOUR_LIMIT = 40
METADATA_BATCH_SIZE = 20
_DOI_TOKEN = re.compile(r"(?:^|\s)doi:(\S+)")
_DOI_SHAPE = re.compile(r"^10\.\d{3,9}/\S+$")
_CROSSREF_SELECT = (
    "DOI,title,author,container-title,published-print,published-online,issued,"
    "type,URL,is-referenced-by-count,abstract"
)


def bare_doi(value: str | None) -> str:
    """A DOI without resolver prefixes, lowercased, or "" when it is not one."""
    text = clean_text(value).lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"):
        if text.startswith(prefix):
            text = text[len(prefix):]
    return text if _DOI_SHAPE.match(text) else ""


_ARXIV_ID = re.compile(r"(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?", re.IGNORECASE)


def bare_arxiv_id(value: str | None) -> str:
    """An arXiv identifier without prefix or version, or "" when it is not one."""
    text = clean_text(value)
    text = re.sub(r"^(?:https?://)?(?:www\.|export\.)?arxiv\.org/(?:abs|pdf)/", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^arxiv:\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\.pdf$", "", text, flags=re.IGNORECASE)
    match = _ARXIV_ID.fullmatch(text)
    return match.group(1) if match else ""


def graph_neighbours(parent_ref: str, direction: str, limit: int) -> list[dict]:
    """Neighbours from Semantic Scholar's graph, already carrying abstracts."""
    return [
        normalize_semanticscholar_paper(item)
        for item in semanticscholar_neighbours(parent_ref, direction, limit)
    ]


def _unique(values):
    seen = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return seen


def index_neighbours(doi: str, direction: str) -> list[str]:
    """DOIs on the other end of the parent's citation links, from the index."""
    rows = fetch_json(f"{OPENCITATIONS_INDEX_URL}/{direction}/doi:{doi}")
    # For "references" the parent is the citing work and the neighbour is cited;
    # for "citations" it is the other way round.
    field = "cited" if direction == "references" else "citing"
    found = []
    for row in rows if isinstance(rows, list) else []:
        for token in _DOI_TOKEN.findall(str((row or {}).get(field) or "")):
            candidate = bare_doi(token)
            if candidate and candidate != doi:
                found.append(candidate)
    return _unique(found)


def registry_references(doi: str) -> list[str]:
    """DOIs in the reference list the publisher deposited with the parent."""
    payload = fetch_json(f"{CROSSREF_WORKS_URL}/{urllib.parse.quote(doi, safe='')}")
    references = ((payload or {}).get("message") or {}).get("reference") or []
    return _unique(bare_doi(item.get("DOI")) for item in references if isinstance(item, dict))


def registry_metadata(dois: list[str]) -> list[dict]:
    """Registry records for the neighbours, normalized like any other candidate."""
    papers: list[dict] = []
    for start in range(0, len(dois), METADATA_BATCH_SIZE):
        batch = dois[start:start + METADATA_BATCH_SIZE]
        params = urllib.parse.urlencode({
            "filter": ",".join(f"doi:{doi}" for doi in batch),
            "rows": str(len(batch)),
            "select": _CROSSREF_SELECT,
        })
        payload = fetch_json(f"{CROSSREF_WORKS_URL}?{params}")
        for item in ((payload or {}).get("message") or {}).get("items") or []:
            papers.append(normalize_crossref_paper(item))
    return papers


def probe_citations(doi: str, direction: str, limit: int = DEFAULT_NEIGHBOUR_LIMIT) -> dict:
    """One backward or forward citation inquiry, shaped like a query probe."""
    # Imported here: collect imports the providers, and the classification must
    # be the one the keyword probe uses rather than a second copy of it.
    from .collect import _is_throttle_error

    if direction not in DIRECTIONS:
        raise ValueError(f"direction must be one of {sorted(DIRECTIONS)}")
    parent = bare_doi(doi)
    arxiv_parent = "" if parent else bare_arxiv_id(doi)
    if not parent and not arxiv_parent:
        raise ValueError("a citation inquiry needs the parent paper's DOI or arXiv ID")
    parent_id = parent or f"arXiv:{arxiv_parent}"
    query = f"{direction}:doi:{parent}" if parent else f"{direction}:arxiv:{arxiv_parent}"
    attempted: list[str] = []
    hits: dict[str, int] = {}
    failures: list[dict] = []

    def attempt(source: str, call):
        attempted.append(source)
        try:
            found = call()
        except Exception as error:  # noqa: BLE001 - every failure is recorded, none is fatal
            failures.append({
                "source": source,
                "query": query,
                "error": str(error),
                "throttled": _is_throttle_error(error),
            })
            return []
        hits[source] = len(found)
        return found

    neighbours: list[str] = []
    papers: list[dict] = []
    if parent:
        neighbours = attempt("opencitations", lambda: index_neighbours(parent, direction))
        if direction == "references" and not neighbours:
            neighbours = attempt("crossref-deposited-references", lambda: registry_references(parent))
        neighbours = neighbours[:max(0, int(limit))]
        papers = attempt("crossref", lambda: registry_metadata(neighbours)) if neighbours else []
    if not papers and source_enabled("semanticscholar"):
        graph_ref = f"DOI:{parent}" if parent else f"arXiv:{arxiv_parent}"
        papers = attempt("semanticscholar", lambda: graph_neighbours(graph_ref, direction, limit))
        papers = [paper for paper in papers if paper.get("title")][:max(0, int(limit))]
    resolved = {bare_doi(paper.get("doi")) for paper in papers}
    for paper in papers:
        paper["citation_graph"] = {
            "direction": direction,
            "inquiry_intent": DIRECTIONS[direction],
            "parent_doi": parent or None,
            "parent_id": parent_id,
        }
    source_stats = {
        "query": query,
        "inquiry_intent": DIRECTIONS[direction],
        "parent_paper_ids": [parent_id],
        "sources_attempted": attempted,
        "source_hits": hits,
        "source_failures": failures,
        "neighbour_dois": neighbours,
        "unresolved_neighbour_dois": [item for item in neighbours if item not in resolved],
        "evidence_status": "retrieval_candidates_only",
    }
    return {
        "query": query,
        "inquiry_intent": DIRECTIONS[direction],
        "parent_paper_ids": [parent_id],
        "sources": attempted,
        "paper_count": len(papers),
        "source_stats": source_stats,
        "evidence_status": "retrieval_candidates_only",
        "papers": papers,
    }
