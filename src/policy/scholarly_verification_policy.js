"use strict";

const APPROVED_SCHOLARLY_NETWORK_POLICY = "approved-scholarly-metadata-v1";

function normalizeStage(stage) {
  return String(stage || "").trim().toLowerCase() || "evidence";
}

function approvedScholarlyMetadataPolicyEnabled() {
  return String(process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY || "").trim()
    === APPROVED_SCHOLARLY_NETWORK_POLICY;
}

function scholarlyVerificationPolicyDecision({ researchStage = "evidence" } = {}) {
  // The legacy verifier shells out to `curl -L`, so it cannot enforce the
  // approved host/path/query/redirect contract. Keep it off even if an older
  // launcher explicitly enabled scholarly lookups. The scoped literature
  // driver remains responsible for approved metadata retrieval.
  if (approvedScholarlyMetadataPolicyEnabled()) {
    return {
      external_lookup_enabled: false,
      additional_verification_status: "pending",
      reason: "legacy_unscoped_lookup_blocked_by_approved_scholarly_metadata_policy",
    };
  }

  const env = String(process.env.RESEARCHLAB_ENABLE_SCHOLARLY_LOOKUPS || "").trim().toLowerCase();
  const stage = normalizeStage(researchStage);
  const enabled = env === "1" || env === "true" || env === "on"
    ? true
    : env === "0" || env === "false" || env === "off"
      ? false
      : stage === "document" || stage === "evidence";
  return {
    external_lookup_enabled: enabled,
    additional_verification_status: enabled ? "active" : "pending",
    reason: enabled ? "legacy_scholarly_lookup_enabled" : "legacy_scholarly_lookup_disabled",
  };
}

function shouldUseExternalScholarlyVerification({ researchStage = "evidence" } = {}) {
  return scholarlyVerificationPolicyDecision({ researchStage }).external_lookup_enabled;
}

module.exports = {
  approvedScholarlyMetadataPolicyEnabled,
  scholarlyVerificationPolicyDecision,
  shouldUseExternalScholarlyVerification,
};
