"""The open-source assets a paper ships, as metadata: code, checkpoints, data, envs.

Almost all SOTA robot-learning work is open source. Knowing -- before a
hypothesis is chosen -- which repository reproduces a paper, under which
license, how recently it moved, which checkpoint and dataset it loads, which
benchmark environment it evaluates in and how much GPU memory that takes,
turns a year of re-implementation into a day of reuse.

Metadata only: nothing is cloned, downloaded or run. Sources:
  * links in the cached full text (``fulltext.py``) and the repository README,
    including ``<owner>.github.io/<repo>`` project pages;
  * GitHub REST (``api.github.com``): repository record (license, stars,
    pushed_at, default branch, fork source), the default-branch head commit,
    the README and the top-level file listing; a repository search by the
    paper's own name (its title head or acronym) when the paper links no code;
  * Hugging Face Hub (``huggingface.co/api``): models and datasets the paper or
    README link, and those the Hub tags with the paper's arXiv ID when they
    come from the code's owner or carry the paper's name.

Official code is the repository NAMED like the paper (OpenVLA -> openvla/openvla)
or linked from its first pages as its code; a repository the paper merely cites
(a baseline, a simulator) is not its code, and a curated paper list never is.

Every lookup is recorded in ``searches_tried``. A refused or rate-limited lookup
is recorded as such, never as evidence that no asset exists. The optional
``RESEARCHLAB_GITHUB_TOKEN`` is sent only outside the approved scholarly
policy, which forbids custom headers (same rule as ``RESEARCHLAB_S2_API_KEY``);
under it GitHub's anonymous budget of 60 requests/hour applies.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .constants import CACHE_ROOT
from .fulltext import cache_dir_for, load_fulltext, normalize_arxiv_id
from .http_client import _fetch_body, approved_scholarly_metadata_policy_enabled
from .local_assets import ENV_PATTERNS, load_local_asset_inventory, match_local_assets

GITHUB_API = "https://api.github.com"
HF_API = "https://huggingface.co/api"
ASSET_CACHE_ROOT = CACHE_ROOT / "assets"
ASSET_CACHE_TTL_HOURS = float(os.environ.get("RESEARCHLAB_ASSET_CACHE_TTL_HOURS") or 72)
# Repositories whose full metadata is read per paper (the official one first).
MAX_REPOS = int(os.environ.get("RESEARCHLAB_ASSET_MAX_REPOS") or 1)
# Candidate repository records checked to find it.
MAX_REPO_CHECKS = int(os.environ.get("RESEARCHLAB_ASSET_MAX_REPO_CHECKS") or 3)
MAX_HUB_ITEMS = int(os.environ.get("RESEARCHLAB_ASSET_MAX_HUB_ITEMS") or 3)
README_HEAD_CHARS = 1500
OFFICIAL_SCORE = 6
MIN_SEARCH_STARS = int(os.environ.get("RESEARCHLAB_ASSET_MIN_SEARCH_STARS") or 20)

_GITHUB_REPO = re.compile(r"github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/([A-Za-z0-9_.-]{1,100})", re.IGNORECASE)
_GITHUB_PAGES = re.compile(r"\b([A-Za-z0-9-]{1,39})\.github\.io(?:/([A-Za-z0-9_.-]{1,100}))?", re.IGNORECASE)
_GITHUB_NOT_OWNERS = {"features", "orgs", "topics", "about", "sponsors", "marketplace", "settings", "login",
                      "site", "collections", "trending", "apps", "enterprise", "pricing", "security", "customer-stories"}
_LIST_REPO = re.compile(r"awesome|paper[-_]?list|papers|reading|survey|daily|arxiv|curated|collection|study|guide|list$", re.IGNORECASE)
_HF_LINK = re.compile(
    r"(?:huggingface\.co/|hf://)(?P<kind>datasets/|spaces/)?(?P<owner>[A-Za-z0-9_.-]+)/(?P<name>[A-Za-z0-9_.-]+)", re.IGNORECASE
)
_HF_NOT_OWNERS = {"docs", "blog", "papers", "api", "learn", "join", "login", "settings", "models", "spaces", "datasets",
                  "tasks", "collections", "organizations"}
_CODE_CUES = re.compile(r"\b(code|source|open[- ]?source|release[sd]?|available|implementation|repository)\b", re.IGNORECASE)
_ENV_FILES = ("requirements.txt", "pyproject.toml", "setup.py", "setup.cfg", "environment.yml", "environment.yaml",
              "conda_env.yaml", "conda_environment.yaml", "Dockerfile", "docker", "uv.lock", "poetry.lock", "Pipfile")
_README_SECTION_PRIORITY = ("reproduc", "evaluat", "train", "quick start", "quickstart", "getting started", "usage",
                            "inference", "demo", "run", "install")
_COMMAND = re.compile(
    r"^(?:\$\s*)?(?:python3?|bash|sh|pip3?|conda|mamba|uv|poetry|torchrun|accelerate|deepspeed|lerobot-\S+|make|docker|"
    r"git|cd|export|wget|curl|huggingface-cli|hf|CUDA_VISIBLE_DEVICES=\S*|[A-Z_]+=\S+\s+python|\./\S+)\b"
)
# A command that runs the method (not just installs or changes directory).
_RUN_COMMAND = re.compile(
    r"^(?:\$\s*)?(?:(?:[A-Z_]+=\S+\s+)*(?:python3?|torchrun|accelerate|deepspeed|lerobot-(?:train|eval|record)|uv run)\s|"
    r"(?:bash|sh|\./)\S*\.sh\b)"
)
_ASSET_URL = re.compile(r"https?://[^\s)\]}>\"'`]+")
_NOT_ASSET_URL = re.compile(
    r"github\.com|githubtocolab|huggingface\.co|arxiv\.org|shields\.io|colab\.research|\.ipynb|youtu|twitter\.com|"
    r"//x\.com|discord|wandb\.ai|readthedocs|openreview|doi\.org|/blob/|/tree/|\.(?:png|gif|jpe?g|svg|mp4|webp|html?)$|"
    r"github\.io/?$",
    re.IGNORECASE,
)

# GPU memory by model name, GB; the smallest common variant where there are two.
_GPU_MEMORY = [
    (r"\bH200\b", 141), (r"\bH100\b", 80), (r"\bA100\b", 40), (r"\bA800\b", 80), (r"\bL40S?\b", 48),
    (r"\bA6000\b", 48), (r"\bA40\b", 48), (r"\bA5000\b", 24), (r"\bA10G?\b", 24), (r"\bL4\b", 24),
    (r"\b(?:RTX\s*)?4090\b", 24), (r"\b(?:RTX\s*)?3090\b", 24), (r"\bTITAN\s*RTX\b", 24), (r"\bV100\b", 16),
    (r"\b(?:RTX\s*)?4080\b", 16), (r"\bT4\b", 16), (r"\b(?:RTX\s*)?2080\s*Ti\b", 11), (r"\b(?:RTX\s*)?3080\b", 10),
    (r"\b(?:RTX\s*)?4070\b", 12), (r"\b(?:RTX\s*)?3070\b", 8), (r"\bTPU\s*v\d\b", None),
]
_EXPLICIT_GB = re.compile(r"(\d{1,3}(?:\.\d)?)\s*GB(?!/s)", re.IGNORECASE)
_MODEL_NAME = re.compile(r"\b[A-Z][A-Za-z0-9]*(?:[-.][A-Za-z0-9]+)+\b|\b[A-Z][a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z]{2,}[A-Za-z0-9]*\b|\b[A-Z][a-z]{2,}\b")
_PARAMS = re.compile(r"(\d+(?:\.\d+)?)\s*(B|M|billion|million)\s*(?:-|\s)?(?:param(?:eter)?s?)\b", re.IGNORECASE)


# --- HTTP ---------------------------------------------------------------------------


def github_token() -> str:
    return (os.environ.get("RESEARCHLAB_GITHUB_TOKEN") or "").strip()


class AssetLookups:
    """Cached GETs that record every attempt, success or refusal."""

    def __init__(self, fetch: Callable[[str, dict | None], str] | None = None, use_cache: bool = True) -> None:
        self._fetch = fetch or (lambda url, headers: _fetch_body(url, headers=headers))
        self.use_cache = use_cache
        self.searches: list[dict] = []
        self.github_budget_exhausted = False

    @staticmethod
    def _cache_path(url: str) -> Path:
        return ASSET_CACHE_ROOT / (hashlib.sha256(url.encode("utf-8")).hexdigest() + ".json")

    def get(self, url: str, *, kind: str, purpose: str) -> object | None:
        host = urllib.parse.urlsplit(url).hostname or ""
        record: dict = {"kind": kind, "source": host, "request": url, "purpose": purpose}
        if host == "api.github.com" and self.github_budget_exhausted:
            record.update({"status": "skipped", "reason": "GitHub rate limit exhausted earlier in this run"})
            self.searches.append(record)
            return None
        cache_path = self._cache_path(url)
        if self.use_cache and cache_path.is_file():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                if time.time() - float(cached.get("fetched_at_epoch", 0)) < ASSET_CACHE_TTL_HOURS * 3600:
                    record.update({"status": cached.get("status", 200), "cached": True})
                    self.searches.append(record)
                    return cached.get("payload")
            except (OSError, ValueError, TypeError):
                pass
        headers = None
        if host == "api.github.com" and github_token() and not approved_scholarly_metadata_policy_enabled():
            headers = {"Authorization": f"Bearer {github_token()}"}
        try:
            payload = json.loads(self._fetch(url, headers))
            status = 200
        except urllib.error.HTTPError as error:
            status = error.code
            payload = None
            if host == "api.github.com" and error.code in (403, 429):
                remaining = error.headers.get("X-RateLimit-Remaining") if error.headers else None
                if remaining in (None, "0"):
                    self.github_budget_exhausted = True
                    record["reason"] = "GitHub rate limit (the anonymous budget is 60 requests/hour)"
        except Exception as error:  # policy refusal, timeout, bad JSON
            record.update({"status": "error", "error": f"{type(error).__name__}: {error}"[:300]})
            self.searches.append(record)
            return None
        record["status"] = status
        self.searches.append(record)
        if status in (200, 404) and self.use_cache:
            try:
                ASSET_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
                cache_path.write_text(json.dumps({"fetched_at_epoch": time.time(), "status": status, "payload": payload}),
                                      encoding="utf-8")
            except OSError:
                pass
        return payload


# --- the paper's name ---------------------------------------------------------------------


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def name_keys(title: str) -> list[str]:
    """What the paper's code would be named: its title head and its coined names.

    "OpenVLA: An Open-Source ..." -> openvla; "Diffusion Policy: Visuomotor ..." ->
    diffusionpolicy; "... Embodied AI with ManiSkill3" -> maniskill3, maniskill.
    """
    keys: list[str] = []
    head = (title or "").split(":", 1)[0].strip()
    if ":" in (title or "") and 2 <= len(head) <= 40:
        keys.append(_key(head))
    for token in re.findall(r"\b[A-Za-z0-9][A-Za-z0-9-]*\b", title or ""):
        coined = (re.search(r"[a-z][A-Z]|[A-Z]{2,}|[A-Za-z]\d|\d[A-Za-z]", token) and len(token) >= 3
                  and token.upper() not in {"RL", "AI", "GPU", "LLM", "VLM", "VLA", "3D", "2D", "RGB", "RGBD"})
        if coined:
            keys.append(_key(token))
    stripped = [re.sub(r"\d+$", "", key) for key in keys]
    ordered = []
    for key in keys + stripped:
        if len(key) >= 3 and key not in ordered:
            ordered.append(key)
    return ordered[:4]


def name_queries(title: str) -> dict[str, str]:
    """Search text per name key: GitHub tokenizes on word boundaries, so
    'diffusionpolicy' finds nothing while 'diffusion policy' finds diffusion_policy."""
    queries: dict[str, str] = {}
    head = (title or "").split(":", 1)[0].strip()
    words = re.findall(r"[A-Za-z0-9]+", head)
    for key in name_keys(title):
        if ":" in (title or "") and key == _key(head) and len(words) > 1:
            queries[key] = " ".join(words)
        else:
            queries[key] = key
    return queries


def _clean_repo(owner: str, name: str) -> str | None:
    name = re.sub(r"\.git$", "", name.rstrip(".,;:)"))
    if not name or owner.lower() in _GITHUB_NOT_OWNERS or name.lower() in {"issues", "pulls", "blob", "tree"}:
        return None
    return f"{owner}/{name}"


def _name_match(repo: str, keys: list[str]) -> bool:
    owner, name = repo.lower().split("/", 1)
    return _key(name) in keys or any(len(key) >= 4 and _key(name) == key for key in keys)


def repo_candidates(text: str, links: list[str], keys: list[str], references_offset: int | None) -> list[dict]:
    """GitHub repositories the paper names, scored as its own code or a citation."""
    found: dict[str, dict] = {}

    def add(repo: str, score: int, evidence: str) -> None:
        entry = found.setdefault(repo.lower(), {"repo": repo, "score": -99, "mentions": 0, "evidence": []})
        entry["mentions"] += 1
        entry["score"] = max(entry["score"], score)
        if evidence and len(entry["evidence"]) < 2:
            entry["evidence"].append(re.sub(r"\s+", " ", evidence).strip()[:240])

    def position_score(start: int) -> int:
        in_references = references_offset is not None and start > references_offset
        early = start < max(4000, len(text) * 0.12)
        cue = bool(_CODE_CUES.search(text[max(0, start - 160): start + 60]))
        return (3 if early else 0) + (3 if cue else 0) - (5 if in_references else 0)

    for match in _GITHUB_REPO.finditer(text):
        repo = _clean_repo(match.group(1), match.group(2))
        if repo:
            add(repo, position_score(match.start()), text[max(0, match.start() - 160): match.start() + 80])
    for match in _GITHUB_PAGES.finditer(text):
        owner, path = match.group(1), match.group(2)
        start = match.start()
        # A project page at <owner>.github.io/<repo> is served from <owner>/<repo>;
        # an organisation page <owner>.github.io names the owner of the code.
        guesses = [path] if path else [key for key in keys if key and key in _key(owner)][:1]
        for guess in guesses:
            repo = _clean_repo(owner, guess)
            if repo:
                add(repo, position_score(start) + 2, f"project page {match.group(0)}")
    for link in links:
        match = _GITHUB_REPO.search(link)
        repo = _clean_repo(match.group(1), match.group(2)) if match else None
        if repo:
            add(repo, 0, "")
    for entry in found.values():
        if _name_match(entry["repo"], keys):
            entry["score"] += 6
        if _LIST_REPO.search(entry["repo"].split("/", 1)[1]):
            entry["score"] -= 10
    return sorted(found.values(), key=lambda item: (-item["score"], -item["mentions"], item["repo"]))


def _decode_readme(payload: object) -> str:
    if not isinstance(payload, dict) or not payload.get("content"):
        return ""
    try:
        return base64.b64decode(payload["content"]).decode("utf-8", errors="replace")
    except (ValueError, TypeError):
        return ""


def reproduction_entry(readme: str, repo_url: str) -> dict | None:
    """The README section and the first commands a reproduction would start from."""
    if not readme:
        return None
    sections: list[tuple[str, str]] = []
    current_heading, current_lines = "(top)", []
    in_block = False
    for line in readme.splitlines():
        if line.strip().startswith("```"):
            in_block = not in_block
        heading = None if in_block else re.match(r"^\s{0,3}#{1,4}\s+(.*?)\s*#*\s*$", line)
        if heading:
            sections.append((current_heading, "\n".join(current_lines)))
            current_heading, current_lines = heading.group(1).strip(), []
        else:
            current_lines.append(line)
    sections.append((current_heading, "\n".join(current_lines)))

    def unprompt(line: str) -> str:
        # "(robodiff)[diffusion_policy]$ python train.py" -> "python train.py"
        return re.sub(r"^(?:\([^)]*\)\s*)?(?:\[[^\]]*\]\s*)?(?:[\w@.~:/-]*\$\s+)", "", line.strip())

    def commands(body: str, strong_only: bool) -> list[str]:
        test = _RUN_COMMAND if strong_only else _COMMAND
        for block in re.findall(r"```[^\n]*\n(.*?)```", body, re.DOTALL):
            lines = [unprompt(line) for line in block.splitlines() if _COMMAND.match(unprompt(line))]
            if lines and any(test.match(line) for line in lines):
                return [line[:240] for line in lines[:4]]
        inline = [span.strip() for span in re.findall(r"`([^`\n]{6,240})`", body) if test.match(span.strip())]
        return inline[:4]

    def anchor(heading: str) -> str:
        return repo_url + "#" + re.sub(r"[^a-z0-9 -]", "", heading.lower()).strip().replace(" ", "-")

    for strong_only in (True, False):
        for cue in _README_SECTION_PRIORITY:
            for heading, body in sections:
                if cue in heading.lower():
                    found = commands(body, strong_only)
                    if found:
                        return {"repo": repo_url, "readme_section": heading, "anchor": anchor(heading), "commands": found}
    for heading, body in sections:
        found = commands(body, False)
        if found:
            return {"repo": repo_url, "readme_section": heading, "anchor": anchor(heading), "commands": found}
    return None


def github_repo_record(lookups: AssetLookups, repo: str, keys: list[str] | None = None) -> dict | None:
    record = lookups.get(f"{GITHUB_API}/repos/{repo}", kind="code", purpose=f"repository record {repo}")
    if not isinstance(record, dict) or not record.get("full_name"):
        return None
    source = record.get("source") or record.get("parent")
    # A fork is usually someone's copy and its source is the code's home -- but a
    # paper can publish its code AS a fork of its base (openvla/openvla forks
    # TRI-ML/prismatic-vlms), so a fork named like the paper stays.
    named_like_paper = bool(keys) and _name_match(record["full_name"], keys)
    if record.get("fork") and not named_like_paper and isinstance(source, dict) and source.get("full_name"):
        # A fork is someone's copy; the code's home is its source.
        upstream = lookups.get(f"{GITHUB_API}/repos/{source['full_name']}", kind="code",
                               purpose=f"fork source of {repo}: {source['full_name']}")
        if isinstance(upstream, dict) and upstream.get("full_name"):
            upstream["_fork_seen"] = record["full_name"]
            return upstream
    return record


def github_repo_metadata(lookups: AssetLookups, record: dict) -> dict:
    """License, stars, recency, head commit, README head and environment files."""
    full_name = record["full_name"]
    branch = record.get("default_branch") or "main"
    head = lookups.get(f"{GITHUB_API}/repos/{full_name}/commits/{urllib.parse.quote(branch)}", kind="code",
                       purpose=f"default-branch head {full_name}@{branch}")
    readme = _decode_readme(lookups.get(f"{GITHUB_API}/repos/{full_name}/readme", kind="code", purpose=f"README {full_name}"))
    listing = lookups.get(f"{GITHUB_API}/repos/{full_name}/contents/", kind="code", purpose=f"top-level files {full_name}")
    names = [item.get("name") for item in listing if isinstance(item, dict)] if isinstance(listing, list) else []
    license_info = record.get("license") or {}
    spdx = license_info.get("spdx_id")
    url = record.get("html_url") or f"https://github.com/{full_name}"
    return {
        "url": url,
        "full_name": full_name,
        "license": spdx if spdx and spdx != "NOASSERTION" else (license_info.get("name") or None),
        "stars": record.get("stargazers_count"),
        "forks": record.get("forks_count"),
        "pushed_at": record.get("pushed_at"),
        "archived": record.get("archived"),
        "default_branch": branch,
        "head_sha": head.get("sha") if isinstance(head, dict) else None,
        "description": record.get("description"),
        "readme_head": readme[:README_HEAD_CHARS] if readme else None,
        "env_files": [name for name in names if name in _ENV_FILES],
        "top_level": names[:60],
        "reproduction_entry": reproduction_entry(readme, url),
        "fork_seen": record.get("_fork_seen"),
        "_readme": readme,
    }


def github_search(lookups: AssetLookups, query: str, purpose: str) -> list[dict]:
    params = urllib.parse.urlencode({"q": query, "sort": "stars", "order": "desc", "per_page": "10"})
    payload = lookups.get(f"{GITHUB_API}/search/repositories?{params}", kind="code", purpose=purpose)
    items = payload.get("items") if isinstance(payload, dict) else None
    return [item for item in items or [] if isinstance(item, dict) and item.get("full_name")]


def resolve_code(lookups: AssetLookups, text: str, links: list[str], keys: list[str], arxiv_id: str,
                 references_offset: int | None, queries: dict[str, str] | None = None) -> tuple[list[dict], list[str], list[dict]]:
    """``(code entries, README texts, candidates considered)``."""
    candidates = repo_candidates(text, links, keys, references_offset)
    lookups.searches.append({"kind": "code", "source": "full text", "request": f"github.com and github.io links in {arxiv_id}",
                             "status": "done", "found": [c["repo"] for c in candidates[:8]]})
    records: dict[str, dict] = {}

    def check(candidate: dict) -> None:
        if len(records) >= MAX_REPO_CHECKS or candidate["repo"].lower() in records:
            return
        record = github_repo_record(lookups, candidate["repo"], keys)
        candidate["checked"] = record is not None
        if record:
            candidate["stars"] = record.get("stargazers_count") or 0
            if record.get("_fork_seen"):
                candidate["evidence"].append(f"fork {candidate['repo']} of {record['full_name']}")
                candidate["repo"] = record["full_name"]
            records[candidate["repo"].lower()] = record

    for candidate in [c for c in candidates if c["score"] >= OFFICIAL_SCORE][:MAX_REPO_CHECKS]:
        check(candidate)
    if not any(c.get("checked") and c["score"] >= OFFICIAL_SCORE for c in candidates):
        # The paper links no repository named like it: search GitHub by its name.
        # Only a repository with some following counts -- a namesake nobody uses
        # is someone's copy, not the paper's code.
        for key in keys[:2]:
            query = (queries or {}).get(key, key)
            items = github_search(lookups, f"{query} in:name", f"repository search by the paper's name '{query}'")
            for item in items:
                stars = item.get("stargazers_count") or 0
                if (_key(item["name"]) != key or _LIST_REPO.search(item["name"]) or stars < MIN_SEARCH_STARS
                        or (item.get("fork") and stars < 50)):
                    continue
                full = item["full_name"]
                entry = next((c for c in candidates if c["repo"].lower() == full.lower()), None)
                if entry is None:
                    entry = {"repo": full, "score": 0, "mentions": 0, "evidence": []}
                    candidates.append(entry)
                entry["score"] = max(entry["score"], OFFICIAL_SCORE)
                entry["stars"] = item.get("stargazers_count") or 0
                entry["evidence"].append(f"GitHub search '{query} in:name'")
                records.setdefault(full.lower(), item if item.get("default_branch") else {})
    official = [c for c in candidates if c["score"] >= OFFICIAL_SCORE and (c.get("checked") or c.get("stars") is not None)]
    # Among repositories named like the paper, the most-starred is its home; the rest are copies.
    official.sort(key=lambda c: (-c["score"], -math.log10((c.get("stars") or 0) + 1), c["repo"]))
    code, readmes = [], []
    for position, candidate in enumerate(official[:MAX_REPOS]):
        record = records.get(candidate["repo"].lower()) or {}
        if not record.get("full_name") or "license" not in record:
            record = github_repo_record(lookups, candidate["repo"], keys) or {}
        if not record.get("full_name"):
            continue
        metadata = github_repo_metadata(lookups, record)
        readme = metadata.pop("_readme", "")
        if readme:
            readmes.append(readme)
        metadata["role"] = "official" if position == 0 else "secondary"
        metadata["found_by"] = candidate["evidence"][:3]
        code.append(metadata)
    return code, readmes, candidates


# --- checkpoints and datasets ------------------------------------------------------------


def hub_links(*texts: str) -> dict[str, list[str]]:
    models: list[str] = []
    datasets: list[str] = []
    for text in texts:
        for match in _HF_LINK.finditer(text or ""):
            owner, name = match.group("owner"), match.group("name").rstrip(".,;:)")
            if owner.lower() in _HF_NOT_OWNERS or match.group("kind") == "spaces/":
                continue
            if re.match(r"/(?:resolve|blob|raw)/", (text or "")[match.end(): match.end() + 8]):
                continue  # a file (usually a README image) inside a repository, not an asset of this paper
            target = datasets if match.group("kind") == "datasets/" else models
            repo_id = f"{owner}/{name}"
            if repo_id not in target:
                target.append(repo_id)
    return {"models": models, "datasets": datasets}


def _hub_license(record: dict) -> str | None:
    card = record.get("cardData") or {}
    value = card.get("license") if isinstance(card, dict) else None
    if isinstance(value, list):
        value = ", ".join(str(item) for item in value)
    if value:
        return str(value)
    for tag in record.get("tags") or []:
        if isinstance(tag, str) and tag.startswith("license:"):
            return tag.split(":", 1)[1]
    return None


def hub_record(lookups: AssetLookups, kind: str, repo_id: str) -> dict | None:
    collection = "models" if kind == "checkpoints" else "datasets"
    record = lookups.get(f"{HF_API}/{collection}/{repo_id}", kind=kind, purpose=f"Hub {collection[:-1]} {repo_id}")
    if not isinstance(record, dict) or not record.get("id"):
        return None
    used = record.get("usedStorage")
    safetensors = record.get("safetensors") or {}
    prefix = "https://huggingface.co/" + ("" if collection == "models" else "datasets/")
    return {
        "url": prefix + record["id"],
        "size_gb": round(used / 1e9, 2) if isinstance(used, (int, float)) else None,
        "size_basis": "Hub usedStorage (all files and revisions)" if isinstance(used, (int, float)) else None,
        "license": _hub_license(record),
        "downloads": record.get("downloads"),
        "gated": record.get("gated"),
        "params": safetensors.get("total") if isinstance(safetensors, dict) else None,
        "last_modified": record.get("lastModified"),
        "source": "huggingface",
    }


def hub_tagged(lookups: AssetLookups, kind: str, arxiv_id: str) -> list[dict]:
    collection = "models" if kind == "checkpoints" else "datasets"
    params = urllib.parse.urlencode({"filter": f"arxiv:{arxiv_id}", "sort": "downloads", "direction": "-1", "limit": "20"})
    payload = lookups.get(f"{HF_API}/{collection}?{params}", kind=kind, purpose=f"Hub {collection} tagged arxiv:{arxiv_id}")
    return [item for item in payload if isinstance(item, dict) and item.get("id")] if isinstance(payload, list) else []


def readme_asset_links(readmes: list[str]) -> dict[str, list[str]]:
    """Checkpoint and data URLs a README hosts outside the Hub (project servers, buckets)."""
    out: dict[str, list[str]] = {"checkpoints": [], "datasets": []}
    for readme in readmes:
        for line in readme.splitlines():
            lowered = line.lower()
            kind = ("checkpoints" if re.search(r"checkpoint|pretrain|weights|ckpt|model zoo", lowered)
                    else "datasets" if re.search(r"dataset|\bdata\b|demonstrations", lowered) else None)
            if not kind:
                continue
            for url in _ASSET_URL.findall(line):
                url = url.rstrip(".,;:")
                if _NOT_ASSET_URL.search(url):
                    continue
                if url not in out[kind]:
                    out[kind].append(url)
    return {kind: urls[:3] for kind, urls in out.items()}


def resolve_hub(lookups: AssetLookups, kind: str, linked: list[str], arxiv_id: str, owners: set[str],
                keys: list[str], first_word: str = "") -> list[dict]:
    """Hub records: linked by the paper/README first, then arXiv-tagged ones that are plausibly official."""
    ids = list(linked)
    for item in hub_tagged(lookups, kind, arxiv_id):
        repo_id = item["id"]
        owner, _, name = repo_id.partition("/")
        plausible = owner.lower() in owners or any(key and key in _key(name) for key in keys) or any(
            key and key in _key(owner) for key in keys)
        if not plausible and first_word and first_word in _key(name) and (item.get("downloads") or 0) >= 1000:
            plausible = True  # e.g. lerobot/diffusion_pusht for Diffusion Policy: widely used, named for the method
        if plausible and repo_id not in ids:
            ids.append(repo_id)
    records = []
    for repo_id in ids[: MAX_HUB_ITEMS + 3]:
        record = hub_record(lookups, kind, repo_id)
        if record:
            record["found_by"] = "linked by paper/README" if repo_id in linked else f"Hub tag arxiv:{arxiv_id}"
            records.append(record)
        if len(records) >= MAX_HUB_ITEMS:
            break
    return records


# --- environments and GPU memory ------------------------------------------------------------


def detect_envs(text: str, readmes: list[str]) -> tuple[list[str], dict]:
    evidence = {}
    for name, pattern in ENV_PATTERNS.items():
        paper_hits = list(pattern.finditer(text))
        readme_hits = sum(len(pattern.findall(readme)) for readme in readmes)
        if len(paper_hits) >= 2 or readme_hits >= 2 or (paper_hits and readme_hits):
            first = paper_hits[0].start() if paper_hits else None
            evidence[name] = {
                "paper_mentions": len(paper_hits),
                "readme_mentions": readme_hits,
                "first_context": re.sub(r"\s+", " ", text[max(0, first - 100): first + 100]).strip() if first is not None else None,
            }
    if "MuJoCo Playground" in evidence:
        evidence.pop("MuJoCo", None)
    ranked = sorted(evidence, key=lambda name: -(evidence[name]["paper_mentions"] + 3 * evidence[name]["readme_mentions"]))
    return ranked, evidence


def _use_of(context: str) -> str:
    lowered = context.lower()
    if re.search(r"train|fine-?tun|pretrain|learn(?:ed|ing)? (?:in|on|with)", lowered):
        return "train"
    if re.search(r"infer|deploy|evaluat|real[- ]time|\bhz\b|rollout|\btest|serv", lowered):
        return "eval"
    return "unspecified"


def _gpu_mentions(text: str, source: str) -> list[dict]:
    mentions = []
    for pattern, memory in _GPU_MEMORY:
        for match in re.finditer(pattern, text):
            context = re.sub(r"\s+", " ", text[max(0, match.start() - 140): match.end() + 140]).strip()
            explicit = [float(value) for value in _EXPLICIT_GB.findall(text[max(0, match.start() - 40): match.end() + 40])]
            stated = explicit[0] if explicit and 4 <= explicit[0] <= 200 else memory
            mentions.append({"gpu": match.group(0), "memory_gb": stated, "use": _use_of(context), "source": source,
                             "context": context[:320]})
            if len(mentions) >= 12:
                return mentions
    for match in re.finditer(r"(?<![\d.])(\d{1,3}(?:\.\d+)?)\s*GB\s*(?:of\s+)?(?:GPU\s+)?(?:VRAM|GPU memory|of GPU memory|video memory)",
                             text, re.IGNORECASE):
        context = re.sub(r"\s+", " ", text[max(0, match.start() - 140): match.end() + 140]).strip()
        mentions.append({"gpu": None, "memory_gb": float(match.group(1)), "use": _use_of(context), "source": source,
                         "context": context[:320]})
    return mentions


def estimate_vram(text: str, readmes: list[str], checkpoint_params: int | None, keys: list[str] | None = None) -> dict:
    """Minimum GPU memory to evaluate and to train, with the basis stated.

    Evaluation is dominated by the weights, so a known parameter count gives it
    directly. Training also holds activations, which no parameter count gives,
    so the parameter-based figure is a lower bound and a GPU the authors report
    training on raises it to what is known to suffice.
    """
    mentions = _gpu_mentions(text, "paper")
    for readme in readmes:
        mentions.extend(_gpu_mentions(readme, "README"))
    params = checkpoint_params
    params_basis = "Hub safetensors parameter count of the official checkpoint" if params else None
    if not params and keys:
        # Only a count stated next to the paper's own name: papers quote their
        # baselines' sizes too (Octo's text names RT-2-X at 55B).
        # The nearest model-like name before the number must be the paper's:
        # "Octo-Base (93M params)" counts, "Octo to RT-2-X, a 55 billion
        # parameter model" does not.
        counts = []
        for match in _PARAMS.finditer(text[:80000]):
            before = text[max(0, match.start() - 80): match.start()]
            names = _MODEL_NAME.findall(before)
            if names and any(key in _key(names[-1]) for key in keys):
                value, unit = match.group(1), match.group(2)
                counts.append(float(value) * (1e9 if unit.lower() in ("b", "billion") else 1e6))
        if counts:
            params = int(max(counts))
            params_basis = "largest parameter count the paper states next to its own name"
    lora = bool(re.search(r"\bLoRA\b", text) or any(re.search(r"\bLoRA\b", readme) for readme in readmes))
    basis = []
    eval_gb = train_gb = None
    if params:
        eval_gb = round(params * 2 * 1.2 / 1e9 + 1.0, 1)
        full_train = round(params * 16 * 1.2 / 1e9, 1)
        train_gb = round(params * 2 * 1.3 / 1e9 + 4.0, 1) if lora else full_train
        basis.append(
            f"{params / 1e9:.2f}B parameters ({params_basis}): eval = bf16 weights x1.2 + 1 GB; train lower bound = "
            + (f"LoRA fine-tune (LoRA is described; a full fine-tune needs ~{full_train} GB)" if lora
               else "full mixed-precision AdamW (16 B/param x1.2), activations excluded")
        )
    stated_train = sorted(m["memory_gb"] for m in mentions if m["use"] == "train" and m["memory_gb"])
    stated_eval = sorted(m["memory_gb"] for m in mentions if m["use"] == "eval" and m["memory_gb"])
    stated_any = sorted(m["memory_gb"] for m in mentions if m["memory_gb"])
    if stated_train and (train_gb is None or stated_train[0] > train_gb):
        train_gb = stated_train[0]
        basis.append(f"train: {train_gb} GB, the smallest GPU the paper/README reports training on (known to suffice)")
    if eval_gb is None and (stated_eval or stated_any):
        eval_gb = (stated_eval or stated_any)[0]
        basis.append(f"eval: {eval_gb} GB, the smallest GPU the paper/README reports running on; a smaller card is untested")
    if train_gb is None and stated_any:
        train_gb = stated_any[0]
        basis.append(f"train: {train_gb} GB, the smallest GPU the paper/README mentions (use unspecified)")
    if eval_gb is None and train_gb is None:
        basis.append("no parameter count or GPU statement found; estimate unavailable")
    return {"min_vram_gb_eval": eval_gb, "min_vram_gb_train": train_gb, "vram_basis": basis, "params": params,
            "stated_hardware": mentions[:10]}


# --- one paper -----------------------------------------------------------------------------


def _references_offset(index: dict) -> int | None:
    for section in index.get("sections") or []:
        if re.match(r"^(references|bibliography)$", (section.get("title") or "").strip(), re.IGNORECASE):
            return section.get("offset")
    return None


def resolve_assets(arxiv_id: str, *, title: str | None = None, lookups: AssetLookups | None = None,
                   fulltext_root: Path | str | None = None, inventory: dict | None = None) -> dict:
    """Assets of one paper, in the card's ``assets`` shape plus the evidence behind them."""
    base_id, _ = normalize_arxiv_id(arxiv_id)
    lookups = lookups or AssetLookups()
    loaded = load_fulltext(base_id, fulltext_root)
    manifest, text, index = loaded if loaded else (None, "", {"sections": [], "labels": [], "links": []})
    if not title and text:
        title = next((line.lstrip("# ").strip() for line in text.splitlines() if line.startswith("#")), "")
    references_offset = _references_offset(index)
    body = text[:references_offset] if references_offset else text
    keys = name_keys(title or "")

    code, readmes, candidates = resolve_code(lookups, text, index.get("links") or [], keys, base_id, references_offset,
                                             name_queries(title or ""))
    owners = {item["full_name"].split("/", 1)[0].lower() for item in code}
    links = hub_links(body, *readmes)
    lookups.searches.append({"kind": "checkpoints", "source": "full text + README", "request": "huggingface.co / hf:// links",
                             "status": "done", "found": links["models"][:8]})
    lookups.searches.append({"kind": "datasets", "source": "full text + README", "request": "huggingface.co/datasets links",
                             "status": "done", "found": links["datasets"][:8]})
    head_words = re.findall(r"[A-Za-z]{5,}", (title or "").split(":", 1)[0]) if ":" in (title or "") else []
    first_word = _key(head_words[0]) if head_words else ""
    hub = {
        "checkpoints": resolve_hub(lookups, "checkpoints", links["models"], base_id, owners, keys, first_word),
        "datasets": resolve_hub(lookups, "datasets", links["datasets"], base_id, owners, keys, first_word),
    }
    other = readme_asset_links(readmes)
    license_of_code = code[0].get("license") if code else None
    for kind in ("checkpoints", "datasets"):
        lookups.searches.append({"kind": kind, "source": "README", "request": f"{kind} URLs outside the Hub",
                                 "status": "done", "found": other[kind]})
        for url in other[kind]:
            if len(hub[kind]) >= MAX_HUB_ITEMS + 2:
                break
            hub[kind].append({"url": url, "size_gb": None, "license": license_of_code,
                              "license_basis": "the code repository's license; the host states none" if license_of_code else None,
                              "source": "README link", "found_by": "linked by README"})

    envs, env_evidence = detect_envs(body, readmes)
    params = next((record["params"] for record in hub["checkpoints"] if record.get("params")), None)
    vram = estimate_vram(body, readmes, params, keys)
    local = match_local_assets(inventory if inventory is not None else load_local_asset_inventory(),
                               [item["url"] for item in code], keys, envs[:3])
    return {
        "paper_id": f"arxiv:{base_id}",
        "title": title,
        "name_keys": keys,
        "fulltext_source": {"url": manifest["source_url"], "sha256": manifest["sha256"]} if manifest else None,
        "assets": {
            "code": code,
            "checkpoints": hub["checkpoints"],
            "datasets": hub["datasets"],
            "envs": envs,
            "min_vram_gb_eval": vram["min_vram_gb_eval"],
            "min_vram_gb_train": vram["min_vram_gb_train"],
            "reproduction_entry": code[0].get("reproduction_entry") if code else None,
            "local_copy_path": local["local_copy_path"],
            "local_related": local["local_related"],
            "vram_basis": vram["vram_basis"],
            "none_found": [kind for kind in ("code", "checkpoints", "datasets") if not (code if kind == "code" else hub[kind])],
            "searches_tried": lookups.searches,
        },
        "evidence": {
            "code_candidates": candidates[:8],
            "env_evidence": env_evidence,
            "stated_hardware": vram["stated_hardware"],
            "params": vram["params"],
            "local_inventory": local["inventory"],
        },
        "resolved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "Metadata only: nothing was cloned, downloaded or run. A rate-limited or refused lookup in "
                "searches_tried is not evidence that the asset does not exist.",
    }


def write_assets(arxiv_id: str, result: dict, fulltext_root: Path | str | None = None) -> Path:
    directory = cache_dir_for(arxiv_id, fulltext_root)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "assets.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
