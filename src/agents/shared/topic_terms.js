"use strict";

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function isPromotableTopicTerm(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (/^[a-z]:[\\/]/i.test(raw) || raw.includes("/") || raw.includes("\\")) return false;
  if (/^(users?|home|var|tmp|private|volumes|workspace|openclaw|researchlab|runtime|artifacts|stats|lanes)(_|$)/.test(normalized)) return false;
  if (/(^|_)(users?|home|workspace|openclaw|researchlab|artifacts|stats|lanes|result|summary|json|csv|tsv|txt)(_|$)/.test(normalized) && normalized.split("_").length <= 4) return false;
  return true;
}

function inferTopicTerms(prompt) {
  const raw = String(prompt || "").trim();
  const text = raw.toLowerCase();
  const terms = [];
  const stop = new Set([
    "the", "and", "for", "with", "from", "into", "using", "that", "this", "there",
    "data", "dataset", "analysis", "analyze", "research", "study", "effect",
  ]);
  for (const quoted of raw.match(/["'`](.+?)["'`]/g) || []) {
    const term = quoted.replace(/^["'`]|["'`]$/g, "");
    if (isPromotableTopicTerm(term)) terms.push(term);
  }
  // Unicode letters and digits, so an objective in any language tokenises.
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || [];
  for (const token of tokens) {
    if (stop.has(token) || !isPromotableTopicTerm(token)) continue;
    terms.push(token);
  }
  if (/data|dataset|analysis/i.test(raw)) {
    terms.push("open dataset validation", "independent validation", "sensitivity analysis");
  }
  const deduped = dedupe(terms).slice(0, 16);
  return deduped.length ? deduped : ["independent validation"];
}

module.exports = {
  dedupe,
  inferTopicTerms,
  isPromotableTopicTerm,
};
