"""A handoff's own dataset reference decides where its blueprints read.

MEASURED ON cycle-a-20260919, 2026-09-29: handoffs that named no
dataset_root were run against the cycle bundle with the most CSVs. A runner
whose handoff checked ``support_topology_randomized_intervention_v1/episodes.csv``
was given the replanning bundle, read ITS episodes.csv and stopped on the pinned
SHA-256; four whose handoff checked a bare ``episodes.csv`` died looking for
another bundle's manifest.
"""
from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.analysis.python_stats_lib.handoff_selection import (  # noqa: E402
    _dataset_root_from_blueprint_references,
    _find_latest_handoff_from_cycle,
    _resolve_dataset_root,
    _select_analyst_handoff,
)


def _write(path: Path, text: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return hashlib.sha256(path.read_bytes()).hexdigest()


class HandoffDatasetRootTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        cycle = Path(self._tmp.name) / ".research-lab" / "datasets" / "cycle-a-x"
        self.sims = cycle / "simulations"
        self.replanning = self.sims / "replanning_recovery_support_factorial_v1"
        self.topology = self.sims / "support_topology_randomized_intervention_v1"
        self.replanning_sha = _write(self.replanning / "episodes.csv", "policy,success\nA,1\n")
        self.topology_sha = _write(self.topology / "episodes.csv", "policy,topology,success\nA,left,1\n")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_relative_reference_resolves_to_the_directory_that_contains_it(self):
        handoff = {
            "validation_code_blueprints": [
                {"dataset": "support_topology_randomized_intervention_v1/episodes.csv"}
            ]
        }
        root, source = _resolve_dataset_root(handoff, {}, self.replanning)
        self.assertEqual(root, self.topology)
        self.assertEqual(source, "handoff_blueprint_reference")

    def test_the_check_dataset_is_read_where_real_handoffs_put_it(self):
        # analyst-208/-215/-216 declared the file on handoff_checks, not on the
        # blueprint.
        handoff = {
            "handoff_checks": [{"dataset": "support_topology_randomized_intervention_v1/episodes.csv"}],
            "validation_code_blueprints": [{"blueprint_id": "BP_1"}],
        }
        self.assertEqual(_dataset_root_from_blueprint_references(handoff, self.replanning), self.topology)

    def test_a_bare_name_is_settled_by_the_pinned_hash(self):
        handoff = {
            "validation_code_blueprints": [{"dataset": "episodes.csv"}],
            "handoff_checks": [{"expected_sha256": self.topology_sha}],
        }
        root = _dataset_root_from_blueprint_references(handoff, self.replanning)
        self.assertEqual(root, self.topology)

    def test_a_set_aside_copy_inside_a_bundle_is_not_a_dataset(self):
        # cycle-a-20260919: the pinned file survived only inside the
        # engineer's attempt47_schema_mismatch/ folder of a regenerated bundle.
        stale_sha = _write(self.topology / "attempt47_schema_mismatch" / "episodes.csv", "superseded attempt")
        handoff = {
            "handoff_checks": [{"dataset": "episodes.csv", "sha256": stale_sha}],
        }
        self.assertIsNone(_dataset_root_from_blueprint_references(handoff, self.replanning))

    def test_an_ambiguous_reference_leaves_the_harness_choice(self):
        handoff = {"validation_code_blueprints": [{"dataset": "episodes.csv"}]}
        root, source = _resolve_dataset_root(handoff, {}, self.replanning)
        self.assertEqual(root, self.replanning)
        self.assertEqual(source, "harness_csv_root")

    def test_a_named_dataset_root_still_wins(self):
        handoff = {
            "dataset_root": str(self.replanning),
            "validation_code_blueprints": [
                {"dataset": "support_topology_randomized_intervention_v1/episodes.csv"}
            ],
        }
        root, source = _resolve_dataset_root(handoff, {}, self.topology)
        self.assertEqual(root, self.replanning)
        self.assertEqual(source, "handoff_dataset_root")

    def test_absolute_references_need_no_inference(self):
        handoff = {"validation_code_blueprints": [{"dataset": str(self.topology / "episodes.csv")}]}
        self.assertIsNone(_dataset_root_from_blueprint_references(handoff, self.replanning))


class SealedHandoffSelectionTest(unittest.TestCase):
    """A handoff the harness refused to seal is not a runner's to execute."""

    def test_the_newest_unrefused_handoff_is_chosen(self):
        import json
        import os
        import time

        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / ".research-lab"
            lanes = runtime / "lanes" / "cyc"
            good = lanes / "followup-analyst-01" / "handoff-validation-plan.json"
            refused = lanes / "followup-analyst-02" / "handoff-validation-plan.json"
            for path, payload in (
                (good, {"handoff_checks": [{"check_id": "ok"}]}),
                (refused, {"handoff_checks": [{"check_id": "bad"}], "handoff_seal": {"status": "rejected"}}),
            ):
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps(payload), encoding="utf-8")
            older = time.time() - 60
            os.utime(good, (older, older))
            role_plan_file = lanes / "followup-runner-01" / "role-plan.json"
            role_plan_file.parent.mkdir(parents=True)
            role_plan_file.write_text("{}", encoding="utf-8")

            latest = _find_latest_handoff_from_cycle({"cycle_id": "cyc"}, role_plan_file)
            self.assertEqual(latest["handoff_checks"][0]["check_id"], "ok")
            chosen = _select_analyst_handoff(
                {"handoff_checks": [{"check_id": "bad"}], "handoff_seal": {"status": "rejected"}},
                latest,
                role_plan_file,
            )
            self.assertEqual(chosen["handoff_checks"][0]["check_id"], "ok")

    def test_a_newer_handoff_with_disjoint_checks_does_not_replace_the_assignment(self):
        # MEASURED ON cycle-a-20260919, 2026-09-30: runners 40-66
        # embedded RECOVERY_MECHANISM_MAXT_01 but executed the newer handoff's
        # two support-removal checks, which then failed without their mappings.
        embedded = {
            "primary_hypothesis_id": "support_removal_dose_response_v1",
            "handoff_checks": [{"check_id": "RECOVERY_MECHANISM_MAXT_01"}],
            "validation_code_blueprints": [
                {"check_id": "RECOVERY_MECHANISM_MAXT_01"}
            ],
        }
        newer = {
            "primary_hypothesis_id": "support_removal_dose_response_v1",
            "handoff_checks": [
                {"check_id": "support-removal-dose-preregistered-v1"},
                {"check_id": "support-removal-per-arm-cost-v2"},
            ],
            "validation_code_blueprints": [
                {"check_id": "support-removal-dose-preregistered-v1"},
                {"check_id": "support-removal-per-arm-cost-v2"},
            ],
        }

        chosen = _select_analyst_handoff(embedded, newer, None)

        self.assertIs(chosen, embedded)


if __name__ == "__main__":
    unittest.main()
