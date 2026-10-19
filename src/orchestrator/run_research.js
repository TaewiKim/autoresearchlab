"use strict";

const fs = require("fs");
const { raiseOnBus } = require("../reporting/message_bus");
const path = require("path");
const { inboxLog } = require("../observability/cycle_logs");

const { parseRunResearchArgs } = require("./args");
const { initResearchLab } = require("../bootstrap/init");
const {
  executeResearchCycle,
  prepareResearchCycle,
} = require("./research_cycle");
const { injectLabDirectorQueries } = require("./query_injection");
const { buildResearchSummary } = require("../reporting/research_summary");
const { refreshCycleOutputs } = require("../reporting/refresh_cycle");
const {
  approvalPassed,
  conclusionPassed,
  gatePassed,
  documentPassed,
  readResearchOutcome,
  readDecisionMode,
  readEvidenceState,
  stageForSummary,
} = require("../policy/stage_policy");
const {
  derivePassBudgetForMinimumRuntime,
  shouldStopForStageBudget,
} = require("../policy/pass_budget_policy");
const { summaryFingerprint, shouldBreakForStagnation } = require("../policy/stagnation_policy");
const { buildGraphSnapshot, writeGraphSnapshot } = require("../graph/graph_snapshot");
const { syncCycleMetadata } = require("../storage/metadata_store");
const { writeControllerEvent, appendJsonl } = require("../observability/logger");
const { quarantineAgentStateFiles } = require("./state_boundary");
const { takeMaintainerCatchUp } = require("./maintainer_catch_up");
const {
  clearProviderQuotaPause,
  clearTerminationCode,
  readTerminationCode,
  writeTerminationCode,
} = require("../reporting/termination_code");
const {
  maybeRestartAfterMaintenance,
  maybeRunMaintainer,
  recoverInterruptedRun,
} = require("./maintainer");

function sleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function refreshMalformedDerivedGateReview({ cwd, cycleId, refresh = refreshCycleOutputs }) {
  const reviewPath = path.join(cwd, ".research-lab", "state", `${cycleId}-gate-review.json`);
  if (!fs.existsSync(reviewPath)) return false;
  try {
    JSON.parse(fs.readFileSync(reviewPath, "utf8").replace(/^\uFEFF/, ""));
    return false;
  } catch {
    // MEASURED ON cycle-a-20260919, 2026-10-02: the derived review
    // contained a complete JSON document plus a concurrent writer's tail. The
    // full refresh reread that malformed value while reconciling cycle state,
    // before it could rebuild it. Hide the derived value during regeneration;
    // the atomic writer prevents another splice after it is republished.
    const malformedPath = `${reviewPath}.${process.pid}-${Date.now()}.malformed`;
    fs.renameSync(reviewPath, malformedPath);
    try {
      refresh({ cwd, cycleId });
      JSON.parse(fs.readFileSync(reviewPath, "utf8").replace(/^\uFEFF/, ""));
      fs.rmSync(malformedPath, { force: true });
      return true;
    } catch (error) {
      if (!fs.existsSync(reviewPath)) fs.renameSync(malformedPath, reviewPath);
      else fs.rmSync(malformedPath, { force: true });
      throw error;
    }
  }
}

// One run-plan call, with the maintainer (RESEARCHLAB_MAINTAINER=1) looking at
// what it left behind: a plumbing pause, a harness stop, repeated identical lane
// failures, or a native exception the self-healer could not get past. It runs
// here, between run-plan calls, because nothing holds the native binary now and
// a pause cannot keep it from running. When it commits a fix that clears the
// blocker, run-plan goes again; otherwise everything behaves as it did without
// it, the exception included. Each resume spends one of the maintainer's
// per-cycle runs, which bounds this loop.
function recordMaintenance(options, maintenance) {
  writeControllerEvent({
    cwd: options.cwd,
    cycleId: options.cycleId,
    eventType: "maintainer-run-recorded",
    payload: maintenance,
  });
  maybeRestartAfterMaintenance({ cwd: options.cwd, cycleId: options.cycleId, outcome: maintenance });
}

function executeResearchCycleWithMaintainer(options) {
  // The pass a reload skipped, on the new source, before the next run-plan.
  if (takeMaintainerCatchUp({ cwd: options.cwd, cycleId: options.cycleId })) {
    const owed = maybeRunMaintainer({ cwd: options.cwd, cycleId: options.cycleId, error: null, staleSeconds: options.staleSeconds });
    if (owed) recordMaintenance(options, owed);
  }
  for (;;) {
    let result = null;
    let error = null;
    try {
      refreshMalformedDerivedGateReview(options);
      // Agents' own files out of the harness's state; see state_boundary.js.
      quarantineAgentStateFiles({ cwd: options.cwd, cycleId: options.cycleId });
      result = executeResearchCycle(options);
    } catch (caught) {
      error = caught;
    }
    if (!error) {
      // MEASURED ON cycle-a-20260919, 2026-09-21: run-plan spent
      // 1208 minutes at gate_review, then the maintainer measured the missing
      // conclusion-review before the caller's reporting refresh could publish
      // it. Refresh derived gate state between run-plan and the maintainer so
      // the latter observes the transition that the completed run enabled.
      refreshCycleOutputs({ cwd: options.cwd, cycleId: options.cycleId });
    }
    const maintenance = maybeRunMaintainer({
      cwd: options.cwd,
      cycleId: options.cycleId,
      error,
      staleSeconds: options.staleSeconds,
    });
    if (maintenance) recordMaintenance(options, maintenance);
    if (maintenance?.resumed) continue;
    if (error) throw error;
    return result;
  }
}

function unreadLabDirectorInboxItems({ cwd, cycleId }) {
  const runtimeRoot = path.join(cwd, ".research-lab", "runtime");
  const cursorPath = path.join(runtimeRoot, `${cycleId}-labdirector-cursor.json`);
  // Called once a second while the supervisor sleeps: closed hours are counted
  // once, and only the current hour's segment is read again.
  const lineCount = inboxLog(path.join(cwd, ".research-lab"), cycleId).countRecords();
  const cursor = readJsonIfExists(cursorPath)?.offset || 0;
  return Math.max(0, lineCount - Number(cursor || 0));
}

// Periodic supervisor interrupt: when the cycle fingerprint stops advancing
// (decision latency / a stuck lab-director deliberation), nudge the LabDirector
// to author a decisive next move instead of letting the whole cycle idle on a
// slow or deferred decision. The supervisor only escalates process latency; it
// does not author the scientific choice (role boundary preserved below).
function appendLabDirectorInterrupt({ cwd, cycleId, stagnantRounds, summary, pass }) {
  const gateScore =
    summary?.gate_review?.review?.gate_score ??
    summary?.conclusion_review?.review?.conclusion_score ??
    null;
  const prompt =
    `Process latency anomaly: the cycle fingerprint has not advanced for ${stagnantRounds} supervisor pass(es) ` +
    `(gate_score=${gateScore}). Decision-making appears stalled. LabDirector must author a decisive next move NOW — ` +
    `promote or demote the current lead, nominate a genuine rival/alternative primary family, or assign the single ` +
    `highest-yield validation pass to close an open gate gap — instead of re-queueing interpretation of the same family. ` +
    `Supervisor is escalating process latency only and does not choose the hypothesis.`;
  const payload = {
    cycle_id: cycleId,
    message_id: `msg-supervisor-interrupt-${cycleId}-p${pass}-s${stagnantRounds}`,
    author: "supervisor",
    source: "run-research-supervisor",
    kind: "supervisor_instruction",
    issue_code: "supervisor_decision_latency_interrupt",
    severity: "process_latency",
    message: prompt,
    requested_action: {
      kind: "lab_director_scientific_decision_required",
      supervisor_scope: "process_escalation_only",
      supervisor_must_not_author_analysis_plan: true,
      lab_director_must_author_research_instruction: true,
      prompt,
    },
    detail: `stagnant_rounds=${stagnantRounds} gate_score=${gateScore} pass=${pass}`,
    role_boundary: {
      supervisor:
        "Own process health and decision-latency detection only; require LabDirector adjudication when the cycle stops advancing. Must not author scientific hypotheses or analysis plans.",
      lab_director:
        "Own research strategy and the concrete corrective decision (promote/demote, nominate rival family, or assign the next validation) after supervisor escalation.",
    },
  };
  // Raised on the bus, not written into the inbox.
  //
  // The inbox is an append-only event feed with a read cursor -- 1,268 chronicle
  // reports and 189 lane-failure notices on cycle-g-v89 against seven of these.
  // Only this one is a REQUEST: another role owes an answer to it, and the Rust
  // consumer spawns a lab-director lane from it. So it goes where requests live,
  // and the bus projects the line that consumer still reads. Nothing writes the
  // inbox directly any more.
  raiseOnBus({
    root: path.join(cwd, ".research-lab"),
    cycleId,
    channel: "supervisor->lab-director:interrupt",
    from: "supervisor",
    to: "lab-director",
    itemId: `decision-latency-p${pass}-s${stagnantRounds}`,
    subject: prompt,
    asksFor: "author the decisive next move, or say what you are waiting on",
    payload,
  });
}

function sleepUntilIntervention({ cwd, cycleId, totalMs }) {
  let remaining = Math.max(0, Number(totalMs || 0));
  while (remaining > 0) {
    if (unreadLabDirectorInboxItems({ cwd, cycleId }) > 0) {
      return;
    }
    const slice = Math.min(1000, remaining);
    sleepMs(slice);
    remaining -= slice;
  }
}

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeSupervisorHistory({ cwd, cycleId, history }) {
  const historyPath = path.join(
    cwd,
    ".research-lab",
    "runtime",
    `${cycleId}-supervisor-history.json`,
  );
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(
    historyPath,
    JSON.stringify(
      {
        cycle_id: cycleId,
        generated_at: new Date().toISOString(),
        passes: history,
      },
      null,
      2,
    ),
    "utf8",
  );
  return historyPath;
}

function latestRunProducedWork(result) {
  const summary = readJsonIfExists(result?.summary_path);
  const passes = Array.isArray(summary?.pass_summaries) ? summary.pass_summaries : [];
  const latestPass = passes.length > 0 ? passes[passes.length - 1] : null;
  const launched = Array.isArray(latestPass?.launched) ? latestPass.launched.length : 0;
  const createdFollowups = Array.isArray(latestPass?.created_followups)
    ? latestPass.created_followups.length
    : 0;
  return launched > 0 || createdFollowups > 0;
}

function syncControllerState({
  cwd,
  cycleId,
  prompt,
  summary,
  passHistory,
  controlState,
  researchStage = "evidence",
  writeSnapshot = true,
}) {
  const graphSnapshot = buildGraphSnapshot({
    cwd,
    cycleId,
    prompt,
    summary,
    supervisorHistory: passHistory,
    researchStage,
    controlState,
  });
  const graphSnapshotPath = writeSnapshot
    ? writeGraphSnapshot({ cwd, cycleId, snapshot: graphSnapshot })
    : null;
  const metadataDbPath = syncCycleMetadata({
    cwd,
    cycleId,
    prompt,
    controlState,
    researchStage,
    status: readResearchOutcome(summary) || (approvalPassed(summary) ? "approved" : "running"),
    graphSnapshot,
  });
  return {
    graphSnapshotPath,
    metadataDbPath,
  };
}

function recordControlState({
  cwd,
  cycleId,
  prompt,
  controlState,
  researchStage,
  summary = null,
  passHistory = [],
}) {
  const controllerArtifacts = syncControllerState({
    cwd,
    cycleId,
    prompt,
    summary,
    passHistory,
    controlState,
    researchStage,
    writeSnapshot: summary != null,
  });
  writeControllerEvent({
    cwd,
    cycleId,
    eventType: "control-state-transition",
    payload: {
      control_state: controlState,
      research_stage: researchStage,
      graph_snapshot_path: controllerArtifacts.graphSnapshotPath,
      metadata_db_path: controllerArtifacts.metadataDbPath,
    },
  });
  return controllerArtifacts;
}

function compactReview(reviewBundle, scoreKey, gateKey, blockerKey) {
  const review = reviewBundle?.review || {};
  return {
    review_path: reviewBundle?.reviewPath || null,
    mode: review.mode || null,
    score: review.score ?? review[scoreKey] ?? null,
    gate_passed: review.pass === true || review[gateKey] === true,
    blockers: Array.isArray(review.blockers)
      ? review.blockers
      : Array.isArray(review[blockerKey])
        ? review[blockerKey]
        : [],
    recommended_actions: Array.isArray(review.recommended_actions)
      ? review.recommended_actions
      : Array.isArray(review.recommended_followup_actions)
        ? review.recommended_followup_actions
        : [],
    decision_mode: review.decision_mode || null,
    decision_reason: review.decision_reason || null,
  };
}

function compactHypothesisLedger(ledgerBundle) {
  const summary = ledgerBundle?.summary || {};
  return {
    output_path: ledgerBundle?.outputPath || null,
    summary: {
      cycle_id: summary.cycle_id || null,
      generated_at: summary.generated_at || null,
      hypothesis_count: Number(summary.hypothesis_count || 0),
      promoted_count: Number(summary.promoted_count || 0),
      strengthened_count: Number(summary.strengthened_count || 0),
      challenged_count: Number(summary.challenged_count || 0),
      demoted_count: Number(summary.demoted_count || 0),
      exploratory_count: Number(summary.exploratory_count || 0),
      weak_count: Number(summary.weak_count || 0),
      robust_count: Number(summary.robust_count || 0),
      claim_count: Number(summary.claim_count || 0),
      analysis_result_count: Number(summary.analysis_result_count || 0),
      unresolved_gap_count: Number(summary.unresolved_gap_count || 0),
      focus_hypotheses: Array.isArray(summary.focus_hypotheses)
        ? summary.focus_hypotheses.slice(0, 3).map((item) => ({
            hypothesis_id: item.hypothesis_id || null,
            statement: item.statement || null,
            family_root: item.family_root || null,
            latest_status: item.latest_status || item.state || null,
            hypothesis_score: item.hypothesis_score ?? null,
            promotion_readiness_score: item.promotion_readiness_score ?? null,
            unresolved_gaps: Array.isArray(item.unresolved_gaps) ? item.unresolved_gaps.slice(0, 5) : [],
          }))
        : [],
      family_state_summary: Array.isArray(summary.family_state_summary)
        ? summary.family_state_summary.slice(0, 6)
        : [],
      family_package_ledger_path: summary.family_package_ledger_path || null,
      family_package_count: Number(summary.family_package_ledger?.family_package_count || 0),
      incumbent_family: summary.family_package_ledger?.incumbent_family || null,
      cycle_state_artifact_paths: summary.cycle_state_artifact_paths || null,
    },
  };
}

function compactResearchSummary(summary, initialized) {
  const researcherSummary = summary?.researcher_view?.summary || {};
  const literatureSummary = summary?.literature?.summary || {};
  const result = summary?.result || {};
  return {
    cycle_id: summary.cycle_id,
    prompt: summary.prompt,
    research_outcome: summary.research_outcome || researcherSummary.research_outcome || null,
    decision_mode: summary.decision_mode || researcherSummary.decision_mode || null,
    query_plan_path: summary.query_plan_path,
    materialized: {
      agent_count: summary?.materialized?.agent_count ?? null,
      agent_plan_path: summary?.materialized?.agent_plan_path || null,
      checkpoint_schedule_path: summary?.materialized?.checkpoint_schedule_path || null,
      chronicle_schedule_path: summary?.materialized?.chronicle_schedule_path || null,
      cycle_plan_path: summary?.materialized?.cycle_plan_path || null,
      lane_manifest_path: summary?.materialized?.lane_manifest_path || null,
      minimum_runtime_hours: summary?.materialized?.minimum_runtime_hours ?? null,
    },
    researcher_view: {
      path: summary?.researcher_view?.outputPath || summary?.researcher_view?.researcherViewPath || null,
      html_path: researcherSummary.html_path || summary?.researcher_view?.htmlPath || null,
      summary: {
        cycle_status: researcherSummary.cycle_status || null,
        execution_completion: researcherSummary.execution_completion || null,
        research_outcome: researcherSummary.research_outcome || null,
        decision_mode: researcherSummary.decision_mode || null,
        claim_count: Number(researcherSummary.claim_count || 0),
        open_question_count: Number(researcherSummary.open_question_count || 0),
        recommended_action_count: Number(researcherSummary.recommended_action_count || 0),
        top_paper_count: Number(researcherSummary.top_paper_count || 0),
        hypothesis_quality_score: researcherSummary.hypothesis_quality_score ?? null,
        conclusion_readiness_score: researcherSummary.conclusion_readiness_score ?? null,
        approval_readiness_score: researcherSummary.approval_readiness_score ?? null,
        approval_readiness_band: researcherSummary.approval_readiness_band || null,
        evidence_readiness: researcherSummary.evidence_readiness || null,
        approval_blockers: Array.isArray(researcherSummary.approval_blockers)
          ? researcherSummary.approval_blockers
          : [],
        analysis_scoreboard: researcherSummary.analysis_scoreboard || null,
        knowledge_graph_digest: researcherSummary.knowledge_graph_digest || null,
        focus_hypotheses: Array.isArray(researcherSummary.focus_hypotheses)
          ? researcherSummary.focus_hypotheses.slice(0, 3).map((item) => ({
              hypothesis_id: item.hypothesis_id || null,
              statement: item.statement || null,
              latest_status: item.latest_status || null,
              support_count: Number(item.support_count || 0),
            }))
          : [],
      },
    },
    literature: {
      output_path: summary?.literature?.outputPath || null,
      lane_count: Array.isArray(literatureSummary.lanes) ? literatureSummary.lanes.length : 0,
      hypothesis_count: Number(literatureSummary.hypothesis_count || 0),
      claim_count: Number(literatureSummary.claim_count || 0),
      reasoning_graph: literatureSummary.reasoning_graph || null,
    },
    hypothesis_ledger: compactHypothesisLedger(summary?.hypothesis_ledger),
    conclusion_review: compactReview(
      summary?.conclusion_review,
      "conclusion_score",
      "conclusion_gate_passed",
      "conclusion_blockers",
    ),
    approval_review: compactReview(
      summary?.approval_review,
      "approval_readiness_score",
      "all_rubrics_approved",
      "approval_blockers",
    ),
    gate_review: compactReview(
      summary?.gate_review,
      "gate_score",
      "gate_passed",
      "major_objections",
    ),
    report_review: compactReview(
      summary?.report_review,
      "report_score",
      "report_gate_passed",
      "report_blockers",
    ),
    paper_review: compactReview(
      summary?.paper_review,
      "paper_score",
      "paper_gate_passed",
      "paper_blockers",
    ),
    termination_code: summary?.termination_code || null,
    result: {
      cycle_id: result.cycle_id || summary.cycle_id,
      summary_path: result.summary_path || null,
      final_cycle_state_path: result.final_cycle_state_path || null,
      final_viz_outputs: Array.isArray(result.final_viz_outputs) ? result.final_viz_outputs : [],
      lane_manifest_path: result.lane_manifest_path || null,
      passes_completed: result.passes_completed ?? null,
    },
    auto_refinement_pass: summary.auto_refinement_pass === true,
    auto_refinement_passes: summary.auto_refinement_passes ?? 0,
    document_refinement_pass: summary.document_refinement_pass === true,
    document_refinement_passes: summary.document_refinement_passes ?? 0,
    evidence_passes: summary.evidence_passes ?? 0,
    supervisor_passes: summary.supervisor_passes ?? 0,
    supervisor_history_path: summary.supervisor_history_path || null,
    conclusion_gate_passed: summary.conclusion_gate_passed === true,
    exploratory_gate_passed: summary.exploratory_gate_passed === true,
    document_gate_passed: summary.document_gate_passed === true,
    submission_gate_passed: summary.submission_gate_passed === true,
    approval_gate_passed: summary.approval_gate_passed === true,
    continue_until_gate: summary.continue_until_gate === true,
    initialization: {
      runtime_root: initialized?.runtime_root || null,
      init_path: initialized?.init_path || null,
      metadata_db_path: initialized?.metadata_db_path || null,
      model_catalog_path: initialized?.model_catalog?.catalogPath || null,
      model_ids: Array.isArray(initialized?.model_catalog?.catalog?.models)
        ? initialized.model_catalog.catalog.models.map((item) => item.id)
        : [],
    },
    graph_snapshot_path: summary?.graph_snapshot_path || null,
    metadata_db_path: summary?.metadata_db_path || initialized?.metadata_db_path || null,
  };
}

function readCycleRunState({ cwd, cycleId }) {
  return readJsonIfExists(
    path.join(cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`),
  ) || {};
}

function maybeWriteJsFallbackTerminationCode({ cwd, cycleId, summary }) {
  const existing = readTerminationCode({ cwd, cycleId });
  if (existing?.should_stop === true) return existing;

  if (approvalPassed(summary)) {
    return writeTerminationCode({
      cwd,
      cycleId,
      code: "APPROVAL_GATE_PASSED",
      category: "gate_passed",
      reason: "approval, gate, and document checks passed",
      metadata: {
        research_outcome: readResearchOutcome(summary),
        decision_mode: readDecisionMode(summary),
      },
    }).terminationCode;
  }

  const cycleState = readCycleRunState({ cwd, cycleId });
  const laneCounts = cycleState?.lane_counts || {};
  const noRemainingLaneWork =
    Number(laneCounts.running || 0) === 0 && Number(laneCounts.pending || 0) === 0;
  const outcome = readResearchOutcome(summary);
  if (noRemainingLaneWork && ["pivot", "stopped_without_conclusion"].includes(String(outcome || ""))) {
    return writeTerminationCode({
      cwd,
      cycleId,
      code: "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK",
      category: "continuation_impossible",
      reason: "no running or pending lanes remain and the current cycle cannot advance further",
      metadata: {
        research_outcome: outcome,
        decision_mode: readDecisionMode(summary),
        lane_counts: laneCounts,
      },
    }).terminationCode;
  }

  return null;
}

function runResearch(argv, options = {}) {
  const cwd = options.cwd || process.cwd();
  const args = parseRunResearchArgs(argv);
  const env = {
    ...process.env,
  };
  if (args.maxSupervisorPasses !== null) {
    env.RESEARCHLAB_MAX_SUPERVISOR_PASSES = String(args.maxSupervisorPasses);
  }
  if (args.maxEvidencePasses !== null) {
    env.RESEARCHLAB_MAX_EVIDENCE_PASSES = String(args.maxEvidencePasses);
  }
  if (args.maxApprovalPasses !== null) {
    env.RESEARCHLAB_MAX_APPROVAL_PASSES = String(args.maxApprovalPasses);
  }
  if (args.maxDocumentPasses !== null) {
    env.RESEARCHLAB_MAX_DOCUMENT_PASSES = String(args.maxDocumentPasses);
  }
  if (args.breakOnStagnation !== null) {
    env.RESEARCHLAB_BREAK_ON_STAGNATION = args.breakOnStagnation ? "1" : "0";
  }
  if (args.agentRuntime !== null) {
    // Set on process.env so the spawned native harness (which inherits
    // process.env via runNative) picks it up. The local ``env`` object
    // here is only consulted for JS-side loop bounds. Setting this BEFORE
    // initResearchLab() is what lets the catalog generator pick the
    // claude-vs-codex variant on this run.
    process.env.RESEARCHLAB_AGENT_RUNTIME = args.agentRuntime;
    env.RESEARCHLAB_AGENT_RUNTIME = args.agentRuntime;
  }
  const effectiveAgentRuntime = (
    args.agentRuntime || process.env.RESEARCHLAB_AGENT_RUNTIME || "codex"
  );
  const maxAutoRefinementPasses = Number(
    env.RESEARCHLAB_MAX_APPROVAL_PASSES || "0",
  );
  const maxDocumentPasses = Number(
    env.RESEARCHLAB_MAX_DOCUMENT_PASSES || "0",
  );
  const maxEvidencePasses = Number(
    env.RESEARCHLAB_MAX_EVIDENCE_PASSES || "0",
  );
  const maxSupervisorPassesRaw = Number(
    env.RESEARCHLAB_MAX_SUPERVISOR_PASSES || "12",
  );
  const maxSupervisorPasses = maxSupervisorPassesRaw === 0 ? Number.POSITIVE_INFINITY : maxSupervisorPassesRaw;
  const stagnationBreakEnabled = env.RESEARCHLAB_BREAK_ON_STAGNATION === "1";
  // Before any native call: a maintainer run cut off mid-edit may have left a
  // half-changed Rust file that would stop the native rebuild.
  recoverInterruptedRun({ cwd, cycleId: args.cycleId });
  clearTerminationCode({ cwd, cycleId: args.cycleId });
  clearProviderQuotaPause({ cwd, cycleId: args.cycleId });
  const initialized = initResearchLab({ cwd });
  recordControlState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    controlState: "INIT",
    researchStage: "evidence",
  });
  recordControlState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    controlState: "PLAN",
    researchStage: "evidence",
  });
  const { materialized, queryPlanPath } = prepareResearchCycle({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    modelCatalogPath: initialized.model_catalog.catalogPath,
    researchStage: "evidence",
    runtime: effectiveAgentRuntime,
  });
  let currentQueryPlanPath = queryPlanPath;
  let currentInjectedStage = "evidence";
  recordControlState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    controlState: "DISPATCH",
    researchStage: currentInjectedStage,
  });
  const effectiveMaxPasses = args.maxPassesExplicit
    ? args.maxPasses
    : derivePassBudgetForMinimumRuntime(
        materialized?.minimum_runtime_hours,
        args.sleepSeconds,
      );
  recordControlState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    controlState: "EXECUTE",
    researchStage: currentInjectedStage,
  });
  let result = executeResearchCycleWithMaintainer({
    cwd,
    cycleId: args.cycleId,
    maxPasses: effectiveMaxPasses,
    sleepSeconds: args.sleepSeconds,
    maxConcurrency: args.maxConcurrency,
    staleSeconds: args.staleSeconds,
  });
  recordControlState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    controlState: "INGEST",
    researchStage: currentInjectedStage,
  });
  let summary = buildResearchSummary({
      cwd,
      cycleId: args.cycleId,
      prompt: args.prompt,
      queryPlanPath: currentQueryPlanPath,
      materialized,
      result,
    });

  let evidencePasses = 0;
  let autoRefinementPasses = 0;
  let documentPasses = 0;
  let supervisorPasses = 1;
  let previousFingerprint = summaryFingerprint(summary);
  let stagnantRounds = 0;
  summary.termination_code =
    maybeWriteJsFallbackTerminationCode({ cwd, cycleId: args.cycleId, summary }) ||
    readTerminationCode({ cwd, cycleId: args.cycleId });
  const passHistory = [
    {
      pass: 1,
      stage: stageForSummary(summary),
      research_outcome: readResearchOutcome(summary),
      decision_mode: readDecisionMode(summary),
      fingerprint: previousFingerprint,
      conclusion_score: summary?.conclusion_review?.review?.conclusion_score ?? null,
      conclusion_gate_passed: conclusionPassed(summary),
      gate_passed: gatePassed(summary),
      document_gate_passed: documentPassed(summary),
    },
  ];
  let controllerArtifacts = syncControllerState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    summary,
    passHistory,
    controlState: "REVIEW",
    researchStage: stageForSummary(summary),
  });
  writeControllerEvent({
    cwd,
    cycleId: args.cycleId,
    eventType: "supervisor-pass-recorded",
    payload: {
        pass: 1,
        stage: stageForSummary(summary),
        research_outcome: readResearchOutcome(summary),
        decision_mode: readDecisionMode(summary),
        query_plan_path: currentQueryPlanPath,
      graph_snapshot_path: controllerArtifacts.graphSnapshotPath,
      metadata_db_path: controllerArtifacts.metadataDbPath,
    },
  });
  writeSupervisorHistory({
    cwd,
    cycleId: args.cycleId,
    history: passHistory,
  });

  while (
    supervisorPasses < maxSupervisorPasses &&
    !(readTerminationCode({ cwd, cycleId: args.cycleId })?.should_stop === true)
  ) {
    const stage = stageForSummary(summary);
    if (shouldStopForStageBudget({
      stage,
      evidencePasses,
      autoRefinementPasses,
      documentPasses,
      maxEvidencePasses,
      maxAutoRefinementPasses,
      maxDocumentPasses,
    })) {
      writeControllerEvent({
        cwd,
        cycleId: args.cycleId,
        eventType: "supervisor-budget-cap-ignored",
        payload: {
          stage,
          evidence_passes: evidencePasses,
          approval_passes: autoRefinementPasses,
          document_passes: documentPasses,
        },
      });
    }
    if (stage !== currentInjectedStage) {
      currentQueryPlanPath = injectLabDirectorQueries({
        cwd,
        cycleId: args.cycleId,
        prompt: args.prompt,
        laneManifestPath: materialized.lane_manifest_path,
        researchStage: stage,
      });
      currentInjectedStage = stage;
      writeControllerEvent({
        cwd,
        cycleId: args.cycleId,
        eventType: "research-stage-transition",
        payload: {
          stage,
          query_plan_path: currentQueryPlanPath,
        },
      });
    }

    const evidenceState = readEvidenceState(summary);
    if (evidenceState.runningCoreLaneCount > 0) {
      sleepUntilIntervention({
        cwd,
        cycleId: args.cycleId,
        totalMs: Math.max(1000, args.sleepSeconds * 1000),
      });
    }

    recordControlState({
      cwd,
      cycleId: args.cycleId,
      prompt: args.prompt,
      controlState: "EXECUTE",
      researchStage: stage,
      summary,
      passHistory,
    });

    result = executeResearchCycleWithMaintainer({
      cwd,
      cycleId: args.cycleId,
      maxPasses: effectiveMaxPasses,
      sleepSeconds: args.sleepSeconds,
      maxConcurrency: args.maxConcurrency,
      staleSeconds: args.staleSeconds,
    });

    recordControlState({
      cwd,
      cycleId: args.cycleId,
      prompt: args.prompt,
      controlState: "INGEST",
      researchStage: stage,
      summary,
      passHistory,
    });

    summary = buildResearchSummary({
      cwd,
      cycleId: args.cycleId,
      prompt: args.prompt,
      queryPlanPath: currentQueryPlanPath,
      materialized,
      result,
    });
    summary.termination_code =
      maybeWriteJsFallbackTerminationCode({ cwd, cycleId: args.cycleId, summary }) ||
      readTerminationCode({ cwd, cycleId: args.cycleId });

    supervisorPasses += 1;
    if (stage === "evidence") evidencePasses += 1;
    if (stage === "conclusion") autoRefinementPasses += 1;
    if (stage === "document") documentPasses += 1;

    const nextFingerprint = summaryFingerprint(summary);
    stagnantRounds = nextFingerprint === previousFingerprint ? stagnantRounds + 1 : 0;
    previousFingerprint = nextFingerprint;
    passHistory.push({
      pass: supervisorPasses,
      stage: stageForSummary(summary),
      research_outcome: readResearchOutcome(summary),
      decision_mode: readDecisionMode(summary),
      fingerprint: nextFingerprint,
      conclusion_score: summary?.conclusion_review?.review?.conclusion_score ?? null,
      conclusion_gate_passed: conclusionPassed(summary),
      gate_passed: gatePassed(summary),
      document_gate_passed: documentPassed(summary),
      stagnant_rounds: stagnantRounds,
      continue_until_gate: !approvalPassed(summary),
    });
    controllerArtifacts = syncControllerState({
      cwd,
      cycleId: args.cycleId,
      prompt: args.prompt,
      summary,
      passHistory,
      controlState: "REVIEW",
      researchStage: stageForSummary(summary),
    });
    writeControllerEvent({
      cwd,
      cycleId: args.cycleId,
      eventType: "supervisor-pass-recorded",
      payload: {
        pass: supervisorPasses,
        stage: stageForSummary(summary),
        research_outcome: readResearchOutcome(summary),
        decision_mode: readDecisionMode(summary),
        stagnant_rounds: stagnantRounds,
        query_plan_path: currentQueryPlanPath,
        graph_snapshot_path: controllerArtifacts.graphSnapshotPath,
        metadata_db_path: controllerArtifacts.metadataDbPath,
      },
    });
    writeSupervisorHistory({
      cwd,
      cycleId: args.cycleId,
      history: passHistory,
    });

    const latestPassProducedWork = latestRunProducedWork(result);
    // Periodically interrupt the LabDirector while the cycle is stalled so a
    // slow or deferred decision does not block the whole pipeline. Fires once
    // per stagnant pass (passes are spaced by execution + intervention sleeps),
    // only before the gate passes. Threshold configurable; default 1.
    const interruptStagnantThreshold = Number(
      env.RESEARCHLAB_SUPERVISOR_INTERRUPT_STAGNANT_ROUNDS || "1",
    );
    if (
      stagnantRounds >= interruptStagnantThreshold &&
      !gatePassed(summary)
    ) {
      appendLabDirectorInterrupt({
        cwd,
        cycleId: args.cycleId,
        stagnantRounds,
        summary,
        pass: supervisorPasses,
      });
      writeControllerEvent({
        cwd,
        cycleId: args.cycleId,
        eventType: "supervisor-lab-director-interrupt",
        payload: {
          stagnant_rounds: stagnantRounds,
          pass: supervisorPasses,
          gate_score:
            summary?.gate_review?.review?.gate_score ??
            summary?.conclusion_review?.review?.conclusion_score ??
            null,
        },
      });
    }
    if (shouldBreakForStagnation({
      summary,
      stagnantRounds,
      stagnationBreakEnabled,
      latestPassProducedWork,
    })) {
      writeControllerEvent({
        cwd,
        cycleId: args.cycleId,
        eventType: "stagnation-detected-continue",
        payload: {
          stagnant_rounds: stagnantRounds,
          stage: stageForSummary(summary),
          latest_pass_produced_work: latestPassProducedWork,
          termination_code_present:
            readTerminationCode({ cwd, cycleId: args.cycleId })?.should_stop === true,
        },
      });
    }
  }

  summary.auto_refinement_pass = autoRefinementPasses > 0;
  summary.auto_refinement_passes = autoRefinementPasses;
  summary.document_refinement_pass = documentPasses > 0;
  summary.document_refinement_passes = documentPasses;
  summary.evidence_passes = evidencePasses;
  summary.supervisor_passes = supervisorPasses;
  summary.supervisor_history_path = writeSupervisorHistory({
    cwd,
    cycleId: args.cycleId,
    history: passHistory,
  });
  summary.conclusion_gate_passed = conclusionPassed(summary);
  summary.exploratory_gate_passed = summary.conclusion_gate_passed;
  summary.gate_passed = gatePassed(summary);
  summary.document_gate_passed = documentPassed(summary);
  summary.submission_gate_passed = summary?.paper_review?.review?.submission_gate_passed === true;
  summary.approval_gate_passed = approvalPassed(summary);
  summary.research_outcome = readResearchOutcome(summary);
  summary.decision_mode = readDecisionMode(summary);
  summary.continue_until_gate = !summary.approval_gate_passed;
  summary.termination_code =
    maybeWriteJsFallbackTerminationCode({ cwd, cycleId: args.cycleId, summary }) ||
    readTerminationCode({ cwd, cycleId: args.cycleId });
  summary.initialization = initialized;
  summary.model_catalog = initialized.model_catalog;
  controllerArtifacts = syncControllerState({
    cwd,
    cycleId: args.cycleId,
    prompt: args.prompt,
    summary,
    passHistory,
    controlState: summary?.termination_code?.should_stop === true ? "STOP" : "UPDATE",
    researchStage: stageForSummary(summary),
  });
  summary.graph_snapshot_path = controllerArtifacts?.graphSnapshotPath || null;
  summary.metadata_db_path = controllerArtifacts?.metadataDbPath || initialized.metadata_db_path || null;

  return compactResearchSummary(summary, initialized);
}

module.exports = {
  runResearch,
  __private: {
    executeResearchCycleWithMaintainer,
    refreshMalformedDerivedGateReview,
  },
};
