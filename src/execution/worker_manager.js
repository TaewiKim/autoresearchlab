"use strict";

function inferWorkerBinding({ laneMode = null, runtimeClass = null, role = null }) {
  return {
    worker_id: `${runtimeClass || "unknown-runtime"}:${laneMode || "unknown-mode"}`,
    runtime_class: runtimeClass || "unknown-runtime",
    environment: laneMode || "unknown-mode",
    role,
  };
}

module.exports = {
  inferWorkerBinding,
};
