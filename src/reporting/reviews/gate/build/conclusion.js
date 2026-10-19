"use strict";

const {
  hasForeignOnlyGeoAccessions,
  keepResearchQualityReasons,
  rubricBlockerReasons,
  uniqueStrings,
  withImpactFirstActionMandate,
} = require("../utils");

function isForeignCurrentLeadComment(comment, currentIdentity) {
  const text = String(comment || "");
  if (!text.trim()) return false;
  if (hasForeignOnlyGeoAccessions(text, currentIdentity?.accessions || [])) return true;
  const currentText = String(currentIdentity?.text || "");
  const currentLiverInjuryLead = /GSE228779|vaccine|liver|autoimmune hepatitis|\bAIH\b|\bVILI\b/i.test(currentText);
  const staleCancerContext = /breast[-\s]?cancer|brain metastasis|GSE322943|tumou?r subtype|tumou?r purity|stromal abundance|immune[-\s]?landscape baseline/i.test(text);
  return currentLiverInjuryLead && staleCancerContext;
}

function filterForeignCurrentLeadComments(values, currentIdentity) {
  return uniqueStrings(values).filter((item) => !isForeignCurrentLeadComment(item, currentIdentity));
}

function conclusionScienceBlockers({ conclusion, approval, currentIdentity = null }) {
  return keepResearchQualityReasons(filterForeignCurrentLeadComments([
    ...(Array.isArray(conclusion?.conclusion_blockers) ? conclusion.conclusion_blockers : []),
    ...(Array.isArray(approval?.approval_blockers) ? approval.approval_blockers : []),
    ...(Array.isArray(approval?.blockers) ? approval.blockers : []),
    ...rubricBlockerReasons(conclusion?.conclusion_rubric),
    ...rubricBlockerReasons(approval?.approval_rubric),
  ], currentIdentity));
}

function normalizeConclusionFollowupActions({ conclusion, approval, blockers, score }) {
  const actions = []
    .concat(Array.isArray(conclusion?.recommended_actions) ? conclusion.recommended_actions : [])
    .concat(Array.isArray(conclusion?.recommended_followup_actions) ? conclusion.recommended_followup_actions : [])
    .concat(Array.isArray(approval?.recommended_actions) ? approval.recommended_actions : [])
    .concat(Array.isArray(approval?.recommended_followup_actions) ? approval.recommended_followup_actions : []);
  return actions
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      ...item,
      priority: item.priority || "high",
      preferred_role: item.preferred_role || "lab-director",
      target_rubric: item.target_rubric || "conclusion_gate",
      target_score: item.target_score || 95,
      current_score: item.current_score ?? score ?? null,
      blocker_reasons: Array.isArray(item.blocker_reasons) && item.blocker_reasons.length > 0
        ? item.blocker_reasons
        : blockers,
      description: item.description || "address the scientific blockers preventing conclusion-gate eligibility",
      source_gate: item.source_gate || "conclusion_review",
    }))
    .map(withImpactFirstActionMandate);
}

function scientificGateComments(blockers) {
  return uniqueStrings(blockers).map((comment) => {
    const rubric = String(comment).includes(":")
      ? String(comment).split(":", 1)[0].trim().toLowerCase().replace(/\s+/g, "_")
      : "gate_science";
    return {
      source: "conclusion_review",
      rubric,
      severity: "blocking",
      comment,
    };
  });
}

module.exports = {
  isForeignCurrentLeadComment,
  filterForeignCurrentLeadComments,
  conclusionScienceBlockers,
  normalizeConclusionFollowupActions,
  scientificGateComments,
};
