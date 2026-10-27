"use strict";

// Nothing valuable gets overwritten again.
//
// Every review in this runtime is written to ONE path and rewritten on every
// refresh: gate-review.json, conclusion-review.json, approval-review.json,
// report-review.json, paper-review.json. Seven `writeJson(reviewPath, review)`
// calls, each destroying what stood there. The current value is always
// available and the trajectory never is.
//
// What that cost, measured on cycle-g-v89 (2026-09-10, day 10 of the run):
//
//   gate score  0 -> 32 -> 43 -> 55 -> 90 -> 64 -> 90 -> 89 -> 50 -> 46 -> 92
//               -> 36 -> 92 -> 30 -> 92 -> 89 -> 32 -> 89 -> 28 -> 27
//
//   novelty peaked at 100, technical_quality at 98, clarity at 100 (09-01
//   14:04); reproducibility and impact at 100 (08-31 16:44). At the time of
//   writing they read 42, 22, 42, 14 and 15.
//
// The threshold is 90. The cycle reached it repeatedly and lost it every time,
// and nothing in the system could see that happening, because the only record
// of a previous score was whatever a later refresh had not yet overwritten.
// Reconstructing the series above needed a 4.1 GB decision ledger that dumps
// whole review snapshots -- and that ledger stopped recording rubric numbers
// after day one, so it could not answer the question either.
//
// This is the append-only half. The review file keeps being written exactly as
// before, so every reader is unaffected; alongside it, one compact line per
// CHANGE lands in `<cycle>-<kind>-history.jsonl` and is never rewritten.
//
// Appending only on change is what keeps this from becoming the 4.1 GB problem
// it replaces: reviews rebuild on every refresh, thousands of times, and almost
// every rebuild is identical to the last.

const fs = require("fs");
const path = require("path");

const { ensureDir } = require("../shared/json");

const RUBRIC_KEYS = [
  "novelty",
  "technical_quality",
  "reproducibility",
  "clarity",
  "impact",
];

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function historyPath(root, cycleId, kind) {
  return path.join(root, "state", `${cycleId}-${kind}-history.jsonl`);
}

// A score with no reasons behind it is a mid-aggregation placeholder, not a
// score -- this runtime has produced reasonless 100s, and a promotion artifact
// once overrode honest gatekeeper novelty of 20-42 with a floor of 95. Recording
// whether the number was accounted for is what lets a later reader tell a real
// peak from an artifact of the pipeline.
// Each review names its rubric differently -- `rubric` on the gate,
// `conclusion_rubric`, `paper_rubric`, `approval_rubric` elsewhere. The first
// version of this looked only for `rubric`, so four of the five trajectories
// recorded an empty one and the regression they were built to expose was
// invisible in exactly the reviews that carry the manuscript.
const RUBRIC_FIELDS = [
  "rubric",
  "gate_rubric",
  "conclusion_rubric",
  "paper_rubric",
  "report_rubric",
  "approval_rubric",
  "rubric_scores",
];

// Rubrics whose score is NOT their own reviewer's. The gate takes each rubric
// from the gatekeeper focused on it; a rubric nobody focused on yet is filled
// from another reviewer's cross-rubric row and listed as pending, and a review
// with any pending rubric cannot pass.
// MEASURED ON cycle-a-20260919, 2026-10-26: a round recorded
// 'score 85, pass false' -- the five numbers of one impact-focused gatekeeper,
// who had challenged it (impact 78) -- while no novelty, technical-quality,
// reproducibility or clarity reviewer had reported on that lead. The history
// carried the 85 and nothing saying it was a quarter of a review, and it read
// as a gate that should have passed.
function unreviewedRubrics(review) {
  const names = new Set(asArray(review?.gatekeeper_pending_rubrics).map((name) => String(name)));
  const rubric = Array.isArray(review?.rubric) ? review.rubric : [];
  for (const row of rubric) {
    if (row && typeof row === "object" && row.focused_review_missing === true && row.name) names.add(String(row.name));
  }
  return [...names].sort();
}

function rubricSnapshot(review) {
  const rubric = RUBRIC_FIELDS.map((field) => review?.[field]).find(
    (value) => Array.isArray(value) ? value.length : value && typeof value === "object",
  );
  const scores = {};
  const accounted = {};
  if (Array.isArray(rubric)) {
    for (const row of rubric) {
      if (!row || typeof row !== "object") continue;
      const name = String(row.name || row.rubric || "").trim();
      if (!name) continue;
      scores[name] = row.score == null ? null : Number(row.score);
      accounted[name] = asArray(row.reasons).length > 0;
    }
  } else if (rubric && typeof rubric === "object") {
    for (const [name, value] of Object.entries(rubric)) {
      scores[name] = value == null ? null : Number(value);
      accounted[name] = null;
    }
  }
  return { scores, accounted };
}

function blockerCount(review) {
  for (const key of ["blockers", "paper_blockers", "conclusion_blockers", "gate_blockers"]) {
    const value = review?.[key];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

function scoreOf(review) {
  for (const key of ["score", "gate_score", "paper_score", "conclusion_score", "approval_score", "report_score"]) {
    const value = review?.[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function passOf(review) {
  for (const key of ["pass", "gate_passed", "paper_gate_passed", "conclusion_gate_passed",
    "approval_gate_passed", "report_gate_passed"]) {
    if (typeof review?.[key] === "boolean") return review[key];
  }
  return null;
}

// What the review was ABOUT. A score is not comparable across leads, so a
// trajectory that cannot name its subject cannot be read as progress or
// regression -- which is how a lead that scored at the threshold came to sit
// dormant while later, lower-scoring work replaced it.
function subjectOf(review) {
  const identity = review?.current_hypothesis_identity || review?.hypothesis_identity;
  if (identity && typeof identity === "object") {
    // The recorded shape carries no id: it is {source_path, source_mtime,
    // accessions, primary_text}. `primary_text` is what names the lead, so the
    // opening of it is the subject. Reading for a `hypothesis_id` that does not
    // exist is how the first version recorded every peak as subject: null --
    // and a trajectory that cannot name its subject cannot be read as progress
    // or regression, which was the whole reason for recording one.
    const named = identity.hypothesis_id || identity.id || identity.family;
    if (named) return String(named).slice(0, 160);
    if (identity.primary_text) return String(identity.primary_text).trim().slice(0, 160);
    if (Array.isArray(identity.accessions) && identity.accessions.length) {
      return String(identity.accessions[0]).slice(0, 160);
    }
    return null;
  }
  const direct = review?.hypothesis_id || review?.lead_hypothesis_id || review?.primary_family;
  return direct ? String(direct).slice(0, 160) : null;
}

// A gate score is a judgment of a lead at one validation-evidence revision.
// New runner evidence intentionally supersedes the reviews of the previous
// revision, so those two scores are not competing computations of one gate.
function evidenceRevisionOf(review) {
  if (review?.type !== "gate_review" && !review?.gatekeeper_progress_signals) return null;
  const identity = review?.current_hypothesis_identity || {};
  const validationLaneId = review?.latest_validation_lane_id
    || review?.gatekeeper_progress_signals?.latest_validation_lane_id
    || null;
  const analysisContractId = identity?.analysis_contract_id || null;
  if (!validationLaneId && !analysisContractId) return null;
  return {
    analysis_contract_id: analysisContractId,
    validation_lane_id: validationLaneId,
  };
}

function fingerprint(entry) {
  return JSON.stringify([
    entry.score,
    entry.pass,
    entry.blockers,
    entry.subject,
    entry.evidence_revision,
    entry.rubric,
    entry.unreviewed_rubrics,
    entry.mode,
  ]);
}

function lastFingerprint(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = text.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      return fingerprint(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Append one line for this review, if anything about it changed.
 *
 * Never rewrites, never truncates, never throws: a history that can break the
 * pass that writes it would be worse than no history, and this runtime has
 * already lost a cycle to a document step that could abort the research loop.
 */
function recordReviewSnapshot({ root, cycleId, kind, review }) {
  if (!root || !cycleId || !kind || !review || typeof review !== "object") return null;
  try {
    const { scores, accounted } = rubricSnapshot(review);
    const entry = {
      ts: new Date().toISOString(),
      kind,
      score: scoreOf(review),
      pass: passOf(review),
      blockers: blockerCount(review),
      subject: subjectOf(review),
      // MEASURED ON cycle-a-20260919, 2026-10-17: scores returned to
      // zero after runners 391, 398 and 402 completed. The history omitted the
      // new validation basis, making three distinct gates look like one gate
      // oscillating between two computations.
      evidence_revision: kind === "gate-review" ? evidenceRevisionOf(review) : undefined,
      rubric: scores,
      // Which of those numbers were accounted for by stated reasons.
      rubric_accounted: accounted,
      // Gate rounds only: which rubrics had no reviewer of their own yet (a
      // round with any of these cannot pass), and the gate's verdict.
      unreviewed_rubrics: kind === "gate-review" ? unreviewedRubrics(review) : undefined,
      mode: kind === "gate-review" ? (review.mode || review.decision_mode || undefined) : undefined,
    };
    const filePath = historyPath(root, cycleId, kind);
    if (lastFingerprint(filePath) === fingerprint(entry)) return null;
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  } catch {
    return null;
  }
}

/**
 * The recorded trajectory, oldest first. Cheap: these lines are hundreds of
 * bytes and only change appends one.
 */
function readReviewHistory({ root, cycleId, kind }) {
  let text;
  try {
    text = fs.readFileSync(historyPath(root, cycleId, kind), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // A torn line is one lost sample, not a lost history.
    }
  }
  return out;
}

/**
 * The best this cycle ever reached on each rubric, and what it reads now.
 *
 * Only entries whose numbers were accounted for count toward a peak, so a
 * reasonless 100 cannot become the bar the cycle is judged to have lost.
 */
function peakVersusCurrent({ root, cycleId, kind }) {
  const history = readReviewHistory({ root, cycleId, kind });
  if (!history.length) return null;
  const peaks = {};
  for (const entry of history) {
    for (const name of Object.keys(entry.rubric || {})) {
      const value = entry.rubric[name];
      if (typeof value !== "number") continue;
      if (entry.rubric_accounted && entry.rubric_accounted[name] === false) continue;
      if (!peaks[name] || value > peaks[name].score) {
        peaks[name] = { score: value, ts: entry.ts, subject: entry.subject };
      }
    }
  }
  const latest = history[history.length - 1];
  const regressed = [];
  for (const [name, peak] of Object.entries(peaks)) {
    const now = latest.rubric?.[name];
    if (typeof now === "number" && now < peak.score) {
      regressed.push({ rubric: name, peak: peak.score, peak_at: peak.ts, peak_subject: peak.subject, now });
    }
  }
  regressed.sort((a, b) => (b.peak - b.now) - (a.peak - a.now));
  return {
    samples: history.length,
    first_at: history[0].ts,
    latest_at: latest.ts,
    latest_score: latest.score,
    peak_score: history.reduce((best, e) => (typeof e.score === "number" && e.score > best ? e.score : best), -Infinity),
    peaks,
    regressed,
  };
}

module.exports = {
  RUBRIC_KEYS,
  historyPath,
  recordReviewSnapshot,
  readReviewHistory,
  peakVersusCurrent,
};
