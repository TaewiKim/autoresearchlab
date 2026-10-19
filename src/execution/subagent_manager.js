"use strict";

function subagentIdForLane({ laneId, role, agentId = null }) {
  if (agentId) return agentId;
  const normalizedRole = String(role || "agent").trim() || "agent";
  const normalizedLane = String(laneId || "lane").trim() || "lane";
  return `${normalizedRole}:${normalizedLane}`;
}

function buildSubagentRecord({ laneId, role, activationStages = [], agentId = null }) {
  return {
    subagent_id: subagentIdForLane({ laneId, role, agentId }),
    lane_id: laneId,
    role,
    activation_stages: activationStages,
  };
}

module.exports = {
  buildSubagentRecord,
  subagentIdForLane,
};
