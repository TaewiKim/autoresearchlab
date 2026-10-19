"use strict";

const fs = require("fs");
const path = require("path");
const { compactTimestamp, ensureDir, safeSegment } = require("./fs_helpers");
const { writeFileAtomic } = require("../../shared/json");

function linkOrPointer(sourcePath, aliasPath) {
  ensureDir(path.dirname(aliasPath));
  fs.rmSync(aliasPath, { force: true });
  const pointerPath = `${aliasPath}.path.txt`;
  const relativeTarget = path.relative(path.dirname(aliasPath), sourcePath);
  try {
    fs.symlinkSync(relativeTarget, aliasPath);
    fs.rmSync(pointerPath, { force: true });
    return "symlink";
  } catch {
    // Replace the pointer atomically. rm-then-write leaves a window in which
    // the name is in the directory listing and not on disk, and a review-map
    // reader that listed first and opened second aborted cycle-g-v87's entire
    // run on the resulting ENOENT. rename within a filesystem is atomic, so a
    // reader sees the old pointer or the new one, never neither.
    writeFileAtomic(pointerPath, `${sourcePath}\n`);
    return "path-pointer";
  }
}

function writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases }) {
  const ordered = [...entries].sort((a, b) =>
    a.mtime_ms - b.mtime_ms ||
    String(a.stage).localeCompare(String(b.stage)) ||
    String(a.role).localeCompare(String(b.role)) ||
    String(a.lane_id || "").localeCompare(String(b.lane_id || "")) ||
    String(a.source_path).localeCompare(String(b.source_path)),
  );
  const aliasEntries = ordered.slice(Math.max(0, ordered.length - maxAliases));
  return aliasEntries.map((entry, index) => {
    const sequence = String(index + 1).padStart(5, "0");
    const ext = path.extname(entry.source_path) || ".artifact";
    const timestamp = compactTimestamp(entry.mtime_ms);
    const aliasName = [
      sequence,
      timestamp,
      safeSegment(entry.role),
      safeSegment(entry.lane_id || "cycle"),
      safeSegment(entry.action_type || entry.artifact_kind),
      safeSegment(entry.artifact_kind),
    ].join("__") + ext;
    const byStagePath = path.join(reviewMapRoot, "by-stage", entry.stage, aliasName);
    const byAgentPath = path.join(
      reviewMapRoot,
      "by-agent",
      safeSegment(entry.role),
      safeSegment(entry.lane_id || "cycle"),
      aliasName,
    );
    const linkType = linkOrPointer(entry.source_path, byStagePath);
    linkOrPointer(entry.source_path, byAgentPath);
    return {
      ...entry,
      sequence: index + 1,
      alias_name: aliasName,
      by_stage_path: path.relative(root, byStagePath),
      by_agent_path: path.relative(root, byAgentPath),
      link_type: linkType,
    };
  });
}

module.exports = {
  linkOrPointer,
  writeReviewMapAliases,
};
