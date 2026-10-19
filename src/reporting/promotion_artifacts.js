"use strict";

const path = require("path");
const { readJsonIfExists } = require("./final_claim_package");

const ARTIFACT_NAMES = Object.freeze({
  baselineConfounderWaiver: "baseline-confounder-waiver",
  robustnessDisplayAddendum: "robustness-display-addendum",
  competitorScreen: "competitor-screen",
  transportabilityDecision: "transportability-decision",
});

const RESOLUTION_RULES = Object.freeze({
  baselineConfounderWaiver: {
    rubricNames: new Set(["reproducibility"]),
    reasonPattern: /\breproducibility\b|baseline|confound|reference|code|numeric|delta|age|sex|subject|leukocyte|adjusted/i,
    scoreFloor: 95,
  },
  robustnessDisplayAddendum: {
    rubricNames: new Set(["clarity"]),
    reasonPattern: /\bclarity\b|figure|display|robustness|primary|patient aggregation|visual/i,
    scoreFloor: 95,
  },
  competitorScreen: {
    rubricNames: new Set(["novelty"]),
    reasonPattern: /\bnovelty\b|broader set|non-trivial|competitor|rival|alternative/i,
    scoreFloor: 95,
  },
  transportabilityDecision: {
    rubricNames: new Set(["impact"]),
    reasonPattern: /\bimpact\b|high-confidence|reasoning gaps|transport|external|companion|PRJNA|GSE229459/i,
    scoreFloor: 95,
  },
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readPromotionArtifacts({ root, cycleId }) {
  const stateDir = path.join(root, "state");
  const read = (name) => readJsonIfExists(path.join(stateDir, `${cycleId}-${name}.json`));
  const artifacts = {
    baselineConfounderWaiver: read(ARTIFACT_NAMES.baselineConfounderWaiver),
    robustnessDisplayAddendum: read(ARTIFACT_NAMES.robustnessDisplayAddendum),
    competitorScreen: read(ARTIFACT_NAMES.competitorScreen),
    transportabilityDecision: read(ARTIFACT_NAMES.transportabilityDecision),
  };
  return summarizePromotionArtifacts(artifacts);
}

function summarizePromotionArtifacts(artifacts) {
  const baseline = artifacts.baselineConfounderWaiver;
  const addendum = artifacts.robustnessDisplayAddendum;
  const competitor = artifacts.competitorScreen;
  const transport = artifacts.transportabilityDecision;

  const baselineUnavailable = [
    ...asArray(baseline?.baseline?.unavailable_items),
    ...asArray(baseline?.unavailable_baseline_items),
    ...asArray(baseline?.baseline_unavailable_items),
  ];
  const confounderUnavailable = [
    ...asArray(baseline?.confounders?.unavailable_fields),
    ...asArray(baseline?.unavailable_confounder_fields),
    ...asArray(baseline?.confounder_unavailable_fields),
  ];
  const baselineWaiverComplete = hasObject(baseline) && (
    baseline?.waiver_decision === "accepted" ||
    baseline?.decision === "waive_unavailable" ||
    baseline?.waiver_accepted === true ||
    (
      baselineUnavailable.length >= 2 &&
      confounderUnavailable.length >= 2 &&
      asArray(baseline?.limitations).length > 0
    )
  );

  const robustnessComplete = hasObject(addendum) && (
    addendum?.addendum_complete === true ||
    (
      (hasObject(addendum?.primary_effects) || asArray(addendum?.primary_effects).length > 0) &&
      (hasObject(addendum?.patient_aggregation) || hasText(addendum?.patient_aggregation)) &&
      (
        asArray(addendum?.robustness_checks).length > 0 ||
        asArray(addendum?.display_outputs).length > 0 ||
        asArray(addendum?.figure_packets).length > 0
      )
    )
  );

  const competitorComplete = hasObject(competitor) && (
    competitor?.screen_complete === true ||
    (
      asArray(competitor?.screened_candidates).length > 0 &&
      (
        asArray(competitor?.demoted_candidates).length > 0 ||
        asArray(competitor?.non_executable_candidates).length > 0 ||
        hasText(competitor?.lead_retention_rationale)
      )
    )
  );

  const transportComplete = hasObject(transport) && (
    transport?.decision_recorded === true ||
    hasText(transport?.decision) ||
    hasText(transport?.promotion_scope) ||
    hasText(transport?.selected_route)
  ) && (
    hasObject(transport?.gse229459) ||
    hasObject(transport?.prjna951615) ||
    hasText(transport?.internal_only_rationale) ||
    hasText(transport?.transportability_rationale)
  );

  return {
    artifacts,
    resolved: {
      baselineConfounderWaiver: Boolean(baselineWaiverComplete),
      robustnessDisplayAddendum: Boolean(robustnessComplete),
      competitorScreen: Boolean(competitorComplete),
      transportabilityDecision: Boolean(transportComplete),
    },
  };
}

function resolutionForRubric(name, promotionArtifacts) {
  const rubricName = String(name || "");
  const resolvedKeys = Object.entries(promotionArtifacts?.resolved || {})
    .filter(([, resolved]) => resolved)
    .map(([key]) => key)
    .filter((key) => RESOLUTION_RULES[key]?.rubricNames.has(rubricName));
  return resolvedKeys;
}

function applyPromotionArtifactResolutions({ rubric = [], blockers = [], promotionArtifacts }) {
  const resolved = promotionArtifacts?.resolved || {};
  const adjustedRubric = asArray(rubric).map((item) => {
    const resolvedKeys = resolutionForRubric(item?.name, promotionArtifacts);
    if (resolvedKeys.length === 0) return item;
    // A resolution artifact may optimistically FLOOR an unreviewed placeholder
    // rubric so a resolved blocker can advance — but it must NEVER override a
    // fresh independent gatekeeper score. Otherwise merely PRODUCING the artifact
    // games the gate: a "competitor screen" would floor novelty to 95 over a
    // gatekeeper that actively searched, found the direct prior art, and honestly
    // scored novelty ~20 as an incremental variant. An item carrying real review
    // reasons (and not flagged focused_review_missing) is an honest assessment and
    // is left untouched; the artifact still clears matching stale BLOCKERS below.
    const hasIndependentReview =
      Array.isArray(item?.reasons) &&
      item.reasons.filter(Boolean).length > 0 &&
      item?.focused_review_missing !== true;
    if (hasIndependentReview) {
      return { ...item, promotion_artifact_resolutions: resolvedKeys };
    }
    const scoreFloor = Math.max(...resolvedKeys.map((key) => RESOLUTION_RULES[key].scoreFloor));
    return {
      ...item,
      score: Math.max(Number(item?.score || 0), scoreFloor),
      reasons: asArray(item?.reasons).filter((reason) =>
        !resolvedKeys.some((key) => RESOLUTION_RULES[key].reasonPattern.test(String(reason || ""))),
      ),
      promotion_artifact_resolutions: resolvedKeys,
    };
  });
  const adjustedBlockers = asArray(blockers).filter((blocker) =>
    !Object.entries(resolved).some(([key, isResolved]) =>
      isResolved && RESOLUTION_RULES[key]?.reasonPattern.test(String(blocker || "")),
    ),
  );
  return {
    rubric: adjustedRubric,
    blockers: adjustedBlockers,
    promotion_artifact_resolution: promotionArtifacts,
  };
}

function promotionArtifactFollowupActions({ promotionArtifacts, score = null, blockers = [] }) {
  const resolved = promotionArtifacts?.resolved || {};
  const actions = [];
  if (!resolved.baselineConfounderWaiver) {
    actions.push({
      type: "baseline_confounder_waiver_followup",
      priority: "high",
      preferred_role: "analyst",
      target_rubric: "reproducibility",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      expected_artifacts: ["baseline-confounder-waiver.json"],
      description:
        "record unavailable same-paper code/numeric-reference/baseline-step and unavailable age/sex/repeated-subject/leukocyte fields as explicit limitations or exploratory waivers instead of sending another runner to rediscover the same missing fields",
    });
  }
  if (!resolved.robustnessDisplayAddendum) {
    actions.push({
      type: "robustness_display_addendum_followup",
      priority: "high",
      preferred_role: "lab-runner",
      target_rubric: "clarity",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      expected_artifacts: ["robustness-display-addendum.json", "robustness-display-addendum.md"],
      description:
        "compile the primary effects, patient aggregation, rival context, sensitivity checks, and publication-facing display outputs into a robustness/display addendum",
    });
  }
  if (!resolved.competitorScreen) {
    actions.push({
      type: "competitor_screen_followup",
      priority: "high",
      preferred_role: "scout",
      target_rubric: "novelty",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      expected_artifacts: ["competitor-screen.json"],
      description:
        "screen classified literature/data-graph competitor candidates and demote literature-only or non-executable alternatives unless one has stronger executable support than the current lead",
    });
  }
  if (!resolved.transportabilityDecision) {
    actions.push({
      type: "transportability_decision_followup",
      priority: "high",
      preferred_role: "analyst",
      target_rubric: "impact",
      target_score: 95,
      current_score: score,
      blocker_reasons: blockers,
      expected_artifacts: ["transportability-decision.json"],
      description:
        "decide whether GSE229459 is executable as a same-paper companion; otherwise materialize PRJNA951615 or explicitly record an internal-only GSE228779 promotion scope",
    });
  }
  return actions;
}

module.exports = {
  applyPromotionArtifactResolutions,
  promotionArtifactFollowupActions,
  readPromotionArtifacts,
  summarizePromotionArtifacts,
};
