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
