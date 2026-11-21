"use strict";

// MEASURED ON cycle-a-20260919, 2026-11-16..21: an owner direction sent
// as a one-off message was gone from the director's context five days later.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runDirectCommand, directionPath } = require("../src/cli/direct");

function cycle() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rl-direct-"));
  const state = path.join(cwd, ".research-lab", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "c-cycle-run-state.json"), "{}");
  return cwd;
}

test("a direction is recorded, replaced and withdrawn with its history kept", () => {
  const cwd = cycle();
  const out = { write() {} };
  runDirectCommand(["--cycle-id", "c", "--message", "return to the coverage hypothesis"], { cwd, out });
  let record = JSON.parse(fs.readFileSync(directionPath(cwd, "c"), "utf8"));
  assert.equal(record.direction.text, "return to the coverage hypothesis");
  assert.ok(record.direction.message_id);

  runDirectCommand(["--cycle-id", "c", "--message", "narrow to one pose axis"], { cwd, out });
  record = JSON.parse(fs.readFileSync(directionPath(cwd, "c"), "utf8"));
  assert.equal(record.direction.text, "narrow to one pose axis");
  assert.deepEqual(record.history.map((item) => item.text), ["return to the coverage hypothesis"]);

  runDirectCommand(["--cycle-id", "c", "--withdraw"], { cwd, out });
  record = JSON.parse(fs.readFileSync(directionPath(cwd, "c"), "utf8"));
  assert.equal(record.direction, null);
  assert.equal(record.history.length, 2);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a direction needs a cycle and a text", () => {
  const cwd = cycle();
  assert.throws(() => runDirectCommand(["--cycle-id", "missing", "--message", "x"], { cwd, out: { write() {} } }), /no cycle/);
  assert.throws(() => runDirectCommand(["--cycle-id", "c"], { cwd, out: { write() {} } }), /--message/);
  fs.rmSync(cwd, { recursive: true, force: true });
});
