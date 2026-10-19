"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { evaluateMemoryGate, admitRecord, REASON } = require("../src/agents/shared/memory_gate");

const active = {
  cycle_id: "cycle-A",
  lane_id: "gatekeeper-01",
  role: "gatekeeper",
  task: "gate_review",
  stage: "gate",
  policy_context: "default",
};

test("admits a cycle-scoped broadcast record (no-constraint fields pass)", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A" }, active);
  assert.equal(r.admitted, true);
  assert.deepEqual(r.denial_reasons, []);
});

test("denies a cross-run record (run_id_mismatch)", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-B" }, active);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.RUN_MISMATCH)));
});

test("denies a record scoped to a different lane (task_scope_mismatch)", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", intended_lane: "analyst-07" }, active);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.SCOPE_LEAK)));
});

test("admits a record scoped to the active lane", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", intended_lane: "gatekeeper-01" }, active);
  assert.equal(r.admitted, true);
});

test("denies a superseded record (inactive_or_superseded_memory)", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", status: "superseded" }, active);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.INACTIVE)));
});

test("denies a record not addressed to the active role (receiver_unauthorized)", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", intended_receivers: ["scout"] }, active);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.RECEIVER_UNAUTHORIZED)));
});

test("admits a broadcast receiver set (*) and an explicit match", () => {
  assert.equal(evaluateMemoryGate({ cycle_id: "cycle-A", intended_receivers: "*" }, active).admitted, true);
  assert.equal(evaluateMemoryGate({ cycle_id: "cycle-A", target_role: "gatekeeper" }, active).admitted, true);
});

test("denies a policy-context mismatch", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", policy_context: "restricted" }, active);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.POLICY_MISMATCH)));
});

test("provenance: stated source absent from the event graph is denied", () => {
  const r = evaluateMemoryGate({ cycle_id: "cycle-A", source: "ghost-lane" }, active, ["lab-director", "chronicle"]);
  assert.equal(r.admitted, false);
  assert.ok(r.denial_reasons.some((x) => x.startsWith(REASON.MISSING_PROVENANCE)));
});

test("admitRecord stamps run, fails closed on mismatch, and audits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbm-"));
  const auditLogPath = path.join(dir, "audit.jsonl");
  // a record with no run gets stamped with the active cycle -> admitted
  const ok = admitRecord({ value: 1 }, { activeMessage: active, auditLogPath, recordId: "rec-ok" });
  assert.deepEqual(ok, { value: 1, cycle_id: "cycle-A", record_id: "rec-ok" });
  // a foreign-run record is denied -> reads as null (fail-closed)
  const denied = admitRecord({ cycle_id: "cycle-Z" }, { activeMessage: active, auditLogPath, recordId: "rec-bad" });
  assert.equal(denied, null);
  // null input stays null without auditing a phantom record
  assert.equal(admitRecord(null, { activeMessage: active, auditLogPath, recordId: "rec-null" }), null);
  const lines = fs.readFileSync(auditLogPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].admitted, true);
  assert.equal(lines[1].admitted, false);
  assert.ok(lines[1].denial_reasons.some((x) => x.startsWith(REASON.RUN_MISMATCH)));
  fs.rmSync(dir, { recursive: true, force: true });
});
