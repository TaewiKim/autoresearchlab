"""A ledger for the places where we accept a shape we did not ask for.

Every tolerance in this tree was added for a good reason and then became
invisible. `unwrap_review_bundle` is the example: a reviewer wrote the whole
template object as the file, nesting three real reviews one level too deep where
nothing read them, and the fix was to accept both shapes -- because the reviews
were real and refusing them would have been defensible and useless.

The danger is what happens next. An unrecorded tolerance quietly becomes the
contract: everybody writes the wrong shape, the coercion fires on every run
forever, and the wording that caused it is never fixed because nothing ever
reported that it was still wrong. The opposite failure is just as real -- a
tolerance for a mistake nobody has made in a year, kept because nobody could
tell.

So a tolerance records two things: that it exists, and whether it fired. Then

  * fired often  -> the instruction is still wrong; fix the wording, not the reader
  * fired never  -> delete it, and the contract has genuinely converged

This is deliberately not an error path. Recording must never be able to break
the run it is observing, so every failure here is swallowed: a ledger that
refused to write would turn an observation into the outage it exists to prevent.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from .constants import CACHE_ROOT

LEDGER_PATH = CACHE_ROOT / "contract-tolerances.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def record(name: str, fired: bool, detail: str = "") -> None:
    """Note that a tolerance was consulted, and whether it had to do anything.

    `fired=False` is the important half. A tolerance that is never consulted
    leaves no evidence that it could be removed, so the counter advances on
    every pass and only `fired_count` distinguishes a live coercion from a
    contract that has settled.
    """
    if os.environ.get("RESEARCHLAB_CONTRACT_TOLERANCE_LEDGER") == "off":
        return
    try:
        ledger = {}
        if LEDGER_PATH.is_file():
            loaded = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("tolerances"), dict):
                ledger = loaded["tolerances"]
        entry = ledger.get(name) if isinstance(ledger.get(name), dict) else {}
        entry["name"] = name
        entry["seen_count"] = int(entry.get("seen_count") or 0) + 1
        entry["first_seen"] = entry.get("first_seen") or _now()
        entry["last_seen"] = _now()
        if fired:
            entry["fired_count"] = int(entry.get("fired_count") or 0) + 1
            entry["last_fired"] = _now()
            if detail:
                entry["last_detail"] = detail
        else:
            entry.setdefault("fired_count", 0)
        ledger[name] = entry
        LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(LEDGER_PATH.parent), delete=False, suffix=".tmp"
        )
        with handle as stream:
            json.dump({"updated_at": _now(), "tolerances": ledger}, stream, indent=2, sort_keys=True)
        os.replace(handle.name, LEDGER_PATH)
    except Exception:
        # An observation must never become the failure. See the module docstring.
        pass


def summary() -> dict:
    """What the ledger currently says, for a run that wants to report it.

    `stale` names the tolerances that have been consulted and have never once
    been needed -- the list of coercions that can now be deleted, which is the
    whole point of counting.
    """
    try:
        if not LEDGER_PATH.is_file():
            return {"tolerances": {}, "stale": []}
        loaded = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
        tolerances = loaded.get("tolerances") if isinstance(loaded, dict) else None
        if not isinstance(tolerances, dict):
            return {"tolerances": {}, "stale": []}
        stale = sorted(
            name
            for name, entry in tolerances.items()
            if isinstance(entry, dict)
            and int(entry.get("fired_count") or 0) == 0
            and int(entry.get("seen_count") or 0) >= int(
                os.environ.get("RESEARCHLAB_CONTRACT_TOLERANCE_STALE_AFTER") or 50
            )
        )
        return {"tolerances": tolerances, "stale": stale}
    except Exception:
        return {"tolerances": {}, "stale": []}
