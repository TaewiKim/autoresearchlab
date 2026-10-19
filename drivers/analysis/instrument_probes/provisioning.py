"""Provision only the packages declared by the explicitly selected probe."""
from __future__ import annotations

import importlib
import os
from pathlib import Path
import sys
from uuid import uuid4

from python_stats_lib.blueprint_model import Blueprint
from python_stats_lib.pip_install import _maybe_install_blueprint_packages, _split_already_importable_packages


def ensure_probe_packages(inventory, packages):
    """Reuse the runner's installer and retain its result with probe evidence.

    Distribution names come from the selected backend, never from exception text.
    The backend imports and measures its actual instrument after this succeeds.
    """
    if not packages:
        return True
    # Measuring what is here must not change what is here.
    #
    # The probe now runs every backend it can find rather than one named
    # default, which is how cycle-g-v91 came to hold a rendering hypothesis
    # believing it had no renderer. Probing broadly and installing broadly are
    # different things: a sweep that pip-installs each backend's dependencies
    # would rewrite the container to answer a question about the container, and
    # would fail wherever the network is closed.
    #
    # So a discovered pass measures and reports what is importable; a backend a
    # caller named explicitly may still provision, because that is a request.
    if not inventory.get("may_provision", True):
        # Distribution names, not module names: `stable-baselines3` imports as
        # `stable_baselines3`, so ask the installer's own mapping.
        missing, _ = _split_already_importable_packages(list(packages))
        if missing:
            inventory.setdefault("notes", []).append(
                "Not measured: " + ", ".join(missing) + " are not importable here, and this pass "
                "does not install. Name this backend explicitly to provision it."
            )
            return False
        return True
    output = os.environ.get("RESEARCHLAB_INSTRUMENT_INVENTORY_OUT")
    root = Path(output).resolve().parent if output else Path.cwd() / ".research-lab" / "artifacts" / "instrument-probes"
    logs = root / f"dependencies-{uuid4().hex}"
    logs.mkdir(parents=True, exist_ok=True)
    blueprint = Blueprint(
        blueprint_id=f"instrument-probe-{inventory['backend']}",
        check_id="dependency-provisioning", code="", entrypoint=None,
        dataset=None, outcome=None, pip_install_packages=list(packages),
    )
    result = _maybe_install_blueprint_packages(blueprint, logs)
    result["interpreter_path"] = sys.executable
    inventory.setdefault("pip_installs", []).append(result)
    if result.get("rejected") or result.get("install_status") not in ("completed", "already_satisfied"):
        inventory["error"] = "Dependency provisioning failed: " + str(
            result.get("error") or result.get("rejected") or result.get("install_status")
        )[:500]
        inventory["notes"].append("The selected probe was not measured because dependency provisioning failed; see pip_installs and its log.")
        return False
    importlib.invalidate_caches()
    return True

