"use strict";

// A requirement written for one domain phantom-fails every cycle in another.
//
// cycle-g-v89 wrote a CGF rendering manuscript, read the venue's instructions,
// and produced the single-paragraph abstract CGF asks for. `title_abstract_framing`
// scored it 80 with "structured abstract is incomplete or too terse". Separately,
// `statistical_reporting` looked for a "core concordance result" -- a correlation
// figure -- in a first-crossing benchmark that reports crossing error, clustered
// false-safe risk and a paired Wilcoxon p.
//
// The owner's decision was to waive on venue evidence, not on domain guesswork.
// So these tests pin both directions: the waiver opens only when the author
// actually read the venue and the venue actually says otherwise, and the gate is
// unchanged everywhere else.

const test = require("node:test");
const assert = require("node:assert");

const {
  venueEvidence,
  venueRequiresUnstructuredAbstract,
  abstractRequirement,
  coreResultRequirement,
  UNSTRUCTURED_ABSTRACT_MIN_CHARS,
} = require("../src/reporting/document_reviews/venue_fit");

const STRUCTURED = {
  background: "b".repeat(100),
  methods: "m".repeat(100),
  results: "r".repeat(100),
  interpretation: "i".repeat(100),
};

function readVenue(style) {
  return {
    name: "Computer Graphics Forum",
    guidelines_url: "https://www.eg.org/wp/eurographics-publications/guidelines/",
    checked_on: "2026-09-02",
    format: { abstract_style: style },
  };
}

test("a venue record without a URL and a date is not evidence", () => {
  // The author contract exists because a recalled venue policy has already been
  // wrong here. A record with no read behind it waives nothing.
  assert.equal(venueEvidence({}).read, false);
  assert.equal(
    venueEvidence({ target_venue: { name: "CGF", format: { abstract_style: "unstructured" } } }).read,
    false,
  );
  assert.equal(
    venueRequiresUnstructuredAbstract({
      target_venue: { name: "CGF", format: { abstract_style: "unstructured" } },
    }),
    false,
    "an unread policy cannot waive a requirement",
  );
  assert.equal(venueEvidence({ target_venue: readVenue("unstructured") }).read, true);
});

test("the structured-abstract requirement is unchanged when no venue says otherwise", () => {
  const check = abstractRequirement({}, { summary: "x".repeat(2000) });
  assert.equal(check.mode, "structured");
  assert.equal(check.satisfied, false, "a long paragraph does not satisfy the default requirement");
  assert.match(check.reason, /structured abstract is incomplete/);

  const ok = abstractRequirement({}, STRUCTURED);
  assert.equal(ok.satisfied, true);
});

test("an 'unknown' abstract style leaves the requirement in place", () => {
  // The contract tells the author to answer 'unknown' when the instructions do
  // not say. That is the honest answer and it must not be the cheap one.
  for (const style of ["unknown", "", "structured"]) {
    const paper = { target_venue: readVenue(style) };
    assert.equal(
      abstractRequirement(paper, { summary: "x".repeat(2000) }).mode,
      "structured",
      `abstract_style=${style} should not waive the requirement`,
    );
  }
});

test("a read venue that asks for one paragraph gets one paragraph judged on substance", () => {
  const paper = { target_venue: readVenue("unstructured") };
  const thin = abstractRequirement(paper, { summary: "x".repeat(UNSTRUCTURED_ABSTRACT_MIN_CHARS - 1) });
  assert.equal(thin.mode, "unstructured");
  assert.equal(thin.satisfied, false, "the waiver is on structure, not on content");
  assert.match(thin.reason, /Computer Graphics Forum/);
  assert.match(thin.reason, /rather than for less content/);

  const full = abstractRequirement(paper, { summary: "x".repeat(UNSTRUCTURED_ABSTRACT_MIN_CHARS) });
  assert.equal(full.satisfied, true);
  assert.equal(full.venue, "Computer Graphics Forum");
  assert.equal(full.checked_on, "2026-09-02");
});

test("a concordance figure still satisfies the core-result requirement", () => {
  // The biomedical path is not removed; it is one way of satisfying the rule.
  const paper = { results: ["recomputation correlation r=0.984 against the source table"] };
  const check = coreResultRequirement(paper);
  assert.equal(check.satisfied, true);
  assert.equal(check.via, "concordance");
});

test("artifact-bound numbers with an uncertainty statement satisfy it too", () => {
  const paper = {
    numbers_manifest: [
      { value: "0.0", source_artifact: "/a/summary.csv" },
      { value: "0.75", source_artifact: "/a/summary.csv" },
      { value: "p = 0.00020", source_artifact: "/a/decision.json" },
    ],
    results: ["paired one-sided Wilcoxon p = 0.00020 against deterministic bisection"],
  };
  const check = coreResultRequirement(paper);
  assert.equal(check.satisfied, true);
  assert.equal(check.via, "artifact_bound_primary_result");
  assert.equal(check.bound_numbers, 3);
});

test("numbers without uncertainty, or uncertainty without numbers, do not satisfy it", () => {
  const noUncertainty = coreResultRequirement({
    numbers_manifest: [
      { value: "1", source_artifact: "/a.csv" },
      { value: "2", source_artifact: "/a.csv" },
      { value: "3", source_artifact: "/a.csv" },
    ],
    results: ["three counts"],
  });
  assert.equal(noUncertainty.satisfied, false);
  assert.match(noUncertainty.reason, /uncertainty statement/);

  const unbound = coreResultRequirement({
    numbers_manifest: [{ value: "0.75", source_artifact: "" }],
    results: ["p = 0.01 somewhere"],
  });
  assert.equal(unbound.satisfied, false, "a number nobody can trace is not a reported result");
  assert.equal(unbound.bound_numbers, 0);
});

test("the failure message names both routes rather than only the biomedical one", () => {
  const check = coreResultRequirement({ results: ["no numbers here"] });
  assert.equal(check.satisfied, false);
  assert.match(check.reason, /concordance or correlation/);
  assert.match(check.reason, /three artifact-bound numbers/);
});

// One gate requiring what another gate disqualifies is not a standard.
//
// The illustrator drew its figures from the source CSVs with a script it wrote,
// which is what the figure gate now requires and what it scored 100 for. The
// integration gate then failed the same figures for not being flattened exports
// from a PowerPoint deck -- a workflow ACM TOG, whose template includes image
// files, never asks for.

const { venueUsesDirectFigureInsertion } = require("../src/reporting/document_reviews/venue_fit");

test("the deck workflow is waived only when a read venue says figures are image files", () => {
  assert.equal(venueUsesDirectFigureInsertion({}), false);
  assert.equal(
    venueUsesDirectFigureInsertion({
      target_venue: { name: "TOG", format: { figure_submission: "direct_image_files" } },
    }),
    false,
    "an unread venue record waives nothing",
  );
  for (const submission of ["figure_deck", "unknown", "", undefined]) {
    assert.equal(
      venueUsesDirectFigureInsertion({ target_venue: { ...readVenue("unknown"), format: { figure_submission: submission } } }),
      false,
      `figure_submission=${submission} keeps the deck requirement`,
    );
  }
  assert.equal(
    venueUsesDirectFigureInsertion({
      target_venue: { ...readVenue("unknown"), format: { figure_submission: "direct_image_files" } },
    }),
    true,
  );
});

// The author's citations have to land where the rubric reads them.
//
// cycle-g-v89's author produced seven graphics papers with DOIs. They went into
// `authored_references`, the rubric reads `references`, and the gate reported
// "reference list needs at least 5 article references" against an empty list.
// The work was done and the review could not see it.

const { applyAuthoredDocument } = require("../src/reporting/document_artifacts/authored");

test("authored references land in the field the rubric reads", () => {
  const paper = {
    references: [
      { type: "dataset", title: "Cycle source data", doi: "10.5281/example" },
      { type: "article", title: "template placeholder" },
    ],
  };
  applyAuthoredDocument(paper, {
    manuscript: {
      references: [
        { key: "xu2024", citation: "Xu et al. 2024. Residual path integrals for re-rendering." },
        { key: "hua2019", citation: "Hua et al. 2019. A survey on gradient-domain rendering." },
      ],
    },
    figures: [],
    figure_panels: [],
    numbers_manifest: [],
    figure_coverage_check: [],
    provenance: {},
  });

  const keys = paper.references.map((item) => item.key || item.type);
  assert.deepEqual(keys, ["dataset", "xu2024", "hua2019"]);
  assert.equal(
    paper.references.filter((item) => String(item.type).toLowerCase() === "dataset").length,
    1,
    "dataset provenance the author does not re-derive is kept",
  );
  assert.equal(paper.authored_references.length, 2, "the authored list stays available on its own");
});

test("a manuscript with no references leaves the template list alone", () => {
  const paper = { references: [{ type: "dataset", title: "Cycle source data" }] };
  applyAuthoredDocument(paper, {
    manuscript: { references: [] },
    figures: [],
    figure_panels: [],
    numbers_manifest: [],
    figure_coverage_check: [],
    provenance: {},
  });
  assert.equal(paper.references.length, 1);
});
