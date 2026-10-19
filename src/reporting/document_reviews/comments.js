"use strict";

const { referenceQuality } = require("../reference_policy");

const HIGH_IMPACT_THRESHOLD = 90;
let paperFigureDeckQuality = () => ({ complete: false, reasons: [] });

function configureDocumentReviewComments(options = {}) {
  if (typeof options.paperFigureDeckQuality === "function") {
    paperFigureDeckQuality = options.paperFigureDeckQuality;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function severityForScore(score) {
  const numeric = Number(score || 0);
  if (numeric < 70) return "major";
  if (numeric < 90) return "substantive";
  if (numeric < 97) return "minor";
  return "commendation";
}

function sectionComment({
  prefix,
  index,
  section,
  rubricItem,
  summary,
  evidenceObserved = [],
  strengths = [],
  concerns = [],
  requiredRevisions = [],
  suggestedRevisions = [],
  suggestedAdditionalAnalysis = [],
  severityOverride = null,
}) {
  return {
    comment_id: `${prefix}-${String(index + 1).padStart(2, "0")}-${String(section || "section").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    section,
    rubric_item: rubricItem?.name || null,
    score: Number(rubricItem?.score || 0),
    severity: severityOverride || severityForScore(rubricItem?.score),
    summary,
    evidence_observed: asArray(evidenceObserved),
    strengths: asArray(strengths),
    concerns: asArray(concerns),
    required_revisions: asArray(requiredRevisions),
    suggested_revisions: asArray(suggestedRevisions),
    suggested_additional_analysis: asArray(suggestedAdditionalAnalysis),
    author_response_expected: true,
  };
}

function rubricByName(rubric) {
  const out = new Map();
  for (const item of asArray(rubric)) out.set(item.name, item);
  return out;
}

function buildReportReviewComments(report, rubric) {
  if (!report) {
    return [
      sectionComment({
        prefix: "report-review",
        index: 0,
        section: "artifact",
        rubricItem: asArray(rubric)[0],
        summary: "No report artifact was available for high-impact review.",
        concerns: ["The report gate cannot assess claim framing, evidence traceability, or limitations without a JSON report artifact."],
        requiredRevisions: ["Generate the research report artifact before requesting report-gate approval."],
      }),
    ];
  }
  const byName = rubricByName(rubric);
  return [
    sectionComment({
      prefix: "report-review",
      index: 0,
      section: "executive_summary",
      rubricItem: byName.get("executive_decision_value"),
      summary: "The executive summary is reviewed for decision value rather than narrative polish.",
      evidenceObserved: [String(report.executive_summary || "").slice(0, 280)],
      strengths: ["The summary foregrounds the promoted claim and its scoped decision use."],
      concerns: asArray(byName.get("executive_decision_value")?.reasons),
      requiredRevisions: asArray(byName.get("executive_decision_value")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep the opening paragraph focused on what the evidence changes, not the full study history."],
    }),
    sectionComment({
      prefix: "report-review",
      index: 1,
      section: "evidence_traceability",
      rubricItem: byName.get("evidence_traceability"),
      summary: "Evidence traceability is reviewed against direct artifact links and quantitative auditability.",
      evidenceObserved: Object.values(report.evidence_artifacts || {}).filter(Boolean),
      strengths: ["The report links the claim to generated evidence artifacts rather than unsupported prose."],
      concerns: asArray(byName.get("evidence_traceability")?.reasons),
      requiredRevisions: asArray(byName.get("evidence_traceability")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep source table paths near the corresponding quantitative claims."],
    }),
    sectionComment({
      prefix: "report-review",
      index: 2,
      section: "limitations",
      rubricItem: byName.get("bias_and_limitations"),
      summary: "Limitations are reviewed for explicit bias, validity, and overclaim control.",
      evidenceObserved: asArray(report.limitations).slice(0, 6),
      strengths: ["The report states single-source and normalization threats explicitly."],
      concerns: asArray(byName.get("bias_and_limitations")?.reasons),
      requiredRevisions: asArray(byName.get("bias_and_limitations")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Maintain a clear distinction between dataset-internal reproducibility and population-level validation."],
    }),
  ];
}

function buildEditorialRiskComment(paper, editorialRisk, index) {
  const warnings = asArray(editorialRisk?.warnings);
  if (!paper || warnings.length === 0) return null;
  const suggestedAdditionalAnalysis = [];
  if (editorialRisk?.completed_external_validation !== true) {
    suggestedAdditionalAnalysis.push(
      "Add an independent public dataset, orthogonal validation slice, stricter sensitivity check, or a clearly documented failed search showing why external validation is not available.",
    );
  }
  if (/model-based|design metadata|additional model/i.test(warnings.join(" "))) {
    suggestedAdditionalAnalysis.push(
      "Recover the required design metadata or add a formal model-feasibility appendix with exact missing fields and source-file evidence.",
    );
  }
  return sectionComment({
    prefix: "paper-review",
    index,
    section: "editorial_readiness",
    rubricItem: { name: "editorial_risk_cap", score: Number(editorialRisk?.score_cap || 0) },
    summary: "The manuscript may pass papergate mechanics while still carrying high-impact editorial risks that should limit the final paper score.",
    evidenceObserved: warnings,
    strengths: ["The paper is scoped as a narrow, internally reproducible secondary-analysis manuscript rather than an overclaimed mechanism paper."],
    concerns: warnings,
    requiredRevisions: Number(editorialRisk?.score_cap || 0) < HIGH_IMPACT_THRESHOLD
      ? warnings.map((reason) => `Resolve before gate approval: ${reason}`)
      : [],
    suggestedRevisions: [
      "Keep the submission class explicit as a brief report or research letter unless independent validation is added.",
      "Do not let a clean checklist score erase sample-size, single-source, source-ethics, or deferred count-model limitations.",
    ],
    suggestedAdditionalAnalysis,
    severityOverride: Number(editorialRisk?.score_cap || 0) < HIGH_IMPACT_THRESHOLD ? "major" : "substantive",
  });
}

function buildPaperReviewComments(paper, rubric, editorialRisk = null) {
  if (!paper) {
    return [
      sectionComment({
        prefix: "paper-review",
        index: 0,
        section: "artifact",
        rubricItem: asArray(rubric)[0],
        summary: "No manuscript artifact was available for high-impact journal review.",
        concerns: ["The paper gate cannot review abstract, methods, results, figures, or availability without a manuscript JSON artifact."],
        requiredRevisions: ["Generate the manuscript JSON/Markdown/TeX artifacts before requesting papergate approval."],
      }),
    ];
  }
  const byName = rubricByName(rubric);
  const blob = JSON.stringify(paper || {});
  const hasFigureDeck = Boolean(paper?.figure_deck?.pptx_path);
  const hasSvgPptPolicy = /svg/i.test(JSON.stringify(paper?.figure_deck || {})) && /ppt/i.test(JSON.stringify(paper?.figure_deck || {}));
  const figureDeckQuality = paperFigureDeckQuality(paper);
  const refQuality = referenceQuality(paper?.references, {
    minimumReferences: 5,
    minimumVerified: 4,
    minimumHighImpact: 2,
  });
  const comments = [
    sectionComment({
      prefix: "paper-review",
      index: 0,
      section: "title_abstract",
      rubricItem: byName.get("title_abstract_framing"),
      summary: "The title and structured abstract are checked for a narrow, falsifiable claim and enough quantitative signal to let a journal editor triage the paper.",
      evidenceObserved: Object.entries(paper.abstract || {}).map(([key, value]) => `${key}: ${String(value || "").slice(0, 180)}`),
      strengths: ["The abstract is structured and frames the claim as dataset-internal rather than population-level."],
      concerns: asArray(byName.get("title_abstract_framing")?.reasons),
      requiredRevisions: asArray(byName.get("title_abstract_framing")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep sample size, primary comparison, main quantitative threshold, and claim scope visible in the abstract."],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 1,
      section: "introduction_discussion_positioning",
      rubricItem: byName.get("novelty_and_impact_positioning"),
      summary: "Novelty is reviewed as a disciplined re-ranking of the dominant signal in the available evidence package, not as an unsupported broad mechanism claim.",
      evidenceObserved: asArray(paper.discussion).slice(0, 4),
      strengths: ["The discussion separates the positive dataset-native observation from untested rival explanations and broader generalization."],
      concerns: asArray(byName.get("novelty_and_impact_positioning")?.reasons),
      requiredRevisions: asArray(byName.get("novelty_and_impact_positioning")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Add or preserve direct contrast to independent, orthogonal, or stricter sensitivity validation opportunities."],
      suggestedAdditionalAnalysis: [
        "Run a high-impact reference refresh before final submission if fewer than two verified high-impact journal references support the framing.",
      ],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 2,
      section: "methods_reproducibility",
      rubricItem: byName.get("methods_reproducibility"),
      summary: "Methods are checked for source-data identity, sample structure, transformations, classification rules, and secondary-analysis reporting disclosures.",
      evidenceObserved: asArray(paper.methods).slice(0, 6),
      strengths: ["The methods identify source data, sample structure, transformations, thresholds, generated artifacts, and sensitivity checks."],
      concerns: asArray(byName.get("methods_reproducibility")?.reasons),
      requiredRevisions: asArray(byName.get("methods_reproducibility")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["State the exact regular-expression classification rules and the one-sided Fisher exact test for class-size normalization."],
      suggestedAdditionalAnalysis: [
        "If richer source data and design metadata are available, run the stronger model-based reanalysis or document why it remains infeasible.",
        "Refresh the validation checklist whenever an author-led method clarification changes a quantitative claim.",
      ],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 3,
      section: "statistical_results",
      rubricItem: byName.get("statistical_reporting"),
      summary: "Statistical reporting is checked for exact numeric anchors, sensitivity thresholds, and the rival-class comparison that carries the paper.",
      evidenceObserved: asArray(paper.results).slice(0, 7),
      strengths: ["The results report concordance, threshold sensitivity, category counts, and rival-evidence balance."],
      concerns: asArray(byName.get("statistical_reporting")?.reasons),
      requiredRevisions: asArray(byName.get("statistical_reporting")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep concordance, threshold sensitivity, and main-versus-rival quantitative contrasts together."],
      suggestedAdditionalAnalysis: [
        "Regenerate feature-level source tables if top anchors, uncertainty values, or validation-panel definitions drift after revision.",
        "Re-run class-size-normalized sensitivity when classification rules or thresholds change.",
      ],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 4,
      section: "figures_tables",
      rubricItem: byName.get("tables_figures_submission_discipline"),
      summary: "Figures are reviewed as submission assets, not only as analysis previews.",
      evidenceObserved: [
        `tables_and_figures=${asArray(paper.tables_and_figures).length}`,
        `figure_deck=${hasFigureDeck ? paper.figure_deck.pptx_path : "missing"}`,
        `svg_ppt_policy=${hasSvgPptPolicy ? "present" : "missing"}`,
        `axis_label_quality=${figureDeckQuality.complete ? "complete" : "incomplete"}`,
        `inserted_figure_images=${asArray(paper.figure_panels).length}`,
        ...asArray(figureDeckQuality.reasons).slice(0, 4),
      ],
      strengths: hasFigureDeck
        ? ["A separate PPT figure deck is linked from the manuscript metadata."]
        : [],
      concerns: [
        ...asArray(byName.get("tables_figures_submission_discipline")?.reasons),
        ...(!hasFigureDeck ? ["A journal-facing figure deck should be produced separately from the paper text."] : []),
        ...(!hasSvgPptPolicy ? ["Figure artwork must be SVG-only while labels stay editable in PPT and captions stay in LaTeX/manifest text."] : []),
        ...(!figureDeckQuality.complete ? ["Figure deck labels, rendered PNG QA, or LaTeX caption ownership are not complete enough for manuscript figures."] : []),
      ],
      requiredRevisions: [
        ...asArray(byName.get("tables_figures_submission_discipline")?.reasons).map((reason) => `Resolve: ${reason}`),
        ...(!hasFigureDeck ? ["Create a separate PPTX figure deck and link its manifest from the paper artifact."] : []),
        ...(!hasSvgPptPolicy ? ["Use SVG files without embedded text for artwork, editable PPT text boxes for labels, and LaTeX/manifest text for captions."] : []),
        ...(!figureDeckQuality.complete ? ["Regenerate the figure deck through ResearchLab illustrator/figure-deck builder with complete editable PPT labels, no embedded caption/title prose, >=8 pt text, and passing rendered_image_quality QA."] : []),
        ...(asArray(paper.figure_panels).length < 3 ? ["Insert exported paper images from the ResearchLab PPT figure deck into the manuscript body."] : []),
        ...(asArray(paper.figure_panels).some((item) => String(item?.detailed_explanation || "").length < 120) ? ["Expand each figure legend with a detailed explanation of what the reader should conclude and which source tables support it."] : []),
      ],
      suggestedRevisions: ["Treat the manuscript figure inventory as a pointer to the PPT deck, SVG assets, source CSVs, and editable text boxes."],
      suggestedAdditionalAnalysis: [
        "Create figure-source tables for primary signal, validation summary, and evidence-trace panels before visual polishing.",
      ],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 5,
      section: "limitations_ethics_availability",
      rubricItem: byName.get("limitations_and_ethics"),
      summary: "Limitations, ethics, and data availability are checked for inherited-source disclosure and prevention of mechanistic overreach.",
      evidenceObserved: asArray(paper.limitations).concat(asArray(paper.data_code_availability)).slice(0, 9),
      strengths: ["The paper states source, measurement, single-source, model-specification, and independent-validation limitations."],
      concerns: asArray(byName.get("limitations_and_ethics")?.reasons),
      requiredRevisions: asArray(byName.get("limitations_and_ethics")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep ethics/accession language tied to the public source rather than implying a new human-subject collection."],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 6,
      section: "data_code_availability",
      rubricItem: byName.get("data_code_availability"),
      summary: "Availability is checked for reproducible source identifiers and generated-artifact discoverability.",
      evidenceObserved: asArray(paper.data_code_availability),
      strengths: ["Source identifiers and generated artifact locations are listed."],
      concerns: asArray(byName.get("data_code_availability")?.reasons),
      requiredRevisions: asArray(byName.get("data_code_availability")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Keep artifact paths stable enough that an author can execute review-driven reanalysis without searching the runtime tree."],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 7,
      section: "references",
      rubricItem: byName.get("novelty_and_impact_positioning"),
      summary: "References are reviewed for verified identifiers, trusted-source metadata, and high-impact journal positioning rather than citation count alone.",
      evidenceObserved: [
        `article_references=${refQuality.article_reference_count}`,
        `verified_article_references=${refQuality.verified_article_reference_count}`,
        `high_impact_references=${refQuality.high_impact_reference_count}`,
        ...asArray(refQuality.blockers).slice(0, 4),
      ],
      strengths: refQuality.high_impact_reference_count > 0
        ? ["At least one high-impact contextual source is present."]
        : [],
      concerns: asArray(refQuality.blockers),
      requiredRevisions: asArray(refQuality.blockers).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: [
        // Naming journals here pins the advice to one field. What makes a
        // reference authoritative is that it resolves and that its venue clears
        // the standard the cycle recorded for its own target.
        "Prefer articles backed by a resolvable persistent identifier, from venues that clear the recorded venue standard for this cycle's target rather than from any fixed list of journal names.",
        "Separate the primary dataset citation from contextual high-impact references.",
      ],
      suggestedAdditionalAnalysis: [
        "Run Crossref/OpenAlex/PubMed verification for every manuscript reference and replace weak metadata-only citations.",
      ],
    }),
    sectionComment({
      prefix: "paper-review",
      index: 8,
      section: "claim_scope",
      rubricItem: byName.get("imrad_structure"),
      summary: "The full IMRaD flow is reviewed for whether each section supports the same bounded claim.",
      evidenceObserved: [
        `introduction=${asArray(paper.introduction).length}`,
        `methods=${asArray(paper.methods).length}`,
        `results=${asArray(paper.results).length}`,
        `discussion=${asArray(paper.discussion).length}`,
        `overclaim_guard=${/hypothesis-generating|not.*population|dataset|slice/i.test(blob) ? "present" : "weak"}`,
      ],
      strengths: ["The manuscript keeps methods and results aligned to the same dataset-internal hypothesis."],
      concerns: asArray(byName.get("imrad_structure")?.reasons),
      requiredRevisions: asArray(byName.get("imrad_structure")?.reasons).map((reason) => `Resolve: ${reason}`),
      suggestedRevisions: ["Reject new domain claims unless they are backed by a generated artifact or explicit external validation plan."],
    }),
  ];
  const riskComment = buildEditorialRiskComment(paper, editorialRisk, comments.length);
  return riskComment ? comments.concat(riskComment) : comments;
}

module.exports = {
  configureDocumentReviewComments,
  severityForScore,
  sectionComment,
  rubricByName,
  buildReportReviewComments,
  buildEditorialRiskComment,
  buildPaperReviewComments,
};
