"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { segmentedLog } = require("./segmented_log");

// Where each of a cycle's append-only logs lives, and the single file it used
// to be. See segmented_log.js for the rule they all follow.
function decisionLog(root, cycleId) {
  return segmentedLog({
    dir: path.join(root, "runtime", `${cycleId}-labdirector-decisions`),
    legacyPath: path.join(root, "runtime", `${cycleId}-labdirector-decisions.jsonl`),
  });
}

function inboxLog(root, cycleId) {
  return segmentedLog({
    dir: path.join(root, "runtime", `${cycleId}-labdirector-inbox`),
    legacyPath: path.join(root, "runtime", `${cycleId}-labdirector-inbox.jsonl`),
  });
}

function dialogueLog(root, cycleId) {
  return segmentedLog({
    dir: path.join(root, "events", `${cycleId}-labdirector-dialogue`),
    legacyPath: path.join(root, "events", `${cycleId}-labdirector-dialogue.jsonl`),
  });
}

function deliveryReceiptLog(root, cycleId) {
  return segmentedLog({
    dir: path.join(root, "messages", cycleId, "delivery-receipts"),
    legacyPath: path.join(root, "messages", cycleId, "delivery-receipts.jsonl"),
  });
}

function appendDialogue({ root, cycleId, row, now = new Date(), fsImpl = fs }) {
  return dialogueLog(root, cycleId).append(row, { now, fsImpl });
}

function appendDialogueRow(root, cycleId, row) {
  return dialogueLog(root, cycleId).append(row);
}

// A review is logged when it says something its last logging did not.
//
// The conclusion, approval and gate reviews are rebuilt on every refresh and
// each rebuild used to be appended to the decision ledger and again to the
// dialogue, whether or not anything in it had changed.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: of 107 consecutive pairs
// of these reviews in two hours of the ledger, 97 differed in nothing but
// `ts`. A gate review is 2.4 MB and an approval review 1.3 MB; the same pair
// was written four times in six minutes. That, twice over, is the 24 GB.
//
// `slot` names the place a review is built, because one refresh builds the
// approval review twice from different inputs and each has its own "last".
// The fingerprints live beside the ledger they describe; losing them costs one
// repeated record, never a missing one.
function reviewFingerprint(review) {
  const { ts, ...rest } = review || {};
  return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

// A review is written into the ledger once per record, and the dialogue gets
// word of it, not a second copy.
//
// MEASURED ON cycle-a-20260919, 2026-10-16: logging only changed
// reviews still left 20 MB an hour in the ledger -- 37 gate reviews of 2.4 MB
// and 50 approval reviews of 0.7 MB in seven hours, each changed by a counter
// or an mtime. In a gate review `recommended_actions` is
// `recommended_followup_actions` again (567 KB), `gatekeeper_reviews` is
// `gatekeeper_review.reviews` again, and the same whole review was appended
// to the dialogue as well, where nothing reads more than its scalars (the live
// stream slims a dialogue payload to four fields).
//
// So in the ledger a large field that repeats an earlier one is written as
// {"$same_as": "<that field>"}, and the dialogue carries the review's scalar
// fields and where the ledger keeps the whole of it.
const SAME_AS_MIN_CHARS = 1024;

function compactReviewForLedger(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return review;
  const seen = new Map();
  const remember = (pathName, value) => {
    if (!value || typeof value !== "object") return;
    const text = JSON.stringify(value);
    if (text.length >= SAME_AS_MIN_CHARS && !seen.has(text)) seen.set(text, pathName);
  };
  const out = {};
  for (const [key, value] of Object.entries(review)) {
    const text = value && typeof value === "object" ? JSON.stringify(value) : null;
    if (text && text.length >= SAME_AS_MIN_CHARS && seen.has(text)) {
      out[key] = { $same_as: seen.get(text) };
      continue;
    }
    out[key] = value;
    remember(key, value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [child, childValue] of Object.entries(value)) remember(`${key}.${child}`, childValue);
    }
  }
  return out;
}

function reviewDialogueSummary(review, ledgerSegment, fingerprint) {
  const summary = {};
  for (const [key, value] of Object.entries(review || {})) {
    if (value === null || typeof value === "number" || typeof value === "boolean") summary[key] = value;
    else if (typeof value === "string" && value.length <= 500) summary[key] = value;
  }
  summary.full_review = { ledger_segment: ledgerSegment, fingerprint };
  return summary;
}

function appendReviewOnce({ root, cycleId, slot, review, dialogueEventType, now = new Date(), fsImpl = fs }) {
  const decisions = decisionLog(root, cycleId);
  const statePath = path.join(decisions.dir, "last-reviews.json");
  const fingerprint = reviewFingerprint(review);
  let state = {};
  try {
    state = JSON.parse(fsImpl.readFileSync(statePath, "utf8")) || {};
  } catch {
    state = {};
  }
  if (state[slot]?.fingerprint === fingerprint) {
    try {
      state[slot] = { ...state[slot], unchanged_since: state[slot].appended_at, last_seen_at: now.toISOString(), repeats: Number(state[slot].repeats || 0) + 1 };
      fsImpl.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // The count of repeats is a courtesy, not a record.
    }
    return false;
  }
  const ledgerSegment = decisions.append(compactReviewForLedger(review), { now, fsImpl });
  dialogueLog(root, cycleId).append({
    ts: review.ts,
    event_type: dialogueEventType,
    payload: reviewDialogueSummary(review, path.relative(root, String(ledgerSegment || "")).split(path.sep).join("/"), fingerprint),
  }, { now, fsImpl });
  try {
    state[slot] = { fingerprint, appended_at: now.toISOString(), repeats: 0 };
    fsImpl.mkdirSync(decisions.dir, { recursive: true });
    fsImpl.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Without the fingerprint the next identical review is logged once more.
  }
  return true;
}

module.exports = {
  appendDialogue,
  appendDialogueRow,
  appendReviewOnce,
  decisionLog,
  deliveryReceiptLog,
  dialogueLog,
  inboxLog,
  reviewFingerprint,
};
