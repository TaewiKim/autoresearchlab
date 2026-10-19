"use strict";

const fs = require("fs");
const path = require("path");

const loadedRevisions = new Map();

// The repository the code was loaded from: the nearest enclosing `.git` that
// is one. The cycle runs with cwd at the package (`<repo>/researchlab`), not at
// the repository root.
//
// MEASURED ON cycle-a-20260919, 2026-10-15: `<repo>/researchlab/.git`
// is an empty directory left from 2026-09-18, on the host and in the volume.
// Looking only at `<cwd>/.git` found it, read no HEAD, returned null -- and a
// null revision switches this guard off, so the resident writer it was written
// to stop kept writing.
function resolveGitDir(cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    try {
      if (fs.statSync(dotGit).isDirectory()) {
        if (fs.existsSync(path.join(dotGit, "HEAD"))) return dotGit;
      } else {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
        if (match) return path.resolve(dir, match[1]);
      }
    } catch {
      // No .git here; keep climbing.
    }
    if (path.dirname(dir) === dir) return null;
  }
}

function packedRef(gitDir, refName) {
  for (const base of [gitDir, path.resolve(gitDir, "..", "..")]) {
    try {
      for (const line of fs.readFileSync(path.join(base, "packed-refs"), "utf8").split(/\r?\n/)) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const [revision, name] = line.split(" ");
        if (name === refName) return revision || null;
      }
    } catch {
      // Loose refs are the common case; a repository need not have packed refs.
    }
  }
  return null;
}

function readSourceRevision(cwd) {
  const gitDir = resolveGitDir(cwd);
  if (!gitDir) return null;
  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head || null;
    const refName = head.slice("ref:".length).trim();
    for (const base of [gitDir, path.resolve(gitDir, "..", "..")]) {
      try {
        const revision = fs.readFileSync(path.join(base, refName), "utf8").trim();
        if (revision) return revision;
      } catch {
        // A linked worktree's branch ref lives in the common git directory.
      }
    }
    return packedRef(gitDir, refName);
  } catch {
    return null;
  }
}

// The revision this process's code was loaded at is the one HEAD named when
// this module was first required -- not when the first gate happened to be
// written, which in a resident orchestrator can be hours and a commit later.
try {
  const startRevision = readSourceRevision(process.cwd());
  if (startRevision) loadedRevisions.set(path.resolve(process.cwd()), startRevision);
} catch {
  // No revision to pin; the first check pins one.
}

function assertHarnessSourceCurrent({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);
  const currentRevision = readSourceRevision(root);
  if (!currentRevision) return currentRevision;
  if (!loadedRevisions.has(root)) {
    loadedRevisions.set(root, currentRevision);
    return currentRevision;
  }
  const loadedRevision = loadedRevisions.get(root);
  if (loadedRevision === currentRevision) return currentRevision;

  // MEASURED ON cycle-a-20260919, 2026-10-15: a resident refresh
  // kept the pre-fix supersession code after HEAD changed and wrote gate score
  // 0, while fresh refresh-gate processes wrote 50 for the same five reviews.
  // Refuse a derived-state write from mixed source revisions; the continuous
  // CLI catches this code and replaces the resident process.
  const error = new Error(
    `harness source changed while this process was resident (${loadedRevision} -> ${currentRevision})`,
  );
  error.code = "HARNESS_SOURCE_CHANGED";
  error.loaded_revision = loadedRevision;
  error.current_revision = currentRevision;
  throw error;
}

function isHarnessSourceChangedError(error) {
  return error?.code === "HARNESS_SOURCE_CHANGED";
}

module.exports = {
  assertHarnessSourceCurrent,
  isHarnessSourceChangedError,
  readSourceRevision,
};
