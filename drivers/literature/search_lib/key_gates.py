"""Sources that need the operator's own key are on only when it is set.

A service that needs a key is not called without one: no anonymous request,
no 429 to record, no scout lane marked throttled for a source nobody enabled.
The operator turns a source on by entering its key
(``researchlab keys set <name>``, kept in ~/.researchlab/.env, loaded by every
researchlab command).

MEASURED ON a first public-image cycle, 2026-10-19: with no Semantic Scholar
key every second lookup got HTTP 429 and the field-landscape scout was marked
``literature_retrieval_throttled`` although OpenAlex, arXiv and Crossref
answered. OpenAlex has required a key on every request since 2026-02-13.

The same table is in src/policy/key_gates.js (the CLI uses it to keep the
agents' sandbox off the hosts of disabled sources).
"""

from __future__ import annotations

import os
import urllib.parse

# source -> (hosts, key variables, how to enable it)
KEY_GATED_SOURCES = {
    "semanticscholar": (("api.semanticscholar.org",), ("RESEARCHLAB_S2_API_KEY",), "researchlab keys set semantic-scholar"),
    "openalex": (("api.openalex.org",), ("RESEARCHLAB_OPENALEX_API_KEY", "OPENALEX_API_KEY"), "researchlab keys set openalex"),
    "scopus": (("api.elsevier.com",), ("SCOPUS_API_KEY", "ELSEVIER_API_KEY", "X_ELS_APIKEY"), "researchlab keys set scopus"),
}


class SourceNotEnabled(RuntimeError):
    """A request to a key-gated source whose key is not set; nothing was sent."""


def gates_active() -> bool:
    # RESEARCHLAB_KEY_GATES=off restores the old keyless calls (tests that
    # mock these services rely on it).
    return (os.environ.get("RESEARCHLAB_KEY_GATES") or "").strip().lower() not in {"0", "off", "false"}


def source_enabled(source: str) -> bool:
    gate = KEY_GATED_SOURCES.get(str(source or "").strip().lower())
    if not gate or not gates_active():
        return True
    return any((os.environ.get(name) or "").strip() for name in gate[1])


def disabled_reason(source: str) -> str:
    gate = KEY_GATED_SOURCES.get(str(source or "").strip().lower())
    if not gate:
        return ""
    return f"{source} is off: it needs an API key, and none is set (turn it on with `{gate[2]}`)"


def enabled_sources(sources) -> list[str]:
    return [source for source in sources if source_enabled(source)]


def disabled_sources(sources) -> list[str]:
    return [source for source in sources if not source_enabled(source)]


def gate_url(url: str) -> None:
    """Refuse, before any network, a request to a source that is off."""
    if not gates_active():
        return
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    for source, (hosts, _names, _how) in KEY_GATED_SOURCES.items():
        if host in hosts and not source_enabled(source):
            raise SourceNotEnabled(disabled_reason(source))
