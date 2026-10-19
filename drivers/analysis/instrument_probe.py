"""Measure explicitly selected local capabilities, independently of a hypothesis.

The default is a standard-library Python probe. Renderer and robot simulator
backends are optional and are never selected from prose or dataset names.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path

# The stats lane loads this entrypoint by file path, from arbitrary working dirs.
_ANALYSIS = str(Path(__file__).resolve().parent)
if _ANALYSIS not in sys.path:
    sys.path.insert(0, _ANALYSIS)

from instrument_probes.common import emit, finalize, new_inventory

PROBE_PACKAGE = "instrument_probes"
PROBE_INPUT_KEYS = ("source_root", "policy_path")


def _scan_probe_package():
    """Every module in the probe package, and whether it is a backend.

    A module is a backend when it implements the contract -- a callable `run` --
    and not when its name appears on a list. The two shared helpers here have no
    `run` and exclude themselves; an exclusion list would have to be edited every
    time one was added, and a list nobody edits is how a capability ends up
    implemented and unreachable.

    This is also the record the harness needs in order to MANAGE what is
    implemented: every module is reported, including the ones that are not
    backends and the ones that could not be imported. A module that exists and
    cannot serve is then a visible state rather than something found by accident.
    """
    scanned = {}
    try:
        package = importlib.import_module(PROBE_PACKAGE)
        root = Path(package.__file__).resolve().parent
    except Exception as exc:  # noqa: BLE001
        return {}, {"error": f"{type(exc).__name__}: {exc}"[:300]}
    for path in sorted(root.glob("*.py")):
        name = path.stem
        if name.startswith("_"):
            continue
        module_name = f"{PROBE_PACKAGE}.{name}"
        entry = {"module": module_name, "file": path.name}
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:  # noqa: BLE001
            entry["role"] = "unimportable"
            entry["error"] = f"{type(exc).__name__}: {exc}"[:300]
        else:
            entry["role"] = "backend" if callable(getattr(module, "run", None)) else "support"
        scanned[name] = entry
    return scanned, None


PROBE_MODULES, PROBE_SCAN_ERROR = _scan_probe_package()
# Kept as a name -> module mapping because that is what the dispatcher needs;
# its CONTENT is now measured rather than declared.
BACKENDS = {
    name: entry["module"]
    for name, entry in PROBE_MODULES.items()
    if entry["role"] == "backend"
}


def _discovered_backends():
    """Every backend the package implements, in a stable order."""
    return sorted(BACKENDS)


def _merge_backend(inventory, name, produced, code):
    """Fold one backend's measurements into the shared inventory.

    Each probe appends to `instruments` and assigns `measurable_quantities`, so
    merging has to EXTEND rather than assign: run two backends into one dict
    naively and the second erases the first's quantities.
    """
    inventory["instruments"].extend(produced.get("instruments") or [])
    for quantity in produced.get("measurable_quantities") or []:
        if quantity not in inventory["measurable_quantities"]:
            inventory["measurable_quantities"].append(quantity)
    for note in produced.get("notes") or []:
        inventory["notes"].append(f"[{name}] {note}")
    # Everything a backend recorded that is not one of the shared fields stays
    # addressable under its own name -- a renderer's variant list means nothing
    # to a statistics probe and should not be flattened into a common bag.
    shared = {"instruments", "measurable_quantities", "notes", "inventory_version",
              "backend", "probe_config", "probed_at", "evidence_scope"}
    extras = {k: v for k, v in produced.items() if k not in shared}
    extras["exit_code"] = code
    inventory.setdefault("by_backend", {})[name] = extras


def main(config=None):
    """Emit an inventory and return an exit code; config is role_plan.probe_config.

    MEASURED ON cycle-g-v91, 2026-09-13. The backend defaulted to "python" and
    the launcher set nothing, so a computer-graphics rendering cycle probed the
    standard library's `statistics` module, reported ONE verified instrument --
    "count, mean and sample variance of supplied finite numeric values" -- and
    never ran `instrument_probes/mitsuba.py`, which sits beside it and was
    already written. Mitsuba 3.8.0 renders in that container; thirteen variants,
    llvm_ad_rgb among them.

    The cost is not a missing line in a report. Every hypothesis must name an
    instrument from this inventory, so the cycle held a rendering hypothesis it
    believed it had no renderer for: analysts declined to author an executable
    blueprint, runners executed a deferral, and four runner lanes completed
    having produced no numbers at all.

    So the default is now every backend that exists. A named backend still
    selects exactly that one, and a backend that fails no longer silences the
    rest -- the previous behaviour recorded "no alternative backend was run",
    which was true and is not what a capability inventory is for.
    """
    inventory = new_inventory("all")
    try:
        if config is None:
            config = {}
        if not isinstance(config, dict):
            raise ValueError("probe_config must be an object")
        requested = config.get("backends")
        if requested is None and config.get("backend") is not None:
            requested = [config.get("backend")]
        # Named by the caller, or discovered here. The difference decides what a
        # failure means: a backend somebody asked for by name failing is the
        # probe failing, while one this function chose to try and found absent is
        # a measurement.
        named_explicitly = requested is not None
        if requested is None:
            requested = _discovered_backends()
        if isinstance(requested, str):
            requested = [requested]
        if not isinstance(requested, list) or not requested:
            raise ValueError("probe_config backends must be a non-empty list")
        names = []
        for backend in requested:
            if isinstance(backend, str):
                backend = backend.strip()
            if not isinstance(backend, str) or backend not in BACKENDS:
                known = ", ".join(_discovered_backends())
                raise ValueError(f"unknown probe backend {backend!r}; expected one of: {known}")
            if backend not in names:
                names.append(backend)
        inventory["backend"] = names[0] if len(names) == 1 else "all"
        inventory["backends"] = names
        # Inputs a backend reads, passed to every backend that runs; one that
        # does not use them ignores them.
        inputs = {key: config[key] for key in PROBE_INPUT_KEYS if key in config}
        inventory["probe_config"] = {"backends": names, **inputs}

        ran = 0
        failed = []
        for name in names:
            produced = new_inventory(name)
            # A backend nobody named is measured, not provisioned. See
            # ensure_probe_packages.
            produced["may_provision"] = named_explicitly
            try:
                module = importlib.import_module(BACKENDS[name])
                code = module.run(produced, {"backend": name, **inputs})
                if code is None:
                    code = 0
                ran += 1
            except Exception as exc:  # noqa: BLE001
                # One backend's failure is negative evidence about that backend,
                # not a reason to stop measuring the others.
                code = 1
                produced["error"] = f"{type(exc).__name__}: {exc}"[:600]
                produced.setdefault("notes", []).append(
                    "This backend could not be probed; its absence here is unmeasured, not measured."
                )
            if code:
                failed.append(name)
            _merge_backend(inventory, name, produced, code)
        if named_explicitly:
            # The caller asked for these specifically; not getting them is the
            # failure, and a lane that requested a renderer must not read exit 0
            # and conclude the renderer answered.
            exit_code = 1 if failed else 0
        else:
            # Discovered: the probe succeeded if it measured anything at all.
            # Whether a given capability is present is the inventory's content,
            # not its exit status.
            exit_code = 0 if ran else 1
    except Exception as exc:  # noqa: BLE001
        inventory["error"] = f"{type(exc).__name__}: {exc}"[:600]
        exit_code = 1
    inventory["probe_modules"] = PROBE_MODULES
    if PROBE_SCAN_ERROR:
        inventory["probe_module_scan_error"] = PROBE_SCAN_ERROR
    # Implemented and not exercised by this run. cycle-g-v91 had exactly one --
    # a four-hundred-line renderer probe that had never executed -- and nothing
    # in the tree could say so.
    inventory["implemented_but_not_probed"] = sorted(
        name for name, entry in PROBE_MODULES.items()
        if entry["role"] == "backend" and name not in (inventory.get("backends") or [])
    )
    finalize(inventory, exit_code)
    emit(inventory)
    return exit_code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config-json", help="Explicit probe_config JSON object")
    args = parser.parse_args()
    sys.exit(main(json.loads(args.config_json) if args.config_json else None))
