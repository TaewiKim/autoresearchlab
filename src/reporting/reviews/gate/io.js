"use strict";

const fs = require("fs");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonIfExistsBounded(filePath, maxBytes = 25 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      return {
        __omitted_large_json: true,
        path: filePath,
        size_bytes: stat.size,
        max_bytes: maxBytes,
      };
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseJsonFromText(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const direct = text.length <= 1024 * 1024 ? (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })() : null;
  if (direct) return direct;
  // Avoid scanning multi-megabyte executor transcripts. Modern executor
  // results carry the parsed payload in extracted_json; falling back to regex
  // over stdout/output_last_message here was a gate-refresh CPU hot path.
  if (text.length > 1024 * 1024) return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {}
  }
  return null;
}

module.exports = {

  readJsonIfExists,

  readJsonIfExistsBounded,

  parseJsonFromText,

};