"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readJson, writeJson } = require("../src/shared/json");
const { refreshMalformedDerivedGateReview } = require("../src/orchestrator/run_research").__private;

// POSIX only: Windows refuses to rename over a file a descriptor holds open,
// and writeJson falls back to an in-place write there (next test).
test("writeJson publishes a whole document when a stale writer has a tail", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-json-atomic-"));
  const target = path.join(root, "cycle-a-20260919-gate-review.json");

  // MEASURED ON cycle-a-20260919, 2026-10-02: gate-review.json held
  // a complete document through line 34234, then bytes from an overlapping
  // writer caused "trailing characters at line 34235 column 1". Keep that
  // writer's descriptor open across the newer publish, then let its tail land.
  const staleFd = fs.openSync(target, "w");
  fs.writeSync(staleFd, `{"old_refresh":"${"x".repeat(256)}`);

  try {
    writeJson(target, { gate_passed: false, score: 52 });
    fs.writeSync(staleFd, '"}\n');
  } finally {
    fs.closeSync(staleFd);
  }

  assert.deepEqual(readJson(target), { gate_passed: false, score: 52 });
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.endsWith(".staged")),
    [],
    "a completed publish must not leave staging files",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("writeJson still writes when Windows refuses to rename over an open file", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-json-open-"));
  const target = path.join(root, "state.json");
  fs.writeFileSync(target, "{}\n");
  const readerFd = fs.openSync(target, "r");
  try {
    writeJson(target, { score: 52 });
  } finally {
    fs.closeSync(readerFd);
  }
  assert.deepEqual(readJson(target), { score: 52 });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith(".staged")), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("native planning preflight rebuilds an already-spliced gate review", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-review-rebuild-"));
  const cycleId = "cycle-a-20260919";
  const target = path.join(cwd, ".research-lab", "state", `${cycleId}-gate-review.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // MEASURED ON cycle-a-20260919, 2026-10-02: this is the persistent
  // shape native planning rejected at line 34235 even after its retry loop.
  fs.writeFileSync(target, '{"gate_passed":false}\n{"stale_writer_tail":true}\n');
  let refreshes = 0;

  const rebuilt = refreshMalformedDerivedGateReview({
    cwd,
    cycleId,
    refresh: () => {
      refreshes += 1;
      writeJson(target, { gate_passed: false, rebuilt_from_lane_state: true });
    },
  });

  assert.equal(rebuilt, true);
  assert.equal(refreshes, 1);
  assert.deepEqual(readJson(target), {
    gate_passed: false,
    rebuilt_from_lane_state: true,
  });
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("gate review recovery does not feed the malformed value back into refresh", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-review-reread-"));
  const cycleId = "cycle-a-20260919";
  const target = path.join(cwd, ".research-lab", "state", `${cycleId}-gate-review.json`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // MEASURED ON cycle-a-20260919, 2026-10-02: recovery invoked the
  // full refresh, whose visualizer parsed this spliced file before the gate
  // builder could replace it, reproducing the native exception immediately.
  fs.writeFileSync(target, '{"gate_passed":false}\n{"stale_writer_tail":true}\n');

  const rebuilt = refreshMalformedDerivedGateReview({
    cwd,
    cycleId,
    refresh: () => {
      assert.equal(fs.existsSync(target), false, "refresh must not see the malformed derived review");
      writeJson(target, { gate_passed: false, rebuilt_from_lane_state: true });
    },
  });

  assert.equal(rebuilt, true);
  assert.deepEqual(readJson(target), {
    gate_passed: false,
    rebuilt_from_lane_state: true,
  });
  assert.deepEqual(
    fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(".malformed")),
    [],
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});
