"use strict";

// "The document gates passed" was recorded as "the research is approved".
//
// The final claim package fires on the report gate and the paper gate alone and
// stamped research_outcome: "approved". approval_review short-circuits its whole
// staged ladder on that field, and the supervisor writes a terminal
// APPROVAL_GATE_PASSED off approval. So the moment cycle-g-v89's paper gate
// passed, the cycle recorded itself approved and stopped -- with its hypothesis
// gate holding 129 blockers at score 46 and its conclusion gate false.
//
// The owner's own authorization for that cycle says "the gate's reject stands
// and is not being rewritten". The manuscript obeyed it. The termination record
// did not.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { writeFinalClaimPackageIfReady } = require("../src/reporting/document_reviews");
const { buildApprovalReview } = require("../src/reporting/approval_review");

function scratch() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "final-claim-"));
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  return { cwd, root };
}

function writeState(root, cycleId, name, value) {
  fs.writeFileSync(path.join(root, "state", `${cycleId}-${name}.json`), JSON.stringify(value), "utf8");
}

const PASSING_DOCUMENTS = {
  reportReview: { report_gate_passed: true, report_path: "/r.md" },
  paperReview: { paper_gate_passed: true, paper_path: "/p.json" },
};

function writePackage(root, cycleId) {
  const outPath = writeFinalClaimPackageIfReady({ root, cycleId, ...PASSING_DOCUMENTS });
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

test("a rejected hypothesis gate is documented, not approved", () => {
  const { root } = scratch();
  const cycleId = "documented-cycle";
  writeState(root, cycleId, "gate-review", { review: { gate_passed: false, blockers: Array(129).fill("b") } });
  writeState(root, cycleId, "conclusion-review", { review: { conclusion_gate_passed: false } });
  writeState(root, cycleId, "document-authorization", {
    authorized: true,
    authorized_by: "owner",
    reason: "document this cycle; the gate's reject stands",
  });

  const pkg = writePackage(root, cycleId);
  assert.equal(pkg.research_outcome, "documented");
  assert.equal(pkg.decision_mode, "documented");
  assert.equal(pkg.hypothesis_gate_passed, false);
  assert.equal(pkg.conclusion_gate_passed, false);
  assert.equal(pkg.documented_under_authorization.authorized_by, "owner");
  // The document gates DID pass, and the package still says so.
  assert.equal(pkg.high_impact_document_gates_passed, true);
});

test("documented does not short-circuit the approval ladder", () => {
  const { cwd, root } = scratch();
  const cycleId = "documented-cycle";
  writeState(root, cycleId, "gate-review", { review: { gate_passed: false, score: 46, blockers: ["hypothesis gate blocker"] } });
  writeState(root, cycleId, "conclusion-review", { review: { conclusion_gate_passed: false, conclusion_score: 87 } });
  writePackage(root, cycleId);

  const { review } = buildApprovalReview({
    cwd,
    cycleId,
    staged: true,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        evidence_readiness: { ready: true, reasons: [] },
        approval_readiness_score: 46,
        approval_rubric: [{ name: "impact", score: 46, applicable: true, reasons: ["impact is low"] }],
        approval_blockers: ["impact is low"],
      },
    },
  });

  assert.equal(review.approval_gate_passed, false, "a documented cycle is not an approved one");
  assert.equal(review.all_stage_gates_passed, false);
});

test("when the research gates do pass, the package still says approved", () => {
  const { root } = scratch();
  const cycleId = "approved-cycle";
  writeState(root, cycleId, "gate-review", { review: { gate_passed: true } });
  writeState(root, cycleId, "conclusion-review", { review: { conclusion_gate_passed: true } });

  const pkg = writePackage(root, cycleId);
  assert.equal(pkg.research_outcome, "approved");
  assert.equal(pkg.hypothesis_gate_passed, true);
  assert.equal(pkg.documented_under_authorization, null);
});

test("a missing gate review is not an approval", () => {
  // Fail closed: absence of a verdict is not a passing verdict.
  const { root } = scratch();
  const cycleId = "no-gate-cycle";
  const pkg = writePackage(root, cycleId);
  assert.equal(pkg.research_outcome, "documented");
  assert.equal(pkg.hypothesis_gate_passed, false);
});
