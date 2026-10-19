from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import random
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from .key_gates import gate_url
from .constants import CACHE_ROOT, DEFAULT_HOST_MIN_INTERVAL_SECONDS, HOST_MIN_INTERVAL_SECONDS, MAX_SOURCE_ATTEMPTS, POLITE_USER_AGENT, QUERY_CACHE_ROOT, RATE_LIMIT_MAX_ATTEMPTS, RATE_LIMIT_RETRY_AFTER_CAP_SECONDS, RATE_LIMIT_TOTAL_BUDGET_BY_HOST, RATE_LIMIT_TOTAL_BUDGET_SECONDS, REQUEST_TIMEOUT_SECONDS, THROTTLE_ROOT


APPROVED_SCHOLARLY_METADATA_POLICY = "approved-scholarly-metadata-v1"
_POLICY_ENV = "RESEARCHLAB_LITERATURE_NETWORK_POLICY"
_FIXED_REQUEST_HEADERS = {
    # Deliberately independent of CONTACT_MAILTO: an operator override must not
    # become outbound request data in this narrow approved mode.
    "User-Agent": "researchlab-scholarly-metadata/1.0",
    "Accept": "application/json, application/atom+xml;q=0.9, text/plain;q=0.8",
}


class LiteratureNetworkPolicyError(ValueError):
    pass


# Process-wide counts of what actually went out on the wire: every request
# attempt, and every rate-limit (429/503) answer the retry loop absorbed. The
# retry is silent by design, so without this a caller cannot say whether a slow
# run was throttled (frontier.py reports both).
REQUEST_STATS = {"requests": 0, "rate_limited": 0}


def approved_scholarly_metadata_policy_enabled() -> bool:
    return os.environ.get(_POLICY_ENV, "").strip() == APPROVED_SCHOLARLY_METADATA_POLICY


def _normalized_path(parsed: urllib.parse.SplitResult) -> str:
    path = urllib.parse.unquote(parsed.path or "/")
    if "\\" in path or "\x00" in path or any(part in {".", ".."} for part in path.split("/")):
        raise LiteratureNetworkPolicyError("scholarly metadata URL contains an unsafe path")
    return path


def _allowed_query_keys(host: str, path: str) -> set[str] | None:
    if host == "api.openalex.org" and (path == "/works" or re.fullmatch(r"/works/W\d+", path)):
        return {"search", "filter", "per-page", "page", "cursor", "sort", "select"}
    if host == "api.crossref.org" and (path == "/works" or path.startswith("/works/")):
        return {
            "query", "query.bibliographic", "query.title", "rows", "offset", "cursor",
            "select", "filter", "sort", "order",
        }
    if host == "api.semanticscholar.org":
        if path == "/graph/v1/paper/search":
            return {
                "query", "limit", "offset", "fields", "year", "venue", "fieldsOfStudy",
                "publicationTypes", "openAccessPdf", "minCitationCount", "sort",
            }
        # Known-item lookup by title: one best match, same fields as search.
        if path == "/graph/v1/paper/search/match":
            return {"query", "fields", "year", "venue", "fieldsOfStudy", "publicationTypes"}
        # Paper identifiers include DOI values whose encoded slash becomes a
        # path slash after normalization. The fixed prefix plus conservative ID
        # alphabet keeps this an identifier route rather than an arbitrary API.
        if re.fullmatch(r"/graph/v1/paper/[A-Za-z0-9:._%/+()=-]+(?:/(?:citations|references))?", path):
            return {"fields", "limit", "offset"}
    if host == "api.opencitations.net" and re.fullmatch(
        r"/index/v2/(?:references|citations)/doi:10\.\d{3,9}/[^\s?#]+", path
    ):
        return set()
    if host == "export.arxiv.org" and path == "/api/query":
        return {"search_query", "id_list", "start", "max_results", "sortBy", "sortOrder"}
    if host == "arxiv.org" and re.fullmatch(r"/abs/[A-Za-z0-9._/-]+", path):
        return set()
    # Full text of a paper by arXiv ID, for deep reading (fulltext.py): arXiv's
    # own HTML rendering, its ar5iv rendering of older papers, then the PDF.
    if host == "arxiv.org" and re.fullmatch(r"/(?:html|pdf)/[A-Za-z0-9._/-]+", path):
        return set()
    if host == "ar5iv.labs.arxiv.org" and re.fullmatch(r"/html/[A-Za-z0-9._/-]+", path):
        return set()
    # Open-source asset METADATA of a paper (assets.py): repository record,
    # README, top-level listing and default-branch head -- never a clone or a
    # file download. Repository search takes a public title or arXiv ID only.
    if host == "api.github.com":
        tail = r"(?:/readme|/contents/?|/commits/[A-Za-z0-9_./-]+)?"
        if re.fullmatch(r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" + tail, path) or re.fullmatch(
            r"/repositories/\d+" + tail, path
        ):
            return set()
        if path == "/search/repositories":
            return {"q", "sort", "order", "per_page", "page"}
    # Hugging Face Hub metadata: one model/dataset record, or a listing filtered
    # by the paper's arXiv tag. No file is downloaded.
    if host == "huggingface.co":
        if re.fullmatch(r"/api/(?:models|datasets)/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?", path):
            return {"blobs"}
        if path in {"/api/models", "/api/datasets"}:
            return {"search", "filter", "author", "sort", "direction", "limit"}
    return None


def _is_semanticscholar_key_header(url: str, headers: dict) -> bool:
    """The one header this policy allows: the Semantic Scholar service key.

    It is a credential FOR an approved host, not content from this machine: it
    carries no local file, document or user data, and it goes nowhere else. The
    rule it narrows -- no custom headers -- exists to stop this process sending
    anything of the owner's; one API key to api.semanticscholar.org does not.
    Anonymous access shares one throttled pool, and its 429s were the cycle's
    most common literature failure.
    """
    if set(headers) != {"x-api-key"}:
        return False
    value = headers.get("x-api-key")
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "api.semanticscholar.org"


_OPENALEX_KEY_ENV = "RESEARCHLAB_OPENALEX_API_KEY"


def _with_openalex_api_key(url: str) -> str:
    """The OpenAlex API key, on requests to OpenAlex and nowhere else.

    MEASURED ON cycle-a-20260919, 2026-10-13 to 2026-10-15: 60 of 133
    OpenAlex requests were refused (429, and 503 "Anonymous search is paused
    while the search cluster recovers from heavy load ... use a free API key
    for uninterrupted access"), at about six requests an hour. Semantic
    Scholar, called with its key, refused 16 of 387. Scouts that lost OpenAlex
    lost the citation counts the established-impact track admits papers on,
    and 22 of 70 scouts ended as `literature_retrieval_throttled`.

    Like the Semantic Scholar key it is a credential for an approved host and
    carries nothing of this machine's. It is added after the URL has been
    validated and is not part of any cache key, so it never lands on disk.
    """
    # OPENALEX_API_KEY is the name OpenAlex's own documentation uses, and the
    # one an owner is likely to have set already.
    key = (os.environ.get(_OPENALEX_KEY_ENV) or os.environ.get("OPENALEX_API_KEY") or "").strip()
    if not key:
        return url
    parts = urllib.parse.urlsplit(url)
    if (parts.hostname or "").lower() != "api.openalex.org":
        return url
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    if any(name == "api_key" for name, _ in query):
        return url
    query.append(("api_key", key))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def validate_approved_scholarly_metadata_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict | None = None,
) -> str:
    """Validate one outbound request without resolving or opening the URL."""
    if method.upper() != "GET":
        raise LiteratureNetworkPolicyError("approved scholarly metadata policy permits GET only")
    if headers and not _is_semanticscholar_key_header(url, headers):
        raise LiteratureNetworkPolicyError("custom request headers are forbidden by scholarly metadata policy")
    if not isinstance(url, str) or not url or len(url) > 8192:
        raise LiteratureNetworkPolicyError("invalid scholarly metadata URL")
    parsed = urllib.parse.urlsplit(url)
    try:
        host = (parsed.hostname or "").lower()
        explicit_port = parsed.port
    except ValueError as error:
        raise LiteratureNetworkPolicyError("invalid scholarly metadata host or port") from error
    if parsed.username or parsed.password or parsed.fragment or explicit_port is not None:
        raise LiteratureNetworkPolicyError("credentials, fragments, and explicit ports are forbidden")
    if parsed.scheme not in {"https", "http"}:
        raise LiteratureNetworkPolicyError("scholarly metadata URL must use HTTP(S)")
    if parsed.scheme == "http" and host != "export.arxiv.org":
        raise LiteratureNetworkPolicyError("plaintext HTTP is permitted only for the official arXiv export API")
    path = _normalized_path(parsed)
    allowed_keys = _allowed_query_keys(host, path)
    if allowed_keys is None:
        raise LiteratureNetworkPolicyError(f"unapproved scholarly metadata endpoint: {host}{path}")
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)
    # OpenAlex/Crossref callers historically add CONTACT_MAILTO. Drop it under
    # this policy so an environment override cannot disclose an address. The
    # APIs accept the same metadata query without it.
    pairs = [(key, value) for key, value in pairs if key != "mailto"]
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise LiteratureNetworkPolicyError("duplicate scholarly metadata query parameter")
    unknown = sorted(set(keys) - allowed_keys)
    if unknown:
        raise LiteratureNetworkPolicyError(f"unapproved scholarly metadata query option: {unknown[0]}")
    scheme = "https" if host == "export.arxiv.org" else parsed.scheme
    return urllib.parse.urlunsplit(
        (scheme, host, parsed.path or "/", urllib.parse.urlencode(pairs), "")
    )


class _ApprovedMetadataRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        approved_url = validate_approved_scholarly_metadata_request(newurl, method="GET")
        return urllib.request.Request(approved_url, headers=dict(_FIXED_REQUEST_HEADERS), method="GET")


_TLS_CONTEXT: ssl.SSLContext | None = None


def _tls_context() -> ssl.SSLContext:
    """The one TLS context every literature request uses.

    CPython's http.client turns on TLS 1.3 post-handshake authentication in the
    context it builds for urllib, which adds the ``post_handshake_auth``
    extension to the ClientHello. arXiv's edge answers export.arxiv.org search
    requests carrying that fingerprint with HTTP 406 and an empty body.

    MEASURED 2026-09-19 from this host on fresh (uncached) queries 3.5 s apart:
    urllib's implicit context -> 406 every time; the same request with
    ``post_handshake_auth = False`` -> 200 every time; curl -> 200 with any
    User-Agent. User-Agent, Accept and Accept-Encoding made no difference. No
    client certificate is ever presented, so the extension had no use here.
    """
    global _TLS_CONTEXT
    if _TLS_CONTEXT is None:
        context = ssl.create_default_context()
        context.set_alpn_protocols(["http/1.1"])
        if getattr(context, "post_handshake_auth", None) is not None:
            context.post_handshake_auth = False
        _TLS_CONTEXT = context
    return _TLS_CONTEXT


def _open_request(request: urllib.request.Request, timeout: float | None = None):
    handlers: list = [urllib.request.HTTPSHandler(context=_tls_context())]
    if approved_scholarly_metadata_policy_enabled():
        handlers.append(_ApprovedMetadataRedirectHandler())
    opener = urllib.request.build_opener(*handlers)
    return opener.open(request, timeout=timeout or REQUEST_TIMEOUT_SECONDS)


def _host_of(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).netloc.lower()
    except Exception:
        return ""


def _polite_throttle(url: str) -> None:
    """Cross-process per-host pacing via a lock dir + timestamp file.

    Many lanes (gatekeeper prior-art searches, scouts) run this driver
    concurrently; in-process sleeps cannot coordinate them. mkdir is atomic on
    every platform, so a lock DIRECTORY serialises the read-wait-stamp cycle; a
    lock older than 30 s is treated as leaked (a killed lane) and broken.
    """
    host = _host_of(url)
    if not host:
        return
    min_interval = HOST_MIN_INTERVAL_SECONDS.get(host, DEFAULT_HOST_MIN_INTERVAL_SECONDS)
    THROTTLE_ROOT.mkdir(parents=True, exist_ok=True)
    lock_dir = THROTTLE_ROOT / f"{host}.lock"
    stamp = THROTTLE_ROOT / f"{host}.stamp"
    deadline = time.time() + 120.0
    while True:
        try:
            lock_dir.mkdir()
            break
        except FileExistsError:
            try:
                if time.time() - lock_dir.stat().st_mtime > 30.0:
                    lock_dir.rmdir()
                    continue
            except OSError:
                pass
            if time.time() > deadline:
                return  # never deadlock the search on a stuck lock
            time.sleep(0.1)
        except OSError:
            return
    try:
        last = 0.0
        try:
            last = float(stamp.read_text(encoding="utf-8").strip() or 0.0)
        except (OSError, ValueError):
            last = 0.0
        wait = min_interval - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        try:
            stamp.write_text(str(time.time()), encoding="utf-8")
        except OSError:
            pass
    finally:
        try:
            lock_dir.rmdir()
        except OSError:
            pass


def _is_rate_limited(error: HTTPError) -> bool:
    return error.code in (429, 503)


def _rate_limit_wait_seconds(error: HTTPError, attempt: int) -> float:
    retry_after = None
    try:
        raw = error.headers.get("Retry-After") if error.headers else None
        if raw:
            retry_after = float(str(raw).strip())
    except (TypeError, ValueError):
        retry_after = None
    if retry_after is not None and retry_after >= 0:
        return min(retry_after, RATE_LIMIT_RETRY_AFTER_CAP_SECONDS)
    base = min(3.0 * (2 ** attempt), 30.0)
    return base + (os.getpid() % 10) * 0.1  # small deterministic jitter


def _fetch_body(url: str, headers: dict | None = None) -> str:
    """Shared polite fetch: throttle + UA + rate-limit-aware retry."""
    return _fetch_raw(url, headers).decode("utf-8")


def fetch_bytes(url: str, headers: dict | None = None, timeout: float | None = None) -> bytes:
    """Uncached raw fetch through the same policy, pacing and retry path.

    For full-text documents (HTML/PDF), which the caller caches with their own
    provenance; the URL-keyed JSON cache below is for small metadata records.
    """
    return _fetch_raw(url, headers, timeout=timeout)


def _without_empty_mailto(url: str) -> str:
    """The URL without a ``mailto=`` that names no one (no contact configured)."""
    parsed = urllib.parse.urlsplit(url)
    if "mailto=" not in parsed.query:
        return url
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    kept = [(key, value) for key, value in pairs if not (key == "mailto" and not value.strip())]
    if len(kept) == len(pairs):
        return url
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(kept)))


def _fetch_raw(url: str, headers: dict | None = None, timeout: float | None = None) -> bytes:
    gate_url(url)
    policy_enabled = approved_scholarly_metadata_policy_enabled()
    if policy_enabled:
        url = validate_approved_scholarly_metadata_request(url, method="GET", headers=headers)
        request_headers = dict(_FIXED_REQUEST_HEADERS)
        # The validator above accepts exactly one caller header, the Semantic
        # Scholar service key for its own host; carry it through.
        if headers and _is_semanticscholar_key_header(url, headers):
            request_headers.update(headers)
    else:
        request_headers = {"User-Agent": POLITE_USER_AGENT}
        if headers:
            request_headers.update(headers)
    url = _with_openalex_api_key(_without_empty_mailto(url))
    last_error: Exception | None = None
    rate_limit_budget = RATE_LIMIT_TOTAL_BUDGET_BY_HOST.get(
        (urllib.parse.urlsplit(url).hostname or "").lower(), RATE_LIMIT_TOTAL_BUDGET_SECONDS
    )
    plain_attempts = 0
    rate_limit_attempts = 0
    rate_limit_slept = 0.0
    while True:
        _polite_throttle(url)
        REQUEST_STATS["requests"] += 1
        try:
            request = urllib.request.Request(url, headers=request_headers, method="GET")
            opened = _open_request(request, timeout) if timeout else _open_request(request)
            with opened as response:
                return response.read()
        except urllib.error.HTTPError as error:
            last_error = error
            if _is_rate_limited(error):
                REQUEST_STATS["rate_limited"] += 1
                rate_limit_attempts += 1
                wait = _rate_limit_wait_seconds(error, rate_limit_attempts)
                if (
                    rate_limit_attempts < RATE_LIMIT_MAX_ATTEMPTS
                    and rate_limit_slept + wait <= rate_limit_budget
                ):
                    rate_limit_slept += wait
                    time.sleep(wait)
                    continue
            else:
                plain_attempts += 1
                if plain_attempts < MAX_SOURCE_ATTEMPTS:
                    time.sleep(0.5 + plain_attempts)
                    continue
            raise
        except Exception as error:  # timeouts, connection resets, DNS blips
            last_error = error
            plain_attempts += 1
            if plain_attempts < MAX_SOURCE_ATTEMPTS:
                time.sleep(0.5 + plain_attempts)
                continue
            raise
    raise last_error if last_error else RuntimeError("failed to fetch")



def cache_path_for_url(url: str) -> Path:
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    return CACHE_ROOT / f"{digest}.json"


def query_cache_path(query: str) -> Path:
    digest = hashlib.sha256(clean_text(query).lower().encode("utf-8")).hexdigest()
    QUERY_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    return QUERY_CACHE_ROOT / f"{digest}.json"


def fetch_json(url: str) -> dict:
    cache_path = cache_path_for_url(url)
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    payload = json.loads(_fetch_body(url))
    cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


def fetch_text(url: str) -> str:
    cache_path = cache_path_for_url(url)
    if cache_path.exists():
        return cache_path.read_text(encoding="utf-8")
    payload = _fetch_body(url)
    cache_path.write_text(payload, encoding="utf-8")
    return payload


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()

def scopus_api_key() -> str:
    """Elsevier Scopus API key from the environment (empty when unavailable)."""
    return (
        os.environ.get("SCOPUS_API_KEY")
        or os.environ.get("ELSEVIER_API_KEY")
        or os.environ.get("X_ELS_APIKEY")
        or ""
    ).strip()


def scopus_enabled() -> bool:
    return bool(scopus_api_key())


def fetch_json_with_headers(url: str, headers: dict) -> dict:
    """Like fetch_json but sends request headers (Scopus needs X-ELS-APIKey).

    Shares the URL-keyed cache with fetch_json: the API key travels in the
    header, not the URL, so the cache key stays stable and no secret is written
    into the cache path.
    """
    cache_path = cache_path_for_url(url)
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    payload = json.loads(_fetch_body(url, headers=headers))
    cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload
