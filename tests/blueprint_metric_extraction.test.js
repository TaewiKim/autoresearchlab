"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  parseAucFromNotes,
  strongestFiniteValue,
  blueprintPrimaryMetric,
} = require("../src/reporting/visualizer/artifact_collectors");

test("parseAucFromNotes recovers an AUC figure from prose", () => {
  assert.equal(
    parseAucFromNotes("pooled AUC linear=0.618, nonlinear=0.755; permutation95=0.880"),
    0.618,
  );
  assert.equal(parseAucFromNotes("AUC 0.72 on held-out seeds"), 0.72);
  assert.equal(parseAucFromNotes("no metric here"), null);
  assert.equal(parseAucFromNotes(null), null);
});

test("strongestFiniteValue returns the largest-magnitude finite value", () => {
  assert.equal(
    strongestFiniteValue({ a: 0.0036, b: -0.068 }),
    -0.068,
  );
  assert.equal(strongestFiniteValue({ a: "not a number" }, { b: 0.4 }), 0.4);
  assert.equal(strongestFiniteValue(null, {}), null);
});

test("blueprintPrimaryMetric surfaces a robotics blueprint result that has no cohort effect", () => {
  // The exact shape a python-stats robotics blueprint emits: no pooled/adjusted
  // cohort effect, but a structured correlation map and an AUC in the note.
  const result = {
    blueprint_executions: [
      {
        metrics: {
          correlations: { ee_speed_vs_is_jam: 0.0036, kinematic_energy_vs_is_jam: -0.068 },
          notes: "pooled AUC linear=0.618, nonlinear=0.755; permutation95=0.880",
        },
      },
    ],
    stats: { correlations: { ee_speed_vs_is_jam: 0.0036, kinematic_energy_vs_is_jam: -0.068 } },
  };
  // AUC from the note wins over the weak correlation
  assert.equal(blueprintPrimaryMetric(result), 0.618);
});

test("blueprintPrimaryMetric prefers an explicit structured metric field", () => {
  const result = {
    blueprint_executions: [
      { metrics: { primary_effect: 0.44, notes: "AUC 0.9 mentioned in passing" } },
    ],
  };
  assert.equal(blueprintPrimaryMetric(result), 0.44);
});

test("blueprintPrimaryMetric falls back to correlation when no AUC/structured field", () => {
  const result = {
    blueprint_executions: [{ metrics: { correlations: { x_vs_y: -0.31 } } }],
  };
  assert.equal(blueprintPrimaryMetric(result), -0.31);
});

test("blueprintPrimaryMetric returns null when there is nothing quantitative", () => {
  assert.equal(blueprintPrimaryMetric({}), null);
  assert.equal(blueprintPrimaryMetric({ blueprint_executions: [] }), null);
  assert.equal(blueprintPrimaryMetric({ blueprint_executions: [{ metrics: { notes: "qualitative only" } }] }), null);
});
