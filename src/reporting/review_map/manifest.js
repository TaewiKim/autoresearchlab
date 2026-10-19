"use strict";

const fs = require("fs");
const path = require("path");
const { STAGE_BY_ROLE } = require("./constants");

function writeReadme(reviewMapRoot, cycleId, manifestPath) {
  const text = [
    `# ResearchLab Review Map: ${cycleId}`,
    "",
    "This directory is a generated, review-facing projection of cycle artifacts.",
    "Original files stay in their normal lane/state/report locations; entries here are chronological aliases.",
    "",
    "Use `by-stage/` to follow the research development process:",
    "- `01-discovery`: scout and source discovery outputs",
    "- `02-chronicle-synthesis`: Chronicle graph, trend, and DCI corpus artifacts",
    "- `03-hypothesis-strategy`: LabDirector hypothesis and strategy outputs",
    "- `04-analysis-design`: analyst handoffs and validation designs",
    "- `05-validation-execution`: lab-runner results and external workflow evidence",
    "- `06-independent-gate`: gate and review outputs",
    "- `07-document-authoring`: report, paper, and authoring artifacts",
    "- `08-figures`: figure and deck artifacts",
    "- `09-monitoring-and-state`: state, watchdog, and cycle-level materializations",
    "",
    "Use `by-agent/` to inspect one role or lane without searching the whole runtime tree.",
    `Machine-readable manifest: ${path.relative(reviewMapRoot, manifestPath)}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(reviewMapRoot, "README.md"), text, "utf8");
}

function buildReviewMapManifest({ root, reviewMapRoot, cycleId, entries, aliases, maxTerminalLanes }) {
  return {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    generated_by: "artifact-review-map",
    purpose: "stage-ordered and agent-ordered artifact aliases for LabDirector and Chronicle review",
    source_policy: "aliases point to original artifacts; original lane/state/report paths remain authoritative",
    alias_count: aliases.length,
    total_entry_count: entries.length,
    truncated_aliases: entries.length > aliases.length,
    lane_selection_policy: {
      pending_running_failed_unknown_included: true,
      max_terminal_lanes: maxTerminalLanes,
    },
    root: path.relative(root, reviewMapRoot),
    views: {
      by_stage: path.relative(root, path.join(reviewMapRoot, "by-stage")),
      by_agent: path.relative(root, path.join(reviewMapRoot, "by-agent")),
    },
    stages: Object.values(STAGE_BY_ROLE).concat(["09-monitoring-and-state"]),
    entries: aliases,
  };
}

function writeReviewMapManifest({ root, reviewMapRoot, cycleId, entries, aliases, maxTerminalLanes }) {
  const manifest = buildReviewMapManifest({
    root,
    reviewMapRoot,
    cycleId,
    entries,
    aliases,
    maxTerminalLanes,
  });
  const manifestPath = path.join(reviewMapRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  fs.writeFileSync(
    path.join(root, "state", `${cycleId}-artifact-review-map.json`),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(reviewMapRoot, "timeline.json"),
    JSON.stringify(aliases.map((entry) => ({
      sequence: entry.sequence,
      updated_at: entry.updated_at,
      stage: entry.stage,
      role: entry.role,
      lane_id: entry.lane_id,
      action_type: entry.action_type,
      status: entry.status,
      artifact_kind: entry.artifact_kind,
      source_path: entry.source_path_relative,
      by_stage_path: entry.by_stage_path,
    })), null, 2),
    "utf8",
  );
  writeReadme(reviewMapRoot, cycleId, manifestPath);
  return manifestPath;
}

module.exports = {
  buildReviewMapManifest,
  writeReadme,
  writeReviewMapManifest,
};
