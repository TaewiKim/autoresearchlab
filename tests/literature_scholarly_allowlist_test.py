#!/usr/bin/env python3
"""Every place that names the scholarly hosts names the same ones.

The approved scholarly network is defined in several places that nothing tied
together: the Rust harness's SCHOLARLY_NETWORK_DOMAINS (which the Codex network
profile is built from and which rejects any other host), the Python driver's
request validator and provider URLs, the evidence-policy document, and the
cycle launchers that set RESEARCHLAB_CODEX_NETWORK_DOMAINS. A provider added on
one side and not the other fails only at run time, inside a sandbox, as a
refused connection that reads like an empty field.

MEASURED ON cycle-b-20260918, 2026-09-18/19: the literature driver used
three of the six approved hosts; Semantic Scholar was allowed everywhere and
queried nowhere.
"""
import re
import sys
import unittest
import urllib.parse
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib import collect, constants, http_client

RUST_POLICY = PROJECT / "native" / "researchlab-harness" / "src" / "runtime" / "codex_policy.rs"
DOCKER_SCOUT = PROJECT / "native" / "researchlab-harness" / "src" / "runtime" / "docker_scout.rs"
POLICY_DOC = PROJECT / "docs" / "research-evidence-policy.md"
LAUNCHERS = PROJECT / ".research-lab"

# The host each retrieval source reaches.
SOURCE_HOSTS = {
    "openalex": constants.OPENALEX_WORKS_URL,
    "crossref": constants.CROSSREF_WORKS_URL,
    "arxiv": constants.ARXIV_API_URL,
    "semanticscholar": constants.SEMANTIC_SCHOLAR_API_URL,
}


def host(url: str) -> str:
    return urllib.parse.urlsplit(url).hostname or ""


def rust_domains() -> set[str]:
    source = RUST_POLICY.read_text(encoding="utf-8")
    block = re.search(r"SCHOLARLY_NETWORK_DOMAINS:\s*&\[&str\]\s*=\s*&\[(.*?)\];", source, re.S)
    assert block, "SCHOLARLY_NETWORK_DOMAINS not found in codex_policy.rs"
    return set(re.findall(r'"([^"]+)"', block.group(1)))


def validator_hosts() -> set[str]:
    source = Path(http_client.__file__).read_text(encoding="utf-8")
    body = source.split("def _allowed_query_keys", 1)[1].split("\ndef ", 1)[0]
    return set(re.findall(r'host == "([^"]+)"', body))


class ScholarlyAllowlistTest(unittest.TestCase):
    def test_the_python_validator_and_the_rust_profile_name_the_same_hosts(self):
        self.assertEqual(validator_hosts(), rust_domains())

    def test_every_approved_source_reaches_an_approved_host(self):
        approved = rust_domains()
        for source in collect.APPROVED_SCHOLARLY_SOURCES:
            self.assertIn(source, SOURCE_HOSTS, f"{source} has no known host")
            self.assertIn(host(SOURCE_HOSTS[source]), approved, source)
        self.assertIn(host(constants.OPENCITATIONS_INDEX_URL), approved)
        self.assertIn("semanticscholar", collect.APPROVED_SCHOLARLY_SOURCES)

    def test_the_policy_document_lists_the_same_hosts(self):
        text = POLICY_DOC.read_text(encoding="utf-8")
        listed = re.search(r"`((?:[a-z0-9.-]+\.[a-z]+,)+[a-z0-9.-]+\.[a-z]+)`", text)
        self.assertIsNotNone(listed, "the approved-host list is missing from the policy document")
        self.assertEqual(set(listed.group(1).split(",")), rust_domains())

    def test_the_docker_scout_forwards_the_domain_list(self):
        source = DOCKER_SCOUT.read_text(encoding="utf-8")
        forwarded = re.search(r"FORWARDED_ENV:\s*&\[&str\]\s*=\s*&\[(.*?)\];", source, re.S).group(1)
        for name in ("RESEARCHLAB_CODEX_NETWORK_DOMAINS", "RESEARCHLAB_LITERATURE_NETWORK_POLICY"):
            self.assertIn(f'"{name}"', forwarded)

    def test_local_launchers_name_only_approved_hosts(self):
        # Launchers are local (gitignored) files; check whichever are present.
        # The harness rejects an unapproved host at launch, so a launcher that
        # names one is a cycle that cannot start.
        approved = rust_domains()
        checked = 0
        for launcher in sorted(LAUNCHERS.glob("*.cjs")):
            text = launcher.read_text(encoding="utf-8", errors="replace")
            match = re.search(r"RESEARCHLAB_CODEX_NETWORK_DOMAINS\s*=\s*\[(.*?)\]", text, re.S)
            if not match:
                continue
            checked += 1
            named = set(re.findall(r'"([^"]+)"', match.group(1)))
            self.assertTrue(named, launcher.name)
            self.assertLessEqual(named, approved, f"{launcher.name} names {sorted(named - approved)}")
        if not checked:
            self.skipTest("no local launcher sets RESEARCHLAB_CODEX_NETWORK_DOMAINS")


if __name__ == "__main__":
    unittest.main()
