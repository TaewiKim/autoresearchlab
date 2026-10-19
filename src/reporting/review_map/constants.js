"use strict";

const STAGE_BY_ROLE = {
  scout: "01-discovery",
  chronicle: "02-chronicle-synthesis",
  "lab-director": "03-hypothesis-strategy",
  analyst: "04-analysis-design",
  "lab-runner": "05-validation-execution",
  gatekeeper: "06-independent-gate",
  author: "07-document-authoring",
  illustrator: "08-figures",
};

const PRIMARY_LANE_FILES = [
  "task.md",
  "role-plan.json",
  "run-state.json",
  "result.json",
  "final-status.json",
  "launcher.stdout.log",
  "launcher.stderr.log",
];

const PRIMARY_LANE_FILE_NAMES = new Set(PRIMARY_LANE_FILES);

const PRIMARY_ARTIFACT_NAMES = new Set([
  "handoff-validation-plan.json",
  "validation-summary.json",
  "result.json",
  "summary.md",
  "analysis-trace.json",
  "hypothesis-results.json",
  "figure-spec.json",
  "derived-indicators.json",
  "external_repository_workflow_result.json",
  "external_repository_agent_summary.json",
]);

const DEFAULT_MAX_ALIASES = 100;
const DEFAULT_MAX_TERMINAL_LANES = 60;
const ROLE_PLAN_PREFIX_BYTES = 16 * 1024;

module.exports = {
  DEFAULT_MAX_ALIASES,
  DEFAULT_MAX_TERMINAL_LANES,
  PRIMARY_ARTIFACT_NAMES,
  PRIMARY_LANE_FILE_NAMES,
  ROLE_PLAN_PREFIX_BYTES,
  STAGE_BY_ROLE,
};
