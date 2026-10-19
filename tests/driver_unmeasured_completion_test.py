"""A completed run that measured nothing says so on the lane.

Regression guard for cycle-g-v91, 2026-09-14. The handoff from
followup-analyst-79 told the runner to measure nothing until an audit file
existed that no role produces. followup-runner-63 and -64 each exited 0 in about
a second with pass_fail "inconclusive" and zero measurements. The driver already
judged both "degraded" in its validation summary, yet both lanes read completed
with degraded false, because the verdict never reached the result fields the
harness copies onto the lane. No rubric moved for five gate rounds and the
watchdog halted the cycle.

The guard cuts both ways, as clean_falsification_test does: a run that MEASURED
and falsified its hypothesis is evidence and must never be flagged, and neither
must a run whose numbers simply failed a check.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_unmeasured", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_unmeasured"] = _mod
_spec.loader.exec_module(_mod)

BlueprintExecution = _mod.BlueprintExecution
_result_status = _mod._result_status
_unmeasured_completion = _mod._unmeasured_completion
NO_MEASUREMENT_FAILURE_CATEGORY = _mod.NO_MEASUREMENT_FAILURE_CATEGORY


def execution(*, status="completed", metrics=None, error=None, return_code=0, tables=None):
    return BlueprintExecution(
        blueprint_id="BP-TEST-01",
        check_id="CHK-TEST-01",
        status=status,
        script_path="/tmp/script.py",
        output_dir="/tmp/out",
        stdout_path="",
        stderr_path="",
        timeout_seconds=1494,
        duration_seconds=1.26,
        return_code=return_code,
        metrics=metrics or {},
        figures=[],
        tables=[] if tables is None else tables,
        error=error,
    )


# The recorded metrics of followup-runner-64: exit 0, no number anywhere.
V91_ZERO_MEASUREMENT = execution(
    metrics={
        "check_id": "CHK-RESIDUAL-VARIANCE-FIRST-HARM-02",
        "evidence_grade": {"residual_variance_first_harm_link": "weak"},
        "notes": "Novelty prerequisite unresolved; exact-hash foundational audit absent, so zero renders were performed.",
        "pass_fail": "inconclusive",
    }
)

# A run that measured, emitted tables, and honestly falsified its hypothesis.
CLEAN_FALSIFICATION = execution(
    metrics={
        "correlations": {"joint_vs_uniform": 0.61},
        "pass_fail": "fail",
        "notes": "the joint signal did not beat the simpler arm",
    },
    tables=[{"name": "summary_metrics.csv", "path": "/tmp/out/summary_metrics.csv"}],
)

# A run that measured numbers and reported no verdict at all.
MEASURED_NO_VERDICT = execution(metrics={"rmse_gain": 0.031})


def flags_for(executions):
    return _unmeasured_completion(_result_status(executions), executions)


class UnmeasuredCompletionTest(unittest.TestCase):
    def test_zero_measurement_run_is_flagged_but_stays_completed(self):
        self.assertEqual(_result_status([V91_ZERO_MEASUREMENT]), "completed")
        self.assertEqual(
            flags_for([V91_ZERO_MEASUREMENT]),
            {"degraded": True, "failure_category": NO_MEASUREMENT_FAILURE_CATEGORY},
        )

    def test_every_execution_unmeasured_is_flagged(self):
        self.assertTrue(flags_for([V91_ZERO_MEASUREMENT] * 3).get("degraded"))

    def test_clean_falsification_is_evidence_and_not_flagged(self):
        self.assertEqual(flags_for([CLEAN_FALSIFICATION]), {})

    def test_measured_numbers_without_a_verdict_are_not_flagged(self):
        self.assertEqual(flags_for([MEASURED_NO_VERDICT]), {})

    def test_one_measured_execution_clears_the_run(self):
        self.assertEqual(flags_for([V91_ZERO_MEASUREMENT, MEASURED_NO_VERDICT]), {})

    def test_a_failed_run_keeps_its_own_status_and_gets_no_extra_category(self):
        # _result_status already reports "failed"; this must not overwrite or add to it.
        crashed = execution(status="failed", error="boom", return_code=1)
        self.assertEqual(_result_status([crashed]), "failed")
        self.assertEqual(flags_for([crashed]), {})

    def test_no_executions_is_not_flagged_here(self):
        self.assertEqual(_unmeasured_completion("completed", []), {})

    def test_the_category_names_no_domain(self):
        category = NO_MEASUREMENT_FAILURE_CATEGORY.lower()
        for word in ("render", "novelty", "audit", "mitsuba", "hash"):
            self.assertNotIn(word, category)


if __name__ == "__main__":
    unittest.main()
