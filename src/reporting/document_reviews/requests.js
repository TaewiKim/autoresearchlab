"use strict";

const { referenceQuality } = require("../reference_policy");
const {
  figureCitationFollowupActions,
  figureEvidenceChecks,
  figureVerificationFollowupActions,
} = require("./figure_evidence");
const { calibratedPaperStandard } = require("./venue_standard");

const { GATE_THRESHOLD: HIGH_IMPACT_THRESHOLD } = require("../../policy/research_gate");
let paperFigureDeckQuality = () => ({ complete: false, reasons: [] });
let paperIntegrationQuality = () => ({ score: 0, passed: false, reasons: ["paper integration quality unavailable"], checks: [] });

function configureDocumentReviewRequests(options = {}) {
  if (typeof options.paperFigureDeckQuality === "function") {
    paperFigureDeckQuality = options.paperFigureDeckQuality;
  }
  if (typeof options.paperIntegrationQuality === "function") {
    paperIntegrationQuality = options.paperIntegrationQuality;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function average(items) {
  const applicable = asArray(items).filter((item) => item.applicable !== false);
  if (applicable.length === 0) return 0;
  return Math.round(applicable.reduce((sum, item) => sum + Number(item.score || 0), 0) / applicable.length);
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function requiredRequestBlockers(requests, fallbackPrefix) {
  return asArray(requests)
    .filter((item) => item?.required_for_gate === true)
    .flatMap((item) => {
      const blockers = asArray(item?.quality_blockers);
      if (blockers.length > 0) return blockers;
      return [`${fallbackPrefix}: ${item?.objective || item?.request_id || "required gate follow-up remains"}`];
    });
}

function gateAdjustedScore(rawScore, blockers) {
  const blockerCount = uniqueStrings(blockers).length;
  if (blockerCount === 0) return Math.round(rawScore);
  return Math.max(0, Math.min(Math.round(rawScore), 89 - Math.min(39, blockerCount * 4)));
}

function paperAnalysisRequests(paper, reviewComments) {
  if (!paper) return [];
  const comments = asArray(reviewComments);
  const commentIds = (section) => comments.filter((item) => item.section === section).map((item) => item.comment_id);
  const supplementaryTables = paper.supplementary_tables || {};
  const hasModelFeasibility = /model_feasibility|model-based|design metadata|sensitivity/i.test(JSON.stringify(supplementaryTables)) || /model feasibility|model-based reanalysis|sensitivity/i.test(JSON.stringify(paper));
  const hasNormalizedCategory = /category_background_normalized|class-size-normalized|one-sided Fisher|category_normalized/i.test(JSON.stringify(paper));
  const hasValidationPanel = /validation_panels|validation panel|evidence trace/i.test(JSON.stringify(paper));
  return [
    {
      request_id: "author-analysis-model-feasibility",
      preferred_role: "author",
      priority: hasModelFeasibility ? "medium" : "high",
      required_for_gate: !hasModelFeasibility,
      allowed_author_execution: true,
      trigger_comment_ids: commentIds("methods_reproducibility").concat(commentIds("statistical_results")),
      analysis_type: "model-feasibility and sensitivity audit",
      objective: "Determine whether a stronger model-based reanalysis is feasible; if not, preserve the available sensitivity audit and document missing metadata precisely.",
      required_inputs: ["public source tables", "design metadata if present", "sample or unit mapping", "current quantitative summaries"],
      expected_artifacts: ["model_feasibility.json", "direction_or_sensitivity_audit.csv", "author_response_model_feasibility.md"],
      acceptance_criteria: [
        "states whether stronger model-based reanalysis is feasible from available inputs",
        "reports sensitivity or concordance evidence, or explains why it cannot be computed",
        "does not change the paper claim without a regenerated evidence artifact",
      ],
    },
    {
      request_id: "author-analysis-category-normalized-sensitivity",
      preferred_role: "author",
      priority: hasNormalizedCategory ? "medium" : "high",
      required_for_gate: !hasNormalizedCategory,
      allowed_author_execution: true,
      trigger_comment_ids: commentIds("methods_reproducibility").concat(commentIds("statistical_results")),
      analysis_type: "category class-size-normalized sensitivity",
      objective: "Refresh class-size-normalized tests if category classification rules or thresholds are edited.",
      required_inputs: ["category-level summary", "classification terms", "classification rules"],
      expected_artifacts: ["category_class_background_normalized.csv", "category_sensitivity_author_response.md"],
      acceptance_criteria: [
        "reports class terms, significant terms, background significant rate, odds ratio, and one-sided Fisher exact p-value",
        "covers the main promoted category and at least one rival or sensitivity category when such categories exist",
      ],
    },
    {
      request_id: "author-analysis-validation-panel-audit",
      preferred_role: "author",
      priority: hasValidationPanel ? "medium" : "high",
      required_for_gate: !hasValidationPanel,
      allowed_author_execution: true,
      trigger_comment_ids: commentIds("statistical_results"),
      analysis_type: "validation panel definition and direction audit",
      objective: "Keep the validation panel definition, direction calls, and uncertainty disclosure synchronized with the manuscript text.",
      required_inputs: ["validation panel feature list", "quantitative result table", "current Results text"],
      expected_artifacts: ["validation_panel_definition.csv", "validation_panel_author_response.md"],
      acceptance_criteria: [
        "defines every feature or validation item used in the panel",
        "separates direction calls from statistical significance",
        "flags any panel item not present in the quantitative result table",
      ],
    },
  ];
}

function paperReferenceRequests(paper, reviewComments) {
  if (!paper) return [];
  // The same venue-calibrated floor the rubric applies. A request that asks for
  // five references while the gate holds twenty-five sends the author to fix the
  // wrong thing, and this project has already spent cycles on rules whose
  // consumer disagreed with their producer.
  const venueStandard = calibratedPaperStandard(paper);
  const refQuality = referenceQuality(paper?.references, {
    minimumReferences: venueStandard.minimum_references,
    minimumVerified: venueStandard.minimum_verified,
    minimumHighImpact: venueStandard.minimum_high_impact,
  });
  const referenceCommentIds = asArray(reviewComments)
    .filter((item) => item.section === "references" || item.rubric_item === "novelty_and_impact_positioning")
    .map((item) => item.comment_id);
  return [
    {
      request_id: "author-reference-high-impact-verification",
      preferred_role: "author",
      priority: refQuality.passed ? "medium" : "high",
      required_for_gate: !refQuality.passed,
      trigger_comment_ids: referenceCommentIds,
      objective: "Refresh manuscript references using verified DOI/PMID/PMCID/trusted-source metadata and prioritize high-impact journals for contextual framing.",
      required_inputs: ["current manuscript reference list", "Crossref/OpenAlex/PubMed metadata lookups", "topic-specific high-impact venue search results"],
      expected_artifacts: ["reference_verification_table.csv", "high_impact_reference_refresh.md", "updated_document_reference_context.json"],
      acceptance_criteria: [
        `at least ${venueStandard.minimum_references} article references are present`,
        `at least ${venueStandard.minimum_verified} article references have DOI, PMID, PMCID, or trusted-source verification`,
        `at least ${venueStandard.minimum_high_impact} contextual article references are well cited for this reference set`,
        "weak metadata-only citations are removed or explicitly marked as non-authoritative context",
      ],
      quality_blockers: refQuality.blockers,
      reference_quality: refQuality,
    },
  ];
}

function paperFigureProductionRequests(paper, reviewComments) {
  if (!paper) return [];
  const figureCommentIds = asArray(reviewComments)
    .filter((item) => item.section === "figures_tables")
    .map((item) => item.comment_id);
  const hasFigureDeck = Boolean(paper?.figure_deck?.pptx_path);
  const hasSvgPptPolicy = /svg/i.test(JSON.stringify(paper?.figure_deck || {})) && /ppt/i.test(JSON.stringify(paper?.figure_deck || {}));
  const figureDeckQuality = paperFigureDeckQuality(paper);
  return [
    {
      request_id: "illustrator-paper-figure-deck",
      preferred_role: "illustrator",
      priority: hasFigureDeck && hasSvgPptPolicy && figureDeckQuality.complete ? "medium" : "high",
      required_for_gate: !(hasFigureDeck && hasSvgPptPolicy && figureDeckQuality.complete),
      trigger_comment_ids: figureCommentIds,
      artifact_type: "pptx_figure_deck",
      objective: "Produce a manuscript figure deck separate from the paper text.",
      production_policy: {
        deck_format: "pptx",
        graphics_format: "svg",
        pptx_generation_policy: "PPTX files must be generated with python-pptx and embed a PowerPoint-compatible PNG artwork layer rendered from the text-free SVG source.",
        svg_text_policy: "SVG files must not contain <text> elements or baked-in labels.",
        ppt_text_policy: "Only panel labels, axis labels, tick labels, legends, value labels, and essential callouts belong in editable PPT text boxes. Captions, slide titles, and key-message prose must remain LaTeX/manifest text, not figure-image text.",
        caption_policy: "Figure captions are authored by LaTeX from the manifest caption field; do not place captions inside PPT slides or flattened figure images.",
        manuscript_image_policy: "The paper must insert existing PNG/JPEG/PDF-compatible flattened exports from paper_image_png_path; raw SVG is not acceptable for pdflatex insertion.",
        visual_text_policy: "Every manifest slide must include text_box_quality/text_overlap_check results proving editable PPT labels do not overlap, do not leave slide bounds, and are at least 8 pt.",
        image_quality_policy: "Every manifest slide must include rendered_image_quality pixel QA from the final paper_image_png_path export.",
        quality_gate_policy: "FigureGate fails on missing PNG exports, raw SVG manuscript insertion, unreadable manifests, embedded SVG text, overlapping or undersized text boxes, captions/titles embedded in figure images, missing rendered-image QA, missing source tables, or missing captions.",
      },
      expected_artifacts: ["paper_figure_deck.pptx generated by python-pptx", "figure_deck_manifest.json", "figure SVG assets without embedded text", "PowerPoint-compatible ppt_artwork_png_path assets", "existing paper_image_png_path exports for every manifest slide", "text_box_quality manifest QA report", "rendered_image_quality pixel QA report", "flattened manuscript figure images inserted in the paper"],
      acceptance_criteria: [
        "manifest records pptx_generation_method=python-pptx",
        "each slide has a source SVG artwork asset, a PPT-compatible rendered artwork layer, and separate editable PPT text boxes",
        "axis titles, tick labels, category labels, trace labels, and value labels are editable PPT text boxes",
        "manifest ppt_text_boxes do not include caption, figure title, key message, or takeaway prose boxes",
        "manifest lists an existing paper_image_png_path for every paper figure",
        "paper figure_panels insert exported image files derived from the PPT deck through paper_image_png_path",
        "LaTeX includegraphics entries do not reference raw .svg files",
        "text_box_quality/text_overlap_check reports pass with zero editable text overlaps, no out-of-bounds labels, and minimum_font_size >= 8",
        "rendered_image_quality reports pass for every final manuscript PNG",
        "each inserted figure has a detailed explanation beyond the short caption",
        "figure captions and source tables are listed in the manifest, with captions rendered by LaTeX rather than embedded in images",
        "no text is embedded in SVG artwork",
      ],
      quality_blockers: figureDeckQuality.reasons,
    },
  ];
}

function followupActions(kind, rubric, threshold = HIGH_IMPACT_THRESHOLD) {
  return asArray(rubric)
    .filter((item) => item.applicable !== false && Number(item.score || 0) < threshold)
    .map((item) => ({
      type: kind === "report" ? "report_high_impact_followup" : "paper_high_impact_followup",
      priority: "high",
      preferred_role: "author",
      target_document: kind,
      target_rubric: item.name,
      target_score: threshold,
      current_score: Number(item.score || 0),
      blocker_reasons: item.reasons || [],
      description:
        kind === "report"
          ? `revise the research report to satisfy high-impact reviewer expectations for ${item.name}`
          : `revise the manuscript to satisfy high-impact journal expectations for ${item.name}`,
    }));
}

function paperAuthorRubric(rubric) {
  return asArray(rubric).filter((item) => item?.name !== "tables_figures_submission_discipline");
}

function paperFigureRubric(rubric) {
  return asArray(rubric).filter((item) => item?.name === "tables_figures_submission_discipline");
}

function rubricBlockers(rubric, threshold = HIGH_IMPACT_THRESHOLD) {
  return asArray(rubric)
    .filter((item) => item.applicable !== false && Number(item.score || 0) < threshold)
    .flatMap((item) => item.reasons.length ? item.reasons : [`${item.name} below high-impact threshold`]);
}

function paperAuthorFollowupActions(rubric, threshold = HIGH_IMPACT_THRESHOLD) {
  return followupActions("paper", paperAuthorRubric(rubric), threshold);
}

// A blocker with no action attached is a blocker nobody is asked to clear.
//
// The venue-standard and claim-strength findings arrive as blockers, not as
// rubric scores, so the rubric-driven followups above cannot see them. On the
// first cycle run under the new gate the paper review emitted 3 blockers and
// ZERO recommended actions: no author lane was ever opened, the supervisor spent
// its rounds on gatekeepers and directors instead, and the run halted on
// stagnation with the manuscript byte-identical to the one it started with. The
// halt's own text was "more gate reviews will not raise them", which was exactly
// right and exactly the problem.
function standardFindingFollowupActions(findings, threshold = HIGH_IMPACT_THRESHOLD) {
  return asArray(findings).map((finding, index) => ({
    type: "manuscript_standard_followup",
    priority: "critical",
    preferred_role: "author",
    target_document: "paper",
    target_rubric: "claim_and_venue_standard",
    target_score: threshold,
    required_for_gate: true,
    finding_index: index,
    blocker_reasons: [finding],
    description: `resolve the manuscript standard blocker: ${finding}`,
  }));
}

function paperFigureRubricFollowupActions(rubric, threshold = HIGH_IMPACT_THRESHOLD) {
  return paperFigureRubric(rubric)
    .filter((item) => item.applicable !== false && Number(item.score || 0) < threshold)
    .map((item) => ({
      type: "figure_submission_discipline_followup",
      priority: "high",
      preferred_role: "illustrator",
      target_document: "paper",
      target_rubric: item.name,
      target_score: threshold,
      current_score: Number(item.score || 0),
      blocker_reasons: item.reasons || [],
      description: "revise the manuscript figure deck and visual assets to satisfy high-impact journal figure/table expectations",
    }));
}

function analysisFollowupActions(analysisRequests) {
  return asArray(analysisRequests)
    .filter((item) => item?.preferred_role === "author" && (item.required_for_gate === true || item.priority === "high"))
    .map((item) => ({
      type: item.request_id,
      priority: item.priority || "high",
      preferred_role: "author",
      target_document: "paper",
      target_rubric: "review_driven_additional_analysis",
      blocker_reasons: item.required_for_gate ? [`additional analysis required: ${item.objective}`] : [],
      description: `perform review-driven author analysis: ${item.objective}`,
      analysis_request: item,
    }));
}

function referenceFollowupActions(referenceRequests) {
  return asArray(referenceRequests)
    .filter((item) => item?.preferred_role === "author" && (item.required_for_gate === true || item.priority === "high"))
    .map((item) => ({
      type: item.request_id,
      priority: item.priority || "high",
      preferred_role: "author",
      target_document: "paper",
      target_rubric: "high_impact_references",
      blocker_reasons: item.quality_blockers || [],
      description: `refresh manuscript citations with verified high-impact references: ${item.objective}`,
      reference_request: item,
    }));
}

function figureFollowupActions(figureRequests) {
  return asArray(figureRequests)
    .filter((item) => item?.preferred_role === "illustrator" && (item.required_for_gate === true || item.priority === "high"))
    .map((item) => ({
      type: item.request_id,
      priority: item.priority || "high",
      preferred_role: "illustrator",
      target_document: "paper",
      target_rubric: "figures_tables",
      blocker_reasons: item.required_for_gate ? [`figure production required: ${item.objective}`] : [],
      description: `produce review-driven paper figures: ${item.objective}`,
      figure_production_request: item,
    }));
}

function integrationFollowupActions(integrationGate) {
  if (!integrationGate || integrationGate.passed === true) return [];
  return [
    {
      type: "paper_integration_followup",
      priority: "high",
      preferred_role: "author",
      target_document: "paper",
      target_rubric: "paper_integration",
      target_score: HIGH_IMPACT_THRESHOLD,
      current_score: Number(integrationGate.score || 0),
      blocker_reasons: asArray(integrationGate.blockers || integrationGate.reasons),
      description: "synchronize manuscript figure insertions, figure-deck manifest IDs, source-table provenance, and detailed figure explanations",
    },
  ];
}

function buildPaperSubgates({
  root,
  cycleId,
  paper,
  rubric,
  rawScore,
  editorialRisk,
  analysisRequests,
  referenceRequests,
  figureRequests,
  // The bar this manuscript is held to, and what the venue's own standard and
  // the claim it makes had to say about it. Defaulted so every existing caller
  // and test keeps the base threshold and adds nothing.
  threshold = HIGH_IMPACT_THRESHOLD,
  standardFindings = [],
}) {
  const authorRubric = paperAuthorRubric(rubric);
  const figureRubric = paperFigureRubric(rubric);
  const authorRequestBlockers = requiredRequestBlockers(analysisRequests, "additional analysis required")
    .concat(requiredRequestBlockers(referenceRequests, "reference verification required"));
  const authorBlockers = uniqueStrings(
    rubricBlockers(authorRubric, threshold)
      .concat(authorRequestBlockers)
      .concat(asArray(standardFindings)),
  );
  const authorRawScore = average(authorRubric);
  const authorBlockerAdjustedScore = gateAdjustedScore(authorRawScore, authorBlockers);
  const authorScore = Math.min(authorBlockerAdjustedScore, Number(editorialRisk?.score_cap || 100));
  const authorGate = {
    gate_id: "author_gate",
    owner_role: "author",
    scope: "manuscript text, claim scope, statistical reporting, references, reviewer response, and review-driven analysis artifacts",
    score: authorScore,
    raw_score: authorRawScore,
    blocker_adjusted_score: authorBlockerAdjustedScore,
    passed: Boolean(paper) && authorBlockers.length === 0 && authorScore >= threshold,
    blockers: authorBlockers,
    rubric: authorRubric,
    analysis_requests: analysisRequests,
    reference_requests: referenceRequests,
    recommended_followup_actions: paperAuthorFollowupActions(rubric, threshold)
      .concat(standardFindingFollowupActions(standardFindings, threshold))
      .concat(analysisFollowupActions(analysisRequests))
      .concat(referenceFollowupActions(referenceRequests)),
  };

  const figureRequestBlockers = requiredRequestBlockers(figureRequests, "figure production required");
  // The deck rubric counts figures; this reads them. A figure that asserts
  // something its own source artifact refutes scores full marks on presence.
  const figureEvidence = figureEvidenceChecks({ root, cycleId, paper });
  const figureBlockers = uniqueStrings(
    rubricBlockers(figureRubric, threshold)
      .concat(figureRequestBlockers)
      .concat(figureEvidence.blockers),
  );
  const figureRawScore = average(figureRubric);
  const figureScore = gateAdjustedScore(figureRawScore, figureBlockers);
  const figureGate = {
    gate_id: "figure_gate",
    owner_role: "illustrator",
    scope: "figure evidence - each figure drawn by the lane that claims it, cited in the manuscript, and read against its source artifact - plus the figure deck, SVG artwork, editable labels and manifest",
    score: figureScore,
    raw_score: figureRawScore,
    passed: Boolean(paper) && figureBlockers.length === 0 && figureScore >= threshold,
    blockers: figureBlockers,
    rubric: figureRubric,
    figure_production_requests: figureRequests,
    figure_evidence_checks: figureEvidence.checks,
    figure_verification_requests: figureEvidence.verification_requests,
    figure_verdict_store: figureEvidence.verdict_store,
    recommended_followup_actions: paperFigureRubricFollowupActions(rubric, threshold)
      .concat(figureFollowupActions(figureRequests))
      .concat(figureVerificationFollowupActions(figureEvidence.verification_requests))
      .concat(figureCitationFollowupActions(figureEvidence.checks)),
  };

  const integrationQuality = paperIntegrationQuality(paper);
  const integrationGate = {
    gate_id: "paper_integration_gate",
    owner_role: "author",
    collaborator_roles: ["author", "illustrator"],
    scope: "cross-check that manuscript text, inserted PPT-derived figure images, manifest IDs, source tables, and detailed explanations agree",
    score: integrationQuality.score,
    raw_score: integrationQuality.score,
    passed: integrationQuality.passed,
    blockers: integrationQuality.reasons,
    checks: integrationQuality.checks,
    recommended_followup_actions: integrationFollowupActions(integrationQuality),
  };

  const paperGateBlockers = uniqueStrings(authorGate.blockers.concat(figureGate.blockers, integrationGate.blockers));
  const paperGateScore = Math.min(
    Number(authorGate.score || 0),
    Number(figureGate.score || 0),
    Number(integrationGate.score || 0),
  );
  return {
    authorGate,
    figureGate,
    integrationGate,
    paperGate: {
      gate_id: "paper_gate",
      owner_role: "lab-director",
      scope: "final high-impact manuscript gate that requires AuthorGate, FigureGate, and PaperIntegrationGate to pass",
      score: paperGateScore,
      raw_score: rawScore,
      passed: Boolean(paper) && authorGate.passed && figureGate.passed && integrationGate.passed && paperGateScore >= threshold,
      threshold,
      blockers: paperGateBlockers,
      required_gates: ["author_gate", "figure_gate", "paper_integration_gate"],
      gate_status: {
        author_gate: authorGate.passed,
        figure_gate: figureGate.passed,
        paper_integration_gate: integrationGate.passed,
      },
    },
  };
}

module.exports = {
  configureDocumentReviewRequests,
  paperAnalysisRequests,
  paperReferenceRequests,
  paperFigureProductionRequests,
  followupActions,
  paperAuthorRubric,
  paperFigureRubric,
  rubricBlockers,
  paperAuthorFollowupActions,
  paperFigureRubricFollowupActions,
  analysisFollowupActions,
  referenceFollowupActions,
  figureFollowupActions,
  integrationFollowupActions,
  buildPaperSubgates,
};
