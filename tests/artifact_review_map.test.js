"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildArtifactReviewMap } = require("../src/reporting/artifact_review_map");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("artifact review map creates stage and agent ordered aliases", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-review-map-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-review-map";
  const scoutDir = path.join(root, "lanes", cycleId, "scout-01");
  const runnerDir = path.join(root, "lanes", cycleId, "followup-runner-001");
  const runnerArtifactDir = path.join(root, "artifacts", "stats", cycleId, "followup-runner-001");

  writeJson(path.join(root, "state", `${cycleId}-cycle-run-state.json`), {
    lane_statuses: [
      { lane_id: "scout-01", role: "scout", status: "completed" },
      { lane_id: "followup-runner-001", role: "lab-runner", status: "completed" },
    ],
  });
  writeJson(path.join(scoutDir, "lane-contract.json"), { role: "scout" });
  writeJson(path.join(scoutDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(scoutDir, "result.json"), { papers: [{ id: "p1" }] });
  writeJson(path.join(runnerDir, "lane-contract.json"), { role: "lab-runner" });
  writeJson(path.join(runnerDir, "role-plan.json"), { action_type: "methods_followup" });
  writeJson(path.join(runnerDir, "final-status.json"), { status: "completed" });
  writeJson(path.join(runnerArtifactDir, "validation-summary.json"), { overall_status: "ok" });
  writeJson(path.join(root, "state", `${cycleId}-gate-review.json`), { score: 42 });

  const output = buildArtifactReviewMap({ cwd, cycleId });
  const manifest = JSON.parse(fs.readFileSync(output.manifest_path, "utf8"));

  assert.equal(manifest.cycle_id, cycleId);
  assert.ok(manifest.alias_count >= 4);
  assert.ok(manifest.entries.some((entry) => entry.stage === "01-discovery"));
  assert.ok(manifest.entries.some((entry) => entry.stage === "05-validation-execution"));
  assert.ok(manifest.entries.some((entry) => entry.by_stage_path.includes("by-stage")));
  assert.ok(
    fs.existsSync(path.join(root, "review-map", cycleId, "README.md")),
    "review map should include human-readable README",
  );
  assert.ok(
    fs.existsSync(path.join(root, "state", `${cycleId}-artifact-review-map.json`)),
    "review map manifest should be mirrored into state for Chronicle/LabDirector",
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});
