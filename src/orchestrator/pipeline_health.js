"use strict";

// Pipeline health: the defects that do not stop a cycle.
//
// The maintainer is woken by a pause, a crash, a harness stop, a repeated
// failure or a stall -- a cycle that cannot move. On cycle-a-20260919
// (2026-09-29) every harness defect found by hand was of the other kind: the
// cycle moved, lanes completed, and the harness wasted work or wrote something
// false while it did.
//
//   ca30796  ten gate re-reviews queued; the ones for four rubrics waited 17 h
//            while newer novelty re-reviews ran, so the gate scored the
//            current lead with reviews of a retired one
//   5410fa2  sixteen runners ran six analyst handoffs
//   274e5a5  runners read another bundle's episodes.csv for a relative name
//   ba5b7da  six handoffs with one blueprint, one dataset and six wordings;
//            three runners returned the same result three times
//   -        runs that failed before measuring anything recorded their check
//            as pass_fail "pass"
//   -        the gate oscillated between two scores for eight hours
//   -        the reproducibility reviewer was told no artifact paths exist
//            while the runner's tables and figures sat on disk
//
// Each detector below is one of those, read from what the cycle wrote. A
// finding is a maintainer trigger of kind `pipeline_health`; its signature
// names the instance, so a fixed defect that recurs somewhere new is seen
// again and one already attempted is not retried. None of them is a blocker:
// with no maintainer attempts left they are reported, never a reason to stop.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runnerDatasetKeys, datasetKeys, runnerHasRealExecution, isFailedExecutionNotEvidence } = require("../agents/shared/lead_evidence_match");
const { currentAnalysisContract } = require("../policy/analysis_contract");

const HEALTH_KIND = "pipeline_health";

function researchRoot(cwd) {
  return path.join(cwd, ".research-lab");
}

function healthReportPath({ cwd, cycleId }) {
  return path.join(researchRoot(cwd), "state", `${cycleId}-pipeline-health.json`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function shortHash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function healthConfig(env = process.env) {
  const number = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    enabled: env.RESEARCHLAB_PIPELINE_HEALTH !== "0",
    starvedHours: number(env.RESEARCHLAB_HEALTH_STARVED_HOURS, 6),
    starvedOvertaken: number(env.RESEARCHLAB_HEALTH_STARVED_OVERTAKEN, 3),
    oscillationWindowHours: number(env.RESEARCHLAB_HEALTH_OSCILLATION_HOURS, 24),
    oscillationReturns: number(env.RESEARCHLAB_HEALTH_OSCILLATION_RETURNS, 3),
    sealRejections: number(env.RESEARCHLAB_HEALTH_SEAL_REJECTIONS, 3),
    validationRefreshMinutes: number(env.RESEARCHLAB_HEALTH_VALIDATION_REFRESH_MINUTES, 15),
    repeatedResults: number(env.RESEARCHLAB_HEALTH_REPEATED_RESULTS, 3),
    repeatedResultWindowHours: number(env.RESEARCHLAB_HEALTH_REPEATED_RESULT_WINDOW_HOURS, 24),
    // Still repeating: the newest identical result is this recent.
    repeatedResultActiveHours: number(env.RESEARCHLAB_HEALTH_REPEATED_RESULT_ACTIVE_HOURS, 3),
    discardedWork: number(env.RESEARCHLAB_HEALTH_DISCARDED_WORK, 3),
    recentHours: number(env.RESEARCHLAB_HEALTH_RECENT_HOURS, 3),
    logHourMegabytes: number(env.RESEARCHLAB_HEALTH_LOG_HOUR_MB, 64),
  };
}

// ---------------------------------------------------------------------------
// lanes

function laneRole(laneId) {
  const match = /^(?:followup-)?([a-z-]+?)-\d+(?:-recovery-\d+)?$/.exec(laneId);
  const role = match ? match[1] : "";
  return role === "runner" ? "lab-runner" : role;
}

// The scheduler's own view decides whether a lane is still open: the self-healer
// moves a lane's final-status.json aside when it resets it, so a lane directory
// without one is not necessarily waiting. On cycle-a-20260919 the
// first dry run of the starvation check listed 24 groups, almost all of them
// lanes the cycle state recorded as failed a week earlier.
function laneStatuses(cwd, cycleId) {
  const state = readJson(path.join(researchRoot(cwd), "state", `${cycleId}-cycle-run-state.json`));
  const statuses = new Map();
  for (const item of Array.isArray(state?.lane_statuses) ? state.lane_statuses : []) {
    if (item?.lane_id) statuses.set(String(item.lane_id), String(item.status || ""));
  }
  return statuses;
}

function listLanes(lanesRoot, statuses = new Map()) {
  let names = [];
  try {
    names = fs.readdirSync(lanesRoot);
  } catch {
    return [];
  }
  return names
    .map((laneId) => {
      const dir = path.join(lanesRoot, laneId);
      const contract = path.join(dir, "lane-contract.json");
      const createdMs = mtimeMs(contract);
      if (!createdMs) return null;
      const finalStatus = readJson(path.join(dir, "final-status.json"));
      const scheduled = statuses.get(laneId) || "";
      return {
        lane_id: laneId,
        dir,
        role: readJson(contract)?.role || laneRole(laneId),
        created_ms: createdMs,
        final_status: finalStatus,
        // Open only while the scheduler still has it queued.
        open: statuses.size ? ["pending", "prepared"].includes(scheduled) : !finalStatus,
        completed_ms: finalStatus ? Date.parse(finalStatus.completed_at || "") || mtimeMs(path.join(dir, "final-status.json")) : 0,
      };
    })
    .filter(Boolean);
}

function laneResult(lane) {
  const resultPath = lane.final_status?.result_path || path.join(lane.dir, "result.json");
  return readJson(resultPath) || readJson(path.join(lane.dir, "result.json"));
}

function laneRolePlan(lane) {
  return readJson(path.join(lane.dir, "role-plan.json")) || {};
}

function laneWorkKey(lane) {
  const rolePlan = laneRolePlan(lane);
  const actionType = rolePlan.action_type || "unknown";
  if (actionType !== "independent_gate_review_followup") return `${lane.role}:${actionType}`;
  const rubric = rolePlan.target_rubric || rolePlan.planner_metadata?.target_rubric || "unspecified";
  return `${lane.role}:${actionType}:${rubric}`;
}

function boundHandoffPath(rolePlan) {
  const candidates = [
    rolePlan?.planner_metadata?.analysis_request?.handoff_path,
    rolePlan?.analysis_request?.handoff_path,
    rolePlan?.planner_metadata?.analyst_handoff_path,
    rolePlan?.analyst_handoff_path,
  ];
  return candidates.map((item) => String(item || "").trim()).find(Boolean) || "";
}

// Same rule as the evidence picker's isFailedExecutionNotEvidence.
function measuredSomething(result) {
  if (String(result?.status || "").toLowerCase() !== "failed") return true;
  const summary = result?.validation_summary || {};
  if (Number(summary.blueprints_passed || 0) > 0) return true;
  return (summary.handoff_check_resolutions || []).some((item) => item?.valid_falsification_result === true);
}

// ---------------------------------------------------------------------------
// detectors

// Two runners that completed the same execution -- same sealed execution id,
// or failing that the same handoff file -- since the watermark.
function duplicateExecutions({ lanes, sinceMs }) {
  const groups = new Map();
  for (const lane of lanes) {
    if (lane.role !== "lab-runner" || lane.final_status?.status !== "completed") continue;
    if (lane.completed_ms < sinceMs) continue;
    const result = laneResult(lane);
    if (!result || !measuredSomething(result)) continue;
    const handoffPath = String(result.executed_handoff_path || "") || boundHandoffPath(laneRolePlan(lane)) || String(result.analyst_handoff_path || "");
    const receipts = (result.execution_receipts || []).filter((receipt) =>
      /^[a-f0-9]{64}$/.test(receipt.script_sha256 || "") && /^[a-f0-9]{64}$/.test(receipt.check_spec_sha256 || ""));
    if (!handoffPath && !receipts.length) continue;
    const handoff = readJson(handoffPath) || {};
    const executionId = handoff?.handoff_seal?.execution_id;
    const key = receipts.length
      ? `actual_execution:${shortHash(JSON.stringify(receipts.map((receipt) => [receipt.script_sha256, receipt.check_spec_sha256])))}`
      : executionId ? `execution:${executionId}` : `handoff:${path.resolve(handoffPath)}`;
    if (!groups.has(key)) groups.set(key, { lanes: [], handoffs: new Set(), checks: new Set() });
    const group = groups.get(key);
    group.lanes.push(lane.lane_id);
    group.handoffs.add(path.basename(path.dirname(handoffPath)));
    for (const item of result?.validation_summary?.handoff_check_resolutions || []) {
      if (item?.check_id) group.checks.add(item.check_id);
    }
  }
  const findings = [];
  for (const [key, group] of groups) {
    if (group.lanes.length < 2) continue;
    findings.push({
      kind: HEALTH_KIND,
      subtype: "duplicate_execution",
      signature: `${HEALTH_KIND}:duplicate_execution:${shortHash(key)}`,
      detail: `${group.lanes.length} runners completed the same execution (${key.split(":")[0]}; check ${[...group.checks].join(", ") || "?"}; handoffs ${[...group.handoffs].join(", ")}): ${group.lanes.join(", ")}. The same code on the same data ran more than once.`,
      lane_ids: group.lanes.slice(-6),
    });
  }
  return findings;
}

// A run that failed before measuring anything, whose check resolution still
// says pass_fail "pass". Anything reading the resolution reads a pass.
//
// Judged only on runs completed after the defect's accepted fix, when there
// is one (`since`). MEASURED ON cycle-a-20260919, 2026-10-01: the
// maintainer fixed this on 09-30 (a1b4637) and no runner has recorded it since,
// yet the finding went on reporting the 54 runs written before the fix. Those
// records stay as they were (the evidence picker already excludes them); the
// check asks whether the harness still does it.
function failedRunsRecordedAsPass({ lanes, since = 0 }) {
  const offenders = [];
  const checks = new Set();
  for (const lane of lanes) {
    if (lane.role !== "lab-runner" || !lane.final_status) continue;
    if (since && lane.completed_ms <= since) continue;
    const result = laneResult(lane);
    if (!result || measuredSomething(result)) continue;
    const passing = (result.validation_summary?.handoff_check_resolutions || []).filter(
      (item) => String(item?.pass_fail || "").toLowerCase() === "pass",
    );
    if (!passing.length) continue;
    offenders.push(lane.lane_id);
    for (const item of passing) checks.add(item.check_id);
  }
  if (!offenders.length) return [];
  return [{
    kind: HEALTH_KIND,
    subtype: "failed_run_recorded_as_pass",
    signature: `${HEALTH_KIND}:failed_run_recorded_as_pass`,
    detail: `${offenders.length} runner(s) failed before measuring anything (status failed, 0 blueprints passed, no valid falsification) yet record their check resolution as pass_fail "pass" (checks: ${[...checks].slice(0, 6).join(", ")}). Readers of handoff_check_resolutions see a pass for a run that measured nothing.`,
    lane_ids: offenders.slice(-6),
  }];
}

// A lane still pending after `starvedHours`, while at least `starvedOvertaken`
// lanes doing the same work created after it have already finished. Independent
// gate reviews are distinct work per rubric; one rubric cannot overtake another.
function starvedLanes({ lanes, now, config }) {
  const byRole = new Map();
  for (const lane of lanes) {
    if (!byRole.has(lane.role)) byRole.set(lane.role, []);
    byRole.get(lane.role).push(lane);
  }
  const groups = new Map();
  for (const lane of lanes) {
    if (!lane.open) continue;
    const waitedHours = (now - lane.created_ms) / 3_600_000;
    if (waitedHours < config.starvedHours) continue;
    const workKey = laneWorkKey(lane);
    // Overtaken by later lanes doing the same kind of work: that is a queue
    // that skipped this one, not a lane waiting on something else.
    const overtaken = (byRole.get(lane.role) || []).filter(
      (other) => other.created_ms > lane.created_ms
        && other.final_status?.status === "completed"
        && laneWorkKey(other) === workKey,
    );
    if (overtaken.length < config.starvedOvertaken) continue;
    const key = workKey;
    if (!groups.has(key)) groups.set(key, { lanes: [], overtakenBy: new Set(), hours: 0 });
    const group = groups.get(key);
    group.lanes.push(lane.lane_id);
    group.hours = Math.max(group.hours, waitedHours);
    for (const other of overtaken.slice(-3)) group.overtakenBy.add(other.lane_id);
  }
  return [...groups].map(([key, group]) => ({
    kind: HEALTH_KIND,
    subtype: "starved_lane",
    signature: `${HEALTH_KIND}:starved_lane:${key}`,
    detail: `${group.lanes.length} ${key} lane(s) pending for up to ${Math.round(group.hours)} h (threshold ${config.starvedHours} h) while later ${key.split(":")[0]} lanes such as ${[...group.overtakenBy].join(", ")} were created after them and already finished: ${group.lanes.join(", ")}.`,
    lane_ids: group.lanes.slice(0, 6),
  }));
}

// Lanes waiting for a role that never comes.
//
// MEASURED ON cycle-a-20260919, 2026-10-01. Two analysts waited
// twenty hours for an engineer to run the director's simulation order; no
// engineer lane was open or created in that time, because the engineer's
// lifetime ceiling had been reached and the order was refused every pass with
// no trace. starvedLanes could not see it: nothing overtook the analysts, there
// was simply no engineer. The scheduler names the role each held lane awaits
// (run-summary `awaited_role`); a role with waiters, no open lane and no new
// lane for the whole threshold is the finding, whatever the cause.
function awaitedRoleAbsent({ summaryPath, lanes, statuses, now, config }) {
  const summary = readJson(summaryPath);
  const passes = Array.isArray(summary?.pass_summaries) ? summary.pass_summaries : [];
  const skipped = passes.length ? passes[passes.length - 1].skipped : null;
  if (!Array.isArray(skipped)) return [];
  const thresholdMs = config.starvedHours * 3_600_000;
  const byLane = new Map(lanes.map((lane) => [lane.lane_id, lane]));
  const waiting = new Map();
  for (const item of skipped) {
    const role = item?.awaited_role;
    const lane = byLane.get(item?.lane_id);
    if (!role || !lane || now - lane.created_ms < thresholdMs) continue;
    if (!waiting.has(role)) waiting.set(role, { lanes: [], reasons: new Set(), hours: 0 });
    const group = waiting.get(role);
    group.lanes.push(lane.lane_id);
    group.reasons.add(String(item.reason || "").replace(/ recorded_at=\S+/, ""));
    group.hours = Math.max(group.hours, (now - lane.created_ms) / 3_600_000);
  }
  const findings = [];
  for (const [role, group] of waiting) {
    const ofRole = lanes.filter((lane) => lane.role === role);
    // A long-running lane completed inside the window still covers this role.
    const present = ofRole.some((lane) => ["pending", "prepared", "running"].includes(statuses.get(lane.lane_id) || "")
      || now - Math.max(lane.created_ms, lane.completed_ms) < thresholdMs);
    if (present) continue;
    const latest = ofRole.reduce((best, lane) => (!best || lane.created_ms > best.created_ms ? lane : best), null);
    findings.push({
      kind: HEALTH_KIND,
      subtype: "awaited_role_absent",
      signature: `${HEALTH_KIND}:awaited_role_absent:${role}`,
      detail: `${group.lanes.length} lane(s) have waited up to ${Math.round(group.hours)} h for the ${role} role (${[...group.reasons].slice(0, 3).join("; ")}), and no ${role} lane has been open or created for ${config.starvedHours} h${latest ? ` (newest: ${latest.lane_id}, created ${new Date(latest.created_ms).toISOString()})` : ""}. Find what keeps the ${role} lane from being created -- a refused action, a cap, a gate -- rather than why the waiters wait: ${group.lanes.slice(0, 6).join(", ")}.`,
      lane_ids: group.lanes.slice(0, 6),
    });
  }
  return findings;
}

// The recorded gate returning to a state it left, again and again, on one
// subject: two computations disagreeing, not the research moving.
function gateOscillation({ historyPath, now, config }) {
  let text = "";
  try {
    text = fs.readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  const since = now - config.oscillationWindowHours * 3_600_000;
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && Date.parse(row.ts || "") >= since);
  const bySubject = new Map();
  for (const row of rows) {
    const subject = String(row.subject || "");
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(row);
  }
  const findings = [];
  for (const [subject, subjectRows] of bySubject) {
    // Once provenance-aware samples exist, older samples without an evidence
    // revision cannot establish that they describe the same computation. Keep
    // detecting wholly legacy histories, but do not mix their ambiguous rows
    // into the newly identified evidence epochs.
    const hasEvidenceRevision = subjectRows.some((row) =>
      Object.prototype.hasOwnProperty.call(row, "evidence_revision"),
    );
    const comparableRows = hasEvidenceRevision
      ? subjectRows.filter((row) => Object.prototype.hasOwnProperty.call(row, "evidence_revision"))
      : subjectRows;
    const byEvidenceRevision = new Map();
    for (const row of comparableRows) {
      const revision = JSON.stringify(row.evidence_revision ?? null);
      if (!byEvidenceRevision.has(revision)) byEvidenceRevision.set(revision, []);
      byEvidenceRevision.get(revision).push(row);
    }
    for (const revisionRows of byEvidenceRevision.values()) {
      const states = revisionRows.map((row) => `${row.score}|${JSON.stringify(row.rubric || {})}`);
      const seen = new Set();
      let previous = null;
      let returns = 0;
      const examples = [];
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        if (state === previous) continue;
        if (seen.has(state)) {
          returns += 1;
          if (examples.length < 6) examples.push(`${String(revisionRows[index].ts).slice(11, 16)}=${revisionRows[index].score}`);
        }
        seen.add(state);
        previous = state;
      }
      if (returns < config.oscillationReturns) continue;
      findings.push({
        kind: HEALTH_KIND,
        subtype: "gate_oscillation",
        signature: `${HEALTH_KIND}:gate_oscillation:${shortHash(subject)}`,
        detail: `the gate review returned to a score it had already left ${returns} times within ${config.oscillationWindowHours} h on one subject (e.g. ${examples.join(", ")}); ${seen.size} distinct states. Two computations of the same gate disagree -- which path writes which state?`,
        lane_ids: [],
        history_path: historyPath,
      });
    }
  }
  return findings;
}

const UNDELIVERED_EVIDENCE = /(validation_artifact_paths\S*\s+(?:is|are)\s+empty|evidence_packet_count\S*\s+is\s+zero|raw outputs[^.]{0,80}not (?:supplied|provided))/i;

// The reproducibility reviewer says it was given no artifacts while the run
// it reviewed wrote tables and figures.
function evidenceUndelivered({ gateReviewPath, cwd, cycleId }) {
  const gate = readJson(gateReviewPath);
  if (!gate) return [];
  const reasons = (gate.rubric || []).flatMap((item) => item?.reasons || []).map(String);
  const complaint = reasons.find((reason) => UNDELIVERED_EVIDENCE.test(reason));
  if (!complaint) return [];
  const laneId = String(gate.latest_validation_lane_id || "");
  if (!laneId) return [];
  const blueprintsDir = path.join(researchRoot(cwd), "artifacts", "stats", cycleId, laneId, "blueprints");
  let artifacts = 0;
  const stack = [blueprintsDir];
  while (stack.length && artifacts < 50) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (/\.(csv|png|json)$/i.test(entry.name)) artifacts += 1;
    }
  }
  if (!artifacts) return [];
  return [{
    kind: HEALTH_KIND,
    subtype: "evidence_undelivered",
    signature: `${HEALTH_KIND}:evidence_undelivered`,
    detail: `the gate's reviewer reports "${complaint.slice(0, 240)}" while ${laneId}, the latest validation it bound, wrote ${artifacts}${artifacts >= 50 ? "+" : ""} tables/figures under ${blueprintsDir}. The evidence exists and does not reach the reviewer.`,
    lane_ids: [laneId],
  }];
}

// A completed measurement can still carry a malformed quality contract.
// Inspect only the validation bound to the active lead; retired experiments
// must not wake the maintainer or alter a new hypothesis's review.
function validationContractMismatch({ gateReviewPath, cwd, cycleId }) {
  const gate = readJson(gateReviewPath);
  const laneId = gate?.latest_validation_lane_id;
  if (!laneId || gate.validation_matches_current_lead !== true) return [];
  const resultPath = path.join(researchRoot(cwd), "lanes", cycleId, laneId, "result.json");
  const summary = readJson(resultPath)?.validation_summary;
  if (!summary) return [];
  const quality = summary.analyst_quality_standard || {};
  const evaluated = new Set((quality.evaluated_requirements || []).map((item) => item.requirement));
  const mismatches = [];
  for (const failure of quality.failed_requirements || []) {
    const match = /^required_validation_check:(\s*([A-Za-z_][\w.-]*)\s*(?:>=|<=|==|!=|>|<|=)\s*(?:true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*)$/i.exec(failure);
    if (match && !evaluated.has(match[1]) && Object.hasOwn(summary.checks || {}, match[2])) {
      mismatches.push(`condition ${match[1]} was treated as a missing check id although ${match[2]} was emitted`);
    }
  }
  const profile = summary.rigor_profile || {};
  for (const axis of ["multi_seed", "comparator"]) {
    if (profile.table_evidence?.[axis] && profile.signals?.[axis] === false) {
      mismatches.push(`rigor profile denies ${axis} despite its own table evidence`);
    }
  }
  if (!mismatches.length) return [];
  return [{
    kind: HEALTH_KIND,
    subtype: "validation_contract_mismatch",
    signature: `${HEALTH_KIND}:validation_contract_mismatch:${shortHash(laneId)}`,
    detail: `${laneId}: ${mismatches.join("; ")}. Repair the contract/summary mapping and rebuild from recorded outputs; preserve scientific failures and approval criteria.`,
    lane_ids: [laneId],
    result_path: resultPath,
  }];
}

// Catch routing failures even when there is no bound validation to inspect.
function currentLeadValidationUnbound({ lanes, gateReviewPath, hypothesisPath, root, cycleId, now, config }) {
  const gate = readJson(gateReviewPath);
  const hypothesis = readJson(hypothesisPath);
  const contract = currentAnalysisContract(root, cycleId);
  const selected = hypothesis?.selected_hypothesis || {};
  const statement = selected.statement || hypothesis?.statement;
  if (!gate || !statement) return [];
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const datasets = datasetKeys([selected.dataset_or_accession, hypothesis?.dataset_or_accession]);
  if (!datasets.size) return [];
  const bound = lanes.find((lane) => lane.lane_id === gate.latest_validation_lane_id);
  const candidates = lanes.filter((lane) => lane.role === "lab-runner" && lane.final_status
    && lane.completed_ms && now - lane.completed_ms >= config.validationRefreshMinutes * 60_000
    && (!bound || lane.completed_ms > bound.completed_ms));
  for (const lane of candidates.sort((a, b) => b.completed_ms - a.completed_ms)) {
    const result = laneResult(lane);
    if (!result || isFailedExecutionNotEvidence(result) || !runnerHasRealExecution(result)) continue;
    // MEASURED ON cycle-a-20260919, 2026-10-16: runner 332 had the
    // exact assignment, dataset, and tables, but its output failed the current
    // contract. The gate correctly retained verified runner 331; this detector
    // incorrectly demanded that the mismatched result replace it.
    const binding = result.analysis_contract_validation || result.validation_summary?.analysis_contract_validation;
    if (contract && (binding?.contract_id !== contract.contract_id
        || binding.status !== "verified" || binding.evidence_role !== "primary")) continue;
    const plan = readJson(path.join(lane.dir, "role-plan.json"));
    const assigned = plan?.assigned_hypotheses || result.assigned_hypotheses || [];
    // Exact assignment and input provenance, not shared robotics vocabulary.
    if (!assigned.some((item) => normalize(typeof item === "string" ? item : item?.statement) === normalize(statement))) continue;
    if (![...runnerDatasetKeys(result)].some((key) => datasets.has(key))) continue;
    const tables = (result.blueprint_executions || []).flatMap((item) => item.tables || []);
    if (!tables.some((table) => table.path && fs.existsSync(table.path))) continue;
    return [{
      kind: HEALTH_KIND, subtype: "current_lead_validation_unbound",
      signature: `${HEALTH_KIND}:current_lead_validation_unbound:${shortHash(`${gate.current_hypothesis_identity?.lead_key || statement}|${lane.lane_id}`)}`,
      detail: `${lane.lane_id} executed the exact current-lead assignment on its declared dataset and wrote tables, but the gate still binds ${gate.latest_validation_lane_id || "no validation"} after ${config.validationRefreshMinutes} minutes. Audit evidence routing and family aliases; preserve failed controls, inconclusive results, and scientific falsification verdicts.`,
      lane_ids: [lane.lane_id],
    }];
  }
  return [];
}

// A broken pinned reference is a contract failure on its first occurrence.
// The maintainer diagnoses the path/provenance; it must never invent a result.
function missingPriorArtifact({ lanes, now, fixedAt = {} }) {
  const findings = [];
  const seen = new Set();
  for (const lane of [...lanes].sort((a, b) => b.completed_ms - a.completed_ms)) {
    if (lane.role !== "lab-runner" || !lane.final_status || !lane.completed_ms
        || now - lane.completed_ms > 24 * 3_600_000) continue;
    const result = laneResult(lane);
    for (const execution of result?.blueprint_executions || []) {
      if (execution.status !== "failed") continue;
      const error = String(execution.error || "");
      const match = /expected exactly one ([^\n]+?) with SHA-256 ([a-f0-9]{64})[^\n]*RESEARCHLAB_PRIOR_ARTIFACTS_ROOT=([^;\n]+); found 0/i.exec(error);
      if (!match) continue;
      const reference = `${match[1]}|${match[2]}|${match[3]}`;
      const baseSignature = `${HEALTH_KIND}:missing_prior_artifact:${shortHash(reference)}`;
      const repairedAt = Math.max(0, ...Object.entries(fixedAt).filter(([key]) => key === baseSignature || key.startsWith(baseSignature + ":recurrence:")).map(([, value]) => value));
      if (repairedAt && lane.completed_ms <= repairedAt) continue;
      if (seen.has(reference)) continue;
      seen.add(reference);
      findings.push({
        kind: HEALTH_KIND, subtype: "missing_prior_artifact",
        signature: repairedAt ? `${baseSignature}:recurrence:${shortHash(lane.lane_id)}` : baseSignature,
        detail: `${lane.lane_id} could not resolve pinned prior artifact ${match[1]} (SHA-256 ${match[2]}) under ${match[3]}. Check the declared artifact path, snapshot, and lookup root before retrying; retain the recorded hash and report missing evidence rather than fabricating measurements.`,
        lane_ids: [lane.lane_id],
      });
    }
  }
  return findings;
}

// Analyst handoffs the harness refused to seal, repeatedly.
function analysisContractMismatch({ lanes, root, cycleId }) {
  const current = currentAnalysisContract(root, cycleId);
  if (!current) return [];
  const findings = [];
  const seen = new Set();
  const verifiedAt = Math.max(0, ...lanes.map((lane) => {
    const binding = lane.role === "lab-runner" ? laneResult(lane)?.analysis_contract_validation : null;
    return binding?.contract_id === current.contract_id && binding.status === "verified" ? lane.completed_ms : 0;
  }));
  for (const lane of [...lanes].sort((a, b) => b.completed_ms - a.completed_ms)) {
    if (lane.role !== "lab-runner") continue;
    if (lane.completed_ms && lane.completed_ms < verifiedAt) continue;
    const output = laneResult(lane)?.analysis_contract_validation;
    const report = output?.status === "mismatch" ? output
      : readJson(path.join(lane.dir, "analysis-contract-preflight.json")) || output;
    if (!report || report.contract_id !== current.contract_id || !["blocked", "mismatch"].includes(report.status)) continue;
    const issue = (report.problems || []).slice().sort().join(",");
    if (seen.has(issue)) continue;
    seen.add(issue);
    findings.push({ kind: HEALTH_KIND, subtype: "analysis_contract_mismatch",
      signature: `${HEALTH_KIND}:analysis_contract_mismatch:${shortHash(`${current.contract_id}|${issue}|${verifiedAt}`)}`,
      detail: `${lane.lane_id} violates the current canonical analysis contract: ${issue}. Rebind pending analyst assignments, regenerate the frozen blueprint against this contract, and execute it once. Never relabel old executed code or waive scientific controls.`,
      lane_ids: [lane.lane_id], contract_id: current.contract_id });
  }
  return findings;
}

// Analyst handoffs the harness refused to seal, repeatedly.
function sealRejections({ lanes, sinceMs, config }) {
  const rejected = [];
  const reasons = new Map();
  for (const lane of lanes) {
    if (lane.role !== "analyst" || lane.completed_ms < sinceMs) continue;
    const handoff = readJson(path.join(lane.dir, "handoff-validation-plan.json"));
    const seal = handoff?.handoff_seal;
    if (seal?.status !== "rejected") continue;
    rejected.push(lane.lane_id);
    for (const reason of seal.rejections || []) {
      const shape = String(reason).replace(/[0-9a-f]{64}/g, "<sha>").replace(/\/[^\s,)]+/g, "<path>").slice(0, 120);
      reasons.set(shape, (reasons.get(shape) || 0) + 1);
    }
  }
  if (rejected.length < config.sealRejections) return [];
  const common = [...reasons].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return [{
    kind: HEALTH_KIND,
    subtype: "seal_rejections",
    signature: `${HEALTH_KIND}:seal_rejections:${shortHash(common)}`,
    detail: `${rejected.length} analyst handoffs were refused by the seal (most common reason: ${common}). Either the analysts keep writing an ambiguous contract the prompt does not prevent, or the seal refuses something it should resolve.`,
    lane_ids: rejected.slice(-6),
  }];
}

// ---------------------------------------------------------------------------
// The defects found by hand on cycle-a-20260919, 2026-10-16..18, in
// the shape they take anywhere. Each was there to be read in what the cycle
// wrote; none of the detectors above read it.

const HOUR_MS = 3_600_000;

function parseCsvRows(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char;
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

// The rows of a runner's primary_contrasts.csv, the table an analysis contract
// measures into, or null.
function primaryContrastRows(result) {
  const table = (result?.blueprint_executions || []).flatMap((execution) => execution?.tables || [])
    .find((item) => item?.name === "primary_contrasts.csv" && item.path);
  if (!table) return null;
  try {
    return parseCsvRows(fs.readFileSync(table.path, "utf8"));
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Runners that measured the same thing again: different code, the same numbers.
//
// MEASURED ON cycle-a-20260919, 2026-10-18: 18 runners (458-475) ran
// 18 freshly written scripts on one sealed panel and wrote the same four
// primary estimates, 0.8992 [0.1585] first among them; eight more (478-485)
// then wrote 0.7119 [0.6512] eight times. duplicateExecutions groups by script
// and check-spec hashes, so it saw 26 different executions. Judged while the
// repetition is still going on: the newest member is recent.
function repeatedResults({ lanes, sinceMs, now, config }) {
  const groups = new Map();
  for (const lane of lanes) {
    if (lane.role !== "lab-runner" || lane.final_status?.status !== "completed") continue;
    if (lane.completed_ms < Math.max(sinceMs, now - config.repeatedResultWindowHours * HOUR_MS) || lane.completed_ms > now) continue;
    const result = laneResult(lane);
    // MEASURED ON cycle-a-20260919, 2026-10-26: runners 783 and 784
    // performed distinct supporting influence audits, but copied runner 782's
    // verified primary_contrasts.csv into their audit artifacts for provenance.
    // A copied reference table in explicitly supporting evidence is not another
    // measurement of the primary estimands.
    const binding = result?.analysis_contract_validation
      || result?.validation_summary?.analysis_contract_validation;
    if (binding?.evidence_role === "supporting") continue;
    const rows = primaryContrastRows(result);
    const measured = (rows || []).map((row) => [
      String(row.contrast_id || ""),
      finiteNumber(row.estimate),
      finiteNumber(row.simultaneous_lower),
      finiteNumber(row.simultaneous_upper),
    ]).filter((row) => row[1] !== null);
    if (!measured.length) continue;
    // The numbers alone: the same measurement under renamed contrasts is still
    // the same measurement. MEASURED ON cycle-a-20260919, 2026-10-18:
    // runners 497/498 wrote 0.7119 [0.6512] again under new contrast IDs for a
    // new contract, after 478-485 had written it eight times.
    const key = JSON.stringify(measured.map((row) => row.slice(1).map((value) => value === null ? null : Number(value.toPrecision(10)))).sort());
    if (!groups.has(key)) groups.set(key, { lanes: [], newest: 0, scripts: new Set(), first: measured[0] });
    const group = groups.get(key);
    group.lanes.push(lane.lane_id);
    group.newest = Math.max(group.newest, lane.completed_ms);
    for (const sha of result?.analysis_contract_validation?.executed_code_sha256 || []) group.scripts.add(sha);
  }
  const findings = [];
  for (const [key, group] of groups) {
    if (group.lanes.length < config.repeatedResults) continue;
    if (now - group.newest > config.repeatedResultActiveHours * HOUR_MS) continue;
    const [contrast, estimate, lower, upper] = group.first;
    findings.push({
      kind: HEALTH_KIND,
      subtype: "repeated_result",
      signature: `${HEALTH_KIND}:repeated_result:${shortHash(key)}`,
      detail: `${group.lanes.length} runners wrote the same primary results (${contrast}=${estimate} [${lower}, ${upper}] and the rest identical) from ${group.scripts.size || "?"} different scripts: ${group.lanes.join(", ")}. The same estimands on the same data were measured ${group.lanes.length} times. Find what keeps asking for this measurement -- an instruction the analysts are given, a handoff-to-runner path that runs every new handoff, a lead re-projection that resets what counts as measured -- and stop it there: a runner that can only repeat a measurement should not be created, and the agents should be told the measurement exists.`,
      lane_ids: group.lanes.slice(-6),
    });
  }
  return findings;
}

// A run labelled as having measured nothing whose own primary table holds
// finite estimates.
//
// MEASURED ON cycle-a-20260919, 2026-10-18: 67 of 150 runners were
// stamped failure_category=no_measurement_produced although their contract
// was verified and primary_contrasts.csv held finite estimates; the label was
// read downstream as "completed lanes produced no quantitative primary effect"
// (eleven director_upheld_without_rebuttal notices in a day).
function measurementLabelContradicted({ lanes, now, config }) {
  const offenders = [];
  for (const lane of lanes) {
    if (lane.role !== "lab-runner" || lane.final_status?.status !== "completed") continue;
    if (now - lane.completed_ms > config.recentHours * HOUR_MS || lane.completed_ms > now) continue;
    const result = laneResult(lane);
    const label = result?.failure_category || lane.final_status?.failure_category;
    if (label !== "no_measurement_produced") continue;
    const rows = primaryContrastRows(result) || [];
    if (!rows.some((row) => finiteNumber(row.estimate) !== null)) continue;
    offenders.push(lane.lane_id);
  }
  if (!offenders.length) return [];
  return [{
    kind: HEALTH_KIND,
    subtype: "measurement_label_contradicted",
    signature: `${HEALTH_KIND}:measurement_label_contradicted:${shortHash(offenders[0])}`,
    detail: `${offenders.length} runner(s) are labelled no_measurement_produced while their primary_contrasts.csv holds finite estimates: ${offenders.slice(-6).join(", ")}. Everything that reads the label -- the gate, the director, the next analyst -- is told nothing was measured. Find where the driver decides a run measured nothing and why it does not see these tables.`,
    lane_ids: offenders.slice(-6),
  }];
}

// Agent work the harness set aside, again and again, for one reason.
//
// MEASURED ON cycle-a-20260919, 2026-10-18: analyst-1012's
// contact-mode audit declared itself supporting in the schema's [{key, column}]
// pairs; the rule that holds repeat measurements read only an object and set
// it aside as one (contract_already_measured). A rule that sets work aside is
// right only while the agents can know it: when it keeps firing, either they
// are not told, or it misreads what they wrote.
const DISCARDING_NOTICES = new Set(["handoff_contract_stale", "contract_already_measured", "labdirector_decision_stale"]);

function discardedWork({ noticesPath, now, config, fixedAt = {} }) {
  const byKind = new Map();
  // Work set aside before an accepted fix of this kind is what that fix was for.
  const fixedFor = (kind) => Math.max(0, ...Object.entries(fixedAt)
    .filter(([signature]) => signature.startsWith(`${HEALTH_KIND}:discarded_work:${kind}:`))
    .map(([, at]) => at));
  for (const line of tailText(noticesPath, 4 * 1024 * 1024).split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const kind = event?.event_type || event?.event;
    if (!DISCARDING_NOTICES.has(kind)) continue;
    const at = Date.parse(event.ts || "") || 0;
    if (now - at > 24 * HOUR_MS || at <= fixedFor(kind)) continue;
    const payload = event.payload || {};
    const subject = String(payload.handoff_path || payload.lane_id || "");
    if (!subject) continue;
    if (!byKind.has(kind)) byKind.set(kind, new Map());
    byKind.get(kind).set(subject, payload);
  }
  const findings = [];
  for (const [kind, subjects] of byKind) {
    if (subjects.size < config.discardedWork) continue;
    const names = [...subjects.keys()].map((subject) => path.basename(path.dirname(subject)) || subject);
    findings.push({
      kind: HEALTH_KIND,
      subtype: "discarded_work",
      signature: `${HEALTH_KIND}:discarded_work:${kind}:${shortHash(names.join("|"))}`,
      detail: `In the last 24 hours the harness set aside ${subjects.size} pieces of agent work as ${kind}: ${names.slice(-8).join(", ")}. Open what those agents wrote. Either they were never told the rule (fix what they are given), or the rule misreads them (fix the rule) -- work that keeps being set aside for one reason is a defect in one of the two, not in the agents.`,
      lane_ids: names.filter((name) => /^(?:followup-)?[a-z-]+-\d+/.test(name)).slice(-6),
    });
  }
  return findings;
}

function tailText(filePath, maxBytes) {
  let fd = null;
  try {
    const size = fs.statSync(filePath).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// An append-only log of the cycle growing faster than anything reads it.
//
// MEASURED ON cycle-a-20260919: the decision ledger reached 12.0 GB
// in 23 days (2026-10-12) as one file, and after it was split by the hour it
// still grew 20 MB an hour (2026-10-16), each review rewritten whole for a
// changed counter and copied into the dialogue. Both were found by hand.
function logGrowth({ root, cycleId, now, config }) {
  const logs = [
    ["decision ledger", path.join(root, "runtime", `${cycleId}-labdirector-decisions`)],
    ["director dialogue", path.join(root, "events", `${cycleId}-labdirector-dialogue`)],
    ["director inbox", path.join(root, "runtime", `${cycleId}-labdirector-inbox`)],
    ["delivery receipts", path.join(root, "messages", cycleId, "delivery-receipts")],
  ];
  const findings = [];
  for (const [name, dir] of logs) {
    let segments = [];
    try {
      segments = fs.readdirSync(dir).filter((entry) => /^\d{4}-\d{2}-\d{2}T\d{2}\.jsonl$/.test(entry)).sort();
    } catch {
      continue;
    }
    // Closed hours only, within the last few: the open hour is still being written.
    const closed = segments.slice(0, -1).filter((entry) => now - Date.parse(`${entry.slice(0, 13)}:00:00Z`) <= config.recentHours * HOUR_MS);
    const sizes = closed.map((entry) => [entry, fs.statSync(path.join(dir, entry)).size]);
    const heavy = sizes.filter(([, size]) => size > config.logHourMegabytes * 1024 * 1024);
    if (!heavy.length) continue;
    const [hour, size] = heavy[heavy.length - 1];
    findings.push({
      kind: HEALTH_KIND,
      subtype: "log_growth",
      signature: `${HEALTH_KIND}:log_growth:${shortHash(name)}:${hour.slice(0, 10)}`,
      detail: `The ${name} (${dir}) took ${Math.round(size / 1048576)} MB in the hour ${hour.slice(0, 13)} UTC (threshold ${config.logHourMegabytes} MB an hour). Open its records: find what is written repeatedly or whole when only part of it changed, and what reads it, then write once what is new and keep what readers need.`,
      lane_ids: [],
    });
  }
  return findings;
}

// `fixedAt` maps a finding's signature to when the maintainer's fix for it was
// accepted; a detector whose signature names the defect rather than one
// instance reads only what happened after that.
function pipelineHealthFindings({ cwd, cycleId, sinceMs = Date.now(), now = Date.now(), env = process.env, fixedAt = {} }) {
  const config = healthConfig(env);
  if (!config.enabled) return [];
  const statuses = laneStatuses(cwd, cycleId);
  const lanes = listLanes(path.join(researchRoot(cwd), "lanes", cycleId), statuses);
  const stateRoot = path.join(researchRoot(cwd), "state");
  const summaryPath = path.join(researchRoot(cwd), "plans", `${cycleId}-run-summary.json`);
  const detectors = [
    () => awaitedRoleAbsent({ summaryPath, lanes, statuses, now, config }),
    () => failedRunsRecordedAsPass({ lanes, since: fixedAt[`${HEALTH_KIND}:failed_run_recorded_as_pass`] || 0 }),
    () => evidenceUndelivered({ gateReviewPath: path.join(stateRoot, `${cycleId}-gate-review.json`), cwd, cycleId }),
    () => validationContractMismatch({ gateReviewPath: path.join(stateRoot, `${cycleId}-gate-review.json`), cwd, cycleId }),
    () => currentLeadValidationUnbound({ lanes, gateReviewPath: path.join(stateRoot, `${cycleId}-gate-review.json`), hypothesisPath: path.join(stateRoot, `${cycleId}-lab-director-hypothesis.json`), root: researchRoot(cwd), cycleId, now, config }),
    () => missingPriorArtifact({ lanes, now, fixedAt }),
    () => analysisContractMismatch({ lanes, root: researchRoot(cwd), cycleId }),
    () => duplicateExecutions({ lanes, sinceMs }),
    () => starvedLanes({ lanes, now, config }),
    () => gateOscillation({ historyPath: path.join(stateRoot, `${cycleId}-gate-review-history.jsonl`), now, config }),
    () => sealRejections({ lanes, sinceMs, config }),
    () => repeatedResults({ lanes, sinceMs, now, config }),
    () => measurementLabelContradicted({ lanes, now, config }),
    () => discardedWork({ noticesPath: path.join(researchRoot(cwd), "events", `${cycleId}-harness-notices.jsonl`), now, config, fixedAt }),
    () => logGrowth({ root: researchRoot(cwd), cycleId, now, config }),
  ];
  const findings = [];
  for (const detect of detectors) {
    try {
      findings.push(...detect());
    } catch {
      // A detector that cannot read its inputs finds nothing; it never stops
      // the supervisor.
    }
  }
  return findings;
}

function writeHealthReport({ cwd, cycleId, findings, now = Date.now() }) {
  const filePath = healthReportPath({ cwd, cycleId });
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ cycle_id: cycleId, generated_at: new Date(now).toISOString(), findings }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // The report is for people; failing to write it changes nothing else.
  }
  return filePath;
}

module.exports = {
  HEALTH_KIND,
  healthConfig,
  healthReportPath,
  pipelineHealthFindings,
  writeHealthReport,
  __private: {
    duplicateExecutions,
    evidenceUndelivered,
    validationContractMismatch,
    currentLeadValidationUnbound,
    missingPriorArtifact,
    analysisContractMismatch,
    discardedWork,
    failedRunsRecordedAsPass,
    logGrowth,
    measurementLabelContradicted,
    repeatedResults,
    gateOscillation,
    laneRole,
    listLanes,
    sealRejections,
    starvedLanes,
  },
};
