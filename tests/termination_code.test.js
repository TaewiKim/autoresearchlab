"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearTerminationCode,
  readTerminationCode,
  terminationCodePath,
  writeTerminationCode,
} = require("../src/reporting/termination_code");

test("termination code persists explicit stop metadata", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-termination-"));
  const cycleId = "cycle-termination-0001";

  const written = writeTerminationCode({
    cwd,
    cycleId,
    code: "APPROVAL_GATE_PASSED",
    category: "gate_passed",
    reason: "approval gate passed and the cycle can stop",
    metadata: {
      approval_gate_passed: true,
    },
  });

  const stored = readTerminationCode({ cwd, cycleId });
  assert.equal(path.basename(written.path), `${cycleId}-termination-code.json`);
  assert.equal(stored.code, "APPROVAL_GATE_PASSED");
  assert.equal(stored.category, "gate_passed");
  assert.equal(stored.should_stop, true);
  assert.equal(stored.metadata.approval_gate_passed, true);

  clearTerminationCode({ cwd, cycleId });
  assert.equal(fs.existsSync(terminationCodePath({ cwd, cycleId })), false);

  fs.rmSync(cwd, { recursive: true, force: true });
});
