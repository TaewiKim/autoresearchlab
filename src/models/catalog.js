"use strict";

const path = require("path");
const { runtimeRoot } = require("../runtime/native_client");
const { ensureDir, writeJson } = require("../shared/json");

const SUPPORTED_RUNTIMES = ["codex", "claude"];

function normalizeRuntime(runtime) {
  const value = String(runtime || "codex").trim().toLowerCase();
  if (!SUPPORTED_RUNTIMES.includes(value)) {
    throw new Error(`unsupported agent runtime: ${runtime}`);
  }
  return value;
}

function codexCatalog() {
  return {
    provider: "openai-compatible",
    runtime: "codex",
    updated_at: new Date().toISOString(),
    models: [
      {
        id: "gpt-6-astra",
        family: "gpt-6",
        tier: "frontier-adjudication",
        strengths: ["novelty synthesis", "hypothesis tournament", "decisive scientific adjudication"],
        suitable_roles: ["lab-director", "gatekeeper"],
        routing_policy: "reserved-for-complex-novelty-and-decisive-adjudication",
        token_policy: "use-at-most-two-decisive-routes-per-cycle",
      },
      {
        id: "gpt-6.1-sol",
        family: "gpt-6",
        tier: "frontier",
        strengths: ["planning", "synthesis", "complex reasoning", "final review"],
        suitable_roles: [
          "lab-director",
          "chronicle",
          "author",
          "illustrator",
          "analyst",
          "gatekeeper",
          "scout",
        ],
        token_policy: "deep-synthesis-and-falsification",
      },
      {
        id: "gpt-6.1-terra",
        family: "gpt-6",
        tier: "balanced",
        strengths: ["structured reasoning", "validation-code generation", "execution scaffolding"],
        suitable_roles: ["lab-director", "chronicle", "author", "illustrator", "analyst", "gatekeeper", "scout", "lab-runner"],
        token_policy: "default-structured-agent-work",
      },
      {
        id: "gpt-6-luna",
        family: "gpt-5",
        tier: "efficient",
        strengths: ["high-volume triage", "query refinement", "summarization", "routine formatting"],
        suitable_roles: ["chronicle", "author", "illustrator", "scout"],
        token_policy: "high-volume-low-complexity-work",
      },
      // Kept as a runtime compatibility label. It is not selected by the
      // router, which always emits an explicit model id above.
      {
        id: "codex-agent",
        family: "codex",
        tier: "tool-using-runtime",
        strengths: ["code-editing", "execution scaffolding", "structured iteration"],
        suitable_roles: ["lab-director", "chronicle", "author", "illustrator", "analyst", "gatekeeper"],
      },
      {
        id: "python-external-driver",
        family: "external-driver",
        tier: "deterministic",
        strengths: ["data analysis", "literature retrieval"],
        suitable_roles: ["scout", "analyst", "lab-runner"],
      },
      {
        id: "native-readonly-runtime",
        family: "native-runtime",
        tier: "fast-path",
        strengths: ["inventory", "read-only scanning", "cheap checks"],
        suitable_roles: ["scout"],
      },
    ],
  };
}

function claudeCatalog() {
  return {
    provider: "anthropic",
    runtime: "claude",
    updated_at: new Date().toISOString(),
    models: [
      {
        id: "claude-opus-4-7",
        family: "claude-4",
        tier: "frontier",
        strengths: ["planning", "synthesis", "complex reasoning", "final review"],
        suitable_roles: ["lab-director"],
      },
      {
        id: "claude-sonnet-4-6",
        family: "claude-4",
        tier: "standard",
        strengths: ["synthesis", "review", "structured iteration", "tool use"],
        // lab-runner is included here because the claude tier mapping consolidates
        // around sonnet — there is no claude-side equivalent of gpt-5.3-codex-spark.
        suitable_roles: [
          "chronicle",
          "author",
          "illustrator",
          "analyst",
          "gatekeeper",
          "lab-runner",
        ],
      },
      {
        id: "claude-haiku-4-5-20251001",
        family: "claude-4",
        tier: "efficient",
        strengths: ["parallel reasoning", "summarization", "follow-up analysis", "fast tool use"],
        suitable_roles: [],
      },
      {
        id: "python-external-driver",
        family: "external-driver",
        tier: "deterministic",
        strengths: ["data analysis", "literature retrieval"],
        suitable_roles: ["scout", "analyst", "lab-runner"],
      },
      {
        id: "native-readonly-runtime",
        family: "native-runtime",
        tier: "fast-path",
        strengths: ["inventory", "read-only scanning", "cheap checks"],
        suitable_roles: ["scout"],
      },
    ],
  };
}

function defaultCatalog(runtime = "codex") {
  const normalized = normalizeRuntime(runtime);
  if (normalized === "claude") return claudeCatalog();
  return codexCatalog();
}

function modelCatalogPath(cwd = process.cwd()) {
  return path.join(runtimeRoot(cwd), "indexes", "model-catalog.json");
}

function updateModelCatalog({ cwd = process.cwd(), runtime = null } = {}) {
  const effectiveRuntime = runtime
    || process.env.RESEARCHLAB_AGENT_RUNTIME
    || "codex";
  const catalog = defaultCatalog(effectiveRuntime);
  const catalogPath = modelCatalogPath(cwd);
  ensureDir(path.dirname(catalogPath));
  writeJson(catalogPath, catalog);
  return { catalogPath, catalog, runtime: catalog.runtime };
}

module.exports = {
  modelCatalogPath,
  updateModelCatalog,
  defaultCatalog,
  codexCatalog,
  claudeCatalog,
  normalizeRuntime,
  SUPPORTED_RUNTIMES,
};
