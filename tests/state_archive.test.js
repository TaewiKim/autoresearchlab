"use strict";

// A delete nothing could prevent, made survivable.
//
// MEASURED ON cycle-g-v91, 2026-09-13. followup-lab-director-44 rewrote state
// files with apply_patch, which expresses a rewrite as a delete followed by an
// add. research-trend-analysis.json got both halves. lab-director-hypothesis
// .json got the delete (item_7) and never the add -- the watchdog halt killed
// the lane 66 seconds later -- and the cycle's only record of the director's
// decision stopped existing. The review-map entries for it are symlinks, so
// they went dangling rather than preserving anything.
//
// Nothing in the system could have refused that delete: `allowed_outputs` in
// the lane contract names the lane's own directory, no code reads the field to
// gate a write, and the lane runs under
// --dangerously-bypass-approvals-and-sandbox. So these pin the weaker property
// that is actually available -- the record survives, and its disappearance is
// recorded by something other than whoever removed it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  archiveAuthoritativeState,
  restoreMissingAuthoritativeState,
  kindFromStateFile,
} = require("../src/provenance/state_archive");

const CYCLE = "cg-archive-test";
const NEWLINE = String.fromCharCode(10);

function newRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-archive-"));
  fs.mkdirSync(path.join(root, ".research-lab", "state"), { recursive: true });
  return root;
}

function writeState(root, kind, value, ext = ".json") {
  const filePath = path.join(root, ".research-lab", "state", `${CYCLE}-${kind}${ext}`);
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

function archives(root, kind) {
  try {
    return fs.readdirSync(path.join(root, ".research-lab", "state-archive", CYCLE, kind)).sort();
  } catch {
    return [];
  }
}

function events(root) {
  const filePath = path.join(root, ".research-lab", "events", `${CYCLE}-cycle-events.jsonl`);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(NEWLINE).filter(Boolean).map((line) => JSON.parse(line));
}

test("a state filename resolves to the kind the table names, or to nothing", () => {
  assert.equal(kindFromStateFile(`${CYCLE}-lab-director-hypothesis.json`, CYCLE), "lab-director-hypothesis");
  // The same kind arrives under more than one extension.
  assert.equal(kindFromStateFile(`${CYCLE}-claim-traces.json`, CYCLE), "claim-traces");
  // Not this cycle's file, and not a kind anybody classified.
  assert.equal(kindFromStateFile("other-cycle-claim-traces.json", CYCLE), null);
  assert.equal(kindFromStateFile(`${CYCLE}-something-nobody-classified.json`, CYCLE), null);
});

test("only authoritative artifacts are copied", () => {
  const root = newRoot();
  writeState(root, "claim-traces", { a: 1 });
  writeState(root, "literature-graph", { nodes: 1 });
  const result = archiveAuthoritativeState({ root, cycleId: CYCLE });
  assert.deepEqual(result.archived.map((item) => item.kind), ["claim-traces"]);
  assert.equal(archives(root, "claim-traces").length, 1);
  assert.equal(archives(root, "literature-graph").length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unchanged artifact is not copied again", () => {
  // Most passes are this one. A watchdog that copied everything every five
  // minutes would be its own disk problem.
  const root = newRoot();
  writeState(root, "claim-traces", { a: 1 });
  archiveAuthoritativeState({ root, cycleId: CYCLE, now: new Date("2026-09-13T11:00:00Z") });
  const second = archiveAuthoritativeState({ root, cycleId: CYCLE, now: new Date("2026-09-13T11:05:00Z") });
  assert.deepEqual(second.archived, []);
  assert.equal(archives(root, "claim-traces").length, 1);

  writeState(root, "claim-traces", { a: 2 });
  const third = archiveAuthoritativeState({ root, cycleId: CYCLE, now: new Date("2026-09-13T11:10:00Z") });
  assert.equal(third.archived.length, 1);
  assert.equal(archives(root, "claim-traces").length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the number of versions kept is bounded", () => {
  const root = newRoot();
  for (let index = 0; index < 6; index += 1) {
    writeState(root, "claim-traces", { a: index });
    archiveAuthoritativeState({
      root, cycleId: CYCLE, keep: 3,
      now: new Date(Date.UTC(2026, 8, 13, 11, index)),
    });
  }
  const kept = archives(root, "claim-traces");
  assert.equal(kept.length, 3);
  // The three most recent, not the three oldest.
  assert.ok(kept[2].startsWith("2026-09-13T11-05"), kept.join(","));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an artifact with copies and no live file comes back", () => {
  // The cycle-g-v91 shape: apply_patch landed the delete and died before the add.
  const root = newRoot();
  const livePath = writeState(root, "lab-director-hypothesis", {
    statement: "the lead that must survive",
    selected_hypothesis: { falsification_conditions: ["it does not beat the comparator"] },
  });
  archiveAuthoritativeState({ root, cycleId: CYCLE });

  fs.rmSync(livePath);
  assert.ok(!fs.existsSync(livePath), "precondition: the artifact is gone");

  const result = restoreMissingAuthoritativeState({
    root, cycleId: CYCLE,
    actor: "followup-lab-director-44",
    reason: "the artifact had archived copies and no live file",
  });

  assert.deepEqual(result.restored.map((item) => item.kind), ["lab-director-hypothesis"]);
  assert.equal(
    JSON.parse(fs.readFileSync(livePath, "utf8")).statement,
    "the lead that must survive",
  );

  // Loud: the removal AND the restore, so "it came back" never reads as "it was
  // never gone".
  const payloads = events(root).map((item) => item.payload);
  const removal = payloads.find((item) => item.operation === "remove");
  assert.ok(removal, "the disappearance was not recorded");
  assert.equal(removal.actor, "followup-lab-director-44");
  assert.match(removal.reason, /not by its remover/);
  const restore = payloads.find((item) => item.operation === "replace");
  assert.equal(restore.actor, "state_archive");
  assert.ok(restore.previous_version_path, "the restore does not say which copy it used");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an artifact that is merely present is left alone", () => {
  const root = newRoot();
  writeState(root, "lab-director-hypothesis", { statement: "still here" });
  archiveAuthoritativeState({ root, cycleId: CYCLE });
  const result = restoreMissingAuthoritativeState({ root, cycleId: CYCLE, actor: "x", reason: "y" });
  assert.deepEqual(result.restored, []);
  assert.deepEqual(events(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a cycle with no state and no archive is not an error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-archive-"));
  assert.deepEqual(archiveAuthoritativeState({ root, cycleId: CYCLE }).archived, []);
  assert.deepEqual(restoreMissingAuthoritativeState({ root, cycleId: CYCLE, actor: "a", reason: "b" }).restored, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an artifact set aside on purpose is not resurrected", () => {
  // FOUND BY THIS MODULE ON ITS FIRST REAL RUN against cycle-g-v91. The
  // watchdog halt is an authoritative kind, so clearing the halt -- which this
  // repository does by renaming the file beside itself -- looked exactly like
  // losing the lead, and the pass put the halt straight back. A cycle that
  // could never be resumed again.
  const root = newRoot();
  const livePath = writeState(root, "watchdog-halt", { halted_at: "2026-09-13T11:05:51Z" });
  archiveAuthoritativeState({ root, cycleId: CYCLE });

  // Clear it the way the repository clears one.
  fs.renameSync(livePath, `${livePath}.cleared-with-9f0efe9`);

  const result = restoreMissingAuthoritativeState({ root, cycleId: CYCLE, actor: "operator", reason: "r" });
  assert.deepEqual(result.restored, [], "a deliberate clear was undone");
  assert.deepEqual(result.deliberate.map((item) => item.kind), ["watchdog-halt"]);
  assert.ok(!fs.existsSync(livePath), "the artifact came back");
  assert.deepEqual(events(root), [], "a decision was recorded as a disappearance");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a set-aside copy older than the archive does not shield a later loss", () => {
  // The halt cleared this morning must not stop this evening's lost lead from
  // coming back. Only a set-aside NEWER than the copy means "this absence is
  // the decision"; an older one is a previous, already-finished story.
  const root = newRoot();
  const livePath = writeState(root, "lab-director-hypothesis", { statement: "the lead" });
  // A set-aside from before anything was archived. The wait is not decoration:
  // a tie is read as deliberate, which is the safe way round in production and
  // ambiguous in a test that writes both files in the same instant, and the
  // kernel's file clock advances in ticks of up to 10 ms.
  fs.writeFileSync(`${livePath}.cleared-with-older`, "{}", "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
  archiveAuthoritativeState({ root, cycleId: CYCLE });

  fs.rmSync(livePath);
  const result = restoreMissingAuthoritativeState({ root, cycleId: CYCLE, actor: "a", reason: "b" });
  assert.deepEqual(result.restored.map((item) => item.kind), ["lab-director-hypothesis"]);
  assert.equal(JSON.parse(fs.readFileSync(livePath, "utf8")).statement, "the lead");
  fs.rmSync(root, { recursive: true, force: true });
});
