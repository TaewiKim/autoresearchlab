"use strict";

const path = require("path");
const { ensureDir, writeJson } = require("../shared/json");
const { updateModelCatalog } = require("../models/catalog");
const { runtimeRoot } = require("../runtime/native_client");
const { ensureMetadataStore } = require("../storage/metadata_store");

function initResearchLab(options = {}) {
  const cwd = options.cwd || process.cwd();
  const runtime = options.runtime
    || process.env.RESEARCHLAB_AGENT_RUNTIME
    || "codex";
  const root = runtimeRoot(cwd);
  const dirs = [
    "artifacts",
    "chronicle",
    "datasets",
    "events",
    "indexes",
    "lanes",
    "papers",
    "plans",
    "reports",
    "researcher-views",
    "runtime",
    "state",
    "viz",
  ];

  for (const dir of dirs) {
    ensureDir(path.join(root, dir));
  }

  const modelCatalog = updateModelCatalog({ cwd, runtime });
  const metadataDbPath = ensureMetadataStore({ cwd });
  const manifestPath = path.join(root, "runtime", "init.json");
  writeJson(manifestPath, {
    initialized_at: new Date().toISOString(),
    runtime_root: root,
    agent_runtime: modelCatalog.runtime,
    model_catalog_path: modelCatalog.catalogPath,
    model_count: modelCatalog.catalog.models.length,
    metadata_db_path: metadataDbPath,
  });

  return {
    runtime_root: root,
    init_path: manifestPath,
    model_catalog: modelCatalog,
    metadata_db_path: metadataDbPath,
  };
}

module.exports = {
  initResearchLab,
};
