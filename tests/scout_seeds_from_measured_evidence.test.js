"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildScoutQueryPlan } = require("../src/agents/scout/query_plan");
const { loadCycleEvidence } = require("../src/agents/shared/cycle_evidence");

// These tests describe the default literature path. The Docker image sets the
// approved scholarly network policy, which the test process must not inherit.
delete process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;

// Stage two built a resolver that prefers what a cycle MEASURED over what its
// field label implies. Stage three is what makes it true in practice: until a
// call site passes evidence, the resolver runs empty and the enumerated profile
// answers every time.
//
// The seeds are where this shows. The enumerated `bio` profile seeds biomedical
// repositories for anything whose prompt reads biomedical, which is how a
// graphics cycle ended up searching GEO. Seeds derived from the corpus the
// cycle actually retrieved cannot drift that way.

const CYCLE = "cg-gate-test-0001";

function cycleWith({ inventory = null, corpus = null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scout-evidence-"));
  const state = path.join(cwd, ".research-lab", "state");
  fs.mkdirSync(state, { recursive: true });
  if (inventory) {
    fs.writeFileSync(path.join(state, `${CYCLE}-instrument-inventory.json`), JSON.stringify(inventory));
  }
  if (corpus) {
    fs.writeFileSync(path.join(state, `${CYCLE}-literature.json`), JSON.stringify({ papers: corpus }));
  }
  return cwd;
}

function inCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(previous);
  }
}

test("a cycle that measured nothing still gets a plan", () => {
  // The loader must be forgiving: no probe yet is a cycle that has not got
  // there, not a failure. What answers now is the field-independent default,
  // and it says which it is -- there is no field-name profile behind it any
  // more, because that table had an entry for the fields someone listed and
  // handed everything else the observational one.
  const cwd = cycleWith();
  const plan = inCwd(cwd, () =>
    buildScoutQueryPlan({ prompt: "rendering algorithms", laneId: "scout-03", cycleId: CYCLE }),
  );
  assert.equal(plan.role, "scout");
  assert.ok(Array.isArray(plan.queries) || Array.isArray(plan.fallback_queries) || plan.objective);
  assert.ok(plan.profile_provenance, "the resolution is recorded even when nothing was measured");
  assert.equal(
    plan.profile_provenance.dataSeeds.source,
    "unmeasured-default",
    "with no corpus the field-independent default answered, and it says so",
  );
  // ...and it supplied no seeds at all rather than one field's repositories.
  assert.deepEqual(plan.data_seeds ?? [], []);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("the loader never throws on a missing or unreadable artifact", () => {
  const cwd = cycleWith();
  fs.writeFileSync(
    path.join(cwd, ".research-lab", "state", `${CYCLE}-literature.json`),
    "{ this is not json",
  );
  const evidence = loadCycleEvidence({ root: path.join(cwd, ".research-lab"), cycleId: CYCLE });
  assert.deepEqual(evidence.corpus, []);
  assert.equal(evidence.instrumentInventory, null);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("no root or cycle id yields empty evidence rather than an error", () => {
  assert.deepEqual(loadCycleEvidence({}), {
    instrumentInventory: null,
    venueStandard: null,
    corpus: [],
  });
  assert.deepEqual(loadCycleEvidence({ root: "/nowhere" }), {
    instrumentInventory: null,
    venueStandard: null,
    corpus: [],
  });
});

test("a measured instrument inventory reaches the plan", () => {
  // The probe measured what this container can actually do. That is the fact
  // the profile should be built from, and the plan should say so.
  const cwd = cycleWith({
    // The recorded shape, copied from a real inventory on disk: named
    // instruments as strings, and measurable quantities as prose.
    inventory: {
      inventory_version: 1,
      verified_instruments: [
        "procedural_scene_render",
        "seed_pinned_reproducibility",
        "matched_sample_budget_control",
        "counterfactual_edit_pairs",
      ],
      measurable_quantities: [
        "image error against a high-spp converged reference (RMSE, PSNR)",
        "quality at a matched sample budget, and wall-clock cost per budget",
      ],
      measured_absences: [],
    },
  });
  const plan = inCwd(cwd, () =>
    buildScoutQueryPlan({ prompt: "rendering algorithms", laneId: "scout-03", cycleId: CYCLE }),
  );
  assert.ok(plan.profile_provenance, "provenance is carried on the plan");
  assert.ok(
    plan.profile_intervention_mode,
    "a cycle with verified instruments has a measured mode, not just a field label",
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a corpus too small for tf-idf does not displace curated seeds", () => {
  // Measured on cycle-g-v89's own eight recorded papers: the derived seeds were
  // "optical, morfeo, adaptive, optics, reconstruction, powerful, synthesis,
  // instrumental" -- a function word, an instrument named in an off-topic
  // adaptive-optics paper, and nothing about rendering -- against a curated
  // "rendering, path tracing, Monte Carlo rendering, adaptive sampling".
  const { deriveProfile, MINIMUM_CORPUS_FOR_DERIVED_SEEDS } = require("../src/agents/shared/derived_profile");
  const eightPapers = [
    { title: "GS-ROR2: Bidirectional-guided 3DGS and SDF for Reflective Object Relighting", abstract: "3D Gaussian Splatting has shown" },
    { title: "Instrumental Variable Identification of Dynamic Variance Decompositions", abstract: "instrumental variable identification" },
    { title: "Sensitivity Analyses for Monte Carlo Sampling-Based Particle Simulations", abstract: "monte carlo sampling particle" },
    { title: "Seeing through Satellite Images at Street Views", abstract: "satellite street view synthesis" },
    { title: "Interfacing adaptive optics simulations with the optical model", abstract: "adaptive optics powerful optical morfeo" },
    { title: "SynIM: a GPU-accelerated Python library for synthetic interaction", abstract: "synthetic interaction matrices optical" },
    { title: "Information-guided optimization of image-based sensorless adaptive optics", abstract: "sensorless adaptive optics reconstruction" },
    { title: "Reproduction of Instrumental Variable Identification", abstract: "reproduction instrumental variable" },
  ];
  assert.ok(eightPapers.length < MINIMUM_CORPUS_FOR_DERIVED_SEEDS);
  const derived = deriveProfile({ corpus: eightPapers });
  assert.deepEqual(
    derived.profile.searchSeeds,
    [],
    "below the floor the derivation offers nothing, so the curated seeds answer",
  );

  // Above the floor it does derive, and the field's own vocabulary wins.
  const many = Array.from({ length: MINIMUM_CORPUS_FOR_DERIVED_SEEDS }, (_, i) => ({
    title: `Adaptive sampling for path tracing ${i}`,
    abstract: "path tracing variance reduction under a matched sample budget",
  }));
  const wide = deriveProfile({ corpus: many });
  assert.ok(wide.profile.searchSeeds.length > 0, "a corpus at the floor does derive seeds");
});
