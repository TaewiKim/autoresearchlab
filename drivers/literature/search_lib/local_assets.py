"""Open-source robot-learning assets already on this host.

Almost every SOTA robot-learning paper ships code, checkpoints, datasets and
benchmark environments. The ones already cloned here cost nothing to use, so a
deep-read card records whether its paper's code is on disk (``local_copy_path``)
and which local repositories re-implement the same method or ship the same
benchmark (``local_related``).

The inventory is built on the host -- the scout container only mounts the
project's parent directory -- and written to
``.research-lab/literature/local-asset-inventory.json``, which the scout reads.
Nothing here touches the network or runs repository code: it reads
``.git/config``, ``.git/HEAD``, READMEs and directory names.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

LOCAL_ASSET_ROOTS_ENV = "RESEARCHLAB_LOCAL_ASSET_ROOTS"
LOCAL_ASSET_INVENTORY_ENV = "RESEARCHLAB_LOCAL_ASSET_INVENTORY"
# Local copies of reference repositories are the operator's to name
# (RESEARCHLAB_LOCAL_ASSET_ROOTS, os.pathsep-separated); there is no default.
DEFAULT_LOCAL_ASSET_ROOTS: tuple[str, ...] = ()
DEFAULT_INVENTORY_PATH = Path(__file__).resolve().parents[3] / ".research-lab" / "literature" / "local-asset-inventory.json"
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "build", "dist", ".mypy_cache", ".pytest_cache",
              "logs", "outputs", "wandb", "media", "imgs", "images", ".github", "third_party", "external_dependencies"}
_MAX_DIRS_PER_REPO = 20000
_MAX_DEPTH = 6

# Methods and benchmark environments, by the spellings their code and papers use.
METHOD_VOCAB: dict[str, list[str]] = {
    "Diffusion Policy": [r"diffusion[_ -]?policy", r"policies/diffusion\b"],
    "ACT (Action Chunking Transformer)": [r"action[_ -]chunking", r"policies/act\b", r"\bimitate_episodes\b"],
    "pi0 / pi0.5": [r"\bpi0(?:5|\.5|_fast|fast)?\b", r"\bpi05\b"],
    "SmolVLA": [r"smolvla"],
    "OpenVLA": [r"openvla"],
    "Octo": [r"\bocto[_-]?(?:base|small|model)?\b"],
    "GR00T N1": [r"gr00t"],
    "VQ-BeT": [r"vq[_-]?bet"],
    "TD-MPC": [r"td[_-]?mpc"],
    "FAST action tokenizer": [r"\bfast[_ -]tokeni[sz]er\b", r"\bFASTER\b"],
    "RL (PPO)": [r"\bppo\b", r"rsl_rl", r"\brl_games\b", r"\bskrl\b"],
    "RL (SAC)": [r"\bsac\b"],
    "Legged locomotion": [r"locomotion", r"legged[_ ]gym", r"\banymal", r"\bunitree"],
    "Imitation learning (robomimic/BC)": [r"robomimic", r"\bbc[_-]rnn\b"],
    "Motion generation (cuRobo)": [r"curobo"],
    "6-DoF pose tracking (FoundationPose)": [r"foundationpose"],
    "Grasp generation (GraspGen)": [r"graspgen"],
    "Teleoperation / data collection": [r"teleop", r"record_sim_episodes"],
}
ENV_VOCAB: dict[str, list[str]] = {
    "ManiSkill": [r"mani[_ ]?skill\s?\d?"],
    "robomimic": [r"robomimic"],
    "LIBERO": [r"\blibero\b"],
    "Isaac Lab": [r"isaac[_ ]?lab", r"isaaclab"],
    "Isaac Gym": [r"isaac[_ ]?gym"],
    "Isaac Sim": [r"isaac[_ ]?sim\b"],
    "MuJoCo Playground": [r"mujoco[_ -]?playground"],
    "MuJoCo": [r"\bmujoco\b"],
    "legged_gym": [r"legged[_ ]gym"],
    "RLBench": [r"\brlbench\b"],
    "Meta-World": [r"meta[_ -]?world"],
    "CALVIN": [r"\bcalvin\b"],
    "SIMPLER": [r"\bsimpler(?:[_ -]?env)?\b"],
    "robosuite": [r"robosuite"],
    "RoboCasa": [r"robocasa"],
    "Push-T": [r"\bpush[_ -]?t\b", r"\bpusht\b"],
    "Franka Kitchen": [r"franka[_ ]kitchen"],
    "D4RL": [r"\bd4rl\b"],
    "BridgeData": [r"bridge[_ ]?data"],
    "Open X-Embodiment": [r"open[_ -]?x[_ -]?embodiment"],
    "DROID": [r"\bdroid\b"],
    "ALOHA": [r"\baloha\b"],
    "DeepMind Control": [r"dm[_ ]?control", r"deepmind control"],
    "Brax": [r"\bbrax\b"],
    "Genesis": [r"genesis[_ -]world", r"genesis[_ -]embodied", r"genesis (?:simulator|physics)"],
    "Gymnasium": [r"gymnasium"],
    "PyBullet": [r"pybullet"],
}


def _compile(vocab: dict[str, list[str]]) -> dict[str, re.Pattern]:
    return {name: re.compile("|".join(f"(?:{pattern})" for pattern in patterns), re.IGNORECASE)
            for name, patterns in vocab.items()}


METHOD_PATTERNS = _compile(METHOD_VOCAB)
ENV_PATTERNS = _compile(ENV_VOCAB)


def normalize_repo_url(url: str | None) -> str | None:
    """``owner/repo`` (lower case) of a GitHub remote or URL, else ``None``."""
    if not url:
        return None
    match = re.search(r"github\.com[:/]+([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$", url.strip())
    return f"{match.group(1)}/{match.group(2)}".lower() if match else None


def _git_dir(path: Path) -> Path | None:
    """The ``.git`` directory of the working tree holding ``path``."""
    for candidate in (path, *path.parents):
        if (candidate / ".git").is_dir():
            return candidate / ".git"
    return None


def _git_remote(repo: Path) -> str | None:
    git = _git_dir(repo)
    if git is None:
        return None
    try:
        config = (git / "config").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    section = re.search(r'\[remote "origin"\](.*?)(?:\n\[|\Z)', config, re.DOTALL)
    match = re.search(r"^\s*url\s*=\s*(\S+)", section.group(1) if section else config, re.MULTILINE)
    return match.group(1) if match else None


def _git_head(repo: Path) -> str | None:
    git = _git_dir(repo)
    if git is None:
        return None
    try:
        head = (git / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not head.startswith("ref:"):
        return head or None
    ref = head.split(":", 1)[1].strip()
    try:
        return (git / ref).read_text(encoding="utf-8").strip()
    except OSError:
        pass
    try:
        for line in (git / "packed-refs").read_text(encoding="utf-8").splitlines():
            if line.endswith(" " + ref):
                return line.split(" ", 1)[0]
    except OSError:
        pass
    return None


def _readme(repo: Path) -> str:
    for name in ("README.md", "readme.md", "README.rst", "README.txt", "README"):
        path = repo / name
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8", errors="replace")[:60000]
            except OSError:
                return ""
    return ""


def _directory_paths(repo: Path) -> list[str]:
    paths: list[str] = []
    for current, dirs, _files in os.walk(repo):
        rel = Path(current).relative_to(repo)
        depth = len(rel.parts)
        dirs[:] = [name for name in dirs if name not in _SKIP_DIRS and not name.startswith(".")]
        if depth >= _MAX_DEPTH:
            dirs[:] = []
        if depth:
            paths.append(rel.as_posix())
        if len(paths) >= _MAX_DIRS_PER_REPO:
            break
    return paths


def _matches(patterns: dict[str, re.Pattern], readme: str, paths: list[str]) -> list[dict]:
    found = []
    for name, pattern in patterns.items():
        in_paths = [path for path in paths if pattern.search(path.replace("-", "_"))]
        readme_hits = len(pattern.findall(readme))
        if in_paths or readme_hits >= 2:
            found.append({"name": name, "readme_mentions": readme_hits, "paths": in_paths[:3]})
    return found


def discover_repositories(roots: list[str] | None = None) -> list[Path]:
    """Every git working tree named by a root, or directly inside one."""
    if roots is None:
        configured = (os.environ.get(LOCAL_ASSET_ROOTS_ENV) or "").strip()
        roots = [part for part in configured.split(os.pathsep) if part.strip()] if configured else list(DEFAULT_LOCAL_ASSET_ROOTS)
    repos: list[Path] = []
    for raw in roots:
        root = Path(raw)
        if not root.is_dir():
            continue
        children = sorted(child for child in root.iterdir() if (child / ".git").exists())
        if (root / ".git").exists() or not children:
            # A working tree, or a project directory inside one (its remote and
            # head are then the enclosing repository's).
            repos.append(root)
        else:
            repos.extend(children)
    return repos


def build_local_asset_inventory(roots: list[str] | None = None) -> dict:
    entries = []
    for repo in discover_repositories(roots):
        readme = _readme(repo)
        paths = _directory_paths(repo)
        title = next((line.lstrip("# ").strip() for line in readme.splitlines() if line.strip().startswith("#")), repo.name)
        remote = _git_remote(repo)
        entries.append({
            "path": repo.as_posix(),
            "name": repo.name,
            "remote_url": remote,
            "repo": normalize_repo_url(remote),
            "head_sha": _git_head(repo),
            "readme_title": title[:160],
            "methods": _matches(METHOD_PATTERNS, readme, paths),
            "benchmarks": _matches(ENV_PATTERNS, readme, paths),
            "directories_scanned": len(paths),
        })
    return {
        "version": "local-asset-inventory-v1",
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "roots": roots if roots is not None else (
            [part for part in (os.environ.get(LOCAL_ASSET_ROOTS_ENV) or "").split(os.pathsep) if part.strip()]
            or list(DEFAULT_LOCAL_ASSET_ROOTS)
        ),
        "repositories": entries,
        "note": "Read from .git, READMEs and directory names only; no code was run. 'methods'/'benchmarks' are "
                "keyword matches -- a lead, not proof that a working implementation exists.",
    }


def inventory_path() -> Path:
    configured = (os.environ.get(LOCAL_ASSET_INVENTORY_ENV) or "").strip()
    return Path(configured) if configured else DEFAULT_INVENTORY_PATH


def write_local_asset_inventory(path: Path | None = None, roots: list[str] | None = None) -> dict:
    inventory = build_local_asset_inventory(roots)
    target = path or inventory_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")
    inventory["inventory_path"] = str(target)
    return inventory


def load_local_asset_inventory(path: Path | None = None) -> dict | None:
    try:
        return json.loads((path or inventory_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def match_local_assets(inventory: dict | None, repos: list[str], method_terms: list[str], envs: list[str]) -> dict:
    """``local_copy_path`` (an exact clone of the paper's code) and related local repositories."""
    if not inventory:
        return {"local_copy_path": None, "local_related": [], "inventory": "missing"}
    wanted = {normalize_repo_url(url) for url in repos} - {None}
    copy = None
    related = []

    def squash(text: str) -> str:
        return re.sub(r"[^a-z0-9]", "", text.lower())

    terms = [squash(term) for term in method_terms if term and len(squash(term)) >= 3]
    for entry in inventory.get("repositories") or []:
        if entry.get("repo") and entry["repo"] in wanted and copy is None:
            copy = entry["path"]
            continue
        reasons = []
        for method in entry.get("methods") or []:
            if any(term in squash(method["name"]) for term in terms):
                reasons.append(f"method {method['name']} ({', '.join(method['paths'][:2]) or 'README'})")
        for bench in entry.get("benchmarks") or []:
            if bench["name"] in envs:
                reasons.append(f"benchmark {bench['name']} ({', '.join(bench['paths'][:2]) or 'README'})")
        if reasons:
            related.append({"path": entry["path"], "repo": entry.get("repo"), "head_sha": entry.get("head_sha"),
                            "why": reasons[:4]})
    return {"local_copy_path": copy, "local_related": related[:6], "inventory": "loaded"}
