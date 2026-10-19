"""An unchanged script that already overran its budget is not run again.

Regression guard for cycle-g-v91, 2026-09-14. One analyst handoff's blueprint
timed out at 1494s in followup-runner-66 and then, byte for byte, in five more
runner lanes -- two and a half hours of the only runner slots while newer
handoffs waited. The guard must refuse exactly that and nothing else: a changed
script, a larger budget, or a run that finished are all different runs.
"""

import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
sys.path.insert(0, str(PROJECT / "drivers" / "analysis"))
from drivers.analysis.python_stats_lib import blueprint_run
from drivers.analysis.python_stats_lib.blueprint_model import Blueprint
from drivers.analysis.python_stats_lib.validation_status import _result_status

SCRIPT = textwrap.dedent("""
    import argparse, json, pathlib
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv-root")
    parser.add_argument("--output-dir")
    args = parser.parse_args()
    pathlib.Path(args.output_dir, "ran.txt").write_text("ran")
    print(json.dumps({"gain": 0.02, "pass_fail": "pass"}))
""")


def prior_lane(stats_root, lane_id, code, stderr_text):
    blueprint_dir = stats_root / lane_id / "blueprints" / "chk-sweep-01"
    blueprint_dir.mkdir(parents=True)
    (blueprint_dir / "script.py").write_text(code, encoding="utf-8")
    (blueprint_dir / "stderr.log").write_text(stderr_text, encoding="utf-8")


def run(stats_root, lane_id, code, timeout_seconds=1494):
    blueprint = Blueprint("BP-SWEEP-01", "CHK-SWEEP-01", code, None, None, None)
    output_root = stats_root / lane_id
    csv_root = stats_root.parent / "csv"
    csv_root.mkdir(exist_ok=True)
    execution = blueprint_run._run_blueprint(
        blueprint,
        csv_root=csv_root,
        output_root=output_root,
        timeout_seconds=timeout_seconds,
        derived_indicators_for_blueprint=[],
    )
    ran = (output_root / "blueprints" / "chk-sweep-01" / "ran.txt").exists()
    return execution, ran


OVERRAN = "\n[driver] blueprint timed out after 1494s"


class OverrunRepeatTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.stats = Path(self._tmp.name) / "stats" / "cg-cycle"
        self.stats.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def test_identical_script_that_overran_is_recorded_as_the_overrun_and_not_run(self):
        prior_lane(self.stats, "followup-runner-66", SCRIPT, OVERRAN)
        execution, ran = run(self.stats, "followup-runner-67", SCRIPT)
        self.assertFalse(ran, "the script was executed again")
        self.assertEqual(execution.status, "timeout")
        self.assertEqual(execution.duration_seconds, 0.0)
        self.assertTrue(execution.metrics["design_overrun"])
        self.assertEqual(execution.metrics["previous_overruns"], ["followup-runner-66"])
        self.assertIn("design_overrun_repeat", execution.error)
        # Every consumer reads it as the timeout it already was.
        self.assertEqual(_result_status([execution]), "failed")

    def test_a_changed_script_runs(self):
        prior_lane(self.stats, "followup-runner-66", SCRIPT, OVERRAN)
        execution, ran = run(self.stats, "followup-runner-67", SCRIPT + "\n# fewer seeds\n")
        self.assertTrue(ran)
        self.assertEqual(execution.status, "completed")

    def test_a_larger_budget_runs(self):
        prior_lane(self.stats, "followup-runner-66", SCRIPT, "\n[driver] blueprint timed out after 600s")
        execution, ran = run(self.stats, "followup-runner-67", SCRIPT, timeout_seconds=1494)
        self.assertTrue(ran)
        self.assertEqual(execution.status, "completed")

    def test_an_identical_script_that_finished_runs(self):
        prior_lane(self.stats, "followup-runner-66", SCRIPT, "")
        execution, ran = run(self.stats, "followup-runner-67", SCRIPT)
        self.assertTrue(ran)
        self.assertEqual(execution.status, "completed")

    def test_the_lane_does_not_refuse_itself(self):
        prior_lane(self.stats, "followup-runner-67", SCRIPT, OVERRAN)
        execution, ran = run(self.stats, "followup-runner-67", SCRIPT)
        self.assertTrue(ran)
        self.assertEqual(execution.status, "completed")


if __name__ == "__main__":
    unittest.main()
