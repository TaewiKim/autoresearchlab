from __future__ import annotations

import argparse
import base64
import bz2
import gzip
import importlib.util
import json
import lzma
import math
import os
import re
import subprocess
import sys
import time
import traceback
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from .io_utils import _coerce_str


def _collect_derived_indicator_specs(
    handoff: Dict[str, Any],
) -> Dict[str, List[Dict[str, Any]]]:
    """Bucket derived-indicator specs by the blueprint that must compute them.

    The analyst handoff JSON carries ``derived_indicators`` with a
    ``blueprint_id_reference`` field; this helper flips that into a map so the
    executor can hand each blueprint only the specs it owns. Specs with an
    unknown or missing ``blueprint_id_reference`` end up under the empty
    string key and are attached to every executed blueprint (safer than
    dropping them silently).
    """

    specs = handoff.get("derived_indicators")
    if not isinstance(specs, list):
        return {}
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for item in specs:
        if not isinstance(item, dict):
            continue
        ref = _coerce_str(item.get("blueprint_id_reference"))
        buckets.setdefault(ref, []).append(item)
    return buckets


def _analyst_declared_emitted_columns(raw_spec: Dict[str, Any]) -> List[str]:
    """Columns the ANALYST said this blueprint will emit.

    The analyst authors both the script and the handoff check, so it is the only
    party that can decide what the run will contain; its `column_mapping_contract`
    asks it to record that intent here. This function only reads that decision —
    it infers nothing.
    """

    out: List[str] = []
    for key in ("emitted_columns", "emitted_column_names", "output_columns"):
        value = raw_spec.get(key)
        if isinstance(value, str):
            value = [value]
        for item in value if isinstance(value, (list, tuple)) else []:
            name = _coerce_str(item)
            if name and name not in out:
                out.append(name)
    return out


def _self_generated_dataset(raw_spec: Dict[str, Any], code: str) -> bool:
    """True when the blueprint FABRICATES its own result frame.

    Such a blueprint renders/simulates and then writes columns it names itself, so
    there is no external CSV whose headers need renaming — an external
    ``column_mapping`` is meaningless for it.
    """

    dataset = _coerce_str(raw_spec.get("dataset")).lower()
    # Analysts spell a generated dataset either as a scheme (procedural://scene)
    # or as a bare name (procedural_mitsuba_phase_boundary_v1.csv); both mean the
    # blueprint builds the frame itself.
    if dataset.startswith("procedural") or dataset.startswith("synthetic"):
        return True
    # An explicitly EXTERNAL source is never self-generated, even if the script
    # also happens to build a DataFrame — its columns come from a real file whose
    # headers only the analyst's mapping can name.
    if dataset and "://" in dataset:
        return False
    identification = raw_spec.get("identification_strategy")
    if isinstance(identification, dict):
        materialized = identification.get("materialized_dataset")
        if isinstance(materialized, dict) and _coerce_str(materialized.get("mode")).lower() in {
            "procedural",
            "synthetic",
        }:
            return True
    # Fall back to the code itself: it renders/simulates AND emits its own frame.
    body = code or ""
    emits = ("to_csv" in body) or ("DataFrame" in body)
    generates = ("mi.render" in body) or ("mitsuba" in body) or ("np.random" in body)
    return bool(emits and generates)


# Semantic keys a blueprint declares as required, e.g.
#   req=["scene_id","regime_id","method","seed", ...]
#   required = ["mse", "render_time_s", ...]
_REQUIRED_KEYS_RE = re.compile(
    r"""(?:req|required|required_keys|needed|must_have|cols|columns|keys)\s*=\s*\[(?P<body>[^\]]{0,2000})\]""",
    re.IGNORECASE,
)


def _declared_required_mapping_keys(code: str) -> List[str]:
    """Semantic column keys the blueprint's own preflight demands."""

    keys: List[str] = []
    for match in _REQUIRED_KEYS_RE.finditer(code or ""):
        for token in re.findall(r"""["']([A-Za-z_][A-Za-z0-9_]{1,60})["']""", match.group("body")):
            if token not in keys:
                keys.append(token)
    return keys


# Identifiers that are Python/library vocabulary rather than column names. Only
# used to trim the permissive superset below; a stray extra key is harmless.
_NON_COLUMN_LITERALS = frozenset(
    {
        "utf-8", "r", "w", "a", "rb", "wb", "true", "false", "none", "nan", "inf",
        "__main__", "agg", "png", "csv", "json", "index", "columns", "data",
        "mean", "std", "sum", "min", "max", "count", "median", "path", "type",
        "scalar_rgb", "llvm_ad_rgb", "cuda_ad_rgb", "perspective", "hdrfilm",
        "independent", "box", "rgb", "float32", "to_world", "float", "int", "str",
        # `compile(src, name, "exec")` is the only quoted identifier in a script
        # shipped as a compressed payload, so without this it became the entire
        # recovered mapping on cycle-g-v74 (`{"exec": "exec"}`).
        "exec", "eval", "single", "strict", "ignore", "replace", "surrogateescape",
    }
)


def _permissive_identity_mapping(code: str) -> Dict[str, str]:
    """Superset identity mapping over every column-ish literal in the script.

    RELAXING THE CONTRACT instead of predicting it. The preflight a blueprint
    writes for itself checks membership — ``[x for x in req if x not in m]`` —
    and every key it can possibly require is a STRING LITERAL somewhere in that
    same script. So rather than trying to locate the specific `req = [...]`
    declaration (which broke as soon as a blueprint wrote `cols = [...]`, or
    checked its keys without any list literal at all), map every plausible column
    name in the script to itself. Over-supplying costs nothing — the script only
    ever looks up the keys it needs — while a missing key costs the entire run,
    because the preflight raises before a single scene is rendered.

    Only ever used for self-generated frames, where identity is by construction
    the correct mapping; an external file keeps failing honestly rather than
    being handed a mapping that points at headers it does not have.
    """

    found: Dict[str, str] = {}
    for token in re.findall(r"""["']([A-Za-z_][A-Za-z0-9_]{1,60})["']""", code or ""):
        lowered = token.lower()
        if lowered in _NON_COLUMN_LITERALS:
            continue
        # Column names are snake_case-ish identifiers; skip dotted/CamelCase API
        # names and single characters.
        if len(token) < 2 or token.startswith("_"):
            continue
        if token != lowered and "_" not in token:
            continue
        found.setdefault(token, token)
    return found


# Blueprints that ship their source as a compressed base64 payload.
#
# WHAT THIS COSTS (cycle-g-v74, followup-runner-58/60/61). The analyst started
# emitting scripts whose entire body is one blob:
#
#     exec(compile(gzip.decompress(base64.b64decode("H4sICIXPcW...")), ..., "exec"))
#
# Every heuristic below reads the script SOURCE, so all of them went blind at
# once. `_declared_required_mapping_keys` found no keys, and the permissive
# superset found exactly one quoted identifier in the whole file — the "exec"
# mode argument of `compile` — and produced `column_mapping={"exec": "exec"}`.
# Non-empty, so it looked like a successful backfill; the preflight then demanded
# 22 real semantic keys and the run died before rendering anything, which is the
# same self-block the relaxation was written to end.
#
# Reading through the wrapper is not another guess about authoring style: the
# recovered text IS the script, so every scan below sees what it was always meant
# to see. Deliberately format-agnostic (gzip/zlib/bz2/lzma, any base64 payload)
# and bounded, and it only ever feeds the scanners — nothing is executed here.
_EMBEDDED_BLOB_RE = re.compile(r"""["']([A-Za-z0-9+/=\s]{256,})["']""")
_MAX_INFLATED_BYTES = 4_000_000


def _inflate_embedded_code(code: str) -> str:
    """Recover blueprint source shipped as a compressed base64 payload."""

    if not code:
        return ""
    recovered: List[str] = []
    budget = _MAX_INFLATED_BYTES
    for match in _EMBEDDED_BLOB_RE.finditer(code):
        blob = "".join(match.group(1).split())
        try:
            raw = base64.b64decode(blob, validate=True)
        except Exception:
            continue
        for decompress in (gzip.decompress, zlib.decompress, bz2.decompress, lzma.decompress):
            try:
                text = decompress(raw).decode("utf-8", "ignore")
            except Exception:
                continue
            if text:
                chunk = text[:budget]
                recovered.append(chunk)
                budget -= len(chunk)
            break
        if budget <= 0:
            break
    return "\n".join(recovered)


def _scannable_code(code: str) -> str:
    """The blueprint source as the scanners need to see it: unwrapped."""

    inflated = _inflate_embedded_code(code)
    return f"{code or ''}\n{inflated}" if inflated else (code or "")


# Semantic variables the CHECK itself declares, independent of the script.
#
# The analyst names its variables in structured check fields (adjustment_set,
# exposures, outcome, fixed_effects) — these are declarations about its own
# analysis, not anything inferred from source, so they survive a script this
# driver cannot read at all: embedded, minified, compiled, or fetched at runtime.
# On runner-60 they covered 9 of the 22 keys the preflight required; a partial
# recovery is worth having as a floor when scanning cannot contribute.
_CHECK_VARIABLE_FIELDS = (
    "adjustment_set",
    "exposures",
    "outcome",
    "outcomes",
    "fixed_effects",
    "covariates",
    "controls",
    "emitted_columns",
)


def _check_declared_semantic_columns(raw_spec: Dict[str, Any]) -> List[str]:
    """Column names the handoff check declares as its own analysis variables."""

    names: List[str] = []
    for field_name in _CHECK_VARIABLE_FIELDS:
        value = (raw_spec or {}).get(field_name)
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, (list, tuple)):
            continue
        for item in value:
            if not isinstance(item, str):
                continue
            token = item.strip()
            if not token or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,60}", token):
                continue
            if token not in names:
                names.append(token)
    return names


def _identity_column_mapping_for_self_generated(raw_spec: Dict[str, Any], code: str) -> Dict[str, str]:
    """Identity ``column_mapping`` for a blueprint that generates its own columns.

    THE FAILURE THIS FIXES. LLM-authored render blueprints habitually open with a
    defensive preflight —

        m = spec.get("column_mapping")
        if not isinstance(m, dict) or not m:
            raise ValueError("handoff check requires a non-empty column_mapping")
        req = ["scene_id", "seed", "estimate", ...]

    — and then go on to RENDER the scenes and write those very columns themselves.
    For a ``procedural://`` dataset nobody ever supplies that mapping, so the
    script dies before ``mi.render`` runs and the lane produces zero numbers.
    Measured: 17 of 28 runner failures in v68 and 4 of 5 in v69, across different
    cycles and different blueprints — an authoring-guidance rule (ac25ccb) did not
    stop it, because the model writes the guard reflexively.

    Since the blueprint names the columns it will emit, the only mapping that can
    be correct is the identity one, so synthesize it from the keys the script
    itself declares. Applies ONLY when the blueprint generates its own data and
    the handoff supplied no mapping: a real external-CSV check keeps failing
    honestly, exactly as before.
    """

    if raw_spec.get("column_mapping"):
        return {}
    # PRIMARY: the analyst's own declaration of what its blueprint emits. This is
    # a judgment it made about its own analysis, not something inferred here.
    declared = _analyst_declared_emitted_columns(raw_spec)
    if declared:
        return {name: name for name in declared}
    # LAST-DITCH: no declaration reached us. Only recover when the run is
    # unambiguously self-generated, and only from keys the script names itself.
    # Deliberately not a general inference engine — pattern-guessing here already
    # failed twice (a `procedural_*.csv` dataset name and a `cols = [...]`
    # declaration both slipped past it), which is why the decision now belongs to
    # the analyst above.
    # Read through a compressed-payload wrapper first, or every scan below sees
    # only the base64 blob — see _inflate_embedded_code.
    scannable = _scannable_code(code)
    if not _self_generated_dataset(raw_spec, scannable):
        return {}
    mapping = {key: key for key in _declared_required_mapping_keys(scannable)}
    # Union with the permissive superset so an unrecognised declaration style
    # cannot starve the preflight. Identity either way, so the three agree.
    mapping.update(_permissive_identity_mapping(scannable))
    # ...and with the check's own declared variables, which need no source at all
    # and so still contribute when the script is unreadable by any means.
    mapping.update({name: name for name in _check_declared_semantic_columns(raw_spec)})
    return mapping


