"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ensureLabDirectorResearchNotes } = require("../src/reporting/lab_director_research_notes");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "director-notebook-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-a-20260919";
  const laneId = "followup-lab-director-1866";
  const lane = path.join(root, "lanes", cycleId, laneId);
  const state = path.join(root, "state");
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const canonical = path.join(state, `${cycleId}-lab-director-research-notes.json`);
  write(canonical, { current_lead_hypothesis: { statement: "Resume the withdrawn allocation lead" } });
  fs.utimesSync(canonical, new Date("2026-10-30"), new Date("2026-10-30"));
  const hypothesis = path.join(state, `${cycleId}-lab-director-hypothesis.json`);
  const withdrawal = { status: "withdrawn", selected_hypothesis: null,
    projection_source: "lab_director_lane_result", generated_by: laneId };
  write(hypothesis, withdrawal);
  write(path.join(lane, "final-status.json"), { status: "completed" });
  write(path.join(lane, "result.json"), { extracted_json: { requery_decision: "restart", selected_hypothesis: null } });
  const local = path.join(lane, "lab-director-research-notes.json");
  const notes = { cycle_id: cycleId, current_lead_hypothesis: null,
    decision_log: [{ decision: "restart_requested_no_successor" }],
    handoff_for_next_lab_director: "Do not resume allocation from stale notes." };
  write(local, notes);
  const markdown = "# Director's complete reasoning\n" + "Retain the failed-method measurements.\n".repeat(200);
  fs.writeFileSync(path.join(lane, "lab-director-research-notes.md"), markdown);
  return { root, cycleId, laneId, lane, canonical, hypothesis, withdrawal, local, notes, markdown, write,
    refresh: () => ensureLabDirectorResearchNotes({ root, cycleId }) };
}

test("refresh publishes the accepted withdrawal notebook without restoring its historical lead", (t) => {
  // MEASURED ON cycle-a-20260919, 2026-11-06: 745 requery lanes
  // finished at owner_selection while Director 1866's corrected local notebook
  // never replaced October 30's allocation-resumption instructions.
  const f = fixture(t);
  const before = fs.readFileSync(f.hypothesis, "utf8");
  assert.equal(f.refresh().reason, "published_lane_notebook");
  const published = JSON.parse(fs.readFileSync(f.canonical, "utf8"));
  assert.equal(published.current_lead_hypothesis, null);
  assert.equal(published.generated_by, f.laneId);
  assert.deepEqual(published.decision_log, f.notes.decision_log);
  assert.equal(fs.readFileSync(f.canonical.replace(/json$/, "md"), "utf8"), f.markdown);
  assert.equal(fs.readFileSync(f.hypothesis, "utf8"), before);
  assert.equal(f.refresh().updated, false, "publication is idempotent");
  const audit = JSON.parse(fs.readFileSync(path.join(f.root, "events", `${f.cycleId}-cycle-events.jsonl`), "utf8"));
  assert.match(fs.readFileSync(audit.payload.previous_version_path, "utf8"), /Resume the withdrawn allocation lead/);
});

test("running, failed, deferred, and inconsistent notebooks cannot replace accepted reasoning", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.canonical, "utf8");
  for (const status of ["running", "failed"]) {
    f.write(path.join(f.lane, "final-status.json"), { status });
    assert.equal(f.refresh().updated, false);
  }
  f.write(path.join(f.lane, "final-status.json"), { status: "completed" });
  f.write(f.hypothesis, { ...f.withdrawal, generated_by: "followup-lab-director-1864" });
  assert.equal(f.refresh().updated, false, "a refused replacement has no publication authority");
  f.write(f.hypothesis, f.withdrawal);
  f.write(f.local, { ...f.notes, current_lead_hypothesis: { statement: "Restore allocation" } });
  assert.equal(f.refresh().updated, false, "notes cannot reverse an accepted withdrawal");
  assert.equal(fs.readFileSync(f.canonical, "utf8"), original);
});

test("an accepted selected lead publishes only its matching notebook and preserves later edits", (t) => {
  const f = fixture(t);
  const statement = "A complete claim " + "with its registered comparison ".repeat(40);
  f.write(f.hypothesis, { ...f.withdrawal, status: "selected", statement });
  f.write(f.local, { ...f.notes, current_lead_hypothesis: { statement: statement + "changed endpoint" } });
  assert.equal(f.refresh().updated, false, "matching a truncated prefix cannot admit a different claim");
  f.write(f.local, { ...f.notes, current_lead_hypothesis: { statement } });
  assert.equal(f.refresh().updated, true);
  assert.equal(JSON.parse(fs.readFileSync(f.canonical, "utf8")).current_lead_hypothesis.statement, statement);
  f.write(f.canonical, { ...f.notes, handoff_for_next_lab_director: "A later operator correction" });
  fs.utimesSync(f.canonical, new Date("2099-01-01"), new Date("2099-01-01"));
  assert.equal(f.refresh().updated, false);
  assert.match(fs.readFileSync(f.canonical, "utf8"), /later operator correction/);
});
