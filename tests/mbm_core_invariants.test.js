"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// MBM-Core as a system-wide design principle, enforced rather than described.
//
// The principle is the owner's own paper, and this runtime already implements
// its reference monitor in src/provenance/message_bound_gate.js: "RELEVANCE IS
// NOT AUTHORIZATION. A record is admitted into the active decision's context
// ONLY IF it is authorized for THIS message ... recomputed from the event/lane
// graph, never trusted from a record's own field." The operational form, from
// docs/research-note-source-of-truth-2026-06-11.md, is three properties:
// provenance-bound admission, fail-closed gates, and an audit log.
//
// Implemented is not the same as applied. Measured on 2026-09-10, cycle-g-v89
// had run for ten days and:
//
//   - 1,478 review entries scored at or above 85 with zero stated reasons
//   - the gate score reached its threshold and lost it repeatedly, and no
//     record of the trajectory survived, because every review is written to one
//     path and rewritten on each refresh
//   - the decision ledger had grown to 4.1 GB and had stopped recording rubric
//     numbers after day one, so it could not reconstruct the decisions either
//   - one score path read an ABSENT gate score as 100, so "not yet scored" was
//     indistinguishable from "satisfied"
//   - the memory gate had exactly one consumer in the whole runtime
//
// These tests are the guard rails for those five failures. They read source,
// which is a blunt instrument, so each one checks a specific shape that was
// actually observed rather than a stylistic preference.

const SRC = path.join(__dirname, "..", "src");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "live_view" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC);

// The other two runtimes.
//
// This file read `src/**.js` and nothing else, and the invariant that matters
// most -- "a role that reads cycle state reads it through the gate" -- was
// scoped further, to `src/agents/`. That scope was written when src/agents was
// where an agent's decision context came from. It is not: 1,392 of 1,397 role
// plans in cycle-g-v89 were built by the Rust follow-up path, and every record
// that enters a lane's context today -- the Chronicle decision digest, the
// instrument inventory, the research notes -- is assembled there.
//
// So the checker guarded the path that does not run, which is the failure it
// exists to prevent, one level up. These two walks put the other runtimes in
// scope for the invariants that are about a shape rather than about a JS API.
const ROOT = path.join(__dirname, "..");

function walkExt(dir, ext, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "target", "__pycache__", ".venv"].includes(entry.name)) continue;
      walkExt(full, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

const RUST_FILES = walkExt(path.join(ROOT, "native", "researchlab-harness", "src"), ".rs")
  .filter((file) => !/[\\/]tests?[\\/]/.test(file) && !/_tests?\.rs$/.test(file));
const PY_FILES = walkExt(path.join(ROOT, "drivers"), ".py");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function rel(file) {
  return path.relative(path.join(__dirname, ".."), file).replaceAll("\\", "/");
}

// ---------------------------------------------------------------- fail-closed

test("MBM: an absent score never defaults to a passing one", () => {
  // Observed: `Number(gateReview.score ?? gateReview.gate_score ?? 100) < 60`.
  // The comparison went false for an unscored gate, the director was never told
  // it had rejected, and no requery was raised. Absence became approval.
  const offenders = [];
  for (const file of FILES) {
    for (const match of read(file).matchAll(/(\w*[Ss]core\w*)\s*\?\?\s*(\d+)/g)) {
      if (Number(match[2]) >= 50) offenders.push(`${rel(file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "a missing score must fail closed, at 0");
});

test("MBM: the memory gate refuses what it cannot order", () => {
  // clockOf returns null when a node carries neither a sequence nor a
  // timestamp, and the edge is then unorderable and refused. If that ever
  // starts returning a number, unorderable records begin flowing.
  const gate = read(path.join(SRC, "provenance", "message_bound_gate.js"));
  assert.match(gate, /fail closed/i, "the fail-closed intent must stay stated");
  const { verifiedCausalClosure } = require("../src/provenance/message_bound_gate");
  // Refusing by throwing is refusing. What must never happen is a closure that
  // quietly admits a message it could not verify.
  let closure = null;
  let refused = false;
  try {
    closure = verifiedCausalClosure({
      activeId: "m1",
      lookupMessage: () => null,
      verifyEnvelope: () => true,
    });
  } catch (error) {
    refused = /missing|unverified|unorderable/i.test(String(error && error.message));
    assert.ok(refused, `the refusal must say why, got: ${error && error.message}`);
  }
  assert.ok(
    refused || closure == null || (closure instanceof Set && closure.size <= 1),
    "an unverifiable ancestry admits nothing",
  );
});

// ------------------------------------------------------------ provenance-bound

test("MBM: a score is recorded together with whether anything accounted for it", () => {
  // 1,478 entries at 85 or above carried no reasons, and nothing downstream
  // could tell them from scores that did. The history writer records the
  // distinction per rubric so a later reader can refuse an unaccounted peak.
  const { recordReviewSnapshot, peakVersusCurrent } = require("../src/reporting/review_history");
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mbm-prov-"));
  const cycleId = "cg-mbm-0001";
  const mk = (score, reasons) => ({
    score,
    rubric: [{ name: "novelty", score, reasons }],
    current_hypothesis_identity: { hypothesis_id: "hyp:a" },
  });
  recordReviewSnapshot({ root, cycleId, kind: "gate-review", review: mk(99, []) });
  recordReviewSnapshot({ root, cycleId, kind: "gate-review", review: mk(41, ["named prior art"]) });
  const report = peakVersusCurrent({ root, cycleId, kind: "gate-review" });
  assert.equal(
    report.peaks.novelty.score,
    41,
    "an unaccounted 99 is on the record but is not the bar",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ audit log

test("MBM: every review that overwrites itself records its trajectory first", () => {
  // A review is written to one path and rewritten on every refresh. Without an
  // append beside it, the only record of a previous score is whatever a later
  // pass has not yet replaced -- which is why ten days of scores were gone.
  const offenders = [];
  for (const file of FILES) {
    const text = read(file);
    if (!text.includes("writeJson(reviewPath, review)")) continue;
    if (!text.includes("recordReviewSnapshot")) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], "a review writer must append its history before overwriting");
});

test("MBM: the audit trail is appended, never rewritten", () => {
  // An audit log that can be truncated is not an audit log. The history writer
  // must reach its file with appendFileSync and nothing else.
  // Strip comments first: the first version of this check matched the writer's
  // own sentence promising never to truncate.
  const code = (file) => read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const history = code(path.join(SRC, "reporting", "review_history.js"));
  assert.ok(history.includes("appendFileSync"), "history is written by appending");
  assert.ok(
    !/writeFileSync|truncateSync|rmSync|unlinkSync/.test(history),
    "nothing in the history writer may overwrite, truncate or remove",
  );
  const gate = code(path.join(SRC, "agents", "shared", "memory_gate.js"));
  assert.ok(
    gate.includes("appendFileSync") && !/writeFileSync/.test(gate),
    "the memory gate's allow/deny log is append-only too",
  );
});

test("MBM: an audit sample stays small enough to keep", () => {
  // The ledger this replaces averages 600 KB per entry and reached 4.1 GB, at
  // which size no agent can open it and the record stops being usable.
  const { recordReviewSnapshot, historyPath } = require("../src/reporting/review_history");
  const os = require("os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mbm-size-"));
  const cycleId = "cg-mbm-0002";
  recordReviewSnapshot({
    root,
    cycleId,
    kind: "gate-review",
    review: {
      score: 90,
      blockers: ["a", "b", "c"],
      current_hypothesis_identity: { hypothesis_id: "hyp:a" },
      rubric: ["novelty", "technical_quality", "reproducibility", "clarity", "impact"]
        .map((name) => ({ name, score: 90, reasons: ["measured"] })),
    },
  });
  assert.ok(fs.statSync(historyPath(root, cycleId, "gate-review")).size < 2048);
  fs.rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------- applied, not merely built

test("MBM: a role that reads cycle state reads it through the gate", () => {
  // The reference monitor and its adapter existed for months with exactly ONE
  // consumer, and every failure the 2026-09-10 audit found sat somewhere the
  // gate does not reach. A read that reaches an agent's context without passing
  // it is the shape of that gap, so it is named here rather than remembered.
  //
  // A path handed to an agent as a string is not a read; only a load is.
  const READS = /readJson\(|readJsonIfExists\(|JSON\.parse\(fs\.readFileSync\(/;
  const GATED = /cycleStateReader|admitRecord|admit\.path\(|admit\(/;
  // Scope: where a record enters an AGENT's decision context. The reporting and
  // orchestration layers read the same files to BUILD them -- a watchdog
  // counting lanes is the system reading its own state, not a record being
  // admitted to a decision, and gating it would buy denial risk and no safety.
  // MBM-Core governs admission into an active decision; that is src/agents.
  const offenders = [];
  for (const file of FILES) {
    const name = rel(file);
    if (!name.startsWith("src/agents/")) continue;
    // The gate itself, its adapter and its reader cannot use themselves.
    if (/provenance\/message_bound_gate|shared\/memory_gate|shared\/gated_state/.test(name)) continue;
    const text = read(file);
    // Only files that pull a CYCLE-SCOPED state record into context.
    if (!/state["'\`\s,]*,?\s*`\$\{cycleId\}-/.test(text)) continue;
    if (!READS.test(text)) continue;
    if (!GATED.test(text)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "these read cycle state into context without the memory gate",
  );
});

// ------------------------------------------------- provenance is not self-reported

test("MBM: causal ancestry is recomputed, not read off the record", () => {
  // "recomputed from the event/lane graph, never trusted from a record's own
  // field" -- a record that simply claims to be authorized must not be.
  const { evaluateMemoryGate } = require("../src/provenance/message_bound_gate");
  const active = { id: "m2", cycle_id: "cg-1", run_id: "cg-1", task_scope: "gate" };
  const liar = {
    id: "m9",
    cycle_id: "cg-OTHER",
    run_id: "cg-OTHER",
    authorized: true,
    admitted: true,
    causal_ancestor: true,
  };
  // Two gates, two shapes: the reference monitor answers {decision, reason},
  // the harness adapter answers {admitted, checks, denial_reasons}. Both must
  // refuse, and both must say why.
  const verdict = evaluateMemoryGate(liar, active);
  assert.equal(verdict.decision, "deny",
    "a record from another run cannot admit itself by asserting that it is admitted");
  assert.equal(verdict.reason, "run_id_mismatch", "and the refusal carries a reason code");

  const { evaluateMemoryGate: adapterGate } = require("../src/agents/shared/memory_gate");
  const adapted = adapterGate(liar, active);
  assert.equal(adapted.admitted, false, "the harness adapter refuses it too");
  assert.equal(adapted.checks.same_run, false);
  assert.ok(adapted.denial_reasons.some((r) => r.includes("run_id_mismatch")));
});


// ------------------------------------------- the same shapes, the other runtimes

test("MBM: an absent score never defaults to a passing one, in any runtime", () => {
  // The JS form of this is checked above. The shape is not about a language:
  // absence read as satisfaction is the failure, and Rust and Python can write
  // it just as easily -- `.unwrap_or(100)` and `.get("score", 100)` say exactly
  // what `?? 100` said.
  const offenders = [];
  for (const file of RUST_FILES) {
    for (const match of read(file).matchAll(/\w*score\w*[^;\n]{0,80}?unwrap_or\((\d+)(?:\.0)?\)/gi)) {
      if (Number(match[1]) >= 50) offenders.push(`${rel(file)}: ${match[0].slice(0, 90)}`);
    }
  }
  // Only a DEFAULT FOR AN ABSENT VALUE, which is the failure. A first pass also
  // matched plain assignment and produced thirteen false positives: scores
  // computed from measured booleans that fail CLOSED when unmeasured
  // (`95.0 if method_rigorous else 40.0`) and a file-ranking heuristic derived
  // from a row count. An invariant that cannot state its shape precisely becomes
  // noise, and noise is what gets deleted.
  for (const file of PY_FILES) {
    const text = read(file);
    const defaults = [
      /\w*score\w*[^\n]{0,60}?\.get\(\s*[^),]+,\s*(\d+)\s*\)/gi,
      /getattr\([^),]+,\s*["'`]\w*score\w*["'`]\s*,\s*(\d+)\s*\)/gi,
      /\w*score\w*\s+or\s+(\d+)\b/gi,
    ];
    for (const pattern of defaults) {
      for (const match of text.matchAll(pattern)) {
        if (Number(match[1]) >= 50) offenders.push(`${rel(file)}: ${match[0].slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a missing score must fail closed, at 0, in every runtime");
});

test("MBM: a record that binds a decision is recomputed at delivery, not carried", () => {
  // "recomputed from the event/lane graph, never trusted from a record's own
  // field." The invariant above applies that to causal ancestry. It is the same
  // rule for every record admitted into an active decision, and until
  // 2026-09-13 nothing applied it to the ones that actually matter.
  //
  // MEASURED ON cycle-g-v91. Both writers of `chronicle_decision_digest` set it
  // only when the key was ABSENT -- one plain assignment when the plan is first
  // written, one `or_insert_with` in the impact mandate -- and the launch
  // refresh, whose whole job is bringing a lane's context up to date, refreshed
  // the research notes, the runner context and the dataset bundles and not the
  // digest. followup-lab-director-17 was queued at 08:10 when no digest existed,
  // the corpus became citable at 08:36, its plan was rewritten at 08:38, and it
  // still carried the 08:10 record. The director was told to decide from the
  // digest, forbidden to go around it, and handed the one from before the
  // evidence arrived -- then reported an empty survey, correctly.
  //
  // A record carried because its key exists is a record trusted from its own
  // field. These are the inputs a lane's decision is bound to, so each must be
  // ASSIGNED by the pre-launch refresh rather than filled in only when missing.
  const refresh = read(
    path.join(ROOT, "native", "researchlab-harness", "src", "labdirector",
      "research_context", "role_plan_refresh", "role_plan_refresh_01.rs"),
  );
  const DECISION_BINDING = ["chronicle_decision_digest", "instrument_inventory"];
  const carried = [];
  for (const key of DECISION_BINDING) {
    const assigns = new RegExp(`planner_metadata\\["${key}"\\]\\s*=`).test(refresh);
    if (!assigns) carried.push(key);
  }
  assert.deepEqual(
    carried,
    [],
    "these bind a lane's decision and are not recomputed when the lane launches",
  );
  // And the refresh must reach the roles that decide. A refresh that skips the
  // deciding role is the same staleness with an extra step.
  assert.match(
    refresh,
    /"lab-director"\s*\|\s*"chronicle"\s*\|\s*"analyst"\s*\|\s*"lab-runner"\s*\|\s*"gatekeeper"/,
    "the launch refresh no longer covers the roles whose context binds a decision",
  );
});
