"use strict";

// The other half of the reference monitor, checked.
//
// `message_bound_gate.js` answers whether a record may ENTER a decision. It
// cannot answer whether the record reached the decision at all, and that is the
// failure this programme keeps having: `lab_director_alerts` named its
// recipient and its reason and was read by nothing for two cycles;
// `skipped_lanes` was written by the only component that saw the stray lane
// directory, into a field with no reader; the gatekeeper was asked whether a
// falsification was adequate and never shown it. None is an admission failure.
//
// Downstream, "never produced", "produced and never delivered" and "denied"
// are one silence. These tests pin the three apart.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VERDICTS,
  evaluateDelivery,
  evaluateCycleDelivery,
  undeliveredSignals,
  matchFiles,
} = require("../src/provenance/delivery_gate");
const { interRoleSignals } = require("../src/policy/dispatch_authority");

const CYCLE = "cg-delivery-test";

function makeCycle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.mkdirSync(path.join(root, "lanes", CYCLE, "followup-lab-director-01"), { recursive: true });
  return root;
}

const ENTRY = {
  signal: "a_signal",
  what: "something one role says to another",
  producer: { file: "x.rs", role: "chronicle" },
  consumer: { file: "y.rs", role: "lab-director" },
  runtime: {
    produced: { glob: "state/{cycle}-cycle-run-state.json", key: "a_signal" },
    delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "a_signal" },
    conditional: null,
  },
};

test("a wildcard in the middle of a path matches every lane", () => {
  // The first matcher treated `*` as a filename prefix in one directory, so the
  // pattern every lane artifact uses matched nothing -- and the report said four
  // signals were read by nobody, half an hour after those four had been measured
  // reaching 16, 34, 17 and 137 role plans. A pattern language is a parser, and
  // one that silently returns the empty set turns a working system into a broken
  // report.
  const root = makeCycle();
  const lanes = path.join(root, "lanes", CYCLE);
  for (const lane of ["followup-lab-director-02", "followup-gatekeeper-01"]) {
    fs.mkdirSync(path.join(lanes, lane), { recursive: true });
    fs.writeFileSync(path.join(lanes, lane, "role-plan.json"), "{}", "utf8");
  }
  fs.writeFileSync(path.join(lanes, "followup-lab-director-01", "role-plan.json"), "{}", "utf8");
  const found = matchFiles(root, `lanes/${CYCLE}/*/role-plan.json`);
  assert.equal(found.length, 3, `expected three lane plans, got ${found.length}`);
  // Directories are not files, and a missing file in one lane is not a match.
  assert.ok(found.every((file) => file.endsWith("role-plan.json")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("produced and read by nobody is its own verdict", () => {
  // The one MBM-Core cannot see.
  const root = makeCycle();
  fs.writeFileSync(
    path.join(root, "state", `${CYCLE}-cycle-run-state.json`),
    JSON.stringify({ a_signal: [{ owner: "lab-director" }] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "lanes", CYCLE, "followup-lab-director-01", "role-plan.json"),
    JSON.stringify({ planner_metadata: {} }),
    "utf8",
  );
  const report = evaluateDelivery({ root, cycleId: CYCLE, entry: ENTRY });
  assert.equal(report.verdict, VERDICTS.PRODUCED_NOT_DELIVERED);
  assert.match(report.reason, /produced by chronicle/);
  assert.match(report.reason, /absent from everything lab-director reads/);
  assert.equal(report.delivered.count, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("never produced is not the same as never delivered", () => {
  const root = makeCycle();
  fs.writeFileSync(
    path.join(root, "lanes", CYCLE, "followup-lab-director-01", "role-plan.json"),
    JSON.stringify({ planner_metadata: { a_signal: null } }),
    "utf8",
  );
  const report = evaluateDelivery({ root, cycleId: CYCLE, entry: ENTRY });
  assert.equal(report.verdict, VERDICTS.NEVER_PRODUCED);
  // The readers are already wired; nothing has been sent. Reporting that as a
  // delivery failure would cry wolf on a healthy cycle.
  assert.equal(report.delivered.count, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a conditional signal says why its absence is not a fault", () => {
  const root = makeCycle();
  const entry = {
    ...ENTRY,
    runtime: { ...ENTRY.runtime, conditional: "only when a blocking lane has failed" },
  };
  const report = evaluateDelivery({ root, cycleId: CYCLE, entry });
  assert.equal(report.verdict, VERDICTS.NEVER_PRODUCED);
  assert.match(report.reason, /only when a blocking lane has failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("delivered means both ends, counted", () => {
  const root = makeCycle();
  fs.writeFileSync(
    path.join(root, "state", `${CYCLE}-cycle-run-state.json`),
    JSON.stringify({ a_signal: [1] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "lanes", CYCLE, "followup-lab-director-01", "role-plan.json"),
    JSON.stringify({ planner_metadata: { a_signal: [1] } }),
    "utf8",
  );
  const report = evaluateDelivery({ root, cycleId: CYCLE, entry: ENTRY });
  assert.equal(report.verdict, VERDICTS.DELIVERED);
  assert.equal(report.produced.count, 1);
  assert.equal(report.delivered.count, 1);
  assert.equal(report.reason, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a signal with no runtime locator says so rather than passing quietly", () => {
  const report = evaluateDelivery({
    root: "/nowhere",
    cycleId: CYCLE,
    entry: { ...ENTRY, runtime: null, runtime_absent_reason: "it is an event, not an artifact" },
  });
  assert.equal(report.verdict, VERDICTS.NOT_LOCATABLE);
  assert.match(report.reason, /an event, not an artifact/);
});

test("every registered signal is locatable or explains why not", () => {
  // An entry with neither a locator nor a reason would pass the report in
  // silence, which is the shape being removed.
  const silent = interRoleSignals()
    .filter((entry) => !entry.runtime && !String(entry.runtime_absent_reason || "").trim())
    .map((entry) => entry.signal);
  assert.deepEqual(silent, []);
});

test("a whole cycle reports every signal, and names the unread ones", () => {
  const root = makeCycle();
  const reports = evaluateCycleDelivery({ root, cycleId: CYCLE });
  assert.equal(reports.length, interRoleSignals().length);
  for (const report of reports) {
    assert.ok(Object.values(VERDICTS).includes(report.verdict), `${report.signal}: ${report.verdict}`);
    assert.ok(String(report.what || "").trim(), `${report.signal} does not say what it is for`);
  }
  // An empty cycle produced nothing, so nothing can be unread.
  assert.deepEqual(undeliveredSignals(reports), []);
  fs.rmSync(root, { recursive: true, force: true });
});
