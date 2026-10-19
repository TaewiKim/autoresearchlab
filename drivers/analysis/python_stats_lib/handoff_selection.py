from __future__ import annotations

import argparse
import base64
import hashlib
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

from .io_utils import _coerce_list, _coerce_str, _read_json


def _find_analyst_handoff(role_plan: Any) -> Dict[str, Any]:
    if not isinstance(role_plan, dict):
        return {}
    containers = [
        role_plan,
        role_plan.get("planner_metadata"),
        role_plan.get("metadata"),
    ]
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in (
            "cycle_analyst_handoff",
            "analyst_handoff",
            "handoff_validation_plan",
        ):
            candidate = container.get(key)
            if isinstance(candidate, dict) and candidate:
                return candidate
    # Some plans stash the handoff under runner-specific wrappers.
    runner = role_plan.get("lab_runner") or role_plan.get("runner")
    if isinstance(runner, dict):
        nested = runner.get("analyst_handoff") or runner.get("cycle_analyst_handoff")
        if isinstance(nested, dict) and nested:
            return nested
    return {}


def _find_latest_handoff_from_cycle(role_plan: Any, role_plan_file: Optional[Path]) -> Dict[str, Any]:
    """Best-effort fallback for stale runner role plans.

    Initial lab-runner role plans are written before analyst lanes finish, so
    they may not contain planner_metadata.analyst_handoff. When the dependency
    gate has allowed a runner to start, the authoritative handoff should already
    be on disk; find the newest analyst handoff in lanes/ or artifacts/stats/.
    """

    if role_plan_file is None:
        return {}
    cycle_id = _coerce_str((role_plan or {}).get("cycle_id"))
    try:
        runtime_root = role_plan_file.resolve().parents[3]
    except IndexError:
        return {}
    if not cycle_id and role_plan_file.parent.parent.name:
        cycle_id = role_plan_file.parent.parent.name
    if not cycle_id:
        return {}

    candidates: List[Path] = []
    lanes_dir = runtime_root / "lanes" / cycle_id
    if lanes_dir.is_dir():
        candidates.extend(lanes_dir.glob("*analyst*/handoff-validation-plan.json"))
    artifacts_dir = runtime_root / "artifacts" / "stats" / cycle_id
    if artifacts_dir.is_dir():
        candidates.extend(artifacts_dir.glob("*analyst*/handoff-validation-plan.json"))
    dated: List[Tuple[float, Path]] = []
    for candidate in candidates:
        try:
            dated.append((candidate.stat().st_mtime, candidate))
        except OSError:
            continue
    # Newest first, passing over any the harness refused to seal: those went
    # back to the analyst and are not for a runner.
    for mtime, path in sorted(dated, key=lambda item: item[0], reverse=True):
        handoff = _read_json(path)
        if not isinstance(handoff, dict) or _seal_rejected(handoff):
            continue
        handoff = dict(handoff)
        handoff["_source_path"] = str(path)
        handoff["_source_mtime"] = mtime
        return handoff
    return {}


def _seal_rejected(handoff: Any) -> bool:
    """True for a handoff the harness refused to seal (runtime/handoff_seal.rs)."""
    if not isinstance(handoff, dict):
        return False
    seal = handoff.get("handoff_seal")
    return isinstance(seal, dict) and seal.get("status") == "rejected"


def _handoff_blueprint_count(handoff: Any) -> int:
    if not isinstance(handoff, dict):
        return 0
    return len(_coerce_list(handoff.get("validation_code_blueprints")))


def _handoff_check_count(handoff: Any) -> int:
    if not isinstance(handoff, dict):
        return 0
    return len(_coerce_list(handoff.get("handoff_checks")))


def _same_handoff_target(left: Any, right: Any) -> bool:
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    left_id = _coerce_str(left.get("primary_hypothesis_id"))
    right_id = _coerce_str(right.get("primary_hypothesis_id"))
    if left_id and right_id and left_id != right_id:
        return False
    left_root = _coerce_str(left.get("dataset_root"))
    right_root = _coerce_str(right.get("dataset_root"))
    if left_root and right_root and Path(left_root) != Path(right_root):
        return False
    # MEASURED ON cycle-a-20260919, 2026-09-30: 27 runners assigned
    # RECOVERY_MECHANISM_MAXT_01 silently executed two support-removal checks
    # instead because both handoffs shared a hypothesis id and no dataset_root.
    # Disjoint check ids are different execution contracts, not revisions.
    def check_ids(handoff: Dict[str, Any]) -> set[str]:
        declared = [
            *_coerce_list(handoff.get("handoff_checks")),
            *_coerce_list(handoff.get("validation_code_blueprints")),
        ]
        return {
            _coerce_str(item.get("check_id"))
            for item in declared
            if isinstance(item, dict) and _coerce_str(item.get("check_id"))
        }

    left_checks = check_ids(left)
    right_checks = check_ids(right)
    if left_checks and right_checks and left_checks.isdisjoint(right_checks):
        return False
    return True


def _select_analyst_handoff(
    embedded: Dict[str, Any],
    latest: Dict[str, Any],
    role_plan_file: Optional[Path],
) -> Dict[str, Any]:
    """Prefer the newest richer analyst handoff when a runner was planned
    before analyst outputs were regenerated.

    Runner role plans can embed a stale handoff. If a later analyst lane emits
    a handoff for the same hypothesis/dataset with more executable checks or
    blueprints, the executor should use that authoritative on-disk handoff
    rather than replaying the stale embedded copy.
    """

    if _seal_rejected(embedded):
        embedded = {}
    if not embedded:
        return latest or {}
    if not latest:
        return embedded
    if not _same_handoff_target(embedded, latest):
        return embedded

    latest_blueprints = _handoff_blueprint_count(latest)
    embedded_blueprints = _handoff_blueprint_count(embedded)
    latest_checks = _handoff_check_count(latest)
    embedded_checks = _handoff_check_count(embedded)
    latest_mtime = latest.get("_source_mtime")
    role_plan_mtime = None
    if role_plan_file is not None and role_plan_file.is_file():
        try:
            role_plan_mtime = role_plan_file.stat().st_mtime
        except OSError:
            role_plan_mtime = None

    if latest_blueprints > embedded_blueprints or latest_checks > embedded_checks:
        return latest
    if (
        isinstance(latest_mtime, (int, float))
        and isinstance(role_plan_mtime, (int, float))
        and latest_mtime > role_plan_mtime
        and latest_blueprints >= embedded_blueprints
        and latest_checks >= embedded_checks
    ):
        return latest
    return embedded


def _dataset_root_from_plan(role_plan: Any, csv_root: Path) -> Path:
    if isinstance(role_plan, dict):
        for key in ("dataset_root", "csv_root", "data_root"):
            value = role_plan.get(key)
            if isinstance(value, str) and value.strip():
                candidate = Path(value)
                if candidate.exists():
                    return candidate
        data_bundle = role_plan.get("data_bundle")
        if isinstance(data_bundle, dict):
            value = data_bundle.get("dataset_root")
            if isinstance(value, str) and Path(value).exists():
                return Path(value)
    return csv_root


_DATASET_WALK_SKIP = {
    ".git", "node_modules", "target", "artifacts", "chronicle", "lanes",
    "reports", "papers", "viz", "runtime", "indexes", "__pycache__",
}
_PINNED_SHA256 = re.compile(r"(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])")


def _cycle_datasets_root(csv_root: Path) -> Optional[Path]:
    """``<runtime>/datasets/<cycle_id>`` above the bundle the harness picked."""
    try:
        resolved = csv_root.resolve()
    except OSError:
        return None
    for candidate in (resolved, *resolved.parents):
        if candidate.parent.name == "datasets":
            return candidate
    return None


def _dataset_directories(root: Path, max_depth: int = 6) -> List[Path]:
    """Directories a dataset reference may be relative to.

    A directory holding a CSV is a bundle, and what is inside it belongs to the
    bundle: an engineer's set-aside attempt (``attempt47_schema_mismatch/`` on
    cycle-a-20260919) is not a dataset of its own. The harness's own
    bundle walk stops at the same place.
    """
    found: List[Path] = []
    stack: List[Tuple[Path, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        found.append(current)
        if depth >= max_depth:
            continue
        try:
            children = sorted(current.iterdir())
        except OSError:
            continue
        if current != root and any(child.is_file() and child.suffix.lower() == ".csv" for child in children):
            continue
        for child in children:
            if child.is_dir() and not child.name.startswith(".") and child.name not in _DATASET_WALK_SKIP:
                stack.append((child, depth + 1))
    return found


def _file_sha256(path: Path) -> Optional[str]:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _dataset_root_from_blueprint_references(handoff: Any, csv_root: Path) -> Optional[Path]:
    """The directory the handoff's own dataset references resolve against.

    Consulted only when the handoff names no dataset_root. The harness then
    passes the cycle bundle with the most CSVs, which need not be the one the
    analyst meant, and a blueprint that resolves its CSV as
    ``csv_root / dataset`` -- falling back to the bare file name -- reads a
    different experiment's file.

    MEASURED ON cycle-a-20260919, 2026-09-29: analyst-208's handoff
    checked ``support_topology_randomized_intervention_v1/episodes.csv``; its
    runner was given ``replanning_recovery_support_factorial_v1`` as csv_root,
    read THAT bundle's episodes.csv and stopped on the SHA-256 the handoff
    pinned. Four runners of analyst-201's handoff, which checked a bare
    ``episodes.csv``, died looking for another bundle's manifest. analyst-212
    wrote the same topology path absolute and its runner ran clean; the two
    newest handoffs, analyst-215 and -216, use the relative form again.

    A relative reference is resolved against every directory of the cycle's
    datasets: exactly one file wins. When several match, a SHA-256 pinned
    anywhere in the handoff picks the one whose content matches it. Anything
    still ambiguous returns None and the previous choice stands.
    """
    if not isinstance(handoff, dict):
        return None
    references: List[str] = []
    declared = [
        *_coerce_list(handoff.get("handoff_checks")),
        *_coerce_list(handoff.get("validation_code_blueprints")),
    ]
    for item in declared:
        if not isinstance(item, dict):
            continue
        reference = _coerce_str(item.get("dataset")).strip()
        if not reference or Path(reference).is_absolute() or ".." in Path(reference).parts:
            continue
        if reference not in references:
            references.append(reference)
    if not references:
        return None
    cycle_root = _cycle_datasets_root(csv_root)
    if cycle_root is None or not cycle_root.is_dir():
        return None
    directories = _dataset_directories(cycle_root)
    pinned = set(_PINNED_SHA256.findall(json.dumps(handoff, sort_keys=True, default=str)))
    # The root handed back is the bundle that holds the file, the shape every
    # csv_root has had: a blueprint that joins csv_root with the reference, or
    # with its bare name, or reads the manifest beside it, finds the same file.
    for reference in references:
        matches = [directory / reference for directory in directories if (directory / reference).is_file()]
        if len(matches) > 1 and pinned:
            matches = [path for path in matches if _file_sha256(path) in pinned]
        if len(matches) == 1:
            return matches[0].parent
    return None


def _resolve_dataset_root(handoff: Any, role_plan: Any, csv_root: Path) -> Tuple[Path, str]:
    """(dataset root, where it came from). Named roots win over inference."""
    from_handoff = _dataset_root_from_handoff(handoff)
    if from_handoff is not None:
        return from_handoff, "handoff_dataset_root"
    from_plan = _dataset_root_from_plan(role_plan, csv_root)
    if from_plan != csv_root:
        return from_plan, "role_plan_dataset_root"
    referenced = _dataset_root_from_blueprint_references(handoff, csv_root)
    if referenced is not None:
        return referenced, "handoff_blueprint_reference"
    return csv_root, "harness_csv_root"


def _dataset_root_from_handoff(handoff: Any) -> Optional[Path]:
    if isinstance(handoff, dict):
        value = handoff.get("dataset_root") or handoff.get("csv_root") or handoff.get("data_root")
        if isinstance(value, str) and value.strip() and Path(value).exists():
            return Path(value)
    return None


# ---------------------------------------------------------------------------
