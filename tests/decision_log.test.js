"use strict";

// The decision ledger is one file per UTC hour, not one file per cycle.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: the single file was
// 12.0 GB after 23 days, 11.9 GB of it reviews appended on every refresh.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appendDecision,
  decisionLogDir,
  decisionLogEnd,
  decisionSegmentName,
  followDecisionLog,
  legacyDecisionLogPath,
  listDecisionSegments,
  readRecentDecisions,
} = require("../src/observability/decision_log");

function newRoot() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-decision-log-")), ".research-lab");
}

const at = (text) => new Date(text);

test("a decision is appended to the segment of the hour it is made in", () => {
  const root = newRoot();
  const cycleId = "cycle-hourly";
  assert.equal(decisionSegmentName(at("2026-10-11T09:59:59Z")), "2026-10-11T09.jsonl");
  assert.equal(decisionSegmentName(at("2026-10-12T00:00:01+09:00")), "2026-10-11T15.jsonl");
  assert.deepEqual(listDecisionSegments(root, cycleId), []);
  assert.deepEqual(readRecentDecisions(root, cycleId), []);

  const first = appendDecision({ root, cycleId, row: { n: 1 }, now: at("2026-10-11T09:10:00Z") });
  appendDecision({ root, cycleId, row: { n: 2 }, now: at("2026-10-11T09:50:00Z") });
  const second = appendDecision({ root, cycleId, row: { n: 3 }, now: at("2026-10-11T10:00:00Z") });
  const third = appendDecision({ root, cycleId, row: { n: 4 }, now: at("2026-10-12T00:30:00Z") });

  assert.equal(path.dirname(first), decisionLogDir(root, cycleId));
  assert.deepEqual(
    [first, second, third].map((filePath) => path.basename(filePath)),
    ["2026-10-11T09.jsonl", "2026-10-11T10.jsonl", "2026-10-12T00.jsonl"],
  );
  assert.equal(fs.readFileSync(first, "utf8"), '{"n":1}\n{"n":2}\n');
  // Nothing is written to the single file any more.
  assert.equal(fs.existsSync(legacyDecisionLogPath(root, cycleId)), false);
  assert.deepEqual(listDecisionSegments(root, cycleId), [first, second, third]);

  // The newest decisions are found across segment boundaries, newest first.
  assert.deepEqual(readRecentDecisions(root, cycleId, { limit: 3 }).map((row) => row.n), [4, 3, 2]);
  assert.deepEqual(readRecentDecisions(root, cycleId, { limit: 99 }).map((row) => row.n), [4, 3, 2, 1]);
});

test("an unsplit single file is read as the oldest part of the ledger", () => {
  const root = newRoot();
  const cycleId = "cycle-unsplit";
  const legacy = legacyDecisionLogPath(root, cycleId);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"n":"legacy-1"}\n{"n":"legacy-2"}\n');
  assert.deepEqual(readRecentDecisions(root, cycleId, { limit: 8 }).map((row) => row.n), ["legacy-2", "legacy-1"]);

  const segment = appendDecision({ root, cycleId, row: { n: "new" }, now: at("2026-10-12T01:00:00Z") });
  // A stray file beside the segments is not part of the ledger.
  fs.writeFileSync(path.join(decisionLogDir(root, cycleId), "2026-10-12T01.jsonl.part"), '{"n":"stray"}\n');
  assert.deepEqual(listDecisionSegments(root, cycleId), [legacy, segment]);
  assert.deepEqual(readRecentDecisions(root, cycleId, { limit: 8 }).map((row) => row.n), ["new", "legacy-2", "legacy-1"]);
  // A record a crash cut short is not a decision.
  fs.appendFileSync(segment, '{"n":"cut sho');
  assert.deepEqual(readRecentDecisions(root, cycleId, { limit: 2 }).map((row) => row.n), ["new", "legacy-2"]);
});

test("a follower gets each appended decision once, across the hour boundary", () => {
  const root = newRoot();
  const cycleId = "cycle-follow";
  const seen = [];
  const read = (filePath, offset) => {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.slice(offset).split("\n").filter(Boolean)) seen.push(JSON.parse(line).n);
    return text.length;
  };

  // Connected before the ledger exists: the first decision is new.
  let position = decisionLogEnd(root, cycleId);
  assert.deepEqual(position, { segment: null, offset: 0 });
  position = followDecisionLog(root, cycleId, position, read);
  appendDecision({ root, cycleId, row: { n: 1 }, now: at("2026-10-11T09:10:00Z") });
  position = followDecisionLog(root, cycleId, position, read);
  assert.deepEqual(seen, [1]);

  // More in the same hour, then two later hours before the next poll.
  appendDecision({ root, cycleId, row: { n: 2 }, now: at("2026-10-11T09:20:00Z") });
  appendDecision({ root, cycleId, row: { n: 3 }, now: at("2026-10-11T10:00:00Z") });
  appendDecision({ root, cycleId, row: { n: 4 }, now: at("2026-10-11T11:00:00Z") });
  position = followDecisionLog(root, cycleId, position, read);
  assert.deepEqual(seen, [1, 2, 3, 4]);
  position = followDecisionLog(root, cycleId, position, read);
  assert.deepEqual(seen, [1, 2, 3, 4]);

  // A follower that connects now starts at the end, not at the beginning.
  const late = [];
  let latePosition = decisionLogEnd(root, cycleId);
  appendDecision({ root, cycleId, row: { n: 5 }, now: at("2026-10-11T11:30:00Z") });
  latePosition = followDecisionLog(root, cycleId, latePosition, (filePath, offset) => {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.slice(offset).split("\n").filter(Boolean)) late.push(JSON.parse(line).n);
    return text.length;
  });
  assert.deepEqual(late, [5]);
});

test("splitting the single file under a follower does not replay the ledger", () => {
  const root = newRoot();
  const cycleId = "cycle-split-under-follower";
  const legacy = legacyDecisionLogPath(root, cycleId);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"n":"old-1"}\n{"n":"old-2"}\n');
  let position = decisionLogEnd(root, cycleId);
  assert.equal(position.segment, legacy);

  // The split: the same records, now in hourly segments, and the file gone.
  appendDecision({ root, cycleId, row: { n: "old-1" }, now: at("2026-10-10T05:00:00Z") });
  appendDecision({ root, cycleId, row: { n: "old-2" }, now: at("2026-10-10T06:00:00Z") });
  fs.rmSync(legacy);

  const seen = [];
  const read = (filePath, offset) => {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.slice(offset).split("\n").filter(Boolean)) seen.push(JSON.parse(line).n);
    return text.length;
  };
  position = followDecisionLog(root, cycleId, position, read);
  assert.deepEqual(seen, []);
  appendDecision({ root, cycleId, row: { n: "new" }, now: at("2026-10-12T02:00:00Z") });
  position = followDecisionLog(root, cycleId, position, read);
  assert.deepEqual(seen, ["new"]);
});
