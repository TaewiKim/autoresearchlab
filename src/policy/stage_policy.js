"use strict";

// "engineer" provisions the capability the analyst's design declares it needs
// and proves it runs here; the analyst reasons and the lab-runner writes and
// executes the code. It sits in every stage that can dispatch a runner, because
// a runner that cannot execute is the case the engineer exists to answer, and
// that case appears at evidence, conclusion and gate alike. See
// src/agents/engineer/environment_plan.js for the boundary.
const STAGE_ROLE_POLICY = Object.freeze({
  evidence: ["chronicle", "scout", "analyst", "engineer", "lab-runner"],
  conclusion: ["chronicle", "scout", "analyst", "engineer", "lab-runner"],
  // "falsifier" is an adversarial variant of gatekeeper used to inject
  // external refutation pressure during the gate stage. See
  // src/agents/index.js "falsifier" case (item #4 of the hypothesis-
  // pipeline hardening pass) and the review_mode=falsifier variant on
  // the gatekeeper role.
  gate: ["chronicle", "gatekeeper", "falsifier", "scout", "analyst", "engineer", "lab-runner"],
  document: ["chronicle", "author", "illustrator"],
  done: [],
});

const PLANNING_ONLY_SCOPE = "planning-only";

function normalizeResearchScope(scope = null) {
  return String(scope || process.env.RESEARCHLAB_RESEARCH_SCOPE || "")
    .trim()
    .toLowerCase();
}

function isPlanningOnlyScope(scope = null) {
  return normalizeResearchScope(scope) === PLANNING_ONLY_SCOPE;
}

function normalizeResearchStage(stage) {
  const value = String(stage || "").trim().toLowerCase();
  return STAGE_ROLE_POLICY[value] ? value : "evidence";
}

function readResearchOutcome(summary) {
  const explicit =
    summary?.researcher_view?.summary?.research_outcome ||
    summary?.researcher_view?.summary?.final_claim_package?.research_outcome ||
    (summary?.report_review?.review?.decision_mode === "approved" ? "approved" : null);
  return explicit ? String(explicit).trim().toLowerCase() : null;
}

function readDecisionMode(summary) {
  const explicit =
    summary?.researcher_view?.summary?.decision_mode ||
    summary?.researcher_view?.summary?.final_claim_package?.decision_mode ||
    summary?.report_review?.review?.decision_mode ||
    summary?.paper_review?.review?.decision_mode ||
    summary?.gate_review?.review?.decision_mode ||
    summary?.approval_review?.review?.decision_mode ||
    null;
  return explicit ? String(explicit).trim().toLowerCase() : null;
}

function conclusionPassed(summary) {
  const outcome = readResearchOutcome(summary);
  if (["approved", "refine", "pivot"].includes(String(outcome || ""))) {
    return true;
  }
  return (
    summary?.conclusion_review?.review?.exploratory_gate_passed === true ||
    summary?.conclusion_review?.review?.conclusion_gate_passed === true
  );
}

function gatePassed(summary) {
  const outcome = readResearchOutcome(summary);
  if (outcome === "approved") return true;
  return summary?.gate_review?.review?.gate_passed === true;
}

function documentPassed(summary) {
  return (
    summary?.report_review?.review?.communication_gate_passed === true &&
    summary?.paper_review?.review?.submission_gate_passed === true
  );
}

function approvalPassed(summary) {
  const outcome = readResearchOutcome(summary);
  if (outcome === "approved") {
    return documentPassed(summary);
  }
  return conclusionPassed(summary) && gatePassed(summary) && documentPassed(summary);
}

function readEvidenceState(summary) {
  const review = summary?.approval_review?.review || {};
  const evidence = review.evidence_readiness || summary?.researcher_view?.summary?.evidence_readiness || {};
  return {
    mode: review.mode || null,
    ready: evidence.ready === true,
    completedCoreLaneCount: Number(evidence.completed_core_lane_count || 0),
    completedEvidenceLaneCount: Number(evidence.completed_evidence_lane_count || 0),
    runningCoreLaneCount: Number(evidence.running_core_lane_count || 0),
    claimCount: Number(summary?.researcher_view?.summary?.claim_count || 0),
    hypothesisCount: Number(
      summary?.literature?.summary?.hypothesis_count || summary?.literature?.hypothesis_count || 0,
    ),
    researchOutcome: readResearchOutcome(summary),
    decisionMode: readDecisionMode(summary),
  };
}

// Once this many evidence-gathering lanes (incl. followup-scout) have completed
// with nothing running, gathering MORE evidence will not, by itself, produce
// claims or hypotheses — only the analyst stage does. Beyond this point we stop
// waiting-for-evidence so the cycle advances (evidence -> conclusion, where the
// analyst is still in the role policy) instead of looping on scout expansion.
const EVIDENCE_SATURATION_LANES = 8;

function shouldContinueForEvidence(summary) {
  const state = readEvidenceState(summary);
  if (state.ready) return false;
  if (state.mode !== "wait") return false;
  if (state.runningCoreLaneCount > 0) return true;
  if (state.completedCoreLaneCount < 2) return true;
  if (state.claimCount > 0 || state.hypothesisCount > 0) return false;
  // No claims/hypotheses yet. Keep waiting ONLY while evidence gathering is
  // still plausibly productive; once saturated, advance so the analyst runs and
  // converts the gathered evidence into hypotheses (breaks the deadlock where
  // readiness needs hypotheses but the analyst that creates them never runs).
  return state.completedEvidenceLaneCount < EVIDENCE_SATURATION_LANES;
}

function gateFollowupActions(summary) {
  const review = summary?.gate_review?.review || {};
  if (Array.isArray(review.recommended_actions)) return review.recommended_actions;
  return Array.isArray(review.recommended_followup_actions)
    ? review.recommended_followup_actions
    : [];
}

function gateRestartDemand(summary) {
  const review = summary?.gate_review?.review || {};
  const verdict = String(review.verdict || review.gatekeeper_review?.verdict || "").trim().toLowerCase();
  const mode = String(review.mode || "").trim().toLowerCase();
  const decisionMode = String(review.decision_mode || "").trim().toLowerCase();
  if (review.restart_recommended === true) return true;
  if (verdict === "reject") return true;
  if (mode === "reject") return true;
  if (decisionMode === "pivot" || decisionMode === "restart") return true;
  return gateFollowupActions(summary).some((item) => String(item?.type || "") === "gate_restart_followup");
}

function stageForSummary(summary) {
  const outcome = readResearchOutcome(summary);
  if (outcome === "approved") {
    return documentPassed(summary) ? "done" : "document";
  }
  if (outcome === "pivot") {
    return "evidence";
  }
  const gateDecisionMode = String(summary?.gate_review?.review?.decision_mode || "").trim().toLowerCase();
  if (gateDecisionMode === "pivot" || gateRestartDemand(summary)) {
    return "evidence";
  }
  if (outcome === "stopped_without_conclusion") {
    return shouldContinueForEvidence(summary) ? "evidence" : "conclusion";
  }
  if (!conclusionPassed(summary)) {
    return shouldContinueForEvidence(summary) ? "evidence" : "conclusion";
  }
  if (!gatePassed(summary)) {
    return gateRestartDemand(summary) ? "evidence" : "gate";
  }
  return documentPassed(summary) ? "done" : "document";
}

function allowedRolesForStage(stage, options = {}) {
  const normalized = normalizeResearchStage(stage);
  const includeSupervisor = options.includeSupervisor !== false;
  // A planning-only cycle runs nothing, so it neither executes validation code
  // nor installs the tools that would execute it.
  const executionRoles = new Set(["lab-runner", "engineer"]);
  const roles = STAGE_ROLE_POLICY[normalized].filter(
    (role) => !(isPlanningOnlyScope(options.researchScope) && executionRoles.has(role)),
  );
  if (includeSupervisor) {
    roles.unshift("lab-director");
  }
  return Array.from(new Set(roles));
}

function isRoleAllowedForStage(stage, role, options = {}) {
  return allowedRolesForStage(stage, options).includes(String(role || "").trim());
}

module.exports = {
  PLANNING_ONLY_SCOPE,
  STAGE_ROLE_POLICY,
  isPlanningOnlyScope,
  normalizeResearchScope,
  normalizeResearchStage,
  conclusionPassed,
  gatePassed,
  documentPassed,
  approvalPassed,
  readResearchOutcome,
  readDecisionMode,
  readEvidenceState,
  shouldContinueForEvidence,
  gateFollowupActions,
  gateRestartDemand,
  stageForSummary,
  allowedRolesForStage,
  isRoleAllowedForStage,
};
