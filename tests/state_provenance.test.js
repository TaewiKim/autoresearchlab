"use strict";

// The scope of "a write must leave a record", enforced rather than described.
//
// "Every write is recorded" was measured at 316 write sites across 53 files in
// three runtimes. That is not a rule anybody keeps, and a rule nobody keeps is
// the same as no rule. So the scope is drawn by MBM-Core's own criterion --
// whether a decision can be reconstructed -- and the criterion is applied per
// artifact: delete it, re-run aggregation over the lane tree and the event log,
// and see whether it comes back.
//
// What made the scope necessary: cycle-g-v91 lost a lane directory's origin
// because no event records a filesystem mutation, and today a halt, a
// termination code, a pause marker and an instrument inventory were each
// replaced by hand, each archived by hand, and none of it was required by
// anything. The archiving was right; nothing made it obligatory.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  STATE_PROVENANCE,
  classifyStateKind,
  isAuthoritative,
  recordStateWrite,
} = require("../src/provenance/state_provenance");

const ROOT = path.join(__dirname, "..");

function walk(dir, ext, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "target", "__pycache__", ".venv", "live_view"].includes(entry.name)) continue;
      walk(full, ext, out);
    } else if (entry.name.endsWith(ext) && !/[\\/]tests?[\\/]/.test(full)
      && !full.endsWith(".test.js") && !full.endsWith("_test.py")) {
      out.push(full);
    }
  }
  return out;
}

// How a cycle-scoped artifact is named, in each of the three runtimes.
const NAMING = [
  /\{cycle_id\}-([a-z0-9][a-z0-9-]*)\.(?:json|jsonl|md|txt)/g,
  /\$\{cycleId\}-([a-z0-9][a-z0-9-]*)\.(?:json|jsonl|md|txt)/g,
  /\{cycle\}-([a-z0-9][a-z0-9-]*)\.(?:json|jsonl|md|txt)/g,
  /\{\}-([a-z0-9][a-z0-9-]*)\.(?:json|jsonl|md|txt)/g,
  /\$\{cycle_id\}-([a-z0-9][a-z0-9-]*)\.(?:json|jsonl|md|txt)/g,
];

function kindsNamedInSource() {
  const files = [
    ...walk(path.join(ROOT, "native", "researchlab-harness", "src"), ".rs"),
    ...walk(path.join(ROOT, "src"), ".js"),
    ...walk(path.join(ROOT, "drivers"), ".py"),
  ];
  const found = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of NAMING) {
      for (const match of text.matchAll(pattern)) {
        if (!found.has(match[1])) found.set(match[1], path.relative(ROOT, file).replaceAll("\\", "/"));
      }
    }
  }
  return found;
}

test("every cycle state kind the code names is classified", () => {
  // The table IS the scope, so a kind outside it is a kind nobody decided
  // about. This is what stops the scope from quietly narrowing as the system
  // grows -- the same way a probe backend nobody listed went unprobed for a
  // whole cycle.
  const unclassified = [];
  for (const [kind, where] of kindsNamedInSource()) {
    if (classifyStateKind(kind) === undefined) unclassified.push(`${kind} (${where})`);
  }
  assert.deepEqual(
    unclassified.sort(),
    [],
    "classify these in src/provenance/state_provenance.js as derived or authoritative",
  );
});

test("the classification says why, in every entry", () => {
  // A class with no reason is a guess that looks like a decision. The reason is
  // what a later reader disagrees with.
  const silent = Object.entries(STATE_PROVENANCE)
    .filter(([, entry]) => !String(entry.why || "").trim())
    .map(([kind]) => kind);
  assert.deepEqual(silent, []);
  for (const [kind, entry] of Object.entries(STATE_PROVENANCE)) {
    assert.ok(["derived", "authoritative"].includes(entry.class), `${kind} has class ${entry.class}`);
  }
});

test("the four the owner settled are settled", () => {
  // Reviews are rewritten on every refresh, so the body is derived and the
  // history is where the judgement survives. The director's hypothesis, the
  // append-only progress graph and actual spend cannot be re-derived at all.
  assert.equal(classifyStateKind("gate-review"), "derived");
  assert.equal(classifyStateKind("gate-review-history"), "authoritative");
  assert.equal(classifyStateKind("lab-director-hypothesis"), "authoritative");
  assert.equal(classifyStateKind("hypothesis-progress"), "authoritative");
  assert.equal(classifyStateKind("token-budget"), "authoritative");
});

test("a derived artifact is out of scope and says so rather than being recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-prov-"));
  const result = recordStateWrite({
    root, cycleId: "cg-1", kind: "literature-graph",
    operation: "replace", actor: "chronicle", reason: "refresh", previous: "x.bak",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.refused, "derived_state_needs_no_record");
  assert.ok(!fs.existsSync(path.join(root, ".research-lab", "events")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("an authoritative write is recorded with who, why, and what it replaced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-prov-"));
  const result = recordStateWrite({
    root, cycleId: "cg-1", kind: "watchdog-halt", operation: "remove",
    actor: "operator", reason: "cleared with the instrument-probe fix",
    previous: ".../watchdog-halt.json.cleared-with-67e0429",
  });
  assert.equal(result.recorded, true);
  const written = fs.readFileSync(
    path.join(root, ".research-lab", "events", "cg-1-cycle-events.jsonl"), "utf8",
  ).trim();
  const event = JSON.parse(written);
  assert.equal(event.event_type, "authoritative-state-write");
  assert.equal(event.payload.kind, "watchdog-halt");
  assert.equal(event.payload.actor, "operator");
  assert.match(event.payload.reason, /instrument-probe fix/);
  assert.ok(event.payload.why_authoritative, "the record carries why this kind is in scope");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a record it cannot make honestly is refused, not faked", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "state-prov-"));
  const base = { root, cycleId: "cg-1", kind: "termination-code", operation: "replace" };
  assert.equal(recordStateWrite({ ...base, reason: "r", previous: "p" }).refused, "no_actor");
  assert.equal(recordStateWrite({ ...base, actor: "a", previous: "p" }).refused, "no_reason");
  // A replacement with nowhere to point has destroyed the only copy, which is
  // exactly what this scope exists to prevent.
  assert.equal(recordStateWrite({ ...base, actor: "a", reason: "r" }).refused,
    "replacement_without_prior_version");
  assert.equal(
    recordStateWrite({ ...base, kind: "not-a-real-kind", actor: "a", reason: "r", previous: "p" }).refused,
    "unclassified_state_kind",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("failing to record never undoes the write it was observing", () => {
  // The caller has already written the file. An exception here would turn an
  // observation into the outage it exists to prevent -- a stray directory once
  // aborted this harness 1,587 times.
  const result = recordStateWrite({
    root: path.join(os.tmpdir(), "definitely", "not", "writable", "\0bad"),
    cycleId: "cg-1", kind: "watchdog-halt", operation: "create",
    actor: "a", reason: "r",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.refused, "append_failed");
});

test("the scope is a minority of the artifacts, on purpose", () => {
  // 316 write sites was the reason a blanket rule could not be kept. If the
  // authoritative set ever grows to most of the table, the criterion has stopped
  // being applied and somebody is classifying by caution instead.
  const total = Object.keys(STATE_PROVENANCE).length;
  const authoritative = Object.keys(STATE_PROVENANCE).filter(isAuthoritative).length;
  assert.ok(total >= 100, `expected the full census, got ${total}`);
  assert.ok(
    authoritative < total / 2,
    `${authoritative} of ${total} classified authoritative; re-apply the delete-and-rebuild test`,
  );
});

// ---------------------------------------------------------------------------
// The archive step: what recordStateWrite demanded and nothing produced.
//
// `recordStateWrite` refuses a replacement that cannot name its prior version,
// which left it reachable only for a create -- so the one rule meant to stop a
// valuable record being overwritten had no way to be obeyed.
//
// cycle-g-v91's lab-director-hypothesis.json vanished between 20:02 and 20:06
// on 2026-09-13 leaving no actor, no reason and no copy. The review-map entries
// that look like archived snapshots are SYMLINKS back into state, so they went
// dangling with it and the record is simply gone.

const {
  writeAuthoritativeState,
  archiveStatePath,
} = require("../src/provenance/state_provenance");
const {
  projectNotesLeadToHypothesis,
} = require("../src/reporting/lab_director_research_notes");

const NEWLINE = String.fromCharCode(10);

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "state-write-"));
}

test("a first write has nothing to keep, and says so", () => {
  const root = tempRoot();
  const filePath = path.join(root, ".research-lab", "state", "cg-1-claim-traces.json");
  const result = writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "claim-traces", filePath,
    value: { traces: ["first"] },
    actor: "chronicle", reason: "the first claim was admitted",
  });
  assert.equal(result.written, true);
  assert.equal(result.operation, "create");
  assert.equal(result.previous_version_path, null);
  assert.equal(result.recorded, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).traces, ["first"]);
  assert.ok(!fs.existsSync(path.join(root, ".research-lab", "state-archive")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a replacement keeps the version it replaced, and the record points at it", () => {
  const root = tempRoot();
  const filePath = path.join(root, ".research-lab", "state", "cg-1-claim-traces.json");
  writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "claim-traces", filePath,
    value: { traces: ["the one that used to be here"] },
    actor: "chronicle", reason: "first",
  });
  const result = writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "claim-traces", filePath,
    value: { traces: ["the new one"] },
    actor: "chronicle", reason: "a later claim superseded it",
  });

  assert.equal(result.operation, "replace");
  assert.equal(result.recorded, true, `refused: ${result.refused}`);
  assert.ok(result.previous_version_path, "a replacement with no prior copy is the loss itself");
  // The archived bytes are the OLD content, not a second copy of the new one.
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.previous_version_path, "utf8")).traces,
    ["the one that used to be here"],
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")).traces, ["the new one"]);
  // And the event names where to find it.
  const events = fs.readFileSync(
    path.join(root, ".research-lab", "events", "cg-1-cycle-events.jsonl"), "utf8",
  ).trim().split(NEWLINE).map((line) => JSON.parse(line));
  assert.equal(events.at(-1).payload.previous_version_path, result.previous_version_path);
  fs.rmSync(root, { recursive: true, force: true });
});

test("when the old version cannot be copied, the new one is not written", () => {
  // Fail-closed. Overwriting the only copy of a decision because the copy step
  // failed is exactly the loss this exists to prevent.
  const root = tempRoot();
  const filePath = path.join(root, ".research-lab", "state", "cg-1-claim-traces.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ traces: ["irreplaceable"] }), "utf8");
  // A file where the archive tree needs a directory.
  fs.writeFileSync(path.join(root, ".research-lab", "state-archive"), "not a directory", "utf8");

  const result = writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "claim-traces", filePath,
    value: { traces: ["would have replaced it"] },
    actor: "chronicle", reason: "a later claim superseded it",
  });
  assert.equal(result.written, false);
  assert.equal(result.refused, "archive_failed");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(filePath, "utf8")).traces, ["irreplaceable"],
    "the record that could not be copied was overwritten anyway",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a derived artifact is written plainly and keeps no archive", () => {
  const root = tempRoot();
  const filePath = path.join(root, ".research-lab", "state", "cg-1-literature-graph.json");
  writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "literature-graph", filePath,
    value: { nodes: 1 }, actor: "chronicle", reason: "refresh",
  });
  const result = writeAuthoritativeState({
    root, cycleId: "cg-1", kind: "literature-graph", filePath,
    value: { nodes: 2 }, actor: "chronicle", reason: "refresh",
  });
  assert.equal(result.written, true);
  assert.equal(result.recorded, false);
  assert.equal(result.refused, "derived_state_needs_no_record");
  assert.equal(result.previous_version_path, null);
  assert.ok(!fs.existsSync(path.join(root, ".research-lab", "state-archive")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("notes do not re-apply a director replacement the harness is holding back", () => {
  // The harness defers a replacement until the current lead's own evidence has
  // been gated. Notes carry the latest director DECISION, so projecting it here
  // would apply exactly the replacement that was deferred.
  const root = tempRoot();
  const stateRoot = path.join(root, ".research-lab", "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  const cycleId = "cg-lead-hold";
  const hypothesisPath = path.join(stateRoot, `${cycleId}-lab-director-hypothesis.json`);
  fs.writeFileSync(hypothesisPath, JSON.stringify({
    statement: "the held lead",
    selected_at_epoch_ms: Date.now(),
    projection_source: "lab_director_lane_result",
  }));

  const project = (lead) => projectNotesLeadToHypothesis({
    stateRoot, cycleId,
    notes: { current_lead_hypothesis: lead, updated_at: new Date().toISOString(), generated_by: "refresh" },
  });

  assert.equal(project({ statement: "the deferred replacement", source: "lab_director_lane_payload" }), null);
  assert.equal(JSON.parse(fs.readFileSync(hypothesisPath, "utf8")).statement, "the held lead");

  // The same lead restated still refreshes, and an operator-forced lead still passes.
  assert.ok(project({ statement: "the held lead", source: "lab_director_lane_payload" }));
  assert.ok(project({ statement: "an operator pivot", source: "forced_strategy_decision" }));
  assert.equal(JSON.parse(fs.readFileSync(hypothesisPath, "utf8")).statement, "an operator pivot");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the archive path is outside state, and named by when the copy was taken", () => {
  const when = new Date("2026-09-13T11:02:08.000Z");
  const archive = archiveStatePath("/r", "cg-1", "lab-director-hypothesis", when);
  assert.ok(archive.includes("state-archive"), archive);
  assert.ok(!archive.includes(`${path.sep}state${path.sep}`), `archives must not sit in state: ${archive}`);
  assert.ok(archive.includes("2026-09-13T11-02-08"), archive);
});

test("the director's lead is written through the rule, not around it", () => {
  // The path that actually writes the artifact cycle-g-v91 lost. A source-text
  // assertion would pass while the call sat on a branch nothing reaches.
  const root = tempRoot();
  const stateRoot = path.join(root, ".research-lab", "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  const cycleId = "cg-lead-archive";

  const project = (statement, by) => projectNotesLeadToHypothesis({
    stateRoot, cycleId,
    notes: {
      current_lead_hypothesis: { statement, primary_family: "f" },
      updated_at: new Date().toISOString(),
      generated_by: by,
    },
  });

  assert.ok(project("the lead that must survive being replaced", "followup-lab-director-43"));
  const written = project("a later lead", "followup-lab-director-44");
  assert.ok(written, "the projection refused a write it should have made");

  const archiveDir = path.join(root, ".research-lab", "state-archive", cycleId, "lab-director-hypothesis");
  const copies = fs.readdirSync(archiveDir);
  assert.equal(copies.length, 1, "the replaced lead was not kept");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(archiveDir, copies[0]), "utf8")).statement,
    "the lead that must survive being replaced",
  );

  const events = fs.readFileSync(
    path.join(root, ".research-lab", "events", `${cycleId}-cycle-events.jsonl`), "utf8",
  ).trim().split(NEWLINE).map((line) => JSON.parse(line));
  const replace = events.filter((item) => item.payload.operation === "replace").at(-1);
  assert.equal(replace.payload.kind, "lab-director-hypothesis");
  assert.equal(replace.payload.actor, "followup-lab-director-44");
  assert.ok(replace.payload.reason, "a write with no reason is the shape being removed");
  fs.rmSync(root, { recursive: true, force: true });
});
