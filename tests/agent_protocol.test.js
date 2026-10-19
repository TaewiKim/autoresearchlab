"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const {
  ensureAgentProtocolSnapshot,
  protocolStatusForLane,
  threadStatusFromCounts,
} = require("../src/reporting/agent_protocol");
const { ensureDir, writeJson } = require("../src/reporting/research_note_utils");

test("agent protocol status mappings follow Agent Protocol run/thread vocabulary", () => {
  assert.equal(protocolStatusForLane("completed"), "success");
  assert.equal(protocolStatusForLane("failed"), "error");
  assert.equal(protocolStatusForLane("aborted"), "interrupted");
  assert.equal(protocolStatusForLane("running"), "pending");
  assert.equal(threadStatusFromCounts({ running: 1, pending: 0 }), "busy");
  assert.equal(threadStatusFromCounts({ running: 0, pending: 0, failed: 1 }), "error");
  assert.equal(threadStatusFromCounts({ running: 0, pending: 0, failed: 0 }), "idle");
});

test("agent protocol snapshot maps cycle to thread and lanes to runs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-agent-protocol-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-agent-protocol";
  const stateRoot = path.join(root, "state");
  const messagesRoot = path.join(root, "messages", cycleId);
  const memoryRoot = path.join(root, "memory", cycleId);
  ensureDir(stateRoot);
  ensureDir(messagesRoot);
  ensureDir(memoryRoot);
  writeJson(path.join(stateRoot, `${cycleId}-cycle-run-state.json`), {
    cycle_id: cycleId,
    updated_at: "2026-06-02T00:00:00.000Z",
    lane_counts: { completed: 1, running: 1, pending: 0, failed: 0 },
    lane_statuses: [
      { lane_id: "followup-analyst-001", role: "analyst", status: "completed", action_type: "methods_followup" },
      { lane_id: "followup-gatekeeper-001", role: "gatekeeper", status: "running", action_type: "independent_gate_review_followup" },
    ],
  });
  writeJson(path.join(stateRoot, `${cycleId}-agent-communication-digest.json`), {
    current_focus: { lead_hypothesis: "A concrete claim" },
  });
  writeJson(path.join(messagesRoot, "bus-ledger.json"), {
    messages: [{
      message_id: "chronicle->gatekeeper:active-blockers#gate-blockers",
      channel: "chronicle->gatekeeper:active-blockers",
      kind: "standing",
      from_role: "lab-director",
      to_roles: ["gatekeeper"],
      subject: "Review the active blocker.",
      open: false,
      delivered_count: 0,
    }],
  });
  writeJson(path.join(memoryRoot, "memory-index.json"), {
    objective: "Close the gate.",
  });

  const result = ensureAgentProtocolSnapshot({ root, cycleId });
  assert.equal(result.reason, "refreshed");
  assert.equal(result.thread_status, "busy");
  assert.equal(result.run_count, 2);
  assert.equal(result.active_run_count, 1);
  const snapshot = JSON.parse(fs.readFileSync(result.snapshot_path, "utf8"));
  assert.equal(snapshot.schema_version, "researchlab.agent_protocol.snapshot.v1");
  assert.equal(snapshot.thread.metadata.researchlab_cycle_id, cycleId);
  assert.equal(snapshot.thread.values.messages[0].content, "Review the active blocker.");
  assert.equal(snapshot.runs.find((run) => run.metadata.researchlab_lane_id === "followup-analyst-001").status, "success");
  assert.equal(snapshot.runs.find((run) => run.metadata.researchlab_lane_id === "followup-gatekeeper-001").status, "pending");
  assert.ok(snapshot.agents.some((agent) => agent.agent_id === "researchlab.gatekeeper"));
  assert.ok(snapshot.store.namespaces.some((item) => item.namespace.join("/") === `researchlab/${cycleId}/memory`));
  assert.ok(fs.existsSync(result.markdown_path));

  fs.rmSync(cwd, { recursive: true, force: true });
});
