"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  allowedRolesForStage,
  approvalPassed,
  isRoleAllowedForStage,
  readResearchOutcome,
  stageForSummary,
} = require("../src/policy/stage_policy");

test("stage policy computes evidence and document stages correctly", () => {
  const evidenceSummary = {
    approval_review: {
      review: {
        mode: "wait",
        evidence_readiness: {
          ready: false,
          completed_core_lane_count: 1,
          running_core_lane_count: 0,
        },
      },
    },
    researcher_view: {
      summary: {
        claim_count: 0,
      },
    },
    literature: {
      summary: {
        hypothesis_count: 0,
      },
    },
  };
  assert.equal(stageForSummary(evidenceSummary), "evidence");
  assert.equal(isRoleAllowedForStage("evidence", "author"), false);
  assert.deepEqual(allowedRolesForStage("document"), [
    "lab-director",
    "chronicle",
    "author",
    "illustrator",
  ]);

  const documentSummary = {
    conclusion_review: {
      review: {
        conclusion_gate_passed: true,
      },
    },
    gate_review: {
      review: {
        gate_passed: true,
      },
    },
    report_review: {
      review: {
        communication_gate_passed: true,
      },
    },
    paper_review: {
      review: {
        submission_gate_passed: true,
      },
    },
  };
  assert.equal(stageForSummary(documentSummary), "done");
  assert.equal(approvalPassed(documentSummary), true);
});

test("planning-only scope removes LabRunner dispatch without removing Analyst design", () => {
  const roles = allowedRolesForStage("evidence", { researchScope: "planning-only" });
  assert.ok(roles.includes("analyst"));
  assert.equal(roles.includes("lab-runner"), false);
});

test("stage policy prefers canonical research outcome semantics", () => {
  const pivotSummary = {
    researcher_view: {
      summary: {
        research_outcome: "pivot",
      },
    },
    gate_review: {
      review: {
        mode: "challenge",
        gate_passed: false,
      },
    },
  };
  assert.equal(readResearchOutcome(pivotSummary), "pivot");
  assert.equal(stageForSummary(pivotSummary), "evidence");

  const approvedButDocumentPending = {
    researcher_view: {
      summary: {
        research_outcome: "approved",
      },
    },
    report_review: {
      review: {
        communication_gate_passed: true,
      },
    },
    paper_review: {
      review: {
        submission_gate_passed: false,
      },
    },
  };
  assert.equal(stageForSummary(approvedButDocumentPending), "document");
  assert.equal(approvalPassed(approvedButDocumentPending), false);
});

test("stage policy honors gate pivot before conclusion bookkeeping catches up", () => {
  const summary = {
    conclusion_review: {
      review: {
        conclusion_gate_passed: false,
      },
    },
    gate_review: {
      review: {
        mode: "reject",
        decision_mode: "pivot",
        gate_passed: false,
        recommended_followup_actions: [
          { type: "gate_restart_followup", preferred_role: "lab-director" },
        ],
      },
    },
  };
  assert.equal(stageForSummary(summary), "evidence");
});

test("stage policy treats rejected gate verdicts as restart demand even without explicit action", () => {
  const summary = {
    conclusion_review: {
      review: {
        conclusion_gate_passed: true,
      },
    },
    gate_review: {
      review: {
        gate_passed: false,
        score: 20,
        gatekeeper_review: {
          verdict: "reject",
        },
        recommended_followup_actions: [],
      },
    },
  };

  assert.equal(stageForSummary(summary), "evidence");
});

test("evidence saturation breaks the scout-loop deadlock (advances to conclusion so the analyst runs)", () => {
  // Deadlock state observed live: many evidence lanes completed, none running,
  // but zero claims/hypotheses (the analyst that would create them never ran).
  const base = {
    approval_review: {
      review: {
        mode: "wait",
        evidence_readiness: {
          ready: false,
          completed_core_lane_count: 3,
          running_core_lane_count: 0,
        },
      },
    },
    researcher_view: { summary: { claim_count: 0 } },
    literature: { summary: { hypothesis_count: 0 } },
  };

  // Not yet saturated (few evidence lanes) → keep gathering evidence.
  base.approval_review.review.evidence_readiness.completed_evidence_lane_count = 3;
  assert.equal(stageForSummary(base), "evidence");

  // Saturated (>=8 evidence lanes done, nothing running, still no
  // claims/hypotheses) → stop looping; advance to conclusion so the analyst
  // dispatches and converts evidence into hypotheses.
  base.approval_review.review.evidence_readiness.completed_evidence_lane_count = 29;
  assert.equal(stageForSummary(base), "conclusion");
});

test("evidence saturation does NOT short-circuit while core lanes are still running", () => {
  const summary = {
    approval_review: {
      review: {
        mode: "wait",
        evidence_readiness: {
          ready: false,
          completed_core_lane_count: 3,
          completed_evidence_lane_count: 29,
          running_core_lane_count: 1,
        },
      },
    },
    researcher_view: { summary: { claim_count: 0 } },
    literature: { summary: { hypothesis_count: 0 } },
  };
  assert.equal(stageForSummary(summary), "evidence");
});
