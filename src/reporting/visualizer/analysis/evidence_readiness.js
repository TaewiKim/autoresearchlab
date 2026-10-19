"use strict";

function computeEvidenceReadiness({ cycleState, report, literature, claims = [], focusHypotheses = [], hypothesisLedger = {} }) {
  const laneStatuses = Array.isArray(cycleState.lane_statuses) ? cycleState.lane_statuses : [];
  const isPrimaryEvidenceLane = (item) => {
    const laneId = String(item?.lane_id || "");
    if (laneId.startsWith("followup-")) return false;
    return ["scout", "analyst", "lab-runner"].includes(item.role);
  };
  const completedCoreLaneCount = laneStatuses.filter((item) => {
    return isPrimaryEvidenceLane(item) && item.status === "completed";
  }).length;
  const runningCoreLaneCount = laneStatuses.filter((item) => {
    return isPrimaryEvidenceLane(item) && item.status === "running";
  }).length;
  // All completed evidence-gathering lanes, INCLUDING followup-scout/followup-
  // runner — used to detect evidence saturation. Distinct from
  // completedCoreLaneCount (primary lanes only), which gates the normal path.
  const isEvidenceGatheringLane = (item) =>
    ["scout", "analyst", "lab-runner"].includes(item.role);
  const completedEvidenceLaneCount = laneStatuses.filter((item) => {
    return isEvidenceGatheringLane(item) && item.status === "completed";
  }).length;
  const reportClaimCount = Number(
    report.claim_count ||
    report.primary_claim_count ||
    ((Array.isArray(report.primary_claims) ? report.primary_claims.length : 0) +
      (Array.isArray(report.supporting_claims) ? report.supporting_claims.length : 0)) ||
    0,
  );
  const hasClaims = reportClaimCount > 0 || (Array.isArray(claims) && claims.length > 0);
  const hasHypotheses =
    Number((literature && literature.hypothesis_count) || 0) > 0 ||
    Number(hypothesisLedger?.hypothesis_count || 0) > 0 ||
    (Array.isArray(focusHypotheses) && focusHypotheses.length > 0);
  const reportPrimaryEvidence = report.primary_evidence || {};
  const hasReportPrimaryEvidence =
    Number.isFinite(Number(reportPrimaryEvidence.adjusted_life)) ||
    Number.isFinite(Number(reportPrimaryEvidence.pooled_life)) ||
    Number.isFinite(Number(reportPrimaryEvidence.checks_passed_count));
  const reportEvidenceReady =
    hasReportPrimaryEvidence &&
    reportClaimCount > 0 &&
    Number(reportPrimaryEvidence.checks_passed_count || 0) >= 4;
  const ready =
    (completedCoreLaneCount >= 2 || reportEvidenceReady) &&
    runningCoreLaneCount === 0 &&
    (hasClaims || hasHypotheses);

  return {
    ready,
    completed_core_lane_count: completedCoreLaneCount,
    completed_evidence_lane_count: completedEvidenceLaneCount,
    running_core_lane_count: runningCoreLaneCount,
    reasons: [
      completedCoreLaneCount < 2 && !reportEvidenceReady
        ? "wait for at least two completed core analysis lanes"
        : "",
      runningCoreLaneCount > 0 ? "wait for running core analysis lanes to finish" : "",
      !hasClaims && !hasHypotheses ? "wait for claims or literature-backed hypotheses to accumulate" : "",
    ].filter(Boolean),
  };
}

module.exports = { computeEvidenceReadiness };
