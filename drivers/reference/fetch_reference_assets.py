#!/usr/bin/env python3
"""Fetch the reference code and checkpoints a cycle's SOTA cards name.

The harness decides WHAT to fetch (a plan file); this script only fetches, and
only from an allowlist of hosts. It never executes anything it downloads: a
repository is cloned shallowly and a checkpoint is streamed to disk, nothing more.

Why it exists (MEASURED ON cycle-a-20260919, 2026-11-09): every slate
candidate failed feasibility because the reproduction anchor -- one number a SOTA
card reports, reproduced here first -- needs the paper's official code and a
checkpoint, and the container had neither (the cards' ``local_copy_path`` pointed
at a Windows directory that was never mounted). Selection looped on that for a day.

State is written to ``--state-file`` after every step so the harness can read
progress, and carries a heartbeat so a dead fetch is recognisable.

plan file: {"items": [{"id", "kind": "git"|"hf", "url", "name", "size_gb"}]}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ALLOWED_HOSTS = {
    "git": {"github.com"},
    "hf": {"huggingface.co"},
}
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
CHUNK = 1024 * 1024


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def safe_name(value: str) -> str:
    cleaned = SAFE_NAME.sub("-", value).strip("-.")
    return cleaned or "asset"


def host_of(url: str) -> str:
    return (urllib.parse.urlparse(url).hostname or "").lower()


def validate_item(item: dict) -> str | None:
    """Why this item may not be fetched, or None."""
    kind = item.get("kind")
    url = str(item.get("url") or "")
    if kind not in ALLOWED_HOSTS:
        return f"unsupported kind {kind!r}"
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https":
        return "only https sources are fetched"
    if host_of(url) not in ALLOWED_HOSTS[kind]:
        return f"host {host_of(url)!r} is not on the allowlist for {kind}"
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        return "url does not name an owner and a repository"
    return None


class State:
    def __init__(self, path: Path, items: list[dict]):
        self.path = path
        self.data = {
            "status": "running",
            "pid": os.getpid(),
            "started_at": now(),
            "updated_at": now(),
            "items": [
                {"id": item["id"], "kind": item["kind"], "url": item["url"], "status": "pending"}
                for item in items
            ],
        }
        self.flush()

    def flush(self) -> None:
        self.data["updated_at"] = now()
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def update(self, item_id: str, **fields) -> None:
        for row in self.data["items"]:
            if row["id"] == item_id:
                row.update(fields)
        self.flush()

    def finish(self) -> None:
        statuses = {row["status"] for row in self.data["items"]}
        self.data["status"] = "complete" if statuses <= {"fetched", "present"} else "partial"
        self.data["finished_at"] = now()
        self.flush()


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 900) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_LFS_SKIP_SMUDGE="1")
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def fetch_git(item: dict, root: Path, state: State) -> dict:
    dest = root / "repos" / safe_name(item["name"])
    if (dest / ".git").is_dir():
        head = run(["git", "rev-parse", "HEAD"], cwd=dest).stdout.strip()
        return {"status": "present", "path": str(dest), "commit": head}
    if dest.exists():
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    done = run(["git", "clone", "--depth", "1", "--no-tags", item["url"], str(dest)])
    if done.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        return {"status": "failed", "error": (done.stderr or done.stdout).strip()[-300:]}
    head = run(["git", "rev-parse", "HEAD"], cwd=dest).stdout.strip()
    size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file() and ".git" not in f.parts)
    return {"status": "fetched", "path": str(dest), "commit": head, "bytes": size}


def hf_repo(url: str) -> str:
    parts = [part for part in urllib.parse.urlparse(url).path.split("/") if part]
    return "/".join(parts[:2])


def open_url(url: str, timeout: int = 60):
    request = urllib.request.Request(url, headers={"User-Agent": "researchlab-reference-fetch"})
    return urllib.request.urlopen(request, timeout=timeout)


def fetch_hf(item: dict, root: Path, state: State, max_bytes: int) -> dict:
    repo = hf_repo(item["url"])
    dest = root / "checkpoints" / safe_name(repo)
    with open_url(f"https://huggingface.co/api/models/{repo}?blobs=true") as response:
        info = json.load(response)
    files = [(s["rfilename"], int(s.get("size") or 0)) for s in info.get("siblings", [])]
    total = sum(size for _, size in files)
    if total > max_bytes:
        return {"status": "skipped", "error": f"{total / 2**30:.1f} GB exceeds the {max_bytes / 2**30:.1f} GB cap"}
    dest.mkdir(parents=True, exist_ok=True)
    digests = {}
    for name, size in files:
        target = dest / name
        if any(part in ("", ".", "..") for part in Path(name).parts):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file() and target.stat().st_size == size:
            continue
        sha = hashlib.sha256()
        url = f"https://huggingface.co/{repo}/resolve/main/{urllib.parse.quote(name)}"
        part = target.with_name(target.name + ".part")
        with open_url(url, timeout=120) as response, open(part, "wb") as out:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                sha.update(chunk)
                state.flush()
        os.replace(part, target)
        digests[name] = sha.hexdigest()
    return {"status": "fetched", "path": str(dest), "bytes": total, "files": len(files), "sha256": digests}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan-file", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--max-asset-gb", type=float, default=5.0)
    args = parser.parse_args(argv)

    plan = json.loads(Path(args.plan_file).read_text(encoding="utf-8"))
    items = plan.get("items", [])
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    state = State(Path(args.state_file), items)
    max_bytes = int(args.max_asset_gb * 2**30)
    for item in items:
        problem = validate_item(item)
        if problem:
            state.update(item["id"], status="rejected", error=problem)
            continue
        state.update(item["id"], status="fetching")
        try:
            result = fetch_git(item, root, state) if item["kind"] == "git" else fetch_hf(item, root, state, max_bytes)
        except Exception as error:  # a fetch that dies is recorded, never fatal to the others
            result = {"status": "failed", "error": str(error)[:300]}
        state.update(item["id"], finished_at=now(), **result)
    state.finish()
    return 0


if __name__ == "__main__":
    sys.exit(main())
