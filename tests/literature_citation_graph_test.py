"""Backward and forward citation inquiries without the source that ran out.

Regression guard for cycle-g-v91, 2026-09-14: OpenAlex refused every request
(429, then an exhausted anonymous daily budget), and the scouts had no other way
to run the backward- and forward-citation inquiries their contract requires.
These go through probe_citations with the network replaced by recorded shapes
of the real responses.
"""

import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from drivers.literature.search_lib import citation_graph

PARENT = "10.1145/3450626.3459812"


def index_row(citing, cited):
    return {"oci": "x", "citing": f"omid:br/1 doi:{citing} openalex:W1", "cited": f"omid:br/2 doi:{cited}"}


def registry_items(dois):
    return {"message": {"items": [
        {"DOI": doi, "title": [f"Paper {doi}"], "type": "journal-article",
         "abstract": "<jats:p>An abstract.</jats:p>", "issued": {"date-parts": [[2020]]}}
        for doi in dois
    ]}}


def throttled(url):
    return urllib.error.HTTPError(url, 429, "Too Many Requests", {}, None)


class FakeNetwork:
    def __init__(self, routes):
        self.routes = routes
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        for prefix, reply in self.routes:
            if url.startswith(prefix):
                if isinstance(reply, Exception):
                    raise reply
                return reply(url) if callable(reply) else reply
        raise AssertionError(f"unexpected request {url}")


def registry_lookup(url):
    query = url.split("filter=", 1)[1].split("&", 1)[0]
    dois = [part[len("doi:"):] for part in urllib.parse.unquote(query).split(",")]
    return registry_items(dois)


import urllib.parse  # noqa: E402  (used by registry_lookup)


def s2_neighbour(title, doi=None, arxiv=None, citations=150):
    return {"paperId": f"s2-{title}", "title": title, "abstract": f"Abstract of {title}.",
            "year": 2023, "publicationDate": "2023-05-01", "citationCount": citations,
            "externalIds": {key: value for key, value in (("DOI", doi), ("ArXiv", arxiv)) if value},
            "venue": "Conference on Robot Learning", "publicationTypes": ["Conference"]}


class CitationGraphTest(unittest.TestCase):
    def run_probe(self, routes, direction, parent=None, **kwargs):
        network = FakeNetwork(routes)

        def graph(ref, graph_direction, limit):
            # Semantic Scholar is reached through its own provider; route it
            # through the same fake so no test ever touches the real network.
            return network(f"s2:{ref}/{graph_direction}")

        with mock.patch.object(citation_graph, "fetch_json", side_effect=network), \
             mock.patch.object(citation_graph, "semanticscholar_neighbours", side_effect=graph):
            target = parent or f"https://doi.org/{PARENT.upper()}"
            return citation_graph.probe_citations(target, direction, **kwargs), network

    def test_backward_citation_takes_what_the_parent_cites(self):
        routes = [
            ("https://api.opencitations.net/index/v2/references/", [index_row(PARENT, "10.1111/cgf.12950"), index_row(PARENT, "10.1145/3406183")]),
            ("https://api.crossref.org/works?", registry_lookup),
        ]
        result, _ = self.run_probe(routes, "references")
        self.assertEqual(result["inquiry_intent"], "backward_citation")
        self.assertEqual(result["parent_paper_ids"], [PARENT])
        self.assertEqual(sorted(p["doi"] for p in result["papers"]), ["10.1111/cgf.12950", "10.1145/3406183"])
        self.assertEqual(result["papers"][0]["citation_graph"]["parent_doi"], PARENT)
        self.assertEqual(result["source_stats"]["source_failures"], [])

    def test_forward_citation_takes_what_cites_the_parent(self):
        routes = [
            ("https://api.opencitations.net/index/v2/citations/", [index_row("10.1111/cgf.14997", PARENT)]),
            ("https://api.crossref.org/works?", registry_lookup),
        ]
        result, network = self.run_probe(routes, "citations")
        self.assertEqual(result["inquiry_intent"], "forward_citation")
        self.assertEqual([p["doi"] for p in result["papers"]], ["10.1111/cgf.14997"])
        self.assertTrue(network.urls[0].endswith(f"/citations/doi:{PARENT}"))

    def test_a_refused_index_is_recorded_as_throttled_and_the_deposited_references_answer(self):
        routes = [
            ("https://api.opencitations.net/", throttled("https://api.opencitations.net/")),
            (f"https://api.crossref.org/works/{urllib.parse.quote(PARENT, safe='')}",
             {"message": {"reference": [{"key": "a", "DOI": "10.1145/3406183"}, {"key": "b", "unstructured": "no doi"}]}}),
            ("https://api.crossref.org/works?", registry_lookup),
        ]
        result, _ = self.run_probe(routes, "references")
        failures = result["source_stats"]["source_failures"]
        self.assertEqual([(f["source"], f["throttled"]) for f in failures], [("opencitations", True)])
        self.assertEqual([p["doi"] for p in result["papers"]], ["10.1145/3406183"])

    def test_a_refused_forward_lookup_falls_back_to_semantic_scholar_and_says_so(self):
        # MEASURED ON cycle-b-20260918: the forward lookup had no fallback,
        # so a refused index left the inquiry empty.
        routes = [
            ("https://api.opencitations.net/", throttled("https://api.opencitations.net/")),
            (f"s2:DOI:{PARENT}/citations", [s2_neighbour("Citing work", doi="10.1000/citing")]),
        ]
        result, network = self.run_probe(routes, "citations")
        failures = result["source_stats"]["source_failures"]
        self.assertEqual([(f["source"], f["throttled"]) for f in failures], [("opencitations", True)])
        self.assertEqual(result["source_stats"]["sources_attempted"], ["opencitations", "semanticscholar"])
        self.assertEqual([p["doi"] for p in result["papers"]], ["10.1000/citing"])
        # The neighbour carries its abstract and a SOURCED citation count.
        paper = result["papers"][0]
        self.assertTrue(paper["abstract"])
        self.assertEqual(paper["citation_count_provenance"]["source"], "semanticscholar")
        self.assertEqual(len(network.urls), 2)

    def test_both_refusals_are_recorded_and_nothing_is_invented(self):
        routes = [
            ("https://api.opencitations.net/", throttled("https://api.opencitations.net/")),
            ("s2:", throttled("https://api.semanticscholar.org/")),
        ]
        result, _ = self.run_probe(routes, "citations")
        self.assertEqual(result["papers"], [])
        self.assertEqual(
            [(f["source"], f["throttled"]) for f in result["source_stats"]["source_failures"]],
            [("opencitations", True), ("semanticscholar", True)],
        )

    def test_an_arxiv_parent_goes_straight_to_the_graph(self):
        routes = [("s2:arXiv:2303.04137/references", [s2_neighbour("Cited preprint", arxiv="2006.11239")])]
        result, network = self.run_probe(routes, "references", parent="arXiv:2303.04137v5")
        self.assertEqual(result["parent_paper_ids"], ["arXiv:2303.04137"])
        self.assertEqual(result["query"], "references:arxiv:2303.04137")
        self.assertEqual([p["arxiv_id"] for p in result["papers"]], ["2006.11239"])
        self.assertEqual(network.urls, ["s2:arXiv:2303.04137/references"])

    def test_neighbours_without_a_registry_record_are_named(self):
        routes = [
            ("https://api.opencitations.net/index/v2/references/", [index_row(PARENT, "10.1111/cgf.12950"), index_row(PARENT, "10.5281/zenodo.1")]),
            ("https://api.crossref.org/works?", registry_items(["10.1111/cgf.12950"])),
        ]
        result, _ = self.run_probe(routes, "references")
        self.assertEqual(result["source_stats"]["unresolved_neighbour_dois"], ["10.5281/zenodo.1"])

    def test_metadata_is_fetched_in_batches_and_the_limit_holds(self):
        many = [index_row(PARENT, f"10.1000/n{i}") for i in range(30)]
        routes = [
            ("https://api.opencitations.net/index/v2/references/", many),
            ("https://api.crossref.org/works?", registry_lookup),
        ]
        result, network = self.run_probe(routes, "references", limit=25)
        registry_calls = [url for url in network.urls if url.startswith("https://api.crossref.org/works?")]
        self.assertEqual(len(registry_calls), 2)
        self.assertEqual(result["paper_count"], 25)

    def test_a_missing_or_malformed_doi_is_refused(self):
        with self.assertRaises(ValueError):
            citation_graph.probe_citations("not a doi", "references")
        with self.assertRaises(ValueError):
            citation_graph.probe_citations(PARENT, "sideways")


if __name__ == "__main__":
    unittest.main()
