"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { hasSubstantiveEvidence } = require("../src/reporting/evidence_soundness");

test("hollow evidence (null effects, zero passed checks) is not substantive", () => {
  // The exact shape a completed-but-hollow cycle produces: every quantitative
  // primary-effect field null and no passed checks. Must NOT count as evidence.
  const summary = {
    primary_evidence: {
      row_count: null,
      primary_effect: null,
      pooled_effect: null,
      adjusted_primary: null,
      regression_primary: null,
      checks_passed_count: 0,
      checks_total_count: 2,
    },
    validation_results: [
      { validation_id: "v:1", validation_type: "validate_with_subgroup" },
    ],
    promoted_hypothesis_validation: [{ status: "exploratory" }],
    final_claim_package: { research_outcome: null },
  };
  assert.equal(hasSubstantiveEvidence(summary), false);
});

test("empty / missing summary is not substantive", () => {
  assert.equal(hasSubstantiveEvidence({}), false);
  assert.equal(hasSubstantiveEvidence(null), false);
  assert.equal(hasSubstantiveEvidence(undefined), false);
});

test("a numeric primary effect is substantive", () => {
  assert.equal(hasSubstantiveEvidence({ primary_evidence: { primary_effect: 0.49 } }), true);
  assert.equal(hasSubstantiveEvidence({ primary_evidence: { pooled_effect: -0.12 } }), true);
  // zero is a real estimate, not a missing value
  assert.equal(hasSubstantiveEvidence({ primary_evidence: { adjusted_primary: 0 } }), true);
});

test("at least one passed runner check is substantive", () => {
  assert.equal(hasSubstantiveEvidence({ primary_evidence: { checks_passed_count: 1 } }), true);
  assert.equal(hasSubstantiveEvidence({ primary_evidence: { checks_passed_count: 0 } }), false);
});

test("a document-gate-approved claim package is substantive", () => {
  assert.equal(
    hasSubstantiveEvidence({ final_claim_package: { research_outcome: "approved" } }),
    true,
  );
});

test("a validated promoted hypothesis is substantive; exploratory/candidate is not", () => {
  assert.equal(
    hasSubstantiveEvidence({ promoted_hypothesis_validation: [{ status: "validated" }] }),
    true,
  );
  assert.equal(
    hasSubstantiveEvidence({ promoted_hypothesis_validation: [{ support_label: "supported" }] }),
    true,
  );
  assert.equal(
    hasSubstantiveEvidence({ promoted_hypothesis_validation: [{ status: "candidate" }] }),
    false,
  );
});
