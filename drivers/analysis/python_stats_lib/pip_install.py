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
from .blueprint_model import Blueprint


# bounds blast radius per blueprint.
PIP_INSTALL_MAX_PACKAGES = 10
# Accepts a bare name or a single PEP 440 version constraint. ">=" and
# friends were previously impossible: they were caught by the forbidden-token
# guard below, so every "numpy>=1.26"-style pin was rejected and only "=="
# pins survived (v85 measured 5 of 6 requests dropped per blueprint).
# Safe because pip is spawned as an argv list, never through a shell, so
# "<"/">" carry no redirection meaning here.
PIP_INSTALL_NAME_PATTERN = re.compile(
    r"^[a-zA-Z][a-zA-Z0-9_\-\.]*((==|>=|<=|~=|!=|>|<)[\w\.\-\+]+)?$"
)
PIP_INSTALL_TIMEOUT_SECONDS = 600
PIP_IMPORT_NAME_OVERRIDES = {
    "beautifulsoup4": "bs4",
    "opencv-python": "cv2",
    "pillow": "PIL",
    "pyyaml": "yaml",
    "scikit-learn": "sklearn",
}


def _filter_pip_install_request(packages: List[str]) -> tuple[List[str], List[Dict[str, Any]]]:
    """Apply safety constraints to a blueprint's
    ``pip_install_packages`` list.

    Returns ``(allowed, rejected)``. ``allowed`` is at most
    ``PIP_INSTALL_MAX_PACKAGES`` entries that match the conservative
    name+pin regex. ``rejected`` records the offending input plus the
    reason for transparency on the result-side log.
    """
    allowed: List[str] = []
    rejected: List[Dict[str, Any]] = []
    for raw in packages or []:
        text = _coerce_str(raw)
        if not text:
            rejected.append({"input": raw, "reason": "empty_name"})
            continue
        # Reject anything that looks like a URL / git ref / index
        # override — this is the dual-use guard against the analyst
        # turning the install step into arbitrary code execution
        # against an untrusted source.
        # "<" / ">" are NOT listed: they are legal PEP 440 constraint operators
        # and cannot redirect anything, because pip is invoked as an argv list.
        # The tokens that remain are the actual dual-use risks -- a URL, a git
        # ref, an index override, or argument injection.
        for forbidden in ("git+", "://", " ", "--"):
            if forbidden in text:
                rejected.append({"input": text, "reason": f"forbidden_token:{forbidden!r}"})
                text = ""
                break
        if not text:
            continue
        if not PIP_INSTALL_NAME_PATTERN.fullmatch(text):
            rejected.append({"input": text, "reason": "name_regex_mismatch"})
            continue
        if len(allowed) >= PIP_INSTALL_MAX_PACKAGES:
            rejected.append({"input": text, "reason": "max_packages_cap_reached"})
            continue
        allowed.append(text)
    return allowed, rejected


# Every PEP 440 comparison, longest first so ">=" is not cut as ">".
_PIP_SPECIFIER_OPERATORS = ("===", "==", ">=", "<=", "~=", "!=", ">", "<")


def _requirement_name(requirement: str) -> str:
    """The bare distribution name, with any version constraint removed.

    Splitting on `==` alone was correct only while `==` was the sole operator the
    sanitizer let through. Once `>=` was allowed, `python>=3` survived intact and
    became an import name -- see _split_already_importable_packages.
    """
    text = _coerce_str(requirement).strip()
    for operator in _PIP_SPECIFIER_OPERATORS:
        if operator in text:
            text = text.split(operator, 1)[0]
            break
    return text.strip()


def _import_name_for_package(package: str) -> Optional[str]:
    name = _requirement_name(package).lower()
    if not name:
        return None
    return PIP_IMPORT_NAME_OVERRIDES.get(name) or name.replace("-", "_")


def _split_already_importable_packages(packages: List[str]) -> tuple[List[str], List[str]]:
    """Return ``(missing, already_importable)`` for unpinned package requests.

    Pinned requests still go through pip so version constraints are honoured.
    Unpinned requests such as ``pandas`` or ``numpy`` are common in generated
    blueprints, and reinstalling them for every lane dominates runtime.
    """
    missing: List[str] = []
    already_importable: List[str] = []
    for package in packages:
        # ANY constraint, not just `==`: a constrained request must go through
        # pip so the constraint is honoured, and must never be handed to
        # find_spec as if it were a module name.
        if any(operator in package for operator in _PIP_SPECIFIER_OPERATORS):
            missing.append(package)
            continue
        import_name = _import_name_for_package(package)
        if import_name and _module_is_importable(import_name):
            already_importable.append(package)
        else:
            missing.append(package)
    return missing, already_importable


def _module_is_importable(import_name: str) -> bool:
    """Is this module already present? A malformed name answers "no", not "boom".

    ``importlib.util.find_spec`` raises ModuleNotFoundError on a name it cannot
    even parse as a module path, and this is called before any blueprint runs, so
    the exception took the whole lane with it -- v85's followup-runner-43..47,
    five lanes with no result at all, from one blueprint asking for `python>=3`.
    A bad requirement is the blueprint's mistake to report, not the driver's to
    die of.
    """
    try:
        return importlib.util.find_spec(import_name) is not None
    except (ImportError, AttributeError, ValueError, TypeError):
        return False


def _ensure_pip_available(log_lines: List[str]) -> None:
    """Minimal/uv environments may omit pip; bootstrap it in this interpreter."""
    if _module_is_importable("pip"):
        return
    command = [sys.executable, "-m", "ensurepip", "--upgrade"]
    log_lines.append(f"$ {' '.join(command)}")
    completed = subprocess.run(
        command, capture_output=True, text=True,
        timeout=PIP_INSTALL_TIMEOUT_SECONDS,
    )
    log_lines.extend([completed.stdout or "", completed.stderr or ""])
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "non-zero exit").strip()
        raise RuntimeError(f"pip bootstrap failed (exit {completed.returncode}): {detail[-500:]}")
    importlib.invalidate_caches()


def _maybe_install_blueprint_packages(
    blueprint: Blueprint,
    blueprint_dir: Path,
) -> Dict[str, Any]:
    """Install any analyst-declared Python packages into the venv that
    is already running this driver. Returns a log entry that gets
    folded into the top-level ``result.json::pip_installs``.

    Failures degrade — a failing install does not block blueprint
    execution; the log entry just carries the error. The blueprint
    will then likely fail at ``import <pkg>`` time, which is a
    graceful, lane-local failure rather than a cycle abort.
    """
    requested = blueprint.pip_install_packages or []
    if not requested:
        return {}
    allowed, rejected = _filter_pip_install_request(requested)
    log_path = blueprint_dir / "pip-install.log"
    log_lines: List[str] = []
    install_status = "skipped"
    install_returncode: Optional[int] = None
    install_error: Optional[str] = None
    already_importable: List[str] = []
    if allowed:
        missing, already_importable = _split_already_importable_packages(allowed)
        if already_importable:
            log_lines.append("already importable: " + ", ".join(already_importable))
        if not missing:
            install_status = "already_satisfied"
        else:
            cmd = [sys.executable, "-m", "pip", "install", "--no-input", *missing]
            try:
                _ensure_pip_available(log_lines)
                completed = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=PIP_INSTALL_TIMEOUT_SECONDS,
                )
                install_returncode = completed.returncode
                install_status = "completed" if completed.returncode == 0 else "failed"
                log_lines.append(f"$ {' '.join(cmd)}")
                log_lines.append(completed.stdout or "")
                log_lines.append(completed.stderr or "")
                if install_status == "failed":
                    install_error = (completed.stderr or "").strip().splitlines()[-1] if completed.stderr else "non-zero exit"
            except subprocess.TimeoutExpired:
                install_status = "timeout"
                install_error = f"pip install timed out after {PIP_INSTALL_TIMEOUT_SECONDS}s"
                log_lines.append(install_error)
            except Exception as exc:  # pylint: disable=broad-except
                install_status = "errored"
                install_error = str(exc)[:200]
                log_lines.append(install_error)
    try:
        log_path.write_text("\n".join(log_lines), encoding="utf-8")
    except Exception:
        pass
    return {
        "blueprint_id": blueprint.blueprint_id,
        "requested": requested,
        "allowed": allowed,
        "already_importable": already_importable,
        "rejected": rejected,
        "install_status": install_status,
        "return_code": install_returncode,
        "error": install_error,
        "log_path": str(log_path) if log_lines else None,
    }

