"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseQuotaResetTime,
  findCycleQuotaResetTime,
  shouldAutoResume,
} = require("../src/orchestrator/quota_recovery");

function makeTempCycleRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quota-recovery-test-"));
}

test("parseQuotaResetTime: PM resets that have not yet occurred today", () => {
  const now = new Date(2026, 3, 30, 9, 0, 0); // local 2026-04-30 09:00
  const reset = parseQuotaResetTime(
    "You've hit your usage limit. ... try again at 1:58 PM.",
    now,
  );
  assert.ok(reset);
  assert.equal(reset.getHours(), 13);
  assert.equal(reset.getMinutes(), 58);
  assert.equal(reset.toDateString(), now.toDateString());
});

test("parseQuotaResetTime: AM with 12 → midnight rollover behaviour", () => {
  const now = new Date(2026, 4, 15, 23, 30, 0); // 2026-05-15 23:30
  const reset = parseQuotaResetTime("try again at 12:15 AM.", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 0);
  assert.equal(reset.getMinutes(), 15);
  // 12:15 AM is in the past relative to 23:30, so we roll forward.
  // Compare via timestamp to avoid month-wrap issues at end-of-month.
  const expected = new Date(now);
  expected.setDate(now.getDate() + 1);
  expected.setHours(0, 15, 0, 0);
  assert.equal(reset.getTime(), expected.getTime());
});

test("parseQuotaResetTime: PM noon (12) handled", () => {
  const now = new Date(2026, 3, 30, 8, 0, 0);
  const reset = parseQuotaResetTime("try again at 12:00 PM.", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 12);
  assert.equal(reset.getMinutes(), 0);
});

test("parseQuotaResetTime: rolls forward when target already passed", () => {
  const now = new Date(2026, 4, 15, 14, 0, 0); // 2026-05-15 14:00
  const reset = parseQuotaResetTime("try again at 1:58 PM.", now);
  assert.ok(reset);
  assert.equal(reset.getHours(), 13);
  assert.equal(reset.getMinutes(), 58);
  const expected = new Date(now);
  expected.setDate(now.getDate() + 1);
  expected.setHours(13, 58, 0, 0);
  assert.equal(reset.getTime(), expected.getTime());
});

test("parseQuotaResetTime: no match → null", () => {
  assert.equal(parseQuotaResetTime("nothing here", new Date()), null);
  assert.equal(parseQuotaResetTime("", new Date()), null);
  assert.equal(parseQuotaResetTime(null, new Date()), null);
});

test("findCycleQuotaResetTime: scans every lane and picks the earliest", () => {
  const cwd = makeTempCycleRoot();
  try {
    const cycleId = "v27";
    const lane1 = path.join(cwd, ".research-lab", "lanes", cycleId, "chronicle-01");
    const lane2 = path.join(cwd, ".research-lab", "lanes", cycleId, "lab-director-01");
    fs.mkdirSync(lane1, { recursive: true });
    fs.mkdirSync(lane2, { recursive: true });
    fs.writeFileSync(
      path.join(lane1, "result.json"),
      JSON.stringify({ stdout: "you've hit your usage limit. try again at 1:58 PM" }),
    );
    fs.writeFileSync(
      path.join(lane2, "stdout.log"),
      "stuff... try again at 12:00 PM ...more stuff",
    );
    const reset = findCycleQuotaResetTime(cwd, cycleId, {
      now: new Date(2026, 3, 30, 8, 0, 0),
    });
    assert.ok(reset);
    // 12:00 PM is earlier than 13:58 PM the same day, so it wins.
    assert.equal(reset.getHours(), 12);
    assert.equal(reset.getMinutes(), 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("findCycleQuotaResetTime: returns null when no lane carries the message", () => {
  const cwd = makeTempCycleRoot();
  try {
    const cycleId = "v27";
    const lane = path.join(cwd, ".research-lab", "lanes", cycleId, "chronicle-01");
    fs.mkdirSync(lane, { recursive: true });
    fs.writeFileSync(
      path.join(lane, "result.json"),
      JSON.stringify({ stdout: "all good, no quota issues" }),
    );
    const reset = findCycleQuotaResetTime(cwd, cycleId);
    assert.equal(reset, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shouldAutoResume: true only when termination is CONTINUATION_IMPOSSIBLE + quota>0", () => {
  const cwd = makeTempCycleRoot();
  try {
    const cycleId = "v27";
    const stateDir = path.join(cwd, ".research-lab", "state");
    fs.mkdirSync(stateDir, { recursive: true });

    // No termination file → false
    assert.equal(shouldAutoResume(cwd, cycleId), false);

    // Termination present but quota=0 → false
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-termination-code.json`),
      JSON.stringify({ code: "CONTINUATION_IMPOSSIBLE_NO_RUNNABLE_WORK" }),
    );
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-aggregate-metrics.json`),
      JSON.stringify({ quota_exceeded_lane_count: 0 }),
    );
    assert.equal(shouldAutoResume(cwd, cycleId), false);

    // quota>0 → true
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-cycle-aggregate-metrics.json`),
      JSON.stringify({ quota_exceeded_lane_count: 3 }),
    );
    assert.equal(shouldAutoResume(cwd, cycleId), true);

    // Different termination code → false even with quota>0
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-termination-code.json`),
      JSON.stringify({ code: "GATE_REVIEW_PASSED" }),
    );
    assert.equal(shouldAutoResume(cwd, cycleId), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("shouldAutoResume: a native provider-quota stop is a quota signal by itself", () => {
  const cwd = makeTempCycleRoot();
  try {
    const cycleId = "v27";
    const stateDir = path.join(cwd, ".research-lab", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `${cycleId}-termination-code.json`),
      JSON.stringify({ code: "PROVIDER_QUOTA_EXHAUSTED", should_stop: true }),
    );
    assert.equal(shouldAutoResume(cwd, cycleId), true);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("an explicit restart lifts only a provider-quota pause", () => {
  const { clearProviderQuotaPause } = require("../src/reporting/termination_code");
  const cwd = makeTempCycleRoot();
  try {
    const cycleId = "v27";
    const stateDir = path.join(cwd, ".research-lab", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const marker = path.join(stateDir, `${cycleId}-labdirector-pause.json`);

    fs.writeFileSync(marker, JSON.stringify({ block_type: "provider_quota" }));
    assert.equal(clearProviderQuotaPause({ cwd, cycleId }), true);
    assert.equal(fs.existsSync(marker), false);

    // A researcher's /pause or a Windows sandbox block has its own resume rule.
    for (const other of [{ source: "researcher" }, { block_type: "windows_sandbox_setup" }]) {
      fs.writeFileSync(marker, JSON.stringify(other));
      assert.equal(clearProviderQuotaPause({ cwd, cycleId }), false);
      assert.equal(fs.existsSync(marker), true);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
