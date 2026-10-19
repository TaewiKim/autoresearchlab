"use strict";

const fs = require("fs");
const path = require("path");
const { ART_X, ART_Y, ART_W, ART_H, ARTWORK_W, ARTWORK_H } = require("./constants");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeInteger(value, fallback = 0) {
  return Math.round(safeNumber(value, fallback));
}

function formatInt(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(safeNumber(value));
}

function formatDecimal(value, digits = 3) {
  return safeNumber(value).toFixed(digits);
}

function formatPValue(value) {
  const numeric = safeNumber(value, NaN);
  if (!Number.isFinite(numeric)) return "n/a";
  if (numeric === 0) return "0";
  if (numeric >= 0.01) return numeric.toFixed(3);
  return numeric.toExponential(2);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function artifactPath(artifacts, names) {
  for (const name of asArray(names)) {
    const candidate = artifacts?.[name];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function artBox(x, y, w, h) {
  return {
    x: ART_X + (safeNumber(x) / ARTWORK_W) * ART_W,
    y: ART_Y + (safeNumber(y) / ARTWORK_H) * ART_H,
    w: (safeNumber(w) / ARTWORK_W) * ART_W,
    h: (safeNumber(h) / ARTWORK_H) * ART_H,
  };
}

function classLabel(name) {
  const key = String(name || "").toLowerCase();
  if (key === "ecm_migration") return "ECM / migration";
  if (key === "canonical_nk_cytotoxicity") return "NK cytotoxicity";
  if (key === "cell_cycle") return "Cell cycle";
  return String(name || "class").replace(/_/g, " ");
}

function sensitivityCount(rows, className, key) {
  const row = asArray(rows).find((item) => String(item?.class || "").toLowerCase() === String(className).toLowerCase());
  const direct = Number(row?.[key]);
  if (Number.isFinite(direct)) return Math.round(direct);
  const normalizedKey = {
    "sig_fdr_lt_0.05": "class_sig_fdr_lt_0_05",
    "sig_fdr_lt_0.1": "class_sig_fdr_lt_0_1",
    "sig_fdr_lt_0.25": "class_sig_fdr_lt_0_25",
  }[key];
  const normalized = Number(normalizedKey ? row?.[normalizedKey] : NaN);
  if (Number.isFinite(normalized)) return Math.round(normalized);
  return 0;
}

function sensitivityRowsFromCategoryRows(rows) {
  return asArray(rows)
    .filter((row) => !row?.analysis_type || String(row.analysis_type).toLowerCase() === "all")
    .map((row) => {
      const sig010 = safeInteger(row.class_sig_fdr_lt_0_1);
      return {
        class: row.class || row.category,
        term_count: safeInteger(row.class_terms || row.term_count),
        "sig_fdr_lt_0.05": safeInteger(firstDefined(row.class_sig_fdr_lt_0_05, sig010)),
        "sig_fdr_lt_0.1": sig010,
        "sig_fdr_lt_0.25": safeInteger(firstDefined(row.class_sig_fdr_lt_0_25, sig010)),
      };
    })
    .filter((row) => row.class);
}

function sensitivityRowsFromNearbyValidationSummaries(root, artifactPaths) {
  const seen = new Set();
  for (const artifact of asArray(artifactPaths)) {
    let current = resolveArtifactPath(root, artifact);
    if (!current) continue;
    current = fs.existsSync(current) && fs.statSync(current).isDirectory() ? current : path.dirname(current);
    for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
      seen.add(current);
      const summaryPath = path.join(current, "validation-summary.json");
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        const rows = asArray(summary?.gatekeeper_challenge_response?.sensitivity_key_counts);
        if (rows.length > 0) return rows;
      }
      const next = path.dirname(current);
      if (!next || next === current) break;
      current = next;
    }
  }
  return [];
}

function resolveArtifactPath(root, value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  if (String(value).startsWith(".research-lab/")) return path.join(path.dirname(root), value);
  return path.join(root, value);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function readCsvRows(filePath, limit = 200) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1, limit + 1).map((line) => {
    const cells = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] == null ? "" : cells[index];
    });
    return row;
  });
}

module.exports = {
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
  parseCsvLine,
  readCsvRows,
};
