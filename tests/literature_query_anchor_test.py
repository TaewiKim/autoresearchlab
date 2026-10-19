#!/usr/bin/env python3
"""A query with no subject in it retrieves whichever field shares the words.

MEASURED ON cycle-g-v91, 2026-09-13. A computer-graphics cycle searched
"confidence sequence stopping" and "verification rays compare validity phase"
and retrieved Collatz sequence stopping times, reasons for stopping electronic
cigarette use, mathematics students' confidence calibration, and streaming
speaker verification. 73 retrieved, 71 quarantined, 0 admitted -- and the
screening was right about every one of them.

The seam meant to prevent this tested the plan text for `geomx`,
`spatial transcriptom`, `interferon` and `mitochondrial`, and emitted literal
queries naming those. It anchored one domain and returned an empty list for
every other, so the graphics cycle had no anchor at all. Two tests in
literature_query_sanitization_test pinned those literal strings in place, in
the same file as a test forbidding hardcoded search terms; they are gone.

What replaces it derives the anchor from the instrument probe's own record of
what this container was MEASURED to be able to do. It names no field, so it has
no field to be wrong about.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib import queries as queries_module
from drivers.literature.search_lib.entrypoint import capability_inventory, cycle_state_dir
from drivers.literature.search_lib.queries import (
    anchor_queries_to_capability,
    capability_anchor_terms,
)

# cycle-g-v91's actual instrument inventory, trimmed to the three keys read.
RENDERING = {
    "verified_instruments": [
        "procedural_scene_render",
        "seed_pinned_reproducibility",
        "converged_reference_and_error_metric",
        "counterfactual_edit_pairs",
        "per_pixel_variance_across_seeds",
        "aov_side_channels",
        "integrator_catalog",
    ],
    "measurable_quantities": [
        "image error against a high-spp converged reference (RMSE, PSNR)",
        "per-pixel estimator variance and its spatial distribution",
        "per-pixel albedo channel (AOV)",
    ],
}

# A container that probed something else entirely. Same code, no edit.
ASSAY = {
    "verified_instruments": [
        "plate_reader_absorbance",
        "plate_layout_randomization",
        "absorbance_dose_response_fit",
    ],
    "measurable_quantities": [
        "absorbance per well at a fixed wavelength",
        "dose response curve per plate",
    ],
}


class CapabilityAnchorTest(unittest.TestCase):
    def test_the_anchor_is_whatever_this_container_measured(self):
        rendering = capability_anchor_terms(RENDERING)
        self.assertTrue(rendering, "a probed container produced no anchor")
        # Terms the probe reaches for across unrelated measurements.
        self.assertIn("pixel", rendering)

        assay = capability_anchor_terms(ASSAY)
        self.assertTrue(assay, "a container that measured something else produced no anchor")
        self.assertIn("absorbance", assay)
        # The point: no term is shared, and no code was changed between them.
        self.assertEqual(set(rendering) & set(assay), set())

    def test_a_term_used_once_describes_a_measurement_not_a_container(self):
        once = capability_anchor_terms({
            "verified_instruments": ["singular_unrepeated_widget"],
            "measurable_quantities": ["one quantity nothing else mentions"],
        })
        self.assertEqual(once, [])

    def test_no_inventory_means_no_anchor_rather_than_a_guess(self):
        for empty in (None, {}, {"verified_instruments": []}, {"verified_instruments": ["x"]}):
            self.assertEqual(capability_anchor_terms(empty), [])
        # And the queries pass through untouched rather than being dropped.
        self.assertEqual(
            anchor_queries_to_capability(["confidence sequence stopping"], None),
            ["confidence sequence stopping"],
        )

    def test_the_subject_goes_in_front_of_every_query(self):
        anchored = anchor_queries_to_capability(
            ["confidence sequence stopping", "verification rays compare validity phase"],
            RENDERING,
        )
        self.assertEqual(len(anchored), 2)
        for query in anchored:
            self.assertIn("pixel", query.lower())

    def test_a_query_already_carrying_the_anchor_is_not_anchored_twice(self):
        terms = capability_anchor_terms(RENDERING)
        already = " ".join([*terms, "estimator variance"])
        anchored = anchor_queries_to_capability([already], RENDERING)
        for term in terms:
            self.assertEqual(anchored[0].lower().count(term), 1, anchored[0])

    def test_the_module_names_no_domain_of_its_own(self):
        # The literals the removed seam carried. A prohibition that names a
        # field is still hardcoding, so this checks for absence, not for a rule.
        source = Path(queries_module.__file__).read_text(encoding="utf-8").lower()
        for term in ("geomx", "spatial transcriptom", "interferon", "mitochondrial", "gene set score"):
            self.assertNotIn(term, source, f"{term} is still named in the query builder")


class StateDirectoryTest(unittest.TestCase):
    """The reader that never found what it read.

    The driver's output directory is `.research-lab/artifacts/stats/<cycle>/
    <lane>`, and the state files are in `.research-lab/state`. The two guesses
    in place were `output_dir.parent` and `output_dir`, so the inventory reader
    and the lead fallback both read paths that do not exist -- quietly, and
    returning as though the cycle had nothing to say.
    """

    def test_the_state_directory_is_found_from_the_lane_output_directory(self):
        cycle = "cg-anchor-test"
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir) / ".research-lab"
            state = root / "state"
            state.mkdir(parents=True)
            (state / f"{cycle}-instrument-inventory.json").write_text(json.dumps(RENDERING), encoding="utf-8")
            output = root / "artifacts" / "stats" / cycle / "followup-scout-28"
            output.mkdir(parents=True)

            self.assertEqual(cycle_state_dir(output, cycle), state.resolve())
            inventory = capability_inventory(output, cycle)
            self.assertIsNotNone(inventory, "the inventory did not reach the lane")
            self.assertIn("pixel", capability_anchor_terms(inventory))

    def test_a_cycle_with_no_state_directory_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "somewhere" / "else"
            output.mkdir(parents=True)
            self.assertIsNone(cycle_state_dir(output, "cg-anchor-test"))
            self.assertIsNone(capability_inventory(output, "cg-anchor-test"))
            self.assertIsNone(capability_inventory(output, ""))


if __name__ == "__main__":
    unittest.main()
