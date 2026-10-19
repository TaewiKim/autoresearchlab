#!/usr/bin/env python3
"""Known-item lookup: fetch THIS paper, then screen it like any other.

MEASURED ON cycle-b-20260918, 2026-09-18/19: 4,617 retrieved candidates
and 290 accepted papers held none of Diffusion Policy, RT-2, OpenVLA, Open
X-Embodiment, Eureka or legged_gym. Keyword search could not ask for a paper by
name, and the one source that indexes those proceedings well was not wired in.

These tests replace the network with recorded response shapes. They pin that
resolution is conservative (one clearly best work, or nothing), that a resolved
paper's fields stay attributed, and that it enters the SAME pending review
queue under the SAME quality rules.
"""
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from datetime import date
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib import constants, entrypoint, http_client, providers, title_lookup
from drivers.literature.search_lib.normalize import normalize_arxiv_paper, normalize_semanticscholar_paper
from drivers.literature.search_lib.screening import quality_eligibility, screen_papers

TITLE = "Diffusion Policy: Visuomotor Policy Learning via Action Diffusion"
ABSTRACT = (
    "This paper introduces Diffusion Policy, a new way of generating robot behavior by representing a "
    "robot's visuomotor policy as a conditional denoising diffusion process. We benchmark Diffusion Policy "
    "across 15 different tasks from 4 different robot manipulation benchmarks."
)
OBJECTIVE = "Which robot-learning claims can this PC's simulators test, for manipulation policies?"


def arxiv_entry(title=TITLE, arxiv_id="2303.04137", published="2019-03-07T17:57:41Z", summary=ABSTRACT):
    return {"title": title, "summary": summary, "published": published,
            "id": f"http://arxiv.org/abs/{arxiv_id}v5", "doi": "", "authors": ["Cheng Chi"],
            "categories": ["cs.RO"]}


def s2_record(title=TITLE, arxiv_id="2303.04137", doi="10.1177/02783649241273668", citations=4211,
              abstract=ABSTRACT, year=2019, date_="2019-03-07"):
    external = {"CorpusId": 257378658}
    if arxiv_id:
        external["ArXiv"] = arxiv_id
    if doi:
        external["DOI"] = doi
    return {"paperId": "bdba3bd30a49ea4c5b20b43dbd8f0eb59e9d80e2", "externalIds": external,
            "title": title.lower(), "abstract": abstract, "year": year, "publicationDate": date_,
            "venue": "Robotics: Science and Systems Conference",
            "publicationVenue": {"name": "Robotics: Science and Systems Conference", "type": "conference"},
            "citationCount": citations, "influentialCitationCount": 852,
            "publicationTypes": ["JournalArticle"], "authors": [{"authorId": "1", "name": "Cheng Chi"}],
            "journal": {"name": "The International Journal of Robotics Research"},
            "openAccessPdf": {"url": "http://arxiv.org/pdf/2303.04137", "status": "GREEN"}}


def openalex_work(title=TITLE, doi="https://doi.org/10.1177/02783649241273668", cited=900):
    return {"id": "https://openalex.org/W4403337227", "display_name": title, "publication_year": 2024,
            "publication_date": "2024-10-01", "doi": doi, "cited_by_count": cited, "type": "article",
            "primary_location": {"source": {"display_name": "The International Journal of Robotics Research"},
                                 "landing_page_url": doi},
            "abstract_inverted_index": None, "ids": {}, "open_access": {"is_oa": False}}


def crossref_item(title, doi):
    return {"DOI": doi, "title": [title], "type": "journal-article", "container-title": ["Some Journal"],
            "issued": {"date-parts": [[2022]]}, "is-referenced-by-count": 3}


def http_error(code):
    return urllib.error.HTTPError("https://example.invalid", code, "error", {}, None)


class Sources:
    """Patch the four title sources with canned replies (or exceptions)."""

    def __init__(self, arxiv=(), s2=(), openalex=(), crossref=(), by_id=None):
        self.replies = {"arxiv": arxiv, "s2": s2, "openalex": openalex, "crossref": crossref}
        self.by_id = by_id or {}

    def _reply(self, key):
        reply = self.replies[key]
        if isinstance(reply, Exception):
            raise reply
        return list(reply)

    def __enter__(self):
        self.patches = [
            mock.patch.object(title_lookup, "search_arxiv_title", side_effect=lambda t: self._reply("arxiv")),
            mock.patch.object(title_lookup, "semanticscholar_match_title", side_effect=lambda t: self._reply("s2")),
            mock.patch.object(title_lookup, "search_openalex_title", side_effect=lambda t: self._reply("openalex")),
            mock.patch.object(title_lookup, "search_crossref_title", side_effect=lambda t: self._reply("crossref")),
            mock.patch.object(title_lookup, "semanticscholar_paper", side_effect=lambda ref: self.by_id.get(ref)),
            mock.patch.object(title_lookup, "fetch_arxiv_ids", side_effect=lambda ids: self.by_id.get("arxiv", [])),
            mock.patch.object(title_lookup, "lookup_crossref_doi", return_value=None),
            mock.patch.object(title_lookup, "lookup_openalex_doi", return_value=[]),
        ]
        for patch in self.patches:
            patch.start()
        return self

    def __exit__(self, *exc):
        for patch in self.patches:
            patch.stop()
        return False


class TitleSimilarityTest(unittest.TestCase):
    def test_exact_titles_match_regardless_of_case_and_punctuation(self):
        self.assertEqual(title_lookup.title_similarity(TITLE, TITLE.lower() + "."), 1.0)
        self.assertEqual(title_lookup.title_similarity(
            "RT-2: Vision-Language-Action Models", "RT 2 - vision language action models"), 1.0)

    def test_a_different_paper_scores_below_the_ambiguity_floor(self):
        score = title_lookup.title_similarity(TITLE, "Consistency Policy: Accelerated Visuomotor Policies via Consistency Distillation")
        self.assertLess(score, title_lookup.AMBIGUOUS_FLOOR)

    def test_a_name_before_the_subtitle_reaches_the_threshold_but_no_further(self):
        self.assertEqual(title_lookup.title_similarity("Diffusion Policy", TITLE), title_lookup.MATCH_THRESHOLD)


class ResolutionTest(unittest.TestCase):
    def test_one_work_across_sources_is_merged_with_every_field_attributed(self):
        unrelated = crossref_item("Diffusion Policies as an Expressive Policy Class for Offline RL", "10.1/other")
        with Sources(arxiv=[arxiv_entry()], s2=[s2_record()], openalex=[openalex_work()], crossref=[unrelated]):
            resolution = title_lookup.resolve_reference("title", TITLE)
        self.assertEqual(resolution["status"], "matched")
        self.assertEqual(resolution["matched_sources"], ["arxiv", "openalex", "semanticscholar"])
        paper = resolution["paper"]
        # The author's own abstract, attributed to the preprint it came from.
        self.assertEqual(paper["abstract"], ABSTRACT)
        self.assertEqual(paper["abstract_provenance"]["source"], "arxiv")
        # The largest SOURCED citation observation, never a sum.
        self.assertEqual(paper["cited_by_count"], 4211)
        self.assertEqual(paper["citation_count_provenance"]["source"], "semanticscholar")
        self.assertTrue(paper["citation_count_provenance"]["source_url"].startswith("https://api.semanticscholar.org/"))
        # The earliest date: the recency track can only get stricter.
        self.assertEqual(paper["publication_date"], "2019-03-07")
        self.assertEqual(paper["doi"], "10.1177/02783649241273668")
        self.assertEqual(paper["arxiv_id"], "2303.04137")
        self.assertNotEqual(paper["journal"], "arXiv")
        self.assertEqual(paper["title_resolution"]["status"], "matched")

    def test_two_different_works_with_the_same_title_are_ambiguous(self):
        twins = [arxiv_entry(arxiv_id="2303.04137"), arxiv_entry(arxiv_id="2401.00001", published="2024-01-01T00:00:00Z")]
        with Sources(arxiv=twins):
            resolution = title_lookup.resolve_reference("title", TITLE)
        self.assertEqual(resolution["status"], "ambiguous")
        self.assertIsNone(resolution["paper"])
        self.assertEqual(len(resolution["candidates"]), 2)

    def test_a_short_name_shared_by_two_works_is_ambiguous(self):
        other = arxiv_entry(title="Diffusion Policy: A Survey of Generative Control", arxiv_id="2501.00002",
                            published="2025-01-01T00:00:00Z")
        with Sources(arxiv=[arxiv_entry(), other]):
            resolution = title_lookup.resolve_reference("title", "Diffusion Policy")
        self.assertEqual(resolution["status"], "ambiguous")

    def test_a_near_miss_is_ambiguous_and_nothing_at_all_is_not_found(self):
        near = arxiv_entry(title="Diffusion Policy: Visuomotor Policy Learning with Action Diffusion Models")
        with Sources(arxiv=[near]):
            self.assertIn(title_lookup.resolve_reference("title", TITLE)["status"], {"ambiguous", "matched"})
        far = arxiv_entry(title="Learning Agile Robotic Locomotion Skills by Imitating Animals")
        with Sources(arxiv=[far]):
            resolution = title_lookup.resolve_reference("title", TITLE)
        self.assertEqual(resolution["status"], "not_found")
        self.assertIsNone(resolution["paper"])

    def test_a_refused_source_is_recorded_and_the_others_still_answer(self):
        with Sources(arxiv=[arxiv_entry()], s2=http_error(429), openalex=http_error(503)):
            resolution = title_lookup.resolve_reference("title", TITLE)
        self.assertEqual(resolution["status"], "matched")
        failures = {item["source"]: item["throttled"] for item in resolution["source_failures"]}
        self.assertEqual(failures, {"semanticscholar": True, "openalex": True})

    def test_an_identifier_lookup_matches_only_a_record_carrying_that_identifier(self):
        with Sources(by_id={"arXiv:2303.04137": s2_record(), "arxiv": [arxiv_entry()]}):
            resolution = title_lookup.resolve_reference("arxiv_id", "https://arxiv.org/abs/2303.04137v5")
        self.assertEqual(resolution["status"], "matched")
        self.assertEqual(resolution["request"]["value"], "2303.04137")
        self.assertEqual(resolution["paper"]["cited_by_count"], 4211)
        wrong = s2_record(arxiv_id="1111.11111")
        with Sources(by_id={"arXiv:2303.04137": wrong}):
            self.assertEqual(title_lookup.resolve_reference("arxiv_id", "2303.04137")["status"], "not_found")
        self.assertEqual(title_lookup.resolve_reference("doi", "not-a-doi")["status"], "invalid_request")

    def test_a_resolved_paper_takes_the_identity_the_lane_already_knows(self):
        existing = normalize_arxiv_paper(arxiv_entry())
        with Sources(s2=[s2_record()]):
            resolved = title_lookup.resolve_reference("title", TITLE)["paper"]
        aligned = title_lookup.align_with_existing([resolved], [existing])[0]
        self.assertEqual(aligned["url"], existing["url"])
        self.assertIsNone(aligned["doi"])
        self.assertEqual(aligned["title_resolution"]["ids"]["doi"], "10.1177/02783649241273668")


class ScreeningPathTest(unittest.TestCase):
    """The lookup changes what is FETCHED, never what is ADMITTED."""

    def test_a_resolved_landmark_enters_the_pending_queue_on_a_sourced_count(self):
        with tempfile.TemporaryDirectory() as tmp, Sources(arxiv=[arxiv_entry()], s2=[s2_record()]):
            out = Path(tmp) / "lane"
            result = entrypoint.lookup_known_papers([TITLE, "An Unknown Paper Title Nobody Wrote"], [], [],
                                                    out, {"objective": OBJECTIVE})
            queue = json.loads((out / "abstract-review-queue.json").read_text(encoding="utf-8"))
            accepted = json.loads((out / "papers.json").read_text(encoding="utf-8"))
        self.assertEqual(result["resolution_counts"]["matched"], 1)
        self.assertEqual(result["resolution_counts"]["not_found"], 1)
        self.assertEqual(result["durable_inquiry"]["counts"]["pending_review"], 1)
        self.assertEqual(accepted, [], "a lookup never admits without an abstract review")
        candidate = queue["candidates"][0]
        self.assertEqual(candidate["status"], "pending_abstract_review")
        self.assertEqual(candidate["quality"]["tracks"], ["established_impact"])

    def test_the_rule_is_unchanged_an_arxiv_record_alone_still_has_no_track(self):
        # The finding, pinned: an older arXiv record carries no citation count,
        # so it cannot reach established_impact. The fix supplies a sourced count;
        # it does not loosen the rule.
        today = date(2026, 9, 19)
        alone = normalize_arxiv_paper(arxiv_entry())
        self.assertEqual(quality_eligibility(alone, today)["reason"], "no_verified_quality_track")
        _, screening = screen_papers([alone], OBJECTIVE, ["arxiv"], as_of=today)
        self.assertEqual(screening["quarantined"][0]["reasons"], ["no_verified_quality_track"])
        with_count = normalize_semanticscholar_paper(s2_record())
        self.assertEqual(quality_eligibility(with_count, today)["tracks"], ["established_impact"])
        # A count below the threshold is still below it.
        low = normalize_semanticscholar_paper(s2_record(citations=99))
        self.assertFalse(quality_eligibility(low, today)["eligible"])


class SemanticScholarProviderTest(unittest.TestCase):
    def test_a_graph_record_is_normalized_with_its_ids_and_a_sourced_count(self):
        paper = normalize_semanticscholar_paper(s2_record())
        self.assertEqual(paper["source"], "semanticscholar")
        self.assertEqual(paper["doi"], "10.1177/02783649241273668")
        self.assertEqual(paper["arxiv_id"], "2303.04137")
        self.assertEqual(paper["type"], "article")
        self.assertEqual(paper["journal"], "Robotics: Science and Systems Conference")
        self.assertEqual(paper["influential_citation_count"], 852)
        self.assertEqual(paper["citation_count_provenance"]["value"], 4211)
        self.assertEqual(paper["abstract"], ABSTRACT)
        preprint = normalize_semanticscholar_paper({**s2_record(doi=None), "venue": "", "publicationVenue": None,
                                                    "journal": None, "publicationTypes": None,
                                                    "citationCount": None})
        self.assertEqual((preprint["type"], preprint["journal"]), ("preprint", "arXiv"))
        self.assertIsNone(preprint["citation_count_provenance"], "an unknown count stays unknown")
        conference = normalize_semanticscholar_paper({**s2_record(), "publicationTypes": ["Conference"]})
        self.assertEqual(conference["type"], "proceedings-article")

    def test_keyword_search_sends_plain_words_within_the_page_limit(self):
        urls = []

        def fetch(url):
            urls.append(url)
            return {"data": [s2_record()]}

        found = providers.search_semanticscholar('cat:cs.RO AND ti:"sim-to-real transfer"', page_size=500, fetch=fetch)
        self.assertEqual(len(found), 1)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(urls[0]).query)
        self.assertEqual(query["query"], ["sim to real transfer"])
        self.assertEqual(query["limit"], ["100"])
        self.assertIn("citationCount", query["fields"][0])
        self.assertTrue(urls[0].startswith(constants.SEMANTIC_SCHOLAR_API_URL + "/paper/search?"))

    def test_no_title_match_is_an_empty_answer_not_an_error(self):
        def fetch(url):
            raise http_error(404)

        self.assertEqual(providers.semanticscholar_match_title(TITLE, fetch=fetch), [])
        self.assertIsNone(providers.semanticscholar_paper("arXiv:0000.00000", fetch=fetch))
        with self.assertRaises(urllib.error.HTTPError):
            providers.semanticscholar_match_title(TITLE, fetch=lambda url: (_ for _ in ()).throw(http_error(429)))

    def test_the_key_is_sent_under_the_policy_too_and_only_to_semantic_scholar(self):
        # MEASURED ON cycle-a-20260919, 2026-09-21: withheld under the
        # policy, every lane shared the anonymous pool and its 429s were the
        # cycle's most common literature failure. The key is a credential for an
        # approved host, not content from this machine.
        with mock.patch.object(providers, "fetch_json_with_headers", return_value={"data": []}) as keyed, \
             mock.patch.object(providers, "fetch_json", return_value={"data": []}) as anonymous:
            for policy in ("", http_client.APPROVED_SCHOLARLY_METADATA_POLICY):
                with mock.patch.dict(os.environ, {"RESEARCHLAB_S2_API_KEY": "k",
                                                  "RESEARCHLAB_LITERATURE_NETWORK_POLICY": policy}):
                    providers.search_semanticscholar("robot manipulation")
                self.assertEqual(keyed.call_args.args[1], {"x-api-key": "k"})
            self.assertEqual(keyed.call_count, 2)
            anonymous.assert_not_called()
            with mock.patch.dict(os.environ, {"RESEARCHLAB_S2_API_KEY": "",
                                              "RESEARCHLAB_LITERATURE_NETWORK_POLICY": http_client.APPROVED_SCHOLARLY_METADATA_POLICY}):
                providers.search_semanticscholar("robot manipulation")
            anonymous.assert_called_once()

    def test_429_backoff_is_bounded_by_the_host_budget(self):
        slept = []
        url = constants.SEMANTIC_SCHOLAR_API_URL + "/paper/search?query=robot&limit=5"

        def refuse(request):
            raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {}, None)

        with mock.patch.object(http_client, "_open_request", side_effect=refuse) as opened, \
             mock.patch.object(http_client, "_polite_throttle"), \
             mock.patch.object(http_client.time, "sleep", side_effect=slept.append), \
             mock.patch.dict(os.environ, {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": ""}):
            with self.assertRaises(urllib.error.HTTPError):
                http_client._fetch_body(url)
        budget = constants.RATE_LIMIT_TOTAL_BUDGET_BY_HOST["api.semanticscholar.org"]
        self.assertGreater(opened.call_count, 1, "a 429 is retried")
        self.assertLessEqual(sum(slept), budget)
        self.assertLess(budget, constants.RATE_LIMIT_TOTAL_BUDGET_SECONDS)

    def test_requests_are_paced_to_about_one_per_second(self):
        self.assertGreaterEqual(constants.HOST_MIN_INTERVAL_SECONDS["api.semanticscholar.org"], 1.0)

    def test_the_policy_admits_the_title_match_route_and_nothing_extra(self):
        ok = http_client.validate_approved_scholarly_metadata_request(
            constants.SEMANTIC_SCHOLAR_API_URL + "/paper/search/match?query=diffusion+policy&fields=title")
        self.assertIn("/paper/search/match", ok)
        with self.assertRaises(http_client.LiteratureNetworkPolicyError):
            http_client.validate_approved_scholarly_metadata_request(
                constants.SEMANTIC_SCHOLAR_API_URL + "/paper/search/match?query=x&callback=y")


if __name__ == "__main__":
    unittest.main()
