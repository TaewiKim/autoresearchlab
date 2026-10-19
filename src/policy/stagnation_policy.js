"use strict";

const { readEvidenceState, approvalPassed, conclusionPassed, readResearchOutcome, readDecisionMode } = require("./stage_policy");
const { hasRegenerationDemand, hasConclusionWorkRemaining } = require("./retry_policy");

function evidenceFingerprint(summary) {
  const state = readEvidenceState(summary);
  return [
    state.mode || "none",
    state.ready ? "ready" : "waiting",
    state.completedCoreLaneCount,
    state.runningCoreLaneCount,
    state.claimCount,
    state.hypothesisCount,
  ].join(":");
}

function summaryFingerprint(summary) {
  const conclusion = summary?.conclusion_review?.review || {};
  const gate = summary?.gate_review?.review || {};
  const report = summary?.report_review?.review || {};
  const paper = summary?.paper_review?.review || {};
  const literature = summary?.literature?.summary || {};
  const ledger = summary?.hypothesis_ledger?.summary || {};
  const followups = Array.isArray(conclusion.recommended_followup_actions)
    ? conclusion.recommended_followup_actions.map((item) => item.type || "unknown").sort().join(",")
    : "";
  const gateFollowups = Array.isArray(gate.recommended_followup_actions)
    ? gate.recommended_followup_actions.map((item) => item.type || "unknown").sort().join(",")
    : "";
  return [
    readResearchOutcome(summary) || "outcome-none",
    readDecisionMode(summary) || "decision-none",
    conclusion.conclusion_score ?? "na",
    conclusion.conclusion_gate_passed ? "c1" : "c0",
    gate.mode || "g-none",
    gate.gatekeeper_review_status || "gk-none",
    gate.lab_director_response_status || "ld-none",
    gate.gate_passed ? "g1" : "g0",
    report.report_gate_passed ? "r1" : "r0",
    paper.paper_gate_passed ? "p1" : "p0",
    literature.hypothesis_count || 0,
    literature.claim_count || 0,
    ledger.promoted_count || 0,
    ledger.strengthened_count || 0,
    ledger.challenged_count || 0,
    ledger.demoted_count || 0,
    followups,
    gateFollowups,
  ].join(":");
}

function shouldBreakForStagnation({
  summary,
  stagnantRounds,
  stagnationBreakEnabled,
  latestPassProducedWork,
}) {
  const currentEvidenceState = readEvidenceState(summary);
  // Before the approval gate passes, stagnation is normally a pivot signal, not
  // a terminal condition — keep the cycle alive so the LabDirector can request a
  // structurally new hypothesis/design family. BUT bound the runaway: if the
  // summary fingerprint (followup types, gate state, ledger counts) has been
  // unchanged for many rounds with nothing promoted and no lanes running, more
  // followup expansion is provably unproductive (the cause is upstream, e.g. a
  // validation blocker that repeats every pass) and the cycle will otherwise
  // balloon indefinitely. Terminate so it concludes with current evidence
  // instead of spawning forever. Threshold is high to preserve genuine pivoting.
  if (!approvalPassed(summary)) {
    const promotedCount = Number(summary?.hypothesis_ledger?.summary?.promoted_count || 0);
    const pregateSaturationRounds = Number(process.env.RESEARCHLAB_PREGATE_SATURATION_ROUNDS || 8);
    if (
      stagnationBreakEnabled &&
      stagnantRounds >= pregateSaturationRounds &&
      promotedCount === 0 &&
      currentEvidenceState.runningCoreLaneCount === 0 &&
      !hasRegenerationDemand(summary)
    ) {
      return true;
    }
    return false;
  }
  if (!latestPassProducedWork && currentEvidenceState.runningCoreLaneCount === 0) {
    return true;
  }
  if (!stagnationBreakEnabled) return false;
  const outcome = readResearchOutcome(summary);
  if (outcome === "pivot") return false;
  return (
    stagnantRounds >= 3 &&
    !conclusionPassed(summary) &&
    currentEvidenceState.runningCoreLaneCount === 0 &&
    !hasRegenerationDemand(summary) &&
    !hasConclusionWorkRemaining(summary)
  );
}

module.exports = {
  evidenceFingerprint,
  summaryFingerprint,
  shouldBreakForStagnation,
};
