"""Tests for the computer-graphics / rendering analyst handoff.

A CG objective generates its scene data procedurally in-code (Mitsuba
mi.load_dict), so no dataset bundle is ever materialised. The bundle-driven
handoff builder used to fall through to a `deferred / awaiting_data_acquisition`
signal in that case — which, for CG, is permanent: the analyst emits no
executable handoff, so the (correct) lab-runner dependency gate never dispatches
and the director spins up more analysts forever (the runner-dispatch deadlock
observed in cycles v20/v23/v25/v26).

These tests lock in that an explicitly selected Mitsuba graphics objective
with no materialised bundle emits an
EXECUTABLE render-and-measure handoff instead of deferring, while a bio/omics
objective in the same no-bundle situation still defers byte-identically.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature import search as lit_search  # noqa: E402


def _build_no_bundle_handoff(objective_domain: str, *, backend=None, objective=None) -> dict:
    """Run build_analyst_handoff for a classified hypothesis with NO
    materialised candidate datasets, under the given objective domain."""
    tmp = Path(tempfile.mkdtemp(prefix="cs-render-handoff-"))
    cycle_id = "cg-render-test"
    state_dir = tmp / ".research-lab" / "state"
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / f"{cycle_id}-lab-director-hypothesis.json").write_text(
        json.dumps(
            {
                "hypothesis_id": f"hyp-{objective_domain}-adaptive-01",
                "statement": (
                    "Tile-level variance-guided sample allocation improves PSNR/SSIM "
                    "versus uniform per-pixel sampling at matched equal-spp budgets."
                ),
                "primary_family": "render_adaptive_sampling",
                "family_root": "render_adaptive_sampling",
                "classification": "classified",
            }
        ),
        encoding="utf-8",
    )
    output_dir = tmp / ".research-lab" / "artifacts" / "stats" / cycle_id / "analyst-01"
    output_dir.mkdir(parents=True, exist_ok=True)
    role_plan = {
        "lane_id": "analyst-01",
        "cycle_id": cycle_id,
        "objective_domain": objective_domain,
        "objective": objective or (
            "computer graphics rendering algorithms"
            if objective_domain == "cs"
            else "omics differential expression"
        ),
        "planner_metadata": {"candidate_datasets": []},
    }
    if backend is not None:
        role_plan["probe_config"] = {"backend": backend}
    return lit_search.build_analyst_handoff({}, role_plan, output_dir=output_dir)


def _has_executable_blueprint(handoff: dict) -> bool:
    for bp in handoff.get("validation_code_blueprints") or []:
        if isinstance(bp, dict) and str(bp.get("code") or "").strip():
            return True
    return False


class AnalystHandoffCsRenderTest(unittest.TestCase):
    def test_explicit_mitsuba_no_bundle_emits_executable_render_handoff(self):
        handoff = _build_no_bundle_handoff("cs", backend="mitsuba")
        self.assertEqual(handoff.get("status"), "ready_for_runner")
        self.assertEqual(handoff.get("reason"), "procedural_render_no_bundle_required")
        self.assertTrue(handoff.get("handoff_checks"), "cs handoff must carry checks")
        self.assertTrue(
            _has_executable_blueprint(handoff),
            "cs handoff must carry a validation code blueprint with real code",
        )
        # The render-and-measure check must be present among the checks.
        check_ids = [c.get("check_id") for c in handoff.get("handoff_checks") or []]
        self.assertTrue(
            any("render_quality_convergence" in str(cid) for cid in check_ids),
            f"expected a render_quality_convergence check, got {check_ids}",
        )
        # The render blueprint declares the Mitsuba dependency.
        deps = []
        for bp in handoff.get("validation_code_blueprints") or []:
            deps.extend(bp.get("dependencies") or [])
        self.assertIn("mitsuba", deps)
        # The omics master-table gate must NOT be stapled onto a render handoff
        # (a rendered image + render_metrics.csv is not a tabular master table;
        # stapling it degrades the passing render lane on a gate it can't meet).
        self.assertFalse(
            any("analysis_master_table" in str(c.get("check_id")) for c in handoff.get("handoff_checks") or []),
            "render handoff must not carry the omics analysis_master_table gate check",
        )
        self.assertNotIn("pre_validation_master_table_gate", handoff)
        self.assertNotIn("analysis_master_table", handoff)

    def test_robot_and_compiler_no_bundle_do_not_install_a_renderer(self):
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": ""}):
            for objective in ("SuperDex robot grasp force control", "LLVM compiler optimization"):
                with self.subTest(objective=objective):
                    handoff = _build_no_bundle_handoff("cs", objective=objective)
                    self.assertEqual(handoff.get("status"), "deferred")
                    self.assertEqual(handoff.get("reason"), "awaiting_data_acquisition")
                    self.assertFalse(_has_executable_blueprint(handoff))
                    self.assertNotIn("mitsuba", json.dumps(handoff).lower())

    def test_graphics_without_selected_renderer_does_not_default_to_mitsuba(self):
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": ""}):
            handoff = _build_no_bundle_handoff("cs")
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertFalse(_has_executable_blueprint(handoff))

    def test_selected_superdex_overrides_stale_mitsuba_environment(self):
        with patch.dict("os.environ", {"RESEARCHLAB_INSTRUMENT_PROBE_BACKEND": "mitsuba"}):
            handoff = _build_no_bundle_handoff(
                "cs", backend="superdex", objective="SuperDex robot grasp force control"
            )
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertFalse(_has_executable_blueprint(handoff))

    def test_bio_no_bundle_defer_is_unaffected_by_render_gating(self):
        # Guard: the render-handoff detection must not touch the bio path.
        handoff = _build_no_bundle_handoff("bio")
        self.assertEqual(handoff.get("status"), "deferred")

    def test_bio_no_bundle_still_defers_byte_identically(self):
        handoff = _build_no_bundle_handoff("bio")
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "awaiting_data_acquisition")
        # The bio defer path leaves no executable checks/blueprints (it may not
        # set the keys at all — the point is there is nothing runnable).
        self.assertFalse(handoff.get("handoff_checks"))
        self.assertFalse(_has_executable_blueprint(handoff))


if __name__ == "__main__":
    unittest.main()
