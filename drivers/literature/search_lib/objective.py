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


# Conservative biomedical-intent vocabulary. Deliberately EXCLUDES tokens that
# are common in graphics / ML / physics (e.g. "neural", "cell", "molecular",
# "model") so a non-biomedical objective is never misrouted to PubMed. Only
# clearly clinical / molecular-biology / epidemiology signals are listed.
BIOMEDICAL_INTENT_TERMS = frozenset({
    "clinical", "patient", "disease", "cancer", "tumor", "tumour", "oncolog",
    "vaccine", "virus", "viral", "pathogen", "immune", "immunolog", "antibody",
    "antigen", "genome", "genomic", "transcriptom", "proteom", "biomarker",
    "epidemi", "cohort", "gene expression", "rna-seq", "rna seq", "single-cell",
    "single cell", "drug", "pharmacolog", "therapeut", "clinical trial",
    "biomedical", "metaboli", "microbiome", "mrna", "peptide", "mortality",
    "morbidity", "in vivo", "in vitro", "biopsy", "histolog", "patholog",
})


def objective_is_biomedical(text: str) -> bool:
    """True when the objective / query text shows clear biomedical intent."""
    lowered = (text or "").lower()
    return any(term in lowered for term in BIOMEDICAL_INTENT_TERMS)



# `_analyst_objective_is_cs` stood here.
#
# It matched the objective's words against one field's assays and archives, and
# fell back to `role_plan.objective_domain` -- a key the analyst plan no longer
# emits, because the JS and Rust classifiers it mirrored are gone. Four call
# sites branched on it, and every one of them already had a data-shaped
# condition underneath: a builder that returns None without the csvs it needs, a
# backend selection that names itself, a modality read off the bundle. A word
# match on top of a measurement is redundant when the data agrees and wrong when
# it does not.


def _objective_forbidden_dataset_terms(role_plan: dict | None) -> set[str]:
    """Extract explicit dataset/accession deny terms from the objective.

    The planner prompt can say "Do not reuse GSE282742". The deterministic
    analyst handoff builder must honor that instruction too; otherwise it can
    pin the forbidden bundle before the LLM ever has a chance to reject it.
    Keep this deliberately narrow: only accession-like identifiers and quoted
    dataset tokens are hard filters.
    """
    text = " ".join(
        str((role_plan or {}).get(key) or "") for key in ("objective", "analysis_goal", "task")
    )
    metadata = (role_plan or {}).get("planner_metadata") or {}
    for key in ("objective", "analysis_goal", "task", "forbidden_datasets", "avoid_datasets"):
        value = metadata.get(key)
        if isinstance(value, list):
            text += " " + " ".join(str(item) for item in value)
        elif value:
            text += " " + str(value)
    lower = text.lower()
    terms: set[str] = set()
    for pattern in (r"\bgse\d+\b", r"\bsrp\d+\b", r"\bprjna\d+\b", r"\begas\d+\b"):
        terms.update(match.group(0).lower() for match in re.finditer(pattern, lower, flags=re.I))
    return terms
