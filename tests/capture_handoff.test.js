"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractEvalHandoff,
  findAnalystHandoff,
  accessionFromDatasetRoot,
} = require("../src/evals/capture_handoff");

test("finds the analyst handoff wherever the runtime parked it", () => {
  assert.ok(findAnalystHandoff({ analyst_handoff: { primary_hypothesis_id: "h" } }));
  assert.ok(
    findAnalystHandoff({ role_plan: { planner_metadata: { analyst_handoff: { primary_hypothesis_id: "h" } } } }),
  );
  assert.equal(findAnalystHandoff({}), null);
});

test("accession is parsed from a dataset_root path", () => {
  assert.equal(
    accessionFromDatasetRoot("/workspace/.research-lab/datasets/cycle-x/gse318067"),
    "GSE318067",
  );
  assert.equal(accessionFromDatasetRoot(""), null);
});

test("uses an explicit canonical_variable_resolution when present", () => {
  const result = {
    analyst_handoff: {
      primary_hypothesis_id: "h1",
      canonical_variable_resolution: [
        { concept: "primary_exposure", resolved_accession: "GSE318067", source_tier: "verified_semantic" },
      ],
    },
  };
  const out = extractEvalHandoff(result, { caseId: "c1" });
  assert.equal(out.ok, true);
  assert.equal(out.projected, false);
  assert.equal(out.handoff.canonical_variable_resolution[0].source_tier, "verified_semantic");
});

test("projects a raw_table resolution from a pre-contract handoff", () => {
  const result = {
    analyst_handoff: {
      primary_hypothesis_id: "hyp-director-gse318067",
      dataset_root: "/ws/.research-lab/datasets/cycle-x/gse318067",
      handoff_checks: [{ exposures: ["cd4_activation"], outcome: "severity_score" }],
    },
  };
  const out = extractEvalHandoff(result, { caseId: "real-1", laneRef: "cycle-x/analyst-01" });
  assert.equal(out.ok, true);
  assert.equal(out.projected, true);
  const rows = out.handoff.canonical_variable_resolution;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].resolved_accession, "GSE318067");
  // Conservative tier: a projected resolution must not claim the canonical tier.
  assert.equal(rows[0].source_tier, "raw_table");
  assert.equal(rows.every((r) => r._projected), true);
});

test("fails cleanly when there is no handoff", () => {
  const out = extractEvalHandoff({ status: "completed" }, { caseId: "c" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no analyst_handoff/i);
});
