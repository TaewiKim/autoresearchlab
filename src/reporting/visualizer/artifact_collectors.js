"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonCached } = require("./json_cache");
const { dialogueLog } = require("../../observability/cycle_logs");
const {
  findLatestVersionedJson,
  readJsonlIfExists,
  uniqueStrings,
  reconcileCycleState,
} = require("./shared");
const { renderSupportBasis } = require("./renderers");
const { listCycleResultFiles } = require("./analysis");
const { selectedLeadIdentity, pickLeadScopedRunner } = require("../../agents/shared/lead_evidence_match");
const readJsonIfExists = readJsonCached;

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function collectDataAcquisitionSummary({ root, cycleId, actions = [] }) {
  const resultFiles = listCycleResultFiles(root, cycleId);
  const runs = [];
  const datasetRoots = new Set();
  const providers = new Set();
  const uniqueTargets = new Set();
  const scorecardByTarget = new Map();
  let filesAdded = 0;

  for (const filePath of resultFiles) {
    const result = readJsonIfExists(filePath, 10 * 1024 * 1024);
    if (!result || result.driver !== "open-data-bootstrap-driver" || result.status === "skipped") continue;
    const laneId = path.basename(path.dirname(filePath));
    const datasets = asArray(result.datasets);
    const provider = result.provider || "unknown";
    if (result.dataset_root) datasetRoots.add(result.dataset_root);
    if (result.provider) providers.add(result.provider);
    for (const item of datasets) {
      const key = `${provider}::${item?.target_name || item?.name || ""}::${item?.identifier || item?.indicator_code || ""}`;
      if (uniqueTargets.has(key)) continue;
      uniqueTargets.add(key);
      filesAdded += 1;
    }
    for (const item of asArray(result.selection_scorecard)) {
      const targetName = String(item.target_name || "").trim();
      if (!targetName || scorecardByTarget.has(targetName)) continue;
      scorecardByTarget.set(targetName, item);
    }
    runs.push({
      lane_id: laneId,
      provider,
      dataset_root: result.dataset_root || null,
      files_downloaded: Number(result.files_downloaded || datasets.length || 0),
      cache_hit: Boolean(result.cache_hit),
      manifest_path: result.manifest_path || null,
      requested_targets: asArray(result.requested_targets).slice(0, 12),
      downloaded_targets: asArray(result.downloaded_targets).slice(0, 12),
      reused_targets: asArray(result.reused_targets).slice(0, 12),
      dataset_names: datasets.map((item) => item.name).filter(Boolean).slice(0, 12),
    });
  }

  const pendingActions = asArray(actions)
    .filter((item) => item && item.type === "data_acquisition_followup")
    .map((item) => ({
      description: item.description || null,
      priority: item.priority || null,
      target_rubric: item.target_rubric || null,
    }));

  return {
    run_count: runs.length,
    providers: Array.from(providers),
    dataset_roots: Array.from(datasetRoots),
    files_added: filesAdded,
    runs,
    pending_actions: pendingActions,
    selection_scorecards: Array.from(scorecardByTarget.values()).slice(0, 12),
  };
}

function latestRunnerResult(root, cycleId, leadIdentity = null) {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (filePath, result) => {
    if (!filePath || !result || seen.has(filePath)) return;
    let mtime = 0;
    try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
    seen.add(filePath);
    candidates.push({ filePath, result, mtime });
  };

  listCycleResultFiles(root, cycleId)
    .map((filePath) => ({ filePath, result: readJsonIfExists(filePath, 10 * 1024 * 1024) }))
    .filter((item) => item.result && /lab-runner|analysis|stats|runner/i.test(`${item.result.role || ""} ${item.result.driver || ""} ${item.filePath}`))
    .forEach((item) => pushCandidate(item.filePath, item.result));

  const cycleStatePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const laneStatuses = asArray((readJsonIfExists(cycleStatePath, 25 * 1024 * 1024) || {}).lane_statuses);
  for (const laneStatus of laneStatuses) {
    const laneId = String(laneStatus?.lane_id || "").trim();
    if (!laneId || laneStatus.status !== "completed" || laneStatus.role !== "lab-runner") continue;
    const laneResultPath = laneStatus.result_path || path.join(root, "lanes", cycleId, laneId, "result.json");
    const laneResult = readJsonIfExists(laneResultPath, 10 * 1024 * 1024);
    if (laneResult && /lab-runner|analysis|stats|runner/i.test(`${laneResult.role || ""} ${laneResult.driver || ""} ${laneResultPath}`)) {
      pushCandidate(laneResultPath, laneResult);
      continue;
    }
    const validationSummaryPath = path.join(root, "artifacts", "stats", cycleId, laneId, "validation-summary.json");
    const validationSummary = readJsonIfExists(validationSummaryPath, 1024 * 1024);
    if (validationSummary) {
      pushCandidate(validationSummaryPath, {
        role: "lab-runner",
        driver: validationSummary.driver || "validation-summary",
        validation_summary: validationSummary,
      });
    }
  }

  // Lead-scoped binding: prefer the newest runner whose executed family/statement
  // matches the selected lead and that has a real (non-deferred) blueprint execution.
  // Falls back to latest-by-mtime when the lead has no identity, no candidate is
  // scopable, or none match (see lead_evidence_match for the no-regression contract).
  return pickLeadScopedRunner(candidates, leadIdentity);
}

// Strongest-magnitude finite value across one or more {key: number} maps. Used
// to surface a real quantitative signal from a driver's structured correlation
// output when the epidemiology-shaped pooled/adjusted effect fields are absent
// (e.g. a robotics/generic blueprint that reports kinematic correlations, not a
// pooled cohort effect).
function strongestFiniteValue(...maps) {
  let best = null;
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const raw of Object.values(map)) {
      const value = toFiniteNumber(raw);
      if (value === null) continue;
      if (best === null || Math.abs(value) > Math.abs(best)) best = value;
    }
  }
  return best;
}

// Parse the largest AUC-like figure out of a free-text blueprint metrics note,
// e.g. "pooled AUC linear=0.618, nonlinear=0.755; permutation95=0.880" -> 0.755.
// Blueprints frequently record their headline metric in prose rather than a
// structured field; this recovers it so the evidence layer sees a real number.
// Returns null when no AUC figure is present.
function parseAucFromNotes(notes) {
  if (typeof notes !== "string" || !notes) return null;
  let best = null;
  const pattern = /auc[^0-9-]{0,20}(-?\d*\.?\d+)/gi;
  let match;
  while ((match = pattern.exec(notes)) !== null) {
    const value = toFiniteNumber(match[1]);
    if (value === null) continue;
    if (best === null || Math.abs(value) > Math.abs(best)) best = value;
  }
  return best;
}

// The primary blueprint's structured metrics object
// (blueprint_executions[].metrics), where the python-stats driver records a
// check's computed quantitative outputs (correlations, evidence_grade, notes).
function firstBlueprintMetrics(result) {
  for (const exec of asArray(result && result.blueprint_executions)) {
    if (exec && exec.metrics && typeof exec.metrics === "object") return exec.metrics;
  }
  return {};
}

// Best available scalar "primary effect" from a blueprint's structured metrics,
// tried most-specific first: an explicit structured metric field, then the
// headline AUC recovered from the metrics note, then the strongest correlation.
// This is the domain-neutral fallback that lets a non-epidemiology result (which
// never populates pooled/adjusted cohort effects) still surface a real number.
function blueprintPrimaryMetric(result) {
  const metrics = firstBlueprintMetrics(result);
  return firstFinite(
    metrics.primary_effect,
    metrics.primary_metric_value,
    metrics.auc,
    metrics.pooled_auc,
    parseAucFromNotes(metrics.notes),
    strongestFiniteValue(result && result.stats && result.stats.correlations, metrics.correlations),
  );
}

function collectPrimaryEvidenceDetails({ root, cycleId, report = {} }) {
  const reportEvidence = report?.primary_evidence || report?.validation_metrics || {};
  const leadIdentity = selectedLeadIdentity(root, cycleId, report);
  const runner = latestRunnerResult(root, cycleId, leadIdentity);
  const result = runner?.result || {};
  const derived = asArray(result.derived_indicator_outcomes);
  const firstDerived = derived[0] || {};
  const validationSummary = result.validation_summary || {};
  // The lead-scoped runner can resolve to a validation-summary stub that lacks
  // the driver's structured blueprint outputs (blueprint_executions / stats). In
  // that case load the sibling full result.json for the same lane so the metric
  // fallback below can read the real computed numbers.
  const runnerDir = runner?.filePath ? path.dirname(runner.filePath) : null;
  const runnerLaneId = runnerDir ? path.basename(runnerDir) : null;
  let metricSource = result;
  if (!asArray(result.blueprint_executions).length) {
    const fullResult =
      (runnerDir && readJsonIfExists(path.join(runnerDir, "result.json"), 10 * 1024 * 1024)) ||
      (runnerLaneId &&
        readJsonIfExists(path.join(root, "lanes", cycleId, runnerLaneId, "result.json"), 10 * 1024 * 1024)) ||
      (runnerLaneId &&
        readJsonIfExists(
          path.join(root, "artifacts", "stats", cycleId, runnerLaneId, "result.json"),
          10 * 1024 * 1024,
        ));
    if (
      fullResult &&
      (asArray(fullResult.blueprint_executions).length ||
        (fullResult.stats && fullResult.stats.correlations))
    ) {
      metricSource = fullResult;
    }
  }
  const metricSourceMetrics = firstBlueprintMetrics(metricSource);
  const blueprintMetric = blueprintPrimaryMetric(metricSource);
  const primaryEffect = firstFinite(
    reportEvidence.primary_effect,
    reportEvidence.adjusted_primary,
    reportEvidence.adjusted_effect,
    reportEvidence.primary_recompute_correlation,
    firstDerived.value,
    firstDerived.summary_stat,
    // Domain-neutral fallback: a robotics/generic blueprint reports its result as
    // structured metrics / an AUC note / correlations, never a pooled cohort
    // effect. Surfacing it here lets a genuine (including negative) result reach
    // the evidence layer instead of registering as null "hollow" evidence.
    blueprintMetric,
  );
  const adjustedEffect = firstFinite(
    reportEvidence.adjusted_primary,
    reportEvidence.adjusted_effect,
    reportEvidence.primary_recompute_correlation,
    primaryEffect,
  );
  const totalSlices = firstFinite(reportEvidence.total_slices, reportEvidence.total_groups, reportEvidence.total_regions);
  const consistentSlices = firstFinite(
    reportEvidence.directionally_consistent_slices,
    reportEvidence.directionally_consistent_regions,
    reportEvidence.supported_slices,
  );
  const checks = validationSummary.checks && typeof validationSummary.checks === "object" ? validationSummary.checks : {};
  const checksPassedCount = firstFinite(
    reportEvidence.checks_passed_count,
    Object.values(checks).filter(Boolean).length,
  );
  const checksTotalCount = firstFinite(
    reportEvidence.checks_total_count,
    Object.keys(checks).length,
    checksPassedCount,
  );
  const yearRange = Array.isArray(reportEvidence.year_range)
    ? reportEvidence.year_range
    : Array.isArray(result.year_range)
      ? result.year_range
      : [];
  const laneId = reportEvidence.lane_id || (runner?.filePath ? path.basename(path.dirname(runner.filePath)) : null);

  return {
    lane_id: laneId || "n/a",
    row_count: firstFinite(reportEvidence.row_count, result.row_count, result.n_rows),
    group_count: firstFinite(reportEvidence.group_count, reportEvidence.country_count, result.group_count, result.country_count),
    country_count: firstFinite(reportEvidence.group_count, reportEvidence.country_count, result.group_count, result.country_count),
    year_range: yearRange,
    primary_effect: primaryEffect,
    pooled_effect: firstFinite(reportEvidence.pooled_primary, reportEvidence.pooled_effect, primaryEffect),
    adjusted_primary: adjustedEffect,
    adjusted_effect: adjustedEffect,
    regression_primary: firstFinite(reportEvidence.regression_primary, reportEvidence.regression_effect),
    uncertainty: firstFinite(reportEvidence.uncertainty, reportEvidence.p_value, reportEvidence.q_value),
    total_groups: totalSlices,
    directionally_consistent_groups: consistentSlices,
    checks_passed_count: checksPassedCount,
    checks_total_count: checksTotalCount,
    bootstrap_positive_share: firstFinite(reportEvidence.bootstrap_positive_share, result.bootstrap_positive_share),
    permutation_p_value: firstFinite(reportEvidence.permutation_p_value, result.permutation_p_value),
    robustness_min: firstFinite(reportEvidence.robustness_min, result.robustness_min),
    robustness_max: firstFinite(reportEvidence.robustness_max, result.robustness_max),
    method_score: firstFinite(reportEvidence.method_score, reportEvidence.method_appropriateness_score, validationSummary.method_appropriateness_score),
    method_appropriateness_score: firstFinite(reportEvidence.method_appropriateness_score, validationSummary.method_appropriateness_score),
    analysis_accuracy_score: firstFinite(reportEvidence.analysis_accuracy_score, validationSummary.analysis_accuracy_score),
    // Blueprint metric context so the evidence/gatekeeper layer can read a
    // non-epidemiology result's headline number and its prose caveats (e.g. an
    // AUC below its permutation boundary) rather than only a bare correlation.
    blueprint_primary_metric: blueprintMetric,
    blueprint_metrics_notes:
      typeof metricSourceMetrics.notes === "string" ? metricSourceMetrics.notes : null,
    source_result_path: runner?.filePath || null,
    derived_indicators: derived.slice(0, 12),
  };
}

function collectAnalysisVisuals({ root, cycleId, report = {} }) {
  const primaryEvidence = collectPrimaryEvidenceDetails({ root, cycleId, report });
  const visuals = asArray(report?.analysis_visuals || report?.figures || report?.visuals);
  const paperFigureVisuals = collectPaperFigureVisuals({ root, cycleId });
  if (visuals.length > 0) {
    const seen = new Set(visuals.map((item) => String(item.figure_id || item.id || item.title || "")));
    return visuals.concat(
      paperFigureVisuals.filter((item) => !seen.has(String(item.figure_id || item.id || item.title || ""))),
    );
  }
  if (paperFigureVisuals.length > 0) return paperFigureVisuals;
  const rows = [
    {
      label: "Primary effect",
      value: primaryEvidence.primary_effect,
      adjusted: primaryEvidence.adjusted_effect,
      note: "Main quantitative signal from report or latest runner artifact.",
    },
    {
      label: "Method score",
      value: primaryEvidence.method_appropriateness_score,
      note: "Method appropriateness score from validation summary.",
    },
    {
      label: "Accuracy score",
      value: primaryEvidence.analysis_accuracy_score,
      note: "Analysis accuracy score from validation summary.",
    },
  ].filter((item) => toFiniteNumber(item.value) !== null || toFiniteNumber(item.adjusted) !== null);

  return rows.length
    ? [
        {
          kind: "primary-signal-summary",
          title: "Primary Signal Across Checks",
          chart_type: "ranked horizontal evidence bars",
          priority: "highest",
          takeaway: "Show the promoted quantitative signal and validation scores without assuming a domain-specific outcome.",
          items: rows,
        },
      ]
    : [];
}

function collectPaperFigureVisuals({ root, cycleId }) {
  const paperPath = findLatestVersionedJson(path.join(root, "papers"), `${cycleId}-paper-`);
  const paper = readJsonIfExists(paperPath);
  const panels = asArray(paper?.figure_panels);
  if (panels.length === 0) return [];

  return panels
    .filter((panel) => panel?.image_path || panel?.paper_image_png_path || panel?.editable_manifest_source)
    .map((panel) => ({
      kind: "manuscript-figure",
      figure_id: panel.figure_id || `figure-${panel.figure_number || "panel"}`,
      title: panel.title || panel.caption || `Figure ${panel.figure_number || ""}`.trim(),
      chart_type: "paper figure panel",
      priority: panel.figure_number === 1 ? "highest" : "high",
      takeaway: panel.caption || panel.detailed_explanation || "Manuscript figure linked from the paper figure deck.",
      image_path: panel.image_path || panel.paper_image_png_path || null,
      editable_ppt_source: panel.editable_ppt_source || null,
      editable_manifest_source: panel.editable_manifest_source || null,
      source_tables: asArray(panel.source_tables),
      items: [
        {
          label: "source tables",
          value: asArray(panel.source_tables).length,
          note: "Figure provenance table count from paper figure metadata.",
        },
      ],
    }));
}

function collectPromotedHypothesisValidation({ root, cycleId, hypothesisLedger }) {
  const hypotheses = asArray(hypothesisLedger?.hypotheses || hypothesisLedger?.focus_hypotheses);
  const validationState = readJsonIfExists(path.join(root, "state", `${cycleId}-validation-results.json`)) || {};
  const validationResults = asArray(validationState.validation_results);
  return hypotheses
    .filter((item) => item?.state === "provisionally_promoted" || item?.latest_status === "robust" || item?.state === "contending")
    .slice(0, 8)
    .map((hypothesis) => {
      const hypothesisId = hypothesis.hypothesis_id || hypothesis.id || null;
      const supportChecks = validationResults
        .filter((item) => asArray(item.target_hypothesis_ids).includes(hypothesisId))
        .map((item) => ({
          lane_id: item.lane_id || item.validation_lane_id || "validation",
          validation_profile: item.validation_profile || item.action_type || "validation",
          passed_checks: asArray(item.passed_checks),
          method_appropriateness_score: item.method_appropriateness_score ?? null,
          analysis_accuracy_score: item.analysis_accuracy_score ?? null,
          verdict: item.verdict || item.latest_status || null,
        }));
      return {
        hypothesis_id: hypothesisId,
        statement: hypothesis.statement || hypothesis.claim || "",
        state: hypothesis.state || hypothesis.latest_status || null,
        y_variable: hypothesis.y_variable || hypothesis.outcome || hypothesis.primary_outcome || null,
        support_checks: supportChecks,
        support_basis_html: renderSupportBasis(supportChecks),
      };
    });
}

function collectIllustratorIterations({ root, cycleId }) {
  return listCycleResultFiles(root, cycleId)
    .map((filePath) => ({ filePath, result: readJsonIfExists(filePath, 10 * 1024 * 1024) }))
    .filter((item) => item.result && (item.result.role === "illustrator" || asArray(item.result.visual_execution_packets).length > 0))
    .map((item) => ({
      lane_id: path.basename(path.dirname(item.filePath)),
      result_path: item.filePath,
      visual_execution_packets: asArray(item.result.visual_execution_packets),
      visual_refinement_brief: item.result.visual_refinement_brief || null,
    }));
}

function collectChronicleCheckpoint({ root, cycleId }) {
  const candidates = [
    path.join(root, "state", `${cycleId}-chronicle-checkpoint.json`),
    path.join(root, "state", `${cycleId}-trend-summary.json`),
    path.join(root, "state", `${cycleId}-research-trend-analysis.json`),
  ];
  const found = candidates.map((filePath) => ({ filePath, json: readJsonIfExists(filePath) })).find((item) => item.json);
  return found ? { path: found.filePath, brief: found.json } : null;
}

function collectChronicleReportDigest({ root, cycleId, claims = [], promotedHypothesisValidation = [], claimTraces = {} }) {
  const trend = readJsonIfExists(path.join(root, "state", `${cycleId}-trend-summary.json`)) || {};
  const traces = asArray(claimTraces.claim_traces);
  const reportPath = findLatestVersionedJson(path.join(root, "reports"), `${cycleId}-research-report-`);
  return {
    trend_summary_path: fs.existsSync(path.join(root, "state", `${cycleId}-trend-summary.json`))
      ? path.join(root, "state", `${cycleId}-trend-summary.json`)
      : null,
    report_path: reportPath,
    what_changed_since_previous_pass: asArray(trend.what_changed_since_previous_pass),
    claim_deltas: asArray(trend.claim_deltas),
    robust_vs_exploratory: trend.robust_vs_exploratory || {},
    open_questions: asArray(trend.open_questions || trend.open_gaps).slice(0, 8),
    recommended_actions: asArray(trend.recommended_actions).slice(0, 8),
    hypothesis_changes: asArray(trend.hypothesis_changes).slice(0, 8),
    supporting_evidence_paths: asArray(trend.supporting_evidence_paths).slice(0, 12),
    approval_blockers: asArray(trend.approval_blockers || trend.blockers).slice(0, 8),
    latest_high_signal_lane_ids: asArray(trend.latest_high_signal_lane_ids).slice(0, 8),
    cluster_labels: asArray(trend.cluster_labels).slice(0, 8),
    dominant_mechanisms: asArray(trend.dominant_mechanisms).slice(0, 8),
    open_gaps: asArray(trend.open_gaps).slice(0, 8),
    claim_count: asArray(claims).length,
    promoted_validation_count: asArray(promotedHypothesisValidation).length,
    traced_claim_count: traces.length,
  };
}

function loadArtifacts({ root, cycleId }) {
  const cyclePlanPath = path.join(root, "plans", `${cycleId}-cycle-plan.json`);
  const cycleStatePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const literaturePath = path.join(root, "plans", `${cycleId}-lab-director-literature.json`);
  const labDirectorHypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  const hypothesisLedgerPath = path.join(root, "state", `${cycleId}-hypothesis-ledger.json`);
  const strategyDecisionPath = path.join(root, "state", `${cycleId}-strategy-decision.json`);
  const finalClaimPackagePath = path.join(root, "state", `${cycleId}-final-claim-package.json`);
  const familyPackageLedgerPath = path.join(root, "state", `${cycleId}-family-package-ledger.json`);
  const validationResultsPath = path.join(root, "state", `${cycleId}-validation-results.json`);
  const claimTracesPath = path.join(root, "state", `${cycleId}-claim-traces.json`);
  const nextCyclePlanPath = path.join(root, "state", `${cycleId}-next-cycle-plan.json`);
  const familyNominationPath = path.join(root, "state", `${cycleId}-family-nomination.json`);
  const reportJsonPath = findLatestVersionedJson(path.join(root, "reports"), `${cycleId}-research-report-`);
  const aggregateMetricsPath = path.join(root, "metrics", `${cycleId}-aggregate-metrics.json`);
  const workgraphPath = path.join(root, "workgraphs", `${cycleId}-workgraph.json`);
  const laneTimelinePath = path.join(root, "events", `${cycleId}-lane-timeline.jsonl`);
  const reportWorkflowPath = path.join(root, "events", `${cycleId}-report-workflow.jsonl`);
  const dialogue = dialogueLog(root, cycleId);
  const chronicleDialoguePath = dialogue.segments().pop() || dialogue.legacyPath;
  const rawCycleState = readJsonIfExists(cycleStatePath) || {};
  const reconciledCycleState = reconcileCycleState(root, cycleId, rawCycleState);

  return {
    cyclePlanPath,
    cycleStatePath,
    literaturePath,
    labDirectorHypothesisPath,
    hypothesisLedgerPath,
    strategyDecisionPath,
    finalClaimPackagePath,
    familyPackageLedgerPath,
    validationResultsPath,
    claimTracesPath,
    nextCyclePlanPath,
    familyNominationPath,
    reportJsonPath,
    aggregateMetricsPath,
    workgraphPath,
    laneTimelinePath,
    reportWorkflowPath,
    chronicleDialoguePath,
    cyclePlan: readJsonIfExists(cyclePlanPath) || {},
    cycleState: reconciledCycleState,
    literature: readJsonIfExists(literaturePath, 25 * 1024 * 1024) || {},
    labDirectorHypothesis: readJsonIfExists(labDirectorHypothesisPath) || {},
    hypothesisLedger: readJsonIfExists(hypothesisLedgerPath) || {},
    strategyDecision: readJsonIfExists(strategyDecisionPath) || {},
    finalClaimPackage: readJsonIfExists(finalClaimPackagePath) || {},
    familyPackageLedger: readJsonIfExists(familyPackageLedgerPath) || {},
    validationResults: readJsonIfExists(validationResultsPath) || {},
    claimTraces: readJsonIfExists(claimTracesPath) || {},
    nextCyclePlan: readJsonIfExists(nextCyclePlanPath) || {},
    familyNominationState: readJsonIfExists(familyNominationPath) || {},
    report: readJsonIfExists(reportJsonPath) || {},
    aggregateMetrics: readJsonIfExists(aggregateMetricsPath) || {},
    workgraph: readJsonIfExists(workgraphPath) || {},
    runtimeEvents: uniqueStrings(dialogue.recent({ limit: 400 }).reverse().map((item) => item.event_type)).slice(0, 12),
    projectionCount: [aggregateMetricsPath, workgraphPath, laneTimelinePath, reportWorkflowPath, chronicleDialoguePath]
      .filter((filePath) => fs.existsSync(filePath))
      .length,
  };
}

module.exports = {
  collectDataAcquisitionSummary,
  collectPrimaryEvidenceDetails,
  parseAucFromNotes,
  strongestFiniteValue,
  blueprintPrimaryMetric,
  collectAnalysisVisuals,
  collectPromotedHypothesisValidation,
  collectIllustratorIterations,
  collectChronicleCheckpoint,
  collectChronicleReportDigest,
  loadArtifacts,
};
