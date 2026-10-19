"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  filterSupersededGatekeeperReviews,
  unboundGatekeeperRubricsForRebind,
} = require("../src/reporting/reviews/gate/build/progress");
const { collectParsedGatekeeperReviews } = require("../src/reporting/reviews/gate/gatekeeper_reviews");
const { buildGateFollowupActions } = require("../src/reporting/reviews/gate/actions");

// cycle-g-v78 reported novelty=72 and technical_quality=28 for four consecutive
// gate rounds — identical ACROSS a lead change, from change_point_path_guiding
// to spatial_selective_cache_invalidation. 15 of the 17 contributing reviews
// predated the current lead; the two that did not were clarity and
// reproducibility, the only two axes that moved.

const SIGNALS = { latestValidationLaneId: null, latestValidationMtime: 0, latestValidationSummary: null };

function review(laneId, briefedLeadKey, verdict = "reject") {
  return {
    lane_id: laneId,
    focus_rubric: "novelty",
    verdict,
    source_mtime: 1000,
    briefed_lead_key: briefedLeadKey,
    rubric: [{ name: "novelty", score: 72, applicable: true }],
  };
}

function split(reviews, identity) {
  return filterSupersededGatekeeperReviews(reviews, SIGNALS, identity);
}

test("a review briefed on the previous lead is superseded", () => {
  const out = split([review("gk-old", "hyp:aaaa")], { lead_key: "hyp:bbbb", source_mtime: 5000, primary_text: "x" });
  assert.equal(out.activeReviews.length, 0);
  assert.equal(out.supersededReviews.length, 1);
  assert.equal(out.supersededReviews[0].superseded_kind, "superseded_briefed_lead_review");
  assert.equal(out.supersededReviews[0].briefed_lead_key, "hyp:aaaa");
  assert.equal(out.supersededReviews[0].current_lead_key, "hyp:bbbb");
});

test("a review briefed on the current lead survives even when it predates the artifact", () => {
  // Same lead, restated: the review is older than the artifact mtime but it IS
  // about this lead, so the existing partial-credit/reject paths still apply.
  const out = split([review("gk-current", "hyp:bbbb")], { lead_key: "hyp:bbbb", source_mtime: 5000, primary_text: "x" });
  assert.equal(out.supersededReviews.filter((r) => r.superseded_kind === "superseded_briefed_lead_review").length, 0);
});

test("a review of the current lead counts before any analysis has run under its contract", () => {
  // cycle-a-20260919, 2026-10-14: the lead carried a contract for a
  // dataset not yet generated, so every reviewer was briefed with no contract
  // and all 42 reviews of that same lead were set aside; the gate scored 0.
  const identity = { lead_key: "hyp:9269", analysis_contract_id: "analysis:e9a1", source_mtime: 5000, primary_text: "x" };
  const unbriefed = { ...review("gk-same-lead", "hyp:9269"), briefed_analysis_contract_id: null };
  const out = split([unbriefed], identity);
  assert.equal(out.supersededReviews.filter((r) => r.superseded_kind === "superseded_briefed_lead_review").length, 0);

  // A review briefed on another contract judged a different analysis.
  const stale = { ...review("gk-old-contract", "hyp:9269"), briefed_analysis_contract_id: "analysis:0ld" };
  const staleOut = split([stale], identity);
  assert.equal(staleOut.supersededReviews.length, 1);
  assert.equal(staleOut.supersededReviews[0].superseded_kind, "superseded_briefed_lead_review");
  // ...and one briefed on this contract stands.
  const bound = { ...review("gk-bound", "hyp:9269"), briefed_analysis_contract_id: "analysis:e9a1" };
  assert.equal(split([bound], identity).supersededReviews.filter((r) => r.superseded_kind === "superseded_briefed_lead_review").length, 0);
  // A review of another lead is still set aside, contract or none.
  assert.equal(split([{ ...review("gk-other", "hyp:aaaa"), briefed_analysis_contract_id: null }], identity).supersededReviews.length, 1);
});

test("previous reviews carry over to a lead whose contract has not run yet", () => {
  const { reviewMatchesSelectedLead } = require("../src/agents/shared/lead_evidence_match");
  const lead = { family: "coverage", datasets: new Set(["calibration_v4"]), contractId: "analysis:e9a1" };
  const identity = (contract) => ({ primary_family: "coverage", dataset_keys: ["calibration_v4"], analysis_contract_id: contract });
  assert.equal(reviewMatchesSelectedLead({ current_hypothesis_identity: identity(null) }, lead), true);
  assert.equal(reviewMatchesSelectedLead({ current_hypothesis_identity: identity("analysis:e9a1") }, lead), true);
  assert.equal(reviewMatchesSelectedLead({ current_hypothesis_identity: identity("analysis:0ld") }, lead), false);
  assert.equal(reviewMatchesSelectedLead({ current_hypothesis_identity: { ...identity(null), primary_family: "other" } }, lead), false);
});

test("an unstamped review is never superseded for the stamp alone", () => {
  // Lanes opened before the stamp existed must behave exactly as before.
  const out = split([review("gk-legacy", null)], { lead_key: "hyp:bbbb", source_mtime: 5000, primary_text: "x" });
  assert.equal(out.supersededReviews.filter((r) => r.superseded_kind === "superseded_briefed_lead_review").length, 0);
});

test("a bound current-lead review reopens rubrics still owned by unstamped reviews", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-04: the cycle reached
  // conclusion, replaced its lead, then five unstamped gate reviews kept the
  // old focused scores live while completed followups could not advance it.
  const reviews = [
    { ...review("gk-current", "hyp:bbbb"), focus_rubric: "novelty" },
    { ...review("gk-old-tech", null), focus_rubric: "technical_quality" },
    { ...review("gk-old-impact", null), focus_rubric: "impact" },
  ];
  const identity = { lead_key: "hyp:bbbb", source_mtime: 5000, primary_text: "x" };
  assert.deepEqual(
    unboundGatekeeperRubricsForRebind(reviews, identity).sort(),
    ["impact", "technical_quality"],
    "the pipeline must schedule current-lead owners for the stuck rubrics",
  );

  reviews.unshift({ ...review("gk-current-tech", "hyp:bbbb"), focus_rubric: "technical_quality" });
  assert.deepEqual(
    unboundGatekeeperRubricsForRebind(reviews, identity),
    ["impact"],
    "a newly bound focused review advances that rubric instead of reopening it forever",
  );
});

test("a missing current lead key does not supersede anything", () => {
  const out = split([review("gk-any", "hyp:aaaa")], { lead_key: null, source_mtime: 5000, primary_text: "x" });
  assert.equal(out.supersededReviews.filter((r) => r.superseded_kind === "superseded_briefed_lead_review").length, 0);
});

test("the current lead key is derived from the lead, not a constant", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { currentHypothesisIdentity } = require("../src/reporting/reviews/gate/build/progress");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lead-key-"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  const write = (statement) =>
    fs.writeFileSync(
      path.join(root, "state", "cyc-lab-director-hypothesis.json"),
      JSON.stringify({ statement, status: "selected" }),
    );

  write("primary_family=path_guiding: frozen proposals show an ESS-to-error crossover under scene edits");
  const first = currentHypothesisIdentity({ root, cycleId: "cyc", summary: {} }).lead_key;
  write("primary_family=radiance_caching: tile invalidation beats full retrain after emitter edits");
  const second = currentHypothesisIdentity({ root, cycleId: "cyc", summary: {} }).lead_key;

  // sha256("") — what a statement-shaped argument to hypothesisKey produces.
  const EMPTY = "hyp:e3b0c44298fc1c14";
  assert.notEqual(first, EMPTY, "the key must come from the lead, not from an empty string");
  assert.notEqual(first, second, "a different lead must produce a different key");

  write("primary_family=radiance_caching: tile invalidation beats full retrain after emitter edits");
  assert.equal(
    currentHypothesisIdentity({ root, cycleId: "cyc", summary: {} }).lead_key,
    second,
    "the same lead must produce the same key",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("the stamp is written at dispatch and read back at collection", () => {
  const actions = buildGateFollowupActions(
    {
      current_lead_key: "hyp:cccc",
      validation_results: [{ lane_id: "lab-runner-01", verdict: "passed" }],
    },
    [],
    ["technical_quality"],
    {},
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].gate_review_lead_key, "hyp:cccc");

  // ...and the lane's plan carries it back to the aggregate.
  const collected = collectParsedGatekeeperReviews([
    {
      laneId: "followup-gatekeeper-01",
      target_rubric: "technical_quality",
      mtime: 1000,
      action_match: "exact",
      rolePlan: { planner_metadata: { gate_review_lead_key: "hyp:cccc" } },
      result: {
        extracted_json: {
          reviewer_focus_rubric: "technical_quality",
          verdict: "reject",
          rubric: [{ name: "technical_quality", score: 28, applicable: true }],
        },
      },
    },
  ]);
  assert.equal(collected.parsedReviews.length, 1);
  assert.equal(collected.parsedReviews[0].briefed_lead_key, "hyp:cccc");
});

// cycle-g-v81: 95 of 190 ledger decisions were lead_stalled_pivot_permitted, all
// naming the best lead, which had been abandoned at round 44 of 57. A lead that
// was dropped rather than disproved was answering every pivot request with
// "permitted", so leads averaged 2.04 rounds each.
const { leadProtectionPrefix } = require("../src/reporting/reviews/gate/actions");
const progress = require("../src/reporting/hypothesis_progress");

test("a dormant best lead is told to resume, not given a blank cheque", () => {
  const dormant = {
    memory_id: "hyp:aaaa",
    last_round_index: 44,
    binding_best_history: [10, 12],
    rubric_history: {},
  };
  assert.equal(
    progress.leadStallKind(dormant, 6, undefined, 57),
    "dormant",
    "last scored 13 rounds ago with a 6-round window",
  );

  const prefix = leadProtectionPrefix({
    decision: "allow",
    reason: "best_lead_dormant_resume_before_replacing",
    resume_lead: {
      memory_id: "hyp:aaaa",
      statement: "primary_family=tail_inversion: use the unclamped tail",
      rounds: 6,
      last_round_index: 44,
      current_round: 57,
      best_by_rubric: { novelty: 58, reproducibility: 78 },
    },
  });
  assert.match(prefix, /ABANDONED, NOT DISPROVED/);
  assert.match(prefix, /hyp:aaaa/);
  assert.match(prefix, /tail_inversion/);
  assert.match(prefix, /reproducibility=78/);
  assert.match(prefix, /round 44 of 57/);
});

test("a plateaued lead still permits an ordinary pivot", () => {
  // Scored recently, so not dormant — the old behaviour must survive.
  const worked = {
    memory_id: "hyp:bbbb",
    last_round_index: 56,
    binding_best_history: [10, 10, 10, 10, 10, 10, 10],
    rubric_history: { novelty: [10, 10, 10, 10, 10, 10, 10] },
    latest: { content: { binding_rubric: { name: "novelty", score: 10 } } },
  };
  assert.equal(progress.leadStallKind(worked, 6, undefined, 57), "plateau");
  assert.equal(leadProtectionPrefix({ decision: "allow", reason: "lead_stalled_pivot_permitted" }), "");
});
