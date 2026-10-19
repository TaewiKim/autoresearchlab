"use strict";

const { formatSigned } = require("./shared");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildRivalFamilyAdjudication({ familyNomination = [], familyPackageLedger = {}, nextCyclePlan = {}, analysisScoreboard = {}, validationResults = [] }) {
  const packages = Array.isArray(familyPackageLedger?.family_packages) ? familyPackageLedger.family_packages : [];
  const nominationByFamily = new Map(
    (Array.isArray(familyNomination) ? familyNomination : []).map((item) => [String(item.family_root || "").trim(), item]),
  );
  const coverageByFamily = new Map(
    (Array.isArray(analysisScoreboard?.family_coverage) ? analysisScoreboard.family_coverage : [])
      .map((item) => [String(item.family_root || "").trim(), Number(item.lane_count || 0)]),
  );
  const validationCounts = new Map();
  for (const item of Array.isArray(validationResults) ? validationResults : []) {
    for (const familyId of Array.isArray(item?.target_family_ids) ? item.target_family_ids : []) {
      const key = String(familyId || "").replace(/^family:/, "").trim();
      if (!key) continue;
      validationCounts.set(key, Number(validationCounts.get(key) || 0) + 1);
    }
  }
  const nextPlanByFamily = new Map(
    (Array.isArray(nextCyclePlan?.prioritized_families) ? nextCyclePlan.prioritized_families : [])
      .map((item) => [String(item.family_root || "").trim(), item]),
  );
  const fallbackPackages = Array.isArray(analysisScoreboard?.family_coverage)
    ? analysisScoreboard.family_coverage.map((item) => ({
        family_root: String(item.family_root || "").trim(),
        package_state: "coverage_only",
        support_count: 0,
        family_score: 0,
        top_hypothesis_score: 0,
        rival_family_ids: [],
      }))
    : [];
  const rankedPackages = (packages.length > 0 ? packages : fallbackPackages).slice(0, 8);

  return rankedPackages.map((pkg) => {
    const familyRoot = String(pkg.family_root || "").trim();
    const nomination = nominationByFamily.get(familyRoot) || {};
    const nextPlan = nextPlanByFamily.get(familyRoot) || {};
    const rivalIds = Array.isArray(pkg.rival_family_ids) ? pkg.rival_family_ids : [];
    const verdict =
      pkg.package_state === "provisionally_promoted"
        ? "leading"
        : pkg.package_state === "challenged"
          ? "contested"
          : pkg.package_state === "demoted"
            ? "trailing"
            : "open";
    return {
      family_root: familyRoot,
      verdict,
      package_state: pkg.package_state || "candidate",
      support_count: Number(pkg.support_count || 0),
      family_score: Number(pkg.family_score || 0),
      top_hypothesis_score: Number(pkg.top_hypothesis_score || 0),
      lane_coverage: Number(coverageByFamily.get(familyRoot) || 0),
      validation_count: Number(validationCounts.get(familyRoot) || 0),
      distinctiveness_score: Number(nomination.distinctiveness_score || 0),
      rival_family_ids: rivalIds.slice(0, 6),
      adjudication_note:
        nextPlan.rationale ||
        nomination.nomination_reason ||
        (verdict === "leading"
          ? "Family currently leads but still needs explicit rival checks before lock-in."
          : verdict === "contested"
            ? "Family remains active but is not yet separated from its closest rivals."
            : "Family has not yet earned clear priority over rival explanations."),
    };
  });
}

function inferPreferredLeadOutcome(chronicleCheckpoint) {
  const brief = chronicleCheckpoint?.brief;
  if (!brief || typeof brief !== "object") return null;
  return (
    brief.promoted_outcome ||
    brief.lead_outcome ||
    brief.primary_outcome ||
    asArray(brief.robust_vs_exploratory?.robust)[0] ||
    null
  );
}

function firstFinite(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function itemValue(item) {
  return firstFinite(item?.adjusted, item?.value, item?.effect_size, item?.estimate, item?.score);
}

function buildBridgeRows(summaryItems, fallbackRows) {
  const rows = asArray(fallbackRows);
  if (rows.length > 0) return rows.slice(0, 8);
  return asArray(summaryItems).slice(0, 6).map((item) => ({
    label: item.label || item.name || item.kind || "evidence",
    value: itemValue(item),
    note: item.note || item.takeaway || "",
  }));
}

function buildVisualNarrative(analysisVisuals, options = {}) {
  const visuals = asArray(analysisVisuals);
  const primaryEvidence = options.primaryEvidence || {};
  const preferredLeadOutcome = options.preferredLeadOutcome || null;
  const primaryVisual =
    visuals.find((item) => asArray(item?.items).length > 0) ||
    visuals.find((item) => item?.kind || item?.title) ||
    null;
  const summaryItems = asArray(primaryVisual?.items);
  const leadOutcome = preferredLeadOutcome || primaryVisual?.kind || primaryEvidence.lead_outcome || "primary_signal";
  const leadOutcomeLabel = primaryVisual?.title || primaryEvidence.lead_outcome_label || "Primary Signal";
  const primaryValue = firstFinite(
    primaryEvidence.adjusted_primary,
    primaryEvidence.adjusted_effect,
    primaryEvidence.primary_effect,
    summaryItems[0]?.adjusted,
    summaryItems[0]?.value,
  );
  const claimBridgeRows = buildBridgeRows(summaryItems, options.claimBridgeRows);
  const validationRows = asArray(options.validationCoverageRows).slice(0, 5);
  const promotedRows = asArray(options.promotedHypothesisRows).slice(0, 5);
  const figureRecommendations = visuals.length
    ? visuals.slice(0, 5).map((item, index) => ({
        figure_id: item.kind || `figure-${index + 1}`,
        title: item.title || item.kind || `Evidence figure ${index + 1}`,
        chart_type: item.chart_type || item.kind || "evidence chart",
        priority: index === 0 ? "highest" : "medium",
        takeaway: item.takeaway || item.note || "Show the quantitative evidence and the remaining validation burden.",
      }))
    : [
        {
          figure_id: "primary-signal-summary",
          title: "Primary Signal Summary",
          chart_type: "ranked evidence bars",
          priority: "highest",
          takeaway: "Show the promoted claim, the primary metric, and unresolved validation gaps together.",
        },
      ];
  const evidenceCheckpoints = claimBridgeRows.map((row, index) => ({
    checkpoint_id: `checkpoint-${index + 1}`,
    label: row.label,
    value: row.value,
    note: row.note || "Evidence checkpoint derived from the available analysis visual.",
  }));
  const visualTakeaways = figureRecommendations.map((item) => ({
    kind: item.figure_id,
    takeaway: item.takeaway,
  }));
  const supportingPoints = [
    primaryValue == null ? null : `primary signal ${formatSigned(primaryValue)}`,
    validationRows.length > 0 ? `${validationRows.length} validation checkpoint(s) visible` : "validation burden remains visible",
    claimBridgeRows.length > 0 ? `${claimBridgeRows.length} evidence bridge row(s)` : "evidence bridge still needs source rows",
  ].filter(Boolean);
  const heroVerdict = {
    verdict: primaryValue == null ? "pending-evidence" : "evidence-ready",
    headline: primaryValue == null
      ? "The promoted claim still needs an executed quantitative visual."
      : `Primary adjusted signal is ${formatSigned(primaryValue)}.`,
    subtitle: validationRows.length > 0
      ? "Quantitative evidence is present and paired with validation checkpoints."
      : "Quantitative evidence is present but validation coverage is still limited.",
    confidence: validationRows.length > 0 ? "reviewable" : "limited",
    supporting_points: supportingPoints,
  };
  const fastReviewCards = promotedRows.concat(validationRows).slice(0, 4).map((row, index) => ({
    title: row.title || row.label || row.hypothesis_id || `Review item ${index + 1}`,
    value: row.value ?? row.score ?? row.verdict ?? row.state ?? "review",
    note: row.note || row.statement || row.summary || "Review-relevant checkpoint from the current artifact set.",
    tone: row.tone || "neutral",
  }));

  return {
    primary_visual_kind: figureRecommendations[0]?.figure_id || null,
    hero_verdict: heroVerdict,
    approval_path: [
      {
        step: "1",
        label: "Artifact Trace",
        value: claimBridgeRows.length ? "present" : "thin",
        note: "Keep the promoted claim tied to generated artifacts.",
      },
      {
        step: "2",
        label: "Rival Evidence",
        value: figureRecommendations.length ? "visible" : "missing",
        note: "Show main, rival, and sensitivity evidence before emphasizing interpretation.",
      },
      {
        step: "3",
        label: "Validation Burden",
        value: validationRows.length ? "tracked" : "open",
        note: "Surface unresolved validation gaps in the same view as the quantitative signal.",
      },
    ],
    reviewer_objections: [
      "Does the visual separate tested evidence from inferred interpretation?",
      "Are missing external validation and sensitivity checks visible enough for gate review?",
    ],
    fast_review_cards: fastReviewCards,
    chart_priority_list: figureRecommendations.map((item) => item.figure_id),
    evidence_checkpoints: evidenceCheckpoints,
    figure_recommendations: figureRecommendations,
    visual_improvement_notes: [
      "Use editable labels and explicit units for every quantitative axis.",
      "Keep uncertainty, thresholds, and validation status visible in figure captions.",
    ],
    visual_takeaways: visualTakeaways,
    strongest_claim_summary: primaryValue == null
      ? "The strongest claim is not yet visually explicit enough to summarize."
      : `The strongest available quantitative signal is ${formatSigned(primaryValue)} and must be interpreted with the listed validation constraints.`,
    claim_bridge_rows: claimBridgeRows,
    primary_signal_rows: claimBridgeRows,
    lead_outcome: leadOutcome,
    lead_outcome_label: leadOutcomeLabel,
    primary_outcome_rows: [
      {
        label: leadOutcomeLabel,
        pooled: firstFinite(primaryEvidence.pooled_primary, primaryEvidence.primary_effect, summaryItems[0]?.value),
        adjusted: primaryValue,
        regression: firstFinite(primaryEvidence.regression_primary, summaryItems[0]?.regression),
        note: primaryVisual?.takeaway || "",
      },
    ],
  };
}

module.exports = {
  buildRivalFamilyAdjudication,
  inferPreferredLeadOutcome,
  buildVisualNarrative,
};
