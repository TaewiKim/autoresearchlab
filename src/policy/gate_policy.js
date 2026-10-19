"use strict";

const { gatePassed, gateRestartDemand, gateFollowupActions } = require("./stage_policy");

function readGateState(summary) {
  const review = summary?.gate_review?.review || {};
  return {
    passed: gatePassed(summary),
    restart_demand: gateRestartDemand(summary),
    followup_actions: gateFollowupActions(summary),
    score: review.score ?? review.gate_score ?? null,
    blockers: Array.isArray(review.blockers)
      ? review.blockers
      : Array.isArray(review.major_objections)
        ? review.major_objections
        : [],
    decision_mode: review.decision_mode || null,
    decision_reason: review.decision_reason || null,
  };
}

module.exports = {
  readGateState,
};
