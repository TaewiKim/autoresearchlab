"""A withheld hypothesis must not become the literature search topic.

cycle-g-v83 searched for "selected pending chronicle".

The lab-director withheld its lead and wrote the reason into the statement field
- "No hypothesis selected pending Chronicle evidence." - and that sentence flowed
into the scout role plan as assigned_hypotheses. It cleared every low-information
check, because those look for vagueness and this sentence is not vague, it is
simply not a hypothesis. Five literature lanes then retrieved 500 papers on
clinical decision support, COVID school closures, 3D cancer models, and one
titled "Crypto Withdrawal Pending", for a computer-graphics rendering objective.

Chronicle read the corpus correctly - "the literature graph contains 12
biomedical nodes, 9 biomedical edges, and zero rendering papers" - and could not
supply the absence evidence the director was waiting on. So the director withheld
again, and its placeholder became the next round's query. A closed loop that
consumed the cycle while every component behaved as written.
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "literature"))

from search_lib.queries import (  # noqa: E402
    _low_information_hypothesis,
    derive_queries_from_role_plan,
)

# Every one of these was written into a hypothesis slot by a real director lane in
# v82 or v83.
PLACEHOLDERS = [
    "No hypothesis selected pending Chronicle evidence.",
    "NOT SELECTED pending Chronicle evidence.",
    "WITHHELD pending Chronicle evidence.",
    "WITHHELD_PENDING_CHRONICLE_EVIDENCE",
    "No hypothesis selected; the candidate research problem was retired before hypothesis construction.",
    "No hypothesis selected under terminal no-survivor restart.",
]

# Real leads, including ones that use the placeholder vocabulary in a legitimate
# technical sense ("pending-update queue", "reset", "deferred shading"). A guard
# that eats these would silence the scouts entirely.
REAL_HYPOTHESES = [
    "Adaptive variance-guided tile allocation beats uniform sampling at a matched spp budget on glossy scenes.",
    "Edit-induced Monte Carlo residual patterns predict the reuse-reset crossover in path-traced scenes.",
    "Stale directional guides degrade effective sample size after localized scene edits.",
    "Neural radiance caching reduces variance in dynamic lighting compared with path guiding.",
    "Reservoir resampling with a pending-update queue improves temporal stability under camera motion.",
    "Deferred shading with tile-based light culling lowers bandwidth at equal image quality.",
]


class PlaceholderHypothesisTest(unittest.TestCase):
    def test_placeholders_are_rejected(self):
        for text in PLACEHOLDERS:
            with self.subTest(text=text):
                self.assertTrue(
                    _low_information_hypothesis(text),
                    f"a status line must never become a search topic: {text!r}",
                )

    def test_real_hypotheses_survive(self):
        for text in REAL_HYPOTHESES:
            with self.subTest(text=text):
                self.assertFalse(
                    _low_information_hypothesis(text),
                    f"a real lead must still drive the search: {text!r}",
                )

    def test_placeholder_plan_falls_back_to_the_candidate_question(self):
        # The good text was never out of reach on v83 - the same role plan carried
        # the director's actual candidate question in planner_metadata.
        plan = {
            "assigned_hypotheses": ["No hypothesis selected pending Chronicle evidence."],
            "objective": "computer graphics rendering algorithm research",
            "planner_metadata": {
                "candidate_hypotheses": [
                    {
                        "answers_research_problem": (
                            "Can edit-induced Monte Carlo residual and variance patterns measured in "
                            "image space predict the edit-severity crossover at which retaining "
                            "sampling state becomes worse than resetting it"
                        )
                    }
                ]
            },
        }
        queries = " ".join(derive_queries_from_role_plan(plan)).lower()
        self.assertNotIn("pending chronicle", queries)
        self.assertTrue(
            any(term in queries for term in ("monte carlo", "residual", "crossover")),
            f"the candidate question must drive the search, got: {queries!r}",
        )

    def test_placeholder_plan_falls_back_to_the_objective(self):
        # No candidate either: the cycle objective is the last honest topic left,
        # and it is always present in the plan.
        plan = {
            "assigned_hypotheses": ["No hypothesis selected pending Chronicle evidence."],
            "objective": "computer graphics rendering algorithm research real-time offline rendering",
        }
        queries = " ".join(derive_queries_from_role_plan(plan)).lower()
        self.assertNotIn("pending chronicle", queries)
        self.assertIn("rendering", queries)

    def test_a_real_lead_still_wins_over_the_objective(self):
        plan = {
            "assigned_hypotheses": [
                "Stale directional guides degrade effective sample size after localized scene edits."
            ],
            "objective": "computer graphics rendering algorithm research",
            "planner_metadata": {"candidate_hypotheses": [{"statement": "something else entirely"}]},
        }
        queries = " ".join(derive_queries_from_role_plan(plan)).lower()
        self.assertTrue(
            any(term in queries for term in ("directional", "guides", "sample size", "edits")),
            f"the assigned lead must take precedence, got: {queries!r}",
        )


if __name__ == "__main__":
    unittest.main()
