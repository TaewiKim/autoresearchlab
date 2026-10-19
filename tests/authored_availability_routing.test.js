"use strict";

// "Data and Code Availability" matched the METHODS pattern on the word `data`.
//
// So on cycle-g-v89 the author's availability statement was filed into Methods,
// the paper kept the template list, and the template prints absolute paths under
// /opt/researchlab/.research-lab at a double-anonymous venue -- while the
// author's own statement, in the same result.json, cited `artifacts/01-check.json`
// and named no machine path at all.
//
// These pin the routing and the one case where the template is allowed to stand.

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyAuthoredSectionsToImrad } = require("../src/reporting/document_artifacts/authored");

const TEMPLATE_AVAILABILITY = [
  "Primary runner result: /opt/researchlab/.research-lab/artifacts/stats/cycle/followup-runner-128/result.json.",
];

function paperWithTemplate() {
  return { data_code_availability: [...TEMPLATE_AVAILABILITY] };
}

test("the author's availability statement replaces the template, and never lands in Methods", () => {
  const paper = paperWithTemplate();
  applyAuthoredSectionsToImrad(paper, [
    { heading: "3. Methods", text: "The benchmark sweeps eight severity levels." },
    {
      heading: "7. Data and Code Availability",
      text: "Primary values are regenerated from `artifacts/01-check.json`.",
    },
  ]);

  assert.deepEqual(paper.data_code_availability, [
    "Primary values are regenerated from `artifacts/01-check.json`.",
  ]);
  assert.equal(paper.methods.join(" ").includes("artifacts/01-check.json"), false);
  assert.equal(paper.methods.join(" "), "The benchmark sweeps eight severity levels.");
});

test("availability is reported as its own destination, not as an IMRaD field", () => {
  const paper = paperWithTemplate();
  applyAuthoredSectionsToImrad(paper, [
    { heading: "7. Data and Code Availability", text: "Artifacts ship with the submission." },
  ]);
  assert.deepEqual(paper.authored_imrad_routing, [
    { heading: "7. Data and Code Availability", routed_to: "data_code_availability" },
  ]);
});

test("with no availability section the template stands", () => {
  // Unlike the body fields, this one is not emptied. The rubric scores it, and a
  // blank statement would read as a manuscript with no availability policy
  // rather than as one whose author did not write it.
  const paper = paperWithTemplate();
  applyAuthoredSectionsToImrad(paper, [
    { heading: "4. Results", text: "The crossing severity is 5." },
  ]);
  assert.deepEqual(paper.data_code_availability, TEMPLATE_AVAILABILITY);
});

test("a section after availability does not inherit availability as its destination", () => {
  // Unmatched sections fall to the field of the section they follow. Availability
  // is not one of those fields, so an unheaded appendix after it belongs to the
  // last IMRaD field instead.
  const paper = paperWithTemplate();
  applyAuthoredSectionsToImrad(paper, [
    { heading: "6. Limitations", text: "Two scene families were held out." },
    { heading: "7. Data and Code Availability", text: "Artifacts ship with the submission." },
    { heading: "8. Appendix", text: "Per-seed dispersion is tabulated." },
  ]);
  assert.deepEqual(paper.data_code_availability, ["Artifacts ship with the submission."]);
  assert.deepEqual(paper.limitations, [
    "Two scene families were held out.",
    "Per-seed dispersion is tabulated.",
  ]);
});

test("a followup author lane owns the document, and its claim declarations reach the paper", () => {
  // Lanes the dispatcher opens later are named `followup-<role>-NN`, and only
  // `<role>-NN` was matched. So followup-author-02 listed the sham that
  // reproduced its own result, the paper still read "not stated", and the gate
  // raised the same blocker against a manuscript that had already answered it.
  const { collectAuthoredDocument, applyAuthoredDocument } = require("../src/reporting/document_artifacts/authored");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authored-followup-"));
  const cycleId = "cycle";
  const lane = path.join(root, "lanes", cycleId, "followup-author-02");
  fs.mkdirSync(lane, { recursive: true });
  fs.writeFileSync(
    path.join(lane, "result.json"),
    JSON.stringify({
      extracted_json: {
        manuscript: { title: "A paper", sections: [] },
        contribution_type: "benchmark",
        controls_that_reproduce_the_result: ["severity-label sham"],
        baselines: [{ name: "bisection", kind: "implementation" }],
        evaluation_scale: { described: "64x64", matches_venue_norm: false },
        withdrawn_claims: ["residual correlation predicts the boundary"],
        next_approach: { approach: "condition on dispersion", derived_from: "27 arms missed 0.10" },
        refutes: { claim: "residuals localize the boundary" },
      },
    }),
    "utf8",
  );

  const authored = collectAuthoredDocument({ root, cycleId });
  assert.ok(authored, "a followup author lane has to be found at all");
  assert.deepEqual(authored.controls_that_reproduce_the_result, ["severity-label sham"]);

  const paper = applyAuthoredDocument({ title: "template" }, authored);
  assert.equal(paper.contribution_type, "benchmark");
  assert.deepEqual(paper.controls_that_reproduce_the_result, ["severity-label sham"]);
  assert.deepEqual(paper.withdrawn_claims, ["residual correlation predicts the boundary"]);
  assert.equal(paper.next_approach.approach, "condition on dispersion");
  assert.equal(paper.evaluation_scale.matches_venue_norm, false);
  assert.equal(paper.refutes.claim, "residuals localize the boundary");
  assert.equal(paper.baselines.length, 1);
});

test("an empty controls list is an assertion, and reaches the paper as one", () => {
  const { applyAuthoredDocument } = require("../src/reporting/document_artifacts/authored");
  const paper = applyAuthoredDocument({}, {
    figures: [],
    controls_that_reproduce_the_result: [],
    provenance: {},
  });
  assert.deepEqual(paper.controls_that_reproduce_the_result, []);
});

test("a partial revision adds to the manuscript instead of replacing it", () => {
  // Followup author lanes answer one blocker at a time and return a partial
  // manuscript. The paper is rebuilt from the TEMPLATE each pass, so whatever the
  // newest lane did not supply fell back to boilerplate rather than to what the
  // previous lane wrote. Sixteen of them ground a complete manuscript -- seven
  // sections, seven references -- down to none of either, and lost the sham
  // declaration made in round two along the way.
  const { collectAuthoredDocument } = require("../src/reporting/document_artifacts/authored");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authored-fold-"));
  const cycleId = "cycle";
  const writeLane = (name, extracted, mtime) => {
    const dir = path.join(root, "lanes", cycleId, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "result.json");
    fs.writeFileSync(file, JSON.stringify({ extracted_json: extracted }), "utf8");
    fs.utimesSync(file, mtime, mtime);
  };

  writeLane("author-01", {
    manuscript: {
      title: "A complete manuscript",
      sections: [{ heading: "4. Results", text: "The crossing severity is 5." }],
      references: [{ title: "Prior work", doi: "10.1/x" }],
    },
    numbers_manifest: [{ value: "0.44", source_artifact: "/tmp/a.csv" }],
  }, new Date(Date.now() - 60_000));

  writeLane("followup-author-02", {
    controls_that_reproduce_the_result: ["severity-label sham"],
  }, new Date(Date.now() - 30_000));

  writeLane("followup-author-03", {
    contribution_type: "benchmark",
  }, new Date());

  const authored = collectAuthoredDocument({ root, cycleId });
  // The newest lane's answer is there.
  assert.equal(authored.contribution_type, "benchmark");
  // So is the one before it, which the newest lane never mentioned.
  assert.deepEqual(authored.controls_that_reproduce_the_result, ["severity-label sham"]);
  // And so is the manuscript neither of them touched.
  assert.equal(authored.manuscript.title, "A complete manuscript");
  assert.equal(authored.manuscript.sections.length, 1);
  assert.equal(authored.manuscript.references.length, 1);
  assert.equal(authored.numbers_manifest.length, 1);
});

test("a later lane still overrides the field it actually supplies", () => {
  const { collectAuthoredDocument } = require("../src/reporting/document_artifacts/authored");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authored-override-"));
  const cycleId = "cycle";
  const writeLane = (name, extracted, mtime) => {
    const dir = path.join(root, "lanes", cycleId, name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "result.json");
    fs.writeFileSync(file, JSON.stringify({ extracted_json: extracted }), "utf8");
    fs.utimesSync(file, mtime, mtime);
  };

  writeLane("author-01", { contribution_type: "method", manuscript: { title: "First" } }, new Date(Date.now() - 60_000));
  writeLane("followup-author-02", { contribution_type: "negative_result", manuscript: { title: "Second" } }, new Date());

  const authored = collectAuthoredDocument({ root, cycleId });
  assert.equal(authored.contribution_type, "negative_result");
  assert.equal(authored.manuscript.title, "Second");
});
