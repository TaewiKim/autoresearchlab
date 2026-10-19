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


from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


DRIVER_NAME = "python-stats-driver"  # intentionally unchanged — engine.rs
# filters lanes by ``result.driver`` string containing "python-stats".

BLUEPRINT_TIMEOUT_SECONDS_DEFAULT = 240  # individual blueprint script
DRIVER_WALL_CLOCK_BUDGET_SECONDS = 1500  # aggregate cap across all blueprints


# ---------------------------------------------------------------------------
# IO helpers

