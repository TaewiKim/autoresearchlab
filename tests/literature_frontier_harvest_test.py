"""Forward-citation frontier harvest, with the network replaced by recorded shapes.

Regression guard for cycle-b-20260919, 2026-09-19: SimToolReal (arXiv
2602.16863, 17 citations about seven months after release) cites five of the
landscape's canonical anchors, yet no landscape ever named it -- the scout named
works from memory, and memory ends at the model's knowledge horizon. A harvest
from the anchors' citation lists must rank such a paper above an older paper
that cites one anchor and has more citations, and must drop anything dated
before ``since``.
"""

import json
import os
import shutil
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
from drivers.literature.search_lib import frontier  # noqa: E402

AS_OF = date(2026, 9, 19)
ANCHORS = [
    {"paper_id": "doi:10.48550/arxiv.2303.04137", "title": "Diffusion Policy"},
    {"paper_id": "doi:10.15607/rss.2023.xix.016", "title": "Learning Fine-Grained Bimanual Manipulation with Low-Cost Hardware"},
    {"paper_id": "arxiv_id:1808.00177", "title": "Learning dexterous in-hand manipulation"},
    {"paper_id": "doi:10.15607/rss.2021.xvii.011", "title": "RMA: Rapid Motor Adaptation for Legged Robots"},
    {"paper_id": "arxiv_id:2108.10470", "title": "Isaac Gym"},
]
ANCHOR_S2 = ["a" * 40, "b" * 40, "c" * 40, "d" * 40, "e" * 40]


def citing(paper_id, title, published, citations, arxiv=None):
    return {"paperId": paper_id, "title": title, "abstract": f"Abstract of {title}.",
            "year": int(published[:4]), "publicationDate": published, "citationCount": citations,
            "venue": "", "externalIds": {"ArXiv": arxiv} if arxiv else {}}


SIMTOOLREAL = citing("9242b2482f96cdc183ad9a46906d85b39b092172",
                     "SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation",
                     "2026-02-18", 17, "2602.16863")
OLD_POPULAR = citing("f" * 40, "An older paper citing one anchor", "2021-09-01", 40)
BEFORE_SINCE = citing("0" * 40, "A frontier-looking paper from before the horizon", "2024-06-01", 300)
ONE_ANCHOR_NEW = citing("1" * 40, "A new paper citing a single anchor", "2026-03-01", 90)


class FakeGraph:
    """Answers the Graph API URLs frontier.py builds; records every URL."""

    def __init__(self, citations, references=None, page_size=None):
        self.citations = citations  # s2 id -> [records]
        self.references = references or {}
        self.page_size = page_size
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        parsed = urllib.parse.urlsplit(url)
        path = urllib.parse.unquote(parsed.path)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        assert parsed.netloc == "api.semanticscholar.org", url
        if path.endswith("/paper/search"):
            title = query["query"]
            index = next(i for i, anchor in enumerate(ANCHORS) if anchor["title"] == title)
            return {"data": [{"paperId": ANCHOR_S2[index], "title": title, "citationCount": 1000}]}
        if path.endswith("/citations"):
            s2 = path.split("/paper/", 1)[1].rsplit("/citations", 1)[0]
            rows = self.citations.get(s2, [])
            offset, limit = int(query["offset"]), int(query["limit"])
            if self.page_size:
                limit = min(limit, self.page_size)
            page = rows[offset:offset + limit]
            payload = {"offset": offset, "data": [{"citingPaper": row} for row in page]}
            if offset + limit < len(rows):
                payload["next"] = offset + limit
            return payload
        if path.endswith("/references"):
            s2 = path.split("/paper/", 1)[1].rsplit("/references", 1)[0]
            return {"data": [{"citedPaper": {"paperId": ref}} for ref in self.references.get(s2, [])]}
        # One anchor by id: resolve it to the same record the title search finds.
        ident = path.split("/paper/", 1)[1]
        for index, anchor in enumerate(ANCHORS):
            if frontier.graph_id(anchor["paper_id"]) == ident:
                return {"paperId": ANCHOR_S2[index], "title": anchor["title"], "citationCount": 1000}
        raise AssertionError(f"unexpected request {url}")


class FrontierHarvestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patcher = mock.patch.object(frontier, "FRONTIER_CACHE_ROOT", Path(self.temp.name) / "cache")
        patcher.start()
        self.addCleanup(patcher.stop)

    def harvest(self, citations, since, keep_cache=False, **kwargs):
        if not keep_cache:
            shutil.rmtree(frontier.FRONTIER_CACHE_ROOT, ignore_errors=True)
        graph = FakeGraph(citations, kwargs.pop("references", None), kwargs.pop("page_size", None))
        report = frontier.run_frontier_harvest(ANCHORS, since, as_of=AS_OF, fetch=graph, **kwargs)
        return report, graph

    def test_the_simtoolreal_case(self):
        # SimToolReal cites all five anchors; the old paper cites one.
        citations = {s2: [SIMTOOLREAL] for s2 in ANCHOR_S2}
        citations[ANCHOR_S2[0]] = [SIMTOOLREAL, OLD_POPULAR]
        # With a since that admits the 2021 paper, and no co-citation floor,
        # the ranking alone must put SimToolReal first.
        with mock.patch.dict(os.environ, {"RESEARCHLAB_FRONTIER_MIN_CO_CITATION": "1"}):
            report, _ = self.harvest(citations, date(2020, 1, 1))
        titles = [item["title"] for item in report["candidates"]]
        self.assertEqual(titles[0], SIMTOOLREAL["title"])
        self.assertLess(titles.index(SIMTOOLREAL["title"]), titles.index(OLD_POPULAR["title"]))
        top = report["candidates"][0]
        self.assertEqual(top["co_citation"], 5)
        self.assertEqual(top["citation_count"], 17)
        self.assertEqual(len(top["cites_anchors"]), 5)
        self.assertTrue(top["post_horizon"])
        old = next(item for item in report["candidates"] if item["title"] == OLD_POPULAR["title"])
        self.assertGreater(old["months_since_publication"], 59)
        self.assertGreater(top["velocity"], old["velocity"])

        # At the real horizon a heavily cited paper that cites three anchors but
        # predates it is gone, as is the 2021 paper; the default floor would
        # drop a one-anchor paper anyway.
        for s2 in ANCHOR_S2[:3]:
            citations[s2] = citations[s2] + [BEFORE_SINCE]
        report, _ = self.harvest(citations, date(2025, 11, 1))
        titles = [item["title"] for item in report["candidates"]]
        self.assertEqual(titles, [SIMTOOLREAL["title"]])
        self.assertEqual(report["scoring"]["min_co_citation"], 2)
        self.assertEqual(report["top_k_ids"], ["arxiv_id:2602.16863"])
        self.assertIn("co_citation * log1p(1 + velocity)", report["scoring"]["formula"])

    def test_score_formula(self):
        new = frontier.score_candidate(5, 17, date(2026, 2, 18), AS_OF)
        old = frontier.score_candidate(1, 40, date(2021, 9, 19), AS_OF)
        self.assertGreater(new["score"], old["score"])
        self.assertAlmostEqual(old["months_since_publication"], 60.0, delta=0.5)
        # A brand-new paper has velocity at most its count (months floored at 1).
        fresh = frontier.score_candidate(2, 3, date(2026, 9, 10), AS_OF)
        self.assertEqual(fresh["velocity"], 3.0)

    def test_a_single_anchor_citer_is_below_the_floor_unless_one_anchor_resolved(self):
        citations = {ANCHOR_S2[0]: [ONE_ANCHOR_NEW]}
        report, _ = self.harvest(citations, date(2025, 11, 1))
        self.assertEqual(report["candidates"], [])
        self.assertEqual(frontier.min_co_citation(1), 1)

    def test_pages_are_capped_cached_and_the_cap_is_reported(self):
        many = [citing(f"{index:040d}", f"Paper {index}", "2026-01-01", index) for index in range(1, 26)]
        citations = {ANCHOR_S2[0]: many, ANCHOR_S2[1]: many}
        with mock.patch.dict(os.environ, {"RESEARCHLAB_FRONTIER_MAX_PAGES_PER_ANCHOR": "2",
                                          "RESEARCHLAB_FRONTIER_PAGE_SIZE": "10"}):
            report, graph = self.harvest(citations, date(2025, 11, 1))
            first = next(item for item in report["anchors"] if item["records"] and item["records"][0]["paperId"] == ANCHOR_S2[0])
            self.assertTrue(first["truncated"])
            self.assertEqual(first["harvest"][0]["pages_fetched"], 2)
            self.assertEqual(first["harvest"][0]["citing_seen"], 20)
            self.assertIn(first["anchor_id"], report["truncated_anchors"])
            self.assertEqual(report["candidate_count"], 20)
            # Every request is a GET URL on the allowed citation route.
            self.assertTrue(all("/citations?" in url or "/paper/search?" in url or "fields=" in url for url in graph.urls))
            requests = report["request_stats"]["graph_requests"]
            # The same harvest again is served from the TTL cache.
            again, graph_again = self.harvest(citations, date(2025, 11, 1), keep_cache=True)
            self.assertEqual(graph_again.urls, [])
            self.assertEqual(again["request_stats"]["graph_requests"], 0)
            self.assertEqual(again["request_stats"]["cache_hits"], requests)

    def test_top_k_joins_the_review_queue_and_stale_candidates_are_revived(self):
        root = Path(self.temp.name)
        # A gatekeeper lane retrieved SimToolReal once and never reviewed it.
        gatekeeper = root / "lanes" / "cycle" / "followup-gatekeeper-02" / "prior-art"
        gatekeeper.mkdir(parents=True)
        stale_paper = {"title": SIMTOOLREAL["title"], "doi": "10.48550/arXiv.2602.16863", "arxiv_id": "2602.16863",
                       "semanticscholar_id": SIMTOOLREAL["paperId"], "year": 2026, "publication_date": "2026-02-18",
                       "cited_by_count": 17, "abstract": "Abstract.", "source": "semanticscholar"}
        (gatekeeper / "abstract-review-queue.json").write_text(json.dumps({"candidates": [
            {"paper_id": "doi:10.48550/arxiv.2602.16863", "status": "pending_abstract_review", "paper": stale_paper},
        ]}), encoding="utf-8")
        # The page cap never reaches it: no anchor's citation list holds it.
        citations = {ANCHOR_S2[0]: [OLD_POPULAR]}
        references = {SIMTOOLREAL["paperId"]: ANCHOR_S2 + ["9" * 40]}
        lane = root / "artifacts" / "frontier-lane"
        plan = {"objective": "Pick ONE falsifiable question across dexterous manipulation and sim-to-real."}
        report, graph = self.harvest(citations, date(2025, 11, 1), references=references,
                                     output_dir=lane, role_plan=plan, top_k=5, revive_roots=[root / "lanes"])
        self.assertEqual(report["revived"]["stale_found"], 1)
        self.assertEqual(report["revived"]["checked"], 1)
        top = report["candidates"][0]
        self.assertEqual(top["title"], SIMTOOLREAL["title"])
        self.assertEqual(top["co_citation"], 5)
        self.assertIn("revived_unreviewed", top["sources"])
        self.assertTrue(top["previously_retrieved_in"])
        # Queued for review through the lane's normal import path.
        queue = json.loads((lane / "abstract-review-queue.json").read_text(encoding="utf-8"))
        queued = [item["paper"]["title"] for item in queue["candidates"]]
        self.assertEqual(queued, [SIMTOOLREAL["title"]])
        self.assertEqual(queue["candidates"][0]["status"], "pending_abstract_review")
        self.assertTrue(queue["candidates"][0]["paper"]["frontier_harvest"]["post_horizon"])
        result = json.loads((lane / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "pending_review")
        self.assertEqual(result["frontier_harvest"]["top_k_ids"], report["top_k_ids"])
        written = json.loads((lane / "frontier-candidates.json").read_text(encoding="utf-8"))
        self.assertEqual(written["top_k_ids"], [queue["candidates"][0]["paper_id"]])

        # Once some lane of the cycle excludes it with a reason, it is no longer stale.
        (gatekeeper / "literature-screening-audit.json").write_text(json.dumps({
            "excluded": [{"paper": stale_paper, "status": "excluded", "reasons": ["abstract_review_irrelevant"]}],
            "quarantined": [], "pending_review_ids": [],
        }), encoding="utf-8")
        stale, resolved = frontier.cycle_screening_state([root / "lanes"])
        self.assertEqual(stale, {})
        self.assertIn("arxiv:2602.16863", resolved)

    def test_a_throttled_page_is_retried_not_dropped(self):
        citations = {s2: [SIMTOOLREAL] for s2 in ANCHOR_S2}
        graph = FakeGraph(citations)
        refused = []

        def flaky(url):
            if "/citations" in url and len(refused) < 2:
                refused.append(url)
                raise urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)
            return graph(url)

        shutil.rmtree(frontier.FRONTIER_CACHE_ROOT, ignore_errors=True)
        with mock.patch.object(frontier, "_sleep") as slept:
            report = frontier.run_frontier_harvest(ANCHORS, date(2025, 11, 1), as_of=AS_OF, fetch=flaky)
        self.assertEqual(len(refused), 2)
        self.assertEqual(slept.call_count, 2)
        self.assertEqual(report["request_stats"]["throttled_retries"], 2)
        self.assertEqual(report["candidates"][0]["co_citation"], 5)
        self.assertEqual(report["truncated_anchors"], [])

    def test_a_year_only_record_is_kept_but_aged_from_the_start_of_its_year(self):
        year_only = {**citing("2" * 40, "A record with only a year", "2026-01-01", 19), "publicationDate": None}
        citations = {ANCHOR_S2[0]: [year_only], ANCHOR_S2[1]: [year_only]}
        report, _ = self.harvest(citations, date(2025, 11, 1))
        item = report["candidates"][0]
        self.assertEqual(item["date_precision"], "year")
        self.assertEqual(item["publication_date"], "2026-12-31")
        self.assertLess(item["velocity"], 2.5)

    def test_the_deadline_stops_the_harvest_and_still_writes_what_it_has(self):
        citations = {s2: [SIMTOOLREAL] for s2 in ANCHOR_S2}
        lane = Path(self.temp.name) / "lane"
        # Two anchors fit before the clock passes the deadline.
        clock = [0.0] + [1.0] * 4 + [100.0] * 500
        with mock.patch.dict(os.environ, {"RESEARCHLAB_FRONTIER_DEADLINE_SECONDS": "5"}):
            with mock.patch.object(frontier.time, "monotonic", side_effect=clock):
                report, _ = self.harvest(citations, date(2025, 11, 1), output_dir=lane)
        self.assertEqual(len(report["truncated_anchors"]), 3)
        self.assertTrue(report["deadline_reached"])
        self.assertTrue(report["truncated_anchors"])
        self.assertTrue((lane / "frontier-candidates.json").is_file())
        self.assertEqual(json.loads((lane / "result.json").read_text(encoding="utf-8"))["status"], "completed")

    def test_the_horizon_comes_from_configuration_not_code(self):
        with mock.patch.dict(os.environ, {"RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON": "2025-11-01"}):
            self.assertEqual(frontier.knowledge_horizon(AS_OF), (date(2025, 11, 1), "RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON"))
        env = {key: value for key, value in os.environ.items() if key != "RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON"}
        with mock.patch.dict(os.environ, env, clear=True):
            since, source = frontier.knowledge_horizon(AS_OF)
            self.assertEqual(since, date(2025, 3, 19))
            self.assertIn("18 months", source)
            with mock.patch.dict(os.environ, {"RESEARCHLAB_FRONTIER_WINDOW_MONTHS": "7"}):
                self.assertEqual(frontier.knowledge_horizon(date(2026, 3, 31))[0], date(2025, 8, 31))

    def test_cycle_ids_map_to_graph_ids(self):
        self.assertEqual(frontier.graph_id("doi:10.48550/arxiv.2303.04137"), "arXiv:2303.04137")
        self.assertEqual(frontier.graph_id("arxiv_id:2107.14483"), "arXiv:2107.14483")
        self.assertEqual(frontier.graph_id("doi:10.1177/02783649241273668"), "DOI:10.1177/02783649241273668")
        self.assertEqual(frontier.graph_id("9242b2482f96cdc183ad9a46906d85b39b092172"), "9242b2482f96cdc183ad9a46906d85b39b092172")
        self.assertEqual(frontier.graph_id("openalex_id:W123"), "")

    def test_the_citation_route_passes_the_scholarly_network_policy(self):
        from drivers.literature.search_lib.http_client import validate_approved_scholarly_metadata_request

        url = ("https://api.semanticscholar.org/graph/v1/paper/arXiv:2303.04137/citations?"
               + urllib.parse.urlencode({"fields": frontier.FRONTIER_CITATION_FIELDS, "limit": "1000", "offset": "0"}))
        self.assertTrue(validate_approved_scholarly_metadata_request(url).startswith("https://api.semanticscholar.org/"))


if __name__ == "__main__":
    unittest.main()
