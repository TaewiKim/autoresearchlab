"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRunPlanForCycle,
  orphanNativeRunPlanRows,
  parsePsRows,
} = require("../src/runtime/process_cleanup");

test("parsePsRows reads pid, ppid, and full command", () => {
  const rows = parsePsRows(`
  18115     1 /repo/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-a --max-passes 80
  78294 18115 node src/cli/index.js resume-cycle --cycle-id cycle-a
`);
  assert.deepEqual(rows, [
    {
      pid: 18115,
      ppid: 1,
      command: "/repo/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-a --max-passes 80",
    },
    {
      pid: 78294,
      ppid: 18115,
      command: "node src/cli/index.js resume-cycle --cycle-id cycle-a",
    },
  ]);
});

test("orphanNativeRunPlanRows only selects orphan native run-plan for the cycle", () => {
  const psOutput = `
  18115     1 /repo/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-a --max-passes 80
  19189     2 /repo/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-a --max-passes 80
  19888     1 /repo/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-b --max-passes 80
  78294     1 node src/cli/index.js resume-cycle --cycle-id cycle-a
`;
  assert.deepEqual(
    orphanNativeRunPlanRows({ cycleId: "cycle-a", cwd: "/repo", psOutput }).map((row) => row.pid),
    [18115],
  );
});

test("isRunPlanForCycle rejects commands outside the workspace", () => {
  const row = {
    pid: 1,
    ppid: 1,
    command: "/other/native/researchlab-harness/target/release/researchlab-harness run-plan --cycle-id cycle-a",
  };
  assert.equal(isRunPlanForCycle(row, "cycle-a", "/repo"), false);
});
