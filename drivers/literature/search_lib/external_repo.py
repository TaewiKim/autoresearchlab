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

from .templates.external_repo_wrapper import _external_repo_agent_wrapper_code
from .constants import EXTERNAL_REPO_CLONE_TIMEOUT_SECONDS, EXTERNAL_REPO_SEARCH_PER_QUERY, GITHUB_REPOSITORY_SEARCH_URL
from .http_client import clean_text, fetch_json
from .queries import _dedupe_texts, _query_tokens, _scientific_phrases
from .providers import cycle_id_from_output_dir, research_lab_runtime_root
from .handoff_checks import _bundle_modality_summary, _generic_adapter_candidate, _requires_real_repository_agent, _tool_slug, _write_open_source_workflow_adapter


def _external_repo_context_text(role_plan: dict | None, selected_bundle: dict | None) -> str:
    parts: list[str] = []
    if isinstance(role_plan, dict):
        for value in role_plan.get("assigned_hypotheses") or []:
            if isinstance(value, str):
                parts.append(value)
        for key in ("search_goal", "analysis_goal", "followup_description"):
            value = role_plan.get(key)
            if isinstance(value, str):
                parts.append(value)
        planner = role_plan.get("planner_metadata") if isinstance(role_plan.get("planner_metadata"), dict) else {}
        for key in ("reference_resources", "reference_resource_context"):
            value = planner.get(key)
            if isinstance(value, (list, dict)):
                parts.append(json.dumps(value, sort_keys=True, default=str)[:4000])
            elif isinstance(value, str):
                parts.append(value)
    if isinstance(selected_bundle, dict):
        for key in ("candidate_title", "title", "provider", "candidate_doi"):
            value = selected_bundle.get(key)
            if value:
                parts.append(str(value))
        for csv_item in (selected_bundle.get("csvs") or [])[:8]:
            if isinstance(csv_item, dict):
                parts.append(str(csv_item.get("name") or ""))
                columns = csv_item.get("columns")
                if isinstance(columns, list):
                    parts.append(" ".join(str(column) for column in columns[:80]))
    return clean_text(" ".join(parts))


def _make_runtime_path_collaborative(path: Path) -> None:
    try:
        os.chmod(path, 0o777 if path.is_dir() else 0o666)
    except OSError:
        pass


def _external_repo_analysis_terms(role_plan: dict | None, selected_bundle: dict | None) -> list[str]:
    text = _external_repo_context_text(role_plan, selected_bundle)
    phrases = _scientific_phrases(text)
    tokens = _query_tokens(text)
    method_terms = [
        "differential expression",
        "gene set enrichment",
        "pathway enrichment",
        "transcriptomics",
        "single cell",
        "batch correction",
        "normalization",
    ]
    return _dedupe_texts([*phrases[:12], *tokens[:16], *method_terms], limit=28)


def _external_repo_search_queries(
    *,
    role_plan: dict | None,
    selected_bundle: dict | None,
    modality: dict,
) -> list[str]:
    terms = _external_repo_analysis_terms(role_plan, selected_bundle)
    modality_text = clean_text(str(modality.get("modality") or "").replace("_", " "))
    method_queries: list[str] = []
    if modality.get("term_statistic_tables") or modality.get("effect_tables"):
        method_queries.extend([
            "gene set enrichment pathway analysis transcriptomics",
            "differential expression enrichment omics workflow",
        ])
    if modality.get("wide_measurement_tables"):
        method_queries.extend([
            "single cell transcriptomics analysis workflow",
            "gene expression normalization batch correction workflow",
        ])
    if not method_queries:
        method_queries.append(f"{modality_text} analysis workflow")
    query_parts: list[str] = []
    for method in method_queries:
        query_parts.append(f"{method} in:name,description,readme")
    for term in terms[:5]:
        if len(term.split()) <= 6:
            query_parts.append(f"{term} omics workflow in:name,description,readme")
    return _dedupe_texts(query_parts, limit=8)


def _github_search_repositories(query: str) -> list[dict]:
    if os.environ.get("RESEARCHLAB_ENABLE_EXTERNAL_REPO_DISCOVERY") == "0":
        return []
    q = f"{query} stars:>5 archived:false"
    params = urllib.parse.urlencode(
        {
            "q": q,
            "sort": "stars",
            "order": "desc",
            "per_page": str(EXTERNAL_REPO_SEARCH_PER_QUERY),
        }
    )
    try:
        payload = fetch_json(f"{GITHUB_REPOSITORY_SEARCH_URL}?{params}")
    except Exception:
        return []
    items = payload.get("items")
    return items if isinstance(items, list) else []


def _external_repo_candidate_score(item: dict, query: str, analysis_terms: list[str]) -> int:
    full_name = clean_text(item.get("full_name"))
    description = clean_text(item.get("description"))
    language = clean_text(item.get("language")).lower()
    topics = item.get("topics") if isinstance(item.get("topics"), list) else []
    text = " ".join([full_name, description, " ".join(str(topic) for topic in topics)]).lower()
    stars = int(item.get("stargazers_count") or 0)
    score = 45 + min(28, int(math.log10(stars + 1) * 9))
    for term in analysis_terms[:18]:
        if term and term.lower() in text:
            score += 5
    domain_hit_count = 0
    for token in ["omics", "transcript", "rna", "gene", "expression", "enrichment", "pathway", "single-cell", "single cell", "differential"]:
        if token in text:
            domain_hit_count += 1
            score += 4
    if domain_hit_count == 0:
        score -= 60
    if language in {"python", "r", "nextflow", "snakemake", "jupyter notebook"}:
        score += 8
    if "workflow" in query.lower() and any(token in text for token in ["workflow", "pipeline", "analysis"]):
        score += 5
    if any(
        noise in text
        for noise in [
            "awesome",
            "course",
            "tutorial",
            "paper-list",
            "papers",
            "book",
            " notes",
            "_notes",
            "-notes",
            "list of",
            "resources",
            "collection of",
            "agent skills",
            "finance and writing",
            "ready to use agent",
        ]
    ):
        score -= 35
    return max(0, min(99, score))


def _candidate_domain_from_terms(analysis_terms: list[str]) -> str:
    """Derive a coarse repository-candidate domain from the cycle's analysis
    terms instead of hardcoding omics, so a graphics/CS objective is not labelled
    (and thereby biased) as expression data. Mirrors the gating in
    src/agents/shared/domain.js / policy.rs objective_domain."""
    text = " ".join(str(t).lower() for t in (analysis_terms or []))
    bio = ("omics", "transcriptom", "rna-seq", "rnaseq", "single-cell", "scrna",
           "gene expression", "differential expression", "proteom", "metabolom",
           "genomic", "methylation", "microarray")
    cs = ("render", "ray tracing", "raytrac", "rasteriz", "shader", "graphics",
          "mitsuba", "pbrt", "global illumination", "gpu kernel")
    if any(k in text for k in bio):
        return "omics_or_high_dimensional_expression"
    if any(k in text for k in cs):
        return "computer_graphics_or_rendering"
    return "general_analysis"


def _external_repo_candidate_from_item(item: dict, query: str, analysis_terms: list[str]) -> dict:
    license_info = item.get("license") if isinstance(item.get("license"), dict) else {}
    return {
        "name": clean_text(item.get("full_name")),
        "url": item.get("html_url"),
        "clone_url": item.get("clone_url"),
        "license": license_info.get("spdx_id") or license_info.get("name") or "unknown",
        "domain": _candidate_domain_from_terms(analysis_terms),
        "language": item.get("language"),
        "stars": item.get("stargazers_count"),
        "description": clean_text(item.get("description")),
        "source_kind": "external_repository",
        "fit_score": _external_repo_candidate_score(item, query, analysis_terms),
        "reuse_decision": "candidate",
        "search_query": query,
        "download_verified": False,
        "local_path": None,
        "repository_local_path": None,
        "setup_commands": [],
        "smoke_test_command": None,
        "application_command": None,
        "expected_outputs": [
            "external_repository_agent_summary.json",
            "external_repository_dataset_application.csv",
            "external_repository_workflow_result.json",
        ],
        "debug_attempts": [],
        "evidence": "Discovered by runtime GitHub repository search from dataset modality, assay/column hints, hypothesis terms, and analysis goal.",
    }


def _detect_supported_repository_workflows(repo_dir: Path) -> list[dict]:
    workflows: list[dict] = []
    clawbio_skill = repo_dir / "skills" / "diff-visualizer" / "diff_visualizer.py"
    if clawbio_skill.is_file() or (repo_dir / "clawbio.py").is_file():
        workflows.append({
            "workflow_name": "ClawBio diff-visualizer",
            "workflow_kind": "repository_native_skill",
            "entrypoint": str(clawbio_skill if clawbio_skill.is_file() else repo_dir / "clawbio.py"),
            "input_contract": "differential-expression table with gene/log2FC/p-value/FDR columns",
        })
    bioskills_visual = repo_dir / "differential-expression" / "de-visualization" / "SKILL.md"
    bioskills_results = repo_dir / "differential-expression" / "de-results" / "SKILL.md"
    if bioskills_visual.is_file() or bioskills_results.is_file():
        workflows.append({
            "workflow_name": "BioSkills differential-expression skill-guided workflow",
            "workflow_kind": "repository_native_skill_docs",
            "skill_paths": [
                str(path.relative_to(repo_dir))
                for path in [bioskills_visual, bioskills_results]
                if path.is_file()
            ],
            "input_contract": "differential-expression result table normalized to gene/log2FoldChange/pvalue/padj",
        })
    render_scene_exts = (".pbrt", ".xml", ".obj", ".gltf", ".glb", ".blend", ".usd", ".usda")
    render_scenes = [p for p in repo_dir.rglob("*") if p.is_file() and p.suffix.lower() in render_scene_exts][:5]
    render_entry = None
    for candidate_py in repo_dir.rglob("*.py"):
        try:
            head = candidate_py.read_text(encoding="utf-8", errors="replace")[:4000]
        except Exception:
            continue
        if "import mitsuba" in head or "import drjit" in head or "def render" in head:
            render_entry = candidate_py
            break
    if render_scenes or render_entry:
        workflows.append({
            "workflow_name": "Rendering / graphics workflow",
            "workflow_kind": "repository_render_workflow",
            "entrypoint": str(render_entry) if render_entry else None,
            "scene_paths": [str(p.relative_to(repo_dir)) for p in render_scenes],
            "input_contract": "scene/asset description (.pbrt/.xml/.obj/.gltf) or an in-code scene; runs a renderer and emits image(s) + timing/quality metrics",
        })
    generic_entry = None
    for cand_name in ("main.py", "__main__.py", "cli.py", "run.py"):
        hit = next((p for p in repo_dir.rglob(cand_name) if p.is_file()), None)
        if hit:
            generic_entry = hit
            break
    if generic_entry is not None and not workflows:
        workflows.append({
            "workflow_name": "Generic repository CLI workflow",
            "workflow_kind": "repository_generic_cli",
            "entrypoint": str(generic_entry),
            "input_contract": "the dataset/asset paths from the analyst handoff, passed to the repository's documented entrypoint; emits result.json plus task-relevant artifacts",
        })
    return workflows


def _search_external_repository_candidates(
    *,
    role_plan: dict | None,
    selected_bundle: dict | None,
    modality: dict,
    query_log: list[str],
) -> list[dict]:
    analysis_terms = _external_repo_analysis_terms(role_plan, selected_bundle)
    candidates_by_url: dict[str, dict] = {}
    for query in _external_repo_search_queries(role_plan=role_plan, selected_bundle=selected_bundle, modality=modality):
        query_log.append(f"github_repository_search query={query!r}")
        items = _github_search_repositories(query)
        query_log.append(f"github_repository_search_results query={query!r} count={len(items)}")
        for item in items:
            candidate = _external_repo_candidate_from_item(item, query, analysis_terms)
            if not candidate.get("url") or not candidate.get("clone_url"):
                continue
            if int(candidate.get("fit_score") or 0) < 70:
                continue
            existing = candidates_by_url.get(candidate["url"])
            if existing is None or int(candidate.get("fit_score") or 0) > int(existing.get("fit_score") or 0):
                candidates_by_url[candidate["url"]] = candidate
    candidates = sorted(
        candidates_by_url.values(),
        key=lambda item: (int(item.get("fit_score") or 0), int(item.get("stars") or 0)),
        reverse=True,
    )
    return candidates[:8]


def _materialize_external_repository_agent(
    candidate: dict,
    *,
    output_dir: Path,
    role_plan: dict | None,
    selected_bundle: dict | None,
    query_log: list[str],
) -> dict | None:
    cycle_id = cycle_id_from_output_dir(output_dir) or "cycle"
    runtime_root = research_lab_runtime_root(output_dir)
    tool_root = runtime_root / "tools" / cycle_id
    slug = _tool_slug(str(candidate.get("name") or candidate.get("url") or "external-repo"))
    tool_dir = tool_root / f"external-repo-{slug}"
    repo_dir = tool_dir / "repo"
    tool_dir.mkdir(parents=True, exist_ok=True)
    clone_url = clean_text(candidate.get("clone_url"))
    debug_attempts = list(candidate.get("debug_attempts") or [])
    clone_command = ["git", "clone", "--depth", "1", "--filter=blob:none", clone_url, str(repo_dir)]
    if repo_dir.exists() and any(repo_dir.iterdir()):
        clone_status = "reused_existing_clone"
        clone_returncode = 0
        clone_stderr = ""
    else:
        if repo_dir.exists():
            shutil.rmtree(repo_dir)
        started = time.monotonic()
        try:
            completed = subprocess.run(
                clone_command,
                capture_output=True,
                text=True,
                timeout=EXTERNAL_REPO_CLONE_TIMEOUT_SECONDS,
            )
            clone_returncode = completed.returncode
            clone_stderr = (completed.stderr or "").strip()
            clone_status = "completed" if completed.returncode == 0 else "failed"
            (tool_dir / "clone-stdout.log").write_text(completed.stdout or "", encoding="utf-8")
            (tool_dir / "clone-stderr.log").write_text(completed.stderr or "", encoding="utf-8")
            query_log.append(
                f"clone_attempt repo={candidate.get('name')} status={clone_status} seconds={time.monotonic() - started:.1f}"
            )
        except subprocess.TimeoutExpired as exc:
            clone_returncode = None
            clone_stderr = f"clone timed out after {EXTERNAL_REPO_CLONE_TIMEOUT_SECONDS}s"
            clone_status = "timeout"
            (tool_dir / "clone-stdout.log").write_text(str(exc.stdout or ""), encoding="utf-8")
            (tool_dir / "clone-stderr.log").write_text(clone_stderr, encoding="utf-8")
        except Exception as exc:  # pylint: disable=broad-except
            clone_returncode = None
            clone_stderr = str(exc)[:500]
            clone_status = "errored"
            (tool_dir / "clone-stderr.log").write_text(clone_stderr, encoding="utf-8")
    debug_attempts.append(
        {
            "command": " ".join(clone_command),
            "status": clone_status,
            "return_code": clone_returncode,
            "stderr_excerpt": clone_stderr[-500:],
            "fix_or_blocker": "repository cloned/downloaded into cycle tool cache" if clone_status in {"completed", "reused_existing_clone"} else "clone/download failed; try the next runtime-discovered candidate",
        }
    )
    if clone_status not in {"completed", "reused_existing_clone"}:
        failed = dict(candidate)
        failed.update({
            "reuse_decision": "reject",
            "download_command": " ".join(clone_command),
            "download_verified": False,
            "local_path": str(tool_dir),
            "repository_local_path": str(repo_dir),
            "debug_attempts": debug_attempts,
            "reason": "Rejected because clone/download did not complete.",
        })
        return failed

    supported_workflows = _detect_supported_repository_workflows(repo_dir)
    debug_attempts.append(
        {
            "command": "repository workflow preflight",
            "status": "completed" if supported_workflows else "blocked",
            "return_code": 0 if supported_workflows else None,
            "stderr_excerpt": "",
            "fix_or_blocker": (
                "repository exposes a workflow/skill adapter that the lab-runner wrapper can apply to the selected dataset"
                if supported_workflows
                else "repository cloned, but no executable or skill-guided workflow adapter is supported by the lab-runner wrapper; try another candidate"
            ),
            "supported_repository_workflows": supported_workflows,
        }
    )
    if not supported_workflows:
        failed = dict(candidate)
        failed.update({
            "reuse_decision": "reject",
            "download_command": " ".join(clone_command),
            "download_verified": True,
            "local_path": str(tool_dir),
            "repository_local_path": str(repo_dir),
            "debug_attempts": debug_attempts,
            "workflow_preflight": {
                "supported": False,
                "supported_repository_workflows": [],
                "require_substantive_output_bundle": True,
            },
            "reason": "Rejected because clone succeeded but no repository-native workflow/skill adapter is currently executable by the lab-runner wrapper.",
        })
        return failed

    wrapper_path = tool_dir / "researchlab_external_repo_agent.py"
    wrapper_path.write_text(_external_repo_agent_wrapper_code().lstrip(), encoding="utf-8")
    _make_runtime_path_collaborative(tool_dir)
    _make_runtime_path_collaborative(wrapper_path)
    analysis_terms = _external_repo_analysis_terms(role_plan, selected_bundle)
    selected = dict(candidate)
    selected.update({
        "reuse_decision": "reuse",
        "download_command": " ".join(clone_command),
        "download_verified": True,
        "local_path": str(tool_dir),
        "repository_local_path": str(repo_dir),
        "repo_path": str(repo_dir),
        "setup_commands": [],
        "supported_repository_workflows": supported_workflows,
        "workflow_preflight": {
            "supported": True,
            "supported_repository_workflows": supported_workflows,
            "require_substantive_output_bundle": True,
        },
        "smoke_test_command": "\"${RESEARCHLAB_PYTHON:-python3}\" researchlab_external_repo_agent.py --smoke",
        "application_command": "\"${RESEARCHLAB_PYTHON:-python3}\" researchlab_external_repo_agent.py --csv-root \"$RESEARCHLAB_CSV_ROOT\" --output-dir \"$RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR\"",
        "analysis_terms": analysis_terms,
        "debug_attempts": [
            *debug_attempts,
            {
                "command": "\"${RESEARCHLAB_PYTHON:-python3}\" researchlab_external_repo_agent.py --smoke",
                "status": "delegated_to_lab_runner",
                "stderr_excerpt": "",
                "fix_or_blocker": "lab-runner records repository inventory, compile smoke, stdout/stderr, and return code before dataset application",
            },
            {
                "command": "\"${RESEARCHLAB_PYTHON:-python3}\" researchlab_external_repo_agent.py --csv-root \"$RESEARCHLAB_CSV_ROOT\" --output-dir \"$RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR\"",
                "status": "delegated_to_lab_runner",
                "stderr_excerpt": "",
                "fix_or_blocker": "lab-runner applies the cloned repository wrapper to the selected dataset/asset; the mandatory substantive validation passes only if a repository-native workflow/skill/domain command produces external_repository_workflow_result.json with substantive_repository_workflow_applied=true",
            },
        ],
        "reason": "Selected because it is a real runtime-discovered external repository matching the objective's analysis terms and was cloned into the cycle tool cache.",
    })
    selected_template_path = tool_dir / "selected-agent-template.json"
    selected_template_path.write_text(json.dumps(selected, ensure_ascii=False, indent=2), encoding="utf-8")
    _make_runtime_path_collaborative(selected_template_path)
    return selected


def _attach_open_source_agent_discovery(
    handoff: dict,
    *,
    role_plan: dict | None,
    output_dir: Path | None,
    selected_bundle: dict | None,
) -> None:
    if handoff.get("open_source_agent_discovery") and "selected_open_source_analysis_agent" in handoff:
        return
    modality = _bundle_modality_summary(selected_bundle)
    mandate = ((role_plan or {}).get("planner_metadata") or {}).get("open_source_analysis_agent_mandate") or {}
    mandatory = bool(((role_plan or {}).get("planner_metadata") or {}).get("require_open_source_analysis_agent_discovery") or (mandate or {}).get("mandatory"))
    repository_agent_required = _requires_real_repository_agent(
        role_plan=role_plan,
        modality=modality,
        mandatory=mandatory,
    )
    tool_dir = (
        _write_open_source_workflow_adapter(output_dir)
        if handoff.get("status") == "ready_for_runner" and not repository_agent_required
        else None
    )
    query_log = [
        "inspected role_plan.reference_resource_context and planner_metadata.reference_resources for same-dataset code/resource hints",
        f"inspected selected bundle schema: {json.dumps(modality, sort_keys=True)}",
    ]
    if repository_agent_required:
        query_log.append(
            "generic pandas/numpy/sklearn adapter rejected as selected agent because mandatory omics/high-dimensional analysis requires a real external repository/workflow/domain package"
        )
    else:
        query_log.append(
            "selected a local adapter over an unverified remote repository so lab-runner can smoke-test and apply the workflow deterministically"
        )
    selected = None
    candidates: list[dict] = []
    if repository_agent_required:
        candidates.append(_generic_adapter_candidate(None, modality, "reject"))
        if output_dir is not None and handoff.get("status") == "ready_for_runner":
            discovered = _search_external_repository_candidates(
                role_plan=role_plan,
                selected_bundle=selected_bundle,
                modality=modality,
                query_log=query_log,
            )
            for candidate in discovered:
                materialized = _materialize_external_repository_agent(
                    candidate,
                    output_dir=output_dir,
                    role_plan=role_plan,
                    selected_bundle=selected_bundle,
                    query_log=query_log,
                )
                if materialized:
                    candidates.append(materialized)
                    if materialized.get("reuse_decision") in {"reuse", "adapt"} and materialized.get("download_verified"):
                        selected = materialized
                        break
        if selected is None:
            handoff.setdefault("evidence_gaps", []).append(
                "Mandatory omics/high-dimensional open-source repository-agent discovery is unresolved: the deterministic generic adapter was rejected as insufficient, and no runtime-discovered external repository was successfully cloned/downloaded for lab-runner application."
            )
        handoff["open_source_agent_requirement"] = {
            "repository_agent_required": True,
            "generic_adapter_satisfies_requirement": False,
            "reason": "omics/high-dimensional analysis requires a real external repository/workflow/domain package, not only a local pandas/numpy/sklearn adapter",
        }
    elif tool_dir is not None:
        selected = _generic_adapter_candidate(tool_dir, modality, "adapt")
        candidates.append(selected)
    discovery = {
        "mandatory": mandatory,
        "repository_agent_required": repository_agent_required,
        "generic_adapter_satisfies_requirement": not repository_agent_required,
        "query_log": query_log,
        "candidates": candidates,
        "selected_agent": selected,
        "rejection_summary": (
            None
            if selected
            else (
                "Mandatory omics/high-dimensional analysis requires a real external repository/workflow/domain package; the generic local package adapter was rejected as insufficient."
                if repository_agent_required
                else "No executable dataset bundle was selected, so tool execution is blocked until dataset_root is resolved."
            )
        ),
    }
    handoff["open_source_agent_discovery"] = discovery
    handoff["selected_open_source_analysis_agent"] = selected
    if selected:
        for blueprint in handoff.get("validation_code_blueprints") or []:
            if not isinstance(blueprint, dict):
                continue
            deps = blueprint.setdefault("dependencies", [])
            if isinstance(deps, list):
                for dep in ["pandas", "numpy"]:
                    if dep not in deps:
                        deps.append(dep)
            notes = blueprint.setdefault("execution_notes", [])
            if isinstance(notes, list):
                notes.append("Lab-runner must execute selected_open_source_analysis_agent smoke/application commands before this blueprint and review external_agent_runs.")
    if selected and repository_agent_required:
        handoff["self_review"] = {
            "review_status": "approved_for_handoff",
            "summary": "Runtime discovery selected a real external repository/workflow/domain package, cloned it into the cycle tool cache, and supplied lab-runner smoke/application commands before blueprint execution.",
            "assumption_checks": [
                "Selected workflow is a downloaded/cloned external repository or domain package ecosystem, not the generic pandas/numpy/sklearn adapter.",
                "Lab-runner must execute the selected repository smoke/application commands and inspect external_agent_runs before any claim can pass.",
                "Blueprints remain responsible for the scientific claim tests after the external repository application has produced dataset-level artifacts.",
            ],
            "failure_modes": [
                "Repository smoke test or dataset application fails in the runner environment.",
                "The selected repository is bioinformatics-relevant but not specific enough for the final claim, requiring a follow-up analyst to choose a better candidate from discovery logs.",
                "A same-dataset repository may exist but was not surfaced by runtime search or reference resources.",
            ],
            "requested_revisions": [],
        }
    else:
        handoff.setdefault("self_review", {
            "review_status": "approved_for_handoff" if selected else "needs_revision",
            "summary": "Deterministic analyst handoff includes runnable open-source workflow metadata before blueprint execution." if selected else "Open-source workflow execution is blocked because no qualifying external repository/workflow has been selected.",
            "assumption_checks": [
                "Selected workflow is a package-workflow adapter, not a claim-specific remote repository.",
                "Blueprints remain responsible for the scientific claim tests; the external workflow audits table shape before those tests.",
            ],
            "failure_modes": [
                "Package imports fail in runner environment.",
                "The profiled table is not the table used by the claim-specific blueprint.",
                "A more specialized same-dataset repository may exist but was not surfaced in the role-plan references.",
            ],
            "requested_revisions": [] if selected else ["Search for a real external repository/workflow/domain package, download or install it into the cycle tool cache, smoke-test/debug it, and apply it to the selected dataset before treating the handoff as gate-ready."],
        })


