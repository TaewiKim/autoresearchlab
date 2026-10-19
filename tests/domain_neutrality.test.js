"use strict";

// A contract every cycle receives may not name one field's vocabulary.
//
// The rule in this project is that no tool name, venue name, repository or
// dataset vocabulary is hardcoded, because every hardcoded list here has failed
// for the domain nobody enumerated. The failure is never loud: the lane does
// what it was asked, and the result looks like a scout that went off topic.
//
// Measured on cycle-g-v89, a computer-graphics rendering cycle. The Rust
// follow-up path handed every data scout a contract naming three biomedical
// repositories, three omics modalities and three human-cohort context terms:
//
//   7 of 7 scout role plans carried it
//   4 of those returned 101, 119, 137 and 155 gene-expression accessions
//   4 of 4 dataset bundles the cycle materialised were GEO series -- 566 MB
//
// The JS base plan had already been fixed and its comment named this exact
// contract as the thing it was removing. It stayed anyway, because every scout
// in a running cycle is a FOLLOW-UP and follow-ups come through the Rust path.
// That is the recurring shape here: the fix went in one layer and the traffic
// was on another, so the assertions below read the sources rather than trusting
// that a fix reached them.
//
// Scope. This began as a check on the cross-domain path only, on the reasoning
// that field vocabulary was correct inside a profile selected by domain. There
// are no such profiles now -- selecting one by matching words against a table of
// fields is the same failure one level up -- so the assertions at the bottom
// guard the removal of the classifiers themselves.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const HARNESS = path.join(__dirname, "..", "native", "researchlab-harness", "src");

function read(...parts) {
  return fs.readFileSync(path.join(...parts), "utf8");
}

function read2(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

// The vocabulary that actually leaked, not a guess at what might. Each of these
// was in the contract v89's renderer received.
const FIELD_VOCABULARY = [
  "GEO",
  "ArrayExpress",
  "PRIDE",
  "transcriptomics",
  "single-cell",
  "proteomics",
  "omics",
  "cohort",
  "biologically meaningful",
];

function offenders(text) {
  return FIELD_VOCABULARY.filter((term) => new RegExp(`\\b${term}\\b`, "i").test(text));
}

function fnBody(source, name) {
  const start = source.indexOf(`fn ${name}`);
  assert.notEqual(start, -1, `no function named ${name}`);
  const next = source.indexOf("\npub(crate) fn ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("the dataset discovery contract names no field's repositories", () => {
  const source = read(HARNESS, "labdirector/hypothesis_frontier.rs");
  const body = fnBody(source, "dataset_discovery_contract");
  // The doc comment above the function is allowed to name what leaked -- that
  // is the record of why the function looks like this. Only what the lane
  // RECEIVES is checked.
  const emitted = body.slice(body.indexOf("json!("));
  assert.deepEqual(
    offenders(emitted),
    [],
    "this contract reaches every cycle's data scouts and points them at one field",
  );
});

test("the dataset discovery contract still asks which repositories the field uses", () => {
  // Deleting the requirement would also pass the assertion above. The lane must
  // still be told to determine and justify its sources -- that is the discovery
  // the hardcoded list was standing in for.
  const source = read(HARNESS, "labdirector/hypothesis_frontier.rs");
  const body = fnBody(source, "dataset_discovery_contract");
  assert.match(body, /repository_selection/);
  assert.match(body, /objective's field actually uses/i);
  assert.match(body, /off_field_policy/, "nothing stops an off-field candidate being returned as a fallback");
});

test("no recovery lane is described in one field's language", () => {
  // These are the sentences a recovery lane is actually given. A neutral
  // contract beside a description that says "biologically meaningful" puts the
  // field straight back, and the description is the part the agent reads first.
  const files = [
    "labdirector/gates/dependency_gates/dependency_gates_01.rs",
    "labdirector/gates/dependency_gates/dependency_gates_02.rs",
    "labdirector/followups/dispatch_pivot.rs",
    "labdirector/followups/dispatch.rs",
  ];
  const found = [];
  for (const rel of files) {
    for (const line of read(HARNESS, rel).split("\n")) {
      // Only emitted strings, never comments explaining the history.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
      if (!/"description"|"task"|LabDirector pivoted/.test(line)) continue;
      for (const term of offenders(line)) found.push(`${rel}: ${term}`);
    }
  }
  assert.deepEqual(found, [], "these lane descriptions carry one field's vocabulary to every cycle");
});

// ------------------------------------------------- the classifier itself

test("nothing classifies an objective into a field any more", () => {
  // Every branch on a field label is a place where one field's scaffolding gets
  // chosen for a cycle by a word match. The two classifiers that existed --
  // src/agents/shared/domain.js and policy.rs objective_domain -- decided which
  // profile a lane ran on, which repositories a scout searched, which
  // confounders an analyst was asked to bound, and whether a cycle was allowed
  // to generate its own inputs. A robotics objective matched neither list and
  // was handed the observational default in all four.
  const gone = [
    path.join(__dirname, "..", "src", "agents", "shared", "domain.js"),
    path.join(__dirname, "..", "src", "agents", "shared", "domain_profiles.js"),
  ];
  for (const file of gone) {
    assert.ok(!fs.existsSync(file), `${path.basename(file)} is back`);
  }
  const policy = read(HARNESS, "labdirector/policy.rs");
  assert.ok(
    !/fn objective_domain\(/.test(policy),
    "objective_domain is back, and everything downstream branches on it again",
  );
});

test("what a cycle can do is read from the probe, not from the objective's words", () => {
  // The three decisions the classifier used to make, each now keyed to a
  // measurement or to a property of the data rather than to a field:
  //
  //   is discovery mandatory        the data's scale
  //   does it make its own inputs   a verified instrument that constructs them
  //   which methodology applies     whether the independent variable can be set
  const policy = read(HARNESS, "labdirector/policy.rs");
  assert.match(policy, /fn objective_indicates_large_scale_data/);
  const refresh = read(HARNESS, "labdirector/research_context/role_plan_refresh/role_plan_refresh_01.rs");
  assert.match(refresh, /fn instrument_inventory_generates_inputs/);
  assert.ok(
    !/procedural_data_domain/.test(refresh),
    "a cycle's ability to generate its own inputs is being decided by a field label again",
  );
});

test("the analyst is asked for one set of confounders, not one per field", () => {
  // This branched into rendering wording or omics wording, and the omics branch
  // was the default: an unlisted field was told to bound "subtype, purity,
  // stromal abundance, sampling-region, batch".
  const refresh = read(HARNESS, "labdirector/followups/role_plan/role_plan_01.rs");
  const emitted = refresh
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(!/analyst_is_cs/.test(emitted), "the per-field branch is back");
  assert.deepEqual(offenders(emitted.replace(/^.*fn .*$/gm, "")), []);
});

// ------------------------------------------------- what the scout is allowed to bring back

// Measured on cycle-g-v89's followup-scout-61: 70 candidates returned, 0 of them
// carrying a retrieval date, 0 of them naming what the design needed them for,
// and 4 bundles fetched -- 566 MB -- with no record of why any was chosen. The
// contract asked for three candidates and got seventy, because "required_count"
// reads as a floor and nothing said what admission meant.
test("a dataset is admitted only for a stated need, with provenance that can be re-checked", () => {
  const body = fnBody(read(HARNESS, "labdirector/hypothesis_frontier.rs"), "dataset_discovery_contract");
  const emitted = body.slice(body.indexOf("json!("));
  assert.match(emitted, /maximum_admitted_candidates/, "the count still reads as a quota rather than a ceiling");
  assert.match(emitted, /needed_for/, "nothing makes a candidate say what it is for");
  assert.match(emitted, /retrieval date/i, "provenance without a date cannot be re-checked");
  assert.match(emitted, /materialization_rule/, "nothing stops a fetch of something nobody admitted");
});

test("finding nothing is an answer the scout can give", () => {
  const body = fnBody(read(HARNESS, "labdirector/hypothesis_frontier.rs"), "dataset_discovery_contract");
  assert.match(body, /absence_is_an_answer/);
  assert.match(body, /no_admissible_dataset/);
  // The failure this prevents is the quiet one: a lane that cannot return
  // nothing returns something, and the something gets analysed.
  assert.match(body, /forbidden_alternatives/);
  assert.match(body, /widening the query until something matches/);

  // ...and the lane's own protocol has to offer the same way out, or the
  // contract is describing an outcome the lane has no shape to report.
  const scout = read2("src/agents/scout/query_plan.js");
  assert.match(scout, /no_admissible_dataset/, "the scout cannot report an empty result as success");
  assert.match(scout, /IS A COMPLETE ANSWER/);
});
