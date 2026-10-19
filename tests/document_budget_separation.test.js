"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const GUARD = path.join(__dirname, "..", "src", "cli", "token_budget_guard.js");
const MB = 1048576;

// The guard runs its work at module load and exits, so it is exercised the way
// the watchdog loop actually invokes it: as a process, judged by what it writes
// and the code it exits with.
function runGuard({ lanes, authorized = true, ceilingMb, documentCeilingMb }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
  const cycleId = "cycle-01";
  const laneRoot = path.join(root, "lanes", cycleId);
  for (const [lane, bytes] of Object.entries(lanes)) {
    fs.mkdirSync(path.join(laneRoot, lane), { recursive: true });
    fs.writeFileSync(path.join(laneRoot, lane, "prompt.txt"), "x".repeat(bytes));
  }
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  if (authorized) {
    fs.writeFileSync(
      path.join(root, "state", `${cycleId}-document-authorization.json`),
      JSON.stringify({ authorized: true, reason: "the science is worth writing up" }),
    );
  }

  const args = [GUARD, "--cycle-id", cycleId, "--root", root, "--ceiling-mb", String(ceilingMb)];
  if (documentCeilingMb !== undefined) args.push("--document-ceiling-mb", String(documentCeilingMb));
  const proc = spawnSync(process.execPath, args, { encoding: "utf8" });

  const status = JSON.parse(
    fs.readFileSync(path.join(root, "state", `${cycleId}-token-budget.json`), "utf8"),
  );
  const haltPath = path.join(root, "state", `${cycleId}-watchdog-halt.json`);
  const halt = fs.existsSync(haltPath) ? JSON.parse(fs.readFileSync(haltPath, "utf8")) : null;
  const onlyPath = path.join(root, "state", `${cycleId}-document-only.json`);
  const documentOnly = fs.existsSync(onlyPath) ? JSON.parse(fs.readFileSync(onlyPath, "utf8")) : null;
  return { status, halt, documentOnly, code: proc.status };
}

// The measured cycle-g-v89 shape: research churn owns 90% of the pot.
const V89_SHAPE = {
  "followup-analyst-01": 30 * MB,
  "followup-lab-director-01": 28 * MB,
  "followup-gatekeeper-01": 26 * MB,
  "followup-author-01": 9 * MB,
  "followup-illustrator-01": 1 * MB,
};

test("research spend cannot consume the write-up's budget", () => {
  const { status, halt, code } = runGuard({
    lanes: V89_SHAPE,
    ceilingMb: 100,
    documentCeilingMb: 30,
  });
  assert.equal(status.budget_is_split, true);
  assert.equal(status.research_mb, 84);
  assert.equal(status.document_mb, 10);
  // 94MB total would be 94% of a shared 100MB pot. Against its own ceiling the
  // write-up has used a third of what it was given.
  assert.equal(status.document_percent_of_ceiling, 33.3);
  assert.equal(halt, null);
  assert.equal(code, 0);
});

test("the write-up running out is its own halt, naming its own ceiling", () => {
  const { status, halt, code } = runGuard({
    lanes: { ...V89_SHAPE, "followup-author-02": 25 * MB },
    ceilingMb: 100,
    documentCeilingMb: 30,
  });
  assert.equal(status.document_mb, 35);
  assert.equal(halt.signatures[0].signature, "document_input_budget_ceiling");
  assert.match(halt.signatures[0].recommended_action, /Research spend did not cause this/);
  assert.equal(code, 1);
});

// Halting here would leave the write-up's reserved budget unspent, which is the
// outcome separating the pots existed to prevent.
test("research exhaustion finishes the paper instead of killing the cycle", () => {
  const { halt, documentOnly, code } = runGuard({
    lanes: { ...V89_SHAPE, "followup-analyst-02": 20 * MB },
    ceilingMb: 100,
    documentCeilingMb: 30,
  });
  assert.equal(halt, null);
  assert.equal(code, 0);
  assert.equal(documentOnly.document_only, true);
  assert.equal(documentOnly.research_mb, 104);
  assert.equal(documentOnly.document_mb, 10);
  assert.match(documentOnly.reason, /finishing the paper is the authorised goal/);
});

// Without a document pot to fall back on there is nothing to finish the paper
// with, so research exhaustion is still the end of the cycle.
test("research exhaustion still halts when the budget is not split", () => {
  const { halt } = runGuard({
    lanes: { ...V89_SHAPE, "followup-analyst-02": 20 * MB },
    ceilingMb: 100,
  });
  assert.equal(halt.signatures[0].signature, "codex_input_budget_ceiling");
});

// The write-up's own ceiling is where the cycle finally stops.
test("the document ceiling still halts, even in document-only mode", () => {
  const { halt } = runGuard({
    lanes: { ...V89_SHAPE, "followup-analyst-02": 20 * MB, "followup-author-02": 25 * MB },
    ceilingMb: 100,
    documentCeilingMb: 30,
  });
  assert.equal(halt.signatures[0].signature, "document_input_budget_ceiling");
});

test("without an authorisation there is one pot, exactly as before", () => {
  const { status, halt } = runGuard({
    lanes: V89_SHAPE,
    authorized: false,
    ceilingMb: 90,
    documentCeilingMb: 30,
  });
  assert.equal(status.budget_is_split, false);
  // Every byte counts against the single ceiling, document lanes included.
  assert.equal(status.prompt_mb, 94);
  assert.equal(halt.signatures[0].signature, "codex_input_budget_ceiling");
});

test("without a document ceiling nothing changes", () => {
  const { status } = runGuard({ lanes: V89_SHAPE, ceilingMb: 100 });
  assert.equal(status.budget_is_split, false);
  assert.equal(status.document_ceiling_mb, null);
});

// A provider outage is a condition NOW. Counting every lane that ever failed
// made one transient limit permanent: cycle-g-v89 failed twice at 00:09 and
// re-halted within seconds of every clear nine hours later.
test("a stale quota failure stops halting once it ages out", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quota-"));
  const cycleId = "cycle-01";
  const laneRoot = path.join(root, "lanes", cycleId);
  fs.mkdirSync(path.join(root, "state"), { recursive: true });

  const lane = (name, ageMinutes) => {
    const dir = path.join(laneRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.txt"), "x".repeat(MB));
    const result = path.join(dir, "result.json");
    fs.writeFileSync(result, JSON.stringify({ failure_category: "quota_exceeded" }));
    const when = new Date(Date.now() - ageMinutes * 60 * 1000);
    fs.utimesSync(result, when, when);
  };

  const run = (windowMinutes) => {
    const args = [GUARD, "--cycle-id", cycleId, "--root", root, "--ceiling-mb", "100",
      "--quota-window-minutes", String(windowMinutes)];
    const proc = spawnSync(process.execPath, args, { encoding: "utf8" });
    const haltPath = path.join(root, "state", `${cycleId}-watchdog-halt.json`);
    const halt = fs.existsSync(haltPath) ? JSON.parse(fs.readFileSync(haltPath, "utf8")) : null;
    if (halt) fs.unlinkSync(haltPath);
    const status = JSON.parse(fs.readFileSync(path.join(root, "state", `${cycleId}-token-budget.json`), "utf8"));
    return { halt, status, code: proc.status };
  };

  lane("followup-gatekeeper-01", 540); // nine hours ago, the measured case

  const stale = run(30);
  assert.equal(stale.halt, null, "a nine-hour-old failure is not a live outage");
  assert.equal(stale.code, 0);
  assert.equal(stale.status.quota_exceeded_lanes, 0);
  // The failure is still visible, just not treated as current.
  assert.equal(stale.status.quota_exceeded_lanes_total, 1);

  lane("followup-gatekeeper-02", 2); // still failing right now
  const live = run(30);
  assert.equal(live.halt.signatures[0].signature, "codex_quota_exhausted");
  assert.equal(live.status.quota_exceeded_lanes, 1);
  assert.equal(live.status.quota_exceeded_lanes_total, 2);
  assert.match(live.halt.signatures[0].recommended_action, /within the last 30 minutes/);
});
