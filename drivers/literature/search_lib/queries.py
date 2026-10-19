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

from .constants import PHRASE_ANCHORS, PRIMARY_FAMILY_LIBRARY, REPOSITORY_ALIASES
from .http_client import clean_text


QUERY_STOPWORDS = {
    "about", "above", "across", "affect", "affects", "after", "again", "against", "agent",
    "also", "and", "another", "any", "because", "been", "being", "between",
    "but", "can", "could", "did", "does", "done", "during", "each", "for",
    "from", "had", "has", "have", "having", "into",
    "analysis", "analyst", "assigned", "authoritative", "autonomous", "before", "brief",
    "artifacts", "autoresearch", "bundle", "cache", "competing", "complete", "cycle",
    "cycle_id", "data", "dataset", "datasets", "description", "directly",
    "differently", "directory", "driver", "evidence", "execute", "families", "family", "file", "files", "fresh",
    "converted", "falsification", "followup", "freeze", "gap", "gaps", "gate", "gatekeeper",
    "hypotheses", "hypothesis", "lane",
    "handoff", "json", "labdirector", "latest", "lead", "leading", "less",
    "literature", "materialized", "metadata",
    "marked", "may", "method", "methods", "objective", "objection", "objections", "one", "paper", "papers", "pass", "path", "plan",
    "planner", "prompt", "promotion", "query", "reason", "reasoning", "reasons",
    "required", "research", "researcher",
    "researchlab", "restart", "result", "results", "role", "role_plan",
    "runner", "scout", "searching", "selection", "sharper", "show", "source", "status",
    "stronger", "study", "task", "target", "targets", "test", "than", "that", "the", "their", "then", "there",
    "these", "this", "those", "through", "under", "unless", "unresolved",
    "using", "validation", "where", "which", "while", "with", "within",
    "without", "workspace", "would",
}
# Words an objective uses to instruct the lab, not to name its subject.
#
# MEASURED ON cycle-b-20260918, 2026-09-18/19. Deterministic scouts searched
#   "python several procedure distinct candidate questions significance"
#   "python claims PC simulators"
#   "mujoco simulation several procedure distinct candidate questions significance"
# built from "LabDirector: several procedure-distinct candidate questions with
# significance" and "which robot-learning claims that this PC's simulators can
# test are still unsettled". Every one of these words is long enough to pass as
# a specific signal, and none of them says what field the cycle is in.
OBJECTIVE_META_WORDS = {
    "ablation", "ablations", "answer", "candidate", "candidates", "claim", "claims",
    "decide", "declared", "deliver", "delivers", "distinct", "falsifiable", "matched",
    "pick", "problem", "problems", "question", "questions", "seeds", "several",
    "significance", "unsettled",
    # Filler that survived with them: "simulators below now".
    "below", "now", "still", "hold", "holds", "tested", "measured",
}
QUERY_STOPWORDS |= OBJECTIVE_META_WORDS
NON_QUERY_ACRONYMS = {
    "JSON", "CSV", "HTTP", "HTTPS", "URL", "DOI", "PID", "HD", "FPKM",
    # Host and emphasis words that match the acronym shape ("this PC's",
    # "Pick ONE"), measured on cycle-b-20260918.
    "PC", "ONE", "GPU", "CPU", "OS", "GB", "RAM",
}
QUERY_BLOCKLIST_MARKERS = (
    "autoresearch",
    "research-lab",
    "researchlab",
    "workspace",
    ".json",
    "role-plan",
    "cycle_id",
    "source_brief_id",
)
GENERIC_SCIENCE_SUFFIXES = (
    "ase",
    "emia",
    "genic",
    "genomic",
    "itis",
    "ology",
    "omic",
    "omics",
    "opathy",
    "osis",
    "phenotype",
    "protein",
    "scriptomic",
)
GENERIC_SCIENCE_TERMS = {
    "abundance",
    "biomarker",
    "cell",
    "cells",
    "cohort",
    "confounding",
    "cytometry",
    "dataset",
    "expression",
    "gene",
    "genes",
    "genome",
    "pathway",
    "phenotype",
    "protein",
    "score",
    "signature",
    "stratified",
    "transcriptome",
}


def _looks_like_task_blob(value: str) -> bool:
    text = clean_text(value)
    lowered = text.lower()
    if len(text) > 260:
        return True
    return any(
        marker in lowered
        for marker in (
            "autonomous follow-up task",
            "assigned hypotheses",
            "cycle_id:",
            "source_brief_id",
            "unresolved reasoning/data gaps",
        )
    )


def _query_tokens(value: str) -> list[str]:
    tokens: list[str] = []
    value = re.sub(r"(?<=[A-Za-z0-9])[-/](?=[A-Za-z0-9])", " ", value)
    for token in re.findall(r"[A-Za-z][A-Za-z0-9+-]{2,}", value):
        cleaned = token.strip("-+").lower()
        if len(cleaned) < 3 or cleaned in QUERY_STOPWORDS:
            continue
        if any(marker in cleaned for marker in QUERY_BLOCKLIST_MARKERS):
            continue
        if cleaned.startswith(("followup", "attempt", "brief-", "hyp-", "v56")):
            continue
        if re.fullmatch(r"[sh]\d+", cleaned):
            continue
        tokens.append(cleaned)
    return tokens


def _normal_query_token(raw: str) -> tuple[str, str] | None:
    lower = raw.lower().strip("-+")
    if raw in NON_QUERY_ACRONYMS and len(lower) < 3:
        return None
    if len(lower) < 3 and not re.fullmatch(r"[A-Z0-9]{2,8}", raw):
        return None
    if not lower or lower in QUERY_STOPWORDS:
        return None
    if any(marker in lower for marker in QUERY_BLOCKLIST_MARKERS):
        return None
    if lower.endswith("ly") and lower not in GENERIC_SCIENCE_TERMS:
        return None
    if lower.startswith(("followup", "attempt", "brief", "hyp-", "v56")):
        return None
    if re.fullmatch(r"[sh]\d+", lower):
        return None
    if re.fullmatch(r"\d+", lower):
        return None
    display = raw if re.fullmatch(r"[A-Z0-9]{2,8}", raw) and raw not in NON_QUERY_ACRONYMS else lower
    return display, lower


def _phrase_words(segment: str) -> list[tuple[str, str]]:
    expanded = re.sub(r"(?<=[A-Za-z0-9])[-/](?=[A-Za-z0-9])", " ", segment)
    words: list[tuple[str, str]] = []
    for raw in re.findall(r"[A-Za-z][A-Za-z0-9+]{1,}", expanded):
        token = _normal_query_token(raw)
        if token:
            words.append(token)
    return words


def _phrase_has_specific_signal(words: list[tuple[str, str]]) -> bool:
    for display, lower in words:
        if display.isupper() and display not in NON_QUERY_ACRONYMS:
            return True
        if len(lower) >= 8:
            return True
        if lower in GENERIC_SCIENCE_TERMS:
            return True
        if lower.endswith(GENERIC_SCIENCE_SUFFIXES):
            return True
    return False


def _score_phrase(words: list[tuple[str, str]], position: int) -> tuple[int, int]:
    lowers = [lower for _, lower in words]
    score = len(words)
    score += sum(1 for lower in lowers if len(lower) >= 7)
    score += sum(2 for display, _ in words if display.isupper() and display not in NON_QUERY_ACRONYMS)
    score += 3 if any(len(lower) >= 10 for lower in lowers) else 0
    score += 2 if any(lower in GENERIC_SCIENCE_TERMS for lower in lowers) else 0
    score += 4 if any(lower.endswith(GENERIC_SCIENCE_SUFFIXES) for lower in lowers) else 0
    if len(words) == 3:
        score += 4
    if len(words) > 5:
        score -= len(words) - 5
    return -score, position


def _candidate_phrase(display_words: list[tuple[str, str]]) -> str:
    return " ".join(display for display, _ in display_words)


def _reject_query_phrase(phrase: str) -> bool:
    lowered = phrase.lower()
    if any(marker in lowered for marker in QUERY_BLOCKLIST_MARKERS):
        return True
    words = lowered.split()
    if len(words) < 2 and not re.fullmatch(r"[A-Z0-9]{2,8}", phrase):
        return True
    if all(word in QUERY_STOPWORDS for word in words):
        return True
    return False


def _looks_like_scientific_context(text: str) -> bool:
    if _scientific_phrases(text):
        return True
    tokens = _query_tokens(text)
    return len(tokens) >= 4 and any(len(token) >= 8 for token in tokens)


def _clean_query_context_text(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"\|\s*unresolved reasoning(?:/data)? gaps?:.*$", " ", text, flags=re.I)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"/[\w./-]+", " ", text)
    text = re.sub(r"\b(?:handoff_)?fingerprint=\S+", " ", text, flags=re.I)
    text = re.sub(r"\brequired_check_ids=\S+", " ", text, flags=re.I)
    text = re.sub(r"\[[^\]]*attempt\s+\d+[^\]]*\]", " ", text, flags=re.I)
    text = re.sub(r"\b[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+){3,}\b", " ", text)
    return clean_text(text)


# A hypothesis slot holding a STATUS instead of a claim.
#
# cycle-g-v83 searched the literature for "selected pending chronicle".
#
# The director withheld its lead and wrote the reason into the statement field -
# "No hypothesis selected pending Chronicle evidence." - and that sentence became
# the scout's search topic, because it has more than three tokens and so cleared
# every check below. Five literature lanes then retrieved 500 papers on clinical
# decision support, COVID school closures, 3D cancer models and one titled "Crypto
# Withdrawal Pending". Chronicle read the corpus correctly ("zero rendering
# papers") and could not supply the absence evidence the director was waiting for,
# so the director withheld again - and the placeholder it wrote became the next
# round's query. A closed loop, running on the cycle's whole budget.
#
# The tell is not vagueness, which the token/phrase checks already catch. It is
# that the sentence is ABOUT the hypothesis being absent.
_HYPOTHESIS_PLACEHOLDER = re.compile(
    r"\b(?:no|not)\s+(?:\w+\s+){0,2}(?:hypothesis|hypotheses|lead|problem)\b"
    r"|\bhypothesis\s+(?:is\s+)?(?:not\s+)?(?:selected|withheld|pending|deferred|retired|unavailable)\b"
    r"|\b(?:withheld|deferred|retired|pending)\s+(?:pending\s+)?(?:chronicle|evidence|verification|absence)\b"
    r"|\bnot\s+selected\b"
    r"|\bpending\s+chronicle\b"
    r"|\bawaiting\s+(?:chronicle|evidence)\b",
    re.IGNORECASE,
)


# Section headings under which an objective describes the lab, not the science:
# the host and its instruments, the robots on hand, the roles and what each
# delivers, constraints, budgets. Their prose is the densest text in a cycle
# objective, the phrase miner ranked it highest, and so it became the search
# topic (cycle-b-20260918, above).
_META_SECTION_HEADING = re.compile(
    r"\b(?:instruments?|host|hardware|machines?|compute|environments?|setup|install\w*|"
    r"software|tools?|resources?|robots?|equipment|roles?|deliver\w*|"
    r"constraints?|rules|budgets?|outputs?|artifacts?|reporting|logistics|safety|"
    r"workflow|procedures?|task)\b",
    re.IGNORECASE,
)
_HEADING_LINE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
# "- Scout: ...", "- LabDirector: ..." -- a role's deliverable, not a topic.
_ROLE_BULLET = re.compile(
    r"^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*)?(?:scouts?|lab[- ]?directors?|analysts?|lab[- ]?runners?|"
    r"runners?|gatekeepers?|chronicle|authors?|engineers?|reviewers?)(?:\*\*)?\s*:",
    re.IGNORECASE,
)
# Task-file metadata lines ("- cycle_id: ...", "- role: scout", "- task: ...").
_TASK_METADATA_LINE = re.compile(
    r"^\s*[-*]?\s*(?:cycle_id|source_brief_id|role|task|lane_id|action_type|assigned_model)\s*:",
    re.IGNORECASE,
)
_OBJECTIVE_KEY_PREFIX = re.compile(r"^\s*[-*]?\s*objective\s*:\s*", re.IGNORECASE)
_TOPIC_LABEL_PREFIX = re.compile(
    r"^\s*(?:research\s+)?(?:problem|question|objective|goal|aim)\s*:\s*", re.IGNORECASE
)


def domain_objective_text(value: str | None) -> str:
    """The part of an objective (or task file) that names its subject.

    Drops markdown sections whose heading describes the lab rather than the
    science (instruments on this host, robots available, what each role
    delivers, constraints), role-deliverable bullets, task-file metadata lines
    and inline code. Keeps the title, the research problem and every other
    section. It reads line structure, so it must run BEFORE clean_text
    collapses the newlines. Returns "" when nothing is left.
    """
    if not value:
        return ""
    kept: list[str] = []
    skip_level = 0
    for raw_line in str(value).splitlines():
        line = _OBJECTIVE_KEY_PREFIX.sub("", raw_line)
        heading = _HEADING_LINE.match(line)
        if heading:
            level = len(heading.group(1))
            if skip_level and level > skip_level:
                continue
            skip_level = level if _META_SECTION_HEADING.search(heading.group(2)) else 0
            if not skip_level:
                kept.append(heading.group(2))
            continue
        if skip_level:
            continue
        if _TASK_METADATA_LINE.match(line) or _ROLE_BULLET.match(line):
            continue
        line = re.sub(r"`[^`]*`", " ", line)
        line = re.sub(r"\b[A-Za-z]:[\\/]\S*", " ", line)
        # "language/vision-conditioned" is two words, not a path; the path
        # stripper downstream would otherwise delete everything after the slash.
        line = re.sub(r"\b([A-Za-z][A-Za-z-]*)/(?=[A-Za-z][A-Za-z-]*(?:[\s,;:.!?)]|$))", r"\1 ", line)
        line = _TOPIC_LABEL_PREFIX.sub("", line).strip()
        if line:
            kept.append(line)
    # Each kept line ends as a sentence, so the title does not run into the
    # research problem once clean_text removes the newlines.
    return "\n".join(line if line[-1] in ".!?;:" else line + "." for line in kept).strip()


def queries_from_objective_text(value: str | None) -> list[str]:
    """One query per distinct subject phrase of an objective, or none.

    Replaces the blob path for objective and task text, which joined the top
    phrases and tokens of the whole text into one string. Returns [] when the
    objective names no subject once the lab-describing sections are gone; the
    caller says so instead of searching on instruction words.
    """
    text = _clean_query_context_text(domain_objective_text(value))
    if not text:
        return []
    queries = list(distinct_phrases(_scientific_phrases(text)))
    tokens = _query_tokens(text)
    if tokens:
        queries.append(" ".join(tokens[:5]))
    return domain_bearing_queries(sanitize_queries(queries))


def domain_bearing_queries(queries: list[str]) -> list[str]:
    """Only queries with at least one word that names a subject.

    A query made only of instruction, workflow and generic-science words asks
    every field at once; it is dropped rather than sent.
    """
    kept = []
    for query in queries:
        tokens = [token for token in _query_tokens(str(query)) if token not in GENERIC_SCIENCE_TERMS]
        if tokens:
            kept.append(query)
    return kept


def _low_information_hypothesis(value: str) -> bool:
    raw_lowered = clean_text(value).lower()
    if "literature_only_no_data_test" in raw_lowered:
        return True
    if _HYPOTHESIS_PLACEHOLDER.search(raw_lowered):
        return True
    text = _clean_query_context_text(value)
    lowered = text.lower()
    if not text:
        return True
    if lowered.startswith("selected by "):
        return True
    phrases = _scientific_phrases(text)
    if re.search(r"\bmay\s+affect\b", lowered) and len(phrases) < 4:
        return True
    if len(_query_tokens(text)) < 3 and len(phrases) < 2:
        return True
    return False


def _role_plan_scientific_context(value: object, out: list[str] | None = None, *, depth: int = 0) -> list[str]:
    if out is None:
        out = []
    if len(out) >= 60 or depth > 6:
        return out
    if isinstance(value, str):
        # Any plan string may carry a copy of the objective (the search
        # contract's research problem does), so the same lab sections go.
        text = _clean_query_context_text(domain_objective_text(value))
        if not text:
            return out
        lowered = text.lower()
        if "literature_only_no_data_test" in lowered:
            return out
        if _looks_like_scientific_context(text):
            out.append(text[:1200])
        return out
    if isinstance(value, dict):
        preferred = [
            "summary",
            "statement",
            "core_claim",
            "hypothesis_statement",
            "candidate_title",
            "major_objections",
            "missing_validations",
            "better_alternative_hypotheses",
            "same_family_alternatives",
            "cross_family_alternatives",
            "analyst_handoff",
            "planner_metadata",
            "data_kg_digest",
        ]
        for key in preferred:
            if key in value:
                _role_plan_scientific_context(value[key], out, depth=depth + 1)
                if len(out) >= 60:
                    return out
        for key, nested in value.items():
            if key in preferred:
                continue
            if isinstance(nested, (dict, list, str)):
                _role_plan_scientific_context(nested, out, depth=depth + 1)
                if len(out) >= 60:
                    return out
    elif isinstance(value, list):
        for nested in value[:80]:
            _role_plan_scientific_context(nested, out, depth=depth + 1)
            if len(out) >= 60:
                return out
    return out


def _scientific_phrases(value: str) -> list[str]:
    text = clean_text(value)
    if not text:
        return []

    candidates: list[tuple[tuple[int, int], str]] = []
    position = 0

    for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9-]*(?:/[A-Za-z][A-Za-z0-9-]*)+\b", text):
        words = _phrase_words(match.group(0))
        if len(words) >= 2 and _phrase_has_specific_signal(words):
            phrase = _candidate_phrase(words)
            if not _reject_query_phrase(phrase):
                candidates.append((_score_phrase(words, position), phrase))
                position += 1

    normalized = re.sub(r"```.*?```", " ", text, flags=re.S)
    normalized = re.sub(r"`([^`]+)`", r"\1", normalized)
    normalized = re.sub(r"https?://\S+", " ", normalized)
    normalized = re.sub(r"/[\w./-]+", " ", normalized)
    normalized = re.sub(
        r"\b(?:is|are|was|were|be|been|being|marked|associated|driven|mediated|predicts?|explains?|requires?|shows?)\b",
        " . ",
        normalized,
        flags=re.I,
    )
    segments = re.split(r"[\n\r,;:|()\[\]{}\u2013\u2014]+|[.!?]\s+", normalized)
    for segment in segments:
        words = _phrase_words(segment)
        if len(words) < 2:
            continue
        windows: list[list[tuple[str, str]]] = []
        if 2 <= len(words) <= 6:
            windows.append(words)
        for size in range(min(5, len(words)), 1, -1):
            for idx in range(0, len(words) - size + 1):
                windows.append(words[idx:idx + size])
        for window in windows:
            if not _phrase_has_specific_signal(window):
                continue
            phrase = _candidate_phrase(window)
            if _reject_query_phrase(phrase):
                continue
            candidates.append((_score_phrase(window, position), phrase))
            position += 1

    for token in re.findall(r"\b[A-Z0-9]{2,8}\b", text):
        if token in NON_QUERY_ACRONYMS:
            continue
        phrase = token
        if not _reject_query_phrase(phrase):
            candidates.append(((-4, position), phrase))
            position += 1

    ordered = [phrase for _, phrase in sorted(candidates, key=lambda item: item[0])]
    return _dedupe_texts(ordered, limit=16)

# How many phrase queries one text is worth. Each becomes its own search
# against every configured source, so this bounds the round trips, not the
# recall: a phrase dropped here overlaps one already kept.
PHRASE_QUERY_LIMIT = 4

# Two phrases sharing this fraction of the smaller one's words are the same
# question asked twice. Window enumeration produces them by construction --
# "a b c d" and "b c d e" share three of four -- and neither contains the
# other, so a substring dedupe does not see it.
PHRASE_OVERLAP_LIMIT = 0.6


def _phrase_word_set(phrase: str) -> frozenset:
    return frozenset(re.findall(r"[a-z0-9]+", str(phrase).lower()))


def distinct_phrases(phrases: list[str], limit: int = PHRASE_QUERY_LIMIT) -> list[str]:
    """Phrases that ask different questions, in the order given.

    `_scientific_phrases` returns EVERY window of length 2..5 over each
    segment, ranked, so the top of that list is routinely one clause sliced
    several ways. `_dedupe_texts` drops only exact repeats, and the overlap
    survives into whatever is built next.
    """
    kept: list[str] = []
    kept_words: list[frozenset] = []
    for phrase in phrases:
        words = _phrase_word_set(phrase)
        if not words:
            continue
        if any(
            len(words & seen) >= PHRASE_OVERLAP_LIMIT * min(len(words), len(seen))
            for seen in kept_words
        ):
            continue
        kept.append(str(phrase).strip())
        kept_words.append(words)
        if len(kept) >= limit:
            break
    return kept


def _dedupe_texts(items: list[str], limit: int = 12) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        cleaned = clean_text(str(item))
        cleaned = re.sub(r"^[#*\-\s]+", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" ;,.:")
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(cleaned)
        if len(out) >= limit:
            break
    return out


def _sanitize_query(value: str) -> str:
    text = clean_text(value)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"/[\w./-]+", " ", text)
    text = re.sub(r"\b[a-f0-9]{10,}\b", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -:;,.")
    if _looks_like_task_blob(text):
        phrases = _scientific_phrases(text)
        tokens = _query_tokens(text)
        parts = _dedupe_texts([*phrases[:4], *tokens[:6]], limit=8)
        text = " ".join(parts)
    if re.search(r"(autoresearch|research-lab|workspace|\.json|/)", text.lower()) and not _scientific_phrases(text):
        return ""
    words = text.split()
    if len(words) > 14:
        text = " ".join(words[:14])
    return text[:180].strip(" -:;,.")


# Harness/workflow vocabulary that leaks from followup TASK text into derived
# queries ("Adjudicate the supersession requests and score the new package…" →
# "adjudicate blocker supersession requests benchmark comparison"). Such queries
# citation-match famous OFF-TOPIC papers (liver-tumor segmentation, single-cell
# genomics, LLM surveys were pulled into a rendering cycle's corpus this way),
# and the gatekeeper then rightly refuses to certify novelty against the
# polluted baseline. Any query containing one of these tokens is a process
# query, not a science query — drop it; when everything drops, the role-plan
# fallback below derives on-objective queries instead. Deliberately excludes
# ambiguous words that are real science terms (e.g. "artifact" in rendering).
_WORKFLOW_QUERY_TOKENS = re.compile(
    r"(adjudicat|supersession|supersede|blocker|gatekeep|handoff|requery"
    r"|lab.?runner|run.?plan|run.?state|role.?plan|dispatch|rubric"
    r"|ranked candidate|candidate table|executable)",
    re.IGNORECASE,
)


def sanitize_queries(queries: list[str], *, role_plan: dict | None = None) -> list[str]:
    sanitized = [_sanitize_query(str(query)) for query in queries]
    sanitized = [query for query in sanitized if query and not _looks_like_task_blob(query)]
    sanitized = [query for query in sanitized if not _WORKFLOW_QUERY_TOKENS.search(query)]
    if sanitized:
        return _dedupe_texts(sanitized, limit=12)
    if role_plan:
        derived = derive_queries_from_role_plan(role_plan)
        return [query for query in derived if not _WORKFLOW_QUERY_TOKENS.search(query)]
    return []


def derive_queries_from_role_plan(role_plan: dict | None) -> list[str]:
    if not isinstance(role_plan, dict):
        return []
    primary_parts: list[str] = []
    secondary_parts: list[str] = []
    for item in role_plan.get("assigned_hypotheses") or []:
        if isinstance(item, str) and not _low_information_hypothesis(item):
            primary_parts.append(_clean_query_context_text(item))
    # When the lead is a placeholder, the candidate the director is actually
    # working on is right here in the same plan, and so is the cycle objective.
    # v83's role plan carried assigned_hypotheses=["No hypothesis selected pending
    # Chronicle evidence."] alongside a candidate reading "Can edit-induced Monte
    # Carlo residual and variance patterns measured in image space predict the
    # edit-severity crossover..." - the good text was never out of reach, only
    # unused.
    if not primary_parts:
        planner_meta = role_plan.get("planner_metadata")
        candidates = (planner_meta or {}).get("candidate_hypotheses") if isinstance(planner_meta, dict) else None
        for item in candidates or []:
            if not isinstance(item, dict):
                continue
            for key in ("statement", "answers_research_problem"):
                text_value = item.get(key)
                if isinstance(text_value, str) and not _low_information_hypothesis(text_value):
                    primary_parts.append(_clean_query_context_text(text_value))
                    break
            if primary_parts:
                break
    if not primary_parts:
        objective = role_plan.get("objective")
        objective = domain_objective_text(objective) if isinstance(objective, str) else ""
        if objective:
            primary_parts.append(_clean_query_context_text(objective))
    for key in ("search_goal", "analysis_goal", "followup_description"):
        value = role_plan.get(key)
        if isinstance(value, str):
            secondary_parts.append(_clean_query_context_text(value))
    for key in ("focus_families", "focus_outcomes"):
        value = role_plan.get(key)
        if isinstance(value, list):
            secondary_parts.extend(_clean_query_context_text(str(item).replace("_", " ")) for item in value[:8])
    planner = role_plan.get("planner_metadata") if isinstance(role_plan.get("planner_metadata"), dict) else {}
    for key in ("blocker_reasons", "recommended_actions", "challenge_questions", "discovered_queries"):
        value = planner.get(key)
        if isinstance(value, list):
            secondary_parts.extend(_clean_query_context_text(str(item)) for item in value[:6])
    text_parts = primary_parts or [part for part in secondary_parts if part]
    if not primary_parts and not text_parts:
        text_parts.extend(_role_plan_scientific_context(role_plan))
    text = ". ".join(part for part in text_parts if part)
    phrases = _scientific_phrases(text)
    tokens = _query_tokens(text)
    if not phrases and not tokens:
        return []

    # One query per phrase. Joining several was the bug: the phrases handed
    # here are overlapping windows over the same clause, so a join repeats the
    # overlap and asks for a sentence no paper contains.
    #
    # MEASURED ON cycle-g-v91, 2026-09-13. Eleven prior-art scout lanes
    # (followup-scout-04 through -27) each searched
    #   "varied conditions preferred explanation procedure reverse conditions
    #    preferred explanation procedure reverse conditions preferred explanation"
    # and returned paper_count=0. Every one of them was counted
    # failed_blocking, which is how a working retrieval path reported itself
    # as eleven lane failures.
    queries: list[str] = list(distinct_phrases(phrases))
    if tokens:
        queries.append(" ".join(tokens[:5]))
    # No templated "<phrase> benchmark comparison" tails: task-prose phrases with
    # generic suffixes citation-match famous OFF-TOPIC papers (LiTS, single-cell
    # atlases, LLM surveys landed in a rendering corpus this way) and say nothing
    # the plain phrase queries above do not already ask.
    # No anchoring here. Queries reach retrieval from three sources (this one,
    # the role plan's own list, and the last-resort reader), so an anchor
    # applied here would cover one of three. It is applied where they converge.
    return domain_bearing_queries(sanitize_queries(queries))


def capability_anchor_terms(inventory: dict | None, limit: int = 2) -> list[str]:
    """Terms that say what subject this cycle works in, from what it MEASURED.

    Not a domain list and not a guess about the field. The instrument probe
    writes what this container was measured to be able to do, in the words of
    the probe modules themselves, and those words are characteristic of the
    subject by construction: a container that probed rendering describes
    per-pixel variance and AOV channels, a container that probed something else
    describes that something else. Nothing here names a field, so nothing here
    has a field to be wrong about.

    Ranked by how many DISTINCT capabilities a term appears in -- a term the
    probe reaches for again and again across unrelated measurements is what the
    container is for. Terms the repository already classifies as carrying no
    field (QUERY_STOPWORDS, GENERIC_SCIENCE_TERMS) are dropped, because a query
    anchored on "analysis" is not anchored.

    MEASURED ON cycle-g-v91, 2026-09-13: ['pixel', 'aov'] out of 26 recorded
    capabilities, against an objective written in Korean that no English query
    could have been built from.
    """
    if not isinstance(inventory, dict):
        return []
    entries: list[str] = []
    for key in ("verified_instruments", "measurable_quantities", "probe_modules"):
        values = inventory.get(key) or []
        # A dict of probe modules is keyed by backend NAME ("python", "mujoco",
        # "mitsuba"); a name says which tool ran, not what it measured.
        if isinstance(values, dict):
            continue
        for item in values:
            text = clean_text(str(item).replace("_", " "))
            if text:
                entries.append(text)
    if not entries:
        return []
    tool_names = _instrument_tool_names(inventory)
    frequency: dict[str, int] = {}
    for entry in entries:
        for token in set(_query_tokens(entry)):
            if token in QUERY_STOPWORDS or token in GENERIC_SCIENCE_TERMS:
                continue
            if token in tool_names or token in INSTRUMENT_RUNTIME_TERMS:
                continue
            frequency[token] = frequency.get(token, 0) + 1
    ranked = sorted(frequency.items(), key=lambda item: (-item[1], -len(item[0]), item[0]))
    # A term that appears in exactly one capability describes that one
    # measurement, not the container.
    return [token for token, count in ranked if count >= 2][:limit]


# Words a probe uses about the machine it ran on rather than the quantity it
# measured. MEASURED ON cycle-b-20260918, 2026-09-18: the anchor came out as
# "python" (from `python_standard_library_statistics` plus the `python` probe
# module) and later "mujoco simulation", and every query of the cycle was
# prefixed with it -- "python claims PC simulators".
INSTRUMENT_RUNTIME_TERMS = {
    "python", "standard", "library", "installation", "install", "process", "device",
    "cuda", "gpu", "cpu", "headless", "docker", "windows", "linux", "host",
    "interpreter", "runtime", "version", "wall", "clock", "throughput", "sees",
    "supplied", "finite", "numeric", "values", "count", "coverage", "nonzero",
}


def _instrument_tool_names(inventory: dict) -> set[str]:
    """Backend and probe-module names the inventory itself declares."""
    names: set[str] = set()
    for key in ("probe_modules", "backends", "by_backend"):
        value = inventory.get(key)
        if isinstance(value, dict):
            candidates = [str(name) for name in value.keys()]
        elif isinstance(value, list):
            candidates = [item for item in value if isinstance(item, str)]
        else:
            candidates = []
        for name in candidates:
            names.update(_query_tokens(name.replace("_", " ")))
    backend = inventory.get("backend")
    if isinstance(backend, str):
        names.update(_query_tokens(backend.replace("_", " ")))
    return names


def anchor_queries_to_capability(queries: list[str], inventory: dict | None, limit: int = 2) -> list[str]:
    """Put the cycle's own subject in front of each query.

    MEASURED ON cycle-g-v91, 2026-09-13. Unanchored phrase queries retrieved,
    for a computer-graphics cycle: Collatz sequence stopping times, reasons for
    stopping electronic cigarette use, students' confidence calibration in
    mathematics, and streaming speaker verification. 73 retrieved, 71
    quarantined, 0 admitted -- and the screening was RIGHT to quarantine them.
    The query "confidence sequence stopping" is a phrase four fields share.

    The seam this replaces matched the plan text against one field'''s vocabulary
    and emitted literal queries written in it, so it anchored exactly that one
    field and returned an empty list for every other. That is the hardcoding
    this repository forbids, and it is why the graphics cycle had no anchor at
    all. Two tests pinned those literal strings in place, in the same file as a
    test forbidding hardcoded search terms; they are gone.
    """
    terms = capability_anchor_terms(inventory, limit=limit)
    if not terms:
        return list(queries)
    anchor = " ".join(terms)
    anchored: list[str] = []
    for query in queries:
        text = clean_text(str(query))
        if not text:
            continue
        lowered = text.lower()
        # Already anchored: an anchor repeated is the overlap bug again.
        if all(term in lowered for term in terms):
            anchored.append(text)
        else:
            anchored.append(f"{anchor} {text}")
    return sanitize_queries(anchored)


def tokenize_text(value: str | None) -> list[str]:
    return [
        token
        for token in re.split(r"[^a-z0-9+.-]+", clean_text(value).lower())
        if len(token) >= 3
    ]


def role_plan_primary_families(role_plan: dict | None) -> list[dict]:
    if not isinstance(role_plan, dict):
        return []
    families = role_plan.get("candidate_primary_families")
    return families if isinstance(families, list) else []


def gate_restart_candidate_families(role_plan: dict | None) -> list[dict]:
    """Families that must be reconsidered after a gatekeeper reject.

    Gate-restart lanes carry the full gate review context under either
    role_plan.gate_restart_policy or planner_metadata.gate_restart_policy.
    The analyst must not quietly fall back to an empty candidate list or reuse
    the rejected incumbent as the primary family; promote the review's family
    switch recommendations and alternative hypotheses into concrete candidate
    families for the handoff builder.
    """
    if not isinstance(role_plan, dict):
        return []
    planner_metadata = role_plan.get("planner_metadata") if isinstance(role_plan.get("planner_metadata"), dict) else {}
    policy = role_plan.get("gate_restart_policy") or planner_metadata.get("gate_restart_policy")
    if not isinstance(policy, dict):
        return []
    verdict = clean_text(str(policy.get("gate_verdict") or policy.get("verdict") or "")).lower()
    if verdict and verdict != "reject":
        return []
    candidates: list[dict] = []
    for bucket in [
        "family_switch_recommendations",
        "better_alternative_hypotheses",
        "cross_family_alternatives",
    ]:
        for item in policy.get(bucket) or []:
            if not isinstance(item, dict):
                continue
            family = clean_text(str(
                item.get("family")
                or item.get("family_root")
                or item.get("target_family")
                or item.get("recommended_family")
                or ""
            ))
            if not family:
                continue
            statement = clean_text(str(item.get("statement") or item.get("recommendation") or item.get("why_better") or ""))
            candidates.append({
                "family": family,
                "family_root": family,
                "why_competitive": statement or f"Gate reject restart alternative from {bucket}.",
                "priority": "high" if len(candidates) < 3 else "medium",
                "source": f"gate_restart_policy.{bucket}",
                "gate_restart_candidate": True,
            })
    deduped: list[dict] = []
    seen: set[str] = set()
    for item in candidates:
        key = item["family"].lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:8]


def infer_frontier_catalog(papers: list[dict], role_plan: dict | None = None) -> dict:
    joined = " ".join(f"{paper.get('title', '')} {paper.get('abstract', '')}".lower() for paper in papers[:48])
    role_plan_families = role_plan_primary_families(role_plan)
    support_counts: dict[str, int] = {}
    catalog: list[dict] = []
    for template in role_plan_families or PRIMARY_FAMILY_LIBRARY:
        terms = [*template.get("members", []), *template.get("mechanisms", []), *template.get("search_terms", [])]
        support = sum(1 for term in terms if clean_text(term).lower() in joined)
        support_counts[template["family"]] = support
        catalog.append({
            "family": template["family"],
            "members": template.get("members", []),
            "mechanisms": template.get("mechanisms", []),
            "support_count": support,
            "rival_status": "candidate_primary",
        })
    catalog.sort(key=lambda item: (-int(item.get("support_count") or 0), item["family"]))
    return {
        "primary_variable_families": catalog,
        "family_support_counts": support_counts,
    }


def snippet(text: str, limit: int = 220) -> str:
    text = clean_text(text)
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def reconstruct_abstract(index: dict | None) -> str:
    if not index:
        return ""
    positions: list[tuple[int, str]] = []
    for token, offsets in index.items():
        for offset in offsets:
            positions.append((int(offset), token))
    positions.sort(key=lambda item: item[0])
    return clean_text(" ".join(token for _, token in positions))





# Source-specific expansion forms for each repository alias. PubMed
# accepts arbitrary parenthesised disjunctions. OpenAlex's `search`
# parameter and Crossref's `query` parameter handle quoted phrases well
# but treat parentheses as literal characters, so we expand abbreviations
# to a single quoted full name rather than an OR-list.
REPOSITORY_ALIASES_SIMPLE = {
    "geo": '"Gene Expression Omnibus"',
    "arrayexpress": '"ArrayExpress"',
    "tcga": '"The Cancer Genome Atlas"',
    "gtex": '"Genotype-Tissue Expression"',
    "recount": '"recount3"',
    "encode": '"ENCODE Project"',
    "cptac": '"Clinical Proteomic Tumor Analysis Consortium"',
    "depmap": '"Cancer Dependency Map"',
    "ccle": '"Cancer Cell Line Encyclopedia"',
    "uk biobank": '"UK Biobank"',
    "human cell atlas": '"Human Cell Atlas"',
    "1000 genomes": '"1000 Genomes"',
    "immport": '"ImmPort"',
}

# Common set of noise tokens we always strip, regardless of source.
NOISE_PATTERNS = [
    r"\brival explanation variable families\b",
    r"\bcausal structure competing exposures\b",
    r"\bfamily tournament pairwise causal comparison\b",
    r"\brival DAG identification strategy\b",
    r"\bcompeting primary families\b",
    r"\bmulti-country\b",
]


def build_literature_query(raw_query: str, source: str = "pubmed") -> str:
    """Apply literature-search guidelines to a raw query string.

    Source-specific syntaxes (``pubmed``, ``openalex``, ``crossref``)
    differ in how they treat parentheses, quotes, and boolean operators:

    - **PubMed** ESearch supports boolean AND/OR with parenthesised
      grouping and field tags like ``[Title/Abstract]``. We expand each
      repository abbreviation to a full OR-list and auto-quote
      multi-word methodology phrases.
    - **OpenAlex** ``search`` parameter is a single free-text field
      that treats parentheses as literals; each abbreviation is
      expanded to a single full name (no OR-list) and phrases are
      quoted.
    - **Crossref** ``query`` parameter matches bibliographic records
      against the full-text query; same simplification as OpenAlex.

    Transformations (in order):

    1. Trim / collapse whitespace.
    2. Strip pipeline-internal noise tokens
       ("rival explanation variable families", "multi-country", ...).
    3. Expand known repository abbreviations (GEO, TCGA, GTEx, ...) so
       bare tokens don't collide with geographic / unrelated meanings.
       Uses the source-specific alias map (parenthesised for PubMed,
       single full-name for others).
    4. Quote recognised multi-word methodology phrases so the source
       treats them as phrase anchors rather than ORed tokens.
    5. Cap the resulting query at 2,048 characters — all three sources
       reject or silently truncate longer URLs.

    Callers that want to bypass these rules (e.g. to pass a pre-built
    expression with field tags) can set an explicit ``[pm:raw]``,
    ``[oa:raw]``, or ``[cr:raw]`` prefix on ``raw_query`` and this
    function will return the remainder verbatim.
    """
    if not raw_query:
        return ""
    text = raw_query.strip()
    source = (source or "pubmed").lower().strip()

    # Bypass prefixes — one per source plus a generic ``[raw]``.
    bypass_prefixes = ("[pm:raw]", "[oa:raw]", "[cr:raw]", "[raw]")
    lowered_head = text.lower()
    for prefix in bypass_prefixes:
        if lowered_head.startswith(prefix):
            return text[len(prefix):].strip()[:2048]

    # (2) Strip noise first so later steps don't quote/expand junk.
    for noise in NOISE_PATTERNS:
        text = re.sub(noise, "", text, flags=re.IGNORECASE)

    alias_map = REPOSITORY_ALIASES if source == "pubmed" else REPOSITORY_ALIASES_SIMPLE
    lowered = text.lower()

    # (3) Repository alias expansion — replace the earliest occurrence
    # of each recognised abbreviation with its source-appropriate
    # expansion, marking spans so later phrase-quoting doesn't break
    # the inserted expression.
    handled_spans: list[tuple[int, int, str]] = []
    for alias, expansion in alias_map.items():
        idx = lowered.find(alias)
        while idx != -1:
            end = idx + len(alias)
            overlap = any(not (end <= s or idx >= e) for s, e, _ in handled_spans)
            if not overlap:
                handled_spans.append((idx, end, expansion))
            idx = lowered.find(alias, end)
    handled_spans.sort()
    cursor = 0
    rebuilt: list[str] = []
    for start, end, expansion in handled_spans:
        if start > cursor:
            rebuilt.append(text[cursor:start])
        rebuilt.append(expansion)
        cursor = end
    if cursor < len(text):
        rebuilt.append(text[cursor:])
    expanded = "".join(rebuilt) if rebuilt else text

    # (4) Phrase anchoring — quote multi-word methodology anchors where
    # they appear as bare substrings (outside of already-quoted regions).
    for phrase in PHRASE_ANCHORS:
        pattern = re.compile(rf"(?<![\"'a-z0-9]){re.escape(phrase)}(?![\"'a-z0-9])", re.IGNORECASE)
        expanded = pattern.sub(f'"{phrase}"', expanded)

    # (5) Collapse whitespace + cap length.
    expanded = re.sub(r"\s+", " ", expanded).strip()
    if len(expanded) > 2048:
        expanded = expanded[:2048]
    return expanded


def build_pubmed_query(raw_query: str) -> str:
    """Backwards-compatible alias — delegates to build_literature_query.

    Retained so callers outside this module (or pre-existing role-plans
    that embed the function name in prompts) continue to work. New call
    sites should use ``build_literature_query(query, source=...)``.
    """
    return build_literature_query(raw_query, source="pubmed")



def load_queries(queries_file: Path | None, task_file: Path | None) -> list[str]:
    if queries_file and queries_file.exists():
        payload = json.loads(queries_file.read_text(encoding="utf-8"))
        queries = payload.get("queries", [])
        if isinstance(queries, list):
            return sanitize_queries([clean_text(item) for item in queries if clean_text(item)])
    if task_file and task_file.exists():
        # Sections are read off the raw text: clean_text alone would join the
        # "Instruments on this host" section onto the research problem, and the
        # blob path would then send it as one query.
        return queries_from_objective_text(task_file.read_text(encoding="utf-8"))
    raise SystemExit("queries are required; provide --queries-file or a non-empty --task-file")


def queries_from_role_plan(role_plan_file: Path | None) -> list[str]:
    if not role_plan_file or not role_plan_file.exists():
        return []
    payload = json.loads(role_plan_file.read_text(encoding="utf-8"))
    next_cycle_context = payload.get("next_cycle_context") if isinstance(payload, dict) else None
    prioritized_queries = []
    if isinstance(next_cycle_context, dict):
        for item in next_cycle_context.get("prioritized_families", [])[:4]:
            if not isinstance(item, dict):
                continue
            family_root = clean_text(str(item.get("family_root", "")).replace("_", " "))
            action = clean_text(str(item.get("action", "")).replace("_", " "))
            if not family_root:
                continue
            prioritized_queries.extend(
                [
                    f"{family_root} {action} evidence",
                    f"{family_root} pairwise contest literature",
                ]
            )
    direct_queries = payload.get("queries")
    if isinstance(direct_queries, list):
        seen: set[str] = set()
        combined: list[str] = []
        for item in [*direct_queries, *prioritized_queries]:
            cleaned = clean_text(item)
            if not cleaned:
                continue
            lowered = cleaned.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            combined.append(cleaned)
        sanitized = sanitize_queries(combined, role_plan=payload)
        if sanitized:
            return sanitized
    candidate_families = role_plan_primary_families(payload)
    frontier = payload.get("frontier_discovery") if isinstance(payload, dict) else None
    reframed_goal = clean_text((frontier or {}).get("reframed_goal")) if isinstance(frontier, dict) else ""
    family_queries = []
    if candidate_families:
        # Outcome hint is derived from the reframed_goal when present;
        # no WHO default (previously "neonatal mortality"). When we
        # cannot infer an outcome we leave it unset so the query
        # expansion falls back to the search_terms alone.
        outcome = ""
        lowered_goal = reframed_goal.lower()
        for candidate in ["survival", "abundance", "activity",
                          "progression", "response rate", "mortality",
                          "incidence", "prevalence", "outcome"]:
            if candidate in lowered_goal:
                outcome = candidate
                break
        for family in candidate_families[:6]:
            label = clean_text(str(family.get("family", "")).replace("_", " "))
            search_terms = [clean_text(item) for item in family.get("search_terms", []) if clean_text(item)]
            lead = " ".join(search_terms[:2]) or label
            if outcome:
                family_queries.append(f"{lead} {outcome}")
                family_queries.append(f"{label} rival causal mechanism {outcome}")
            else:
                family_queries.append(f"{lead} mechanism")
                family_queries.append(f"{label} rival causal mechanism")
        if outcome:
            family_queries.append(f"{outcome} competing primary variable families")
            family_queries.append(f"{outcome} rival DAG")
        seen: set[str] = set()
        combined: list[str] = []
        for item in [*family_queries, *prioritized_queries]:
            cleaned = clean_text(item)
            if not cleaned:
                continue
            lowered = cleaned.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            combined.append(cleaned)
        sanitized = sanitize_queries(combined, role_plan=payload)
        if sanitized:
            return sanitized

    action_type = clean_text(payload.get("action_type")).lower()
    blocker_reasons = " ".join(payload.get("planner_metadata", {}).get("blocker_reasons", []))
    followup_description = clean_text(payload.get("followup_description"))
    brainstorm_frame = clean_text(payload.get("planner_metadata", {}).get("brainstorm_frame")).lower()
    seed_text = " ".join([action_type, blocker_reasons, followup_description]).lower()

    # Brainstorm frames are planning labels, not standalone literature
    # queries. Search terms must come from the role-plan/task context;
    # otherwise the driver falls back to the task/query file rather than
    # emitting generic methodology searches.
    if brainstorm_frame == "alternative-mechanism":
        return derive_queries_from_role_plan(payload)
    if brainstorm_frame == "moderator-map":
        return derive_queries_from_role_plan(payload)
    if brainstorm_frame == "partition-and-threshold":
        return derive_queries_from_role_plan(payload)
    if brainstorm_frame == "counterfactual-and-rival":
        return derive_queries_from_role_plan(payload)
    if brainstorm_frame == "high-upside-bet":
        return derive_queries_from_role_plan(payload)

    # seed_text labels are routing hints. They should not produce generic
    # hardcoded literature queries without scientific context.
    if "citation" in seed_text:
        return derive_queries_from_role_plan(payload)
    if "novelty" in seed_text or "moderator" in seed_text:
        return derive_queries_from_role_plan(payload)
    if "methods" in seed_text:
        return derive_queries_from_role_plan(payload)
    return derive_queries_from_role_plan(payload)
