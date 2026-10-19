"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertHarnessSourceCurrent,
  isHarnessSourceChangedError,
  readSourceRevision,
} = require("../src/runtime/source_revision");
const { buildGateReview } = require("../src/reporting/gate_review");

test("the revision is read from the enclosing repository past an empty .git", () => {
  // The package lives at <repo>/researchlab and holds an empty .git directory
  // (cycle-a-20260919 volume and host, since 2026-09-18).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-source-revision-nested-"));
  const refPath = path.join(repo, ".git", "refs", "heads", "main");
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(refPath, `${"3".repeat(40)}\n`);
  const pkg = path.join(repo, "researchlab");
  fs.mkdirSync(path.join(pkg, ".git"), { recursive: true });
  assert.equal(readSourceRevision(pkg), "3".repeat(40));
  // And with no repository anywhere above, there is no revision.
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-source-revision-none-"));
  if (!readSourceRevision(path.dirname(lone))) assert.equal(readSourceRevision(lone), null);
});

test("a resident gate writer stops when fresh processes are running a newer harness revision", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-15: the history records
  // read by gate_oscillation were 0, 50, 0, 50 for the same lead. The resident
  // process wrote 0 with old supersession code while fresh refresh-gate
  // processes at the new HEAD wrote 50 from the same five gatekeeper records.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-source-revision-"));
  const gitDir = path.join(cwd, ".git");
  const refPath = path.join(gitDir, "refs", "heads", "main");
  const oldRevision = "1".repeat(40);
  const newRevision = "2".repeat(40);
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(refPath, `${oldRevision}\n`);

  const cycleId = "cycle-a-20260919";
  const stateDir = path.join(cwd, ".research-lab", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const build = () => buildGateReview({
    cwd,
    cycleId,
    researcherView: { summary: {} },
    conclusionReview: { review: {} },
    approvalReview: { review: {} },
  });

  assert.equal(readSourceRevision(cwd), oldRevision);
  build();
  assert.equal(assertHarnessSourceCurrent({ cwd }), oldRevision);
  const historyPath = path.join(stateDir, `${cycleId}-gate-review-history.jsonl`);
  const measuredHistory = [0, 50, 0, 50].map((score, index) => JSON.stringify({
    ts: `2026-10-15T00:${String(23 + index).padStart(2, "0")}:00Z`,
    kind: "gate-review",
    score,
    pass: false,
    blockers: score === 0 ? 3 : 132,
    subject: "Within one state-input MuJoCo pushing regime, use a calibration-first causal effect-modification procedure",
    rubric: { novelty: score === 0 ? 0 : 76 },
  }));
  fs.writeFileSync(historyPath, `${measuredHistory.join("\n")}\n`);
  fs.writeFileSync(refPath, `${newRevision}\n`);

  assert.throws(
    () => build(),
    (error) => {
      assert.equal(isHarnessSourceChangedError(error), true);
      assert.equal(error.loaded_revision, oldRevision);
      assert.equal(error.current_revision, newRevision);
      return true;
    },
  );
  const scores = fs.readFileSync(historyPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).score);
  assert.deepEqual(scores, [0, 50, 0, 50], "the stale writer must not append another conflicting gate state");

  fs.rmSync(cwd, { recursive: true, force: true });
});
