"use strict";

function derivePassBudgetForMinimumRuntime(minimumRuntimeHours, sleepSeconds) {
  const hours = Number(minimumRuntimeHours || 0);
  if (!Number.isFinite(hours) || hours <= 0) return 8;
  const effectiveSleepSeconds = Math.max(1, Number(sleepSeconds || 0));
  return Math.max(8, Math.ceil((hours * 3600) / effectiveSleepSeconds));
}

function shouldStopForStageBudget({
  stage,
  evidencePasses,
  autoRefinementPasses,
  documentPasses,
  maxEvidencePasses,
  maxAutoRefinementPasses,
  maxDocumentPasses,
}) {
  if (stage === "evidence" && maxEvidencePasses !== 0 && evidencePasses >= maxEvidencePasses) {
    return true;
  }
  if (
    stage === "conclusion" &&
    maxAutoRefinementPasses !== 0 &&
    autoRefinementPasses >= maxAutoRefinementPasses
  ) {
    return true;
  }
  if (stage === "document" && maxDocumentPasses !== 0 && documentPasses >= maxDocumentPasses) {
    return true;
  }
  return false;
}

module.exports = {
  derivePassBudgetForMinimumRuntime,
  shouldStopForStageBudget,
};
