"use strict";

const { allowedRolesForStage, normalizeResearchStage } = require("./stage_policy");

function partitionPlansByDispatchStage(plans, researchStage) {
  const stage = normalizeResearchStage(researchStage);
  const allowedRoles = new Set(allowedRolesForStage(stage));
  const active = [];
  const deferred = [];
  for (const plan of plans || []) {
    const role = String(plan?.role || "").trim();
    if (allowedRoles.has(role)) {
      active.push(plan);
    } else {
      deferred.push({
        lane_id: plan?.lane_id || null,
        role,
        deferred_until_stage: stage,
      });
    }
  }
  return {
    stage,
    active,
    deferred,
  };
}

module.exports = {
  partitionPlansByDispatchStage,
};
