import os
import unittest
import urllib.request
from unittest import mock

from drivers.literature.search_lib import http_client


POLICY = http_client.APPROVED_SCHOLARLY_METADATA_POLICY


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return b'{"ok": true}'


class LiteratureNetworkPolicyTests(unittest.TestCase):
    def validate(self, url, **kwargs):
        return http_client.validate_approved_scholarly_metadata_request(url, **kwargs)

    def test_permits_official_metadata_query_and_identifier_urls(self):
        urls = [
            "https://api.openalex.org/works?search=robot+control&per-page=10&mailto=test%40example.org",
            "https://api.openalex.org/works/W2741809807?select=id,title,abstract_inverted_index",
            "https://api.crossref.org/works?query=robot+control&rows=10&select=DOI,title,abstract",
            "https://api.crossref.org/works/10.1145%2F123.456",
            "https://api.semanticscholar.org/graph/v1/paper/search?query=robot+control&limit=10&fields=paperId,title,abstract",
            "https://api.semanticscholar.org/graph/v1/paper/DOI:10.1145%2F123.456/citations?limit=20&fields=paperId,title",
            "http://export.arxiv.org/api/query?search_query=all%3Arobot&start=0&max_results=10&sortBy=relevance&sortOrder=descending",
            "https://arxiv.org/abs/2404.19594",
            "https://arxiv.org/pdf/2404.19594",
            "https://api.opencitations.net/index/v2/references/doi:10.1145/3450626.3459812",
            "https://api.opencitations.net/index/v2/citations/doi:10.1111/cgf.14997",
        ]
        for url in urls:
            with self.subTest(url=url):
                approved = self.validate(url)
                self.assertTrue(approved.startswith("https://"))
                self.assertNotIn("mailto=", approved)

    def test_rejects_host_tricks_paths_ports_and_unapproved_options(self):
        urls = [
            "https://api.openalex.org.evil.example/works?search=x",
            "https://api.openalex.org@evil.example/works?search=x",
            "https://api.openalex.org:443/works?search=x",
            "https://api.openalex.org/works/../users?search=x",
            "https://api.crossref.org/members?query=x",
            "https://api.semanticscholar.org/graph/v1/author/search?query=x",
            "https://export.arxiv.org/api/query?search_query=x&callback=https%3A%2F%2Fevil.example",
            # The PDF by arXiv ID is admitted for deep reading (search_lib/fulltext.py);
            # a query string on it is not.
            "https://arxiv.org/pdf/2404.19594?download=1",
            "https://api.opencitations.net/index/v2/references/doi:10.1145/1?format=csv",
            "https://api.opencitations.net/meta/v1/metadata/doi:10.1145/3450626.3459812",
            "https://api.opencitations.net/index/v2/citations/omid:br/061401000438",
            "file:///etc/passwd",
        ]
        for url in urls:
            with self.subTest(url=url):
                with self.assertRaises(http_client.LiteratureNetworkPolicyError):
                    self.validate(url)

    def test_get_only_and_no_custom_headers(self):
        url = "https://api.openalex.org/works?search=robot"
        with self.assertRaises(http_client.LiteratureNetworkPolicyError):
            self.validate(url, method="POST")
        with self.assertRaises(http_client.LiteratureNetworkPolicyError):
            self.validate(url, headers={"Authorization": "Bearer secret"})

    def test_unapproved_url_is_blocked_before_an_open_attempt(self):
        with mock.patch.dict(os.environ, {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}), \
             mock.patch.object(http_client, "_open_request") as opened, \
             mock.patch.object(http_client, "_polite_throttle") as throttled:
            with self.assertRaises(http_client.LiteratureNetworkPolicyError):
                http_client._fetch_body("https://api.openalex.org.evil.example/works?search=x")
        opened.assert_not_called()
        throttled.assert_not_called()

    def test_redirect_target_is_validated_before_following(self):
        handler = http_client._ApprovedMetadataRedirectHandler()
        request = urllib.request.Request("https://api.openalex.org/works?search=robot")
        with self.assertRaises(http_client.LiteratureNetworkPolicyError):
            handler.redirect_request(
                request,
                None,
                302,
                "Found",
                {},
                "https://evil.example/collect?query=robot",
            )
        redirected = handler.redirect_request(
            request,
            None,
            302,
            "Found",
            {},
            "https://api.crossref.org/works?query=robot&rows=5",
        )
        self.assertEqual(redirected.get_method(), "GET")
        self.assertEqual(redirected.full_url, "https://api.crossref.org/works?query=robot&rows=5")
        self.assertNotIn("Authorization", redirected.headers)

    def test_opt_in_requests_use_only_fixed_headers(self):
        captured = []

        def fake_open(request):
            captured.append(request)
            return _Response()

        with mock.patch.dict(os.environ, {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}), \
             mock.patch.object(http_client, "_open_request", side_effect=fake_open), \
             mock.patch.object(http_client, "_polite_throttle"):
            body = http_client._fetch_body("https://api.openalex.org/works?search=robot")
        self.assertEqual(body, '{"ok": true}')
        self.assertEqual(captured[0].get_method(), "GET")
        headers = {key.lower(): value for key, value in captured[0].header_items()}
        self.assertEqual(set(headers), {"user-agent", "accept"})
        self.assertNotIn("@", headers["user-agent"])

    def test_policy_drops_contact_override_from_url_and_headers(self):
        captured = []

        def fake_open(request):
            captured.append(request)
            return _Response()

        with mock.patch.dict(
            os.environ,
            {
                "RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY,
                "RESEARCHLAB_CONTACT_MAILTO": "private-person@example.org",
            },
        ), mock.patch.object(http_client, "_open_request", side_effect=fake_open), \
             mock.patch.object(http_client, "_polite_throttle"):
            http_client._fetch_body(
                "https://api.openalex.org/works?search=robot&mailto=private-person%40example.org"
            )
        self.assertNotIn("mailto=", captured[0].full_url)
        self.assertNotIn("private-person", str(captured[0].header_items()))



class SemanticScholarKeyHeaderTest(unittest.TestCase):
    """The service key is the one header this policy allows, and only to S2.

    MEASURED ON cycle-a-20260919, 2026-09-21: anonymous Semantic
    Scholar access shares one throttled pool, and its 429s were the cycle's
    most common literature failure. The key carries no local content.
    """

    def test_the_key_is_allowed_only_for_semantic_scholar(self):
        url = "https://api.semanticscholar.org/graph/v1/paper/search?query=robot"
        http_client.validate_approved_scholarly_metadata_request(url, headers={"x-api-key": "k"})
        with self.assertRaises(http_client.LiteratureNetworkPolicyError):
            http_client.validate_approved_scholarly_metadata_request(
                "https://api.openalex.org/works?search=robot", headers={"x-api-key": "k"}
            )
        for headers in ({"x-api-key": ""}, {"authorization": "Bearer k"}, {"x-api-key": "k", "cookie": "a=b"}):
            with self.assertRaises(http_client.LiteratureNetworkPolicyError):
                http_client.validate_approved_scholarly_metadata_request(url, headers=headers)


class OpenAlexApiKeyTests(unittest.TestCase):
    """OpenAlex paused anonymous search; its key goes to OpenAlex only.

    MEASURED ON cycle-a-20260919, 2026-10-13 to 2026-10-15: 60 of 133
    anonymous OpenAlex requests were refused at about six an hour.
    """

    def sent_urls(self, url, env):
        sent = []

        def fake_open(request, timeout=None):  # noqa: ANN001
            sent.append(request.full_url)
            return _Response()

        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(http_client, "_open_request", side_effect=fake_open), \
                mock.patch.object(http_client, "_polite_throttle", lambda _url: None):
            http_client._fetch_raw(url)
        return sent

    def test_the_key_is_added_to_openalex_requests_only(self):
        env = {"RESEARCHLAB_OPENALEX_API_KEY": "oa-key", "RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}
        [sent] = self.sent_urls("https://api.openalex.org/works?search=robot+control&per-page=10", env)
        self.assertIn("api_key=oa-key", sent)
        self.assertIn("search=robot+control", sent)
        [crossref] = self.sent_urls("https://api.crossref.org/works?query=robot&rows=10", env)
        self.assertNotIn("oa-key", crossref)
        [s2] = self.sent_urls("https://api.semanticscholar.org/graph/v1/paper/search?query=robot", env)
        self.assertNotIn("oa-key", s2)

    def test_the_documented_variable_name_is_read_too(self):
        env = {"RESEARCHLAB_OPENALEX_API_KEY": "", "OPENALEX_API_KEY": "oa-plain", "RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}
        [sent] = self.sent_urls("https://api.openalex.org/works?search=robot", env)
        self.assertIn("api_key=oa-plain", sent)

    def test_without_a_key_requests_are_unchanged(self):
        env = {"RESEARCHLAB_OPENALEX_API_KEY": "", "OPENALEX_API_KEY": "", "RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}
        url = "https://api.openalex.org/works?search=robot&per-page=10"
        self.assertEqual(self.sent_urls(url, env), [url])

    def test_the_key_never_enters_a_cache_path(self):
        with mock.patch.dict(os.environ, {"RESEARCHLAB_OPENALEX_API_KEY": "oa-key"}):
            url = "https://api.openalex.org/works?search=robot"
            self.assertEqual(http_client.cache_path_for_url(url), http_client.cache_path_for_url(url))
            self.assertNotIn("oa-key", str(http_client.cache_path_for_url(url)))


if __name__ == "__main__":
    unittest.main()
