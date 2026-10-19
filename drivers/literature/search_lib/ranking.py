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

from .constants import CURRENT_YEAR, HIGH_IMPACT_JOURNAL_TERMS, MAX_TOTAL_PAPERS, OBVIOUS_SPAM_TITLE_TERMS
from .http_client import clean_text


def paper_is_relevant(paper: dict) -> bool:
    """Legacy name: record validity for retrieval only, never evidence admission.

    Direct relevance requires the full-abstract semantic review in screening.py.
    """
    title = (paper.get("title") or "").strip()
    if not title:
        return False
    if str(paper.get("type") or "").lower() not in {"article", "review", "report", "preprint", "journal-article", "proceedings-article", "conference paper"}:
        return False
    lowered_title = title.lower()
    if any(term in lowered_title for term in OBVIOUS_SPAM_TITLE_TERMS):
        return False
    return True


def paper_score(paper: dict) -> int:
    """Domain-neutral paper score.

    The prior revision scored papers by WHO/immunization keywords
    (+10 for DTP3, +8 for "immunization", +10 for "routine vaccination
    coverage", +12 for "global routine vaccination coverage", ...) plus
    WHO-biased journal tiers (Lancet Global Health +18, Bulletin of WHO
    +12, Vaccine +8). Non-WHO papers were systematically scored lower
    than WHO ones even when retrieval was balanced.

    Level 3 uses only generic quality signals:
    - citation count (log-scaled)
    - recency (newer = small boost, very old = small penalty)
    - has abstract (+2)
    - has DOI (+1)
    - source = openalex (+2, reflects better metadata coverage)
    - type = preprint (-8, retained as a preprint-vs-peer-review signal)

    HIGH_IMPACT_JOURNAL_TERMS is now empty so the venue bonus is 0 —
    citation count carries the load. No keyword-based boosts.
    """
    score = 0

    journal = clean_text(paper.get("journal")).lower()
    venue_score = 0
    for term, weight in HIGH_IMPACT_JOURNAL_TERMS.items():
        if term in journal:
            venue_score = weight
            break

    year = parse_publication_year(paper.get("year"))
    recency_score = 0
    if year is not None:
        age = max(0, CURRENT_YEAR - year)
        if age <= 1:
            recency_score = 14
        elif age <= 3:
            recency_score = 12
        elif age <= 5:
            recency_score = 9
        elif age <= 8:
            recency_score = 5
        elif age <= 12:
            recency_score = 2
        else:
            recency_score = -4
        if venue_score >= 12 and age <= 5:
            recency_score += 2

    citations = int(paper.get("cited_by_count") or 0)
    if citations > 0:
        score += min(14, int(math.log10(citations + 1) * 5))
    score += venue_score
    score += recency_score
    if paper.get("source") == "openalex":
        score += 2
    if paper.get("type") == "preprint":
        score -= 8
    if paper.get("abstract"):
        score += 2
    if paper.get("doi"):
        score += 1
    return score


def parse_publication_year(value) -> int | None:
    if value is None:
        return None
    match = re.search(r"(19|20)\d{2}", str(value))
    if not match:
        return None
    year = int(match.group(0))
    if 1900 <= year <= CURRENT_YEAR + 1:
        return year
    return None


def title_series_key(title: str | None) -> str:
    text = clean_text(title).lower()
    text = re.sub(r"[\u2010-\u2015—–-]", " ", text)
    text = re.sub(r"\b(19|20)\d{2}\b", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    tokens = [token for token in text.split() if len(token) >= 4]
    return clean_text(" ".join(tokens[:8]))


def is_annual_coverage_series(_title: str | None) -> bool:
    """Always False under Level 3.

    The prior revision used this flag to de-duplicate annual
    "Global Routine Vaccination Coverage, 20XX" reports so they did not
    dominate the top ranks. That logic was WHO-specific; we no longer
    need it because WHO keyword boosts have been removed.
    """
    return False


def diversify_ranked_papers(papers: list[dict], limit: int = MAX_TOTAL_PAPERS) -> list[dict]:
    ranked = sorted(papers, key=paper_score, reverse=True)
    chosen: list[dict] = []
    series_counts: dict[str, int] = {}
    annual_series_selected = 0

    while ranked and len(chosen) < limit:
        best_index = 0
        best_value = None
        for index, paper in enumerate(ranked[: min(len(ranked), 24)]):
            base_score = paper_score(paper)
            series_key = title_series_key(paper.get("title"))
            penalty = 0
            if series_key:
                penalty = series_counts.get(series_key, 0) * 16
            if is_annual_coverage_series(paper.get("title")):
                penalty += annual_series_penalty(series_counts, annual_series_selected, len(chosen))
            adjusted = base_score - penalty
            if best_value is None or adjusted > best_value:
                best_value = adjusted
                best_index = index
        selected = ranked.pop(best_index)
        chosen.append(selected)
        series_key = title_series_key(selected.get("title"))
        if series_key:
            series_counts[series_key] = series_counts.get(series_key, 0) + 1
        if is_annual_coverage_series(selected.get("title")):
            annual_series_selected += 1

    return chosen[:limit]


def annual_series_penalty(series_counts: dict[str, int], annual_series_selected: int, rank_position: int) -> int:
    annual_count = sum(count for key, count in series_counts.items() if "annual series" in key)
    if annual_count == 0 and annual_series_selected == 0:
        return 0
    if rank_position < 10 and annual_series_selected >= 1:
        return 1000
    return 24 + annual_count * 10


def paper_is_fallback_acceptable(paper: dict) -> bool:
    """Domain-neutral fallback acceptor.

    Previously required WHO/vaccine vocabulary (FALLBACK_ACCEPT_TERMS)
    to accept a paper on the fallback path. Those lists are now empty;
    the fallback is simply "is this a readable paper" — has title +
    not obvious spam.
    """
    return paper_is_relevant(paper)
