"use strict";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function decideDocumentRewriteEscalation({
  rewriteQueue = [],
  reportActions = [],
  paperActions = [],
} = {}) {
  const queue = asArray(rewriteQueue);
  const reviewActions = asArray(reportActions).concat(asArray(paperActions));
  const highSeverityCount = queue.filter((item) => String(item?.severity || "").toLowerCase() === "high").length;
  const authorActionCount = reviewActions.filter((item) => item?.preferred_role === "author").length;
  const escalateToAuthorLane = queue.length >= 4 || highSeverityCount >= 2 || authorActionCount >= 3;
  const mode = escalateToAuthorLane
    ? "paper_orchestra_author_rewrite_escalated"
    : "paper_orchestra_author_rewrite";

  const reasons = [];
  if (queue.length >= 4) reasons.push("rewrite queue exceeded escalation threshold");
  if (highSeverityCount >= 2) reasons.push("multiple high-severity rewrite items remain");
  if (authorActionCount >= 3) reasons.push("document review generated enough author follow-up actions to justify explicit rewrite execution");
  if (reasons.length === 0) reasons.push("rewrite load remained within deterministic loop capacity");

  return {
    mode,
    escalate_to_author_lane: escalateToAuthorLane,
    reasons,
    recommended_max_passes: escalateToAuthorLane ? 4 : 2,
  };
}

module.exports = {
  decideDocumentRewriteEscalation,
};
