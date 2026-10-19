"use strict";

const { buildExperimentalAuthorDraftSections } = require("../agents/author/section_drafts");
const { decideDocumentRewriteEscalation } = require("../policy/document_rewrite_escalation_policy");

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

function mergeTopPapers(reportJson, literature) {
  const ledger = asArray(literature?.writing_loop?.citation_ledger);
  const existing = asArray(reportJson?.top_papers);
  const merged = [];
  const seen = new Set();

  for (const item of ledger) {
    if (item?.verification_status === "weak") continue;
    const title = String(item?.title || "").trim();
    const key = String(item?.doi || title).toLowerCase();
    if (!title || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      title,
      year: item?.year || null,
      doi: item?.doi || null,
      abstract_snippet: item?.abstract_snippet || null,
      verification_status: item?.verification_status || null,
      verification_method: item?.verification_method || null,
    });
  }
  for (const item of existing) {
    const title = String(item?.title || "").trim();
    const key = String(item?.doi || title).toLowerCase();
    if (!title || !key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.slice(0, 12);
}

function buildSectionGapNarrative(sectionPackets) {
  const gaps = dedupeStrings(sectionPackets.flatMap((packet) => packet?.unresolved_gaps || []), 6);
  if (gaps.length === 0) return null;
  return `Open literature gaps still affecting interpretation: ${gaps.join("; ")}.`;
}

function buildAuthorRewriteQueue({ literature, reportActions, paperActions }) {
  const writingLoop = literature?.writing_loop || {};
  const literatureQueue = asArray(writingLoop.revision_queue)
    .filter((item) => !item?.preferred_role || item.preferred_role === "author")
    .map((item) => ({
      source: "literature",
      revision_id: item?.revision_id || null,
      severity: item?.severity || null,
      section_id: item?.section_id || null,
      issue: item?.issue || null,
      recommended_action: item?.recommended_action || null,
      target_document: "paper",
    }));
  const documentQueue = asArray(reportActions)
    .concat(asArray(paperActions))
    .filter((item) => item?.preferred_role === "author")
    .map((item) => ({
      source: "document_review",
      revision_id: item?.type || null,
      severity: item?.priority || null,
      section_id: item?.target_rubric || null,
      issue: asArray(item?.blocker_reasons).join("; ") || null,
      recommended_action: item?.description || null,
      target_document: item?.target_document || null,
    }));
  return literatureQueue.concat(documentQueue).slice(0, 12);
}

function applySingleRewrite({ reportJson, rewriteItem, literature }) {
  const updated = {
    ...reportJson,
    literature_positioning: {
      ...(reportJson?.literature_positioning || {}),
    },
    revision_summary: {
      ...(reportJson?.revision_summary || {}),
    },
  };
  const sectionPackets = asArray(literature?.writing_loop?.section_packets);
  const gapNarrative = buildSectionGapNarrative(sectionPackets);
  const action = String(rewriteItem?.revision_id || "");
  const description = String(rewriteItem?.recommended_action || "").trim();

  if (/report_importance_followup/.test(action)) {
    const current = String(updated.executive_summary || "").trim();
    if (!/^Why now:/i.test(current)) {
      updated.executive_summary = `Why now: population-health interpretation and next-cycle approval decisions depend on whether the adjusted signal remains stable. ${current}`.trim();
    }
  } else if (/report_decision_followup/.test(action)) {
    const current = String(updated.executive_summary || "").trim();
    if (!/^Decision:/i.test(current)) {
      updated.executive_summary = `Decision: carry forward only the adjusted, traceable claims and defer weaker narrative branches. ${current}`.trim();
    }
  } else if (/paper_structure_followup|paper_submission_followup/.test(action)) {
    updated.revision_summary.submission_note =
      "Manuscript rewrite loop applied: section flow, abstract framing, and authoring discipline were normalized against the current review rubric.";
  } else if (/rev:.*:citations|paper_citation_followup/.test(action)) {
    updated.top_papers = mergeTopPapers(updated, literature);
    updated.literature_positioning.summary = {
      ...(updated.literature_positioning?.summary || {}),
      citation_count: updated.top_papers.length,
      rewrite_citation_refresh: true,
    };
  } else if (/rev:.*:gaps|paper_rigor_followup/.test(action)) {
    if (gapNarrative && !String(updated.other_analyses || "").includes(gapNarrative)) {
      updated.other_analyses = [updated.other_analyses, gapNarrative].filter(Boolean).join(" ");
    }
    if (gapNarrative && !String(updated.limitations || "").includes(gapNarrative)) {
      updated.limitations = [updated.limitations, gapNarrative].filter(Boolean).join(" ");
    }
  } else if (description) {
    updated.recommended_next_moves = dedupeStrings(
      asArray(updated.recommended_next_moves).map((item) => item?.description || item).concat(description),
      6,
    ).map((item) => ({ description: item }));
  }

  const appliedNote = description || rewriteItem?.issue || rewriteItem?.revision_id || "rewrite";
  updated.revision_summary.applied_rewrites = asArray(updated.revision_summary.applied_rewrites).concat({
    revision_id: rewriteItem?.revision_id || null,
    source: rewriteItem?.source || null,
    target_document: rewriteItem?.target_document || null,
    note: appliedNote,
  });
  return updated;
}

function runDocumentRewriteLoop({ cycleId, reportJson, literature, reportActions, paperActions, maxPasses = 2 }) {
  const rewriteQueue = buildAuthorRewriteQueue({
    literature,
    reportActions,
    paperActions,
  });
  const venueProfile = literature?.writing_loop?.venue_profile || null;
  const escalation = decideDocumentRewriteEscalation({
    rewriteQueue,
    reportActions,
    paperActions,
  });
  const authorDraftSections = buildExperimentalAuthorDraftSections({
    writingLoop: literature?.writing_loop || {},
    revisionQueue: rewriteQueue,
    venueProfile,
  });
  let current = {
    ...reportJson,
    top_papers: mergeTopPapers(reportJson, literature),
    venue_profile: reportJson?.venue_profile || venueProfile,
    author_draft_sections_experiment: authorDraftSections,
  };
  const passes = [];
  if (rewriteQueue.length === 0) {
    return {
      cycle_id: cycleId,
      mode: escalation.mode,
      applied_count: 0,
      rewrite_queue: [],
      escalation,
      author_rewrite_lane_execution: {
        executed: escalation.escalate_to_author_lane,
        draft_sections: authorDraftSections,
      },
      passes,
      report_json: current,
    };
  }

  if (escalation.escalate_to_author_lane && authorDraftSections.length > 0) {
    current.draft_sections = authorDraftSections.map((item) => ({
      section_id: item.section_id,
      title: item.title,
      objective: null,
      narrative: `${item.opening} ${item.evidence_anchor}`.trim(),
      linked_claims: [],
      citations: [],
      unresolved_gaps: asArray(item.unresolved_gaps),
      author_experiment: true,
    }));
    current.revision_summary = {
      ...(current.revision_summary || {}),
      author_rewrite_lane_executed: true,
    };
  }

  for (let passIndex = 0; passIndex < Math.min(escalation.recommended_max_passes || maxPasses, rewriteQueue.length); passIndex += 1) {
    const items = rewriteQueue.slice(passIndex * 3, passIndex * 3 + 3);
    if (items.length === 0) break;
    const beforeSummary = String(current.executive_summary || "");
    for (const item of items) {
      current = applySingleRewrite({
        reportJson: current,
        rewriteItem: item,
        literature,
      });
    }
    passes.push({
      pass_id: `rewrite-pass-${passIndex + 1}`,
      applied_revision_ids: items.map((item) => item.revision_id).filter(Boolean),
      executive_summary_changed: beforeSummary !== String(current.executive_summary || ""),
      applied_count: items.length,
    });
  }

  current.document_rewrite_loop = {
    mode: escalation.mode,
    applied_count: passes.reduce((sum, pass) => sum + Number(pass.applied_count || 0), 0),
    pass_count: passes.length,
    queue_size: rewriteQueue.length,
    latest_pass_id: passes[passes.length - 1]?.pass_id || null,
    escalation,
  };

  return {
    cycle_id: cycleId,
    mode: escalation.mode,
    applied_count: current.document_rewrite_loop.applied_count,
    rewrite_queue: rewriteQueue,
    escalation,
    author_rewrite_lane_execution: {
      executed: escalation.escalate_to_author_lane,
      draft_sections: authorDraftSections,
    },
    passes,
    report_json: current,
  };
}

module.exports = {
  runDocumentRewriteLoop,
};
