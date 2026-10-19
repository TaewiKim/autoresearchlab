"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  recordExecutedExperiments,
  adoptedExperimentFollowupActions,
} = require("../src/reporting/experiment_requests");

// cycle-g-v89: one adopted request, FIVE analyst lanes told to design it, one
// runner that executed it. The ledger had no way to hear the answer, so the
// paper review kept emitting the design request at priority 9,900.
//
// The fixture is the recorded shape, not an invention: the runner names the
// analyst handoff it ran, the analyst lane carries the claim the ledger keys
// on, and the runner's metrics carry pass_fail and resolution_status. Both
// runners report completed with degraded false -- the stub differs only in
// having reached no verdict.

const CLAIM =
  "Rendering-derived acquisition contains boundary-localization information beyond severity order under equal two-query budgets.";

function cycle({ withVerdict = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exp-req-"));
  const cycleId = "cycle-g-v89-20260831";
  const lanes = path.join(root, "lanes", cycleId);
  fs.mkdirSync(path.join(root, "state"), { recursive: true });

  // Every lane records its role in run-state.json, and that is what tells the
  // resolver which lanes are worth opening: role plans here are a fifth of a
  // megabyte and there are twelve hundred lanes.
  const lane = (id, role) => {
    const dir = path.join(lanes, id);
    fs.mkdirSync(dir, { recursive: true });
    if (role) {
      fs.writeFileSync(
        path.join(dir, "run-state.json"),
        JSON.stringify({ lane_id: id, role, status: "completed" }),
      );
    }
    return dir;
  };

  // The analyst that designed it: its result carries the claim verbatim.
  fs.writeFileSync(
    path.join(lane("followup-analyst-201", "analyst"), "result.json"),
    JSON.stringify({ notes: `designing for: ${CLAIM}` }),
  );
  fs.writeFileSync(
    path.join(lane("followup-analyst-201", "analyst"), "handoff-validation-plan.json"),
    JSON.stringify({ handoff_checks: [{ check_id: "MASKED_NONMONOTONE_ZFB_V1" }] }),
  );

  // An analyst for a different request, whose runner must not be counted.
  fs.writeFileSync(
    path.join(lane("followup-analyst-144", "analyst"), "result.json"),
    JSON.stringify({ notes: "an unrelated design" }),
  );

  const handoff = (analyst) =>
    JSON.stringify({
      analysis_request: {
        handoff_path: path.join(lanes, analyst, "handoff-validation-plan.json"),
      },
      planner_metadata: {
        analyst_handoff_path: path.join(lanes, analyst, "handoff-validation-plan.json"),
      },
    });

  // The real execution: 1288s, a verdict, a falsification.
  fs.writeFileSync(path.join(lane("followup-runner-131", "lab-runner"), "role-plan.json"), handoff("followup-analyst-201"));
  fs.writeFileSync(
    path.join(lanes, "followup-runner-131", "result.json"),
    JSON.stringify({
      status: "completed",
      blueprint_executions: [
        {
          check_id: "MASKED_NONMONOTONE_ZFB_V1",
          blueprint_id: "BP_MASKED_NONMONOTONE_ZFB_V1",
          duration_seconds: 1288.17,
          metrics: withVerdict
            ? { pass_fail: "fail", resolution_status: "valid_falsification" }
            : {},
        },
      ],
    }),
  );

  // The stub: same lane shape, same "completed", one second, empty metrics.
  fs.writeFileSync(path.join(lane("followup-runner-130", "lab-runner"), "role-plan.json"), handoff("followup-analyst-201"));
  fs.writeFileSync(
    path.join(lanes, "followup-runner-130", "result.json"),
    JSON.stringify({
      status: "completed",
      blueprint_executions: [
        { check_id: "SCHEMA-GATE-ZFB-MASKED-01", duration_seconds: 1, metrics: {} },
      ],
    }),
  );

  // A runner for the other analyst, which answers nothing here.
  fs.writeFileSync(path.join(lane("followup-runner-81", "lab-runner"), "role-plan.json"), handoff("followup-analyst-144"));
  fs.writeFileSync(
    path.join(lanes, "followup-runner-81", "result.json"),
    JSON.stringify({
      status: "completed",
      blueprint_executions: [{ check_id: "OTHER_V1", metrics: { pass_fail: "pass" } }],
    }),
  );

  fs.writeFileSync(
    path.join(root, "state", `${cycleId}-experiment-requests.json`),
    JSON.stringify({
      cycle_id: cycleId,
      requests: [
        {
          claim_it_would_support: CLAIM,
          experiment: "Mask numeric and ordinal severity labels from both policies...",
          result_that_licenses_the_claim: "The rendering-derived arm has lower paired crossing error than the sham...",
          result_that_refutes_it: "The sham again matches the rendering-derived arm, or the rendering-derived arm misses any preregistered endpoint.",
          status: "adopted",
          decision: { adopt: true, reason: "Owner decision 2026-09-09: run it.", decided_by: "owner" },
        },
      ],
    }),
  );
  return { root, cycleId };
}

test("the run that answered an adopted request is recorded against it", () => {
  const { root, cycleId } = cycle();
  const ledger = recordExecutedExperiments({ root, cycleId });
  const request = ledger.requests[0];

  assert.equal(request.executed_by.length, 1, "one verdict-producing run, not two");
  const run = request.executed_by[0];
  assert.equal(run.lane_id, "followup-runner-131");
  assert.equal(run.check_id, "MASKED_NONMONOTONE_ZFB_V1");
  assert.equal(run.pass_fail, "fail");
  assert.equal(run.resolution_status, "valid_falsification");
  assert.equal(run.designed_by, "followup-analyst-201");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a completed run that reached no verdict has answered nothing", () => {
  // runner-130's shape: completed, degraded false, one second, empty metrics.
  // Completion is not evidence and duration is not the test.
  const { root, cycleId } = cycle({ withVerdict: false });
  const ledger = recordExecutedExperiments({ root, cycleId });
  assert.equal(
    (ledger.requests[0].executed_by || []).length,
    0,
    "no run in this cycle produced a verdict",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("an executed request stops asking the analyst to design it", () => {
  const { root, cycleId } = cycle();
  const actions = adoptedExperimentFollowupActions({ root, cycleId });
  const design = actions.filter((a) => a.type === "author_requested_experiment");
  assert.equal(design.length, 0, "five analyst lanes designed this experiment once too often");

  const answered = actions.filter((a) => a.type === "author_requested_experiment_answered");
  assert.equal(answered.length, 1);
  assert.equal(answered[0].preferred_role, "author", "the answer is the author's to apply");
  assert.equal(answered[0].required_for_gate, true);
  // The author is handed its own two preregistered outcomes beside what was
  // measured. Deciding which one this was is a scientific judgement, and
  // matching measured numbers to prose was refuted by measurement here.
  assert.ok(answered[0].experiment_request.result_that_licenses_the_claim);
  assert.ok(answered[0].experiment_request.result_that_refutes_it);
  assert.match(answered[0].blocker_reasons[0], /withdraw it and record it in withdrawn_claims/);
  assert.match(answered[0].description, /MASKED_NONMONOTONE_ZFB_V1: fail/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an adopted request with no execution still asks for the design", () => {
  const { root, cycleId } = cycle({ withVerdict: false });
  const actions = adoptedExperimentFollowupActions({ root, cycleId });
  const design = actions.filter((a) => a.type === "author_requested_experiment");
  assert.equal(design.length, 1, "an unrun adoption must still reach the analyst");
  assert.equal(design[0].preferred_role, "analyst");
  assert.equal(
    actions.filter((a) => a.type === "author_requested_experiment_answered").length,
    0,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("lanes ruled out are remembered, so the scan is paid once", () => {
  const { root, cycleId } = cycle({ withVerdict: false });
  // A lane that is still running: its role plan names the handoff, but it has
  // written no result yet, so it may still answer this request.
  const inFlight = path.join(root, "lanes", cycleId, "followup-runner-132");
  fs.mkdirSync(inFlight, { recursive: true });
  fs.writeFileSync(
    path.join(inFlight, "run-state.json"),
    JSON.stringify({ lane_id: "followup-runner-132", role: "lab-runner", status: "running" }),
  );
  fs.writeFileSync(
    path.join(inFlight, "role-plan.json"),
    JSON.stringify({
      analysis_request: {
        handoff_path: path.join(
          root, "lanes", cycleId, "followup-analyst-201", "handoff-validation-plan.json",
        ),
      },
    }),
  );

  const first = recordExecutedExperiments({ root, cycleId });
  const examined = first.requests[0].execution_lanes_examined || [];
  assert.ok(examined.includes("followup-runner-81"), "a runner for another design is settled");
  assert.ok(examined.includes("followup-runner-130"), "a finished run with no verdict is settled");
  assert.ok(!examined.includes("followup-runner-132"), "a lane still in flight stays open");

  const second = recordExecutedExperiments({ root, cycleId });
  assert.deepEqual(
    (second.requests[0].execution_lanes_examined || []).sort(),
    examined.slice().sort(),
    "a second pass adds nothing and re-reads nothing",
  );
  fs.rmSync(root, { recursive: true, force: true });
});
