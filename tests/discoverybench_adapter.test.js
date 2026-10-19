"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scoreHypothesis,
  relationshipClass,
  variablesMatch,
  formatHarnessInput,
} = require("../src/evals/benchmarks/discoverybench_adapter");

const gold = {
  hypothesis: "Among early-career researchers, higher international collaboration share is positively associated with annual publication count.",
  context: "early-career researchers",
  variables: ["international_collaboration_share", "annual_publication_count"],
  relationship: "positive association",
};

test("relationship class detection", () => {
  assert.equal(relationshipClass("positively associated, productivity increases"), "positive");
  assert.equal(relationshipClass("inverse relationship, productivity decreases"), "negative");
  assert.equal(relationshipClass("no significant association"), "none");
  assert.equal(relationshipClass("a u-shaped, nonlinear interaction effect"), "nonlinear");
});

test("variables facet matches gold variables present in predicted text", () => {
  assert.equal(
    variablesMatch(gold.variables, "international_collaboration_share raises annual_publication_count"),
    1,
  );
  assert.ok(variablesMatch(gold.variables, "collaboration share only") < 1);
});

test("a correct hypothesis scores HMS=1 across all facets", () => {
  const s = scoreHypothesis({
    predicted:
      "For early-career researchers, an increase in international_collaboration_share is positively associated with higher annual_publication_count.",
    gold,
  });
  assert.equal(s.hms, 1);
  assert.equal(s.facets.variables.match, true);
  assert.equal(s.facets.context.match, true);
  assert.equal(s.facets.relationship.match, true);
});

test("wrong direction fails the relationship facet -> HMS=0", () => {
  const s = scoreHypothesis({
    predicted:
      "For early-career researchers, higher international_collaboration_share is negatively associated with annual_publication_count.",
    gold,
  });
  assert.equal(s.facets.relationship.gold, "positive");
  assert.equal(s.facets.relationship.predicted, "negative");
  assert.equal(s.hms, 0);
});

test("wrong subpopulation fails the context facet -> HMS=0", () => {
  const s = scoreHypothesis({
    predicted: "International collaboration positively relates to annual_publication_count and international_collaboration_share.",
    gold,
  });
  // no "early-career" context tokens -> context facet misses
  assert.equal(s.facets.context.match, false);
  assert.equal(s.hms, 0);
});

test("pluggable LLM-judge hook overrides the deterministic scorer", () => {
  const s = scoreHypothesis({
    predicted: "anything",
    gold,
    judge: () => ({ hms: 1, soft_score: 1, facets: { via: "llm" } }),
  });
  assert.equal(s.facets.via, "llm");
});

test("formatHarnessInput turns a task into a cycle input", () => {
  const input = formatHarnessInput({
    task_id: "t1",
    domain: "scientometrics",
    query: "characterize the relationship",
    dataset_metadata: { name: "researchers.csv", columns: [{ name: "x" }, { name: "y" }] },
  });
  assert.equal(input.benchmark, "discoverybench");
  assert.equal(input.cycle_prompt, "characterize the relationship");
  assert.deepEqual(input.column_hint, ["x", "y"]);
});
