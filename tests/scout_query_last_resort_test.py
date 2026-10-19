"""A scout told to search must not die because its plan carries no search terms.

cycle-g-v85 dispatched followup-scout-15 and -42 with the task "search for
stronger competing hypothesis families, sharper falsification targets, and
literature that can overturn the current lead", and a role plan holding
focus_families [], assigned_hypotheses [], an empty frontier catalog, no
cycle_id and no absolute paths. The only English prose in the whole plan was the
workflow instruction itself.

Query derivation therefore extracted exactly that -- "adjudicate sharpened
blockers rescore current", "repaired audit targeted novelty adjudicate" -- and
the workflow-token filter correctly rejected both. The one on-topic string, the
cycle objective, contributed nothing: the phrase and token extractors are ASCII
word-based and that objective is Korean, so the boilerplate supplied every
candidate and the subject supplied none. `queries are required` raised, the lane
died, and the director redispatched it. The task file reads `[attempt 26]`.

The lead the task refers to was on disk the whole time. The task file names the
cycle even when the role plan does not.

The last clause of the fail-closed guard is kept on purpose: when there is
genuinely nothing to search for, the lane still refuses to run.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "literature" / "search.py"

_spec = importlib.util.spec_from_file_location("search_scout_queries", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["search_scout_queries"] = _mod
_spec.loader.exec_module(_mod)

_last_resort_queries = _mod._last_resort_queries
_cycle_id_from_task_file = _mod._cycle_id_from_task_file

CYCLE = "cycle-g-v85-20260826"
LEAD = ("Test whether a leakage-free pre-action residual and support proxy predicts the "
        "local-recompute crossover and policy regret beyond changed-region AOVs and a "
        "faithful Residual Path Integrals baseline.")

# The v85 shape: metadata header, objective line, workflow-only task line.
TASK_MD = (
    "# Autonomous Follow-up Task for scout\n\n"
    f"- cycle_id: {CYCLE}\n"
    "- objective: computer graphics rendering algorithm research\n"
    "- role: scout\n"
    "- task: Restart from the gatekeeper's objections by searching for stronger "
    "competing hypothesis families. [attempt 26]\n"
)


class Fixture:
    def __init__(self, *, with_hypothesis=True, task_md=TASK_MD):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / "state"
        self.lane_out = self.state / "followup-scout-42"
        self.lane_out.mkdir(parents=True)
        self.task = self.tmp / "task.md"
        if task_md is not None:
            self.task.write_text(task_md, encoding="utf-8")
        if with_hypothesis:
            (self.state / f"{CYCLE}-lab-director-hypothesis.json").write_text(json.dumps({
                "statement": LEAD,
                "primary_family": "edit_region_residual_rerendering",
                "why_selected": "Different estimator family from the rejected incumbent.",
            }), encoding="utf-8")

    def run(self, role_plan):
        return _last_resort_queries(self.lane_out, self.task if self.task.exists() else None, role_plan)

    def cleanup(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)


class TheCycleIsFoundThroughTheTaskFile(unittest.TestCase):
    def test_cycle_id_is_read_from_the_task_file(self):
        f = Fixture()
        try:
            self.assertEqual(_cycle_id_from_task_file(f.task), CYCLE)
        finally:
            f.cleanup()

    def test_no_task_file_is_not_an_error(self):
        self.assertEqual(_cycle_id_from_task_file(None), "")
        self.assertEqual(_cycle_id_from_task_file(Path("/nonexistent/task.md")), "")


class QueriesComeFromTheCurrentLead(unittest.TestCase):
    def test_the_lead_beats_the_objective(self):
        f = Fixture()
        try:
            queries, source = f.run({"objective": "computer graphics"})
            self.assertEqual(source, f"lab-director-hypothesis:{CYCLE}")
            self.assertTrue(queries)
            joined = " ".join(queries).lower()
            # On-topic terms out of the lead, not workflow vocabulary out of the task.
            self.assertIn("residual", joined)
            for workflow_word in ("adjudicate", "rescore", "blockers", "attempt"):
                self.assertNotIn(workflow_word, joined)
        finally:
            f.cleanup()

    def test_the_objective_is_used_when_no_lead_exists_yet(self):
        f = Fixture(with_hypothesis=False)
        try:
            queries, source = f.run({"objective": "computer graphics rendering research"})
            self.assertEqual(source, "cycle-objective")
            self.assertTrue(queries)
        finally:
            f.cleanup()


class TheFailClosedGuardSurvives(unittest.TestCase):
    def test_nothing_to_search_still_yields_nothing(self):
        f = Fixture(with_hypothesis=False)
        try:
            queries, source = f.run({})
            self.assertEqual(queries, [])
            self.assertEqual(source, "")
        finally:
            f.cleanup()

    def test_an_unreadable_hypothesis_file_falls_through(self):
        f = Fixture(with_hypothesis=False)
        try:
            (f.state / f"{CYCLE}-lab-director-hypothesis.json").write_text("{not json", encoding="utf-8")
            queries, source = f.run({"objective": "computer graphics rendering research"})
            self.assertEqual(source, "cycle-objective")
        finally:
            f.cleanup()

    def test_an_empty_statement_falls_through(self):
        f = Fixture(with_hypothesis=False)
        try:
            (f.state / f"{CYCLE}-lab-director-hypothesis.json").write_text(
                json.dumps({"statement": "", "primary_family": ""}), encoding="utf-8")
            queries, source = f.run({"objective": "computer graphics rendering research"})
            self.assertEqual(source, "cycle-objective")
        finally:
            f.cleanup()


INVENTORY = {
    "verified_instruments": [
        "procedural_scene_render", "seed_pinned_reproducibility",
        "matched_sample_budget_control", "converged_reference_and_error_metric",
    ],
    "measurable_quantities": [
        "image error against a high-spp converged reference (RMSE, PSNR)",
        "quality at a matched sample budget, and wall-clock cost per budget",
        "across-seed spread of any derived statistic (pinned, bitwise reproducible)",
        "per-pixel estimator variance and its spatial distribution",
    ],
    "renderer": {"available": True, "package": "mitsuba", "version": "3.8.0"},
}

# What the gate-restart dispatcher stamps on an explore-mode scout.
OPEN_SEARCH_PLAN = {
    "objective": "computer graphics rendering research",
    "planner_metadata": {
        "novelty_mode": "gate-restart-regeneration",
        "selection_scope": "gate-restart-open-search",
    },
}


class ExploreScoutsSearchTheSpaceNotTheLead(unittest.TestCase):
    """dispatch.rs empties assigned_selected_hypotheses in explore mode on
    purpose. Anchoring the fallback on the lead would defeat exactly that."""

    def _fixture(self, *, with_inventory=True):
        f = Fixture()
        if with_inventory:
            (f.state / f"{CYCLE}-instrument-inventory.json").write_text(
                json.dumps(INVENTORY), encoding="utf-8")
        return f

    def test_open_search_is_recognised_from_either_key(self):
        self.assertTrue(_mod._role_plan_is_open_search(OPEN_SEARCH_PLAN))
        self.assertTrue(_mod._role_plan_is_open_search(
            {"planner_metadata": {"selection_scope": "gate-restart-open-search"}}))
        self.assertTrue(_mod._role_plan_is_open_search(
            {"planner_metadata": {"novelty_mode": "gate-restart-regeneration"}}))
        self.assertFalse(_mod._role_plan_is_open_search({"planner_metadata": {}}))
        self.assertFalse(_mod._role_plan_is_open_search({}))
        self.assertFalse(_mod._role_plan_is_open_search(None))

    def test_the_measured_space_wins_over_the_lead(self):
        f = self._fixture()
        try:
            queries, source = f.run(OPEN_SEARCH_PLAN)
            self.assertEqual(source, f"instrument-space:{CYCLE}")
            joined = " ".join(queries).lower()
            self.assertIn("mitsuba", joined)
            self.assertIn("converged reference", joined)
            # The lead file exists and is deliberately NOT used here.
            self.assertNotIn("leakage", joined)
            self.assertNotIn("residual path integrals", joined)
        finally:
            f.cleanup()

    def test_a_converging_scout_still_gets_the_lead(self):
        f = self._fixture()
        try:
            queries, source = f.run({"objective": "computer graphics rendering research"})
            self.assertEqual(source, f"lab-director-hypothesis:{CYCLE}")
            self.assertIn("residual", " ".join(queries).lower())
        finally:
            f.cleanup()

    def test_no_inventory_falls_back_rather_than_failing(self):
        f = self._fixture(with_inventory=False)
        try:
            queries, source = f.run(OPEN_SEARCH_PLAN)
            self.assertEqual(source, f"lab-director-hypothesis:{CYCLE}")
            self.assertTrue(queries)
        finally:
            f.cleanup()

    def test_an_inventory_with_nothing_measurable_falls_through(self):
        f = self._fixture(with_inventory=False)
        try:
            (f.state / f"{CYCLE}-instrument-inventory.json").write_text(
                json.dumps({"measurable_quantities": [], "verified_instruments": []}),
                encoding="utf-8")
            queries, source = f.run(OPEN_SEARCH_PLAN)
            self.assertEqual(source, f"lab-director-hypothesis:{CYCLE}")
        finally:
            f.cleanup()


if __name__ == "__main__":
    unittest.main()
