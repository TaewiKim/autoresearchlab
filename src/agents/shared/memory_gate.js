"use strict";

// Message-bound shared-memory read gate (MBM-Core, the user's paper applied to
// the researchlab harness). Every shared-memory/context record admitted into an
// agent's working context is validated against the ACTIVE MESSAGE (the current
// lane's task) with seven conjunctive checks before use. A record is admitted
// only if all applicable checks pass; otherwise it is denied with a reason code.
// Every allow/deny is appended to a per-cycle audit log so the final decision is
// reconstructable from the event graph.
//
// No-constraint principle (mirrors the paper's null rule): a record field that
// carries no constraint (absent / null / "*" / empty) means "applies to all"
// and therefore PASSES that check — it is not a violation. A check fails only
// when the record explicitly states a value that conflicts with the active
// message. This keeps legitimate cycle-scoped broadcast context flowing while
// still catching cross-run / cross-scope / superseded / unauthorized leakage.

const fs = require("fs");
const path = require("path");

const REASON = Object.freeze({
  RUN_MISMATCH: "run_id_mismatch",
  SCOPE_LEAK: "task_scope_mismatch",
  INACTIVE: "inactive_or_superseded_memory",
  MISSING_PROVENANCE: "missing_provenance",
  RECEIVER_UNAUTHORIZED: "receiver_unauthorized",
  INTENT_INCOMPATIBLE: "intent_type_incompatible",
  POLICY_MISMATCH: "policy_context_mismatch",
});

function _unconstrained(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "*" ||
    (Array.isArray(value) && (value.length === 0 || value.includes("*")))
  );
}

function _asList(value) {
  if (_unconstrained(value)) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

// Evaluate the seven conjunctive checks. activeMessage carries the current
// lane's authorization context: { cycle_id, lane_id, role, task, stage,
// policy_context, scope, family_root }. eventGraph (optional) is the set of
// known record/source ids for the provenance check.
function evaluateMemoryGate(record, activeMessage, eventGraph = null) {
  const reasons = [];
  const rec = record && typeof record === "object" ? record : {};
  const am = activeMessage || {};

  // 1) same run — the only always-enforced binding; record's run, when stated,
  //    must equal the active message's run.
  const recRun = rec.cycle_id ?? rec.run_id ?? rec.run;
  const sameRun = _unconstrained(recRun) ? true : String(recRun) === String(am.cycle_id);
  if (!sameRun) reasons.push(`${REASON.RUN_MISMATCH}: record=${recRun} active=${am.cycle_id}`);

  // 2) task / wider scope — record bound to a lane/family/scope must match the
  //    active lane/family, unless it is cycle/global-scoped (unconstrained).
  const recScope = rec.intended_lane ?? rec.scope ?? rec.family_root;
  let scopeOk = true;
  if (!_unconstrained(recScope)) {
    const s = String(recScope);
    scopeOk =
      s === String(am.lane_id) ||
      s === String(am.family_root) ||
      s === String(am.scope) ||
      s === String(am.cycle_id) ||
      s === "cycle" ||
      s === "global";
  }
  if (!scopeOk) reasons.push(`${REASON.SCOPE_LEAK}: record=${recScope} active_lane=${am.lane_id}`);

  // 3) active status — not superseded / retired / archived.
  const status = String(rec.status ?? rec.delivery_state ?? "active").toLowerCase();
  const activeStatus = !["superseded", "retired", "archived", "stale", "consumed"].includes(status);
  if (!activeStatus) reasons.push(`${REASON.INACTIVE}: ${status}`);

  // 4) provenance — record's source exists in the event graph when one is
  //    supplied; otherwise a stated source is sufficient. Records that declare
  //    a source but whose source is absent from a provided event graph fail.
  const source = rec.source ?? rec.author_role ?? rec.provenance_source;
  let provenanceOk = true;
  if (eventGraph && Array.isArray(eventGraph) && !_unconstrained(source)) {
    provenanceOk = eventGraph.map(String).includes(String(source));
  }
  if (!provenanceOk) reasons.push(`${REASON.MISSING_PROVENANCE}: source=${source}`);

  // 5) receiver authorization — active role must be in the record's allowed
  //    reader set, unless the set is unconstrained (broadcast).
  const receivers = _asList(rec.intended_receivers ?? rec.target_role ?? rec.allowed_readers);
  const receiverOk = receivers.length === 0 || receivers.includes(String(am.role));
  if (!receiverOk) reasons.push(`${REASON.RECEIVER_UNAUTHORIZED}: allowed=${receivers} active_role=${am.role}`);

  // 6) intent / type compatibility — when the record declares an intended
  //    consumer role/intent, it must admit the active role's intent.
  const intentFor = _asList(rec.intent_for ?? rec.consumer_intent);
  const intentOk = intentFor.length === 0 || intentFor.includes(String(am.role)) || intentFor.includes(String(am.task));
  if (!intentOk) reasons.push(`${REASON.INTENT_INCOMPATIBLE}: intent_for=${intentFor} active=${am.role}/${am.task}`);

  // 7) policy context — when the record pins a policy context, it must match
  //    the active message's policy context.
  const recPolicy = rec.policy_context ?? rec.policy_tier;
  const policyOk =
    _unconstrained(recPolicy) ||
    _unconstrained(am.policy_context) ||
    String(recPolicy) === String(am.policy_context);
  if (!policyOk) reasons.push(`${REASON.POLICY_MISMATCH}: record=${recPolicy} active=${am.policy_context}`);

  const checks = {
    same_run: sameRun,
    task_scope: scopeOk,
    active_status: activeStatus,
    provenance: provenanceOk,
    receiver_auth: receiverOk,
    intent_type: intentOk,
    policy_context: policyOk,
  };
  const admitted = Object.values(checks).every(Boolean);
  return {
    admitted,
    checks,
    denial_reasons: reasons,
    record_id: rec.record_id ?? rec.message_id ?? rec.id ?? null,
    active_cycle: am.cycle_id ?? null,
    active_lane: am.lane_id ?? null,
  };
}

// Append-only audit: one JSON line per gate decision so the admitted context
// (and every denial + reason) is reconstructable from the event graph.
function auditMemoryGate(evaluation, auditLogPath, extra = {}) {
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      record_id: evaluation.record_id,
      admitted: evaluation.admitted,
      denial_reasons: evaluation.denial_reasons,
      checks: evaluation.checks,
      cycle: evaluation.active_cycle,
      lane: evaluation.active_lane,
      ...extra,
    };
    fs.appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Audit must never break the read path.
  }
}

// Convenience: gate a single record at a read boundary. Stamps the run id from
// the loader (records are loaded by `${cycleId}-...` path so the binding is
// authoritative), records the decision, and returns the record only if
// admitted (fail-closed: a denied record reads as absent).
function admitRecord(record, { activeMessage, auditLogPath, recordId, stampRun = true }) {
  if (record == null) return null;
  const rec = typeof record === "object" ? record : { value: record };
  if (recordId != null && rec.record_id == null) rec.record_id = recordId;
  if (stampRun && rec.cycle_id == null && rec.run_id == null) rec.cycle_id = activeMessage.cycle_id;
  const evaluation = evaluateMemoryGate(rec, activeMessage);
  if (auditLogPath) auditMemoryGate(evaluation, auditLogPath, { record_id: recordId ?? rec.record_id ?? null });
  return evaluation.admitted ? record : null;
}

module.exports = { evaluateMemoryGate, auditMemoryGate, admitRecord, REASON };
