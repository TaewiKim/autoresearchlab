"use strict";

// The store destroyed and rebuilt the whole cycle on every supervisor pass.
//
// Every INSERT in `syncCycleMetadata` was already `ON CONFLICT DO UPDATE`, and
// six DELETEs ran first and wiped the cycle's rows -- so the upserts could never
// fire and each pass rewrote everything from nothing. Measured on this
// container: `state/researchlab.sqlite` at 1.5 GB, 112,089 graph nodes and
// 158,969 edges, rewritten for as long as a cycle ran.
//
// The DELETEs were doing one real job: dropping rows a later pass no longer
// produces. That job is now done against the keys a pass actually wrote.
//
// Worth stating because it is the reason this mattered enough to fix: the
// primary key of this write-only store is what crashed cycle-g-v91's supervisor
// 1,650 times (see metadata_store_task_id_collision.test.js).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { syncCycleMetadata, metadataDbPath } = require("../src/storage/metadata_store");

const CYCLE = "cg-gate-incremental";

function cycleWithLanes(laneNames) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-incr-"));
  for (const name of laneNames) {
    fs.mkdirSync(path.join(cwd, ".research-lab", "lanes", CYCLE, name), { recursive: true });
  }
  return cwd;
}

function sync(cwd, graphSnapshot) {
  return syncCycleMetadata({
    cwd,
    cycleId: CYCLE,
    prompt: "objective",
    controlState: "RUN",
    researchStage: "evidence",
    status: "running",
    graphSnapshot,
  });
}

function open(cwd) {
  return new DatabaseSync(metadataDbPath(cwd));
}

const NODES = (ids) => ({
  nodes: ids.map((id) => ({ node_id: id, node_type: "paper", label: id, state_json: { seen: 1 } })),
  edges: [],
});

test("an unchanged row is not rewritten", () => {
  const cwd = cycleWithLanes(["scout-01", "analyst-01"]);
  sync(cwd, NODES(["n1", "n2"]));

  const db = open(cwd);
  const before = db.prepare("SELECT node_id, updated_at FROM graph_nodes ORDER BY node_id").all();
  db.close();
  assert.equal(before.length, 2);

  // A second pass with identical content. Previously every row was deleted and
  // reinserted here; now the guard finds nothing changed.
  sync(cwd, NODES(["n1", "n2"]));

  const db2 = open(cwd);
  const after = db2.prepare("SELECT node_id, updated_at FROM graph_nodes ORDER BY node_id").all();
  db2.close();
  assert.deepEqual(after, before, "identical content still rewrote the rows");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a changed row is updated, and updated_at moves only then", () => {
  const cwd = cycleWithLanes(["scout-01"]);
  sync(cwd, NODES(["n1"]));
  const db = open(cwd);
  const before = db.prepare("SELECT state_json, updated_at FROM graph_nodes WHERE node_id LIKE '%n1'").get();
  db.close();

  sync(cwd, {
    nodes: [{ node_id: "n1", node_type: "paper", label: "n1", state_json: { seen: 2 } }],
    edges: [],
  });

  const db2 = open(cwd);
  const after = db2.prepare("SELECT state_json, updated_at FROM graph_nodes WHERE node_id LIKE '%n1'").get();
  db2.close();
  assert.notEqual(after.state_json, before.state_json, "the change was not written");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a row a later pass no longer produces is pruned", () => {
  const cwd = cycleWithLanes(["scout-01"]);
  sync(cwd, NODES(["n1", "n2", "n3"]));
  let db = open(cwd);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM graph_nodes").get().c, 3);
  db.close();

  sync(cwd, NODES(["n1", "n3"]));
  db = open(cwd);
  const remaining = db.prepare("SELECT node_id FROM graph_nodes ORDER BY node_id").all().map((r) => r.node_id);
  db.close();
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.some((id) => id.endsWith("n2")), `n2 survived: ${remaining.join(", ")}`);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a pass that produces nothing for a table does not erase it", () => {
  // A single failed refresh must not wipe a cycle's history. The old DELETE ran
  // unconditionally and would have.
  const cwd = cycleWithLanes(["scout-01"]);
  sync(cwd, NODES(["n1", "n2"]));

  sync(cwd, { nodes: [], edges: [] });

  const db = open(cwd);
  const count = db.prepare("SELECT COUNT(*) c FROM graph_nodes").get().c;
  db.close();
  assert.equal(count, 2, "an empty pass erased the cycle's nodes");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("lane rows survive a pass and a vanished lane is pruned", () => {
  const cwd = cycleWithLanes(["scout-01", "analyst-01"]);
  sync(cwd, { nodes: [], edges: [] });
  let db = open(cwd);
  const first = db.prepare("SELECT task_id FROM tasks ORDER BY task_id").all().map((r) => r.task_id);
  db.close();
  assert.equal(first.length, 2);

  fs.rmSync(path.join(cwd, ".research-lab", "lanes", CYCLE, "analyst-01"), { recursive: true, force: true });
  sync(cwd, { nodes: [], edges: [] });

  db = open(cwd);
  const second = db.prepare("SELECT task_id FROM tasks ORDER BY task_id").all().map((r) => r.task_id);
  db.close();
  assert.equal(second.length, 1);
  assert.ok(second[0].endsWith("scout-01"));

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a graph larger than SQLite's parameter ceiling is still pruned", () => {
  // cycle-a-20260919, 2026-10-01: the NOT IN list outgrew SQLite's
  // 32,766 bound parameters and run-research died on every restart.
  const cwd = cycleWithLanes(["scout-01"]);
  const many = Array.from({ length: 40_000 }, (_, index) => `n${index}`);
  sync(cwd, NODES(many));
  // A later pass drops one node; the other 39,999 are kept.
  sync(cwd, NODES(many.filter((id) => id !== "n7")));

  const db = open(cwd);
  const count = db.prepare("SELECT COUNT(*) c FROM graph_nodes").get().c;
  const dropped = db.prepare("SELECT COUNT(*) c FROM graph_nodes WHERE node_id LIKE '%:n7'").get().c;
  db.close();
  assert.equal(count, 39_999);
  assert.equal(dropped, 0);

  fs.rmSync(cwd, { recursive: true, force: true });
});
