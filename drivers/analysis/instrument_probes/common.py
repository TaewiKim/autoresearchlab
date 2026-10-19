"""Inventory evidence helpers shared by domain-specific probes."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path


def new_inventory(backend):
    return {
        "inventory_version": 3,
        "backend": backend,
        "probe_config": {"backend": backend},
        "probed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "evidence_scope": "capability_measurement_not_hypothesis_validation",
        "instruments": [],
        "measurable_quantities": [],
        "notes": [],
    }


def probe(name, question, fn, inventory, capability=True):
    """Preserve failed measurements and measured absences as negative evidence."""
    entry = {
        "instrument": name, "question": question, "probe_ran": False,
        "capability_present": False, "available": False, "measured": None,
        "error": None,
    }
    started = time.monotonic()
    try:
        entry["measured"] = fn()
        entry["probe_ran"] = True
        present = capability(entry["measured"]) if callable(capability) else capability
        entry["available"] = entry["capability_present"] = bool(present)
    except Exception as exc:
        entry["error"] = f"{type(exc).__name__}: {exc}"[:600]
    entry["elapsed_s"] = round(time.monotonic() - started, 3)
    inventory["instruments"].append(entry)
    status = "OK" if entry["available"] else ("ABSENT" if entry["probe_ran"] else "FAILED")
    print(f"[probe] {status} {name}: {str(entry['error'] or entry['measured'])[:200]}", flush=True)
    return entry


def finalize(inventory, exit_code):
    entries = inventory["instruments"]
    inventory["verified_instruments"] = [e["instrument"] for e in entries if e.get("capability_present")]
    inventory["unavailable_instruments"] = [e["instrument"] for e in entries if not e.get("capability_present")]
    inventory["measured_absences"] = [
        {"instrument": e["instrument"], "probe_ran": e["probe_ran"],
         "measured": e.get("measured"), "error": e.get("error")}
        for e in entries if not e.get("capability_present")
    ]
    inventory["exit_code"] = exit_code
    inventory["status"] = "failed" if exit_code else ("measured" if inventory["verified_instruments"] else "empty")
    # Backend-independent, and stated here because a multi-backend inventory has
    # no single backend whose guidance should stand for the whole. Each backend's
    # own wording stays under `by_backend`.
    inventory.setdefault("director_guidance", {
        "rule": "Cite only quantities actually measured here; capability evidence is not hypothesis validation.",
        "on_absence": (
            "Keep negative evidence. If a question needs something in unavailable_instruments, do NOT "
            "retire the question: restate it over an observable that IS verified, or ask one runner lane "
            "to build the missing instrument and re-probe. cycle-g-v82 retired 100 problems in a row for "
            "want of this sentence and produced zero gate rounds in 5.5 hours."
        ),
        "do_not_assume": "An unprobed backend and an absent capability are different things; only what appears here was tested.",
    })


def emit(inventory):
    text = json.dumps(inventory, indent=2, allow_nan=False)
    print("\n=== INSTRUMENT_INVENTORY_JSON ===", flush=True)
    print(text, flush=True)
    output = os.environ.get("RESEARCHLAB_INSTRUMENT_INVENTORY_OUT")
    if output:
        path = Path(output)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", encoding="utf-8")
        print(f"[probe] wrote {path}", flush=True)
