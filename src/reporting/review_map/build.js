"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { DEFAULT_MAX_ALIASES, DEFAULT_MAX_TERMINAL_LANES } = require("./constants");
const { writeReviewMapAliases } = require("./alias_writer");
const { collectReviewMapEntries } = require("./collect_entries");
const { ensureDir, readJsonIfExistsBounded, resetGeneratedDirectory } = require("./fs_helpers");
const { writeReviewMapManifest } = require("./manifest");

function buildArtifactReviewMap({
  cwd = process.cwd(),
  cycleId,
  cycleState = null,
  maxAliases = DEFAULT_MAX_ALIASES,
  maxTerminalLanes = DEFAULT_MAX_TERMINAL_LANES,
}) {
  const root = runtimeRoot(cwd);
  const reviewMapRoot = path.join(root, "review-map", cycleId);
  const cycleStateValue =
    cycleState || readJsonIfExistsBounded(path.join(root, "state", `${cycleId}-cycle-run-state.json`), 8 * 1024 * 1024) || {};
  const entries = collectReviewMapEntries({ root, cycleId, cycleState: cycleStateValue, maxTerminalLanes });
  resetGeneratedDirectory(reviewMapRoot);
  ensureDir(reviewMapRoot);
  const aliases = writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases });
  const manifestPath = writeReviewMapManifest({
    root,
    reviewMapRoot,
    cycleId,
    entries,
    aliases,
    maxTerminalLanes,
  });
  return {
    manifest_path: manifestPath,
    review_map_root: reviewMapRoot,
    alias_count: aliases.length,
    total_entry_count: entries.length,
    truncated_aliases: entries.length > aliases.length,
  };
}

module.exports = {
  buildArtifactReviewMap,
};
