"use strict";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function scorePacket(packet) {
  let score = 0;
  if (packet?.figure_id) score += 2;
  if (packet?.figure_title || packet?.title) score += 2;
  if (packet?.priority) score += 1;
  if (packet?.paired_takeaway || packet?.takeaway) score += 2;
  if (packet?.chart_type || packet?.recommended_chart_type) score += 1;
  if (asArray(packet?.evidence_links).length > 0) score += 2;
  return score;
}

function scorePlan(packets = [], figureRecommendations = []) {
  const normalizedPackets = asArray(packets);
  const recommendationIds = new Set(asArray(figureRecommendations).map((item) => String(item?.figure_id || "")));
  let score = normalizedPackets.reduce((sum, packet) => sum + scorePacket(packet), 0);
  for (const packet of normalizedPackets) {
    if (recommendationIds.has(String(packet?.figure_id || ""))) score += 2;
  }
  return score;
}

function evaluateVisualExecutionPlan({
  authoredPackets = [],
  fallbackPackets = [],
  figureRecommendations = [],
} = {}) {
  const authored = asArray(authoredPackets);
  const fallback = asArray(fallbackPackets);
  const authoredScore = scorePlan(authored, figureRecommendations);
  const fallbackScore = scorePlan(fallback, figureRecommendations);
  const useAuthored = authored.length > 0 && authoredScore >= Math.max(6, fallbackScore - 1);
  const preferredPackets = useAuthored ? authored : fallback;
  const preferredMode = useAuthored
    ? "illustrator_authored_execution_packets"
    : "deterministic_baseline_plus_illustrator_refinement";

  const reasons = [];
  if (useAuthored) {
    reasons.push("illustrator-provided packets passed minimum visual QA");
    if (authoredScore > fallbackScore) reasons.push("illustrator packets scored above deterministic fallback");
  } else if (authored.length > 0) {
    reasons.push("illustrator packets failed minimum visual QA, so deterministic fallback was retained");
  } else {
    reasons.push("no illustrator packets were available");
  }

  return {
    preferred_mode: preferredMode,
    preferred_packets: preferredPackets.slice(0, 5),
    authored_score: authoredScore,
    fallback_score: fallbackScore,
    qa_passed: useAuthored || authored.length === 0,
    reasons,
  };
}

module.exports = {
  evaluateVisualExecutionPlan,
};
