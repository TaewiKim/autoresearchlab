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


from urllib.error import HTTPError


OPENALEX_WORKS_URL = "https://api.openalex.org/works"
CROSSREF_WORKS_URL = "https://api.crossref.org/works"
# Keyless citation index: who cites a DOI and what a DOI cites. Used for the
# backward- and forward-citation inquiries; see citation_graph.py.
OPENCITATIONS_INDEX_URL = "https://api.opencitations.net/index/v2"
# Elsevier Scopus Search API. Unlike OpenAlex/Crossref/PubMed (keyless), Scopus
# REQUIRES an API key (X-ELS-APIKey) plus, for most institutions, entitled
# network/token access. The key is read from the environment so no secret lives
# in the repo; when unset, Scopus is simply not included in the source list.
SCOPUS_SEARCH_URL = "https://api.elsevier.com/content/search/scopus"
PUBMED_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
PUBMED_ESUMMARY_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
PUBMED_EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
# arXiv Atom API. Keyless, cross-domain preprints — the dominant prior-art source
# for computer-graphics / ML / physics / math (cs.GR, cs.LG, cs.CV, ...). PubMed
# is biomedical-only; arXiv is the non-biomedical counterpart, so a graphics/cs
# objective retrieves a REAL prior-art baseline to score novelty against instead
# of an off-topic biomedical corpus. Response is Atom XML (parsed with ET).
ARXIV_API_URL = "http://export.arxiv.org/api/query"
ARXIV_ATOM_NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
}
# Semantic Scholar Graph API. Keyless (an optional RESEARCHLAB_S2_API_KEY raises
# the rate limit), cross-domain, and -- unlike the three registries above -- it
# indexes CoRL/RSS/NeurIPS/ICLR proceedings with their arXiv IDs, abstracts and a
# citation count, and it answers a title lookup directly (/paper/search/match).
# MEASURED ON cycle-b-20260918, 2026-09-18/19: with only OpenAlex, Crossref
# and arXiv, 4,617 candidates held none of the field's landmark robot-learning
# papers; see title_lookup.py.
SEMANTIC_SCHOLAR_API_URL = "https://api.semanticscholar.org/graph/v1"
SEMANTIC_SCHOLAR_PAPER_FIELDS = (
    "paperId,externalIds,title,abstract,venue,publicationVenue,year,publicationDate,"
    "citationCount,influentialCitationCount,publicationTypes,authors,journal,url,openAccessPdf"
)
GITHUB_REPOSITORY_SEARCH_URL = "https://api.github.com/search/repositories"
CACHE_ROOT = Path(__file__).resolve().parents[2] / ".research-lab" / "indexes" / "literature-cache"
QUERY_CACHE_ROOT = CACHE_ROOT / "queries"
QUERY_CACHE_SCHEMA_VERSION = 2
REQUEST_TIMEOUT_SECONDS = 8
MAX_SOURCE_ATTEMPTS = 2

# --- polite fetch layer -------------------------------------------------------
# Rate limits were DISTORTING gate scores: the gatekeeper's active prior-art
# search hit 429/503s, and its own review recorded "targeted searches found no
# usable direct prior art, but rate limits make that negative result
# non-probative" — novelty then scored conservatively (fail-closed) for lack of
# a baseline, not on the merits. Three causes, fixed here at the single fetch
# chokepoint every source shares:
#   1. no cross-process pacing — concurrent lanes each hammered the same API
#      back-to-back (arXiv's published policy is >= 3 s between requests);
#   2. a rate-limit response retried once after ~1 s and then gave up
#      (MAX_SOURCE_ATTEMPTS=2), ignoring Retry-After and treating 503 —
#      arXiv's actual throttle signal — as fatal;
#   3. anonymous requests: OpenAlex/Crossref route requests without a real
#      mailto/User-Agent into the strictest shared pool.
# The operator's own address, from the environment only; with none set no
# address is sent (http_client drops the empty mailto parameter).
CONTACT_MAILTO = (os.environ.get("RESEARCHLAB_CONTACT_MAILTO") or "").strip()
POLITE_USER_AGENT = "researchlab-literature-search/1.0" + (f" (mailto:{CONTACT_MAILTO})" if CONTACT_MAILTO else "")
THROTTLE_ROOT = CACHE_ROOT / "http-throttle"
# Minimum seconds between requests to the same host, shared ACROSS processes.
HOST_MIN_INTERVAL_SECONDS = {
    "export.arxiv.org": 3.1,  # arXiv API terms: no more than one request per 3 s
    "api.openalex.org": 0.5,
    "api.crossref.org": 0.5,
    "eutils.ncbi.nlm.nih.gov": 0.4,  # NCBI: 3 req/s without an API key
    # Semantic Scholar: 1 req/s is the documented budget with a key, and the
    # anonymous pool is shared by every unauthenticated caller, so stay under it.
    "api.semanticscholar.org": 1.05,
    # Full text and asset metadata for deep reading (fulltext.py, assets.py).
    "arxiv.org": 2.0,
    "ar5iv.labs.arxiv.org": 1.0,
    "api.github.com": 1.0,
    "huggingface.co": 0.5,
}
DEFAULT_HOST_MIN_INTERVAL_SECONDS = 1.0
# Rate-limit (429/503) retries get their own, longer budget; other errors keep
# the original MAX_SOURCE_ATTEMPTS behaviour.
RATE_LIMIT_MAX_ATTEMPTS = 6
RATE_LIMIT_RETRY_AFTER_CAP_SECONDS = 60.0
# Hard ceiling on the TOTAL time one fetch may spend sleeping between
# rate-limit retries. Without it a hard-throttling source (e.g. arXiv after a
# hammering burst) could hold a single URL for minutes and blow the calling
# lane's own time budget — the search must return (partial results from the
# other sources) rather than hang. Overridable for offline/batch use.
RATE_LIMIT_TOTAL_BUDGET_SECONDS = float(
    os.environ.get("RESEARCHLAB_RATE_LIMIT_BUDGET_SECONDS") or 45.0
)
# A shorter ceiling for hosts whose anonymous pool throttles often. Semantic
# Scholar refuses anonymous bursts with 429 and no Retry-After; waiting 45 s
# per URL there would hold every probe hostage to one source the others do not
# need. The failure is recorded as throttled, never as an empty field.
RATE_LIMIT_TOTAL_BUDGET_BY_HOST = {
    "api.semanticscholar.org": float(
        os.environ.get("RESEARCHLAB_S2_RATE_LIMIT_BUDGET_SECONDS") or 20.0
    ),
}

MAX_PAPERS_PER_QUERY = 36
MAX_TOTAL_PAPERS = 120
MIN_REQUIRED_PAPERS = 100
CURRENT_YEAR = time.gmtime().tm_year
EXTERNAL_REPO_SEARCH_PER_QUERY = 8
EXTERNAL_REPO_CLONE_TIMEOUT_SECONDS = 90
# ----------------------------------------------------------------------
# Domain-neutral filter / score constants.
#
# The prior revision of this file kept 11 WHO/vaccination-specific term
# lists (PRIMARY_TOPIC_TERMS, REQUIRED_CHILDHOOD_TERMS, PREFERRED_TITLE_
# TERMS, FALLBACK_ACCEPT_TERMS, BLOCKED_TEXT_TERMS that filtered out
# omics topics like cancer/diabetes, HIGH_IMPACT_JOURNAL_TERMS biased
# toward Lancet Global Health / Bulletin of WHO / Vaccine, etc.). Those
# lists meant scout returned omics papers from OpenAlex/Crossref but
# then filtered them OUT and boosted WHO papers IN.
#
# Level 3 replaces them with empty or minimal domain-neutral sets:
# - no BLOCKED_TEXT_TERMS (rely on API relevance + paper-type gate)
# - no REQUIRED_CHILDHOOD_TERMS (retrieval must not require vaccine context)
# - no PRIMARY_TOPIC_TERMS / OUTCOME_TERMS / METHOD_TERMS / SURVEILLANCE_
#   ACCEPT_TERMS / FALLBACK_ACCEPT_TERMS (keep names empty; downstream
#   relevance is driven by API-sort + citation + recency)
# - no PREFERRED_TITLE_TERMS (no title-keyword boost)
# - empty HIGH_IMPACT_JOURNAL_TERMS (venue bonus disabled pending a
#   domain-neutral replacement; citation count carries most of the load)
# - empty PRIMARY_FAMILY_LIBRARY (frontier catalog is derived from the
#   role plan and the retrieved papers only — no cached WHO families)
# ----------------------------------------------------------------------
PRIMARY_TOPIC_TERMS: list[str] = []
OUTCOME_TERMS: list[str] = []
METHOD_TERMS: list[str] = []
BLOCKED_TEXT_TERMS: list[str] = []
REQUIRED_CHILDHOOD_TERMS: list[str] = []
PREFERRED_TITLE_TERMS: list[str] = []
FALLBACK_ACCEPT_TERMS: list[str] = []
HIGH_IMPACT_JOURNAL_TERMS: dict[str, int] = {}
PRIMARY_FAMILY_LIBRARY: list[dict] = []
SURVEILLANCE_ACCEPT_TERMS: list[str] = []

# A small obvious-spam filter that applies regardless of domain. These
# are titles that show up as keyword collisions across many searches and
# almost never represent the work we actually want. Keep short and
# domain-neutral; do not add field-specific filters here.
OBVIOUS_SPAM_TITLE_TERMS = [
    "trust-aware recommender",
    "recommender systems",
]
EXPANSION_SCENARIOS = [
    # Domain-neutral study-design / methodology modifiers. The prior
    # revision hardcoded WHO / public-health expansions
    # (equity gradient, zero-dose, health system capacity) that coated
    # every query with immunization vocabulary regardless of the user
    # prompt. These are replaced with methodology terms that are equally
    # useful across omics, trials, epidemiology, and policy research.
    "mechanism",
    "moderator analysis",
    "heterogeneity",
    "sensitivity analysis",
    "causal identification",
    "benchmark comparison",
    "reproducibility",
    "confounding",
]

# Abbreviation expansions for common open-data repositories and analysis
# frameworks. PubMed keyword search treats "GEO" and "TCGA" as ordinary
# tokens and will otherwise return geographic / unrelated hits. We wrap
# each abbreviation with its full name so ESearch matches titles and
# abstracts that actually reference the repository.
REPOSITORY_ALIASES = {
    "geo": '("Gene Expression Omnibus" OR "GEO dataset" OR "GEO accession")',
    "arrayexpress": '("ArrayExpress" OR "Expression Atlas")',
    "tcga": '("The Cancer Genome Atlas" OR TCGA)',
    "gtex": '("Genotype-Tissue Expression" OR GTEx)',
    "recount": '("recount3" OR "Recount" OR "recount2")',
    "encode": '("ENCODE Project" OR "Encyclopedia of DNA Elements" OR ENCODE)',
    "cptac": '("Clinical Proteomic Tumor Analysis Consortium" OR CPTAC)',
    "depmap": '("Cancer Dependency Map" OR DepMap OR "Achilles project")',
    "ccle": '("Cancer Cell Line Encyclopedia" OR CCLE)',
    "uk biobank": '"UK Biobank"',
    "human cell atlas": '"Human Cell Atlas"',
    "1000 genomes": '"1000 Genomes"',
    "immport": '"ImmPort"',
}

# Domain-neutral methodology phrases that we want to keep quoted so
# PubMed treats them as multi-word search units rather than ORing the
# individual tokens.
PHRASE_ANCHORS = [
    "differential expression",
    "pathway enrichment",
    "gene set enrichment",
    "single-cell",
    "single cell",
    "survival analysis",
    "mendelian randomization",
    "diff-in-diff",
    "event study",
    "instrumental variable",
    "synthetic control",
    "mixed effects",
    "meta-analysis",
    "systematic review",
    "cohort study",
    "case-control",
]
