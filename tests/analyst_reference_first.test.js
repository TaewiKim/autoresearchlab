"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");
const { buildRolePlan } = require("../src/agents/index");

// The analyst's loop used to open on `ask` -- "what single validation question
// would most change the family ranking right now?" -- and every stage after it
// concerned this cycle's own data. Prior work entered the process for the first
// time when the gatekeeper scored novelty against it, which is after the design
// has already been executed and paid for.
//
// The cycle has that literature on disk before any analyst lane runs.

test("the loop opens on prior work, before the question is chosen", () => {
  const plan = buildAnalystQueryPlan({ prompt: "rendering research", laneId: "analyst-01" });
  const stages = plan.analysis_loop.map((step) => step.stage);
  assert.equal(stages[0], "reference", `reference must come first, got ${stages.join(" -> ")}`);
  assert.ok(stages.indexOf("reference") < stages.indexOf("design"), "and before the design");
  assert.ok(stages.indexOf("reference") < stages.indexOf("ask"), "and before the question");
});

test("the stage asks for the method, the comparator and the endpoint", () => {
  const [reference] = buildAnalystQueryPlan({ prompt: "x", laneId: "analyst-01" }).analysis_loop;
  const deliverables = reference.deliverables.join(" ").toLowerCase();
  for (const needed of ["reference methods", "reference comparators", "reference endpoints"]) {
    assert.ok(deliverables.includes(needed), `the stage must ask for ${needed}`);
  }
  // An absence is an answer. A design that found no prior work has to say so and
  // say what it looked at; silence cannot be scored.
  assert.ok(
    deliverables.includes("explicit absence"),
    "finding nothing must be a statable outcome, not a silent one",
  );
});

test("the reads are bounded and point at this cycle's own artifacts", () => {
  const plan = buildAnalystQueryPlan({
    prompt: "x",
    laneId: "analyst-01",
    cycleId: "cycle-g-v89-20260831",
  });
  const reads = plan.analysis_loop[0].read_narrowly.join(" ");
  assert.ok(
    reads.includes(".research-lab/state/cycle-g-v89-20260831-literature-summary.json"),
    "the path must resolve to this cycle, not to a directory to search",
  );
  // The summary runs to megabytes; reading all of it is what the context rule
  // exists to prevent.
  assert.ok(reads.includes("never the whole file"), "the read has to be bounded");
});

test("the design must say what it drew on, or that it found nothing", () => {
  const plan = buildAnalystQueryPlan({ prompt: "x", laneId: "analyst-01" });
  const basis = plan.required_output.find((line) => line.startsWith("reference_basis:"));
  assert.ok(basis, "reference_basis is a required output, not advice");
  assert.match(basis, /estimator/);
  assert.match(basis, /comparator/);
  assert.match(basis, /endpoint/);
  assert.match(basis, /explicit statement that the retrieved corpus holds none/);
});

test("the dispatcher passes the cycle id, so the paths are real", () => {
  // Without this the new parameter is never populated and every path reads
  // "<cycle>" -- a value produced and never consumed, which is the recurring
  // failure this runtime keeps rediscovering.
  const rolePlan = buildRolePlan({
    prompt: "rendering research",
    lane: { lane_id: "analyst-01", role: "analyst" },
    laneId: "analyst-01",
    cycleId: "cycle-g-v89-20260831",
  });
  assert.ok(rolePlan?.analysis_loop, "the analyst branch must return its loop");
  const reads = rolePlan.analysis_loop[0].read_narrowly.join(" ");
  assert.ok(!reads.includes("<cycle>"), "the dispatcher must hand the analyst its cycle id");
  assert.ok(reads.includes("cycle-g-v89-20260831"));
});
