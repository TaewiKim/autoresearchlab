"""Regression coverage for completed runs mislabelled by quality summaries."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rigor_profile_table_evidence_test import execution, write_csv, _mod


class QualityExpressions(unittest.TestCase):
    def summary(self, values, requirement="canonical_resolution_fraction=1.0"):
        runs = []
        for value in values:
            run = execution([])
            run.metrics["pass_fail"] = "pass"
            run.metrics["checks"] = {} if value is None else {"canonical_resolution_fraction": value}
            runs.append(run)
        return _mod._validation_summary(runs, {
            "analyst_quality_standard": {"required_validation_checks": [requirement]},
        })

    def test_actual_fraction_passes_and_records_raw_value(self):
        summary = self.summary([1.0])
        self.assertEqual(summary["overall_status"], "passed")
        quality = summary["analyst_quality_standard"]
        self.assertTrue(quality["satisfied"])
        self.assertEqual(quality["evaluated_requirements"][0]["observed_values"], [1.0])

    def test_nonzero_fraction_is_not_promoted_by_boolean_coercion(self):
        summary = self.summary([0.5])
        self.assertTrue(summary["checks"]["canonical_resolution_fraction"])
        self.assertFalse(summary["analyst_quality_standard"]["satisfied"])

    def test_missing_boolean_and_nonfinite_values_fail_closed(self):
        for value in [None, True, float("nan"), float("inf")]:
            with self.subTest(value=value):
                self.assertFalse(self.summary([value])["analyst_quality_standard"]["satisfied"])

    def test_conflicting_blueprints_do_not_overwrite_a_failure(self):
        self.assertFalse(self.summary([0.5, 1.0])["analyst_quality_standard"]["satisfied"])

    def test_comparators_and_boolean_literals_are_enforced(self):
        self.assertTrue(self.summary([0.9], "canonical_resolution_fraction>=0.8")["analyst_quality_standard"]["satisfied"])
        self.assertFalse(self.summary([0.7], "canonical_resolution_fraction>=0.8")["analyst_quality_standard"]["satisfied"])
        self.assertTrue(self.summary([True], "canonical_resolution_fraction=true")["analyst_quality_standard"]["satisfied"])
        self.assertFalse(self.summary([False], "canonical_resolution_fraction=true")["analyst_quality_standard"]["satisfied"])


class RoboticsRigor(unittest.TestCase):
    def test_training_evaluation_and_analysis_seeds_remain_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tables = [
                write_csv(root, "seed_lineage_slopes.csv", ["eval_seed", "checkpoint_lineage", "slope"],
                          [[i, f"train_seed_{j}", 0.3] for i in range(10) for j in [11, 23, 37]]),
                write_csv(root, "effect.csv", ["analysis_seed", "estimate", "se", "lower", "upper"],
                          [[i, 0.354, 0.02, 0.3, 0.4] for i in range(5)]),
                write_csv(root, "competence.csv", ["loss_family", "refinement_steps", "success_rate"],
                          [[family, steps, 0.5] for family in ["denoising", "consistency_flow"] for steps in [1, 4]]),
            ]
            profile = _mod._rigor_profile([execution(tables)])
        self.assertEqual(profile["reproducibility_grade"], "supported")
        dimensions = profile["table_evidence"]["seed_dimensions"]
        self.assertEqual(dimensions["eval_seed"]["distinct_values"], 10)
        self.assertEqual(dimensions["checkpoint_lineage"]["distinct_values"], 3)
        self.assertEqual(dimensions["analysis_seed"]["distinct_values"], 5)
        self.assertNotIn("affordable_here", profile)

    def test_analysis_randomness_alone_is_not_independent_replication(self):
        with tempfile.TemporaryDirectory() as tmp:
            table = write_csv(Path(tmp), "bootstrap.csv", ["analysis_seed", "estimate"], [[i, 0.3] for i in range(5)])
            profile = _mod._rigor_profile([execution([table])])
        self.assertFalse(profile["signals"]["multi_seed"])


if __name__ == "__main__":
    unittest.main()
