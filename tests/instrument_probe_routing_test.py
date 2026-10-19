"""Regression tests for explicit capability backends and honest probe failures."""
import builtins
from contextlib import redirect_stdout
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
ANALYSIS = REPO / "drivers" / "analysis"
sys.path.insert(0, str(ANALYSIS))
import instrument_probe
from instrument_probes.common import finalize, new_inventory, probe
from python_stats_lib import entrypoint
from python_stats_lib.instrument_probe_lane import run_instrument_probe_lane


class ProbeRoutingTests(unittest.TestCase):
    def run_dispatcher(self, config=None):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            with patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(output)}), redirect_stdout(io.StringIO()):
                code = instrument_probe.main(config)
            return code, json.loads(output.read_text(encoding="utf-8"))

    def test_default_measures_every_backend_that_exists(self):
        """The default used to be "python, and do not import an optional SDK".

        That is why cycle-g-v91 never learned it had a renderer. Mitsuba 3.8.0
        was installed and working in the container; the probe reported ONE
        verified instrument, "count, mean and sample variance of supplied finite
        numeric values", and instrument_probes/mitsuba.py -- four hundred lines,
        sitting beside it -- had never run. Every hypothesis must cite this
        inventory, so the cycle held a rendering hypothesis it believed it had no
        renderer for: analysts declined to author an executable blueprint,
        runners executed a deferral, and four runner lanes completed having
        produced no numbers at all.

        A capability present and unprobed is the failure this default now
        prevents. Not importing an SDK was never the goal; knowing what this
        container can do is.
        """
        code, inventory = self.run_dispatcher()
        self.assertEqual(code, 0)
        # The registry is the directory, so this asserts the discovery and not a
        # second list of names that would have to be kept in lockstep.
        expected = sorted(instrument_probe.BACKENDS)
        self.assertEqual(inventory["probe_config"], {"backends": expected})
        self.assertEqual(inventory["backends"], expected)
        self.assertIn("python_standard_library_statistics", inventory["verified_instruments"])
        # Each backend's own findings stay addressable under its own name.
        self.assertEqual(sorted(inventory["by_backend"]), expected)

    def test_one_failing_backend_does_not_silence_the_others(self):
        """The old dispatcher recorded "no alternative backend was run".

        That was true and is not what a capability inventory is for: a renderer
        that cannot be imported says nothing about whether arithmetic works.
        """
        real_import = instrument_probe.importlib.import_module

        def refuse_mitsuba(name):
            if name.endswith(".mitsuba"):
                raise ImportError("no renderer here")
            return real_import(name)

        with patch.object(instrument_probe.importlib, "import_module", side_effect=refuse_mitsuba):
            code, inventory = self.run_dispatcher()
        self.assertEqual(code, 0, "one backend failing must not fail the probe")
        self.assertIn("python_standard_library_statistics", inventory["verified_instruments"])
        self.assertIn("no renderer here", inventory["by_backend"]["mitsuba"]["error"])
        self.assertEqual(inventory["by_backend"]["mitsuba"]["exit_code"], 1)

    def test_the_inventory_is_a_census_of_what_is_implemented(self):
        """The harness has to be able to MANAGE what has been built.

        instrument_probes/mitsuba.py existed for the whole of cycle-g-v91, was
        four hundred lines long, and had never run. Nothing in the tree could
        say so, which is why it took a stalled cycle and a hand audit to find.

        The inventory now reports every module in the probe package and the role
        it plays -- backend, support, or unimportable -- and names the backends
        that were implemented and not exercised by this run. An implemented and
        unreachable capability becomes a visible state instead of a discovery.
        """
        code, inventory = self.run_dispatcher()
        self.assertEqual(code, 0)
        census = inventory["probe_modules"]
        # Every module, not only the ones that qualified.
        for name in ("common", "provisioning", "python", "mitsuba"):
            self.assertIn(name, census, f"{name} is missing from the census")
        # A backend is one that implements the contract; the two shared helpers
        # exclude themselves by not having a `run`, with no list saying so.
        self.assertEqual(census["python"]["role"], "backend")
        self.assertEqual(census["mitsuba"]["role"], "backend")
        self.assertEqual(census["common"]["role"], "support")
        self.assertEqual(census["provisioning"]["role"], "support")
        # A full pass leaves nothing unexercised.
        self.assertEqual(inventory["implemented_but_not_probed"], [])

    def test_an_implemented_backend_nobody_ran_is_named(self):
        # This is the one line that would have made cycle-g-v91 obvious on day
        # one: the cycle probed `python`, and a renderer probe sat unexecuted.
        code, inventory = self.run_dispatcher({"backend": "python"})
        self.assertEqual(code, 0)
        self.assertEqual(inventory["verified_instruments"], ["python_standard_library_statistics"])
        self.assertIn("mitsuba", inventory["implemented_but_not_probed"])

    def test_a_backend_is_recognised_by_its_contract_not_by_its_name(self):
        # The registry is derived, so no file anywhere needs editing when a
        # backend is added -- and nothing can be a backend by being named one.
        import instrument_probes
        from pathlib import Path as _Path
        modules = {
            path.stem
            for path in _Path(instrument_probes.__file__).resolve().parent.glob("*.py")
            if not path.stem.startswith("_")
        }
        self.assertEqual(set(instrument_probe.PROBE_MODULES), modules)
        for name, entry in instrument_probe.PROBE_MODULES.items():
            if entry["role"] != "backend":
                continue
            module = __import__(entry["module"], fromlist=["run"])
            self.assertTrue(callable(getattr(module, "run", None)), f"{name} is listed as a backend and has no run()")

    def test_incidental_mentions_do_not_select_backend(self):
        # Still the rule, and still for the same reason: a backend chosen by a
        # word appearing in a description is the substring classifier that has
        # taken this harness down three times. A config that names no backend
        # gets the full measurement, not the one its prose happens to mention.
        code, inventory = self.run_dispatcher({"description": "Mitsuba renderer"})
        self.assertEqual(code, 0)
        self.assertEqual(inventory["backends"], sorted(instrument_probe.BACKENDS))

    def test_explicit_backend_routes_only_to_declared_module(self):
        for backend in ("mitsuba", "superdex"):
            with self.subTest(backend=backend):
                config = {"backend": backend, "source_root": "/chosen/source", "policy_path": "/chosen/hw.zip"}
                calls = []
                def run(inventory, received):
                    calls.append(received)
                    probe("chosen_measurement", "measured?", lambda: {"value": 2}, inventory)
                    return 0
                fake = types.SimpleNamespace(run=run)
                with patch.object(instrument_probe.importlib, "import_module", return_value=fake) as loader:
                    code, inventory = self.run_dispatcher(config)
                loader.assert_called_once_with(f"instrument_probes.{backend}")
                self.assertEqual(calls, [config])
                self.assertEqual(code, 0)
                self.assertEqual(inventory["probe_config"], {"backends": [backend], "source_root": "/chosen/source", "policy_path": "/chosen/hw.zip"})
                self.assertEqual(inventory["backend"], backend)

    def test_unknown_backend_fails_without_fallback(self):
        with patch.object(instrument_probe.importlib, "import_module") as loader:
            code, inventory = self.run_dispatcher({"backend": "unknown"})
        loader.assert_not_called()
        self.assertEqual(code, 1)
        self.assertEqual(inventory["status"], "failed")
        self.assertIn("unknown probe backend", inventory["error"])
        self.assertEqual(inventory["verified_instruments"], [])

    def test_missing_explicit_mitsuba_preserves_scoped_failure(self):
        with patch.dict(sys.modules, {"mitsuba": None}), patch("instrument_probes.mitsuba.ensure_probe_packages", return_value=True):
            code, inventory = self.run_dispatcher({"backend": "mitsuba"})
        # A named backend that cannot run is a scoped failure: the inventory says
        # what was wrong with THAT backend rather than claiming the capability is
        # absent, and the probe still exits non-zero, because a lane that asked
        # for a renderer must not read exit 0 and conclude the renderer answered.
        self.assertEqual(code, 1)
        self.assertFalse(inventory["by_backend"]["mitsuba"]["renderer"]["available"])
        self.assertNotIn("NOTHING", json.dumps(inventory))
        self.assertEqual(inventory["verified_instruments"], [])

    def test_backend_normalization_matches_the_planner(self):
        with self.subTest(config={"backend": " python "}):
            code, inventory = self.run_dispatcher({"backend": " python "})
            self.assertEqual(code, 0)
            self.assertEqual(inventory["probe_config"], {"backends": ["python"]})
        # An explicit null is not a choice, so it measures everything.
        with self.subTest(config={"backend": None}):
            code, inventory = self.run_dispatcher({"backend": None})
            self.assertEqual(code, 0)
            self.assertEqual(inventory["probe_config"], {"backends": sorted(instrument_probe.BACKENDS)})

    def test_superdex_requires_explicit_source_and_policy_before_import(self):
        code, inventory = self.run_dispatcher({"backend": "superdex"})
        self.assertEqual(code, 1)
        superdex = inventory["by_backend"]["superdex"]
        self.assertIn("explicit absolute source_root", superdex["error"])
        self.assertFalse(superdex["hardware_connected"])


class ProbeLaneFailureTests(unittest.TestCase):
    def test_nonzero_exit_with_partial_inventory_is_failed_and_config_is_passed(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            fake_driver = output / "fake_probe.py"
            fake_driver.write_text(
                "import json, os\n"
                "def main(config=None):\n"
                "    data = {'backend': config['backend'], 'probe_config': config, 'verified_instruments': ['partial_measurement']}\n"
                "    with open(os.environ['RESEARCHLAB_INSTRUMENT_INVENTORY_OUT'], 'w') as stream: json.dump(data, stream)\n"
                "    return 7\n", encoding="utf-8")
            config = {"backend": "superdex", "source_root": "/explicit"}
            with patch("python_stats_lib.instrument_probe_lane._probe_driver_path", return_value=fake_driver):
                result = run_instrument_probe_lane({"lane_kind": "instrument_probe", "probe_config": config}, output / "out", None, None)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["probe_exit_code"], 7)
            self.assertEqual(result["probe_config"], config)
            self.assertEqual(result["verified_instruments"], ["partial_measurement"])
            self.assertIn("exit 7", result["error"])
            self.assertEqual(result["validation_summary"]["overall_status"], "not_applicable")
            inventory = json.loads(Path(result["instrument_inventory_path"]).read_text())
            self.assertEqual(inventory["status"], "failed")
            self.assertNotIn("Renderer UNAVAILABLE", Path(result["summary_path"]).read_text())

    def test_crash_cannot_reuse_previous_successful_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            declared = output / "shared-inventory.json"
            old = {"backend": "mitsuba", "verified_instruments": ["old_render"]}
            declared.write_text(json.dumps(old))
            fake_driver = output / "crash_probe.py"
            fake_driver.write_text("def main(config=None):\n    raise RuntimeError('fresh probe crashed')\n")
            with patch("python_stats_lib.instrument_probe_lane._probe_driver_path", return_value=fake_driver):
                result = run_instrument_probe_lane({"lane_kind": "instrument_probe", "probe_config": {"backend": "python"}, "probe_output_path": str(declared)}, output / "out", None, None)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["verified_instruments"], [])
            self.assertEqual(json.loads(declared.read_text())["status"], "failed")
            previous = list((output / "out").glob("instrument-inventory-previous-*.json"))
            self.assertTrue(any(json.loads(p.read_text()) == old for p in previous))

    def test_canonical_driver_process_fails_when_probe_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            role = output / "role.json"
            role.write_text(json.dumps({"lane_kind": "instrument_probe", "probe_config": {"backend": "unknown"}}))
            process = subprocess.run([sys.executable, str(ANALYSIS / "python_stats.py"), "--csv-root", str(output), "--output-dir", str(output / "out"), "--role-plan-file", str(role)], capture_output=True, text=True)
            self.assertEqual(process.returncode, 1, process.stderr)
            result = json.loads((output / "out" / "result.json").read_text())
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["verified_instruments"], [])

    def test_scientific_falsification_exit_semantics_unchanged(self):
        args = ["python_stats.py", "--csv-root", ".", "--output-dir", "."]
        result = {"status": "failed", "lane_kind": "hypothesis_validation", "validation_summary": {"overall_status": "fail"}}
        with patch.object(sys, "argv", args), patch.object(entrypoint, "run_driver", return_value=result), redirect_stdout(io.StringIO()):
            self.assertEqual(entrypoint.main(), 0)

    def test_reproducibility_default_does_not_invent_renderer_cost(self):
        result = entrypoint._stamp_handoff_reproducibility({"handoff_checks": [{"check_id": "x"}]})
        affordability = result["handoff_checks"][0]["reproducibility_design"]["why_affordable"]
        self.assertIn("Not established", affordability)
        self.assertNotIn("36s", affordability)
        self.assertNotIn("render", affordability)


class SuperDexMeasurementTests(unittest.TestCase):
    def fake_run(self, *, missing_actor=False, fail_after_step=None):
        import numpy as np
        from instrument_probes import superdex as backend
        state = types.SimpleNamespace(step=0, closed=False, calls=0)

        class Actor:
            def register_query(self, query):
                pass
            def get_contact_force_world(self):
                if fail_after_step is not None and state.step >= fail_after_step:
                    raise RuntimeError("force read failed")
                return [float(state.step), 0.0, 0.0]

        class Environment:
            def __init__(self, seed):
                self.scene = object()
                self.prefab = types.SimpleNamespace(name="fixture")
                self.ft_links = [Actor()] * (2 if missing_actor else 3)
            def reset(self, seed):
                return np.zeros(19), {}
            def close(self):
                state.closed = True

        class Adapter:
            def __init__(self, env):
                pass
            def apply(self, dq, df):
                state.step += 1
                return state.step == 2, {"lift": 0.1, "tilt_deg": 3.0, "wrist_above_tcp_m": 0.03, "is_success": state.step == 2}

        class Runner:
            def __init__(self, policy, adapter):
                pass
            def observation(self):
                return np.zeros(19)

        class Policy:
            @classmethod
            def load(cls, path, device):
                return cls()
            def predict(self, obs, deterministic):
                state.calls += 1
                return np.zeros(8), None

        root_package = types.ModuleType("superdex")
        root_package.__path__ = []
        physics = types.ModuleType("superdex.physics")
        physics.QueryType = types.SimpleNamespace(TOTAL_CONTACT_FORCE=1)
        helpers = types.ModuleType("superdex.physics.utils.scene_helpers")
        helpers.find_actor = lambda scene, name: None if missing_actor and name.endswith("right_finger") else Actor()
        sb3 = types.ModuleType("stable_baselines3")
        sb3.PPO = Policy
        source_modules = {
            "rl_grasp_runner": types.SimpleNamespace(SimAdapter=Adapter, Runner=Runner, ARM_SCALE=0.04, FINGER_SCALE=0.004),
            "xarm_grasp_env_hw": types.SimpleNamespace(XArmGraspEnvHW=Environment),
            "xarm_grasp_env": types.SimpleNamespace(HORIZON=120, TIME_STEP=0.01, SUBSTEPS=5),
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / "scripts").mkdir()
            for module in backend.SOURCE_MODULES:
                (source / "scripts" / f"{module}.py").write_text("# fake source\n")
            policy = source / "ppo_xarm_grasp_hw.zip"
            policy.write_bytes(b"fake model")
            config = {"backend": "superdex", "source_root": str(source), "policy_path": str(policy)}
            inventory = new_inventory("superdex")
            with patch.dict(sys.modules, {"superdex": root_package, "superdex.physics": physics, "superdex.physics.utils.scene_helpers": helpers, "stable_baselines3": sb3}), patch.object(backend.importlib, "import_module", side_effect=lambda name: source_modules[name]), patch.object(backend, "ensure_probe_packages", return_value=True), redirect_stdout(io.StringIO()):
                code = backend.run(inventory, config)
                finalize(inventory, code)
        return code, inventory, state

    def test_simulation_measures_shapes_named_coverage_and_endpoint_forces(self):
        code, inventory, state = self.fake_run()
        self.assertEqual(code, 0)
        self.assertTrue(state.closed)
        self.assertEqual(state.calls, 2)
        self.assertEqual(inventory["execution_mode"], "simulation")
        self.assertFalse(inventory["hardware_connected"])
        measured = next(e["measured"] for e in inventory["instruments"] if e["instrument"] == "superdex_policy_simulation_measurement")
        self.assertEqual(measured["policy_observation_shapes"], [[19]])
        self.assertEqual(measured["policy_action_shapes"], [[8]])
        self.assertEqual(measured["force_sample_interval_s"], 0.05)
        self.assertEqual(measured["sampled_peak_net_force_n"], 6.0)
        self.assertIn("no physics-substep", measured["force_sampling"])

    def test_missing_force_actor_blocks_policy_without_claiming_zero_force(self):
        code, inventory, state = self.fake_run(missing_actor=True)
        self.assertEqual(code, 1)
        self.assertTrue(state.closed)
        self.assertEqual(state.calls, 0)
        self.assertEqual(inventory["verified_instruments"], [])
        coverage = inventory["instruments"][0]
        self.assertEqual(coverage["measured"]["missing_actors"], ["bio_gripper_right_finger"])

    def test_force_read_failure_retains_partial_evidence_and_fails(self):
        code, inventory, state = self.fake_run(fail_after_step=2)
        self.assertEqual(code, 1)
        self.assertTrue(state.closed)
        self.assertEqual(inventory["status"], "failed")
        self.assertEqual(len(inventory["partial_policy_step_samples"]), 1)
        self.assertNotIn("superdex_policy_simulation_measurement", inventory["verified_instruments"])
        self.assertIn("force read failed", inventory["measured_absences"][0]["error"])


if __name__ == "__main__":
    unittest.main()


class SimulatorProbeTests(unittest.TestCase):
    """Isaac Sim and MuJoCo are backends, and say so honestly when absent."""

    def test_both_simulators_are_discovered_backends(self):
        for name in ("isaacsim", "mujoco"):
            with self.subTest(backend=name):
                self.assertEqual(instrument_probe.PROBE_MODULES[name]["role"], "backend")
                self.assertIn(name, instrument_probe.BACKENDS)

    def test_isaac_sim_without_an_interpreter_is_a_measured_absence(self):
        from instrument_probes import isaacsim as isaacsim_probe
        from instrument_probes.common import new_inventory

        inventory = new_inventory("isaacsim")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(isaacsim_probe.INTERPRETER_ENV, None)
            self.assertEqual(isaacsim_probe.run(inventory, {"backend": "isaacsim"}), 1)
        entry = inventory["instruments"][0]
        self.assertFalse(entry["available"])
        self.assertFalse(entry["probe_ran"])
        self.assertIn(isaacsim_probe.INTERPRETER_ENV, entry["error"])
        self.assertTrue(any("Not measured" in note for note in inventory["notes"]))

    def test_a_named_interpreter_that_fails_is_recorded_not_assumed(self):
        from instrument_probes import mujoco as mujoco_probe
        from instrument_probes.common import new_inventory

        inventory = new_inventory("mujoco")
        with patch.object(mujoco_probe, "_interpreter", return_value="python-for-test"), patch.object(
            mujoco_probe, "_measure", side_effect=RuntimeError("mujoco measurement failed: no module")
        ):
            self.assertEqual(mujoco_probe.run(inventory, {"backend": "mujoco"}), 1)
        entry = inventory["instruments"][0]
        self.assertFalse(entry["available"])
        self.assertIn("mujoco measurement failed", entry["error"])
        self.assertEqual(inventory["measurable_quantities"], [])
