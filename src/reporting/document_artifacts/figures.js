"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueStrings(values, limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function figureNumberForId(figureId, index) {
  const match = String(figureId || "").match(/figure-(\d+)/i);
  return match ? Number(match[1]) : index + 1;
}

function latexCompatibleImagePath(imagePath) {
  const value = String(imagePath || "");
  if (!value) return "";
  if (/\.(png|jpe?g|pdf)$/i.test(value)) return value;
  if (/\.svg$/i.test(value)) {
    const pngPath = value.replace(/\.svg$/i, ".png");
    if (fs.existsSync(pngPath)) return pngPath;
  }
  return "";
}

function pdflatexCandidates() {
  return uniqueStrings([
    process.env.RESEARCHLAB_PDFLATEX,
    "pdflatex",
    "/workspace/.texlive/2026/bin/x86_64-linux/pdflatex",
  ]);
}

function findPdflatex() {
  for (const candidate of pdflatexCandidates()) {
    try {
      execFileSync(candidate, ["--version"], {
        timeout: 5000,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return candidate;
    } catch {
      // Keep PDF generation optional when TeX is not installed.
    }
  }
  return null;
}

function buildPaperPdf(paperTexPath) {
  const texPath = String(paperTexPath || "") ? path.resolve(String(paperTexPath)) : "";
  if (!texPath || !fs.existsSync(texPath)) {
    return {
      paper_pdf_path: null,
      paper_pdf_build: {
        attempted: false,
        passed: false,
        reason: "paper TeX file does not exist",
      },
    };
  }
  const pdfPath = texPath.replace(/\.tex$/i, ".pdf");
  const pdflatex = findPdflatex();
  if (!pdflatex) {
    return {
      paper_pdf_path: fs.existsSync(pdfPath) ? pdfPath : null,
      paper_pdf_build: {
        attempted: false,
        passed: false,
        reason: "pdflatex is not available",
      },
    };
  }
  const cwd = path.dirname(texPath);
  const args = [
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    `-output-directory=${cwd}`,
    texPath,
  ];
  let lastOutput = "";
  for (let pass = 1; pass <= 2; pass += 1) {
    try {
      const output = execFileSync(pdflatex, args, {
        cwd,
        timeout: 90000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      lastOutput = String(output || "");
    } catch (error) {
      lastOutput = [error.stdout, error.stderr].map((item) => String(item || "")).join("\n").trim();
      const errorLogPath = texPath.replace(/\.tex$/i, ".pdf-build-error.log");
      fs.writeFileSync(errorLogPath, lastOutput, "utf8");
      return {
        paper_pdf_path: fs.existsSync(pdfPath) ? pdfPath : null,
        paper_pdf_build: {
          attempted: true,
          passed: false,
          engine: pdflatex,
          pass,
          error_log_path: errorLogPath,
          reason: "pdflatex failed",
        },
      };
    }
  }
  const errorLogPath = texPath.replace(/\.tex$/i, ".pdf-build-error.log");
  if (fs.existsSync(errorLogPath)) fs.rmSync(errorLogPath, { force: true });
  return {
    paper_pdf_path: fs.existsSync(pdfPath) ? pdfPath : null,
    paper_pdf_build: {
      attempted: true,
      passed: fs.existsSync(pdfPath),
      engine: pdflatex,
      passes: 2,
      bytes: fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0,
      log_tail: lastOutput.split(/\r?\n/).slice(-8),
    },
  };
}

function gatekeeperApprovedForDraft(gate) {
  const review = gate?.gatekeeper_review || {};
  return (
    review.verdict === "approve" &&
    asArray(review.pending_rubrics).length === 0 &&
    asArray(gate?.gatekeeper_pending_rubrics).length === 0 &&
    asArray(gate?.challenge_questions).length === 0
  );
}

function documentRefinementEligible(gate) {
  if (!gate || typeof gate !== "object") return false;
  if (!gatekeeperApprovedForDraft(gate)) return false;
  if (gate.approval_gate_passed !== true) return false;
  if (gate.conclusion_gate_passed !== true) return false;
  const blockers = asArray(gate.blockers);
  const allowedBlocker = /(clarity|visual|figure|paper|manuscript|document|report|caption|source[- ]?table|insert)/i;
  return blockers.every((item) => allowedBlocker.test(String(item || "")));
}

function buildPaperFigurePanels({ figureDeck, paper, evidence }) {
  const manifest = readJsonIfExists(figureDeck?.manifest_path) || {};
  const slides = asArray(manifest.slides);
  return slides.map((slide, index) => {
    const number = figureNumberForId(slide.figure_id, index);
    const fallbackCaption = slide.caption || asArray(paper.figure_captions)[index]?.caption || "";
    const sourceTables = asArray(slide.source_tables);
    const titleText = `${slide.title || ""} ${fallbackCaption}`.toLowerCase();
    let detailed = "";
    if (/volcano|differential-expression anchor|primary quantitative signal/.test(titleText)) {
      detailed = "This panel is the quantitative entry point for the manuscript. It displays the strongest available feature-level or metric-level evidence with axis labels, thresholds, tick marks, and legend authored in the PPT text layer, so the inserted manuscript image matches the editable figure source while preserving a text-free SVG artwork layer.";
    } else if (/pathway|dominance|validation and rival-evidence summary/.test(titleText)) {
      detailed = "This panel is the central review-facing validation figure. It contrasts the main signal with rival, sensitivity, or background checks when those artifacts exist. Value labels and category labels remain editable PPT text boxes, making the figure auditable during manuscript revision.";
    } else if (/marker|cytotoxic/.test(titleText)) {
      detailed = "This panel is the main interpretation caveat. It shows that prespecified canonical NK and cytotoxicity markers do not move in one coherent direction, so the manuscript should not collapse the dataset-native signal into a simple cytotoxic activation or suppression narrative.";
    } else if (/evidence trace/.test(titleText)) {
      detailed = "This panel connects the promoted claim to source artifacts, validation status, and unresolved limitations. It is designed to prevent overclaiming by showing what has been directly tested, what remains inferred, and what follow-up validation is still required.";
    } else {
      detailed = `This manuscript figure was exported from the ResearchLab PPT figure deck. The editable source separates SVG artwork from PPT text boxes, while this inserted image is a flattened paper asset for journal review.`;
    }
    return {
      figure_number: number,
      figure_id: slide.figure_id,
      title: slide.title,
      image_path: slide.paper_image_png_path || slide.paper_image_svg_path || slide.svg_path,
      editable_ppt_source: figureDeck?.pptx_path || null,
      editable_manifest_source: figureDeck?.manifest_path || null,
      artwork_svg_source: slide.svg_path || null,
      caption: fallbackCaption,
      detailed_explanation: detailed,
      source_tables: sourceTables,
      insertion_policy: "insert flattened paper image in manuscript; keep editable source in PPT with SVG artwork and PPT text boxes",
    };
  });
}

function buildReportFigureSpec(figureDeck) {
  const manifest = readJsonIfExists(figureDeck?.manifest_path) || {};
  const slides = asArray(manifest.slides);
  if (slides.length === 0) return null;
  return {
    source: "paper_figure_deck_manifest",
    manifest_path: figureDeck?.manifest_path || null,
    pptx_path: figureDeck?.pptx_path || null,
    figures: slides.map((slide, index) => ({
      figure_id: slide.figure_id || `figure-${index + 1}`,
      title: slide.title || slide.figure_id || `Figure ${index + 1}`,
      caption: slide.caption || "",
      chart_type: "manuscript figure panel",
      priority: index === 0 ? "highest" : "high",
      image_path: slide.paper_image_png_path || slide.paper_image_svg_path || slide.svg_path || null,
      source_tables: asArray(slide.source_tables),
    })),
  };
}

module.exports = {
  figureNumberForId,
  latexCompatibleImagePath,
  pdflatexCandidates,
  findPdflatex,
  buildPaperPdf,
  gatekeeperApprovedForDraft,
  documentRefinementEligible,
  buildPaperFigurePanels,
  buildReportFigureSpec,
};
