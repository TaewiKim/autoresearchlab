"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  scholarlyVerificationPolicyDecision,
  shouldUseExternalScholarlyVerification,
} = require("../src/policy/scholarly_verification_policy");

// These tests describe the default literature path. The Docker image sets the
// approved scholarly network policy, which the test process must not inherit.
delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;

test("scholarly verification policy defaults on for document stage", () => {
  const previous = process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  delete process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  assert.equal(shouldUseExternalScholarlyVerification({ researchStage: "document" }), true);
  assert.equal(shouldUseExternalScholarlyVerification({ researchStage: "evidence" }), true);
  if (previous == null) {
    delete process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  } else {
    process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = previous;
  }
});

test("scholarly verification policy respects explicit environment override", () => {
  const previous = process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = "0";
  assert.equal(shouldUseExternalScholarlyVerification({ researchStage: "document" }), false);
  process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = "1";
  assert.equal(shouldUseExternalScholarlyVerification({ researchStage: "evidence" }), true);
  if (previous == null) {
    delete process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  } else {
    process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = previous;
  }
});

test("approved scholarly metadata policy blocks the legacy curl verifier even when explicitly enabled", () => {
  const previousLookup = process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
  const previousPolicy = process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = "1";
  process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = "approved-scholarly-metadata-v1";
  try {
    const decision = scholarlyVerificationPolicyDecision({ researchStage: "evidence" });
    assert.equal(decision.external_lookup_enabled, false);
    assert.equal(decision.additional_verification_status, "pending");
    assert.equal(shouldUseExternalScholarlyVerification({ researchStage: "evidence" }), false);
  } finally {
    if (previousLookup == null) delete process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS;
    else process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS = previousLookup;
    if (previousPolicy == null) delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
    else process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = previousPolicy;
  }
});
