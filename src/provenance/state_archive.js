"use strict";

// A copy of every authoritative artifact, taken while it still exists.
//
// writeAuthoritativeState keeps the version a JS write replaces. That covers
// the projection that writes the lead and nothing else, because the artifacts
// in this system are mostly written by AGENTS, and an agent writes with
// apply_patch -- which expresses a full-file rewrite as a delete followed by an
// add.
//
// MEASURED ON cycle-g-v91, 2026-09-13. followup-lab-director-44 rewrote two
// state files that way. For research-trend-analysis.json both halves landed
// (item_5 delete, item_6 add). For lab-director-hypothesis.json the delete
// landed as item_7 and the add never came: the watchdog halt killed the lane
// 66 seconds later. The cycle's only record of the director's decision --
// statement, four falsification conditions, four rival mechanisms, three
// literature edges -- stopped existing, and every review-map entry for it is a
// symlink, so they went dangling with it rather than preserving anything.
//
// Nothing prevented the delete and nothing could: the lane contract declares
// `allowed_outputs` as the lane's own directory, no code reads that field to
// gate a write, and the lane runs under
// --dangerously-bypass-approvals-and-sandbox. So this does not try to forbid
// the delete. It makes the delete survivable, and makes a silent one loud.
//
// Cheap on purpose: a pass copies only what changed since its last copy, and
// keeps a bounded number of versions per kind.

const fs = require("fs");
const path = require("path");

const { STATE_PROVENANCE, isAuthoritative, recordStateWrite } = require("./state_provenance");

const NEWLINE = String.fromCharCode(10);
const DEFAULT_KEEP = 5;

function stateDir(root, cycleId) {
  return path.join(root, ".research-lab", "state");
}

function archiveDir(root, cycleId, kind) {
  return path.join(root, ".research-lab", "state-archive", cycleId, kind);
}

/**
 * The artifact kind a state filename names, or null when it names none.
 *
 * State files are `<cycleId>-<kind><ext>`, and the same kind can appear with
 * more than one extension (a digest is written as .json and as .md). The kind
 * is the table's vocabulary, so an unknown one is simply not in scope.
 */
function kindFromStateFile(fileName, cycleId) {
  const prefix = `${cycleId}-`;
  if (!fileName.startsWith(prefix)) return null;
  const rest = fileName.slice(prefix.length);
  const withoutExt = rest.replace(/\.(json|jsonl|md|txt)$/i, "");
  return Object.prototype.hasOwnProperty.call(STATE_PROVENANCE, withoutExt) ? withoutExt : null;
}

function listArchives(root, cycleId, kind) {
  try {
    return fs.readdirSync(archiveDir(root, cycleId, kind)).sort();
  } catch {
    return [];
  }
}

function sameBytes(a, b) {
  try {
    const left = fs.statSync(a);
    const right = fs.statSync(b);
    if (left.size !== right.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function prune(dir, keep) {
  let entries;
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
    } catch {
      /* a version that cannot be pruned is not a reason to stop archiving */
    }
  }
}

/**
 * Copy every authoritative artifact that changed since its last copy.
 *
 * Returns what it did. Never throws: a failure to keep a copy must not become
 * the thing that stops the cycle, and the caller decides what to say about it.
 */
function archiveAuthoritativeState({ root, cycleId, keep = DEFAULT_KEEP, now = new Date() }) {
  const archived = [];
  const failed = [];
  let entries;
  try {
    entries = fs.readdirSync(stateDir(root, cycleId), { withFileTypes: true });
  } catch {
    return { archived, failed, scanned: 0 };
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const kind = kindFromStateFile(entry.name, cycleId);
    if (!kind || !isAuthoritative(kind)) continue;
    scanned += 1;
    const livePath = path.join(stateDir(root, cycleId), entry.name);
    const dir = archiveDir(root, cycleId, kind);
    const existing = listArchives(root, cycleId, kind);
    const newest = existing.length ? path.join(dir, existing[existing.length - 1]) : null;
    // Unchanged since the last copy: nothing to keep, and most passes are this.
    if (newest && sameBytes(livePath, newest)) continue;
    const ext = path.extname(entry.name) || ".json";
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(livePath, path.join(dir, `${stamp}${ext}`));
      archived.push({ kind, file: entry.name });
      prune(dir, keep);
    } catch (error) {
      failed.push({ kind, file: entry.name, error: String(error && error.message) });
    }
  }
  return { archived, failed, scanned };
}

/**
 * True when this artifact was set aside on purpose rather than lost.
 *
 * This repository clears an artifact by renaming it beside itself --
 * `<name>.cleared-with-<commit>`, `.superseded-<ts>`, `.self-heal-<ts>.bak`,
 * `.pre-<commit>`. The absence that follows is a decision, and restoring it
 * undoes the decision.
 *
 * FOUND BY THIS MODULE ON ITS FIRST REAL RUN: the watchdog halt is an
 * authoritative kind, so clearing the halt looked exactly like losing the lead,
 * and the first pass put the halt straight back -- a cycle that could never be
 * resumed again.
 *
 * The test is `ctime`, not `mtime`: a rename carries the original mtime with
 * it, so a halt written at 20:05 and set aside at 22:35 still looks two hours
 * older than the copy taken at 22:30. ctime moves when the name does.
 */
function archiveStampMs(archiveFileName) {
  const base = archiveFileName.replace(/\.[^.]+$/, "");
  const iso = base.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1$2:$3:$4.$5Z",
  );
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setAsideAfter(root, cycleId, kind, ext, archivedAtMs) {
  const prefix = `${cycleId}-${kind}${ext}.`;
  let entries;
  try {
    entries = fs.readdirSync(stateDir(root, cycleId));
  } catch {
    return false;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      if (fs.statSync(path.join(stateDir(root, cycleId), name)).ctimeMs >= archivedAtMs) return true;
    } catch {
      /* a sibling we cannot stat is not evidence either way */
    }
  }
  return false;
}

/**
 * Put back an authoritative artifact that has copies and no live file.
 *
 * A kind with archives and nothing in state existed and stopped existing. That
 * is the shape cycle-g-v91 died of, and the restore is deliberately loud: it
 * records the removal it inferred as well as the restore, so "it came back"
 * never reads as "it was never gone".
 *
 * Restoring over a rewrite in flight is safe -- the agent's own add overwrites
 * it moments later -- and a missing lead is what stalls thirteen lanes.
 */
function restoreMissingAuthoritativeState({ root, cycleId, actor, reason, now = new Date() }) {
  const restored = [];
  const failed = [];
  // Kinds whose absence is a decision somebody made, listed rather than acted on.
  const deliberate = [];
  let kinds;
  try {
    kinds = fs.readdirSync(path.join(root, ".research-lab", "state-archive", cycleId));
  } catch {
    return { restored, failed, deliberate };
  }
  for (const kind of kinds) {
    if (!isAuthoritative(kind)) continue;
    const versions = listArchives(root, cycleId, kind);
    if (!versions.length) continue;
    const newest = versions[versions.length - 1];
    const ext = path.extname(newest) || ".json";
    const livePath = path.join(stateDir(root, cycleId), `${cycleId}-${kind}${ext}`);
    if (fs.existsSync(livePath)) continue;
    const from = path.join(archiveDir(root, cycleId, kind), newest);
    // When the COPY was taken, read from the name this module wrote. Not
    // stat: copyFileSync carries the source mtime across on some filesystems,
    // so the copy can report the moment the artifact was last written rather
    // than the moment it was kept -- which made a set-aside and its archive
    // tie exactly, and a tie reads as deliberate.
    //
    // But never LATER than the copy's own ctime. The stamp comes from the
    // process clock; the set-aside's ctime comes from the kernel's coarse clock,
    // which can lag it by a tick. Measured in this container after a reboot: a
    // file created before Date.now() carried a ctime 6 ms earlier than it, so a
    // clear made moments after an archive pass read as older than the copy and
    // the halt came back. The copy's ctime is set by the kernel when the copy is
    // made (unlike mtime, nothing carries it across), so it is the same clock as
    // the rename; the earlier of the two is still before any later set-aside.
    let archivedAtMs = archiveStampMs(newest);
    try {
      const copyCtimeMs = fs.statSync(from).ctimeMs;
      if (!archivedAtMs || copyCtimeMs < archivedAtMs) archivedAtMs = copyCtimeMs;
    } catch {
      /* no stat: the name is the only clock left */
    }
    if (setAsideAfter(root, cycleId, kind, ext, archivedAtMs)) {
      deliberate.push({ kind });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(livePath), { recursive: true });
      fs.copyFileSync(from, livePath);
    } catch (error) {
      failed.push({ kind, error: String(error && error.message) });
      continue;
    }
    // Two records, because two things happened and only one of them was ours.
    recordStateWrite({
      root, cycleId, kind, operation: "remove", actor: actor || "unknown",
      reason: `${reason || "the artifact was gone"}; detected by state archive, not by its remover`,
      now,
    });
    recordStateWrite({
      root, cycleId, kind, operation: "replace", actor: "state_archive",
      reason: `restored the last copy taken before it vanished (${newest})`,
      previous: from, now,
    });
    restored.push({ kind, from, to: livePath });
  }
  return { restored, failed, deliberate };
}

module.exports = {
  archiveAuthoritativeState,
  restoreMissingAuthoritativeState,
  kindFromStateFile,
  NEWLINE,
};
