"use strict";

const fs = require("fs");
const path = require("path");
const { ensureDir } = require("../../../shared/json");
const { buildImpactFirstHypothesisMandate } = require("../../../agents/shared/impact_first");

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null);
  if (value == null || value === "") return [];
  return [value];
}

function compactText(value, maxChars = 320) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
}

function averageApplicableRubricScore(rubric) {
  const items = Array.isArray(rubric)
    ? rubric.filter((item) => item?.applicable !== false && Number.isFinite(Number(item?.score)))
    : [];
  if (items.length === 0) return null;
  return Math.round(items.reduce((sum, item) => sum + Number(item.score || 0), 0) / items.length);
}

function keepResearchQualityReasons(values) {
  const blockedPatterns = [
    /\b8\s*hours?\b/i,
    /\bruntime\b/i,
    /\boutput contract\b/i,
    /\bapproval-ready\b/i,
    /\bapproval ready\b/i,
    /\bmissing paper\/report artifacts?\b/i,
    /\boperational contract compliance\b/i,
    /\bartifact\b/i,
    /\bparse-safe\b/i,
    /\bparse failed\b/i,
    /\bjson review\b/i,
    /\bgate closure\b/i,
    /\blane completed\b/i,
    /\bcycle events?\b/i,
    /\bminutes?\b/i,
    /\bfile-path rebasing\b/i,
  ];
  return uniqueStrings(values).filter((item) => !blockedPatterns.some((pattern) => pattern.test(item)));
}

function impactFirstActionPolicy(mandate) {
  return {
    mode: "impact-first",
    mandate_version: mandate.policy_version,
    selection_rule: mandate.selection_rule,
    minimum_initial_scores: mandate.minimum_initial_scores,
    required_candidate_fields: mandate.required_candidate_fields,
    demotion_rules: mandate.demotion_rules,
    lead_selection_deliverables: mandate.lead_selection_deliverables,
  };
}

function roleReceivesImpactFirstMandate(role) {
  return ["lab-director", "scout", "analyst", "gatekeeper", "falsifier"].includes(String(role || ""));
}

function withImpactFirstActionMandate(action) {
  if (!action || typeof action !== "object") return action;
  if (!roleReceivesImpactFirstMandate(action.preferred_role)) return action;
  const mandate = action.impact_first_hypothesis_mandate || buildImpactFirstHypothesisMandate();
  const policy = action.hypothesis_generation_policy || impactFirstActionPolicy(mandate);
  const plannerMetadata = action.planner_metadata && typeof action.planner_metadata === "object"
    ? action.planner_metadata
    : {};
  return {
    ...action,
    impact_first_hypothesis_mandate: mandate,
    hypothesis_generation_policy: policy,
    planner_metadata: {
      ...plannerMetadata,
      impact_first_hypothesis_mandate:
        plannerMetadata.impact_first_hypothesis_mandate || buildImpactFirstHypothesisMandate(),
      hypothesis_generation_policy: plannerMetadata.hypothesis_generation_policy || policy,
    },
  };
}

function rubricBlockerReasons(rubric, threshold = 95) {
  return Array.isArray(rubric)
    ? rubric
        .filter((item) => item?.applicable !== false && Number(item?.score || 0) < threshold)
        .flatMap((item) => Array.isArray(item?.reasons) ? item.reasons : [])
        .filter(Boolean)
    : [];
}

function extractGeoAccessions(value) {
  const text = typeof value === "string" ? value : collectSearchText(value, 260, 40000);
  return uniqueStrings(text.match(/\bGSE\d+\b/gi) || []).map((item) => item.toUpperCase());
}

function hasForeignOnlyGeoAccessions(value, currentAccessions) {
  const current = new Set((currentAccessions || []).map((item) => String(item || "").toUpperCase()).filter(Boolean));
  if (current.size === 0) return false;
  const mentioned = extractGeoAccessions(value);
  if (mentioned.length === 0) return false;
  return mentioned.every((item) => !current.has(item));
}

function collectSearchText(value, maxParts = 260, maxChars = 40000) {
  const parts = [];
  const visit = (item) => {
    if (parts.length >= maxParts) return;
    if (item == null) return;
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      const text = compactText(item, 700);
      if (text) parts.push(text);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (parts.length >= maxParts) break;
        if (/path|html|visual|figure|chart/i.test(key)) continue;
        visit(child);
      }
    }
  };
  visit(value);
  return parts.join("\n").slice(0, maxChars);
}

module.exports = {

  appendJsonl,

  uniqueStrings,

  asArray,

  compactText,

  averageApplicableRubricScore,

  keepResearchQualityReasons,

  impactFirstActionPolicy,

  roleReceivesImpactFirstMandate,

  withImpactFirstActionMandate,

  rubricBlockerReasons,

  collectSearchText,

  extractGeoAccessions,

  hasForeignOnlyGeoAccessions,

};
