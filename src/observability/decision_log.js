"use strict";

const path = require("path");
const { decisionLog } = require("./cycle_logs");
const { segmentName } = require("./segmented_log");

// The lab director's decision ledger, one file per UTC hour:
//
//   runtime/<cycle>-labdirector-decisions/2026-10-12T03.jsonl
//
// MEASURED ON cycle-a-20260919, 2026-10-12: as the single file
// `runtime/<cycle>-labdirector-decisions.jsonl` it was 12.0 GB after 23 days,
// 32,288 records -- 4,350 gate reviews at 1.7 MB each and 8,487 approval
// reviews at 0.5 MB are 11.9 GB of it. An hour of it is 27 MB at the median
// and 283 MB at the worst.
//
// It follows the rule every append-only log of a cycle follows
// (segmented_log.js); the Rust harness writes the same segments
// (core::support::append_labdirector_decision).

function decisionLogDir(root, cycleId) {
  return decisionLog(root, cycleId).dir;
}

function legacyDecisionLogPath(root, cycleId) {
  return decisionLog(root, cycleId).legacyPath;
}

function decisionSegmentName(now = new Date()) {
  return segmentName(now);
}

function decisionSegmentPath(root, cycleId, now = new Date()) {
  return path.join(decisionLogDir(root, cycleId), segmentName(now));
}

function appendDecision({ root, cycleId, row, now = new Date(), fsImpl }) {
  return decisionLog(root, cycleId).append(row, fsImpl ? { now, fsImpl } : { now });
}

function listDecisionSegments(root, cycleId) {
  return decisionLog(root, cycleId).segments();
}

// The newest `limit` decisions, newest first.
function readRecentDecisions(root, cycleId, options = {}) {
  return decisionLog(root, cycleId).recent(options);
}

function decisionLogEnd(root, cycleId) {
  return decisionLog(root, cycleId).end();
}

function followDecisionLog(root, cycleId, position, read) {
  return decisionLog(root, cycleId).follow(position, read);
}

module.exports = {
  appendDecision,
  decisionLogDir,
  decisionLogEnd,
  decisionSegmentName,
  decisionSegmentPath,
  followDecisionLog,
  legacyDecisionLogPath,
  listDecisionSegments,
  readRecentDecisions,
};
