"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { runtimeRoot } = require("../runtime/native_client");
const { ensureDir } = require("../shared/json");
const { dialogueLog } = require("../observability/cycle_logs");
const { forEachLine, isSegmentName } = require("../observability/segmented_log");

function metadataDbPath(cwd = process.cwd()) {
  return path.join(runtimeRoot(cwd), "state", "researchlab.sqlite");
}

function openMetadataDb(cwd = process.cwd()) {
  const dbPath = metadataDbPath(cwd);
  ensureDir(path.dirname(dbPath));
  return new DatabaseSync(dbPath);
}

function initializeSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- synchronous=NORMAL (with WAL) fsyncs only at checkpoint, not on every
    -- commit. The default (FULL) fsyncs the WAL on each of the thousands of
    -- per-cycle task/event/node/edge upserts in syncCycleMetadata, which on the
    -- WSL2/overlay disk stalled run-research in jbd2_log_wait_commit for minutes
    -- and starved lane dispatch (observed on both 9p and overlay). NORMAL is the
    -- standard durable-enough setting for WAL; this metadata DB is an observability
    -- mirror reconstructable from the event graph, so losing the last few commits
    -- on a hard crash is acceptable in exchange for not blocking the supervisor.
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS cycles (
      cycle_id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      control_state TEXT NOT NULL,
      research_stage TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      contract_version TEXT,
      owner_subagent_id TEXT,
      worker_id TEXT,
      team_id TEXT,
      role TEXT NOT NULL,
      task_type TEXT NOT NULL,
      control_state TEXT NOT NULL,
      research_stage TEXT NOT NULL,
      status TEXT NOT NULL,
      decision_id TEXT,
      parent_task_id TEXT,
      input_subgraph_ref TEXT,
      expected_output_schema_ref TEXT,
      budget_tokens INTEGER,
      timeout_seconds INTEGER,
      max_retries INTEGER,
      artifact_path TEXT,
      provenance_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id)
    );

    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      runtime_class TEXT NOT NULL,
      environment TEXT,
      status TEXT NOT NULL,
      trust_level TEXT,
      failure_rate REAL DEFAULT 0,
      cost_profile TEXT,
      capabilities_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      team_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      owned_subgraph_ref TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      task_id TEXT,
      artifact_type TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      node_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      label TEXT,
      state_json TEXT,
      metadata_json TEXT,
      provenance_json TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id)
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      edge_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      weight REAL,
      status TEXT,
      metadata_json TEXT,
      provenance_json TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      cycle_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      task_id TEXT,
      worker_id TEXT,
      node_id TEXT,
      severity TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (cycle_id) REFERENCES cycles(cycle_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_cycle_id ON tasks(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_cycle_id ON artifacts(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_events_cycle_id ON events(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_graph_nodes_cycle_id ON graph_nodes(cycle_id);
    CREATE INDEX IF NOT EXISTS idx_graph_edges_cycle_id ON graph_edges(cycle_id);
  `);
  ensureColumn(db, "tasks", "contract_version", "TEXT");
  ensureColumn(db, "tasks", "worker_id", "TEXT");
  ensureColumn(db, "tasks", "decision_id", "TEXT");
  ensureColumn(db, "tasks", "parent_task_id", "TEXT");
  ensureColumn(db, "tasks", "max_retries", "INTEGER");
  ensureColumn(db, "tasks", "provenance_json", "TEXT");
}

function ensureColumn(db, tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}

function ensureMetadataStore({ cwd = process.cwd() } = {}) {
  const db = openMetadataDb(cwd);
  try {
    initializeSchema(db);
  } finally {
    db.close();
  }
  return metadataDbPath(cwd);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonlIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {}
  }
  return rows;
}

// What the metadata store and the graph carry of one event.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: 25,988 events, of which
// 56 were 69.6 MB of the 82 MB the graph spent on events -- 19 gate reviews at
// 2.4 MB each and 37 approval reviews at 0.6 MB, each one the whole review
// object logged as an event payload. Every controller sync parsed them, wrote
// them out again as `payload_json`, parsed that into a graph node, and wrote
// the node into a 189 MB snapshot; the orchestrator's 2 GB heap, already
// holding leaked report caches, died on it six times in six days.
//
// The event log is the record and stays whole. The store and the graph are
// derived from it and index what happened, so an event too large to be an
// index entry keeps its scalar fields, one level of its payload's, the claim
// ids the graph links on, and where the full record is.
const EVENT_PAYLOAD_MAX_CHARS = Math.max(
  4096,
  Number(process.env.RESEARCHLAB_EVENT_INDEX_PAYLOAD_MAX_CHARS || 64 * 1024),
);
const EVENT_PAYLOAD_TEXT_MAX_CHARS = 2000;
const DIALOGUE_INDEX_MAX_SEGMENTS = 48;
const DIALOGUE_INDEX_MAX_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.RESEARCHLAB_DIALOGUE_INDEX_MAX_BYTES || 32 * 1024 * 1024),
);
const EVENT_CLAIM_KEYS = ["claim_ids", "claim_node_ids"];

function eventScalars(value) {
  const kept = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === null || typeof item === "number" || typeof item === "boolean") kept[key] = item;
    else if (typeof item === "string") {
      kept[key] = item.length > EVENT_PAYLOAD_TEXT_MAX_CHARS ? `${item.slice(0, EVENT_PAYLOAD_TEXT_MAX_CHARS)}...` : item;
    }
  }
  return kept;
}

function eventPayloadJson(event, source = null) {
  const full = JSON.stringify(event);
  if (full.length <= EVENT_PAYLOAD_MAX_CHARS) return full;
  const kept = eventScalars(event);
  const omitted = [];
  for (const [key, item] of Object.entries(event || {})) {
    if (!item || typeof item !== "object") continue;
    if (EVENT_CLAIM_KEYS.includes(key) && Array.isArray(item)) kept[key] = item;
    else if (Array.isArray(item)) omitted.push(key);
    else {
      kept[key] = eventScalars(item);
      omitted.push(...Object.keys(item).filter((field) => !(field in kept[key])).map((field) => `${key}.${field}`));
    }
  }
  kept.payload_omitted = {
    reason: "event too large for the index; the event log holds it whole",
    chars: full.length,
    fields: omitted.slice(0, 200),
    ...(source || {}),
  };
  const compact = JSON.stringify(kept);
  if (compact.length <= EVENT_PAYLOAD_MAX_CHARS) return compact;
  // Still too large: dozens of long strings. Keep the top-level scalars only.
  return JSON.stringify({ ...eventScalars(event), payload_omitted: { ...kept.payload_omitted, fields: [] } });
}

function stableId(prefix, value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}:${slug || "item"}`;
}

/**
 * Write down what we know about a stray lane directory, while we still know it.
 *
 * The collision above has been detected since 3e96e3e and recorded into
 * `skipped_lanes`, which nothing reads -- so the directory was skipped in
 * silence and the question "who created it" had no answer on disk. Asked that
 * question about cycle-g-v91's " scout-02", the audit log could not help: it
 * records control-state transitions, supervisor passes and role dialogues, and
 * has no event for a directory appearing. The only evidence left was the
 * directory's own mode (755, where every lane the harness writes is 777,
 * because `write_json` makes its parent collaborative and a bare `mkdir` does
 * not) and its mtime.
 *
 * So this records the evidence at the moment it is still recoverable: what the
 * directory is called, when it appeared, whether anything is inside it, its
 * permission mode, and which lanes were executing at that instant. Next time
 * the question is asked it has an answer, and the answer names a suspect
 * instead of a shrug.
 *
 * Recording must never break the sync it observes -- a stray directory already
 * crashed this harness 1,587 times once -- so every failure here is swallowed.
 */
function recordStrayLaneDirectory({ cwd, cycleId, lanesRoot, laneId, taskId, claimedBy }) {
  try {
    const strayPath = path.join(lanesRoot, laneId);
    const stat = fs.statSync(strayPath);
    const appearedAtMs = stat.mtimeMs;
    let contents = [];
    try {
      contents = fs.readdirSync(strayPath);
    } catch {
      contents = [];
    }
    // A lane is executing when its run-state exists and was written around the
    // moment the stray appeared. The window is generous on purpose: this is a
    // list of suspects to narrow later, not a verdict.
    const windowMs = 10 * 60 * 1000;
    const executing = [];
    for (const sibling of fs.readdirSync(lanesRoot)) {
      if (sibling === laneId) continue;
      const runStatePath = path.join(lanesRoot, sibling, "run-state.json");
      try {
        const siblingStat = fs.statSync(runStatePath);
        if (Math.abs(siblingStat.mtimeMs - appearedAtMs) <= windowMs) {
          executing.push(sibling);
        }
      } catch {
        /* not an executing lane */
      }
    }
    const eventsDir = path.join(cwd, ".research-lab", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      event_type: "stray-lane-directory-skipped",
      payload: {
        cycle_id: cycleId,
        lane_id: laneId,
        task_id: taskId,
        already_claimed_by: claimedBy,
        appeared_at: new Date(appearedAtMs).toISOString(),
        entry_count: contents.length,
        // Octal, because the mode is the strongest fingerprint available: the
        // harness writes 777 through write_json, a bare mkdir leaves 755.
        mode: (stat.mode & 0o777).toString(8),
        written_by_harness_write_path: (stat.mode & 0o777) === 0o777,
        lanes_executing_near_that_time: executing,
      },
    };
    const eventsPath = path.join(eventsDir, `${cycleId}-cycle-events.jsonl`);
    // Once per stray directory per cycle: the sync runs every supervisor pass,
    // and a line per pass would bury the first sighting, which is the only one
    // whose timing means anything.
    try {
      const existing = fs.readFileSync(eventsPath, "utf8");
      if (existing.includes(`"lane_id":${JSON.stringify(laneId)}`)
        && existing.includes("stray-lane-directory-skipped")) {
        return;
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(eventsPath, JSON.stringify(record) + "\n");
  } catch {
    // An observation must never become the failure it is observing.
  }
}

function scopeTaskId(cycleId, taskId) {
  const value = String(taskId || "").trim();
  if (!value) return `${cycleId}:task`;
  if (value.startsWith(`${cycleId}:`)) return value;
  return `${cycleId}:${value}`;
}

function scopeGraphId(cycleId, nodeId) {
  const value = String(nodeId || "").trim();
  if (!value) return `${cycleId}:node`;
  if (value.startsWith(`${cycleId}:`)) return value;
  return `${cycleId}:${value}`;
}

function inferTaskType(rolePlan = {}, laneContract = {}) {
  return (
    rolePlan.task_type ||
    rolePlan.action_type ||
    laneContract.task_type ||
    laneContract.runtime_class ||
    "lane-execution"
  );
}

function inferWorkerId(rolePlan = {}, laneContract = {}) {
  const runtimeClass = laneContract.runtime_class || rolePlan.runtime_class || "unknown-runtime";
  const environment = laneContract.lane_mode || rolePlan.lane_mode || "unknown-mode";
  return `${runtimeClass}:${environment}`;
}

function collectLaneRecords({ cwd = process.cwd(), cycleId, researchStage, controlState }) {
  const root = runtimeRoot(cwd);
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) {
    return {
      tasks: [],
      workers: [],
      teams: [],
      artifacts: [],
      events: [],
      skipped_lanes: [],
    };
  }

  const workers = new Map();
  const skippedLanes = [];
  const tasks = [];
  const teams = [];
  const artifacts = [];
  const events = [];

  // A lane id is the directory name, and `scopeTaskId` TRIMS it -- so a stray
  // directory named " scout-02" collapses onto the real `scout-02`, both rows go
  // into one INSERT after the cycle's tasks are deleted, and the primary key
  // rejects the second. `runResearch` aborts on the throw, the wrapper
  // relaunches, and it aborts again.
  //
  // MEASURED ON cycle-g-v90: an agent created an empty " scout-02" beside the
  // real one, and the supervisor crashed 1,587 times over three hours without
  // dispatching a single lane. The watchdog reported nothing, because from the
  // outside a cycle that cannot START looks exactly like a quiet one -- the same
  // signature v85 died of, and the second time one stray filesystem entry has
  // taken the whole harness down.
  //
  // So: the lane id is what the directory is actually called, the task id is
  // what it scopes to, and a second directory scoping onto a task id already
  // claimed is recorded and skipped rather than inserted.
  //
  // Order matters here, and not alphabetically: " scout-02" sorts BEFORE
  // "scout-02", so first-wins on the raw listing would keep the stray and drop
  // the lane that actually ran. A directory whose name is its own trimmed form
  // is a lane the harness created; anything else goes last and loses.
  const claimedTaskIds = new Map();
  const laneIds = fs
    .readdirSync(lanesRoot)
    .sort((a, b) => (a === a.trim() ? 0 : 1) - (b === b.trim() ? 0 : 1) || a.localeCompare(b));
  for (const laneId of laneIds) {
    const laneRoot = path.join(lanesRoot, laneId);
    if (!fs.statSync(laneRoot).isDirectory()) continue;

    const laneContract = readJsonIfExists(path.join(laneRoot, "lane-contract.json")) || {};
    const rolePlan = readJsonIfExists(path.join(laneRoot, "role-plan.json")) || {};
    const runState = readJsonIfExists(path.join(laneRoot, "run-state.json")) || {};
    const finalStatus = readJsonIfExists(path.join(laneRoot, "final-status.json")) || {};
    const artifactsManifest = readJsonIfExists(path.join(laneRoot, "artifacts.json")) || {};
    const resultPath = fs.existsSync(path.join(laneRoot, "result.json"))
      ? path.join(laneRoot, "result.json")
      : runState.result_path || finalStatus.result_path || null;
    const role = rolePlan.role || laneContract.role || laneId.replace(/-\d+$/, "");
    const rawTaskId = rolePlan.task_id || laneContract.task_id || laneId;
    const taskId = scopeTaskId(cycleId, rawTaskId);
    const claimedBy = claimedTaskIds.get(taskId);
    if (claimedBy !== undefined) {
      // Keep the first, which is the one the harness created: a directory whose
      // name is not its own trimmed form was written by something else.
      skippedLanes.push({ lane_id: laneId, task_id: taskId, already_claimed_by: claimedBy });
      recordStrayLaneDirectory({ cwd, cycleId, lanesRoot, laneId, taskId, claimedBy });
      continue;
    }
    claimedTaskIds.set(taskId, laneId);
    const workerId = inferWorkerId(rolePlan, laneContract);
    const createdAt = finalStatus.completed_at || runState.started_at || laneContract.created_at || new Date().toISOString();
    const updatedAt = finalStatus.completed_at || runState.updated_at || runState.started_at || createdAt;
    const taskStatus = finalStatus.status || runState.status || "pending";

    tasks.push({
      task_id: taskId,
      lane_id: laneId,
      cycle_id: cycleId,
      contract_version: rolePlan.contract_version || null,
      owner_subagent_id: rolePlan.agent_id || laneContract.agent_id || laneId,
      worker_id: workerId,
      team_id: rolePlan.team_id || null,
      role,
      task_type: inferTaskType(rolePlan, laneContract),
      control_state: controlState,
      research_stage: researchStage,
      status: taskStatus,
      decision_id: rolePlan?.provenance?.decision_id || null,
      parent_task_id: rolePlan?.provenance?.parent_task_id || null,
      input_subgraph_ref: rolePlan.input_subgraph_ref || null,
      expected_output_schema_ref: rolePlan.expected_output_schema_ref || null,
      budget_tokens: Number(rolePlan?.constraints?.budget_tokens || rolePlan?.budget_tokens || 0) || null,
      timeout_seconds: Number(rolePlan?.constraints?.timeout_seconds || rolePlan?.timeout_seconds || 0) || null,
      max_retries: Number(rolePlan?.constraints?.max_retries || rolePlan?.max_retries || 0) || null,
      artifact_path: resultPath,
      provenance_json: JSON.stringify(rolePlan?.provenance || {}),
      created_at: createdAt,
      updated_at: updatedAt,
    });

    workers.set(workerId, {
      worker_id: workerId,
      runtime_class: laneContract.runtime_class || rolePlan.runtime_class || "unknown",
      environment: laneContract.lane_mode || rolePlan.lane_mode || "unknown",
      status: taskStatus,
      trust_level: laneContract.trust_level || null,
      failure_rate: 0,
      cost_profile: laneContract.cost_profile || null,
      capabilities_json: JSON.stringify({
        role,
        allowed_outputs: laneContract.allowed_outputs || [],
      }),
      updated_at: updatedAt,
    });

    if (rolePlan.team_id) {
      teams.push({
        team_id: rolePlan.team_id,
        cycle_id: cycleId,
        goal: rolePlan.team_goal || rolePlan.goal || rolePlan.description || rolePlan.task || rolePlan.role || rolePlan.team_id,
        owned_subgraph_ref: rolePlan.input_subgraph_ref || null,
        status: taskStatus,
        created_at: createdAt,
        updated_at: updatedAt,
      });
    }

    if (resultPath) {
      artifacts.push({
        artifact_id: stableId("artifact", `${cycleId}:${laneId}:result`),
        lane_id: laneId,
        cycle_id: cycleId,
        task_id: taskId,
        artifact_type: "result",
        path: resultPath,
        content_hash: null,
        created_at: updatedAt,
      });
    }

    for (const artifactPath of Array.isArray(artifactsManifest?.artifacts) ? artifactsManifest.artifacts : []) {
      artifacts.push({
        artifact_id: stableId("artifact", `${cycleId}:${laneId}:${artifactPath}`),
        lane_id: laneId,
        cycle_id: cycleId,
        task_id: taskId,
        artifact_type: "durable-artifact",
        path: artifactPath,
        content_hash: null,
        created_at: updatedAt,
      });
    }

    const laneEvents = readJsonlIfExists(path.join(laneRoot, "events.jsonl"));
    laneEvents.forEach((event, index) => {
      events.push({
        event_id: event.event_id || stableId("event", `${cycleId}:${laneId}:${index}`),
        cycle_id: cycleId,
        event_type: event.type || event.event_type || "lane-event",
        task_id: taskId,
        worker_id: workerId,
        node_id: event.node_id || null,
        severity: event.severity || "info",
        payload_json: eventPayloadJson(event, { file: path.join(laneRoot, "events.jsonl"), record: index + 1 }),
        created_at: event.created_at || updatedAt,
      });
    });
  }

  const cycleEventFiles = fs.existsSync(path.join(root, "events"))
    ? fs.readdirSync(path.join(root, "events")).filter((entry) => entry.startsWith(`${cycleId}-`) && entry.endsWith(".jsonl"))
    : [];
  for (const eventFile of cycleEventFiles) {
    const filePath = path.join(root, "events", eventFile);
    readJsonlIfExists(filePath).forEach((event, index) => {
      events.push({
        event_id: event.event_id || stableId("event", `${cycleId}:${eventFile}:${index}`),
        cycle_id: cycleId,
        event_type: event.type || event.event_type || "cycle-event",
        task_id: event.task_id || null,
        worker_id: event.worker_id || null,
        node_id: event.node_id || null,
        severity: event.severity || "info",
        payload_json: eventPayloadJson(event, { file: filePath, record: index + 1 }),
        created_at: event.created_at || new Date().toISOString(),
      });
    });
  }

  // The dialogue is kept by the hour (observability/segmented_log.js) and is
  // not one of the files above. The index carries its recent hours: the newest
  // segments that fit the budget, each event named by its segment and place in
  // it, so an event keeps its id for as long as it is indexed.
  let dialogueBytes = 0;
  const dialogueSegments = dialogueLog(root, cycleId).segments().filter((segment) => isSegmentName(path.basename(segment)));
  for (const segment of dialogueSegments.slice(-DIALOGUE_INDEX_MAX_SEGMENTS).reverse()) {
    let size = 0;
    try {
      size = fs.statSync(segment).size;
    } catch {
      continue;
    }
    if (dialogueBytes + size > DIALOGUE_INDEX_MAX_BYTES && dialogueBytes > 0) break;
    dialogueBytes += size;
    const name = path.basename(segment);
    let index = 0;
    forEachLine(segment, 0, (text) => {
      index += 1;
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }
      events.push({
        event_id: event.event_id || stableId("event", `${cycleId}:labdirector-dialogue:${name}:${index}`),
        cycle_id: cycleId,
        event_type: event.type || event.event_type || "cycle-event",
        task_id: event.task_id || null,
        worker_id: event.worker_id || null,
        node_id: event.node_id || null,
        severity: event.severity || "info",
        payload_json: eventPayloadJson(event, { file: segment, record: index }),
        created_at: event.created_at || event.ts || new Date().toISOString(),
      });
    });
  }

  return {
    tasks,
    workers: Array.from(workers.values()),
    teams,
    artifacts,
    events,
    skipped_lanes: skippedLanes,
  };
}

/**
 * Drop this cycle's rows whose key this pass did not write.
 *
 * The keys are compared in the database rather than pulled into JS: a cycle can
 * hold six figures of graph rows, and reading them all back every pass to diff
 * in memory would trade one kind of churn for another.
 */
function pruneMissing(db, table, keyColumn, cycleId, keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) {
    // A pass that produced nothing for this table says nothing about what
    // belongs in it. Wiping here is how a single failed refresh would erase a
    // cycle's history.
    return 0;
  }
  // The kept keys go through a temp table, not one bound parameter each.
  //
  // MEASURED ON cycle-a-20260919, 2026-10-01 03:36Z: run-research
  // died with "too many SQL variables" at this DELETE, and every one of the
  // container's ten automatic restarts died the same way on its first sync --
  // the cycle's graph had outgrown SQLite's 32,766-parameter ceiling, so the
  // NOT IN list could no longer be bound at all. The cycle sat stopped for
  // two hours.
  db.exec("CREATE TEMP TABLE IF NOT EXISTS prune_keep (key PRIMARY KEY)");
  db.exec("DELETE FROM prune_keep");
  const keep = db.prepare("INSERT OR IGNORE INTO prune_keep (key) VALUES (?)");
  db.exec("BEGIN");
  try {
    for (const key of unique) keep.run(key);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the one worth reporting.
    }
    throw error;
  }
  try {
    const statement = db.prepare(
      `DELETE FROM ${table} WHERE cycle_id = ? AND ${keyColumn} NOT IN (SELECT key FROM prune_keep)`,
    );
    return statement.run(cycleId).changes || 0;
  } finally {
    db.exec("DELETE FROM prune_keep");
  }
}

function syncCycleMetadata({
  cwd = process.cwd(),
  cycleId,
  prompt,
  controlState,
  researchStage,
  status,
  graphSnapshot,
}) {
  const db = openMetadataDb(cwd);
  try {
    initializeSchema(db);
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT created_at FROM cycles WHERE cycle_id = ?").get(cycleId);
    db.prepare(`
      INSERT INTO cycles (cycle_id, prompt, control_state, research_stage, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_id) DO UPDATE SET
        prompt = excluded.prompt,
        control_state = excluded.control_state,
        research_stage = excluded.research_stage,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(
      cycleId,
      prompt || "",
      controlState,
      researchStage,
      status,
      existing?.created_at || now,
      now,
    );

    const laneRecords = collectLaneRecords({
      cwd,
      cycleId,
      researchStage,
      controlState,
    });

    // The six DELETEs that used to run here wiped every row for the cycle so
    // that the upserts below could never fire. Each pass then rewrote the whole
    // cycle -- on this container, ~270k graph rows into a 1.5 GB store, for as
    // long as the cycle ran. What they were actually needed for is pruning rows
    // a later pass no longer produces, and `pruneMissing` does that at the end
    // against the keys this pass actually wrote.

    const insertTask = db.prepare(`
      INSERT INTO tasks (
        task_id, cycle_id, contract_version, owner_subagent_id, worker_id, team_id, role, task_type, control_state,
        research_stage, status, decision_id, parent_task_id, input_subgraph_ref, expected_output_schema_ref,
        budget_tokens, timeout_seconds, max_retries, artifact_path, provenance_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      -- The ONLY insert here that had no upsert clause: it relied on the DELETE
      -- above wiping the cycle first. That is also why a duplicate task_id was
      -- fatal while every other table absorbed one -- cycle-g-v91's supervisor
      -- aborted 1,650 times on exactly this constraint.
      ON CONFLICT(task_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        contract_version = excluded.contract_version,
        owner_subagent_id = excluded.owner_subagent_id,
        worker_id = excluded.worker_id,
        team_id = excluded.team_id,
        role = excluded.role,
        task_type = excluded.task_type,
        control_state = excluded.control_state,
        research_stage = excluded.research_stage,
        status = excluded.status,
        decision_id = excluded.decision_id,
        parent_task_id = excluded.parent_task_id,
        input_subgraph_ref = excluded.input_subgraph_ref,
        expected_output_schema_ref = excluded.expected_output_schema_ref,
        budget_tokens = excluded.budget_tokens,
        timeout_seconds = excluded.timeout_seconds,
        max_retries = excluded.max_retries,
        artifact_path = excluded.artifact_path,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at
      WHERE tasks.status IS NOT excluded.status
         OR tasks.control_state IS NOT excluded.control_state
         OR tasks.research_stage IS NOT excluded.research_stage
         OR tasks.artifact_path IS NOT excluded.artifact_path
         OR tasks.provenance_json IS NOT excluded.provenance_json
    `);
    for (const task of laneRecords.tasks) {
      insertTask.run(
        task.task_id,
        task.cycle_id,
        task.contract_version,
        task.owner_subagent_id,
        task.worker_id,
        task.team_id,
        task.role,
        task.task_type,
        task.control_state,
        task.research_stage,
        task.status,
        task.decision_id,
        task.parent_task_id,
        task.input_subgraph_ref,
        task.expected_output_schema_ref,
        task.budget_tokens,
        task.timeout_seconds,
        task.max_retries,
        task.artifact_path,
        task.provenance_json,
        task.created_at,
        task.updated_at,
      );
    }

    const upsertWorker = db.prepare(`
      INSERT INTO workers (
        worker_id, runtime_class, environment, status, trust_level, failure_rate,
        cost_profile, capabilities_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        runtime_class = excluded.runtime_class,
        environment = excluded.environment,
        status = excluded.status,
        trust_level = excluded.trust_level,
        failure_rate = excluded.failure_rate,
        cost_profile = excluded.cost_profile,
        capabilities_json = excluded.capabilities_json,
        updated_at = excluded.updated_at
    `);
    for (const worker of laneRecords.workers) {
      upsertWorker.run(
        worker.worker_id,
        worker.runtime_class,
        worker.environment,
        worker.status,
        worker.trust_level,
        worker.failure_rate,
        worker.cost_profile,
        worker.capabilities_json,
        worker.updated_at,
      );
    }

    const insertTeam = db.prepare(`
      INSERT INTO teams (team_id, cycle_id, goal, owned_subgraph_ref, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        goal = excluded.goal,
        owned_subgraph_ref = excluded.owned_subgraph_ref,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);
    for (const team of laneRecords.teams) {
      insertTeam.run(
        team.team_id,
        team.cycle_id,
        team.goal,
        team.owned_subgraph_ref,
        team.status,
        team.created_at,
        team.updated_at,
      );
    }

    const insertArtifact = db.prepare(`
      INSERT INTO artifacts (artifact_id, cycle_id, task_id, artifact_type, path, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        task_id = excluded.task_id,
        artifact_type = excluded.artifact_type,
        path = excluded.path,
        content_hash = excluded.content_hash
      WHERE artifacts.content_hash IS NOT excluded.content_hash
         OR artifacts.path IS NOT excluded.path
         OR artifacts.task_id IS NOT excluded.task_id
    `);
    for (const artifact of laneRecords.artifacts) {
      insertArtifact.run(
        artifact.artifact_id,
        artifact.cycle_id,
        artifact.task_id,
        artifact.artifact_type,
        artifact.path,
        artifact.content_hash,
        artifact.created_at,
      );
    }

    const insertNode = db.prepare(`
      INSERT INTO graph_nodes (node_id, cycle_id, node_type, label, state_json, metadata_json, provenance_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        node_type = excluded.node_type,
        label = excluded.label,
        state_json = excluded.state_json,
        metadata_json = excluded.metadata_json,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at
      WHERE graph_nodes.state_json IS NOT excluded.state_json
         OR graph_nodes.node_type IS NOT excluded.node_type
         OR graph_nodes.metadata_json IS NOT excluded.metadata_json
         OR graph_nodes.label IS NOT excluded.label
    `);
    const insertEdge = db.prepare(`
      INSERT INTO graph_edges (edge_id, cycle_id, source_node_id, target_node_id, relation, weight, status, metadata_json, provenance_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        source_node_id = excluded.source_node_id,
        target_node_id = excluded.target_node_id,
        relation = excluded.relation,
        weight = excluded.weight,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at
      WHERE graph_edges.status IS NOT excluded.status
         OR graph_edges.relation IS NOT excluded.relation
         OR graph_edges.weight IS NOT excluded.weight
         OR graph_edges.metadata_json IS NOT excluded.metadata_json
    `);
    for (const node of graphSnapshot?.nodes || []) {
      insertNode.run(
        scopeGraphId(cycleId, node.node_id),
        cycleId,
        node.node_type,
        node.label || null,
        JSON.stringify(node.state_json || {}),
        JSON.stringify(node.metadata_json || {}),
        JSON.stringify(node.provenance_json || {}),
        now,
      );
    }
    for (const edge of graphSnapshot?.edges || []) {
      const sourceNodeId = scopeGraphId(cycleId, edge.source_node_id);
      const targetNodeId = scopeGraphId(cycleId, edge.target_node_id);
      insertEdge.run(
        scopeGraphId(cycleId, edge.edge_id || `${edge.source_node_id}|${edge.relation}|${edge.target_node_id}`),
        cycleId,
        sourceNodeId,
        targetNodeId,
        edge.relation,
        edge.weight ?? null,
        edge.status || null,
        JSON.stringify(edge.metadata_json || {}),
        JSON.stringify(edge.provenance_json || {}),
        now,
      );
    }

    const insertEvent = db.prepare(`
      INSERT INTO events (event_id, cycle_id, event_type, task_id, worker_id, node_id, severity, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        cycle_id = excluded.cycle_id,
        event_type = excluded.event_type,
        task_id = excluded.task_id,
        worker_id = excluded.worker_id,
        node_id = excluded.node_id,
        severity = excluded.severity,
        payload_json = excluded.payload_json
      -- An event is a record of something that happened; its id already carries
      -- its identity, so a second sighting is the same event and not an update.
      WHERE events.payload_json IS NOT excluded.payload_json
    `);
    for (const event of laneRecords.events) {
      insertEvent.run(
        event.event_id,
        event.cycle_id,
        event.event_type,
        event.task_id,
        event.worker_id,
        event.node_id ? scopeGraphId(cycleId, event.node_id) : null,
        event.severity,
        event.payload_json,
        event.created_at,
      );
    }

    // What the DELETEs were genuinely for: a row this pass no longer produces
    // has to go. Done against the keys actually written rather than by wiping
    // the cycle first, so an unchanged row is never destroyed and recreated.
    //
    // Events are exempt. They are an append-only record of things that
    // happened, and a pass that no longer reports an old event has not
    // un-happened it -- pruning them would make the log a mirror of the latest
    // pass instead of a history.
    pruneMissing(db, "tasks", "task_id", cycleId, laneRecords.tasks.map((task) => task.task_id));
    pruneMissing(db, "teams", "team_id", cycleId, laneRecords.teams.map((team) => team.team_id));
    pruneMissing(db, "artifacts", "artifact_id", cycleId,
      laneRecords.artifacts.map((artifact) => artifact.artifact_id));
    pruneMissing(db, "graph_nodes", "node_id", cycleId,
      (graphSnapshot?.nodes || []).map((node) => scopeGraphId(cycleId, node.node_id)));
    pruneMissing(db, "graph_edges", "edge_id", cycleId,
      (graphSnapshot?.edges || []).map((edge) => scopeGraphId(
        cycleId,
        edge.edge_id || `${edge.source_node_id}|${edge.relation}|${edge.target_node_id}`,
      )));
  } finally {
    db.close();
  }
  return metadataDbPath(cwd);
}

module.exports = {
  metadataDbPath,
  ensureMetadataStore,
  syncCycleMetadata,
  collectLaneRecords,
  EVENT_PAYLOAD_MAX_CHARS,
};
