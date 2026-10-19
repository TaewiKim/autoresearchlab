"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyReviewBlockers } = require("../src/reporting/research_note_utils");

test("research note blocker classification separates resolved stale blockers from active science blockers", () => {
  const classified = classifyReviewBlockers([
    "Independent hypothesis gate: No lead hypothesis is present, so there is nothing scientifically falsifiable to approve.",
    "Independent hypothesis gate: No validation evidence exists: there are zero evidence packets.",
    "Resolved prior blockers: a lead GSE282742 hypothesis now exists, the fetched bundle is selected, and validation artifacts are present; still blocking: executed analyses do not test the stated claim.",
    "The executed validation does not test the stated claim: no DESeq2, no pathway scoring, and no grouped nested CV were run.",
    "The executed validation does not test the stated claim: no DESeq2, no pathway scoring, and no grouped nested CV were run.",
  ], {
    hasLeadHypothesis: true,
    hasDataset: true,
    hasValidationEvidence: true,
  });

  assert.equal(classified.stale_blocker_count, 2);
  assert.equal(classified.duplicate_blocker_count, 1);
  assert.match(classified.resolved_or_superseded_blockers.join("\n"), /No lead hypothesis/);
  assert.match(classified.active_blockers.join("\n"), /executed analyses do not test/);
  assert.match(classified.active_blockers.join("\n"), /executed validation does not test/);
});

test("research note blocker classification scopes prior accession audit blockers away from current lead", () => {
  const classified = classifyReviewBlockers([
    "Still blocking: the incumbent GSE282742 family does not materially exceed the same-dataset baseline.",
    "No exact 8-gene grouped benchmark was run for GSE282742.",
    "If you pivot to GSE289864, define the exact same-dataset baseline and falsification trigger.",
    "mandatory omics/high-dimensional analysis only completed repository inventory/CSV profiling; it must run a repository-native workflow/skill/domain command",
  ], {
    hasLeadHypothesis: true,
    hasDataset: true,
    hasValidationEvidence: true,
    currentLeadHypothesis: {
      statement: "In GSE289864, recurrent anti-PD1-treated glioblastoma has a tumor-immune resistance program.",
      dataset_or_accession: "GSE289864",
    },
  });

  assert.doesNotMatch(classified.active_blockers.join("\n"), /GSE282742|8-gene|If you pivot/);
  assert.match(classified.active_blockers.join("\n"), /repository-native workflow/);
  assert.match(classified.resolved_or_superseded_blockers.join("\n"), /GSE282742|8-gene|If you pivot/);
});
