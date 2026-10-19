"use strict";

// The orchestrator is one process for the life of a cycle. What it keeps and
// what it rebuilds each pass has to stay bounded as the cycle grows.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: the process reached its
// 2 GB heap after 4.5 h and was restarted by Docker, six times in six days;
// a fresh one already peaked at 1.46 GB on its first refresh.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { collectLaneRecords, EVENT_PAYLOAD_MAX_CHARS } = require("../src/storage/metadata_store");
const { buildGraphSnapshot } = require("../src/graph/graph_snapshot");
const { readJsonCached, cacheStats } = require("../src/reporting/visualizer/json_cache");
const { listCycleResultFiles } = require("../src/reporting/visualizer/analysis");

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function writeLane(root, cycleId, laneId, { events = [], result = { ok: true } } = {}) {
  const laneRoot = path.join(root, "lanes", cycleId, laneId);
  ensureDir(laneRoot);
  writeJson(path.join(laneRoot, "lane-contract.json"), { runtime_class: "codex-agent", lane_mode: "read-write-scoped" });
  writeJson(path.join(laneRoot, "role-plan.json"), { role: "analyst", task_id: `task-${laneId}`, action_type: "analysis" });
  writeJson(path.join(laneRoot, "final-status.json"), { status: "completed", completed_at: "2026-10-12T00:00:00.000Z" });
  if (result) writeJson(path.join(laneRoot, "result.json"), result);
  if (events.length) writeJsonl(path.join(laneRoot, "events.jsonl"), events);
  return laneRoot;
}

// Rewrites a file and makes sure its mtime moves even on a coarse clock.
function rewrite(filePath, value, tick) {
  writeJson(filePath, value);
  const when = new Date(Date.UTC(2026, 9, 12, 0, 0, tick));
  fs.utimesSync(filePath, when, when);
}

test("a rewritten file replaces its cached parse instead of joining it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-json-cache-"));
  const ledger = path.join(dir, "hypothesis-ledger.json");
  const before = cacheStats();

  rewrite(ledger, { version: 1, rows: "x".repeat(4000) }, 1);
  assert.equal(readJsonCached(ledger).version, 1);
  const first = cacheStats();
  assert.equal(first.entries, before.entries + 1);

  // Twenty refreshes, each rewriting the ledger: still one entry, and the
  // bytes held are the current version's, not the sum of all twenty.
  for (let version = 2; version <= 21; version += 1) {
    rewrite(ledger, { version, rows: "x".repeat(4000) }, version);
    assert.equal(readJsonCached(ledger).version, version);
  }
  const after = cacheStats();
  assert.equal(after.entries, first.entries);
  assert.equal(after.bytes - before.bytes, fs.statSync(ledger).size);

  // An unchanged file is the same parsed object, not a second parse.
  assert.equal(readJsonCached(ledger), readJsonCached(ledger));
  // The size cap is the caller's, and is not remembered against the file.
  assert.equal(readJsonCached(ledger, 16), null);
  assert.equal(readJsonCached(ledger).version, 21);
  assert.equal(readJsonCached(path.join(dir, "absent.json")), null);
});

test("the parse cache is bounded however many files pass through it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-json-cache-bound-"));
  const modulePath = require.resolve("../src/reporting/visualizer/json_cache");
  const saved = {
    entries: process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_ENTRIES,
    bytes: process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_BYTES,
    module: require.cache[modulePath],
  };
  process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_ENTRIES = "16";
  process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_BYTES = String(1024 * 1024);
  delete require.cache[modulePath];
  try {
    const bounded = require("../src/reporting/visualizer/json_cache");
    // A lane window sliding over 200 lanes: only the most recent stay.
    for (let lane = 0; lane < 200; lane += 1) {
      const filePath = path.join(dir, `result-${lane}.json`);
      writeJson(filePath, { lane });
      assert.equal(bounded.readJsonCached(filePath).lane, lane);
    }
    assert.equal(bounded.cacheStats().entries, 16);

    // Bytes bound it as well as count: 300 kB files, 1 MB budget.
    for (let lane = 0; lane < 8; lane += 1) {
      const filePath = path.join(dir, `large-${lane}.json`);
      writeJson(filePath, { lane, body: "y".repeat(300 * 1024) });
      bounded.readJsonCached(filePath);
      assert.ok(bounded.cacheStats().bytes <= 1024 * 1024, JSON.stringify(bounded.cacheStats()));
    }
    // A file larger than the whole budget is read for its caller and not kept.
    const huge = path.join(dir, "huge.json");
    writeJson(huge, { body: "z".repeat(2 * 1024 * 1024) });
    assert.equal(bounded.readJsonCached(huge).body.length, 2 * 1024 * 1024);
    assert.ok(bounded.cacheStats().bytes <= 1024 * 1024);
  } finally {
    for (const [name, value] of [["RESEARCHLAB_VISUALIZER_JSON_CACHE_ENTRIES", saved.entries], ["RESEARCHLAB_VISUALIZER_JSON_CACHE_BYTES", saved.bytes]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    require.cache[modulePath] = saved.module;
  }
});

test("a lane that finishes after the first listing is listed", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-result-list-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-result-list";
  const statePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  ensureDir(path.dirname(statePath));

  writeLane(root, cycleId, "followup-analyst-01");
  rewrite(statePath, { lane_statuses: [{ lane_id: "followup-analyst-01", role: "analyst" }] }, 1);
  const first = listCycleResultFiles(root, cycleId);
  assert.deepEqual(first.map((filePath) => path.basename(path.dirname(filePath))), ["followup-analyst-01"]);
  // Nothing changed: the same list, not a second scan.
  assert.equal(listCycleResultFiles(root, cycleId), first);

  // The orchestrator is still the same process when analyst-02 finishes.
  writeLane(root, cycleId, "followup-analyst-02");
  rewrite(statePath, {
    lane_statuses: [
      { lane_id: "followup-analyst-01", role: "analyst" },
      { lane_id: "followup-analyst-02", role: "analyst" },
    ],
  }, 2);
  assert.deepEqual(
    listCycleResultFiles(root, cycleId).map((filePath) => path.basename(path.dirname(filePath))).sort(),
    ["followup-analyst-01", "followup-analyst-02"],
  );
});

test("an event too large to be an index entry points at the log instead of copying it", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-event-index-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-event-index";
  writeLane(root, cycleId, "followup-gatekeeper-01", {
    events: [{ event_id: "lane-small", type: "lane-completed", claim_ids: ["claim-1"] }],
  });
  // The shape of the real thing: a whole gate review logged as one event.
  const review = {
    ts: "2026-10-12T00:00:00Z",
    cycle_id: cycleId,
    decision: "reject",
    score: 31,
    summary: "s".repeat(5000),
    recommended_followup_actions: Array.from({ length: 13 }, (_, index) => ({
      id: index,
      blocker_reasons: Array.from({ length: 131 }, () => "Novelty remains unverified: ".repeat(8)),
    })),
    rubric: { novelty: 28, notes: "n".repeat(100) },
  };
  const dialoguePath = path.join(root, "events", `${cycleId}-labdirector-dialogue.jsonl`);
  writeJsonl(dialoguePath, [
    { ts: "2026-10-12T00:00:00Z", event_type: "lane_started", payload: { lane_id: "followup-gatekeeper-01" } },
    { ts: review.ts, event_type: "independent_gate_review", claim_ids: ["claim-1"], payload: review },
  ]);
  const logged = fs.readFileSync(dialoguePath, "utf8");
  assert.ok(logged.length > 4 * EVENT_PAYLOAD_MAX_CHARS, "the fixture has to be an oversized event");

  const records = collectLaneRecords({ cwd, cycleId, researchStage: "evidence", controlState: "active" });
  const byType = new Map(records.events.map((event) => [event.event_type, event]));

  // Ordinary events are carried exactly as logged.
  assert.deepEqual(JSON.parse(byType.get("lane_started").payload_json), {
    ts: "2026-10-12T00:00:00Z",
    event_type: "lane_started",
    payload: { lane_id: "followup-gatekeeper-01" },
  });
  assert.deepEqual(JSON.parse(byType.get("lane-completed").payload_json).claim_ids, ["claim-1"]);

  const indexed = byType.get("independent_gate_review");
  assert.ok(indexed.payload_json.length <= EVENT_PAYLOAD_MAX_CHARS, String(indexed.payload_json.length));
  const entry = JSON.parse(indexed.payload_json);
  // What identifies it and what the graph links on survive.
  assert.equal(entry.event_type, "independent_gate_review");
  assert.equal(entry.ts, review.ts);
  assert.deepEqual(entry.claim_ids, ["claim-1"]);
  assert.equal(entry.payload.decision, "reject");
  assert.equal(entry.payload.score, 31);
  assert.ok(entry.payload.summary.length < 2100);
  // What does not is named, with where to read it.
  assert.equal(entry.payload.recommended_followup_actions, undefined);
  assert.ok(entry.payload_omitted.fields.includes("payload.recommended_followup_actions"));
  assert.ok(entry.payload_omitted.fields.includes("payload.rubric"));
  assert.equal(entry.payload_omitted.file, dialoguePath);
  assert.equal(entry.payload_omitted.record, 2);
  assert.ok(entry.payload_omitted.chars > 4 * EVENT_PAYLOAD_MAX_CHARS);
  // The log itself is untouched.
  assert.equal(fs.readFileSync(dialoguePath, "utf8"), logged);

  const snapshot = buildGraphSnapshot({ cwd, cycleId, prompt: "p", summary: {}, researchStage: "evidence", controlState: "active" });
  const node = snapshot.nodes.find((item) => item.node_type === "Event" && item.label === "independent_gate_review");
  assert.ok(JSON.stringify(node).length <= EVENT_PAYLOAD_MAX_CHARS + 1024);
  assert.ok(snapshot.edges.some((edge) => edge.source_node_id === node.node_id && edge.target_node_id === "claim:claim-1"));
});

test("a graph of many lanes has each node and edge once", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-graph-scale-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-graph-scale";
  const shared = path.join(root, "artifacts", "shared.csv");
  const lanes = 150;
  for (let lane = 0; lane < lanes; lane += 1) {
    const laneId = `followup-analyst-${lane}`;
    const laneRoot = writeLane(root, cycleId, laneId, {
      events: [
        { type: "lane_started" },
        { type: "lane_started" },
        { type: "lane_failed", severity: "error", message: "stopped" },
      ],
    });
    // The same artifact path listed twice by one lane, and by every lane.
    writeJson(path.join(laneRoot, "artifacts.json"), { artifacts: [shared, shared, path.join(laneRoot, "table.csv")] });
  }
  const started = Date.now();
  const snapshot = buildGraphSnapshot({ cwd, cycleId, prompt: "p", summary: {}, researchStage: "evidence", controlState: "active" });
  const elapsedMs = Date.now() - started;

  const nodeIds = snapshot.nodes.map((node) => node.node_id);
  const edgeIds = snapshot.edges.map((edge) => edge.edge_id);
  assert.equal(new Set(nodeIds).size, nodeIds.length);
  assert.equal(new Set(edgeIds).size, edgeIds.length);
  const count = (type) => snapshot.nodes.filter((node) => node.node_type === type).length;
  assert.equal(count("Task"), lanes);
  assert.equal(count("Event"), lanes * 3);
  assert.equal(count("Blocker"), lanes);
  // One evidence node for the path every lane shares, one per lane for the rest.
  assert.equal(snapshot.nodes.filter((node) => node.node_id.startsWith("evidence:artifact:") && node.label === shared).length, 1);
  // Generous: this is 30x the time it takes, and a small fraction of what
  // rescanning the arrays for every insert cost at the cycle's real size.
  assert.ok(elapsedMs < 30000, `building ${nodeIds.length} nodes took ${elapsedMs} ms`);
});
