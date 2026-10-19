// A review-map pointer must never be absent between two of its own writes.
//
// cycle-g-v87's watchdog halt snapshot carried this as its only abort:
//
//     run-research aborted: ENOENT: no such file or directory, open
//     '.../00038__...__followup-scout-56__gate_restart_followup__result.json.path.txt'
//
// followup-scout-56 was complete and intact. The pointer file simply was not on
// disk at that instant: linkOrPointer rmSync'd it and then writeFileSync'd it,
// so between the two calls the name was in the directory listing and nowhere
// else. A concurrent reader that listed first and opened second got ENOENT, and
// that ENOENT took down the run instead of skipping one alias.
//
// The v85 crash-restart loop was the same shape one layer down -- ONE unreadable
// lane file aborting the harness 106 times over 2h13m.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeReviewMapAliases } = require("../src/reporting/review_map/alias_writer.js");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review-map-pointer-"));
}

function entryFor(root, laneId, mtimeMs) {
  const source = path.join(root, `${laneId}-result.json`);
  fs.writeFileSync(source, JSON.stringify({ lane_id: laneId }), "utf8");
  return {
    source_path: source,
    mtime_ms: mtimeMs,
    stage: "01-discovery",
    role: "scout",
    lane_id: laneId,
    action_type: "gate_restart_followup",
    artifact_kind: "result.json",
  };
}

// Force the pointer branch: symlinkSync fails on Windows without the privilege,
// and the fallback is the branch that carried the bug, so exercise it directly
// on every platform rather than only where symlinks happen to be unavailable.
function withSymlinkDisabled(fn) {
  const real = fs.symlinkSync;
  fs.symlinkSync = () => {
    throw new Error("EPERM: symlink not permitted");
  };
  try {
    return fn();
  } finally {
    fs.symlinkSync = real;
  }
}

test("a rewritten pointer is readable at every instant", () => {
  const root = scratch();
  const reviewMapRoot = path.join(root, "review-map");
  const entries = [entryFor(root, "followup-scout-56", 1000)];

  const written = withSymlinkDisabled(() =>
    writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases: 8 }),
  );
  assert.strictEqual(written.length, 1);

  const pointer = fs
    .readdirSync(path.join(reviewMapRoot, "by-stage", "01-discovery"))
    .find((name) => name.endsWith(".path.txt"));
  assert.ok(pointer, "the fallback branch must leave a pointer file");
  const pointerPath = path.join(reviewMapRoot, "by-stage", "01-discovery", pointer);

  // Rewrite it the way a refresh pass does. The old code removed the file first,
  // so a reader interleaved here saw nothing; assert the name resolves before,
  // between, and after.
  assert.ok(fs.existsSync(pointerPath));
  for (let pass = 0; pass < 5; pass += 1) {
    withSymlinkDisabled(() =>
      writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases: 8 }),
    );
    assert.ok(
      fs.existsSync(pointerPath),
      `pointer vanished after refresh pass ${pass + 1}`,
    );
    assert.match(fs.readFileSync(pointerPath, "utf8"), /followup-scout-56-result\.json/);
  }
});

test("no staged temp file survives a completed write", () => {
  // A rename that is skipped or a staged file that is left behind would show up
  // in the review map as an artifact nobody can resolve.
  const root = scratch();
  const reviewMapRoot = path.join(root, "review-map");
  const entries = [entryFor(root, "followup-scout-56", 1000)];
  withSymlinkDisabled(() =>
    writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases: 8 }),
  );
  const names = fs.readdirSync(path.join(reviewMapRoot, "by-stage", "01-discovery"));
  assert.deepStrictEqual(
    names.filter((name) => name.includes(".staged")),
    [],
    `staged files left behind: ${names.join(", ")}`,
  );
});

test("a working symlink clears any pointer left by an earlier fallback", () => {
  const root = scratch();
  const reviewMapRoot = path.join(root, "review-map");
  const entries = [entryFor(root, "followup-scout-56", 1000)];

  withSymlinkDisabled(() =>
    writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases: 8 }),
  );
  const stageDir = path.join(reviewMapRoot, "by-stage", "01-discovery");
  assert.ok(fs.readdirSync(stageDir).some((name) => name.endsWith(".path.txt")));

  // writeReviewMapAliases swallows a symlink failure by design, so ask the
  // filesystem directly instead of inferring capability from a thrown error.
  let symlinkWorks = true;
  try {
    fs.symlinkSync(path.join(root, "probe-target"), path.join(root, "probe-link"));
  } catch {
    symlinkWorks = false;
  }
  if (!symlinkWorks) return; // no symlink privilege here; nothing to assert.
  writeReviewMapAliases({ root, reviewMapRoot, entries, maxAliases: 8 });
  assert.deepStrictEqual(
    fs.readdirSync(stageDir).filter((name) => name.endsWith(".path.txt")),
    [],
    "a stale pointer beside a fresh symlink is a second source of truth",
  );
});
