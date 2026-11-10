"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildConclusionReview } = require("../src/reporting/conclusion_review");
const { buildApprovalReview } = require("../src/reporting/approval_review");

const retired = "Novelty: need a broader set of non-trivial hypotheses";
const downgraded = "Reproducibility: method validation still looks too weak for reliable repetition";
const active = "The registered controlled effects are nonidentified";

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-disposition-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cycleId = "cycle-a-20260919";
  const state = path.join(cwd, ".research-lab", "state");
  fs.mkdirSync(state, { recursive: true });
  const write = (kind, value) => fs.writeFileSync(path.join(state, `${cycleId}-${kind}.json`), JSON.stringify(value));
  write("lab-director-hypothesis", { status: "withdrawn", selected_hypothesis: null });
  const gate = {
    gatekeeper_review_status: "parsed", score: 25, gate_passed: false,
    rubric: [{ name: "novelty", score: 20 }, { name: "reproducibility", score: 35 }],
    blockers: [active], gate_scientific_blockers: [active],
    gate_blocker_adjudication_resolution: {
      active_blockers: [active],
      removed_blockers: [{ blocker: retired, adjudication: { decision: "superseded" } }],
      downgraded_blockers: [{ blocker: downgraded, adjudication: { decision: "downgrade" } }],
    },
  };
  write("gate-review", gate);
  const rubric = [
    { name: "novelty", score: 50, reasons: [retired, active] },
    { name: "reproducibility", score: 50, reasons: [downgraded] },
  ];
  const summary = { objective: "Robot imitation coverage", evidence_readiness: { ready: true },
    conclusion_readiness_score: 50, approval_readiness_score: 50,
    conclusion_rubric: rubric, approval_rubric: rubric,
    conclusion_blockers: [retired, downgraded, active], approval_blockers: [retired, downgraded, active] };
  return { cwd, cycleId, write, gate, summary, refresh: () => {
    const conclusion = buildConclusionReview({ cwd, cycleId, researcherView: { summary } }).review;
    const approval = buildApprovalReview({ cwd, cycleId, researcherView: { summary },
      conclusionReview: conclusion, gateReview: gate, staged: true }).review;
    return { conclusion, approval };
  } };
}

test("accepted gate dispositions survive downstream refresh without changing scientific scores", (t) => {
  // MEASURED ON cycle-a-20260919, 2026-11-06: at owner_selection,
  // Director 1872 packaged synchronization patches after completed independent
  // adjudications; conclusion and approval regenerated the retired objections.
  const f = fixture(t);
  for (let pass = 0; pass < 2; pass += 1) {
    const { conclusion, approval } = f.refresh();
    for (const review of [conclusion, approval]) {
      const text = JSON.stringify([review.conclusion_blockers, review.approval_blockers,
        review.conclusion_rubric, review.approval_rubric, review.recommended_followup_actions]);
      assert.ok(!text.includes(retired), "a settled objection must not reappear in successor work");
      assert.ok(!text.includes(downgraded));
      assert.ok(text.includes(active), "sharper scientific blockers remain");
    }
    assert.deepEqual(conclusion.conclusion_rubric.map((item) => item.score), [20, 35]);
    assert.equal(conclusion.conclusion_gate_passed, false);
    assert.equal(approval.approval_gate_passed, false);
    assert.deepEqual(conclusion.raw_conclusion_rubric, f.summary.conclusion_rubric);
    assert.deepEqual(approval.raw_approval_blockers, f.summary.approval_blockers);
  }
});

test("missing and foreign-contract dispositions cannot retire current objections", (t) => {
  const f = fixture(t);
  f.write("lab-director-hypothesis", { status: "selected", primary_family: "successor", dataset_or_accession: "/data/new-panel/episodes.csv" });
  f.write("gate-review", { ...f.gate, current_hypothesis_identity: {
    primary_family: "retired", dataset_keys: ["old-panel"],
  } });
  assert.ok(f.refresh().conclusion.conclusion_blockers.includes(retired));
  f.write("gate-review", { ...f.gate, gate_blocker_adjudication_resolution: null });
  assert.ok(f.refresh().conclusion.conclusion_blockers.includes(retired));
});

test("retiring a reason cannot turn a below-threshold rubric into a gate pass", (t) => {
  const f = fixture(t);
  const rubric = [{ name: "novelty", score: 70, reasons: [retired] },
    { name: "reproducibility", score: 100, reasons: [] }];
  f.write("gate-review", { ...f.gate, rubric });
  const conclusion = buildConclusionReview({ cwd: f.cwd, cycleId: f.cycleId,
    researcherView: { summary: { ...f.summary, conclusion_rubric: rubric } } }).review;
  assert.equal(conclusion.conclusion_score, 85);
  assert.deepEqual(conclusion.conclusion_blockers, []);
  assert.equal(conclusion.all_rubrics_approved, false);
  assert.equal(conclusion.conclusion_gate_passed, false, "the rubric conjunction still controls the gate");
});

test("each sink applies the full decision register even when the gate's applied subset is empty", (t) => {
  // MEASURED ON cycle-a-20260919, 2026-11-09: Director 1906 kept
  // requesting synchronization after Gatekeeper 2058 superseded the breadth
  // objection. The gate published that decision but its applied subset was empty;
  // approval regenerated the same objection and Chronicle had run six times.
  const f = fixture(t);
  const { buildGateReview } = require("../src/reporting/gate_review");
  const { aggregateGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");
  const aggregate = aggregateGatekeeperReviews({ expectedRubrics: ["novelty", "clarity"], parsedReviews: [
    { focus_rubric: "novelty", source_mtime: 1, verdict: "reject", rubric: [],
      blocker_adjudications: [{ blocker: retired, decision: "uphold" }] },
    { focus_rubric: "clarity", source_mtime: 2, verdict: "reject", rubric: [],
      blocker_adjudications: [{ blocker: retired, decision: "superseded" },
        { blocker: downgraded, decision: "downgrade" }, { blocker: active, decision: "uphold" }] },
  ] });
  f.gate.gate_blocker_adjudications = aggregate.blocker_adjudications;
  f.gate.gate_blocker_adjudication_resolution = {
    active_blockers: [active], removed_blockers: [], downgraded_blockers: [], upheld_blockers: [],
  };
  f.write("gate-review", f.gate);
  for (let pass = 0; pass < 3; pass += 1) {
    const { conclusion, approval } = f.refresh();
    for (const review of [conclusion, approval]) {
      const actionable = JSON.stringify([review.conclusion_rubric, review.approval_rubric,
        review.conclusion_blockers, review.approval_blockers, review.recommended_followup_actions]);
      assert.ok(!actionable.includes(retired), "a later supersession survives rubric ordering and refresh");
      assert.ok(!actionable.includes(downgraded));
      assert.ok(actionable.includes(active));
    }
    assert.equal(conclusion.conclusion_gate_passed, false);
    assert.equal(approval.approval_gate_passed, false);
    assert.deepEqual(conclusion.conclusion_rubric.map((item) => item.score), [20, 35]);
    assert.deepEqual(conclusion.raw_conclusion_rubric, f.summary.conclusion_rubric);
    assert.deepEqual(approval.raw_approval_rubric, f.summary.approval_rubric);
  }
  // The gate uses that same resolver when it sees the objection again.
  const lane = path.join(f.cwd, ".research-lab", "lanes", f.cycleId, "gatekeeper-2058");
  fs.mkdirSync(lane, { recursive: true });
  for (const [file, value] of Object.entries({
    "role-plan.json": { role: "gatekeeper", action_type: "independent_gate_review_followup", target_rubric: "novelty" },
    "final-status.json": { status: "completed" },
    "result.json": { extracted_json: { verdict: "reject", reviewer_focus_rubric: "novelty",
      rubric: f.gate.rubric, blocker_adjudications: aggregate.blocker_adjudications } },
  })) fs.writeFileSync(path.join(lane, file), JSON.stringify(value));
  const gate = buildGateReview({ cwd: f.cwd, cycleId: f.cycleId,
    researcherView: { summary: f.summary }, conclusionReview: { review: {
      conclusion_gate_passed: false, conclusion_blockers: [retired, active],
    } }, approvalReview: { review: {} } }).review;
  assert.ok(!gate.gate_scientific_blockers.includes(retired));
  assert.ok(gate.gate_scientific_blockers.includes(active));
  assert.equal(gate.gate_passed, false);
});

test("published decisions remain bound to the current lead and a later uphold restores an objection", (t) => {
  const f = fixture(t);
  f.gate.gate_blocker_adjudications = [{ blocker: retired, decision: "uphold" },
    { blocker: retired, decision: "superseded" }];
  f.write("gate-review", f.gate);
  assert.ok(f.refresh().conclusion.conclusion_blockers.includes(retired));
  f.write("lab-director-hypothesis", { status: "selected", primary_family: "new-lead",
    dataset_or_accession: "/data/new-panel/episodes.csv" });
  f.write("gate-review", { ...f.gate, current_hypothesis_identity: { primary_family: "old-lead", dataset_keys: ["old-panel"] },
    gate_blocker_adjudications: [{ blocker: retired, decision: "superseded" }] });
  assert.ok(f.refresh().conclusion.conclusion_blockers.includes(retired));
});
