"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureDir, writeJson } = require("../src/shared/json");
const { injectLabDirectorQueries } = require("../src/orchestrator/query_injection");

test("query injection enforces stage-valid role plans", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-query-"));
  const cycleId = "cycle-query-0001";
  const root = path.join(cwd, ".research-lab");
  const lanesRoot = path.join(root, "lanes", cycleId);
  ensureDir(path.join(lanesRoot, "scout-01"));
  ensureDir(path.join(lanesRoot, "author-01"));
  ensureDir(path.join(root, "plans"));
  ensureDir(path.join(root, "state"));

  const manifestPath = path.join(root, "plans", `${cycleId}-lane-manifest.json`);
  writeJson(manifestPath, [
    { lane_id: "scout-01", role: "scout", model: "native-readonly" },
    { lane_id: "author-01", role: "author", model: "gpt-5.4" },
  ]);

  injectLabDirectorQueries({
    cwd,
    cycleId,
    prompt: "analyze vaccination effects",
    laneManifestPath: manifestPath,
    researchStage: "evidence",
  });

  assert.equal(fs.existsSync(path.join(lanesRoot, "scout-01", "role-plan.json")), true);
  assert.equal(fs.existsSync(path.join(lanesRoot, "author-01", "role-plan.json")), false);

  injectLabDirectorQueries({
    cwd,
    cycleId,
    prompt: "analyze vaccination effects",
    laneManifestPath: manifestPath,
    researchStage: "document",
  });

  assert.equal(fs.existsSync(path.join(lanesRoot, "author-01", "role-plan.json")), true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("initial Scout dispatch preserves its exact objective and adaptive search contract after skeleton compaction", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-query-scout-contract-"));
  const cycleId = "cycle-query-contract";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "scout-02");
  const exactObjective = `Determine when contact-risk-aware clarification improves shared robot autonomy. ${"Context that must be compacted. ".repeat(900)}`;
  try {
    ensureDir(laneRoot);
    ensureDir(path.join(root, "plans"));
    ensureDir(path.join(root, "state"));
    const manifestPath = path.join(root, "plans", `${cycleId}-lane-manifest.json`);
    writeJson(manifestPath, [{ lane_id: "scout-02", role: "scout", model: "gpt-5.6-terra" }]);
    injectLabDirectorQueries({ cwd, cycleId, prompt: exactObjective, laneManifestPath: manifestPath, researchStage: "evidence" });
    const rolePlan = JSON.parse(fs.readFileSync(path.join(laneRoot, "role-plan.json"), "utf8"));
    assert.equal(rolePlan._preflight_reduction, "skeletonized-for-token-budget");
    assert.equal(rolePlan.action_type, "reasoning_literature_scout");
    assert.equal(rolePlan.objective, exactObjective);
    assert.equal(rolePlan.screening_objective, exactObjective);
    assert.equal(rolePlan.search_agent_contract.agent_kind, "hypothesis_conditioned_literature_agent");
    assert.ok(Array.isArray(rolePlan.search_agent_contract.hypotheses));
    assert.ok(Array.isArray(rolePlan.search_agent_contract.required_field_facets));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("restart preserves a same-objective adaptive Scout plan with a literature checkpoint", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-query-scout-resume-"));
  const cycleId = "cycle-query-resume";
  const prompt = "Test whether uncertainty-triggered language clarification improves robot manipulation.";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "scout-02");
  try {
    ensureDir(laneRoot);
    ensureDir(path.join(root, "plans"));
    ensureDir(path.join(root, "state"));
    const manifestPath = path.join(root, "plans", `${cycleId}-lane-manifest.json`);
    writeJson(manifestPath, [{ lane_id: "scout-02", role: "scout", model: "gpt-6-luna" }]);
    const authoredPlan = {
      lane_id: "scout-02",
      role: "scout",
      objective: prompt,
      screening_objective: prompt,
      action_type: "reasoning_literature_scout",
      queries: ["uncertainty triggered clarification robot manipulation"],
      authored_hypotheses: [{ hypothesis_id: "H1", statement: "Clarification improves calibrated intervention." }],
      search_agent_contract: {
        contract_version: "adaptive-search-agent-v1",
        agent_kind: "hypothesis_conditioned_literature_agent",
        hypotheses: [{ hypothesis_id: "H1" }],
      },
    };
    writeJson(path.join(laneRoot, "role-plan.json"), authoredPlan);
    writeJson(path.join(laneRoot, "queries.json"), { queries: ["agent-refined inquiry"] });
    writeJson(path.join(laneRoot, "literature-candidates.json"), { papers: [{ id: "candidate-1" }] });

    injectLabDirectorQueries({ cwd, cycleId, prompt, laneManifestPath: manifestPath, researchStage: "evidence" });

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(laneRoot, "role-plan.json"), "utf8")), authoredPlan);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(laneRoot, "queries.json"), "utf8")), { queries: ["agent-refined inquiry"] });
    const summary = JSON.parse(fs.readFileSync(path.join(root, "plans", `${cycleId}-lab-director-query-plan.json`), "utf8"));
    assert.equal(summary.lanes[0].authored_hypotheses[0].hypothesis_id, "H1");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("approved scholarly scope replaces a stale data Scout instead of preserving its checkpoint", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-query-scout-policy-"));
  const cycleId = "cycle-query-policy";
  const prompt = "Find scholarly evidence on dataset evaluation feasibility.";
  const root = path.join(cwd, ".research-lab");
  const laneRoot = path.join(root, "lanes", cycleId, "scout-03");
  const oldPolicy = process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  try {
    ensureDir(laneRoot);
    ensureDir(path.join(root, "plans"));
    ensureDir(path.join(root, "state"));
    const manifestPath = path.join(root, "plans", `${cycleId}-lane-manifest.json`);
    writeJson(manifestPath, [{ lane_id: "scout-03", role: "scout", model: "python-external-driver" }]);
    writeJson(path.join(laneRoot, "role-plan.json"), {
      role: "scout", objective: prompt, screening_objective: prompt,
      action_type: "data_acquisition_followup", marker: "must-not-survive",
      search_agent_contract: { contract_version: "adaptive-search-agent-v1", agent_kind: "hypothesis_conditioned_literature_agent" },
    });
    writeJson(path.join(laneRoot, "literature-candidates.json"), { papers: [{ id: "old" }] });
    process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = "approved-scholarly-metadata-v1";

    injectLabDirectorQueries({ cwd, cycleId, prompt, laneManifestPath: manifestPath, researchStage: "evidence" });

    const refreshed = JSON.parse(fs.readFileSync(path.join(laneRoot, "role-plan.json"), "utf8"));
    assert.notEqual(refreshed.marker, "must-not-survive");
    assert.equal(refreshed.action_type, "reasoning_literature_scout");
  } finally {
    if (oldPolicy === undefined) delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
    else process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY = oldPolicy;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
