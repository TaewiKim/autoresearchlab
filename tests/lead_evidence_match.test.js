"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runnerExecutedIdentity,
  runnerHasRealExecution,
  runnerLeadMatchScore,
  pickLeadScopedRunner,
} = require("../src/agents/shared/lead_evidence_match");

const PHOTON_LEAD = {
  family: "online_photon_change_point_refresh_control",
  tokens: new Set(["photon", "change", "point", "caustic", "cusum", "guide", "refresh"]),
  hasIdentity: true,
};

function runnerResult({ family, statement, deferred }) {
  return {
    hypothesis_results: family ? [{ family, hypothesis_id: `hyp-${family}` }] : [],
    selected_hypotheses: statement ? [{ statement, claims: [{ statement }] }] : [],
    blueprint_executions: [
      { blueprint_id: deferred ? "none_deferred_no_matching_bundle" : "photon_guide_cusum_render_v1" },
    ],
  };
}

test("runnerExecutedIdentity extracts families and statement text", () => {
  const id = runnerExecutedIdentity(
    runnerResult({ family: "motion_compensated_temporal_error_shaping", statement: "temporal error shaping crossover" }),
  );
  assert.ok(id.families.has("motion_compensated_temporal_error_shaping"));
  assert.match(id.statementText, /temporal error shaping/);
});

test("runnerHasRealExecution: deferred blueprint is not a real execution", () => {
  assert.equal(runnerHasRealExecution(runnerResult({ family: "x", deferred: true })), false);
  assert.equal(runnerHasRealExecution(runnerResult({ family: "x", deferred: false })), true);
  assert.equal(runnerHasRealExecution({ blueprint_executions: [] }), false);
});

test("runnerLeadMatchScore: family match scores 2, off-family scores 0", () => {
  const onFamily = runnerResult({ family: "online_photon_change_point_refresh_control" });
  const offFamily = runnerResult({ family: "motion_compensated_temporal_error_shaping" });
  assert.equal(runnerLeadMatchScore(onFamily, PHOTON_LEAD), 2);
  assert.equal(runnerLeadMatchScore(offFamily, PHOTON_LEAD), 0);
});

test("runnerLeadMatchScore: explicit family mismatch cannot be rescued by shared prose", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-07: runner-181 explicitly
  // executed loss_refinement_support_factorial, but shared terms such as
  // diffusion/support/distance matched the new coverage-diversity lead.
  const stale = runnerResult({
    family: "loss_refinement_support_factorial",
    statement: "photon change point evidence for the unrelated old method",
  });
  assert.equal(runnerLeadMatchScore(stale, PHOTON_LEAD), 0);
});

test("runnerLeadMatchScore: statement-token overlap scores 1 when no family match", () => {
  const byStatement = {
    hypothesis_results: [],
    selected_hypotheses: [{ statement: "one-sided CUSUM change-point control on moving-caustic photon-guide scenes" }],
    blueprint_executions: [{ blueprint_id: "render_v1" }],
  };
  assert.equal(runnerLeadMatchScore(byStatement, PHOTON_LEAD), 1);
});

test("runnerLeadMatchScore: un-scopable (bio) runner returns null", () => {
  // Bio/epi runner: validation_summary + checks, no hypothesis_results / selected_hypotheses.
  const bioRunner = { validation_summary: { overall_status: "passed", checks: { auc: true } } };
  assert.equal(runnerLeadMatchScore(bioRunner, PHOTON_LEAD), null);
});

test("pickLeadScopedRunner: binds the on-family real-execution runner over a newer off-family deferred one", () => {
  const candidates = [
    {
      filePath: "/lanes/followup-runner-050/result.json",
      mtime: 100,
      result: runnerResult({ family: "online_photon_change_point_refresh_control", deferred: false }),
    },
    {
      filePath: "/lanes/followup-runner-112/result.json",
      mtime: 200, // newer, but off-family + deferred (this is the v61 bug case)
      result: runnerResult({ family: "motion_compensated_temporal_error_shaping", deferred: true }),
    },
  ];
  const picked = pickLeadScopedRunner(candidates, PHOTON_LEAD);
  assert.equal(picked.filePath, "/lanes/followup-runner-050/result.json");
});

test("pickLeadScopedRunner: prefers a real execution over a deferred same-family runner", () => {
  const candidates = [
    {
      filePath: "/lanes/runner-real.json",
      mtime: 100,
      result: runnerResult({ family: "online_photon_change_point_refresh_control", deferred: false }),
    },
    {
      filePath: "/lanes/runner-deferred.json",
      mtime: 300,
      result: runnerResult({ family: "online_photon_change_point_refresh_control", deferred: true }),
    },
  ];
  const picked = pickLeadScopedRunner(candidates, PHOTON_LEAD);
  assert.equal(picked.filePath, "/lanes/runner-real.json");
});

test("pickLeadScopedRunner: no lead identity -> latest by mtime (unchanged behavior)", () => {
  const candidates = [
    { filePath: "/a.json", mtime: 100, result: runnerResult({ family: "a" }) },
    { filePath: "/b.json", mtime: 200, result: runnerResult({ family: "b" }) },
  ];
  const picked = pickLeadScopedRunner(candidates, { hasIdentity: false });
  assert.equal(picked.filePath, "/b.json");
});

test("pickLeadScopedRunner: un-scopable runners -> the VALIDATED one, not merely the newest", () => {
  // v70 regression: the selected lead had no family, so this fallback ran and
  // bound the newest runner — which had failed with 0 passing checks — over an
  // older runner that had passed. Evidence must beat recency.
  const candidates = [
    { filePath: "/bio-a.json", mtime: 100, result: { validation_summary: { overall_status: "passed", checks: {} } } },
    { filePath: "/bio-b.json", mtime: 200, result: { validation_summary: { overall_status: "failed", checks: {} } } },
  ];
  const picked = pickLeadScopedRunner(candidates, PHOTON_LEAD);
  assert.equal(picked.filePath, "/bio-a.json");
});

test("pickLeadScopedRunner: newest still wins among equally-validated runners", () => {
  const candidates = [
    { filePath: "/old.json", mtime: 100, result: { validation_summary: { overall_status: "passed", checks: { a: true } } } },
    { filePath: "/new.json", mtime: 200, result: { validation_summary: { overall_status: "passed", checks: { a: true } } } },
  ];
  assert.equal(pickLeadScopedRunner(candidates, { hasIdentity: false }).filePath, "/new.json");
});

test("pickLeadScopedRunner: passing checks beat a merely-newest failed runner", () => {
  // The exact v70 shape: runner-01 passed 13/13, runner-98 failed 0/2 but newer.
  const candidates = [
    {
      filePath: "/runner-01.json",
      mtime: 100,
      result: { validation_summary: { overall_status: "passed", checks: { a: true, b: true, c: true } } },
    },
    {
      filePath: "/runner-98.json",
      mtime: 999,
      result: { validation_summary: { overall_status: "degraded", checks: { a: false, b: false } } },
    },
  ];
  assert.equal(pickLeadScopedRunner(candidates, { hasIdentity: false }).filePath, "/runner-01.json");
});

test("pickLeadScopedRunner: lead identity present but nothing matches -> latest by mtime (defensive fallback)", () => {
  const candidates = [
    { filePath: "/off-1.json", mtime: 100, result: runnerResult({ family: "unrelated_family_one" }) },
    { filePath: "/off-2.json", mtime: 200, result: runnerResult({ family: "unrelated_family_two" }) },
  ];
  const picked = pickLeadScopedRunner(candidates, PHOTON_LEAD);
  assert.equal(picked.filePath, "/off-2.json");
});
