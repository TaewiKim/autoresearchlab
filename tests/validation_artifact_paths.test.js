// The reviewer asked where the results are. The files were on disk the whole time.
//
// cycle-g-v89 capped reproducibility at 55-68 with one recurring objection:
//
//     "No artifact paths, executable bundle, scene definitions, split
//      assignments, or analysis code are referenced in the evidence packet."
//
// 182 CSVs and 66 PNGs sat under artifacts/stats/<cycle>/, and every runner
// result recorded their absolute paths in blueprint_executions[].tables[].path,
// .figures[].path and .output_dir. 43 of 45 gatekeeper prompts carried
// `"validation_artifact_paths": []`.
//
// Two faults: nothing collected the RUN's paths (the only writer of that field
// stores chronicle's own bookkeeping JSON, which is not what the objection is
// about), and the consumer sliced an OBJECT as an array.
//
// These go through the exported projection with v89's real result shape. The
// three delivery bugs before this one all passed their source-text assertions
// while the value never arrived.

const test = require("node:test");
const assert = require("node:assert");

const { compactGateValidationResults } = require("../src/reporting/reviews/gate/actions.js");

// followup-runner-27's shape, trimmed to the fields the collector reads.
const RUN_PATHS = [
  {
    kind: "table",
    name: "v5_across_seed_dispersion.csv",
    path: "/opt/researchlab/.research-lab/artifacts/stats/cycle-g-v89-20260831/"
      + "followup-runner-27/blueprints/chk_sparse_counterfactual_v5_01/v5_across_seed_dispersion.csv",
  },
  {
    kind: "figure",
    name: "v5_risk_work_frontier.png",
    path: "/opt/researchlab/.research-lab/artifacts/stats/cycle-g-v89-20260831/"
      + "followup-runner-27/blueprints/chk_sparse_counterfactual_v5_01/v5_risk_work_frontier.png",
  },
  {
    kind: "output_dir",
    name: null,
    path: "/opt/researchlab/.research-lab/artifacts/stats/cycle-g-v89-20260831/"
      + "followup-runner-27/blueprints/chk_sparse_counterfactual_v5_01",
  },
];

function summary(overrides = {}) {
  return {
    validation_artifact_paths: RUN_PATHS,
    latest_validation_summary: {
      overall_status: "passed",
      checks_passed: 2,
      checks_total: 2,
      measured_quantities: [{ name: "false_safe_upper", value: 0.1583 }],
    },
    ...overrides,
  };
}

test("the run's table and figure paths reach the compacted payload", () => {
  const out = compactGateValidationResults(summary());
  assert.strictEqual(out.validation_artifact_paths.length, 3);
  const kinds = out.validation_artifact_paths.map((p) => p.kind).sort();
  assert.deepStrictEqual(kinds, ["figure", "output_dir", "table"]);
  // Delivery means surviving serialisation into the reviewer's prompt.
  assert.match(JSON.stringify(out), /v5_across_seed_dispersion\.csv/);
  assert.match(JSON.stringify(out), /v5_risk_work_frontier\.png/);
});

test("chronicle's object-shaped bookkeeping paths are listed, not wrapped", () => {
  // asArray({a: 1}) yields [{a: 1}] -- one opaque blob where the reviewer needs a
  // list. This is the shape hypothesis_ledger.js has always written.
  const out = compactGateValidationResults(summary({
    validation_artifact_paths: {
      validation_plan: "/state/cycle-g-v89-validation-plan.json",
      data_graph: "/state/cycle-g-v89-data-graph.json",
      reasoning_graph: "/state/cycle-g-v89-reasoning-graph.json",
    },
  }));
  assert.strictEqual(out.validation_artifact_paths.length, 3);
  assert.deepStrictEqual(
    out.validation_artifact_paths.map((p) => p.name).sort(),
    ["data_graph", "reasoning_graph", "validation_plan"],
  );
  for (const entry of out.validation_artifact_paths) {
    assert.ok(entry.path.startsWith("/state/"), `lost the path for ${entry.name}`);
  }
});

test("no paths yields an empty list rather than a null hole", () => {
  for (const value of [null, undefined, "", 0, []]) {
    const out = compactGateValidationResults(summary({ validation_artifact_paths: value }));
    assert.deepStrictEqual(out.validation_artifact_paths, [], `for ${JSON.stringify(value)}`);
  }
});

test("the list is bounded, because prompts are already 70-160KB", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    kind: "table", name: `t${i}.csv`, path: `/stats/t${i}.csv`,
  }));
  const out = compactGateValidationResults(summary({ validation_artifact_paths: many }));
  assert.strictEqual(out.validation_artifact_paths.length, 24);
});

test("collecting paths does not disturb the rest of the payload", () => {
  // The same function carries rigor_profile and the validation results; a
  // regression here would silently undo 78a0b1f.
  const out = compactGateValidationResults(summary());
  assert.ok("rigor_profile" in out);
  assert.ok(Array.isArray(out.validation_results));
  assert.strictEqual(out.counts.validation_result_count, out.validation_results.length);
});
