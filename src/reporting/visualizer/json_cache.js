"use strict";

const fs = require("fs");
const { readJson } = require("../../shared/json");

// One parsed copy of a JSON file, for as long as the file is what was parsed.
//
// The collectors that build a researcher view read the same files many times
// in one refresh -- the hypothesis ledger, the claim traces, a window of lane
// results -- so the parse is worth keeping. It used to be kept under a key of
// path + size + mtime, in a map nothing ever removed from: every NEW version
// of a file was a new entry and every old version stayed.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: the state files a refresh
// rewrites (hypothesis ledger 42.8 MB, claim traces 16.6 MB, validation results
// 8.8 MB) cost 99 MB of live heap per refresh, 39 MB of it for each version of
// the ledger alone. The orchestrator is one process for the life of a cycle; it
// reached its 2 GB heap after 4.5 h and died, six times in six days, and the
// one run that had been given 6 GB reached that after 42 h.
//
// So: one entry per path, replaced when the file changes, and the whole cache
// bounded -- the lane window slides over thousands of lanes in a long cycle,
// and a path that is never read again is as leaked as a stale version.
const MAX_ENTRIES = Math.max(16, Number(process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_ENTRIES || 1024));
const MAX_BYTES = Math.max(
  1024 * 1024,
  Number(process.env.RESEARCHLAB_VISUALIZER_JSON_CACHE_BYTES || 192 * 1024 * 1024),
);

// Insertion order is recency: a hit is re-inserted, eviction takes the oldest.
const entries = new Map();
let heldBytes = 0;

function forget(filePath) {
  const entry = entries.get(filePath);
  if (!entry) return;
  heldBytes -= entry.size;
  entries.delete(filePath);
}

function remember(filePath, entry) {
  forget(filePath);
  // A file larger than the whole budget is parsed for its caller and not kept.
  if (entry.size > MAX_BYTES) return;
  entries.set(filePath, entry);
  heldBytes += entry.size;
  while (entries.size > MAX_ENTRIES || heldBytes > MAX_BYTES) {
    forget(entries.keys().next().value);
  }
}

// null when the file is missing, unreadable, or larger than `maxBytes`.
function readJsonCached(filePath, maxBytes = null) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (maxBytes != null && Number.isFinite(Number(maxBytes)) && stat.size > Number(maxBytes)) return null;
    const cached = entries.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      entries.delete(filePath);
      entries.set(filePath, cached);
      return cached.value;
    }
    const value = readJson(filePath);
    remember(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

// What a file is right now, for callers whose own derived value is only good
// while the file has not changed.
function fileSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "absent";
  }
}

function cacheStats() {
  return { entries: entries.size, bytes: heldBytes, max_entries: MAX_ENTRIES, max_bytes: MAX_BYTES };
}

module.exports = {
  readJsonCached,
  fileSignature,
  cacheStats,
};
