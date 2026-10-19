"use strict";

// A role exists only where every layer agrees it exists.
//
// Adding a role touches five layers in two languages, and four of them fail
// SILENTLY when they are missed -- not with an error, but by quietly doing
// something else:
//
//   stage policy      the role is never allowed into a stage, so no lane opens
//   follow-up caps    a role with no cap entry reads `unwrap_or(0)`, which is a
//                     permanent refusal that looks like a director that will
//                     not dispatch
//   dispatch branch   the chain on `preferred_role` ends in an `else` that
//                     returns lab-runner, so an unmatched role is DISPATCHED AS
//                     SOMETHING ELSE under its own lane id
//   lane identity     the role cannot be recovered from a lane id, so its
//                     follow-ups get another role's default action
//   output contract   the role falls through to "" and runs with no output
//                     contract at all -- measured twice already, on the author
//                     and then on the illustrator, whose lane ran on 632 bytes
//
// This project's recurring failure is a rule that was never DELIVERED to the
// layer that had to act on it. These assertions are that check, run against the
// sources rather than remembered.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HARNESS = path.join(ROOT, "native", "researchlab-harness", "src");

function read(...parts) {
  return fs.readFileSync(path.join(...parts), "utf8");
}

const { STAGE_ROLE_POLICY } = require("../src/policy/stage_policy");

// "falsifier" is an adversarial REVIEW MODE carried on a gatekeeper lane, not a
// role of its own: it reuses the gatekeeper's runtime, caps and whitelist and is
// distinguished by review_mode. It is listed in the stage policy because that is
// where the stage's reviewers are named. See src/agents/index.js "gatekeeper".
const ROLE_MODE_ALIASES = new Map([["falsifier", "gatekeeper"]]);

function declaredRoles() {
  const out = new Set();
  for (const roles of Object.values(STAGE_ROLE_POLICY)) {
    for (const role of roles) out.add(ROLE_MODE_ALIASES.get(role) || role);
  }
  // The supervisor is prepended by allowedRolesForStage rather than listed.
  out.add("lab-director");
  return [...out].sort();
}

// One function's body, and not the next one's. Slicing to end-of-file made the
// first version of the cap assertions pass on the OTHER map's entries: deleting
// the total cap still left the per-pass cap in the slice, so a role with no
// budget at all read as budgeted. Caught by removing the entry and watching the
// test stay green.
function fnBody(source, name) {
  const start = source.indexOf(`fn ${name}`);
  assert.notEqual(start, -1, `no function named ${name}`);
  const next = source.indexOf("\npub(crate) fn ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

// 2026-10-03: one follow-up budget for the cycle (budget_caps::total_followup_cap).
// A lifetime cap per role was the cause of one stall after another on
// cycle-a-20260919 (engineer 240/240, director 321/320, chronicle
// 167/160); a role's per-pass budget (next test) is what keeps it from running
// away. This keeps the per-role lifetime caps from coming back unnoticed.
test("role separation: the follow-up budget is one number, not one per role", () => {
  const caps = read(HARNESS, "labdirector/followups/dispatch_support/budget_caps.rs");
  const availability = read(HARNESS, "labdirector/followups/dispatch_support/role_availability.rs");
  assert.ok(caps.includes("fn total_followup_cap()"), "the cycle's one budget is gone");
  for (const [source, text] of [["budget_caps.rs", caps], ["role_availability.rs", availability]]) {
    assert.ok(!/total_cap_by_role|total_followup_cap_by_role|exempt_cap_multiplier/.test(text),
      `${source} has a per-role lifetime cap again`);
  }
});

test("role separation: every dispatchable role has a per-pass budget", () => {
  const caps = read(HARNESS, "labdirector/followups/dispatch_support/budget_caps.rs");
  const pass = fnBody(caps, "pass_followup_budget_by_role");
  const missing = declaredRoles().filter((role) => !pass.includes(`("${role}",`));
  assert.deepEqual(missing, [], "these roles have no per-pass budget");
});

test("role separation: no role falls through the dispatch chain into another role's lane", () => {
  // The chain ends `} else { ("lab-runner", ...) }`. A role with no branch is
  // not refused -- it is dispatched as a lab-runner while carrying its own
  // requested role, which is the hardest kind of bug to see from the outside.
  const dispatch = read(HARNESS, "labdirector/followups/dispatch.rs");
  const missing = declaredRoles().filter(
    (role) => role !== "lab-runner" && !dispatch.includes(`preferred_role == "${role}"`),
  );
  assert.deepEqual(
    missing,
    [],
    "these roles have no branch on preferred_role, so a request for them is dispatched as a lab-runner",
  );
});

test("role separation: every role can be recovered from its lane id", () => {
  const identity = read(HARNESS, "labdirector/lane_identity.rs");
  const inference = identity.slice(0, identity.indexOf("pub(crate) fn lane_id_looks_like_analyst"));
  const missingInference = declaredRoles().filter((role) => !inference.includes(`"${role}"`));
  assert.deepEqual(missingInference, [], "these roles cannot be inferred from a lane id");

  const actions = identity.slice(identity.indexOf("fn default_followup_action_for_role"));
  const missingAction = declaredRoles().filter(
    (role) => !actions.includes(`"${role}" =>`),
  );
  assert.deepEqual(
    missingAction,
    [],
    "these roles have no default follow-up action and inherit the catch-all",
  );
});

test("role separation: every role that reasons has an output contract", () => {
  // Roles whose lane is an external driver return the driver's artifacts and
  // need no JSON contract; roles that reason return JSON, and a missing branch
  // gives them "" -- the author and the illustrator each shipped that way.
  const prompt = read(HARNESS, "runtime/codex_prompt.rs");
  const chain = prompt.slice(prompt.indexOf("let output_contract ="));
  const reasoning = declaredRoles().filter((role) => role !== "lab-runner" && role !== "scout");
  const missing = reasoning.filter((role) => !chain.includes(`contract.role == "${role}"`));
  assert.deepEqual(missing, [], "these roles run against an empty output contract");
});

// ------------------------------------------------- the boundary itself

test("role separation: the analyst declares what it needs and does not provision it", () => {
  const analyst = read(ROOT, "src/agents/analyst/query_plan.js");
  assert.ok(
    /capability_requirements/.test(analyst),
    "the analyst has no way to state what the design needs, so nothing can provision for it",
  );
  const policy = read(HARNESS, "labdirector/policy.rs");
  const directive = policy.slice(
    policy.indexOf("fn open_source_analysis_agent_directive"),
    policy.indexOf("fn engineer_provisioning_directive"),
  );
  // The clause used to end by telling the analyst to clone, install, smoke-test
  // and repair. Those verbs moving out is the whole change; if they come back,
  // the split has been undone in the only place that reaches a running lane.
  for (const verb of ["git clone", "smoke_test_command", "debug_attempts"]) {
    assert.ok(
      !directive.includes(verb),
      `the analyst directive still carries provisioning work: ${verb}`,
    );
  }

  // The directive is not the only thing that reaches an analyst lane. The
  // open-source policy object reaches ALL of them -- 225 of 225 on cycle-g-v89
  // -- and it still read "this is an Analyst responsibility ... environment
  // variable wiring" after the directive had been split. Moving prose out of one
  // producer while another producer keeps saying it is how a rule stays
  // undelivered here, so both are asserted.
  const repairPolicy = policy.slice(
    policy.indexOf("fn open_source_analysis_agent_policy"),
    policy.indexOf("\npub(crate) fn", policy.indexOf("fn open_source_analysis_agent_policy") + 1),
  );
  assert.ok(
    !/this is an Analyst responsibility/.test(repairPolicy),
    "the policy every analyst lane receives still assigns environment repair to the analyst",
  );
  assert.match(
    repairPolicy,
    /ENGINEER responsibility/,
    "nothing in that policy routes a dependency or environment failure to the engineer",
  );
  // ...and the method half must stay with the analyst. Routing everything to the
  // engineer would also pass the assertion above.
  assert.match(repairPolicy, /repair the column mapping/i);
});

test("role separation: the engineer provisions and neither reasons nor codes", () => {
  const { buildEngineerEnvironmentPlan } = require("../src/agents/engineer/environment_plan");
  const plan = buildEngineerEnvironmentPlan({
    prompt: "an experiment that needs something built",
    laneId: "engineer-01",
    cycleId: "cg-test",
  });
  assert.equal(plan.role, "engineer");
  assert.equal(plan.hypothesis_focus, null);
  assert.deepEqual(plan.validation_checks, []);
  const boundary = JSON.stringify(plan.role_boundary.does_not_own);
  assert.ok(/hypothesis|estimand/.test(boundary), "the engineer does not disclaim the science");
  assert.ok(/validation code/.test(boundary), "the engineer does not disclaim writing code");
  // A capability asserted without a run is what let four consecutive cycles
  // report a backend they did not have.
  assert.ok(
    plan.analysis_loop.some((stage) => stage.gate === "capability_proved_by_execution"),
    "nothing forces the engineer to prove a capability by running it",
  );
});

test("role separation: an unsatisfiable requirement returns as a decision, not a substitution", () => {
  // The failure this prevents is quiet: an engineer that cannot install what was
  // asked for and installs something near it instead has changed the experiment,
  // and no record anywhere says a method decision was made.
  const { buildEngineerEnvironmentPlan } = require("../src/agents/engineer/environment_plan");
  const plan = buildEngineerEnvironmentPlan({ prompt: "x", laneId: "engineer-01", cycleId: "cg-test" });
  assert.match(plan.role_boundary.escalation_rule, /Do not choose a replacement tool/);
});

test("role separation: the engineer names no tool of its own", () => {
  // Every hardcoded tool, venue or dataset list in this repository has failed
  // for the domain nobody enumerated. The engineer's requirements come from the
  // analyst's handoff and the measured inventory, so the file itself carries no
  // vocabulary that would bias which domains it can serve.
  const source = read(ROOT, "src/agents/engineer/environment_plan.js");
  const body = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  const requirements = /capability_requirements|declaredCapabilityRequirements/;
  assert.ok(requirements.test(body), "the engineer does not read a declared requirement");
  // A short, deliberately generic probe: these are the example tools the role
  // was described with, and none of them belongs in the code.
  for (const name of ["virtualenv", "blender", "mitsuba", "cad", "conda", "pip install"]) {
    assert.ok(
      !new RegExp(`\\b${name}\\b`, "i").test(body),
      `the engineer hardcodes a tool name: ${name}`,
    );
  }
});
