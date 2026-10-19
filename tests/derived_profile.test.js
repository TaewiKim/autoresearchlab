"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  deriveProfile,
  interventionCapability,
  corpusSearchSeeds,
} = require("../src/agents/shared/derived_profile");

// The live cycle-g-v89 inventory, trimmed. Every field here was written by a
// probe that ran in the container, including what it looked for and did not
// find.
const RENDER_INVENTORY = {
  instruments: [
    {
      instrument: "procedural_scene_render",
      question: "Can a scene built in memory be rendered to a finite radiance array?",
      probe_ran: true,
      capability_present: true,
      measured: { shape: [48, 48, 3], mean_radiance: 0.050057, wall_s: 2.967 },
    },
    {
      instrument: "seed_pinned_reproducibility",
      question: "Does a pinned seed reproduce the same image bitwise?",
      probe_ran: true,
      capability_present: true,
    },
    {
      instrument: "matched_sample_budget_control",
      question: "Can two methods be compared at a matched sample budget?",
      probe_ran: true,
      capability_present: true,
    },
    {
      instrument: "counterfactual_edit_pairs",
      question: "Can one isolated scene edit be applied and its effect measured?",
      probe_ran: true,
      capability_present: true,
    },
  ],
  measurable_quantities: [
    "image error against a high-spp converged reference (RMSE, PSNR)",
    "quality at a matched sample budget, and wall-clock cost per budget",
  ],
  measured_absences: [
    { instrument: "per_path_telemetry_hooks", why: "No per-path telemetry callback is exposed." },
  ],
};

// The same shape for a cycle that can only read what was already collected.
const COHORT_INVENTORY = {
  instruments: [
    {
      instrument: "recorded_cohort_table",
      question: "Can the archival registry cohort be loaded as a table?",
      probe_ran: true,
      capability_present: true,
    },
    {
      instrument: "survey_panel_join",
      question: "Can the observational survey panel be joined to the cohort?",
      probe_ran: true,
      capability_present: true,
    },
  ],
  measurable_quantities: ["outcome rates per recorded subgroup"],
};

// The judgement that replaces the domain label. Nothing here names a field.
test("a cycle that can set the independent variable is experimental", () => {
  const capability = interventionCapability(RENDER_INVENTORY);
  assert.equal(capability.mode, "interventional");
  assert.match(capability.reason, /setting the independent variable/);
});

test("a cycle that can only read recorded data is observational", () => {
  const capability = interventionCapability(COHORT_INVENTORY);
  assert.equal(capability.mode, "observational");
});

test("no verified instrument yields no mode, and no guess", () => {
  for (const inventory of [null, {}, { instruments: [{ instrument: "x", probe_ran: false }] }]) {
    const capability = interventionCapability(inventory);
    assert.equal(capability.mode, null, "an unprobed instrument is a promise, not a capability");
  }
});

// The decisive test for the whole design: the graphics profile has to fall out
// of the recorded evidence without the derivation naming graphics anywhere.
test("the live inventory derives an experimental profile with no domain word", () => {
  const { profile, provenance, usable } = deriveProfile({ instrumentInventory: RENDER_INVENTORY });
  assert.equal(usable, true);
  assert.equal(profile.intervention_mode, "interventional");
  assert.equal(provenance.identity.source, "derived");
  // The hints are the probe's own words, not a list written into the runtime.
  assert.deepEqual(profile.hints, RENDER_INVENTORY.measurable_quantities);
  assert.equal(profile.measured_absences[0].instrument, "per_path_telemetry_hooks");

  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "agents", "shared", "derived_profile.js"),
    "utf8",
  );
  // The derivation may DISCUSS the enumerated profiles it replaces -- the record
  // of why this module exists is worth keeping and reaches no agent. What it
  // must not do is DECIDE anything from a field name, so comments come out
  // before the check rather than only the header.
  const logic = (source.split("function asArray")[1] || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  for (const domainWord of ["graphics", "rendering", "omics", "transcriptom", "epidemiolog"]) {
    assert.ok(
      !logic.toLowerCase().includes(domainWord),
      `the derivation must not branch on "${domainWord}"`,
    );
  }
});

// A slot with no evidence is reported as missing, not filled from a list. This
// is the half that `generic` got wrong: it supplied econometrics silently.
test("slots with no evidence say so rather than guessing", () => {
  const { profile, provenance } = deriveProfile({ instrumentInventory: RENDER_INVENTORY });
  assert.equal(provenance.evaluation_norm.source, "unavailable");
  assert.equal(profile.evaluation_norm, null);
  assert.equal(provenance.designShift.source, "unavailable");
  assert.match(provenance.designShift.reason, /weakest slot/);
});

test("an unprobed cycle produces no usable profile at all", () => {
  const { usable, provenance } = deriveProfile({});
  assert.equal(usable, false, "hypothesis generation must not proceed on a guessed profile");
  assert.equal(provenance.identity.source, "unavailable");
});

// Ranking a corpus by raw frequency returns function words. Measured on the live
// 116-paper corpus it gave ["from","model","results","which","paper",...].
test("corpus terms are ranked by distinctiveness, not by frequency", () => {
  const corpus = [];
  for (let i = 0; i < 20; i += 1) {
    corpus.push({
      title: `a study of the results from the model which we present in this paper`,
      abstract: i < 6 ? "photon mapping across scenes with photon mapping budgets" : "generic filler text here",
    });
  }
  const seeds = corpusSearchSeeds(corpus, 6);
  assert.ok(seeds.includes("photon"), "a term concentrated in few documents is the field's vocabulary");
  for (const functionWord of ["from", "which", "this", "results"]) {
    assert.ok(!seeds.includes(functionWord), `"${functionWord}" is language, not a field`);
  }
});

// The enumerated registry is gone. What used to be tested here -- that
// `domainProfile("cs")` answers with a rendering identity and that an unlisted
// field silently falls back to the statistician default -- was a record of the
// behaviour this module was built to replace, and there is nothing left to
// record.

// --- stage 2: the resolver decides -----------------------------------------

const { resolveProfile, deriveBlueprintRules } = require("../src/agents/shared/derived_profile");

// A field nobody enumerated, whose instruments plainly intervene. Today this
// objective resolves to `generic`: a statistician identity and
// difference-in-differences design shifts.
const ROBOTICS_INVENTORY = {
  instruments: [
    {
      instrument: "trajectory_replay_with_pinned_seed",
      question: "Can a control episode be replayed with a pinned seed?",
      probe_ran: true,
      capability_present: true,
      measured: { episodes: 20, wall_s: 11.4 },
    },
    {
      instrument: "matched_energy_budget_control",
      question: "Can two controllers be compared at a matched energy budget?",
      probe_ran: true,
      capability_present: true,
    },
  ],
  measurable_quantities: ["tracking error under a matched energy budget"],
  measured_absences: [
    { instrument: "contact_force_telemetry", why: "The simulator exposes no contact-force channel." },
  ],
};

test("an unlisted field with interventional instruments stops getting econometrics", () => {
  const resolved = resolveProfile({
    instrumentInventory: ROBOTICS_INVENTORY,
    context: "test",
  });
  assert.equal(resolved.intervention_mode, "interventional");
  assert.match(resolved.profile.identity, /experimentalist/);
  assert.ok(
    !resolved.profile.designShift.strategies.some((s) => /difference_in_differences|event_study/.test(s)),
    "an experimental cycle must not be handed observational design shifts",
  );
});

// There is no second opinion left to disagree with.
//
// Two tests stood here, asserting that a measured mode contradicting the field
// label was reported rather than resolved away. That was worth asserting while a
// field label still decided things. Nothing decides but the probe now, so the
// assertion is the stronger one: a label cannot get in even when handed over.
test("a field label cannot enter the profile, even when one is passed", () => {
  const resolved = resolveProfile({
    instrumentInventory: ROBOTICS_INVENTORY,
    enumeratedProfile: { identity: "statistician", hints: ["confounding"], designShift: { strategies: ["difference_in_differences"] } },
    context: "robotics cycle",
  });
  assert.equal(resolved.intervention_mode, "interventional");
  assert.match(resolved.profile.identity, /experimentalist/);
  assert.ok(!resolved.profile.hints.includes("confounding"));
  assert.ok(!resolved.profile.designShift.strategies.some((item) => /difference_in_differences/.test(item)));
  assert.equal(resolved.contradiction, undefined, "nothing is left to contradict");
});

// The enumerated blueprint rules name a helper module and asset extensions,
// which is right for one field. These name what a probe ran here.
test("blueprint rules come from the instruments, not from a field's toolchain", () => {
  const rules = deriveBlueprintRules(ROBOTICS_INVENTORY);
  assert.equal(rules.length, 3, "two verified instruments and one measured absence");
  assert.match(rules[0], /trajectory_replay_with_pinned_seed/);
  assert.match(rules[0], /a probe ran it in this container/);
  assert.match(rules[2], /DO NOT DEPEND ON `contact_force_telemetry`/);
  assert.match(rules[2], /no contact-force channel/);
  for (const rule of rules) {
    assert.ok(!/cs_helpers|omics_helpers|\.pbrt|\.gltf/.test(rule), "no field toolchain may leak in");
  }
});

// Every slot says where it came from, and the ones with no evidence say that
// rather than pretending. This is what `generic` got wrong: it supplied
// econometrics silently.
test("each slot reports whether it was measured, framed, or guessed", () => {
  const resolved = resolveProfile({ instrumentInventory: RENDER_INVENTORY });
  const sources = Object.fromEntries(
    Object.entries(resolved.provenance).map(([slot, value]) => [slot, value.source]),
  );
  assert.equal(sources.identity, "measured");
  assert.equal(sources.hints, "measured");
  assert.equal(sources.blueprintRules, "measured");
  assert.equal(sources.analysisGoal, "mode-framing");
  assert.equal(sources.designShift, "mode-framing");
  // Derived from the mode now, not from a field label.
  assert.equal(sources.statisticalMandate, "mode-framing");
});

test("with no probe there is no mode, so every slot falls back and says so", () => {
  const resolved = resolveProfile({});
  assert.equal(resolved.usable, false);
  assert.equal(resolved.intervention_mode, null);
  for (const [slot, value] of Object.entries(resolved.provenance)) {
    // blueprintRules always has the universal scaffolding behind it, which is
    // field-independent and holds with no probe.
    if (slot === "blueprintRules") continue;
    assert.equal(value.source, "unmeasured-default", `${slot} claimed a source it does not have`);
  }
  // And the default says what it is, rather than naming a field.
  assert.match(resolved.profile.identity, /have not been probed yet/);
});
