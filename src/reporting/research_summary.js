"use strict";

const { refreshCycleOutputs } = require("./refresh_cycle");

function buildResearchSummary({ cwd, cycleId, prompt, result, queryPlanPath, materialized }) {
  const refreshed = refreshCycleOutputs({ cwd, cycleId });
  return {
    cycle_id: cycleId,
    prompt,
    query_plan_path: queryPlanPath,
    materialized,
    literature: refreshed.literature,
    hypothesis_ledger: refreshed.hypothesis_ledger,
    researcher_view: refreshed.researcher_view,
    conclusion_review: refreshed.conclusion_review,
    approval_review: refreshed.approval_review,
    gate_review: refreshed.gate_review,
    report_review: refreshed.report_review,
    paper_review: refreshed.paper_review,
    termination_code: refreshed.termination_code || null,
    result,
  };
}

module.exports = {
  buildResearchSummary,
};
