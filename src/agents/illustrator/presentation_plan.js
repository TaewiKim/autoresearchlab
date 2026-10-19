"use strict";

const { buildVisualExecutionPackets } = require("./visual_execution_packets");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function buildVisualRefinementBrief({ visualExecutionPackets = [], visualFollowups = [], researcherView = {} }) {
  if (researcherView?.visual_refinement_brief && typeof researcherView.visual_refinement_brief === "object") {
    return researcherView.visual_refinement_brief;
  }
  const primaryVisualKind = researcherView?.primary_visual_kind || null;
  const leadOutcomeLabel = researcherView?.lead_outcome_label || null;
  const focusPackets = asArray(visualExecutionPackets).slice(0, 3).map((item) => ({
    execution_id: item?.execution_id || null,
    figure_id: item?.figure_id || null,
    figure_title: item?.figure_title || null,
    priority: item?.priority || null,
    paired_takeaway: item?.paired_takeaway || null,
  }));
  const followups = asArray(visualFollowups).slice(0, 4).map((item) => ({
    revision_id: item?.revision_id || null,
    severity: item?.severity || null,
    issue: item?.issue || null,
    recommended_action: item?.recommended_action || null,
  }));
  return {
    mode: "deterministic_baseline_plus_illustrator_refinement",
    primary_visual_kind: primaryVisualKind,
    lead_outcome_label: leadOutcomeLabel,
    focus_packets: focusPackets,
    refinement_tasks: followups,
    figure_production_policy: {
      // Owner decision: figures are not authored through a PowerPoint deck. What
      // has to survive is the ability to rebuild any figure from the committed
      // data, so the generator script is the deliverable that matters and the
      // image is its output.
      authoring: "Draw each figure from its committed source artifact with a generator script this lane writes and leaves on disk.",
      generator_policy: "The generator must run again unattended and reproduce the same image from the same artifact: no hand-edited images, no values typed into the script, no path that only exists in this run.",
      image_format: "Emit PNG or PDF sized for the manuscript column, and record the emitted path beside the generator that produced it.",
      caption_policy: "Captions and key-message prose belong in the manuscript text, not baked into the image.",
      visual_qa_policy: "Before reporting coverage, measure the rendered figure: no text overlapping other text or data marks, nothing clipped at the axes or figure edge, and every label legible at print size.",
      regeneration_policy: "Do not hand-patch an emitted image to hide a figure problem; fix the generator and re-emit.",
    },
    refinement_goal:
      "start from the baseline execution packets, preserve claim-evidence traceability, and improve ordering, takeaway clarity, and chart choice where the current packets are weak",
  };
}

function buildVisualPackets(cyclePlanningContext) {
  const writingLoop = cyclePlanningContext?.literature_summary?.writing_loop || {};
  const researcherView = cyclePlanningContext?.researcher_view || {};
  const visualQa = researcherView?.visual_qa && typeof researcherView.visual_qa === "object"
    ? researcherView.visual_qa
    : null;
  const evidenceMatrix = asArray(writingLoop.evidence_matrix);
  const reportActions = asArray(cyclePlanningContext?.report_review?.recommended_followup_actions)
    .filter((item) => item?.preferred_role === "illustrator");
  const paperActions = asArray(cyclePlanningContext?.paper_review?.recommended_followup_actions)
    .filter((item) => item?.preferred_role === "illustrator");
  const figureGateActions = asArray(cyclePlanningContext?.paper_review?.figure_gate?.recommended_followup_actions)
    .filter((item) => item?.preferred_role === "illustrator");
  const figureProductionRequests = asArray(cyclePlanningContext?.paper_review?.figure_production_requests)
    .filter((item) => !item?.preferred_role || item.preferred_role === "illustrator");
  const sections = asArray(writingLoop.section_packets).slice(0, 4).map((item) => ({
    section_id: item?.section_id || null,
    title: item?.title || null,
    summary: item?.summary || null,
    unresolved_gaps: asArray(item?.unresolved_gaps).slice(0, 3),
    lead_citations: asArray(item?.citation_packets).slice(0, 3).map((citation) => ({
      title: citation?.title || null,
      year: citation?.year || null,
      verification_status: citation?.verification_status || null,
    })),
  }));
  const evidenceRows = evidenceMatrix.slice(0, 5).map((item) => ({
    hypothesis_id: item?.hypothesis_id || null,
    statement: item?.statement || null,
    linked_claim: item?.linked_claim || null,
    support_count: Number(item?.support_count || 0),
    citation_titles: asArray(item?.citation_titles).slice(0, 3),
  }));
  const visualFollowups = reportActions.concat(paperActions, figureGateActions).slice(0, 4).map((item, index) => ({
    revision_id: item?.type || `illustrator-followup-${index + 1}`,
    severity: item?.priority || null,
    issue: asArray(item?.blocker_reasons).join("; ") || null,
    recommended_action: item?.description || null,
    figure_production_request: item?.figure_production_request || null,
  }));
  const visualExecutionPackets = asArray(researcherView?.visual_execution_packets).length > 0
    ? asArray(researcherView.visual_execution_packets).slice(0, 5)
    : buildVisualExecutionPackets({
        sectionPackets: writingLoop.section_packets,
        evidenceMatrix,
        figureRecommendations: researcherView.figure_recommendations,
        claimBridgeRows: researcherView.claim_bridge_rows,
        visualTakeaways: researcherView.visual_takeaways,
        leadOutcome: researcherView.lead_outcome,
        primaryVisualKind: researcherView.primary_visual_kind,
      });
  const refinementBrief = buildVisualRefinementBrief({
    visualExecutionPackets,
    visualFollowups,
    researcherView,
  });
  return {
    sections,
    evidence_rows: evidenceRows,
    visual_followups: visualFollowups,
    figure_production_requests: figureProductionRequests,
    visual_execution_packets: visualExecutionPackets,
    visual_refinement_brief: refinementBrief,
    visual_qa: visualQa,
    summary: {
      mode: writingLoop.mode || null,
      verified_citation_count: Number(writingLoop?.summary?.verified_citation_count || 0),
      section_count: Number(writingLoop?.summary?.section_count || sections.length || 0),
    },
  };
}

function buildIllustratorPresentationPlan({ prompt, laneId, cyclePlanningContext = null }) {
  const visualPackets = buildVisualPackets(cyclePlanningContext);
  return {
    lane_id: laneId,
    role: "illustrator",
    source: "lab-director",
    prompt,
    presentation_goals: [
      "make the main result understandable in under one minute",
      "surface the strongest graph or visual first",
      "avoid charts that do not change researcher decisions",
      "turn the current evidence into approval-ready visuals with explicit takeaways",
    ],
    outputs: [
      "researcher-facing HTML view",
      "figure generator script, left on disk and rerunnable from the committed data",
      "emitted manuscript figures in PNG or PDF, each named beside its generator and source artifact",
      "rendered-figure QA: text overlap, clipping, and legibility measured on the emitted image",
      "figure recommendations",
      "visual improvement notes",
      "chart priority list",
      "one-sentence takeaway per visual",
    ],
    visual_checks: [
      "show at least one primary outcome chart",
      "show one robustness or heterogeneity chart",
      "make the strongest claim legible without reading raw tables",
      "keep captions and key-message prose in the manuscript text rather than baked into the figure image",
      "verify no text overlaps other text or a data mark, nothing is clipped at the axes or figure edge, and no label is below 8 pt",
      "verify every emitted figure path exists before handing work back to the author",
      "name, for each figure, the generator that drew it and the committed artifact it read",
      "repair figure failures by fixing the generator and re-emitting, not by patching the emitted image",
    ],
    figure_production_policy: {
      // Owner decision: figures are not authored through a PowerPoint deck. What
      // must survive the run is the ability to rebuild any figure from committed
      // data, so the generator is the deliverable and the image is its output.
      authoring: "Draw each figure from its committed source artifact with a generator script this lane writes and leaves on disk.",
      generator_policy: "The generator must run again unattended and reproduce the same image from the same artifact: no hand-edited images, no values typed into the script, no path that only exists in this run.",
      image_format: "Emit PNG or PDF sized for the manuscript column, and record the emitted path beside the generator that produced it.",
      caption_policy: "Captions and key-message prose belong in the manuscript text, not baked into the image.",
      visual_qa_policy: "Measure the rendered figure before reporting coverage: no text overlapping other text or data marks, nothing clipped at the axes or figure edge, and no label below 8 pt.",
      regeneration_policy: "Do not hand-patch an emitted image to hide a figure problem; fix the generator and re-emit.",
    },
    interpretation_schema: {
      required_signals: ["summary"],
      optional_signals: [
        "figure_recommendations",
        "visual_priority_list",
        "takeaways",
        "visual_improvement_notes",
      ],
      preferred_json_keys: [
        "summary",
        "figure_recommendations",
        "takeaways",
      ],
      raw_text_cues: [
        "strongest graph",
        "one-minute understanding",
        "takeaway",
        "visual priority",
        "chart recommendation",
      ],
      fallback_interpretation_rules: [
        "If no JSON is present, summarize the raw output into a visual guidance brief.",
        "Prefer decision-relevant visuals over exhaustive chart coverage.",
        "If output is noisy, preserve the strongest visual recommendation and one-sentence takeaway first.",
      ],
    },
    section_packets: visualPackets.sections,
    evidence_matrix_rows: visualPackets.evidence_rows,
    visual_revision_queue: visualPackets.visual_followups,
    figure_production_requests: visualPackets.figure_production_requests,
    figure_gate: cyclePlanningContext?.paper_review?.figure_gate || null,
    paper_integration_gate: cyclePlanningContext?.paper_review?.paper_integration_gate || null,
    visual_execution_packets: visualPackets.visual_execution_packets,
    visual_refinement_brief: visualPackets.visual_refinement_brief,
    visual_qa: visualPackets.visual_qa,
    visual_execution_mode: cyclePlanningContext?.researcher_view?.visual_execution_mode || "deterministic_baseline_plus_illustrator_refinement",
    literature_positioning_summary: visualPackets.summary,
  };
}

module.exports = {
  buildIllustratorPresentationPlan,
};
