"use strict";

// Soundness floor shared by the approval and conclusion reviews.
//
// `evidence_readiness.ready` only certifies that the core lanes COMPLETED, not
// that they produced anything. A cycle can finish every lane yet promote only
// empty validation-plan descriptors, null primary effects, and templated
// "candidate" hypotheses — a hollow run that, without this check, sails to an
// approval-ready / conclusion-ready score (observed: a robotics cycle whose
// AUC-shaped runner output never mapped onto the epidemiology-shaped evidence
// schema scored 98/approval-ready on entirely null quantitative fields).
//
// Returns true only when at least one GENUINE quantitative or validated evidence
// signal exists. Cross-domain by construction: a real numeric primary effect, a
// passed runner check, or a document-gate-approved claim package all qualify, so
// biomedical happy-paths are unaffected and a future robotics-schema fix (mapping
// AUC/lead-time into primary_effect or checks_passed_count) satisfies it too.
function hasSubstantiveEvidence(summary) {
  const isNum = (value) => typeof value === "number" && Number.isFinite(value);
  const primaryEvidence = (summary && summary.primary_evidence) || {};
  // 1) a non-null quantitative primary effect estimate from a runner
  for (const key of [
    "primary_effect",
    "adjusted_primary",
    "adjusted_effect",
    "pooled_effect",
    "regression_primary",
  ]) {
    if (isNum(primaryEvidence[key])) return true;
  }
  // 2) a runner reported at least one PASSED validation check
  if (isNum(primaryEvidence.checks_passed_count) && primaryEvidence.checks_passed_count > 0) {
    return true;
  }
  // 3) the document gate approved a final claim package
  const finalClaimPackage = (summary && summary.final_claim_package) || {};
  if (finalClaimPackage.research_outcome === "approved") return true;
  // 4) a promoted hypothesis reached a validated (non-exploratory/candidate) status
  const promoted = Array.isArray(summary && summary.promoted_hypothesis_validation)
    ? summary.promoted_hypothesis_validation
    : [];
  if (
    promoted.some((item) => {
      const status = String(
        (item && (item.status || item.support_label || item.validation_status)) || "",
      ).toLowerCase();
      return status === "validated" || status === "supported" || status === "confirmed";
    })
  ) {
    return true;
  }
  return false;
}

module.exports = { hasSubstantiveEvidence };
