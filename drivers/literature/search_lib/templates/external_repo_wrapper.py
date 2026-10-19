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


def _external_repo_agent_wrapper_code() -> str:
    """Source of the generated program, held in data/external_repo_agent_wrapper.py."""

    return (_DATA_DIR / "external_repo_agent_wrapper.py").read_text(encoding="utf-8")
