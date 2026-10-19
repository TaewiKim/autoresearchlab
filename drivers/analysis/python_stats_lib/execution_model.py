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

from .blueprint_model import Blueprint


# ---------------------------------------------------------------------------
# Blueprint execution


@dataclass
class BlueprintExecution:
    blueprint_id: str
    check_id: str
    status: str  # "completed" | "failed" | "skipped" | "timeout"
    script_path: Optional[str]
    output_dir: str
    stdout_path: str
    stderr_path: str
    timeout_seconds: int
    duration_seconds: float
    return_code: Optional[int]
    metrics: Dict[str, Any]
    figures: List[Dict[str, Any]]
    tables: List[Dict[str, Any]]
    error: Optional[str]
    derived_indicator_specs: List[Dict[str, Any]] = field(default_factory=list)
    derived_indicator_outcomes: List[Dict[str, Any]] = field(default_factory=list)
    pip_install: Optional[Dict[str, Any]] = None


@dataclass
class ExternalAgentExecution:
    agent_name: str
    stage: str
    status: str  # "completed" | "failed" | "skipped" | "timeout"
    command: Optional[str]
    cwd: str
    stdout_path: str
    stderr_path: str
    duration_seconds: float
    return_code: Optional[int]
    error: Optional[str]
    output_dir: str


_FIGURE_SUFFIXES = {".png", ".svg", ".jpg", ".jpeg", ".pdf", ".html"}
_TABLE_SUFFIXES = {".csv", ".tsv", ".parquet", ".json"}


_DRIVER_SIDECARS = {
    "check.json",
    "script.py",
    "driver-execution-receipt.json",
    "stdout.log",
    "stderr.log",
    "stdout.json",
    "derived-indicators.json",
    "stderr.txt",
    "stderr.json",
}


def _classify_artifact(path: Path) -> Optional[str]:
    # Driver-produced sidecars (the blueprint's own source file, the stored
    # check spec, and the stdout/stderr logs) must never be reported as
    # blueprint outputs.
    if path.name in _DRIVER_SIDECARS:
        return None
    suffix = path.suffix.lower()
    if suffix in _FIGURE_SUFFIXES:
        return "figure"
    if suffix in _TABLE_SUFFIXES:
        return "table"
    return None


def _scan_blueprint_artifacts(
    blueprint: Blueprint,
    output_dir: Path,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    figures: List[Dict[str, Any]] = []
    tables: List[Dict[str, Any]] = []
    if not output_dir.is_dir():
        return figures, tables
    for entry in sorted(output_dir.iterdir()):
        if not entry.is_file():
            continue
        kind = _classify_artifact(entry)
        if kind is None:
            continue
        record = {
            "blueprint_id": blueprint.blueprint_id,
            "check_id": blueprint.check_id,
            "path": str(entry),
            "name": entry.name,
            "kind": kind,
            "suffix": entry.suffix.lower(),
            "size_bytes": entry.stat().st_size,
        }
        if kind == "figure":
            figures.append(record)
        else:
            tables.append(record)
    return figures, tables


def _extract_metrics_from_stdout(stdout_text: str) -> Dict[str, Any]:
    """Parse the last JSON object emitted on stdout, if any.

    Convention: a blueprint that wants to report structured metrics prints a
    single JSON object on its final line (or as a contiguous block). We walk
    the stdout from the end looking for a parseable object. This keeps the
    contract loose — blueprints can still write arbitrary log text before the
    final JSON.
    """

    if not stdout_text.strip():
        return {}
    # Fast path: final non-empty line.
    lines = [ln.strip() for ln in stdout_text.splitlines() if ln.strip()]
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    # Slow path: scan for final balanced JSON object.
    start = stdout_text.rfind("{")
    while start != -1:
        depth = 0
        for idx in range(start, len(stdout_text)):
            ch = stdout_text[idx]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    candidate = stdout_text[start : idx + 1]
                    try:
                        parsed = json.loads(candidate)
                        if isinstance(parsed, dict):
                            return parsed
                    except Exception:
                        pass
                    break
        start = stdout_text.rfind("{", 0, start)
    return {}


# ---------------------------------------------------------------------------
# Open-source analysis agent execution


