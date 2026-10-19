"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateVisualExecutionPlan } = require("../src/policy/visual_qa_policy");

test("visual QA prefers illustrator-authored packets when they pass baseline quality", () => {
  const result = evaluateVisualExecutionPlan({
    authoredPackets: [
      {
        figure_id: "authored-1",
        figure_title: "Authored Figure",
        priority: "highest",
        paired_takeaway: "Lead with the adjusted signal.",
        chart_type: "bar",
        evidence_links: ["claim-1"],
      },
    ],
    fallbackPackets: [
      {
        figure_id: "fallback-1",
        figure_title: "Fallback Figure",
      },
    ],
    figureRecommendations: [{ figure_id: "authored-1" }],
  });

  assert.equal(result.preferred_mode, "illustrator_authored_execution_packets");
  assert.equal(result.preferred_packets[0].figure_id, "authored-1");
});

test("visual QA falls back when illustrator-authored packets are too thin", () => {
  const result = evaluateVisualExecutionPlan({
    authoredPackets: [{ figure_id: "authored-weak" }],
    fallbackPackets: [
      {
        figure_id: "fallback-1",
        figure_title: "Fallback Figure",
        priority: "highest",
        paired_takeaway: "Use the deterministic baseline.",
        chart_type: "bar",
        evidence_links: ["claim-1"],
      },
    ],
    figureRecommendations: [{ figure_id: "fallback-1" }],
  });

  assert.equal(result.preferred_mode, "deterministic_baseline_plus_illustrator_refinement");
  assert.equal(result.preferred_packets[0].figure_id, "fallback-1");
});
