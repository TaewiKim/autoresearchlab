"""Evidence must not enter synthesis through title similarity or corpus padding."""
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "literature"))
from search_lib import collect, entrypoint, normalize
from search_lib.screening import (
    POLICY_VERSION, abstract_hash, paper_identity, quality_eligibility,
    merge_candidate_records, screen_papers, screening_context,
)

OBJECTIVE = "Clarify user preferences during safe language-guided robot manipulation."
SOURCES = ["openalex", "crossref", "arxiv"]
ABSTRACT = (
    "We study clarification of user preferences during robot manipulation. "
    "Our method asks a contrastive language question before selecting a safe grasp. "
    "Experiments show fewer unnecessary interventions with preserved task success."
)


def paper(**overrides):
    record = {"title": "Contrastive questions for robot manipulation", "doi": "10.1234/robot",
              "abstract": ABSTRACT, "year": date.today().year, "type": "article",
              "source": "openalex", "journal": "Robotics Example", "cited_by_count": None}
    record.update(overrides)
    return record


def review(record, decision="directly_relevant", objective=OBJECTIVE):
    return {
        "paper_id": paper_identity(record), "objective_hash": screening_context(objective, SOURCES)["objective_hash"],
        "abstract_sha256": abstract_hash(record), "abstract_read_in_full": True,
        "reviewer": {"kind": "codex_cli", "identity": "gpt-5.6-sol"},
        "reviewed_at": date.today().isoformat(), "decision": decision,
        # Distinct per paper, because a reason reused word-for-word across two
        # papers is the template signature the screening gate now rejects -- and
        # rightly: v90 admitted 252 papers sharing four reasons between them. A
        # fixture that reuses one sentence for every record was testing a bundle
        # no real reviewer produces.
        "direct_relevance_reason": (
            f"The study directly tests clarification of preferences during safe robot manipulation "
            f"({record.get('doi') or record.get('title')})."
        ),
        "supporting_passage": "We study clarification of user preferences during robot manipulation.",
        "linkage": {
            "study_task": {"abstract_evidence": "clarification of user preferences during robot manipulation",
                           "objective_link": "The studied task is the objective's robot preference clarification task."},
            "method": {"abstract_evidence": "asks a contrastive language question before selecting a safe grasp",
                       "objective_link": "The question policy directly operationalizes clarification before safe action."},
            "outcome": {"abstract_evidence": "fewer unnecessary interventions with preserved task success",
                        "objective_link": "The intervention and success measures assess the objective's safe execution tradeoff."},
        },
        "limitations": "The abstract does not establish generalization to a different robot or user population.",
    }


def bundle(*reviews, objective=OBJECTIVE):
    return {"policy_version": POLICY_VERSION,
            "context_hash": screening_context(objective, SOURCES)["context_hash"], "reviews": list(reviews)}


def citation(value):
    return {"value": value, "source": "openalex", "source_url": "https://api.openalex.org/works/W1",
            "observed_at": date.today().isoformat()}


class AbstractScreeningTest(unittest.TestCase):
    def test_paraphrase_cannot_pass_as_source_abstract(self):
        record = paper(abstract_text_kind="abstract_summary")
        accepted, audit = screen_papers([record], OBJECTIVE, SOURCES, bundle(review(record)))
        self.assertEqual(accepted, [])
        self.assertIn("original_abstract_required_not_summary", audit["quarantined"][0]["reasons"])

    def test_screened_paper_does_not_complete_search_without_journal(self):
        accepted, _ = screen_papers([paper()], OBJECTIVE, SOURCES, bundle(review(paper())))
        result = {"status": "completed", "papers": accepted, "evidence_ready": True}
        with tempfile.TemporaryDirectory() as tmp:
            entrypoint.apply_search_agent_assessment(result, Path(tmp), {
                "search_agent_contract": {"contract_version": "adaptive-search-agent-v1"}})
        self.assertEqual(result["status"], "insufficient_corpus")
        self.assertTrue(result["evidence_ready"])
        self.assertEqual(len(result["papers"]), 1)
        self.assertFalse(result["search_decision_ready"])

    def test_durable_inquiries_reuse_reviews_and_reject_objective_drift(self):
        plan = {"objective": OBJECTIVE, "search_agent_contract": {"contract_version": "adaptive-search-agent-v1"}}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            batch = {"query": "first precise question", "sources": SOURCES, "papers": [paper()]}
            first = entrypoint.persist_candidate_batch(out, batch, plan)
            self.assertEqual(first["counts"]["pending_review"], 1)
            self.assertEqual(first["retrieval_receipt"]["new_candidate_ids"], [paper_identity(paper())])
            (out / "abstract-reviews.json").write_text(json.dumps(bundle(review(paper()))))
            second = entrypoint.persist_candidate_batch(out, {**batch, "query": "follow a missing mechanism",
                "papers": [paper(doi="10.1234/new")], "sources": ["publisher"]}, plan)
            self.assertEqual(second["counts"]["accepted"], 1)
            self.assertEqual(second["counts"]["pending_review"], 1)
            self.assertFalse(second["search_decision_ready"])
            self.assertEqual(len((out / "search-retrieval-events.jsonl").read_text().splitlines()), 2)
            # A supplemental reviewer writes only the newly read paper. The
            # first accepted receipt remains bound to its saved original hash.
            (out / "abstract-reviews.json").write_text(json.dumps(bundle(review(paper(doi="10.1234/new")))))
            third = entrypoint.persist_candidate_batch(out, {"papers": [], "sources": [], "query": "no new hits"}, plan)
            self.assertEqual(third["counts"]["accepted"], 2)
            self.assertEqual(third["counts"]["pending_review"], 0)
            self.assertEqual(third["retrieval_receipt"]["new_candidate_ids"], [])
            self.assertEqual(third["retrieval_receipt"]["changed_abstract_ids"], [])
            duplicate = entrypoint.persist_candidate_batch(out, batch, plan)
            self.assertEqual(duplicate["retrieval_receipt"]["new_candidate_ids"], [])
            self.assertEqual(duplicate["retrieval_receipt"]["changed_abstract_ids"], [])
            self.assertEqual(duplicate["retrieval_receipt"]["newly_accepted_ids"], [])
            before = (out / "literature-candidates.json").read_bytes()
            with self.assertRaisesRegex(ValueError, "objective changed"):
                entrypoint.persist_candidate_batch(out, batch, {"objective": "Unrelated new objective"})
            self.assertEqual((out / "literature-candidates.json").read_bytes(), before)

    def test_unchanged_abstract_review_reused_while_recency_is_rechecked(self):
        record = paper(year=2024, publication_date="2024-01-01")
        early = date(2026, 9, 6)
        late = date(2028, 9, 6)
        assessment = review(record)
        reviews = {"policy_version": POLICY_VERSION,
                   "context_hash": screening_context(OBJECTIVE, SOURCES, early)["context_hash"],
                   "reviews": [assessment]}
        accepted, _ = screen_papers([record], OBJECTIVE, SOURCES, reviews, early)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(screening_context(OBJECTIVE, SOURCES, early)["context_hash"],
                         screening_context(OBJECTIVE, SOURCES, late)["context_hash"])
        accepted, audit = screen_papers([record], OBJECTIVE, SOURCES, reviews, late)
        self.assertEqual(accepted, [])
        self.assertIn("no_verified_quality_track", audit["quarantined"][0]["reasons"])

    def test_title_and_abstract_keyword_overlap_cannot_accept_without_review(self):
        accepted, audit = screen_papers([paper()], OBJECTIVE, SOURCES)
        self.assertEqual(accepted, [])
        self.assertEqual(audit["counts"]["pending_review"], 1)
        self.assertEqual(audit["review_queue"][0]["paper"]["abstract"], ABSTRACT)

    def test_metadata_only_record_is_quarantined_even_with_review_and_citations(self):
        record = paper(abstract="", cited_by_count=500, citation_count_provenance=citation(500))
        accepted, audit = screen_papers([record], OBJECTIVE, SOURCES, bundle(review(record)))
        self.assertEqual(accepted, [])
        self.assertIn("full_abstract_missing", audit["quarantined"][0]["reasons"])

    def test_high_citation_off_topic_paper_never_backfills(self):
        irrelevant = paper(doi="10.1234/irrelevant", cited_by_count=2000, citation_count_provenance=citation(2000))
        reviews = bundle(review(paper()), review(irrelevant, "irrelevant"))
        accepted, audit = screen_papers([paper(), irrelevant], OBJECTIVE, SOURCES, reviews)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(audit["counts"]["excluded"], 1)
        self.assertEqual(accepted[0]["literature_screening"]["review"]["decision"], "directly_relevant")

    def test_unquoted_or_incomplete_linkage_stays_pending(self):
        for corruption in ("quote", "method", "reviewer", "objective"):
            with self.subTest(corruption=corruption):
                assessment = review(paper())
                if corruption == "quote":
                    assessment["supporting_passage"] = "The authors proved a large benefit never stated in this abstract."
                elif corruption == "method":
                    del assessment["linkage"]["method"]
                elif corruption == "reviewer":
                    assessment["reviewer"] = {"kind": "keyword_classifier", "identity": "lexical"}
                else:
                    assessment["objective_hash"] = "different-objective"
                accepted, audit = screen_papers([paper()], OBJECTIVE, SOURCES, bundle(assessment))
                self.assertEqual(accepted, [])
                self.assertEqual(audit["counts"]["pending_review"], 1)

    def test_changed_abstract_or_objective_invalidates_old_review(self):
        accepted, _ = screen_papers([paper()], OBJECTIVE, SOURCES, bundle(review(paper())))
        for records, objective, sources in (
            ([paper(abstract=ABSTRACT + " Additional limitation.")], OBJECTIVE, SOURCES),
            (accepted, "Medical diagnosis under uncertainty", SOURCES),
        ):
            output, audit = screen_papers(records, objective, sources, bundle(review(paper())))
            self.assertEqual(output, [])
            self.assertEqual(audit["counts"]["pending_review"], 1)

    def test_adding_search_sources_preserves_identical_abstract_review(self):
        accepted, _ = screen_papers([paper()], OBJECTIVE, SOURCES, bundle(review(paper())))
        output, _ = screen_papers(accepted, OBJECTIVE, SOURCES + ["rss"])
        self.assertEqual(len(output), 1)

    def test_recent_frontier_does_not_require_citation_popularity(self):
        result = quality_eligibility(paper(cited_by_count=0, citation_count_provenance=citation(0)))
        self.assertEqual(result["tracks"], ["recent_frontier"])

    def test_old_papers_need_verified_impact_and_no_venue_name_whitelist(self):
        old = paper(year=date.today().year - 8, cited_by_count=500, journal="Nature")
        self.assertFalse(quality_eligibility(old)["eligible"])
        old["citation_count_provenance"] = citation(500)
        self.assertEqual(quality_eligibility(old)["tracks"], ["established_impact"])
        old["citation_count_provenance"]["value"] = 499
        self.assertFalse(quality_eligibility(old)["eligible"])

    def test_field_percentiles_and_venue_quartiles_require_provenance(self):
        old = paper(year=date.today().year - 8)
        old["field_normalized_citation_percentile"] = {
            **citation(95), "field_normalized": True, "field": "robotics",
            "metric_year": date.today().year - 1, "scale": "0-100",
        }
        self.assertTrue(quality_eligibility(old)["eligible"])
        old["field_normalized_citation_percentile"]["field_normalized"] = False
        self.assertFalse(quality_eligibility(old)["eligible"])
        old["venue_metrics"] = [{**citation("Q1"), "venue": old["journal"], "verified": True,
                                  "metric": "sjr_quartile", "metric_year": date.today().year - 1}]
        self.assertTrue(quality_eligibility(old)["eligible"])
        old["venue_metrics"][0]["source_url"] = ""
        self.assertFalse(quality_eligibility(old)["eligible"])

    def test_normalization_preserves_unknown_counts(self):
        self.assertIsNone(normalize.normalize_arxiv_paper({"title": "test", "summary": ABSTRACT})["cited_by_count"])
        self.assertIsNone(normalize.normalize_pubmed_paper({"uid": "123", "title": "test"})["cited_by_count"])
        self.assertIsNone(normalize.normalize_paper({"id": "https://openalex.org/W1", "display_name": "test"})["cited_by_count"])
        known = normalize.normalize_paper({"id": "https://openalex.org/W1", "display_name": "test", "cited_by_count": 0})
        self.assertEqual(known["cited_by_count"], 0)
        self.assertEqual(known["citation_count_provenance"]["source_url"], "https://api.openalex.org/works/W1")

    def test_duplicate_sources_merge_abstract_and_sourced_citations(self):
        crossref = paper(doi="10.1234/robot", source="crossref", abstract="", cited_by_count=50,
                         citation_count_provenance={**citation(50), "source": "crossref"})
        openalex = paper(doi="https://doi.org/10.1234/ROBOT", cited_by_count=130,
                         citation_count_provenance=citation(130))
        for records in ([crossref, openalex], [openalex, crossref]):
            merged = merge_candidate_records(records)
            self.assertEqual(len(merged), 1)
            self.assertEqual(merged[0]["abstract"], ABSTRACT)
            self.assertEqual(merged[0]["cited_by_count"], 130)
            self.assertEqual(len(merged[0]["citation_observations"]), 2)

    def test_collection_never_synthesizes_unreviewed_retrieval(self):
        stats = {"sources_attempted": SOURCES, "source_hits": {"openalex": 1}, "source_failures": []}
        with (patch.object(collect, "collect_query_papers", return_value=([paper()], stats)) as retrieve,
              patch.object(collect, "infer_frontier_catalog") as infer,
              patch.object(collect, "generate_hypothesis_scenarios") as hypotheses):
            accepted, audit = collect.collect_papers(["robot preferences"], {"objective": OBJECTIVE})
        self.assertEqual(accepted, [])
        self.assertEqual(retrieve.call_count, 1, "no minimum-count expansion/backfill")
        infer.assert_not_called()
        hypotheses.assert_not_called()
        self.assertEqual(audit["screening"]["counts"]["pending_review"], 1)

    def test_driver_publishes_pending_queue_but_no_runner_handoff(self):
        stats = {"sources_attempted": SOURCES, "source_hits": {"openalex": 1}, "source_failures": []}
        _, empty_screening = screen_papers([], OBJECTIVE, SOURCES)
        local_stats = {"sources_attempted": ["local-scout-cache"], "source_hits": {},
                       "source_failures": [], "screening": empty_screening}
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            role_path = out / "role-plan.json"
            role_path.write_text(json.dumps({"objective": OBJECTIVE}))
            with (patch.object(entrypoint, "queries_from_role_plan", return_value=["robot preferences"]),
                  patch.object(collect, "collect_query_papers", return_value=([paper()], stats)),
                  patch.object(entrypoint, "synthesize_from_local_papers", return_value=([], local_stats)),
                  patch.object(entrypoint, "build_analyst_handoff") as handoff,
                  patch.object(entrypoint, "build_statistical_review_memo") as memo):
                result = entrypoint.run_driver(out, "analyst", None, None, role_path)
            handoff.assert_not_called()
            memo.assert_not_called()
            self.assertEqual(result["status"], "pending_review")
            self.assertFalse(result["evidence_ready"])
            self.assertEqual(json.loads((out / "papers.json").read_text()), [])
            self.assertEqual(len(json.loads((out / "abstract-review-queue.json").read_text())["candidates"]), 1)
            self.assertFalse((out / "handoff-validation-plan.json").exists())

    def test_finalize_is_offline_and_removes_stale_synthesis(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            _, initial = screen_papers([paper()], OBJECTIVE, SOURCES)
            entrypoint.write_screening_artifacts(out, initial)
            (out / "result.json").write_text(json.dumps({"analyst_handoff": {"stale": True},
                                                       "source_stats": {"statistical_review_memo": {"stale": True}}}))
            (out / "handoff-validation-plan.json").write_text(json.dumps({"checks": ["stale-check"]}))
            reviews_path = out / "reviews.json"
            reviews_path.write_text(json.dumps(bundle(review(paper()))))
            with (patch.object(entrypoint, "collect_query_papers", side_effect=AssertionError("must be offline")),
                  patch.object(entrypoint, "infer_frontier_catalog", return_value={}),
                  patch.object(entrypoint, "generate_hypothesis_scenarios", return_value=[])):
                result = entrypoint.finalize_review_dir(out, reviews_path)
            self.assertEqual(result["paper_count"], 1)
            self.assertNotIn("analyst_handoff", result)
            self.assertNotIn("statistical_review_memo", result["source_stats"])
            self.assertEqual(len(json.loads((out / "papers.json").read_text())), 1)
            self.assertEqual(json.loads((out / "abstract-review-queue.json").read_text())["candidates"], [])
            self.assertEqual(json.loads((out / "handoff-validation-plan.json").read_text())["status"], "blocked")
            self.assertEqual(len(list((out / "superseded-literature-handoffs").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
