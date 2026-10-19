"use strict";

// Comprehensive verification harness for the ACM-CP hypothesis-progress coupling.
// Goes beyond the unit tests: it runs the paper's C4-vs-C5 contrast, computes the
// coupling-layer metrics, proves the binding-rubric trajectory is monotonic under
// the guard, and runs adversarial negative cases. Deterministic, no container.
//
// Run: node tests/hypothesis_progress_verify.js   (exit 0 iff every claim holds)

const assert = require("assert");
const H = require("../src/reporting/hypothesis_progress");

const CYCLE = "verify-cycle";
const results = [];
function claim(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

function mkRecord(round, lane, statement, scores, verdict = "challenge", gatePassed = false) {
  const rubric = Object.entries(scores).map(([name, score]) => ({ name, score, applicable: true }));
  return H.buildProgressRecord({
    cycleId: CYCLE,
    round,
    reviewLaneId: lane,
    statement,
    rubric,
    verdict,
    gatePassed,
    now: `t${round}`,
    eventId: `evt-${round}`,
  });
}

// ---------------------------------------------------------------------------
// Simulate a research loop over ROUNDS. Each round the environment offers:
//   * REFINE the current lead  -> its binding (lowest) rubric rises by +STEP
//   * PIVOT to a fresh "safe"  -> a flat hypothesis (composite ~SAFE, never rises)
// A policy decides refine-vs-pivot. We record every reviewed round to a progress
// log and then measure convergence + suppression under two policies.
// ---------------------------------------------------------------------------
const ROUNDS = 14;
const STEP = 12; // binding-rubric gain per refine round (enough to cross the gate)
const GATE = 90;

const minRubric = (lead) => Math.min(lead.novelty, lead.technical_quality, lead.reproducibility);

function runLoop(policy) {
  // lead state: an "aniso" hypothesis whose weakest rubric starts low and can be
  // raised. Its weakest rubric is still BELOW the gate, so the lead is genuinely
  // improvable — dropping it would suppress recoverable progress.
  let lead = { statement: "H_aniso", novelty: 82, technical_quality: 45, reproducibility: 55 };
  const log = [];
  let suppressions = 0; // times an IMPROVABLE lead was dropped (critical-memory suppression)
  let converged = false;
  let round = 0;
  for (let i = 0; i < ROUNDS; i++) {
    round += 1;
    // The reviewer scores the CURRENT lead this round.
    const rec = mkRecord(round, `gk-${round}`, lead.statement, {
      novelty: lead.novelty,
      technical_quality: lead.technical_quality,
      reproducibility: lead.reproducibility,
    });
    log.push(rec);

    // The lead is certified once its weakest rubric clears the gate — natural end.
    if (minRubric(lead) >= GATE) {
      converged = true;
      break;
    }

    const safeComposite = 60; // tempting flat/mediocre alternative
    const improvable = minRubric(lead) < GATE; // the lead can still be refined

    let pivot;
    if (policy === "C4_uncoupled") {
      // No memory of best-so-far: pivots to anything "fresh" while not yet passing
      // (the observed thrash) — suppressing accumulated progress every round.
      pivot = H.compositeScore(rec.content.rubric.map((r) => ({ ...r }))) < GATE;
    } else {
      // C5 coupled: consult the anti-suppression guard on the append-only log.
      const decision = H.evaluateLeadSupersession({
        records: log,
        cycleId: CYCLE,
        proposedComposite: safeComposite,
      });
      pivot = decision.decision !== "deny";
    }

    if (pivot) {
      if (improvable) suppressions += 1; // dropped a still-improvable lead
      // Each thrash pivot is a genuinely DIFFERENT hypothesis (distinct content
      // tokens), so it gets a distinct key under the token-set signature.
      lead = { statement: `distinctpivot${round} unrelated topic ${round}`, novelty: 55, technical_quality: 60, reproducibility: 60 };
    } else {
      const b = H.bindingRubric(rec.content.rubric);
      lead = { ...lead };
      lead[b.name] = Math.min(100, b.score + STEP);
    }
  }
  return { log, suppressions, converged, rounds: round };
}

// --- Claim 1: C4 vs C5 contrast (the paper's key expected test) --------------
claim("C1: coupled (C5) preserves the improving lead; uncoupled (C4) suppresses it", () => {
  const c5 = runLoop("C5_coupled");
  const c4 = runLoop("C4_uncoupled");
  // C5 never suppresses an improvable lead, and it CONVERGES (lead crosses gate).
  assert.strictEqual(c5.suppressions, 0, `C5 suppressions should be 0, got ${c5.suppressions}`);
  assert.strictEqual(c5.converged, true, "C5 must converge (retained lead crosses the gate)");
  // C4 repeatedly suppresses (thrash) and never converges.
  assert.ok(c4.suppressions >= 3, `C4 should thrash (>=3 suppressions), got ${c4.suppressions}`);
  assert.strictEqual(c4.converged, false, "C4 must NOT converge (it keeps abandoning progress)");
});

// --- Claim 2: binding-rubric trajectory is MONOTONIC under the guard ---------
claim("C2: under coupling the lead's binding-rubric trajectory is monotonic non-decreasing", () => {
  const c5 = runLoop("C5_coupled");
  const recon = H.reconstructLead(c5.log, CYCLE);
  const traj = recon.chain.map((c) => c.binding_rubric.score);
  for (let i = 1; i < traj.length; i++) {
    assert.ok(traj[i] >= traj[i - 1], `trajectory dipped at round ${i}: ${traj}`);
  }
  // and it genuinely progressed (not flat)
  assert.ok(traj[traj.length - 1] > traj[0], `trajectory did not progress: ${traj}`);
});

// --- Claim 3: coupling-layer metrics (mirror the paper) ----------------------
claim("C3: metrics — suppression_rate=0, reconstructable=100%, lead_persistence up vs baseline", () => {
  const c5 = runLoop("C5_coupled");
  const c4 = runLoop("C4_uncoupled");
  const suppressionRate = (log, n) => n / log.length;
  assert.strictEqual(suppressionRate(c5.log, c5.suppressions), 0, "C5 suppression_rate must be 0");
  assert.ok(suppressionRate(c4.log, c4.suppressions) > 0, "C4 suppression_rate must be > 0");
  // reconstructability: current lead is fully replayable with provenance on every round
  const recon = H.reconstructLead(c5.log, CYCLE);
  assert.ok(recon.chain.every((c) => c.source_message_id && c.audit_hash), "every round has provenance + hash");
  // lead_persistence: rounds the SAME lead was refined before any pivot
  const persistence = (log) => {
    const roll = H.rollupByHypothesis(log, CYCLE);
    return Math.max(...[...roll.values()].map((r) => r.rounds));
  };
  assert.ok(persistence(c5.log) > persistence(c4.log), "C5 lead persistence should exceed C4");
});

// --- Claim 4: adversarial / negative (fail-closed integrity + provenance) ----
claim("C4a: tampered progress record is denied on read (integrity)", () => {
  const r = mkRecord(1, "gk-1", "H", { novelty: 30, technical_quality: 60 });
  assert.strictEqual(H.admitProgressRecord(r, CYCLE), true);
  const t = JSON.parse(JSON.stringify(r));
  t.content.rubric[0].score = 99; // inflate without re-hashing
  assert.strictEqual(H.admitProgressRecord(t, CYCLE), false, "tamper must be denied");
});
claim("C4b: wrong-run and missing-provenance records are denied (fail-closed)", () => {
  const r = mkRecord(1, "gk-1", "H", { novelty: 30 });
  assert.strictEqual(H.admitProgressRecord(r, "other-run"), false, "wrong-run denied");
  const noProv = mkRecord(1, null, "H", { novelty: 30 });
  assert.strictEqual(H.admitProgressRecord(noProv, CYCLE), false, "no-provenance denied");
});

// --- Claim 5: anti-lock — a genuinely stalled lead CAN be pivoted -----------
claim("C5-antilock: a stalled lead is not locked forever (pivot permitted after stall)", () => {
  // Genuinely flat on BOTH axes for more than the stall window (no new high) —
  // must be judged stalled and pivotable.
  const log = [1, 2, 3, 4, 5].map((r) =>
    mkRecord(r, `gk-${r}`, "H_stuck", { novelty: 30, technical_quality: 40 }),
  );
  const d = H.evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 35 });
  assert.strictEqual(d.decision, "allow", "stalled lead must be pivotable");
  assert.match(d.reason, /stalled/);
});

// --- Claim 6: a strictly-better candidate is promoted (not over-locked) ------
claim("C6-promotion: a strictly-better candidate legitimately takes the lead", () => {
  const log = [mkRecord(1, "gk-1", "H_a", { novelty: 58, technical_quality: 50 })];
  const d = H.evaluateLeadSupersession({
    records: log,
    cycleId: CYCLE,
    proposedComposite: 85,
    // per-rubric better: its weakest (80) beats the lead's weakest (50)
    proposedRubric: [{ name: "novelty", score: 88 }, { name: "technical_quality", score: 80 }],
    proposedHypothesisKey: "a-different-and-better-hypothesis",
  });
  assert.strictEqual(d.decision, "allow");
  assert.match(d.reason, /improves_lead/);
});

// --- Claim 7 (REGRESSION, adversarial): improving lead with FLAT binding but ---
// --- climbing composite must NOT be ruled stalled / must NOT be suppressed -----
claim("C7-regression: lead with flat binding rubric but climbing composite is protected", () => {
  // novelty (lowest) is flat at 65 across all rounds; the other rubrics climb, so
  // composite rises 66.5 -> 78 -> 89. This must be treated as PROGRESS, not stall.
  const log = [
    mkRecord(1, "gk-1", "H_climb", { novelty: 65, technical_quality: 60, reproducibility: 75 }),
    mkRecord(2, "gk-2", "H_climb", { novelty: 65, technical_quality: 83, reproducibility: 86 }),
    mkRecord(3, "gk-3", "H_climb", { novelty: 65, technical_quality: 99, reproducibility: 100 }),
  ];
  const lead = H.bestSoFarLead(log, CYCLE);
  assert.strictEqual(H.leadIsStalled(lead), false, "climbing-composite lead must NOT be stalled");
  const d = H.evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 55 });
  assert.strictEqual(d.decision, "deny", "still-improving lead must be protected (not dropped for a worse alt)");
});

// --- Claim 8 (REGRESSION, adversarial): hashless record fails closed on read ---
claim("C8-regression: a record with NO audit_hash is denied (integrity fail-closed)", () => {
  const good = mkRecord(1, "gk-1", "H", { novelty: 60, technical_quality: 62 });
  assert.strictEqual(H.admitProgressRecord(good, CYCLE), true, "valid hashed record admitted");
  const hashless = JSON.parse(JSON.stringify(good));
  delete hashless.audit_hash;
  assert.strictEqual(H.admitProgressRecord(hashless, CYCLE), false, "hashless record must be denied");
  // and an injected hashless low-score history must NOT poison stall detection
  const legit = [
    mkRecord(1, "gk-1", "H_good", { novelty: 53, technical_quality: 70 }),
    mkRecord(2, "gk-2", "H_good", { novelty: 56, technical_quality: 74 }),
    mkRecord(3, "gk-3", "H_good", { novelty: 59, technical_quality: 78 }),
  ];
  const poison = [1, 2, 3].map((r) => {
    const x = mkRecord(r + 3, `atk-${r}`, "H_good", { novelty: 5, technical_quality: 5 });
    delete x.audit_hash; // attacker omits the hash
    return x;
  });
  const before = H.evaluateLeadSupersession({ records: legit, cycleId: CYCLE, proposedComposite: 40 });
  const after = H.evaluateLeadSupersession({ records: [...legit, ...poison], cycleId: CYCLE, proposedComposite: 40 });
  assert.strictEqual(before.decision, "deny", "improving lead protected before injection");
  assert.strictEqual(after.decision, "deny", "hashless injection must NOT flip the guard to allow (poison rejected)");
});

// --- Claim 9 (REGRESSION): status is inside the integrity hash --------------
claim("C9-regression: flipping status to 'superseded'/'banked' invalidates the hash (denied)", () => {
  const r = mkRecord(1, "gk-1", "H", { novelty: 70, technical_quality: 72 });
  for (const bad of ["superseded", "banked", "active-tampered"]) {
    const t = JSON.parse(JSON.stringify(r));
    t.status = bad; // flip status WITHOUT recomputing the hash
    assert.strictEqual(H.admitProgressRecord(t, CYCLE), false, `status flip to ${bad} must be denied`);
  }
  // and a status-flip cannot drop the improving best-so-far lead
  const legit = [1, 2, 3].map((i) => mkRecord(i, `gk-${i}`, "H_lead", { novelty: 50 + i * 6, technical_quality: 60 + i * 6 }));
  const attack = legit.map((x, i) => (i === 2 ? Object.assign(JSON.parse(JSON.stringify(x)), { status: "superseded" }) : x));
  assert.ok(H.bestSoFarLead(attack, CYCLE), "lead survives a status-flip attack (tampered record denied)");
});

// --- Claim 10 (REGRESSION): freshness — revoked/redacted/expired denied -----
claim("C10-regression: revoked/redacted/expired records are denied on read (freshness)", () => {
  for (const st of ["revoked", "redacted", "expired", "bogus"]) {
    const r = mkRecord(1, "gk-1", "H", { novelty: 60 });
    r.status = st;
    r.audit_hash = H.recordHash(r); // even with a VALID hash for that status
    assert.strictEqual(H.admitProgressRecord(r, CYCLE), false, `status ${st} must be denied by freshness`);
  }
});

// --- Claim 11 (REGRESSION): shared-accession does NOT conflate hypotheses ----
claim("C11-regression: distinct statements under a shared familyRoot get distinct lead memories", () => {
  const k1 = H.hypothesisKey({ familyRoot: "ACC-123", statement: "adaptive tile sampling reduces variance" });
  const k2 = H.hypothesisKey({ familyRoot: "ACC-123", statement: "neural denoiser improves specular highlights" });
  assert.notStrictEqual(k1, k2, "distinct statements must not merge under a shared accession");
  const k1b = H.hypothesisKey({ familyRoot: "ACC-123", statement: "adaptive tile sampling reduces variance" });
  assert.strictEqual(k1, k1b, "same statement+family is stable (history accrues)");
});

// --- Claim 12 (REGRESSION): saw-tooth / dip-recover stall classification -----
claim("C12-regression: saw-tooth (no new high) is stalled; dip-then-new-high is protected", () => {
  // saw-tooth that never sets a new high -> stalled (pivotable)
  const saw = [50, 60, 50, 60, 50, 60].map((s, i) =>
    mkRecord(i + 1, `gk-${i}`, "H_saw", { novelty: s, technical_quality: s }),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(saw, CYCLE)), true, "saw-tooth with no new high is stalled");
  // dip then a genuine NEW high -> still progressing (protected)
  const recover = [40, 55, 20, 70].map((s, i) =>
    mkRecord(i + 1, `gk-${i}`, "H_rec", { novelty: s, technical_quality: s }),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(recover, CYCLE)), false, "a new high after a dip is progress, not stall");
});

// --- Claim 13 (REGRESSION, CRITICAL): the lead improving ITS OWN composite ---
// --- must NOT trip the different-candidate promotion branch (self-defeat) -----
claim("C13-regression: a lead improving its own composite is PROTECTED, not promoted-away (identity-aware)", () => {
  // Mirror the production input: the guard sees the PRIOR log for ONE lead, and is
  // asked with proposedComposite = that SAME lead's improved composite this round
  // + proposedHypothesisKey = that SAME lead's key. It must DENY (protect), never
  // 'allow / candidate_strictly_improves_lead' against itself.
  const key = H.hypothesisKey({ statement: "H_self", familyRoot: null });
  const prior = [1, 2].map((r) => mkRecord(r, `gk-${r}`, "H_self", { novelty: 60, technical_quality: 55 + r * 4 }));
  const nextComposite = 80; // the lead's OWN next-round composite (higher)
  const d = H.evaluateLeadSupersession({
    records: prior,
    cycleId: CYCLE,
    proposedComposite: nextComposite,
    proposedHypothesisKey: key,
  });
  assert.strictEqual(d.decision, "deny", "self-improvement must be protected (deny), not promoted away");
  assert.notStrictEqual(d.reason, "candidate_strictly_improves_lead", "must NOT fire the different-candidate branch");
  // a genuinely DIFFERENT better candidate (per-rubric better too) still promotes:
  const d2 = H.evaluateLeadSupersession({
    records: prior,
    cycleId: CYCLE,
    proposedComposite: 95,
    proposedRubric: [{ name: "novelty", score: 95 }, { name: "technical_quality", score: 92 }],
    proposedHypothesisKey: "some-other-hypothesis",
    proposedStatement: "a genuinely different and stronger hypothesis",
  });
  assert.strictEqual(d2.decision, "allow", "a different strictly-better candidate still promotes");
  assert.match(d2.reason, /improves_lead/);
});

// --- Claim 14 (REGRESSION): replayed / double-appended record counted once ---
claim("C14-regression: replayed/duplicate rounds do not inflate round counts or poison stall", () => {
  const r1 = mkRecord(1, "gk-1", "H_dup", { novelty: 40, technical_quality: 40 });
  const r2 = mkRecord(2, "gk-2", "H_dup", { novelty: 40, technical_quality: 40 });
  const r3 = mkRecord(3, "gk-3", "H_dup", { novelty: 40, technical_quality: 40 });
  // append every record 3x (refresh-pass double/triple write + a replay)
  const log = [r1, r1, r1, r2, r2, r3, r3, r3];
  const roll = H.rollupByHypothesis(log, CYCLE);
  const lead = [...roll.values()][0];
  assert.strictEqual(lead.rounds, 3, `duplicates must dedupe to 3 rounds, got ${lead.rounds}`);
});

// --- Claim 15 (REGRESSION): out-of-range scores are clamped to [0,100] -------
claim("C15-regression: unclamped/negative/NaN scores are clamped so composite stays bounded", () => {
  const r = mkRecord(1, "gk-1", "H", { novelty: 1e9, technical_quality: -50, reproducibility: NaN });
  assert.ok(r.content.composite >= 0 && r.content.composite <= 100, `composite must be in [0,100], got ${r.content.composite}`);
  for (const it of r.content.rubric) assert.ok(it.score >= 0 && it.score <= 100, `${it.name} clamped`);
});

// --- Claim 16 (REGRESSION): guard decisions are reconstructable from the graph -
claim("C16-regression: decision events are tamper-evident and reconstructable, not rollup-polluting", () => {
  const rounds = [1, 2].map((r) => mkRecord(r, `gk-${r}`, "H", { novelty: 60, technical_quality: 60 }));
  // A GENUINE decision event is signed with its own decision audit_hash (exactly
  // what appendDecisionEvent writes). event_type is INSIDE that hash envelope.
  const decisionEvt = { schema: "acmcp.hypothesis_progress.decision/1", event_type: H.DECISION_EVENT_TYPE, run_id: CYCLE, ts: "td", decision: { decision: "deny" } };
  decisionEvt.audit_hash = H.decisionHash(decisionEvt);
  const log = [...rounds, decisionEvt];
  // decision event must NOT be counted as a progress round
  const roll = H.rollupByHypothesis(log, CYCLE);
  assert.strictEqual([...roll.values()][0].rounds, 2, "decision event must not inflate rounds");
  // but it IS reconstructable from the graph
  const trail = H.readDecisionTrailFromRecords(log, CYCLE);
  assert.strictEqual(trail.length, 1, "decision trail is reconstructable");
  // A progress record with an INJECTED event_type (audit_hash is a PROGRESS hash,
  // not a decision hash) must NOT leak into the decision trail, and must NOT be
  // admitted as a progress round — the two categories stay disjoint.
  const poisoned = mkRecord(3, "gk-3", "H", { novelty: 60, technical_quality: 60 });
  poisoned.event_type = H.DECISION_EVENT_TYPE; // injected outside the hash envelope
  assert.strictEqual(H.admitProgressRecord(poisoned, CYCLE), false, "poisoned progress record denied on read");
  assert.strictEqual(H.readDecisionTrailFromRecords([poisoned], CYCLE).length, 0, "poisoned record does not leak into decision trail");
});

// --- Claim 17 (REGRESSION): a stable hypothesisId defeats paraphrase churn ---
claim("C17-regression: paraphrased rounds under one stable hypothesisId accrue to ONE lead", () => {
  const HID = "cg-v49-hyp-inverse-anisotropic-specular-mitsuba-001";
  const rewordings = [
    "anisotropic specular materials show larger inverse-rendering instability",
    "on anisotropic specular scenes, inverse rendering is significantly more unstable",
    "inverse rendering destabilizes more on anisotropic, specular material configurations",
  ];
  const log = rewordings.map((st, i) =>
    H.buildProgressRecord({
      cycleId: CYCLE,
      round: i + 1,
      reviewLaneId: `gk-${i + 1}`,
      hypothesisId: HID, // stable id threaded from the lab-director hypothesis file
      statement: st,
      rubric: [
        { name: "novelty", score: 60 + i * 5 },
        { name: "technical_quality", score: 55 + i * 6 },
      ],
      verdict: "challenge",
      now: `t${i}`,
      eventId: `evt-${i}`,
    }),
  );
  const roll = H.rollupByHypothesis(log, CYCLE);
  assert.strictEqual(roll.size, 1, `3 paraphrases must roll up to ONE lead, got ${roll.size}`);
  const recon = H.reconstructLead(log, CYCLE);
  assert.strictEqual(recon.chain.length, 3, "the full 3-round provenance chain is reconstructable");
});

// --- Claim 18 (REGRESSION): paraphrase on the NULL-id path accretes to one lead
claim("C18-regression: paraphrases (no stable id) share one key AND are not promoted-away", () => {
  const rewordings = [
    "anisotropic specular materials increase rendering instability",
    "rendering instability increases on anisotropic, specular materials",
    "on anisotropic specular material, rendering instability significantly increases",
  ];
  // No hypothesisId — must still collapse to ONE key via the token-set signature.
  const keys = rewordings.map((st) => H.hypothesisKey({ statement: st, familyRoot: null }));
  assert.strictEqual(new Set(keys).size, 1, `paraphrases must share one key, got ${new Set(keys).size}`);
  // And the guard must NOT treat a paraphrase of the lead as a different candidate:
  const log = rewordings.slice(0, 2).map((st, i) =>
    mkRecord(i + 1, `gk-${i + 1}`, st, { novelty: 60, technical_quality: 55 + i * 6 }),
  );
  const d = H.evaluateLeadSupersession({
    records: log,
    cycleId: CYCLE,
    proposedComposite: 90,
    proposedHypothesisKey: "hyp:some-reworded-key-that-differs",
    proposedStatement: rewordings[2], // a paraphrase of the same lead
  });
  assert.strictEqual(d.decision, "deny", "a paraphrase of the lead must be protected, not promoted-away");
});

// --- Claim 19 (REGRESSION): a lead whose BINDING blocker is stuck below the gate
// --- is pivotable even if its composite climbs on other rubrics (no false-lock) -
claim("C19-regression: composite climbing on non-binding rubrics does NOT false-lock an unpassable lead", () => {
  // binding rubric (novelty) frozen at 50 (< gate) for many rounds; other rubrics
  // climb so composite rises — but the gate-blocker is stuck, so it must be stalled.
  const log = [1, 2, 3, 4, 5].map((r) =>
    mkRecord(r, `gk-${r}`, "H_unpassable", { novelty: 50, technical_quality: 55 + r * 8, reproducibility: 55 + r * 8 }),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(log, CYCLE)), true, "binding stuck below gate => stalled (pivotable)");
  const d = H.evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 50 });
  assert.strictEqual(d.decision, "allow", "an unpassable (binding-stuck) lead must be pivotable");
});

// --- Claim 20 (REGRESSION): promotion is PER-RUBRIC, not mean-skew ----------
claim("C20-regression: a higher-mean candidate with a WORSE weakest rubric does NOT promote away the lead", () => {
  // lead: all rubrics ~78-82 (weakest 78). candidate: mean 85 but weakest 40.
  const log = [
    mkRecord(1, "gk-1", "H_lead", { novelty: 82, technical_quality: 78, reproducibility: 80 }),
    mkRecord(2, "gk-2", "H_lead", { novelty: 82, technical_quality: 78, reproducibility: 80 }),
  ];
  const d = H.evaluateLeadSupersession({
    records: log,
    cycleId: CYCLE,
    proposedComposite: 85, // higher MEAN
    proposedRubric: [{ name: "novelty", score: 100 }, { name: "technical_quality", score: 40 }, { name: "reproducibility", score: 100 }, { name: "clarity", score: 100 }], // weakest 40 << lead's 78
    proposedHypothesisKey: "different-but-lopsided",
    proposedStatement: "a completely different lopsided hypothesis",
  });
  assert.strictEqual(d.decision, "deny", "must NOT promote toward a candidate farther from the per-rubric gate");
});

// --- Claim 21 (REGRESSION): a +1 gain to a new all-time high is progress -----
claim("C21-regression: a genuine +1 improvement to a new high is NOT mis-read as stalled", () => {
  const climbTo71 = [60, 65, 70, 70, 70, 71].map((s, i) =>
    mkRecord(i + 1, `gk-${i}`, "H_climb1", { technical_quality: s, novelty: 90 }),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(climbTo71, CYCLE)), false, "+1 to a new high (71>70) is progress, not stall");
  const flat = [60, 65, 70, 70, 70, 70].map((s, i) =>
    mkRecord(i + 1, `gk-${i}`, "H_flat1", { technical_quality: s, novelty: 90 }),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(flat, CYCLE)), true, "a true plateau (no new high) is stalled");
});

// mkRecord variant that takes an explicit rubric array (for missing-lane / churn cases)
function mkRecordR(round, lane, statement, rubricArr) {
  return H.buildProgressRecord({
    cycleId: CYCLE, round, reviewLaneId: lane, statement, rubric: rubricArr,
    verdict: "challenge", now: `t${round}`, eventId: `evt-${round}`,
  });
}

// --- Claim 22 (REGRESSION): rubric-SET churn does not false-stall a climbing lead
claim("C22-regression: a lead improving on a newly-entered rubric is NOT falsely stalled by set churn", () => {
  // rounds 1-3: binding = technical_quality (40,46,52). rounds 4-6: reproducibility
  // ENTERS low and climbs (40,42,44) becoming the new binding. The mixed floor
  // history [40,46,52,40,42,44] looks non-monotonic, but the hypothesis improves
  // on every axis, so it must NOT be ruled stalled.
  const log = [
    mkRecordR(1, "gk-1", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 40 }]),
    mkRecordR(2, "gk-2", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 46 }]),
    mkRecordR(3, "gk-3", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 52 }]),
    mkRecordR(4, "gk-4", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 60 }, { name: "reproducibility", score: 40 }]),
    mkRecordR(5, "gk-5", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 62 }, { name: "reproducibility", score: 42 }]),
    mkRecordR(6, "gk-6", "H_churn", [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 64 }, { name: "reproducibility", score: 44 }]),
  ];
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(log, CYCLE)), false, "rubric-set churn must not false-stall an all-axes-improving lead");
});

// --- Claim 23 (REGRESSION): a transiently-missing gatekeeper lane (score-0
// --- placeholder) does NOT inject a phantom 0 that false-stalls the lead -------
claim("C23-regression: focused_review_missing score-0 placeholder is excluded from binding/stall", () => {
  // technical_quality climbs 50->90; but the reproducibility LANE is missing the
  // last 3 rounds, arriving as score:0 focused_review_missing:true. That phantom 0
  // must be excluded so binding stays on the climbing technical_quality (not 0).
  const log = [50, 60, 70, 80, 85, 90].map((tq, i) => {
    const rub = [{ name: "novelty", score: 92 }, { name: "technical_quality", score: tq }];
    if (i >= 3) rub.push({ name: "reproducibility", score: 0, focused_review_missing: true });
    return mkRecordR(i + 1, `gk-${i + 1}`, "H_missinglane", rub);
  });
  // the phantom 0 must not appear in the persisted rubric nor drive binding to 0
  const lead = H.bestSoFarLead(log, CYCLE);
  assert.ok(lead.binding_best_history.every((s) => s > 0), `no phantom-0 in binding history: ${lead.binding_best_history}`);
  assert.strictEqual(H.leadIsStalled(lead), false, "a climbing lead must not be stalled by a missing-lane 0");
});

// --- Claim 24 (REGRESSION): a HEAVY reword (below Jaccard 0.6) of the improving
// --- lead is still recognized as the same lead and protected (null-id path) ----
claim("C24-regression: a heavy reword keeping >=50% of the lead's tokens is protected, not promoted-away", () => {
  const leadStmt = "anisotropic specular inverse rendering gradient instability";
  const heavyReword = "anisotropic specular BRDF lobes drive inverse rendering convergence failure divergence"; // retains anisotropic/specular/inverse/rendering; Jaccard < 0.6
  assert.ok(H.statementSimilarity(leadStmt, heavyReword) < 0.6, "precondition: heavy reword is below the paraphrase Jaccard threshold");
  const log = [
    mkRecord(1, "gk-1", leadStmt, { novelty: 90, technical_quality: 48 }),
    mkRecord(2, "gk-2", leadStmt, { novelty: 90, technical_quality: 56 }),
    mkRecord(3, "gk-3", leadStmt, { novelty: 90, technical_quality: 63 }),
  ];
  const d = H.evaluateLeadSupersession({
    records: log,
    cycleId: CYCLE,
    proposedComposite: 80,
    proposedRubric: [{ name: "novelty", score: 90 }, { name: "technical_quality", score: 70 }],
    proposedHypothesisKey: H.hypothesisKey({ statement: heavyReword }), // a DIFFERENT key (reword churns it)
    proposedStatement: heavyReword,
  });
  assert.strictEqual(d.decision, "deny", "a heavy reword of the still-improving lead must be protected, not promoted-away");
});

// --- Claim 25 (REGRESSION): a fresh lowest-rubric NAME every round cannot infinite-
// --- lock a dead-flat unpassable lead (signal-2 short-series escape closed) -----
claim("C25-regression: fresh-name binding churn does NOT infinite-lock a dead-flat unpassable lead", () => {
  // floor dead-flat at 20; the lowest rubric has a fresh name every round.
  const names = ["technical_quality", "reproducibility", "clarity", "consort_reporting_completeness", "strobe_reporting_completeness"];
  const log = [1, 2, 3, 4, 5, 6].map((r) =>
    mkRecordR(r, `gk-${r}`, "H_deadflat", [{ name: "novelty", score: 90 }, { name: names[r % names.length], score: 20 }]),
  );
  assert.strictEqual(H.leadIsStalled(H.bestSoFarLead(log, CYCLE)), true, "a dead-flat lead must be stalled regardless of fresh binding names");
});

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verification claims passed.`);
if (failed.length) {
  console.log("FAILURES:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
console.log("VERIFICATION: ALL CLAIMS HOLD.");
