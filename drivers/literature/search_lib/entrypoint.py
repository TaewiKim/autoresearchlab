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

from .http_client import clean_text
from .queries import _query_tokens, _scientific_phrases, anchor_queries_to_capability, capability_anchor_terms, distinct_phrases, infer_frontier_catalog, load_queries, queries_from_objective_text, queries_from_role_plan, role_plan_primary_families, sanitize_queries
from .collect import collect_papers, collect_query_papers, default_literature_sources, merge_paper_lists, merge_source_stats, select_literature_sources, synthesize_from_local_papers
from .synthesis import build_analysis_lane_proposals, build_statistical_review_memo, generate_hypothesis_scenarios
from .director_context import _compact_role_plan_for_result
from .handoff_builder import build_analyst_handoff
from .screening import objective_from_plan, paper_identity, screen_papers, merge_candidate_records
from .providers import research_lab_runtime_root


_CYCLE_ID_IN_TASK = re.compile(r"^\s*[-*]?\s*cycle_id\s*:\s*([A-Za-z0-9_.-]+)\s*$", re.MULTILINE)


def _cycle_id_from_task_file(task_file: Path | None) -> str:
    """The cycle a lane belongs to, taken from its task file.

    v85's scout role plans carry neither `cycle_id` nor any absolute path, so
    this is the only handle on the cycle those lanes have.
    """
    if not task_file or not task_file.exists():
        return ""
    try:
        match = _CYCLE_ID_IN_TASK.search(task_file.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return ""
    return match.group(1) if match else ""


def _role_plan_is_open_search(role_plan: dict | None) -> bool:
    """True when this lane was dispatched to search the space, not the lead.

    Set by the gate-restart dispatcher; both keys are written together, so either
    one is enough and neither is required to be present.
    """
    planner = (role_plan or {}).get("planner_metadata")
    if not isinstance(planner, dict):
        return False
    scope = str(planner.get("selection_scope") or "").strip().lower()
    novelty_mode = str(planner.get("novelty_mode") or "").strip().lower()
    return "open-search" in scope or "regeneration" in novelty_mode


def cycle_state_dir(start: Path, cycle_id: str) -> Path | None:
    """The directory holding this cycle's state files, found by looking.

    The driver's output directory is
    `.research-lab/artifacts/stats/<cycle>/<lane>`, and the state files are in
    `.research-lab/state` -- not one level up, which is what the two guesses
    here assumed. So `_instrument_space_queries` never found an inventory and
    the lead fallback never found a lead: both read paths that do not exist,
    quietly, and returned as though the cycle had nothing to say.

    Walking up and looking for the file is the only version of this that cannot
    drift when the layout moves again.
    """
    probe = f"{cycle_id}-instrument-inventory.json"
    lead = f"{cycle_id}-lab-director-hypothesis.json"
    current = start.resolve()
    for candidate in [current, *current.parents][:8]:
        for directory in (candidate, candidate / "state", candidate / ".research-lab" / "state"):
            try:
                if (directory / probe).is_file() or (directory / lead).is_file():
                    return directory
            except OSError:
                continue
    return None


def capability_inventory(output_dir: Path, cycle_id: str) -> dict | None:
    if not cycle_id:
        return None
    state_dir = cycle_state_dir(output_dir, cycle_id)
    if state_dir is None:
        return None
    path = state_dir / f"{cycle_id}-instrument-inventory.json"
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _instrument_space_queries(state_dir: Path, cycle_id: str) -> list[str]:
    """Queries drawn from what this container was MEASURED to be able to do.

    Not the lead, and not a guess: the instrument probe writes verified
    instruments, measurable quantities and the renderer build at cycle start. For
    an explore scout that is the right anchor -- it describes the space the cycle
    can work in without naming a hypothesis inside it.
    """
    path = state_dir / f"{cycle_id}-instrument-inventory.json"
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return []
    quantities = [
        clean_text(str(item))
        for item in (payload.get("measurable_quantities") or [])
        if clean_text(str(item))
    ]
    renderer = payload.get("renderer") if isinstance(payload.get("renderer"), dict) else {}
    package = clean_text(str(renderer.get("package") or ""))
    candidates: list[str] = []
    for quantity in quantities[:4]:
        # The parenthetical is a unit gloss, not a search term.
        head = quantity.split("(")[0].strip()
        if head:
            candidates.append(f"{package} {head}".strip() if package else head)
    verified = [
        clean_text(str(item)).replace("_", " ")
        for item in (payload.get("verified_instruments") or [])
        if clean_text(str(item))
    ]
    if verified:
        candidates.append(" ".join(verified[:3]))
    return sanitize_queries(candidates)


def _last_resort_queries(
    output_dir: Path,
    task_file: Path | None,
    role_plan: dict | None,
) -> tuple[list[str], str]:
    """Queries built from the cycle's own state, when the role plan carries none.

    Returns ``(queries, source)``; source is empty when nothing was found, so a
    caller can say which fallback fired rather than pretending the plan supplied
    them.

    Deliberately ordered: the director's current lead first, because that is what
    a scout tasked to "overturn the current lead" is actually looking for; the
    cycle objective only after that, because on its own it is a topic, not a
    question.
    """
    cycle_id = _cycle_id_from_task_file(task_file)
    # An explore-mode scout is dispatched to look PAST the current lead, so
    # anchoring it on that lead would defeat the mode. Anchor it on what the
    # container was measured to be able to do instead.
    resolved_state_dir = cycle_state_dir(output_dir, cycle_id) if cycle_id else None
    if cycle_id and _role_plan_is_open_search(role_plan):
        for state_dir in (resolved_state_dir, output_dir.parent, output_dir):
            if state_dir is None:
                continue
            space = _instrument_space_queries(state_dir, cycle_id)
            if space:
                return space, f"instrument-space:{cycle_id}"
    if cycle_id:
        # cycle_state_dir finds it; the two guesses stay behind it because a
        # caller may hand an output directory that already IS the state root.
        for state_dir in (resolved_state_dir, output_dir.parent, output_dir):
            if state_dir is None:
                continue
            hypothesis_path = state_dir / f"{cycle_id}-lab-director-hypothesis.json"
            if not hypothesis_path.is_file():
                continue
            try:
                payload = json.loads(hypothesis_path.read_text(encoding="utf-8", errors="replace"))
            except (OSError, ValueError):
                continue
            parts = [
                clean_text(str(payload.get(key) or ""))
                for key in ("statement", "primary_family", "why_selected")
            ]
            text = ". ".join(part for part in parts if part)
            if not text:
                continue
            # Same rule as derive_queries_from_role_plan: one query per
            # phrase. This is the second builder that joined overlapping
            # windows into one string, and a fix to only the other one would
            # have left the instrument-space path still asking for salad.
            derived = []
            phrases = _scientific_phrases(text)
            tokens = _query_tokens(text)
            derived.extend(distinct_phrases(phrases))
            if tokens:
                derived.append(" ".join(tokens[:5]))
            sanitized = sanitize_queries(derived)
            if sanitized:
                return sanitized, f"lab-director-hypothesis:{cycle_id}"
    # The objective as ONE sanitized blob was the token-soup path: its
    # instrument, robot and role-deliverable sections were mined alongside the
    # research problem (cycle-b-20260918 searched "python claims PC
    # simulators"). Only its subject-bearing text is read, one query per phrase.
    objective = str((role_plan or {}).get("objective") or "")
    if clean_text(objective):
        derived = queries_from_objective_text(objective)
        if derived:
            return derived, "cycle-objective"
    return [], ""


def run_driver(
    output_dir: Path,
    role: str,
    queries_file: Path | None,
    task_file: Path | None,
    role_plan_file: Path | None,
    reviews_file: Path | None = None,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    role_plan_queries = queries_from_role_plan(role_plan_file)
    if role_plan_queries:
        queries = role_plan_queries
    else:
        try:
            queries = load_queries(queries_file, task_file) if queries_file or task_file else []
        except SystemExit:
            queries = []
    role_plan = None
    if role_plan_file and role_plan_file.exists():
        role_plan = json.loads(role_plan_file.read_text(encoding="utf-8"))
    if reviews_file:
        role_plan = dict(role_plan or {})
        role_plan["literature_reviews"] = json.loads(reviews_file.read_text(encoding="utf-8"))
    query_source = "role-plan" if role_plan_queries else "task-file"
    if not queries:
        # Everything the plan offered was workflow prose, which the sanitizer is
        # right to reject. The cycle still knows what it is working on: read the
        # director's current lead off disk rather than killing a lane that was
        # explicitly told to go and search. v85 redispatched one such scout 26
        # times before this existed.
        queries, query_source = _last_resort_queries(output_dir, task_file, role_plan)
        if queries:
            print(
                f"[literature-driver] role plan carried no usable queries; "
                f"derived {len(queries)} from {query_source}",
                file=sys.stderr,
            )
    if not queries:
        # Said plainly, because the alternative this replaced was worse than no
        # search: token soup mined from the host/instrument and role sections.
        raise SystemExit(
            "queries are required; provide --queries-file, role-plan queries, or a non-empty --task-file. "
            "The objective yielded no domain-bearing query: instrument/host, robot, role-deliverable and "
            "constraint sections and instruction words are never mined into a search. Author queries, or "
            "look up known papers with --title / --arxiv-id / --doi."
        )

    # Every query source has converged here -- the role plan's own list, the
    # task file, and the last-resort readers -- so this is the one place an
    # anchor covers all three.
    #
    # MEASURED ON cycle-g-v91, 2026-09-13: unanchored, a computer-graphics
    # cycle retrieved Collatz stopping times, electronic-cigarette cessation,
    # and mathematics-students' confidence calibration; 73 retrieved, 71
    # quarantined, 0 admitted, and the screening was right every time.
    inventory = capability_inventory(output_dir, _cycle_id_from_task_file(task_file))
    anchor_terms = capability_anchor_terms(inventory)
    if anchor_terms:
        queries = anchor_queries_to_capability(queries, inventory)
        print(
            f"[literature-driver] anchored {len(queries)} queries on measured capability: "
            f"{' '.join(anchor_terms)}",
            file=sys.stderr,
        )
    else:
        print(
            "[literature-driver] no capability inventory reached this lane; queries are unanchored",
            file=sys.stderr,
        )

    papers, source_stats = collect_papers(queries, role_plan)
    if role == "analyst":
        local_papers, local_source_stats = synthesize_from_local_papers(queries, output_dir, role_plan)
        candidates = [item["paper"] for stats in (source_stats, local_source_stats)
                      for item in (stats.get("screening") or {}).get("candidates", [])]
        source_stats = merge_source_stats(source_stats, local_source_stats)
        objective = objective_from_plan(role_plan, queries)
        papers, screening = screen_papers(candidates, objective, default_literature_sources(objective),
                                         (role_plan or {}).get("literature_reviews"))
        source_stats["screening"] = screening
        if papers:
            source_stats["frontier_catalog"] = infer_frontier_catalog(papers, role_plan)
            source_stats["hypothesis_scenarios"] = generate_hypothesis_scenarios(papers, role_plan)[:6]
            source_stats["statistical_review_memo"] = build_statistical_review_memo(papers, role_plan)
            source_stats["analysis_lane_proposals"] = build_analysis_lane_proposals(role_plan)

    screening = source_stats.pop("screening")
    screening_paths = write_screening_artifacts(output_dir, screening)
    source_stats["literature_screening"] = {"manifest": screening["manifest"], "counts": screening["counts"], **screening_paths}

    papers_path = output_dir / "papers.json"
    summary_path = output_dir / "summary.md"
    result_path = output_dir / "result.json"

    papers_path.write_text(json.dumps(papers, ensure_ascii=False, indent=2), encoding="utf-8")
    if not papers:
        invalidate_previous_handoff(output_dir)
    summary_lines = [
        "# Literature Search Summary",
        "",
        f"- Role: {role}",
        f"- Queries: {len(queries)}",
        f"- Papers collected: {len(papers)}",
        f"- Sources attempted: {', '.join(source_stats['sources_attempted']) or 'n/a'}",
        f"- Source hits: {json.dumps(source_stats['source_hits'], ensure_ascii=False)}",
        f"- Source failures: {len(source_stats['source_failures'])}",
        f"- Discovered queries: {len(source_stats.get('discovered_queries', []))}",
        f"- Hypothesis scenarios: {len(source_stats.get('hypothesis_scenarios', []))}",
        f"- Candidate primary families: {len(source_stats.get('frontier_catalog', {}).get('primary_variable_families', []))}",
        *(
            [
                f"- Role plan source: {role_plan.get('source')}",
                f"- Role plan goal: {role_plan.get('search_goal') or role_plan.get('analysis_goal') or 'n/a'}",
                f"- Analyst identity: {role_plan.get('analyst_identity') or 'n/a'}",
            ]
            if isinstance(role_plan, dict)
            else []
        ),
        "",
        "## Queries",
        *[f"- {query}" for query in queries],
        "",
        "## Discovered Queries",
        *[f"- {query}" for query in source_stats.get("discovered_queries", [])[:16]],
        "",
        "## Hypothesis Scenarios",
        *[
            f"- {item['label']}: {item['hypothesis']} | validate: {item['validation_scenario']}"
            for item in source_stats.get("hypothesis_scenarios", [])[:8]
        ],
        "",
        "## Candidate Primary Families",
        *[
            f"- {item['family']}: support={item.get('support_count', 0)} | mechanisms={', '.join(item.get('mechanisms', [])[:3])}"
            for item in source_stats.get("frontier_catalog", {}).get("primary_variable_families", [])[:8]
        ],
        *(
            [
                "",
                "## Statistical Review Memo",
                f"- Estimands: {', '.join(source_stats.get('statistical_review_memo', {}).get('estimands', []))}",
                f"- Priority confounders: {', '.join(source_stats.get('statistical_review_memo', {}).get('priority_confounders', []))}",
                f"- Falsification tests: {', '.join(source_stats.get('statistical_review_memo', {}).get('falsification_tests', []))}",
                f"- Selection bias risks: {', '.join(source_stats.get('statistical_review_memo', {}).get('selection_bias_risks', []))}",
                f"- Measurement risks: {', '.join(source_stats.get('statistical_review_memo', {}).get('measurement_risks', []))}",
                f"- Data KG incumbent: {source_stats.get('statistical_review_memo', {}).get('data_kg_priorities', {}).get('incumbent_family') or 'n/a'}",
                f"- Analysis lane proposals: {len(source_stats.get('analysis_lane_proposals', []))}",
            ]
            if role == "analyst"
            else []
        ),
        "",
        "## Top Papers",
        *[f"- {paper['year']}: {paper['title']}" for paper in papers[:10]],
    ]
    summary_path.write_text("\n".join(summary_lines), encoding="utf-8")

    result = {
        "status": "completed" if papers else "pending_review" if screening["review_queue"] else "no_admitted_evidence",
        "driver": "literature-search-driver",
        "role": role,
        "queries": queries,
        "paper_count": len(papers),
        "papers_path": str(papers_path),
        "summary_path": str(summary_path),
        "role_plan_path": str(role_plan_file) if role_plan_file else None,
        "role_plan": _compact_role_plan_for_result(role_plan),
        "source_stats": source_stats,
        "discovered_queries": source_stats.get("discovered_queries", []),
        "hypothesis_scenarios": source_stats.get("hypothesis_scenarios", []),
        "statistical_review_memo": source_stats.get("statistical_review_memo", {}),
        "analysis_lane_proposals": source_stats.get("analysis_lane_proposals", []),
        "recommended_followup_actions": source_stats.get("analysis_lane_proposals", []),
        "frontier_catalog": source_stats.get("frontier_catalog", {}),
        "candidate_primary_families": role_plan_primary_families(role_plan),
        "papers": papers,
        "evidence_ready": bool(papers),
        "literature_screening": source_stats["literature_screening"],
    }
    apply_search_agent_assessment(result, output_dir, role_plan)
    if role == "analyst" and papers and result.get("search_decision_ready", True):
        analyst_handoff = build_analyst_handoff(source_stats, role_plan, output_dir=output_dir)
        handoff_path = output_dir / "handoff-validation-plan.json"
        handoff_path.write_text(json.dumps(analyst_handoff, ensure_ascii=False, indent=2), encoding="utf-8")
        design_memo = analyst_handoff.get("analysis_design_memo") if isinstance(analyst_handoff, dict) else None
        if isinstance(design_memo, dict):
            design_memo_path = output_dir / "analysis-design-memo.json"
            design_memo_path.write_text(json.dumps(design_memo, ensure_ascii=False, indent=2), encoding="utf-8")
            result["analysis_design_memo"] = design_memo
            result["analysis_design_memo_path"] = str(design_memo_path)
        result["analyst_handoff"] = analyst_handoff
        result["analyst_handoff_path"] = str(handoff_path)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def apply_search_agent_assessment(result: dict, output_dir: Path, role_plan: dict | None = None) -> dict:
    """Bind the adaptive search journal to admitted evidence using the JS gate.

    Abstract admission and search completion are different decisions. Keep valid
    papers available for the next inquiry while withholding a completed search
    or executable handoff when its reasoning journal is missing or incomplete.
    """
    plan = role_plan or result.get("role_plan") or {}
    contract = plan.get("search_agent_contract") or result.get("search_agent_contract")
    if not contract:
        return result
    result["search_agent_contract"] = contract
    journal_path = output_dir / "search-agent-journal.json"
    journal = None
    try:
        if journal_path.is_file():
            journal = json.loads(journal_path.read_text(encoding="utf-8"))
        elif isinstance(result.get("search_agent_journal"), dict):
            journal = result["search_agent_journal"]
    except (OSError, ValueError):
        pass
    if isinstance(journal, dict) and not isinstance(journal.get("synthesis"), dict):
        synthesis_path = output_dir / "search-agent-synthesis.json"
        try:
            if synthesis_path.is_file():
                journal["synthesis"] = json.loads(synthesis_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    result["search_agent_journal"] = journal
    result["search_agent_journal_path"] = str(journal_path)
    assessment = {"valid": False, "status": "pending", "decision_ready": False,
                  "gaps": ["search_agent_journal_missing_or_invalid"]}
    if journal:
        node = shutil.which("node")
        validator = Path(__file__).resolve().parents[3] / "src/agents/scout/search_agent.js"
        try:
            if not node:
                raise RuntimeError("node runtime unavailable")
            proc = subprocess.run([node, str(validator), "--validate", "-"],
                                  input=json.dumps(result, ensure_ascii=False), capture_output=True,
                                  text=True, encoding="utf-8", timeout=20,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if proc.returncode != 0:
                raise RuntimeError("search journal validator failed")
            assessment = json.loads(proc.stdout)
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            assessment = {"valid": False, "status": "pending", "decision_ready": False,
                          "gaps": ["search_agent_journal_validation_unavailable"]}
    ready = assessment.get("valid") is True and assessment.get("decision_ready") is True
    result["search_agent_assessment"] = assessment
    result["search_decision_ready"] = ready
    if result.get("papers"):
        result["status"] = "completed" if ready else "insufficient_corpus"
    (output_dir / "search-agent-assessment.json").write_text(
        json.dumps(assessment, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def write_screening_artifacts(output_dir: Path, screening: dict) -> dict:
    """Publish unreviewed/excluded records outside the accepted papers surface."""
    candidates_path = output_dir / "literature-candidates.json"
    queue_path = output_dir / "abstract-review-queue.json"
    audit_path = output_dir / "literature-screening-audit.json"
    candidates_path.write_text(json.dumps({
        "manifest": screening["manifest"],
        "papers": [candidate["paper"] for candidate in screening["candidates"]],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    queue_path.write_text(json.dumps({
        "manifest": screening["manifest"], "review_contract": screening["review_contract"],
        "candidates": screening["review_queue"],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    audit_path.write_text(json.dumps({
        "manifest": screening["manifest"], "counts": screening["counts"],
        "review_bundle_status": screening["review_bundle_status"],
        "excluded": screening["excluded"], "quarantined": screening["quarantined"],
        "pending_review_ids": [candidate["paper_id"] for candidate in screening["review_queue"]],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"candidates_path": str(candidates_path), "review_queue_path": str(queue_path),
            "audit_path": str(audit_path)}


def invalidate_previous_handoff(output_dir: Path) -> None:
    """Keep former results for audit while removing them from executable paths."""
    for name in ("handoff-validation-plan.json", "analysis-design-memo.json"):
        path = output_dir / name
        if not path.is_file():
            continue
        former = path.read_text(encoding="utf-8")
        digest = hashlib.sha256(former.encode("utf-8")).hexdigest()[:12]
        archive = output_dir / "superseded-literature-handoffs"
        archive.mkdir(exist_ok=True)
        (archive / f"{path.stem}-{digest}.json").write_text(former, encoding="utf-8")
        path.write_text(json.dumps({
            "status": "blocked", "evidence_ready": False,
            "reason": "A new analyst handoff must be authored from the current reviewed literature.",
            "validation_checks": [], "check_specs": [],
        }, indent=2), encoding="utf-8")


def finalize_review_dir(output_dir: Path, reviews_file: Path, role_plan_file: Path | None = None) -> dict:
    """Apply Codex/human abstract reviews to saved candidates without retrieval."""
    candidate_payload = json.loads((output_dir / "literature-candidates.json").read_text(encoding="utf-8"))
    prior_manifest = candidate_payload["manifest"]
    result_path = output_dir / "result.json"
    result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.exists() else {"driver": "literature-search-driver"}
    explicit_plan = json.loads(role_plan_file.read_text(encoding="utf-8")) if role_plan_file else {}
    role_plan = explicit_plan or result.get("role_plan") or {}
    objective = objective_from_plan(explicit_plan, []) if explicit_plan else prior_manifest["objective"]
    sources = default_literature_sources(objective) if explicit_plan else prior_manifest["sources"]
    reviews = json.loads(reviews_file.read_text(encoding="utf-8"))
    papers, screening = screen_papers(candidate_payload["papers"], objective, sources, reviews)
    paths = write_screening_artifacts(output_dir, screening)
    (output_dir / "papers.json").write_text(json.dumps(papers, ensure_ascii=False, indent=2), encoding="utf-8")
    result.update({
        "status": "completed" if papers else "pending_review" if screening["review_queue"] else "no_admitted_evidence",
        "evidence_ready": bool(papers), "paper_count": len(papers), "papers": papers,
        "papers_path": str(output_dir / "papers.json"),
        "literature_screening": {"manifest": screening["manifest"], "counts": screening["counts"], **paths},
        "frontier_catalog": infer_frontier_catalog(papers, role_plan) if papers else {},
        "hypothesis_scenarios": generate_hypothesis_scenarios(papers, role_plan)[:6] if papers else [],
    })
    # Never carry synthesis or runner handoff from a former, now-invalid corpus.
    for key in ("statistical_review_memo", "analysis_lane_proposals", "recommended_followup_actions",
                "analyst_handoff", "analyst_handoff_path", "analysis_design_memo", "analysis_design_memo_path"):
        result.pop(key, None)
    invalidate_previous_handoff(output_dir)
    stats = result.setdefault("source_stats", {})
    stats["literature_screening"] = result["literature_screening"]
    stats["frontier_catalog"] = result["frontier_catalog"]
    stats["hypothesis_scenarios"] = result["hypothesis_scenarios"]
    for key in ("statistical_review_memo", "analysis_lane_proposals"):
        stats.pop(key, None)
    apply_search_agent_assessment(result, output_dir, role_plan)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (output_dir / "summary.md").write_text(
        "# Reviewed literature\n\n" + f"Accepted: {len(papers)}; pending abstract review: {len(screening['review_queue'])}.\n"
        + "\n".join(f"- {paper.get('year')}: {paper.get('title')}" for paper in papers), encoding="utf-8")
    return result


def persist_candidate_batch(output_dir: Path, batch: dict, role_plan: dict) -> dict:
    """Append one agent inquiry without discarding earlier reads or requerying.

    A primary-page/citation-graph batch has the same admission boundary as an
    index probe. Imported author judgments never substitute for abstract review.
    """
    objective = objective_from_plan(role_plan, [])
    if not objective:
        raise ValueError("A durable inquiry requires the exact role-plan research objective")
    incoming = batch.get("papers")
    if not isinstance(incoming, list) or any(not isinstance(p, dict) for p in incoming):
        raise ValueError("Candidate batch must contain a papers array of metadata records")
    output_dir.mkdir(parents=True, exist_ok=True)
    candidate_path = output_dir / "literature-candidates.json"
    prior = json.loads(candidate_path.read_text(encoding="utf-8")) if candidate_path.exists() else {}
    if prior and prior.get("manifest", {}).get("objective") != objective:
        raise ValueError("Research objective changed; use a new lane instead of mixing review contexts")
    # Prior receipts remain reusable under their original hashes. New imported
    # records are candidates even if the importing tool attached accepted flags.
    new_papers = [{k: v for k, v in p.items() if k != "literature_screening"} for p in incoming]
    papers = merge_candidate_records([*(prior.get("papers") or []), *new_papers])
    previous_by_id = {paper_identity(p): p for p in (prior.get("papers") or [])}
    new_candidate_ids = [paper_identity(p) for p in papers if paper_identity(p) not in previous_by_id]
    changed_abstract_ids = [paper_identity(p) for p in papers
                            if paper_identity(p) in previous_by_id
                            and clean_text(p.get("abstract") or "") != clean_text(
                                previous_by_id[paper_identity(p)].get("abstract") or "")]
    previously_accepted_ids = {paper_identity(p) for p in previous_by_id.values()
                              if (p.get("literature_screening") or {}).get("status") == "accepted"}
    sources = sorted(set([*(prior.get("manifest", {}).get("sources") or []),
                          *(batch.get("sources") or []),
                          *(str(p.get("source")) for p in new_papers if p.get("source"))]))
    reviews_path = output_dir / "abstract-reviews.json"
    reviews = json.loads(reviews_path.read_text(encoding="utf-8")) if reviews_path.is_file() else None
    accepted, screening = screen_papers(papers, objective, sources, reviews)
    write_screening_artifacts(output_dir, screening)
    (output_dir / "papers.json").write_text(json.dumps(accepted, ensure_ascii=False, indent=2), encoding="utf-8")
    receipt = {"observed_at": datetime.now(timezone.utc).isoformat(), "query": batch.get("query"),
               "sources": batch.get("sources") or [], "source_stats": batch.get("source_stats") or {},
               "result_ids": list(dict.fromkeys(paper_identity(p) for p in new_papers)),
               "new_candidate_ids": new_candidate_ids, "changed_abstract_ids": changed_abstract_ids,
               "newly_accepted_ids": [paper_identity(p) for p in accepted if paper_identity(p) not in previously_accepted_ids],
               "evidence_status": "retrieval_candidates_only"}
    with (output_dir / "search-retrieval-events.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(receipt, ensure_ascii=False) + "\n")
    result = {"driver": "literature-search-driver", "role": "scout", "objective": objective,
              "role_plan": _compact_role_plan_for_result(role_plan), "papers": accepted,
              "paper_count": len(accepted), "evidence_ready": bool(accepted),
              "status": "insufficient_corpus" if accepted else "pending_review" if screening["review_queue"] else "no_admitted_evidence",
              "literature_screening": {"manifest": screening["manifest"], "counts": screening["counts"]}}
    apply_search_agent_assessment(result, output_dir, role_plan)
    invalidate_previous_handoff(output_dir)
    (output_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"counts": screening["counts"], "result_path": str(output_dir / "result.json"),
            "review_queue_path": str(output_dir / "abstract-review-queue.json"),
            "retrieval_receipt": receipt, "search_decision_ready": result.get("search_decision_ready", False)}


def probe_query(query: str, output_dir: Path | None = None, role_plan: dict | None = None,
                sources: list[str] | None = None) -> dict:
    """Run ONE query across the configured sources and return papers + stats.

    This is the retrieval primitive a reasoning (codex-agent) scout calls to
    author queries iteratively: issue a query, read the papers, refine, repeat.
    It does NOT run the full role-plan pipeline — just retrieval — so the agent
    stays in control of query authorship and depth. ``sources`` (the
    ``--sources`` flag) narrows the probe to named sources.
    """
    objective = objective_from_plan(role_plan, []) if role_plan else ""
    sources = select_literature_sources(sources, objective or query)
    papers, source_stats = collect_query_papers(query, sources, objective)
    result = {
        "query": query,
        "sources": sources,
        "paper_count": len(papers),
        "source_stats": source_stats,
        "evidence_status": "retrieval_candidates_only",
        "papers": papers,
    }
    if output_dir is not None:
        result["durable_inquiry"] = persist_candidate_batch(output_dir, result, role_plan or {})
    return result


def discover_role_plan_file(output_dir: Path) -> Path | None:
    """The lane's role plan, found from its output directory.

    The native scout protocol writes retrieval into the lane's artifact
    directory (`.research-lab/artifacts/stats/<cycle>/<lane>`) while the role
    plan lives in `.research-lab/lanes/<cycle>/<lane>/role-plan.json`, so a
    lookup given only `--output-dir` looks in both.
    """
    candidates = [output_dir / "role-plan.json"]
    try:
        runtime_root = research_lab_runtime_root(output_dir)
        candidates.append(runtime_root / "lanes" / output_dir.parent.name / output_dir.name / "role-plan.json")
    except IndexError:
        pass
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def lookup_known_papers(titles: list[str], arxiv_ids: list[str], dois: list[str],
                        output_dir: Path | None = None, role_plan: dict | None = None) -> dict:
    """Resolve known papers by title / arXiv ID / DOI; optionally persist them.

    A matched paper joins the lane's candidates and the SAME pending
    abstract-review queue as a keyword hit: screening, quality tracks and the
    review contract are unchanged. Ambiguous and unmatched requests are
    reported per title and admit nothing.
    """
    from .title_lookup import align_with_existing, lookup_references

    result = lookup_references(titles, arxiv_ids, dois)
    if output_dir is not None:
        candidate_path = output_dir / "literature-candidates.json"
        try:
            existing = json.loads(candidate_path.read_text(encoding="utf-8")).get("papers") or []
        except (OSError, ValueError, AttributeError):
            existing = []
        result["papers"] = align_with_existing(result["papers"], existing)
        result["durable_inquiry"] = persist_candidate_batch(output_dir, result, role_plan or {})
    return result


def deep_read_tools(fulltext_ids: list[str], asset_ids: list[str], rebuild_inventory: bool, refresh: bool) -> dict:
    """Full text, assets and the local inventory for a deep-read scout.

    Each paper is independent: one that no source renders is reported with the
    sources tried and the others still resolve.
    """
    from .assets import AssetLookups, resolve_assets, write_assets
    from .fulltext import fetch_fulltext, fulltext_summary
    from .local_assets import load_local_asset_inventory, write_local_asset_inventory

    out: dict = {}
    if rebuild_inventory:
        inventory = write_local_asset_inventory()
        out["local_asset_inventory"] = {
            "path": inventory["inventory_path"],
            "repositories": [
                {"path": entry["path"], "repo": entry["repo"], "head_sha": entry["head_sha"],
                 "methods": [item["name"] for item in entry["methods"]],
                 "benchmarks": [item["name"] for item in entry["benchmarks"]]}
                for entry in inventory["repositories"]
            ],
        }
    fulltexts = []
    for arxiv_id in list(dict.fromkeys(fulltext_ids + asset_ids)):
        try:
            fulltexts.append(fulltext_summary(fetch_fulltext(arxiv_id, refresh=refresh and arxiv_id in fulltext_ids)))
        except ValueError as error:
            try:
                fulltexts.append(json.loads(str(error)))
            except ValueError:
                fulltexts.append({"arxiv_id": arxiv_id, "error": str(error)})
    if fulltexts:
        out["fulltext"] = fulltexts
    if asset_ids:
        lookups = AssetLookups()
        inventory = load_local_asset_inventory()
        resolved = []
        for arxiv_id in asset_ids:
            lookups.searches = []
            try:
                result = resolve_assets(arxiv_id, lookups=lookups, inventory=inventory)
                result["assets_path"] = str(write_assets(arxiv_id, result))
            except ValueError as error:
                result = {"arxiv_id": arxiv_id, "error": str(error)}
            resolved.append(result)
        out["assets"] = resolved
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir")
    parser.add_argument("--role", default="scout")
    parser.add_argument("--queries-file")
    parser.add_argument("--task-file")
    parser.add_argument("--role-plan-file")
    parser.add_argument("--reviews-file", help="Structured full-abstract reviews authored by Codex CLI or a human")
    parser.add_argument("--finalize-review-dir", help="Finalize saved candidates with --reviews-file; no new search")
    parser.add_argument("--import-candidates-file", help="Append primary-page/citation candidates to the lane without retrieval; requires --output-dir and --role-plan-file")
    parser.add_argument(
        "--query",
        help="Single-query PROBE mode: run one query across sources and print "
        "papers as JSON to stdout (for an agent to reason over and refine). "
        "Skips the full role-plan pipeline; --output-dir not required.",
    )
    parser.add_argument(
        "--citations-of",
        help="Citation-graph PROBE: the DOI of one parent paper. Use with --direction; "
        "with --output-dir and --role-plan-file the lookup is recorded like a --query probe.",
    )
    parser.add_argument(
        "--direction",
        choices=["references", "citations"],
        default="references",
        help="references = backward citation (what the parent cites); "
        "citations = forward citation (what cites the parent).",
    )
    parser.add_argument(
        "--title", action="append", default=[],
        help="Known-item LOOKUP by exact paper title (repeatable). Resolved through arXiv, Semantic "
        "Scholar, OpenAlex and Crossref; each title reports matched/ambiguous/not_found. With "
        "--output-dir, matched papers join that lane's pending abstract-review queue.",
    )
    parser.add_argument("--arxiv-id", action="append", default=[], help="Known-item lookup by arXiv ID (repeatable).")
    parser.add_argument("--doi", action="append", default=[], help="Known-item lookup by DOI (repeatable).")
    parser.add_argument(
        "--sources", "--source", dest="sources", action="append", default=[],
        help="Restrict a --query probe to these sources (repeatable or comma-separated): "
        "openalex, crossref, arxiv, semanticscholar, pubmed, scopus. The network policy still applies.",
    )
    parser.add_argument(
        "--fulltext", action="append", default=[],
        help="DEEP READ: fetch and cache one paper's full text by arXiv ID (repeatable): arxiv.org/html, then "
        "ar5iv, then the PDF. Prints where the text is, its sha256 and its section/table/figure index.",
    )
    parser.add_argument(
        "--resolve-assets", action="append", default=[],
        help="DEEP READ: resolve one paper's open-source assets by arXiv ID (repeatable) -- code repositories "
        "(GitHub metadata), checkpoints and datasets (Hugging Face), benchmark environments, a min-VRAM estimate, "
        "the reproduction entry point and any local copy. Metadata only. Fetches the full text first if needed.",
    )
    parser.add_argument("--local-asset-inventory", action="store_true",
                        help="Rebuild the inventory of open-source robot-learning repositories on this host.")
    parser.add_argument("--refresh", action="store_true", help="With --fulltext: ignore the cached copy.")
    parser.add_argument(
        "--frontier-harvest", action="store_true",
        help="FRONTIER HARVEST: page Semantic Scholar's forward citations of every anchor in --anchors-file, keep "
        "papers dated on/after --since, rank them by distinct anchors cited and citation velocity, write "
        "frontier-candidates.json to --output-dir and queue the top-K for abstract review (see frontier.py).",
    )
    parser.add_argument("--anchors-file", help="With --frontier-harvest: JSON list of anchor paper ids or {paper_id, title}.")
    parser.add_argument("--since", help="With --frontier-harvest: YYYY-MM-DD. Default: the knowledge horizon "
                        "(RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON, else --cycle-date minus RESEARCHLAB_FRONTIER_WINDOW_MONTHS).")
    parser.add_argument("--cycle-date", help="With --frontier-harvest and no --since: the cycle's date (YYYY-MM-DD); default today.")
    parser.add_argument("--top-k", type=int, help="With --frontier-harvest: candidates queued for review (RESEARCHLAB_FRONTIER_TOP_K, default 20).")
    parser.add_argument("--revive-root", action="append", default=[],
                        help="With --frontier-harvest: a cycle directory whose retrieved-but-never-reviewed candidates "
                        "are revived through the same filter (repeatable).")
    args = parser.parse_args()

    if args.frontier_harvest:
        from datetime import date as _date

        from .frontier import knowledge_horizon, load_anchors, run_frontier_harvest

        if not args.anchors_file:
            parser.error("--frontier-harvest requires --anchors-file")
        if args.since:
            since, horizon_source = _date.fromisoformat(args.since[:10]), "--since"
        else:
            since, horizon_source = knowledge_horizon(_date.fromisoformat(args.cycle_date[:10]) if args.cycle_date else None)
        output_dir = Path(args.output_dir) if args.output_dir else None
        role_plan_file = Path(args.role_plan_file) if args.role_plan_file else (
            discover_role_plan_file(output_dir) if output_dir else None
        )
        plan = json.loads(role_plan_file.read_text(encoding="utf-8")) if role_plan_file else None
        report = run_frontier_harvest(
            load_anchors(Path(args.anchors_file)), since, output_dir=output_dir, role_plan=plan,
            top_k=args.top_k, revive_roots=[Path(root) for root in args.revive_root],
            horizon_source=horizon_source,
        )
        print(json.dumps({key: report[key] for key in (
            "since", "horizon_source", "scoring", "candidate_count", "top_k_ids", "truncated_anchors",
            "unresolved_anchors", "request_stats", "import")} | {
            "top": [{key: item[key] for key in ("rank", "paper_id", "title", "publication_date", "co_citation",
                                                 "citation_count", "velocity", "score")}
                    for item in report["candidates"][:report["top_k"]]],
        }, ensure_ascii=False, indent=2))
        return

    if args.fulltext or args.resolve_assets or args.local_asset_inventory:
        print(json.dumps(deep_read_tools(args.fulltext, args.resolve_assets, args.local_asset_inventory, args.refresh),
                         ensure_ascii=False, indent=2))
        return

    if args.title or args.arxiv_id or args.doi:
        output_dir = Path(args.output_dir) if args.output_dir else None
        plan = None
        role_plan_file = Path(args.role_plan_file) if args.role_plan_file else (
            discover_role_plan_file(output_dir) if output_dir else None
        )
        if role_plan_file:
            plan = json.loads(role_plan_file.read_text(encoding="utf-8"))
        elif output_dir is not None:
            # A lane that already holds candidates carries its objective in the
            # screening manifest; reuse it rather than refuse the lookup.
            try:
                manifest = json.loads((output_dir / "literature-candidates.json").read_text(encoding="utf-8"))["manifest"]
                plan = {"objective": manifest["objective"]}
            except (OSError, ValueError, KeyError, TypeError):
                parser.error("Durable --title/--arxiv-id/--doi needs the lane objective: pass --role-plan-file "
                             "or run it on a lane directory holding role-plan.json")
        print(json.dumps(lookup_known_papers(args.title, args.arxiv_id, args.doi, output_dir, plan),
                         ensure_ascii=False, indent=2))
        return

    if args.citations_of:
        from .citation_graph import probe_citations

        if args.output_dir and not args.role_plan_file:
            parser.error("Durable --citations-of requires --role-plan-file to bind the research objective")
        result = probe_citations(args.citations_of, args.direction)
        if args.output_dir:
            plan = json.loads(Path(args.role_plan_file).read_text(encoding="utf-8"))
            result["durable_inquiry"] = persist_candidate_batch(Path(args.output_dir), result, plan)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.finalize_review_dir:
        if not args.reviews_file:
            parser.error("--finalize-review-dir requires --reviews-file")
        result = finalize_review_dir(Path(args.finalize_review_dir), Path(args.reviews_file),
                                     Path(args.role_plan_file) if args.role_plan_file else None)
        print(json.dumps({"status": result["status"], "paper_count": result["paper_count"],
                          "literature_screening": result["literature_screening"]}, ensure_ascii=False, indent=2))
        return

    if args.import_candidates_file:
        if not args.output_dir or not args.role_plan_file:
            parser.error("--import-candidates-file requires --output-dir and --role-plan-file")
        batch = json.loads(Path(args.import_candidates_file).read_text(encoding="utf-8"))
        plan = json.loads(Path(args.role_plan_file).read_text(encoding="utf-8"))
        print(json.dumps(persist_candidate_batch(Path(args.output_dir), batch, plan), ensure_ascii=False, indent=2))
        return

    if args.query:
        if args.output_dir and not args.role_plan_file:
            parser.error("Durable --query requires --role-plan-file to bind the research objective")
        plan = json.loads(Path(args.role_plan_file).read_text(encoding="utf-8")) if args.role_plan_file else None
        if args.sources:
            try:
                select_literature_sources(args.sources)
            except ValueError as error:
                parser.error(str(error))
        probe = probe_query(args.query, Path(args.output_dir) if args.output_dir else None, plan, args.sources)
        print(json.dumps(probe, ensure_ascii=False, indent=2))
        return

    if not args.output_dir:
        parser.error("--output-dir is required unless --query (probe mode) is used")

    result = run_driver(
        Path(args.output_dir),
        args.role,
        Path(args.queries_file) if args.queries_file else None,
        Path(args.task_file) if args.task_file else None,
        Path(args.role_plan_file) if args.role_plan_file else None,
        Path(args.reviews_file) if args.reviews_file else None,
    )
    handoff = result.get("analyst_handoff") if isinstance(result, dict) else None
    discovery = handoff.get("open_source_agent_discovery") if isinstance(handoff, dict) else None
    stdout_summary = {
        "status": result.get("status"),
        "driver": result.get("driver"),
        "role": result.get("role"),
        "paper_count": result.get("paper_count"),
        "result_path": str(Path(args.output_dir) / "result.json"),
        "analyst_handoff_path": result.get("analyst_handoff_path"),
        "open_source_agent_discovery": {
            "mandatory": discovery.get("mandatory"),
            "repository_agent_required": discovery.get("repository_agent_required"),
            "selected_agent": (
                (discovery.get("selected_agent") or {}).get("name")
                if isinstance(discovery.get("selected_agent"), dict)
                else None
            ),
            "candidate_count": len(discovery.get("candidates") or []),
        }
        if isinstance(discovery, dict)
        else None,
    }
    print(json.dumps(stdout_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
