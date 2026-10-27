"use strict";

// The director's clue register: what a lead taught the cycle outlives the lead.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const clues = require("../src/reporting/research_clues");

const CYCLE = "cycle-clues";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clues-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  return root;
}

function directorLane(root, laneId, updates, mtime) {
  const dir = path.join(root, "lanes", CYCLE, laneId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "result.json");
  fs.writeFileSync(file, JSON.stringify({ extracted_json: { requery_decision: "replace", research_clue_updates: updates } }));
  const when = new Date(mtime);
  fs.utimesSync(file, when, when);
}

const ADD = {
  op: "add",
  kind: "dead_end",
  statement: "Targeted nearest-support removal cannot be run: the bound accession is confirmed unobtainable.",
  why_it_matters: "Do not spend another lane designing around that dataset.",
  evidence_refs: ["followup-runner-526"],
  lead_key: "hyp:74b518f1",
  importance: "high",
};

test("a clue is recorded with its evidence, and the same statement merges instead of duplicating", () => {
  const root = fixture();
  directorLane(root, "followup-lab-director-1", [ADD], "2026-10-27T01:00:00Z");
  directorLane(root, "followup-lab-director-2", [{ ...ADD, evidence_refs: ["followup-runner-531"], importance: "medium" }], "2026-10-27T02:00:00Z");
  const result = clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  assert.equal(result.applied.length, 2);
  const register = clues.readRegister(root, CYCLE);
  assert.equal(register.clues.length, 1, "the same clue was written twice");
  const clue = register.clues[0];
  assert.equal(clue.clue_id, clues.clueId(ADD.statement));
  assert.deepEqual(clue.evidence_refs, ["followup-runner-526", "followup-runner-531"]);
  assert.equal(clue.importance, "high", "a later, lower importance does not demote it");
  assert.equal(clue.first_recorded_by, "followup-lab-director-1");
  assert.equal(clue.last_updated_by, "followup-lab-director-2");
  assert.equal(clue.history.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("applying again changes nothing, and a lost register is rebuilt from the lanes", () => {
  const root = fixture();
  directorLane(root, "followup-lab-director-1", [ADD], "2026-10-27T01:00:00Z");
  clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  const before = fs.readFileSync(clues.cluesPath(root, CYCLE), "utf8");
  const again = clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  assert.equal(again.changed, false);
  assert.equal(fs.readFileSync(clues.cluesPath(root, CYCLE), "utf8"), before);
  fs.rmSync(clues.cluesPath(root, CYCLE));
  clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  assert.equal(clues.readRegister(root, CYCLE).clues.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a clue is updated by id, and resolving or retiring one needs a reason", () => {
  const root = fixture();
  const id = clues.clueId(ADD.statement);
  directorLane(root, "followup-lab-director-1", [ADD], "2026-10-27T01:00:00Z");
  directorLane(root, "followup-lab-director-2", [
    { op: "update", clue_id: id, status: "retired" },
    { op: "update", clue_id: id, status: "in_use", note: "the v4 panel tests the same question another way" },
    { op: "update", clue_id: "c-00000000", status: "resolved", note: "x" },
  ], "2026-10-27T02:00:00Z");
  const result = clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  assert.deepEqual(result.refused.map((item) => item.why), [
    "a clue is retired with a note saying why",
    "no such clue_id",
  ]);
  const clue = clues.readRegister(root, CYCLE).clues[0];
  assert.equal(clue.status, "in_use");
  assert.match(clue.history.at(-1).change, /status in_use; the v4 panel/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a malformed entry is refused where it can be seen, not dropped silently", () => {
  const root = fixture();
  directorLane(root, "followup-lab-director-1", [
    { op: "add", kind: "dead_end", statement: "too short" },
    { op: "add", kind: "hunch", statement: "A statement that is long enough to be a clue on its own." },
    { op: "remove", clue_id: "c-1" },
  ], "2026-10-27T01:00:00Z");
  const result = clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  assert.equal(result.applied.length, 0);
  assert.equal(result.refused.length, 3);
  assert.equal(clues.readRegister(root, CYCLE).clues.length, 0);
  assert.equal(clues.readRegister(root, CYCLE).refused_recent.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the director's view shows live clues first, the most important first, and leaves retired ones out of the top", () => {
  const root = fixture();
  const mk = (statement, importance) => ({ op: "add", kind: "idea", statement: `${statement} -- a long enough statement.`, importance });
  directorLane(root, "followup-lab-director-1", [mk("alpha low", "low"), mk("bravo high", "high"), mk("charlie medium", "medium"), mk("delta high retired", "high")], "2026-10-27T01:00:00Z");
  directorLane(root, "followup-lab-director-2", [{ op: "update", clue_id: clues.clueId("delta high retired -- a long enough statement."), status: "retired", note: "answered" }], "2026-10-27T02:00:00Z");
  clues.applyDirectorClueUpdates({ root, cycleId: CYCLE });
  const view = clues.readRegister(root, CYCLE).director_view;
  assert.deepEqual(view.map((item) => item.statement.split(" -- ")[0]), ["bravo high", "charlie medium", "alpha low", "delta high retired"]);
  const summary = clues.summarize(clues.readRegister(root, CYCLE));
  assert.equal(summary.total, 4);
  assert.equal(summary.live, 3);
  assert.equal(summary.high, 1);
  const text = clues.renderClues(clues.readRegister(root, CYCLE));
  assert.match(text, /\[high\] c-[0-9a-f]{8}  idea  open/);
  assert.ok(!text.includes("delta high retired"), "a retired clue is listed only with --all");
  assert.match(clues.renderClues(clues.readRegister(root, CYCLE), { all: true }), /delta high retired/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a cycle with no director lanes, or a torn register, never throws", () => {
  const root = fixture();
  assert.deepEqual(clues.applyDirectorClueUpdates({ root, cycleId: CYCLE }).applied, []);
  fs.writeFileSync(clues.cluesPath(root, CYCLE), "{not json");
  assert.equal(clues.readRegister(root, CYCLE).clues.length, 0);
  assert.match(clues.renderClues(clues.readRegister(root, CYCLE)), /No research clues recorded yet/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("status and the clues command read the register, folding in decisions not yet applied", () => {
  const { cycleStatus, VERDICT } = require("../src/reporting/cycle_status");
  const { runCluesCommand } = require("../src/cli/clues");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clues-cli-"));
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  const none = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "clues");
  assert.equal(none.verdict, VERDICT.ABSENT);

  directorLane(root, "followup-lab-director-1", [ADD, { op: "add", kind: "open_question", statement: "Does the crossover survive a second support geometry?", importance: "medium" }], "2026-10-27T01:00:00Z");
  const status = cycleStatus({ root, cycleId: CYCLE }).checks.find((item) => item.id === "clues");
  assert.equal(status.verdict, VERDICT.OK);
  assert.equal(status.detail.total, 2);
  assert.equal(status.detail.high, 1);

  let printed = "";
  runCluesCommand(["--cycle-id", CYCLE], { cwd, out: { write: (text) => { printed += text; } } });
  assert.match(printed, /2 recorded, 2 live \(1 high importance\)/);
  assert.match(printed, /\[high\] c-[0-9a-f]{8}  dead_end  open  lead hyp:74b518f1/);
  assert.match(printed, /evidence: followup-runner-526/);
  assert.throws(() => runCluesCommand([], { cwd, out: { write() {} } }), /requires --cycle-id/);
  let json = "";
  runCluesCommand(["--cycle-id", CYCLE, "--json"], { cwd, out: { write: (text) => { json += text; } } });
  assert.equal(JSON.parse(json).summary.total, 2);
  fs.rmSync(cwd, { recursive: true, force: true });
});
