#!/usr/bin/env python3
"""Entry point for the literature/data-search driver.

The implementation lives in the ``search_lib`` package, one module per
responsibility (see its ``__init__`` for the map). This file only resolves the
package and re-exports its symbols.

It used to ``exec`` twelve ``search_parts/part_NN_*.py`` files into this module's
globals. Those parts were cut on line count, which left five of them over a
thousand lines and produced boundaries that meant nothing -- ``part_09`` was
named after ``_looks_like_wide_expression_csv`` and held four unrelated blueprint
builders. Because every part landed in one shared namespace, the split could also
hide two import cycles and a function that was defined twice.

The star re-export is deliberate: the harness and the tests load this file by
path and reach for internals on it, so the module surface has to stay what it was.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Loaded by file path (importlib.util.spec_from_file_location) by the harness,
# so this directory is not on sys.path yet.
_DRIVER_DIR = Path(__file__).resolve().parent
if str(_DRIVER_DIR) not in sys.path:
    sys.path.insert(0, str(_DRIVER_DIR))

from search_lib import *  # noqa: E402,F401,F403
from search_lib import entrypoint as _entrypoint  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(_entrypoint.main())
