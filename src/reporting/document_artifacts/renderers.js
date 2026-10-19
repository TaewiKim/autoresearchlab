"use strict";

const { latexCompatibleImagePath } = require("./figures");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function latexEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function renderReportMarkdown(report) {
  const refs = asArray(report.references)
    .map((item, index) => `${index + 1}. ${item.title || "Reference"}${item.year ? ` (${item.year})` : ""}${item.venue ? `. ${item.venue}` : ""}${item.doi ? `. DOI: ${item.doi}` : ""}${item.url ? `. ${item.url}` : ""}${item.reference_tier ? `. ${item.reference_tier}` : ""}`)
    .join("\n");
  const topFeatures = asArray(report.top_feature_results)
    .map((item) => {
      const label = item.feature_name || item.name || item.id || "feature";
      const value = item.effect_size ?? item["log2(fc)"] ?? item.value ?? item.score ?? "";
      const q = item.qval ?? item.p_value ?? item.pvalue ?? item.fdr ?? "";
      return `- ${label}${value !== "" ? `: value=${Number(value).toFixed(3)}` : ""}${q !== "" ? `, q/p=${Number(q).toExponential(3)}` : ""}`;
    })
    .join("\n");
  const norm = asArray(report.category_normalized_tests)
    .filter((item) => item.analysis_type === "all")
    .map((item) => `- ${item.class || item.category}: ${item.class_sig_fdr_lt_0_1 ?? item.significant_count ?? "n/a"}/${item.class_terms ?? item.term_count ?? "n/a"} signals; class rate=${Number(item.class_sig_rate || item.signal_rate || 0).toFixed(3)}, background rate=${Number(item.background_sig_rate || 0).toFixed(3)}, enrichment p=${item.fisher_exact_enrichment_p_value == null ? "n/a" : Number(item.fisher_exact_enrichment_p_value).toExponential(3)}`)
    .join("\n");
  const tables = Object.entries(report.supplementary_tables || {})
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n");
  const figures = asArray(report.figure_captions)
    .map((item) => `- ${item.figure_id}: ${item.file}. ${item.caption}`)
    .join("\n");
  const figureRegeneration =
    asArray(report.figures)
      .map((figure) =>
        [
          `- ${figure.id}`,
          `  - generator: ${figure.generator || "not recorded"}`,
          `  - source artifact: ${figure.source_artifact || "not recorded"}`,
        ].join("\n"),
      )
      .join("\n") || "- No figures have been generated yet.";
  return `# ${report.title}

## Executive Summary
${report.executive_summary}

## Lead Claim
${report.lead_claim}

## Key Findings
${report.key_findings.map((item) => `- ${item}`).join("\n")}

## Validation Metrics
- Blueprint passes: ${report.validation_metrics.blueprint_passes}
- Checks passed: ${report.validation_metrics.checks_passed_count}
- Method appropriateness score: ${report.validation_metrics.method_appropriateness_score}
- Analysis accuracy score: ${report.validation_metrics.analysis_accuracy_score}
- Primary recomputation/concordance metric: ${Number(report.validation_metrics.primary_recompute_correlation || 0).toFixed(3)}
- Primary/secondary signal counts: ${report.validation_metrics.primary_signal_count}:${report.validation_metrics.secondary_signal_count}

## Sensitivity
${asArray(report.sensitivity_summary).map((item) => `- ${item.class}: FDR<0.05=${item["sig_fdr_lt_0.05"]}, FDR<0.10=${item["sig_fdr_lt_0.1"]}, FDR<0.25=${item["sig_fdr_lt_0.25"]}`).join("\n") || "- Sensitivity table attached in evidence artifacts."}

## Quantitative Feature Anchors
${topFeatures || "- See supplementary feature table or runner artifact."}

## Class-Size Normalized Category Check
${norm || "- See supplementary category background-normalized table when available."}

${report.category_test_note || ""}

## Classification and Versioning
${asArray(report.classification_rules).map((item) => `- ${item.class}: \`${item.regex}\``).join("\n")}

${report.ontology_version_note || ""}

## Figure and Table Inventory
${figures || "- Figures are archived with the blueprint outputs."}

Figure regeneration:
${figureRegeneration}

Supplementary tables:
${tables || "- Supplementary tables are archived with the blueprint outputs."}

## Limitations
${report.limitations.map((item) => `- ${item}`).join("\n")}

## Model Feasibility and Sensitivity Note
${report.model_feasibility_note || "Not available."}

## Ethics and Accession Note
${report.ethics_note || ""}

${report.accession_note || ""}

## Literature Positioning
${asArray(report.reference_discussion_points).map((item) => `- ${item}`).join("\n") || "- References are used for context; they do not independently validate this slice."}

## Recommended Next Tests
${report.recommended_next_tests.map((item) => `- ${item}`).join("\n")}

## Evidence Artifacts
- Summary: ${report.evidence_artifacts.summary_md || "n/a"}
- Artifact directory: ${report.evidence_artifacts.artifact_dir || "n/a"}

## References
${refs || "No external references supplied; dataset and analysis artifacts are the primary sources."}
`;
}

function renderReportHtml(report) {
  const findings = report.key_findings.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const limits = report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const tests = report.recommended_next_tests.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const refs = asArray(report.references)
    .map((item) => `<li>${escapeHtml(item.title || "Reference")} ${item.year ? `(${escapeHtml(item.year)})` : ""}${item.url ? ` <a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>` : ""}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(report.title)}</title><style>
body{margin:0;background:#f7f2ea;color:#1f2937;font-family:Georgia,'Iowan Old Style',serif;line-height:1.55}
main{max-width:1080px;margin:0 auto;padding:42px 22px 64px}
.hero,.panel{background:#fffdf8;border:1px solid #ddd2c2;border-radius:24px;box-shadow:0 20px 45px rgba(17,24,39,.08)}
.hero{padding:34px;margin-bottom:18px;background:linear-gradient(135deg,rgba(10,95,83,.12),#fffdf8)}
.eyebrow{text-transform:uppercase;letter-spacing:.14em;color:#69716d;font-size:12px}
h1{font-size:38px;line-height:1.08;margin:.25em 0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{padding:16px;border-radius:16px;background:#fbf8f0;border:1px solid #e4d8c8}.metric b{display:block;font-size:26px}.panel{padding:24px;margin-top:18px}a{color:#0f766e}@media(max-width:820px){.grid{grid-template-columns:1fr}h1{font-size:30px}}
  </style></head><body><main><section class="hero"><div class="eyebrow">High-Impact Report Gate Candidate</div><h1>${escapeHtml(report.title)}</h1><p>${escapeHtml(report.executive_summary)}</p><div class="grid"><div class="metric">Checks<b>${escapeHtml(report.validation_metrics.checks_passed_count)}</b></div><div class="metric">Method<b>${escapeHtml(report.validation_metrics.method_appropriateness_score)}</b></div><div class="metric">Accuracy<b>${escapeHtml(report.validation_metrics.analysis_accuracy_score)}</b></div><div class="metric">Signals<b>${escapeHtml(`${report.validation_metrics.primary_signal_count}:${report.validation_metrics.secondary_signal_count}`)}</b></div></div></section><section class="panel"><h2>Lead Claim</h2><p>${escapeHtml(report.lead_claim)}</p></section><section class="panel"><h2>Key Findings</h2><ul>${findings}</ul></section><section class="panel"><h2>Limitations</h2><ul>${limits}</ul></section><section class="panel"><h2>Recommended Next Tests</h2><ul>${tests}</ul></section><section class="panel"><h2>References</h2><ol>${refs || "<li>Dataset and generated analysis artifacts.</li>"}</ol></section></main></body></html>`;
}

function renderPaperMarkdown(paper) {
  const abstract = paper.abstract;
  const refs = asArray(paper.references)
    .map((item, index) => `${index + 1}. ${item.title || "Reference"}${item.year ? ` (${item.year})` : ""}${item.venue ? `. ${item.venue}` : ""}${item.doi ? `. DOI: ${item.doi}` : ""}${item.url ? `. ${item.url}` : ""}${item.reference_tier ? `. ${item.reference_tier}` : ""}`)
    .join("\n");
  const topFeatures = asArray(paper.top_feature_results)
    .map((item) => {
      const label = item.feature_name || item.name || item.id || "feature";
      const value = item.effect_size ?? item["log2(fc)"] ?? item.value ?? item.score ?? "";
      const q = item.qval ?? item.p_value ?? item.pvalue ?? item.fdr ?? "";
      return `- ${label}${value !== "" ? `: value=${Number(value).toFixed(3)}` : ""}${q !== "" ? `, q/p=${Number(q).toExponential(3)}` : ""}`;
    })
    .join("\n");
  const validationPanels = asArray(paper.validation_panels)
    .map((item) => `- ${item.label || item.feature_name || item.name || "validation item"}${item.value == null ? "" : `: ${item.value}`}`)
    .join("\n");
  const normalized = asArray(paper.category_normalized_tests)
    .map((item) => `- ${item.analysis_type || "analysis"}/${item.class || item.category || "category"}: ${item.class_sig_fdr_lt_0_1 ?? item.significant_count ?? "n/a"}/${item.class_terms ?? item.term_count ?? "n/a"} signals; class rate=${Number(item.class_sig_rate || item.signal_rate || 0).toFixed(3)}, background=${Number(item.background_sig_rate || 0).toFixed(3)}, enrichment p=${item.fisher_exact_enrichment_p_value == null ? "n/a" : Number(item.fisher_exact_enrichment_p_value).toExponential(3)}`)
    .join("\n");
  const rules = asArray(paper.classification_rules)
    .map((item) => `- ${item.class}: \`${item.regex}\``)
    .join("\n");
  const checks = asArray(paper.validation_checklist)
    .map((item) => `- ${item.check_id}: ${item.passed ? "pass" : "fail"}`)
    .join("\n");
  const figures = asArray(paper.figure_captions)
    .map((item) => `- ${item.figure_id}: ${item.file}. ${item.caption}`)
    .join("\n");
  const figurePanels = asArray(paper.figure_panels)
    .map((panel) => {
      const sourceTables = asArray(panel.source_tables).map((item) => `  - ${item}`).join("\n");
      return `### Figure ${panel.figure_number}. ${panel.title || panel.figure_id}
![Figure ${panel.figure_number}: ${panel.title || panel.figure_id}](${panel.image_path})

**Caption:** ${panel.caption}

**Detailed explanation:** ${panel.detailed_explanation}

**Source tables:**
${sourceTables || "  - No source table was recorded for this figure."}`;
    })
    .join("\n\n");
  // The supplement is where a reader checks the work rather than follows the
  // argument, so each item states what it holds and why it is not in the main
  // text -- a bare filename was what the template used to print.
  const supplementary =
    asArray(paper.supplementary_material)
      .map((item) =>
        [
          `**${item.id || "S"}. ${item.title || "Supplementary item"}** (${item.kind || "item"})`,
          "",
          item.what_it_contains || "",
          item.why_not_in_main_text ? `\n*Why supplementary:* ${item.why_not_in_main_text}` : "",
          item.source_artifact ? `\n*Source:* ${item.source_artifact}` : "",
          asArray(item.columns).length
            ? `\n*Columns:*\n${asArray(item.columns).map((column) => `  - ${column}`).join("\n")}`
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      .join("\n\n") || "- No supplementary material has been written yet.";
  // Owner decision: figures are not authored through a PowerPoint deck. What the
  // manuscript records instead is how each figure is rebuilt, so the figure
  // outlives the run that produced it.
  const figureRegeneration =
    asArray(paper.figures)
      .map((figure) =>
        [
          `- ${figure.id}`,
          `  - generator: ${figure.generator || "not recorded"}`,
          `  - source artifact: ${figure.source_artifact || "not recorded"}`,
        ].join("\n"),
      )
      .join("\n") || "- No figures have been generated yet.";
  const tables = Object.entries(paper.supplementary_tables || {})
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n");
  return `# ${paper.title}

## Abstract
**Background:** ${abstract.background}

**Methods:** ${abstract.methods}

**Results:** ${abstract.results}

**Interpretation:** ${abstract.interpretation}

## Introduction
${paper.introduction.map((item) => `${item}`).join("\n\n")}

## Methods
${paper.methods.map((item) => `${item}`).join("\n\n")}

## Results
${paper.results.map((item) => `- ${item}`).join("\n")}

## Discussion
${paper.discussion.map((item) => `${item}`).join("\n\n")}

## Limitations
${paper.limitations.map((item) => `- ${item}`).join("\n")}

## Data and Code Availability
${paper.data_code_availability.map((item) => `- ${item}`).join("\n")}

## Tables and Figures
${paper.tables_and_figures.map((item) => `- ${item}`).join("\n")}

### Figure Regeneration
${figureRegeneration}

## Supplementary Material
${supplementary}

### Inserted Manuscript Figures
${figurePanels || "- No manuscript figure images have been emitted yet."}

### Figure Captions
${figures || "- Figure captions are archived with the report package."}

## Supplementary Quantitative Feature Results
${topFeatures || "- See supplementary feature table."}

## Validation Panels
${validationPanels || "- See supplementary validation panel definition."}

## Classification Rules
${rules || "- See supplementary classification terms."}

${paper.ontology_version_note || ""}

## Class-Size-Normalized Category Tests
${normalized || "- See supplementary category background-normalized tests."}

${paper.category_test_note || ""}

## Validation Checklist
${checks || "- See supplementary validation checklist."}

## Supplementary Tables
${tables || "- Supplementary tables are archived with the blueprint outputs."}

## Additional Model Feasibility
${paper.model_feasibility_note || "Additional model-based reanalysis is deferred unless source data and design metadata support it."}

## Ethics and Source Accession
${paper.ethics_note || ""}

${paper.accession_note || ""}

## References
Reference verification policy: at least ${paper.reference_quality?.policy?.minimum_article_references || 5} article references, ${paper.reference_quality?.policy?.minimum_verified_article_references || 4} verified article references, and ${paper.reference_quality?.policy?.minimum_high_impact_references || 2} high-impact journal references are required by papergate.

${refs || "No external references supplied; dataset and analysis artifacts are the primary sources."}
`;
}

function renderPaperTex(paper) {
  const refs = asArray(paper.references)
    .map((item) => `\\item ${latexEscape(item.title || "Reference")}${item.year ? ` (${latexEscape(item.year)})` : ""}${item.venue ? `. ${latexEscape(item.venue)}` : ""}${item.doi ? `. DOI: ${latexEscape(item.doi)}` : ""}${item.url ? `. \\url{${latexEscape(item.url)}}` : ""}${item.reference_tier ? `. ${latexEscape(item.reference_tier)}` : ""}`)
    .join("\n");
  // `\begin{itemize}` with no `\item` is a fatal LaTeX error, so a section the
  // author left empty took the whole PDF down with "Something's wrong--perhaps a
  // missing \item". This surfaced the moment pdflatex became available: the
  // manuscript had never been compiled, so nobody knew it could not be.
  //
  // The placeholder says what is missing rather than hiding it. The rubric still
  // fails the empty section, which is where the author reads that it is missing;
  // the document's job here is to build so the rest can be reviewed at all.
  // What replaces the deck listing: how each figure is rebuilt. `\seqsplit` is
  // not loaded here, so long paths are wrapped in \texttt and allowed to break
  // rather than running past the margin -- five Overfull \hbox warnings in the
  // first compiled PDF came from exactly this kind of unbreakable string.
  const figureRegenerationTex =
    asArray(paper.figures)
      .map((figure) =>
        [
          `\\item \\textbf{${latexEscape(figure.id)}}`,
          `\\newline generator: \\path{${String(figure.generator || "not recorded")}}`,
          `\\newline source artifact: \\path{${String(figure.source_artifact || "not recorded")}}`,
        ].join("\n"),
      )
      .join("\n") || `\\item ${latexEscape("No figures have been generated yet.")}`;
  const supplementaryTex =
    asArray(paper.supplementary_material)
      .map((item) =>
        [
          `\\subsection*{${latexEscape(`${item.id || "S"}. ${item.title || "Supplementary item"}`)}}`,
          latexEscape(item.what_it_contains || ""),
          item.why_not_in_main_text
            ? `\\par\\emph{Why supplementary:} ${latexEscape(item.why_not_in_main_text)}`
            : "",
          item.source_artifact
            ? `\\par\\emph{Source:} \\path{${String(item.source_artifact)}}`
            : "",
          asArray(item.columns).length
            ? [
                "\\begin{itemize}",
                asArray(item.columns).map((column) => `\\item ${latexEscape(column)}`).join("\n"),
                "\\end{itemize}",
              ].join("\n")
            : "",
        ]
          .filter((line) => line !== "")
          .join("\n"),
      )
      .join("\n") || latexEscape("No supplementary material has been written yet.");
  const itemize = (items) => {
    const rows = asArray(items).map((item) => `\\item ${latexEscape(item)}`);
    return rows.length ? rows.join("\n") : "\\item[] \\emph{This section has not been written yet.}";
  };
  const figurePanels = asArray(paper.figure_panels)
    .map((panel) => {
      const pathForTex = latexCompatibleImagePath(panel.image_path);
      const image = pathForTex
        ? `\\includegraphics[width=0.95\\linewidth]{\\detokenize{${pathForTex}}}`
        : latexEscape(`No PDF-compatible paper image export available for ${panel.figure_id || "figure panel"}.`);
      return `\\begin{figure}[htbp]
\\centering
${image}
\\caption{${latexEscape(`${panel.title || panel.figure_id}. ${panel.caption} ${panel.detailed_explanation}`)}}
\\end{figure}`;
    })
    .join("\n\n");
  // pdfTeX stamps the absolute source path of every INCLUDED PDF into
  // /PTEX.FileName in the output bytes. The figure paths here run through
  // `.research-lab/lanes/<cycle>/illustrator-01/figures/`, so under a
  // double-anonymous venue that is the reviewer reading the submitting group's
  // directory layout. The author contract has required this flag since the
  // clause was written; the template that actually emits the TeX never had it,
  // which is why the requirement had never once been met.
  //
  // Today's figures are PNG, which carries no path, so the leak is latent rather
  // than live -- one PDF figure turns it on.
  const anonymous = /double.?anonymous|double.?blind/i.test(
    String(paper?.target_venue?.format?.anonymity || ""),
  );
  return `\\documentclass[11pt]{article}
\\pdfsuppressptexinfo=-1
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}
\\usepackage{booktabs}
\\usepackage{graphicx}
\\usepackage{url}
% \\path refuses to break by default, which turned five overfull lines into
% thirteen. Allowing breaks at path separators is what makes a long artifact
% path fit the column instead of running into the margin.
\\def\\UrlBreaks{\\do\\/\\do\\-\\do\\_\\do\\.\\do\\a\\do\\b\\do\\c\\do\\d\\do\\e\\do\\f\\do\\g\\do\\h\\do\\i\\do\\j\\do\\k\\do\\l\\do\\m\\do\\n\\do\\o\\do\\p\\do\\q\\do\\r\\do\\s\\do\\t\\do\\u\\do\\v\\do\\w\\do\\x\\do\\y\\do\\z\\do\\0\\do\\1\\do\\2\\do\\3\\do\\4\\do\\5\\do\\6\\do\\7\\do\\8\\do\\9}
\\sloppy
\\title{${latexEscape(paper.title)}}
\\author{${anonymous ? "Anonymous submission" : "ResearchLab"}}
\\date{${latexEscape(new Date().toISOString().slice(0, 10))}}
\\begin{document}
\\maketitle
\\begin{abstract}
\\textbf{Background:} ${latexEscape(paper.abstract.background)}
\\textbf{Methods:} ${latexEscape(paper.abstract.methods)}
\\textbf{Results:} ${latexEscape(paper.abstract.results)}
\\textbf{Interpretation:} ${latexEscape(paper.abstract.interpretation)}
\\end{abstract}
\\section{Introduction}
${paper.introduction.map(latexEscape).join("\n\n")}
\\section{Methods}
${paper.methods.map(latexEscape).join("\n\n")}
\\section{Results}
\\begin{itemize}
${itemize(paper.results)}
\\end{itemize}
\\section{Discussion}
${paper.discussion.map(latexEscape).join("\n\n")}
\\section{Limitations}
\\begin{itemize}
${itemize(paper.limitations)}
\\end{itemize}
\\section{Data and Code Availability}
\\begin{itemize}
${itemize(paper.data_code_availability)}
\\end{itemize}
\\section{Tables and Figures}
\\begin{itemize}
${itemize(paper.tables_and_figures)}
\\end{itemize}
\\section{Supplementary Material}
${supplementaryTex}
\section{Figure Regeneration}
\\begin{itemize}
${figureRegenerationTex}
\\end{itemize}
\\section{Inserted Manuscript Figures}
${figurePanels || latexEscape("No manuscript figure images have been emitted yet.")}
\\section{References}
\\begin{itemize}
${refs || "\\item Dataset and generated analysis artifacts."}
\\end{itemize}
\\end{document}
`;
}

module.exports = {
  renderReportMarkdown,
  renderReportHtml,
  renderPaperMarkdown,
  renderPaperTex,
};
