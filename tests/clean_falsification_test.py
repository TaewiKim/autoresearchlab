"""A falsified hypothesis is evidence, not a broken blueprint.

Regression guard for the v85 aggregation bug. The analyst standard asks for the
distinction in its own words -- "a clean scientific fail is resolved evidence;
ambiguous or incomplete output is not" -- and sets
``require_all_handoff_checks_pass=false`` to permit it. The driver did not make
it: any ``pass_fail="fail"`` counted as a blueprint FAILURE.

Measured on cycle-g-v85 (2026-08-26): followup-runner-06/08/09 exited 0 after
855s of real Mitsuba, emitted six CSVs plus a figure, and correctly falsified
their own joint-signal hypothesis (Wilcoxon p=8.7e-17 against uniform, p=0.446
against the aov-only arm). All three were stamped ``status: failed``. The
Gatekeeper then wrote "the cited primary follow-up artifact failed and does not
verify the claimed tables", scoring the label instead of the science, and three
further lanes died looking for ``benchmark_results.csv`` -- a table those
"failed" lanes had in fact written.

The guard cuts both ways: the v63 shape (``pass_fail="fail"`` with no tables and
inf metrics, from ``Plugin "h_rps" not found``) must STAY a failure. Loosening
that is what cost v61/v62/v63 their entire review budgets.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_falsification", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_falsification"] = _mod
_spec.loader.exec_module(_mod)

BlueprintExecution = _mod.BlueprintExecution
_execution_hard_failed = _mod._execution_hard_failed
_execution_produced_evidence = _mod._execution_produced_evidence
_execution_is_clean_falsification = _mod._execution_is_clean_falsification
_execution_resolution = _mod._execution_resolution
_result_status = _mod._result_status


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
        duration_seconds=855.5,
        return_code=return_code,
        metrics=metrics or {},
        figures=[],
        tables=[] if tables is None else tables,
        error=error,
    )


_TABLES = [
    {"name": "allocation_results_per_seed.csv", "path": "/tmp/out/allocation_results_per_seed.csv"},
    {"name": "summary_metrics.csv", "path": "/tmp/out/summary_metrics.csv"},
]

# The exact shape followup-runner-08 produced: exit 0, six tables, finite
# correlations, and an honest "the joint signal did not beat the simpler ones".
V85_CLEAN_FALSIFICATION = execution(
    metrics={
        "check_id": "CHK-VAR-AOV-HELDOUT-ALLOC-01",
        "pass_fail": "fail",
        "correlations": {
            "aov_change_tile_vs_residual_magnitude": 0.8153405551603713,
            "joint_score_vs_residual_magnitude": 0.8206745395432207,
            "pre_edit_variance_tile_vs_residual_magnitude": 0.5160837251866758,
        },
        "evidence_grade": {"heldout_prediction_link": "weak"},
        "notes": (
            '{"allocation_pass": false, "prediction_pass": false, '
            '"unchanged_control_pass": true, "equal_wall_fair": true, '
            '"seeds": [851, 852, 853, 854, 855], "joint_mean_auroc": 0.929, '
            '"variance_mean_auroc": 0.955}'
        ),
    },
    tables=_TABLES,
)

# The v63 shape: same pass_fail, but nothing underneath it.
V63_PLUGIN_MISSING = execution(
    metrics={
        "correlations": {},
        "pass_fail": "fail",
        "notes": (
            'native_available=False; mass_error=inf; relative_bias=inf; '
            'errors=[\'h_rps probe failed: failed to instantiate unknown plugin '
            'of type "h_rps": Plugin "h_rps" not found!\']'
        ),
    },
)


class CleanFalsificationIsEvidence(unittest.TestCase):
    def test_falsification_with_tables_is_not_a_hard_failure(self):
        self.assertTrue(_execution_is_clean_falsification(V85_CLEAN_FALSIFICATION))
        self.assertFalse(_execution_hard_failed(V85_CLEAN_FALSIFICATION))

    def test_falsification_counts_as_produced_evidence(self):
        self.assertTrue(_execution_produced_evidence(V85_CLEAN_FALSIFICATION))

    def test_falsification_resolves_its_handoff_check(self):
        resolution = _execution_resolution(V85_CLEAN_FALSIFICATION)
        self.assertTrue(resolution["resolved"])
        # Declared vs inferred stays auditable: the blueprint never said so.
        self.assertFalse(resolution["valid_falsification_result"])
        self.assertTrue(resolution["inferred_clean_falsification"])

    def test_lane_status_is_completed(self):
        self.assertEqual(_result_status([V85_CLEAN_FALSIFICATION]), "completed")


class UnbackedFailureStaysAFailure(unittest.TestCase):
    def test_v63_plugin_missing_is_still_hard_failed(self):
        self.assertFalse(_execution_is_clean_falsification(V63_PLUGIN_MISSING))
        self.assertTrue(_execution_hard_failed(V63_PLUGIN_MISSING))
        self.assertFalse(_execution_produced_evidence(V63_PLUGIN_MISSING))
        self.assertEqual(_result_status([V63_PLUGIN_MISSING]), "failed")

    def test_verdict_with_no_tables_is_not_clean(self):
        """A "fail" with finite numbers but nothing written down is incomplete."""
        bare = execution(
            metrics={"pass_fail": "fail", "correlations": {"a_vs_b": 0.5}},
            tables=[],
        )
        self.assertFalse(_execution_is_clean_falsification(bare))
        self.assertTrue(_execution_hard_failed(bare))

    def test_nonzero_return_code_is_not_clean(self):
        crashed = execution(
            metrics={"pass_fail": "fail", "correlations": {"a_vs_b": 0.5}},
            tables=_TABLES,
            return_code=1,
        )
        self.assertFalse(_execution_is_clean_falsification(crashed))
        self.assertTrue(_execution_hard_failed(crashed))

    def test_timeout_is_not_clean(self):
        timed_out = execution(
            status="timeout",
            metrics={"design_overrun": True, "wall_clock_budget_seconds": 1494},
            tables=_TABLES,
            return_code=None,
            error="timeout after 1494s (design_overrun: budget=1494s)",
        )
        self.assertFalse(_execution_is_clean_falsification(timed_out))
        self.assertTrue(_execution_hard_failed(timed_out))

    def test_inf_metrics_are_not_clean(self):
        degenerate = execution(
            metrics={
                "pass_fail": "fail",
                "correlations": {"a_vs_b": 0.5},
                "notes": "relative_bias=inf; mass_error=inf",
            },
            tables=_TABLES,
        )
        self.assertFalse(_execution_is_clean_falsification(degenerate))
        self.assertTrue(_execution_hard_failed(degenerate))


class PassingRunsAreUnaffected(unittest.TestCase):
    def test_a_passing_execution_keeps_its_verdict(self):
        passing = execution(
            metrics={"pass_fail": "pass", "correlations": {"a_vs_b": 0.81}},
            tables=_TABLES,
        )
        self.assertFalse(_execution_hard_failed(passing))
        self.assertTrue(_execution_produced_evidence(passing))
        self.assertTrue(_execution_resolution(passing)["resolved"])
        self.assertFalse(_execution_resolution(passing)["inferred_clean_falsification"])


# The shape v86's followup-runner-10/-16/-17/-19 produced: exit 0, nine emitted
# tables, eight finite numbers at the TOP LEVEL of metrics, and the
# `resolution_status` the contract asks a falsifying run to declare. All four
# were called failures.
V86_DECLARED_FALSIFICATION = execution(
    metrics={
        "check_id": "conformal-risk-comparator-v1",
        "pass_fail": "fail",
        "resolution_status": "valid_falsification",
        "matched_width_wilcoxon_p": 0.03125,
        "rich_coverage_across_seed_std": 0.007494157103323917,
        "matched_width_improvement_seed_count": 5,
        "notes": (
            "Resolved comparator-aware LOSO and held-condition-out conformal coverage; "
            "a scientific fail is a valid falsification, not an execution failure."
        ),
    },
    tables=_TABLES,
)


class ADeclaredFalsificationIsHonoured(unittest.TestCase):
    """The contract asks the blueprint to label it; the resolution layer accepts
    the label; the failure layer must agree, or the three disagree about the same
    run -- which is what v86 did on four lanes at once."""

    def test_the_declared_label_is_enough(self):
        self.assertTrue(_execution_is_clean_falsification(V86_DECLARED_FALSIFICATION))
        self.assertFalse(_execution_hard_failed(V86_DECLARED_FALSIFICATION))
        self.assertEqual(_result_status([V86_DECLARED_FALSIFICATION]), "completed")

    def test_resolution_and_failure_layers_agree(self):
        resolution = _execution_resolution(V86_DECLARED_FALSIFICATION)
        self.assertTrue(resolution["resolved"])
        self.assertFalse(_execution_hard_failed(V86_DECLARED_FALSIFICATION))

    def test_a_label_cannot_rescue_a_crash(self):
        crashed = execution(
            metrics={"pass_fail": "fail", "resolution_status": "valid_falsification"},
            tables=_TABLES,
            return_code=1,
        )
        self.assertFalse(_execution_is_clean_falsification(crashed))
        self.assertTrue(_execution_hard_failed(crashed))

    def test_a_label_cannot_rescue_an_unrunnable_method(self):
        # The v63 shape wearing the label it never actually earned.
        degenerate = execution(
            metrics={
                "pass_fail": "fail",
                "resolution_status": "valid_falsification",
                "notes": 'mass_error=inf; Plugin "h_rps" not found!',
            },
            tables=_TABLES,
        )
        self.assertFalse(_execution_is_clean_falsification(degenerate))
        self.assertTrue(_execution_hard_failed(degenerate))


class TopLevelNumbersCount(unittest.TestCase):
    """A falsification's boolean checks are all False by definition, so the
    sources _execution_has_finite_signal used to read go quiet exactly when it
    matters. v86 put eight finite measurements on `metrics` itself."""

    def test_a_plain_numeric_metric_is_a_signal(self):
        measured = execution(
            metrics={"pass_fail": "fail", "matched_width_wilcoxon_p": 0.03125},
            tables=_TABLES,
        )
        self.assertTrue(_execution_is_clean_falsification(measured))

    def test_pass_fail_and_the_label_are_not_themselves_signals(self):
        bare = execution(metrics={"pass_fail": "fail"}, tables=_TABLES)
        self.assertFalse(_execution_is_clean_falsification(bare))
        self.assertTrue(_execution_hard_failed(bare))

    def test_an_infinite_metric_is_not_a_signal(self):
        degenerate = execution(
            metrics={"pass_fail": "fail", "relative_bias": float("inf")},
            tables=_TABLES,
        )
        self.assertFalse(_execution_is_clean_falsification(degenerate))


class ThePrimaryContrastTableIsAMeasurement(unittest.TestCase):
    """cycle-a-20260919, 2026-10-18: fifteen runners wrote the
    contract's primary_contrasts.csv with finite estimates and metrics of only
    pass_fail and notes; each was stamped no_measurement_produced."""

    def _table(self, rows):
        import csv
        import tempfile

        handle = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, newline="", encoding="utf-8")
        with handle:
            writer = csv.DictWriter(handle, fieldnames=["contrast_id", "estimate", "simultaneous_lower", "simultaneous_upper"])
            writer.writeheader()
            writer.writerows(rows)
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        return [{"name": "primary_contrasts.csv", "path": handle.name}]

    def test_a_finite_estimate_in_the_table_is_evidence(self):
        tables = self._table([{"contrast_id": "dp_r030", "estimate": "0.89921875", "simultaneous_lower": "0.158", "simultaneous_upper": "1.64"}])
        run = execution(metrics={"pass_fail": "pass", "notes": "Primary estimate met the margin."}, tables=tables)
        self.assertTrue(_execution_produced_evidence(run))
        self.assertEqual(_mod._unmeasured_completion("completed", [run]), {})

    def test_a_table_without_a_number_is_not(self):
        tables = self._table([{"contrast_id": "dp_r030", "estimate": "", "simultaneous_lower": "", "simultaneous_upper": ""}])
        run = execution(metrics={"pass_fail": "inconclusive"}, tables=tables)
        self.assertFalse(_execution_produced_evidence(run))
        self.assertEqual(_mod._unmeasured_completion("completed", [run])["failure_category"], "no_measurement_produced")


if __name__ == "__main__":
    unittest.main()
