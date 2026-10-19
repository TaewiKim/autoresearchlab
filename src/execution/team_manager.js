"use strict";

const { teamIdForRole, teamGoalForRole } = require("./task_contract");

function buildTeamBinding({ cycleId, role, researchStage, rolePlan = {} }) {
  const teamId = rolePlan.team_id || teamIdForRole({ cycleId, role, researchStage });
  if (!teamId) return null;
  return {
    team_id: teamId,
    team_goal: rolePlan.team_goal || teamGoalForRole({ role, researchStage }),
    owned_subgraph_ref: rolePlan.input_subgraph_ref || null,
  };
}

module.exports = {
  buildTeamBinding,
};
