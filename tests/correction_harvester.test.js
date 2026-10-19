"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  harvestCorrections,
  mergeIntoOverlay,
  renderPatchSummary,
} = require("../src/agents/shared/correction_harvester");
const { buildCanonicalReference } = require("../src/agents/shared/canonical_reference");

const canonicalReference = {
  incumbent_family: "autoimmune proteomic severity gradient",
  families: [{ family_root: "autoimmune proteomic severity gradient" }],
  reference_notes: {
    "autoimmune proteomic severity gradient": {
      family_root: "autoimmune proteomic severity gradient",
      gotchas: ["batch effect not controlled"],
      routing_triggers: [],
    },
  },
};

test("harvests gate-review and telemetry signals into family-keyed patches", () => {
  const harvest = harvestCorrections({
    gateReview: {
      challenge_questions: ["Is the rival-explanation test still missing?"],
      incumbent_rejection_reasons: ["single-source evidence only"],
    },
    evalTelemetry: [
      { domain: "omics", passed: false, accuracy: 0.5, canonical_resolution_rate: 0.5 },
    ],
    canonicalReference,
  });

  const patch = harvest.patches["autoimmune proteomic severity gradient"];
  assert.ok(patch, "patch keyed to incumbent family");
  assert.match(patch.add_routing_triggers.join("\n"), /rival-explanation test/i);
  assert.match(patch.add_gotchas.join("\n"), /single-source evidence/i);
  assert.match(patch.add_gotchas.join("\n"), /eval gate failed/i);
});

test("does not re-propose a gotcha already curated in the overlay", () => {
  const harvest = harvestCorrections({
    gateReview: { major_objections: ["batch effect not controlled"] },
    canonicalReference,
  });
  // The only signal duplicates an existing curated gotcha -> no patch produced.
  assert.equal(Object.keys(harvest.patches).length, 0);
});

test("counts recurring signals and tags them", () => {
  const harvest = harvestCorrections({
    gateReview: {
      gate_scientific_blockers: ["confounding unaddressed", "confounding unaddressed"],
    },
    canonicalReference,
  });
  const patch = harvest.patches["autoimmune proteomic severity gradient"];
  assert.match(patch.add_gotchas.join("\n"), /confounding unaddressed \[recurring ×2\]/);
});

test("mergeIntoOverlay unions patches onto an existing overlay and round-trips through the builder", () => {
  const harvest = harvestCorrections({
    gateReview: { switch_triggers: ["rival family now has stronger validated edges"] },
    canonicalReference,
  });
  const overlay = mergeIntoOverlay({}, harvest.patches);
  assert.match(
    overlay["autoimmune proteomic severity gradient"].routing_triggers.join("\n"),
    /rival family now has stronger/i,
  );

  // The merged overlay must actually surface through canonical_reference.
  const graph = {
    nodes: [
      {
        id: "family:autoimmune proteomic severity gradient",
        metadata: { family_root: "autoimmune proteomic severity gradient" },
      },
    ],
    edges: [],
  };
  const ref = buildCanonicalReference({ dataGraph: graph, referenceNotesOverlay: overlay });
  const notes = ref.reference_notes["autoimmune proteomic severity gradient"];
  assert.equal(notes.curated, true);
  assert.match(notes.routing_triggers.join("\n"), /rival family now has stronger/i);
});

test("renderPatchSummary is stable and reports empty cleanly", () => {
  const empty = renderPatchSummary({ signals_seen: 0, patches: {} });
  assert.match(empty, /nothing to patch/i);
  const summary = renderPatchSummary(
    harvestCorrections({ gateReview: { major_objections: ["x objection"] }, canonicalReference }),
  );
  assert.match(summary, /## Family: autoimmune proteomic severity gradient/);
  assert.match(summary, /x objection/);
});
