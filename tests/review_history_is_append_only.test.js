"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  recordReviewSnapshot,
  readReviewHistory,
  peakVersusCurrent,
  historyPath,
} = require("../src/reporting/review_history");

// cycle-g-v89 ran for ten days and could not say what its own score had been.
// Every review is written to one path and rewritten on each refresh, so the
// only record of a previous value was whatever a later pass had not yet
// replaced. Reconstructing the series needed a 4.1 GB decision ledger that
// dumps whole review snapshots -- and that ledger stopped recording rubric
// numbers after day one, so it could not answer either.
//
// Meanwhile the cycle's best lead scored at the threshold on 09-01 and was
// still sitting `contending`, unworked, on 09-10 at a score of 27.

const CYCLE = "cg-gate-test-0001";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-history-"));
}

function review({ score, rubric, reasons = ["measured"], subject = "hyp:lead-a", blockers = [] }) {
  return {
    score,
    pass: score >= 90,
    blockers,
    current_hypothesis_identity: { hypothesis_id: subject },
    rubric: Object.entries(rubric).map(([name, value]) => ({ name, score: value, reasons })),
  };
}

test("an unchanged review appends nothing", () => {
  // Reviews rebuild on every refresh, thousands of times, and almost every
  // rebuild is identical. Appending each one is how the ledger this replaces
  // reached 4.1 GB.
  const root = tempRoot();
  const first = review({ score: 90, rubric: { novelty: 100 } });
  assert.ok(recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: first }));
  assert.equal(recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: first }), null);
  assert.equal(recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: first }), null);
  assert.equal(readReviewHistory({ root, cycleId: CYCLE, kind: "gate-review" }).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("history is appended, never rewritten", () => {
  const root = tempRoot();
  for (const score of [90, 64, 50, 27]) {
    recordReviewSnapshot({
      root, cycleId: CYCLE, kind: "gate-review",
      review: review({ score, rubric: { novelty: score } }),
    });
  }
  const file = historyPath(root, CYCLE, "gate-review");
  const before = fs.readFileSync(file, "utf8");
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({ score: 31, rubric: { novelty: 31 } }),
  });
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.startsWith(before), "the earlier lines must still be there, byte for byte");
  assert.equal(readReviewHistory({ root, cycleId: CYCLE, kind: "gate-review" }).length, 5);
  fs.rmSync(root, { recursive: true, force: true });
});

test("gate history records a new validation revision even when its score is unchanged", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-17: runners 391, 398 and
  // 402 each superseded the prior gatekeeper reviews, but compact history kept
  // only the lead text and made their distinct gate computations look alike.
  const root = tempRoot();
  const gate = (validationLane) => ({
    ...review({ score: 0, rubric: { novelty: 0 } }),
    type: "gate_review",
    latest_validation_lane_id: validationLane,
    current_hypothesis_identity: {
      hypothesis_id: "hyp:adaptive-acquisition",
      analysis_contract_id: "analysis:59a",
    },
  });
  recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: gate("followup-runner-391") });
  recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: gate("followup-runner-398") });

  const rows = readReviewHistory({ root, cycleId: CYCLE, kind: "gate-review" });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.evidence_revision.validation_lane_id), [
    "followup-runner-391",
    "followup-runner-398",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the peak names the lead it was reached on, and the regression is visible", () => {
  // v89 in miniature: the rejection-map lead scores at the threshold, the cycle
  // moves to another line, and ten days later everything is far below.
  const root = tempRoot();
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({
      score: 90,
      subject: "hyp:rejection-map-inversion-v1",
      rubric: { novelty: 100, technical_quality: 98, reproducibility: 100, clarity: 100, impact: 100 },
    }),
  });
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({
      score: 27,
      subject: "hyp:zfb",
      rubric: { novelty: 42, technical_quality: 22, reproducibility: 14, clarity: 42, impact: 15 },
    }),
  });
  const report = peakVersusCurrent({ root, cycleId: CYCLE, kind: "gate-review" });
  assert.equal(report.peak_score, 90);
  assert.equal(report.latest_score, 27);
  const worst = report.regressed[0];
  assert.equal(worst.rubric, "reproducibility");
  assert.equal(worst.peak, 100);
  assert.equal(worst.now, 14);
  assert.equal(
    worst.peak_subject,
    "hyp:rejection-map-inversion-v1",
    "a score is not comparable across leads, so the peak has to name its subject",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a score with no reasons cannot become the peak", () => {
  // This runtime has produced reasonless 100s, and a promotion artifact once
  // overrode honest gatekeeper novelty of 20-42 with a floor of 95. An
  // unaccounted number must not become the bar the cycle is judged to have lost.
  const root = tempRoot();
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({ score: 99, rubric: { novelty: 100 }, reasons: [] }),
  });
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({ score: 55, rubric: { novelty: 55 }, reasons: ["cited prior art"] }),
  });
  const report = peakVersusCurrent({ root, cycleId: CYCLE, kind: "gate-review" });
  assert.equal(report.peaks.novelty.score, 55, "the reasonless 100 is recorded but is not a peak");
  assert.deepEqual(report.regressed, [], "and so it cannot manufacture a regression");
  // It is still on disk: recording it and trusting it are different things.
  const lines = readReviewHistory({ root, cycleId: CYCLE, kind: "gate-review" });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].rubric_accounted.novelty, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("recording never throws, whatever it is handed", () => {
  // A history that can break the pass that writes it would be worse than no
  // history: this runtime has already lost a cycle to a document step that
  // could abort the research loop.
  const root = tempRoot();
  for (const bad of [null, undefined, 42, "review", [], { rubric: "not a list" }]) {
    assert.doesNotThrow(() =>
      recordReviewSnapshot({ root, cycleId: CYCLE, kind: "gate-review", review: bad }));
  }
  assert.equal(recordReviewSnapshot({ root: null, cycleId: CYCLE, kind: "x", review: {} }), null);
  assert.deepEqual(readReviewHistory({ root, cycleId: "never-written", kind: "gate-review" }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("one sample costs a few hundred bytes, not a megabyte", () => {
  // The ledger this replaces averages 600 KB per entry.
  const root = tempRoot();
  recordReviewSnapshot({
    root, cycleId: CYCLE, kind: "gate-review",
    review: review({
      score: 90,
      rubric: { novelty: 100, technical_quality: 98, reproducibility: 100, clarity: 100, impact: 100 },
      blockers: ["one", "two", "three"],
    }),
  });
  const size = fs.statSync(historyPath(root, CYCLE, "gate-review")).size;
  assert.ok(size < 2048, `a sample should be small, got ${size} bytes`);
  fs.rmSync(root, { recursive: true, force: true });
});
