"use strict";

// Measured evidence for the corpus floor below (cycle-g-v89, 2026-09-10).
//
// The cycle's own recorded corpus was the eight papers in `top_papers`, and it
// was not one topic: an econometrics paper on instrumental variables and a
// satellite-imagery paper sat beside the graphics work. Derived seeds came out
// as "optical, morfeo, adaptive, optics, reconstruction, powerful, synthesis,
// instrumental" -- "powerful" is a function word that survived tf-idf, and
// "morfeo" is an instrument named in an adaptive-optics paper -- against the
// enumerated "rendering, path tracing, Monte Carlo rendering, adaptive
// sampling, ray tracing, global illumination".
//
// So the derivation is right in mechanism and wrong at this corpus size, and
// the floor is drawn between the eight that lose and the 116 that win.

// Derive the research profile from what this cycle MEASURED, not from a list of
// domains someone enumerated.
//
// `domain_profiles.js` classifies an objective as bio / cs / generic and hands
// out a fixed profile. Its own header admits what it is: scattered hardcoding
// collected into one place. The failure it cannot avoid is the one the owner
// banned outright -- a fixed enumeration works for the fields that were listed
// and is silently wrong for every other. Measured on the live tree: `generic` is
// byte-identical to `bio` on hints and statistical mandate, and its design
// shifts are econometrics (difference-in-differences, event study, instrumental
// variable). A robotics or compiler objective is handed a statistician's framing
// and a rival-DAG vocabulary.
//
// Everything a profile needs is already recorded by artifacts this cycle
// produces before any hypothesis exists:
//
//   instrument-inventory.json  what a probe ACTUALLY ran in this container, what
//                              it measured, and what it looked for and did not
//                              find (`measured_absences`)
//   venue standard             what papers in the target venue evaluate on,
//                              read from the venue's own pages and papers
//   literature corpus          what the field names as its datasets and terms
//
// STAGE 1: this module derives and records. It does not yet decide anything --
// `domain_profiles.js` still drives behaviour. The point is to find out whether
// the derivation reproduces the hand-written profile before trusting it with a
// cycle, and to make every fallback announce itself so a guessed profile is
// visible rather than silent.

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

// An instrument counts as usable only if a probe RAN and found the capability.
// A declared instrument nobody exercised is a promise, and this whole artifact
// exists because promises were being cited as evidence.
function verifiedInstruments(inventory) {
  const rows = asArray(inventory?.instruments).filter(
    (item) => item?.probe_ran === true && item?.capability_present === true,
  );
  if (rows.length) return rows;
  // Older inventories recorded only the name list.
  return asArray(inventory?.verified_instruments).map((name) => ({
    instrument: text(name),
    probe_ran: true,
    capability_present: true,
  }));
}

// THE CORE JUDGEMENT, and it is not a domain.
//
// What separates the hand-written `cs` profile from `bio`/`generic` is not the
// subject matter, it is whether the cycle can SET the independent variable. An
// instrument that pins a seed, matches a budget, or applies one isolated edit
// lets the cycle intervene; an instrument that only reads a recorded cohort does
// not. The domain label was a proxy for that, and a proxy is exactly what fails
// for the fields nobody listed.
//
// The signals are properties of an instrument's own recorded question -- does it
// describe setting something, or reading something.
const INTERVENTION_SIGNALS = [
  "seed",
  "budget",
  "matched",
  "control",
  "counterfactual",
  "edit",
  "ablation",
  "sweep",
  "vary",
  "inject",
  "perturb",
  "configure",
  "reproducib",
];

const OBSERVATION_SIGNALS = [
  "recorded",
  "archival",
  "registry",
  "survey",
  "panel",
  "retrospective",
  "observational",
];

function interventionCapability(inventory) {
  const rows = verifiedInstruments(inventory);
  const haystack = rows
    .map((row) => `${text(row.instrument)} ${text(row.question)}`.toLowerCase())
    .join(" | ");
  const interventional = INTERVENTION_SIGNALS.filter((needle) => haystack.includes(needle));
  const observational = OBSERVATION_SIGNALS.filter((needle) => haystack.includes(needle));
  if (!rows.length) {
    return { mode: null, reason: "no probe has verified any instrument", interventional, observational };
  }
  if (interventional.length > observational.length) {
    return {
      mode: "interventional",
      reason:
        `${rows.length} verified instrument(s) describe setting the independent variable `
        + `(${interventional.slice(0, 4).join(", ")})`,
      interventional,
      observational,
    };
  }
  if (observational.length > 0) {
    return {
      mode: "observational",
      reason: `verified instruments read recorded data (${observational.slice(0, 4).join(", ")})`,
      interventional,
      observational,
    };
  }
  // Instruments ran but say nothing either way. That is not a licence to guess.
  return {
    mode: null,
    reason: "verified instruments describe neither intervention nor observation",
    interventional,
    observational,
  };
}

// What the cycle can measure, in the words the probe recorded. These are the
// `hints` slot: the quantities a hypothesis in THIS cycle can actually be about.
function measurableQuantities(inventory) {
  return asArray(inventory?.measurable_quantities).map(text).filter(Boolean);
}

// What was looked for and not found, with the reason. A profile that omits this
// invites a hypothesis the cycle cannot test.
function measuredAbsences(inventory) {
  return asArray(inventory?.measured_absences)
    .map((row) => ({ instrument: text(row?.instrument), why: text(row?.why) }))
    .filter((row) => row.instrument);
}

// What a paper in the target venue is expected to evaluate on, read from papers
// the cycle actually fetched. `venue_standard.js` already records this with the
// DOIs it read; nothing here re-derives it.
function evaluationNorm(venueStandard) {
  const standard = venueStandard?.standard || venueStandard || {};
  const norm = standard?.evaluation_norm || {};
  const papers = asArray(norm.papers_read).map((paper) => ({
    doi: text(paper?.doi),
    evaluated_on: text(paper?.what_it_evaluated_on),
  })).filter((paper) => paper.evaluated_on);
  return {
    described: text(norm.described) || null,
    papers_read: papers,
    accepts_contribution_types: asArray(standard?.accepts_contribution_types).map(text).filter(Boolean),
  };
}

// The datasets and benchmarks the retrieved papers NAME, rather than a list of
// dataset names written into this runtime.
function corpusDataSeeds(corpus, limit = 8) {
  const seeds = [];
  for (const paper of asArray(corpus)) {
    for (const named of asArray(paper?.datasets_named || paper?.datasets || paper?.benchmarks)) {
      const value = text(named);
      if (value && !seeds.includes(value)) seeds.push(value);
      if (seeds.length >= limit) return seeds;
    }
  }
  return seeds;
}

// Terms that recur across the retrieved on-topic papers. The objective supplies
// the first pass; the corpus is what tells the cycle the field's own vocabulary.
function corpusSearchSeeds(corpus, limit = 8) {
  // Ranking by how OFTEN a term appears selects function words: measured on the
  // live 116-paper corpus, plain document frequency returned
  // ["from","model","results","which","paper","study","using","these"].
  //
  // A field's vocabulary is not the most frequent language, it is the language
  // this corpus uses and general language does not. That is tf-idf, and it needs
  // no stopword list -- so it works for a corpus in any language, which a list
  // never does.
  const documents = asArray(corpus);
  if (!documents.length) return [];
  const documentFrequency = new Map();
  const totalOccurrences = new Map();
  for (const paper of documents) {
    const words = `${text(paper?.title)} ${text(paper?.abstract)}`
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) || [];
    for (const word of words) totalOccurrences.set(word, (totalOccurrences.get(word) || 0) + 1);
    for (const word of new Set(words)) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  }
  const floor = Math.max(2, Math.ceil(documents.length * 0.05));
  const scored = [];
  for (const [word, df] of documentFrequency) {
    if (df < floor) continue;
    const idf = Math.log(documents.length / df);
    const meanTermFrequency = (totalOccurrences.get(word) || 0) / df;
    scored.push([word, meanTermFrequency * idf]);
  }
  return scored
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}


// Below this many retrieved papers, derived search seeds are not used: see the
// measurement in deriveProfile.
const MINIMUM_CORPUS_FOR_DERIVED_SEEDS = 30;

const INTERVENTIONAL_IDENTITY = "experimentalist for this cycle's verified instruments";
const OBSERVATIONAL_IDENTITY = "analyst of the recorded data this cycle can reach";

// Build the profile, slot by slot, and say for EVERY slot whether it came from
// evidence or from nothing. A slot with no evidence is reported as null with a
// reason; it is not filled with a guess.
function deriveProfile({ instrumentInventory = null, venueStandard = null, corpus = [] } = {}) {
  const capability = interventionCapability(instrumentInventory);
  const quantities = measurableQuantities(instrumentInventory);
  const absences = measuredAbsences(instrumentInventory);
  const norm = evaluationNorm(venueStandard);
  const dataSeeds = corpusDataSeeds(corpus);
  // A corpus too small for tf-idf loses to a curated list, so it must not be
  // preferred over one: at eight papers the derivation returned a function word
  // and a piece of apparatus named in an off-topic paper, and nothing about the
  // cycle's own subject. The measurement is in this file's header. The method is
  // sound where it was validated, on the far larger corpus the comment on
  // corpusSearchSeeds records; this floor sits between the size that measurably
  // loses and the size that measurably wins.
  const searchSeeds = corpus.length >= MINIMUM_CORPUS_FOR_DERIVED_SEEDS
    ? corpusSearchSeeds(corpus)
    : [];
  const instruments = verifiedInstruments(instrumentInventory);

  const provenance = {};
  const record = (slot, value, source, reason) => {
    provenance[slot] = { source, reason };
    return value;
  };

  const identity = capability.mode
    ? record(
      "identity",
      capability.mode === "interventional" ? INTERVENTIONAL_IDENTITY : OBSERVATIONAL_IDENTITY,
      "derived",
      capability.reason,
    )
    : record("identity", null, "unavailable", capability.reason);

  return {
    profile: {
      identity,
      intervention_mode: capability.mode,
      hints: quantities.length
        ? record("hints", quantities, "derived", `${quantities.length} measurable quantities recorded by the probe`)
        : record("hints", [], "unavailable", "the probe recorded no measurable quantities"),
      verified_instruments: instruments.map((row) => text(row.instrument)).filter(Boolean),
      measured_absences: absences.length
        ? record("measured_absences", absences, "derived", `${absences.length} instrument(s) probed and not found`)
        : record("measured_absences", [], "derived", "nothing was probed and missing"),
      evaluation_norm: norm.described
        ? record("evaluation_norm", norm, "derived", `read from ${norm.papers_read.length} paper(s) in the target venue`)
        : record("evaluation_norm", null, "unavailable", "no venue standard has been recorded"),
      searchSeeds: searchSeeds.length
        ? record("searchSeeds", searchSeeds, "derived", "terms recurring across the retrieved corpus")
        : record("searchSeeds", [], "unavailable", "no corpus has been retrieved yet"),
      dataSeeds: dataSeeds.length
        ? record("dataSeeds", dataSeeds, "derived", "datasets named by the retrieved papers")
        : record("dataSeeds", [], "unavailable", "no retrieved paper names a dataset"),
      // Honest gap: how a field strengthens a claim is methodological knowledge,
      // and the venue's evaluation norm is a thin proxy for it. Left explicitly
      // unavailable rather than filled from a list, so stage 2 can see that this
      // is the slot still needing a real source.
      designShift: record(
        "designShift",
        null,
        "unavailable",
        "not yet derivable from recorded evidence; the weakest slot in this design",
      ),
    },
    provenance,
    // A profile is usable when the cycle knows what it can measure and how it
    // can act. Everything else can arrive later.
    usable: Boolean(capability.mode) && quantities.length > 0,
  };
}


// ---------------------------------------------------------------------------
// Stage 2: the resolver that actually decides.
// ---------------------------------------------------------------------------

// Blueprint rules built from the instruments a probe verified in THIS container.
// The enumerated profiles name a helper module and asset file extensions, which
// is correct for exactly one field; these name what the probe ran and what it
// returned, which is correct wherever the probe ran.
function deriveBlueprintRules(inventory) {
  const rules = [];
  for (const row of verifiedInstruments(inventory)) {
    const name = text(row.instrument);
    if (!name) continue;
    const question = text(row.question);
    const measured = row.measured && typeof row.measured === "object"
      ? Object.entries(row.measured)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
        .join(", ")
      : "";
    rules.push(
      `USE THE VERIFIED INSTRUMENT \`${name}\`: a probe ran it in this container`
      + (question ? ` and answered "${question}"` : "")
      + (measured ? `, measuring ${measured}` : "")
      + ". Build the validation on what this instrument returns, and report that number.",
    );
  }
  for (const absence of measuredAbsences(inventory)) {
    rules.push(
      `DO NOT DEPEND ON \`${absence.instrument}\`: it was probed and is absent. ${absence.why} `
      + "Restate the check over an instrument that IS verified, or request that the capability be built "
      + "before the check is written.",
    );
  }
  return rules;
}

// What an analyst owes in either mode. Lifted out of the two enumerated
// profiles, which carried the same fourteen obligations twice -- once in
// epidemiological vocabulary and once in rendering vocabulary. Stripping the
// vocabulary left one list, which is the evidence that the domain table was
// standing in for the mode all along.
const SHARED_PRIMARY_TASKS = Object.freeze([
  "rank candidate hypotheses by expected impact, novelty delta, decision relevance, testability, and feasibility before selecting a lead",
  "define the quantity being compared and what counts as a meaningful difference in it, in the unit the field itself reports",
  "resolve every modeled concept to exactly one canonical column or measured output before defining the master table, and record the rejected near-duplicates",
  "attach a provenance footer to every resolution and every claim in the handoff: what produced the number, which version or snapshot, and when",
  "declare a pinned analyst_quality_standard and a self_evaluation against it, treating a below-target result as a blocker rather than a note",
  "name the ways this measurement could be wrong before running it, and what each one would look like in the output",
  "propose pairwise contests between the surviving candidates, and attach at least two explicit, executable falsification tests to each, plus a methodological_rigor self-score (0-100) with justification",
  "rank candidates by what can actually be established here, not by narrative plausibility",
  "define the master table required before validation: its row grain, its keys, and the columns every downstream check reads",
  "state the capability the design needs and, when a prior runner failed on it, whether the METHOD survives -- the environment repair itself belongs to the engineer",
  "write at least one executable validation-code blueprint a lab-runner can run with minimal reinterpretation",
  "self-review the proposed code for specification risk, assumptions, and failure modes before handoff",
]);

const SHARED_REVIEW_AXES = Object.freeze(["falsification", "measurement", "reproducibility"]);

// Framing for the two modes. This is methodology, not a field: "compare at a
// matched budget and report the across-seed spread" reads the same wherever a
// cycle can set its independent variable, and "name the identification strategy
// and its rival explanations" reads the same wherever it cannot.
const MODE_FRAMING = Object.freeze({
  interventional: Object.freeze({
    identity: "experimentalist for this cycle's verified instruments",
    analysisGoal:
      "act as an experimentalist: turn the objective into competing method families and design controlled "
      + "comparisons on the verified instruments -- matched budgets and equal-cost comparisons, ablations over "
      + "the method's components, pinned seeds with the across-seed spread reported, and a preregistered "
      + "stopping rule -- before any family is promoted",
    hints: Object.freeze([
      "matched budget",
      "equal-cost comparison",
      "ablation",
      "pinned seed",
      "across-seed spread",
      "preregistered stopping rule",
      "control that should reproduce the result if the mechanism is not what is claimed",
      "baseline strength",
    ]),
    statisticalMandate: Object.freeze({
      primary_tasks: Object.freeze([
        ...SHARED_PRIMARY_TASKS,
        "specify the fair-comparison protocol: compare each arm under BOTH a matched cost budget and a matched quality target, so a difference is attributable to the method and not to the budget",
        "hold the setup fixed across compared arms -- inputs, resolution or scale, budget, hardware, warm-up and caching -- and pin the seed, reporting the across-seed spread rather than a single run",
      ]),
      review_axes: Object.freeze([...SHARED_REVIEW_AXES, "equal-budget fairness", "ablation coverage", "significance of the measured difference"]),
    }),
    designShift: Object.freeze({
      currentApproachLabel: "single-configuration comparison",
      strategies: Object.freeze([
        "hold the budget fixed and vary the method",
        "hold the method fixed and vary the budget",
        "ablate one component at a time",
        "repeat under pinned seeds and report the spread",
        "add a control that should reproduce the result if the mechanism is not what is claimed",
      ]),
    }),
  }),
  observational: Object.freeze({
    identity: "analyst of the recorded data this cycle can reach",
    analysisGoal:
      "act as an analyst of recorded data: state the estimand and the identification strategy before any "
      + "comparison, name the rival explanations the design does not exclude, and pair every claim with the "
      + "negative control or sensitivity analysis that would break it",
    hints: Object.freeze([
      "identification strategy",
      "rival explanation",
      "negative control",
      "selection effect",
      "measurement error",
      "model misspecification",
      "heterogeneity across units",
    ]),
    statisticalMandate: Object.freeze({
      primary_tasks: Object.freeze([
        ...SHARED_PRIMARY_TASKS,
        "state the estimand and the identification strategy before any comparison, and name the assumption the estimate depends on",
        "separate the variables that confound, the ones that mediate, the ones that modify, and the ones that would open a spurious path if adjusted for",
      ]),
      review_axes: Object.freeze([...SHARED_REVIEW_AXES, "identification", "confounding", "heterogeneity", "selection"]),
    }),
    designShift: Object.freeze({
      currentApproachLabel: "pooled comparison over recorded units",
      strategies: Object.freeze([
        "compare within a unit over time rather than across units",
        "restrict to a subgroup where the rival explanation cannot operate",
        "add a negative control whose effect must be null",
        "vary the adjustment set and report how the estimate moves",
        "test the assumption the identification strategy depends on",
      ]),
    }),
  }),
});

// Blueprint scaffolding that holds in any field.
//
// Lifted verbatim out of the domain registry, where it sat wrapped around a
// per-field rule list. Nothing here names a field: it is about building the
// master table first, loading real inputs without assuming their format,
// declaring dependencies, and mapping the blueprint to a named check.
const ROBUST_DATA_LOADING_RULE = "ROBUST DATA LOADING: never assume a delimiter or header layout. Real inputs are frequently TSV, Excel, or have multi-row headers / banner lines. Sniff the format before parsing — try the documented/declared format first, then fall back across tab/comma and comment-prefix skipping (e.g. pandas read_csv(sep=None, engine='python') with comment-line skipping), and transpose if the orientation is swapped. A bare pd.read_csv(path) on a non-CSV is a common master-table failure and cascades into every downstream check failing — guard against it explicitly and print the resolved delimiter/skiprows in the metrics.";

const UNIVERSAL_BLUEPRINT_RULES = Object.freeze([
  "HELPER MODULES ARE PLACED NEXT TO YOUR BLUEPRINT: list the blueprint's own directory before writing loading code -- importable helper modules are copied there at run time and one may already handle your input's shape, which is cheaper and better tested than re-implementing it. Discover them by listing, never by assuming a module name: which helpers exist is a property of this runtime, not of your field.",
  "IMPLEMENT THE PROPOSED METHOD -- NEVER ASSUME IT EXISTS ALREADY: a method THIS cycle invented is not a built-in of the tool you selected. Implement the novel arm through that tool's documented extension interface, register or configure it if the tool requires that, and verify the novel arm ACTUALLY EXECUTES in a minimal smoke run before the full comparison. If it cannot be implemented here, report an implementation gap -- a comparison whose novel arm never ran produces numbers that mean nothing, which is how three consecutive cycles reported passing lanes on all-null evidence.",
  "the first executable blueprint should build and persist the analysis master table before any hypothesis test runs",
  "the master-table blueprint must map to a named check_id such as analysis_master_table_created",
  "the master-table blueprint must emit a table artifact whose filename contains master_table and must print JSON metrics with checks.analysis_master_table_created=true when successful",
  "if failed_runner_context.repository_workflow_exhausted or repository_workflow_repetition is present, the next handoff must materially differ from the repeated failed workflow: new input mapping, different workflow/domain package, or explicit rejection/waiver plus replacement method",
  "the blueprint must map to a named handoff_check via check_id",
  "include a concrete entrypoint name and enough code to show the model/algorithm specification",
  "prefer explicit column names, adjustment sets, and sample/condition filters over generic placeholders",
  "SELF-PROVISION TOOLS: do not assume a tool is preinstalled. Declare every PyPI package the blueprint imports in a `pip_install_packages` (or `dependencies`) list — the lab-runner pip-installs them into the cycle environment before the script runs (PyPI names only, optionally pinned with ==; no URLs / git refs / flags). If a needed tool is not on PyPI, give the exact clone/build command in execution notes and record it as a missing dependency rather than pretending it ran.",
  "state dependencies and execution notes needed by the lab-runner",
]);

// The last tier, for the window before any probe has run.
//
// The instrument probe runs on a cycle's first lab-runner lane, so there is a
// real window with no inventory and therefore no mode. What used to fill it was
// a profile chosen by matching words in the objective against a table of
// domains -- which worked for the domains someone had listed and quietly handed
// every other field a statistician's framing and a rival-DAG vocabulary.
//
// This fills it with the obligations that hold either way, and an identity that
// says plainly that the mode has not been measured yet. A lane that reads
// "not yet measured" can ask for the probe; a lane handed the wrong field's
// framing cannot tell that anything is wrong.
const NEUTRAL_PROFILE = Object.freeze({
  identity: "researcher for a cycle whose instruments have not been probed yet",
  analysisGoal:
    "no probe has run, so what this cycle can do is unknown: state what the objective would need to be "
    + "measured, and treat the capability probe as the first thing that has to happen -- do not assume "
    + "either that the independent variable can be set or that it cannot",
  hints: Object.freeze([]),
  searchSeeds: Object.freeze([]),
  dataSeeds: Object.freeze([]),
  statisticalMandate: Object.freeze({
    primary_tasks: SHARED_PRIMARY_TASKS,
    review_axes: SHARED_REVIEW_AXES,
  }),
  designShift: null,
});

// Resolve the profile a lane should run on.
//
// Precedence, slot by slot: evidence recorded by this cycle first, mode framing
// second, and the enumerated domain profile only where neither reaches. Every
// slot reports which of the three it came from.
function resolveProfile({
  instrumentInventory = null,
  venueStandard = null,
  corpus = [],
  context = null,
} = {}) {
  const { profile: derived, provenance: derivedProvenance, usable } = deriveProfile({
    instrumentInventory,
    venueStandard,
    corpus,
  });
  const framing = derived.intervention_mode ? MODE_FRAMING[derived.intervention_mode] : null;
  const fallback = NEUTRAL_PROFILE;
  const provenance = {};

  const pick = (slot, derivedValue, framingValue, reason) => {
    if (derivedValue != null && (!Array.isArray(derivedValue) || derivedValue.length)) {
      provenance[slot] = { source: "measured", reason };
      return derivedValue;
    }
    if (framingValue != null) {
      provenance[slot] = { source: "mode-framing", reason: `framing for a ${derived.intervention_mode} cycle` };
      return framingValue;
    }
    provenance[slot] = {
      source: "unmeasured-default",
      reason: "no measurement and no mode yet; the field-independent default was used",
    };
    return fallback[slot];
  };

  const blueprintRules = [
    UNIVERSAL_BLUEPRINT_RULES[0],
    ROBUST_DATA_LOADING_RULE,
    ...deriveBlueprintRules(instrumentInventory),
    ...UNIVERSAL_BLUEPRINT_RULES.slice(1),
  ];

  return {
    usable,
    intervention_mode: derived.intervention_mode,
    profile: {
      identity: pick("identity", derived.identity, framing?.identity, derivedProvenance.identity?.reason),
      analysisGoal: pick("analysisGoal", null, framing?.analysisGoal),
      hints: pick("hints", derived.hints, framing?.hints, derivedProvenance.hints?.reason),
      searchSeeds: pick("searchSeeds", derived.searchSeeds, null, derivedProvenance.searchSeeds?.reason),
      dataSeeds: pick("dataSeeds", derived.dataSeeds, null, derivedProvenance.dataSeeds?.reason),
      blueprintRules: pick(
        "blueprintRules",
        blueprintRules,
        null,
        `${blueprintRules.length} rule(s) built from verified instruments and measured absences`,
      ),
      designShift: pick("designShift", null, framing?.designShift),
      // Derived from what the cycle can DO, not from what field it is in: the
      // two enumerated mandates were the same obligations in two vocabularies.
      statisticalMandate: pick("statisticalMandate", null, framing?.statisticalMandate),
      // Pure additions: evidence the enumerated profiles never carried.
      intervention_mode: derived.intervention_mode,
      verified_instruments: derived.verified_instruments,
      measured_absences: derived.measured_absences,
      evaluation_norm: derived.evaluation_norm,
    },
    provenance,
    // A cycle whose instruments say one thing while its field label says another
    // is worth seeing rather than silently resolving.
  };
}

// Nothing to contradict any more.
//
// This compared the measured mode against the identity of the profile a field
// label had chosen, and reported when the two disagreed -- which was worth
// seeing precisely because a field label was being used to decide what a cycle
// could do. Nothing decides that but the probe now, so there is no second
// opinion to disagree with.

/**
 * The alternative-design strategies for a measured mode.
 *
 * A cycle that cannot set its independent variable has different moves open to
 * it than one that can, and that is the only thing this depends on. It used to
 * depend on a field label, whose unlisted-field entry was the observational set
 * -- so a cycle in any field nobody had enumerated was offered econometrics.
 */
function designShiftForMode(mode) {
  return MODE_FRAMING[mode]?.designShift || NEUTRAL_DESIGN_SHIFT;
}

// When the probe has not run, the moves that hold either way.
const NEUTRAL_DESIGN_SHIFT = Object.freeze({
  currentApproachLabel: "the design as it stands",
  strategies: Object.freeze([
    "change what is measured rather than how it is compared",
    "narrow to the sub-case where the claim is sharpest",
    "add a control whose result is known in advance",
    "repeat the comparison under a different setting and report how it moves",
    "run the capability probe, so the next choice is made against what this cycle can actually do",
  ]),
});

module.exports = {
  designShiftForMode,
  MINIMUM_CORPUS_FOR_DERIVED_SEEDS,
  deriveProfile,
  deriveBlueprintRules,
  resolveProfile,
  MODE_FRAMING,
  interventionCapability,
  measurableQuantities,
  measuredAbsences,
  evaluationNorm,
  corpusDataSeeds,
  corpusSearchSeeds,
};
