"use strict";

// The evidence a profile should be derived FROM, loaded once per call site.
//
// `resolveProfile` (derived_profile.js) already prefers what a cycle measured
// over what its field label implies, but it can only do that when the
// measurements reach it. Nothing threaded them in: every `domainProfile(domain)`
// call site resolved the field name and stopped there, so stage two's machinery
// ran with empty evidence and fell back to the enumerated profile every time.
//
// This is the loader. It is deliberately forgiving: a cycle with no probe yet,
// no venue standard and no corpus returns empty evidence and the caller falls
// back exactly as before. Absence of measurement is never an error here.

const fs = require("fs");
const path = require("path");
const { cycleStateReader } = require("./gated_state");

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function statePath(root, cycleId, suffix) {
  return path.join(root, "state", `${cycleId}-${suffix}`);
}

// What the instrument probe actually measured in THIS container.
function instrumentInventoryFor(root, cycleId) {
  // This evidence shapes the profile every role plan is built from, so it is
  // admitted for this cycle rather than read on sight.
  return cycleStateReader({ root, cycleId, task: "profile_evidence" })("instrument-inventory.json");
}

// The venue the manuscript names, and the bar it was recorded as holding.
function venueStandardFor(root, cycleId) {
  const admit = cycleStateReader({ root, cycleId, task: "profile_evidence" });
  const review = admit("paper-review.json");
  const fromReview = review?.review?.target_venue || review?.target_venue;
  if (fromReview) return fromReview;
  return admit("venue-standard.json");
}

// The literature this cycle actually retrieved. Seeds derived from a real
// corpus beat seeds enumerated for a field name, which is the whole point.
//
// The file and the field names here are the recorded ones, checked on disk. The
// first version of this function read `<cycle>-literature.json`, which does not
// exist, and returned an empty corpus every time -- so the seeds silently stayed
// on the enumerated fallback and the wiring delivered only half of itself.
// `<cycle>-literature-graph.json` is not the corpus either: its nodes are single
// extracted terms ("variance", "sampling"), already the output of the analysis
// this derivation is trying to do.
//
// `top_papers` carries `abstract_snippet`, and the tf-idf seed derivation reads
// `abstract`, so the shape is adapted here rather than loosened there.
function corpusFor(root, cycleId) {
  const summary = cycleStateReader({ root, cycleId, task: "profile_evidence" })("literature-summary.json");
  const papers = summary?.top_papers;
  if (!Array.isArray(papers)) return [];
  return papers.map((paper) => ({
    ...paper,
    abstract: paper?.abstract || paper?.abstract_snippet || "",
  }));
}

/**
 * Everything `resolveProfile` can use, or empty when the cycle has not measured
 * anything yet. Never throws: a missing artifact is a cycle that has not got
 * there, not a failure.
 */
function loadCycleEvidence({ root = null, cycleId = null } = {}) {
  if (!root || !cycleId) {
    return { instrumentInventory: null, venueStandard: null, corpus: [] };
  }
  return {
    instrumentInventory: instrumentInventoryFor(root, cycleId),
    venueStandard: venueStandardFor(root, cycleId),
    corpus: corpusFor(root, cycleId),
  };
}

module.exports = {
  loadCycleEvidence,
  instrumentInventoryFor,
  venueStandardFor,
  corpusFor,
};
