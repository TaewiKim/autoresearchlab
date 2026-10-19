"use strict";

// Honesty is a constraint on a claim. It is not a claim.
//
// The gate has spent this cycle getting the integrity checks right -- figures
// read against their artifacts, numbers bound to files, no paths leaked, a
// falsification reported rather than buried. All of that works. And what it
// produced is a manuscript whose Interpretation sentence says the result is
// "restricted to benchmarked localization rather than a rendering-specific
// mechanism or deployment-ready safety guarantee", whose headline method is
// matched exactly by a control that uses no rendering information, and whose own
// preregistered safety bound was missed under both budgets.
//
// Every one of those sentences is true. Together they are a paper that claims
// nothing, and the gate passed it at 92 because nothing it checks distinguishes
// a careful result from a careful absence.
//
// Worse, the machinery rewards the retreat. A falsification counts as a
// contribution, so the cheapest way past a control that reproduces your result
// is to relabel the paper as an audit and keep the same evidence. The claim gets
// weaker until it fits what was measured, and each step is defensible on its
// own. That is what a hedge dressed as integrity looks like from inside.
//
// So this module asks the questions integrity checks do not:
//
//   Does the manuscript establish anything, stated as a claim rather than as a
//   qualified non-claim?
//
//   If the contribution is a negative result, whose claim does it kill? A
//   result that refutes nobody is a failed search, and a failed search is a
//   reason to run the next experiment, not a paper.
//
//   If claims were withdrawn, what survived? A cycle may not conclude by
//   subtraction alone.
//
// None of this licenses overclaiming: the no-overclaiming rules stay exactly
// where they are, and a claim asserted past its evidence still fails them. The
// two together are the actual requirement -- say something, and be able to
// defend it.

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

// Words that convert a finding into a posture. The list is deliberately about
// EPISTEMIC hedges -- "may", "appears" -- and about the scope-shrinking moves
// this project's manuscripts actually used, not about ordinary caution like
// "under matched budgets", which is a specification and belongs in a result.
const HEDGE_PATTERNS = [
  /\bmay\b/i,
  /\bmight\b/i,
  /\bcould\b/i,
  /\bsuggests?\b/i,
  /\bappears?\s+to\b/i,
  /\btends?\s+to\b/i,
  /\bis\s+consistent\s+with\b/i,
  /\bcannot\s+be\s+(excluded|ruled\s+out)\b/i,
  /\bdo(es)?\s+not\s+(establish|demonstrate|show|prove|claim)\b/i,
  /\brestricted\s+to\b/i,
  /\brather\s+than\s+a\b/i,
  /\bpotentially\b/i,
  /\bpreliminary\b/i,
];

function isHedged(sentence) {
  return HEDGE_PATTERNS.some((pattern) => pattern.test(sentence));
}

function sentences(value) {
  return text(value)
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 20);
}

// A claim that carries a measured quantity is a claim someone can attack. One
// that carries none is a position.
function carriesAMeasurement(sentence) {
  return /\d/.test(sentence);
}

function manuscriptClaimText(paper) {
  const abstract = paper?.abstract;
  const parts = [
    text(paper?.claim),
    text(paper?.central_claim),
    typeof abstract === "string" ? abstract : "",
    text(abstract?.interpretation),
    text(abstract?.results),
    text(abstract?.summary),
  ];
  for (const item of asArray(paper?.results)) parts.push(text(item));
  return parts.filter(Boolean);
}

/**
 * The one sentence a reader should be able to quote back: what this manuscript
 * establishes, said without a qualifier in front of it, carrying a number.
 */
function establishedClaim(paper) {
  const candidates = manuscriptClaimText(paper).flatMap(sentences);
  const standing = candidates.filter((item) => !isHedged(item) && carriesAMeasurement(item));
  return {
    found: standing.length > 0,
    sentence: standing[0] || null,
    hedged_candidates: candidates.filter(isHedged).length,
    total_candidates: candidates.length,
  };
}

function contributionType(paper) {
  return text(paper?.contribution_type).toLowerCase() || null;
}

// A negative result is an input, not an ending.
//
// Owner rule: when something fails, the failure itself is evidence about where
// the answer is, and the cycle owes the next approach it points to. cycle-g-v89
// ran 27 distinct methods against one question and every one missed the same
// preregistered bound of 0.10 -- a pattern that says something quite specific
// about the problem -- and the manuscript's conclusion was that the bound was
// not met. That is a report of the failure, not a use of it.
//
// So the next approach has to be DERIVED. "Future work: more scenes, higher
// resolution" is the boilerplate this check exists to reject: it could have been
// written before the experiment ran, which means the result contributed nothing
// to it. What makes it derived is that it points at a measurement this
// manuscript actually reports, in an artifact this manuscript actually ships.
function nextApproachRecord(paper) {
  const record = paper?.next_approach && typeof paper.next_approach === "object" ? paper.next_approach : null;
  const approach = text(record?.approach);
  const derivedFrom = text(record?.derived_from);
  return {
    stated: Boolean(approach),
    approach: approach || null,
    derived_from: derivedFrom || null,
    // Derived means it names a number the result produced, not a direction
    // anybody could have named beforehand.
    derived: Boolean(derivedFrom) && /\d/.test(derivedFrom),
    source_artifact: text(record?.source_artifact) || null,
  };
}

// Everything that makes a manuscript owe a next approach: a negative result, a
// claim given up, or a control that matched the method.
function carriesANegativeResult(paper) {
  const type = contributionType(paper);
  return (
    type === "negative_result" ||
    type === "falsification" ||
    asArray(paper?.withdrawn_claims).length > 0 ||
    asArray(paper?.controls_that_reproduce_the_result).length > 0
  );
}

// A negative result has a target. `refutes` names the standing claim and where
// it was made; without the source it is an assertion that someone, somewhere,
// believed the thing this cycle failed to show.
function refutationRecord(paper) {
  const record = paper?.refutes && typeof paper.refutes === "object" ? paper.refutes : null;
  const claim = text(record?.claim);
  const source = record?.source && typeof record.source === "object" ? record.source : null;
  const cited = Boolean(text(source?.doi) || text(source?.title) || text(source?.url));
  return { claim: claim || null, cited, source };
}

/**
 * Blockers about what the manuscript claims. These are blockers rather than
 * score deductions because a paper with no claim does not become one at a
 * higher score.
 */
function claimStrengthFindings(paper, { experimentChannelExhausted = false } = {}) {
  const findings = [];
  if (!paper) return findings;

  const established = establishedClaim(paper);
  const type = contributionType(paper);
  const withdrawn = asArray(paper.withdrawn_claims).map(text).filter(Boolean);
  const refutation = refutationRecord(paper);

  // Both declarations are REQUIRED, and an omission is not a pass.
  //
  // Run against cycle-g-v89 these checks found nothing, because the manuscript
  // declares neither field -- while its own Results section reports that a
  // severity-label sham matched the proposed method on every held-family seed.
  // A check that only fires when the author volunteers the damaging fact is a
  // check the careless case walks past, which is how the sham reached a passing
  // gate in the first place.
  //
  // "None" therefore has to be written down. An empty list is an assertion a
  // gatekeeper can read the artifacts against; a missing field is not.
  if (!type) {
    findings.push(
      "contribution_type is not stated: say whether this is a method, a benchmark, an evaluation or a "
      + "negative_result. The claim a manuscript is allowed to make depends on which one it is",
    );
  }
  if (!Array.isArray(paper.controls_that_reproduce_the_result)) {
    findings.push(
      "controls_that_reproduce_the_result is not stated: list every control, sham or ablation whose result "
      + "matches the proposed method's, or record an empty list to assert that none does. Leaving the field "
      + "out is not the same as there being none",
    );
  }

  if (!established.found) {
    findings.push(
      "the manuscript states no positive claim: every candidate sentence is hedged or carries no measured "
      + `quantity (${established.hedged_candidates} hedged of ${established.total_candidates} candidates). `
      + "Write one sentence saying what this work establishes, with the number that makes it attackable. "
      + "If the evidence does not support one yet, that is a request for the next experiment, not a manuscript",
    );
  }

  // A cycle may not finish by subtraction. This is the same rule the director
  // works under -- a falsification retires the METHOD, not the QUESTION -- read
  // at the point where the cycle tries to publish the subtraction.
  if (withdrawn.length && !established.found) {
    findings.push(
      `${withdrawn.length} claim(s) were withdrawn and none replaced them (${withdrawn.join("; ")}). `
      + "Removing a claim is a result about a method; the question it was answering is still open, and the "
      + "paper needs whatever now answers it",
    );
  }

  if (type === "negative_result" || type === "falsification") {
    if (!refutation.claim) {
      findings.push(
        "a negative result has to name the standing claim it kills: record `refutes.claim`. "
        + "Failing to meet a bound this cycle set for itself is a failed search, and a failed search is a "
        + "reason to run the next experiment rather than a contribution",
      );
    } else if (!refutation.cited) {
      findings.push(
        `the refuted claim is stated but not attributed (${refutation.claim}): record refutes.source with a `
        + "doi, title or url, so a reader can check that somebody actually held it",
      );
    }
  }

  // The failure has to be used, not just disclosed.
  if (carriesANegativeResult(paper)) {
    const next = nextApproachRecord(paper);
    const requested = asArray(paper.additional_experiments_requested).length > 0;
    if (!next.stated) {
      findings.push(
        "this manuscript reports something that did not work and stops there: record `next_approach` with "
        + "the approach the result itself points to. A failure is evidence about where the answer is, and "
        + "the cycle owes the move it implies",
      );
    } else if (!next.derived) {
      findings.push(
        `the next approach is stated but not derived from the result (${next.approach}): `
        + "`next_approach.derived_from` has to name the measurement in THIS work that points there. A "
        + "direction that could have been written before the experiment ran was not learned from it",
      );
    }
    // Asking is only a requirement while asking can be answered. Once the
    // programme has refused every request and adopted none, demanding one more
    // request tells the author to do the exact thing another blocker tells it to
    // stop doing -- a contradiction this rule and the exhausted-channel
    // instruction produced together on cycle-g-v89.
    //
    // NAMING the next approach stays required either way: that is the half the
    // owner asked for, the solution a negative result points to. Only the demand
    // that the cycle run it is lifted.
    if (next.stated && !requested && !experimentChannelExhausted) {
      findings.push(
        `the next approach is named but never requested (${next.approach}): put it in `
        + "`additional_experiments_requested` so the director decides whether this cycle runs it. A next "
        + "step recorded only in the discussion is future work, and future work is where results go to stop",
      );
    }
  }

  // Reported rather than blocked: a manuscript may legitimately be careful. The
  // number is here so a reviewer can see the posture, and so a cycle that drifts
  // toward hedging over successive revisions is visible in the review record.
  return findings;
}

function claimStrengthReport(paper) {
  const established = establishedClaim(paper);
  return {
    states_a_positive_claim: established.found,
    established_claim: established.sentence,
    hedged_candidate_sentences: established.hedged_candidates,
    candidate_sentences: established.total_candidates,
    hedge_ratio: established.total_candidates
      ? Number((established.hedged_candidates / established.total_candidates).toFixed(2))
      : null,
    contribution_type: contributionType(paper),
    withdrawn_claims: asArray(paper?.withdrawn_claims).length,
    refutes: refutationRecord(paper).claim,
    carries_a_negative_result: carriesANegativeResult(paper),
    next_approach: nextApproachRecord(paper).approach,
    next_approach_derived: nextApproachRecord(paper).derived,
  };
}

module.exports = {
  establishedClaim,
  claimStrengthFindings,
  claimStrengthReport,
  isHedged,
};
