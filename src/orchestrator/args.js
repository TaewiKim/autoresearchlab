"use strict";

function parseRunResearchArgs(argv) {
  const parsed = {
    prompt: null,
    cycleId: null,
    maxPasses: 8,
    maxPassesExplicit: false,
    sleepSeconds: 0,
    maxConcurrency: 4,
    staleSeconds: 1800,
    maxSupervisorPasses: null,
    maxEvidencePasses: null,
    maxApprovalPasses: null,
    maxDocumentPasses: null,
    breakOnStagnation: null,
    agentRuntime: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--prompt") parsed.prompt = next;
    // The research request as a file (Markdown); the same as --prompt with its text.
    if (token === "--prompt-file") parsed.prompt = require("fs").readFileSync(require("path").resolve(next), "utf8");
    if (token === "--cycle-id") parsed.cycleId = next;
    if (token === "--max-passes") {
      parsed.maxPasses = Number(next);
      parsed.maxPassesExplicit = true;
    }
    if (token === "--sleep-seconds") parsed.sleepSeconds = Number(next);
    if (token === "--max-concurrency") parsed.maxConcurrency = Number(next);
    if (token === "--stale-seconds") parsed.staleSeconds = Number(next);
    if (token === "--max-supervisor-passes") parsed.maxSupervisorPasses = Number(next);
    if (token === "--max-evidence-passes") parsed.maxEvidencePasses = Number(next);
    if (token === "--max-approval-passes") parsed.maxApprovalPasses = Number(next);
    if (token === "--max-document-passes") parsed.maxDocumentPasses = Number(next);
    if (token === "--break-on-stagnation") parsed.breakOnStagnation = true;
    if (token === "--no-break-on-stagnation") parsed.breakOnStagnation = false;
    if (token === "--agent-runtime") parsed.agentRuntime = next;
  }

  if (parsed.agentRuntime !== null) {
    const normalized = String(parsed.agentRuntime).trim().toLowerCase();
    if (normalized !== "codex" && normalized !== "claude") {
      throw new Error("--agent-runtime must be one of: codex, claude");
    }
    parsed.agentRuntime = normalized;
  }

  if (!parsed.prompt) {
    throw new Error("--prompt <text> or --prompt-file <path> is required");
  }
  if (!parsed.cycleId) {
    const slug = parsed.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    parsed.cycleId = `cycle-${slug.slice(0, 24) || "research"}`;
  }
  if (!Number.isFinite(parsed.maxPasses) || parsed.maxPasses <= 0) {
    throw new Error("--max-passes must be a positive number");
  }
  if (!Number.isFinite(parsed.sleepSeconds) || parsed.sleepSeconds < 0) {
    throw new Error("--sleep-seconds must be a non-negative number");
  }
  if (!Number.isFinite(parsed.maxConcurrency) || parsed.maxConcurrency <= 0) {
    throw new Error("--max-concurrency must be a positive number");
  }
  if (!Number.isFinite(parsed.staleSeconds) || parsed.staleSeconds <= 0) {
    throw new Error("--stale-seconds must be a positive number");
  }

  for (const [flag, value] of [
    ["--max-supervisor-passes", parsed.maxSupervisorPasses],
    ["--max-evidence-passes", parsed.maxEvidencePasses],
    ["--max-approval-passes", parsed.maxApprovalPasses],
    ["--max-document-passes", parsed.maxDocumentPasses],
  ]) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${flag} must be a non-negative number`);
    }
  }

  return parsed;
}

module.exports = {
  parseRunResearchArgs,
};
