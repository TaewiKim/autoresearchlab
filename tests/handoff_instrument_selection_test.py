"""Tool selection governs render templates in the bundle-driven handoff path."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from drivers.literature.search_lib.dataset_checks import _build_generic_handoff_check_and_blueprint
from drivers.literature.search_lib.handoff_checks import _explicit_mitsuba_render_selected


def build_for(role_plan):
    return _build_generic_handoff_check_and_blueprint(
        primary_hypothesis_id="hyp-method-cost",
        primary_family="method_cost",
        director_hypothesis={"statement": "A selected method reduces measured cost."},
        role_plan=role_plan,
        memo={},
        bundle={"csvs": [{"name": "measurements", "csv_path": "measurements.csv",
                          "columns": ["setting", "duration_ms"]}]},
        keywords={"duration", "setting"},
    )


class HandoffInstrumentSelectionTest(unittest.TestCase):
    def test_robot_and_compiler_keep_domain_neutral_bundle_checks(self):
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": ""}):
            for objective in ("SuperDex robot control", "LLVM compiler optimization",
                              "Previous Mitsuba probe failed; study robot control"):
                with self.subTest(objective=objective):
                    checks, blueprints, _ = build_for({"objective_domain": "cs", "objective": objective})
                    self.assertEqual(checks[0]["model_family"], "generic-pearson-association")
                    self.assertTrue(blueprints[0]["code"].strip())
                    self.assertNotIn("mitsuba", json.dumps(blueprints).lower())

    def test_explicit_mitsuba_keeps_capability_scope_and_renderer_dependencies(self):
        checks, blueprints, _ = build_for({
            "objective_domain": "cs", "objective": "Computer graphics rendering",
            "probe_config": {"backend": "mitsuba"},
        })
        self.assertIn("render_quality_convergence", checks[0]["check_id"])
        self.assertFalse(checks[0]["hypothesis_bound"])
        self.assertIn("GENERIC CAPABILITY BASELINE", checks[0]["alignment_notice"])
        self.assertIn("mitsuba", blueprints[0]["pip_install_packages"])

    def test_explicit_inventory_and_cycle_environment_are_supported(self):
        role = {"objective_domain": "cs", "objective": "Computer graphics rendering"}
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": "mitsuba"}):
            self.assertTrue(_explicit_mitsuba_render_selected(role))
        for inventory in ({"backend": "mitsuba"}, {"probe_config": {"backend": "mitsuba"}}):
            with self.subTest(inventory=inventory):
                self.assertTrue(_explicit_mitsuba_render_selected({
                    **role, "planner_metadata": {"instrument_inventory": inventory},
                }))

    def test_explicit_different_tool_wins_over_stale_inventory_and_environment(self):
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": "mitsuba"}):
            checks, blueprints, _ = build_for({
                "objective_domain": "cs", "objective": "SuperDex robot control",
                "probe_config": {"backend": "superdex"},
                "planner_metadata": {"instrument_inventory": {"backend": "mitsuba"}},
            })
        self.assertEqual(checks[0]["model_family"], "generic-pearson-association")
        self.assertNotIn("mitsuba", json.dumps(blueprints).lower())


if __name__ == "__main__":
    unittest.main()
