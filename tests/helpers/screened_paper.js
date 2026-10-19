"use strict";

// Build a paper that passes the abstract-screening gate.
//
// `bafcced` made screening fail-closed: no paper reaches the literature graph,
// the gate reviewer's `latest_papers`, or any hypothesis grounding without a
// `literature_screening` receipt naming the reviewer, the objective it was read
// against, the exact abstract text it was read from, and evidence that the paper
// clears a quality track. That is the right shape -- it is the same rule the
// Python driver's `screening.py` enforces on the way in.
//
// What it left behind was five tests whose fixtures were written before it, all
// of which then asserted against an empty corpus and went red on the same day.
// They stayed red for four days because nothing else in the suite reads the
// literature path.
//
// This helper exists so a fixture states the ONE thing it is about -- a sidecar
// is read, a paper reaches the reviewer -- without restating the receipt every
// time. It computes the receipt with `literature_screening.js`'s own hash and
// identity functions, so if that contract changes, every fixture moves with it
// instead of going quietly empty.

const { POLICY_VERSION, hash, paperIdentity } = require("../../src/policy/literature_screening");

// Long enough for the gate's own minimum, and each passage is quoted verbatim
// out of this text below.
const ABSTRACT = [
  "We study adaptive sample allocation for Monte Carlo path tracing.",
  "The method reallocates samples across pixels using a variance estimate updated per iteration.",
  "On a scene suite the approach reduces mean squared error at equal sample count,",
  "and the outcome holds across three light transport configurations.",
].join(" ");

/**
 * A paper that satisfies `isScreenedEvidence` against `objective`.
 *
 * `overrides` are applied to the paper BEFORE the receipt is computed, so a
 * caller can change the title, abstract or identity and still get a valid
 * receipt for what it actually built.
 */
function screenedPaper(objective, overrides = {}) {
  const paper = {
    title: "Adaptive Sampling for Monte Carlo Path Tracing",
    authors: "A. Researcher, B. Researcher",
    journal: "ACM Transactions on Graphics",
    // The recency track: a paper published inside the last three years clears
    // the quality bar without citation metrics, which a new paper cannot have.
    year: new Date().getUTCFullYear(),
    abstract: ABSTRACT,
    abstract_text_kind: "full_abstract",
    doi: "10.1145/adaptive-sampling-1",
    ...overrides,
  };

  const abstract = String(paper.abstract || "").replace(/\s+/gu, " ").trim();
  const objectiveHash = hash(objective);
  // Quoted out of the abstract, because the gate checks that each passage is
  // actually in the text the reviewer says it read.
  const passage = (fragment) => (abstract.includes(fragment) ? fragment : abstract.slice(0, 60));

  paper.literature_screening = {
    status: "accepted",
    policy_version: POLICY_VERSION,
    context_hash: hash(`${objective}|screening-context`),
    objective_hash: objectiveHash,
    quality: { eligible: true, tracks: ["recent_frontier"] },
    review: {
      paper_id: paperIdentity(paper),
      abstract_sha256: hash(paper.abstract),
      objective_hash: objectiveHash,
      abstract_read_in_full: true,
      decision: "directly_relevant",
      reviewer: { kind: "codex_cli", identity: "test-fixture-reviewer" },
      reviewed_at: new Date().toISOString(),
      // Per paper, because a reason reused word-for-word across papers is now
      // rejected as a template -- which is what 252 of 252 v90 reviews were.
      direct_relevance_reason:
        `"${paper.title}" addresses the same estimator the objective asks about and reports the outcome on it.`,
      limitations: "Evaluated on a single renderer and scene suite.",
      supporting_passage: passage("adaptive sample allocation for Monte Carlo path tracing"),
      linkage: {
        study_task: {
          abstract_evidence: passage("adaptive sample allocation"),
          objective_link:
            `The objective asks about the sample-allocation task "${paper.title}" runs.`,
        },
        method: {
          abstract_evidence: passage("using a variance estimate updated per iteration"),
          objective_link:
            `The estimator "${paper.title}" names is the one the objective compares against.`,
        },
        outcome: {
          abstract_evidence: passage("reduces mean squared error at equal sample count"),
          objective_link:
            `The outcome "${paper.title}" reports is the metric the objective is scored on.`,
        },
      },
    },
  };
  return paper;
}

module.exports = { screenedPaper, SCREENED_ABSTRACT: ABSTRACT };
