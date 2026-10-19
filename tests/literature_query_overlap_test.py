#!/usr/bin/env python3
"""A query built by joining overlapping phrases asks for a sentence.

`_scientific_phrases` enumerates EVERY window of length 2..5 over each segment
of its input, ranked. The top of that list is therefore one clause sliced
several ways, and `_dedupe_texts` drops only exact repeats. Two builders used
to join three of those windows into one string.

MEASURED ON cycle-g-v91, 2026-09-13. Eleven prior-art scout lanes
(followup-scout-04 through -27) each searched, verbatim:

    "varied conditions preferred explanation procedure reverse conditions
     preferred explanation procedure reverse conditions preferred explanation"
    "reinforcement learned adaptive reconstruction sampling reinforcement
     learned adaptive learned adaptive reconstruction"

Every one returned paper_count=0 and was counted failed_blocking, taking the
cycle from 6 blocking failures to 16 -- a working retrieval path reporting
itself as eleven lane failures.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib import entrypoint
from drivers.literature.search_lib.queries import (
    derive_queries_from_role_plan,
    distinct_phrases,
)

# The head of cycle-g-v91's actual lead, as it stood in the role plan of
# followup-scout-27.
V91_LEAD = (
    "On held-out procedural Mitsuba edit families, a sequential "
    "posterior-uncertainty value-of-information policy will lower "
    "family-clustered false-safe upper90 by at least 0.03 at prespecified "
    "fresh-work budgets"
)


def repeated_bigrams(query: str) -> list[str]:
    """Word pairs that occur more than once -- the signature of a joined window.

    A phrase of five words or fewer does not repeat a pair by accident; a join
    of overlapping windows repeats one every time.
    """
    words = query.lower().split()
    pairs = [" ".join(words[i:i + 2]) for i in range(len(words) - 1)]
    return sorted({pair for pair in pairs if pairs.count(pair) > 1})


class PhraseOverlapTest(unittest.TestCase):
    def test_shifted_windows_of_one_clause_are_one_phrase(self):
        # Neither of these contains the other, so a substring dedupe keeps both.
        phrases = [
            "conditions preferred explanation procedure reverse",
            "preferred explanation procedure reverse conditions",
            "explanation procedure reverse",
            "sparse voxel occupancy grid",
        ]
        kept = distinct_phrases(phrases)
        self.assertEqual(
            kept,
            ["conditions preferred explanation procedure reverse", "sparse voxel occupancy grid"],
        )

    def test_order_is_kept_and_the_limit_bounds_the_round_trips(self):
        phrases = [f"alpha{index} beta{index} gamma{index}" for index in range(9)]
        kept = distinct_phrases(phrases)
        self.assertEqual(kept, phrases[:4])
        self.assertEqual(distinct_phrases(phrases, limit=2), phrases[:2])

    def test_an_empty_phrase_list_is_not_an_error(self):
        self.assertEqual(distinct_phrases([]), [])
        self.assertEqual(distinct_phrases(["", "   ", "..."]), [])


class RolePlanQueryTest(unittest.TestCase):
    def test_the_lead_becomes_several_short_queries_not_one_sentence(self):
        queries = derive_queries_from_role_plan({"assigned_hypotheses": [V91_LEAD]})
        self.assertTrue(queries, "the lead produced no query at all")
        for query in queries:
            self.assertEqual(
                repeated_bigrams(query), [], f"joined windows are back in: {query}"
            )
            self.assertLessEqual(
                len(query.split()), 8, f"a query this long is a sentence: {query}"
            )
        # Several separate questions, not one.
        self.assertGreaterEqual(len(queries), 2)


class LastResortQueryTest(unittest.TestCase):
    """The second builder. Fixing only the first would have left this one.

    This repository keeps finding one rule delivered down one of two paths, so
    the test exercises the path rather than asserting on the source text.
    """

    def test_the_hypothesis_fallback_obeys_the_same_rule(self):
        cycle_id = "cg-query-overlap-test"
        with tempfile.TemporaryDirectory() as temp:
            state_dir = Path(temp)
            output_dir = state_dir / "followup-scout-01"
            output_dir.mkdir()
            (state_dir / f"{cycle_id}-lab-director-hypothesis.json").write_text(
                json.dumps(
                    {
                        "statement": V91_LEAD,
                        "primary_family": "value_of_information_active_probing",
                        "why_selected": "it is the only lead with a stated way to be wrong",
                    }
                ),
                encoding="utf-8",
            )
            task_file = output_dir / "task.md"
            task_file.write_text(f"- cycle_id: {cycle_id}\n", encoding="utf-8")

            queries, source = entrypoint._last_resort_queries(output_dir, task_file, {})

        self.assertEqual(source, f"lab-director-hypothesis:{cycle_id}")
        self.assertTrue(queries)
        for query in queries:
            self.assertEqual(
                repeated_bigrams(query), [], f"joined windows are back in: {query}"
            )


if __name__ == "__main__":
    unittest.main()
