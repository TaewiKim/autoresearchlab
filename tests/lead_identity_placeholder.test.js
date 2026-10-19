"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");

const progress = require("../src/reporting/hypothesis_progress");

// cycle-g-v84 spent a whole gate round on a lead named
// `unselected_pending_chronicle`, scored 18/4/3/42/12. The director emitted that
// string as `hypothesis_id` while it was still deferring for evidence, and an
// explicit id is authoritative in hypothesisKey, so a status became the eighth
// distinct lead of a nineteen-round cycle.
//
// The cost is not one wasted round. Every lead change invalidates the reviews
// briefed on the previous lead, so the rounds after one carry a single rubric
// each -- and a one-rubric round cannot beat five bests. That is how
// rounds_since_improvement reached 5 and the stagnation rule halted the cycle,
// twice, with the bests frozen at novelty 38 / technical_quality 35.
//
// Same leak as the literature search running on "selected pending chronicle": a
// placeholder escaping the field it was written in and being read as content.

const PLACEHOLDER_IDS = [
  "unselected_pending_chronicle",
  "no_hypothesis_selected",
  "not_selected",
  "WITHHELD_PENDING_CHRONICLE_EVIDENCE",
  "withheld",
  "awaiting_chronicle",
  "terminal_no_survivor",
];

// Ids that name a specific hypothesis: kept verbatim.
const OPAQUE_IDS = [
  "hyp-director-provisional-inversion-candidate-01",
  "hyp:8adfd9381159091d",
];

// Ids that are just a family name. These must key to the SAME lead as a
// statement declaring that family, or one idea spelled two ways stays two leads
// - which is exactly how `light_transport_estimators` and hyp:8adfd938, whose
// statement read "Primary family light_transport_estimators: ...", ended up as
// separate leads on v84.
const BARE_FAMILY_IDS = [
  "light_transport_estimators",
  "path_guiding",
  "residual_rerendering",
  // uses the vocabulary legitimately: a lead ABOUT deferred shading, not a defer
  "deferred_shading_tile_culling",
];

const FAMILY_STATEMENT =
  "primary_family=light_transport_estimators: seed-to-seed catastrophic bright-path " +
  "misses estimate pilot success probability at a matched time budget";

test("a status string is not a lead identity", () => {
  for (const id of PLACEHOLDER_IDS) {
    const key = progress.hypothesisKey({ hypothesisId: id, statement: FAMILY_STATEMENT });
    assert.notEqual(key, id, `${id} must not become a lead key`);
  }
});

test("a deferring round joins the lead it is actually about", () => {
  // The round still happened and still scored; it belongs to the family the
  // statement declares, not to a new lead of its own. Dropping it would be its
  // own falsification -- the point is that it must not FRAGMENT the ledger.
  const withPlaceholder = progress.hypothesisKey({
    hypothesisId: "unselected_pending_chronicle",
    statement: FAMILY_STATEMENT,
  });
  const withNothing = progress.hypothesisKey({ hypothesisId: "", statement: FAMILY_STATEMENT });
  assert.equal(withPlaceholder, withNothing, "the deferring round must merge into its family");
});

test("every placeholder collapses to one bucket, not one lead each", () => {
  // With no family to fall back on there is nothing to merge into, so the honest
  // outcome is a single unknown-lead bucket. v84 minted a separate lead instead,
  // and each one cost a round of review binding.
  const keys = new Set(
    PLACEHOLDER_IDS.map((id) => progress.hypothesisKey({ hypothesisId: id, statement: "" })),
  );
  assert.equal(keys.size, 1, `placeholders must not multiply leads (got ${keys.size})`);
});

test("an id naming a specific hypothesis is kept verbatim", () => {
  for (const id of OPAQUE_IDS) {
    assert.equal(
      progress.hypothesisKey({ hypothesisId: id, statement: FAMILY_STATEMENT }),
      id,
      `${id} must keep its declared identity`,
    );
  }
});

test("a bare family id keys to the same lead as that family declared", () => {
  for (const id of BARE_FAMILY_IDS) {
    assert.equal(
      progress.hypothesisKey({ hypothesisId: id, statement: "any prose at all" }),
      progress.hypothesisKey({ statement: "different prose entirely", primaryFamily: id }),
      `${id} as an id and as a declared family must be one lead`,
    );
  }
  // ...and they are still four different leads from each other.
  const keys = new Set(BARE_FAMILY_IDS.map((id) => progress.hypothesisKey({ hypothesisId: id, statement: "" })));
  assert.equal(keys.size, BARE_FAMILY_IDS.length);
});

test("two different families stay two different leads", () => {
  const a = progress.hypothesisKey({ hypothesisId: "", statement: "primary_family=path_guiding: x" });
  const b = progress.hypothesisKey({ hypothesisId: "", statement: "primary_family=radiance_caching: x" });
  assert.notEqual(a, b);
});

// cycle-g-v84 recorded SIXTEEN leads over 28 rounds while its director lanes
// declared FIVE distinct families -- in `selected_hypothesis.primary_family`,
// a field the output contract already requires and 12 of 13 lanes filled.
//
// The ledger never read it. It parsed the statement prose instead, and 21 of
// those 28 statements declare no family anywhere in their text: "PROVISIONAL-NOT
// PROMOTED: spatial bright-outlier morphology predicts ...", "Rank 1 - On three
// frozen Mitsuba edit-pair strata ...". Every preamble rewrite moved the
// signature and minted a new lead for the same idea; bright-outlier morphology
// was filed four times. The anti-churn guard was left reasoning over a ledger in
// which no lead could accumulate rounds.
//
// Widening the prose regex does not fix this and was measured not to -- 16 leads
// before, 16 after. You cannot parse what was never written down.

const V84_PREAMBLES = [
  "PROVISIONAL-NOT PROMOTED: spatial bright-outlier morphology predicts a charged matched-time upper-tail RMSE",
  "Rank 1 - On three frozen Mitsuba edit-pair strata, marked spatial-extremes features of pilot bright outliers",
  "Provisional inversion candidate: on frozen Mitsuba edit pairs, spatial bright-outlier morphology normally clamped",
  "Selected - on frozen Mitsuba edit pairs, bright-outlier morphology predicts tail error",
];

test("one declared family is one lead, whatever the preamble says", () => {
  const keys = new Set(
    V84_PREAMBLES.map((statement) =>
      progress.hypothesisKey({ statement, primaryFamily: "path_space_robustness_diagnostics" }),
    ),
  );
  assert.equal(keys.size, 1, `four rewordings of one lead must be one key (got ${keys.size})`);
});

test("the declared family outranks drifting prose", () => {
  // The statement even names a DIFFERENT family in prose; the structured field is
  // the director's own declaration and is what it is contractually required to
  // hold constant while refining.
  const viaField = progress.hypothesisKey({
    statement: "primary_family=path_guiding: some restatement",
    primaryFamily: "light_transport_estimators",
  });
  const viaFieldAlone = progress.hypothesisKey({ statement: "", primaryFamily: "light_transport_estimators" });
  assert.equal(viaField, viaFieldAlone);
});

test("different declared families remain different leads", () => {
  const seen = new Set(
    ["path_guiding", "residual_rerendering", "light_transport_estimators", "adaptive_sampling_heterogeneity"].map(
      (primaryFamily) => progress.hypothesisKey({ statement: "same prose everywhere", primaryFamily }),
    ),
  );
  assert.equal(seen.size, 4, "the guard must still be able to tell real pivots apart");
});

test("a placeholder family falls through instead of minting a lead", () => {
  // v84's director wrote primary_family: "unselected_pending_chronicle" while
  // deferring. That is a status, not a family.
  assert.equal(
    progress.hypothesisKey({ statement: "prose", primaryFamily: "unselected_pending_chronicle" }),
    progress.hypothesisKey({ statement: "prose" }),
  );
});
