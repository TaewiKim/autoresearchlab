"""The check spec must agree with the blueprint it configures.

cycle-g-v87 lost every lead-bound execution to one disagreement inside a single
handoff file:

    ValueError: reproducibility seeds must be exactly [101, 211, 307, 401, 503];
    got [0, 1, 2, 3, 4]

The analyst preregistered its seeds in `validation_code_blueprints[*].code` and
left `handoff_checks[*].reproducibility_design` unset. The driver read the silence,
stamped its v84 default, and shipped it to the blueprint through
RESEARCHLAB_CHECK_SPEC, where the blueprint's own guard rejected it. Ten runs, all
degraded at 0/1 blueprints, and reproducibility honestly scored 8 on the
`unsupported` rigor profile that produced.

Across all ten of v87's handoffs: 0 checks carried a design, 7 of 10 blueprints
pinned SEEDS.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "analysis"))

from python_stats_lib.entrypoint import (  # noqa: E402
    _blueprint_seeds_for_check,
    _seeds_from_blueprint_code,
    _stamp_handoff_reproducibility,
)

PREREGISTERED = [101, 211, 307, 401, 503]

# followup-analyst-35's shape, trimmed to what the stamp reads.
V87_CODE = (
    "import matplotlib\nmatplotlib.use('Agg')\nimport mitsuba as mi\n"
    "CHECK_ID='aov-spill-held-family-v1'\n"
    "SEEDS=[101,211,307,401,503]\n"
    "SEVS=[0,.25,.5,.75,1.]\n"
    "got=sorted(spec['reproducibility_design']['seeds'])\n"
    "if got!=SEEDS:raise ValueError(f'reproducibility seeds must be exactly {SEEDS}; got {got}')\n"
)


def v87_handoff(check_id="aov-spill-held-family-v1", code=V87_CODE, blueprint_check_id=None):
    blueprint = {"blueprint_id": "BP-AOV-SPILL-REPL-01", "code": code}
    if blueprint_check_id is not None:
        blueprint["check_id"] = blueprint_check_id
    return {
        "handoff_checks": [{
            "check_id": check_id,
            "goal": "held-family AOV spill",
            "exposures": ["invalidation_strategy"],
            "outcome": "inclusive_rmse",
        }],
        "validation_code_blueprints": [blueprint],
    }


class SeedExtraction(unittest.TestCase):
    def test_the_v87_literal_is_read(self):
        self.assertEqual(_seeds_from_blueprint_code(V87_CODE), PREREGISTERED)

    def test_alternate_spellings_are_read(self):
        for line in ("SEED_LIST = [7, 8, 9]", "seeds=[7,8,9]", "PINNED_SEEDS = [7, 8, 9]"):
            self.assertEqual(_seeds_from_blueprint_code("x=1\n" + line + "\n"), [7, 8, 9], line)

    def test_a_blueprint_that_pins_nothing_returns_none(self):
        self.assertIsNone(_seeds_from_blueprint_code("import pandas as pd\nprint(1)\n"))
        self.assertIsNone(_seeds_from_blueprint_code(""))
        self.assertIsNone(_seeds_from_blueprint_code(None))

    def test_a_non_numeric_list_is_not_mistaken_for_seeds(self):
        self.assertIsNone(_seeds_from_blueprint_code("SEEDS=[a, b, c]\n"))


class BlueprintBinding(unittest.TestCase):
    def test_bound_by_the_check_id_literal_in_the_source(self):
        handoff = v87_handoff()
        self.assertEqual(
            _blueprint_seeds_for_check(handoff, handoff["handoff_checks"][0]), PREREGISTERED
        )

    def test_bound_by_the_structured_check_id(self):
        handoff = v87_handoff(code="SEEDS=[101,211,307,401,503]\n",
                              blueprint_check_id="aov-spill-held-family-v1")
        self.assertEqual(
            _blueprint_seeds_for_check(handoff, handoff["handoff_checks"][0]), PREREGISTERED
        )

    def test_a_single_check_and_single_blueprint_bind_without_any_id(self):
        # 3 of v87's 10 blueprints declared no CHECK_ID at all.
        handoff = v87_handoff(code="SEEDS=[101,211,307,401,503]\n")
        self.assertEqual(
            _blueprint_seeds_for_check(handoff, handoff["handoff_checks"][0]), PREREGISTERED
        )

    def test_a_mismatched_check_id_does_not_bind(self):
        # With several checks in play, guessing is worse than the default.
        handoff = v87_handoff()
        handoff["handoff_checks"].append({"check_id": "some-other-check"})
        self.assertIsNone(
            _blueprint_seeds_for_check(handoff, handoff["handoff_checks"][1])
        )


class Stamping(unittest.TestCase):
    def test_the_v87_failure_does_not_happen_again(self):
        handoff = _stamp_handoff_reproducibility(v87_handoff())
        design = handoff["handoff_checks"][0]["reproducibility_design"]
        self.assertEqual(design["seeds"], PREREGISTERED)
        self.assertEqual(design["seed_count"], 5)
        self.assertIn("blueprint", design["seeds_source"])

    def test_genuine_silence_still_gets_the_v84_default(self):
        handoff = v87_handoff(code="import pandas as pd\nprint(1)\n")
        handoff = _stamp_handoff_reproducibility(handoff)
        design = handoff["handoff_checks"][0]["reproducibility_design"]
        self.assertEqual(design["seeds"], [0, 1, 2, 3, 4])
        self.assertIn("default", design["seeds_source"])
        # and the rest of the v84 stamp is still applied
        self.assertEqual(design["dispersion_statistic"], "std")
        self.assertIn("comparator", design)

    def test_a_written_design_keeps_everything_except_contradicted_seeds(self):
        handoff = v87_handoff()
        handoff["handoff_checks"][0]["reproducibility_design"] = {
            "seeds": [0, 1, 2, 3, 4],
            "seed_count": 5,
            "comparator": "fixed_entity",
            "dispersion_statistic": "IQR",
            "matched_budget": "equal wall time",
        }
        handoff = _stamp_handoff_reproducibility(handoff)
        design = handoff["handoff_checks"][0]["reproducibility_design"]
        self.assertEqual(design["seeds"], PREREGISTERED, "the code that runs decides")
        self.assertEqual(design["comparator"], "fixed_entity", "the analyst's own words survive")
        self.assertEqual(design["dispersion_statistic"], "IQR")
        self.assertEqual(design["matched_budget"], "equal wall time")

    def test_a_written_design_is_untouched_when_the_blueprint_pins_nothing(self):
        handoff = v87_handoff(code="print(1)\n")
        written = {"seeds": [3, 4, 5], "comparator": "uniform", "dispersion_statistic": "std"}
        handoff["handoff_checks"][0]["reproducibility_design"] = dict(written)
        handoff = _stamp_handoff_reproducibility(handoff)
        self.assertEqual(handoff["handoff_checks"][0]["reproducibility_design"], written)

    def test_an_agreeing_design_is_not_rewritten(self):
        handoff = v87_handoff()
        handoff["handoff_checks"][0]["reproducibility_design"] = {
            "seeds": list(PREREGISTERED), "comparator": "fixed_entity",
        }
        handoff = _stamp_handoff_reproducibility(handoff)
        design = handoff["handoff_checks"][0]["reproducibility_design"]
        self.assertEqual(design["seeds"], PREREGISTERED)
        self.assertNotIn("seeds_source", design, "no need to annotate what already agreed")

    def test_a_handoff_without_checks_survives(self):
        self.assertEqual(_stamp_handoff_reproducibility({}), {})
        self.assertEqual(_stamp_handoff_reproducibility({"handoff_checks": "nope"}),
                         {"handoff_checks": "nope"})
        self.assertIsNone(_stamp_handoff_reproducibility(None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
