"use strict";

// Every log a cycle only appends to is one file per UTC hour, written by the
// hour and never read whole.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: decisions 12.0 GB in one
// file, dialogue 12.0 GB, delivery receipts 1.5 GB in one file that could no
// longer be read at all, inbox 97 MB re-read every second.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { forEachLine, segmentedLog } = require("../src/observability/segmented_log");
const { appendReviewOnce, decisionLog, deliveryReceiptLog, dialogueLog, inboxLog } = require("../src/observability/cycle_logs");
const { recordDelivery, ensureMessageBus } = require("../src/reporting/message_bus");
const { collectLaneRecords } = require("../src/storage/metadata_store");

const at = (text) => new Date(text);
const newRoot = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `researchlab-${name}-`)), ".research-lab");
const lines = (filePath) => fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("a segmented log is written by the hour and read without being read whole", () => {
  const root = newRoot("segmented");
  const legacyPath = path.join(root, "log.jsonl");
  const log = segmentedLog({ dir: path.join(root, "log"), legacyPath });
  assert.deepEqual(log.segments(), []);
  assert.equal(log.countRecords(), 0);

  // A cycle that has not been split: the single file is the oldest segment.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(legacyPath, '{"n":1}\n\n{"n":2}\n');
  const nine = log.append([{ n: 3 }, { n: 4 }], { now: at("2026-10-11T09:10:00Z") });
  const ten = log.append({ n: 5 }, { now: at("2026-10-11T10:00:00Z") });
  fs.writeFileSync(path.join(log.dir, "notes.txt"), "not a segment");
  assert.deepEqual(log.segments(), [legacyPath, nine, ten]);
  assert.deepEqual([nine, ten].map((filePath) => path.basename(filePath)), ["2026-10-11T09.jsonl", "2026-10-11T10.jsonl"]);

  const seen = [];
  log.forEachRecord((record) => seen.push(record.n));
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(log.countRecords(), 5);
  assert.deepEqual(log.recent({ limit: 3 }).map((record) => record.n), [5, 4, 3]);

  // The newest segment is recounted when it grows; a record still being
  // written (no newline yet) counts, as it does for the harness's cursor.
  fs.appendFileSync(ten, '{"n":6}\n{"n":7}');
  assert.equal(log.countRecords(), 7);
});

test("a line reader hands over whole lines across its read buffer", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-lines-"));
  const filePath = path.join(dir, "big.jsonl");
  // Records larger than the 4 MB read buffer, with a multi-byte character at
  // a place the buffer boundary can fall.
  const big = "é".repeat(3 * 1024 * 1024);
  fs.writeFileSync(filePath, `${JSON.stringify({ n: 1, big })}\n${JSON.stringify({ n: 2, big })}\n{"n":3}\n{"n":4`);
  const seen = [];
  const offset = forEachLine(filePath, 0, (text) => seen.push(JSON.parse(text)));
  assert.deepEqual(seen.map((record) => record.n), [1, 2, 3]);
  assert.equal(seen[1].big, big);
  // The offset stops before the unfinished record, so a follower gets it whole.
  fs.appendFileSync(filePath, ',"done":true}\n');
  const rest = [];
  forEachLine(filePath, offset, (text) => rest.push(JSON.parse(text)));
  assert.deepEqual(rest, [{ n: 4, done: true }]);
});

test("a review is logged when it changes, not every time it is rebuilt", () => {
  const root = newRoot("review-once");
  const cycleId = "cycle-review-once";
  const review = (score, ts) => ({ ts, cycle_id: cycleId, type: "gate_review", score, blockers: ["novelty unverified"] });
  const log = (slot, value, now) =>
    appendReviewOnce({ root, cycleId, slot, review: value, dialogueEventType: "independent_gate_review", now: at(now) });

  assert.equal(log("gate_review", review(31, "2026-10-12T01:15:37Z"), "2026-10-12T01:15:37Z"), true);
  // Three more refreshes rebuild the same review with a new timestamp.
  for (const ts of ["2026-10-12T01:18:30Z", "2026-10-12T01:19:01Z", "2026-10-12T02:21:20Z"]) {
    assert.equal(log("gate_review", review(31, ts), ts), false);
  }
  // It changes; it changes back. Both are things that happened.
  assert.equal(log("gate_review", review(44, "2026-10-12T02:30:00Z"), "2026-10-12T02:30:00Z"), true);
  assert.equal(log("gate_review", review(31, "2026-10-12T02:40:00Z"), "2026-10-12T02:40:00Z"), true);
  // One refresh builds the approval review twice from different inputs; each
  // place has its own "last", so they do not take turns displacing each other.
  const approval = (kind, ts) => ({ ts, type: "approval_review", kind });
  for (const ts of ["2026-10-12T02:41:00Z", "2026-10-12T02:44:00Z"]) {
    const first = appendReviewOnce({ root, cycleId, slot: "approval_review:direct", review: approval("direct", ts), dialogueEventType: "labdirector_approval_review", now: at(ts) });
    const second = appendReviewOnce({ root, cycleId, slot: "approval_review:staged", review: approval("staged", ts), dialogueEventType: "labdirector_approval_review", now: at(ts) });
    assert.deepEqual([first, second], ts.endsWith("41:00Z") ? [true, true] : [false, false]);
  }

  const decisions = [];
  decisionLog(root, cycleId).forEachRecord((record) => decisions.push([record.type, record.score ?? record.kind, record.ts]));
  assert.deepEqual(decisions, [
    ["gate_review", 31, "2026-10-12T01:15:37Z"],
    ["gate_review", 44, "2026-10-12T02:30:00Z"],
    ["gate_review", 31, "2026-10-12T02:40:00Z"],
    ["approval_review", "direct", "2026-10-12T02:41:00Z"],
    ["approval_review", "staged", "2026-10-12T02:41:00Z"],
  ]);
  // The dialogue carries the same five, as events, and nothing else.
  const events = [];
  dialogueLog(root, cycleId).forEachRecord((record) => events.push([record.event_type, record.payload.score ?? record.payload.kind]));
  assert.deepEqual(events.map((event) => event[1]), [31, 44, 31, "direct", "staged"]);
  assert.deepEqual(decisionLog(root, cycleId).segments().map((segment) => path.basename(segment)), ["2026-10-12T01.jsonl", "2026-10-12T02.jsonl"]);
  // How long a review has stood unchanged is kept beside the ledger.
  const state = JSON.parse(fs.readFileSync(path.join(decisionLog(root, cycleId).dir, "last-reviews.json"), "utf8"));
  assert.equal(state["approval_review:staged"].repeats, 1);
});

test("a logged review is written once: no repeated field, no copy in the dialogue", () => {
  const root = newRoot("review-compact");
  const cycleId = "cycle-review-compact";
  const actions = Array.from({ length: 40 }, (_, index) => ({ type: "methods_followup", description: `action ${index} `.repeat(8) }));
  const reviews = [{ lane_id: "followup-gatekeeper-1", verdict: "reject" }];
  const review = {
    ts: "2026-10-16T05:00:02Z",
    type: "gate_review",
    mode: "reject",
    gate_passed: false,
    recommended_followup_actions: actions,
    recommended_actions: actions,
    gatekeeper_review: { reviews },
    gatekeeper_reviews: reviews,
    blockers: ["novelty unverified"],
  };
  assert.equal(appendReviewOnce({ root, cycleId, slot: "gate_review", review, dialogueEventType: "independent_gate_review", now: at(review.ts) }), true);

  const ledger = [];
  decisionLog(root, cycleId).forEachRecord((record) => ledger.push(record));
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].recommended_followup_actions, actions);
  assert.deepEqual(ledger[0].recommended_actions, { $same_as: "recommended_followup_actions" });
  // Small values are kept as they are, even when they repeat.
  assert.deepEqual(ledger[0].gatekeeper_reviews, reviews);
  assert.deepEqual(ledger[0].blockers, ["novelty unverified"]);

  const events = [];
  dialogueLog(root, cycleId).forEachRecord((record) => events.push(record));
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "independent_gate_review");
  assert.deepEqual(
    { mode: events[0].payload.mode, gate_passed: events[0].payload.gate_passed, actions: events[0].payload.recommended_followup_actions },
    { mode: "reject", gate_passed: false, actions: undefined },
  );
  assert.equal(events[0].payload.full_review.ledger_segment, `runtime/${cycleId}-labdirector-decisions/2026-10-16T05.jsonl`);
  assert.ok(fs.existsSync(path.join(root, events[0].payload.full_review.ledger_segment)));
});

test("delivery receipts are folded as they arrive, never re-read", () => {
  const root = newRoot("receipts");
  const cycleId = "cycle-receipts";
  const receipts = deliveryReceiptLog(root, cycleId);
  // An unsplit single file from before, then receipts in two hours.
  fs.mkdirSync(path.dirname(receipts.legacyPath), { recursive: true });
  fs.writeFileSync(receipts.legacyPath, `${JSON.stringify({ message_id: "m1", delivered_to: "analyst", delivered_at: "2026-10-10T00:00:00Z" })}\n`);
  assert.equal(recordDelivery({ root, cycleId, role: "scout", messageIds: ["m1", "m2"], now: at("2026-10-11T09:00:00Z") }), 2);
  assert.equal(recordDelivery({ root, cycleId, role: "scout", messageIds: "m2", laneId: "followup-scout-01", now: at("2026-10-11T10:00:00Z") }), 1);
  assert.deepEqual(receipts.segments().map((segment) => path.basename(segment)), ["delivery-receipts.jsonl", "2026-10-11T09.jsonl", "2026-10-11T10.jsonl"]);
  assert.equal(lines(receipts.segments()[2])[0].lane_id, "followup-scout-01");

  const summaryPath = path.join(root, "messages", cycleId, "delivery-summary.json");
  ensureMessageBus({ root, cycleId });
  const first = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.deepEqual(first.by_id.m1, { count: 2, first_at: "2026-10-10T00:00:00Z", last_at: "2026-10-11T09:00:00.000Z", roles: ["analyst", "scout"] });
  assert.equal(first.by_id.m2.count, 2);
  assert.equal(path.basename(first.position.segment), "2026-10-11T10.jsonl");

  // What was folded is not read again: the closed hours can vanish and the
  // totals stand, and only the new receipt is added.
  fs.rmSync(receipts.legacyPath);
  fs.rmSync(receipts.segments()[0]);
  recordDelivery({ root, cycleId, role: "gatekeeper", messageIds: ["m2"], now: at("2026-10-11T10:30:00Z") });
  ensureMessageBus({ root, cycleId });
  const second = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(second.by_id.m1.count, 2);
  assert.deepEqual([second.by_id.m2.count, second.by_id.m2.roles], [3, ["scout", "gatekeeper"]]);
});

test("the inbox and the dialogue are segments to their readers", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-inbox-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-inbox";
  const inbox = inboxLog(root, cycleId);
  inbox.append({ type: "chronicle_report", n: 1 }, { now: at("2026-10-11T09:00:00Z") });
  inbox.append([{ type: "user_message", n: 2 }, { type: "user_message", n: 3 }], { now: at("2026-10-11T10:00:00Z") });
  assert.equal(inbox.countRecords(), 3);
  assert.equal(fs.existsSync(inbox.legacyPath), false);

  // The metadata index carries the dialogue's recent hours, each event named
  // by its segment and place in it.
  const dialogue = dialogueLog(root, cycleId);
  dialogue.append({ ts: "2026-10-11T09:00:00Z", event_type: "lane_started", payload: { lane_id: "scout-01" } }, { now: at("2026-10-11T09:00:00Z") });
  dialogue.append({ ts: "2026-10-11T10:00:00Z", event_type: "chronicle_response", payload: {} }, { now: at("2026-10-11T10:00:00Z") });
  fs.mkdirSync(path.join(root, "lanes", cycleId), { recursive: true });
  const records = collectLaneRecords({ cwd, cycleId, researchStage: "evidence", controlState: "active" });
  assert.deepEqual(
    records.events.map((event) => [event.event_type, event.event_id]).sort(),
    [
      ["chronicle_response", "event:cycle-inbox-labdirector-dialogue-2026-10-11t10-jsonl-1"],
      ["lane_started", "event:cycle-inbox-labdirector-dialogue-2026-10-11t09-jsonl-1"],
    ],
  );
});

test("replaced review-map generations are cleared, a bounded number at a time", () => {
  const { resetGeneratedDirectory, pruneStaleGenerations } = require("../src/reporting/review_map/fs_helpers");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-stale-"));
  const staleRoot = path.join(parent, ".stale");
  fs.mkdirSync(staleRoot);
  // What 23 days left behind: generations of this cycle's map, and another cycle's.
  for (let index = 0; index < 60; index += 1) {
    fs.mkdirSync(path.join(staleRoot, `cycle-a-${1791000000000 + index}`, "by-agent"), { recursive: true });
    fs.writeFileSync(path.join(staleRoot, `cycle-a-${1791000000000 + index}`, "manifest.json"), "{}");
  }
  fs.mkdirSync(path.join(staleRoot, "cycle-a-2-1791000000005"));
  fs.mkdirSync(path.join(staleRoot, "cycle-b-1791000000001"));
  fs.mkdirSync(path.join(staleRoot, "cycle-a-notes"));

  // A rebuild moves the current map aside and clears 40 of the old ones.
  const target = path.join(parent, "cycle-a");
  fs.mkdirSync(target);
  resetGeneratedDirectory(target);
  assert.equal(fs.existsSync(target), false);
  const left = () => fs.readdirSync(staleRoot).filter((name) => /^cycle-a-\d{13}$/.test(name)).sort();
  assert.equal(left().length, 61 - 40);
  // The next clears the rest down to the newest three, oldest first.
  assert.equal(pruneStaleGenerations(staleRoot, "cycle-a"), 18);
  assert.equal(left().length, 3);
  assert.ok(Number(left()[2].slice("cycle-a-".length)) > 1791000000059, "the generation just replaced is kept");
  assert.deepEqual(left().slice(0, 2), ["cycle-a-1791000000058", "cycle-a-1791000000059"]);
  assert.equal(pruneStaleGenerations(staleRoot, "cycle-a"), 0);
  // Another cycle's generations, and anything that is not one, are not touched.
  for (const name of ["cycle-a-2-1791000000005", "cycle-b-1791000000001", "cycle-a-notes"]) {
    assert.ok(fs.existsSync(path.join(staleRoot, name)), name);
  }
});
