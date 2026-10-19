"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function writeControllerEvent({ cwd = process.cwd(), cycleId, eventType, payload = {}, severity = "info" }) {
  const root = runtimeRoot(cwd);
  const filePath = path.join(root, "events", `${cycleId}-controller.jsonl`);
  const row = {
    event_id: `controller:${cycleId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    cycle_id: cycleId,
    event_type: eventType,
    severity,
    created_at: new Date().toISOString(),
    payload,
  };
  appendJsonl(filePath, row);
  return row;
}

module.exports = {
  appendJsonl,
  writeControllerEvent,
};
