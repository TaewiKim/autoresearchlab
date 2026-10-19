"use strict";

// Tell a running cycle's LabDirector something.
//
//   researchlab tell --cycle-id <id> --message "<text>"
//   researchlab tell --cycle-id <id> --message-file <path>
//
// The message is delivered the way the director reads every request: on the
// message bus, which projects it into the director's inbox. The director acts
// on it in its next decision, or says why it does not.

const fs = require("fs");
const path = require("path");
const { queueLabDirectorMessage } = require("../reporting/labdirector_messages");

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function runTellCommand(argv, { cwd = process.cwd(), out = process.stdout } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  if (!cycleId) throw new Error("tell requires --cycle-id <id>");
  const file = readFlag(argv, "--message-file");
  const message = file ? fs.readFileSync(path.resolve(cwd, file), "utf8") : readFlag(argv, "--message");
  if (!message || !String(message).trim()) throw new Error("tell requires --message <text> or --message-file <path>");
  if (!fs.existsSync(path.join(cwd, ".research-lab", "state", `${cycleId}-cycle-run-state.json`))) {
    throw new Error(`no cycle ${cycleId} under ${path.join(cwd, ".research-lab")} (run researchlab from the directory the cycle was started in)`);
  }
  const queued = queueLabDirectorMessage({ cwd, cycleId, message: String(message), source: "cli" });
  out.write(`queued ${queued.message_id} for the LabDirector of ${cycleId} at ${queued.ts}\n`);
  return queued;
}

module.exports = { runTellCommand };
