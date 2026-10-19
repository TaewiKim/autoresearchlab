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

from .constants import DRIVER_WALL_CLOCK_BUDGET_SECONDS
from .io_utils import _coerce_list, _coerce_str
from .column_mapping import _identity_column_mapping_for_self_generated


# Blueprint extraction & normalization


@dataclass
class Blueprint:
    blueprint_id: str
    check_id: str
    code: str
    entrypoint: Optional[str]
    dataset: Optional[str]
    outcome: Optional[str]
    exposures: List[str] = field(default_factory=list)
    language: str = "python"
    raw: Dict[str, Any] = field(default_factory=dict)
    # Phase 1.4 of docs/data-fetcher-2026-04-28.md — analysts can
    # declare extra Python packages they need. Filtered + installed in
    # _maybe_install_blueprint_packages with PyPI-only constraint, name
    # allow-pattern, and a hard cap.
    pip_install_packages: List[str] = field(default_factory=list)
    # How long the analyst expects its own sweep to need. Nothing else can know:
    # a 2-scene x 5-seed sweep at 24 spp finished in 31s on cycle-g-v74, while the
    # visibility-hazard prospective design on the same cycle needed more than the
    # 240s it was given and died at the wall twice. See _allocate_blueprint_timeout.
    requested_timeout_seconds: Optional[int] = None


# Hard limits on what blueprint-driven pip installs may do. These let the
# analyst self-provision the tools a hypothesis needs (e.g. a renderer like
# mitsuba, imageio, scikit-image) without a human pre-installing them, while the
# dual-use guard in _filter_pip_install_request (PyPI names only, no URLs / git
# refs / index overrides) keeps it from turning into arbitrary code execution.
# Timeout is generous enough for heavier wheels (renderers, ML libs); the cap

def _column_mapping_dict(value: Any) -> Any:
    """A handoff check's ``column_mapping`` as the ``{key: column}`` dict scripts read.

    MEASURED ON cycle-b-20260918, 2026-09-19: the analyst schema had no
    ``column_mapping`` at all, so followup-runner-70..76 died on "handoff check
    requires a non-empty column_mapping". The schema now carries it as a list of
    ``{"key", "column"}`` pairs; a dict (side specs, older handoffs) passes
    through unchanged, and an empty list becomes ``{}`` so the backfills below
    still treat it as missing.
    """
    if not isinstance(value, list):
        return value
    mapping: Dict[str, str] = {}
    for pair in value:
        if not isinstance(pair, dict):
            continue
        key = _coerce_str(pair.get("key"))
        column = _coerce_str(pair.get("column"))
        if key and column:
            mapping[key] = column
    return mapping


def _recovered_check_from_state_specs(check_id: str) -> Dict[str, Any]:
    """Recover an analyst-authored side check-spec for ``check_id``.

    Analysts frequently write rich check-level metadata (``column_mapping``,
    ``identification_strategy`` with ``materialized_dataset.mode='procedural'``,
    etc.) ONLY into a side ``*-check-spec.json`` artifact under
    ``.research-lab/state`` while leaving those keys empty/absent in the handoff
    JSON. But the handoff-derived ``blueprint.raw`` is the ONLY thing delivered
    to the blueprint (via ``RESEARCHLAB_CHECK_SPEC``), so every field that lives
    only in the side spec is invisible at runtime — the blueprint then fails
    ("handoff check must include a non-empty column_mapping", or "dataset CSV
    not found; set materialized_dataset.mode='procedural'"). Return the newest
    matching side-spec CHECK dict so the caller can backfill the missing fields.
    This is pure plumbing of the analyst's OWN data — nothing is invented; if no
    matching spec exists the blueprint still fails honestly.

    Matches the exact ``check_id`` first, then the same lineage (``check_id``
    with a trailing ``_vNN`` stripped), because analysts bump the version each
    iteration but do not always re-emit a side spec for every version.
    """
    if not check_id:
        return {}
    try:
        # NOTE: the split driver is assembled via exec() into python_stats.py's
        # globals, so ``__file__`` here is python_stats.py, NOT this part file.
        # Never index a fixed parents[N]; walk upward until the repo root that
        # actually contains .research-lab/state is found.
        state_dir = None
        for parent in Path(__file__).resolve().parents:
            cand = parent / ".research-lab" / "state"
            if cand.is_dir():
                state_dir = cand
                break
        if state_dir is None:
            return {}
        candidates = sorted(
            state_dir.glob("*check-spec*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
    except Exception:
        return {}
    # Analysts bump the check_id version each iteration (…_v85 → …_v90) but
    # keep the same column lineage, and they do not always re-emit a side spec
    # for every version. Match exactly first; then fall back to the newest spec
    # from the SAME lineage (check_id with the trailing _vNN stripped). Still
    # analyst-authored data; if a required key is missing for the newer
    # blueprint, it raises a precise "missing required key(s)" error instead of
    # the blanket "non-empty column_mapping" failure.
    base_id = re.sub(r"_v\d+$", "", check_id)

    def _informative(check: Dict[str, Any]) -> bool:
        # A side spec is worth backfilling from only if it carries at least one
        # of the fields analysts routinely omit from the handoff.
        mapping = check.get("column_mapping")
        if isinstance(mapping, dict) and mapping:
            return True
        if check.get("identification_strategy"):
            return True
        return False

    def _scan(match_exact: bool) -> Dict[str, Any]:
        for spec_path in candidates[:40]:
            try:
                spec = json.loads(spec_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(spec, dict):
                continue
            checks = spec.get("handoff_checks")
            if not isinstance(checks, list):
                checks = [spec]
            for check in checks:
                if not isinstance(check, dict):
                    continue
                cid = _coerce_str(check.get("check_id"))
                if match_exact:
                    if cid != check_id:
                        continue
                else:
                    if not cid or re.sub(r"_v\d+$", "", cid) != base_id:
                        continue
                if _informative(check):
                    return dict(check)
        return {}

    return _scan(True) or _scan(False)


def _collect_blueprints(handoff: Dict[str, Any]) -> List[Blueprint]:
    items = handoff.get("validation_code_blueprints")
    blueprints: List[Blueprint] = []
    if not isinstance(items, list):
        return blueprints
    checks_by_id: Dict[str, Dict[str, Any]] = {}
    for check in _coerce_list(handoff.get("handoff_checks")):
        if not isinstance(check, dict):
            continue
        check_id = _coerce_str(check.get("check_id"))
        if check_id:
            checks_by_id[check_id] = check
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        code = item.get("code")
        if not isinstance(code, str) or not code.strip():
            # Blueprint exists only as a spec without executable code — keep
            # the metadata for reporting but do not execute it.
            code = ""
        check_id = _coerce_str(item.get("check_id")) or f"check_{idx + 1:02d}"
        blueprint_id = (
            _coerce_str(item.get("blueprint_id"))
            or f"blueprint:{check_id}"
        )
        pip_install = item.get("pip_install_packages")
        if pip_install is None:
            # Analyst handoffs historically used ``dependencies`` as the
            # blueprint-level contract. Treat that as an install request too
            # (still filtered by _filter_pip_install_request) so executable
            # in-cycle validation does not fail merely because the handoff used
            # the older field name.
            pip_install = item.get("dependencies")
        pip_install_list: List[str] = []
        if isinstance(pip_install, list):
            pip_install_list = [
                x for x in (_coerce_str(p) for p in pip_install) if x
            ]
        elif isinstance(pip_install, str):
            pip_install_list = [pip_install.strip()]
        raw_spec = dict(checks_by_id.get(check_id, {}))
        raw_spec.update(item)
        # The analyst's response schema carries the mapping as [{key, column}]
        # pairs (a strict schema cannot hold free keys); scripts read a dict.
        if "column_mapping" in raw_spec:
            raw_spec["column_mapping"] = _column_mapping_dict(raw_spec["column_mapping"])
        # Backfill check-level metadata the analyst wrote ONLY into a side
        # check-spec (column_mapping, identification_strategy, ...). Only fill
        # keys the handoff/blueprint left missing or empty — never overwrite a
        # field the handoff actually provided (e.g. the blueprint's own code).
        recovered = _recovered_check_from_state_specs(check_id)
        if recovered:
            for key, value in recovered.items():
                if key in ("code", "blueprint_id"):
                    continue
                if raw_spec.get(key) in (None, {}, [], ""):
                    raw_spec[key] = value
        # LAST RESORT, after every analyst-authored source has had its chance: a
        # blueprint that generates its own columns but self-blocks on a missing
        # column_mapping gets the identity mapping built from the keys it declares.
        # Never overwrites a mapping the analyst actually supplied.
        identity_mapping = _identity_column_mapping_for_self_generated(raw_spec, code)
        if identity_mapping:
            raw_spec["column_mapping"] = identity_mapping
            raw_spec["column_mapping_source"] = "driver_identity_backfill_self_generated"
        blueprints.append(
            Blueprint(
                blueprint_id=blueprint_id,
                check_id=check_id,
                code=code,
                entrypoint=item.get("entrypoint") if isinstance(item.get("entrypoint"), str) else None,
                dataset=item.get("dataset") if isinstance(item.get("dataset"), str) else None,
                outcome=item.get("outcome") if isinstance(item.get("outcome"), str) else None,
                exposures=[
                    x for x in _coerce_list(item.get("exposures")) if isinstance(x, str)
                ],
                language=_coerce_str(item.get("language")) or "python",
                raw=raw_spec,
                pip_install_packages=pip_install_list,
                requested_timeout_seconds=_requested_timeout_seconds(item, raw_spec),
            )
        )
    return blueprints


# The analyst's own estimate of how long its sweep needs.
#
# Read from whichever field it used; the point is that the estimate is a judgment
# about the experiment it just designed, and no fixed default can stand in for it.
# Bounded here only against absurd values — the real bound is the driver's
# aggregate wall clock, applied at allocation time.
_TIMEOUT_DECLARATION_FIELDS = (
    "timeout_seconds",
    "execution_timeout_seconds",
    "expected_runtime_seconds",
    "estimated_runtime_seconds",
    "budget_seconds",
)


def _requested_timeout_seconds(*specs: Any) -> Optional[int]:
    """Runtime the analyst asked for, if it said."""

    for spec in specs:
        if not isinstance(spec, dict):
            continue
        for field_name in _TIMEOUT_DECLARATION_FIELDS:
            try:
                value = int(float(spec.get(field_name)))
            except (TypeError, ValueError):
                continue
            if value > 0:
                return min(value, DRIVER_WALL_CLOCK_BUDGET_SECONDS)
    return None


