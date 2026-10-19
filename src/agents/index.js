"use strict";

// These builders are NOT the dispatch path. The Rust follow-up builder composes
// the role plan a running cycle actually receives, and never calls into here --
// see src/policy/dispatch_authority.js for the measurement and the registry of
// rules that must exist on both sides. An edit here does not reach a lane by
// itself.
const { buildAnalystQueryPlan } = require("./analyst/query_plan");
const { buildAuthorRevisionPlan } = require("./author/revision_plan");
const { buildChronicleBriefPlan } = require("./chronicle/brief_plan");
const { buildEngineerEnvironmentPlan } = require("./engineer/environment_plan");
const { buildIllustratorPresentationPlan } = require("./illustrator/presentation_plan");
const { buildLabRunnerAnalysisPlan } = require("./lab_runner/analysis_plan");
const { buildInstrumentProbePlan, inventoryStatePath, resolveProbeConfig } = require("./lab_runner/instrument_probe_plan");
const { buildScoutQueryPlan } = require("./scout/query_plan");
const {
  buildImpactFirstHypothesisMandate,
  roleUsesImpactFirstHypothesisMandate,
} = require("./shared/impact_first");
const { buildLabDirectorLiteratureTriagePolicy } = require("./shared/literature_policy");
const {
  supervisorLabDirectorRoleBoundary,
  supervisorEscalationPolicy,
} = require("./shared/role_boundaries");
const { buildTaskContract, validateTaskContract } = require("../execution/task_contract");
const { buildTeamBinding } = require("../execution/team_manager");
const { buildSubagentRecord } = require("../execution/subagent_manager");
const { chooseModelRoute } = require("../policy/model_router");
const { RESEARCH_API_POLICY, RESEARCH_API_INSTRUCTION, usesDirectModelApi } = require("../policy/research_api");

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function compactText(value, maxChars = 320) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
}

function uniqueStrings(values) {
  return Array.from(new Set(asArray(values).map((item) => compactText(item)).filter(Boolean)));
}

function gateRestartPolicyFromContext(cyclePlanningContext) {
  const gate = cyclePlanningContext?.gate_review || {};
  const researcherSummary = cyclePlanningContext?.researcher_view?.summary || cyclePlanningContext?.researcher_view || {};
  const verdict = String(gate.verdict || gate.gatekeeper_review?.verdict || "").trim().toLowerCase();
  const mode = String(gate.mode || "").trim().toLowerCase();
  const decisionMode = String(gate.decision_mode || "").trim().toLowerCase();
  const actions = asArray(gate.recommended_actions || gate.recommended_followup_actions);
  const restartDemand =
    gate.restart_recommended === true ||
    verdict === "reject" ||
    mode === "reject" ||
    decisionMode === "pivot" ||
    decisionMode === "restart" ||
    actions.some((item) => String(item?.type || "") === "gate_restart_followup");
  if (!restartDemand) return null;
  const rejectedFamilies = uniqueStrings([
    gate.incumbent_family,
    gate.gatekeeper_review?.incumbent_family,
    researcherSummary?.incumbent_family,
    researcherSummary?.lead_family,
    researcherSummary?.lead_outcome_label,
    ...(asArray(gate.candidate_hypotheses).map((item) =>
      typeof item === "string"
        ? ""
        : item?.family_root || item?.family || item?.hypothesis_family || item?.cluster || "",
    )),
    ...(asArray(researcherSummary?.focus_hypotheses || researcherSummary?.hypotheses).map((item) =>
      typeof item === "string"
        ? ""
        : item?.family_root || item?.family || item?.hypothesis_family || item?.cluster || "",
    )),
  ]);
  const rubricScores = asArray(gate.rubric)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      name: item.name || null,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
      applicable: item.applicable !== false,
      reasons: asArray(item.reasons).map((reason) => compactText(reason, 220)).slice(0, 3),
    }))
    .filter((item) => item.name || item.score != null)
    .slice(0, 12);
  const gatekeeperReviewSummaries = asArray(gate.gatekeeper_reviews || gate.gatekeeper_reviews_normalized)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      lane_id: item.lane_id || item.reviewer_id || null,
      focus_rubric: item.focus_rubric || item.reviewer_focus_rubric || null,
      verdict: item.verdict || item.mode || null,
      score: Number.isFinite(Number(item.score))
        ? Number(item.score)
        : asArray(item.rubric).length > 0
          ? Math.round(
              asArray(item.rubric)
                .filter((rubric) => rubric?.applicable !== false && Number.isFinite(Number(rubric?.score)))
                .reduce((sum, rubric, _index, items) => sum + Number(rubric.score) / Math.max(1, items.length), 0),
            )
          : null,
      summary: compactText(item.summary || item.rationale || "", 260) || null,
    }))
    .slice(0, 10);
  const gatekeeperReviewComments = [];
  const addComment = (source, rubric, comment, score = null, laneId = null) => {
    const text = compactText(comment, 360);
    if (!text) return;
    gatekeeperReviewComments.push({
      source,
      lane_id: laneId,
      rubric: rubric || null,
      score,
      comment: text,
    });
  };
  for (const item of asArray(gate.blockers)) addComment("gate.blockers", null, item);
  for (const item of asArray(gate.challenge_questions)) addComment("gate.challenge_questions", null, item);
  for (const item of asArray(gate.major_objections)) addComment("gate.major_objections", null, item);
  for (const item of asArray(gate.missing_validations)) addComment("gate.missing_validations", null, item);
  for (const item of asArray(gate.switch_triggers)) addComment("gate.switch_triggers", null, item);
  for (const item of asArray(gate.incumbent_rejection_reasons)) addComment("gate.incumbent_rejection_reasons", null, item);
  for (const rubric of asArray(gate.rubric)) {
    for (const reason of asArray(rubric?.reasons)) {
      addComment("gate.rubric.reasons", rubric?.name || null, reason, rubric?.score ?? null);
    }
  }
  for (const review of asArray(gate.gatekeeper_reviews || gate.gatekeeper_reviews_normalized)) {
    const laneId = review?.lane_id || review?.reviewer_id || null;
    const focusRubric = review?.focus_rubric || review?.reviewer_focus_rubric || null;
    addComment("gatekeeper.summary", focusRubric, review?.summary || review?.rationale, null, laneId);
    for (const item of asArray(review?.major_objections)) addComment("gatekeeper.major_objections", focusRubric, item, null, laneId);
    for (const item of asArray(review?.missing_validations)) addComment("gatekeeper.missing_validations", focusRubric, item, null, laneId);
    for (const item of asArray(review?.switch_triggers)) addComment("gatekeeper.switch_triggers", focusRubric, item, null, laneId);
    for (const item of asArray(review?.incumbent_rejection_reasons)) addComment("gatekeeper.incumbent_rejection_reasons", focusRubric, item, null, laneId);
    for (const rubric of asArray(review?.rubric)) {
      for (const reason of asArray(rubric?.reasons)) {
        addComment("gatekeeper.rubric.reasons", rubric?.name || focusRubric, reason, rubric?.score ?? null, laneId);
      }
    }
  }
  const seenComments = new Set();
  const uniqueReviewComments = gatekeeperReviewComments.filter((item) => {
    const key = `${item.source}|${item.lane_id || ""}|${item.rubric || ""}|${item.score ?? ""}|${item.comment}`;
    if (seenComments.has(key)) return false;
    seenComments.add(key);
    return true;
  });
  return {
    required: true,
    source: "gate_review",
    gate_review_source_path: cyclePlanningContext?.source_paths?.gate_review || null,
    reason: gate.decision_reason || gate.blockers?.[0] || gate.challenge_questions?.[0] || "gate review rejected the incumbent lead package",
    gate_score: gate.score ?? gate.gate_score ?? null,
    rubric_scores: rubricScores,
    gate_mode: mode || null,
    gate_verdict: verdict || null,
    gatekeeper_review_summaries: gatekeeperReviewSummaries,
    review_comment_manifest: {
      source_path: cyclePlanningContext?.source_paths?.gate_review || null,
      total_unique_comment_count: uniqueReviewComments.length,
      comments: uniqueReviewComments,
    },
    decision_mode: decisionMode || null,
    rejected_incumbent_families: rejectedFamilies,
    unresolved_blockers: uniqueStrings([
      ...asArray(gate.blockers),
      ...asArray(gate.challenge_questions),
      ...asArray(gate.major_objections),
      ...asArray(gate.missing_validations),
      ...asArray(gate.switch_triggers),
      ...asArray(gate.incumbent_rejection_reasons),
    ]).slice(0, 14),
    alternative_family_hints: asArray(gate.cross_family_alternatives || gate.better_alternative_hypotheses)
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        return {
          family_root: item.family_root || null,
          statement: compactText(item.statement || item.hypothesis || item.description || "", 260) || null,
          why_better: compactText(item.why_better || item.rationale || "", 220) || null,
        };
      })
      .filter(Boolean)
      .slice(0, 5),
    mandatory_restart_steps: [
      "Do not patch or rephrase the rejected incumbent family in place.",
      "Restart from literature/data search and rank at least three distinct hypothesis families before selecting a new lead.",
      "Prefer cross-family alternatives or a materially different mechanism unless the incumbent can be explicitly cleared against every unresolved blocker.",
      "For the new lead, name the state-of-art baseline, same-dataset comparator, exposure/outcome/covariates, confound-adjustment plan, null/composition test, and external-validation or transportability route before sending another gate review.",
    ],
  };
}

function compactReviewComment(item, source = null) {
  if (typeof item === "string") {
    return { source, comment: compactText(item), severity: "blocking" };
  }
  if (!item || typeof item !== "object") return null;
  const comment = uniqueStrings([
    item.comment,
    item.summary,
    item.issue,
    item.reason,
    item.description,
    ...asArray(item.concerns),
    ...asArray(item.required_revisions),
    ...asArray(item.reasons),
  ]).join(" | ");
  if (!comment) return null;
  return {
    source: item.source || source,
    rubric: item.rubric || item.rubric_item || item.name || null,
    section: item.section || null,
    comment_id: item.comment_id || item.id || null,
    severity: item.severity || "blocking",
    score: item.score ?? null,
    comment: compactText(comment),
    required_revisions: asArray(item.required_revisions).map((value) => compactText(value, 180)).slice(0, 3),
  };
}

function collectReviewComments(value, source) {
  return asArray(value).map((item) => compactReviewComment(item, source)).filter(Boolean);
}

function compactPreviousReviewContext(cyclePlanningContext) {
  const existing =
    cyclePlanningContext?.gate_review?.gate_reviewer_context?.previous_review_context ||
    cyclePlanningContext?.gate_review?.previous_review_context ||
    null;
  if (existing && typeof existing === "object") {
    return {
      source: existing.source || "gate_review_memory",
      required_for_gatekeeper: true,
      previous_gate_review_path: existing.previous_gate_review_path || null,
      review_comments: asArray(existing.review_comments).map((item) => compactReviewComment(item, item?.source)).filter(Boolean).slice(0, 16),
      unresolved_blockers: uniqueStrings(existing.unresolved_blockers).slice(0, 10),
      reviewer_instruction: existing.reviewer_instruction || null,
    };
  }

  const comments = []
    .concat(collectReviewComments(cyclePlanningContext?.gate_review?.scientific_gate_comments, "gate_review"))
    .concat(collectReviewComments(cyclePlanningContext?.gate_review?.blockers, "gate_review"))
    .concat(collectReviewComments(cyclePlanningContext?.gate_review?.challenge_questions, "gate_review"))
    .concat(collectReviewComments(cyclePlanningContext?.conclusion_review?.conclusion_blockers, "conclusion_review"))
    .concat(collectReviewComments(cyclePlanningContext?.paper_review?.paper_blockers, "paper_review"))
    .concat(collectReviewComments(cyclePlanningContext?.paper_review?.paper_review_comments, "paper_review"))
    .concat(collectReviewComments(cyclePlanningContext?.report_review?.report_blockers, "report_review"))
    .concat(collectReviewComments(cyclePlanningContext?.report_review?.report_review_comments, "report_review"));
  return {
    source: "cycle_planning_context",
    required_for_gatekeeper: true,
    previous_gate_review_path: null,
    review_comments: comments.slice(0, 16),
    unresolved_blockers: uniqueStrings(comments.map((item) => item.comment)).slice(0, 10),
    reviewer_instruction:
      "Before scoring, check whether each prior scientific review comment is resolved, still blocking, or superseded.",
  };
}

function normalizePaperItem(item, source = null) {
  if (!item || typeof item !== "object") return null;
  const title = compactText(item.title || item.paper_title || item.name || item.citation_title || "", 220);
  const doi = compactText(item.doi || item.DOI || "", 140);
  const paperId = compactText(
    item.paper_id || item.citation_id || item.pmid || item.pmcid || ((title || doi) ? item.id : "") || "",
    120,
  );
  if (!title && !paperId && !doi) return null;
  return {
    title: title || null,
    paper_id: paperId || null,
    year: item.year || item.publication_year || item.pub_year || null,
    doi: doi || null,
    venue: compactText(item.venue || item.journal || item.source || "", 160) || null,
    url: item.url || item.source_url || null,
    source,
  };
}

function collectKnownPaperItems(value, source = "chronicle", limit = 12) {
  const papers = [];
  const seen = new Set();
  const add = (items, itemSource) => {
    for (const item of asArray(items).slice(0, limit)) {
      const paper = normalizePaperItem(item, itemSource);
      if (!paper) continue;
      const key = String(paper.doi || paper.title || paper.paper_id || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      papers.push(paper);
      if (papers.length >= limit) return;
    }
  };
  if (!value || typeof value !== "object") return papers;
  add(value.papers, source);
  add(value.top_papers, source);
  add(value.citation_ledger, source);
  add(value.references, source);
  add(value.writing_loop?.citation_ledger, "writing_loop.citation_ledger");
  add(value.writing_loop?.top_papers, "writing_loop.top_papers");
  add(value.writing_loop?.verified_citations, "writing_loop.verified_citations");
  for (const lane of asArray(value.lanes).slice(0, 8)) {
    add(lane?.papers, "literature_lane.papers");
    add(lane?.top_papers, "literature_lane.top_papers");
    add(lane?.writing_loop?.citation_ledger, "literature_lane.citation_ledger");
    if (papers.length >= limit) break;
  }
  return papers.slice(0, limit);
}

function compactTrendValues(values, limit = 12) {
  return uniqueStrings(asArray(values).map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return (
      item.label ||
      item.cluster ||
      item.topic ||
      item.name ||
      item.summary ||
      item.gap ||
      item.mechanism ||
      item.method ||
      item.rationale ||
      JSON.stringify(item).slice(0, 240)
    );
  })).slice(0, limit);
}

function compactChronicleResearchContext(cyclePlanningContext) {
  const existing =
    cyclePlanningContext?.gate_review?.gate_reviewer_context?.chronicle_research_context ||
    cyclePlanningContext?.gate_review?.chronicle_research_context ||
    cyclePlanningContext?.chronicle_research_context ||
    null;
  if (existing && typeof existing === "object") {
    return {
      source: existing.source || "chronicle",
      required_for_gatekeeper: true,
      source_paths: existing.source_paths || {},
      missing_sources: asArray(existing.missing_sources),
      what_changed_since_previous_pass: compactTrendValues(existing.what_changed_since_previous_pass, 8),
      latest_high_signal_lane_ids: asArray(existing.latest_high_signal_lane_ids).slice(0, 8),
      approval_blockers: compactTrendValues(existing.approval_blockers, 8),
      open_questions: compactTrendValues(existing.open_questions, 8),
      recommended_actions: compactTrendValues(existing.recommended_actions, 8),
      dominant_mechanisms: compactTrendValues(existing.dominant_mechanisms, 8),
      latest_research_trends: compactTrendValues(existing.latest_research_trends, 12),
      latest_papers: asArray(existing.latest_papers).map((item) => normalizePaperItem(item, item?.source)).filter(Boolean).slice(0, 10),
      literature_graph_digest: existing.literature_graph_digest || null,
      reviewer_instruction: existing.reviewer_instruction || null,
    };
  }

  const researcherView = cyclePlanningContext?.researcher_view?.summary || cyclePlanningContext?.researcher_view || {};
  const chronicle = researcherView?.chronicle_reporting || {};
  const trendSummary = cyclePlanningContext?.trend_summary || {};
  const trendAnalysis = cyclePlanningContext?.research_trend_analysis || {};
  const literature = cyclePlanningContext?.lab_director_literature || cyclePlanningContext?.literature_summary || {};
  const literatureGraph = cyclePlanningContext?.literature_graph || {};
  const papers = []
    .concat(collectKnownPaperItems(literature, "lab_director_literature", 10))
    .concat(collectKnownPaperItems(trendSummary, "trend_summary", 6))
    .concat(collectKnownPaperItems(trendAnalysis, "research_trend_analysis", 6));
  const deduped = [];
  const seen = new Set();
  for (const paper of papers) {
    const key = String(paper.doi || paper.title || paper.paper_id || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }
  const graphNodes = asArray(literatureGraph.nodes);
  const graphEdges = asArray(literatureGraph.edges);
  return {
    source: "chronicle",
    required_for_gatekeeper: true,
    source_paths: {},
    missing_sources: [],
    what_changed_since_previous_pass: compactTrendValues(chronicle.what_changed_since_previous_pass || trendSummary.what_changed_since_previous_pass, 8),
    latest_high_signal_lane_ids: asArray(chronicle.latest_high_signal_lane_ids || trendSummary.latest_high_signal_lane_ids).slice(0, 8),
    approval_blockers: compactTrendValues(chronicle.approval_blockers || trendSummary.approval_blockers || trendSummary.blockers, 8),
    open_questions: compactTrendValues(chronicle.open_questions || trendSummary.open_questions || trendSummary.open_gaps || trendAnalysis.underexplored_gaps, 8),
    recommended_actions: compactTrendValues(chronicle.recommended_actions || trendSummary.recommended_actions, 8),
    dominant_mechanisms: compactTrendValues(chronicle.dominant_mechanisms || trendSummary.dominant_mechanisms, 8),
    latest_research_trends: compactTrendValues([
      ...asArray(trendSummary.cluster_labels),
      ...asArray(trendSummary.rising_methodologies),
      ...asArray(trendSummary.saturated_baselines),
      ...asArray(trendSummary.open_gaps),
      ...asArray(trendAnalysis.dominant_clusters),
      ...asArray(trendAnalysis.rising_methods),
      // Both names. The prompt now asks for `repeated_datasets`; every trend
      // analysis recorded before that asked for `repeated_datasets_or_cohorts`,
      // and dropping the old key would silently blank that field for every
      // cycle already on disk.
      ...asArray(trendAnalysis.repeated_datasets),
      ...asArray(trendAnalysis.repeated_datasets_or_cohorts),
      ...asArray(trendAnalysis.saturated_baselines),
      ...asArray(trendAnalysis.underexplored_gaps),
      ...asArray(trendAnalysis.selection_implications),
    ], 12),
    latest_papers: deduped.slice(0, 10),
    literature_graph_digest: literatureGraph && typeof literatureGraph === "object"
      ? {
          node_count: graphNodes.length || Number(literatureGraph.node_count || 0),
          edge_count: graphEdges.length || Number(literatureGraph.edge_count || 0),
          top_concepts: graphNodes.map((item) => item?.label || item?.name || item?.node_id || item?.id).filter(Boolean).slice(0, 10),
        }
      : null,
    reviewer_instruction:
      "Use Chronicle's trend summary, research-trend analysis, literature graph, and latest paper list to infer the current state-of-the-art baseline before judging novelty or impact.",
  };
}

function withImpactFirstHypothesisMandate(rolePlan, { researchStage = "evidence" } = {}) {
  if (!roleUsesImpactFirstHypothesisMandate(rolePlan?.role)) return rolePlan;
  const mandate = buildImpactFirstHypothesisMandate();
  const plannerMetadata = {
    ...(rolePlan.planner_metadata || {}),
    impact_first_hypothesis_mandate: mandate,
  };
  const extras = {};
  if (["lab-director", "analyst"].includes(String(rolePlan.role || ""))) {
    extras.required_output = uniqueStrings([
      ...(Array.isArray(rolePlan.required_output) ? rolePlan.required_output : []),
      "impact-ranked candidate hypothesis table",
      "validation-data availability ranking with accession/bundle path, variable mapping, and data blockers for each candidate",
      "state-of-art delta and decision relevance for each candidate",
      "lead selection rationale that explains why the lead is not merely an audit",
    ]);
  }
  return {
    ...rolePlan,
    ...extras,
    impact_first_hypothesis_mandate: mandate,
    hypothesis_generation_policy: {
      mode: "impact-first",
      applies_from_stage: researchStage,
      mandate_version: mandate.policy_version,
      minimum_initial_scores: mandate.minimum_initial_scores,
      required_candidate_fields: mandate.required_candidate_fields,
    },
    planner_metadata: plannerMetadata,
  };
}

function withLabDirectorLiteratureTriagePolicy(rolePlan) {
  if (String(rolePlan?.role || "") !== "lab-director") return rolePlan;
  const policy = buildLabDirectorLiteratureTriagePolicy();
  return {
    ...rolePlan,
    literature_triage_policy: policy,
    required_output: uniqueStrings([
      ...(Array.isArray(rolePlan.required_output) ? rolePlan.required_output : []),
      "literature sufficiency decision: continue_search, stop_and_gate_review, stop_and_validate, or pivot",
      "coverage checklist for state-of-art baseline, same-dataset/mechanism reference, rival family, and KG-seed vocabulary",
      "one next role assignment justified by the literature triage policy",
    ]),
    decision_policy: {
      ...(rolePlan.decision_policy || {}),
      must_apply_literature_triage_policy: true,
      must_stop_literature_search_when_sufficient: true,
      must_allow_abstract_only_kg_seeds: true,
    },
    planner_metadata: {
      ...(rolePlan.planner_metadata || {}),
      literature_triage_policy: policy,
    },
  };
}

// ONE probe per cycle, on the first runner lane.
//
// The inventory check alone is not enough: every lab-runner plan for a cycle is
// built in the same planning pass, before any of them has run, so all four saw
// no inventory and all four became probe lanes. cycle-g-v83 duly ran the same
// 26-second probe three times (lab-runner-01/02/03) and held all three
// concurrency slots doing it.
function isFirstRunnerLane(laneId) {
  return String(laneId || "") === "lab-runner-01";
}

// How many times one cycle may spend a runner lane re-measuring its instruments.
//
// instrumentInventoryNeeded is self-disarming: a probe that succeeds makes it
// false. A probe that FAILS does not, and without a bound every later runner
// lane would become another probe lane. Three attempts is enough for a
// transient, and few enough that a cycle whose probe cannot run still has
// runner lanes left to do science with.
const INSTRUMENT_PROBE_ATTEMPT_LIMIT = 3;

function instrumentProbeAttemptsPath(cycleId) {
  return `.research-lab/state/${cycleId}-instrument-probe-attempts.json`;
}

function readInstrumentProbeAttempts(cycleId) {
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(process.cwd(), instrumentProbeAttemptsPath(cycleId));
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(parsed?.attempts) ? parsed.attempts : 0;
  } catch {
    return 0;
  }
}

function recordInstrumentProbeAttempt(cycleId, laneId) {
  const attempts = readInstrumentProbeAttempts(cycleId) + 1;
  try {
    const path = require("path");
    const { writeFileAtomic } = require("../shared/json");
    writeFileAtomic(
      path.join(process.cwd(), instrumentProbeAttemptsPath(cycleId)),
      `${JSON.stringify({ attempts, last_lane_id: laneId, updated_at: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // A missing attempt record only costs another attempt; it must not stop the
    // probe that is trying to unblock the cycle.
  }
  return attempts;
}

// Whether THIS runner lane should measure the instruments instead of running
// science.
//
// MEASURED on cycle-a-20260919, 2026-09-23. The cycle moved from
// Windows into a container on 2026-09-22, and its inventory stayed behind: it
// still recorded mujoco 3.10.0 under
// C:\Users\...\Python311\python.exe and a source_root of D:\projects\...,
// measured by lab-runner-01 on a machine that no longer exists. The container
// runs mujoco 3.11.0 under Python 3.12.3. Every engineer execution audit then
// failed its `identity` check against that declaration -- 4 of 5 checks passing,
// identity failing, forever -- the director deferred on the unresolved
// reproducibility defect, and the cycle sat at `lead_selected` for 4,851
// minutes.
//
// instrumentInventoryNeeded already answers this correctly: a measurement whose
// probe_config names a source_root this venue does not have is not a
// measurement of this venue. It was simply never asked, because arming was
// additionally gated on the lane being `lab-runner-01` -- a lane that had
// already run, on the other machine. An inventory describing a machine that no
// longer exists is worse than no inventory, because roles cite it as fact.
//
// MEASURED 2026-09-23 15:00, on the first attempt at this fix: three probe
// attempts were spent in under a minute and the inventory never changed.
// buildLaneQueryPlan maps over a MANIFEST -- one planning pass builds the plans
// for many lanes at once, including lanes that finished days ago -- so arming
// on the lane id alone re-planned lab-runner-01, -02 and -03 (all completed
// 2026-09-19) as probe lanes, burned the whole budget on plans nobody would
// run, and left the Windows inventory in place. A lane that already carries a
// final-status has run; re-planning it cannot measure anything.
function laneHasAlreadyRun(cycleId, laneId) {
  try {
    const fs = require("fs");
    const path = require("path");
    return fs.existsSync(
      path.join(process.cwd(), ".research-lab", "lanes", String(cycleId), String(laneId), "final-status.json"),
    );
  } catch {
    return false;
  }
}

function shouldProbeInstruments(laneId, cycleId) {
  if (!instrumentInventoryNeeded(cycleId)) return false;
  if (laneHasAlreadyRun(cycleId, laneId)) return false;
  if (isFirstRunnerLane(laneId)) return true;
  return readInstrumentProbeAttempts(cycleId) < INSTRUMENT_PROBE_ATTEMPT_LIMIT;
}

// True while this cycle has no measured instrument inventory yet. Deliberately a
// filesystem check rather than a flag threaded through the planner: the probe
// must arm on a fresh cycle and on a resumed one that never got as far as
// probing, and disarm the moment a real measurement exists.
function instrumentInventoryNeeded(cycleId) {
  if (!cycleId) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(process.cwd(), inventoryStatePath(cycleId));
    if (!fs.existsSync(file)) return true;
    // Reuse only a successful measurement of the currently selected tool and
    // inputs. Legacy or differently configured inventories must be re-probed.
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!["measured", "completed"].includes(parsed?.status) || parsed.exit_code !== 0) return true;
    if (!Array.isArray(parsed.verified_instruments) || !parsed.verified_instruments.some((item) => typeof item === "string" && item.trim())) return true;
    if (!parsed.probe_config || typeof parsed.probe_config !== "object" || Array.isArray(parsed.probe_config)) return true;
    const selectedConfig = resolveProbeConfig();
    // When nothing is named, the driver runs every backend it implements and
    // RECORDS that list -- superdex included -- as probe_config.backends. That
    // record is not a request, and replaying it through resolveProbeConfig asks
    // superdex for a source_root and policy_path nobody gave it, which throws;
    // the catch below then calls a complete, fresh measurement "needed".
    // MEASURED 2026-09-28 on cycle-a-20260919: a probe run in the
    // container measured all five backends, left nothing unprobed, and would still
    // have re-armed on every new runner lane until the attempt cap. With an unnamed
    // selection the measured backends do not decide anything -- the
    // implemented_but_not_probed check below does -- so they are not replayed.
    const { backends: _recordedBackends, backend: _recordedBackend, ...recordedInputs } = parsed.probe_config;
    const measuredConfig = resolveProbeConfig({
      probeConfig: selectedConfig.backends ? parsed.probe_config : recordedInputs,
      env: {},
    });
    const { backends: _measuredBackends, ...measuredInputs } = measuredConfig;
    const { backends: _selectedBackends, ...selectedInputs } = selectedConfig;
    // A changed source or policy is a different measurement whichever backends ran.
    if (JSON.stringify(measuredInputs) !== JSON.stringify(selectedInputs)) return true;
    if (!selectedConfig.backends) {
      // Nothing is named, so the selection is "every backend the driver
      // implements" -- and only the driver knows what that is. The measurement
      // itself answers whether it covered them: `implemented_but_not_probed` is
      // the list of backends that exist and were not run, and an empty one is a
      // complete measurement.
      //
      // Without this the unnamed selection could never equal any recorded
      // config, and the probe would re-run on every pass -- roughly ninety
      // seconds of renderer measurement per supervisor pass, to re-learn what
      // the file on disk already said.
      const unprobed = parsed.implemented_but_not_probed;
      if (!Array.isArray(unprobed)) return true;   // an older inventory cannot say
      return unprobed.length > 0;
    }
    return JSON.stringify(measuredConfig) !== JSON.stringify(selectedConfig);
  } catch {
    return true;
  }
}

function buildRolePlan({ prompt, lane, cycleId = null, researchStage = "evidence", cyclePlanningContext = null }) {
  const laneId = lane.lane_id;
  const routingChanged = lane.model_pin || lane.pinned_model || lane.retry_count > 0 || lane.failure_category;
  const modelRoute = !usesDirectModelApi(lane) && !routingChanged && lane.model_route && typeof lane.model_route === "object"
    ? lane.model_route
    : chooseModelRoute({
      role: lane.role,
      runtime: lane.agent_runtime || process.env.RESEARCHLAB_AGENT_RUNTIME || "codex",
      runtimeClass: lane.runtime_class,
      laneMode: lane.lane_mode,
      prompt,
      actionType: lane.action_type,
      complexityScore: lane.complexity_score,
      estimatedPromptBytes: lane.estimated_prompt_bytes,
      retryCount: lane.retry_count,
      failureCategory: lane.failure_category,
      scientificStakes: lane.scientific_stakes,
      adjudicationRequired: lane.adjudication_required,
      candidateCount: lane.candidate_count,
      modelPin: lane.model_pin || lane.pinned_model,
      billingMode: lane.billing_mode,
      authentication: lane.authentication,
    });
  // `assigned_model` is consumed by the native harness today. Keep it while
  // persisting the richer route alongside it for future runtime support.
  const assignedModel = modelRoute.model || lane.model || null;
  let rolePlan;

  switch (lane.role) {
    case "lab-director": {
      const stage = String(researchStage || "evidence");
      const gateRestartPolicy = gateRestartPolicyFromContext(cyclePlanningContext);
      rolePlan = {
        lane_id: laneId,
        role: lane.role,
        source: "lab-director",
        prompt,
        assigned_model: assignedModel,
        action_type: gateRestartPolicy?.required
          ? "gate_restart_followup"
          : stage === "gate"
            ? "lab_director_requery_followup"
            : "hypothesis_strategy_followup",
        research_goal:
          "own scientific direction: generate impact-first hypotheses that DIRECTLY TEST THE RESEARCH OBJECTIVE'S OWN QUESTION WITH THE OBJECTIVE'S OWN METHOD, select or pivot the lead by scientific merit + objective fit FIRST, and assign validation work only after candidate families are ranked against the current state of the art. Data availability is a tie-breaker among well-fitting hypotheses, NOT a primary selection criterion.",
        // OBJECTIVE-FIT GATE (owner decision 2026-07-06): the lead must be an
        // on-objective hypothesis. For an objective like "computer graphics
        // rendering-algorithm research with REAL rendering experiments", the lead
        // must be a rendering-algorithm claim validated by an ACTUAL rendering
        // experiment (e.g. a Mitsuba render), NOT a benchmark-CSV statistical
        // comparison of engines (e.g. "Vulkan vs Unity FPS on a Zenodo CSV").
        // "the dataset is already materialized / this is the strongest EVALUABLE
        // lead" is NOT a valid reason to select an OFF-OBJECTIVE hypothesis — a
        // well-fitting hypothesis that still needs a real experiment BEATS a
        // convenient off-objective data comparison.
        objective_fit_rule:
          "Reject any lead that does not test the OBJECTIVE'S actual question with the OBJECTIVE'S actual method. Convenience of existing data must never override objective fit. If the best-fitting lead needs a real experiment with a verified instrument rather than a pre-existing CSV, choose it and materialize/repair the experiment — do NOT drift to an off-objective benchmark/statistics comparison because its data is handy.",
        // HYPOTHESIS-NARROWING PROTOCOL (owner design 2026-07-07): a creative lead
        // is not picked in one shot from the "strongest evidence cluster" — it is
        // NARROWED progressively, in DIALOGUE with the literature AND data scouts,
        // from broad trend → specific open problem → what THIS environment/data can
        // actually test. Picking the densest cluster yields a re-confirmation of an
        // established result (honest-low novelty); narrowing toward an unsolved,
        // testable-here problem is what makes the lead novel and feasible.
        // NOT DELIVERED — verified 2026-08-20. Zero role-plan.json files carry this
        // key, in v81 or in any cycle in the container's history: the Rust followup
        // builder (labdirector/followups/role_plan) writes the role plan that is
        // actually dispatched, and it composes its own plan rather than merging this
        // one. The live copy of this protocol is the inline text in
        // runtime/codex_prompt.rs, which is what produced research_problem on v81.
        // Kept in sync deliberately; edit BOTH or neither, and do not assume an edit
        // here reaches an agent — grep a dispatched lane's role-plan.json first.
        hypothesis_narrowing_protocol: [
          "STEP 0 — DECIDE THE PROBLEM BEFORE THE HYPOTHESIS (this is the cycle's first deliverable, not a preamble to one): a hypothesis written before its problem is a method looking for a use, and that is exactly how a cycle ends up re-confirming an established result with a slightly different estimator. STEPS 1-2 exist to produce ONE artifact: `research_problem` — the single question this cycle will answer, with (a) its SOURCE (a gap the field flagged, or a question no one has posed), (b) WHY IT IS NOT ALREADY ANSWERED — a missing instrument, missing data, an unexamined assumption, or simply that nobody asked, (c) for an unposed question, the EVIDENCE OF ABSENCE: the component queries you ran (objects, measured quantity, setting, instrument) showing each component is richly covered while the question itself is not, (d) WHAT CHANGES once it is answered — what someone would do differently, and (e) the instrument in THIS environment that can answer it. Only after `research_problem` is fixed do you generate candidate hypotheses, and every candidate is judged by how well it ANSWERS THAT QUESTION rather than by how publishable it sounds; the selected lead must carry `answers_research_problem` restating it. If you cannot state the question yet — the corpus is too thin to say what is unsolved, or too thin to prove a question is unasked — do NOT invent a hypothesis to fill the silence: request the missing evidence and refine. A cycle that answers a well-chosen question badly is recoverable; a cycle that answers no question at all is not.",
          "STEP 1 — SURVEY THE TREND: from the Chronicle literature graph / trend summary / scout corpus, map the field's CURRENT state of the art and its DISTINCT active research directions (what recent work actually does and claims). Do not collapse to one cluster yet.",
          "STEP 2 — FIND THE OPEN PROBLEM: identify what is still UNSOLVED, contested, or named as a limitation ACROSS that prior art — the gap the field itself flags. That is ONE of two admissible sources, and it is the ceiling-bound one: a gap the field has already flagged is a gap the field is already working on, so the best available outcome is being early to a known problem. The SECOND source, which you must also attempt: an UNPOSED PROBLEM — a question that is answerable with this environment's instruments, whose answer would change what someone does, and that NO ONE HAS ASKED. Do not look for it in the field's stated limitations; construct it, then use the literature to verify its ABSENCE rather than to find it. Name the question's components (objects, measured quantity, setting, instrument) and confirm each is well covered by prior art while the QUESTION itself is not — that is the evidence the gatekeeper needs to distinguish an unposed problem from a failed search, and without it your lead will be scored as unverified. A new TASK outranks a new method for an old task. A creative hypothesis targets an open problem, NOT a restatement of an established/textbook result.",
          "STEP 2b — NOVELTY COMES FROM THE METHOD FAMILY, NOT ONLY THE DOMAIN: novelty is scored against the METHOD/mechanism family, not the application domain or the comparator set. Name the DENSEST prior-art method family for your candidate — the family the retrieved corpus and the gatekeeper's own prior-art search will most heavily populate (using method families established by this objective's retrieved literature). Prefer an open problem whose best-fit solution is a METHOD FAMILY DIFFERENT from that densest cluster (one with a substantively different executed procedure and a documented gap in the retrieved prior art). Shifting only the DOMAIN (a fresher benchmark or condition) while keeping the saturated method family, or only strengthening comparators, lifts honest novelty at most marginally and leaves it structurally capped below the gate. Do NOT mistake a domain shift or a stronger baseline for a novelty pivot: when the gate cites named prior art and cross_family_alternatives / family_switch_recommendations, the fix is a different METHOD family, not a better comparator on the same method.",
          "STEP 2c — VALUE TEST (five checks; discard the lead if ANY fails): V1 NON-OBVIOUS — could a domain expert confidently bet on the outcome BEFORE the experiment? If yes (e.g. 'a purpose-built method beats a weaker baseline on the very condition/regime it was designed for', 'method X reduces error versus uniform sampling'), it is an EXPECTED RESULT with near-zero information value — discard. State explicitly WHY the outcome is not already predicted by the named prior art. V2 INFORMATIVE EITHER WAY — write down what is learned if the hypothesis is TRUE and what is learned if it is FALSE; both answers must be substantive (if true=trivial or false=experiment-doubted, discard). V3 STRUCTURAL CLAIM, NOT A HORSE-RACE — the claim must be about WHEN / WHY / HOW MUCH: a mechanism, a quantified trade-off, a scaling law, a failure/boundary condition (precisely when and why a method breaks), an inversion/crossover condition, or a transfer to a regime where the method was assumed not to apply. 'X beats Y' alone is a benchmark row, not knowledge. V4 NAMED DELTA vs THE STRONGEST SOTA — identify the single strongest prior method the gatekeeper's own prior-art search will surface, and state the concrete delta over THAT method; beating uniform or weak baselines does not clear the gate. V5 REAL FALSIFICATION RISK — name the specific outcome that kills the hypothesis and why that outcome is genuinely plausible; a claim that cannot fail is a demo, not science. Write the V1 justification and the V4 named-SOTA delta INTO the hypothesis statement itself so the gatekeeper sees them.",
          "STEP 2d — CROSS-DOMAIN METHOD TRANSFER (exploit the LLM advantage — transfer the METHOD, never just the story): your single biggest edge over a within-field researcher is cross-domain knowledge, and within-field method tweaks in a mature field are almost always already published. But understand HOW novelty is scored: the gatekeeper runs a prior-art search against the EXPERIMENTAL PROCEDURE the validation actually executes, not against the vocabulary of the hypothesis statement. Dressing a saturated in-field method in another field's language changes nothing — the closest prior art is still the same crowded cluster and honest novelty stays low. Observed in-cycle, and the two outcomes are the whole lesson: a lead that imported another field's LANGUAGE over an unchanged in-field method scored novelty 20, because the gatekeeper's prior-art search read straight through the framing to the same crowded cluster; a lead that imported another field's ANALYSIS DESIGN and RAN IT — the imported design was itself the experiment — scored 38, the cycle's highest. A candidate lead counts as cross-domain ONLY if the imported element changes at least one of: (i) the SAMPLING/ESTIMATION PROCEDURE actually executed, (ii) the ANALYSIS DESIGN applied to the outputs, (iii) the DATA/EXPERIMENT construction, or (iv) the QUANTITY that is measured and modeled. Three transfer shapes that satisfy this: (a) IMPORT an estimator or analysis design from another field AND RUN IT — the imported procedure must be what executes, not a lens laid over the in-field one: it replaces the estimator, the sampler, or the metric that is actually computed, and the run that produces the result is the imported design's run; (b) EXPORT this domain's methods onto a MATERIALIZED foreign regime where a core assumption measurably breaks — a regime you actually construct here, not one you name — and claim the FAILURE STRUCTURE — where and why it breaks, with the foreign regime actually constructed, not merely name-dropped; (c) TRANSFER a formal result (bound, scaling law, phase transition) into a QUANTITATIVE prediction the in-field literature does not already contain, then test that prediction. RENAME TEST (mandatory before finalizing any cross-domain lead): rewrite the hypothesis with every cross-domain word deleted, describing only what the validation will actually execute — if what remains reads as a standard in-field comparison ('method family X vs baselines under condition set Y'), the transfer is cosmetic: discard it or redo it at the procedure level. Then ask: which field's literature holds the closest prior art for that PROCEDURE? If the answer is still this domain's dense cluster, no shift happened. Generate 2-3 candidates that survive the rename test and prefer the one whose procedure-level prior art is thinnest; it must still pass STEP 2c and STEP 3.",
          "STEP 2e — INVERSION (generate at least ONE candidate of this shape and weigh it beside the STEP 2d candidates): the sharpest novelty in a mature field usually comes from reversing what the field treats as waste. Name something practitioners spend effort REMOVING, SUPPRESSING, CLAMPING, or MERELY TOLERATING — measurement noise, residual errors, sample correlation, missing observations, quantization, temporal lag — and ask what that nuisance measurably ENCODES about the system, the process, or the estimator. Then make it the INSTRUMENT rather than the enemy: 'the field removes X; X encodes Y; we estimate Y FROM X'. The shape, from another field: motion blur is normally deblurred away, yet it encodes camera and scene motion during the exposure, so a video prior can recover the whole exposure interval's dynamics from a single blurred frame — the defect became the data. This inverts an assumption rather than swapping a method family, which is why it reads as novel to a prior-art search: the closest prior work is about DELETING X, and there is little about MEASURING Y from it. An inversion candidate is subject to the same bars as everything else — it must pass the STEP 2c VALUE TEST and the STEP 2d RENAME TEST, and the validation must actually MEASURE the encoded quantity Y (with the ground truth simulation can supply) rather than re-describing an existing method as 'exploiting' X.",
          "STEP 3a — CITE THE INSTRUMENT, DO NOT GUESS AT IT: `role_plan.planner_metadata.instrument_inventory` is the record of a probe that actually ran in this container - drivers/analysis/instrument_probe.py, executed by the first lab-runner lane of the cycle. `research_problem.answerable_here_because` must name an entry from its `verified_instruments` or `measurable_quantities`. If the question needs an observable in `unavailable_instruments`, fill `research_problem.instrument_gap` and EITHER restate the question over a verified observable OR emit ONE methods_followup asking a runner lane to build the instrument and re-probe. NEVER retire a research problem for a missing instrument, and NEVER treat an absent inventory as proof of impossibility: `status: not_probed_yet` means NOT MEASURED. cycle-g-v82 is the cost of getting this wrong - told to justify answerable_here_because with no inventory to cite, the director invented an 'executable-instrument gate', cleared nothing through it, retired 100 candidate problems in a row and declared a terminal no-survivor restart: 285 lanes, 22.4MB of prompt, ZERO gate rounds in 5.5 hours. Its questions were good; it had no way to prove them answerable.",
          "STEP 3 — SCOPE TO WHAT THIS ENVIRONMENT CAN TEST (environment-fit, four checks): E1 COMPLETE-HERE, WITH A NAMED ACQUISITION PATH FOR EVERY DEPENDENCY — the full validation must be executable with ACCESSIBLE data and THIS runtime's verified instruments and methods. For EACH validation dependency (experimental inputs/data, every named comparator/baseline, every library/tool), state HOW it is obtained in this environment, in this preference order: (1) code-generable — procedural inputs / synthetic data the blueprint constructs in-code using a verified method (this IS materialization; a self-contained procedural experiment needs NO downloaded bundle); (2) installable — a library available via pip/conda/apt, named with its install command (verify package availability and installation permissions; a missing package is a setup step before it is a blocker); (3) publicly downloadable — an open dataset or benchmark asset with a verified URL/accession relevant to the objective fetched by the data scout; (4) genuinely unavailable — private/paid/human-subject/physical-apparatus dependencies. A dependency in tiers 1-3 is ACQUIRABLE and must NOT be treated as impossible: if a named SOTA comparator has no obtainable implementation here, REPLACE it with the strongest baseline you can actually run (verified reference implementations and matched-resource controls appropriate to the objective) rather than making the lead depend on the unobtainable one. ONLY a tier-4 dependency justifies discarding or reframing the claim; if the claim needs a physical experiment, large-scale training, human subjects (e.g. real JND/preference responses), or proprietary data, discard or reframe it. E2 EXPLOIT VERIFIED INSTRUMENT CAPABILITIES — choose hypothesis shapes that the available instruments can test decisively. When simulation is appropriate and verified, use the ground truth, seed replication, parameter sweeps, or controlled counterfactual pairs it actually supports to test scaling laws, failure boundaries, crossover conditions, and mechanism isolation (V3-shaped claims). Cite the measured capabilities and costs; do not assume a particular simulator or observability that has not been verified. E3 TRANSFER BOUNDARY — when validation is synthetic/procedural, state as PART OF THE CLAIM under which conditions the result should generalize beyond the synthetic setup (and test that boundary if possible). E4 BUDGET-FEASIBLE POWER — matched-time/compute comparisons with enough independent repetitions/conditions for statistical power must fit the current compute budget; a hypothesis that cannot reach significance here is untestable here. An untestable open problem must be narrowed, reframed, or exchanged for an adjacent testable one.",
          "STEP 4 — NARROW VIA SCOUT DIALOGUE (do not guess): if the corpus misses the open problem's direct prior art or the experiment's feasibility evidence, emit precise literature or data requests whose answers change a named decision. Continue only while a query can close a decision-critical coverage gap; stop when the registered coverage and saturation criteria pass, or return `insufficient_corpus` with the remaining gaps. Do not use a fixed pass count, and do not treat family-level or pseudo-ID references as verified primary evidence.",
          "STEP 5 — ASSIGN THE CORRECT ADMISSION STATE: in a literature-only cycle, select the strongest evidence-backed frontier item as `exploration_candidate_selected`, preserve unresolved novelty, and finish without dispatching Analyst or LabRunner. In a validation cycle, promote `validation_lead_ready` only after the candidate has a complete scientific contract: distinct executable procedure, verified closest prior art and exact delta, strongest simple baseline, primary estimand, smallest useful effect, falsification criterion, null contribution, instrument evidence, and bounded kill test. If no candidate is ready, report the missing contract fields and the smallest next evidence action; never fabricate readiness to keep the scheduler busy.",
          "FINALIZE only after comparing at least five procedure-distinct candidates and running the rename test against the closest prior procedure. The selected item must answer the research problem with a concrete mechanism or identification result, be informative under support and refutation, survive its strongest inversion and simple baseline, and stay within the evidence route's claim scope. Record independent novelty and impact assessments with source references; wording, citation counts, repeated agents, or a domain label cannot supply scientific merit.",
        ],
        objective: prompt,
        gate_restart_policy: gateRestartPolicy,
        decision_policy: {
          owner: "lab-director",
          must_rank_before_selecting_lead: true,
          must_fit_objective_question_and_method: true,
          must_narrow_hypothesis_from_trend_to_open_problem_to_testable: true,
          must_dialogue_with_scouts_to_narrow_before_finalizing: true,
          must_source_novelty_from_method_family_not_only_domain: true,
          must_pass_value_test_reject_expected_results: true,
          must_prefer_simulation_advantaged_claims: true,
          must_generate_cross_domain_candidate_leads_before_finalizing: true,
          cross_domain_requires_procedure_change_not_narrative: true,
          must_not_select_off_objective_lead_for_data_convenience: true,
          must_restart_from_literature_and_data_search_on_gate_reject: gateRestartPolicy?.required === true,
          must_switch_family_after_gate_reject: gateRestartPolicy?.required === true,
          must_demote_low_impact_audits: true,
          must_demote_off_objective_convenience_leads: true,
          must_score_validation_data_availability: true,
          must_name_validation_dataset_or_acquisition_path: true,
          must_assign_explicit_admission_state: true,
          literature_only_cycle_must_stop_before_validation_dispatch: true,
          validation_lead_requires_complete_scientific_contract: true,
          needs_chronicle_evidence_is_transient_not_terminal: true,
          family_level_literature_is_discovery_only: true,
          must_record_research_note_update: true,
        },
        role_boundary: supervisorLabDirectorRoleBoundary(),
        supervisor_instruction_policy: supervisorEscalationPolicy(),
        next_cycle_context: cyclePlanningContext?.next_cycle_plan || null,
      };
      break;
    }
    case "scout":
      rolePlan = { ...buildScoutQueryPlan({ prompt, laneId, cycleId, actionType: lane.action_type, cyclePlanningContext }), assigned_model: assignedModel };
      break;
    case "analyst":
      rolePlan = { ...buildAnalystQueryPlan({ prompt, laneId, cycleId, cyclePlanningContext }), assigned_model: assignedModel };
      break;
    // Provisioning is its own lane. The analyst asks for a capability, the
    // engineer proves one exists, and the runner writes code against it -- see
    // engineer/environment_plan.js for why those are three jobs and not one.
    case "engineer":
      rolePlan = {
        ...buildEngineerEnvironmentPlan({ prompt, laneId, cycleId, cyclePlanningContext }),
        assigned_model: assignedModel,
      };
      break;
    case "lab-runner":
      // The first runner lane of a cycle measures the instruments before anything
      // is hypothesised. See instrument_probe_plan.js: cycle-g-v82 retired 100
      // research problems for want of a verified instrument record, and its four
      // lab-runner lanes never ran at all because a runner waits on an analyst
      // handoff that a hypothesis-less cycle can never produce.
      //
      // Self-arming and self-disarming: the probe is chosen only while no
      // inventory exists, so it runs once per cycle and every later runner lane
      // is an ordinary validation lane.
      rolePlan = shouldProbeInstruments(laneId, cycleId)
        ? (recordInstrumentProbeAttempt(cycleId, laneId),
           buildInstrumentProbePlan({ prompt, laneId, cycleId, assignedModel }))
        : { ...buildLabRunnerAnalysisPlan({ prompt, laneId, cyclePlanningContext }), assigned_model: assignedModel };
      break;
    case "author":
      rolePlan = {
        ...buildAuthorRevisionPlan({ prompt, laneId, cycleId, cyclePlanningContext }),
        assigned_model: assignedModel,
      };
      break;
    case "illustrator":
      rolePlan = {
        ...buildIllustratorPresentationPlan({ prompt, laneId, cyclePlanningContext }),
        assigned_model: assignedModel,
      };
      break;
    case "chronicle":
      rolePlan = { ...buildChronicleBriefPlan({ prompt, laneId, cycleId }), assigned_model: assignedModel };
      break;
    case "gatekeeper": {
      // Adversarial falsifier mode: when the lane carries
      // review_mode === "falsifier" (set by the labdirector for dedicated
      // falsifier lanes) the review goal is INVERTED — the reviewer is
      // asked to find data patterns that would REFUTE the leading claim.
      // This re-uses the gatekeeper runtime / role whitelist (JS + Rust)
      // while introducing external adversarial pressure (item #4 of the
      // hypothesis-pipeline hardening pass).
      const reviewMode = String(lane?.review_mode || lane?.planner_metadata?.review_mode || "gate");
      const isFalsifier = reviewMode === "falsifier";
      const previousReviewContext = compactPreviousReviewContext(cyclePlanningContext);
      const chronicleResearchContext = compactChronicleResearchContext(cyclePlanningContext);
      const reviewGoal = isFalsifier
        ? "adversarial falsifier review: first read previous_review_context and chronicle_research_context, then identify the specific data patterns, subgroups, temporal slices, or current-literature baselines that would refute the current leading claim; propose the cheapest single test whose failure would demote the family; do NOT affirm the claim even partially if a plausible refutation is available"
        : "evaluate the active claim set against gate criteria after reading previous_review_context and chronicle_research_context; emit explicit blockers or approval signals and state whether unresolved prior review comments are resolved, still blocking, or superseded by stronger evidence";
      rolePlan = {
        lane_id: laneId,
        role: lane.role,
        source: "lab-director",
        prompt,
        assigned_model: assignedModel,
        review_mode: reviewMode,
        adversarial: isFalsifier,
        review_goal: reviewGoal,
        previous_review_context: previousReviewContext,
        chronicle_research_context: chronicleResearchContext,
        review_context_policy: {
          must_read_previous_review_comments: true,
          must_use_chronicle_research_context: true,
          previous_review_comment_sources: previousReviewContext.review_comments.map((item) => item.source).filter(Boolean),
          chronicle_context_sources: [
            "trend_summary",
            "research_trend_analysis",
            "lab_director_literature",
            "literature_graph",
            "researcher_view.chronicle_reporting",
          ],
        },
      };
      break;
    }
    case "falsifier":
      // Alias role — same runtime as gatekeeper but surfaces as a
      // distinct role for labdirector dispatch. stage_policy permits
      // this role in the gate stage. The Rust side currently maps
      // arbitrary roles through the default codex-agent path, so the
      // lane will still execute even without a bespoke handler; it
      // just won't receive gatekeeper_focus_clause injection. Prefer
      // the gatekeeper+review_mode variant above for production lanes.
      rolePlan = {
        lane_id: laneId,
        role: lane.role,
        source: "lab-director",
        prompt,
        assigned_model: assignedModel,
        review_mode: "falsifier",
        adversarial: true,
        review_goal:
          "adversarial falsifier review: your job is to break the leading claim, not support it. List concrete data patterns, subsamples, or temporal windows whose observation would demote the current incumbent family. Propose the single cheapest test whose failure would refute the claim.",
      };
      break;
    default:
      rolePlan = {
        lane_id: laneId,
        role: lane.role,
        source: "lab-director",
        prompt,
        assigned_model: assignedModel,
        note: "No specialized JS role plan is defined for this role yet.",
      };
      break;
  }

  rolePlan = { ...rolePlan, model_route: modelRoute, research_api_policy: RESEARCH_API_POLICY };
  rolePlan.followup_description = [rolePlan.followup_description, RESEARCH_API_INSTRUCTION].filter(Boolean).join("\n\n");
  rolePlan = withLabDirectorLiteratureTriagePolicy(rolePlan);
  rolePlan = withImpactFirstHypothesisMandate(rolePlan, { researchStage });

  const teamBinding = buildTeamBinding({
    cycleId,
    role: rolePlan.role,
    researchStage,
    rolePlan,
  });
  const subagent = buildSubagentRecord({
    laneId,
    role: rolePlan.role,
    activationStages: Array.isArray(lane.activation_stages) ? lane.activation_stages : [],
    agentId: lane.agent_id || null,
  });
  const contract = buildTaskContract({
    cycleId,
    laneId,
    role: rolePlan.role,
    researchStage,
    assignedModel,
    rolePlan,
    cyclePlanningContext,
  });
  const validation = validateTaskContract(contract);
  if (!validation.valid) {
    throw new Error(`invalid task contract for ${laneId}: missing ${validation.missing.join(", ")}`);
  }

  return {
    ...rolePlan,
    contract_version: contract.contract_version,
    task_id: contract.task_id,
    cycle_id: contract.cycle_id,
    control_state: contract.control_state,
    research_stage: contract.research_stage,
    task_type: contract.task_type,
    context_refs: contract.context_refs,
    constraints: contract.constraints,
    expected_output_schema_ref: contract.expected_output_schema_ref,
    expected_output_schema: contract.expected_output_schema,
    completion_requirements: contract.completion_requirements,
    provenance: contract.provenance,
    team_id: contract.team_id,
    team_goal: contract.team_goal,
    agent_id: subagent.subagent_id,
    subagent_record: subagent,
    planner_validation: validation,
    ...(teamBinding || {}),
  };
}

module.exports = {
  buildRolePlan,
};
