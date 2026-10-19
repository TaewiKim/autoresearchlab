"use strict";

function resumeRunPlanStdio({ captureRunPlanStdout = false } = {}) {
  if (captureRunPlanStdout) {
    return ["ignore", "pipe", "pipe"];
  }
  // The native run-plan can emit very large lane payloads on either output
  // stream. resume-cycle refreshes cycle artifacts from disk after the native
  // run, so default no-capture mode must not pipe child output through
  // spawnSync; doing so can hit Node string/buffer limits before refresh runs.
  return ["ignore", "ignore", "ignore"];
}

module.exports = { resumeRunPlanStdio };
