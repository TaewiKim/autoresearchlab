// Under an authorised document stage, flat research rubrics are the PREMISE.
//
// cycle-g-v89 was authorised precisely because its gate would not pass and the
// science was worth writing up anyway. Halting it for "no rubric improved" stops
// the cycle for the reason it was told to proceed under, and it did: twice, at
// rounds 128 and 133, while the manuscript was being rewritten round after round.
//
// The authorisation does not disarm the signature. It moves what the signature
// measures: a cycle whose PAPER is also frozen is stuck in the document stage and
// still dies here.

const test = require("node:test");
const assert = require("node:assert");

const { evaluate, FLATLINE_WINDOW_MINUTES } = require("../src/cli/progress_watchdog.js");

const MINUTE = 60000;
const NOW = 1_756_000_000_000;
const STAGNATION = "score_stagnation_without_improvement";

function row(minutesAgo, { paperScore = 73, blockers = 8 } = {}) {
  return {
    epoch_ms: NOW - minutesAgo * MINUTE,
    lanes_completed: 700,
    gate_rounds: 130,
    abort_count: 0,
    paper_score: paperScore,
    paper_blocker_count: blockers,
  };
}

const HISTORY = [
  row(FLATLINE_WINDOW_MINUTES + 30, { paperScore: 65, blockers: 11 }),
  row(FLATLINE_WINDOW_MINUTES + 5, { paperScore: 65, blockers: 11 }),
  row(10, { paperScore: 73, blockers: 8 }),
];

function snapshot(overrides = {}) {
  return {
    epoch_ms: NOW,
    lanes_completed: 760,
    gate_rounds: 133,
    abort_count: 0,
    gate_passed: false,
    rounds_since_improvement: 5,
    distinct_leads: 67,
    lead_changes: 68,
    rounds_per_lead: 1.99,
    best_technical_quality: 98,
    best_reproducibility: 86,
    best_by_rubric: { novelty: 76, impact: 62 },
    role_counts: { "lab-director": 124, scout: 5, gatekeeper: 240 },
    document_stage_authorization: null,
    paper_score: 73,
    paper_blocker_count: 8,
    ...overrides,
  };
}

const AUTHORIZED = { authorized: true, authorized_by: "owner", reason: "document this cycle" };

function fired(findings) {
  return findings.some((item) => item.signature === STAGNATION);
}

test("with no authorisation, flat rubrics still halt the cycle", () => {
  assert.equal(fired(evaluate({ snapshot: snapshot(), history: HISTORY })), true);
});

test("an authorised document stage is not halted while the paper is moving", () => {
  // v89's own numbers: rubrics flat, paper 65 -> 73 and blockers 11 -> 8.
  const findings = evaluate({
    snapshot: snapshot({ document_stage_authorization: AUTHORIZED }),
    history: HISTORY,
  });
  assert.equal(fired(findings), false, JSON.stringify(findings.map((f) => f.signature)));
});

test("an authorised cycle whose paper is frozen too still dies here", () => {
  const frozen = [
    row(FLATLINE_WINDOW_MINUTES + 30, { paperScore: 73, blockers: 8 }),
    row(FLATLINE_WINDOW_MINUTES + 5, { paperScore: 73, blockers: 8 }),
    row(10, { paperScore: 73, blockers: 8 }),
  ];
  const findings = evaluate({
    snapshot: snapshot({ document_stage_authorization: AUTHORIZED }),
    history: frozen,
  });
  assert.equal(fired(findings), true, "the authorisation is not a licence to sit still");
});

test("a blocker count that moves counts as movement even when the score does not", () => {
  const scoreFlat = [
    row(FLATLINE_WINDOW_MINUTES + 30, { paperScore: 73, blockers: 11 }),
    row(10, { paperScore: 73, blockers: 8 }),
  ];
  const findings = evaluate({
    snapshot: snapshot({ document_stage_authorization: AUTHORIZED }),
    history: scoreFlat,
  });
  assert.equal(fired(findings), false);
});

// MEASURED on cycle-g-v89 at 12:01:36. The review's numbers were flat across the
// whole window (65 / 9 at both ends) so the document counted as frozen and the
// halt fired -- six minutes after the manuscript was rewritten and three minutes
// after an author lane completed. The review re-scores at gate-round cadence; the
// author writes far more often, so between rounds an active paper always looks
// still.
test("a manuscript rewritten inside the window is a moving document", () => {
  const { evaluate, FLATLINE_WINDOW_MINUTES } = require("../src/cli/progress_watchdog");
  const now = Date.now();
  const windowMs = FLATLINE_WINDOW_MINUTES * 60000;

  const row = (ageMinutes, extra) => ({
    epoch_ms: now - ageMinutes * 60000,
    gate_passed: false,
    gate_rounds: 179,
    rounds_since_improvement: 5,
    document_stage_authorization: { authorized: true, reason: "worth writing up" },
    paper_score: 65,
    paper_blocker_count: 9,
    best_by_rubric: { novelty: 76 },
    role_counts: {},
    ...extra,
  });

  // The measured shape: score and blockers identical across the window.
  const baseline = row(FLATLINE_WINDOW_MINUTES + 5, { paper_artifact_mtime: now - windowMs - 600000 });

  const frozen = evaluate({
    snapshot: row(0, { paper_artifact_mtime: baseline.paper_artifact_mtime }),
    history: [baseline],
  });
  assert.ok(
    frozen.some((f) => f.signature === "score_stagnation_without_improvement"),
    "score, blockers and manuscript all unchanged is genuinely stuck",
  );

  const rewritten = evaluate({
    snapshot: row(0, { paper_artifact_mtime: now - 360000 }), // written 6 minutes ago
    history: [baseline],
  });
  assert.ok(
    !rewritten.some((f) => f.signature === "score_stagnation_without_improvement"),
    "a manuscript rewritten inside the window must not read as a frozen document",
  );
});
