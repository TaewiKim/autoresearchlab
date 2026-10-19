"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir, readJson, writeJson } = require("../../shared/json");
const { runtimeRoot } = require("../../runtime/native_client");
const { hasSubstantiveEvidence } = require("../evidence_soundness");
const {
  escapeHtml,
  readJsonIfExists,
  uniqueStrings,
  formatSigned,
  formatPlain,
  formatPercent,
} = require("./shared");
const {
  barChartSvg,
  renderSignalScorecardSvg,
  renderPrimarySignalSummarySvg,
  renderPrimaryClaimBridgeSvg,
  renderSubgroupHeterogeneitySvg,
  renderRobustnessSvg,
  renderPromotedHypothesesSummarySvg,
  renderValidationCoverageSvg,
  renderMetricTiles,
  renderPriorityCards,
  renderRivalFamilyCards,
  renderList,
  renderKnowledgeGraphSummary,
  buildKnowledgeGraphExplorer,
  renderKnowledgeGraphExplorer,
} = require("./renderers");
const {
  collectFollowupRubricProgress,
  collectAnalysisValidationSignals,
  collectAnalysisTraces,
  collectOpenEndedExperiments,
  collectAnalysisScoreboard,
  buildKnowledgeGraphDigest,
  computeConclusionReadiness,
  computeEvidenceReadiness,
} = require("./analysis");
const {
  collectDataAcquisitionSummary,
  collectPrimaryEvidenceDetails,
  collectAnalysisVisuals,
  collectPromotedHypothesisValidation,
  collectIllustratorIterations,
  collectChronicleCheckpoint,
  collectChronicleReportDigest,
  loadArtifacts,
} = require("./artifact_collectors");
const {
  buildRivalFamilyAdjudication,
  inferPreferredLeadOutcome,
  buildVisualNarrative,
} = require("./narrative");
const { buildVisualExecutionPackets } = require("../../agents/illustrator/visual_execution_packets");
const { evaluateVisualExecutionPlan } = require("../../policy/visual_qa_policy");
const {
  enrichClaimsWithLedgerSupport,
  enrichClaimsWithTraceArtifacts,
  normalizeReportClaims,
  selectPrimaryConclusions,
  provisionalClaimsFromHypotheses,
  preferCanonicalFocusHypotheses,
} = require("./researcher_view/claims");
const { renderResearcherViewHtml } = require("./researcher_view/html");
function buildResearcherView({ cwd = process.cwd(), cycleId }) {
  const root = runtimeRoot(cwd);
  const outputDir = path.join(root, "researcher-views");
  ensureDir(outputDir);

  const artifacts = loadArtifacts({ root, cycleId });
  const laneCounts = artifacts.cycleState.lane_counts || {};
  const report = artifacts.report || {};
  const literature = artifacts.literature || {};
  const followupProgress = collectFollowupRubricProgress({ root, cycleId });
  const validationSignals = collectAnalysisValidationSignals({ root, cycleId });
  const analysisTraceBundle = collectAnalysisTraces({ root, cycleId });
  const openEndedExperimentBundle = collectOpenEndedExperiments({ root, cycleId });
  const analysisScoreboard = collectAnalysisScoreboard({ root, cycleId });
  const ledgerFocusHypotheses = Array.isArray(artifacts.hypothesisLedger.focus_hypotheses)
    ? artifacts.hypothesisLedger.focus_hypotheses.slice(0, 6)
    : [];
  const focusHypotheses = preferCanonicalFocusHypotheses(
    ledgerFocusHypotheses,
    artifacts.labDirectorHypothesis,
  );
  const derivableHypothesisCandidates = Array.isArray(artifacts.hypothesisLedger.derivable_hypothesis_candidates)
    ? artifacts.hypothesisLedger.derivable_hypothesis_candidates.slice(0, 8)
    : [];
  const challengedCount = Number(artifacts.hypothesisLedger.challenged_count || 0);
  const demotedCount = Number(artifacts.hypothesisLedger.demoted_count || 0);
  const familyNomination = Array.isArray(artifacts.familyNominationState.family_nomination)
    ? artifacts.familyNominationState.family_nomination
    : Array.isArray(literature.family_nomination)
      ? literature.family_nomination
      : [];
  const familyTournament = literature.family_tournament && typeof literature.family_tournament === "object"
    ? literature.family_tournament
    : {};
  const familyPackageLedger = artifacts.familyPackageLedger && typeof artifacts.familyPackageLedger === "object"
    ? artifacts.familyPackageLedger
    : artifacts.hypothesisLedger.family_package_ledger && typeof artifacts.hypothesisLedger.family_package_ledger === "object"
      ? artifacts.hypothesisLedger.family_package_ledger
      : {};
  const nextCyclePlan = artifacts.nextCyclePlan && typeof artifacts.nextCyclePlan === "object"
    ? artifacts.nextCyclePlan
    : artifacts.hypothesisLedger.next_cycle_plan && typeof artifacts.hypothesisLedger.next_cycle_plan === "object"
      ? artifacts.hypothesisLedger.next_cycle_plan
      : {};
  const validationResults = Array.isArray(artifacts.validationResults.validation_results)
    ? artifacts.validationResults.validation_results
    : Array.isArray(artifacts.hypothesisLedger.validation_results?.validation_results)
      ? artifacts.hypothesisLedger.validation_results.validation_results
      : [];
  const schemaQuality = artifacts.hypothesisLedger.schema_quality || {};
  const hypothesisQualityScore = Number(
    artifacts.hypothesisLedger.average_evidence_quality_score || 0,
  );
  const knowledgeGraphExplorer = buildKnowledgeGraphExplorer(artifacts.hypothesisLedger);
  const knowledgeGraph = artifacts.hypothesisLedger.knowledge_graph && Object.keys(artifacts.hypothesisLedger.knowledge_graph).length
    ? artifacts.hypothesisLedger.knowledge_graph
    : {
        literature_graph: {
          hypothesis_count: knowledgeGraphExplorer.literature_graph.hypotheses.length,
          node_count: knowledgeGraphExplorer.literature_graph.nodes.length,
          edge_count: knowledgeGraphExplorer.literature_graph.edges.length,
        },
        data_graph: {
          hypothesis_count: knowledgeGraphExplorer.data_graph.hypotheses.length,
          node_count: knowledgeGraphExplorer.data_graph.nodes.length,
          edge_count: knowledgeGraphExplorer.data_graph.edges.length,
        },
      };
  const reasoningGraph = knowledgeGraph.reasoning_graph || {
    claim_count: 0,
    analysis_result_count: 0,
    test_count: 0,
    unresolved_gap_count: 0,
  };
  const knowledgeGraphDigest = buildKnowledgeGraphDigest(knowledgeGraph, knowledgeGraphExplorer);
  const topPapers = Array.isArray(report.top_papers) && report.top_papers.length
    ? report.top_papers.slice(0, 8)
    : Array.isArray(literature.top_papers)
      ? literature.top_papers.slice(0, 8)
      : [];
  const reportedClaims = normalizeReportClaims(report).slice(0, 12);
  const allClaims = enrichClaimsWithTraceArtifacts(
    enrichClaimsWithLedgerSupport(
      reportedClaims.length ? reportedClaims : provisionalClaimsFromHypotheses(artifacts.hypothesisLedger, 2),
      artifacts.hypothesisLedger,
    ),
    artifacts.claimTraces,
  );
  const claims = selectPrimaryConclusions(allClaims);
  const openQuestions = Array.isArray(report.open_questions) && report.open_questions.length
    ? report.open_questions.slice(0, 12)
    : [];
  const actions = Array.isArray(report.recommended_actions) && report.recommended_actions.length
    ? report.recommended_actions.slice(0, 12)
    : Array.isArray(report.recommended_next_moves) && report.recommended_next_moves.length
      ? report.recommended_next_moves.slice(0, 12)
    : [];
  const dataAcquisition = collectDataAcquisitionSummary({ root, cycleId, actions });
  const analysisVisuals = collectAnalysisVisuals({ root, cycleId, report });
  const promotedHypothesisValidation = collectPromotedHypothesisValidation({
    root,
    cycleId,
    hypothesisLedger: artifacts.hypothesisLedger,
  });
  const chronicleReportDigest = collectChronicleReportDigest({
    root,
    cycleId,
    claims,
    promotedHypothesisValidation,
    claimTraces: artifacts.claimTraces,
  });
  const illustratorIterations = collectIllustratorIterations({ root, cycleId });
  const chronicleCheckpoint = collectChronicleCheckpoint({ root, cycleId });
  const preferredLeadOutcome = inferPreferredLeadOutcome(chronicleCheckpoint);
  const openValidationGaps = (Array.isArray(artifacts.hypothesisLedger.hypotheses)
    ? artifacts.hypothesisLedger.hypotheses
    : [])
    .filter((item) => Array.isArray(item.unresolved_gaps) && item.unresolved_gaps.length > 0)
    .slice(0, 10);
  const reasoningClaims = (Array.isArray(artifacts.hypothesisLedger.hypotheses)
    ? artifacts.hypothesisLedger.hypotheses
    : [])
    .flatMap((item) => (item.claims || []).map((claim) => ({
      ...claim,
      source_hypothesis_id: item.hypothesis_id,
      source_state: item.state,
    })))
    .slice(0, 12);
  const promotedHypothesisRows = promotedHypothesisValidation
    .map((item, index) => ({
      label: item.hypothesis_id || "hypothesis",
      value: item.support_checks.length,
      note: item.statement || "",
      color: ["#2563eb", "#0f766e", "#d97706", "#7c2d12"][index % 4],
    }))
    .slice(0, 8);
  const validationCoverageRows = promotedHypothesisValidation
    .flatMap((item) => item.support_checks || [])
    .reduce((acc, item) => {
      const key = `${item.lane_id}:${item.validation_profile || "validation"}`;
      if (!acc.has(key)) {
        acc.set(key, {
          label: item.lane_id,
          check_count: Array.isArray(item.passed_checks) ? item.passed_checks.length : 0,
          method_score: item.method_appropriateness_score,
          accuracy_score: item.analysis_accuracy_score,
          note: item.validation_profile || item.action_type || "validation",
        });
      }
      return acc;
    }, new Map());
  const primaryEvidence = collectPrimaryEvidenceDetails({ root, cycleId, report });
  const visualNarrative = buildVisualNarrative(analysisVisuals, {
    primaryEvidence,
    promotedHypothesisRows,
    validationCoverageRows: Array.from(validationCoverageRows.values()),
    preferredLeadOutcome,
  });
  const illustratorProvidedPackets = illustratorIterations
    .flatMap((item) => Array.isArray(item.visual_execution_packets) ? item.visual_execution_packets : [])
    .filter(Boolean)
    .slice(0, 5);
  const illustratorRefinementBrief = illustratorIterations
    .map((item) => item.visual_refinement_brief)
    .find((item) => item && typeof item === "object") || null;
  const deterministicVisualPackets = buildVisualExecutionPackets({
    sectionPackets: literature?.writing_loop?.section_packets,
    evidenceMatrix: literature?.writing_loop?.evidence_matrix,
    figureRecommendations: visualNarrative.figure_recommendations,
    claimBridgeRows: visualNarrative.claim_bridge_rows,
    visualTakeaways: visualNarrative.visual_takeaways,
    leadOutcome: visualNarrative.lead_outcome,
    primaryVisualKind: visualNarrative.primary_visual_kind,
  });
  const visualQa = evaluateVisualExecutionPlan({
    authoredPackets: illustratorProvidedPackets,
    fallbackPackets: deterministicVisualPackets,
    figureRecommendations: visualNarrative.figure_recommendations,
  });
  const visualExecutionPackets = visualQa.preferred_packets;
  const graphItems = [
    { label: "Total Lanes", value: laneCounts.total || 0, color: "#2563eb" },
    { label: "Completed", value: laneCounts.completed || 0, color: "#16a34a" },
    { label: "Running", value: laneCounts.running || 0, color: "#d97706" },
    { label: "Failed", value: laneCounts.failed || 0, color: "#dc2626" },
    { label: "Claims", value: report.claim_count || 0, color: "#7c3aed" },
    { label: "Hypotheses", value: literature.hypothesis_count || 0, color: "#0891b2" },
  ];
  const conclusion = computeConclusionReadiness({
    report,
    literature,
    laneCounts,
    topPapers,
    claims,
    focusHypotheses,
    hypothesisLedger: artifacts.hypothesisLedger,
    familyNomination,
    familyTournament,
    openQuestions,
    actions,
    followupProgress,
    validationSignals,
    projectionCount: Math.max(Number(artifacts.projectionCount || 0), analysisVisuals.length),
  });
  const rivalFamilyAdjudication = buildRivalFamilyAdjudication({
    familyNomination,
    familyPackageLedger,
    nextCyclePlan,
    analysisScoreboard,
    validationResults,
  });
  const evidenceReadiness = computeEvidenceReadiness({
    cycleState: artifacts.cycleState,
    report,
    literature: literature.summary || literature,
    claims,
    focusHypotheses,
    hypothesisLedger: artifacts.hypothesisLedger,
  });
  // Soundness floor: lane completion (evidence_readiness.ready) alone must not
  // certify a readiness score. A cycle can complete every lane yet produce only
  // null quantitative effects and templated candidate claims — hollow evidence
  // that would otherwise surface an approval-ready number (observed: a robotics
  // cycle whose AUC-shaped runner output never mapped onto the epidemiology-
  // shaped evidence schema displayed 98/approval-ready on entirely null fields).
  // Require at least one genuine quantitative/validated signal before scoring;
  // otherwise present pending-evidence, exactly like incomplete lanes. Because
  // the conclusion/approval reviews read these summary readiness scores, the null
  // propagates and the authoritative gates hold too.
  const substantiveEvidence = hasSubstantiveEvidence({
    primary_evidence: primaryEvidence,
    promoted_hypothesis_validation: promotedHypothesisValidation,
  });
  const readyForScoring = evidenceReadiness.ready && substantiveEvidence;
  const conclusionScore = readyForScoring ? conclusion.score : null;
  const conclusionBand = readyForScoring ? conclusion.band : "pending-evidence";
  const conclusionBlockers = readyForScoring
    ? conclusion.reasons
    : evidenceReadiness.ready
      ? [
          "no substantive validated evidence: completed lanes produced no quantitative primary effect and no passed checks",
        ]
      : evidenceReadiness.reasons;
  const conclusionRubric = readyForScoring ? conclusion.rubric : [];
  const leadLabel = visualNarrative.lead_outcome_label || "primary hypothesis";
  const leadAdjustedValue = primaryEvidence?.adjusted_primary ?? primaryEvidence?.adjusted_effect ?? null;
  const hasExecutedLeadOutcome = visualNarrative.lead_outcome && primaryEvidence;
  const researcherSummary = hasExecutedLeadOutcome
    ? [
        Number.isFinite(leadAdjustedValue)
          ? `Lead with the adjusted ${leadLabel.toLowerCase()} estimate (${formatSigned(leadAdjustedValue)}) rather than the pooled correlation.`
          : `Lead with the adjusted ${leadLabel.toLowerCase()} estimate rather than the pooled correlation.`,
        "Keep corroborating outcomes secondary to the assigned hypothesis and report them only when the executed validation supports them.",
        Number.isFinite(primaryEvidence?.total_groups)
          ? `Frame heterogeneity as magnitude variation, not sign collapse: the lead outcome keeps the claimed sign across ${primaryEvidence?.directionally_consistent_groups ?? "available"}/${primaryEvidence?.total_groups} pooled slices and throughout leave-one-out checks.`
          : "Frame heterogeneity as magnitude variation, not sign collapse.",
      ].filter(Boolean)
    : [
        "Validation is not yet approval-ready: no executed evidence chart is available for the promoted claim.",
        visualNarrative.strongest_claim_summary || "The strongest claim still needs an executable analyst handoff and lab-runner result.",
        "Treat the current view as cycle monitoring until at least one validation blueprint runs and emits numeric evidence.",
      ].filter(Boolean);
  const researcherLimits = [
    "Do not make strong causal or timing claims from the current evidence base until a causal-design-specific blueprint executes.",
    "Keep rival mechanisms, measurement artifacts, cohort selection, and confounding explicit in the next validation pass.",
    "Treat the result as exploratory evidence until reproducible runner artifacts exist.",
  ];
  const nextAction = actions.find((item) => item && item.priority === "high" && item.description)
    || actions.find((item) => item && item.description);
  const nextApprovalStep = nextAction
    ? `Next approval move: ${nextAction.description}`
    : "Next approval move: generate and execute an analyst validation blueprint with explicit dataset, outcome, exposure, and failure criteria.";
  const executionCompletion = String(artifacts.cycleState.status || "unknown");
  // Domain-specific final-claim generation was removed, but the document
  // gate now emits a domain-neutral package once both report and paper pass.
  // Prefer that package when present; otherwise retain the visual/report
  // fallback so old cycles still render.
  const finalClaimPackage = {
    ...(artifacts.finalClaimPackage || {}),
    lead_outcome: artifacts.finalClaimPackage?.lead_outcome || visualNarrative.lead_outcome || null,
    lead_outcome_label: artifacts.finalClaimPackage?.lead_outcome_label || visualNarrative.lead_outcome_label || null,
    lead_claim:
      artifacts.finalClaimPackage?.lead_claim ||
      visualNarrative.strongest_claim_summary ||
      null,
    primary_figure_kind: artifacts.finalClaimPackage?.primary_figure_kind || visualNarrative.primary_visual_kind || null,
    research_outcome: artifacts.finalClaimPackage?.research_outcome || null,
    decision_mode: artifacts.finalClaimPackage?.decision_mode || null,
    decision_reason: artifacts.finalClaimPackage?.decision_reason || null,
    open_questions: Array.isArray(report?.open_questions) ? report.open_questions : [],
  };
  const html = renderResearcherViewHtml({
    cycleId,
    artifacts,
    laneCounts,
    report,
    literature,
    followupProgress,
    validationSignals,
    analysisTraceBundle,
    openEndedExperimentBundle,
    analysisScoreboard,
    focusHypotheses,
    derivableHypothesisCandidates,
    challengedCount,
    demotedCount,
    familyNomination,
    familyTournament,
    familyPackageLedger,
    nextCyclePlan,
    validationResults,
    schemaQuality,
    hypothesisQualityScore,
    knowledgeGraphExplorer,
    knowledgeGraph,
    reasoningGraph,
    knowledgeGraphDigest,
    topPapers,
    reportedClaims,
    allClaims,
    claims,
    openQuestions,
    actions,
    dataAcquisition,
    analysisVisuals,
    promotedHypothesisValidation,
    chronicleReportDigest,
    illustratorIterations,
    chronicleCheckpoint,
    preferredLeadOutcome,
    openValidationGaps,
    reasoningClaims,
    promotedHypothesisRows,
    validationCoverageRows,
    primaryEvidence,
    visualNarrative,
    illustratorProvidedPackets,
    illustratorRefinementBrief,
    deterministicVisualPackets,
    visualQa,
    visualExecutionPackets,
    graphItems,
    conclusion,
    rivalFamilyAdjudication,
    evidenceReadiness,
    conclusionScore,
    conclusionBand,
    conclusionBlockers,
    conclusionRubric,
    leadLabel,
    leadAdjustedValue,
    hasExecutedLeadOutcome,
    researcherSummary,
    researcherLimits,
    nextAction,
    nextApprovalStep,
    executionCompletion,
    finalClaimPackage,
  });
  const htmlPath = path.join(outputDir, `${cycleId}-researcher-view.html`);
  const jsonPath = path.join(outputDir, `${cycleId}-researcher-view.json`);
  const payload = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    html_path: htmlPath,
    objective: artifacts.cyclePlan.objective || null,
    cycle_status: executionCompletion,
    execution_completion: executionCompletion,
    research_outcome: finalClaimPackage.research_outcome,
    decision_mode: finalClaimPackage.decision_mode,
    decision_reason: finalClaimPackage.decision_reason,
    claim_count: Math.max(
      claims.length,
      reportedClaims.length,
      Number(report.claim_count || report.primary_claim_count || 0),
    ),
    open_question_count: openQuestions.length,
    recommended_action_count: actions.length,
    top_paper_count: topPapers.length,
    hypothesis_quality_score: hypothesisQualityScore,
    challenged_hypothesis_count: challengedCount,
    demoted_hypothesis_count: demotedCount,
    family_nomination_count: familyNomination.length,
    family_tournament_count: Number(familyTournament.family_count || 0),
    family_nomination: familyNomination,
    family_tournament: familyTournament,
    family_package_count: Number(familyPackageLedger.family_package_count || 0),
    family_package_ledger: familyPackageLedger,
    validation_results_count: validationResults.length,
    validation_results: validationResults.slice(0, 12),
    claim_trace_count: Number(artifacts.claimTraces.claim_trace_count || 0),
    claim_traces: Array.isArray(artifacts.claimTraces.claim_traces)
      ? artifacts.claimTraces.claim_traces.slice(0, 12)
      : [],
    next_cycle_plan: nextCyclePlan,
    evidence_readiness: evidenceReadiness,
    conclusion_readiness_score: conclusionScore,
    conclusion_readiness_band: conclusionBand,
    conclusion_blockers: conclusionBlockers,
    conclusion_rubric: conclusionRubric,
    approval_readiness_score: conclusionScore,
    approval_readiness_band: conclusionBand,
    approval_blockers: conclusionBlockers,
    approval_rubric: conclusionRubric,
    followup_rubric_progress: followupProgress,
    focus_hypotheses: focusHypotheses,
    derivable_hypothesis_candidates: derivableHypothesisCandidates,
    schema_quality: schemaQuality,
    reasoning_graph: reasoningGraph,
    reasoning_claims: reasoningClaims,
    open_validation_gaps: openValidationGaps,
    analysis_visuals: analysisVisuals,
    analysis_trace_count: Number(analysisTraceBundle.analysis_trace_count || 0),
    analysis_traces: analysisTraceBundle.analysis_traces,
    open_ended_experiment_count: Number(openEndedExperimentBundle.open_ended_experiment_count || 0),
    open_ended_experiment_completed_count: Number(openEndedExperimentBundle.open_ended_experiment_completed_count || 0),
    open_ended_new_hypothesis_count: Number(openEndedExperimentBundle.open_ended_new_hypothesis_count || 0),
    open_ended_figure_idea_count: Number(openEndedExperimentBundle.open_ended_figure_idea_count || 0),
    open_ended_experiments: openEndedExperimentBundle.open_ended_experiments,
    analysis_scoreboard: analysisScoreboard,
    chronicle_reporting: {
      what_changed_since_previous_pass: chronicleReportDigest.what_changed_since_previous_pass,
      claim_deltas: chronicleReportDigest.claim_deltas,
      robust_vs_exploratory: chronicleReportDigest.robust_vs_exploratory,
      open_questions: chronicleReportDigest.open_questions,
      recommended_actions: chronicleReportDigest.recommended_actions,
      hypothesis_changes: chronicleReportDigest.hypothesis_changes,
      supporting_evidence_paths: chronicleReportDigest.supporting_evidence_paths,
      approval_blockers: uniqueStrings([
        ...chronicleReportDigest.approval_blockers,
        ...conclusionBlockers,
      ]),
      graph_digests: {
        literature: knowledgeGraphDigest.literature_graph,
        reasoning: knowledgeGraphDigest.reasoning_graph,
        data: knowledgeGraphDigest.data_graph,
        analysis_scoreboard: {
          lane_count: Number(analysisScoreboard.lane_count || 0),
          score_ranges: analysisScoreboard.score_ranges || {},
          selected_grade_totals: analysisScoreboard.selected_grade_totals || {},
          generated_grade_totals: analysisScoreboard.generated_grade_totals || {},
        },
        open_ended_experiments: {
          lane_count: Number(openEndedExperimentBundle.open_ended_experiment_count || 0),
          completed_count: Number(openEndedExperimentBundle.open_ended_experiment_completed_count || 0),
          new_hypothesis_count: Number(openEndedExperimentBundle.open_ended_new_hypothesis_count || 0),
          figure_idea_count: Number(openEndedExperimentBundle.open_ended_figure_idea_count || 0),
        },
      },
      rival_family_adjudication: rivalFamilyAdjudication,
      latest_high_signal_lane_ids: chronicleReportDigest.latest_high_signal_lane_ids,
      report_path: chronicleReportDigest.report_path,
    },
    promoted_hypothesis_validation: promotedHypothesisValidation,
    illustrator_iterations: illustratorIterations,
    chronicle_checkpoint: chronicleCheckpoint,
    primary_visual_kind: finalClaimPackage.primary_figure_kind || visualNarrative.primary_visual_kind,
    lead_outcome: finalClaimPackage.lead_outcome,
    lead_outcome_label: finalClaimPackage.lead_outcome_label,
    hero_verdict: visualNarrative.hero_verdict,
    approval_path: visualNarrative.approval_path,
    reviewer_objections: visualNarrative.reviewer_objections,
    figure_recommendations: visualNarrative.figure_recommendations,
    visual_execution_mode: visualQa.preferred_mode,
    visual_execution_packets: visualExecutionPackets,
    visual_qa: visualQa,
    visual_refinement_brief: illustratorRefinementBrief,
    visual_improvement_notes: visualNarrative.visual_improvement_notes,
    chart_priority_list: visualNarrative.chart_priority_list,
    evidence_checkpoints: visualNarrative.evidence_checkpoints,
    visual_takeaways: visualNarrative.visual_takeaways,
    strongest_claim_summary: finalClaimPackage.lead_claim || visualNarrative.strongest_claim_summary,
    researcher_summary: researcherSummary,
    researcher_limits: researcherLimits,
    next_approval_step: nextApprovalStep,
    open_questions: finalClaimPackage.open_questions,
    final_claim_package_path: fs.existsSync(artifacts.finalClaimPackagePath)
      ? artifacts.finalClaimPackagePath
      : null,
    final_claim_package: finalClaimPackage,
    claim_bridge_rows: visualNarrative.claim_bridge_rows,
    primary_signal_rows: visualNarrative.primary_signal_rows,
    primary_outcome_rows: visualNarrative.primary_outcome_rows,
    primary_evidence: primaryEvidence,
    data_acquisition: dataAcquisition,
    knowledge_graph: knowledgeGraph,
    knowledge_graph_digest: knowledgeGraphDigest,
    knowledge_graph_explorer: knowledgeGraphExplorer,
    source_paths: {
      cycle_plan: artifacts.cyclePlanPath,
      cycle_state: artifacts.cycleStatePath,
      strategy_decision: artifacts.strategyDecisionPath,
      final_claim_package: fs.existsSync(artifacts.finalClaimPackagePath)
        ? artifacts.finalClaimPackagePath
        : null,
      literature: artifacts.literaturePath,
      hypothesis_ledger: artifacts.hypothesisLedgerPath,
      family_package_ledger: artifacts.familyPackageLedgerPath,
      family_nomination: artifacts.familyNominationPath,
      validation_results: artifacts.validationResultsPath,
      claim_traces: artifacts.claimTracesPath,
      next_cycle_plan: artifacts.nextCyclePlanPath,
      analysis_traces: analysisTraceBundle.analysis_traces.map((item) => item.path),
      open_ended_experiments: openEndedExperimentBundle.open_ended_experiments.map((item) => item.path).filter(Boolean),
      chronicle_reports: chronicleReportDigest.report_path,
      report: artifacts.reportJsonPath,
      aggregate_metrics: artifacts.aggregateMetricsPath,
      workgraph: artifacts.workgraphPath,
    },
  };

  fs.writeFileSync(htmlPath, html, "utf8");
  writeJson(jsonPath, payload);
  return {
    htmlPath,
    jsonPath,
    summary: payload,
  };
}

module.exports = {
  buildResearcherView,
};
