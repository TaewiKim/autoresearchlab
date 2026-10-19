"use strict";

// A check a template can satisfy is a check that measures nothing.
//
// MEASURED ON cycle-g-v90. 252 papers were admitted to a COMPUTER GRAPHICS
// corpus as `directly_relevant`, and among them:
//
//     EEG is better left alone                  (Scientific Reports)
//     Trends in using deep learning algorithms in biomedical prediction systems
//     2D-to-3D Image Reconstruction in Agriculture
//     Intelligent Defect Detection of Ancient City Walls
//
// Every structural check passed on all of them, because every structural check
// was satisfiable without reading anything:
//
//     252 of 252  supporting_passage was the ENTIRE abstract
//                 -- `abstract.includes(quote)` is free when quote IS abstract
//     252 of 252  all three linkage dimensions quoted the SAME sentence
//       4 values  distinct direct_relevance_reason across 252 papers (70% shared one)
//      15 values  distinct objective_link across 756 links (top three: 176 each)
//
// The EEG paper's receipt read: reason "Abstract directly links a rendering
// procedure to measured rendering quality or performance"; method linkage
// evidence "Automated preprocessing methods are critically needed to process the
// large publicly-available EEG databases"; method objective_link "The abstract
// identifies an implemented rendering algorithm or procedure used in the study."
//
// The hashes were real. The quote was genuinely in the abstract. The reviewer
// was named. Only the judgment was absent -- which is the failure mode
// provenance-bound admission exists to prevent, arriving with its provenance
// intact.

const test = require("node:test");
const assert = require("node:assert");

const {
  isScreenedEvidence,
  filterScreenedEvidence,
  templatedReviewKeys,
} = require("../src/policy/literature_screening");
const { screenedPaper } = require("./helpers/screened_paper");

const OBJECTIVE = "improve adaptive sampling for Monte Carlo path tracing";

function valid(overrides = {}) {
  return screenedPaper(OBJECTIVE, overrides);
}

/** Rewrite one field inside a valid receipt's review. */
function withReview(paper, mutate) {
  const copy = JSON.parse(JSON.stringify(paper));
  mutate(copy.literature_screening.review);
  return copy;
}

test("a fixture that should pass, passes", () => {
  assert.equal(isScreenedEvidence(valid(), { objective: OBJECTIVE }), true);
});

test("pasting the whole abstract back is not a supporting passage", () => {
  // What all 252 v90 reviews did. The old check only asked that the quote be IN
  // the abstract, which the abstract satisfies perfectly.
  const paper = withReview(valid(), (review) => {
    review.supporting_passage = paper0Abstract();
  });
  assert.equal(isScreenedEvidence(paper, { objective: OBJECTIVE }), false);
});

function paper0Abstract() {
  return valid().abstract;
}

test("three linkage dimensions answered with one sentence is not three answers", () => {
  const paper = withReview(valid(), (review) => {
    const one = review.linkage.study_task.abstract_evidence;
    review.linkage.method.abstract_evidence = one;
    review.linkage.outcome.abstract_evidence = one;
  });
  assert.equal(isScreenedEvidence(paper, { objective: OBJECTIVE }), false);
});

test("three objective links that are the same link is not three links", () => {
  const paper = withReview(valid(), (review) => {
    const one = review.linkage.study_task.objective_link;
    review.linkage.method.objective_link = one;
    review.linkage.outcome.objective_link = one;
  });
  assert.equal(isScreenedEvidence(paper, { objective: OBJECTIVE }), false);
});

test("a reason reused word-for-word for another paper is a template", () => {
  const shared = "Abstract directly links a rendering procedure to measured rendering quality or performance.";
  const a = withReview(valid({ title: "Paper A", doi: "10.1/a" }), (review) => {
    review.direct_relevance_reason = shared;
  });
  const b = withReview(valid({ title: "Paper B", doi: "10.1/b" }), (review) => {
    review.direct_relevance_reason = shared;
  });

  // Each is individually well formed -- that is exactly the problem.
  assert.equal(isScreenedEvidence(a, { objective: OBJECTIVE }), true);
  assert.equal(isScreenedEvidence(b, { objective: OBJECTIVE }), true);

  assert.deepEqual([...templatedReviewKeys([a, b])], [shared]);
  assert.deepEqual(filterScreenedEvidence([a, b], { objective: OBJECTIVE }), []);
});

test("papers each reviewed on their own terms all survive the batch", () => {
  const papers = ["A", "B", "C"].map((n, i) => valid({ title: `Paper ${n}`, doi: `10.1/${i}` }));
  assert.equal(filterScreenedEvidence(papers, { objective: OBJECTIVE }).length, 3);
  assert.equal(templatedReviewKeys(papers).size, 0);
});

test("the off-topic paper v90 admitted is refused on its real receipt", () => {
  // Verbatim from the cycle-g-v90 artifact, shortened only in the abstract.
  const abstract = [
    "Automated preprocessing methods are critically needed to process the large",
    "publicly-available EEG databases, but the optimal approach remains unknown",
    "because we lack data quality metrics to compare them. Here, we designed a",
    "simple yet robust EEG data quality metric assessing the percentage of",
    "significant channels between two experimental conditions.",
  ].join(" ");
  const sentence = "Automated preprocessing methods are critically needed to process the large";

  const paper = valid({ title: "EEG is better left alone", doi: "10.1038/s41598-023-27528-0", abstract });
  const eeg = withReview(paper, (review) => {
    review.direct_relevance_reason =
      "Abstract directly links a rendering procedure to measured rendering quality or performance.";
    review.supporting_passage = abstract;
    for (const dimension of ["study_task", "method", "outcome"]) {
      review.linkage[dimension].abstract_evidence = sentence;
    }
  });

  assert.equal(
    isScreenedEvidence(eeg, { objective: OBJECTIVE }),
    false,
    "a study of EEG preprocessing was admitted to a rendering corpus",
  );
});
