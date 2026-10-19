"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonicalOperationalSpec(spec) {
  if (!spec || !Array.isArray(spec.required_contrast_ids) || !spec.comparator) return spec;
  const registered = spec.contrast_comparators || {};
  const comparators = {};
  let needsMap = Object.keys(registered).length > 0;
  for (const contrastId of spec.required_contrast_ids) {
    const encoded = /(?:_vs_|_minus_)([a-z0-9][a-z0-9_]*)$/i.exec(contrastId)?.[1];
    comparators[contrastId] = registered[contrastId] || encoded || spec.comparator;
    if (comparators[contrastId] !== spec.comparator) needsMap = true;
  }
  return needsMap ? { ...spec, contrast_comparators: comparators } : spec;
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
function currentAnalysisContract(root, cycleId) {
  if (!root || !cycleId) return null;
  const policy = read(path.join(root, "state", `${cycleId}-analysis-contract-policy.json`));
  if (!policy?.enabled) return null;
  const hypothesis = read(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`));
  const lead = hypothesis?.selected_hypothesis || hypothesis;
  if (!lead?.statement) throw new Error("Enabled analysis-contract policy has no readable canonical hypothesis.");
  let spec = policy.specs?.[lead.primary_family] || null;
  if (spec?.canonical_statement && (spec.canonical_statement !== lead.statement
      || JSON.stringify(spec.canonical_estimands) !== JSON.stringify(lead.identification_strategy?.estimands || []))) spec = null;
  // MEASURED ON cycle-a-20260919, 2026-10-16: runner 359 emitted
  // behavior_transformer and hact_vq for contrasts whose registered IDs said
  // `_minus_behavior_transformer` / `_minus_hact_vq`, but the canonical contract
  // exposed only its chunked_bc default and the verifier rejected those rows.
  // Make the comparator already encoded by each registered contrast ID explicit;
  // this changes the contract ID so old executions cannot be relabelled.
  spec = canonicalOperationalSpec(spec);
  const contract = {
    version: 1, cycle_id: cycleId, primary_family: lead.primary_family,
    statement: lead.statement, dataset: lead.dataset_or_accession || hypothesis.dataset_or_accession,
    estimands: lead.identification_strategy?.estimands || [],
    falsification_conditions: lead.falsification_conditions || [],
    rival_mechanisms: lead.rival_mechanisms || [],
    scope: lead.claim_scope_narrowed_from || null, operational_spec: spec,
  };
  const operational = spec && Object.fromEntries(Object.entries(spec).filter(([key]) => !["canonical_statement", "canonical_estimands", "base_contract_id"].includes(key)));
  contract.contract_id = `analysis:${digest({ ...contract, operational_spec: operational })}`;
  return contract;
}
const ANALYST_CONTRACT_INSTRUCTION = "Prepare the executable validation for planner_metadata.analysis_contract. Use its exact comparator, quantifiers, estimands, dataset, and decision margin. For every primary contrast, use operational_spec.contrast_comparators[contrast_id] when present and only otherwise use operational_spec.comparator. Emit primary_hypothesis_id=contract_id and a validation_target whose claim_text is the exact canonical statement. Read the analysis contract from RESEARCHLAB_ANALYSIS_CONTRACT in the blueprint; emit analysis_contract_id and a primary_contrasts.csv with exactly the required contrast IDs and comparator labels. Every estimable row must contain finite estimate, simultaneous_lower, and simultaneous_upper values. If a preregistered validity gate makes the design invalid, instead emit every required row with status=not_estimable_design_invalid and all estimate and interval fields blank, plus validity_gates.csv proving the failed registered threshold; never mix descriptive estimates with missing bounds. Preserve actual scientific failures and uncertainty. Never substitute a policy mean or a different comparator. Do not reuse or relabel previously executed code: author a revised frozen blueprint for exactly one new immutable validation run. Supporting audits must explicitly use analysis_evidence_role=supporting in the handoff check column_mapping and cannot validate the primary claim. Immediately before writing the final handoff, run node src/policy/analysis_contract.js $PWD <cycle_id> --current and compare its contract_id with planner_metadata.analysis_contract.contract_id. If it changed while this lane was running, re-read the current contract and revise the handoff and frozen blueprint to match it before completing; do not submit the superseded contract for another Analyst to repair.";

const NEW_RUN_SENTENCE = " Do not reuse or relabel previously executed code: author a revised frozen blueprint for exactly one new immutable validation run.";
if (!ANALYST_CONTRACT_INSTRUCTION.includes(NEW_RUN_SENTENCE)) throw new Error("analysis_contract: the new-run sentence moved");

function analysisContractIds(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => analysisContractIds(item, found));
  else if (value && typeof value === "object") {
    if (typeof value.contract_id === "string" && value.contract_id.startsWith("analysis:")) found.add(value.contract_id);
    Object.values(value).forEach((item) => analysisContractIds(item, found));
  }
  return found;
}

function clearStaleAnalysisContext(plan, contractId) {
  let changed = false;
  for (const field of ["failed_runner_context", "validation_results", "analysis_request", "review_action"]) {
    const ids = analysisContractIds(plan.planner_metadata?.[field]);
    if (ids.size && !ids.has(contractId)) {
      delete plan.planner_metadata[field];
      changed = true;
    }
  }
  return changed;
}

// A contract's verified primary measurements, and what they measured.
//
// MEASURED ON cycle-a-20260919, 2026-10-18: every Analyst bound to
// contract 12daf336 -- novelty, comparator, methods and interpretation lanes
// alike -- was told to author "exactly one new immutable validation run", and
// did: 18 runners (458-475) executed 18 new scripts on the same sealed data and
// wrote the same four estimates, 0.8992 [0.1585] first among them, every time.
// The Rust harness runs no third primary execution of a contract
// (role_plan_refresh_03.rs, CONTRACT_MEASUREMENTS_BEFORE_HOLD); the Analyst is
// told so, with the numbers, before it writes one.
const CONTRACT_MEASUREMENTS_BEFORE_HOLD = 2;

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell !== ""));
  return (body || []).map((cells) => Object.fromEntries((header || []).map((name, column) => [name, cells[column] ?? ""])));
}

// MEASURED ON cycle-a-20260919, 2026-10-18: runners 486/487 measured
// one registered specification; after the lead incorporated their numbers its
// new contract ID sent the same specification to runners 493/494. The claim
// prose and registration epoch are not the execution identity.
function primaryMeasurementKey(contract) {
  if (!contract?.operational_spec || typeof contract.operational_spec !== "object") return null;
  const spec = { ...contract.operational_spec };
  for (const field of ["analysis_evidence_role", "canonical_statement", "canonical_estimands", "base_contract_id"]) delete spec[field];
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;
  return JSON.stringify(canonical(spec));
}

function runnerAnalysisContract(rolePlan) {
  return rolePlan?.planner_metadata?.analysis_request?.analyst_handoff?.analysis_contract
    || rolePlan?.planner_metadata?.analyst_handoff?.analysis_contract
    || rolePlan?.planner_metadata?.cycle_analyst_handoff?.payload?.analysis_contract
    || rolePlan?.analysis_request?.analyst_handoff?.analysis_contract
    || rolePlan?.analyst_handoff?.analysis_contract
    || null;
}

function contractMeasurements(root, cycleId, contract) {
  const contractId = typeof contract === "string" ? contract : contract?.contract_id;
  const measurementKey = typeof contract === "string" ? null : primaryMeasurementKey(contract);
  const state = read(path.join(root, "state", `${cycleId}-cycle-run-state.json`));
  const measured = [];
  for (const lane of state?.lane_statuses || []) {
    if (!/runner/.test(lane.lane_id || "")) continue;
    const dir = path.join(root, "lanes", cycleId, lane.lane_id);
    const executedContractId = read(path.join(dir, "analysis-contract-preflight.json"))?.contract_id;
    if (executedContractId !== contractId) {
      const executedKey = primaryMeasurementKey(runnerAnalysisContract(read(path.join(dir, "role-plan.json"))));
      if (!measurementKey || executedKey !== measurementKey) continue;
    }
    const result = read(path.join(dir, "result.json"));
    const binding = result?.analysis_contract_validation || result?.validation_summary?.analysis_contract_validation;
    if (binding?.contract_id !== executedContractId || binding?.status !== "verified" || binding?.evidence_role !== "primary") continue;
    const table = (result.blueprint_executions || []).flatMap((execution) => execution.tables || [])
      .find((item) => item?.name === "primary_contrasts.csv");
    let contrasts = [];
    try {
      contrasts = parseCsv(fs.readFileSync(table.path, "utf8")).map((row) => ({
        contrast_id: row.contrast_id,
        estimate: row.estimate,
        simultaneous_lower: row.simultaneous_lower,
        simultaneous_upper: row.simultaneous_upper,
        status: row.status || null,
      }));
    } catch {
      contrasts = [];
    }
    measured.push({ lane_id: lane.lane_id, result_path: path.join(dir, "result.json"), primary_contrasts: contrasts });
  }
  return measured.sort((left, right) => left.lane_id.localeCompare(right.lane_id, undefined, { numeric: true }));
}

function measurementInstruction(measurements) {
  if (!measurements.length) return "";
  const lanes = measurements.map((item) => item.lane_id).join(", ");
  const numbers = (measurements[0].primary_contrasts || [])
    .map((row) => `${row.contrast_id}=${row.estimate || row.status || "?"} [${row.simultaneous_lower || "?"}, ${row.simultaneous_upper || "?"}]`)
    .join("; ");
  const measuredBy = ` This primary measurement is already available: verified execution${measurements.length > 1 ? "s" : ""} ${lanes}${numbers ? ` (${numbers})` : ""}; see planner_metadata.analysis_contract_measurements.`;
  if (measurements.length >= CONTRACT_MEASUREMENTS_BEFORE_HOLD) {
    return `${measuredBy} The same registered estimands on the same sealed data reproduce these numbers, and the harness runs no further primary execution of this measurement specification. Work from these measurements. Any new execution must be a supporting audit (analysis_evidence_role=supporting) that measures something the primary contrasts do not; if the measurement itself is wrong, say why in your result so the LabDirector can change the lead or its specification.`;
  }
  return `${measuredBy} One independent reproduction of it may still run; author it only if your assignment needs one.`;
}

function bindAnalystPlan(plan, contract, recovery = null, measurements = []) {
  plan.planner_metadata ||= {};
  const staleContextCleared = clearStaleAnalysisContext(plan, contract.contract_id);
  const previous = plan.planner_metadata?.analysis_contract;
  const measuredBy = measurements.map((item) => item.lane_id);
  const contractBound = previous?.contract_id === contract.contract_id
      && JSON.stringify(plan.assigned_hypotheses) === JSON.stringify([contract.statement])
      && plan.planner_metadata.analysis_contract_binding_version === 5
      && JSON.stringify((plan.planner_metadata.analysis_contract_measurements || []).map((item) => item.lane_id)) === JSON.stringify(measuredBy)
      && (contract.operational_spec || plan.followup_description?.includes("--register-spec"));
  const recoveryBound = !recovery || (plan.planner_metadata?.analysis_contract_recovery?.lane_id === recovery.lane_id
    && JSON.stringify(plan.planner_metadata.analysis_contract_recovery.problems) === JSON.stringify(recovery.analysis_contract_validation.problems));
  if (contractBound && recoveryBound && !staleContextCleared) return false;
  if (!contractBound) plan.assigned_hypotheses = [contract.statement];
  plan.planner_metadata.analysis_contract = contract;
  // MEASURED ON cycle-a-20260919, 2026-10-16: runner 347's frozen
  // blueprint mixed descriptive rows with three required contrasts that had no
  // simultaneous bounds because the analyst assignment never stated the
  // verifier's complete-row / design-invalid output alternatives.
  // MEASURED ON cycle-a-20260919, 2026-10-18: analysts 966 and 998
  // exactly followed their start-of-lane contracts, but those contracts changed
  // before completion and both finished handoffs were discarded as stale.
  plan.planner_metadata.analysis_contract_binding_version = 5;
  plan.planner_metadata.current_lead_under_analysis = contract;
  plan.planner_metadata.candidate_hypotheses = [{ family: contract.primary_family, statement: contract.statement }];
  // Old scientific assignments must not compete with the canonical contract.
  plan.planner_metadata.blocker_reasons = [];
  plan.analysis_goals = contract.estimands;
  plan.followup_description = measurements.length >= CONTRACT_MEASUREMENTS_BEFORE_HOLD
    ? ANALYST_CONTRACT_INSTRUCTION.replace(NEW_RUN_SENTENCE, "")
    : ANALYST_CONTRACT_INSTRUCTION;
  if (measurements.length) plan.planner_metadata.analysis_contract_measurements = measurements;
  else delete plan.planner_metadata.analysis_contract_measurements;
  plan.followup_description += measurementInstruction(measurements);
  if (!contract.operational_spec) plan.followup_description += " Before authoring the blueprint, preregister a machine-readable spec under this lane: comparator, required_contrast_ids, dataset_sha256, canonical_statement, canonical_estimands, and base_contract_id. Register it with node src/policy/analysis_contract.js <cwd> <cycleId> <laneId> --register-spec <spec-file>. Use the returned updated contract_id. Registration cannot overwrite an existing registered specification or change the canonical hypothesis.";
  if (recovery) {
    // MEASURED ON cycle-a-20260919, 2026-10-17: runner 420's current-
    // contract script failed before writing primary_contrasts.csv or its executed
    // contract ID, while three already-bound pending Analysts received no record
    // of that execution and therefore could not repair its frozen blueprint.
    const analysisRequest = {
      source: "analysis-contract-mismatch-recovery",
      failed_runner_context: recovery,
      regenerate_frozen_blueprint: true,
      execute_new_immutable_validation_once: true,
    };
    plan.planner_metadata.analysis_contract_recovery = {
      lane_id: recovery.lane_id,
      problems: recovery.analysis_contract_validation.problems,
    };
    plan.planner_metadata.failed_runner_context = recovery;
    plan.planner_metadata.validation_results = recovery;
    plan.planner_metadata.analysis_request = analysisRequest;
    plan.analysis_request = analysisRequest;
    plan.followup_description += ` Repair the failed execution in ${recovery.lane_id}: ${recovery.analysis_contract_validation.problems.join(", ")}. Read planner_metadata.failed_runner_context and its result and handoff paths, fix the frozen code that actually ran, and replace it with one newly authored immutable blueprint. Do not dispatch or relabel the failed script.`;
  }
  return true;
}
function bindLane({ cwd, cycleId, laneId, recovery = null }) {
  const root = path.join(cwd, ".research-lab");
  const contract = currentAnalysisContract(root, cycleId);
  if (!contract) return { enabled: false };
  const dir = path.join(root, "lanes", cycleId, laneId);
  const plan = read(path.join(dir, "role-plan.json"));
  if (!plan || (plan.role && plan.role !== "analyst")) return { enabled: true, changed: false };
  const changed = bindAnalystPlan(plan, contract, recovery, contractMeasurements(root, cycleId, contract));
  writeJson(path.join(dir, "role-plan.json"), plan);
  fs.writeFileSync(path.join(dir, "task.md"), `# Canonical analysis assignment\n\n${plan.objective || ""}\n\n## Current hypothesis\n${contract.statement}\n\n## Required validation contract\n${JSON.stringify(contract, null, 2)}\n\n${plan.followup_description}\n`);
  writeJson(path.join(root, "state", `${cycleId}-analysis-contract.json`), contract);
  return { enabled: true, changed, contract_id: contract.contract_id };
}

function latestContractMismatch(root, cycleId, contract) {
  const state = read(path.join(root, "state", `${cycleId}-cycle-run-state.json`));
  const runners = (state?.lane_statuses || []).flatMap((lane) => {
    const dir = path.join(root, "lanes", cycleId, lane.lane_id);
    const role = lane.role || read(path.join(dir, "lane-contract.json"))?.role;
    if (role !== "lab-runner") return [];
    return [{ lane, dir, completed_at: read(path.join(dir, "final-status.json"))?.completed_at || "" }];
  }).sort((left, right) => right.completed_at.localeCompare(left.completed_at));
  for (const { lane, dir, completed_at } of runners) {
    const resultPath = path.join(dir, "result.json"), result = read(resultPath);
    const binding = result?.analysis_contract_validation || result?.validation_summary?.analysis_contract_validation;
    if (binding?.contract_id !== contract.contract_id || binding.status !== "mismatch") continue;
    return {
      lane_id: lane.lane_id,
      completed_at,
      result_path: resultPath,
      executed_handoff_path: result.executed_handoff_path || null,
      analysis_contract_validation: binding,
      analysis_trace: result.analysis_trace || null,
      blueprint_executions: (result.blueprint_executions || []).map((execution) => ({
        blueprint_id: execution.blueprint_id,
        check_id: execution.check_id,
        status: execution.status,
        error: execution.error || null,
        script_path: execution.script_path || null,
      })),
    };
  }
  return null;
}

function repairQueuedAnalystContracts({ cwd, cycleId }) {
  const root = path.join(cwd, ".research-lab");
  const current = currentAnalysisContract(root, cycleId);
  if (!current) return [];
  const state = read(path.join(root, "state", `${cycleId}-cycle-run-state.json`));
  const recovery = latestContractMismatch(root, cycleId, current);
  const pending = (state?.lane_statuses || []).filter((lane) => ["pending", "prepared"].includes(lane.status)
    && read(path.join(root, "lanes", cycleId, lane.lane_id, "lane-contract.json"))?.role === "analyst"
    && read(path.join(root, "lanes", cycleId, lane.lane_id, "run-state.json"))?.status !== "running");
  // One Analyst owns regeneration so one bad execution produces one replacement,
  // even when unrelated novelty or Chronicle Analyst work was already queued.
  const existingOwner = recovery && (state?.lane_statuses || []).find((lane) => {
    const dir = path.join(root, "lanes", cycleId, lane.lane_id);
    const role = lane.role || read(path.join(dir, "lane-contract.json"))?.role;
    return role === "analyst" && read(path.join(dir, "role-plan.json"))
      ?.planner_metadata?.analysis_contract_recovery?.lane_id === recovery.lane_id;
  })?.lane_id;
  const recoveryOwner = recovery && (existingOwner || [...pending].sort((left, right) => {
    const action = (lane) => read(path.join(root, "lanes", cycleId, lane.lane_id, "role-plan.json"))?.action_type;
    const rank = (lane) => /runner_(?:result|failure)/.test(action(lane) || "") ? 0 : 1;
    return rank(left) - rank(right) || left.lane_id.localeCompare(right.lane_id);
  })[0]?.lane_id || null);
  const repaired = [];
  for (const lane of pending) {
    const laneRecovery = lane.lane_id === recoveryOwner ? recovery : null;
    if (bindLane({ cwd, cycleId, laneId: lane.lane_id, recovery: laneRecovery }).changed) repaired.push(lane.lane_id);
  }
  return repaired;
}
function registerSpec({ cwd, cycleId, laneId, specPath }) {
  const root = path.join(cwd, ".research-lab"), current = currentAnalysisContract(root, cycleId);
  if (!current || current.operational_spec) throw new Error("An existing scientific specification cannot be overwritten by contract repair.");
  const dir = fs.realpathSync(path.join(root, "lanes", cycleId, laneId));
  const source = fs.realpathSync(specPath);
  if (!source.startsWith(dir + path.sep)) throw new Error("Specification must be saved in the authoring lane.");
  const spec = read(source);
  if (spec?.base_contract_id !== current.contract_id || spec.canonical_statement !== current.statement
      || JSON.stringify(spec.canonical_estimands) !== JSON.stringify(current.estimands)
      || typeof spec.comparator !== "string" || !spec.comparator
      || !Array.isArray(spec.required_contrast_ids) || !spec.required_contrast_ids.length
      || new Set(spec.required_contrast_ids).size !== spec.required_contrast_ids.length
      || !/^[a-f0-9]{64}$/.test(spec.dataset_sha256 || "")) throw new Error("Specification does not match the canonical scientific assignment.");
  const file = path.join(root, "state", `${cycleId}-analysis-contract-policy.json`), policy = read(file);
  policy.specs ||= {}; policy.specs[current.primary_family] = spec;
  writeJson(file, policy);
  bindLane({ cwd, cycleId, laneId });
  return currentAnalysisContract(root, cycleId);
}
module.exports = { CONTRACT_MEASUREMENTS_BEFORE_HOLD, currentAnalysisContract, bindAnalystPlan, bindLane, contractMeasurements, repairQueuedAnalystContracts, registerSpec };
if (require.main === module) {
  const [, , cwd, cycleId, laneId, operation, specPath] = process.argv;
  process.stdout.write(JSON.stringify(operation === "--register-spec" ? registerSpec({ cwd, cycleId, laneId, specPath }) : laneId === "--current"
    ? currentAnalysisContract(path.join(cwd, ".research-lab"), cycleId)
    : bindLane({ cwd, cycleId, laneId })));
}
