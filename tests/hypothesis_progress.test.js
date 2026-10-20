"use strict";

// Verification for the hypothesis-progress coupled memory (ACM-CP applied to the
// science loop). Mirrors the paper's "key expected test" shape: the same event
// graph is judged with and without the coupling guard, and only the coupled path
// preserves the critical memory (best-so-far lead) instead of suppressing it.
//
// Run: node tests/hypothesis_progress.test.js   (exit 0 = pass)

const assert = require("assert");
const {
  buildProgressRecord,
  recordHash,
  admitProgressRecord,
  bestSoFarLead,
  leadIsStalled,
  STALL_ROUNDS,
  evaluateLeadSupersession,
  reconstructLead,
  compositeScore,
  bindingRubric,
  DECISION_EVENT_TYPE,
  decisionHash,
} = require("../src/reporting/hypothesis_progress");

const CYCLE = "test-cycle-1";
let n = 0;
const pass = (name) => console.log(`  ok  ${++n} - ${name}`);

function rec({ round, lane, statement, scores, verdict, gatePassed }) {
  const rubric = Object.entries(scores).map(([name, score]) => ({ name, score, applicable: true }));
  return buildProgressRecord({
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

// ---- integrity + provenance gate (fail-closed) ------------------------------
{
  const r = rec({ round: 1, lane: "gk-1", statement: "H1", scores: { novelty: 30, technical_quality: 60 }, verdict: "challenge" });
  assert.strictEqual(admitProgressRecord(r, CYCLE), true, "clean record admitted");
  // tamper: mutate content without re-hashing => denied (M5 integrity)
  const tampered = JSON.parse(JSON.stringify(r));
  tampered.content.rubric[0].score = 95;
  assert.strictEqual(admitProgressRecord(tampered, CYCLE), false, "tampered record denied");
  // wrong run => denied
  assert.strictEqual(admitProgressRecord(r, "other-cycle"), false, "wrong-run record denied");
  // missing provenance => denied
  const noProv = rec({ round: 1, lane: null, statement: "H1", scores: { novelty: 30 }, verdict: "challenge" });
  assert.strictEqual(admitProgressRecord(noProv, CYCLE), false, "no-provenance record denied (fail-closed)");
  pass("read gate: integrity + run + provenance fail-closed");
}

// ---- composite + binding rubric (curriculum) --------------------------------
{
  const rubric = [
    { name: "novelty", score: 58 },
    { name: "technical_quality", score: 40 },
    { name: "reproducibility", score: 70 },
  ];
  assert.strictEqual(Math.round(compositeScore(rubric)), 56, "composite = mean");
  assert.deepStrictEqual(bindingRubric(rubric), { name: "technical_quality", score: 40 }, "binding = lowest");
  pass("composite mean + binding (lowest) rubric");
}

// ---- CRITICAL: best-so-far lead is preserved while still improving -----------
{
  // The 58-novelty lead (H_aniso) keeps improving its binding rubric across
  // rounds; a shiny new safe hypothesis (H_safe) shows up. WITHOUT the guard the
  // director would pivot to H_safe and suppress the improving lead. WITH the
  // guard, superseding the still-improving lead is DENIED (fail-closed).
  const log = [
    rec({ round: 1, lane: "gk-1", statement: "H_aniso", scores: { novelty: 58, technical_quality: 40, reproducibility: 50 }, verdict: "challenge" }),
    rec({ round: 2, lane: "gk-2", statement: "H_aniso", scores: { novelty: 58, technical_quality: 55, reproducibility: 58 }, verdict: "challenge" }),
    rec({ round: 3, lane: "gk-3", statement: "H_aniso", scores: { novelty: 58, technical_quality: 68, reproducibility: 66 }, verdict: "challenge" }),
  ];
  const lead = bestSoFarLead(log, CYCLE);
  assert.strictEqual(lead.memory_id.includes("H_aniso") || lead.statement === "H_aniso", true, "H_aniso is the lead");
  assert.strictEqual(leadIsStalled(log.length ? bestSoFarLead(log, CYCLE) : null), false, "lead not stalled (binding rubric rose 40->68)");

  const guarded = evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 45 });
  assert.strictEqual(guarded.decision, "deny", "pivot to a WORSE safe hypothesis is denied");
  assert.match(guarded.reason, /suppression_blocked/, "reason cites critical-memory suppression block");
  pass("anti-suppression: improving lead is NOT dropped for a worse pivot (C5 coupled behavior)");
}

// ---- a strictly better candidate is a legitimate promotion (not suppression),
// ---- but ONLY after the incumbent has had its fair validation window ----------
{
  // Incumbent has had a full stall-window of rounds (fair chance for its own
  // validation to land) — a strictly-better DIFFERENT candidate may now take over.
  const log = Array.from({ length: STALL_ROUNDS }, (_, i) =>
    rec({ round: i + 1, lane: `gk-${i + 1}`, statement: "H_aniso", scores: { novelty: 58, technical_quality: 50 }, verdict: "challenge" }),
  );
  const promote = evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 80, proposedRubric: [{ name: "novelty", score: 82 }, { name: "technical_quality", score: 78 }], proposedHypothesisKey: "different-better-hyp" });
  assert.strictEqual(promote.decision, "allow", "a strictly-better candidate is allowed after the incumbent's fair window");
  assert.match(promote.reason, /improves_lead/, "reason cites strict improvement");
  pass("promotion: strictly-better candidate allowed after fair window");
}

// ---- a strictly better candidate may NOT supersede a too-YOUNG incumbent ------
{
  // Same strictly-better candidate, but the incumbent has had only one round: it
  // must be protected so its own validation can land, not swapped out immediately
  // (the cycle-g-v60 soft-churn fix).
  const log = [
    rec({ round: 1, lane: "gk-1", statement: "H_aniso", scores: { novelty: 58, technical_quality: 50 }, verdict: "challenge" }),
  ];
  const guarded = evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 80, proposedRubric: [{ name: "novelty", score: 82 }, { name: "technical_quality", score: 78 }], proposedHypothesisKey: "different-better-hyp" });
  assert.strictEqual(guarded.decision, "deny", "a young incumbent is protected from strictly-better supersession");
  assert.match(guarded.reason, /still_improving/, "reason cites lead still improving");
  pass("protection: young incumbent not superseded before its fair window");
}

// ---- a genuinely STALLED lead may be pivoted (not infinite lock) -------------
{
  // Build enough flat rounds to exceed the stall window (window-relative so this
  // stays correct if STALL_ROUNDS is retuned; needs > STALL_ROUNDS rounds).
  const flatRounds = Array.from({ length: STALL_ROUNDS + 3 }, (_, i) => i + 1);
  const log = flatRounds.map((r) =>
    rec({ round: r, lane: `gk-${r}`, statement: "H_stuck", scores: { novelty: 30, technical_quality: 42 }, verdict: "challenge" }),
  );
  assert.strictEqual(leadIsStalled(bestSoFarLead(log, CYCLE)), true, "lead stalled (both axes flat beyond window)");
  const guarded = evaluateLeadSupersession({ records: log, cycleId: CYCLE, proposedComposite: 30 });
  assert.strictEqual(guarded.decision, "allow", "stalled lead may be pivoted away from");
  assert.match(guarded.reason, /stalled/, "reason cites stall");
  pass("anti-lock: a genuinely stalled lead can be pivoted");
}

// ---- reconstructability: replay explains the current lead -------------------
{
  const log = [
    rec({ round: 1, lane: "gk-1", statement: "H_aniso", scores: { novelty: 58, technical_quality: 40 }, verdict: "challenge" }),
    rec({ round: 2, lane: "gk-2", statement: "H_aniso", scores: { novelty: 58, technical_quality: 62 }, verdict: "challenge" }),
  ];
  const r = reconstructLead(log, CYCLE);
  assert.strictEqual(r.chain.length, 2, "chain has both rounds");
  assert.strictEqual(r.chain[0].source_message_id, "gk-1", "provenance preserved (round 1 lane)");
  assert.strictEqual(r.chain[1].binding_rubric.score, 58, "round 2 binding rubric is novelty=58 after tq rose to 62");
  assert.ok(r.best_composite >= 58 - 0.001, "best composite tracked");
  pass("reconstructability: replay yields the lead's provenance chain");
}

// ---- Level-2 exploit mode: budget pressure freezes ALL lead swaps -------------
{
  // A stalled lead AND a strictly-better candidate — both of which would be
  // allowed in explore mode — must BOTH be denied under an exploit policy: the
  // remaining budget consolidates the best lead instead of exploring.
  const flat = Array.from({ length: STALL_ROUNDS + 3 }, (_, i) =>
    rec({ round: i + 1, lane: `gk-${i + 1}`, statement: "H_stuck", scores: { novelty: 30, technical_quality: 42 }, verdict: "challenge" }),
  );
  const exploit = { mode: "exploit", reason: "gatekeeper_followups_140_of_192" };
  const stalledUnderExploit = evaluateLeadSupersession({ records: flat, cycleId: CYCLE, proposedComposite: 30, policy: exploit });
  assert.strictEqual(stalledUnderExploit.decision, "deny", "exploit mode denies even a stalled-lead pivot");
  assert.match(stalledUnderExploit.reason, /budget_exploitation/, "reason cites exploit mode");
  const betterUnderExploit = evaluateLeadSupersession({
    records: flat, cycleId: CYCLE, proposedComposite: 80,
    proposedRubric: [{ name: "novelty", score: 82 }, { name: "technical_quality", score: 78 }],
    proposedHypothesisKey: "different-better-hyp", policy: exploit,
  });
  assert.strictEqual(betterUnderExploit.decision, "deny", "exploit mode denies even a strictly-better candidate");
  // Explore (default/no policy) keeps the original behaviour on the same log.
  const stalledUnderExplore = evaluateLeadSupersession({ records: flat, cycleId: CYCLE, proposedComposite: 30 });
  assert.strictEqual(stalledUnderExplore.decision, "allow", "explore mode still permits a stalled pivot");
  pass("level-2: exploit policy freezes swaps; explore unchanged");
}

// ---- Level-2 policy file loader: fail-open to explore -------------------------
{
  const { readWatchdogPolicy } = require("../src/reporting/hypothesis_progress");
  assert.strictEqual(readWatchdogPolicy("/nonexistent/policy.json").mode, "explore", "missing file => explore");
  const os = require("os");
  const fsx = require("fs");
  const pathx = require("path");
  const tmp = pathx.join(os.tmpdir(), `wd-policy-test-${process.pid}.json`);
  fsx.writeFileSync(tmp, JSON.stringify({ mode: "exploit", exploit_reason: "test" }), "utf8");
  assert.strictEqual(readWatchdogPolicy(tmp).mode, "exploit", "exploit file => exploit");
  fsx.writeFileSync(tmp, "{not json", "utf8");
  assert.strictEqual(readWatchdogPolicy(tmp).mode, "explore", "torn/corrupt file => explore (fail-open)");
  fsx.unlinkSync(tmp);
  pass("level-2: policy loader fail-opens to explore");
}

// ---- Level-2 exploit mode: budget pressure freezes ALL lead swaps -------------
{
  // A stalled lead AND a strictly-better candidate — both of which would be
  // allowed in explore mode — must BOTH be denied under an exploit policy: the
  // remaining budget consolidates the best lead instead of exploring.
  const flat = Array.from({ length: STALL_ROUNDS + 3 }, (_, i) =>
    rec({ round: i + 1, lane: `gk-${i + 1}`, statement: "H_stuck", scores: { novelty: 30, technical_quality: 42 }, verdict: "challenge" }),
  );
  const exploit = { mode: "exploit", reason: "gatekeeper_followups_140_of_192" };
  const stalledUnderExploit = evaluateLeadSupersession({ records: flat, cycleId: CYCLE, proposedComposite: 30, policy: exploit });
  assert.strictEqual(stalledUnderExploit.decision, "deny", "exploit mode denies even a stalled-lead pivot");
  assert.match(stalledUnderExploit.reason, /budget_exploitation/, "reason cites exploit mode");
  const betterUnderExploit = evaluateLeadSupersession({
    records: flat, cycleId: CYCLE, proposedComposite: 80,
    proposedRubric: [{ name: "novelty", score: 82 }, { name: "technical_quality", score: 78 }],
    proposedHypothesisKey: "different-better-hyp", policy: exploit,
  });
  assert.strictEqual(betterUnderExploit.decision, "deny", "exploit mode denies even a strictly-better candidate");
  // Explore (default/no policy) keeps the original behaviour on the same log.
  const stalledUnderExplore = evaluateLeadSupersession({ records: flat, cycleId: CYCLE, proposedComposite: 30 });
  assert.strictEqual(stalledUnderExplore.decision, "allow", "explore mode still permits a stalled pivot");
  pass("level-2: exploit policy freezes swaps; explore unchanged");
}

// ---- Level-2 policy file loader: fail-open to explore -------------------------
{
  const { readWatchdogPolicy } = require("../src/reporting/hypothesis_progress");
  assert.strictEqual(readWatchdogPolicy("/nonexistent/policy.json").mode, "explore", "missing file => explore");
  const os = require("os");
  const fsx = require("fs");
  const pathx = require("path");
  const tmp = pathx.join(os.tmpdir(), `wd-policy-test-${process.pid}.json`);
  fsx.writeFileSync(tmp, JSON.stringify({ mode: "exploit", exploit_reason: "test" }), "utf8");
  assert.strictEqual(readWatchdogPolicy(tmp).mode, "exploit", "exploit file => exploit");
  fsx.writeFileSync(tmp, "{not json", "utf8");
  assert.strictEqual(readWatchdogPolicy(tmp).mode, "explore", "torn/corrupt file => explore (fail-open)");
  fsx.unlinkSync(tmp);
  pass("level-2: policy loader fail-opens to explore");
}


// ---- Stalled by absence: a lead nobody has scored in a long time -------------
// cycle-g-v75: hyp:f199ba08 was scored in rounds 1 and 2 and never again. At
// round 43 it still held the protection, because 2 <= STALL_ROUNDS read as "too
// early to judge" and its history could not grow while every review went to a
// different hypothesis. 141 denies; nine consecutive LabDirectors, each handed
// the protection text and the lead's own name, all chose `replace`.
{
  const records = [];
  for (const round of [1, 2]) {
    records.push(rec({
      round, lane: `gatekeeper-0${round}`, statement: "the abandoned lead",
      scores: { novelty: 40, technical_quality: 30, reproducibility: 20 }, verdict: "challenge",
    }));
  }
  for (let round = 3; round <= 43; round += 1) {
    records.push(rec({
      round, lane: `gatekeeper-${round}`, statement: `replacement hypothesis ${round}`,
      scores: { novelty: 30, technical_quality: 20, reproducibility: 10 }, verdict: "challenge",
    }));
  }

  const lead = bestSoFarLead(records, CYCLE);
  assert.ok(lead, "the early lead is still best-so-far");
  assert.strictEqual(lead.rounds, 2, "it was scored exactly twice");
  assert.strictEqual(lead.last_round_index, 2, "and not since round 2");

  // History length alone still reads as "too early" -- that is the trap.
  assert.strictEqual(leadIsStalled(lead, STALL_ROUNDS), false, "by history alone: not stalled");
  // Knowing the cycle has moved on, it is stalled by absence.
  assert.strictEqual(leadIsStalled(lead, STALL_ROUNDS, 1, 43), true, "41 rounds dormant => stalled");

  const decision = evaluateLeadSupersession({ records, cycleId: CYCLE, stallRounds: STALL_ROUNDS });
  assert.strictEqual(decision.decision, "allow", "a pivot away from a dormant lead is permitted");
  // Still `allow` - refusing would rebuild the 141-deny deadlock this case exists
  // to prevent. The reason is now the more specific one, because on cycle-g-v81 a
  // bare "permitted" was cashed 95 times while leads averaged 2.04 rounds: a lead
  // that was DROPPED rather than disproved must come back with the permission.
  assert.strictEqual(decision.reason, "best_lead_dormant_resume_before_replacing");
  assert.ok(decision.resume_lead, "the allow carries the abandoned lead back with it");
  assert.strictEqual(decision.resume_lead.memory_id, lead.memory_id);
  assert.strictEqual(decision.resume_lead.last_round_index, 2);
  pass("stalled by absence: a dormant lead stops blocking pivots, and is handed back");
}

// ---- A declined resume is an answer -------------------------------------------
// cycle-a-20260919, 2026-10-19: the dormant best lead's data were
// confirmed unobtainable; seven director lanes said so and chose another lead,
// and the guard put the same lead to the next director every time.
{
  const fsx = require("fs");
  const os = require("os");
  const pathx = require("path");
  const { directorResumeDeclines } = require("../src/reporting/hypothesis_progress");
  const records = [];
  for (const round of [1, 2]) {
    records.push(rec({
      round, lane: `gatekeeper-0${round}`, statement: "the abandoned lead",
      scores: { novelty: 40, technical_quality: 30, reproducibility: 20 }, verdict: "challenge",
    }));
  }
  for (let round = 3; round <= 43; round += 1) {
    records.push(rec({
      round, lane: `gatekeeper-${round}`, statement: `replacement hypothesis ${round}`,
      scores: { novelty: 30, technical_quality: 20, reproducibility: 10 }, verdict: "challenge",
    }));
  }
  const dormant = bestSoFarLead(records, CYCLE);

  const root = fsx.mkdtempSync(pathx.join(os.tmpdir(), "declines-"));
  const writeDirector = (laneId, answer) => {
    const dir = pathx.join(root, "lanes", CYCLE, laneId);
    fsx.mkdirSync(dir, { recursive: true });
    fsx.writeFileSync(pathx.join(dir, "result.json"), JSON.stringify({ extracted_json: { resume_lead_decision: answer } }));
  };
  // Too thin to be a reason; and a resume is not a decline.
  writeDirector("followup-lab-director-1", { lead_id: dormant.memory_id, decision: "decline", reason: "no", evidence_refs: [] });
  writeDirector("followup-lab-director-2", { lead_id: dormant.memory_id, decision: "resume", reason: "it needs the balanced panel rerun at r020 first", evidence_refs: [] });
  assert.strictEqual(directorResumeDeclines({ root, cycleId: CYCLE }).size, 0, "only a reasoned decline counts");
  writeDirector("followup-lab-director-3", {
    lead_id: dormant.memory_id.toUpperCase(), decision: "decline",
    reason: "its accession is confirmed unobtainable and the one bound run failed the preregistered balance gate",
    evidence_refs: ["followup-runner-526"],
  });
  const declines = directorResumeDeclines({ root, cycleId: CYCLE });
  assert.strictEqual(declines.size, 1);

  const before = evaluateLeadSupersession({ records, cycleId: CYCLE, stallRounds: STALL_ROUNDS });
  assert.strictEqual(before.reason, "best_lead_dormant_resume_before_replacing", "without the answer it is put again");
  const after = evaluateLeadSupersession({ records, cycleId: CYCLE, stallRounds: STALL_ROUNDS, declinedResumes: declines });
  assert.notStrictEqual(after.lead, dormant.memory_id, "the declined lead is no longer the one the guard protects");
  assert.ok(!after.resume_lead || after.resume_lead.memory_id !== dormant.memory_id, "and it is not put to the director again");
  // Selected again, it is the current lead and protected like any other.
  const reselected = evaluateLeadSupersession({
    records, cycleId: CYCLE, stallRounds: STALL_ROUNDS, declinedResumes: declines, currentLeadKey: dormant.memory_id,
  });
  assert.strictEqual(reselected.lead, dormant.memory_id);
  pass("a reasoned decline to resume the strongest lead is recorded and not asked again");
}

// ---- ...unless the ledger already recorded that it was falsified -------------
// cycle-g-v91: hyp:4fafb0af6dd99ba4 was released 31 times by
// lead_falsified_by_completed_run, went dormant when the cycle moved to a new
// method, and was then handed back 96 times as "abandoned, not disproved".
{
  const scored = [];
  for (const round of [1, 2]) {
    scored.push(rec({
      round, lane: `gatekeeper-0${round}`, statement: "the falsified lead",
      scores: { novelty: 40, technical_quality: 30, reproducibility: 20 }, verdict: "challenge",
    }));
  }
  for (let round = 3; round <= 43; round += 1) {
    scored.push(rec({
      round, lane: `gatekeeper-${round}`, statement: `replacement hypothesis ${round}`,
      scores: { novelty: 30, technical_quality: 20, reproducibility: 10 }, verdict: "challenge",
    }));
  }
  const falsifiedId = bestSoFarLead(scored, CYCLE).memory_id;
  const release = (lead) => {
    const event = {
      schema: "acmcp.hypothesis_progress.decision/1",
      event_type: DECISION_EVENT_TYPE,
      run_id: CYCLE,
      ts: "t2-release",
      decision: { decision: "allow", reason: "lead_falsified_by_completed_run", lead },
    };
    event.audit_hash = decisionHash(event);
    return event;
  };

  const decision = evaluateLeadSupersession({
    records: [...scored, release(falsifiedId)], cycleId: CYCLE, stallRounds: STALL_ROUNDS,
  });
  assert.strictEqual(decision.decision, "allow", "the pivot is still permitted");
  assert.strictEqual(decision.reason, "best_lead_falsified_pivot_permitted");
  assert.strictEqual(decision.resume_lead, undefined, "a falsified lead is not handed back");
  assert.strictEqual(decision.falsification_releases, 1);
  assert.strictEqual(decision.falsified_at, "t2-release");

  // A release naming a different lead, or a forged one, changes nothing.
  const other = evaluateLeadSupersession({
    records: [...scored, release("hyp:a-different-lead")], cycleId: CYCLE, stallRounds: STALL_ROUNDS,
  });
  assert.strictEqual(other.reason, "best_lead_dormant_resume_before_replacing");
  const forged = release(falsifiedId);
  forged.audit_hash = "sha256:forged";
  const forgedDecision = evaluateLeadSupersession({
    records: [...scored, forged], cycleId: CYCLE, stallRounds: STALL_ROUNDS,
  });
  assert.strictEqual(forgedDecision.reason, "best_lead_dormant_resume_before_replacing");
  pass("a dormant lead the ledger already saw falsified is not handed back as abandoned");
}

// ---- ...but a lead still being scored keeps its protection -------------------
{
  const records = [];
  for (let round = 1; round <= 3; round += 1) {
    records.push(rec({
      round, lane: `gatekeeper-0${round}`, statement: "the active lead",
      scores: { novelty: 40, technical_quality: 30, reproducibility: 20 + round }, verdict: "challenge",
    }));
  }
  const lead = bestSoFarLead(records, CYCLE);
  assert.strictEqual(lead.last_round_index, 3, "scored right up to the newest round");
  assert.strictEqual(leadIsStalled(lead, STALL_ROUNDS, 1, 3), false, "current => not stalled by absence");
  const decision = evaluateLeadSupersession({ records, cycleId: CYCLE, stallRounds: STALL_ROUNDS });
  assert.strictEqual(decision.decision, "deny", "an improving, current lead is still protected");
  pass("stalled by absence leaves an actively scored lead alone");
}


// ---- Lead identity follows the director's declaration, not drifting prose ----
// cycle-g-v75: the `statement` this keys on is currentIdentity.primary_text — a
// concatenation of ~18 hypothesis-artifact fields truncated to 600 chars (every
// one of the cycle's 39 recorded leads had a signed statement of exactly 600).
// A dataset resolving, or the director changing its preamble, shifted the window
// and minted a new lead for the same hypothesis: 38 recorded leads were 23 ideas,
// and `rare_event_splitting` was filed as five separate leads across rounds 3-9.
{
  const { hypothesisKey, declaredLeadIdentity } = require("../src/reporting/hypothesis_progress");
  const FAM = "primary_family=rare_event_splitting";
  const DS = "dataset=procedural://mitsuba/rare-event-light-path-splitting-v1";

  // the three preambles actually observed on v75, same hypothesis underneath
  const a = `SELECTED — ${FAM}; ${DS}; validation_data_status=materialized. Execute adaptive splitting.`;
  const b = `PROVISIONAL RANK 1 — ${FAM}; ${DS}. Execute adaptive multilevel splitting on caustics.`;
  const c = `Provisional first replacement: ${FAM}; ${DS}; needs_materialization. Adaptive splitting.`;
  assert.strictEqual(hypothesisKey({ statement: a }), hypothesisKey({ statement: b }),
    "same family+dataset, different preamble => same lead");
  assert.strictEqual(hypothesisKey({ statement: b }), hypothesisKey({ statement: c }),
    "and again across a third rewording");

  // a different method family is a different lead
  const other = `SELECTED — primary_family=online_photon_guiding; ${DS}. Execute guided photons.`;
  assert.notStrictEqual(hypothesisKey({ statement: a }), hypothesisKey({ statement: other }),
    "different family => different lead");

  // same family on different data is kept apart: merging them would let a guard
  // that decides whether a lead may be abandoned confuse two experiments
  const otherData = `SELECTED — ${FAM}; dataset=procedural://smallvcm/reciprocal-bidirectional-v1.`;
  assert.notStrictEqual(hypothesisKey({ statement: a }), hypothesisKey({ statement: otherData }),
    "same family, different dataset => different lead");

  // no declaration => the statement signature still decides
  assert.strictEqual(declaredLeadIdentity("a lead with no declared family"), null);
  assert.strictEqual(
    hypothesisKey({ statement: "adaptive splitting of rare light paths" }),
    hypothesisKey({ statement: "splitting of rare light paths, adaptive" }),
    "undeclared leads still collapse by token signature",
  );

  // an explicit id still wins outright
  assert.strictEqual(hypothesisKey({ hypothesisId: "hyp-explicit-1", statement: a }), "hyp-explicit-1");
  pass("lead identity: declared family+dataset survives preamble drift");
}

// ---- ...and the rounds now accrue to one lead ---------------------------------
{
  const records = [];
  const FAM = "primary_family=rare_event_splitting";
  const DS = "dataset=procedural://mitsuba/rare-event-light-path-splitting-v1";
  const preambles = ["SELECTED —", "PROVISIONAL RANK 1 —", "Provisional first replacement:", "Candidate only —", "Rank 1,"];
  preambles.forEach((pre, i) => {
    records.push(rec({
      round: i + 1, lane: `gatekeeper-0${i + 1}`,
      statement: `${pre} ${FAM}; ${DS}. Execute adaptive multilevel splitting.`,
      scores: { novelty: 40, technical_quality: 30, reproducibility: 20 }, verdict: "challenge",
    }));
  });
  const lead = bestSoFarLead(records, CYCLE);
  assert.strictEqual(lead.rounds, 5, "five reworded rounds are ONE lead with five rounds");
  assert.strictEqual(lead.last_round_index, 5);
  // five flat rounds is now judgeable — and flat means stalled
  assert.strictEqual(leadIsStalled(lead, 4, 1, 5), true, "a genuinely flat five-round lead is stalled");
  pass("lead identity: reworded rounds accrue to one lead the ledger can judge");
}

console.log(`\nAll ${n} hypothesis-progress checks passed.`);
