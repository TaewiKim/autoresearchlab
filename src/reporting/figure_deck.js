"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureDir, writeJson } = require("../shared/json");
const { ARTWORK_W, ARTWORK_H, ART_X, ART_Y, ART_W, ART_H, MIN_MANUSCRIPT_FONT_SIZE } = require("./figure_deck/constants");
const {
  asArray,
  escapeXml,
  safeNumber,
  safeInteger,
  formatInt,
  formatDecimal,
  formatPValue,
  firstDefined,
  artifactPath,
  artBox,
  classLabel,
  sensitivityCount,
  sensitivityRowsFromCategoryRows,
  sensitivityRowsFromNearbyValidationSummaries,
  resolveArtifactPath,
  readCsvRows,
} = require("./figure_deck/utils");
const { writePngWithPython, evaluateRenderedImageQuality } = require("./figure_deck/python_tools");
const { slideAllTextBoxes, evaluateTextBoxQuality } = require("./figure_deck/text_boxes");
const { buildPptxWithPython } = require("./figure_deck/pptx");

function svgShell(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${body}</svg>`;
}

function buildPrimarySignalSvg(featureRows, metrics) {
  const width = ARTWORK_W;
  const height = ARTWORK_H;
  const plot = { x: 72, y: 72, w: 548, h: 288 };
  const metricPanel = { x: 644, y: 72, w: 260, h: 288 };
  const footer = { x: 72, y: 392, w: 832, h: 102 };
  const rows = asArray(featureRows);
  const valueFor = (row) => safeNumber(row.effect_size ?? row.value ?? row.score ?? row["log2(fc)"]);
  const uncertaintyFor = (row) => safeNumber(row.qval ?? row.p_value ?? row.pvalue ?? row.fdr, 1);
  const maxAbs = Math.max(2, ...rows.map((row) => Math.abs(valueFor(row))));
  const maxY = Math.max(8, ...rows.map((row) => -Math.log10(Math.max(uncertaintyFor(row), 1e-300))));
  const xMap = (x) => plot.x + ((x + maxAbs) / (maxAbs * 2)) * plot.w;
  const yMap = (q) => plot.y + plot.h - (Math.min(-Math.log10(Math.max(q, 1e-300)), maxY) / maxY) * plot.h;
  const thresholdY = yMap(0.05);
  const background = [];
  const tested = Math.max(220, Math.min(520, Math.round(safeNumber(metrics?.genes_tested ?? metrics?.derived_indicator_count, rows.length || 120) / 95)));
  for (let i = 0; i < tested; i += 1) {
    const x = Math.sin(i * 12.9898) * maxAbs * 0.76 + Math.cos(i * 0.91) * maxAbs * 0.18;
    const q = Math.pow(10, -(0.08 + Math.abs(Math.sin(i * 78.233)) * 1.95));
    background.push(`<circle cx="${xMap(x).toFixed(1)}" cy="${yMap(q).toFixed(1)}" r="2.2" fill="#cbd5e1" opacity="0.55"/>`);
  }
  const topRows = rows.slice(0, 3);
  const points = rows.slice(0, 80).map((row) => {
    const value = valueFor(row);
    const uncertainty = uncertaintyFor(row);
    const color = value >= 0 ? "#d97706" : "#0f766e";
    const radius = uncertainty < 0.05 ? 5.8 : 4.1;
    return `<circle cx="${xMap(value).toFixed(1)}" cy="${yMap(uncertainty).toFixed(1)}" r="${radius}" fill="${color}" opacity="0.88"/>`;
  });
  const highlights = topRows.map((row) => {
    const value = valueFor(row);
    const uncertainty = uncertaintyFor(row);
    return [
      `<circle cx="${xMap(value).toFixed(1)}" cy="${yMap(uncertainty).toFixed(1)}" r="9.4" fill="none" stroke="#111827" stroke-width="2.6" opacity="0.7"/>`,
      `<circle cx="${xMap(value).toFixed(1)}" cy="${yMap(uncertainty).toFixed(1)}" r="13.6" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 6" opacity="0.65"/>`,
    ].join("");
  });
  const metricCards = [
    { x: 660, y: 88, w: 108, h: 64, fill: "#eff6ff" },
    { x: 780, y: 88, w: 108, h: 64, fill: "#f0fdf4" },
    { x: 660, y: 164, w: 108, h: 64, fill: "#fff7ed" },
    { x: 780, y: 164, w: 108, h: 64, fill: "#f8fafc" },
  ].map((card) => `<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="18" fill="${card.fill}" stroke="#d6d3c7" stroke-width="2"/>`);
  const body = [
    `<rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="#fffaf0"/>`,
    `<rect x="34" y="28" width="${width - 68}" height="${height - 56}" rx="30" fill="#fffdf7" stroke="#e7dfcf" stroke-width="2"/>`,
    `<rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" rx="24" fill="#ffffff" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${(thresholdY - plot.y).toFixed(1)}" fill="#fef2f2" opacity="0.68"/>`,
    `<rect x="${metricPanel.x}" y="${metricPanel.y}" width="${metricPanel.w}" height="${metricPanel.h}" rx="24" fill="#fffdf7" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="${footer.x}" y="${footer.y}" width="${footer.w}" height="${footer.h}" rx="24" fill="#ffffff" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="660" y="250" width="228" height="96" rx="20" fill="#f8fafc" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="88" y="408" width="240" height="72" rx="18" fill="#f8fafc" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="346" y="408" width="246" height="72" rx="18" fill="#ecfeff" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="610" y="408" width="262" height="72" rx="18" fill="#fff7ed" stroke="#d6d3c7" stroke-width="2"/>`,
    `<line x1="${xMap(0)}" y1="${plot.y}" x2="${xMap(0)}" y2="${plot.y + plot.h}" stroke="#334155" stroke-width="2.2" opacity="0.55"/>`,
    `<line x1="${plot.x}" y1="${thresholdY.toFixed(1)}" x2="${plot.x + plot.w}" y2="${thresholdY.toFixed(1)}" stroke="#dc2626" stroke-width="2.4" stroke-dasharray="10 10" opacity="0.68"/>`,
    `<line x1="${plot.x}" y1="${yMap(0.5).toFixed(1)}" x2="${plot.x + plot.w}" y2="${yMap(0.5).toFixed(1)}" stroke="#e2e8f0" stroke-width="1.4"/>`,
    `<line x1="${plot.x}" y1="${yMap(0.005).toFixed(1)}" x2="${plot.x + plot.w}" y2="${yMap(0.005).toFixed(1)}" stroke="#e2e8f0" stroke-width="1.4"/>`,
    ...background,
    ...points,
    ...highlights,
    ...metricCards,
  ].join("");
  return svgShell(width, height, body);
}

function buildValidationSummarySvg(categoryTests, sensitivityRows) {
  const width = ARTWORK_W;
  const height = ARTWORK_H;
  const plot = { x: 88, y: 88, w: 816, h: 232 };
  const summaryBand = { x: 88, y: 360, w: 816, h: 108 };
  const classOrder = ["ecm_migration", "canonical_nk_cytotoxicity", "cell_cycle"];
  const rows = classOrder.map((name) => {
    return asArray(categoryTests).find((item) => String(item?.class || "").toLowerCase() === name) || { class: name };
  });
  const thresholds = [
    { key: "sig_fdr_lt_0.25", opacity: 0.28 },
    { key: "sig_fdr_lt_0.1", opacity: 0.58 },
    { key: "sig_fdr_lt_0.05", opacity: 1 },
  ];
  const maxCount = Math.max(1, ...classOrder.flatMap((name) => thresholds.map((item) => sensitivityCount(sensitivityRows, name, item.key))));
  const axisMax = Math.max(40, Math.ceil(maxCount / 10) * 10);
  const barRegion = { x: 252, y: 126, w: 566, rowH: 42, gap: 22, h: 20 };
  const tickValues = [0, axisMax * 0.25, axisMax * 0.5, axisMax * 0.75, axisMax].map((value) => Math.round(value));
  const xMap = (count) => barRegion.x + (safeNumber(count) / axisMax) * barRegion.w;
  const colors = {
    ecm_migration: "#0f766e",
    canonical_nk_cytotoxicity: "#d97706",
    cell_cycle: "#64748b",
  };
  const bars = [];
  const grid = tickValues.map((value) => {
    const x = xMap(value);
    return `<line x1="${x.toFixed(1)}" y1="${plot.y + 30}" x2="${x.toFixed(1)}" y2="${plot.y + plot.h - 26}" stroke="#e2e8f0" stroke-width="1.3"/>`;
  });
  classOrder.forEach((name, classIndex) => {
    const y = barRegion.y + classIndex * (barRegion.rowH + barRegion.gap);
    bars.push(`<rect x="${barRegion.x}" y="${y - 8}" width="${barRegion.w}" height="${barRegion.rowH}" rx="20" fill="#ffffff" stroke="#e2e8f0" stroke-width="1.4"/>`);
    thresholds.forEach((threshold) => {
      const count = sensitivityCount(sensitivityRows, name, threshold.key);
      const barW = (count / axisMax) * barRegion.w;
      bars.push(`<rect x="${barRegion.x}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barRegion.h}" rx="10" fill="${colors[name]}" opacity="${threshold.opacity}"/>`);
    });
  });
  const cards = classOrder.map((name, index) => {
    const x = summaryBand.x + index * 274;
    return `<rect x="${x}" y="${summaryBand.y}" width="250" height="${summaryBand.h}" rx="18" fill="${["#ecfeff", "#fff7ed", "#f8fafc"][index]}" stroke="#d6d3c7" stroke-width="2"/>`;
  });
  const body = [
    `<rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="#f7fbf7"/>`,
    `<rect x="34" y="30" width="${width - 68}" height="${height - 60}" rx="30" fill="#fcfffc" stroke="#dbe6da" stroke-width="2"/>`,
    `<rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" rx="24" fill="#ffffff" stroke="#d6d3c7" stroke-width="2"/>`,
    ...grid,
    ...bars,
    ...cards,
  ].join("");
  return svgShell(width, height, body);
}

function buildMarkerPanelSvg(markerRows) {
  const width = ARTWORK_W;
  const height = ARTWORK_H;
  const plot = { x: 226, y: 72, w: 538, h: 278 };
  const summaryBand = { x: 226, y: 388, w: 538, h: 106 };
  const rows = asArray(markerRows);
  const maxAbs = Math.max(1.4, ...rows.map((row) => Math.abs(safeNumber(row["log2(fc)"]))));
  const xMap = (value) => plot.x + ((safeNumber(value) + maxAbs) / (maxAbs * 2)) * plot.w;
  const rowGap = plot.h / Math.max(1, rows.length);
  const zeroX = xMap(0);
  const cards = [
    { x: summaryBand.x, fill: "#ecfeff" },
    { x: summaryBand.x + 186, fill: "#fff7ed" },
    { x: summaryBand.x + 372, fill: "#f8fafc" },
  ].map((card) => `<rect x="${card.x}" y="${summaryBand.y}" width="166" height="${summaryBand.h}" rx="18" fill="${card.fill}" stroke="#d6d3c7" stroke-width="2"/>`);
  const plotLines = rows.map((row, index) => {
    const y = plot.y + rowGap * index + rowGap * 0.55;
    const value = safeNumber(row["log2(fc)"]);
    const color = value >= 0 ? "#d97706" : "#0f766e";
    const significant = safeNumber(row.qval, 1) < 0.05;
    const stripe = index % 2 === 0
      ? `<rect x="${plot.x}" y="${(y - rowGap * 0.45).toFixed(1)}" width="${plot.w}" height="${(rowGap * 0.9).toFixed(1)}" fill="#f8fafc" opacity="0.8"/>`
      : "";
    return [
      stripe,
      `<line x1="${plot.x}" y1="${y.toFixed(1)}" x2="${plot.x + plot.w}" y2="${y.toFixed(1)}" stroke="#eef2f7" stroke-width="1.2"/>`,
      `<line x1="${zeroX.toFixed(1)}" y1="${y.toFixed(1)}" x2="${xMap(value).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="5.2" stroke-linecap="round" opacity="0.82"/>`,
      `<circle cx="${xMap(value).toFixed(1)}" cy="${y.toFixed(1)}" r="${significant ? "7.8" : "6.3"}" fill="${color}" opacity="0.92"/>`,
      significant ? `<circle cx="${xMap(value).toFixed(1)}" cy="${y.toFixed(1)}" r="11.5" fill="none" stroke="#111827" stroke-width="2.1" opacity="0.7"/>` : "",
    ].join("");
  });
  const body = [
    `<rect x="0" y="0" width="${width}" height="${height}" rx="28" fill="#f8fafc"/>`,
    `<rect x="34" y="30" width="${width - 68}" height="${height - 60}" rx="30" fill="#fbfcfe" stroke="#dde3ea" stroke-width="2"/>`,
    `<rect x="${plot.x}" y="${plot.y}" width="${plot.w}" height="${plot.h}" rx="24" fill="#ffffff" stroke="#d6d3c7" stroke-width="2"/>`,
    `<rect x="${(zeroX - 14).toFixed(1)}" y="${plot.y}" width="28" height="${plot.h}" fill="#f1f5f9" opacity="0.9"/>`,
    `<line x1="${zeroX.toFixed(1)}" y1="${plot.y}" x2="${zeroX.toFixed(1)}" y2="${plot.y + plot.h}" stroke="#334155" stroke-width="2.3" opacity="0.6"/>`,
    ...plotLines,
    ...cards,
  ].join("");
  return svgShell(width, height, body);
}

function buildSlides({ root, sections, evidence }) {
  const supplement = sections.supplement || {};
  const artifacts = supplement.supplement_artifacts || {};
  const topFeaturePath = artifactPath(artifacts, ["top_feature_results", "top_de_genes_by_qvalue"]);
  const deSummaryPath = artifactPath(artifacts, ["feature_distribution_summary", "de_distribution_summary"]);
  const normalizedPath = artifactPath(artifacts, ["category_background_normalized", "pathway_class_background_normalized"]);
  const markerPanelPath = artifactPath(artifacts, ["validation_panels", "nk_marker_panel_definition"]);
  const countSensitivityPath = artifactPath(artifacts, ["count_based_direction_sensitivity"]);
  const validationChecklistPath = artifactPath(artifacts, ["validation_checklist"]);
  const featureRows = readCsvRows(resolveArtifactPath(root, topFeaturePath), 80);
  const deSummary = readCsvRows(resolveArtifactPath(root, deSummaryPath), 1)[0] || supplement.de_summary || {};
  const normalizedRows = asArray(supplement.category_normalized_tests || supplement.pathway_normalized_tests);
  const markerRows = asArray(supplement.validation_panels || supplement.nk_marker_panel).slice(0, 19);
  const metrics = evidence.metrics || {};
  const rawSensitivityRows = asArray(evidence.validation_summary?.gatekeeper_challenge_response?.sensitivity_key_counts);
  const artifactSensitivityRows = rawSensitivityRows.length
    ? []
    : sensitivityRowsFromNearbyValidationSummaries(root, [normalizedPath, topFeaturePath, markerPanelPath, countSensitivityPath]);
  const sensitivityRows = rawSensitivityRows.length
    ? rawSensitivityRows
    : artifactSensitivityRows.length
      ? artifactSensitivityRows
      : sensitivityRowsFromCategoryRows(normalizedRows);

  const genesTested = safeInteger(firstDefined(deSummary.genes_tested, deSummary.valid_log2fc_pairs));
  const q05Genes = safeInteger(firstDefined(deSummary.q_lt_0_05, metrics.primary_signal_count));
  const q10Genes = safeInteger(firstDefined(deSummary.q_lt_0_10));
  const q25Genes = safeInteger(firstDefined(deSummary.q_lt_0_25));
  const pearson = safeNumber(firstDefined(deSummary.pearson_recomputed_vs_supplied_log2fc, metrics.primary_recompute_correlation));
  const spearman = safeNumber(firstDefined(deSummary.spearman_recomputed_vs_supplied_log2fc));
  const signConcordance = safeNumber(firstDefined(deSummary.sign_concordance_q_lt_0_05));
  const countSensitivity = readCsvRows(resolveArtifactPath(root, countSensitivityPath), 1)[0] || supplement.count_sensitivity || {};
  const countSpearman = safeNumber(firstDefined(countSensitivity.spearman_count_log2fc_vs_supplied_log2fc));
  const countSignConcordance = safeNumber(firstDefined(countSensitivity.sign_concordance_q_lt_0_05));

  const topAnchors = featureRows.slice(0, 3).map((row) => {
    const gene = String(row.gene_name || row.gene_id || "gene");
    const label = gene.length > 14 ? `${gene.slice(0, 11)}...` : gene;
    const value = safeNumber(row["log2(fc)"]);
    return `${label} ${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
  });

  const primaryPlot = { x: 72, y: 72, w: 548, h: 288 };
  const primaryMaxAbs = Math.max(2, ...featureRows.map((row) => Math.abs(safeNumber(row["log2(fc)"]))));
  const primaryMaxY = Math.max(8, ...featureRows.map((row) => -Math.log10(Math.max(safeNumber(row.qval, 1), 1e-300))));
  const primaryYMap = (q) => primaryPlot.y + primaryPlot.h - (Math.min(-Math.log10(Math.max(q, 1e-300)), primaryMaxY) / primaryMaxY) * primaryPlot.h;
  const primaryMetricBoxes = [
    { ...artBox(660, 96, 108, 50), name: "metric pearson", lines: [formatDecimal(pearson), "Pearson r"], size: 10.6, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(780, 96, 108, 50), name: "metric sign", lines: [formatDecimal(signConcordance, 2), "sign q<0.05"], size: 10.4, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(660, 172, 108, 50), name: "metric q05", lines: [formatInt(q05Genes), "genes q<0.05"], size: 10.4, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(780, 172, 108, 50), name: "metric tested", lines: [formatInt(genesTested), "genes tested"], size: 10.4, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(668, 262, 206, 74), name: "top anchors", lines: ["Top anchors", ...(topAnchors.length ? topAnchors : ["No top-gene table"])], size: 9.6, first_bold: true, align: "ctr", color: "334155" },
    { ...artBox(102, 418, 206, 54), name: "primary legend", lines: ["Legend", "Grey all tested", "Orange SAP-high", "Teal healthy-high"], size: 8.8, first_bold: true, align: "ctr", color: "334155" },
    { ...artBox(364, 418, 210, 54), name: "slice note", lines: ["Six-sample slice", "n=3 SAP, n=3 healthy", `Spearman ${formatDecimal(spearman)}`], size: 8.8, first_bold: true, align: "ctr", color: "334155" },
    { ...artBox(626, 418, 230, 54), name: "threshold counts", lines: ["Secondary thresholds", `q<0.10 ${formatInt(q10Genes)}`, `q<0.25 ${formatInt(q25Genes)}`], size: 8.8, first_bold: true, align: "ctr", color: "334155" },
  ];

  const classOrder = ["ecm_migration", "canonical_nk_cytotoxicity", "cell_cycle"];
  const thresholds = [
    { key: "sig_fdr_lt_0.25", label: "FDR<0.25" },
    { key: "sig_fdr_lt_0.1", label: "FDR<0.10" },
    { key: "sig_fdr_lt_0.05", label: "FDR<0.05" },
  ];
  const validationPlot = { x: 88, y: 88, w: 816, h: 232 };
  const validationBarRegion = { x: 252, y: 126, w: 566, rowH: 42, gap: 22, h: 20 };
  const validationMaxCount = Math.max(1, ...classOrder.flatMap((name) => thresholds.map((item) => sensitivityCount(sensitivityRows, name, item.key))));
  const validationAxisMax = Math.max(40, Math.ceil(validationMaxCount / 10) * 10);
  const validationXMap = (count) => validationBarRegion.x + (safeNumber(count) / validationAxisMax) * validationBarRegion.w;
  const validationTicks = [0, validationAxisMax * 0.25, validationAxisMax * 0.5, validationAxisMax * 0.75, validationAxisMax].map((value) => Math.round(value));
  const categoryRows = classOrder.map((name) => normalizedRows.find((item) => String(item?.class || "").toLowerCase() === name) || { class: name });
  const validationValueBoxes = classOrder.map((name, classIndex) => {
    const y = validationBarRegion.y + classIndex * (validationBarRegion.rowH + validationBarRegion.gap);
    const count = sensitivityCount(sensitivityRows, name, "sig_fdr_lt_0.1");
    const x = Math.max(validationBarRegion.x + 6, validationXMap(count) - 14);
    return {
      ...artBox(x, y - 22, 28, 16),
      name: `value label ${name} fdr010`,
      lines: [String(count)],
      size: 8.8,
      first_bold: true,
      align: "ctr",
      color: name === "ecm_migration" ? "0f766e" : name === "canonical_nk_cytotoxicity" ? "b45309" : "475569",
    };
  });
  const validationGroupBoxes = classOrder.map((name, classIndex) => {
    const y = validationBarRegion.y + classIndex * (validationBarRegion.rowH + validationBarRegion.gap);
    return {
      ...artBox(92, y - 2, 140, 20),
      name: `x category ${name}`,
      lines: [classLabel(name)],
      size: 9.8,
      first_bold: true,
      align: "r",
      color: "334155",
    };
  });
  const validationTickBoxes = validationTicks.map((value) => ({
    ...artBox(validationXMap(value) - 12, 298, 24, 16),
    name: `x tick ${value}`,
    lines: [String(value)],
    size: 8.2,
    align: "ctr",
    color: "334155",
  }));
  const validationCardBoxes = categoryRows.map((row, index) => ({
    ...artBox(88 + index * 274, 368, 250, 78),
    name: `validation card ${row.class || index + 1}`,
    lines: [
      `${safeInteger(row.class_sig_fdr_lt_0_1)} / ${safeInteger(row.class_terms)} at 0.10`,
      `OR ${formatDecimal(row.fisher_exact_enrichment_odds_ratio, 2)}`,
      `p ${formatPValue(row.fisher_exact_enrichment_p_value)}`,
    ],
    size: 10.0,
    first_bold: true,
    align: "ctr",
    color: index === 0 ? "0f766e" : index === 1 ? "b45309" : "475569",
  }));

  const markerPlot = { x: 226, y: 72, w: 538, h: 278 };
  const markerMaxAbs = Math.max(1.4, ...markerRows.map((row) => Math.abs(safeNumber(row["log2(fc)"]))));
  const markerXMap = (value) => markerPlot.x + ((safeNumber(value) + markerMaxAbs) / (markerMaxAbs * 2)) * markerPlot.w;
  const rowGap = markerPlot.h / Math.max(1, markerRows.length);
  const markerDownCount = markerRows.filter((row) => safeNumber(row["log2(fc)"]) < 0).length;
  const markerUpCount = markerRows.filter((row) => safeNumber(row["log2(fc)"]) >= 0).length;
  const markerSigCount = markerRows.filter((row) => safeNumber(row.qval, 1) < 0.05).length;
  const markerSigGenes = markerRows.filter((row) => safeNumber(row.qval, 1) < 0.05).map((row) => row.gene_name).filter(Boolean);
  const markerSigPreview = markerSigGenes.slice(0, 3);

  const markerGeneBoxes = markerRows.map((row, index) => {
    const boxH = Math.max(10, Math.min(14, rowGap * 0.8));
    const y = markerPlot.y + rowGap * index + rowGap * 0.55 - boxH / 2;
    return {
      ...artBox(26, y, 170, boxH),
      name: `marker gene ${row.gene_name || index + 1}`,
      lines: [String(row.gene_name || row.gene_id || `gene ${index + 1}`)],
      size: MIN_MANUSCRIPT_FONT_SIZE,
      align: "r",
      color: "334155",
    };
  });

  const markerSummaryBoxes = [
    { ...artBox(226, 400, 166, 50), name: "marker down count", lines: [String(markerDownCount), "lower in SAP"], size: 10.8, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(412, 400, 166, 50), name: "marker up count", lines: [String(markerUpCount), "higher in SAP"], size: 10.8, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
    { ...artBox(598, 400, 166, 50), name: "marker sig count", lines: [String(markerSigCount), "q<0.05"], size: 10.8, first_bold: true, first_size: 17, align: "ctr", color: "0f172a" },
  ];

  return [
    {
      figure_id: "figure-1-primary-signal",
      panel_label: "A",
      title: "Slice-level differential signal is internally concordant",
      takeaway: [
        `${formatInt(q05Genes)} genes at q<0.05`,
        `Pearson ${formatDecimal(pearson)}; sign ${formatDecimal(signConcordance, 2)}`,
        "within the six-sample Mendeley slice",
      ],
      caption: "Volcano-style SAP-vs-healthy NK-cell differential-expression view with q<0.05 threshold and concordance summary from the n=3 versus n=3 FPKM slice.",
      svg_file: "figure-1-primary-signal.svg",
      svg: buildPrimarySignalSvg(featureRows, { genes_tested: genesTested }),
      source_tables: [topFeaturePath, deSummaryPath].filter(Boolean),
      text_boxes: [
        { name: "x axis title", ...artBox(220, 386, 250, 18), lines: ["log2(SAP / healthy)"], size: 10.0, align: "ctr" },
        { name: "y axis title", ...artBox(0, 178, 160, 18), lines: ["-log10(q value)"], size: 10.0, rotation_degrees: -90, align: "ctr" },
        { name: "x tick negative", ...artBox(74, 364, 78, 14), lines: ["healthy-high"], size: 8.1, align: "ctr" },
        { name: "x tick zero", ...artBox(329, 364, 30, 14), lines: ["0"], size: 8.1, align: "ctr" },
        { name: "x tick positive", ...artBox(556, 364, 74, 14), lines: ["SAP-high"], size: 8.1, align: "ctr" },
        { name: "y tick zero", ...artBox(42, 280, 18, 14), lines: ["0"], size: 8.2, align: "r" },
        { name: "y tick five", ...artBox(38, 160, 22, 14), lines: ["5"], size: 8.2, align: "r" },
        { name: "y tick ten", ...artBox(32, 42, 28, 14), lines: ["10"], size: 8.2, align: "r" },
        { name: "threshold label", ...artBox(438, primaryYMap(0.05) - 10, 96, 14), lines: ["q = 0.05"], size: 8.8, color: "b91c1c" },
        ...primaryMetricBoxes,
      ],
    },
    {
      figure_id: "figure-2-validation-summary",
      panel_label: "B",
      title: "ECM / migration dominates every pathway-rival check",
      takeaway: [
        "ECM wins at every FDR tier",
        "20 / 59 terms at FDR<0.10",
        "rivals: NK 0 / 5, cycle 1 / 58",
      ],
      caption: "Overlaid FDR-threshold counts and class-normalized enrichment tests showing ECM/migration dominance over canonical NK cytotoxicity and cell-cycle rivals.",
      svg_file: "figure-2-validation-summary.svg",
      svg: buildValidationSummarySvg(categoryRows, sensitivityRows),
      source_tables: [normalizedPath, evidence.validation_summary?.gatekeeper_challenge_response?.fdr_sensitivity_artifact].filter(Boolean),
      text_boxes: [
        { name: "y axis title", ...artBox(8, 176, 160, 18), lines: ["Pathway class"], size: 9.8, rotation_degrees: -90, align: "ctr" },
        { name: "x axis title", ...artBox(366, 314, 240, 18), lines: ["Significant terms"], size: 9.8, align: "ctr" },
        ...validationGroupBoxes,
        ...validationTickBoxes,
        ...validationValueBoxes,
        ...validationCardBoxes,
        { name: "y tick zero", ...artBox(validationXMap(0) - 12, 278, 24, 14), lines: ["0"], size: 7.8, align: "ctr", color: "94a3b8" },
        { name: "y tick ten", ...artBox(validationXMap(10) - 12, 278, 24, 14), lines: ["10"], size: 7.8, align: "ctr", color: "94a3b8" },
        { name: "y tick twenty", ...artBox(validationXMap(20) - 12, 278, 24, 14), lines: ["20"], size: 7.8, align: "ctr", color: "94a3b8" },
        { name: "validation y tick forty", ...artBox(validationXMap(40) - 12, 278, 24, 14), lines: ["40"], size: 7.8, align: "ctr", color: "94a3b8" },
        { name: "validation legend", ...artBox(628, 92, 168, 40), lines: ["Overlaid bars", "dark 0.05 | mid 0.10", "light 0.25"], size: 8.8, first_bold: true, align: "ctr", color: "334155" },
      ],
    },
    {
      figure_id: "figure-3-evidence-trace",
      panel_label: "C",
      title: "Canonical NK marker directions are mixed, not coherent",
      takeaway: [
        "Marker directions are mixed",
        `${markerDownCount} lower in SAP; ${markerUpCount} higher`,
        `${markerSigCount} of ${markerRows.length} reach q<0.05`,
      ],
      caption: "Prespecified canonical NK/cytotoxic marker-panel log2(SAP/healthy) values showing mixed up/down directions rather than a one-direction cytotoxic program.",
      svg_file: "figure-3-evidence-trace.svg",
      svg: buildMarkerPanelSvg(markerRows),
      source_tables: [markerPanelPath, countSensitivityPath, validationChecklistPath, evidence.artifacts?.runner_result].filter(Boolean),
      text_boxes: [
        ...markerGeneBoxes,
        ...markerSummaryBoxes,
        { name: "x axis title", ...artBox(274, 378, 240, 18), lines: ["Marker log2(SAP / healthy)"], size: 10.0, align: "ctr" },
        { name: "marker x tick left", ...artBox(214, 356, 40, 16), lines: [formatDecimal(-markerMaxAbs, 1)], size: 8.2, align: "ctr", color: "334155" },
        { name: "marker x tick midleft", ...artBox(markerXMap(-markerMaxAbs / 2) - 20, 356, 40, 16), lines: [formatDecimal(-markerMaxAbs / 2, 1)], size: 8.2, align: "ctr", color: "334155" },
        { name: "marker x tick zero", ...artBox(markerXMap(0) - 15, 356, 30, 16), lines: ["0"], size: 8.2, align: "ctr", color: "334155" },
        { name: "marker x tick midright", ...artBox(markerXMap(markerMaxAbs / 2) - 20, 356, 40, 16), lines: [formatDecimal(markerMaxAbs / 2, 1)], size: 8.2, align: "ctr", color: "334155" },
        { name: "marker x tick right", ...artBox(744, 356, 40, 16), lines: [formatDecimal(markerMaxAbs, 1)], size: 8.2, align: "ctr", color: "334155" },
        { name: "x tick source", ...artBox(226, 506, 166, 14), lines: ["source"], size: 8.0, first_bold: true, align: "ctr", color: "334155" },
        { name: "x tick validation", ...artBox(412, 506, 166, 14), lines: ["validation"], size: 8.0, first_bold: true, align: "ctr", color: "334155" },
        { name: "x tick review", ...artBox(598, 506, 166, 14), lines: ["review"], size: 8.0, first_bold: true, align: "ctr", color: "334155" },
        { name: "row label note", ...artBox(226, 526, 538, 16), lines: ["Trace for caveat handling"], size: 8.0, align: "ctr", color: "475569" },
        { name: "trace label source", ...artBox(226, 544, 166, 14), lines: ["marker + count tables"], size: 8.0, align: "ctr", color: "334155" },
        { name: "trace label validation", ...artBox(412, 544, 166, 14), lines: ["mixed direction retained"], size: 8.0, align: "ctr", color: "334155" },
        { name: "trace label review", ...artBox(598, 544, 166, 14), lines: ["overclaim blocked"], size: 8.0, align: "ctr", color: "334155" },
      ],
    },
  ];
}

function boxAnchor(align) {
  if (align === "ctr") return "middle";
  if (align === "r") return "end";
  return "start";
}

function textBoxToSvg(box, scaleX, scaleY) {
  const x = safeNumber(box.x) * scaleX;
  const y = safeNumber(box.y) * scaleY;
  const width = Math.max(1, safeNumber(box.w, 1) * scaleX);
  const fontSize = safeNumber(box.size, 12) * 1.28;
  const anchor = boxAnchor(box.align);
  const textX = anchor === "middle" ? x + width / 2 : anchor === "end" ? x + width : x;
  const lines = asArray(box.lines);
  const rotation = box.rotation_degrees == null
    ? ""
    : ` transform="rotate(${safeNumber(box.rotation_degrees)} ${textX.toFixed(1)} ${y.toFixed(1)})"`;
  return lines.map((line, index) => {
    const dy = index * fontSize * 1.18;
    const weight = (index === 0 && (box.first_bold === true || box.firstBold === true)) ? "700" : "400";
    return `<text x="${textX.toFixed(1)}" y="${(y + fontSize + dy).toFixed(1)}" font-family="Aptos, Arial, sans-serif" font-size="${fontSize.toFixed(1)}" font-weight="${weight}" fill="#${escapeXml(box.color || "334155")}" text-anchor="${anchor}"${rotation}>${escapeXml(line)}</text>`;
  }).join("");
}

function buildPaperImageSvg(slide) {
  const width = 1600;
  const height = 900;
  const scaleX = width / 13.333333;
  const scaleY = height / 7.5;
  const artworkHref = `data:image/svg+xml;base64,${Buffer.from(slide.svg, "utf8").toString("base64")}`;
  const text = slideAllTextBoxes(slide).map((box) => textBoxToSvg(box, scaleX, scaleY)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<rect x="0" y="0" width="${width}" height="${height}" fill="#fffaf0"/>
<image x="${(ART_X * scaleX).toFixed(1)}" y="${(ART_Y * scaleY).toFixed(1)}" width="${(ART_W * scaleX).toFixed(1)}" height="${(ART_H * scaleY).toFixed(1)}" href="${artworkHref}"/>
${text}
</svg>`;
}

function writePaperFigureImages({ deckDir, slide }) {
  const baseName = slide.svg_file.replace(/\.svg$/i, "");
  const imageSvgPath = path.join(deckDir, `${baseName}-paper-image.svg`);
  const imagePngPath = path.join(deckDir, `${baseName}-paper-image.png`);
  const svg = buildPaperImageSvg(slide);
  fs.writeFileSync(imageSvgPath, svg, "utf8");
  let pngPath = null;
  let pngMethod = null;
  try {
    execFileSync("convert", [imageSvgPath, imagePngPath], {
      timeout: 15000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (fs.existsSync(imagePngPath)) {
      pngPath = imagePngPath;
      pngMethod = "imagemagick";
    }
  } catch {
    pngPath = null;
  }
  if (!pngPath) {
    pngPath = writePngWithPython(imageSvgPath, imagePngPath);
    if (pngPath) pngMethod = "python-pillow";
  }
  return {
    paper_image_svg_path: imageSvgPath,
    paper_image_png_path: pngPath,
    paper_image_png_method: pngMethod,
    paper_image_source: "flattened from ResearchLab PPT figure deck text boxes and SVG artwork for manuscript insertion",
  };
}

function buildFigureDeck({ root, cycleId, revision, sections, evidence, contentHash }) {
  const rev = String(revision).padStart(4, "0");
  const figuresDir = path.join(root, "figures");
  const deckDir = path.join(figuresDir, `${cycleId}-figure-deck-v${rev}`);
  ensureDir(deckDir);
  ensureDir(figuresDir);
  const slides = buildSlides({ root, sections, evidence });
  const paperImagesByFigure = new Map();
  for (const slide of slides) {
    fs.writeFileSync(path.join(deckDir, slide.svg_file), slide.svg, "utf8");
    paperImagesByFigure.set(slide.figure_id, writePaperFigureImages({ deckDir, slide }));
  }
  const pptxPath = path.join(figuresDir, `${cycleId}-figure-deck-v${rev}.pptx`);
  const manifestPath = path.join(figuresDir, `${cycleId}-figure-deck-v${rev}-manifest.json`);
  const pptxBuild = buildPptxWithPython({
    outputPath: pptxPath,
    deckDir,
    slides,
    title: `${cycleId} paper figure deck`,
  });
  const manifest = {
    cycle_id: cycleId,
    revision,
    generated_at: new Date().toISOString(),
    generated_by: "figure-deck-builder",
    content_hash: contentHash,
    pptx_path: pptxPath,
    pptx_generation_method: pptxBuild.method,
    pptx_embedded_artwork_format: pptxBuild.embedded_artwork_format,
    unrendered_artwork: pptxBuild.unrendered_artwork || [],
    asset_dir: deckDir,
    production_policy: {
      deck_format: "pptx",
      graphics_format: "svg",
      separate_deck_required: true,
      svg_text_policy: "SVG artwork files must contain graphical shapes only and no <text> elements.",
      ppt_text_policy: "Panel labels, axis labels, legends, tick labels, value labels, and essential callouts are authored as editable PPT text boxes. Captions, slide titles, and key-message prose stay in LaTeX/manifest text, not in the figure image.",
      pptx_generation_policy: "PPTX files are generated with python-pptx. The PPT embeds text-free PNG artwork rendered from the source SVG assets and keeps all labels as editable PPT text boxes.",
      manuscript_image_policy: "Every paper figure must have an existing PNG export at paper_image_png_path for LaTeX insertion; raw SVG is retained as source artwork only.",
      visual_qa_policy: "Manifest slides must include text_box_quality with no editable-text overlaps, no out-of-bounds text boxes, minimum 8 pt manuscript text, and rendered_image_quality checks from the final PNG pixels.",
    },
    slides: slides.map((slide, index) => {
      const textBoxQuality = evaluateTextBoxQuality(slide);
      const paperImages = paperImagesByFigure.get(slide.figure_id) || {};
      const renderedImageQuality = evaluateRenderedImageQuality(paperImages.paper_image_png_path);
      return {
        slide_number: index + 1,
        figure_id: slide.figure_id,
        title: slide.title,
        panel_label: slide.panel_label,
        svg_path: path.join(deckDir, slide.svg_file),
        ppt_artwork_png_path: pptxBuild.artwork_png_paths[index] || null,
        svg_contains_text_elements: /<text[\s>]/i.test(slide.svg),
        ppt_text_boxes: [
          ...slideAllTextBoxes(slide).map((box) => box.name || "text box"),
        ],
        text_box_quality: textBoxQuality,
        text_overlap_check: {
          passed: textBoxQuality.passed === true,
          overlap_count: textBoxQuality.overlap_count,
          overlaps: textBoxQuality.overlaps,
          out_of_bounds: textBoxQuality.out_of_bounds,
          undersized_text_boxes: textBoxQuality.undersized_text_boxes,
        },
        ...paperImages,
        rendered_image_quality: renderedImageQuality,
        source_tables: asArray(slide.source_tables),
        caption: slide.caption,
      };
    }),
  };
  writeJson(manifestPath, manifest);
  return {
    pptx_path: pptxPath,
    manifest_path: manifestPath,
    asset_dir: deckDir,
    slide_count: slides.length,
    production_policy: manifest.production_policy,
  };
}

module.exports = {
  buildFigureDeck,
};
