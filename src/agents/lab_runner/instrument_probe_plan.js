"use strict";

const fs = require("fs");
const path = require("path");

// A capability probe precedes the hypothesis and selects its tool explicitly.
const PROBE_DRIVER = "drivers/analysis/instrument_probe.py";
// Where the backends themselves live. The driver keeps the registry that maps a
// name to its module; naming them again here would be a second copy to edit in
// lockstep, so this asks whether the module exists instead. A backend added to
// the driver works here with no change.
const PROBE_BACKEND_DIR = "drivers/analysis/instrument_probes";
// Resolved from this module's own location, not the working directory: a lane
// builds its plan from wherever it happens to be running, and the first version
// of this check asked the cwd and rejected `python` under the test harness.
const INSTALL_ROOT = path.resolve(__dirname, "..", "..", "..");

function probeBackendExists(backend, root = INSTALL_ROOT) {
  if (!backend || /[^A-Za-z0-9_]/.test(backend)) return false;
  return fs.existsSync(path.join(root, PROBE_BACKEND_DIR, `${backend}.py`));
}

function inventoryStatePath(cycleId) {
  return `.research-lab/state/${cycleId}-instrument-inventory.json`;
}

// Who decides which backends exist: the driver, once.
//
// The default here used to be the literal "python", and the launcher set
// nothing, so a computer-graphics cycle probed the standard library and never
// ran instrument_probes/mitsuba.py -- four hundred lines, sitting beside it,
// never executed. Mitsuba 3.8.0 renders in that container.
//
// My first repair replaced that literal with a directory scan in THIS file,
// which put one rule in two languages: JavaScript decided what a backend is by
// excluding a hardcoded ["common", "provisioning"], and Python decided by a
// hardcoded map of two names. Either could drift from the other, and both were
// name lists of exactly the kind that leaves a capability unreachable.
//
// So this file no longer decides. A plan that names no backend sends no backend
// list, and the driver -- which can actually import the modules -- takes every
// one that implements the contract. An explicitly named backend is still
// checked here, because a typo is worth catching before a lane is dispatched,
// and the driver rejects an unknown name again regardless.
// Inputs a backend reads rather than a choice of backend. They pass through to
// whichever backends run; a backend that does not use them ignores them.
const PROBE_PATH_KEYS = ["source_root", "policy_path"];

function resolveProbeConfig({ probeConfig, env = process.env } = {}) {
  const named = env.RESEARCHLAB_INSTRUMENT_PROBE_BACKEND;
  const raw = probeConfig === undefined ? {
    ...(named ? { backend: named } : {}),
    source_root: env.RESEARCHLAB_DATA_ROOT,
    policy_path: env.RESEARCHLAB_INSTRUMENT_PROBE_POLICY,
  } : probeConfig;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("probeConfig must be an object");
  let backends = null;
  if (Array.isArray(raw.backends)) backends = raw.backends;
  else if (raw.backend !== undefined && raw.backend !== null) backends = [raw.backend];
  const config = {};
  if (backends !== null) {
    backends = backends.map((name) => (typeof name === "string" ? name.trim() : name));
    if (!backends.length) throw new Error("probeConfig named no backend");
    for (const backend of backends) {
      if (!probeBackendExists(backend)) {
        throw new Error(
          `unsupported instrument probe backend: ${backend} (no ${PROBE_BACKEND_DIR}/${backend}.py)`,
        );
      }
    }
    config.backends = [...new Set(backends)];
  }
  for (const key of PROBE_PATH_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "string" || !raw[key].trim() || !path.isAbsolute(raw[key].trim())) {
      throw new Error(`instrument probe ${key} must be an absolute path`);
    }
    config[key] = path.normalize(raw[key].trim());
  }
  // Caught before a lane is dispatched; the backend rejects it again regardless.
  if (config.backends?.includes("superdex") && (!config.source_root || !config.policy_path)) {
    throw new Error("superdex instrument probe requires explicit source_root and policy_path");
  }
  return config;
}

function buildInstrumentProbePlan({ prompt, laneId, cycleId, assignedModel = null, probeConfig }) {
  const config = resolveProbeConfig({ probeConfig });
  const outPath = inventoryStatePath(cycleId);
  const invocation = {
    executable: process.env.RESEARCHLAB_PYTHON || "python3",
    argv: [PROBE_DRIVER, "--config-json", JSON.stringify(config)],
    env: { RESEARCHLAB_INSTRUMENT_INVENTORY_OUT: outPath },
  };
  return {
    lane_id: laneId, role: "lab-runner", role_alias: "instrument-prober",
    source: "harness", prompt, assigned_model: assignedModel,
    requires_analyst_handoff: false,
    instruction_handoff_policy: "instrument-probe-runs-before-any-hypothesis-exists",
    analysis_mode: "execution-only", scientist_mode: "capability-measurement-only",
    analysis_profile: "instrument-inventory-probe", lane_kind: "instrument_probe",
    probe_config: config, probe_output_path: outPath, probe_invocation: invocation,
    execution_mandate: [
      `execute ${PROBE_DRIVER} with the declared probe_config (${config.backends ? `backends=${config.backends.join(", ")}` : "every backend the driver implements"})`,
      "the external driver passes probe_config directly; use probe_invocation as a structured argument list for standalone reproduction",
      "report what the selected tool measured; unselected tools have not been tested",
      "record unavailable capabilities and their errors without replacing the selected tool",
      "do not propose or evaluate a hypothesis, or widen a capability probe into an experiment",
    ],
    validation_coding_task: {
      task_id: `${cycleId}-instrument-inventory`,
      goal: "Measure the selected tool's observables so answerable_here_because can cite an actual capability record.",
      invocation, required_artifact: outPath,
      extend_when: [
        "an unavailable capability reflects an incorrect probe invocation rather than evidence of absence",
        "the research question needs an observable not covered by the selected probe",
      ],
      extension_rule: "Extend the selected backend, re-run it, and keep a complete measured inventory. Never hand-edit a capability claim into the inventory.",
      forbidden: [
        "marking a capability available without its measured evidence",
        "deleting negative results or reusing a previous inventory after the current probe failed",
        "substituting a different tool or cheaper workload without declaring that change",
      ],
    },
    analysis_goals: [
      "execute the explicitly selected capability probe end to end",
      `write the current measured inventory to ${outPath}`,
      "record unavailable instruments and the observations or errors supporting that result",
      "report the actual probe duration without assuming another tool's benchmark costs",
    ],
    required_outputs: [
      { name: "instrument_inventory", path: outPath, description: "selected configuration, verified and unavailable instruments, measurable quantities, and raw measurements" },
      { name: "probe_summary", description: "what was measured, what remains unavailable or untested, and the limitations of this capability check" },
    ],
    validation_checks: [], hypothesis_focus: null,
    gate_scoring_policy: "Capability measurement is not hypothesis validation and does not establish novelty, technical quality or reproducibility of a research claim.",
    open_ended_timeout_policy: {
      tier: "instrument-probe", codex_timeout_seconds: 240, script_timeout_seconds: 600,
      trigger_reason: "Bound the individual capability probe; report measured elapsed time and retain timeout failures.",
    },
  };
}

module.exports = { buildInstrumentProbePlan, resolveProbeConfig, inventoryStatePath, probeBackendExists, PROBE_DRIVER, PROBE_BACKEND_DIR };
