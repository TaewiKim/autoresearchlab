"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { leadProtectionPrefix } = require("../src/reporting/reviews/gate/actions");

// The decision the ledger computed 19 times on cycle-g-v89 and that reached 0 of
// the 19 most recent director prompts. It is an ALLOW, which is why every reader
// that kept only denies discarded it.
const DORMANT_RESUME = {
  decision: "allow",
  reason: "best_lead_dormant_resume_before_replacing",
  lead: "hyp:a425b73b4952eb71",
  resume_lead: {
    memory_id: "hyp:a425b73b4952eb71",
    statement: "rejected reuse proposals encode the first unsafe stale-harm boundary",
    rounds: 11,
    last_round_index: 120,
    current_round: 168,
    best_by_rubric: { novelty: 64, technical_quality: 82, reproducibility: 86, clarity: 91, impact: 62 },
    best_composite: 75.4,
  },
};

test("a dormant best lead is delivered as an instruction to resume it", () => {
  const prefix = leadProtectionPrefix(DORMANT_RESUME);
  assert.match(prefix, /ABANDONED, NOT DISPROVED/);
  assert.match(prefix, /hyp:a425b73b4952eb71/);
  // The rubric scores are what tell the director which axis to work on.
  assert.match(prefix, /impact=62/);
  assert.match(prefix, /scored 11 time\(s\)/);
});

test("an ordinary allow carries no protection text", () => {
  assert.equal(leadProtectionPrefix({ decision: "allow", reason: "lead_stalled_pivot_permitted" }), "");
});

test("the conclusion review reader keeps the resume decision", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { ledgerLeadProtection } = require("../src/reporting/conclusion_review");

  const { appendDecisionEvent } = require("../src/reporting/hypothesis_progress");

  const write = (decision) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-"));
    const cycleId = "cycle-01";
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    // Written through the ledger's own append, so the record carries the audit
    // hash its integrity gate demands. A hand-built line reads as absent.
    appendDecisionEvent(root, cycleId, decision, fs, new Date().toISOString());
    return ledgerLeadProtection(root, cycleId, fs);
  };

  // Read back through the real reader, not asserted against the source text: a
  // source assertion passed through two whole cycles here while the field it
  // named arrived zero times.
  const resumed = write(DORMANT_RESUME);
  assert.equal(resumed?.reason, "best_lead_dormant_resume_before_replacing");
  assert.match(leadProtectionPrefix(resumed), /ABANDONED, NOT DISPROVED/);

  const denied = write({ decision: "deny", reason: "critical_memory_suppression_blocked_lead_still_improving" });
  assert.equal(denied?.decision, "deny");

  // An unrelated allow is still nothing to say.
  assert.equal(write({ decision: "allow", reason: "lead_falsified_by_completed_run" }), null);
});

test("the director is told which rubrics are already at the bar, and what earned them", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-17/18: a lead reached novelty
  // 78 / technical_quality 84 / reproducibility 92 / clarity 86 with only impact
  // (67) short, and was replaced instead of improved at the one rubric that lacked.
  const { retainedStrengthsPrefix } = require("../src/reporting/reviews/gate/actions");
  const rubric = [
    { name: "novelty", score: 84, reasons: ["No direct prior art found in four targeted searches.", "closest is Much Ado About Noising"], applicable: true },
    { name: "technical_quality", score: 89, reasons: ["Exact shared-state pairing and a sealed panel."], applicable: true },
    { name: "reproducibility", score: 88, reasons: ["Hash-pinned dataset and recorded commands."], applicable: true },
    { name: "clarity", score: 85, reasons: ["Falsifiers and rivals are explicit."], applicable: true },
    { name: "impact", score: 78, reasons: ["Would change the model-selection decision only if it holds."], applicable: true },
  ];
  const text = retainedStrengthsPrefix(rubric);
  assert.match(text, /ALREADY AT THE BAR \(80\)/);
  assert.match(text, /novelty=84 \(reviewer: No direct prior art found in four targeted searches\. \| closest is Much Ado/);
  assert.match(text, /technical_quality=89/);
  assert.match(text, /The work left is impact=78/);
  assert.match(text, /A cleared rubric that falls again is a regression/);
  assert.ok(!/impact=78 \(reviewer/.test(text), "a rubric below the bar is the work, not a strength");

  // A rubric filled from another reviewer's row (nobody focused on it) is not a score.
  const partial = [
    { name: "impact", score: 90, reasons: ["Strong."], applicable: true },
    { name: "novelty", score: 95, reasons: ["Filled from the impact reviewer's row."], applicable: true, focused_review_missing: true },
  ];
  const onlyOwn = retainedStrengthsPrefix(partial);
  assert.match(onlyOwn, /impact=90/);
  assert.ok(!/novelty=95/.test(onlyOwn), "an unreviewed rubric was presented as cleared");

  // Nothing at the bar, nothing to retain.
  assert.equal(retainedStrengthsPrefix([{ name: "impact", score: 40, reasons: [], applicable: true }]), "");
  assert.equal(retainedStrengthsPrefix([]), "");
  assert.equal(retainedStrengthsPrefix(null), "");
});
