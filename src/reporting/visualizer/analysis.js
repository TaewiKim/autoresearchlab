"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonCached, fileSignature } = require("./json_cache");
const { buildKnowledgeGraphDigest } = require("./analysis/knowledge_graph");
const { computeEvidenceReadiness } = require("./analysis/evidence_readiness");

function rubricItem(name, score, reasons, options = {}) {
  return {
    name,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: reasons.filter(Boolean),
    applicable: options.applicable !== false,
    framework: options.framework || null,
  };
}

const RUBRIC_WEIGHTS = {
  novelty: 0.2,
  technical_quality: 0.24,
  reproducibility: 0.18,
  clarity: 0.12,
  impact: 0.14,
  consort_reporting_completeness: 0.06,
  strobe_reporting_completeness: 0.06,
};
const { GATE_THRESHOLD } = require("../../policy/research_gate");
const VISUALIZER_RESULT_MAX_BYTES = Math.max(
  256 * 1024,
  Number(process.env.RESEARCHLAB_VISUALIZER_RESULT_MAX_BYTES || 1024 * 1024),
);
const VISUALIZER_RESULT_SCAN_LIMIT = Math.max(
  40,
  Number(process.env.RESEARCHLAB_VISUALIZER_RESULT_SCAN_LIMIT || 140),
);
const VISUALIZER_RESULT_ROLE_SCAN_LIMIT = Math.max(
  20,
  Number(process.env.RESEARCHLAB_VISUALIZER_RESULT_ROLE_SCAN_LIMIT || 80),
);
// The result files a cycle's views read, good for as long as the cycle state
// and the lane tree are what they were when the list was made. It used to be
// good forever: the orchestrator listed once and every lane that finished
// afterwards stayed out of the analysis views until the process was replaced.
const RESULT_FILE_CACHE = new Map();

const readJsonIfExists = readJsonCached;

function resultFileListSignature(root, cycleId) {
  return [
    path.join(root, "state", `${cycleId}-cycle-run-state.json`),
    path.join(root, "artifacts", "stats", cycleId),
    path.join(root, "lanes", cycleId),
  ].map(fileSignature).join("|");
}

function rememberResultFiles(cacheKey, signature, files) {
  RESULT_FILE_CACHE.set(cacheKey, { signature, files });
  return files;
}

function weightedScore(items) {
  const applicableItems = items.filter((item) => item?.applicable !== false);
  if (!applicableItems.length) return 0;
  let numerator = 0;
  let denominator = 0;
  for (const item of applicableItems) {
    const weight = RUBRIC_WEIGHTS[item.name] || 0;
    numerator += item.score * weight;
    denominator += weight;
  }
  if (denominator === 0) return 0;
  return Math.round(numerator / denominator);
}

function inferStudyDesignProfile(text) {
  const source = String(text || "").toLowerCase();
  const explicitTrialAnchor =
    /randomi[sz]ed trial|clinicaltrials\.gov|isrctn|trial registration|\brct\b/.test(source);
  const randomizedSignals = [
    /randomi[sz]ed trial/,
    /\brct\b/,
    /allocation concealment/,
    /\bblinding\b/,
    /\bcomparator\b/,
    /\bintervention\b/,
    /\btrial registration\b/,
    /\bparallel group\b/,
  ].filter((pattern) => pattern.test(source)).length;
  const observationalSignals = [
    /\bobservational\b/,
    /\bcohort\b/,
    /case-control/,
    /cross-sectional/,
    /\becological\b/,
    /\bpanel data\b/,
    /\bregistry\b/,
    /\bpopulation-level\b/,
  ].filter((pattern) => pattern.test(source)).length;
  return {
    randomized: explicitTrialAnchor && randomizedSignals >= 2,
    observational: observationalSignals >= 1 || randomizedSignals === 0,
  };
}

function reportingCompleteness({ name, framework, applicable, text, checks, boost = 0 }) {
  if (!applicable) {
    return rubricItem(name, 100, [], { applicable: false, framework });
  }
  const covered = checks.filter((item) => item.pattern.test(text));
  const coveredWeight = covered.reduce((sum, item) => sum + item.weight, 0);
  const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0) || 1;
  const missing = checks.filter((item) => !item.pattern.test(text));
  return rubricItem(
    name,
    28 + (coveredWeight / totalWeight) * 72 + boost,
    missing.slice(0, 4).map((item) => item.reason),
    { framework },
  );
}

function listLaneDirs(root, cycleId) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  return fs.readdirSync(lanesRoot).map((laneId) => path.join(lanesRoot, laneId));
}

function summarizeFollowupEvidence(result) {
  if (!result || typeof result !== "object") {
    return { signal: 0, summary: "no result yet" };
  }

  if (Array.isArray(result.selected_hypotheses)) {
    const robustCount = result.selected_hypotheses.filter((item) => item.status === "robust").length;
    const exploratoryCount = result.selected_hypotheses.filter((item) => item.status === "exploratory").length;
    const validationSummary = result.validation_summary || {};
    const validationBoost = Math.round(
      (Number(validationSummary.method_appropriateness_score || 0) +
        Number(validationSummary.analysis_accuracy_score || 0)) / 20,
    );
    const signal = Math.min(18, robustCount * 3 + exploratoryCount + validationBoost);
    return {
      signal,
      summary: `selected hypotheses: ${result.selected_hypotheses.length}, robust: ${robustCount}, exploratory: ${exploratoryCount}, method score: ${validationSummary.method_appropriateness_score || 0}, accuracy score: ${validationSummary.analysis_accuracy_score || 0}`,
    };
  }

  if (typeof result.paper_count === "number") {
    const signal = Math.min(10, Math.floor(result.paper_count / 2));
    return {
      signal,
      summary: `papers collected: ${result.paper_count}`,
    };
  }

  if (result.status === "prepared") {
    return { signal: 1, summary: "prepared but not executed" };
  }

  return { signal: 2, summary: "completed without specialized evidence summary" };
}

function collectFollowupRubricProgress({ root, cycleId }) {
  const summaryByRubric = new Map();
  const scanLimit = Math.max(
    40,
    Number(process.env.RESEARCHLAB_VISUALIZER_FOLLOWUP_SCAN_LIMIT || 180),
  );
  const laneDirs = listLaneDirs(root, cycleId)
    .filter((laneDir) => path.basename(laneDir).startsWith("followup-"))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), undefined, { numeric: true }))
    .slice(-scanLimit);

  for (const laneDir of laneDirs) {
    const rolePlanPath = path.join(laneDir, "role-plan.json");
    if (!fs.existsSync(rolePlanPath)) continue;

    const rolePlan = readJsonIfExists(rolePlanPath, 5 * 1024 * 1024);
    if (!rolePlan || rolePlan.source !== "lab-director-followup") continue;

    const targetRubric = rolePlan.planner_metadata?.target_rubric;
    if (!targetRubric) continue;

    const laneId = path.basename(laneDir);
    const finalStatusPath = path.join(laneDir, "final-status.json");
    const resultPath = path.join(laneDir, "result.json");
    const finalStatus = readJsonIfExists(finalStatusPath, 1024 * 1024);
    const result = readJsonIfExists(resultPath, VISUALIZER_RESULT_MAX_BYTES);
    const status = finalStatus?.status || "pending";
    const evidence = summarizeFollowupEvidence(result);

    if (!summaryByRubric.has(targetRubric)) {
      summaryByRubric.set(targetRubric, {
        rubric: targetRubric,
        planned: 0,
        completed: 0,
        failed: 0,
        evidence_signal: 0,
        lanes: [],
      });
    }

    const bucket = summaryByRubric.get(targetRubric);
    bucket.planned += 1;
    if (status === "completed" || status === "prepared") bucket.completed += 1;
    if (status === "failed" || status === "aborted") bucket.failed += 1;
    bucket.evidence_signal += evidence.signal;
    bucket.lanes.push({
      lane_id: laneId,
      role: rolePlan.role,
      action_type: rolePlan.action_type,
      status,
      current_score: rolePlan.planner_metadata?.current_score ?? null,
      target_score: rolePlan.planner_metadata?.target_score ?? null,
      blocker_reasons: rolePlan.planner_metadata?.blocker_reasons || [],
      evidence_summary: evidence.summary,
    });
  }

  return Array.from(summaryByRubric.values()).map((item) => ({
    ...item,
    boost: Math.min(18, item.completed * 4 + item.evidence_signal - item.failed * 3),
  }));
}

function collectAnalysisValidationSignals({ root, cycleId }) {
  const scores = {
    method_appropriateness: [],
    analysis_accuracy: [],
    visualization_quality: [],
  };

  const finiteScore = (value) => {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  for (const resultPath of listCycleResultFiles(root, cycleId)) {
    const result = readJsonIfExists(resultPath, VISUALIZER_RESULT_MAX_BYTES) || {};
    const validation = result.validation_summary || {};
    const methodScore = finiteScore(validation.method_appropriateness_score);
    const accuracyScore = finiteScore(validation.analysis_accuracy_score);
    if (methodScore != null) scores.method_appropriateness.push(methodScore);
    if (accuracyScore != null) scores.analysis_accuracy.push(accuracyScore);
    const figureSpecPath = result.figure_spec_path;
    if (figureSpecPath && fs.existsSync(figureSpecPath)) {
      const figureSpec = readJsonIfExists(figureSpecPath, 5 * 1024 * 1024) || {};
      const figureCount = Array.isArray(figureSpec.figures) ? figureSpec.figures.length : 0;
      scores.visualization_quality.push(Math.min(100, 45 + figureCount * 10));
    }
  }

  return scores;
}

function listCycleResultFiles(root, cycleId) {
  const cacheKey = `${root}:${cycleId}:${VISUALIZER_RESULT_SCAN_LIMIT}`;
  const signature = resultFileListSignature(root, cycleId);
  const listed = RESULT_FILE_CACHE.get(cacheKey);
  if (listed && listed.signature === signature) return listed.files;
  const laneSort = (left, right) =>
    String(left.lane_id || left).localeCompare(String(right.lane_id || right), undefined, { numeric: true });
  const resultFilesFromStatuses = (statuses) =>
    statuses
      .map((item) => item.result_path || path.join(root, "lanes", cycleId, String(item.lane_id || ""), "result.json"))
      .map((filePath) => {
        if (!filePath || !fs.existsSync(filePath)) return null;
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > VISUALIZER_RESULT_MAX_BYTES) return null;
          return { filePath, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.mtime - right.mtime || left.filePath.localeCompare(right.filePath))
      .map((item) => item.filePath);
  const cycleStatePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const laneStatuses = ((readJsonIfExists(cycleStatePath, 25 * 1024 * 1024) || {}).lane_statuses || [])
    .filter((item) => item && typeof item === "object");
  if (laneStatuses.length > 0) {
    const primary = laneStatuses.filter((item) => !String(item.lane_id || "").startsWith("followup-"));
    const criticalRoles = new Set(["analyst", "lab-runner", "data-fetcher"]);
    const followups = laneStatuses.filter((item) => String(item.lane_id || "").startsWith("followup-"));
    const critical = [];
    for (const role of criticalRoles) {
      critical.push(
        ...followups
          .filter((item) => item.role === role)
          .sort(laneSort)
          .slice(-VISUALIZER_RESULT_ROLE_SCAN_LIMIT),
      );
    }
    const recentOtherFollowups = followups
      .filter((item) => !criticalRoles.has(item.role))
      .sort(laneSort)
      .slice(-Math.max(20, Math.floor(VISUALIZER_RESULT_SCAN_LIMIT / 3)));
    const byLaneId = new Map();
    for (const item of primary.concat(critical, recentOtherFollowups)) {
      const laneId = String(item?.lane_id || "").trim();
      if (laneId && !byLaneId.has(laneId)) byLaneId.set(laneId, item);
    }
    return rememberResultFiles(cacheKey, signature, resultFilesFromStatuses(Array.from(byLaneId.values())));
  }

  const statsDir = path.join(root, "artifacts", "stats", cycleId);
  if (fs.existsSync(statsDir)) {
    const files = fs.readdirSync(statsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
      .slice(-VISUALIZER_RESULT_SCAN_LIMIT)
      .map((entry) => path.join(statsDir, entry.name, "result.json"))
      .filter((filePath) => {
        if (!fs.existsSync(filePath)) return false;
        try { return fs.statSync(filePath).size <= VISUALIZER_RESULT_MAX_BYTES; } catch { return false; }
      });
    return rememberResultFiles(cacheKey, signature, files);
  }

  const laneIds = new Set(
    ((readJsonIfExists(cycleStatePath, 25 * 1024 * 1024) || {}).lane_statuses || [])
      .map((item) => String(item?.lane_id || "").trim())
      .filter(Boolean),
  );
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (fs.existsSync(lanesRoot)) {
    fs.readdirSync(lanesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => laneIds.add(entry.name));
  }
  const files = Array.from(laneIds)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .slice(-VISUALIZER_RESULT_SCAN_LIMIT)
    .map((laneId) => path.join(lanesRoot, laneId, "result.json"))
    .filter((filePath) => {
      if (!fs.existsSync(filePath)) return false;
      try { return fs.statSync(filePath).size <= VISUALIZER_RESULT_MAX_BYTES; } catch { return false; }
    });
  return rememberResultFiles(cacheKey, signature, files);
}

function collectAnalysisTraces({ root, cycleId }) {
  const resultFiles = listCycleResultFiles(root, cycleId);
  const traces = [];

  for (const filePath of resultFiles) {
    const result = readJsonIfExists(filePath, VISUALIZER_RESULT_MAX_BYTES) || {};
    const tracePath = result.analysis_trace_path;
    if (!tracePath || !fs.existsSync(tracePath)) continue;
    const trace = readJsonIfExists(tracePath, VISUALIZER_RESULT_MAX_BYTES) || {};
    traces.push({
      lane_id: path.basename(path.dirname(filePath)),
      framework: trace.framework || null,
      analysis_mode: trace.analysis_mode || null,
      stages: Array.isArray(trace.stages) ? trace.stages.map((item) => item.stage).filter(Boolean) : [],
      gates: Array.isArray(trace.stages)
        ? trace.stages.map((item) => ({
            stage: item.stage || null,
            status: item.quality_gate?.status || null,
          }))
        : [],
      path: tracePath,
    });
  }

  return {
    analysis_trace_count: traces.length,
    analysis_traces: traces.slice(0, 12),
  };
}

function collectOpenEndedExperiments({ root, cycleId }) {
  const resultFiles = listCycleResultFiles(root, cycleId);
  const experiments = [];
  let completedCount = 0;
  let newHypothesisCount = 0;
  let figureIdeaCount = 0;

  for (const filePath of resultFiles) {
    const result = readJsonIfExists(filePath, VISUALIZER_RESULT_MAX_BYTES) || {};
    const experiment = result.experiment_result;
    if (!experiment || typeof experiment !== "object") continue;
    const newHypotheses = Array.isArray(experiment.new_hypotheses) ? experiment.new_hypotheses : [];
    const figureIdeas = Array.isArray(experiment.figure_ideas) ? experiment.figure_ideas : [];
    if (experiment.status === "completed") completedCount += 1;
    newHypothesisCount += newHypotheses.length;
    figureIdeaCount += figureIdeas.length;
    experiments.push({
      lane_id: path.basename(path.dirname(filePath)),
      status: experiment.status || "unknown",
      summary: experiment.experiment_summary || experiment.reason || null,
      derived_metrics: Array.isArray(experiment.derived_metrics) ? experiment.derived_metrics.slice(0, 8) : [],
      executed_checks: Array.isArray(experiment.executed_checks) ? experiment.executed_checks.slice(0, 8) : [],
      new_hypotheses: newHypotheses.slice(0, 4),
      figure_ideas: figureIdeas.slice(0, 4),
      path: result.experiment_result_path || null,
      script_path: experiment.script_path || null,
    });
  }

  return {
    open_ended_experiment_count: experiments.length,
    open_ended_experiment_completed_count: completedCount,
    open_ended_new_hypothesis_count: newHypothesisCount,
    open_ended_figure_idea_count: figureIdeaCount,
    open_ended_experiments: experiments.slice(0, 12),
  };
}

function collectAnalysisScoreboard({ root, cycleId }) {
  const resultFiles = listCycleResultFiles(root, cycleId);
  const laneRows = [];

  const finiteScore = (value) => {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  for (const filePath of resultFiles) {
    const result = readJsonIfExists(filePath, VISUALIZER_RESULT_MAX_BYTES) || {};
    const validation = result.validation_summary;
    if (!validation || typeof validation !== "object") continue;
    const methodScore = finiteScore(validation.method_appropriateness_score);
    const accuracyScore = finiteScore(validation.analysis_accuracy_score);
    laneRows.push({
      lane_id: path.basename(path.dirname(filePath)),
      method_appropriateness_score: methodScore,
      analysis_accuracy_score: accuracyScore,
      selected_family_roots: Array.isArray(validation.selected_family_roots) ? validation.selected_family_roots : [],
      selected_grade_counts: validation.selected_grade_counts || {},
      generated_grade_counts: validation.generated_grade_counts || {},
      selected_exploratory_share: Number(validation.selected_exploratory_share || 0),
      generated_exploratory_share: Number(validation.generated_exploratory_share || 0),
      competition_penalty: Number(validation.competition_penalty || 0),
      exploratory_penalty: Number(validation.exploratory_penalty || 0),
      concentration_penalty: Number(validation.concentration_penalty || 0),
    });
  }

  const familyCounts = new Map();
  const selectedGradeTotals = { robust: 0, exploratory: 0, weak: 0 };
  const generatedGradeTotals = { robust: 0, exploratory: 0, weak: 0 };
  let minMethod = null;
  let maxMethod = null;
  let minAccuracy = null;
  let maxAccuracy = null;

  laneRows.forEach((row) => {
    row.selected_family_roots.forEach((familyRoot) => {
      familyCounts.set(familyRoot, Number(familyCounts.get(familyRoot) || 0) + 1);
    });
    ["robust", "exploratory", "weak"].forEach((key) => {
      selectedGradeTotals[key] += Number(row.selected_grade_counts[key] || 0);
      generatedGradeTotals[key] += Number(row.generated_grade_counts[key] || 0);
    });
    if (row.method_appropriateness_score != null) {
      minMethod = minMethod == null ? row.method_appropriateness_score : Math.min(minMethod, row.method_appropriateness_score);
      maxMethod = maxMethod == null ? row.method_appropriateness_score : Math.max(maxMethod, row.method_appropriateness_score);
    }
    if (row.analysis_accuracy_score != null) {
      minAccuracy = minAccuracy == null ? row.analysis_accuracy_score : Math.min(minAccuracy, row.analysis_accuracy_score);
      maxAccuracy = maxAccuracy == null ? row.analysis_accuracy_score : Math.max(maxAccuracy, row.analysis_accuracy_score);
    }
  });

  return {
    lane_count: laneRows.length,
    score_ranges: {
      method_appropriateness: { min: minMethod, max: maxMethod },
      analysis_accuracy: { min: minAccuracy, max: maxAccuracy },
    },
    selected_grade_totals: selectedGradeTotals,
    generated_grade_totals: generatedGradeTotals,
    family_coverage: Array.from(familyCounts.entries())
      .map(([family_root, lane_count]) => ({ family_root, lane_count }))
      .sort((a, b) => b.lane_count - a.lane_count || a.family_root.localeCompare(b.family_root))
      .slice(0, 8),
    lane_rows: laneRows.slice(0, 12),
  };
}

// Copied as-is from researcher_view.js to preserve behavior while shrinking the main module.
function computeConclusionReadiness(args) {
  const {
    report,
    literature,
    laneCounts,
    topPapers,
    claims,
    focusHypotheses,
    hypothesisLedger,
    familyNomination,
    familyTournament,
    followupProgress,
    validationSignals,
    projectionCount,
  } = args;
  const claimCount = Array.isArray(claims) ? claims.length : Number(report.claim_count || 0);
  const supportingClaimCount = Number(report.supporting_claim_count || 0);
  const openQuestionCount = Number(report.open_question_count || 0);
  const recommendedActionCount = Number(report.recommended_action_count || 0);
  const completedLaneCount = Number(laneCounts.completed || 0);
  const completedExperimentLaneCount = Number(report.completed_experiment_lanes || 0);
  const reportTopPaperCount = Number(topPapers.length || 0);
  const literatureTopPaperCount = Array.isArray(literature.top_papers) ? literature.top_papers.length : 0;
  const hypothesisPaperCount = new Set(
    (focusHypotheses || []).flatMap((item) => item.paper_examples || []).map((item) => String(item).trim()).filter(Boolean),
  ).size;
  const ledgerPaperCount = new Set(
    ((hypothesisLedger && Array.isArray(hypothesisLedger.hypotheses) ? hypothesisLedger.hypotheses : []) || [])
      .flatMap((item) => item.paper_examples || [])
      .map((item) => String(item).trim())
      .filter(Boolean),
  ).size;
  const claimSupportPaperCount = new Set(
    (claims || [])
      .flatMap((item) => item.supporting_papers || [])
      .map((item) => String(item).trim())
      .filter(Boolean),
  ).size;
  const tracedLaneCount = new Set(
    (claims || [])
      .flatMap((item) => item.supporting_lanes || [])
      .map((item) => String(item).trim())
      .filter(Boolean),
  ).size;
  const citedClaimCount = (claims || []).filter((item) => Array.isArray(item.supporting_papers) && item.supporting_papers.length > 0).length;
  const tracedClaimCount = (claims || []).filter((item) => {
    const papers = Array.isArray(item.supporting_papers) ? item.supporting_papers.length : 0;
    const lanes = Array.isArray(item.supporting_lanes) ? item.supporting_lanes.length : 0;
    return papers > 0 || lanes > 0;
  }).length;
  const promotedCount = Number(hypothesisLedger?.promoted_count || 0);
  const schemaQuality = hypothesisLedger?.schema_quality || {};
  const reasoningGraph = hypothesisLedger?.knowledge_graph?.reasoning_graph || {};
  const derivableHypothesisCandidates = Array.isArray(hypothesisLedger?.derivable_hypothesis_candidates)
    ? hypothesisLedger.derivable_hypothesis_candidates
    : [];
  const hypothesisCount = Number(literature.hypothesis_count || 0);
  const robustFocusHypothesisCount = (focusHypotheses || []).filter(
    (item) => String(item?.latest_status || item?.state || "").toLowerCase() === "robust" ||
      String(item?.state || "").toLowerCase() === "promoted-to-claim" ||
      String(item?.state || "").toLowerCase() === "provisionally_promoted",
  ).length;
  const hypothesisQualityScore = Number(hypothesisLedger?.average_evidence_quality_score || 0);
  const mechanismCoverage =
    hypothesisCount > 0 ? Number(schemaQuality.mechanism_node_count || 0) / hypothesisCount : 0;
  const moderatorCoverage =
    hypothesisCount > 0 ? Number(schemaQuality.moderator_node_count || 0) / hypothesisCount : 0;
  const confounderCoverage =
    hypothesisCount > 0 ? Number(schemaQuality.confounder_node_count || 0) / hypothesisCount : 0;
  const falsificationCoverage =
    hypothesisCount > 0 ? Number(schemaQuality.falsification_test_count || 0) / hypothesisCount : 0;
  const bridgeEdgeCount = Number(hypothesisLedger?.knowledge_graph?.bridge_graph?.bridge_edge_count || 0);
  const reasoningClaimCount = Number(reasoningGraph.claim_count || 0);
  const reasoningAnalysisCount = Number(reasoningGraph.analysis_result_count || 0);
  const reasoningTestCount = Number(reasoningGraph.test_count || 0);
  const unresolvedGapCount = Number(reasoningGraph.unresolved_gap_count || 0);
  const targetReasoningClaims = Math.max(2, Math.min(6, claimCount * 2));
  const targetReasoningTests = Math.max(4, Math.min(12, claimCount * 3));
  const acceptableGapCount = Math.max(4, Math.ceil(hypothesisCount * 0.8));
  const graphGenerationScore = Math.round(
    Math.min(
      100,
      mechanismCoverage * 18 +
        moderatorCoverage * 16 +
        confounderCoverage * 8 +
        falsificationCoverage * 14 +
        Math.min(18, reasoningClaimCount * 2) +
        Math.min(16, reasoningAnalysisCount / 6) +
        Math.min(14, reasoningTestCount * 2) +
        Math.max(0, 12 - Math.max(0, unresolvedGapCount - acceptableGapCount)) +
        Math.min(24, derivableHypothesisCandidates.length * 3) +
        Math.min(20, bridgeEdgeCount / 12),
    ),
  );
  function brainstormFamilyTagFromId(hypothesisId) {
    const value = String(hypothesisId || "").trim();
    if (value.startsWith("hyp-alternative-")) return "alternative";
    if (value.startsWith("hyp-moderator-")) return "moderator";
    if (value.startsWith("hyp-threshold-")) return "threshold";
    if (value.startsWith("hyp-rival-")) return "rival";
    if (value.startsWith("hyp-high-upside-")) return "high-upside";
    return "";
  }
  const ledgerHypotheses = Array.isArray(hypothesisLedger?.hypotheses)
    ? hypothesisLedger.hypotheses
    : [];
  const brainstormPool = ledgerHypotheses.filter((item) => brainstormFamilyTagFromId(item?.hypothesis_id));
  const brainstormFamilies = new Map();
  for (const item of brainstormPool) {
    const familyTag = brainstormFamilyTagFromId(item?.hypothesis_id);
    if (!familyTag) continue;
    const supportBasis = Array.isArray(item.support_basis) ? item.support_basis : [];
    const supportRoles = Array.isArray(item.evidence_roles) ? item.evidence_roles : [];
    const clusterKey = String(item.cluster_key || "").trim();
    const evidenceQuality = Number(item.evidence_quality_score || 0);
    const selected = Boolean(
      clusterKey &&
      (
        (focusHypotheses || []).some((candidate) => String(candidate.cluster_key || "").trim() === clusterKey) ||
        ledgerHypotheses.some((candidate) => String(candidate.cluster_key || "").trim() === clusterKey && (candidate.support_count || 0) >= 1)
      ),
    );
    const crossGrounded =
      supportBasis.includes("data") &&
      supportBasis.includes("literature") &&
      supportRoles.includes("lab-runner") &&
      supportRoles.includes("analyst");
    const strongDataGrounded =
      supportBasis.includes("data") &&
      supportRoles.includes("lab-runner") &&
      (evidenceQuality >= 65 || Number(item.support_count || 0) >= 8) &&
      (
        String(item.latest_status || item.state || "").toLowerCase() === "robust" ||
        String(item.state || "").toLowerCase() === "promoted-to-claim" ||
        String(item.state || "").toLowerCase() === "strengthened"
      );
    const robust =
      String(item.latest_status || item.state || "").toLowerCase() === "robust" ||
      String(item.state || "").toLowerCase() === "promoted-to-claim";
    if (!brainstormFamilies.has(familyTag)) {
      brainstormFamilies.set(familyTag, {
        familyTag,
        qualified: false,
        clusterKey,
      });
    }
    const current = brainstormFamilies.get(familyTag);
    if (selected && (crossGrounded || strongDataGrounded) && (robust || evidenceQuality >= 80)) {
      current.qualified = true;
      if (clusterKey) current.clusterKey = clusterKey;
    }
  }
  const qualifiedBrainstormFamilies = Array.from(brainstormFamilies.values()).filter(
    (item) => item.qualified,
  );
  const brainstormFamilyCount = qualifiedBrainstormFamilies.length;
  const brainstormClusterDiversity = new Set(
    qualifiedBrainstormFamilies.map((item) => item.clusterKey).filter(Boolean),
  ).size;
  const clusterDiversity = new Set(
    (focusHypotheses || []).map((item) => String(item.cluster_key || "").trim()).filter(Boolean),
  ).size;
  const familyNominationRows = Array.isArray(familyNomination) ? familyNomination : [];
  const familyTournamentData = familyTournament && typeof familyTournament === "object" ? familyTournament : {};
  const nominatedFamilyRoots = new Set();
  const strongNominatedFamilyRoots = new Set();
  const nonGenericStrongFamilyRoots = new Set();
  const strongFamilyStatuses = new Set([
    "robust",
    "strengthened",
    "contending",
    "challenged",
    "provisionally_promoted",
    "promoted-to-claim",
  ]);
  for (const item of familyNominationRows) {
    const familyRoot = String(item?.family_root || item?.family_id || "").trim();
    if (!familyRoot) continue;
    nominatedFamilyRoots.add(familyRoot);
    const supportCount = Number(item?.support_count || 0);
    const hypothesisFamilyCount = Number(item?.hypothesis_count || 0);
    const distinctivenessScore = Number(item?.distinctiveness_score || item?.family_distinctiveness_score || 0);
    const status = String(item?.state || item?.latest_status || "").toLowerCase();
    const strong =
      supportCount >= 2 &&
      hypothesisFamilyCount >= 1 &&
      (distinctivenessScore >= 55 || strongFamilyStatuses.has(status));
    if (!strong) continue;
    strongNominatedFamilyRoots.add(familyRoot);
    if (!/^unclassified/i.test(familyRoot)) {
      nonGenericStrongFamilyRoots.add(familyRoot);
    }
  }
  const tournamentFamilyCount = Number(
    familyTournamentData.family_count ||
      familyTournamentData.contender_count ||
      (Array.isArray(familyTournamentData.families) ? familyTournamentData.families.length : 0) ||
      (Array.isArray(familyTournamentData.family_rankings) ? familyTournamentData.family_rankings.length : 0) ||
      0,
  );
  const activeFamilyDiversity = Math.max(
    brainstormFamilyCount,
    strongNominatedFamilyRoots.size,
    nonGenericStrongFamilyRoots.size,
    tournamentFamilyCount,
  );
  const claimReasons = claims.map((claim) => String(claim.reason || ""));
  const hasSubgroupReasoning = claimReasons.some((item) => /subgroup|group|moderat|heterogene/i.test(item));
  const familyReasoningText = familyNominationRows.map((item) => [
    item?.family_root,
    item?.mechanism,
    item?.rationale,
    item?.summary,
    item?.statement,
    Array.isArray(item?.required_validations) ? item.required_validations.join(" ") : "",
  ].filter(Boolean).join(" ")).join(" ");
  const hasModeratorOrPartitionCoverage =
    hasSubgroupReasoning ||
    Number(schemaQuality.moderator_node_count || 0) >= 2 ||
    /subgroup|group|moderat|heterogene|partition|stratif|interaction|effect modifier/i.test(familyReasoningText) ||
    (focusHypotheses || []).some((item) =>
      /subgroup|group|moderat|heterogene|partition|stratif|interaction|effect modifier/i.test(
        [
          item?.mechanism,
          item?.family_root,
          item?.cluster_key,
          JSON.stringify(item?.validation_protocol || {}),
        ].join(" "),
      )
    );
  const hasAlternativeFamilyCoverage =
    activeFamilyDiversity >= 2 &&
    (
      nonGenericStrongFamilyRoots.size >= 2 ||
      brainstormFamilyCount >= 2 ||
      tournamentFamilyCount >= 2 ||
      clusterDiversity >= 2
    );
  const graphClaimCoverage = Number(schemaQuality.claim_count || 0);
  const graphAnalysisCoverage = Number(schemaQuality.analysis_result_count || 0);
  const graphTestCoverage = Math.max(Number(schemaQuality.falsification_test_count || 0), reasoningTestCount);
  const hasGraphDerivedHypothesisCoverage =
    derivableHypothesisCandidates.length >= 3 ||
    (
      reasoningClaimCount >= targetReasoningClaims &&
      graphClaimCoverage >= Math.max(4, claimCount) &&
      graphAnalysisCoverage >= Math.max(8, completedLaneCount * 2)
    ) ||
    (
      activeFamilyDiversity >= 2 &&
      graphClaimCoverage >= Math.max(6, claimCount * 2) &&
      graphTestCoverage >= Math.max(4, Math.min(8, hypothesisCount))
    );
  const methodReasoningFromClaims = claimReasons.some((item) => /adjust|confound|robust|sensitivity|lag|missing/i.test(item));
  const validationAverage = (key) => {
    const values = validationSignals?.[key] || [];
    if (!values.length) return 0;
    return Math.round(Math.max(...values));
  };
  const methodValidationScore = validationAverage("method_appropriateness");
  const accuracyValidationScore = validationAverage("analysis_accuracy");
  const decisiveBlueprintValidation =
    methodValidationScore >= 90 &&
    accuracyValidationScore >= 90;
  const methodReasoningFromHypotheses = (focusHypotheses || []).some((item) =>
    /adjust|confound|robust|sensitivity|lag|missing|regression/i.test(
      [
        item.mechanism,
        JSON.stringify(item.validation_protocol || {}),
        JSON.stringify(item.support_paths || []),
      ].join(" ").toLowerCase(),
    )
  );
  const methodReasoningFromValidation = methodValidationScore >= 80 || accuracyValidationScore >= 90;
  const hasMethodReasoning =
    methodReasoningFromClaims || methodReasoningFromHypotheses || methodReasoningFromValidation;
  const evidenceTraceCoverage = claimCount > 0 ? tracedClaimCount / Math.max(1, claimCount) : 0;
  const progressMap = new Map((followupProgress || []).map((item) => [item.rubric, item]));
  const progressBoost = (rubric) => progressMap.get(rubric)?.boost || 0;
  const reportFigureCount = Number((((report.figure_spec || {}).figures) || []).length || 0);
  const figureCount = reportFigureCount + Math.min(3, Number(projectionCount || 0));
  const studySignalText = [
    JSON.stringify(report || {}),
    JSON.stringify(literature || {}),
    JSON.stringify(focusHypotheses || []),
    JSON.stringify(claims || []),
    JSON.stringify(hypothesisLedger || {}),
  ].join(" ").toLowerCase();
  const studyDesign = inferStudyDesignProfile(studySignalText);
  const consortChecks = [
    { pattern: /trial registration|clinicaltrials\.gov|isrctn|registration/i, weight: 1, reason: "CONSORT: trial registration or registry details are not explicit" },
    { pattern: /protocol|statistical analysis plan|sap/i, weight: 1, reason: "CONSORT: protocol or statistical analysis plan access is not explicit" },
    { pattern: /data sharing|code availability|shared code|repository/i, weight: 1, reason: "CONSORT: data or code sharing details are not explicit" },
    { pattern: /trial design|parallel group|superiority|non-inferiority|allocation ratio/i, weight: 2, reason: "CONSORT: trial design details are not explicit enough" },
    { pattern: /eligibility criteria|inclusion criteria|exclusion criteria|setting|site/i, weight: 1, reason: "CONSORT: participant eligibility or setting details are incomplete" },
    { pattern: /intervention|comparator|control group|usual care|placebo/i, weight: 2, reason: "CONSORT: intervention or comparator description is incomplete" },
    { pattern: /primary outcome|secondary outcome|outcome metric|time point/i, weight: 2, reason: "CONSORT: prespecified outcomes and time points are not explicit enough" },
    { pattern: /sample size|power|confidence interval|precision|statistical method/i, weight: 2, reason: "CONSORT: sample size, precision, or statistical methods are not explicit enough" },
    { pattern: /blinding|masked|allocation concealment|random allocation/i, weight: 2, reason: "CONSORT: randomization, blinding, or allocation concealment details are incomplete" },
    { pattern: /participant flow|recruitment|losses|exclusions|follow-up/i, weight: 1, reason: "CONSORT: participant flow or recruitment accounting is incomplete" },
    { pattern: /harms|adverse event|safety/i, weight: 1, reason: "CONSORT: harms or unintended effects are not addressed" },
    { pattern: /limitations|bias|generalisability|interpretation/i, weight: 1, reason: "CONSORT: limitations or interpretation against bias/generalisability are incomplete" },
  ];
  const strobeChecks = [
    { pattern: /cohort|case-control|cross-sectional|observational|ecological/i, weight: 1, reason: "STROBE: observational study design is not stated clearly" },
    { pattern: /setting|country|site|registry|time period/i, weight: 1, reason: "STROBE: setting, location, or study period is incomplete" },
    { pattern: /participants|population|eligibility|inclusion|exclusion/i, weight: 2, reason: "STROBE: participant eligibility or selection details are incomplete" },
    { pattern: /outcome|exposure|predictor|confound|modifier/i, weight: 2, reason: "STROBE: outcomes, exposures, confounders, or effect modifiers are not specified well enough" },
    { pattern: /data source|measurement|definition|dataset/i, weight: 1, reason: "STROBE: data sources or measurement definitions are incomplete" },
    { pattern: /bias|confound|adjust|sensitivity|missing data/i, weight: 2, reason: "STROBE: bias control, confound adjustment, or missing-data handling is incomplete" },
    { pattern: /statistical method|regression|model|subgroup|interaction/i, weight: 2, reason: "STROBE: statistical methods and subgroup/sensitivity handling are incomplete" },
    { pattern: /descriptive|baseline|summary statistics|participant characteristics/i, weight: 1, reason: "STROBE: descriptive or baseline data reporting is incomplete" },
    { pattern: /effect size|confidence interval|precision|main result/i, weight: 2, reason: "STROBE: main results or precision reporting is incomplete" },
    { pattern: /limitations|generalisability|external validity|funding/i, weight: 1, reason: "STROBE: limitations, generalisability, or funding disclosure is incomplete" },
  ];

  const items = [
    rubricItem(
      "novelty",
      18 +
        Math.min(24, hypothesisCount * 3) +
        Math.min(18, brainstormFamilyCount * 7) +
        Math.min(8, brainstormClusterDiversity * 4) +
        Math.min(12, clusterDiversity * 4) +
        Math.min(12, derivableHypothesisCandidates.length * 2) +
        Math.min(10, reasoningClaimCount * 2) +
        Math.round(graphGenerationScore * 0.08) +
        Math.min(10, nonGenericStrongFamilyRoots.size * 3) +
        (hasAlternativeFamilyCoverage ? 6 : 0) +
        (hasGraphDerivedHypothesisCoverage ? 6 : 0) +
        (hasModeratorOrPartitionCoverage ? 12 : 0) +
        (hasMethodReasoning ? 8 : 0) +
        (decisiveBlueprintValidation ? 8 : 0) +
        progressBoost("novelty"),
      [
        hypothesisCount < 4 && !decisiveBlueprintValidation ? "Novelty: need a broader set of non-trivial hypotheses" : "",
        brainstormFamilyCount < 2 && !decisiveBlueprintValidation && !hasAlternativeFamilyCoverage ? "Novelty: alternative hypothesis families are still too limited" : "",
        derivableHypothesisCandidates.length < 3 && !decisiveBlueprintValidation && !hasGraphDerivedHypothesisCoverage ? "Novelty: graph-derived next-step hypotheses are still too limited" : "",
        reasoningClaimCount < targetReasoningClaims ? "Novelty: structured reasoning claims are still too limited" : "",
        !hasModeratorOrPartitionCoverage && !decisiveBlueprintValidation ? "Novelty: moderator or partition originality is still weak" : "",
      ],
      { framework: "research" },
    ),
    rubricItem(
      "technical_quality",
      16 +
        Math.min(22, completedLaneCount * 4) +
        Math.min(18, completedExperimentLaneCount * 3) +
        (hasMethodReasoning ? 12 : 0) +
        Math.round(methodValidationScore * 0.35) +
        Math.round(accuracyValidationScore * 0.22) +
        Math.min(10, Math.round(falsificationCoverage * 5)) +
        Math.min(10, reasoningTestCount * 2) +
        Math.min(8, Math.round(confounderCoverage * 4)) +
        Math.min(8, Math.round(evidenceTraceCoverage * 12)) +
        progressBoost("technical_quality"),
      [
        completedLaneCount < 4 ? "Technical quality: not enough execution lanes completed to justify method coverage" : "",
        !hasMethodReasoning ? "Technical quality: robustness or confound handling is not explicit enough" : "",
        falsificationCoverage < 0.75 ? "Technical quality: too few explicit falsification tests are attached to hypotheses" : "",
        reasoningTestCount < targetReasoningTests ? "Technical quality: too few executed or attached tests exist in the reasoning graph" : "",
        methodValidationScore < 70 ? "Technical quality: methodological validation is still not strong enough" : "",
      ],
      { framework: "research" },
    ),
    rubricItem(
      "reproducibility",
      18 +
        Math.min(18, completedExperimentLaneCount * 4) +
        Math.min(18, tracedClaimCount * 8) +
        Math.min(10, citedClaimCount * 3) +
        Math.min(10, tracedLaneCount * 2) +
        Math.round(methodValidationScore * 0.18) +
        Math.round(accuracyValidationScore * 0.2) +
        Math.min(8, reasoningAnalysisCount / 6) +
        Math.min(8, figureCount * 3) +
        (decisiveBlueprintValidation ? 8 : 0) +
        progressBoost("reproducibility"),
      [
        evidenceTraceCoverage < 1 ? "Reproducibility: too many claims still lack explicit evidence traces" : "",
        tracedLaneCount < completedExperimentLaneCount ? "Reproducibility: not enough completed analyses are explicitly traceable" : "",
        methodValidationScore < 70 ? "Reproducibility: method validation still looks too weak for reliable repetition" : "",
        accuracyValidationScore < 70 ? "Reproducibility: analytical confidence is still limited" : "",
      ],
      { framework: "research" },
    ),
    rubricItem(
      "clarity",
      26 +
        Math.min(22, claimCount * 8) +
        Math.min(12, supportingClaimCount * 2) +
        Math.min(20, tracedClaimCount * 7) +
        Math.min(10, citedClaimCount * 3) +
        Math.min(12, figureCount * 4) +
        Math.max(0, 12 - openQuestionCount * 2) +
        Math.max(0, 10 - recommendedActionCount) +
        progressBoost("clarity"),
      [
        claimCount < 1 ? "Clarity: too few explicit claims are visible" : "",
        openQuestionCount > 5 ? "Clarity: unresolved questions still weaken readability" : "",
        tracedClaimCount < claimCount ? "Clarity: too many claims still lack explicit support traces" : "",
        figureCount < 2 ? "Clarity: clearer primary and robustness figures are still needed" : "",
      ],
      { framework: "research" },
    ),
    rubricItem(
      "impact",
      28 +
        Math.min(26, claimCount * 10) +
        Math.min(12, supportingClaimCount * 2) +
        Math.min(16, hypothesisCount * 2) +
        Math.min(20, Math.max(promotedCount, robustFocusHypothesisCount) * 6) +
        Math.round(hypothesisQualityScore * 0.15) +
        (decisiveBlueprintValidation ? 28 : 0) +
        progressBoost("impact"),
      [
        claimCount < 1 ? "Impact: validated findings are still too limited" : "",
        Math.max(promotedCount, robustFocusHypothesisCount) < 2 && !decisiveBlueprintValidation ? "Impact: too few high-confidence promoted hypotheses are visible" : "",
        unresolvedGapCount > acceptableGapCount && !decisiveBlueprintValidation ? "Impact: too many unresolved reasoning gaps remain for a high-impact claim set" : "",
      ],
      { framework: "research" },
    ),
    reportingCompleteness({
      name: "consort_reporting_completeness",
      framework: "CONSORT",
      applicable: studyDesign.randomized && !studyDesign.observational,
      text: studySignalText,
      checks: consortChecks,
      boost: progressBoost("consort_reporting_completeness"),
    }),
    reportingCompleteness({
      name: "strobe_reporting_completeness",
      framework: "STROBE",
      applicable: studyDesign.observational,
      text: studySignalText,
      checks: strobeChecks,
      boost: progressBoost("strobe_reporting_completeness"),
    }),
  ];
  const weightedItems = items.map((item) => ({
    ...item,
    weight: RUBRIC_WEIGHTS[item.name] || 0,
  }));

  const score = weightedScore(weightedItems);
  // Revision P0-3: only surface blockers from rubric items that actually
  // scored below the approval band. Previously every sub-condition that
  // pattern-matched would always raise its blocker text, yielding the
  // contradictory case where a rubric item scored 88 yet emitted "too
  // limited" blockers. Items at the approval threshold are treated as "clean" for blocker
  // purposes even if fine-grained diagnostics remain visible on the
  // rubric entries themselves. Follow the owner's approval threshold.
  const BLOCKER_SCORE_CUTOFF = GATE_THRESHOLD;
  const reasons = weightedItems
    .flatMap((item) => (Number(item.score || 0) < BLOCKER_SCORE_CUTOFF ? item.reasons : []))
    .filter(Boolean);
  const band =
    score >= GATE_THRESHOLD ? "approval-ready" :
    score >= GATE_THRESHOLD - 5 ? "nearly-ready" :
    score >= 65 ? "promising-but-incomplete" :
    "early";

  return {
    score,
    band,
    reasons,
    rubric: weightedItems,
  };
}

module.exports = {
  rubricItem,
  weightedScore,
  inferStudyDesignProfile,
  reportingCompleteness,
  listLaneDirs,
  summarizeFollowupEvidence,
  collectFollowupRubricProgress,
  collectAnalysisValidationSignals,
  collectAnalysisTraces,
  collectOpenEndedExperiments,
  collectAnalysisScoreboard,
  buildKnowledgeGraphDigest,
  computeConclusionReadiness,
  computeEvidenceReadiness,
  listCycleResultFiles,
};
