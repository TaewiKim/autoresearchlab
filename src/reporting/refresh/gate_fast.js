"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { buildApprovalReview } = require("../approval_review");
const { buildGateReview } = require("../gate_review");
const { refreshStoredPrimaryEvidence } = require("./primary_evidence");
const { readJsonIfExists, summarizeCycleState } = require("./state");

function refreshGateOutputs({ cwd = process.cwd(), cycleId }) {
  const root = runtimeRoot(cwd);
  const stateRoot = path.join(root, "state");
  const researcherViewPath = path.join(root, "researcher-views", `${cycleId}-researcher-view.json`);
  const researcherView = refreshStoredPrimaryEvidence({ root, cycleId }).view || {};
  if (researcherView && typeof researcherView === "object") {
    researcherView.jsonPath = researcherView.jsonPath || researcherViewPath;
  }

  const conclusionReview = {
    review: readJsonIfExists(path.join(stateRoot, `${cycleId}-conclusion-review.json`)) || {},
  };
  const existingApprovalReview = {
    review: readJsonIfExists(path.join(stateRoot, `${cycleId}-approval-review.json`)) || {},
  };
  const reportReview = {
    review: readJsonIfExists(path.join(stateRoot, `${cycleId}-report-review.json`)) || {},
  };
  const paperReview = {
    review: readJsonIfExists(path.join(stateRoot, `${cycleId}-paper-review.json`)) || {},
  };

  const gateReview = buildGateReview({
    cwd,
    cycleId,
    researcherView,
    conclusionReview,
    approvalReview: existingApprovalReview,
  });
  const approvalReview = buildApprovalReview({
    cwd,
    cycleId,
    researcherView,
    conclusionReview,
    gateReview,
    reportReview,
    paperReview,
    staged: true,
  });
  const cycleSummary = summarizeCycleState({ cwd, cycleId });

  return {
    cycle_id: cycleId,
    refresh_gate_fast: true,
    cycle_state: cycleSummary.cycleState,
    gate_review: gateReview,
    approval_review: approvalReview,
  };
}

module.exports = {
  refreshGateOutputs,
};
