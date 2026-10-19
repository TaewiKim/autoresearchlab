"""A blueprint's inputs fail loudly and usefully, not silently.

Regression guard for cycle-g-v91, 2026-09-14. followup-runner-103 to -109 each
stopped within two seconds with "column_mapping missing semantic keys": the
script read another runner's table, and the analyst never declared which of that
table's columns held which concept. The error said which keys were missing, but
not what the table's columns actually were, and three successive handoffs kept
the defect. followup-runner-110 then "completed" a code field that was a single
comment pointing at a file stored elsewhere.
"""

import json
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

MAPPING_PREFLIGHT = textwrap.dedent("""
    import json, os
    spec = json.load(open(os.environ["RESEARCHLAB_CHECK_SPEC"]))
    mapping = spec.get("column_mapping") or {}
    needed = {"family", "phase", "nrmse"}
    missing = sorted(needed - set(mapping))
    if missing:
        raise ValueError(f"column_mapping missing semantic keys: {missing}")
    print(json.dumps({"ok": 1}))
""")

MEASURES = textwrap.dedent("""
    import json
    print(json.dumps({"gain": 0.02, "pass_fail": "pass"}))
""")

RESOLVES_PINNED_PRIOR_ARTIFACT = textwrap.dedent("""
    import json, os
    from pathlib import Path
    root = Path(os.environ["RESEARCHLAB_PRIOR_ARTIFACTS_ROOT"])
    marker = json.loads((root / ".sealed.json").read_text(encoding="utf-8"))
    artifact = root / marker["data_file"]
    if marker["sha256"] != "c4f368f1c6d906548bfadc073526ab7e7b463031eaddd4802cdf979c829c63a3":
        raise ValueError("wrong pinned artifact")
    if not artifact.is_file():
        raise ValueError("pinned artifact is absent")
    print(json.dumps({"pass_fail": "pass", "artifact": artifact.name}))
""")


class BlueprintInputContractTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.stats = Path(self._tmp.name) / ".research-lab" / "artifacts" / "stats" / "cg-cycle"
        (self.stats / "followup-runner-01" / "blueprints" / "producer").mkdir(parents=True)
        (self.stats / "followup-runner-01" / "blueprints" / "producer" / "master_table.csv").write_text(
            "family_id,phase_index,stale_reuse_nrmse\nf1,0,0.1\n", encoding="utf-8"
        )
        self.csv_root = Path(self._tmp.name) / "csv"
        self.csv_root.mkdir()

    def tearDown(self):
        self._tmp.cleanup()

    def run_blueprint(self, code, dataset=None):
        raw = {"dataset": dataset} if dataset else {}
        blueprint = Blueprint("BP-01", "CHK-01", code, None, dataset, None, raw=raw)
        return blueprint_run._run_blueprint(
            blueprint,
            csv_root=self.csv_root,
            output_root=self.stats / "followup-runner-02",
            timeout_seconds=60,
            derived_indicators_for_blueprint=[],
        )

    def test_a_comment_pointing_at_a_file_is_refused_not_completed(self):
        execution = self.run_blueprint(
            "# Complete reviewed source is stored at /somewhere/else/analysis_v3.py\n"
        )
        self.assertEqual(execution.status, "failed")
        self.assertIn("blueprint_has_no_executable_source", execution.error)
        self.assertIsNone(execution.return_code, "the script must not have been run")

    def test_a_docstring_alone_is_also_no_source(self):
        execution = self.run_blueprint('"""the real analysis lives elsewhere"""\n')
        self.assertEqual(execution.status, "failed")
        self.assertIn("blueprint_has_no_executable_source", execution.error)

    def test_a_mapping_failure_names_the_columns_of_the_table_it_reads(self):
        execution = self.run_blueprint(
            MAPPING_PREFLIGHT, dataset="artifact://followup-runner-01/master_table.csv"
        )
        self.assertEqual(execution.status, "failed")
        self.assertIn("column_mapping missing semantic keys", execution.error)
        for column in ("family_id", "phase_index", "stale_reuse_nrmse"):
            self.assertIn(column, execution.error)

    def test_a_mapping_failure_without_a_resolvable_table_is_left_as_the_script_reported_it(self):
        execution = self.run_blueprint(MAPPING_PREFLIGHT, dataset="artifact://followup-runner-99/absent.csv")
        self.assertEqual(execution.status, "failed")
        self.assertIn("column_mapping missing semantic keys", execution.error)
        self.assertNotIn("has columns", execution.error)

    def test_a_script_that_measures_is_unaffected(self):
        execution = self.run_blueprint(MEASURES, dataset="artifact://followup-runner-01/master_table.csv")
        self.assertEqual(execution.status, "completed")
        self.assertIsNone(execution.error)

    def test_hash_pinned_prior_artifact_uses_its_cycle_sealed_snapshot(self):
        # MEASURED ON cycle-a-20260919, 2026-10-14: runner 288's
        # eval_log.json existed in the sealed snapshot, outside its stats-only
        # RESEARCHLAB_PRIOR_ARTIFACTS_ROOT, so the reuse audit found zero files.
        artifact_hash = "c4f368f1c6d906548bfadc073526ab7e7b463031eaddd4802cdf979c829c63a3"
        sealed = (
            Path(self._tmp.name)
            / ".research-lab"
            / "sealed-datasets"
            / "cg-cycle"
            / f"{artifact_hash[:16]}-pusht_anchor_attempt65d"
        )
        sealed.mkdir(parents=True)
        (sealed / "eval_log.json").write_text("{}\n", encoding="utf-8")
        (sealed / ".sealed.json").write_text(
            json.dumps({"data_file": "eval_log.json", "sha256": artifact_hash}),
            encoding="utf-8",
        )
        blueprint = Blueprint(
            "BP-PUSHT-OFFICIAL-AUDIT-01",
            "CHECK-PUSHT-OFFICIAL-ANCHOR-01",
            RESOLVES_PINNED_PRIOR_ARTIFACT,
            None,
            "official-real-stanford-pusht-eval-log",
            None,
            raw={"column_mapping": {"artifact_filename": "eval_log.json", "artifact_sha256": artifact_hash}},
        )

        execution = blueprint_run._run_blueprint(
            blueprint,
            csv_root=self.csv_root,
            output_root=self.stats / "followup-runner-288",
            timeout_seconds=60,
            derived_indicators_for_blueprint=[],
        )

        self.assertEqual(execution.status, "completed")
        self.assertIsNone(execution.error)


if __name__ == "__main__":
    unittest.main()
