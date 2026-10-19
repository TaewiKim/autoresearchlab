"use strict";

const { gateFollowupActions, gateRestartDemand } = require("./stage_policy");

function conclusionFollowupActions(summary) {
  const review = summary?.conclusion_review?.review || {};
  if (Array.isArray(review.recommended_actions)) {
    return review.recommended_actions;
  }
  return Array.isArray(review.recommended_followup_actions)
    ? review.recommended_followup_actions
    : [];
}

function hasRegenerationDemand(summary) {
  const conclusionDemand = conclusionFollowupActions(summary).some((item) =>
    String(item?.type || "").startsWith("hypothesis_regeneration"),
  );
  if (conclusionDemand) return true;
  return gateRestartDemand(summary);
}

function hasConclusionWorkRemaining(summary) {
  return conclusionFollowupActions(summary).length > 0 || gateFollowupActions(summary).length > 0;
}

module.exports = {
  conclusionFollowupActions,
  hasRegenerationDemand,
  hasConclusionWorkRemaining,
};
