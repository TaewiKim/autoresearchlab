"use strict";

const fs = require("fs");
const path = require("path");
const { appendDialogueRow } = require("../observability/cycle_logs");
const { ensureDir, readJson, writeJson } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");
const { attachUnifiedReviewFields } = require("./final_claim_package");
const { referenceQuality } = require("./reference_policy");
const { recordReviewSnapshot } = require("./review_history");
const {
  configureDocumentReviewComments,
  buildReportReviewComments,
  buildPaperReviewComments,
} = require("./document_reviews/comments");
const {
  configureDocumentReviewRequests,
  paperAnalysisRequests,
  paperReferenceRequests,
  paperFigureProductionRequests,
  followupActions,
  buildPaperSubgates,
} = require("./document_reviews/requests");
const {
  abstractRequirement,
  coreResultRequirement,
  venueUsesDirectFigureInsertion,
} = require("./document_reviews/venue_fit");
const {
  calibratedPaperStandard,
  venueStandardFindings,
} = require("./document_reviews/venue_standard");
const {
  claimStrengthFindings,
  claimStrengthReport,
} = require("./document_reviews/claim_strength");
const {
  adoptedExperimentFollowupActions,
  experimentChannelExhausted,
  readExperimentRequests,
  undecidedExperimentFindings,
} = require("./experiment_requests");

// The floor, not the bar. `calibratedPaperStandard` raises it to the venue the
// manuscript was actually written for; it never lowers it below this.
const { GATE_THRESHOLD: HIGH_IMPACT_THRESHOLD } = require("../policy/research_gate");

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function latestVersionedJson(dirPath, prefix) {
  if (!fs.existsSync(dirPath)) return null;
  const candidates = fs
    .readdirSync(dirPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  return candidates.length ? path.join(dirPath, candidates[candidates.length - 1]) : null;
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function scoreItem(name, score, reasons = [], applicable = true) {
  return {
    name,
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: asArray(reasons).map((item) => String(item || "").trim()).filter(Boolean),
    applicable,
  };
}

function highImpactPaperScoreItem(name, rawScore, reasons = [], applicable = true) {
  const cleanReasons = asArray(reasons).map((item) => String(item || "").trim()).filter(Boolean);
  let score = Number(rawScore || 0);
  if (cleanReasons.length > 0) {
    const severeBlocker = cleanReasons.some((reason) =>
      /reference list|paper must|figure deck|methods lack|structured abstract|FDR|availability|limitations|overclaim|artifact/i.test(reason),
    );
    const cap = severeBlocker ? 82 : 86;
    score = Math.min(score, cap - Math.min(12, Math.max(0, cleanReasons.length - 1) * 4));
  }
  return scoreItem(name, score, cleanReasons, applicable);
}

function missingIf(condition, reason) {
  return condition ? [] : [reason];
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

function slideTextQualityBlocker(slide) {
  const quality = slide?.text_box_quality && typeof slide.text_box_quality === "object"
    ? slide.text_box_quality
    : null;
  if (!quality) {
    return "is missing text_box_quality manifest QA results for editable PPT labels";
  }
  const overlapCheck = slide?.text_overlap_check && typeof slide.text_overlap_check === "object"
    ? slide.text_overlap_check
    : quality?.text_overlap_check && typeof quality.text_overlap_check === "object"
      ? quality.text_overlap_check
      : quality;
  const overlapCount = Number(quality?.overlap_count ?? overlapCheck?.overlap_count ?? 0);
  const overlaps = asArray(quality?.overlaps).concat(asArray(overlapCheck?.overlaps));
  const outOfBounds = asArray(quality?.out_of_bounds).concat(asArray(overlapCheck?.out_of_bounds));
  const undersizedTextBoxes = asArray(quality?.undersized_text_boxes).concat(asArray(overlapCheck?.undersized_text_boxes));
  const minimumFontSize = Number(quality?.minimum_font_size ?? overlapCheck?.minimum_font_size);
  if (!Number.isFinite(minimumFontSize)) {
    return "is missing minimum_font_size QA for manuscript figure labels";
  }
  if (minimumFontSize < 8 || undersizedTextBoxes.length > 0) {
    return "uses manuscript figure text smaller than 8 pt";
  }
  if (quality?.passed === false || overlapCheck?.passed === false || overlapCount > 0 || overlaps.length > 0) {
    return "has overlapping editable text boxes in the PPT figure layer";
  }
  if (outOfBounds.length > 0) {
    return "has editable text boxes outside slide bounds";
  }
  return null;
}

function slideRenderedImageQualityBlocker(slide) {
  const quality = slide?.rendered_image_quality && typeof slide.rendered_image_quality === "object"
    ? slide.rendered_image_quality
    : null;
  if (!quality) {
    return "is missing rendered_image_quality pixel QA for the final manuscript PNG";
  }
  if (quality.passed === false) {
    const issues = uniqueStrings(asArray(quality.issues).map(String)).slice(0, 3);
    return `fails rendered manuscript image pixel QA${issues.length ? `: ${issues.join("; ")}` : ""}`;
  }
  return null;
}

function slideEmbeddedProseBlocker(slide) {
  const forbiddenBoxes = asArray(slide?.ppt_text_boxes)
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((label) =>
      label === "caption" ||
      label === "figure title" ||
      label === "key message" ||
      /^caption\b/.test(label) ||
      /^figure title\b/.test(label) ||
      /\btakeaway\b/.test(label),
    );
  if (forbiddenBoxes.length === 0) return null;
  return `embeds caption/title/takeaway prose in the figure image layer: ${uniqueStrings(forbiddenBoxes).join(", ")}`;
}

function hasCompletedExternalValidation(paper) {
  const explicit = paper?.external_validation || paper?.independent_validation || paper?.validation_extension;
  if (explicit && typeof explicit === "object") {
    return explicit.passed === true || explicit.completed === true || explicit.status === "completed";
  }
  const supplementKeys = Object.keys(paper?.supplementary_tables || {}).join(" ");
  return /\b(independent|external|single[- ]?cell).*(validation|replication|cohort)\b/i.test(supplementKeys);
}

function paperEditorialRisk(paper) {
  if (!paper) {
    return {
      score_cap: 0,
      score_cap_reasons: ["no manuscript artifact exists"],
      warnings: [],
    };
  }
  const blob = JSON.stringify(paper || {});
  const limitations = asArray(paper?.limitations).join(" ");
  const availability = asArray(paper?.data_code_availability).join(" ");
  const contract = JSON.stringify(paper?.reviewer_contract || {});
  const caps = [];
  const warnings = [];
  const addCap = (scoreCap, reason) => {
    caps.push({ score_cap: scoreCap, reason });
    warnings.push(reason);
  };
  if (/(3-vs-3|n\s*=\s*3|n=3)/i.test(blob) && /(single-source|one public|public .*slice|public slice)/i.test(`${limitations} ${blob}`)) {
    addCap(94, "single public n=3-vs-n=3 slice limits high-impact editorial confidence even when internally reproducible");
  }
  if (!hasCompletedExternalValidation(paper) && /(independent cohort|orthogonal validation|not yet a population-level|before population-level|before broad mechanistic)/i.test(blob)) {
    addCap(92, "independent or orthogonal validation is still absent, so the manuscript cannot receive a near-perfect high-impact paper score");
  }
  if (/brief report\/research letter draft only|brief report \/ research letter candidate|brief_report/i.test(`${contract} ${blob}`)) {
    addCap(92, "manuscript is positioned as a narrow brief-report/research-letter candidate, not a fully validated high-impact original article");
  }
  if (/model-based reanalysis.*deferred|additional model.*deferred|complete upstream design metadata/i.test(blob)) {
    addCap(94, "additional model-based inference remains deferred because source design metadata are incomplete");
  }
  if (/ethics\/consent.*must be verified|must be verified from the source publication|not contained in the CSV slice/i.test(`${availability} ${blob}`)) {
    addCap(95, "journal-submission source ethics and consent metadata still require upstream verification");
  }
  const scoreCap = caps.length > 0
    ? Math.min(...caps.map((item) => item.score_cap))
    : 100;
  return {
    score_cap: scoreCap,
    score_cap_reasons: uniqueStrings(caps.map((item) => item.reason)),
    warnings: uniqueStrings(warnings),
    completed_external_validation: hasCompletedExternalValidation(paper),
  };
}

function paperFigureDeckQuality(paper) {
  const figureDeck = paper?.figure_deck && typeof paper.figure_deck === "object" ? paper.figure_deck : {};
  const manifestPath = figureDeck.manifest_path || null;
  const manifest = readJsonIfExists(manifestPath);
  const slides = asArray(manifest?.slides);
  const reasons = [];
  if (!figureDeck.pptx_path) reasons.push("paper needs a separate PPT figure deck for manuscript figures");
  if (!manifestPath || !manifest) reasons.push("figure deck manifest is missing or unreadable");
  if (manifest && manifest.pptx_generation_method !== "python-pptx") {
    reasons.push("figure deck PPTX must be generated with python-pptx to avoid PowerPoint repair errors");
  }
  if (!/svg/i.test(JSON.stringify(figureDeck)) || !/ppt/i.test(JSON.stringify(figureDeck))) {
    reasons.push("figure policy must keep artwork in SVG and editable text in PPT");
  }
  const boxSetFor = (figureId) => {
    const slide = slides.find((item) => item?.figure_id === figureId) || {};
    return new Set(asArray(slide.ppt_text_boxes).map((item) => String(item || "").toLowerCase()));
  };
  const requireBoxes = (figureId, labels) => {
    const boxes = boxSetFor(figureId);
    const missing = labels.filter((label) => !boxes.has(label.toLowerCase()));
    if (missing.length > 0) {
      reasons.push(`${figureId} is missing editable PPT text boxes: ${missing.join(", ")}`);
    }
  };
  if (slides.length > 0) {
    requireBoxes("figure-1-primary-signal", [
      "x axis title",
      "y axis title",
      "x tick negative",
      "x tick zero",
      "x tick positive",
      "y tick zero",
      "y tick five",
      "y tick ten",
      "threshold label",
    ]);
    requireBoxes("figure-2-validation-summary", [
      "y axis title",
      "y tick zero",
      "y tick ten",
      "y tick twenty",
    ]);
    const validationBoxes = boxSetFor("figure-2-validation-summary");
    const categoryLabelCount = Array.from(validationBoxes).filter((label) => label.startsWith("x category ")).length;
    const valueLabelCount = Array.from(validationBoxes).filter((label) => label.startsWith("value label ")).length;
    if (categoryLabelCount < 3 || valueLabelCount < 3) {
      reasons.push("figure-2-validation-summary needs at least three editable category labels and value labels in PPT");
    }
    const traceBoxes = boxSetFor("figure-3-evidence-trace");
    requireBoxes("figure-3-evidence-trace", [
      "x axis title",
      "x tick source",
      "x tick validation",
      "x tick review",
      "row label note",
    ]);
    const traceLabelCount = Array.from(traceBoxes).filter((label) => label.startsWith("trace label ")).length;
    if (traceLabelCount < 3) {
      reasons.push("figure-3-evidence-trace needs editable trace labels in PPT");
    }
    for (const slide of slides) {
      if (slide?.svg_contains_text_elements === true) {
        reasons.push(`${slide.figure_id || "figure"} embeds text in SVG artwork`);
      }
      if (!slide?.ppt_artwork_png_path || !fs.existsSync(String(slide.ppt_artwork_png_path))) {
        reasons.push(`${slide.figure_id || "figure"} is missing a PowerPoint-compatible PNG artwork layer generated from SVG`);
      }
      const embeddedProseBlocker = slideEmbeddedProseBlocker(slide);
      if (embeddedProseBlocker) {
        reasons.push(`${slide.figure_id || "figure"} ${embeddedProseBlocker}`);
      }
      const textQualityBlocker = slideTextQualityBlocker(slide);
      if (textQualityBlocker) {
        reasons.push(`${slide.figure_id || "figure"} ${textQualityBlocker}`);
      }
      const renderedQualityBlocker = slideRenderedImageQualityBlocker(slide);
      if (renderedQualityBlocker) {
        reasons.push(`${slide.figure_id || "figure"} ${renderedQualityBlocker}`);
      }
      if (!slide?.paper_image_png_path && !slide?.paper_image_svg_path) {
        reasons.push(`${slide.figure_id || "figure"} is missing a flattened manuscript image export from the PPT deck`);
      }
      if (!slide?.paper_image_png_path || !fs.existsSync(String(slide.paper_image_png_path))) {
        reasons.push(`${slide.figure_id || "figure"} is missing a PDF-compatible PNG manuscript export for LaTeX builds`);
      }
    }
  }
  return {
    manifest_path: manifestPath,
    slide_count: slides.length,
    complete: reasons.length === 0,
    reasons,
  };
}

function paperIntegrationQuality(paper) {
  if (!paper) {
    return {
      score: 0,
      passed: false,
      reasons: ["no manuscript artifact exists"],
      checks: [],
    };
  }
  const figureDeck = paper?.figure_deck && typeof paper.figure_deck === "object" ? paper.figure_deck : {};
  const manifest = readJsonIfExists(figureDeck.manifest_path || null);
  const slides = asArray(manifest?.slides);
  const panels = asArray(paper?.figure_panels);
  const reasons = [];
  const checks = [];
  const slideById = new Map(slides.map((slide) => [String(slide?.figure_id || ""), slide]).filter(([id]) => id));
  const slideExportPaths = new Set(
    slides.flatMap((slide) => [slide?.paper_image_png_path, slide?.paper_image_svg_path]).filter(Boolean).map(String),
  );
  const panelIds = panels
    .map((panel) => String(panel?.figure_id || panel?.panel_id || panel?.id || "").trim())
    .filter(Boolean);
  const panelImagePaths = panels
    .map((panel) => String(panel?.image_path || panel?.paper_image_path || panel?.paper_image_svg_path || panel?.paper_image_png_path || "").trim())
    .filter(Boolean);
  const latexCompatiblePanelPaths = panelImagePaths.filter((item) => /\.(png|jpe?g|pdf)$/i.test(item));

  // Owner decision: figures are not authored through a PowerPoint deck. The deck
  // manifest existed to keep the manuscript and the figures in step, so the check
  // now asks that of the artifacts that exist -- every panel is a figure the
  // paper carries, every figure is inserted, every image is on disk.
  if (panels.length < 3) reasons.push("paper integration needs at least three inserted figure panels");
  const figureIds = new Set(
    asArray(paper?.figures)
      .map((figure) => String(figure?.id || "").trim())
      .filter(Boolean),
  );
  if (figureIds.size > 0) {
    const panelsWithoutFigure = panelIds.filter((id) => !figureIds.has(id));
    if (panelsWithoutFigure.length > 0) {
      reasons.push(`inserted figure panels name no figure in the manuscript figure set: ${panelsWithoutFigure.join(", ")}`);
    }
    const figuresWithoutPanel = [...figureIds].filter((id) => !panelIds.includes(id));
    if (figuresWithoutPanel.length > 0) {
      reasons.push(`manuscript figures are not inserted as panels: ${figuresWithoutPanel.join(", ")}`);
    }
  }
  const missingImages = panelImagePaths.filter((item) => !fs.existsSync(item));
  if (missingImages.length > 0) {
    reasons.push("inserted figure panels point at images that are not on disk");
  }
  if (panelImagePaths.length > 0 && latexCompatiblePanelPaths.length !== panelImagePaths.length) {
    reasons.push("figure images must be PNG/JPEG/PDF for LaTeX insertion, not raw SVG");
  }
  for (const panel of panels) {
    const id = String(panel?.figure_id || panel?.panel_id || panel?.id || "figure panel");
    const explanation = String(panel?.detailed_explanation || "");
    const caption = String(panel?.caption || "");
    const sourceTables = asArray(panel?.source_tables || panel?.source_table_paths);
    if (explanation.length < 120) reasons.push(`${id} needs a detailed manuscript explanation beyond the caption`);
    if (!caption.trim()) reasons.push(`${id} needs a manuscript caption synchronized with the figure deck`);
    if (sourceTables.length === 0) reasons.push(`${id} needs source-table provenance in the paper metadata`);
  }
  checks.push({
    name: "manifest_linked",
    passed: Boolean(manifest && figureDeck.manifest_path),
    evidence: figureDeck.manifest_path || null,
  });
  checks.push({
    name: "inserted_figure_panels",
    passed: panels.length >= 3,
    evidence: panels.length,
  });
  checks.push({
    name: "panel_manifest_id_match",
    passed: panelIds.length === 0 || panelIds.every((id) => slideById.has(id)),
    evidence: panelIds,
  });
  checks.push({
    name: "ppt_export_image_match",
    passed: panelImagePaths.length === 0 || slideExportPaths.size === 0 || panelImagePaths.every((item) => slideExportPaths.has(item)),
    evidence: panelImagePaths,
  });
  checks.push({
    name: "latex_compatible_figure_exports",
    passed: panelImagePaths.length > 0 && latexCompatiblePanelPaths.length === panelImagePaths.length,
    evidence: panelImagePaths,
  });
  checks.push({
    name: "figure_explanation_and_provenance",
    passed: panels.length > 0 && panels.every((panel) => String(panel?.detailed_explanation || "").length >= 120 && asArray(panel?.source_tables || panel?.source_table_paths).length > 0),
    evidence: panels.map((panel) => ({
      figure_id: panel?.figure_id || panel?.panel_id || panel?.id || null,
      detailed_explanation_chars: String(panel?.detailed_explanation || "").length,
      source_table_count: asArray(panel?.source_tables || panel?.source_table_paths).length,
    })),
  });
  const score = gateAdjustedScore(
    62 +
      (manifest ? 8 : 0) +
      (slides.length >= 3 ? 8 : 0) +
      (panels.length >= 3 ? 8 : 0) +
      (panelIds.length > 0 && panelIds.every((id) => slideById.has(id)) ? 6 : 0) +
      (panelImagePaths.length > 0 && (slideExportPaths.size === 0 || panelImagePaths.every((item) => slideExportPaths.has(item))) ? 5 : 0) +
      (panelImagePaths.length > 0 && latexCompatiblePanelPaths.length === panelImagePaths.length ? 4 : 0) +
      (panels.length > 0 && panels.every((panel) => String(panel?.detailed_explanation || "").length >= 120) ? 5 : 0) +
      (panels.length > 0 && panels.every((panel) => asArray(panel?.source_tables || panel?.source_table_paths).length > 0) ? 4 : 0),
    reasons,
  );
  return {
    score,
    passed: Boolean(paper) && reasons.length === 0 && score >= HIGH_IMPACT_THRESHOLD,
    reasons: uniqueStrings(reasons),
    checks,
  };
}

function reportRubric(report) {
  const references = asArray(report?.references);
  const refQuality = referenceQuality(references, {
    minimumReferences: 4,
    minimumVerified: 3,
    minimumHighImpact: 1,
  });
  const findings = asArray(report?.key_findings);
  const limitations = asArray(report?.limitations);
  const nextTests = asArray(report?.recommended_next_tests);
  const metrics = report?.validation_metrics || {};
  const hasSensitivity = asArray(report?.sensitivity_summary).length >= 3;
  const artifactCount = Object.values(report?.evidence_artifacts || {}).filter(Boolean).length;
  return [
    scoreItem(
      "executive_decision_value",
      82 + (String(report?.executive_summary || "").length > 300 ? 10 : 0) + (nextTests.length >= 3 ? 8 : 0),
      [
        ...missingIf(String(report?.executive_summary || "").length > 300, "executive summary is too thin for high-impact decision review"),
        ...missingIf(nextTests.length >= 3, "recommended next tests are not concrete enough"),
      ],
    ),
    scoreItem(
      "claim_scope_discipline",
      80 + (/internally reproducible|dataset|slice|not.*population|hypothesis-generating/i.test(JSON.stringify(report)) ? 20 : 0),
      missingIf(/internally reproducible|dataset|slice|not.*population|hypothesis-generating/i.test(JSON.stringify(report)), "report does not sufficiently prevent population-level overclaiming"),
    ),
    scoreItem(
      "evidence_traceability",
      72 + Math.min(18, artifactCount * 6) + (Number(metrics.analysis_accuracy_score || 0) >= 90 ? 10 : 0),
      [
        ...missingIf(artifactCount >= 2, "report lacks enough direct artifact links for audit"),
        ...missingIf(Number(metrics.analysis_accuracy_score || 0) >= 90, "analysis accuracy evidence is not strong enough"),
      ],
    ),
    scoreItem(
      "quantitative_specificity",
      70 +
        (Number(metrics.primary_recompute_correlation || 0) > 0.75 ? 10 : 0) +
        (Number(metrics.primary_signal_count || 0) >= Number(metrics.secondary_signal_count || 0) ? 10 : 0) +
        (findings.length >= 4 ? 10 : 0),
      [
        ...missingIf(Number(metrics.primary_recompute_correlation || 0) > 0.75, "core recomputation or concordance metric is absent or weak"),
        ...missingIf(findings.length >= 4, "report needs at least four quantitative findings"),
      ],
    ),
    scoreItem(
      "bias_and_limitations",
      75 + Math.min(15, limitations.length * 4) + (/measurement|missing|single-source|model specification|source selection|external validity/i.test(limitations.join(" ")) ? 10 : 0),
      [
        ...missingIf(limitations.length >= 4, "limitations are too sparse for high-impact review"),
        ...missingIf(/measurement|missing|single-source|model specification|source selection|external validity/i.test(limitations.join(" ")), "key bias and validity threats are not explicit"),
      ],
    ),
    scoreItem(
      "literature_positioning",
      60 +
        Math.min(12, references.length * 3) +
        Math.min(12, refQuality.verified_article_reference_count * 3) +
        Math.min(10, refQuality.high_impact_reference_count * 5) +
        (refQuality.passed ? 6 : 0),
      [
        ...refQuality.blockers,
      ],
    ),
    scoreItem(
      "sensitivity_and_reporting",
      74 + (hasSensitivity ? 14 : 0) + (/STROBE|bias|missing/i.test(JSON.stringify(report)) ? 12 : 0),
      [
        ...missingIf(hasSensitivity, "FDR sensitivity summary is absent"),
        ...missingIf(/STROBE|bias|missing/i.test(JSON.stringify(report)), "reporting checklist and missing-data disclosure are absent"),
      ],
    ),
  ];
}

// A figure is reproducible when the script that drew it is still there and still
// says what it read. That is the property the deck rubric was standing in for,
// and the one the owner asked to keep: "the code has to stay so the figure can be
// rebuilt from the data at any time".
// Availability used to be scored by counting array entries: three or more and the
// statement was complete. That passed the TEMPLATE, whose three lines are
// "Primary runner result: <path>", "Generated artifacts are under <path>" and a
// sentence about archiving -- and it failed the author's own statement, two
// paragraphs naming every shipped artifact by its package name and telling a
// reader which script regenerates which number. Counting paragraphs measures
// formatting, and the one thing it reliably rewards is padding.
//
// So the check reads what the statement has to say: what ships, and how the
// reported numbers come back from it.
function availabilityCompleteness(availability) {
  const statement = availability.join(" ");
  const missing = [];
  if (statement.trim().length < 200) {
    missing.push("it is too short to say what ships and how to rebuild the numbers");
  }
  // No named services. `zenodo` and `figshare` were on this list, which means it
  // knew about two repositories and no others -- the same shape as the venue
  // whitelist that made high impact unreachable for a whole field. What the
  // statement has to do is point somewhere: a bundled path, a DOI or a URL, or
  // say in words where the material lives.
  const pointsSomewhere =
    /\b(?:artifacts?|supplement\w*|repositor\w*|archive\w*|dataset)\b/i.test(statement) ||
    /\bdoi\b|https?:\/\/|\b10\.\d{4,}\//i.test(statement);
  if (!pointsSomewhere) {
    missing.push("it does not name what ships with the submission or where a reader gets it");
  }
  if (!/regenerat|reproduc|re-?run|recomput|rebuild|script|command|notebook/i.test(statement)) {
    missing.push("it does not say how the reported numbers are regenerated from what ships");
  }
  return {
    satisfied: missing.length === 0,
    reason: `data/code availability statement is incomplete: ${missing.join("; ")}`,
  };
}

function reproducibleFigureQuality(paper) {
  const figures = asArray(paper?.figures);
  if (!figures.length) {
    return {
      every_figure_has_a_generator: false,
      every_figure_names_its_source: false,
      generators_on_disk: false,
      reasons: [],
    };
  }
  const withGenerator = figures.filter((item) => String(item?.generator || "").trim());
  const withSource = figures.filter((item) => String(item?.source_artifact || "").trim());
  const generatorsPresent = withGenerator.filter((item) => fs.existsSync(String(item.generator)));
  const reasons = [];
  if (withGenerator.length !== figures.length) {
    reasons.push("every figure must name the generator script that drew it");
  }
  if (withSource.length !== figures.length) {
    reasons.push("every figure must name the committed artifact it was drawn from");
  }
  if (withGenerator.length && generatorsPresent.length !== withGenerator.length) {
    const missing = withGenerator
      .filter((item) => !fs.existsSync(String(item.generator)))
      .map((item) => item.id || item.generator);
    reasons.push(`figure generators are not on disk, so these figures cannot be rebuilt: ${missing.slice(0, 3).join(", ")}`);
  }
  return {
    every_figure_has_a_generator: withGenerator.length === figures.length,
    every_figure_names_its_source: withSource.length === figures.length,
    generators_on_disk: Boolean(withGenerator.length) && generatorsPresent.length === withGenerator.length,
    reasons,
  };
}

function paperRubric(paper) {
  const abstract = paper?.abstract || {};
  const references = asArray(paper?.references);
  const methods = asArray(paper?.methods);
  const results = asArray(paper?.results);
  const limitations = asArray(paper?.limitations);
  const availability = asArray(paper?.data_code_availability);
  const availabilityComplete = availabilityCompleteness(availability);
  const figures = asArray(paper?.tables_and_figures);
  const figureDeck = paper?.figure_deck && typeof paper.figure_deck === "object" ? paper.figure_deck : {};
  const figureDeckQuality = paperFigureDeckQuality(paper);
  // Owner decision: figures are not produced through a PowerPoint deck. What the
  // review checks instead is that any figure can be rebuilt from the committed
  // data -- the generator exists, it is on disk, and it names what it read.
  const reproducibleFigures = reproducibleFigureQuality(paper);
  // The reference floor is the venue's, not a constant: a 17%-acceptance journal
  // and a workshop do not expect the same related work, and a fixed 5 was the
  // number that let a seven-reference manuscript reach 92.
  const venueStandard = calibratedPaperStandard(paper);
  const refQuality = referenceQuality(references, {
    minimumReferences: venueStandard.minimum_references,
    minimumVerified: venueStandard.minimum_verified,
    minimumHighImpact: venueStandard.minimum_high_impact,
  });
  const blob = JSON.stringify(paper || {});
  // Both requirements below were written for biomedical manuscripts. They are
  // waived only on evidence the author gathered from the venue itself, and only
  // for the part that is venue-specific; see document_reviews/venue_fit.js.
  const abstractCheck = abstractRequirement(paper, abstract);
  const coreResult = coreResultRequirement(paper);
  const hasCoreConcordance = coreResult.satisfied;
  return [
    highImpactPaperScoreItem(
      "title_abstract_framing",
      72 +
        (String(paper?.title || "").length > 40 ? 8 : 0) +
        (abstractCheck.satisfied ? 20 : 0),
      missingIf(abstractCheck.satisfied, abstractCheck.reason),
    ),
    highImpactPaperScoreItem(
      "imrad_structure",
      78 +
        (asArray(paper?.introduction).length >= 2 ? 5 : 0) +
        (methods.length >= 4 ? 7 : 0) +
        (results.length >= 4 ? 5 : 0) +
        (asArray(paper?.discussion).length >= 3 ? 5 : 0),
      [
        ...missingIf(methods.length >= 4, "methods are not detailed enough for reproduction"),
        ...missingIf(results.length >= 4, "results section is too thin"),
      ],
    ),
    highImpactPaperScoreItem(
      "methods_reproducibility",
      70 +
        (/source data|artifact path|validation metrics|sensitivity|model|preprocessing|threshold/i.test(blob) ? 20 : 0) +
        (/classification|checklist|secondary-analysis|audit/i.test(blob) ? 10 : 0),
      missingIf(/source data|artifact path|validation metrics|sensitivity|model|preprocessing|threshold/i.test(blob), "methods lack enough reproducible dataset/statistical detail"),
    ),
    highImpactPaperScoreItem(
      "statistical_reporting",
      72 +
        (hasCoreConcordance ? 8 : 0) +
        (/threshold|sensitivity|confidence|uncertainty|p[ -]?value|q[ -]?value|interval/i.test(blob) ? 10 : 0) +
        (/main signal|rival|negative control|validation burden|category/i.test(blob) ? 10 : 0),
      [
        ...missingIf(hasCoreConcordance, coreResult.reason || "core concordance result is missing"),
        ...missingIf(/threshold|sensitivity|confidence|uncertainty|p[ -]?value|q[ -]?value|interval/i.test(blob), "threshold, uncertainty, or sensitivity reporting is insufficient"),
      ],
    ),
    highImpactPaperScoreItem(
      "novelty_and_impact_positioning",
      70 +
        (/rival|alternative|mechanism|underexplored|non-obvious|validation target/i.test(blob) ? 12 : 0) +
        (/hypothesis-generating|independent|orthogonal|not.*population|external validity/i.test(blob) ? 12 : 0) +
        (refQuality.passed ? 6 : 0),
      [
        ...missingIf(/hypothesis-generating|independent|orthogonal|not.*population|external validity/i.test(blob), "paper does not clearly bound impact and next validation"),
        ...refQuality.blockers,
      ],
    ),
    highImpactPaperScoreItem(
      "limitations_and_ethics",
      75 + Math.min(15, limitations.length * 4) + (/single-source|measurement|missing|selection|model specification|external validity/i.test(limitations.join(" ")) ? 10 : 0),
      [
        ...missingIf(limitations.length >= 4, "limitations are underdeveloped"),
        ...missingIf(/single-source|measurement|missing|selection|model specification|external validity/i.test(limitations.join(" ")), "domain-general validity threats are not stated"),
      ],
    ),
    highImpactPaperScoreItem(
      "data_code_availability",
      75 + (availabilityComplete.satisfied ? 15 : 0) + (/source|artifact|classification|sensitivity|runtime|identifier/i.test(availability.join(" ")) ? 10 : 0),
      missingIf(availabilityComplete.satisfied, availabilityComplete.reason),
    ),
    highImpactPaperScoreItem(
      "tables_figures_submission_discipline",
      60 +
        Math.min(16, figures.length * 4) +
        (paper?.reviewer_contract?.no_overclaiming === true ? 4 : 0) +
        (reproducibleFigures.every_figure_has_a_generator ? 8 : 0) +
        (reproducibleFigures.every_figure_names_its_source ? 6 : 0) +
        (reproducibleFigures.generators_on_disk ? 6 : 0) +
        (asArray(paper?.figure_panels).length >= 3 ? 6 : 0) +
        (/detailed explanation/i.test(blob) || (asArray(paper?.figure_panels).length >= 3 && asArray(paper?.figure_panels).every((item) => String(item?.detailed_explanation || "").length > 120)) ? 4 : 0),
      [
        ...missingIf(figures.length >= 4, "paper needs a complete figure/table inventory"),
        ...missingIf(asArray(paper?.figure_panels).length >= 3, "paper must insert its figure images"),
        ...missingIf(asArray(paper?.figure_panels).every((item) => String(item?.detailed_explanation || "").length > 120), "paper needs detailed figure explanations, not captions only"),
        ...reproducibleFigures.reasons,
      ],
    ),
  ];
}

// "The document gates passed" was written down as "the research is approved".
//
// This function fires on the report gate and the paper gate alone, and stamped
// research_outcome: "approved". approval_review then short-circuits its entire
// staged ladder on that one field, and the supervisor writes a terminal
// APPROVAL_GATE_PASSED. So on cycle-g-v89 the moment the paper gate passed, the
// cycle recorded itself approved and stopped -- while its hypothesis gate held
// 129 blockers at score 46 and its conclusion gate was false.
//
// That contradicts the owner's own authorization for that cycle, which says in
// as many words: "Owner decision: document this cycle. The gate's reject stands
// and is not being rewritten", and forbids the paper from claiming the gate
// passed. The paper obeyed. The cycle's termination record did not.
//
// So the package now reports which gates passed rather than one word standing in
// for all of them. `approved` requires the hypothesis and conclusion gates too;
// a cycle documented under an authorization while the gate rejects is
// `documented`, and carries the verdict it was documented against.
function writeFinalClaimPackageIfReady({ root, cycleId, reportReview, paperReview }) {
  if (reportReview.report_gate_passed !== true || paperReview.paper_gate_passed !== true) return null;
  const outputPath = path.join(root, "state", `${cycleId}-final-claim-package.json`);
  const researcherView = readJsonIfExists(path.join(root, "researcher-views", `${cycleId}-researcher-view.json`)) || {};
  const lead = asArray(researcherView.focus_hypotheses).find((item) => item?.latest_status === "robust") || asArray(researcherView.focus_hypotheses)[0] || null;
  const gateReview = readJsonIfExists(path.join(root, "state", `${cycleId}-gate-review.json`));
  const conclusionReview = readJsonIfExists(path.join(root, "state", `${cycleId}-conclusion-review.json`));
  const hypothesisGatePassed = (gateReview?.review || gateReview)?.gate_passed === true;
  const conclusionGatePassed = (conclusionReview?.review || conclusionReview)?.conclusion_gate_passed === true;
  const authorization = readJsonIfExists(path.join(root, "state", `${cycleId}-document-authorization.json`));
  const researchApproved = hypothesisGatePassed && conclusionGatePassed;
  const packageJson = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    generated_by: "document-review-gate",
    execution_completion: "completed",
    research_outcome: researchApproved ? "approved" : "documented",
    decision_mode: researchApproved ? "approved" : "documented",
    // What the one word used to hide.
    hypothesis_gate_passed: hypothesisGatePassed,
    conclusion_gate_passed: conclusionGatePassed,
    documented_under_authorization: !researchApproved && authorization?.authorized === true
      ? { authorized_by: authorization.authorized_by || null, reason: authorization.reason || null }
      : null,
    lead_claim: lead?.statement || null,
    lead_hypothesis_id: lead?.hypothesis_id || null,
    report_review_path: path.join(root, "state", `${cycleId}-report-review.json`),
    paper_review_path: path.join(root, "state", `${cycleId}-paper-review.json`),
    report_path: reportReview.report_path || null,
    paper_path: paperReview.paper_path || null,
    high_impact_document_gates_passed: true,
  };
  writeJson(outputPath, packageJson);
  return outputPath;
}


configureDocumentReviewComments({ paperFigureDeckQuality });
configureDocumentReviewRequests({ paperFigureDeckQuality, paperIntegrationQuality });

function buildReportReview({ cwd = process.cwd(), cycleId, documentArtifacts = null }) {
  const root = runtimeRoot(cwd);
  const reportPath =
    documentArtifacts?.report_path ||
    latestVersionedJson(path.join(root, "reports"), `${cycleId}-research-report-`);
  const report = readJsonIfExists(reportPath);
  const rubric = report ? reportRubric(report) : [
    scoreItem("report_artifact_presence", 0, ["no research report JSON artifact exists"]),
  ];
  const score = average(rubric);
  const blockers = rubric
    .filter((item) => item.applicable !== false && Number(item.score || 0) < HIGH_IMPACT_THRESHOLD)
    .flatMap((item) => item.reasons.length ? item.reasons : [`${item.name} below high-impact threshold`]);
  const actions = followupActions("report", rubric);
  const reviewComments = buildReportReviewComments(report, rubric);
  const pass = Boolean(report) && blockers.length === 0 && score >= HIGH_IMPACT_THRESHOLD;
  const review = attachUnifiedReviewFields({
    ts: new Date().toISOString(),
    cycle_id: cycleId,
    type: "report_review",
    mode: pass ? "hold" : score >= 80 ? "nudge" : "refine",
    report_score: score,
    report_gate_passed: pass,
    communication_gate_passed: pass,
    report_path: reportPath,
    report_rubric: rubric,
    report_blockers: blockers,
    report_review_comments: reviewComments,
    section_review_comments: reviewComments,
    high_impact_standard: true,
    threshold: HIGH_IMPACT_THRESHOLD,
    recommended_followup_actions: actions,
  }, {
    score,
    pass,
    blockers,
    recommendedActions: actions,
    decisionMode: pass ? "approved" : "refine",
    decisionReason: pass ? "high-impact report gate passed" : blockers[0] || "report gate blockers remain",
  });
  const reviewPath = path.join(root, "state", `${cycleId}-report-review.json`);
  // Append the trajectory before the value is overwritten; this file is
  // rewritten on every refresh, so the previous score is otherwise gone.
  recordReviewSnapshot({ root, cycleId, kind: "report-review", review });
  writeJson(reviewPath, review);
  appendDialogueRow(root, cycleId, {
    ts: review.ts,
    event_type: "report_review",
    payload: review,
  });
  return { reviewPath, review };
}

function buildPaperReview({ cwd = process.cwd(), cycleId, documentArtifacts = null }) {
  const root = runtimeRoot(cwd);
  const paperPath =
    documentArtifacts?.paper_path ||
    latestVersionedJson(path.join(root, "papers"), `${cycleId}-paper-`);
  const paper = readJsonIfExists(paperPath);
  const rubric = paper ? paperRubric(paper) : [
    scoreItem("paper_artifact_presence", 0, ["no manuscript JSON artifact exists"]),
  ];
  const rawScore = average(rubric);
  const editorialRisk = paperEditorialRisk(paper);
  const reviewComments = buildPaperReviewComments(paper, rubric, editorialRisk);
  const analysisRequests = paperAnalysisRequests(paper, reviewComments);
  const referenceRequests = paperReferenceRequests(paper, reviewComments);
  const figureRequests = paperFigureProductionRequests(paper, reviewComments);
  // Two things the integrity checks never asked. What bar does the venue this
  // manuscript names actually hold, and does the manuscript claim anything.
  const standard = calibratedPaperStandard(paper);
  // A run the manuscript depends on that nobody has decided is a document
  // blocker: pressure on the decision without blocking the research loop.
  const undecided = undecidedExperimentFindings({ root, cycleId });
  const standardFindings = venueStandardFindings(paper)
    .concat(
      claimStrengthFindings(paper, {
        // The same ledger fact the undecided-request rule reads, so the two
        // cannot ask the author for opposite things.
        experimentChannelExhausted: Boolean(
          experimentChannelExhausted(readExperimentRequests({ root, cycleId }).requests),
        ),
      }),
    )
    .concat(undecided.blockers);
  const subgates = buildPaperSubgates({
    root,
    cycleId,
    paper,
    rubric,
    rawScore,
    editorialRisk,
    analysisRequests,
    referenceRequests,
    figureRequests,
    threshold: standard.gate_threshold,
    standardFindings,
  });
  const blockers = subgates.paperGate.blockers;
  const blockerAdjustedScore = gateAdjustedScore(rawScore, blockers);
  const score = subgates.paperGate.score;
  // An adopted experiment is analyst work, and this review's actions are the
  // path that already reaches the dispatcher. Without it the director could
  // adopt a request and nothing would ever design it.
  const actions = subgates.authorGate.recommended_followup_actions
    .concat(subgates.figureGate.recommended_followup_actions)
    .concat(subgates.integrationGate.recommended_followup_actions)
    .concat(adoptedExperimentFollowupActions({ root, cycleId }))
    .concat(undecided.actions);
  const pass = subgates.paperGate.passed;
  const review = attachUnifiedReviewFields({
    ts: new Date().toISOString(),
    cycle_id: cycleId,
    type: "paper_review",
    mode: pass ? "hold" : score >= 80 ? "nudge" : "refine",
    paper_score: score,
    paper_raw_score: rawScore,
    paper_blocker_adjusted_score: blockerAdjustedScore,
    paper_editorial_risk: editorialRisk,
    paper_gate_passed: pass,
    submission_gate_passed: pass,
    author_gate_passed: subgates.authorGate.passed,
    figure_gate_passed: subgates.figureGate.passed,
    figure_evidence_checks: subgates.figureGate.figure_evidence_checks || [],
    figure_verification_requests: subgates.figureGate.figure_verification_requests || [],
    paper_integration_gate_passed: subgates.integrationGate.passed,
    paper_path: paperPath,
    paper_rubric: rubric,
    paper_blockers: blockers,
    paper_review_comments: reviewComments,
    section_review_comments: reviewComments,
    paper_gate: subgates.paperGate,
    author_gate: subgates.authorGate,
    figure_gate: subgates.figureGate,
    paper_integration_gate: subgates.integrationGate,
    paper_gate_dependencies: subgates.paperGate.required_gates,
    paper_gate_status: subgates.paperGate.gate_status,
    analysis_requests: analysisRequests,
    reference_requests: referenceRequests,
    figure_production_requests: figureRequests,
    author_can_execute_analysis: true,
    additional_analysis_policy: {
      enabled: true,
      preferred_role: "author",
      scope: "review-driven manuscript analysis only",
      constraints: [
        "analysis must read existing source data or generated artifacts",
        "new biological claims require a newly written evidence artifact",
        "author responses must cite the review comment IDs they address",
      ],
    },
    high_impact_standard: true,
    threshold: standard.gate_threshold,
    venue_standard: standard,
    claim_strength: claimStrengthReport(paper),
    recommended_followup_actions: actions,
  }, {
    score,
    pass,
    blockers,
    recommendedActions: actions,
    decisionMode: pass ? "approved" : "refine",
    decisionReason: pass ? "high-impact manuscript gate passed" : blockers[0] || "paper subgate blockers remain",
  });
  const reviewPath = path.join(root, "state", `${cycleId}-paper-review.json`);
  // Append the trajectory before the value is overwritten; this file is
  // rewritten on every refresh, so the previous score is otherwise gone.
  recordReviewSnapshot({ root, cycleId, kind: "paper-review", review });
  writeJson(reviewPath, review);
  appendDialogueRow(root, cycleId, {
    ts: review.ts,
    event_type: "paper_review",
    payload: review,
  });
  writeFinalClaimPackageIfReady({ root, cycleId, reportReview: readJsonIfExists(path.join(root, "state", `${cycleId}-report-review.json`)) || {}, paperReview: review });
  return { reviewPath, review };
}

module.exports = {
  buildReportReview,
  buildPaperReview,
  writeFinalClaimPackageIfReady,
  reportRubric,
  paperRubric,
  paperFigureDeckQuality,
  paperIntegrationQuality,
  paperEditorialRisk,
  buildPaperSubgates,
  buildPaperReviewComments,
  paperAnalysisRequests,
  paperReferenceRequests,
  paperFigureProductionRequests,
};
