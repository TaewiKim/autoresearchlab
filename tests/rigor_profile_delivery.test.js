// The reviewer scoring reproducibility must be handed the reproducibility evidence.
//
// cycle-g-v86 scored technical_quality=3 and reproducibility=2 for TWELVE of its
// eighteen gate rounds, `reproducibility` binding on nine of them. Not a
// trajectory -- a constant, and an honest reading of the input.
//
// Measured across v86: 24 runner lanes finished `overall: passed`, bound to the
// lead, at reproducibility_grade="supported". Across all 38 gatekeeper prompts:
//
//     measured_quantities    38 / 38
//     rigor_profile           0 / 38
//     reproducibility_grade   0 / 38
//     table_evidence          0 / 38
//
// The gate projects each validation result through a field whitelist and
// rigor_profile was never on it. Today's earlier fix made the value CORRECT and
// never checked it was DELIVERED -- the fourth time this session a rule looked
// ignored and had simply never arrived.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// compactRigorProfile is module-private, so lift it out with the one helper it
// closes over rather than exporting internals just for a test.
const SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "src", "reporting", "reviews", "gate", "actions.js"),
  "utf8",
);
const SLICE = SOURCE.slice(
  SOURCE.indexOf("function compactRigorProfile("),
  SOURCE.indexOf("function authoritativeGateFollowupActions("),
);
const compactRigorProfile = new Function(
  "asArray",
  `${SLICE}; return compactRigorProfile;`,
)((v) => (Array.isArray(v) ? v : []));

// What the driver writes on a lane like v85's followup-runner-08.
const SUPPORTED = {
  signals: {
    multi_seed: true, dispersion: true, comparator: true,
    interval: false, significance: true, effect_size: true,
  },
  core_present: ["multi_seed", "dispersion", "comparator"],
  core_missing: [],
  reproducibility_grade: "supported",
  basis: "measured quantities plus the per-row tables emitted by the executed blueprints",
  affordable_here:
    "the instrument probe measured a 2-arm x 5-seed x 3-scene sweep at 36.3s of render " +
    "and three converged references at 48.6s in this container, with bitwise-reproducible " +
    "seeds -- a single-seed, comparator-free run is a design choice, not a cost limit",
  table_evidence: {
    tables_scanned: 5,
    multi_seed: { column: "seed", distinct_values: 5, table: "allocation_results_per_seed.csv" },
    comparator: {
      column: "method", distinct_values: 3,
      table: "allocation_results_per_seed.csv",
      arms: ["aov_only", "joint", "uniform"],
    },
  },
};

test("the grade and the signals survive the projection", () => {
  const out = compactRigorProfile(SUPPORTED);
  assert.strictEqual(out.reproducibility_grade, "supported");
  assert.deepStrictEqual(out.core_present, ["multi_seed", "dispersion", "comparator"]);
  assert.deepStrictEqual(out.core_missing, []);
  assert.strictEqual(out.signals.multi_seed, true);
  assert.strictEqual(out.signals.interval, false);
});

test("the named columns survive, because that is what makes it checkable", () => {
  const out = compactRigorProfile(SUPPORTED);
  assert.strictEqual(out.table_evidence.multi_seed.column, "seed");
  assert.strictEqual(out.table_evidence.multi_seed.distinct_values, 5);
  assert.strictEqual(out.table_evidence.multi_seed.table, "allocation_results_per_seed.csv");
  assert.deepStrictEqual(out.table_evidence.comparator.arms, ["aov_only", "joint", "uniform"]);
});

test("the generic prose does not, because the prompts are already 70-99KB", () => {
  const out = JSON.stringify(compactRigorProfile(SUPPORTED));
  assert.ok(!out.includes("affordable"), out);
  assert.ok(!out.includes("instrument probe measured"), out);
  assert.ok(out.length < JSON.stringify(SUPPORTED).length);
});

test("an unsupported run reports what is MISSING, not nothing", () => {
  const out = compactRigorProfile({
    signals: { multi_seed: false, dispersion: true, comparator: false },
    core_present: ["dispersion"],
    core_missing: ["multi_seed", "comparator"],
    reproducibility_grade: "partial",
  });
  assert.strictEqual(out.reproducibility_grade, "partial");
  assert.deepStrictEqual(out.core_missing, ["multi_seed", "comparator"]);
  // No table evidence to name, so the key is absent rather than empty.
  assert.ok(!("table_evidence" in out));
});

test("a missing profile projects to null rather than an empty shell", () => {
  assert.strictEqual(compactRigorProfile(null), null);
  assert.strictEqual(compactRigorProfile(undefined), null);
  assert.strictEqual(compactRigorProfile("supported"), null);
});

// Everything above tests the FORMATTER. On cycle-g-v87 the formatter was
// correct, the source text below matched, and the field still reached 0 of 11
// gatekeeper prompts -- so from here down the tests go through the real
// exported projection instead.
const { compactGateValidationResults } = require("../src/reporting/reviews/gate/actions.js");

// The summary shape v87 produced at 16:49, after four runner lanes had written
// rigor_profile: 52 entries in {cycle}-validation-results.json whose schema
// (validation_id / execution_status / coefficients / target_hypothesis_ids)
// shares no field name with the per-entry map, plus the run summary that
// actually holds the profile.
function v87Summary() {
  return {
    validation_results: {
      validation_results: [
        {
          validation_id: "validation:H-ARTIFACT-CROSSOVER-01:2",
          execution_status: "completed_exploratory",
          validation_type: "edge_robustness_test",
          coefficients: [],
          target_hypothesis_ids: ["H-ARTIFACT-CROSSOVER-01"],
        },
      ],
    },
    latest_validation_summary: {
      primary_hypothesis_id: "H-ARTIFACT-CROSSOVER-01",
      overall_status: "passed",
      checks_passed: 13,
      checks_total: 13,
      measured_quantities: [{ name: "crossover_spp", value: 41.2 }],
      rigor_profile: SUPPORTED,
    },
  };
}

test("the run's rigor profile reaches the compacted gate payload", () => {
  const out = compactGateValidationResults(v87Summary());
  assert.ok(out.rigor_profile, "the reproducibility rubric's only evidence must be delivered");
  assert.strictEqual(out.rigor_profile.reproducibility_grade, "supported");
  // Delivery means it survives serialisation into the reviewer's prompt, which
  // is how it is actually transported.
  assert.match(JSON.stringify(out), /"reproducibility_grade":"supported"/);
});

test("it is delivered on the branch that actually fires", () => {
  // The hole was branch-specific: v87's 52 entries all filter away, so the
  // single-entry fallback is the branch every prompt was built from. A test that
  // did not pin the branch would pass while the live path stayed empty.
  const out = compactGateValidationResults(v87Summary());
  assert.strictEqual(
    out.counts.validation_result_count,
    1,
    "v87's entries carry no mapped field, so the fallback branch must be the one under test",
  );
  assert.ok(out.rigor_profile);
});

test("a per-entry profile still wins where a producer supplies one", () => {
  const summary = v87Summary();
  summary.validation_results.validation_results = [
    { lane_id: "followup-runner-11", verdict: "passed", rigor_profile: SUPPORTED },
  ];
  const out = compactGateValidationResults(summary);
  assert.strictEqual(out.counts.validation_result_count, 1);
  assert.strictEqual(out.validation_results[0].rigor_profile.reproducibility_grade, "supported");
});

test("no run summary means null, not an empty shell", () => {
  const out = compactGateValidationResults({ focus_hypotheses: [] });
  assert.strictEqual(out.rigor_profile, null);
});
