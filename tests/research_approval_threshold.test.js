"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { followupActions, rubricBlockers } = require("../src/reporting/document_reviews/requests");
const { buildReportReview, buildPaperReview } = require("../src/reporting/document_reviews");

test("document followups stop at 80 and retain the below-threshold rubric", () => {
  const rubric = [
    { name: "methods", score: 80, applicable: true, reasons: [] },
    { name: "reproducibility", score: 79, applicable: true, reasons: ["missing provenance"] },
  ];
  assert.deepEqual(rubricBlockers(rubric), ["missing provenance"]);
  const actions = followupActions("report", rubric);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].target_rubric, "reproducibility");
  assert.equal(actions[0].target_score, 80);
});

test("80-point document floor still blocks absent reports and manuscripts", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-approval-80-"));
  try {
    const options = { cwd, cycleId: "approval-80" };
    const report = buildReportReview(options).review;
    const paper = buildPaperReview(options).review;
    assert.equal(report.threshold, 80);
    assert.equal(paper.threshold, 80);
    assert.equal(report.pass, false);
    assert.equal(paper.pass, false);
    assert.match(report.blockers.join("\n"), /no research report/);
    assert.match(paper.blockers.join("\n"), /no manuscript/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
