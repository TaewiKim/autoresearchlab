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


def _read_json(path: Optional[Path]) -> Any:
    if path is None or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _sanitize_nonfinite(value: Any) -> Any:
    """Replace non-finite floats (NaN, +/-Infinity) with None throughout a payload.

    Python's json.dumps emits bare ``NaN``/``Infinity`` tokens by default, which are
    NOT valid JSON: the native Rust harness reads these driver artifacts with
    serde_json, which rejects them ("expected value ...") and aborts the whole
    run-plan pass. A degenerate metric (e.g. a correlation over a constant column)
    routinely produces NaN, so sanitize before writing rather than letting an
    unparseable artifact wedge the cycle.
    """
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _sanitize_nonfinite(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_nonfinite(child) for child in value]
    return value


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_sanitize_nonfinite(payload), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _read_text(path: Optional[Path]) -> str:
    if path is None or not path.is_file():
        return ""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_]+", "-", value or "").strip("-").lower()
    return slug or "untitled"


# ---------------------------------------------------------------------------
# Role-plan / handoff accessors
#
# We intentionally accept several shapes because the Rust harness, the
# labdirector, and upstream lanes have all evolved over time and the shape is
# not fully unified. The goal is: get whatever analyst handoff contract is
# present without caring about its container.


def _coerce_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    return []


def _coerce_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


