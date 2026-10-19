"use strict";

const fs = require("fs");
const path = require("path");

const [
  runtimeRootArg,
  cycleId,
  rawWindow,
  rawHistoryLimit,
] = process.argv.slice(2);

const runtimeRoot = runtimeRootArg || ".research-lab";
const windowSize = Math.max(2, Number.parseInt(rawWindow || "3", 10) || 3);
const historyLimit = Math.max(windowSize, Number.parseInt(rawHistoryLimit || "24", 10) || 24);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asBool(value) {
  return value === true || value === "true";
}

function stableArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean).sort()
    : [];
}

function actionTypes(actions) {
  return Array.isArray(actions)
    ? actions.map((item) => String(item?.type || item?.action_type || "unknown")).filter(Boolean).sort()
    : [];
}

function blockerFingerprint(gate) {
  const blockers = Array.isArray(gate?.blockers)
    ? gate.blockers
    : Array.isArray(gate?.major_objections)
      ? gate.major_objections
      : [];
  return blockers
    .slice(0, 12)
    .map((item) => String(item).replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .sort();
}

function scoreLimitingStage(approval, gate) {
  return (
    approval?.approval_stage_summary?.score_limiting_stage?.name ||
    approval?.approval_stage_summary?.score_limiting_stage?.stage ||
    approval?.approval_stage_summary?.score_limiting_stage ||
    (asBool(gate?.gate_passed ?? gate?.pass) ? "post-hypothesis" : "hypothesis")
  );
}

const statePath = path.join(runtimeRoot, "state", `${cycleId}-cycle-run-state.json`);
const gatePath = path.join(runtimeRoot, "state", `${cycleId}-gate-review.json`);
const approvalPath = path.join(runtimeRoot, "state", `${cycleId}-approval-review.json`);
const historyPath = path.join(runtimeRoot, "run-logs", `${cycleId}-gate-score-stagnation-history.json`);

const state = readJson(statePath) || {};
const gate = readJson(gatePath);
if (!gate) process.exit(0);
const approval = readJson(approvalPath) || {};
const gateScore = asNumber(gate.score ?? gate.gate_score);
if (gateScore === null) process.exit(0);

const snapshot = {
  ts: new Date().toISOString(),
  gate_score: gateScore,
  gate_passed: asBool(gate.gate_passed ?? gate.pass),
  gatekeeper_review_status: gate.gatekeeper_review_status || null,
  lab_director_response_status: gate.lab_director_response_status || null,
  score_limiting_stage: scoreLimitingStage(approval, gate),
  approval_readiness_score: asNumber(approval.approval_readiness_score ?? approval.score),
  approval_gate_passed: asBool(approval.approval_gate_passed),
  pending_rubrics: stableArray(gate.gatekeeper_pending_rubrics ?? gate.pending_rubric_blockers),
  action_types: actionTypes(gate.recommended_followup_actions ?? gate.recommended_actions),
  blockers: blockerFingerprint(gate),
  lane_counts: state.lane_counts || null,
};

snapshot.fingerprint = JSON.stringify({
  gate_score: snapshot.gate_score,
  gate_passed: snapshot.gate_passed,
  gatekeeper_review_status: snapshot.gatekeeper_review_status,
  lab_director_response_status: snapshot.lab_director_response_status,
  score_limiting_stage: snapshot.score_limiting_stage,
  pending_rubrics: snapshot.pending_rubrics,
  action_types: snapshot.action_types,
  blockers: snapshot.blockers,
});

const history = readJson(historyPath);
const snapshots = Array.isArray(history?.snapshots) ? history.snapshots : [];
snapshots.push(snapshot);
const trimmed = snapshots.slice(-historyLimit);
writeJson(historyPath, {
  cycle_id: cycleId,
  updated_at: snapshot.ts,
  window_size: windowSize,
  snapshots: trimmed,
});

const latest = trimmed.slice(-windowSize);
if (latest.length < windowSize) process.exit(0);
if (snapshot.gate_passed || snapshot.approval_gate_passed) process.exit(0);
if (!latest.every((item) => item.fingerprint === snapshot.fingerprint)) process.exit(0);

const first = latest[0];
const completedDelta = Number(snapshot.lane_counts?.completed || 0) - Number(first.lane_counts?.completed || 0);
const pending = Number(snapshot.lane_counts?.pending || 0);
const running = Number(snapshot.lane_counts?.running || 0);
const detail = [
  `gate_score=${snapshot.gate_score}`,
  `score_limiting_stage=${snapshot.score_limiting_stage}`,
  `repeated_snapshots=${latest.length}`,
  `completed_delta=${completedDelta}`,
  `pending=${pending}`,
  `running=${running}`,
  `pending_rubrics=${snapshot.pending_rubrics.join(",") || "none"}`,
  `actions=${snapshot.action_types.join(",") || "none"}`,
].join(" ");

process.stdout.write(JSON.stringify({
  anomaly_count: 1,
  anomalies: [{
    code: "gate_score_stagnation",
    severity: "research_blocker",
    owner_role: "lab-director",
    detail,
    message: "Process anomaly: the hypothesis/approval gate score has repeated without passing across watchdog snapshots. LabDirector must stop broad repeated discovery, inspect the score-limiting stage and unchanged blockers, then author the smallest targeted gatekeeper/rubric, waiver, or closure action needed to change the gate state; supervisor is not choosing the scientific verdict.",
  }],
}));
