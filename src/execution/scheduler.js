"use strict";

function buildSchedulerEnvelope({ cycleId, minimumRuntimeHours = 0, maxPasses = null }) {
  return {
    cycle_id: cycleId,
    minimum_runtime_hours: Number(minimumRuntimeHours || 0),
    max_passes: maxPasses == null ? null : Number(maxPasses),
    recurrence_mode: "manual-supervisor-loop",
  };
}

module.exports = {
  buildSchedulerEnvelope,
};
