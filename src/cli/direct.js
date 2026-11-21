"use strict";

// Give a running cycle a standing direction, or withdraw it.
//
//   researchlab direct --cycle-id <id> --message "<text>"
//   researchlab direct --cycle-id <id> --message-file <path>
//   researchlab direct --cycle-id <id> --withdraw
//
// `researchlab tell` reaches the one director opened for the message. A
// direction is different: it is written to state/<cycle>-owner-direction.json
// and handed to EVERY director lane until it is replaced or withdrawn (native
// labdirector/owner_direction.rs). It is also told to the director now, so the
// cycle acts on it without waiting for its next decision.

const fs = require("fs");
const path = require("path");
const { queueLabDirectorMessage } = require("../reporting/labdirector_messages");

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function directionPath(cwd, cycleId) {
  return path.join(cwd, ".research-lab", "state", `${cycleId}-owner-direction.json`);
}

function readRecord(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeRecord(filePath, record) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function runDirectCommand(argv, { cwd = process.cwd(), out = process.stdout, now = () => new Date() } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  if (!cycleId) throw new Error("direct requires --cycle-id <id>");
  if (!fs.existsSync(path.join(cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`))) {
    throw new Error(`no cycle ${cycleId} under ${path.join(cwd, ".research-lab")} (run researchlab from the directory the cycle was started in)`);
  }
  const filePath = directionPath(cwd, cycleId);
  const previous = readRecord(filePath) || { cycle_id: cycleId, direction: null, history: [] };
  const history = Array.isArray(previous.history) ? previous.history : [];
  if (previous.direction) history.push({ ...previous.direction, ended_at: now().toISOString() });

  if (argv.includes("--withdraw")) {
    writeRecord(filePath, { cycle_id: cycleId, direction: null, history, updated_at: now().toISOString() });
    const queued = queueLabDirectorMessage({ cwd, cycleId, source: "cli",
      message: "OWNER: the standing direction for this cycle is withdrawn. Decide the next line of work yourself." });
    out.write(`withdrew the standing direction of ${cycleId}; told the LabDirector (${queued.message_id})\n`);
    return null;
  }

  const file = readFlag(argv, "--message-file");
  const text = String(file ? fs.readFileSync(path.resolve(cwd, file), "utf8") : readFlag(argv, "--message") || "").trim();
  if (!text) throw new Error("direct requires --message <text>, --message-file <path> or --withdraw");
  const queued = queueLabDirectorMessage({ cwd, cycleId, source: "cli",
    message: `OWNER STANDING DIRECTION (stays in force until replaced or withdrawn; it is also in your context as owner_direction):\n\n${text}` });
  const direction = { text, issued_at: queued.ts, message_id: queued.message_id };
  writeRecord(filePath, { cycle_id: cycleId, direction, history, updated_at: now().toISOString() });
  out.write(`recorded the standing direction of ${cycleId} and told the LabDirector (${queued.message_id})\n`);
  return direction;
}

module.exports = { runDirectCommand, directionPath };
