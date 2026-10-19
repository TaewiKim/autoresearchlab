#!/usr/bin/env python3
"""data-scout-browser driver — domain-neutral open dataset discovery.

Invoked by the Rust harness when a scout lane runs with
``action_type=data_acquisition_followup``. Fulfils the
``cycle-<id>-data-request.json`` artifact emitted by lab-director when
the hypothesis it formed needs additional dataset evidence to be
actionable.

Design contract
---------------
NO domain hardcoding. lab-director may ask for any kind of dataset
(physical, social, climate, biomedical, economic, ...). The scout
must NOT presuppose a domain — that means no OmicsDI, no GEO-first,
no PubMed-first. Every backend in the default discover path must be
domain-neutral.

Two-stage flow
--------------
1. **discover** — enumerate candidate URLs from domain-neutral indices:
     a) DataCite Commons REST (https://api.datacite.org/dois) — every
        DOI-registered dataset across all disciplines.
     b) DuckDuckGo HTML (https://html.duckduckgo.com/html) via Playwright
        — broad open-web fallback that catches datasets hosted outside
        DOI registries (institutional repositories, author pages,
        government data portals, etc.).
2. **crawl** — visit each candidate page, extract identifiers, check
   accessibility (HTTP 200 + no login wall), record host + extracted
   accessions / DOIs.

OSS references the design borrows from
--------------------------------------
- **DataCite Commons** (https://commons.datacite.org, REST docs at
  https://support.datacite.org/docs/api): all-discipline DOI registry,
  free, no auth, JSON:API. Primary domain-neutral discover backend.
- **re3data** (https://www.re3data.org, python-re3data MIT): registry of
  3000+ research data repositories across all disciplines. We don't
  call it directly — instead the DDG fallback subsumes the same role.
- **DataMed** (JAMIA 2018): pioneered the
  "federated-search → accession-recognition → access-verification"
  pipeline pattern this driver implements.
- Domain-specific clients (OmicsDI ddipy, GEOfetch, GEOparse, pyDataverse)
  exist and could be plugged in later as **opt-in** backends keyed off
  explicit tokens in the data-request, but they are NOT default-on.

Output contract
---------------
The driver does NOT download large data files — too expensive for a
scout pass. It records URLs + identifiers + access status so a
downstream lane (or operator) can choose what to fetch.

CLI:
    data_scout_browser.py
        --output-dir <dir>          (required — lane scratch dir)
        --runtime-root <dir>        (required — .research-lab path)
        --cycle-id <id>             (required)
        [--role-plan-file <path>]   (optional — only used to surface lane_id
                                     in graph annotations)
        [--max-queries N]           (default 5)
        [--max-candidates-per-query N] (default 6)
        [--per-page-timeout N]      (seconds, default 20)

Outputs:
    <output_dir>/result.json
        {
          status, driver, cycle_id, queries_attempted,
          candidate_count, candidates[], data_graph_update_path,
          completion_marker_path
        }
    <runtime_root>/state/<cycle>-data-graph.json   (appended dataset nodes)
    <runtime_root>/state/<cycle>-data-acquisition-completed.json
        (marker — presence unblocks the analyst dispatch gate)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote_plus, urlencode, urlparse

# dataset_fetcher is loaded lazily from the same drivers/data directory
# so the scout still imports cleanly even when the fetcher's optional
# pandas / pyarrow / openpyxl deps aren't installed yet (the doctor
# probe is responsible for ensuring they're present before a real
# cycle invokes the fetch path).
try:
    from . import dataset_fetcher as _dataset_fetcher  # type: ignore
except ImportError:  # pragma: no cover — script-style invocation
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        import dataset_fetcher as _dataset_fetcher  # type: ignore
    except Exception:
        _dataset_fetcher = None  # type: ignore


# DataCite Commons REST — domain-neutral DOI-registered dataset index.
# Docs: https://support.datacite.org/docs/api-queries
# Single endpoint covers every discipline that registers DOIs (Zenodo,
# Figshare, Dataverse, OSF, Harvard Dataverse, university repositories,
# government portals, etc.).
DATACITE_SEARCH_URL = "https://api.datacite.org/dois"
DATACITE_TIMEOUT_SEC = 6.0
SCOUT_USER_AGENT = "ResearchLab-DataScout"

# Additional official open-data registries — each independent of DataCite
# so we still get hits when DataCite's harvest is stale or the dataset
# was registered without a DataCite DOI. All four use unauthenticated
# JSON APIs documented as public:
#
# - Zenodo direct (api.zenodo.org/records) — CERN-hosted; the same
#   records that DataCite indexes show up here typically days earlier
#   and with richer file lists. Docs: https://developers.zenodo.org/
# - Figshare direct (api.figshare.com/v2/articles) — separate index with
#   non-DataCite-registered Figshare entries. Docs:
#   https://docs.figshare.com/
# - OpenAIRE Explore (api.openaire.eu/search/datasets) — EU research
#   federation aggregating ~1500 repositories beyond DataCite's reach.
#   Docs: https://graph.openaire.eu/docs/apis/search-api/
# - OSF (api.osf.io/v2/registrations) — Open Science Framework
#   datasets / preregistered studies. Docs: https://developer.osf.io/
ZENODO_SEARCH_URL = "https://zenodo.org/api/records"
FIGSHARE_SEARCH_URL = "https://api.figshare.com/v2/articles/search"
OPENAIRE_SEARCH_URL = "https://api.openaire.eu/search/datasets"
OSF_SEARCH_URL = "https://api.osf.io/v2/registrations/"
# Additional broader-crawl registries:
# - Dryad: research-data archive with strong biological / clinical
#   coverage. Docs: https://datadryad.org/api/v2/docs
# - Hugging Face Datasets: very large general-purpose ML dataset hub
#   that also indexes plenty of domain-specific (medical, climate,
#   government statistics) datasets. Public API needs no auth.
# - Harvard Dataverse: world's largest Dataverse instance (federation
#   API works the same on any Dataverse host so the search function
#   can be re-pointed in a future sweep).
# - re3data: meta-registry of ~3000 research-data repositories. We
#   surface the repository landing pages (not individual datasets) so
#   the analyst sees additional venues to chase that the per-dataset
#   indexes above might not cover for a given prompt.
DRYAD_SEARCH_URL = "https://datadryad.org/api/v2/search"
HUGGINGFACE_SEARCH_URL = "https://huggingface.co/api/datasets"
DATAVERSE_SEARCH_URL = "https://dataverse.harvard.edu/api/search"
RE3DATA_SEARCH_URL = "https://www.re3data.org/api/v1/repositories"
# Specialized archive APIs that DOI registries do not fully cover.
# These are queried only when the request names a relevant repository
# or accession-shaped identifier, so generic topics are not biased
# toward any single research domain.
NCBI_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
NCBI_ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
EBI_BIOSTUDIES_URL = "https://www.ebi.ac.uk/biostudies/api/v1/search"
EBI_ENA_PORTAL_URL = "https://www.ebi.ac.uk/ena/portal/api/search"
REGISTRY_TIMEOUT_SEC = 6.0


# ----------------------------------------------------------------------
# Utilities

def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _safe_read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _atomic_write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


# Identifier patterns we know how to spot across landing pages.
# Order matters for reporting: DOI first (most universal), then
# domain-neutral repositories (Zenodo, Figshare, OSF, Dataverse,
# Synapse), then domain-specific patterns as last-resort. This order
# is deliberate — we never want to surface a domain-specific tag
# ahead of a generic DOI when both are present.
ACCESSION_PATTERNS = [
    # Domain-neutral
    ("DOI", re.compile(r"\b10\.\d{4,9}/[^\s\"'<>)]+")),
    ("Zenodo", re.compile(r"zenodo\.org/record(?:s)?/(\d{4,9})")),
    ("Figshare", re.compile(r"figshare\.com/(?:articles|s)/[^\s\"'<>]+")),
    ("OSF", re.compile(r"osf\.io/([a-z0-9]{4,8})\b", re.IGNORECASE)),
    ("Dataverse", re.compile(r"dataverse\.[a-z0-9.\-]+/dataset\.xhtml\?[^\s\"'<>]+", re.IGNORECASE)),
    ("Dryad", re.compile(r"datadryad\.org/(?:stash/)?dataset/[^\s\"'<>]+", re.IGNORECASE)),
    ("Synapse", re.compile(r"\bsyn\d{5,9}\b")),
    ("GitHub", re.compile(r"github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)(?:[/?#][^\s\"'<>)]*)?", re.IGNORECASE)),
    ("HuggingFace", re.compile(r"huggingface\.co/datasets/[^\s\"'<>]+", re.IGNORECASE)),
    ("Kaggle", re.compile(r"kaggle\.com/datasets/[^\s\"'<>]+", re.IGNORECASE)),
    # Domain-specific (kept for recognition, not ranking)
    ("GEO", re.compile(r"\bGSE\d{3,7}\b")),
    ("GEO_GDS", re.compile(r"\bGDS\d{3,6}\b")),
    ("ArrayExpress", re.compile(r"\bE-[A-Z]{4}-\d{1,6}\b")),
    ("SRA", re.compile(r"\b(?:SRP|ERP|DRP|SRX|ERX|DRX|SRR|ERR|DRR)\d{4,8}\b")),
    ("BioProject", re.compile(r"\bPRJ[ENDA][A-Z]?\d{3,9}\b")),
    ("dbGaP", re.compile(r"\bphs\d{6}\b")),
    ("EGA", re.compile(r"\bEGAS\d{6,12}\b|\bEGAD\d{6,12}\b")),
]


def _extract_accessions(text: str) -> list[dict]:
    """Find any recognisable accession in *text*. Returns list of
    {repository, accession_id} pairs. Deduplicates."""
    found: list[dict] = []
    seen: set[tuple[str, str]] = set()
    if not text:
        return found
    for repo, pattern in ACCESSION_PATTERNS:
        for match in pattern.findall(text):
            acc = match if isinstance(match, str) else " ".join(match)
            key = (repo, acc.lower())
            if key in seen:
                continue
            seen.add(key)
            found.append({"repository": repo, "accession": acc})
    return found


def _reference_paper_resource_queries(hypothesis: dict | None, max_queries: int = 12) -> list[dict]:
    """Build targeted web-search queries for data/code linked to same-dataset papers.

    LabDirector hypothesis artifacts already name the same-dataset reference
    papers that define the baseline.  A plain data-scout pass used to search
    only the cycle objective or candidate accession, so it could miss the
    paper's Data Availability / Code Availability links (GitHub, Zenodo,
    Dryad, GEO supplementary accessions).  Return small structured query
    records so downstream candidates keep provenance back to the paper.
    """
    if not isinstance(hypothesis, dict):
        return []

    papers: list[dict] = []
    seen_papers: set[tuple[str, str]] = set()

    def _add_paper(value: dict) -> None:
        title = str(value.get("title") or "").strip()
        doi = str(value.get("doi") or "").strip()
        accession = str(
            value.get("accession_or_cohort")
            or value.get("dataset_or_accession")
            or ""
        ).strip()
        if not (title or doi or accession):
            return
        key = (title.lower(), doi.lower())
        if key in seen_papers:
            return
        seen_papers.add(key)
        papers.append({"title": title, "doi": doi, "accession_or_cohort": accession})

    selected = hypothesis.get("selected_hypothesis")
    if isinstance(selected, dict):
        for paper in selected.get("same_dataset_reference_papers") or []:
            if isinstance(paper, dict):
                _add_paper(paper)
    for repl in hypothesis.get("replacement_hypotheses") or []:
        if not isinstance(repl, dict):
            continue
        for paper in repl.get("same_dataset_reference_papers") or []:
            if isinstance(paper, dict):
                _add_paper(paper)

    out: list[dict] = []
    seen_queries: set[str] = set()

    def _push(query: str, paper: dict, kind: str) -> None:
        query = " ".join(str(query or "").split())
        key = query.lower()
        if not query or key in seen_queries or len(out) >= max_queries:
            return
        seen_queries.add(key)
        out.append({"query": query, "reference_paper": paper, "resource_kind": kind})

    for paper in papers:
        title = paper.get("title") or ""
        doi = paper.get("doi") or ""
        accession = paper.get("accession_or_cohort") or ""
        if doi:
            _push(f'"{doi}" GitHub', paper, "code_repository")
            _push(f'"{doi}" data availability', paper, "paper_data_link")
        if title:
            _push(f'"{title}" GitHub', paper, "code_repository")
            _push(f'"{title}" supplementary data GEO GitHub', paper, "paper_data_link")
        for ident in _extract_dataset_identifiers(" ".join([title, doi, accession]))[:3]:
            _push(f'"{ident}" GitHub code', paper, "code_repository")
            _push(f'"{ident}" supplementary data', paper, "paper_data_link")
    return out


def _short_modality_label(specs: list[dict]) -> str:
    """Compact one-line label summarising what the data-request asks
    for. The data-request is open-shape so we just join whatever
    free-text 'modality' or 'kind' tokens it provides — no domain
    interpretation."""
    parts = []
    for s in specs[:3]:
        token = (s.get("modality") or s.get("kind") or s.get("type") or "").strip()
        if token:
            parts.append(token)
    return " / ".join(parts) if parts else "unspecified"


# ----------------------------------------------------------------------
# Query construction

_DATASET_ID_PATTERNS = [
    # Accession patterns commonly cited by lab-director hypotheses.
    # Prefer specific identifier forms — they make far better search
    # queries than the surrounding prose because each registry's
    # full-text index keys on the bare accession string.
    #
    # NOTE: word-boundary anchors (``\b``) are intentionally NOT used.
    # Python ``\b`` does not break between ``_`` and an alphanumeric
    # character (both are word chars), so ``\bGSE\d+\b`` would miss
    # the ``GSE40279`` inside lab-director slugs like
    # ``dataset_GSE40279``. We rely on the leading non-word lookbehind
    # (or string start) plus the fixed prefix to anchor each pattern
    # so the bare accession surfaces from any slug the harness emits.
    re.compile(r"(?:^|[^A-Za-z0-9])(GSE\d{3,7})(?=[^A-Za-z0-9]|$)", re.IGNORECASE),       # GEO Series
    re.compile(r"(?:^|[^A-Za-z0-9])(SRP\d{5,8})(?=[^A-Za-z0-9]|$)", re.IGNORECASE),       # SRA project
    re.compile(r"(?:^|[^A-Za-z0-9])(PRJ[EDN][A-Z]\d{4,9})(?=[^A-Za-z0-9]|$)", re.IGNORECASE),  # ENA / SRA bioproject
    re.compile(r"(?:^|[^A-Za-z0-9])(E-[A-Z]{4}-\d{1,7})(?=[^A-Za-z0-9]|$)"),                # ArrayExpress
    re.compile(r"(?:^|[^A-Za-z0-9])(phs\d{6,9}(?:\.v\d+)?)(?=[^A-Za-z0-9]|$)", re.IGNORECASE),  # dbGaP
    re.compile(r"\b(10\.\d{4,9}/[\w./\-]+)\b"),                                            # any DOI
    re.compile(r"\b(dataset_[a-z0-9_]+)\b", re.IGNORECASE),                                # lab-director slug
]


def _extract_dataset_identifiers(text: str) -> list[str]:
    """Pull GEO / SRA / DOI / ArrayExpress / dataset_* tokens out of a
    free-form text blob (e.g. lab-director hypothesis statement, the
    fallback's followup_description). These tokens are far more
    productive search terms than the surrounding prose because
    Zenodo / Dryad / OpenAIRE / DataCite all index the bare
    accessions.
    """
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for pat in _DATASET_ID_PATTERNS:
        for match in pat.findall(text):
            token = str(match).strip().rstrip(".,;)”\"'")
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(token)
    return out


def _forbidden_dataset_terms_from_role_plan(role_plan: dict | None) -> set[str]:
    text_parts: list[str] = []
    if isinstance(role_plan, dict):
        for key in ("objective", "analysis_goal", "task"):
            value = role_plan.get(key)
            if value:
                text_parts.append(str(value))
        metadata = role_plan.get("planner_metadata") or {}
        if isinstance(metadata, dict):
            for key in ("objective", "analysis_goal", "task", "forbidden_datasets", "avoid_datasets"):
                value = metadata.get(key)
                if isinstance(value, list):
                    text_parts.extend(str(item) for item in value)
                elif value:
                    text_parts.append(str(value))
    text = " ".join(text_parts).lower()
    terms: set[str] = set()
    for pattern in (r"\bgse\d+\b", r"\bsrp\d+\b", r"\bprjna\d+\b", r"\begas\d+\b"):
        terms.update(match.group(0).lower() for match in re.finditer(pattern, text, flags=re.I))
    return terms


def _contains_forbidden_dataset_term(value, forbidden_terms: set[str]) -> bool:
    if not forbidden_terms:
        return False
    try:
        blob = json.dumps(value, ensure_ascii=False).lower()
    except Exception:
        blob = str(value).lower()
    return any(term in blob for term in forbidden_terms)


_QUERY_STOPWORDS = frozenset({
    # generic English
    "this", "that", "with", "from", "into", "have", "will", "should",
    "than", "more", "less", "most", "least", "over", "under", "above",
    "below", "across", "among", "between", "after", "before", "their",
    "which", "where", "when", "while", "what", "would", "could", "must",
    "make", "made", "take", "given", "using", "based", "shows", "show",
    "such", "also", "whole", "first", "second", "third", "next", "every",
    # research-prose filler that crowds out distinctive terms
    "data", "dataset", "datasets", "study", "studies",
    "analysis", "analyses", "model", "models", "result", "results",
    "value", "values", "single", "primary", "predict", "predicts",
    "predicting", "strongest", "single-site", "transportable",
    "independent", "published", "harmonized", "preprocessing",
    "researcher", "researchers", "approach", "approaches",
    "patients", "humans", "human", "healthy",
    # measurement / setup boilerplate
    "sample", "samples", "cohort", "cohorts", "registry", "registries",
    "subject", "subjects", "control", "controls", "baseline",
    "outcome", "outcomes", "measurement", "measurements",
    "variable", "variables", "predictor", "predictors",
    # generic anatomy that crowds out gene / pathway terms — these
    # match an enormous swathe of unrelated records on Zenodo /
    # Dataverse (cardiovascular surveys, microscopy datasets, etc.)
    "blood", "serum", "plasma", "saliva", "tissue", "brain",
    "heart", "lung", "liver", "kidney",
    # generic biomedical mass nouns
    "disease", "diseases", "syndrome", "syndromes",
    "expression", "level", "levels",
})


def _build_query_variants(statement: str, primary_family: str = "") -> list[str]:
    """Build multiple distinct, precise search queries from a single
    lab-director hypothesis. The point is **diversity** — registries
    rank differently, so feeding three or four different angles
    (gene-only, gene+concept, concept-only, family-tag-split)
    gives the cycle several independent chances to surface a
    hypothesis-relevant dataset instead of betting everything on a
    single seed string.

    Returns up to 5 queries, ordered most-specific first:
      1. distinctive only (gene + accession ids)
      2. distinctive + top plain (gene + concept word)
      3. plain only (concept phrase)
      4. family components (vf_<a>_<b> → "<a> <b>")
      5. distinctive single + plain single (compact 2-word)
    Empty / duplicate variants are dropped before return.
    """
    family_blob = primary_family or ""
    if family_blob.lower().startswith("vf_"):
        family_blob = family_blob[3:]
    family_terms = [
        t for t in re.split(r"[^A-Za-z0-9]+", family_blob)
        if len(t) > 3 and t.lower() not in _QUERY_STOPWORDS
    ]
    family_blob = " ".join(family_terms)
    blob = " ".join(str(x or "") for x in (family_blob, statement))

    seen: set[str] = set()
    distinctive: list[str] = []
    plain: list[str] = []
    for raw in re.split(r"[^A-Za-z0-9_]+", blob):
        token = raw.strip()
        if len(token) <= 4:
            continue
        low = token.lower()
        if low in _QUERY_STOPWORDS or low.isdigit():
            continue
        if "_" in token:
            continue
        if low in seen:
            continue
        seen.add(low)
        is_distinctive = (
            any(ch.isdigit() for ch in token)
            or any(ch.isupper() for ch in token[1:])
        )
        if is_distinctive:
            distinctive.append(token)
        else:
            plain.append(token)

    out: list[str] = []
    seen_queries: set[str] = set()

    def _push(parts: list[str]) -> None:
        parts = [p for p in parts if p]
        if not parts:
            return
        q = " ".join(parts)
        key = q.lower().strip()
        if not key or key in seen_queries:
            return
        seen_queries.add(key)
        out.append(q)

    # 1. distinctive-only — best for accession / gene-symbol matches
    if distinctive:
        _push(distinctive[:3])
    # 2. gene + concept hybrid — typically the most productive shape
    #    on Zenodo / Dryad / OpenAIRE; gene-symbol grounds the
    #    record while concept word filters topic drift.
    if distinctive and plain:
        _push([distinctive[0]] + plain[:2])
    # 3. concept-only — registries with weak gene-symbol indexing
    #    (Dataverse, Figshare) often respond better to plain English.
    if len(plain) >= 2:
        _push(plain[:3])
    # 4. family-derived — split family tag into bare terms
    if family_terms:
        _push(family_terms[:3])
    # 5. compact single-distinctive + single-plain pair
    if distinctive and plain:
        _push([distinctive[0], plain[0]])
    return out


def _hypothesis_keyword_query(statement: str, primary_family: str = "", max_terms: int = 4) -> str:
    """Build a focused search query from a lab-director hypothesis
    statement. Splits tokens into two pools — distinctive (gene
    symbols, accession-shaped ids, hyphenated technical terms) and
    plain content words — and emits up to *max_terms* with the
    distinctive ones first so registries that index by symbol /
    accession prefer them over the surrounding prose. This stops
    "ELOVL2 cg16867657 methylation aging" style hypotheses from
    decaying into "whole blood predictors" once stopwords are stripped.
    """
    # Family tags (``vf_elovl2_cpgs``) are internal labels — registry
    # full-text indexes won't contain them verbatim. Strip the prefix
    # and split on underscore so the constituent biology terms
    # (``elovl2``, ``cpgs``) flow into the same pool as the statement
    # tokens. Use a separator so split-by-non-word treats them as
    # independent tokens.
    family_blob = primary_family or ""
    if family_blob.lower().startswith("vf_"):
        family_blob = family_blob[3:]
    family_blob = family_blob.replace("_", " ")
    blob = " ".join(str(x or "") for x in (family_blob, statement))
    seen: set[str] = set()
    distinctive: list[str] = []
    plain: list[str] = []
    for raw in re.split(r"[^A-Za-z0-9_]+", blob):
        token = raw.strip()
        if len(token) <= 4:
            continue
        low = token.lower()
        if low in _QUERY_STOPWORDS or low.isdigit():
            continue
        # Drop tokens that still contain an underscore — they are almost
        # always internal slugs / family tags that no public registry
        # indexes verbatim. The bare components have already been
        # broken out above.
        if "_" in token:
            continue
        if low in seen:
            continue
        seen.add(low)
        # Distinctive shape: contains a digit (CpG / SNP / accession)
        # OR has any uppercase letter beyond the first character (gene
        # symbol like ELOVL2, BRCA1, NT-proBNP).
        is_distinctive = (
            any(ch.isdigit() for ch in token)
            or any(ch.isupper() for ch in token[1:])
        )
        if is_distinctive:
            distinctive.append(token)
        else:
            plain.append(token)
    out: list[str] = []
    # Pull up to (max_terms - 1) distinctive tokens, then top up with
    # plain content words (domain phrases like ``methylation``,
    # ``aging``). Both lists preserve original order so the cited
    # gene / id appears before the descriptive phrase.
    for tok in distinctive[: max(1, max_terms - 1)]:
        out.append(tok)
    for tok in plain:
        if len(out) >= max_terms:
            break
        out.append(tok)
    return " ".join(out)


def _load_lab_director_hypothesis(runtime_root: Path, cycle_id: str) -> dict | None:
    p = runtime_root / "state" / f"{cycle_id}-lab-director-hypothesis.json"
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # pylint: disable=broad-except
        return None


def _data_request_from_role_plan(role_plan: dict) -> dict:
    """Synthesise a minimal data_request from the lab-director role_plan
    when no explicit ``<cycle>-data-request.json`` artefact is present.

    Each free-form field the harness populates for a
    ``data_acquisition_followup`` lane becomes its OWN spec — search
    backends like DataCite return nothing for very long concatenated
    queries, so we keep each spec atomic. The hypothesis statements
    are kept short (one per spec) and the objective stands alone as
    the canonical topic.

    Identifier-aware extraction (v31 lesson): when the lab-director or
    the harness fallback names specific accessions / DOIs / GEO ids in
    its hypothesis or followup_description, those tokens get their own
    high-priority specs so the registry queries hit the actual record
    pages instead of the cycle's generic objective text.
    """
    if not isinstance(role_plan, dict):
        return {}
    specs: list[dict] = []

    # Pull dataset identifiers from every text field that may carry
    # them; these become the FIRST specs so they take precedence over
    # the cycle's boilerplate objective.
    identifier_pool = " ".join(str(role_plan.get(k) or "") for k in (
        "followup_description", "objective", "assigned_hypotheses",
    ))
    # assigned_hypotheses may also be a list of strings; flatten.
    hyp_field = role_plan.get("assigned_hypotheses")
    if isinstance(hyp_field, list):
        identifier_pool = identifier_pool + " " + " ".join(
            str(h) for h in hyp_field if isinstance(h, (str, int, float))
        )
    forbidden_terms = _forbidden_dataset_terms_from_role_plan(role_plan)
    identifiers = [
        ident for ident in _extract_dataset_identifiers(identifier_pool)
        if not _contains_forbidden_dataset_term(ident, forbidden_terms)
    ]
    for ident in identifiers[:6]:
        specs.append({"topic": ident})

    objective = (role_plan.get("objective") or "").strip()
    if objective:
        specs.append({"topic": objective})
    hypotheses = role_plan.get("assigned_hypotheses")
    if isinstance(hypotheses, list):
        for h in hypotheses[:3]:
            if isinstance(h, str) and h.strip():
                specs.append({"keywords": [h.strip()]})
    request: dict = {}
    if specs:
        request["required_dataset_specs"] = specs
    planner_metadata = role_plan.get("planner_metadata")
    if isinstance(planner_metadata, dict):
        discovery_contract = planner_metadata.get("dataset_discovery_contract")
        if isinstance(discovery_contract, dict):
            request["dataset_discovery_contract"] = discovery_contract
            for spec in discovery_contract.get("query_specs") or []:
                if isinstance(spec, dict):
                    request.setdefault("required_dataset_specs", []).append(spec)
        forbidden = planner_metadata.get("forbidden_dataset_terms") or planner_metadata.get("forbidden_accessions")
        if isinstance(forbidden, list):
            request["forbidden_accessions"] = [str(item) for item in forbidden if item]
    if "dataset_discovery_contract" not in request and COHORT_DATASET_REQUEST_RE.search(identifier_pool):
        # KG-seed discovery must not depend on a verbose LabDirector prose
        # query.  When the role plan clearly asks for omics/cohort/accession
        # discovery but does not provide an explicit contract, synthesize a
        # small archive-native contract so GEO / ArrayExpress / PRIDE are
        # queried with compact terms before the natural-language directive.
        request["dataset_discovery_contract"] = {
            "required_repositories": ["GEO", "ArrayExpress", "PRIDE"],
            "omics_modalities": ["transcriptomics RNA-seq", "single-cell RNA-seq", "proteomics"],
            "biological_context_terms": ["human disease cohort", "immune cohort"],
            "purpose": "kg_seed_dataset_discovery_before_hypothesis_generation",
        }
    description = (role_plan.get("followup_description") or "").strip()
    if description:
        # Used by _build_queries as a verbatim natural-language query —
        # one query rather than concatenated with everything else.
        request["scout_directive"] = description
    return request


def _build_queries(data_request: dict, max_queries: int) -> list[str]:
    """Translate a data_request.json into a small set of search
    queries. The data-request artefact is open-shape: it carries an
    optional list of dataset specs and an optional scout_directive.

    We do NOT inject domain-specific suffixes or biomedical phrasing.
    The lab-director's own words drive the queries; we only add a
    light "open dataset" nudge so search
    engines surface dataset pages rather than papers.
    """
    queries: list[str] = []
    seen: set[str] = set()
    specs = data_request.get("required_dataset_specs") or []
    directive = (data_request.get("scout_directive") or "").strip()
    discovery_contract = data_request.get("dataset_discovery_contract") or {}
    if not isinstance(discovery_contract, dict):
        discovery_contract = {}

    def _push(q: str) -> None:
        if not q:
            return
        key = q.lower().strip()
        if not key or key in seen or len(queries) >= max_queries:
            return
        seen.add(key)
        queries.append(q.strip())

    # An accession-shaped spec (GSE / SRP / PRJ / E-MTAB / phs / DOI /
    # ``dataset_*``) is already as precise as the registry index will
    # ever index — appending ``open dataset`` / ``data download``
    # to it just creates noise. Reserve the suffix variants for prose
    # specs (objective text, full hypothesis statement) where they
    # might disambiguate "paper" from "dataset" hits.
    _ACCESSION_SHAPE = re.compile(
        r"^(?:GSE\d+|GDS\d+|GSM\d+|SRP\d+|PRJ[EDN][A-Z]\d+|E-[A-Z]{4}-\d+|phs\d+(?:\.v\d+)?|10\.\d{4,9}/\S+|dataset_\S+)$",
        re.IGNORECASE,
    )

    def _looks_like_accession(text: str) -> bool:
        return bool(_ACCESSION_SHAPE.match(text.strip()))

    # Explicit accession targets are the highest-signal queries we can send to
    # GEO/ENA/DataCite. Push them before archive-native generic cohort seeds so
    # a small max_queries budget cannot crowd out the requested records.
    for spec in specs:
        if not isinstance(spec, dict):
            continue
        topic = str(spec.get("topic") or "").strip()
        if topic and _looks_like_accession(topic):
            _push(topic)

    request_blob = " ".join(
        [directive]
        + [
            " ".join(str(v) for v in spec.values() if isinstance(v, (str, int, float)))
            for spec in specs
            if isinstance(spec, dict)
        ]
    )
    # Long natural-language objectives perform poorly against GEO/ENA
    # indexes.  When the request is clearly for omics cohorts but does
    # not name an accession, seed compact archive-native queries before
    # the verbose objective consumes the query budget.
    # Archive-native seeding fires ONLY when the request is explicitly biomedical
    # AND the role-plan (LabDirector) actually named repositories/modalities. We
    # no longer inject hardcoded GEO/ArrayExpress/PRIDE + omics + human-cohort
    # defaults for every cohort-shaped request — that steered non-biomedical
    # cycles (e.g. computer graphics) into biomedical repositories. A graphics or
    # other-domain objective simply searches its own terms against the universal
    # multi-domain registries below.
    if COHORT_DATASET_REQUEST_RE.search(request_blob):
        repos = [str(item) for item in discovery_contract.get("required_repositories") or [] if item]
        modalities = [str(item) for item in discovery_contract.get("omics_modalities") or [] if item]
        contexts = [str(item) for item in discovery_contract.get("biological_context_terms") or [] if item]
        for repo in repos[:4]:
            for modality in (modalities or [""])[:3]:
                for context in (contexts or [""])[:2]:
                    seeded = " ".join(part for part in (repo, modality, context) if part).strip()
                    if seeded:
                        _push(seeded)

    for spec in specs:
        # Accept whatever free-form fields the lab-director chose to
        # populate. We don't privilege any one field's vocabulary.
        primary_terms: list[str] = []
        for field in ("modality", "kind", "type", "topic"):
            val = spec.get(field)
            if val:
                primary_terms.append(str(val).strip())
        for field in ("must_have", "keywords", "tags"):
            val = spec.get(field)
            if isinstance(val, list):
                primary_terms.extend([str(t).strip() for t in val if t])
            elif val:
                primary_terms.append(str(val).strip())
        primary_terms = [t for t in primary_terms if t]
        if primary_terms:
            base = " ".join(primary_terms)
            _push(base)
            if not _looks_like_accession(base):
                _push(f"{base} open dataset")
                _push(f"{base} data download")

    if directive:
        _push(directive)

    if not queries:
        # Last-resort: a fully generic open-data query. Better to do
        # something than to no-op when the data-request is empty.
        _push("open access dataset")
    return queries


SPECIALIZED_ARCHIVE_HINT_RE = re.compile(
    r"\b(?:geo|ncbi|ebi|ena|biostudies|arrayexpress|sra|bioproject|dbgap|ega)\b"
    r"|\b(?:transcriptomics|rna[- ]?seq|scrna[- ]?seq|single[- ]?cell|omics|expression atlas)\b"
    r"|\b(?:GSE|GDS|GSM|SRP|ERP|DRP|SRX|ERX|DRX|SRR|ERR|DRR)\d{3,9}\b"
    r"|\bPRJ[ENDA][A-Z]?\d{3,9}\b"
    r"|\bE-[A-Z]{4}-\d{1,6}\b"
    r"|\bphs\d{6,9}(?:\.v\d+)?\b"
    r"|\bEGA[SD]\d{6,12}\b",
    re.IGNORECASE,
)

COHORT_DATASET_REQUEST_RE = re.compile(
    r"\b(?:cohort|cohorts|accession|accessions|geo|arrayexpress|sra|transcriptomics|rna[- ]?seq|single[- ]?cell|omics)\b",
    re.IGNORECASE,
)


def _needs_specialized_archives(query: str) -> bool:
    return bool(SPECIALIZED_ARCHIVE_HINT_RE.search(query or ""))


def _should_skip_re3data_for_query(query: str) -> bool:
    """Do not let repository catalogs satisfy cohort/accession requests."""
    text = query or ""
    if re.search(
        r"\b(?:repository|repositories|registry|registries|data portal|archive catalog)\b",
        text,
        re.IGNORECASE,
    ):
        return False
    return bool(COHORT_DATASET_REQUEST_RE.search(text))


def _query_keywords(text: str) -> set[str]:
    """Substantive relevance tokens for registry hit filtering.

    This intentionally reuses the query-construction stopword list so
    broad scientific prose (``research``, ``analysis``, ``dataset``)
    cannot make an unrelated record look relevant.
    """
    extra_stop = {
        "open", "download", "research", "labdirector", "pivoted", "cycle",
        "cycles", "reason", "supported", "claim", "delta",
        "produced", "rerun", "targeted", "surface", "named",
        "clues", "backed", "support", "structurally", "finalizes",
        "together", "public", "publication", "publishable",
        "meaningful", "robust", "transparent", "provenance",
        "reproducible", "figures", "reporting", "overclaiming",
        "sensitivity", "external", "validation",
    }
    out: set[str] = set()
    for token in re.split(r"[^A-Za-z0-9_]+", (text or "").lower()):
        if len(token) > 3 and token not in _QUERY_STOPWORDS and token not in extra_stop:
            out.add(token)
    return out


def _hit_passes_relevance(hit: dict, query: str) -> bool:
    kws = _query_keywords(query)
    if not kws:
        return True  # nothing to filter on
    accessions = []
    for accession in hit.get("accessions") or []:
        if not isinstance(accession, dict):
            continue
        accessions.extend([
            str(accession.get("repository") or ""),
            str(accession.get("accession") or ""),
        ])
    # Include identifier-bearing fields as well as descriptive text.
    # Accession-only requests such as ``GSE282742`` often return GEO
    # summaries whose title/description omit the accession even though the
    # URL and geo_accession are exact matches; filtering those out makes
    # data-acquisition followups appear empty despite a registry hit.
    blob = " ".join(
        [str(hit.get(k) or "") for k in (
            "title", "url", "datacite_description", "description",
            "datacite_subjects", "geo_accession", "ena_accession",
            "biostudies_accession", "huggingface_repo_id", "re3data_id",
        )] + accessions
    ).lower()
    return any(kw in blob for kw in kws)
