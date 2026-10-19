"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildChronicleBriefPlan } = require("../src/agents/chronicle/brief_plan");

test("chronicle brief plan carries direct corpus interaction contract", () => {
  const plan = buildChronicleBriefPlan({
    prompt: "test prompt",
    laneId: "chronicle-01",
    cycleId: "cycle-dci",
  });

  assert.equal(plan.direct_corpus_interaction_contract.required, true);
  assert.equal(plan.direct_corpus_interaction_contract.source_refs[0].arxiv, "2605.05242");
  assert.match(
    plan.direct_corpus_interaction_contract.source_refs[1].url,
    /DCI-Agent-Lite/,
  );
  assert.equal(
    plan.direct_corpus_interaction_contract.required_artifacts.corpus_map_path,
    ".research-lab/state/cycle-dci-chronicle-dci-corpus-map.json",
  );
  assert.equal(
    plan.direct_corpus_interaction_contract.context_management.summarize_checkpoint_for_resume,
    true,
  );
});
