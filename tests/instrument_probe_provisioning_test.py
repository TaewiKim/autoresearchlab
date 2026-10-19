"""Selected probes install missing distributions through the active interpreter."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ANALYSIS = Path(__file__).resolve().parents[1] / "drivers" / "analysis"
sys.path.insert(0, str(ANALYSIS))
import instrument_probe
from instrument_probes.common import new_inventory
from instrument_probes.provisioning import ensure_probe_packages


class ProbeProvisioningTests(unittest.TestCase):
    def test_missing_packages_use_active_python_and_keep_install_log(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            inventory = new_inventory("superdex")
            with patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(output)}), patch(
                "python_stats_lib.pip_install._module_is_importable", side_effect=lambda name: name in ("numpy", "pip")
            ), patch("python_stats_lib.pip_install.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="installed", stderr="")) as install:
                self.assertTrue(ensure_probe_packages(inventory, ["numpy", "stable-baselines3"]))
            self.assertEqual(install.call_args.args[0], [sys.executable, "-m", "pip", "install", "--no-input", "stable-baselines3"])
            entry = inventory["pip_installs"][0]
            self.assertEqual(entry["already_importable"], ["numpy"])
            self.assertEqual(entry["interpreter_path"], sys.executable)
            self.assertIn("installed", Path(entry["log_path"]).read_text(encoding="utf-8"))

    def test_available_packages_do_not_invoke_pip(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(Path(directory) / "inventory.json")}), patch(
            "python_stats_lib.pip_install._module_is_importable", return_value=True
        ), patch("python_stats_lib.pip_install.subprocess.run") as install:
            inventory = new_inventory("superdex")
            self.assertTrue(ensure_probe_packages(inventory, ["numpy"]))
            install.assert_not_called()
            self.assertEqual(inventory["pip_installs"][0]["install_status"], "already_satisfied")

    def test_failed_install_blocks_selected_probe_and_preserves_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            with patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(output)}), patch(
                "python_stats_lib.pip_install._module_is_importable", side_effect=lambda name: name == "pip"
            ), patch("python_stats_lib.pip_install.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="index unavailable")), redirect_stdout(io.StringIO()):
                self.assertEqual(instrument_probe.main({"backend": "mitsuba"}), 1)
            inventory = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(inventory["status"], "failed")
            self.assertEqual(inventory["verified_instruments"], [])
            # A backend's own findings live under its own name now, because the
            # inventory can hold several. The error is still preserved verbatim
            # -- that was the point of this test and it has not changed.
            mitsuba = inventory["by_backend"]["mitsuba"]
            self.assertIn("index unavailable", mitsuba["error"])
            self.assertEqual(mitsuba["pip_installs"][0]["return_code"], 1)

    def test_the_probe_never_installs_anything_to_make_a_capability_appear(self):
        """Measuring what is here must never change what is here.

        This used to assert that the DEFAULT probe touches no optional package,
        which it achieved by probing only the standard library -- and that is why
        cycle-g-v91 never learned it had a renderer. The rule worth keeping is
        the narrower one: a probe reports what is installed, and does not install
        something so that it can report it. An inventory that provisions its own
        answer is measuring the installer.
        """
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(Path(directory) / "inventory.json")}), patch(
            "instrument_probes.provisioning._maybe_install_blueprint_packages",
            # A return value the inventory can actually serialise: a bare
            # MagicMock reaches the emitted JSON and the probe dies writing it,
            # which would fail this test for a reason it is not about.
            return_value=False,
        ) as install, redirect_stdout(io.StringIO()):
            instrument_probe.main()
            install.assert_not_called()

    def test_discovered_pass_checks_distributions_by_their_import_names(self):
        # `stable-baselines3` imports as `stable_baselines3`. Asking find_spec for
        # the distribution name reported an installed SB3 missing, so the
        # SuperDex backend exited unmeasured on a venv that had everything.
        inventory = new_inventory("superdex")
        inventory["may_provision"] = False
        with patch("python_stats_lib.pip_install._module_is_importable", side_effect=lambda name: name == "stable_baselines3"):
            self.assertTrue(ensure_probe_packages(inventory, ["stable-baselines3"]))
        self.assertEqual(inventory["notes"], [])

    def test_unprovisioned_mitsuba_reports_absence_instead_of_crashing(self):
        from instrument_probes import mitsuba
        inventory = new_inventory("mitsuba")
        inventory["may_provision"] = False
        with patch.object(mitsuba, "ensure_probe_packages", return_value=False):
            self.assertEqual(mitsuba.run(inventory, {"backend": "mitsuba"}), 1)
        self.assertFalse(inventory["renderer"]["available"])
        self.assertIn("not provisioned", inventory["renderer"]["error"])

    def test_environment_without_pip_bootstraps_before_install(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(Path(directory) / "inventory.json")}), patch(
            "python_stats_lib.pip_install._module_is_importable", return_value=False
        ), patch("python_stats_lib.pip_install.subprocess.run", return_value=SimpleNamespace(returncode=0, stdout="done", stderr="")) as run:
            inventory = new_inventory("superdex")
            self.assertTrue(ensure_probe_packages(inventory, ["numpy"]))
            self.assertEqual([c.args[0] for c in run.call_args_list], [
                [sys.executable, "-m", "ensurepip", "--upgrade"],
                [sys.executable, "-m", "pip", "install", "--no-input", "numpy"],
            ])

    def test_failed_pip_bootstrap_does_not_attempt_package_install(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RESEARCHLAB_INSTRUMENT_INVENTORY_OUT": str(Path(directory) / "inventory.json")}), patch(
            "python_stats_lib.pip_install._module_is_importable", return_value=False
        ), patch("python_stats_lib.pip_install.subprocess.run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="ensurepip unavailable")) as run:
            inventory = new_inventory("superdex")
            self.assertFalse(ensure_probe_packages(inventory, ["numpy"]))
            self.assertEqual(run.call_count, 1)
            self.assertIn("pip bootstrap failed", inventory["error"])


if __name__ == "__main__":
    unittest.main()
