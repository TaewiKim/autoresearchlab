"use strict";

const { buildExperimentalAuthorDraftSections } = require("./section_drafts");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function trimSectionPacket(packet) {
  return {
    section_id: packet?.section_id || null,
    title: packet?.title || null,
    objective: packet?.objective || null,
    summary: packet?.summary || null,
    target_queries: asArray(packet?.target_queries).slice(0, 3),
    unresolved_gaps: asArray(packet?.unresolved_gaps).slice(0, 3),
    citation_packets: asArray(packet?.citation_packets).slice(0, 4).map((item) => ({
      citation_id: item?.citation_id || null,
      title: item?.title || null,
      year: item?.year || null,
      verification_status: item?.verification_status || null,
    })),
  };
}

function compactReviewComment(item) {
  return {
    comment_id: item?.comment_id || null,
    section: item?.section || null,
    rubric_item: item?.rubric_item || null,
    severity: item?.severity || null,
    score: item?.score == null ? null : Number(item.score),
    summary: item?.summary || null,
    concerns: asArray(item?.concerns).slice(0, 4),
    required_revisions: asArray(item?.required_revisions).slice(0, 4),
    suggested_revisions: asArray(item?.suggested_revisions).slice(0, 4),
    suggested_additional_analysis: asArray(item?.suggested_additional_analysis).slice(0, 4),
  };
}

function collectReviewComments(cyclePlanningContext) {
  const reportComments = asArray(
    cyclePlanningContext?.report_review?.report_review_comments ||
      cyclePlanningContext?.report_review?.section_review_comments,
  ).map(compactReviewComment);
  const paperComments = asArray(
    cyclePlanningContext?.paper_review?.paper_review_comments ||
      cyclePlanningContext?.paper_review?.section_review_comments,
  ).map(compactReviewComment);
  return {
    report_comments: reportComments,
    paper_comments: paperComments,
    author_paper_comments: paperComments.filter((item) => item.section !== "figures_tables" && item.rubric_item !== "tables_figures_submission_discipline"),
    all_comments: reportComments.concat(paperComments),
  };
}

function compactAnalysisRequest(item) {
  return {
    request_id: item?.request_id || null,
    priority: item?.priority || null,
    required_for_gate: item?.required_for_gate === true,
    allowed_author_execution: item?.allowed_author_execution !== false,
    analysis_type: item?.analysis_type || null,
    objective: item?.objective || null,
    trigger_comment_ids: asArray(item?.trigger_comment_ids).slice(0, 6),
    required_inputs: asArray(item?.required_inputs).slice(0, 6),
    expected_artifacts: asArray(item?.expected_artifacts).slice(0, 6),
    acceptance_criteria: asArray(item?.acceptance_criteria).slice(0, 6),
  };
}

function collectAuthorAnalysisRequests(cyclePlanningContext) {
  return asArray(cyclePlanningContext?.paper_review?.analysis_requests)
    .filter((item) => !item?.preferred_role || item.preferred_role === "author")
    .filter((item) => item?.allowed_author_execution !== false)
    .map(compactAnalysisRequest);
}

function compactReferenceRequest(item) {
  return {
    request_id: item?.request_id || null,
    priority: item?.priority || null,
    required_for_gate: item?.required_for_gate === true,
    objective: item?.objective || null,
    trigger_comment_ids: asArray(item?.trigger_comment_ids).slice(0, 6),
    required_inputs: asArray(item?.required_inputs).slice(0, 6),
    expected_artifacts: asArray(item?.expected_artifacts).slice(0, 6),
    acceptance_criteria: asArray(item?.acceptance_criteria).slice(0, 6),
    quality_blockers: asArray(item?.quality_blockers).slice(0, 6),
  };
}

function collectAuthorReferenceRequests(cyclePlanningContext) {
  return asArray(cyclePlanningContext?.paper_review?.reference_requests)
    .filter((item) => !item?.preferred_role || item.preferred_role === "author")
    .map(compactReferenceRequest);
}

function authorRevisionItems(cyclePlanningContext) {
  const writingLoop = cyclePlanningContext?.literature_summary?.writing_loop || {};
  const reportActions = asArray(cyclePlanningContext?.report_review?.recommended_followup_actions);
  const paperActions = asArray(cyclePlanningContext?.paper_review?.recommended_followup_actions);
  const collectedComments = collectReviewComments(cyclePlanningContext);
  const reviewComments = collectedComments.report_comments.concat(collectedComments.author_paper_comments);
  const analysisRequests = collectAuthorAnalysisRequests(cyclePlanningContext);
  const referenceRequests = collectAuthorReferenceRequests(cyclePlanningContext);
  const revisionQueue = asArray(writingLoop.revision_queue)
    .filter((item) => !item?.preferred_role || item.preferred_role === "author")
    .slice(0, 5)
    .map((item) => ({
      revision_id: item?.revision_id || null,
      severity: item?.severity || null,
      section_id: item?.section_id || null,
      issue: item?.issue || null,
      recommended_action: item?.recommended_action || null,
    }));
  const reviewDrivenActions = reportActions
    .concat(paperActions)
    .filter((item) => item?.preferred_role === "author")
    .slice(0, 6)
    .map((item, index) => ({
      revision_id: item?.type || `author-followup-${index + 1}`,
      severity: item?.priority || null,
      section_id: item?.target_document || null,
      issue: asArray(item?.blocker_reasons).join("; ") || null,
      recommended_action: item?.description || null,
    }));
  const commentDrivenItems = reviewComments
    .filter((item) => asArray(item.required_revisions).length || asArray(item.concerns).length)
    .slice(0, 5)
    .map((item) => ({
      revision_id: item.comment_id || "paper-review-comment",
      revision_type: "review_comment_response",
      severity: item.severity || null,
      section_id: item.section || null,
      issue: asArray(item.concerns).join("; ") || item.summary || null,
      recommended_action: asArray(item.required_revisions).join("; ") || asArray(item.suggested_revisions).join("; ") || null,
      source_comment_id: item.comment_id || null,
    }));
  const analysisDrivenItems = analysisRequests
    .slice(0, 5)
    .map((item) => ({
      revision_id: item.request_id || "author-analysis-request",
      revision_type: "additional_analysis",
      severity: item.priority || null,
      section_id: "paper",
      issue: item.objective || null,
      recommended_action: `execute or update analysis artifacts: ${asArray(item.expected_artifacts).join(", ")}`,
      source_comment_ids: asArray(item.trigger_comment_ids),
      expected_artifacts: asArray(item.expected_artifacts),
    }));
  const referenceDrivenItems = referenceRequests
    .slice(0, 4)
    .map((item) => ({
      revision_id: item.request_id || "author-reference-request",
      revision_type: "reference_verification",
      severity: item.priority || null,
      section_id: "references",
      issue: asArray(item.quality_blockers).join("; ") || item.objective || null,
      recommended_action: `verify and refresh high-impact references: ${asArray(item.expected_artifacts).join(", ")}`,
      source_comment_ids: asArray(item.trigger_comment_ids),
      expected_artifacts: asArray(item.expected_artifacts),
    }));
  return revisionQueue
    .concat(reviewDrivenActions)
    .concat(commentDrivenItems)
    .concat(analysisDrivenItems)
    .concat(referenceDrivenItems)
    .slice(0, 14);
}

function buildAuthorRevisionPlan({ prompt, laneId, cycleId = null, cyclePlanningContext = null }) {
  const writingLoop = cyclePlanningContext?.literature_summary?.writing_loop || {};
  const venueProfile = writingLoop.venue_profile || null;
  const sectionPackets = asArray(writingLoop.section_packets).map(trimSectionPacket);
  const sectionOutline = asArray(writingLoop.section_outline).map((item) => ({
    section_id: item?.section_id || null,
    title: item?.title || null,
    objective: item?.objective || null,
    target_queries: asArray(item?.target_queries).slice(0, 3),
  }));
  const revisionQueue = authorRevisionItems(cyclePlanningContext);
  const reviewComments = collectReviewComments(cyclePlanningContext);
  const analysisRequests = collectAuthorAnalysisRequests(cyclePlanningContext);
  const referenceRequests = collectAuthorReferenceRequests(cyclePlanningContext);
  const experimentalDraftSections = buildExperimentalAuthorDraftSections({
    writingLoop,
    revisionQueue,
    venueProfile,
  });
  return {
    lane_id: laneId,
    role: "author",
    source: "lab-director",
    prompt,
    deliverables: [
      "approval-ready narrative",
      "explicit claim-evidence chain",
      "researcher-readable summary",
      "review-comment response map",
      "review-driven additional analysis artifacts when requested",
      "verified high-impact reference refresh when requested",
      "LaTeX figure integration that uses PPT-derived PNG/JPEG/PDF-compatible exports",
    ],
    revision_goals: [
      "compress findings around the user prompt",
      "remove low-signal detail",
      "surface novelty, impact, and decision relevance first",
      "keep manuscript figure insertions synchronized with the figure-deck manifest and LaTeX-compatible image exports",
    ],
    literature_positioning_summary: {
      mode: writingLoop.mode || null,
      verified_citation_count: Number(writingLoop?.summary?.verified_citation_count || 0),
      section_count: Number(writingLoop?.summary?.section_count || sectionPackets.length || 0),
      revision_item_count: Number(writingLoop?.summary?.revision_item_count || revisionQueue.length || 0),
    },
    paper_review_comments: reviewComments.author_paper_comments,
    report_review_comments: reviewComments.report_comments,
    author_gate: cyclePlanningContext?.paper_review?.author_gate || null,
    paper_integration_gate: cyclePlanningContext?.paper_review?.paper_integration_gate || null,
    analysis_requests: analysisRequests,
    reference_requests: referenceRequests,
    additional_analysis_policy: {
      enabled: true,
      executor_role: "author",
      trigger: "papergate/reportgate review comments and analysis_requests",
      output_root_hint: `.research-lab/artifacts/stats/${cycleId || "<cycle-id>"}/${laneId}`,
      allowed_tasks: [
        "recompute small source-table summaries needed to answer a review comment",
        "refresh manuscript-linked supplementary CSV/JSON/Markdown artifacts",
        "write an author response explaining infeasible analyses and missing inputs",
      ],
      constraints: [
        "do not invent source data or validation outcomes",
        "do not add a new biological claim without a generated evidence artifact",
        "cite review comment IDs and output artifact paths in the revision summary",
      ],
    },
    reference_verification_policy: {
      enabled: true,
      executor_role: "author",
      trigger: "papergate reference_requests",
      required_outputs: [
        "reference_verification_table.csv",
        "high_impact_reference_refresh.md",
        "updated_document_reference_context.json",
      ],
      // A fixed list of journal names is only ever right for the domain that
      // wrote it. These were biomedical venues reaching a computer-graphics
      // cycle; the venue standard the cycle records from evidence already knows
      // what this field's leading venues are.
      venue_priority: [
        "the venues the recorded venue standard identifies as leading for THIS field, read from what the cycle recorded about the target venue",
        "venues at or above the target venue's recorded selectivity",
        "field-leading specialty venues when directly relevant",
      ],
      constraints: [
        "do not cite unverifiable metadata-only references as authoritative support",
        "prefer a resolvable persistent identifier (a DOI, or the registry identifier this field uses); otherwise use the landing-page URL the record was actually retrieved from, and say which source returned it",
        "separate primary dataset citation from contextual high-impact articles",
      ],
    },
    manuscript_figure_integration_policy: {
      enabled: true,
      executor_role: "author",
      collaborator_role: "illustrator",
      source_of_truth: "figure_deck_manifest.json",
      constraints: [
        "insert manuscript figure_panels from manifest paper_image_png_path values only",
        "never place raw .svg paths in LaTeX includegraphics or paper figure_panels",
        "render captions through LaTeX from manifest caption text; do not rely on captions embedded inside figure images",
        "block the manuscript handoff and request an illustrator follow-up when paper_image_png_path is missing, unreadable, or not synchronized with the manifest",
        "block the manuscript handoff and request an illustrator follow-up when rendered_image_quality or text_box_quality is missing or failing",
        "do not hand-patch final .tex or .json artifacts to hide missing figures; update the figure deck request, manifest source, or builder inputs and regenerate",
        "keep figure_id, caption, source_tables, and detailed_explanation synchronized with the manifest",
      ],
      gate_checks: [
        "latex_compatible_figure_exports",
        "ppt_export_image_match",
        "rendered_image_quality",
        "latex_caption_ownership",
        "panel_manifest_id_match",
        "figure_explanation_and_provenance",
      ],
    },
    venue_profile: venueProfile,
    section_outline: sectionOutline,
    section_packets: sectionPackets,
    revision_queue: revisionQueue,
    author_draft_sections_experiment: experimentalDraftSections,
    rubric_priority: [
      "clarity",
      "impact",
      "strobe_reporting_completeness",
    ],
  };
}

module.exports = {
  buildAuthorRevisionPlan,
};
