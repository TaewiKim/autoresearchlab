"""Provider failures remain retryable and approved policy stays allowlisted."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "literature"))
from search_lib import collect


class ParallelCollectionTest(unittest.TestCase):
    def test_partial_provider_failure_retries_instead_of_becoming_a_cached_corpus(self):
        paper = {"doi": "10.0000/test", "title": "Robot control test result"}
        repaired_paper = {"doi": "10.0000/repaired", "title": "Recovered robot control result"}
        unavailable_attempts = 0

        def provider(name, query):
            nonlocal unavailable_attempts
            self.assertEqual(query, "robot control")
            if name == "unavailable":
                unavailable_attempts += 1
                if unavailable_attempts == 1:
                    raise OSError("provider unavailable")
                return [repaired_paper]
            return [paper]

        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "query.json"
            with (
                patch.object(collect, "query_cache_path", return_value=cache),
                patch.object(collect, "collect_from_source", side_effect=provider) as fetch,
                patch.object(collect, "paper_is_relevant", return_value=True),
                patch.object(collect, "paper_score", return_value=1),
            ):
                papers, stats = collect.collect_query_papers(
                    "robot control", ["available", "duplicate", "unavailable"]
                )
                self.assertEqual(papers, [paper])
                self.assertEqual(fetch.call_count, 3)
                # `throttled` classifies WHY the provider dropped out, so a
                # source refused for rate and a source that genuinely holds
                # nothing stop being the same empty result. An OSError is
                # neither, so it is False here.
                self.assertEqual(stats["source_failures"], [{
                    "source": "unavailable", "query": "robot control",
                    "error": "provider unavailable", "throttled": False,
                }])
                self.assertFalse(cache.exists(), "a partial provider failure must not be cached as complete")
                repaired, repaired_stats = collect.collect_query_papers("robot control", ["available", "duplicate", "unavailable"])
                self.assertEqual(fetch.call_count, 6, "same-context retry must requery the repaired provider")
                self.assertEqual(repaired_stats["source_failures"], [])
                self.assertEqual({item["doi"] for item in repaired}, {paper["doi"], repaired_paper["doi"]})
                self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["source_stats"]["source_failures"], [])
                collect.collect_query_papers("robot control", ["available", "duplicate", "unavailable"])
                self.assertEqual(fetch.call_count, 6, "only completed retrievals are reusable")

    def test_legacy_failure_cache_is_invalidated_even_with_the_same_context(self):
        paper = {"doi": "10.0000/retry", "title": "Retry after provider repair"}
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "query.json"
            context = collect.screening_context("robot control", ["openalex"])
            cache.write_text(json.dumps({
                "schema_version": collect.QUERY_CACHE_SCHEMA_VERSION,
                "screening_context": context,
                "papers": [],
                "source_stats": {"source_failures": [{"source": "openalex", "error": "temporary failure"}]},
            }), encoding="utf-8")
            with (
                patch.object(collect, "query_cache_path", return_value=cache),
                patch.object(collect, "collect_from_source", return_value=[paper]) as fetch,
                patch.object(collect, "paper_is_relevant", return_value=True),
                patch.object(collect, "paper_score", return_value=1),
            ):
                papers, stats = collect.collect_query_papers("robot control", ["openalex"])
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(papers, [paper])
            self.assertEqual(stats["source_failures"], [])
            self.assertEqual(json.loads(cache.read_text(encoding="utf-8"))["papers"], [paper])

    def test_approved_policy_limits_default_and_explicit_sources(self):
        with patch.dict("os.environ", {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": "approved-scholarly-metadata-v1"}, clear=False):
            self.assertEqual(
                collect.default_literature_sources("biomedical objective"),
                ["openalex", "crossref", "arxiv", "semanticscholar"],
            )
            self.assertEqual(
                collect.allowed_literature_sources(
                    ["openalex", "pubmed", "crossref", "scopus", "arxiv", "semanticscholar"]
                ),
                ["openalex", "crossref", "arxiv", "semanticscholar"],
            )

    def test_a_named_source_set_is_honoured_and_an_unknown_name_refused(self):
        with patch.dict("os.environ", {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": "approved-scholarly-metadata-v1"}, clear=False):
            self.assertEqual(
                collect.select_literature_sources(["semanticscholar,arxiv"]), ["semanticscholar", "arxiv"]
            )
            # The policy still removes what it does not allow.
            self.assertEqual(collect.select_literature_sources(["pubmed", "openalex"]), ["openalex"])
            self.assertEqual(
                collect.select_literature_sources([], "robot manipulation"),
                list(collect.APPROVED_SCHOLARLY_SOURCES),
            )
            with self.assertRaises(ValueError):
                collect.select_literature_sources(["semantic-scholar"])


if __name__ == "__main__":
    unittest.main()
