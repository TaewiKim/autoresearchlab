"""Bounded MuJoCo capability measurement: one short rigid-body simulation.

Measured, not declared: the probe builds a two-body contact scene, steps it, and
reports what it read back. An installation that imports but cannot step is an
absence this records rather than a capability it assumes.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

from .common import probe
from .provisioning import ensure_probe_packages

STEPS = 400
# The measurement runs in whichever interpreter has MuJoCo, so it is written
# once here and executed either in this process or in the named one.
MEASURE_SOURCE = '''
import json, time
import mujoco
import numpy as np

XML = """
<mujoco>
  <option timestep="0.002" gravity="0 0 -9.81"/>
  <worldbody>
    <geom name="floor" type="plane" size="2 2 0.1"/>
    <body name="cube" pos="0 0 0.5">
      <freejoint/>
      <geom name="cube" type="box" size="0.05 0.05 0.05" density="500"/>
    </body>
  </worldbody>
</mujoco>
"""

model = mujoco.MjModel.from_xml_string(XML)
data = mujoco.MjData(model)
start_height = float(data.qpos[2]) if model.nq else None
mujoco.mj_forward(model, data)
started = time.perf_counter()
contacts_seen = 0
max_contact_force = 0.0
force = np.zeros(6, dtype=float)
for _ in range({steps}):
    mujoco.mj_step(model, data)
    contacts_seen = max(contacts_seen, int(data.ncon))
    for index in range(int(data.ncon)):
        mujoco.mj_contactForce(model, data, index, force)
        max_contact_force = max(max_contact_force, float(np.linalg.norm(force[:3])))
elapsed = time.perf_counter() - started

print(json.dumps({{
    "mujoco_version": mujoco.__version__,
    "interpreter_path": __import__("sys").executable,
    "timestep_s": float(model.opt.timestep),
    "steps_executed": {steps},
    "simulated_seconds": float(model.opt.timestep) * {steps},
    "wall_seconds": round(elapsed, 4),
    "realtime_factor": round((float(model.opt.timestep) * {steps}) / elapsed, 3) if elapsed else None,
    "start_height_m": start_height,
    "final_height_m": float(data.qpos[2]),
    "settled_on_floor": bool(abs(float(data.qpos[2]) - 0.05) < 0.01),
    "max_contacts_in_one_step": contacts_seen,
    "max_contact_force_n": round(max_contact_force, 4),
    "finite_state": bool(np.isfinite(data.qpos).all() and np.isfinite(data.qvel).all()),
}}))
'''


def _interpreter(config):
    """The interpreter that owns MuJoCo, when it is not this one."""
    named = config.get("mujoco_python") or os.environ.get("RESEARCHLAB_MUJOCO_PYTHON")
    if not named:
        return None
    path = Path(str(named))
    return str(path) if path.is_file() else None


def _measure(interpreter):
    source = MEASURE_SOURCE.format(steps=STEPS)
    completed = subprocess.run(
        [interpreter, "-c", source],
        capture_output=True, text=True, timeout=300,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"mujoco measurement failed: {completed.stderr.strip()[:400]}")
    return json.loads(completed.stdout.strip().splitlines()[-1])


def run(inventory, config):
    inventory["execution_mode"] = "simulation"
    inventory["notes"] += [
        "One short rigid-body drop measures that this MuJoCo installation integrates and reports contacts; it is not a validated model of any robot.",
        "Contact forces here are from a box on a plane, not a gripper, and say nothing about hardware force limits.",
    ]
    interpreter = _interpreter(config)
    if interpreter is None:
        # This interpreter, if it has MuJoCo. A discovered pass does not install.
        if not ensure_probe_packages(inventory, ["mujoco", "numpy"]):
            return 1
        interpreter = sys.executable
    inventory["interpreter_path"] = interpreter

    measurement = probe(
        "mujoco_rigid_body_simulation",
        "Can this MuJoCo installation build a contact scene, step it, and return finite state?",
        lambda: _measure(interpreter),
        inventory,
        capability=lambda m: m["finite_state"] and m["steps_executed"] == STEPS,
    )
    if not measurement["available"]:
        return 1

    inventory["measurable_quantities"] += [
        "rigid-body pose and velocity over a stepped MuJoCo simulation",
        "per-step contact count and contact-force magnitude in a MuJoCo scene",
        "simulated-to-wall-clock step throughput for this installation",
    ]
    contact = probe(
        "mujoco_contact_response",
        "Did the stepped scene actually produce contact and come to rest on the floor?",
        lambda: {
            "max_contacts_in_one_step": measurement["measured"]["max_contacts_in_one_step"],
            "max_contact_force_n": measurement["measured"]["max_contact_force_n"],
            "settled_on_floor": measurement["measured"]["settled_on_floor"],
        },
        inventory,
        capability=lambda m: m["max_contacts_in_one_step"] > 0 and m["settled_on_floor"],
    )
    if not contact["available"]:
        inventory["notes"].append(
            "MuJoCo stepped but the drop produced no resting contact; contact response is unverified here."
        )
    return 0
