"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { codexCatalog } = require("../src/models/catalog");
const { chooseModelRoute, ROUTE_VERSION } = require("../src/policy/model_router");
const { buildDynamicAgentPlan } = require("../src/agents/lab_director/agent_plan");
const { buildRolePlan } = require("../src/agents");

test("catalog lists the four current Codex routing tiers", () => {
  const ids = codexCatalog().models.map((model) => model.id);
  assert.deepEqual(ids.slice(0, 4), [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-5.6-luna",
  ]);
});

test("router assigns routine and complex work to the appropriate cost tier", () => {
  assert.equal(chooseModelRoute({
    role: "chronicle", runtimeClass: "codex-agent", prompt: "Summarize the new evidence.",
  }).model, "gpt-5.6-luna");
  assert.equal(chooseModelRoute({
    role: "scout", runtimeClass: "codex-agent", prompt: "Compare the literature, citations, and candidate datasets for a novel experiment.",
  }).model, "gpt-6.1-terra");
  assert.equal(chooseModelRoute({
    role: "analyst", runtimeClass: "codex-agent", complexityScore: 5, actionType: "falsification_comparison",
  }).model, "gpt-6.1-sol");
});

test("router reserves Astra for candidate synthesis and decisive adjudication", () => {
  const synthesis = chooseModelRoute({
    role: "lab-director",
    runtimeClass: "codex-agent",
    complexityScore: 5,
    actionType: "hypothesis_tournament",
    candidateCount: 3,
  });
  assert.equal(synthesis.model, "gpt-6-astra");
  assert.equal(synthesis.reasoning_effort, "xhigh");
  assert.match(synthesis.route_reason, /reserved Astra/i);

  const ordinaryReview = chooseModelRoute({
    role: "gatekeeper", runtimeClass: "codex-agent", complexityScore: 5, actionType: "technical_review",
  });
  assert.equal(ordinaryReview.model, "gpt-6.1-sol");

  const decisiveReview = chooseModelRoute({
    role: "gatekeeper",
    runtimeClass: "codex-agent",
    complexityScore: 5,
    actionType: "novelty_adjudication",
    scientificStakes: "decisive",
  });
  assert.equal(decisiveReview.model, "gpt-6-astra");
});

test("router respects pins, retries, availability fallback, and driver bypass", () => {
  const pinned = chooseModelRoute({
    role: "scout", runtimeClass: "codex-agent", modelPin: "gpt-6.1-sol",
  });
  assert.equal(pinned.model, "gpt-6.1-sol");
  assert.match(pinned.route_reason, /explicit model pin/i);

  const retry = chooseModelRoute({
    role: "analyst", runtimeClass: "codex-agent", retryCount: 2, failureCategory: "invalid_structured_output",
  });
  assert.equal(retry.model, "gpt-6.1-sol");

  const quotaFallback = chooseModelRoute({
    role: "lab-director",
    runtimeClass: "codex-agent",
    complexityScore: 5,
    actionType: "hypothesis_tournament",
    candidateCount: 3,
    failureCategory: "quota_exceeded",
  });
  assert.equal(quotaFallback.model, "gpt-6.1-sol");

  const driver = chooseModelRoute({
    role: "lab-runner", runtimeClass: "external-driver", laneMode: "driver-exec",
  });
  assert.equal(driver.model, "python-external-driver");
  assert.equal(driver.reasoning_effort, "none");
  assert.deepEqual(driver.fallback_chain, []);
});

test("agent and role plans retain assigned_model alongside model_route", () => {
  const plan = buildDynamicAgentPlan({
    prompt: "Generate at least three candidate hypotheses, compare prior art, and adjudicate the novelty of a new experiment.",
    catalogPath: "/tmp/catalog.json",
    researchStage: "evidence",
  });
  const director = plan.agents.find((agent) => agent.role === "lab-director");
  const chronicle = plan.agents.find((agent) => agent.role === "chronicle");
  const runner = plan.agents.find((agent) => agent.role === "lab-runner");
  assert.equal(director.model, "gpt-6-astra");
  assert.equal(director.model_route.route_version, ROUTE_VERSION);
  assert.equal(chronicle.model, "gpt-6.1-terra");
  assert.equal(runner.model, "python-external-driver");

  const rolePlan = buildRolePlan({
    prompt: "Summarize the evidence.",
    lane: {
      lane_id: "chronicle-01",
      role: "chronicle",
      runtime_class: "codex-agent",
      lane_mode: "read-write-scoped",
      model: "gpt-5.6-luna",
      model_route: chronicle.model_route,
    },
    cycleId: "router-test",
  });
  assert.equal(rolePlan.assigned_model, rolePlan.model_route.model);
  assert.deepEqual(rolePlan.model_route, chronicle.model_route);
});

test("pins never authorize an automatic model change on long or failed work", () => {
  const selected = chooseModelRoute({ role: "lab-director", modelPin: "gpt-5.6-luna",
    actionType: "hypothesis_tournament", candidateCount: 5, complexityScore: 6,
    prompt: "hypothesis ".repeat(20_000), retryCount: 3, failureCategory: "quota_exceeded" });
  assert.equal(selected.model, "gpt-5.6-luna");
  assert.deepEqual(selected.fallback_chain, []);
  assert.throws(() => chooseModelRoute({ modelPin: "unverified-model" }), /unsupported Codex model pin/);
  const plan = buildRolePlan({ prompt: "Summarize new evidence.", cycleId: "pin-update",
    lane: { lane_id: "chronicle-01", role: "chronicle", runtime_class: "codex-agent",
      model_pin: "gpt-5.6-luna", model_route: { model: "gpt-6-astra", reasoning_effort: "xhigh" } } });
  assert.equal(plan.assigned_model, "gpt-5.6-luna");
  assert.deepEqual(plan.model_route.fallback_chain, []);
});

test("runtime failures preserve the tier while response-quality failures may escalate", () => {
  for (const failureCategory of ["timeout", "context_window_exceeded", "context_length_exceeded", "invalid_json_schema"]) {
    assert.equal(chooseModelRoute({ role: "analyst", complexityScore: 2, retryCount: 3,
      failureCategory }).model, "gpt-6.1-terra", failureCategory);
  }
  assert.equal(chooseModelRoute({ role: "analyst", complexityScore: 2, retryCount: 2,
    failureCategory: "invalid_structured_output" }).model, "gpt-6.1-sol");
});

test("long evidence and candidate inventories do not imply a hard synthesis task", () => {
  const longEvidence = "paper citation hypothesis experiment ".repeat(8_000);
  for (const estimatedPromptBytes of [undefined, null, ""]) {
    const selected = chooseModelRoute({ role: "scout", complexityScore: 1,
      prompt: longEvidence, estimatedPromptBytes });
    assert.equal(selected.model, "gpt-6.1-terra");
    assert.match(selected.route_reason, /long prompt/);
  }
  const inventory = chooseModelRoute({ role: "lab-director", complexityScore: 5,
    actionType: "status_digest", candidateCount: 20 });
  assert.equal(inventory.model, "gpt-6.1-sol");
  assert.ok(!inventory.fallback_chain.includes("gpt-6-astra"));
});
