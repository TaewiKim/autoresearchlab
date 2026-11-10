"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deriveProgress, recordProgress, stallFindings, supervisorConfig } = require("../src/orchestrator/cycle_progress");

test("a standing owner release advances the measured feasibility churn past the removed checkpoint", (t) => {
  // MEASURED ON cycle-a-20260919, 2026-11-09: candidate_feasibility,
  // 6 completed gate restarts, no owner-candidates, withdrawn lead. Round 3's
  // spent_round retained the release that both scheduling and observation lost.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "owner-release-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cycleId = "cycle-a-20260919";
  const root = path.join(cwd, ".research-lab");
  const state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  const write = (kind, value) => fs.writeFileSync(path.join(state, `${cycleId}-${kind}.json`), JSON.stringify(value));
  const before = "2026-11-07T06:43:54Z";
  const now = Date.parse("2026-11-09T04:48:55Z");
  for (const [kind, field] of [["field-landscape", "subfields"], ["sota-cards", "cards"],
    ["field-beliefs", "beliefs"], ["candidate-slate", "candidates"], ["expert-panel", "ranking"],
    ["novelty-audit", "audits"], ["candidate-feasibility", "assessments"]]) {
    write(kind, { [field]: [{}], projected_at: before, updated_at: before });
  }
  write("frontier-harvest", { candidates: [], projected_at: before });
  write("lab-director-hypothesis", { status: "withdrawn", selected_hypothesis: null, updated_at: "2026-11-09T04:23:44Z" });
  for (let i = 0; i < 6; i += 1) {
    const dir = path.join(root, "lanes", cycleId, `followup-lab-director-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "role-plan.json"), JSON.stringify({ action_type: "gate_restart_followup" }));
    fs.writeFileSync(path.join(dir, "final-status.json"), JSON.stringify({ status: "completed", completed_at: "2026-11-09T04:21:13Z" }));
  }
  const stuck = recordProgress({ cwd, cycleId, now }).progress;
  assert.equal(stuck.current_milestone, "candidate_feasibility");
  assert.equal(stuck.next_milestone, "owner_checkpoint");
  assert.ok(stallFindings({ progress: stuck, config: supervisorConfig({}), now })
    .some((f) => f.signature === "lane_churn:candidate_feasibility:gate_restart_followup"));
  const release = { candidate_id: "release", decision: "slate_released", selected_at: "2026-11-09T02:40:34Z" };
  const rounds = [{ spent_round: { owner_selection: release } }];
  write("expert-selection", { round: 3, rounds });
  const advanced = recordProgress({ cwd, cycleId, now }).progress;
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.current_milestone, "owner_selection");
  assert.equal(advanced.next_milestone, "lead_selected");
  assert.ok(!advanced.waiting_on.some((s) => s.includes("owner_checkpoint")));
  assert.equal(fs.existsSync(path.join(state, `${cycleId}-owner-candidates.json`)), false);
  // Explicit current choices win over history; old slate picks cannot transfer.
  write("expert-selection", { rounds, owner_selection: { candidate_id: "new", decision: "candidate_picked" } });
  assert.equal(deriveProgress({ cwd, cycleId, now }).current_milestone, "candidate_feasibility");
  write("expert-selection", { rounds: [...rounds, { spent_round: { owner_selection: { candidate_id: "old" } } }] });
  assert.equal(deriveProgress({ cwd, cycleId, now }).current_milestone, "candidate_feasibility");
});
