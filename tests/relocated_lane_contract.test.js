"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { healCycleOnce } = require("../src/orchestrator/self_healing_cycle");

function fixture(t, role = "author", oldRoot = "Z:\\retired-host\\researchlab") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "relocated-lane-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cycleId = "cycle-a-20260919", laneId = `${role}-01`;
  const lane = path.join(cwd, ".research-lab", "lanes", cycleId, laneId);
  fs.mkdirSync(lane, { recursive: true });
  const oldPath = oldRoot.startsWith("/") ? path.posix : path.win32;
  const oldLane = oldPath.join(oldRoot, ".research-lab", "lanes", cycleId, laneId);
  const contract = { cycle_id: cycleId, lane_id: laneId, role, runtime_class: "codex-agent",
    mode: "read-write-scoped", cwd: oldRoot, task_file: oldPath.join(oldLane, "task.md"),
    allowed_inputs: [oldLane, oldPath.join(oldRoot + "-external", "pinned.csv")],
    allowed_outputs: [oldLane], output_artifact: oldPath.join(oldLane, "result.json"),
    fallback_strategy: null };
  const write = (name, value) => fs.writeFileSync(path.join(lane, name), JSON.stringify(value));
  const read = (name) => JSON.parse(fs.readFileSync(path.join(lane, name), "utf8"));
  write("lane-contract.json", contract);
  write("final-status.json", { status: "failed", error: "failed to spawn agent runtime (codex)" });
  write("run-state.json", { status: "failed" });
  fs.writeFileSync(path.join(lane, "task.md"), "Document the authenticated audit; preserve withdrawal and blank estimates.");
  return { cwd, cycleId, lane, contract, read, write, heal: () => healCycleOnce({ cwd, cycleId }) };
}

test("released document lanes execute their saved task after relocation instead of repeating ENOENT", (t) => {
  // MEASURED ON cycle-a-20260919, 2026-11-06: Director 1873's
  // release reached all three document lanes, but their Windows cwd survived
  // migration. Self-healing reset status and retried that same unusable cwd.
  for (const role of ["author", "illustrator", "lab-director"]) {
    const f = fixture(t, role);
    const before = fs.readFileSync(path.join(f.lane, "lane-contract.json"), "utf8");
    const task = fs.readFileSync(path.join(f.lane, "task.md"), "utf8");
    assert.equal(spawnSync(process.execPath, ["-e", ""], { cwd: f.contract.cwd }).error.code, "ENOENT");
    const actions = f.heal();
    assert.ok(actions.some((a) => a.action === "rebind_relocated_lane_contract"));
    assert.ok(actions.some((a) => a.action === "reset_failed_lane"));
    const repaired = f.read("lane-contract.json");
    assert.equal(repaired.cwd, f.cwd);
    assert.deepEqual(repaired.allowed_outputs, [f.lane]);
    assert.equal(repaired.allowed_inputs[0], f.lane);
    assert.equal(repaired.allowed_inputs[1], f.contract.allowed_inputs[1], "external evidence is not relocated");
    assert.equal(fs.existsSync(path.join(f.lane, "final-status.json")), false);
    const backups = fs.readdirSync(f.lane).filter((n) => n.startsWith("lane-contract.json.self-heal-"));
    assert.equal(fs.readFileSync(path.join(f.lane, backups[0]), "utf8"), before);
    // A local executor exercises the actual cwd/task/output boundary without
    // contacting a model or granting any scientific approval.
    const run = spawnSync(process.execPath, ["-e", `
      const fs = require('fs');
      fs.writeFileSync(process.argv[2], JSON.stringify({status:'completed', task:fs.readFileSync(process.argv[1],'utf8')}));
    `, repaired.task_file, repaired.output_artifact], { cwd: repaired.cwd });
    assert.equal(run.status, 0, run.stderr?.toString());
    assert.equal(f.read("result.json").task, task);
    assert.equal(f.heal().some((a) => a.action === "rebind_relocated_lane_contract"), false);
  }
});

test("relocation works between Unix roots and preserves scientific failure and live-work boundaries", (t) => {
  const unix = fixture(t, "author", "/nonexistent/retired-researchlab-root");
  assert.ok(unix.heal().some((a) => a.action === "rebind_relocated_lane_contract"));
  for (const boundary of ["completed", "scientific_failure", "live", "different_task", "missing_task", "existing_cwd"]) {
    const f = fixture(t);
    if (boundary === "completed") f.write("final-status.json", { status: "completed" });
    if (boundary === "scientific_failure") f.write("final-status.json", { status: "failed", error: "registered design invalid" });
    if (boundary === "live") f.write("process.json", { pid: process.pid });
    if (boundary === "different_task") f.write("lane-contract.json", { ...f.contract, task_file: "Z:\\other\\task.md" });
    if (boundary === "missing_task") fs.unlinkSync(path.join(f.lane, "task.md"));
    if (boundary === "existing_cwd") f.write("lane-contract.json", { ...f.contract, cwd: f.cwd });
    const before = fs.readFileSync(path.join(f.lane, "lane-contract.json"), "utf8");
    assert.equal(f.heal().some((a) => a.action === "rebind_relocated_lane_contract"), false, boundary);
    assert.equal(fs.readFileSync(path.join(f.lane, "lane-contract.json"), "utf8"), before, boundary);
  }
});
