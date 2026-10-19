"""The generic render baseline runs once per cycle, not once per lead.

Measured on cycle-g-v85: 12 of 28 runner lanes ran the byte-identical
adaptive-vs-uniform blueprint -- one sha256, twelve executions -- stamped with
four different lead names. Six carried the then-current lead, which is why three
gatekeepers at 14:20 all scored that lead as having no successful validation
result. They were right: nothing had tested it.

The template says of itself "A hypothesis-specific design must come from the
analyst", and then returned before the analyst got a chance: for any CG objective
the requirement-driven builder short-circuited to it unconditionally, using the
director's hypothesis only to name the check.

It cannot just be deleted -- without it the analyst emits no executable handoff,
the runner gate never dispatches, and the director spins up analysts forever.
So the first one still runs, and the tests below pin both halves: it runs when
nothing has proven the renderer yet, and it stops once something has.
"""

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "literature" / "search.py"

_spec = importlib.util.spec_from_file_location("search_cs_baseline", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["search_cs_baseline"] = _mod
_spec.loader.exec_module(_mod)

_cs_baseline_decision = _mod._cs_baseline_decision
_cs_analyst_design_request = _mod._cs_analyst_design_request
_cs_cycle_stats_root = _mod._cs_cycle_stats_root

LEAD = "hyp-director-primary-family-edit-region-residual-rerendering"
BASELINE_CHECK = "hyp_director_something_render_quality_convergence_01"


def role_plan_for(tmp: Path, cycle_id="cycle-g-v99-20260826"):
    """A role plan carrying the absolute state paths a real one carries."""
    runtime = tmp / ".research-lab"
    (runtime / "state").mkdir(parents=True, exist_ok=True)
    return {
        "lane_id": "followup-analyst-40",
        "objective_domain": "cs",
        "planner_metadata": {
            "instrument_inventory": {
                "source_path": str(runtime / "state" / f"{cycle_id}-instrument-inventory.json"),
            },
        },
    }


def write_lane(tmp: Path, cycle_id, lane, *, check_ids, overall, bound_to=None):
    d = tmp / ".research-lab" / "artifacts" / "stats" / cycle_id / lane
    d.mkdir(parents=True, exist_ok=True)
    summary = {"overall_status": overall}
    if bound_to is not None:
        summary["hypothesis_alignment"] = {
            "bound_to_handed_hypothesis": True,
            "handed_hypothesis_id": bound_to,
        }
    (d / "result.json").write_text(json.dumps({
        "blueprint_executions": [{"check_id": c} for c in check_ids],
        "validation_summary": summary,
    }), encoding="utf-8")


class TheFirstBaselineStillRuns(unittest.TestCase):
    """The deadlock this template prevents must stay prevented."""

    def test_emits_when_nothing_has_run_yet(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            decision = _cs_baseline_decision(role_plan_for(tmp), LEAD)
            self.assertTrue(decision["emit_baseline"])
            self.assertEqual(decision["reason"], "first_capability_baseline_of_the_cycle")

    def test_emits_when_the_cycle_cannot_be_located(self):
        # cycle-g-v85's analyst-01 and analyst-02 carry no absolute paths at all.
        # That is exactly the start of a cycle, when emitting is correct -- and a
        # measurement we cannot take must never silently become a new policy.
        decision = _cs_baseline_decision({"lane_id": "analyst-01", "objective_domain": "cs"}, LEAD)
        self.assertTrue(decision["emit_baseline"])
        self.assertEqual(decision["reason"], "no_cycle_context_available")

    def test_a_baseline_that_did_not_pass_does_not_count(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            cycle = "cycle-g-v99-20260826"
            write_lane(tmp, cycle, "followup-runner-03",
                       check_ids=[BASELINE_CHECK], overall="degraded")
            decision = _cs_baseline_decision(role_plan_for(tmp, cycle), LEAD)
            self.assertTrue(decision["emit_baseline"], decision)


class AfterThatItAsksForTheDesign(unittest.TestCase):
    def test_withholds_once_a_baseline_has_passed(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            cycle = "cycle-g-v99-20260826"
            write_lane(tmp, cycle, "followup-runner-03",
                       check_ids=[BASELINE_CHECK], overall="passed")
            decision = _cs_baseline_decision(role_plan_for(tmp, cycle), LEAD)
            self.assertFalse(decision["emit_baseline"])
            self.assertEqual(decision["reason"], "capability_baseline_already_passed_this_cycle")
            self.assertEqual(decision["baseline_passed_lanes"], ["followup-runner-03"])

    def test_withholds_when_the_lead_already_has_a_bound_design(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            cycle = "cycle-g-v99-20260826"
            write_lane(tmp, cycle, "followup-runner-30",
                       check_ids=["CHK-RESERVOIR-CROSSOVER-LOSO-01"],
                       overall="passed", bound_to=LEAD)
            decision = _cs_baseline_decision(role_plan_for(tmp, cycle), LEAD)
            self.assertFalse(decision["emit_baseline"])
            self.assertEqual(decision["reason"], "lead_already_has_an_analyst_designed_check")

    def test_another_leads_design_does_not_count_for_this_one(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            cycle = "cycle-g-v99-20260826"
            write_lane(tmp, cycle, "followup-runner-30",
                       check_ids=["CHK-OTHER-01"], overall="passed",
                       bound_to="hyp-director-some-other-lead")
            decision = _cs_baseline_decision(role_plan_for(tmp, cycle), LEAD)
            # No baseline has passed either, so this is still the first one.
            self.assertTrue(decision["emit_baseline"])
            self.assertEqual(decision["reason"], "first_capability_baseline_of_the_cycle")

    def test_the_request_is_not_executable_and_says_why(self):
        import tempfile
        with tempfile.TemporaryDirectory() as t:
            tmp = Path(t)
            cycle = "cycle-g-v99-20260826"
            write_lane(tmp, cycle, "followup-runner-03",
                       check_ids=[BASELINE_CHECK], overall="passed")
            decision = _cs_baseline_decision(role_plan_for(tmp, cycle), LEAD)
            checks, blueprints, mapping = _cs_analyst_design_request(
                primary_hypothesis_id=LEAD,
                primary_family="edit_region_residual_rerendering",
                director_hypothesis={"statement": "a leakage-free pre-action residual proxy"},
                role_plan=role_plan_for(tmp, cycle),
                decision=decision,
            )
            # No blueprint: _handoff_is_scientifically_executable is False, so the
            # reason travels to the LabDirector as a blocker rather than a lane
            # that runs, passes, and tells nobody the lead is still untested.
            self.assertEqual(blueprints, [])
            self.assertEqual(len(checks), 1)
            self.assertFalse(checks[0]["executable"])
            self.assertFalse(checks[0]["hypothesis_bound"])
            self.assertEqual(mapping["handoff_generation_mode"], "cs_analyst_design_required")
            self.assertIn("followup-runner-03", checks[0]["goal"])
            self.assertIn("a leakage-free pre-action residual proxy", checks[0]["hypothesis_text"])
            # And it forbids the obvious way to game it.
            self.assertTrue(any("capability baseline under a new name" in f
                                for f in checks[0]["failure_criteria"]))


if __name__ == "__main__":
    unittest.main()
