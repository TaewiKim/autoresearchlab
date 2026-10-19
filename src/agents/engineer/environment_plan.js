"use strict";

// The engineer builds the capability the design needs. It does not choose the
// science, and it does not write the validation code.
//
// Before this role existed the analyst did three jobs at once. Its own duty text
// asked it to design the identification strategy AND to discover open-source
// pipelines, clone them into a tool cache, read their dependencies, generate
// their config, run a smoke test, and -- when a runner failed -- repair the failed
// command, config, dependency or column mapping before re-issuing the handoff.
// Tool provisioning and scientific reasoning are different jobs with different
// failure modes: a wrong estimand is a thinking error and a missing shared
// library is not, and a lane that owns both spends its reasoning budget on
// whichever one is louder. This runtime has measured that: cycle-g-v65 through
// v68 all ran with no working render backend because a path was wrong, and the
// analyst lanes that were meant to notice were designing experiments.
//
// So the split is:
//
//   analyst    what question, what estimand, what comparator, what would
//              falsify it, and what the check must compute
//   engineer   an isolated runtime, the tools that design names, and a
//              recorded smoke run proving each one actually executes here
//   lab-runner writes and executes the validation code inside that runtime
//
// The engineer never names a tool the design did not ask for. The required
// tools come from the analyst's declared requirement and from the measured
// instrument inventory, never from a list in this file: this project's rule is
// that no tool name, venue name or dataset name is hardcoded, because every
// hardcoded list here has already failed for the domain nobody enumerated.

const { inventoryStatePath } = require("../lab_runner/instrument_probe_plan");
const { inferTopicTerms } = require("../shared/topic_terms");

function capabilityRecordPath(cycleId) {
  return `.research-lab/state/${cycleId}-engineering-capability.jsonl`;
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

/**
 * What the design says it needs, as the design said it.
 *
 * Read from the analyst's handoff, not inferred: an engineer that guesses the
 * requirement is choosing the method, which is the analyst's decision. When the
 * handoff declares nothing, that absence is reported as a blocker rather than
 * filled in with a default stack.
 */
function declaredCapabilityRequirements(cyclePlanningContext = null) {
  const fromHandoff = asList(cyclePlanningContext?.analyst_handoff?.capability_requirements);
  const fromPlan = asList(cyclePlanningContext?.next_cycle_plan?.capability_requirements);
  const out = [];
  for (const entry of [...fromHandoff, ...fromPlan]) {
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text) out.push({ requirement: text, requested_by: "analyst" });
      continue;
    }
    if (entry && typeof entry === "object") {
      const text = String(entry.requirement || entry.tool || entry.capability || "").trim();
      if (text) {
        out.push({
          requirement: text,
          purpose: entry.purpose || entry.reason || null,
          requested_by: entry.requested_by || "analyst",
        });
      }
    }
  }
  return out.slice(0, 24);
}

function buildEngineerEnvironmentPlan({
  prompt,
  laneId,
  cycleId,
  assignedModel = null,
  cyclePlanningContext = null,
}) {
  const requirements = declaredCapabilityRequirements(cyclePlanningContext);
  const recordPath = capabilityRecordPath(cycleId);
  const inventoryPath = inventoryStatePath(cycleId);
  return {
    lane_id: laneId,
    role: "engineer",
    role_alias: "research-engineer",
    source: "lab-director",
    prompt,
    assigned_model: assignedModel,
    analysis_mode: "provisioning-only",
    scientist_mode: "capability-provisioning-only",
    analysis_profile: "research-environment-provisioning",
    lane_kind: "engineering_capability",
    topic_terms: inferTopicTerms(prompt),
    // Everything the lane is allowed to want, and where it came from.
    capability_requirements: requirements,
    capability_record_path: recordPath,
    instrument_inventory_path: inventoryPath,
    // Append-only. A capability record is evidence of what ran on a given day;
    // rewriting it destroys the only account of why a later cycle could or could
    // not reproduce a result, and this runtime has already lost a score history
    // to one path being rewritten on every refresh.
    capability_record_policy: {
      append_only: true,
      one_line_per_attempt: true,
      never_rewrite_or_truncate: true,
      rationale:
        "A failed install is a finding about this machine and is kept. Overwriting the record leaves a later reader unable to tell an untried tool from one that was tried and refused to run.",
    },
    role_boundary: {
      owns: [
        "isolated runtime creation and the exact interpreter, package and version set inside it",
        "acquiring the tools the design named, from their own distribution or source",
        "a smoke run per tool that proves it executes on this machine, with the command and its output kept",
        "diagnosing and repairing a tool, dependency, config or command that failed for a lab-runner",
        "recording the capability so a later lane can cite it instead of re-deriving it",
      ],
      does_not_own: [
        "choosing the hypothesis, the estimand, the comparator or the success criterion",
        "writing or executing validation code, which is the lab-runner's lane",
        "deciding whether a result supports or falsifies a claim",
        "substituting a different method when the requested tool cannot be installed -- report the blocker and let the analyst choose",
      ],
      // The one that is easy to get wrong. A tool that will not install is a
      // constraint on the design, and a design decision belongs to the roles
      // that own it. An engineer that quietly swaps in a tool it could install
      // has changed the experiment without anyone deciding to.
      escalation_rule:
        "When a declared requirement cannot be satisfied, record the attempt, the error, and what was tried, then return the blocker. Do not choose a replacement tool.",
    },
    analysis_loop: [
      {
        stage: "read",
        question: "What capability did the design declare it needs, and what does the measured inventory already provide?",
        deliverables: [
          "the declared requirements, quoted from the handoff",
          "which of them the recorded instrument inventory already satisfies, with the measurement cited",
          "an explicit blocker when the handoff declares no requirement, rather than a default stack",
        ],
        read_narrowly: [
          `${inventoryPath}: verified and unavailable instruments, and the measurements behind each`,
          `${recordPath}: what earlier lanes in this cycle already provisioned, so work is not repeated`,
        ],
      },
      {
        stage: "isolate",
        question: "What isolated runtime will this cycle's work execute inside, and how is it addressed?",
        deliverables: [
          "the runtime's location and the exact command that activates or invokes it",
          "the interpreter or toolchain version it pins",
          "why isolation was or was not possible here, when it was not",
        ],
      },
      {
        stage: "provision",
        question: "For each unsatisfied requirement, what was installed or built, from where, and at what version?",
        deliverables: [
          "per requirement: source, version, install or build command, and the return code",
          "failures kept with their error text, not retried into silence",
          "system-level prerequisites that had to be satisfied first",
        ],
      },
      {
        stage: "prove",
        question: "What smoke run demonstrates each provisioned tool actually executes here?",
        deliverables: [
          "per tool: the smallest command that exercises it, its output, and its elapsed time",
          "an explicit unavailable verdict for anything whose smoke run did not succeed",
          "the environment variables and paths the run depended on",
        ],
        // Availability is claimed only from evidence. A capability asserted
        // without a run is what let four consecutive cycles report a working
        // backend they did not have.
        gate: "capability_proved_by_execution",
      },
      {
        stage: "hand-off",
        question: "What exactly does the lab-runner need to type to work inside this environment?",
        deliverables: [
          "the invocation contract: executable, arguments, working directory, environment",
          "the known limits of what was provisioned",
          "unsatisfied requirements returned as blockers, each with what was attempted",
        ],
      },
    ],
    execution_mandate: [
      "provision only what the design declared; an unrequested tool is scope the analyst did not choose",
      "prove every capability with a run, and record the command and its output",
      "keep failures: an install that did not work is a measurement of this machine",
      "repair a failed runner command, config or dependency when asked, and report what was wrong",
      "do not write validation code, and do not interpret a validation result",
    ],
    required_outputs: [
      {
        name: "engineering_capability_record",
        path: recordPath,
        description:
          "one appended line per provisioning attempt: requirement, source, version, command, return code, smoke run, verdict",
      },
      {
        name: "runner_invocation_contract",
        description:
          "executable, arguments, working directory and environment the lab-runner uses to run inside the provisioned environment",
      },
      {
        name: "capability_blockers",
        description:
          "declared requirements that could not be satisfied, each with the attempts and errors behind that verdict",
      },
    ],
    validation_checks: [],
    hypothesis_focus: null,
    gate_scoring_policy:
      "Provisioning a capability is not evidence for a research claim and establishes no novelty, technical quality or reproducibility on its own.",
    open_ended_timeout_policy: {
      tier: "engineering-provisioning",
      codex_timeout_seconds: 300,
      script_timeout_seconds: 900,
      // Builds and installs are slow and their slowness is not a failure. The
      // ceiling is here so a wedged download cannot hold a lane forever, and the
      // measured elapsed time is reported either way.
      trigger_reason:
        "Toolchain installation and first builds run long; bound the lane, report the measured time, and keep a timeout as a recorded failure rather than an absence.",
    },
    next_cycle_context: cyclePlanningContext?.next_cycle_plan || null,
  };
}

module.exports = {
  buildEngineerEnvironmentPlan,
  declaredCapabilityRequirements,
  capabilityRecordPath,
  inventoryStatePath,
};
