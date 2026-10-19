"use strict";

const { verifyCitation } = require("./citation_verifier");
const {
  inferVenueProfile,
  mergeVenueProfiles,
  shapeSectionOutlineForVenue,
} = require("../../policy/venue_profile");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function dedupeStrings(values, limit = Infinity) {
  const seen = new Set();
  const items = [];
  for (const value of asArray(values)) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function lowerJoinedPaper(paper) {
  return [
    paper?.title,
    paper?.abstract,
    paper?.abstract_snippet,
    asArray(paper?.keywords).join(" "),
  ].join(" ").toLowerCase();
}

function rankCitationsByNeedle(citations, needleText, limit = 4) {
  const needle = String(needleText || "").toLowerCase();
  const ranked = citations
    .map((citation) => {
      const blob = lowerJoinedPaper(citation);
      let score = Number(citation?.verification_score || 0) * 10;
      const title = String(citation?.title || "").toLowerCase();
      if (needle && blob.includes(needle)) score += 20;
      if (needle && title.includes(needle)) score += 10;
      return { citation, score };
    })
    .sort((left, right) =>
      right.score - left.score ||
      String(left.citation?.title || "").localeCompare(String(right.citation?.title || "")),
    );
  return ranked.slice(0, limit).map((item) => item.citation);
}

function buildTargetedQueries({
  discoveredQueries = [],
  rolePlan = {},
  themes = [],
  hypotheses = [],
  claims = [],
}) {
  const seeded = [];
  for (const item of asArray(discoveredQueries)) {
    const query = typeof item === "string" ? item : item?.query || item?.text || "";
    if (query) seeded.push(query);
  }
  for (const item of asArray(rolePlan?.search_queries)) {
    seeded.push(item);
  }
  for (const theme of asArray(themes)) {
    seeded.push(`${theme} systematic review`);
  }
  for (const hypothesis of asArray(hypotheses).slice(0, 4)) {
    const exposure = hypothesis?.x_variable || hypothesis?.primary_exposure || "exposure";
    const outcome = hypothesis?.y_variable || hypothesis?.outcome || "outcome";
    seeded.push(`${exposure} ${outcome} confounding mechanisms`);
    seeded.push(`${exposure} ${outcome} heterogeneity low coverage settings`);
  }
  for (const claim of asArray(claims).slice(0, 3)) {
    const statement = String(claim?.statement || claim?.reason || "").trim();
    if (statement) seeded.push(statement);
  }
  return dedupeStrings(seeded, 12);
}

function buildSectionOutline({
  targetedQueries = [],
  citationLedger = [],
  themes = [],
  hypotheses = [],
  claims = [],
  venueProfile = null,
}) {
  const leadHypotheses = asArray(hypotheses).slice(0, 3);
  const leadClaims = asArray(claims).slice(0, 3);
  const sections = [
    {
      section_id: "motivation-gap",
      title: "Research Gap and Motivation",
      objective: "Anchor the study in the current literature gap and explain why the present observational question matters now.",
      target_queries: targetedQueries.slice(0, 3),
      focus_terms: dedupeStrings([
        ...themes,
        ...leadClaims.map((item) => item?.statement),
      ], 5),
    },
    {
      section_id: "mechanism-rivals",
      title: "Mechanisms and Rival Explanations",
      objective: "Contrast the lead explanation against rival mechanisms, confounders, and delivery-system alternatives.",
      target_queries: targetedQueries.slice(3, 6),
      focus_terms: dedupeStrings(leadHypotheses.flatMap((item) => [
        item?.mechanism,
        item?.condition,
        item?.x_variable,
        item?.y_variable,
      ]), 6),
    },
    {
      section_id: "measurement-design",
      title: "Measurement and Design Constraints",
      objective: "Document what the literature says about proxy quality, measurement error, ecological limits, and design constraints.",
      target_queries: targetedQueries.slice(6, 9),
      focus_terms: dedupeStrings([
        "measurement quality",
        "ecological bias",
        "regional heterogeneity",
        ...themes.filter((item) => /region|inequality|quality/i.test(item)),
      ], 6),
    },
    {
      section_id: "evidence-frontier",
      title: "Evidence Frontier and Next Tests",
      objective: "Translate literature into a concrete writing and testing agenda for the next research pass.",
      target_queries: targetedQueries.slice(9, 12),
      focus_terms: dedupeStrings([
        ...leadHypotheses.map((item) => item?.statement),
        ...leadClaims.map((item) => item?.statement),
      ], 6),
    },
    {
      section_id: "novelty-comparison",
      title: "Novelty Relative to Prior Literature",
      objective: "Compare the current claim package against incumbent literature explanations, rivalry structure, and what remains only partially new.",
      target_queries: targetedQueries.slice(0, 2).concat(targetedQueries.slice(9, 10)),
      focus_terms: dedupeStrings([
        "novelty",
        "related work",
        "rival explanations",
        ...themes.slice(0, 2),
        ...leadClaims.map((item) => item?.statement),
      ], 6),
    },
  ];

  return shapeSectionOutlineForVenue({
    sections: sections.map((section) => ({
      ...section,
      citation_ids: rankCitationsByNeedle(
        citationLedger,
        section.focus_terms.join(" "),
        4,
      ).map((item) => item.citation_id),
    })),
    venueProfile,
  }).map((section) => ({
    ...section,
    citation_ids: rankCitationsByNeedle(
      citationLedger,
      section.focus_terms.join(" "),
      4,
    ).map((item) => item.citation_id),
  }));
}

function buildEvidenceMatrix({ citationLedger = [], hypotheses = [], claims = [] }) {
  return asArray(hypotheses).slice(0, 8).map((hypothesis, index) => {
    const needle = [
      hypothesis?.statement,
      hypothesis?.x_variable,
      hypothesis?.y_variable,
      hypothesis?.mechanism,
    ].filter(Boolean).join(" ");
    const citations = rankCitationsByNeedle(citationLedger, needle, 3);
    const matchedClaim = asArray(claims).find((claim) =>
      asArray(claim?.supporting_hypotheses).includes(hypothesis?.hypothesis_id),
    );
    return {
      row_id: `evidence-row-${index + 1}`,
      hypothesis_id: hypothesis?.hypothesis_id || null,
      statement: hypothesis?.statement || null,
      linked_claim: matchedClaim?.statement || null,
      citation_ids: citations.map((item) => item.citation_id),
      citation_titles: citations.map((item) => item.title),
      support_count: Number(hypothesis?.support_count || citations.length),
      unresolved_gaps: asArray(hypothesis?.unresolved_gaps).slice(0, 3),
    };
  });
}

function buildSectionPackets({ outline = [], citationLedger = [], evidenceMatrix = [] }) {
  return asArray(outline).map((section) => {
    const citations = asArray(section.citation_ids)
      .map((citationId) => citationLedger.find((item) => item.citation_id === citationId))
      .filter(Boolean);
    const evidenceRows = evidenceMatrix
      .filter((item) => asArray(item.citation_ids).some((citationId) => section.citation_ids.includes(citationId)))
      .slice(0, 4);
    return {
      section_id: section.section_id,
      title: section.title,
      objective: section.objective,
      target_queries: section.target_queries,
      summary:
        citations.length > 0
          ? `${section.title} should be grounded in ${citations.length} verified or partial citations and tied to ${evidenceRows.length} hypothesis rows from the current cycle.`
          : `${section.title} lacks enough grounded citations and should trigger another literature search pass.`,
      citation_packets: citations.map((item) => ({
        citation_id: item.citation_id,
        title: item.title,
        year: item.year,
        verification_status: item.verification_status,
        abstract_snippet: item.abstract_snippet,
      })),
      evidence_rows: evidenceRows,
      unresolved_gaps: dedupeStrings(
        evidenceRows.flatMap((item) => item.unresolved_gaps || []),
        5,
      ),
    };
  });
}

function buildNoveltyPackets({ sectionPackets = [], claims = [], themes = [] }) {
  const noveltySection = asArray(sectionPackets).find((item) => item?.section_id === "novelty-comparison");
  if (!noveltySection) return [];
  const claimStatements = asArray(claims).map((item) => item?.statement).filter(Boolean).slice(0, 3);
  const rivalThemes = dedupeStrings(asArray(themes).filter((item) => /heterogeneity|inequality|quality|delivery|measurement/i.test(String(item || ""))), 3);
  const incumbentClaims = claimStatements.slice(0, 2);
  const whatIsNewHere = dedupeStrings([
    claimStatements[0] ? `current cycle carries forward: ${claimStatements[0]}` : "",
    rivalThemes[0] ? `explicit rivalry framing: ${rivalThemes[0]}` : "",
    "literature packets now connect claims, citations, and follow-up actions in one writing contract",
  ], 3);
  const partialNovelty = dedupeStrings([
    rivalThemes[1] ? `moderator coverage is still partial around ${rivalThemes[1]}` : "",
    noveltySection.unresolved_gaps?.[0] || "",
  ], 3);
  return [{
    novelty_id: "novelty:related-work",
    section_id: noveltySection.section_id,
    title: noveltySection.title,
    incumbent_claims: incumbentClaims,
    rival_explanations: rivalThemes,
    what_is_new_here: whatIsNewHere,
    what_is_only_partial: partialNovelty,
    next_validation_needed: dedupeStrings(noveltySection.unresolved_gaps || [], 3),
  }];
}

function buildRevisionQueue({ sectionPackets = [], citationLedger = [] }) {
  const revisions = [];
  for (const section of asArray(sectionPackets)) {
    const verifiedCount = asArray(section.citation_packets)
      .filter((item) => item.verification_status === "verified").length;
    if (verifiedCount < 2) {
      revisions.push({
        revision_id: `rev:${section.section_id}:citations`,
        severity: "high",
        section_id: section.section_id,
        issue: "citation grounding is too thin for a writing pass",
        recommended_action: "run another targeted search and keep only verified or stronger partial citations",
      });
    }
    if (asArray(section.unresolved_gaps).length > 0) {
      revisions.push({
        revision_id: `rev:${section.section_id}:gaps`,
        severity: "medium",
        section_id: section.section_id,
        issue: "open gaps are still visible in the literature packet",
        recommended_action: "turn unresolved gaps into explicit follow-up questions in the draft and route them to the next evidence pass",
      });
    }
  }
  if (citationLedger.length < 4) {
    revisions.push({
      revision_id: "rev:global:citation-depth",
      severity: "high",
      section_id: null,
      issue: "overall literature depth is too shallow",
      recommended_action: "expand retrieval breadth before finalizing the literature-grounded manuscript sections",
    });
  }
  return revisions;
}

function mergeSectionOutlineEntry(outlines, citationById, section) {
  const key = section.section_id;
  if (!outlines.has(key)) {
    outlines.set(key, {
      section_id: section.section_id,
      title: section.title,
      objective: section.objective,
      target_queries: [],
      focus_terms: [],
      citation_ids: [],
    });
  }
  const entry = outlines.get(key);
  entry.target_queries = dedupeStrings(entry.target_queries.concat(section.target_queries || []), 6);
  entry.focus_terms = dedupeStrings(entry.focus_terms.concat(section.focus_terms || []), 6);
  entry.citation_ids = dedupeStrings(entry.citation_ids.concat(section.citation_ids || []), 8)
    .filter((citationId) => citationById.has(citationId));
}

function mergeEvidenceMatrixRow(rows, row) {
  const key = row.hypothesis_id || row.statement || `row-${rows.size + 1}`;
  if (!rows.has(key)) {
    rows.set(key, {
      hypothesis_id: row.hypothesis_id || null,
      statement: row.statement || null,
      linked_claim: row.linked_claim || null,
      citation_ids: [],
      citation_titles: [],
      support_count: 0,
      unresolved_gaps: [],
    });
  }
  const entry = rows.get(key);
  entry.citation_ids = dedupeStrings(entry.citation_ids.concat(row.citation_ids || []), 8);
  entry.citation_titles = dedupeStrings(entry.citation_titles.concat(row.citation_titles || []), 8);
  entry.support_count = Math.max(Number(entry.support_count || 0), Number(row.support_count || 0));
  entry.unresolved_gaps = dedupeStrings(entry.unresolved_gaps.concat(row.unresolved_gaps || []), 6);
}

function shapeWritingLoopForStage({
  researchStage = "evidence",
  targetedQueries = [],
  citationLedger = [],
  sectionOutline = [],
  evidenceMatrix = [],
  sectionPackets = [],
  noveltyPackets = [],
  revisionQueue = [],
  paperCount = 0,
  laneCount = null,
  venueProfile = null,
}) {
  const stage = String(researchStage || "").trim().toLowerCase() || "evidence";
  const allowFullPackets = stage !== "evidence";
  const shapedEvidenceMatrix = allowFullPackets ? evidenceMatrix : [];
  const shapedSectionPackets = allowFullPackets ? sectionPackets : [];
  const shapedRevisionQueue = allowFullPackets ? revisionQueue : [];
  const verifiedCitationCount = citationLedger.filter((item) => item.verification_status === "verified").length;

  return {
    mode: "paper_orchestra_inspired",
    targeted_queries: targetedQueries,
    citation_ledger: citationLedger,
    section_outline: sectionOutline,
    evidence_matrix: shapedEvidenceMatrix,
    section_packets: shapedSectionPackets,
    novelty_packets: allowFullPackets ? noveltyPackets : [],
    revision_queue: shapedRevisionQueue,
    venue_profile: venueProfile,
    summary: {
      paper_count: Number(paperCount || 0),
      citation_count: citationLedger.length,
      verified_citation_count: verifiedCitationCount,
      section_count: sectionOutline.length,
      targeted_query_count: targetedQueries.length,
      revision_item_count: shapedRevisionQueue.length,
      ...(laneCount == null ? {} : { lane_count: Number(laneCount || 0) }),
    },
  };
}

function aggregateWritingLoops(lanes = []) {
  const laneLoops = asArray(lanes).map((lane) => lane?.writing_loop).filter(Boolean);
  const citationById = new Map();
  const queries = [];
  const outlines = new Map();
  const evidenceRows = new Map();
  const sections = new Map();
  const revisions = [];
  const aggregateStage = laneLoops.some((loop) => asArray(loop.section_packets).length > 0) ? "document" : "evidence";
  const paperCount = laneLoops.reduce((sum, loop) => sum + Number(loop?.summary?.paper_count || 0), 0);
  const noveltyPackets = [];
  const venueProfile = mergeVenueProfiles(laneLoops.map((loop) => loop?.venue_profile));

  for (const loop of laneLoops) {
    for (const citation of asArray(loop.citation_ledger)) {
      if (!citationById.has(citation.citation_id)) citationById.set(citation.citation_id, citation);
    }
    queries.push(...asArray(loop.targeted_queries));
    for (const section of asArray(loop.section_outline)) {
      mergeSectionOutlineEntry(outlines, citationById, section);
    }
    for (const row of asArray(loop.evidence_matrix)) {
      mergeEvidenceMatrixRow(evidenceRows, row);
    }
    noveltyPackets.push(...asArray(loop.novelty_packets));
    for (const packet of asArray(loop.section_packets)) {
      const key = packet.section_id;
      if (!sections.has(key)) {
        sections.set(key, {
          section_id: packet.section_id,
          title: packet.title,
          objective: packet.objective,
          target_queries: [],
          citation_packets: [],
          evidence_rows: [],
          unresolved_gaps: [],
        });
      }
      const entry = sections.get(key);
      entry.target_queries = dedupeStrings(entry.target_queries.concat(packet.target_queries || []), 6);
      entry.citation_packets = dedupeStrings(
        entry.citation_packets.concat(asArray(packet.citation_packets).map((item) => item.citation_id)),
        8,
      ).map((citationId) => citationById.get(citationId)).filter(Boolean);
      entry.evidence_rows = entry.evidence_rows.concat(asArray(packet.evidence_rows)).slice(0, 6);
      entry.unresolved_gaps = dedupeStrings(entry.unresolved_gaps.concat(packet.unresolved_gaps || []), 6);
      entry.summary =
        entry.citation_packets.length > 0
          ? `${entry.title} aggregates ${entry.citation_packets.length} distinct citations across ${laneLoops.length} literature lanes.`
          : `${entry.title} still needs stronger cross-lane literature support.`;
    }
    revisions.push(...asArray(loop.revision_queue));
  }

  const citationLedger = Array.from(citationById.values())
    .sort((left, right) =>
      Number(right.verification_score || 0) - Number(left.verification_score || 0) ||
      String(left.title || "").localeCompare(String(right.title || "")),
    );
  const targetedQueries = dedupeStrings(queries, 16);
  const sectionOutline = Array.from(outlines.values());
  const evidenceMatrix = Array.from(evidenceRows.values());
  const sectionPackets = Array.from(sections.values());
  return shapeWritingLoopForStage({
    researchStage: aggregateStage,
    targetedQueries,
    citationLedger,
    sectionOutline,
    evidenceMatrix,
    sectionPackets,
    noveltyPackets: noveltyPackets.slice(0, 4),
    revisionQueue: revisions.slice(0, 12),
    paperCount,
    laneCount: laneLoops.length,
    venueProfile,
  });
}

function buildPaperOrchestraLoop({
  papers = [],
  rolePlan = {},
  discoveredQueries = [],
  themes = [],
  hypotheses = [],
  claims = [],
  researchStage = "evidence",
  verifyCitationFn = verifyCitation,
}) {
  const venueProfile = inferVenueProfile({
    papers,
    explicitProfile: rolePlan?.venue_profile || null,
  });
  const citationLedger = asArray(papers).map((paper, index) => verifyCitationFn(paper, index));
  const targetedQueries = buildTargetedQueries({
    discoveredQueries,
    rolePlan,
    themes,
    hypotheses,
    claims,
  });
  const evidenceMatrix = buildEvidenceMatrix({
    citationLedger,
    hypotheses,
    claims,
  });
  const sectionOutline = buildSectionOutline({
    targetedQueries,
    citationLedger,
    themes,
    hypotheses,
    claims,
    venueProfile,
  });
  const sectionPackets = buildSectionPackets({
    outline: sectionOutline,
    citationLedger,
    evidenceMatrix,
  });
  const noveltyPackets = buildNoveltyPackets({
    sectionPackets,
    claims,
    themes,
  });
  const revisionQueue = buildRevisionQueue({
    sectionPackets,
    citationLedger,
  });
  return shapeWritingLoopForStage({
    researchStage,
    targetedQueries,
    citationLedger,
    sectionOutline,
    evidenceMatrix,
    sectionPackets,
    noveltyPackets,
    revisionQueue,
    paperCount: asArray(papers).length,
    venueProfile,
  });
}

module.exports = {
  aggregateWritingLoops,
  buildPaperOrchestraLoop,
};
