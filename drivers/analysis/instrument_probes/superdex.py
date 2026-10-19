"""Bounded SuperDex simulation capability measurement; no hardware modules."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import importlib
from pathlib import Path
import sys

from .common import probe
from .provisioning import ensure_probe_packages

ACTOR_NAMES = ("bio_gripper_base_link", "bio_gripper_left_finger", "bio_gripper_right_finger")
SOURCE_MODULES = ("rl_grasp_runner", "xarm_grasp_env_hw", "xarm_grasp_env", "xarm_kinematics")
SEED = 700
MAX_POLICY_STEPS = 120


def _required_path(config, key, directory=False):
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"superdex requires explicit absolute {key}")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"superdex {key} must be an absolute path")
    path = path.resolve()
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"superdex {key} does not exist: {path}")
    return path


@contextmanager
def _source_imports(scripts):
    """Use exactly the declared snapshot, even if another probe imported a copy."""
    previous_path = sys.path[:]
    previous_modules = {name: sys.modules.pop(name) for name in SOURCE_MODULES if name in sys.modules}
    previous_bytecode = sys.dont_write_bytecode
    sys.path.insert(0, str(scripts))
    sys.dont_write_bytecode = True
    try:
        yield
    finally:
        sys.path[:] = previous_path
        sys.dont_write_bytecode = previous_bytecode
        for name in SOURCE_MODULES:
            sys.modules.pop(name, None)
        sys.modules.update(previous_modules)


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(inventory, config):
    inventory["execution_mode"] = "simulation"
    inventory["hardware_connected"] = False
    inventory["interpreter_path"] = sys.executable
    inventory["notes"] += [
        "One bounded seeded policy episode measures local simulation capabilities, not a research hypothesis or hardware readiness.",
        "The existing SimAdapter reconstructs ground-truth observations and bypasses the environment's injected observation noise.",
        "Force samples are net vector sums at policy-step endpoints, not local squeeze loads, continuous-time maxima or hardware force bounds.",
        "The environment's 8 N term is a reward penalty, not an inference-time force stop."
    ]
    root = _required_path(config, "source_root", directory=True)
    policy_path = _required_path(config, "policy_path")
    if policy_path.suffix.lower() != ".zip":
        raise ValueError("superdex policy_path must explicitly name a trained PPO .zip policy")
    scripts = root / "scripts"
    for module in SOURCE_MODULES:
        if not (scripts / f"{module}.py").is_file():
            raise ValueError(f"superdex source_root lacks scripts/{module}.py")
    inventory["source_root"] = str(root)
    inventory["policy_path"] = str(policy_path)
    inventory["probe_config"] = {"backend": "superdex", "source_root": str(root), "policy_path": str(policy_path)}
    inventory["policy_sha256"] = _sha256(policy_path)
    inventory["source_sha256"] = {f"scripts/{name}.py": _sha256(scripts / f"{name}.py") for name in SOURCE_MODULES}
    # The SuperDex SDK itself is supplied by the selected local environment.
    # Do not guess a public distribution from a private/native SDK import name.
    if not ensure_probe_packages(inventory, ["numpy", "gymnasium", "trimesh", "stable-baselines3"]):
        return 1
    with _source_imports(scripts):
        # Only simulator modules and the installed inference library are loaded.
        import numpy as np
        import superdex.physics as physics
        from superdex.physics.utils.scene_helpers import find_actor
        from stable_baselines3 import PPO
        runner_module = importlib.import_module("rl_grasp_runner")
        env_module = importlib.import_module("xarm_grasp_env_hw")
        base_module = importlib.import_module("xarm_grasp_env")
        policy = PPO.load(str(policy_path), device="cpu")
        env = env_module.XArmGraspEnvHW(seed=SEED)
        try:
            native_observation, _ = env.reset(seed=SEED)
            adapter = runner_module.SimAdapter(env)
            runner = runner_module.Runner(policy, adapter)
            actors = {}

            def actor_coverage():
                found, missing, read_errors = [], [], {}
                for name in ACTOR_NAMES:
                    actor = find_actor(env.scene, f"{env.prefab.name}/{name}")
                    if actor is None:
                        missing.append(name)
                        continue
                    found.append(name)
                    try:
                        actor.register_query(physics.QueryType.TOTAL_CONTACT_FORCE)
                        vector = np.asarray(actor.get_contact_force_world(), dtype=float)
                        if vector.shape != (3,) or not np.isfinite(vector).all():
                            raise ValueError("force query must yield a finite 3-vector")
                        actors[name] = actor
                    except Exception as exc:
                        read_errors[name] = f"{type(exc).__name__}: {exc}"
                return {"expected_actors": list(ACTOR_NAMES), "found_actors": found,
                        "missing_actors": missing, "read_errors": read_errors,
                        "readable_actor_count": len(actors),
                        "environment_registered_actor_count": len(env.ft_links)}

            coverage = probe("superdex_gripper_force_actor_coverage",
                             "Are all three named simulated gripper force actors present and readable?",
                             actor_coverage, inventory,
                             capability=lambda m: m["readable_actor_count"] == 3 and m["environment_registered_actor_count"] == 3)
            if not coverage["available"]:
                return 1

            samples = []
            policy_shapes = set()
            action_shapes = set()

            def simulate():
                info, done = {}, False
                for step in range(min(MAX_POLICY_STEPS, int(base_module.HORIZON))):
                    obs = np.asarray(runner.observation())
                    action, _ = policy.predict(obs, deterministic=True)
                    action = np.asarray(action, dtype=float)
                    policy_shapes.add(tuple(obs.shape))
                    action_shapes.add(tuple(action.shape))
                    if obs.shape != (19,) or action.shape != (8,) or not np.isfinite(obs).all() or not np.isfinite(action).all():
                        raise ValueError("policy observations/actions must be finite vectors of shape (19,)/(8,)")
                    action = np.clip(action, -1, 1)
                    done, info = adapter.apply(runner_module.ARM_SCALE * action[:7], runner_module.FINGER_SCALE * action[7])
                    vectors = {}
                    for name, actor in actors.items():
                        vector = np.asarray(actor.get_contact_force_world(), dtype=float)
                        if vector.shape != (3,) or not np.isfinite(vector).all():
                            raise ValueError(f"invalid force vector after step {step}: {name}")
                        vectors[name] = vector
                    net_force = float(np.linalg.norm(np.sum(list(vectors.values()), axis=0)))
                    sample = {
                        "policy_step": step + 1,
                        "net_force_n": net_force,
                        "per_link_force_norms_n": {name: float(np.linalg.norm(v)) for name, v in vectors.items()},
                        "lift_m": float(info["lift"]),
                        "tilt_deg": float(info["tilt_deg"]),
                        "wrist_above_tcp_m": float(info["wrist_above_tcp_m"]),
                        "success": bool(info.get("is_success")),
                        "orientation_guard_violation": bool(info.get("guard_violation", False)),
                    }
                    if not np.isfinite([net_force, sample["lift_m"], sample["tilt_deg"], sample["wrist_above_tcp_m"]]).all():
                        raise ValueError(f"nonfinite measured state after step {step}")
                    samples.append(sample)
                    if done:
                        break
                if not samples:
                    raise RuntimeError("simulation produced no policy-step measurements")
                forces = [s["net_force_n"] for s in samples]
                inventory["measurable_quantities"] += [
                    "policy observation/action vector shape and finite values",
                    "sampled held-lift success, lift height and orientation-guard outcome in simulation",
                    "three-link net contact force and individual link force-vector magnitudes at policy-step endpoints",
                ]
                return {"seed": SEED, "steps_executed": len(samples), "episode_done": bool(done),
                        "native_observation_shape": list(np.asarray(native_observation).shape),
                        "policy_observation_shapes": [list(s) for s in sorted(policy_shapes)],
                        "policy_action_shapes": [list(s) for s in sorted(action_shapes)],
                        "physics_timestep_s": float(base_module.TIME_STEP),
                        "physics_substeps_per_policy_step": int(base_module.SUBSTEPS),
                        "force_sample_interval_s": float(base_module.TIME_STEP * base_module.SUBSTEPS),
                        "force_sampling": "once after each policy step; no physics-substep or continuous-force measurement",
                        "sampled_peak_net_force_n": max(forces),
                        "sampled_p95_net_force_n": float(np.percentile(forces, 95)),
                        "terminal_success": bool(info.get("is_success")),
                        "any_sampled_orientation_guard_violation": any(s["orientation_guard_violation"] for s in samples),
                        "samples": samples}

            rollout = probe("superdex_policy_simulation_measurement",
                            "Can the explicit policy execute a bounded simulation and return finite state/force measurements?",
                            simulate, inventory)
            if not rollout["available"]:
                inventory["partial_policy_step_samples"] = samples
                return 1
            contact = probe("superdex_nonzero_contact_response",
                            "Did the sampled episode actually produce a nonzero response from the simulated force queries?",
                            lambda: {"largest_sampled_net_force_n": max(s["net_force_n"] for s in samples),
                                     "largest_sampled_link_force_n": max(max(s["per_link_force_norms_n"].values()) for s in samples),
                                     "known_nonzero_contact_observed": any(max(s["per_link_force_norms_n"].values()) > 1e-8 for s in samples)},
                            inventory, capability=lambda m: m["known_nonzero_contact_observed"])
            if not contact["available"]:
                inventory["notes"].append("Force queries were readable but no nonzero contact was observed; contact response remains unverified.")
            return 0 if contact["available"] else 1
        finally:
            env.close()
