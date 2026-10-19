#!/usr/bin/env python3
"""Compatibility wrapper for the split data_scout_browser.py driver.

The implementation is stored in data_scout_browser_parts/part_*.py files, split on
top-level Python statement boundaries so no source file exceeds 1000 lines.
"""
from __future__ import annotations

from pathlib import Path

_PARTS_DIR = Path(__file__).with_name('data_scout_browser_parts')
_PART_FILES = [
    'part_01_docstring.py',
    'part_02_search_datacite.py',
    'part_03_search_duckduckgo.py',
    'part_04_main.py'
]

for _part_file in _PART_FILES:
    _part_path = _PARTS_DIR / _part_file
    exec(compile(_part_path.read_text(encoding="utf-8"), str(_part_path), "exec"), globals())

del _PARTS_DIR, _PART_FILES, _part_file, _part_path
