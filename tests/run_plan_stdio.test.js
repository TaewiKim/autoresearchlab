"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resumeRunPlanStdio } = require("../src/runtime/run_plan_stdio");

test("resume-cycle default run-plan stdio avoids spawnSync output buffering", () => {
  assert.deepEqual(resumeRunPlanStdio({ captureRunPlanStdout: false }), ["ignore", "ignore", "ignore"]);
});

test("resume-cycle explicit capture mode pipes stdout and stderr for parsing/debugging", () => {
  assert.deepEqual(resumeRunPlanStdio({ captureRunPlanStdout: true }), ["ignore", "pipe", "pipe"]);
});
