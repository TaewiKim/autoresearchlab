#!/usr/bin/env python3
"""Entry point for the python-stats analysis driver.

The implementation lives in the ``python_stats_lib`` package, one module per
responsibility (see its ``__init__`` for the map). This file only resolves the
package and re-exports its symbols.

It used to ``exec`` a list of ``python_stats_parts/part_NN_*.py`` files into this
module's globals. Those parts were cut on line count rather than responsibility --
``part_01_docstring.py`` held IO helpers, handoff selection, pip installation,
column-mapping recovery, blueprint collection, the execution dataclasses and
external-agent discovery in 1360 lines named after its first docstring -- and
because every part landed in one shared namespace, nothing recorded which part
needed which symbol. There was no boundary anywhere to push back on growth.

The star re-export is deliberate: the harness and the tests both load this file
by path and reach for internals on it (``_measured_quantities``,
``BlueprintExecution``, ``_identity_column_mapping_for_self_generated``, ...), so
the module surface has to stay exactly what it was.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Loaded by file path (importlib.util.spec_from_file_location) by both the
# harness and the tests, so this directory is not on sys.path yet.
_DRIVER_DIR = Path(__file__).resolve().parent
if str(_DRIVER_DIR) not in sys.path:
    sys.path.insert(0, str(_DRIVER_DIR))

from python_stats_lib import *  # noqa: E402,F401,F403
from python_stats_lib import entrypoint as _entrypoint  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(_entrypoint.main())
