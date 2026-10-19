"use strict";

const fs = require("fs");
const path = require("path");
const { ROLE_PLAN_PREFIX_BYTES } = require("./constants");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonIfExistsBounded(filePath, maxBytes = 2 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPrefixIfExists(filePath, maxBytes = ROLE_PLAN_PREFIX_BYTES) {
  if (!fs.existsSync(filePath)) return "";
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    const byteCount = Math.min(Math.max(0, stat.size), maxBytes);
    if (byteCount === 0) return "";
    const buffer = Buffer.alloc(byteCount);
    fd = fs.openSync(filePath, "r");
    const read = fs.readSync(fd, buffer, 0, byteCount, 0);
    return buffer.slice(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // best effort only
      }
    }
  }
}

function extractJsonStringFieldPrefix(filePath, fieldName) {
  const prefix = readPrefixIfExists(filePath);
  if (!prefix) return null;
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = prefix.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, "m"));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function safeSegment(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "unknown";
}

function compactTimestamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "00000000T000000Z";
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function statInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      updated_at: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return {
      exists: false,
      size_bytes: 0,
      mtime_ms: 0,
      updated_at: null,
    };
  }
}

// A replaced generation is moved aside so the swap is one rename, and then it
// is finished with: the map is rebuilt from the lane tree on every refresh and
// nothing reads `.stale`.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: nothing ever removed
// them. 4,309 generations of one cycle's review map, 0.8 GB, 44 MB more a day.
//
// The newest few are kept, for looking at what the map said a moment ago. The
// rest go a bounded number per refresh, so the first pass after this rule does
// not stop to delete four thousand directories.
const STALE_GENERATIONS_KEPT = Math.max(0, Number(process.env.RESEARCHLAB_REVIEW_MAP_STALE_KEPT || 3));
const STALE_GENERATIONS_REMOVED_PER_PASS = Math.max(1, Number(process.env.RESEARCHLAB_REVIEW_MAP_STALE_REMOVED_PER_PASS || 40));

function pruneStaleGenerations(staleRoot, base) {
  let removed = 0;
  try {
    const generations = fs.readdirSync(staleRoot)
      .map((name) => {
        // <base>-<epoch ms> or <base>-<epoch ms>-<attempt>
        const match = name.startsWith(`${base}-`) ? /^(\d{10,})(?:-\d+)?$/.exec(name.slice(base.length + 1)) : null;
        return match ? { name, at: Number(match[1]) } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.at - right.at || left.name.localeCompare(right.name));
    const excess = generations.slice(0, Math.max(0, generations.length - STALE_GENERATIONS_KEPT));
    for (const generation of excess.slice(0, STALE_GENERATIONS_REMOVED_PER_PASS)) {
      fs.rmSync(path.join(staleRoot, generation.name), { recursive: true, force: true });
      removed += 1;
    }
  } catch {
    // Clearing old generations is housekeeping; the map that was just swapped in stands.
  }
  return removed;
}

function resetGeneratedDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const parent = path.dirname(targetPath);
  const staleRoot = path.join(parent, ".stale");
  ensureDir(staleRoot);
  const base = path.basename(targetPath);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${attempt}`;
    const stalePath = path.join(staleRoot, `${base}-${Date.now()}${suffix}`);
    try {
      fs.renameSync(targetPath, stalePath);
      pruneStaleGenerations(staleRoot, base);
      return;
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      if (error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`could not rotate generated review-map directory ${targetPath}`);
}

module.exports = {
  compactTimestamp,
  ensureDir,
  extractJsonStringFieldPrefix,
  pruneStaleGenerations,
  readJsonIfExistsBounded,
  readPrefixIfExists,
  resetGeneratedDirectory,
  safeSegment,
  statInfo,
};
