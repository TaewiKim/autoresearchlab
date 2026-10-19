"use strict";

// The cycle's state directory belongs to the harness.
//
// MEASURED ON cycle-a-20260919, 2026-10-02. followup-lab-director-335
// wrote state/<cycle>-lead-manifest.json -- an "immutable lead manifest" binding
// H-SCD-V3 -- that no harness code writes or reads. The directors after it read
// the state directory as the cycle's record, found two leads, and four of them
// upheld the manifest's lead while the harness's lead file, its simulation order
// and the engineer running it belonged to another. One director asked for the
// canonical projection to be "corrected" to the agent's file. Twenty such files
// had been written into state/ by lanes since 2026-09-28.
//
// A lane's own record belongs in its lane directory. A state file whose kind the
// harness does not register (provenance/state_provenance.js) and whose content
// names a lane that has finished is moved into that lane's directory, under
// agent-state/, with an event saying where it went. Nothing is deleted, and a
// file that names no lane, or a lane still running, is left where it is.

const fs = require("fs");
const path = require("path");

const { classifyStateKind } = require("../provenance/state_provenance");

const AUTHOR_FIELDS = ["generated_by", "issued_by", "lane_id", "author", "written_by"];

function readAuthor(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const first = filePath.endsWith(".jsonl") ? text.split(/\r?\n/).find((line) => line.trim()) || "" : text;
  let value;
  try {
    value = JSON.parse(first.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const field of AUTHOR_FIELDS) {
    const author = value[field];
    if (typeof author === "string" && /^(?:followup-)?[a-z][a-z-]*-\d+(?:-recovery-\d+)*$/.test(author)) return author;
  }
  return null;
}

function agentStateFiles({ cwd, cycleId }) {
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const lanesDir = path.join(root, "lanes", cycleId);
  let names = [];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return [];
  }
  const prefix = `${cycleId}-`;
  const found = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(.+?)\.(json|jsonl)$/.exec(name.slice(prefix.length));
    if (!match) continue;
    if (classifyStateKind(match[1])) continue;
    const filePath = path.join(stateDir, name);
    const laneId = readAuthor(filePath);
    if (!laneId) continue;
    const laneDir = path.join(lanesDir, laneId);
    // Only a lane that has finished: a running lane may still be writing it.
    if (!fs.existsSync(path.join(laneDir, "final-status.json"))) continue;
    found.push({ name, kind: match[1], filePath, laneId, laneDir });
  }
  return found;
}

function quarantineAgentStateFiles({ cwd, cycleId, dryRun = false, now = new Date() }) {
  const moved = [];
  for (const item of agentStateFiles({ cwd, cycleId })) {
    const target = path.join(item.laneDir, "agent-state", item.name);
    if (!dryRun) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(item.filePath, target);
      } catch {
        continue;
      }
    }
    moved.push({ file: item.name, lane_id: item.laneId, moved_to: target });
  }
  if (moved.length && !dryRun) {
    // Not <cycle>-cycle-events.jsonl, which the aggregation rewrites every pass;
    // see harness_notices_path in native core/support.
    const eventsPath = path.join(cwd, ".research-lab", "events", `${cycleId}-harness-notices.jsonl`);
    try {
      fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
      fs.appendFileSync(
        eventsPath,
        `${JSON.stringify({ ts: now.toISOString(), event_type: "agent_state_files_moved_to_lane", payload: { moved } })}\n`,
        "utf8",
      );
    } catch {
      // The move is the point; a lost event is a lost note about it.
    }
  }
  return moved;
}

module.exports = { agentStateFiles, quarantineAgentStateFiles };
