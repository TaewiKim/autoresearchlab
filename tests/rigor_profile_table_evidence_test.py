"""rigor_profile must read the tables a blueprint EMITTED, not a truncated notes blob.

``_rigor_profile`` judged a run from ``json.dumps(_measured_quantities(...))``
alone. That blob truncates ``metrics.notes`` at ~200 characters, so which signals
were "found" depended on where in the note they happened to fall.

Measured on cycle-g-v85 followup-runner-08: the profile reported
``multi_seed: false, comparator: false`` for a run whose
``allocation_results_per_seed.csv`` holds 540 rows across five pinned seeds
(851-855) and three arms (uniform / aov_only / joint) -- because
``"seeds": [851, ...]`` sat past the cut while ``std_rmse_gain`` sat before it.
Replayed across all 18 v85 executions, the fix upgrades 5 lanes partial ->
supported and leaves the 7 that produced nothing at ``unsupported``.

That last part is the point of the second class below: this may only ever ADD
signal from real emitted rows. A lane with no tables, or a table with a single
seed value, must not be upgraded -- the fail-closed reading is what made the
reproducibility rubric honest in the first place.
"""

import csv
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_rigor", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_rigor"] = _mod
_spec.loader.exec_module(_mod)

BlueprintExecution = _mod.BlueprintExecution
_rigor_profile = _mod._rigor_profile
_table_rigor_evidence = _mod._table_rigor_evidence


def write_csv(directory: Path, name: str, header, rows):
    path = directory / name
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)
    return {
        "path": str(path),
        "name": name,
        "kind": "table",
        "suffix": ".csv",
        "size_bytes": path.stat().st_size,
    }


def execution(tables, *, notes="", status="completed"):
    return BlueprintExecution(
        blueprint_id="BP-RIGOR-01",
        check_id="CHK-RIGOR-01",
        status=status,
        script_path="/tmp/s.py",
        output_dir="/tmp/out",
        stdout_path="",
        stderr_path="",
        timeout_seconds=1494,
        duration_seconds=855.5,
        return_code=0,
        metrics={"pass_fail": "fail", "correlations": {"a_vs_b": 0.81}, "notes": notes},
        figures=[],
        tables=tables,
        error=None,
    )


# The shape followup-runner-08 wrote: five pinned seeds, three arms, one row each.
_V85_HEADER = ["scene", "edit_type", "severity", "seed", "method", "rmse", "std_rmse_gain"]
_V85_ROWS = [
    ["boxes", "emission", "0.15", str(seed), method, "0.03", "0.009"]
    for seed in (851, 852, 853, 854, 855)
    for method in ("uniform", "aov_only", "joint")
]
# Long enough that the seed list falls past the notes truncation, as it really did.
_V85_NOTES = (
    '{"allocation_pass": false, "allocation_tests": {"equal_total_spp_joint_vs_aov_only": '
    '{"bootstrap_mean_95ci": [-0.00037, 0.00074], "mean_rmse_gain": 0.00018, '
    '"std_rmse_gain": 0.00263, "wilcoxon_one_sided_p": 0.446}}, '
    '"seeds": [851, 852, 853, 854, 855]}'
)


class EmittedRowsAreRead(unittest.TestCase):
    def test_seeds_and_arms_come_from_the_csv_not_the_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            table = write_csv(Path(tmp), "allocation_results_per_seed.csv", _V85_HEADER, _V85_ROWS)
            profile = _rigor_profile([execution([table], notes=_V85_NOTES)])

        self.assertEqual(profile["reproducibility_grade"], "supported")
        self.assertEqual(profile["core_missing"], [])
        evidence = profile["table_evidence"]
        self.assertEqual(evidence["multi_seed"]["column"], "seed")
        self.assertEqual(evidence["multi_seed"]["distinct_values"], 5)
        self.assertEqual(evidence["comparator"]["column"], "method")
        self.assertEqual(evidence["comparator"]["arms"], ["aov_only", "joint", "uniform"])

    def test_the_note_alone_would_not_have_carried_it(self):
        """Same run, same note, no emitted table: the old understatement stands."""
        profile = _rigor_profile([execution([], notes=_V85_NOTES)])
        self.assertIn("multi_seed", profile["core_missing"])
        self.assertEqual(profile["table_evidence"]["tables_scanned"], 0)


class FailClosedIsPreserved(unittest.TestCase):
    def test_single_seed_is_not_multi_seed(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = [["boxes", "emission", "0.15", "851", "joint", "0.03", "0.009"]]
            table = write_csv(Path(tmp), "one_seed.csv", _V85_HEADER, rows)
            profile = _rigor_profile([execution([table])])
        self.assertIn("multi_seed", profile["core_missing"])
        self.assertNotIn("multi_seed", profile["table_evidence"])

    def test_a_lane_with_no_tables_stays_unsupported(self):
        profile = _rigor_profile([execution([], notes="native_available=False")])
        self.assertEqual(profile["reproducibility_grade"], "unsupported")

    def test_a_missing_file_is_recorded_not_raised(self):
        ghost = {
            "path": "/nonexistent/never_written.csv",
            "name": "never_written.csv",
            "kind": "table",
            "suffix": ".csv",
            "size_bytes": 10,
        }
        evidence = _table_rigor_evidence([execution([ghost])])
        self.assertEqual(evidence["tables_scanned"], 0)
        self.assertEqual(
            [s["table"] for s in evidence.get("skipped_tables", [])], ["never_written.csv"]
        )

    def test_non_tabular_artifacts_are_ignored(self):
        figure = {"path": "/tmp/plot.png", "name": "plot.png", "kind": "figure", "suffix": ".png"}
        evidence = _table_rigor_evidence([execution([figure])])
        self.assertEqual(evidence["tables_scanned"], 0)


if __name__ == "__main__":
    unittest.main()
