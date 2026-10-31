"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseModelRoute } = require("../src/policy/model_router");
const { buildRolePlan } = require("../src/agents");
const { assertResearchApiModel, codexSubscriptionEnvironment } = require("../src/policy/research_api");

test("API route remains Luna through pins, retries and a decisive Astra task", () => {
  const facts = { role: "lab-director", billingMode: "api", complexityScore: 6, candidateCount: 6,
    actionType: "hypothesis_tournament", modelPin: "gpt-6-astra", retryCount: 8, failureCategory: "quota" };
  const route = chooseModelRoute(facts);
  assert.equal(route.model, "gpt-6-luna");
  assert.deepEqual(route.fallback_chain, []);
  assert.equal(chooseModelRoute({ ...facts, billingMode: "chatgpt", failureCategory: null }).model, "gpt-6-astra");
});

test("strict model validation rejects aliases and model suffixes", () => {
  for (const model of [null, undefined, "gpt-6-astra", "gpt-5.6-sol", "gpt-6-luna-2026", " gpt-6-luna", "GPT-6-LUNA"]) {
    assert.throws(() => assertResearchApiModel(model), /exactly/);
  }
  assert.equal(assertResearchApiModel("gpt-6-luna"), "gpt-6-luna");
});

test("Codex children receive no API keys while parent and literature credentials survive", () => {
  const parent = { OPENAI_API_KEY: "test-secret", anthropic_api_key: "other-secret", RESEARCHLAB_LUNA_API_KEY: "scoped-secret",
    OPENAI_BASE_URL: "https://example.invalid", SCOPUS_API_KEY: "metadata-key", PATH: "runtime" };
  const before = { ...parent };
  assert.deepEqual(codexSubscriptionEnvironment(parent), { SCOPUS_API_KEY: "metadata-key", PATH: "runtime", RESEARCHLAB_API_MODEL: "gpt-6-luna" });
  assert.deepEqual(parent, before);
});

test("stale role routes cannot override an explicit API mode", () => {
  const plan = buildRolePlan({ prompt: "Summarize literature", lane: { lane_id: "chronicle-01", role: "chronicle",
    billing_mode: "api", model: "gpt-6-astra", model_route: { model: "gpt-6-astra" } } });
  assert.equal(plan.assigned_model, "gpt-6-luna");
  assert.deepEqual(plan.research_api_policy.allowed_models, ["gpt-6-luna"]);
});
