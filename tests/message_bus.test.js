"use strict";

// One bus, and the properties the five mechanisms it replaces did not have.
//
// What it replaced, counted on cycle-g-v89: a mailbox with four hardcoded
// channels whose ledger held only one of them, eight state files each read
// directly by another role, and 48 planner_metadata keys carrying 225 KB on a
// single role plan. The thing named "messages" was the weakest of the five --
// its delivery state had a reader and no writer, and when one channel flooded
// the ledger the director's mailbox file stopped being written on 09-03 while
// the cycle ran to 09-11.
//
// The contract itself is not new. experiment_requests.js had it right for one
// channel: raise, owe a decision, require a reason both ways, escalate while it
// waits, and treat a channel answered the same way enough times as exhausted.

const test = require("node:test");
const assert = require("node:assert");
const { inboxLog } = require("../src/observability/cycle_logs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureMessageBus, recordDelivery, openRequestsFor, raiseOnBus, KEPT_PER_CHANNEL } = require("../src/reporting/message_bus");
const { CHANNELS } = require("../src/reporting/message_bus/channels");
const { defineChannel, decide, KINDS } = require("../src/reporting/message_bus/contract");
const { ensureDir, writeJson } = require("../src/reporting/research_note_utils");

function cycleWith(state = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-bus-"));
  const root = path.join(cwd, ".research-lab");
  ensureDir(path.join(root, "state"));
  for (const [stem, value] of Object.entries(state)) {
    writeJson(path.join(root, "state", `${CYCLE}-${stem}.json`), value);
  }
  return { cwd, root };
}

const CYCLE = "cycle-bus";

function ledgerOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "messages", CYCLE, "bus-ledger.json"), "utf8"));
}

// ------------------------------------------------- the contract

test("a request channel must say what happens while it goes unanswered", () => {
  // A request nobody has to answer is exactly the state the mailbox was in:
  // messages marked trigger_turn and pending, and no path that ever answered
  // one. The contract refuses to declare such a channel.
  assert.throws(
    () => defineChannel({ id: "a->b:x", from: "a", to: "b", kind: KINDS.REQUEST, build: () => [] }),
    /must say what happens while it goes unanswered/,
  );
  // A standing channel owes nobody an answer, so it needs no escalation.
  assert.ok(defineChannel({ id: "a->b:y", from: "a", to: "b", kind: KINDS.STANDING, build: () => [] }));
});

test("a decision carries a reason, in both directions", () => {
  // An adoption nobody can account for later is a silently expanded scope; a
  // decline nobody can account for is the question quietly disappearing.
  assert.equal(decide({ decision: "accept", reason: "", decidedBy: "lab-director" }).ok, false);
  assert.equal(decide({ decision: "decline", reason: "  ", decidedBy: "lab-director" }).ok, false);
  assert.equal(decide({ decision: "sideways", reason: "why", decidedBy: "x" }).ok, false);
  const answered = decide({ decision: "decline", reason: "the arms cannot be run here", decidedBy: "lab-director" });
  assert.equal(answered.ok, true);
  assert.equal(answered.decision.decided_by, "lab-director");
  assert.ok(answered.decision.decided_at);
});

test("every registered channel declares both of its roles and its kind", () => {
  assert.ok(CHANNELS.length >= 5);
  for (const channel of CHANNELS) {
    assert.ok(channel.from, `${channel.id} has no author role`);
    assert.ok(channel.to.length > 0, `${channel.id} reaches nobody`);
    assert.ok(Object.values(KINDS).includes(channel.kind));
    assert.ok(!channel.to.includes(channel.from), `${channel.id} talks to itself`);
  }
  const ids = CHANNELS.map((channel) => channel.id);
  assert.equal(new Set(ids).size, ids.length, "two channels share an id");
});

// ------------------------------------------------- what the bus carries

test("the author's existing channels reach the director as things it owes an answer on", () => {
  // Both of these relationships existed before the bus -- experiment_requests
  // as its own store with decisions and reasons, and the manuscript reviews as
  // blockers. What did not exist was anywhere to ask "who owes whom an answer".
  const { cwd, root } = cycleWith({
    "cycle-run-state": { status: "running", lane_counts: { completed: 7 } },
    "lab-director-research-notes": {
      current_lead_hypothesis: { statement: "The held-out families separate under the mechanism claim." },
      open_blockers: ["reproducibility evidence is not bound to the current family"],
      rejected_or_demoted_hypotheses: [
        { family: "severity_only", status: "retired_valid_falsification", reason: "Runner-107 retained no reuse." },
      ],
    },
    "paper-review": { blockers: ["the results section is too thin"] },
    "experiment-requests": {
      cycle_id: CYCLE,
      requests: [
        { claim_it_would_support: "the mechanism claim", experiment: "run the masked-severity arms", status: "pending" },
        {
          claim_it_would_support: "an answered one",
          experiment: "already decided",
          status: "adopted",
          decision: { adopt: true, reason: "worth the budget", decided_by: "lab-director" },
        },
      ],
    },
  });

  ensureMessageBus({ root, cycleId: CYCLE });
  const owed = openRequestsFor({ root, cycleId: CYCLE, role: "lab-director" }).owes_an_answer;
  const channels = owed.map((message) => message.channel).sort();
  assert.deepEqual(channels, [
    "author->lab-director:experiment-request",
    "author->lab-director:manuscript-blocker",
  ]);
  // The one already decided is not open, and is not re-asked.
  assert.ok(!owed.some((message) => /already decided/.test(message.subject)));

  // The author's side of the same question: what is it waiting on.
  const waiting = openRequestsFor({ root, cycleId: CYCLE, role: "author" }).waiting_on_an_answer;
  assert.equal(waiting.length, 2);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a retired method travels with its reason, to the role writing it up", () => {
  // A retired METHOD is not a retired QUESTION in this programme. Without the
  // reason the write-up buries the question along with the method.
  const { cwd, root } = cycleWith({
    "lab-director-research-notes": {
      current_lead_hypothesis: { statement: "A lead worth writing against." },
      rejected_or_demoted_hypotheses: [
        { family: "severity_only", status: "retired_valid_falsification", reason: "Runner-107 retained no reuse." },
      ],
    },
  });
  ensureMessageBus({ root, cycleId: CYCLE });
  const mandate = ledgerOf(root).messages.find((m) => m.channel === "lab-director->author:write-against");
  assert.ok(mandate, "the author is told nothing about what to write against");
  assert.match(mandate.payload.write_against_lead, /A lead worth writing against/);
  assert.equal(mandate.payload.retired_methods.length, 1);
  assert.match(mandate.payload.retired_methods[0].reason, /retained no reuse/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------- the three failures it fixes

test("a standing message is one message whose content refreshes", () => {
  // The watchdog's summary embedded a lane count, so every refresh minted a new
  // id. That is what filled the ledger: all 250 entries were this one channel.
  const { cwd, root } = cycleWith({});
  for (let pass = 0; pass < 12; pass += 1) {
    writeJson(path.join(root, "state", `${CYCLE}-cycle-run-state.json`), {
      status: "running",
      lane_counts: { completed: pass },
    });
    ensureMessageBus({ root, cycleId: CYCLE });
  }
  const status = ledgerOf(root).messages.filter((m) => m.channel === "watchdog->supervisor:cycle-status");
  assert.equal(status.length, 1, `${status.length} copies of one standing message`);
  assert.match(status[0].subject, /completed 11 lanes/, "the standing message stopped refreshing");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a busy channel loses its own history and nobody else's", () => {
  // The cap was one global slice across all channels, over a sort key every
  // message left empty -- so it kept whichever author had the highest sequence
  // number and evicted the director's channel permanently.
  const { cwd, root } = cycleWith({
    "cycle-run-state": { status: "running" },
    "lab-director-research-notes": { current_lead_hypothesis: { statement: "A lead." } },
    "paper-review": { blockers: [] },
  });
  const busDir = path.join(root, "messages", CYCLE);
  ensureDir(busDir);
  const noisy = [];
  for (let index = 0; index < 300; index += 1) {
    noisy.push({
      message_id: `author->lab-director:manuscript-blocker#noise-${index}`,
      channel: "author->lab-director:manuscript-blocker",
      kind: "request",
      from_role: "author",
      to_roles: ["lab-director"],
      subject: `distinct blocker ${index}`,
      open: true,
      queued_at: new Date(Date.now() - (300 - index) * 1000).toISOString(),
    });
  }
  writeJson(path.join(busDir, "bus-ledger.json"), { schema_version: 1, cycle_id: CYCLE, messages: noisy });

  ensureMessageBus({ root, cycleId: CYCLE });
  const ledger = ledgerOf(root);
  const channels = new Set(ledger.messages.map((m) => m.channel));
  for (const channel of [
    "watchdog->supervisor:cycle-status",
    "supervisor->lab-director:focus",
    "lab-director->author:write-against",
  ]) {
    assert.ok(channels.has(channel), `${channel} was evicted by a busier channel`);
  }
  const noisyKept = ledger.messages.filter((m) => m.channel === "author->lab-director:manuscript-blocker").length;
  assert.ok(noisyKept <= KEPT_PER_CHANNEL + 1, `the busy channel kept ${noisyKept} and is still unbounded`);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("delivery is recorded, so an undelivered message is visible as one", () => {
  // `delivery_state` had a reader and no writer: nothing in the system ever set
  // acknowledged_at, so every message was pending forever and "was this
  // delivered?" had no answer other than re-reading a prompt.
  const { cwd, root } = cycleWith({
    "cycle-run-state": { status: "running" },
    "lab-director-research-notes": { current_lead_hypothesis: { statement: "A lead." } },
  });
  ensureMessageBus({ root, cycleId: CYCLE });
  const before = ledgerOf(root);
  assert.equal(before.undelivered_count, before.message_count, "something claimed delivery with no receipt");

  const focus = before.messages.find((m) => m.channel === "supervisor->lab-director:focus");
  recordDelivery({ root, cycleId: CYCLE, role: "lab-director", messageIds: [focus.message_id], laneId: "lab-director-01" });

  ensureMessageBus({ root, cycleId: CYCLE });
  const after = ledgerOf(root);
  const delivered = after.messages.find((m) => m.message_id === focus.message_id);
  assert.equal(delivered.delivered_count, 1);
  assert.deepEqual(delivered.delivered_to, ["lab-director"]);
  assert.ok(delivered.first_delivered_at);
  assert.equal(after.undelivered_count, before.undelivered_count - 1);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a channel whose source is unreadable does not take the bus down", () => {
  const { cwd, root } = cycleWith({});
  fs.writeFileSync(path.join(root, "state", `${CYCLE}-lab-director-research-notes.json`), "{ not json", "utf8");
  const result = ensureMessageBus({ root, cycleId: CYCLE });
  assert.ok(result.message_count >= 1, "one bad source silenced every channel");
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ------------------------------------------------- the sixth mechanism

// `runtime/<cycle>-labdirector-inbox.jsonl` was a place two producers wrote
// directly, which made it a sixth place to look for "who has asked whom for
// what". It is not one thing: on cycle-g-v89 its 1,464 lines were 1,268
// chronicle reports, 189 lane-failure notices, and 7 supervisor instructions.
// Only the last are REQUESTS, and pushing the other 1,457 through a bus built
// for decisions would repeat the conflation the bus exists to remove.
//
// So the feed stays a feed and the request moves: the producer raises, the bus
// projects the line the Rust consumer still reads -- that consumer spawns a
// lab-director lane from it, so the transport must not change.
test("a request to the director is raised on the bus and projected once", () => {
  const { cwd, root } = cycleWith({ "cycle-run-state": { status: "running" } });
  raiseOnBus({
    root,
    cycleId: CYCLE,
    channel: "supervisor->lab-director:interrupt",
    from: "supervisor",
    to: "lab-director",
    itemId: "decision-latency-p3-s2",
    subject: "the cycle fingerprint has not advanced for 2 supervisor passes",
    asksFor: "author the decisive next move, or say what you are waiting on",
    payload: { issue_code: "supervisor_decision_latency_interrupt" },
  });
  ensureMessageBus({ root, cycleId: CYCLE });

  const inbox = inboxLog(root, CYCLE);
  assert.equal(inbox.segments().length, 1, "the consumer's inbox was not written");
  // By the hour, not into the single file it used to be.
  assert.equal(fs.existsSync(inbox.legacyPath), false);
  const read = () => {
    const rows = [];
    inbox.forEachRecord((record) => rows.push(record));
    return rows;
  };
  const first = read();
  assert.equal(first.length, 1);
  // The shape the Rust consumer matches on, unchanged.
  assert.equal(first[0].type, "supervisor_instruction");
  assert.equal(first[0].payload.issue_code, "supervisor_decision_latency_interrupt");

  // The bus rebuilds every pass and the file is append-only behind a read
  // cursor, so a projection that ran on each rebuild would replay the same
  // instruction forever and spawn a lane each time.
  ensureMessageBus({ root, cycleId: CYCLE });
  ensureMessageBus({ root, cycleId: CYCLE });
  assert.equal(read().length, 1, "the instruction was replayed into the cursor");

  // ...and it is a request the director owes an answer on, which the inbox
  // could never say.
  const owed = openRequestsFor({ root, cycleId: CYCLE, role: "lab-director" }).owes_an_answer;
  assert.equal(owed.length, 1);
  assert.equal(owed[0].channel, "supervisor->lab-director:interrupt");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a supervisor interrupt is answered by the next director decision", () => {
  // cycle-a-20260919, 2026-10-02: six interrupts, one citing a gate
  // score of 41 from days earlier, sat open in every director prompt.
  const { cwd, root } = cycleWith({ "cycle-run-state": { status: "running" } });
  const lanes = path.join(root, "lanes", CYCLE);
  const directorLane = (name, status, at) => {
    ensureDir(path.join(lanes, name));
    const file = path.join(lanes, name, "final-status.json");
    writeJson(file, { status });
    fs.utimesSync(file, at, at);
  };
  const raisedAt = new Date(Date.now() - 60_000);
  directorLane("followup-lab-director-10", "completed", new Date(raisedAt.getTime() - 60_000));
  raiseOnBus({
    root,
    cycleId: CYCLE,
    channel: "supervisor->lab-director:interrupt",
    from: "supervisor",
    to: "lab-director",
    itemId: "decision-latency-p3-s1",
    subject: "the cycle fingerprint has not advanced for 1 supervisor pass",
    asksFor: "author the decisive next move, or say what you are waiting on",
    now: raisedAt,
  });
  const owed = () => openRequestsFor({ root, cycleId: CYCLE, role: "lab-director" }).owes_an_answer
    .filter((item) => item.channel === "supervisor->lab-director:interrupt");

  ensureMessageBus({ root, cycleId: CYCLE });
  assert.equal(owed().length, 1, "a decision from before the interrupt does not answer it");

  // A director lane that is still running, or failed, has not answered.
  directorLane("followup-lab-director-11", "failed", new Date());
  ensureMessageBus({ root, cycleId: CYCLE });
  assert.equal(owed().length, 1);

  directorLane("followup-lab-director-12", "completed", new Date());
  ensureMessageBus({ root, cycleId: CYCLE });
  assert.equal(owed().length, 0, "the interrupt stayed open after the director decided");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("nothing but the bus writes the director's inbox", () => {
  // The two producers that used to append to it directly.
  const producers = {
    "src/orchestrator/run_research.js": "the supervisor's decision-latency interrupt",
    "src/reporting/labdirector_messages.js": "the researcher's own instruction",
  };
  for (const [file, what] of Object.entries(producers)) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const writes = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .filter((line) => /appendJsonl\(.*labdirector-inbox/.test(line));
    assert.deepEqual(writes, [], `${what} still writes the inbox directly (${file})`);
    assert.match(source, /raiseOnBus/, `${what} does not raise on the bus (${file})`);
  }
});

// A channel raised by NAME from code is a channel that exists, and the registry
// is where the channels that exist are listed. Two were not in it:
// `supervisor->lab-director:interrupt` and `researcher->lab-director:instruction`
// were written by name in run_research.js and live_view/chat.js and appeared
// nowhere in channels.js. They reached the bus through `raiseOnBus`, whose
// generic reader has no registry entry to consult -- so `defineChannel`'s one
// hard rule, that a request must say what happens while it goes unanswered,
// was not applied to the only two requests a PERSON or the supervisor raises.
test("a request channel raised by name is registered, and escalates", () => {
  const raised = ["supervisor->lab-director:interrupt", "researcher->lab-director:instruction"];
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src/reporting/message_bus/channels.js"),
    "utf8",
  );
  for (const id of raised) {
    assert.match(source, new RegExp(id.replace(/[->:]/g, "\\$&")), `${id} is not registered`);
    const channel = CHANNELS.find((entry) => entry.id === id);
    assert.ok(channel, `${id} is not in CHANNELS`);
    assert.equal(channel.kind, "request", `${id} is not a request`);
    assert.equal(typeof channel.escalate, "function", `${id} cannot escalate`);
  }
});

test("an unanswered researcher instruction escalates into a dispatched lane", () => {
  const { cwd, root } = cycleWith({ "cycle-run-state": { status: "running" } });
  raiseOnBus({
    root,
    cycleId: CYCLE,
    channel: "researcher->lab-director:instruction",
    from: "researcher",
    to: "lab-director",
    itemId: "msg-1",
    subject: "stop chasing the render lead and answer the falsification",
    asksFor: "act on what the researcher asked for, or say why you are not",
  });
  ensureMessageBus({ root, cycleId: CYCLE });

  const ledger = JSON.parse(
    fs.readFileSync(path.join(root, "messages", CYCLE, "bus-ledger.json"), "utf8"),
  );
  const state = ledger.messages.find(
    (message) => message.message_id === "researcher->lab-director:instruction#channel-state",
  );
  assert.ok(state, "the channel never said it was waiting on an answer");
  const [escalation] = state.payload.escalations;
  assert.equal(escalation.preferred_role, "lab-director");
  assert.equal(escalation.priority, "critical");

  // The escalation summary is not itself a request, so it must not reach the
  // consumer that spawns a lane per line -- that would be two lanes for one ask.
  assert.equal(inboxLog(root, CYCLE).countRecords(), 1, "the channel-state summary was projected as an instruction");

  fs.rmSync(cwd, { recursive: true, force: true });
});
