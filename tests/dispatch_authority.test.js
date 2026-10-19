"use strict";

// A rule reaches a lane, or it does not exist.
//
// The JS plan builders are not the dispatch path. On cycle-g-v89, 1,392 of
// 1,397 role plans were written by the Rust follow-up builder and none carried
// a JS-authored key -- so a rule written only in `src/agents/**` is inert, and
// looks present in the obvious place while being delivered nowhere. That has
// now happened at least six times in this repository, and every time it was
// found by reading a dispatched lane's prompt rather than the source.
//
// These assertions are that reading, made mechanical: every governed rule must
// exist on BOTH sides, and a rule-bearing key in a plan must be either governed
// or explicitly excused.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const {
  GOVERNED_RULES,
  UNGOVERNED_KEYS,
  DELIVERY_MODES,
} = require("../src/policy/dispatch_authority");

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("every governed rule exists on the JS side it claims", () => {
  const missing = [];
  for (const entry of GOVERNED_RULES) {
    if (!fs.existsSync(path.join(ROOT, entry.js.file))) {
      missing.push(`${entry.rule}: no file ${entry.js.file}`);
      continue;
    }
    if (!read(entry.js.file).includes(entry.js.key)) {
      missing.push(`${entry.rule}: ${entry.js.file} no longer contains ${entry.js.key}`);
    }
  }
  assert.deepEqual(missing, [], "the registry points at JS that has moved or gone");
});

test("every governed rule is delivered by Rust that exists", () => {
  // The half that actually matters. A registry entry whose Rust symbol is gone
  // is a rule that stopped being delivered, and nothing else in the suite would
  // notice: the JS side still reads correctly.
  const missing = [];
  for (const entry of GOVERNED_RULES) {
    if (!fs.existsSync(path.join(ROOT, entry.rust.file))) {
      missing.push(`${entry.rule}: no file ${entry.rust.file}`);
      continue;
    }
    if (!read(entry.rust.file).includes(entry.rust.symbol)) {
      missing.push(`${entry.rule}: ${entry.rust.file} no longer defines ${entry.rust.symbol}`);
    }
  }
  assert.deepEqual(missing, [], "these rules are written in JS and delivered by nothing");
});

test("every governed rule declares how it arrives", () => {
  for (const entry of GOVERNED_RULES) {
    assert.ok(
      DELIVERY_MODES.includes(entry.delivered_via),
      `${entry.rule}: ${entry.delivered_via} is not a delivery mode`,
    );
  }
});

// ------------------------------------------------- nothing slips in ungoverned

const PLANS = [
  ["analyst", () => require("../src/agents/analyst/query_plan").buildAnalystQueryPlan({ prompt: "x", laneId: "analyst-01" })],
  ["scout", () => require("../src/agents/scout/query_plan").buildScoutQueryPlan({ prompt: "x", laneId: "scout-01" })],
  ["engineer", () => require("../src/agents/engineer/environment_plan").buildEngineerEnvironmentPlan({ prompt: "x", laneId: "engineer-01", cycleId: "c" })],
  // Chronicle was absent from this list, which is why its literature_relevance_review
  // could sit in a JS plan for two cycles while 0 of 100 dispatched lanes received
  // it. A builder not scanned here is a builder whose rules nothing checks.
  ["chronicle", () => require("../src/agents/chronicle/brief_plan").buildChronicleBriefPlan({ prompt: "x", laneId: "chronicle-01", cycleId: "c" })],
];

// A key carries a RULE when it holds prose long enough to be an instruction
// rather than a label. Short strings, numbers and identifiers are configuration.
function carriesRule(value) {
  if (Array.isArray(value)) {
    return value.some((item) => typeof item === "string" && item.length > 60);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(carriesRule);
  }
  return typeof value === "string" && value.length > 120;
}

test("a rule-bearing plan key is governed, or excused in writing", () => {
  const governedJsKeys = new Set(GOVERNED_RULES.map((entry) => entry.js.key));
  const ungoverned = [];
  for (const [role, build] of PLANS) {
    const plan = build();
    for (const [key, value] of Object.entries(plan)) {
      if (!carriesRule(value)) continue;
      if (governedJsKeys.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(UNGOVERNED_KEYS, key)) continue;
      // A key whose rule is governed under a different name still has to be
      // named somewhere, so nothing rides along unaccounted for.
      ungoverned.push(`${role}.${key}`);
    }
  }
  assert.deepEqual(
    ungoverned,
    [],
    "these keys carry instructions that no Rust path is recorded as delivering; "
      + "wire the Rust side and register it, or excuse the key in UNGOVERNED_KEYS with the reason",
  );
});

test("an excuse names a key that actually exists", () => {
  // An excuse for a key nobody emits is a stale note that quietly widens the
  // exemption: the next key with that name is excused before anyone looks.
  const emitted = new Set();
  for (const [, build] of PLANS) {
    for (const key of Object.keys(build())) emitted.add(key);
  }
  const stale = Object.keys(UNGOVERNED_KEYS).filter((key) => !emitted.has(key));
  assert.deepEqual(stale, [], "these excuses name keys no plan emits any more");
});

test("the authority is stated where the plans are built", () => {
  // A future reader edits src/agents and needs to learn this before shipping,
  // not after a cycle has run on a rule nobody received.
  assert.match(
    read("src/policy/dispatch_authority.js"),
    /Rust follow-up builder is the authority for a dispatched lane/,
  );
  assert.match(
    read("src/agents/index.js"),
    /dispatch_authority/,
    "the plan dispatcher does not point at the authority note",
  );
});


// ---------------------------------------------------------------------------
// Both ends of an inter-role signal.
//
// The rules above answer "is it delivered". These answer "does anyone read it",
// which is the other half of every failure this programme has had and the half
// MBM-Core does not govern: its gate can refuse a record that ARRIVES and has
// no concept of one that never does, so downstream `not delivered`, `denied`
// and `never existed` are one absence.
//
// lab_director_alerts named its recipient, stated what it wanted, and was read
// by nothing for two cycles. skipped_lanes was written by the only component
// that saw the stray directory, into a field with no reader anywhere. The
// gatekeeper was asked whether a falsification was adequate and never shown it.
// None of those is an admission failure; all are delivery.

const { INTER_ROLE_SIGNALS, interRoleSignals } = require("../src/policy/dispatch_authority");

function readIfPresent(relative) {
  const full = path.join(__dirname, "..", relative);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

// One signal, spelled three ways. The same record is `instrument_inventory` in
// a role plan, `instrument-inventory` in a filename and
// `RESEARCHLAB_INSTRUMENT_INVENTORY_OUT` in the driver's environment -- because
// three runtimes each spell it their own way. Insisting on one spelling would
// force a cosmetic rename across all three; comparing normalized asks the
// question that matters, which is whether this file is about that signal.
function mentions(text, signal) {
  const flatten = (value) => value.toLowerCase().replaceAll("-", "_");
  return flatten(text).includes(flatten(signal));
}

test("every inter-role signal names a producer and a consumer that exist", () => {
  const missing = [];
  for (const entry of interRoleSignals()) {
    for (const side of ["producer", "consumer"]) {
      const end = entry[side];
      if (!end || !end.file || !String(end.role || "").trim()) {
        missing.push(`${entry.signal}: ${side} is not named`);
        continue;
      }
      if (readIfPresent(end.file) === null) missing.push(`${entry.signal}: ${side} file ${end.file} is gone`);
    }
  }
  assert.deepEqual(missing, [], "a signal with an end that does not exist is a message into the air");
});

test("the consumer actually mentions the signal it is said to read", () => {
  // The rule this repository learned the hard way: grep the CONSUMER for the
  // field before blaming the consumer. A registry entry claiming somebody reads
  // a signal, where that file never names it, is the same false assurance the
  // entry exists to prevent.
  const unread = [];
  for (const entry of interRoleSignals()) {
    const text = readIfPresent(entry.consumer.file);
    if (text === null) continue;
    if (!mentions(text, entry.signal)) {
      unread.push(`${entry.signal} is not named anywhere in ${entry.consumer.file}`);
    }
  }
  assert.deepEqual(unread, [], "these signals have a consumer on paper and none in the code");
});

test("the producer actually writes the signal it is said to produce", () => {
  const unwritten = [];
  for (const entry of interRoleSignals()) {
    const text = readIfPresent(entry.producer.file);
    if (text === null) continue;
    if (!mentions(text, entry.signal)) {
      unwritten.push(`${entry.signal} is not named anywhere in ${entry.producer.file}`);
    }
  }
  assert.deepEqual(unwritten, [], "these signals are claimed to come from a file that never mentions them");
});

test("a signal says what it is for, and how it travels", () => {
  for (const entry of interRoleSignals()) {
    assert.ok(String(entry.what || "").trim(), `${entry.signal} does not say what it is for`);
    assert.ok(
      DELIVERY_MODES.includes(entry.delivered_via),
      `${entry.signal} travels by ${entry.delivered_via}, which is not a mode`,
    );
  }
});

test("the registry carries the signals whose absence was measured", () => {
  // Not a completeness claim -- nobody can enumerate every signal in three
  // runtimes. It pins the ones that actually failed, so a later edit cannot
  // quietly drop the case that taught the lesson.
  const names = new Set(INTER_ROLE_SIGNALS.map((entry) => entry.signal));
  for (const signal of [
    "lab_director_alerts",
    "chronicle_decision_digest",
    "instrument_inventory",
    "current_lead_under_review",
    "dependency_stall",
  ]) {
    assert.ok(names.has(signal), `${signal} failed in a measured cycle and is not registered`);
  }
});
