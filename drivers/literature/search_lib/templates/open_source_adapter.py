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


_DATA_DIR = Path(__file__).resolve().parent / "data"


def _open_source_workflow_adapter_code() -> str:
    """Source of the generated program, held in data/open_source_workflow_adapter.py."""

    return (_DATA_DIR / "open_source_workflow_adapter.py").read_text(encoding="utf-8")
