"use strict";

const { approvalPassed } = require("./stage_policy");

function readApprovalState(summary) {
  const review = summary?.approval_review?.review || {};
  return {
    passed: approvalPassed(summary),
    score: review.score ?? review.approval_readiness_score ?? null,
    blockers: Array.isArray(review.blockers)
      ? review.blockers
      : Array.isArray(review.approval_blockers)
        ? review.approval_blockers
        : [],
    recommended_actions: Array.isArray(review.recommended_actions)
      ? review.recommended_actions
      : Array.isArray(review.recommended_followup_actions)
        ? review.recommended_followup_actions
        : [],
    decision_mode: review.decision_mode || null,
    decision_reason: review.decision_reason || null,
  };
}

module.exports = {
  readApprovalState,
};
