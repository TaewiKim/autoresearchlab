"use strict";

const path = require("path");
const { buildApprovalReview } = require("../approval_review");
const { buildConclusionReview } = require("../conclusion_review");
const { buildGateReview } = require("../gate_review");
const { buildPaperReview, buildReportReview } = require("../document_reviews");
const { buildArtifactReviewMap } = require("../artifact_review_map");
const { ensureAgentCommunicationDigest } = require("../agent_communication_digest");
const { ensureAgentMailboxes } = require("../agent_mailbox");
const { ensureAgentProtocolSnapshot } = require("../agent_protocol");
const { ensureAnalystResearchNotes } = require("../analyst_research_notes");
const { ensureChronicleResearchNotes } = require("../chronicle_research_notes");
const { ensureCycleMemory } = require("../cycle_memory");
const { ensureLabDirectorResearchNotes } = require("../lab_director_research_notes");
const { readTerminationCode } = require("../termination_code");
const { refreshStoredPrimaryEvidence } = require("./primary_evidence");
const { pendingEvidenceReadiness, pendingRefreshReasons, readJsonIfExists } = require("./state");

function attachPendingEvidenceMetadata({ researcherView, cycleSummary }) {
  if (!researcherView?.summary) return researcherView;
  const existing = researcherView.summary.evidence_readiness || {};
  const reasons = [
    ...(Array.isArray(existing.reasons) ? existing.reasons : []),
    ...pendingRefreshReasons(cycleSummary),
  ].filter((item, index, items) => item && items.indexOf(item) === index);
  researcherView.summary.evidence_readiness = {
    ...existing,
    pending_lane_count: cycleSummary.pendingLaneCount,
    running_lane_count: cycleSummary.runningLaneCount,
    pending_core_lane_count: cycleSummary.pendingCoreLaneCount,
    running_core_lane_count: Math.max(
      Number(existing.running_core_lane_count || 0),
      cycleSummary.runningCoreLaneCount,
    ),
    deferred_full_refresh: true,
    reasons,
  };
  researcherView.summary.cycle_state = cycleSummary.cycleState;
  researcherView.summary.cycle_status = cycleSummary.cycleState?.status || researcherView.summary.cycle_status || "running";
  researcherView.summary.execution_completion = researcherView.summary.cycle_status;
  researcherView.summary.partial_gate_refresh = true;
  researcherView.summary.source_paths = {
    ...(researcherView.summary.source_paths || {}),
    cycle_state: cycleSummary.cycleStatePath,
  };
  return researcherView;
}

function buildPendingGateRefresh({ cwd, cycleId, cycleSummary, fallbackResearcherView, existingReportReview, existingPaperReview }) {
  let gateRefresh = null;
  let gateRefreshError = null;
  try {
    const researcherView = attachPendingEvidenceMetadata({
      researcherView: fallbackResearcherView,
      cycleSummary,
    });
    const conclusionReview = buildConclusionReview({ cwd, cycleId, researcherView });
    const approvalForGate = {
      review: {
        ...(conclusionReview?.review || {}),
        type: "approval_review",
        approval_readiness_score: conclusionReview?.review?.conclusion_score ?? null,
        approval_readiness_band: conclusionReview?.review?.conclusion_band || "unknown",
        approval_blockers: conclusionReview?.review?.conclusion_blockers || [],
        approval_rubric: conclusionReview?.review?.conclusion_rubric || [],
        approval_gate_passed: conclusionReview?.review?.conclusion_gate_passed === true,
      },
    };
    const gateReview = buildGateReview({
      cwd,
      cycleId,
      researcherView,
      conclusionReview,
      approvalReview: approvalForGate,
    });
    const reportReview = existingReportReview
      ? { reviewPath: path.join(cycleSummary.root, "state", `${cycleId}-report-review.json`), review: existingReportReview }
      : null;
    const paperReview = existingPaperReview
      ? { reviewPath: path.join(cycleSummary.root, "state", `${cycleId}-paper-review.json`), review: existingPaperReview }
      : null;
    const approvalReview = buildApprovalReview({
      cwd,
      cycleId,
      researcherView,
      conclusionReview,
      gateReview,
      reportReview,
      paperReview,
      staged: true,
    });
    gateRefresh = {
      researcherView,
      conclusionReview,
      approvalReview,
      gateReview,
      reportReview,
      paperReview,
    };
  } catch (error) {
    gateRefreshError = error?.message || String(error);
  }
  return { gateRefresh, gateRefreshError };
}

function buildPendingRefreshSnapshot({ cwd, cycleId, cycleSummary }) {
  const root = cycleSummary.root;
  const existingLiterature = readJsonIfExists(path.join(root, "state", `${cycleId}-literature-summary.json`));
  const existingLedger = readJsonIfExists(path.join(root, "state", `${cycleId}-hypothesis-ledger.json`));
  const existingReportReview = readJsonIfExists(path.join(root, "state", `${cycleId}-report-review.json`));
  const existingPaperReview = readJsonIfExists(path.join(root, "state", `${cycleId}-paper-review.json`));
  // This path does not rebuild the researcher view, so its evidence is
  // recomputed here; otherwise the gate reads whatever runner the view named
  // when it was last built (see primary_evidence.js).
  const existingResearcherView = refreshStoredPrimaryEvidence({ root, cycleId }).view;
  const existingConclusionReview = readJsonIfExists(path.join(root, "state", `${cycleId}-conclusion-review.json`));
  const existingApprovalReview = readJsonIfExists(path.join(root, "state", `${cycleId}-approval-review.json`));
  const existingGateReview = readJsonIfExists(path.join(root, "state", `${cycleId}-gate-review.json`));
  const fallbackResearcherView = existingResearcherView
    ? {
        jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
        summary: existingResearcherView,
      }
    : {
        jsonPath: null,
        summary: {
          cycle_id: cycleId,
          cycle_status: cycleSummary.cycleState?.status || "running",
          evidence_readiness: pendingEvidenceReadiness(cycleSummary),
          source_paths: {
            cycle_state: cycleSummary.cycleStatePath,
          },
        },
      };
  const { gateRefresh, gateRefreshError } = buildPendingGateRefresh({
    cwd,
    cycleId,
    cycleSummary,
    fallbackResearcherView,
    existingReportReview,
    existingPaperReview,
  });
  const artifactReviewMap = buildArtifactReviewMap({
    cwd,
    cycleId,
    cycleState: cycleSummary.cycleState,
  });
  const labDirectorResearchNotes = ensureLabDirectorResearchNotes({ root, cycleId });
  const chronicleResearchNotes = ensureChronicleResearchNotes({ root, cycleId });
  const analystResearchNotes = ensureAnalystResearchNotes({ root, cycleId });
  const agentCommunicationDigest = ensureAgentCommunicationDigest({ root, cycleId });
  const cycleMemory = ensureCycleMemory({ root, cycleId });
  const agentMailboxes = ensureAgentMailboxes({ root, cycleId });
  const agentProtocol = ensureAgentProtocolSnapshot({ root, cycleId });
  return {
    cycle_id: cycleId,
    refresh_deferred: true,
    refresh_deferred_reason: "wait for core analysis lanes to finish before document materialization",
    gate_refresh_applied: Boolean(gateRefresh),
    gate_refresh_error: gateRefreshError,
    termination_code: readTerminationCode({ cwd, cycleId }),
    cycle_state: cycleSummary.cycleState,
    literature: existingLiterature,
    hypothesis_ledger: existingLedger,
    researcher_view: gateRefresh?.researcherView || fallbackResearcherView,
    conclusion_review: gateRefresh?.conclusionReview || (existingConclusionReview
      ? { reviewPath: path.join(root, "state", `${cycleId}-conclusion-review.json`), review: existingConclusionReview }
      : null),
    approval_review: gateRefresh?.approvalReview || (existingApprovalReview
      ? { reviewPath: path.join(root, "state", `${cycleId}-approval-review.json`), review: existingApprovalReview }
      : null),
    gate_review: gateRefresh?.gateReview || (existingGateReview
      ? { reviewPath: path.join(root, "state", `${cycleId}-gate-review.json`), review: existingGateReview }
      : null),
    report_review: gateRefresh?.reportReview || (existingReportReview
      ? { reviewPath: path.join(root, "state", `${cycleId}-report-review.json`), review: existingReportReview }
      : null),
    paper_review: gateRefresh?.paperReview || (existingPaperReview
      ? { reviewPath: path.join(root, "state", `${cycleId}-paper-review.json`), review: existingPaperReview }
      : null),
    lab_director_research_notes: labDirectorResearchNotes,
    chronicle_research_notes: chronicleResearchNotes,
    analyst_research_notes: analystResearchNotes,
    agent_communication_digest: agentCommunicationDigest,
    cycle_memory: cycleMemory,
    agent_mailboxes: agentMailboxes,
    agent_protocol: agentProtocol,
    artifact_review_map: artifactReviewMap,
  };
}

module.exports = {
  attachPendingEvidenceMetadata,
  buildPendingRefreshSnapshot,
};
