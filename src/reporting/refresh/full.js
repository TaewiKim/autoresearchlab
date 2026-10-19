"use strict";

const { buildHypothesisLedger } = require("../../agents/chronicle/hypothesis_ledger");
const { synthesizeCycleLiterature } = require("../../agents/chronicle/literature_synthesis");
const { buildApprovalReview } = require("../approval_review");
const { buildConclusionReview } = require("../conclusion_review");
const { buildDocumentArtifacts } = require("../document_artifacts");
const { buildPaperReview, buildReportReview } = require("../document_reviews");
const { buildGateReview } = require("../gate_review");
const { buildResearcherView } = require("../visualizer/researcher_view");
const { buildArtifactReviewMap } = require("../artifact_review_map");
const { ensureAgentCommunicationDigest } = require("../agent_communication_digest");
const { ensureAgentMailboxes } = require("../agent_mailbox");
const { ensureAgentProtocolSnapshot } = require("../agent_protocol");
const { ensureAnalystResearchNotes } = require("../analyst_research_notes");
const { ensureChronicleResearchNotes } = require("../chronicle_research_notes");
const { ensureCycleMemory } = require("../cycle_memory");
const { ensureLabDirectorResearchNotes } = require("../lab_director_research_notes");
const { readTerminationCode } = require("../termination_code");
const { buildPendingRefreshSnapshot } = require("./pending");
const { inferRefreshStage, refreshCycleState, summarizeCycleState } = require("./state");

function refreshCycleOutputs({ cwd = process.cwd(), cycleId, aggregateRunner }) {
  refreshCycleState({ cwd, cycleId, aggregateRunner });
  const cycleSummary = summarizeCycleState({ cwd, cycleId });
  if (cycleSummary.pendingCoreAnalysis) {
    return buildPendingRefreshSnapshot({
      cwd,
      cycleId,
      cycleSummary,
    });
  }
  const researchStage = inferRefreshStage({
    root: cycleSummary.root,
    cycleId,
  });
  const literature = synthesizeCycleLiterature({ cwd, cycleId, researchStage });
  const hypothesisLedger = buildHypothesisLedger({ cwd, cycleId });
  let researcherView = buildResearcherView({ cwd, cycleId });
  let conclusionReview = buildConclusionReview({ cwd, cycleId, researcherView });
  let approvalReview = buildApprovalReview({ cwd, cycleId, researcherView });
  let gateReview = buildGateReview({
    cwd,
    cycleId,
    researcherView,
    conclusionReview,
    approvalReview,
  });
  // A document artifact that cannot be built is a defect to record, not a
  // reason to end the research pass: the pass that fails here is also the one
  // that dispatches lanes, so an unbuildable figure used to stop the science.
  // The document reviews below read the newest artifact on disk when handed
  // null, so the cycle degrades to its previous revision instead of dying.
  let documentArtifacts = null;
  let documentArtifactsFailure = null;
  try {
    documentArtifacts = buildDocumentArtifacts({
      cwd,
      cycleId,
      researcherView,
      gateReview,
    });
  } catch (error) {
    documentArtifactsFailure = {
      failed_at: new Date().toISOString(),
      message: String(error?.message || error),
    };
  }
  if (documentArtifacts?.report_path || documentArtifacts?.paper_path) {
    researcherView = buildResearcherView({ cwd, cycleId });
    conclusionReview = buildConclusionReview({ cwd, cycleId, researcherView });
    approvalReview = buildApprovalReview({ cwd, cycleId, researcherView });
    gateReview = buildGateReview({
      cwd,
      cycleId,
      researcherView,
      conclusionReview,
      approvalReview,
    });
  }
  const reportReview = buildReportReview({
    cwd,
    cycleId,
    documentArtifacts,
  });
  const paperReview = buildPaperReview({
    cwd,
    cycleId,
    documentArtifacts,
  });
  if (documentArtifacts?.report_path || documentArtifacts?.paper_path || paperReview?.review?.paper_gate_passed === true) {
    researcherView = buildResearcherView({ cwd, cycleId });
    conclusionReview = buildConclusionReview({ cwd, cycleId, researcherView });
    approvalReview = buildApprovalReview({ cwd, cycleId, researcherView });
    gateReview = buildGateReview({
      cwd,
      cycleId,
      researcherView,
      conclusionReview,
      approvalReview,
    });
  }
  approvalReview = buildApprovalReview({
    cwd,
    cycleId,
    researcherView,
    conclusionReview,
    gateReview,
    reportReview,
    paperReview,
    staged: true,
  });
  const artifactReviewMap = buildArtifactReviewMap({
    cwd,
    cycleId,
    cycleState: cycleSummary.cycleState,
  });
  const labDirectorResearchNotes = ensureLabDirectorResearchNotes({
    root: cycleSummary.root,
    cycleId,
  });
  const chronicleResearchNotes = ensureChronicleResearchNotes({
    root: cycleSummary.root,
    cycleId,
  });
  const analystResearchNotes = ensureAnalystResearchNotes({
    root: cycleSummary.root,
    cycleId,
  });
  const agentCommunicationDigest = ensureAgentCommunicationDigest({
    root: cycleSummary.root,
    cycleId,
  });
  const cycleMemory = ensureCycleMemory({
    root: cycleSummary.root,
    cycleId,
  });
  const agentMailboxes = ensureAgentMailboxes({
    root: cycleSummary.root,
    cycleId,
  });
  const agentProtocol = ensureAgentProtocolSnapshot({
    root: cycleSummary.root,
    cycleId,
  });

  return {
    cycle_id: cycleId,
    termination_code: readTerminationCode({ cwd, cycleId }),
    literature,
    hypothesis_ledger: hypothesisLedger,
    researcher_view: researcherView,
    conclusion_review: conclusionReview,
    approval_review: approvalReview,
    gate_review: gateReview,
    document_artifacts: documentArtifacts,
    document_artifacts_failure: documentArtifactsFailure,
    report_review: reportReview,
    paper_review: paperReview,
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
  refreshCycleOutputs,
};
