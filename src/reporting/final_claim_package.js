"use strict";

// Kept utilities after the WHO-specific ``buildFinalClaimPackage`` pipeline
// was removed:
//
// * ``buildClaimLedgerSummary`` — canonical cross-surface claim-count
//   summary (revision P1-1). Reads the hypothesis ledger + the latest
//   research report and emits a single state file every UI/card can
//   consume. Completely domain-neutral.
//
// * ``attachUnifiedReviewFields`` — trivial helper that stitches a review
//   object with the harness's standard score/blockers/decision fields.
//
// Previously this file also hosted ``buildFinalClaimPackage`` and helpers
// (``normalizeLeadOutcomeLabel``, ``inferLeadOutcome``,
// ``mapDecisionMode``, ``validateFinalizationConsistency``) that hard-wired
// WHO DTP3 → life-expectancy / neonatal-mortality semantics. Those have
// been deleted — downstream surfaces now rely on the illustrator lane HTML
// and the author lane narrative instead of a single cross-cutting claim
// package.

const path = require("path");
const { ensureDir, writeJson, readJson } = require("../shared/json");

function readJsonIfExists(filePath) {
  if (!filePath) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function buildClaimLedgerSummary({ root, cycleId }) {
  const ledgerPath = path.join(root, "state", `${cycleId}-hypothesis-ledger.json`);
  const ledger = readJsonIfExists(ledgerPath) || {};
  const aggregatePath = path.join(root, "state", `${cycleId}-cycle-aggregate-metrics.json`);
  const aggregate = readJsonIfExists(aggregatePath) || {};

  let reportJson = null;
  try {
    const reportsDir = path.join(root, "reports");
    const reportPrefix = `${cycleId}-research-report-v`;
    if (require("fs").existsSync(reportsDir)) {
      const candidates = require("fs")
        .readdirSync(reportsDir)
        .filter((name) => name.startsWith(reportPrefix) && name.endsWith(".json"))
        .sort();
      const latest = candidates[candidates.length - 1];
      if (latest) reportJson = readJsonIfExists(path.join(reportsDir, latest));
    }
  } catch {
    // leave reportJson null; summary still useful
  }
  const primaryInReport = Number(
    (reportJson?.primary_claim_count != null
      ? reportJson.primary_claim_count
      : Array.isArray(reportJson?.primary_claims) ? reportJson.primary_claims.length : 0) || 0,
  );
  const supportingInReport = Number(
    (reportJson?.supporting_claim_count != null
      ? reportJson.supporting_claim_count
      : Array.isArray(reportJson?.supporting_claims) ? reportJson.supporting_claims.length : 0) || 0,
  );

  const summary = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    candidate_count: Number(ledger.candidate_count || 0),
    contending_count: Number(ledger.contending_count || 0),
    claim_candidate_count: Number(ledger.claim_candidate_count || 0),
    provisionally_promoted_count: Number(ledger.provisionally_promoted_count || 0),
    promoted_count: Number(ledger.promoted_count || 0),
    strengthened_count: Number(ledger.strengthened_count || 0),
    weakened_count: Number(ledger.weakened_count || 0),
    challenged_count: Number(ledger.challenged_count || 0),
    demoted_count: Number(ledger.demoted_count || 0),
    retired_count: Number(ledger.retired_count || 0),
    hypothesis_count: Number(ledger.hypothesis_count || 0),
    focus_hypothesis_count: Array.isArray(ledger.focus_hypotheses) ? ledger.focus_hypotheses.length : 0,
    primary_in_report_count: primaryInReport,
    supporting_in_report_count: supportingInReport,
    total_claim_surfaces: primaryInReport + supportingInReport,
    cycle_cumulative_claim_delta: Number(aggregate.claim_delta_count || 0),
    cycle_cumulative_primary_claim: Number(aggregate.primary_claim_count || 0),
    cycle_cumulative_supporting_claim: Number(aggregate.supporting_claim_count || 0),
    average_hypothesis_score: Number(ledger.average_hypothesis_score || 0),
    average_evidence_quality_score: Number(ledger.average_evidence_quality_score || 0),
  };

  const outputPath = path.join(root, "state", `${cycleId}-claim-ledger-summary.json`);
  ensureDir(path.dirname(outputPath));
  writeJson(outputPath, summary);
  return { summary, outputPath };
}

function attachUnifiedReviewFields(review, {
  score = null,
  pass = false,
  blockers = [],
  recommendedActions = [],
  decisionMode = null,
  decisionReason = null,
}) {
  return {
    ...review,
    score,
    pass,
    blockers,
    recommended_actions: recommendedActions,
    decision_mode: decisionMode,
    decision_reason: decisionReason,
  };
}

module.exports = {
  attachUnifiedReviewFields,
  buildClaimLedgerSummary,
  readJsonIfExists,
};
