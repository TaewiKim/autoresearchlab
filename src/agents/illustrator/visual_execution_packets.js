"use strict";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function scoreRecommendationForSection(section, recommendation) {
  const sectionText = normalizeText([
    section?.section_id,
    section?.title,
    section?.objective,
    section?.summary,
  ].join(" "));
  const recText = normalizeText([
    recommendation?.figure_id,
    recommendation?.title,
    recommendation?.takeaway,
    recommendation?.chart_type,
  ].join(" "));
  let score = 0;
  for (const token of sectionText.split(/\s+/)) {
    if (token.length < 4) continue;
    if (recText.includes(token)) score += 1;
  }
  if (/motivation|gap/.test(sectionText) && /scorecard|summary/.test(recText)) score += 3;
  if (/mechanism|rival/.test(sectionText) && /heterogeneity|bridge|panel/.test(recText)) score += 3;
  if (/measurement|design/.test(sectionText) && /coverage|robustness/.test(recText)) score += 3;
  if (/evidence|frontier|next tests/.test(sectionText) && /coverage|validation/.test(recText)) score += 3;
  return score;
}

function buildVisualExecutionPackets({
  sectionPackets = [],
  evidenceMatrix = [],
  figureRecommendations = [],
  claimBridgeRows = [],
  visualTakeaways = [],
  leadOutcome = null,
  primaryVisualKind = null,
}) {
  const recommendations = asArray(figureRecommendations);
  const sections = asArray(sectionPackets);
  const evidenceRows = asArray(evidenceMatrix);
  const packets = sections.map((section, index) => {
    const matchedRecommendation = recommendations
      .map((item) => ({ item, score: scoreRecommendationForSection(section, item) }))
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item)[0] || recommendations[index] || null;
    const packetEvidence = evidenceRows
      .filter((row) => normalizeText([row?.linked_claim, row?.statement].join(" ")).includes(normalizeText(section?.title || "")) ||
        asArray(section?.citation_packets).some((citation) => asArray(row?.citation_titles).includes(citation?.title)))
      .slice(0, 3);
    const bridgeRows = asArray(claimBridgeRows).slice(0, 4);
    const leadTakeaway = asArray(visualTakeaways).find((item) =>
      item?.kind === matchedRecommendation?.figure_id ||
      item?.kind === primaryVisualKind,
    );
    return {
      execution_id: `visual-exec-${index + 1}`,
      section_id: section?.section_id || null,
      section_title: section?.title || null,
      figure_id: matchedRecommendation?.figure_id || `figure-${index + 1}`,
      figure_title: matchedRecommendation?.title || section?.title || null,
      chart_type: matchedRecommendation?.chart_type || "evidence summary chart",
      priority: matchedRecommendation?.priority || (index === 0 ? "highest" : "high"),
      execution_goal: section?.objective || matchedRecommendation?.takeaway || null,
      paired_takeaway: matchedRecommendation?.takeaway || leadTakeaway?.takeaway || null,
      lead_outcome: leadOutcome,
      citation_titles: asArray(section?.citation_packets).map((item) => item?.title).filter(Boolean).slice(0, 4),
      evidence_rows: packetEvidence,
      claim_bridge_rows: bridgeRows,
      unresolved_gaps: asArray(section?.unresolved_gaps).slice(0, 3),
    };
  });

  if (packets.length === 0 && recommendations.length > 0) {
    return recommendations.slice(0, 4).map((item, index) => ({
      execution_id: `visual-exec-${index + 1}`,
      section_id: null,
      section_title: null,
      figure_id: item?.figure_id || `figure-${index + 1}`,
      figure_title: item?.title || null,
      chart_type: item?.chart_type || "evidence summary chart",
      priority: item?.priority || (index === 0 ? "highest" : "high"),
      execution_goal: item?.takeaway || null,
      paired_takeaway: item?.takeaway || null,
      lead_outcome: leadOutcome,
      citation_titles: [],
      evidence_rows: evidenceRows.slice(0, 3),
      claim_bridge_rows: asArray(claimBridgeRows).slice(0, 4),
      unresolved_gaps: [],
    }));
  }

  return packets.slice(0, 5);
}

module.exports = {
  buildVisualExecutionPackets,
};
