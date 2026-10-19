"""A source that needs a key is on only when its key is set."""

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "literature"))

from search_lib import key_gates  # noqa: E402
from search_lib.collect import allowed_literature_sources, default_literature_sources  # noqa: E402
from search_lib.http_client import _fetch_raw  # noqa: E402

KEYS = ("RESEARCHLAB_S2_API_KEY", "RESEARCHLAB_OPENALEX_API_KEY", "OPENALEX_API_KEY",
        "SCOPUS_API_KEY", "ELSEVIER_API_KEY", "X_ELS_APIKEY")


def env(**values):
    base = {name: value for name, value in os.environ.items() if name not in KEYS}
    base["RESEARCHLAB_KEY_GATES"] = "on"
    base.update(values)
    return mock.patch.dict(os.environ, base, clear=True)


class KeyGatesTest(unittest.TestCase):
    def test_without_keys_the_gated_sources_are_not_asked(self):
        with env(RESEARCHLAB_LITERATURE_NETWORK_POLICY="approved-scholarly-metadata-v1"):
            self.assertEqual(default_literature_sources(), ["crossref", "arxiv"])
            self.assertEqual(allowed_literature_sources(["openalex", "semanticscholar", "arxiv"]), ["arxiv"])
            self.assertFalse(key_gates.source_enabled("semanticscholar"))
            self.assertIn("researchlab keys set semantic-scholar", key_gates.disabled_reason("semanticscholar"))

    def test_entering_a_key_turns_its_source_on(self):
        with env(RESEARCHLAB_LITERATURE_NETWORK_POLICY="approved-scholarly-metadata-v1", RESEARCHLAB_S2_API_KEY="k", OPENALEX_API_KEY="o"):
            self.assertEqual(default_literature_sources(), ["openalex", "crossref", "arxiv", "semanticscholar"])

    def test_a_request_to_a_source_that_is_off_never_reaches_the_network(self):
        with env(), mock.patch("urllib.request.urlopen", side_effect=AssertionError("network was called")):
            with self.assertRaises(key_gates.SourceNotEnabled) as raised:
                _fetch_raw("https://api.semanticscholar.org/graph/v1/paper/search?query=x")
            self.assertIn("needs an API key", str(raised.exception))
            with self.assertRaises(key_gates.SourceNotEnabled):
                _fetch_raw("https://api.openalex.org/works?search=x")

    def test_keyless_sources_stay_on(self):
        with env():
            for source in ("crossref", "arxiv", "pubmed", "opencitations"):
                self.assertTrue(key_gates.source_enabled(source), source)


if __name__ == "__main__":
    unittest.main()
