"""A handoff check's column_mapping reaches the blueprint as a dict.

Regression guard for cycle-b-20260918, 2026-09-19. The analyst response
schema had no column_mapping field (additionalProperties false), so no analyst
could send the mapping its own script demanded; followup-runner-70..76 each died
on "handoff check requires a non-empty column_mapping". The schema now carries
it as [{key, column}] pairs, and the driver hands the script {key: column}.
"""

import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
sys.path.insert(0, str(PROJECT / "drivers" / "analysis"))
from drivers.analysis.python_stats_lib.blueprint_model import _collect_blueprints, _column_mapping_dict

CODE = "import json, os\nspec = json.load(open(os.environ['RESEARCHLAB_CHECK_SPEC']))\n"


class HandoffColumnMappingPairsTest(unittest.TestCase):
    def test_pairs_from_the_schema_become_the_dict_the_script_reads(self):
        handoff = {
            "handoff_checks": [{
                "check_id": "CHK-GUARD-RESIDUAL-THRESHOLD-01",
                "dataset": ".research-lab/datasets/c/simulations/o/episodes.csv",
                "column_mapping": [
                    {"key": "checkpoint", "column": "checkpoint"},
                    {"key": "pose_bin", "column": "realized_pose_bin"},
                    {"key": "", "column": "ignored"},
                ],
            }],
            "validation_code_blueprints": [{"check_id": "CHK-GUARD-RESIDUAL-THRESHOLD-01", "code": CODE}],
        }
        [blueprint] = _collect_blueprints(handoff)
        self.assertEqual(
            blueprint.raw["column_mapping"],
            {"checkpoint": "checkpoint", "pose_bin": "realized_pose_bin"},
        )

    def test_a_dict_passes_through_and_an_empty_list_counts_as_missing(self):
        self.assertEqual(_column_mapping_dict({"a": "b"}), {"a": "b"})
        self.assertEqual(_column_mapping_dict([]), {})
        self.assertIsNone(_column_mapping_dict(None))


if __name__ == "__main__":
    unittest.main()
