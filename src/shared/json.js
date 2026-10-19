"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  // Windows agents write through PowerShell, which prefixes a UTF-8 BOM.
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  // MEASURED ON cycle-a-20260919, 2026-10-02: overlapping refreshes
  // left one complete 1.9 MB gate review followed by a stale writer's tail.
  // Publish the serialized document as one rename so an older open descriptor
  // cannot splice its remaining bytes into the new state file.
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

let atomicWriteCounter = 0;

/**
 * Publish a file by rename, through a staging name only this writer uses.
 *
 * MEASURED on cycle-a-20260919, 2026-09-23 11:57 -- the whole cycle
 * died on this:
 *
 *   run-research aborted: ENOENT, rename
 *   '...-literature-synthesis-scan-cache.json.tmp' -> '...-scan-cache.json'
 *
 * The staging name was a constant, `${filePath}.tmp`, so two writers of the
 * same file shared one temp path: the first rename moved it away and the
 * second found nothing to rename. The rename is right -- a reader must see the
 * old file or the new one, never a torn one (review_map/alias_writer.js records
 * what a half-written pointer cost cycle-g-v87) -- but the staging name has to
 * belong to one writer, so pid and a counter go in it.
 *
 * Losing a rename race is not a failure: the file IS published, by the other
 * writer, with equally fresh content. ENOENT from the rename is therefore
 * swallowed; everything else is still raised.
 */
function writeFileAtomic(filePath, contents) {
  ensureDir(path.dirname(filePath));
  atomicWriteCounter += 1;
  const staged = `${filePath}.${process.pid}.${atomicWriteCounter}.staged`;
  try {
    // Flushed before the rename: after the WSL VM was restarted under the cycle
    // on 2026-10-04, files renamed into place but never flushed came back
    // zero bytes. Same as replace_file_via_temp in the native harness.
    const fd = fs.openSync(staged, "w");
    try {
      fs.writeSync(fd, contents, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(staged, filePath);
  } catch (error) {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      // The staging file is this writer's alone; failing to remove it leaves
      // litter, not a corrupted destination.
    }
    if (error && error.code === "ENOENT") return;
    // Windows will not rename over a file another process holds open (EPERM,
    // EACCES or EBUSY), which POSIX does without complaint. That is a reader,
    // not a broken destination: write in place, as before the rename existed,
    // rather than abort the cycle over a refresh. Same fallback as the native
    // write_json (core/support).
    if (error && process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
      fs.writeFileSync(filePath, contents, "utf8");
      return;
    }
    throw error;
  }
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  writeFileAtomic,
};
