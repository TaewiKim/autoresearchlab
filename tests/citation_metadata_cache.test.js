"use strict";

// The quality gate's second door had no handle on the outside.
//
// `hasQualityEvidence` offers four alternative tracks. `recent_frontier` needs
// only a publication date; verified citation count, verified field-normalized
// percentile and verified Q1 venue metric all need a measurement WITH
// provenance. Nothing attached those measurements before the gate ran, so only
// the recency track was reachable in practice.
//
// MEASURED ON cycle-g-v91: 107 of 109 accepted papers came in on recency, 3 on
// established impact, and nothing older than 2021 was admitted at all. 90 of the
// 109 carried no citation count of any kind -- arXiv supplied 92 of them and
// gives a count on 2. The scout then recorded that the foundational literature
// "lacks accepted full-abstract evidence", declared its search incomplete, and
// twelve downstream lanes waited on a scout that could never complete.
//
// An enrichment component did exist. It called OpenAlex, received a response
// carrying `cited_by_count`, discarded the field while normalizing -- and ran at
// literature_synthesis.js:373, AFTER filterScreenedEvidence at :321, where it
// cannot help a paper the gate has already dropped.
//
// These tests pin the contract from the JS side: what the gate requires of an
// attached measurement, and that a paper only ever moves from inadmissible to
// admissible by gaining evidence, never by the bar moving.

const test = require("node:test");
const assert = require("node:assert");

const { hasQualityEvidence, isScreenedEvidence } = require("../src/policy/literature_screening");
const { screenedPaper } = require("./helpers/screened_paper");

const OBJECTIVE = "improve adaptive sampling for Monte Carlo path tracing";

/** The real foundational paper the v91 scout named and could not admit. */
function foundationalPaper(extra = {}) {
  return {
    title: "Real-time neural radiance caching for path tracing",
    doi: "10.1145/3450626.3459812",
    year: 2021,
    journal: "ACM Transactions on Graphics",
    ...extra,
  };
}

const NOW = new Date("2026-09-12T00:00:00Z");

test("a foundational paper with no measurement clears no track", () => {
  assert.equal(hasQualityEvidence(foundationalPaper(), NOW), false);
});

test("the citation evidence the cache attaches is exactly what the gate accepts", () => {
  // Byte-for-byte the record citation_metadata.py writes, verified live against
  // OpenAlex: cited_by_count 134, source_url https://openalex.org/W3176679482.
  const paper = foundationalPaper({
    cited_by_count: 134,
    citation_count_provenance: {
      value: 134,
      source: "openalex",
      source_url: "https://openalex.org/W3176679482",
      observed_at: "2026-09-12",
    },
  });
  assert.equal(hasQualityEvidence(paper, NOW), true);
});

test("a count without provenance is a claim, not a measurement", () => {
  assert.equal(hasQualityEvidence(foundationalPaper({ cited_by_count: 134 }), NOW), false);
});

test("provenance that does not match the count it vouches for is refused", () => {
  // The gate requires citation.value === paper.cited_by_count, so a record
  // written for one paper cannot be attached to another.
  const paper = foundationalPaper({
    cited_by_count: 134,
    citation_count_provenance: {
      value: 3997,
      source: "openalex",
      source_url: "https://openalex.org/W4210000000",
      observed_at: "2026-09-12",
    },
  });
  assert.equal(hasQualityEvidence(paper, NOW), false);
});

test("a stale cached count can only exclude, never admit", () => {
  // Why the cache is kept indefinitely: a citation count only grows, so an old
  // observation understates impact. Below the bar it stays out -- which is the
  // conservative direction -- and it can never carry a paper in on a number the
  // paper does not have.
  const belowBar = foundationalPaper({
    cited_by_count: 99,
    citation_count_provenance: {
      value: 99,
      source: "openalex",
      source_url: "https://openalex.org/W3176679482",
      observed_at: "2019-01-01",
    },
  });
  assert.equal(hasQualityEvidence(belowBar, NOW), false);

  // The same paper, re-read after it crossed the threshold.
  const refreshed = foundationalPaper({
    cited_by_count: 134,
    citation_count_provenance: {
      value: 134,
      source: "openalex",
      source_url: "https://openalex.org/W3176679482",
      observed_at: "2026-09-12",
    },
  });
  assert.equal(hasQualityEvidence(refreshed, NOW), true);
});

test("attached evidence admits a screened foundational paper end to end", () => {
  // The gate is unchanged; only the evidence is now present when it runs.
  const base = screenedPaper(OBJECTIVE, foundationalPaper());
  // screenedPaper builds its receipt for a recent paper, so strip the recency
  // route and leave the established-impact one.
  const aged = { ...base, year: 2021, publication_date: "2021-07-01" };
  assert.equal(isScreenedEvidence(aged, { objective: OBJECTIVE, now: NOW }), false);

  const enriched = {
    ...aged,
    cited_by_count: 134,
    citation_count_provenance: {
      value: 134,
      source: "openalex",
      source_url: "https://openalex.org/W3176679482",
      observed_at: "2026-09-12",
    },
  };
  assert.equal(isScreenedEvidence(enriched, { objective: OBJECTIVE, now: NOW }), true);
});
