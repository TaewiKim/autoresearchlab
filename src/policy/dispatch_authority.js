"use strict";

// The Rust follow-up builder is the authority for a dispatched lane.
//
// This is not a preference; it is what the runtime does. Measured on
// cycle-g-v89: of 1,397 role plans in the cycle, 1,392 were written by
// `native/.../labdirector/followups/role_plan/`, and NOT ONE carried a key
// authored by `src/agents/**`. Zero of 65 scout lanes received the JS data-scout
// protocol -- including the sentence in it that said not to default to one
// field's repositories, while the Rust path was handing every one of them a
// contract naming that field's repositories.
//
// The Rust builder composes its own plan and never calls into JS. So a rule
// written only in a JS plan builder is inert in a running cycle. This is the
// single most expensive shape of bug in this repository, because the rule LOOKS
// present in the obvious place: the last five times a researchlab value appeared
// to be ignored, it had never been delivered.
//
// What this module is
// -------------------
// A registry of the governance rules that must reach a dispatched lane, each
// naming BOTH the JS expression of the rule and the Rust code that actually
// delivers it. `tests/dispatch_authority.test.js` asserts every entry's two
// sides exist, and that no rule-bearing key in a JS plan is missing from the
// registry. Editing one side and not the other fails the suite instead of
// producing a rule nobody receives.
//
// What the JS plan builders are for
// ---------------------------------
// They still build BASE lanes (the ones a cycle opens before the director takes
// over), and they are what the tests exercise. They are not the dispatch path,
// and an edit to one does not reach a running cycle by itself.

/**
 * A rule that must survive the trip to a lane.
 *
 * `js` is where the rule is written in this tree; `rust` is the symbol that
 * puts it into a dispatched role plan. `delivered_via` says how it arrives, so
 * a reader can check the claim rather than trust it:
 *
 *   bus              a registered channel: one role saying something to another,
 *                    with a kind, a delivery receipt, and -- for a request -- an
 *                    answer that carries a reason. This is the ONLY mode for a
 *                    role-to-role message.
 *   directive        the HARNESS instructing a lane, appended to its task text.
 *                    Not a message: nobody is speaking, and nobody answers.
 *   role_plan_key    the harness configuring a lane through its role plan.
 *   output_contract  the JSON shape a lane must return.
 *
 * The distinction that matters: `bus` is communication BETWEEN ROLES; the other
 * three are the system setting up a lane. Conflating them is how eight state
 * files and 48 planner_metadata keys ended up doing the communicating while the
 * thing named "messages" carried four hardcoded channels and was never read.
 */
const DELIVERY_MODES = Object.freeze(["bus", "directive", "role_plan_key", "output_contract"]);

const RUST_ROOT = "native/researchlab-harness/src";

const GOVERNED_RULES = Object.freeze([
  {
    // The sixth instance of this bug, and the one that cost the most: Chronicle
    // decides which of a scout corpus is this cycle's own field, and it was
    // asked only in the base lane. 1 of 1 base chronicle lanes carried the
    // request on cycle-g-v89; 0 of 100 follow-up lanes did, and every chronicle
    // lane a running cycle dispatches is a follow-up.
    rule: "Chronicle reads the corpus directly, against a recorded map and evidence ledger",
    js: { file: "src/agents/chronicle/brief_plan.js", key: "direct_corpus_interaction_contract" },
    rust: { file: `${RUST_ROOT}/labdirector/context/contracts.rs`, symbol: "chronicle_direct_corpus_interaction_contract" },
    delivered_via: "role_plan_key",
  },
  {
    rule: "Chronicle selects the corpus that forms the novelty baseline, and the builder only enforces it",
    js: { file: "src/agents/chronicle/brief_plan.js", key: "literature_relevance_review" },
    rust: { file: `${RUST_ROOT}/labdirector/context/contracts.rs`, symbol: "chronicle_literature_relevance_contract" },
    delivered_via: "role_plan_key",
  },
  {
    rule: "the analyst names what the design needs and does not provision it",
    js: { file: "src/agents/analyst/query_plan.js", key: "capability-requirement" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "open_source_analysis_agent_directive" },
    delivered_via: "directive",
  },
  {
    rule: "environment repair belongs to the engineer; the method decision stays with the analyst",
    js: { file: "src/agents/analyst/query_plan.js", key: "capability_requirements" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "open_source_analysis_agent_policy" },
    delivered_via: "role_plan_key",
  },
  {
    rule: "the engineer provisions, proves by running, and returns a blocker rather than a substitution",
    js: { file: "src/agents/engineer/environment_plan.js", key: "role_boundary" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "engineer_provisioning_directive" },
    delivered_via: "directive",
  },
  {
    rule: "the engineer returns a runner invocation contract and its blockers",
    js: { file: "src/agents/engineer/environment_plan.js", key: "required_outputs" },
    rust: { file: `${RUST_ROOT}/runtime/codex_prompt.rs`, symbol: "ENGINEER_OUTPUT_CONTRACT" },
    delivered_via: "output_contract",
  },
  {
    rule: "prior work is consulted before a design is authored",
    js: { file: "src/agents/analyst/query_plan.js", key: "reference_basis" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "reference_first_directive" },
    delivered_via: "directive",
  },
  {
    rule: "a dataset is admitted on its own field's terms, or reported absent",
    js: { file: "src/agents/scout/query_plan.js", key: "retrieval_strategy" },
    rust: { file: `${RUST_ROOT}/labdirector/hypothesis_frontier.rs`, symbol: "dataset_discovery_contract" },
    delivered_via: "role_plan_key",
  },
  // Seven clauses that were written in the analyst plan and delivered to
  // NOTHING: 0 of 225 dispatched analyst lanes on cycle-g-v89 carried any of
  // these keys, or their wording in any other form. They now ride one Rust
  // directive, which is why they share a symbol.
  {
    rule: "the analyst resolves definitions in trust order",
    js: { file: "src/agents/analyst/query_plan.js", key: "sources_of_truth_policy" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "every modeled concept resolves to exactly one canonical column or output",
    js: { file: "src/agents/analyst/query_plan.js", key: "concept_resolution_protocol" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "every resolution and claim carries a provenance footer",
    js: { file: "src/agents/analyst/query_plan.js", key: "provenance_policy" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "the analysis master table is built and checked before any hypothesis test",
    js: { file: "src/agents/analyst/query_plan.js", key: "pre_validation_master_table_gate" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "the analyst pins a quality standard and evaluates itself against it",
    js: { file: "src/agents/analyst/query_plan.js", key: "analyst_quality_standard_policy" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "referenced fields are checked for freshness and the snapshot is pinned",
    js: { file: "src/agents/analyst/query_plan.js", key: "data_quality_freshness_policy" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "the analyst's obligations are stated as one mandate",
    js: { file: "src/agents/analyst/query_plan.js", key: "statistical_mandate" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "analysis_design_discipline_directive" },
    delivered_via: "directive",
  },
  {
    rule: "the protected lead reaches every lane that could pivot away from it",
    js: { file: "src/reporting/reviews/gate/build.js", key: "lead-protection" },
    rust: {
      file: `${RUST_ROOT}/labdirector/research_context/role_plan_refresh/role_plan_refresh_01.rs`,
      symbol: "lead_protection_payload",
    },
    delivered_via: "role_plan_key",
  },
  {
    rule: "a role that owes another role an answer is told so, and the answer carries a reason",
    js: { file: "src/reporting/message_bus/channels.js", key: "author->lab-director:experiment-request" },
    rust: { file: `${RUST_ROOT}/labdirector/context/director_memory.rs`, symbol: "you_owe_an_answer" },
    delivered_via: "bus",
  },
  {
    rule: "what was put in front of a lane is recorded, so an undelivered message is visible",
    js: { file: "src/reporting/message_bus/index.js", key: "recordDelivery" },
    rust: { file: `${RUST_ROOT}/labdirector/context/director_memory.rs`, symbol: "record_mailbox_delivery" },
    delivered_via: "bus",
  },
  {
    rule: "the cycle's focus and the write-against mandate reach the roles that act on them",
    js: { file: "src/reporting/message_bus/channels.js", key: "lab-director->author:write-against" },
    rust: { file: `${RUST_ROOT}/labdirector/context/director_memory.rs`, symbol: "agent_mailbox_context" },
    delivered_via: "bus",
  },
  {
    rule: "a request to the director is raised on the bus, and the bus writes the file its consumer reads",
    js: { file: "src/reporting/message_bus/index.js", key: "LEGACY_INBOX_CHANNELS" },
    rust: { file: `${RUST_ROOT}/labdirector/supervision/inbox.rs`, symbol: "supervisor_instruction" },
    delivered_via: "bus",
  },
  {
    rule: "a blueprint implements the method it proposes and proves it runs",
    js: { file: "src/agents/shared/derived_profile.js", key: "UNIVERSAL_BLUEPRINT_RULES" },
    rust: { file: `${RUST_ROOT}/labdirector/policy.rs`, symbol: "blueprint_authoring_directive" },
    delivered_via: "directive",
  },
]);

// Rule-bearing keys that are deliberately NOT governed, each with the reason.
// A key lands here when it shapes a base lane or a test and carries no rule a
// dispatched lane needs -- never because wiring the Rust side was inconvenient.
const UNGOVERNED_KEYS = Object.freeze({
  frontier_discovery: "query seeds for a base lane; the Rust path authors its own queries",
  followup_description: "the description text is composed by the Rust dispatcher itself",
  search_goal: "restates the objective, which every Rust path already carries",
  search_agent_contract: "the literature driver's own protocol, executed by the driver rather than read as governance",
  analysis_goal: "the profile's identity line, derived per cycle rather than fixed",
  gate_scoring_policy: "a statement about how the gate treats this lane, enforced in the gate rather than the lane",
  open_ended_timeout_policy: "lane timeouts, applied by the harness rather than read by the agent",
  execution_mandate: "restates role_boundary, which is governed above",
  capability_record_policy: "the append-only rule, carried by engineer_provisioning_directive",
  compute_budget_contract: "delivered by compute_budget_directive on the Rust side",
  code_generation_protocol: "the blueprint rules inside it are delivered by blueprint_authoring_directive",
  required_output: "the shape a lane must return is delivered by the role's output contract in codex_prompt.rs",
  library_documentation_policy: "delivered by the analyst docs clause in codex_prompt.rs",
  materializability_first_policy: "restates the dataset admission rule, which dataset_discovery_contract governs",
  claim_coverage_contract: "delivered by claim_coverage_directive on the Rust side",
  column_mapping_contract: "delivered by blueprint_authoring_directive on the Rust side",
  interpretation_schema: "the shape Chronicle's OUTPUT is parsed against, read from the plan by chronicle/reporting.rs rather than delivered as an instruction",
});

// ---------------------------------------------------------------------------
// Inter-role signals: both ends, named.
//
// The registry above answers "is this rule delivered". It cannot answer "does
// anyone read it", and that is the other half of every failure this programme
// has had. MBM-Core governs ADMISSION -- what a record must prove to enter a
// decision -- and says nothing about DELIVERY. Its gate can only refuse a
// record that arrives; it has no concept of one that never does. Downstream,
// `not delivered`, `denied` and `never existed` are the same absence.
//
// MEASURED, all in 2026-09-12/13, none of them an admission failure:
//
//   lab_director_alerts       written by chronicle with an owner and a reason,
//                             read by NOTHING for two cycles while v90 and v91
//                             sat at running:0 waiting for a human
//   skipped_lanes             the only component that saw the stray lane
//                             directory recorded it into a returned field with
//                             no reader anywhere in the tree
//   chronicle_decision_digest set only when absent by both writers, so a lane
//                             queued at 08:10 still decided from the 08:10
//                             record at 08:38, after the evidence arrived
//   instrument_inventory      a renderer probe that existed, was 400 lines, and
//                             had never run in any cycle
//   current_lead_under_review the gatekeeper was asked whether the falsification
//                             was adequate and never shown it: `falsification`
//                             19 times in the prompt, `rival_mechanism` 0
//
// So a signal is registered with BOTH ends. The test greps the consumer for the
// signal's own name, which is the rule this repository learned the hard way:
// check the consumer for the field before blaming the consumer.
//
// A signal belongs here when one part of the system writes it FOR another part
// to act on. Not every write: a projection nobody is expected to read back, or
// a log, is not a signal. If you cannot name who acts on it, that is the
// finding, not a reason to leave the consumer blank.
const INTER_ROLE_SIGNALS = Object.freeze([
  {
    signal: "lab_director_alerts",
    runtime: {
      produced: { glob: "state/{cycle}-cycle-run-state.json", key: "lab_director_alerts" },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "lab_director_alerts" },
      conditional: "only when a blocking lane has failed",
    },
    what: "a blocking lane failed and the cycle needs a decision about it",
    producer: { file: `${RUST_ROOT}/chronicle/aggregate.rs`, role: "chronicle" },
    consumer: { file: `${RUST_ROOT}/labdirector/plan/task_graph_blocking_recovery.rs`, role: "lab-director" },
    delivered_via: "bus",
  },
  {
    signal: "dependency_stall",
    runtime: {
      produced: { glob: "state/{cycle}-dependency-stall.json", key: null },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "dependency_stall" },
      conditional: "only when a round launches nothing while nothing is running",
    },
    what: "nothing ran, nothing launched, and every pending lane is held on a blocker",
    producer: { file: `${RUST_ROOT}/labdirector/plan/run_loop.rs`, role: "harness" },
    consumer: { file: `${RUST_ROOT}/labdirector/plan/task_graph_blocking_recovery.rs`, role: "lab-director" },
    delivered_via: "bus",
  },
  {
    signal: "chronicle_decision_digest",
    runtime: {
      produced: { glob: "state/{cycle}-chronicle-decision-digest.json", key: null },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "chronicle_decision_digest" },
      conditional: null,
    },
    what: "the compact evidence a director is told to decide from, and forbidden to go around",
    producer: { file: `${RUST_ROOT}/labdirector/context/decision_digest.rs`, role: "chronicle" },
    consumer: { file: `${RUST_ROOT}/labdirector/research_context/role_plan_refresh/role_plan_refresh_01.rs`, role: "lab-director" },
    delivered_via: "role_plan_key",
  },
  {
    signal: "citable_corpus",
    runtime: {
      produced: { glob: "state/{cycle}-chronicle-decision-digest.json", key: "citable_corpus" },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "citable_corpus" },
      conditional: null,
    },
    what: "the admitted papers with the ids the screening gate validated, so a survey can attribute",
    producer: { file: `${RUST_ROOT}/labdirector/context/decision_digest.rs`, role: "chronicle" },
    consumer: { file: `${RUST_ROOT}/labdirector/policy.rs`, role: "lab-director" },
    delivered_via: "role_plan_key",
  },
  {
    signal: "instrument_inventory",
    runtime: {
      produced: { glob: "state/{cycle}-instrument-inventory.json", key: null },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "instrument_inventory" },
      conditional: null,
    },
    what: "what this container was measured to be able to do, which every hypothesis must cite",
    // `emit` in common.py is what writes the artifact; instrument_probe.py
    // dispatches the backends and never names the destination.
    producer: { file: "drivers/analysis/instrument_probes/common.py", role: "lab-runner" },
    consumer: { file: `${RUST_ROOT}/labdirector/research_context/role_plan_refresh/role_plan_refresh_01.rs`, role: "lab-director" },
    delivered_via: "role_plan_key",
  },
  {
    signal: "implemented_but_not_probed",
    runtime: {
      produced: { glob: "state/{cycle}-instrument-inventory.json", key: "implemented_but_not_probed" },
      delivered: { glob: "state/{cycle}-instrument-inventory.json", key: "implemented_but_not_probed" },
      conditional: null,
    },
    what: "a capability that exists in this tree and was never measured",
    producer: { file: "drivers/analysis/instrument_probe.py", role: "lab-runner" },
    consumer: { file: "src/agents/index.js", role: "harness" },
    delivered_via: "role_plan_key",
  },
  {
    signal: "current_lead_under_review",
    runtime: {
      produced: { glob: "lanes/{cycle}/*/role-plan.json", key: "current_lead_under_review" },
      delivered: { glob: "lanes/{cycle}/*/prompt.txt", key: "current_lead_under_review" },
      conditional: "only once a lead exists and a gatekeeper lane has launched",
    },
    what: "the lead in the terms the gate scores it on, including its own falsification conditions",
    producer: { file: `${RUST_ROOT}/labdirector/followups/role_plan/role_plan_01.rs`, role: "lab-director" },
    consumer: { file: `${RUST_ROOT}/labdirector/followups/role_plan/role_plan_01.rs`, role: "gatekeeper" },
    delivered_via: "role_plan_key",
  },
  {
    signal: "stray-lane-directory-skipped",
    runtime: null,
    runtime_absent_reason: "a cycle event, not a cycle artifact: its delivery is the event log line itself, which the producer writes and no lane reads back",
    what: "a lane directory that collided with a real one, with the evidence that could name its creator",
    producer: { file: "src/storage/metadata_store.js", role: "harness" },
    consumer: { file: "tests/metadata_store_task_id_collision.test.js", role: "operator" },
    delivered_via: "bus",
  },
  {
    signal: "authoritative-state-write",
    runtime: null,
    runtime_absent_reason: "a cycle event, not a cycle artifact: the record is the audit line, and its reader is a person or a later audit rather than a lane",
    what: "a decision artifact was created, replaced or removed, and by whom",
    producer: { file: "src/provenance/state_provenance.js", role: "harness" },
    consumer: { file: "tests/state_provenance.test.js", role: "operator" },
    delivered_via: "bus",
  },
  {
    signal: "experiment_requests",
    runtime: {
      produced: { glob: "state/{cycle}-experiment-requests.json", key: null },
      delivered: { glob: "lanes/{cycle}/*/role-plan.json", key: "experiment_requests" },
      conditional: "only when the author has asked for one",
    },
    what: "the author asking the director for an experiment the manuscript needs",
    producer: { file: "src/reporting/message_bus/index.js", role: "author" },
    consumer: { file: `${RUST_ROOT}/labdirector/followups/role_plan/role_plan_01.rs`, role: "lab-director" },
    delivered_via: "bus",
  },
]);

function interRoleSignals() {
  return INTER_ROLE_SIGNALS.map((entry) => ({ ...entry }));
}

function governedRules() {
  return GOVERNED_RULES.map((entry) => ({ ...entry }));
}

module.exports = {
  DELIVERY_MODES,
  GOVERNED_RULES,
  UNGOVERNED_KEYS,
  INTER_ROLE_SIGNALS,
  governedRules,
  interRoleSignals,
};
