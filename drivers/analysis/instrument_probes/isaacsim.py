"""Bounded Isaac Sim capability measurement: one headless physics simulation.

Isaac Sim lives in its own interpreter and starts a full Kit application, so this
probe runs the measurement as a separate process with a hard timeout and reports
what that process actually read back. No renderer window, no asset downloads, no
training.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from .common import probe

STEPS = 120
TIMEOUT_SECONDS = 900
# Isaac Sim's own interpreter. Without it this backend is a measured absence, not
# a guess: `import isaacsim` from another environment does not start Kit.
INTERPRETER_ENV = "RESEARCHLAB_ISAACSIM_PYTHON"
MEASURE_SOURCE = '''
import json, time
from isaacsim import SimulationApp

app = SimulationApp({{"headless": True}})
result = {{"steps_executed": 0}}
try:
    import isaacsim
    import numpy as np
    from isaacsim.core.api import World
    from isaacsim.core.api.objects import DynamicCuboid

    world = World(stage_units_in_meters=1.0)
    world.scene.add_default_ground_plane()
    cube = world.scene.add(DynamicCuboid(
        prim_path="/World/probe_cube", name="probe_cube",
        position=np.array([0.0, 0.0, 0.5]), size=0.1, mass=1.0,
    ))
    world.reset()
    start = cube.get_world_pose()[0]
    started = time.perf_counter()
    for _ in range({steps}):
        world.step(render=False)
        result["steps_executed"] += 1
    elapsed = time.perf_counter() - started
    end, _ = cube.get_world_pose()
    velocity = cube.get_linear_velocity()
    physics_dt = float(world.get_physics_dt())
    result.update({{
        "isaacsim_version": getattr(isaacsim, "__version__", None),
        "interpreter_path": __import__("sys").executable,
        "physics_dt_s": physics_dt,
        "simulated_seconds": physics_dt * result["steps_executed"],
        "wall_seconds": round(elapsed, 4),
        "realtime_factor": round((physics_dt * result["steps_executed"]) / elapsed, 3) if elapsed else None,
        "start_height_m": float(start[2]),
        "final_height_m": float(end[2]),
        "fell_under_gravity": bool(float(end[2]) < float(start[2]) - 0.05),
        "final_linear_velocity": [float(value) for value in velocity],
        "finite_state": bool(np.isfinite(end).all() and np.isfinite(velocity).all()),
    }})
    try:
        import torch
        result["cuda_available"] = bool(torch.cuda.is_available())
        result["cuda_device"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        result["cuda_available"] = None
finally:
    # Kit can terminate the process from app.close(), so the payload is emitted
    # first and flushed; on cycle-b-20260918 a completed measurement was
    # lost to an exit(0) inside close().
    import sys as _sys
    print("PROBE_RESULT " + json.dumps(result), flush=True)
    _sys.stdout.flush()
    app.close()
'''


def _interpreter(config):
    named = config.get("isaacsim_python") or os.environ.get(INTERPRETER_ENV)
    if not named:
        return None
    path = Path(str(named))
    return str(path) if path.is_file() else None


def _measure(interpreter):
    completed = subprocess.run(
        [interpreter, "-c", MEASURE_SOURCE.format(steps=STEPS)],
        capture_output=True, text=True, timeout=TIMEOUT_SECONDS,
    )
    # Kit writes a great deal to stdout before the payload; the marker is the
    # only line this probe trusts.
    for line in reversed((completed.stdout or "").splitlines()):
        if line.startswith("PROBE_RESULT "):
            return json.loads(line[len("PROBE_RESULT "):])
    raise RuntimeError(
        f"isaac sim measurement returned no result (exit {completed.returncode}): "
        f"{(completed.stderr or completed.stdout or '').strip()[-400:]}"
    )


def run(inventory, config):
    inventory["execution_mode"] = "simulation"
    inventory["notes"] += [
        "One headless rigid-body drop measures that this Isaac Sim installation starts Kit, steps PhysX and returns finite state; it validates no robot model or task.",
        "Kit startup dominates the wall time reported here, so the throughput figure is not a benchmark of steady-state stepping.",
    ]
    interpreter = _interpreter(config)
    if interpreter is None:
        inventory["notes"].append(
            f"Not measured: no Isaac Sim interpreter was named. Set {INTERPRETER_ENV} or probe_config.isaacsim_python to the python.exe of an Isaac Sim environment."
        )
        probe(
            "isaacsim_headless_physics_simulation",
            "Can this host start Isaac Sim headless and step PhysX?",
            lambda: (_ for _ in ()).throw(
                RuntimeError(f"no Isaac Sim interpreter named; set {INTERPRETER_ENV}")
            ),
            inventory,
        )
        return 1
    inventory["interpreter_path"] = interpreter

    measurement = probe(
        "isaacsim_headless_physics_simulation",
        "Can this Isaac Sim installation start headless, step PhysX, and return finite state?",
        lambda: _measure(interpreter),
        inventory,
        capability=lambda m: m.get("finite_state") and m.get("steps_executed") == STEPS,
    )
    if not measurement["available"]:
        return 1

    inventory["measurable_quantities"] += [
        "rigid-body pose and linear velocity over a stepped Isaac Sim (PhysX) simulation",
        "physics timestep and simulated-to-wall-clock throughput for this Isaac Sim installation",
        "whether this Isaac Sim process sees a CUDA device",
    ]
    gravity = probe(
        "isaacsim_gravity_response",
        "Did the dropped body actually move under gravity in this scene?",
        lambda: {
            "start_height_m": measurement["measured"]["start_height_m"],
            "final_height_m": measurement["measured"]["final_height_m"],
            "fell_under_gravity": measurement["measured"]["fell_under_gravity"],
        },
        inventory,
        capability=lambda m: m["fell_under_gravity"],
    )
    if not gravity["available"]:
        inventory["notes"].append(
            "Isaac Sim stepped but the body did not fall; dynamics in this scene are unverified."
        )
    return 0
