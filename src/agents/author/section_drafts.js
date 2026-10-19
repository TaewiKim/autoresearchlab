"use strict";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildExperimentalAuthorDraftSections({
  writingLoop = {},
  revisionQueue = [],
  venueProfile = null,
} = {}) {
  const packets = asArray(writingLoop.section_packets);
  const revisions = asArray(revisionQueue);
  const emphasis = asArray(venueProfile?.drafting_emphasis).slice(0, 3);

  return packets.map((packet, index) => {
    const matchingRevisions = revisions.filter((item) => item?.section_id === packet?.section_id).slice(0, 3);
    const citationTitles = asArray(packet?.citation_packets).slice(0, 3).map((item) => item?.title).filter(Boolean);
    const openingParts = [
      packet?.objective ? `${packet.objective}.` : "",
      packet?.summary || "",
      emphasis.length > 0 ? `Venue emphasis: ${emphasis.join("; ")}.` : "",
    ].filter(Boolean);

    return {
      draft_id: `author-draft-${index + 1}`,
      section_id: packet?.section_id || null,
      title: packet?.title || null,
      opening: openingParts.join(" "),
      evidence_anchor: citationTitles.length > 0 ? `Ground with ${citationTitles.join("; ")}.` : "Ground with the strongest available citations.",
      revision_focus: matchingRevisions.map((item) => item?.recommended_action || item?.issue).filter(Boolean),
      unresolved_gaps: asArray(packet?.unresolved_gaps).slice(0, 3),
    };
  });
}

module.exports = {
  buildExperimentalAuthorDraftSections,
};
