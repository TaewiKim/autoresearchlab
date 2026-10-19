"use strict";

// One line to read a cycle record the way MBM-Core requires.
//
// `src/provenance/message_bound_gate.js` is this runtime's reference monitor and
// states the rule in its own header: RELEVANCE IS NOT AUTHORIZATION. A record is
// admitted into the active decision's context only if it is authorized for THIS
// message. `src/agents/shared/memory_gate.js` wraps it as `admitRecord`.
//
// Both have existed for a long time and had exactly ONE consumer:
// `lab_director/query_plan.js`, which gates all seventeen of its reads. Every
// other role pulled cycle state straight off disk. Measured on 2026-09-10,
// chronicle alone had thirty-nine such reads, and every failure that audit found
// sat somewhere the gate does not reach.
//
// The reason it stayed at one consumer is friction: gating a read meant building
// an active message, choosing an audit path, and naming a record id at every
// call. This is that, once.
//
// Denial is not silent. Every allow and deny is appended to the cycle's
// memory-gate audit log, so a record that stops arriving can be traced to the
// check that refused it rather than looking like an empty file.

const fs = require("fs");
const path = require("path");

const { admitRecord } = require("./memory_gate");

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    // A torn or partial write is a missing record, not a crashed cycle.
    return null;
  }
}

function auditLogPathFor(root, cycleId) {
  return path.join(root, "state", `${cycleId}-memory-gate-audit.jsonl`);
}

/**
 * A reader that admits cycle records against the caller's active message.
 *
 * `task` and `stage` describe what the reading lane is doing; the gate's
 * no-constraint principle means a record that states no scope still passes, so
 * adopting this never starves a role of legitimate cycle-scoped context. What it
 * stops is a record from another run, another scope, or a superseded state
 * arriving as if it belonged here.
 */
function cycleStateReader({ root, cycleId, task = "cycle_read", stage = "evidence", scope = "cycle", laneId = null }) {
  const activeMessage = {
    cycle_id: cycleId,
    run_id: cycleId,
    lane_id: laneId,
    task,
    stage,
    scope,
  };
  const auditLogPath = auditLogPathFor(root, cycleId);

  // `suffix` names the artifact the way the cycle does: "data-graph.json".
  const read = (suffix, recordId = null) => {
    const filePath = path.join(root, "state", `${cycleId}-${suffix}`);
    return admitRecord(readJsonIfExists(filePath), {
      activeMessage,
      auditLogPath,
      recordId: recordId || String(suffix).replace(/\.json$/i, ""),
    });
  };

  // For records that do not live under state/ or are already loaded.
  read.path = (filePath, recordId) =>
    admitRecord(readJsonIfExists(filePath), { activeMessage, auditLogPath, recordId });
  read.value = (record, recordId) =>
    admitRecord(record, { activeMessage, auditLogPath, recordId });
  read.activeMessage = activeMessage;
  read.auditLogPath = auditLogPath;
  return read;
}

/**
 * What the gate has been doing: how many records it admitted and refused, and
 * for which reasons. Without this, adopting the gate is unfalsifiable — a role
 * that suddenly sees nothing looks identical to a cycle with nothing to see.
 */
function memoryGateAudit({ root, cycleId }) {
  let text;
  try {
    text = fs.readFileSync(auditLogPathFor(root, cycleId), "utf8");
  } catch {
    return { entries: 0, admitted: 0, denied: 0, reasons: {} };
  }
  let admitted = 0;
  let denied = 0;
  let entries = 0;
  const reasons = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    entries += 1;
    if (row.admitted === true) {
      admitted += 1;
      continue;
    }
    denied += 1;
    for (const reason of row.denial_reasons || []) {
      const code = String(reason).split(":")[0];
      reasons[code] = (reasons[code] || 0) + 1;
    }
  }
  return { entries, admitted, denied, reasons };
}

module.exports = {
  cycleStateReader,
  memoryGateAudit,
  auditLogPathFor,
  readJsonIfExists,
};
