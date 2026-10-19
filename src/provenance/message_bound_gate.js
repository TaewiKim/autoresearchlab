"use strict";

// Message-bound memory gate for researchlab — a reference monitor for shared-memory / context reads.
// Ported from the MBM-Core research artifacts (benchmarks/coupled_memory/causal.mjs +
// benchmarks/external/mbm_gate.mjs). The principle: RELEVANCE IS NOT AUTHORIZATION. A record (a
// gatekeeper review, a hypothesis, a prior decision) is admitted into the active decision's context
// ONLY IF it is authorized for THIS message — same run/task, still active, reader-allowed, policy
// matched, and — crucially — its source lies in the active message's DIRECTED causal ancestor closure
// (recomputed from the event/lane graph, never trusted from a record's own field).
//
// This file is intentionally framework-agnostic and content-shaped to researchlab records via the
// adapter in researchlab_graph.js. CommonJS (researchlab uses require()).

// ---- causal closure (ported from causal.mjs) -------------------------------------------------

// Logical clock for ordering: prefer a monotonic per-run `sequence`, fall back to `created_at`.
// Returns null when neither is available (edge then unorderable and refused — fail closed).
function clockOf(node) {
  if (node == null) return null;
  if (node.sequence != null && Number.isFinite(Number(node.sequence))) return Number(node.sequence);
  if (node.created_at) {
    const t = Date.parse(node.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Parent message ids of a node: typed multi-parent `parents[]` (each {id,type} or a string) when
// present, else the legacy single parent + delegation slots.
function parentIdsOf(node) {
  if (node && Array.isArray(node.parents) && node.parents.length) {
    return node.parents.map((p) => (typeof p === "string" ? p : p && p.id)).filter(Boolean);
  }
  return [node && node.parent_message_id, node && node.delegated_from].filter((x) => x != null);
}

// Strict edge validator (secure tier): a directed edge parent->child is valid ONLY IF the parent is a
// distinct, same-run message that strictly precedes the child in logical order. THROWS so secure
// paths fail closed.
function verifyCausalEdge(parent, child) {
  if (!parent || !child) throw new Error("causal_edge_missing");
  if (parent.message_id === child.message_id) throw new Error("causal_self_loop");
  if ((parent.run_id == null ? null : parent.run_id) !== (child.run_id == null ? null : child.run_id)) {
    throw new Error("causal_run_mismatch");
  }
  const ps = clockOf(parent);
  const cs = clockOf(child);
  if (ps == null || cs == null || !(ps < cs)) throw new Error("causal_order_invalid");
}

// Secure, fail-closed closure: every referenced node must exist, verify (verifyEnvelope), and form a
// temporally valid edge, else the WHOLE closure throws. Use when records are signed (Phase 2+).
function verifiedCausalClosure({ activeId, lookupMessage, verifyEnvelope }) {
  const closure = new Set();
  const visiting = new Set();
  const visit = (messageId) => {
    if (closure.has(messageId)) return;
    if (visiting.has(messageId)) throw new Error(`causal_cycle:${messageId}`);
    visiting.add(messageId);
    const child = lookupMessage(messageId);
    if (!child) throw new Error(`causal_message_missing:${messageId}`);
    if (!verifyEnvelope(child)) throw new Error(`causal_message_unattested:${messageId}`);
    for (const parentId of parentIdsOf(child)) {
      if (parentId == null) continue;
      const parent = lookupMessage(parentId);
      if (!parent) throw new Error(`causal_parent_missing:${parentId}`);
      if (!verifyEnvelope(parent)) throw new Error(`causal_parent_unattested:${parentId}`);
      verifyCausalEdge(parent, child);
      visit(parentId);
    }
    visiting.delete(messageId);
    closure.add(messageId);
  };
  visit(activeId);
  return closure;
}

// Lenient closure (audit/offline tier): follows directed, same-run, strictly-preceding edges; skips
// edges it cannot validate (missing parent, cross-run, unorderable) rather than throwing. Correct for
// the FIRST researchlab port where lane records are not yet cryptographically signed: it still refuses
// the graph-only sibling-branch trap (no undirected correlation expansion, no future/cyclic edges).
function causalAncestryFromMessages(messages, activeMessage) {
  const byId = new Map();
  for (const m of messages || []) byId.set(m.message_id, m);
  if (!byId.has(activeMessage.message_id)) byId.set(activeMessage.message_id, activeMessage);

  const closure = new Set();
  const stack = [activeMessage.message_id];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || closure.has(id)) continue;
    closure.add(id);
    const node = byId.get(id);
    if (!node) continue; // referenced id with no record: include but cannot traverse further
    const childClock = clockOf(node);
    for (const parentId of parentIdsOf(node)) {
      if (parentId == null || parentId === id) continue;
      const parent = byId.get(parentId);
      if (parent == null) continue; // parent absent: cannot validate edge -> refuse
      if ((parent.run_id == null ? null : parent.run_id) !== (node.run_id == null ? null : node.run_id)) {
        continue; // cross-run edge: not a valid ancestor
      }
      const parentClock = clockOf(parent);
      if (childClock == null || parentClock == null) continue; // unorderable -> refuse
      if (!(parentClock < childClock)) continue; // must strictly precede (no future/cyclic)
      stack.push(parentId);
    }
  }
  return closure;
}

// ---- memory gate (ported from mbm_gate.mjs evaluateMemoryGateStandalone) -----------------------

// Conjunctive, deny-by-default reference monitor. A record is admitted iff EVERY check passes; the
// check order, deny defaults, and reason codes mirror the MBM-Core central runtime. `eventGraph` is
// the active message's causal ancestor closure (a Set of message ids) built by the functions above —
// NOT a flat set of all known ids.
function evaluateMemoryGate(memory, currentMessage, opts = {}) {
  const {
    eventGraph,
    intentMemoryTypes,
    knownMessageIds,
    secure = false,
    requireIntegrity = false,
  } = opts;

  // Content integrity (when a write-time hash is recorded): a record whose content no longer matches.
  if (memory.audit_hash && typeof opts.contentHash === "function") {
    if (opts.contentHash(memory) !== memory.audit_hash) {
      return { decision: "deny", reason: "integrity_mismatch" };
    }
  }
  if ((secure || requireIntegrity) && !memory.audit_hash) {
    return { decision: "deny", reason: "integrity_missing" };
  }
  // Run scope.
  if (memory.run_id !== currentMessage.run_id) {
    return { decision: "deny", reason: "run_id_mismatch" };
  }
  // Task scope (record's task, or a run/global-scoped record).
  const taskMatches =
    memory.task_id === currentMessage.task_id || ["run", "global"].includes(memory.scope);
  if (!taskMatches) {
    return { decision: "deny", reason: "task_scope_mismatch" };
  }
  // Lifecycle: missing status -> deny (a writer-declared status is only a hint; authoritative status
  // is supplied by the adapter from a lifecycle log in Phase 3).
  if (memory.status !== "active") {
    return { decision: "deny", reason: "inactive_memory" };
  }
  // Provenance: source must exist AND lie in the causal closure (recomputed from the graph).
  if (!memory.source_message_id) {
    return { decision: "deny", reason: "missing_provenance_message" };
  }
  if (knownMessageIds && !knownMessageIds.has(memory.source_message_id)) {
    return { decision: "deny", reason: "missing_provenance_message" };
  }
  if (eventGraph && !eventGraph.has(memory.source_message_id)) {
    return { decision: "deny", reason: "provenance_not_in_causal_graph" };
  }
  // Reader authorization (no wildcard default).
  const allowedReaders = new Set(memory.allowed_readers || []);
  if (!allowedReaders.has("*") && !allowedReaders.has(currentMessage.receiver)) {
    return { decision: "deny", reason: "reader_not_authorized" };
  }
  // Intent -> memory_type lifecycle (own-property guard).
  const allowedTypes =
    intentMemoryTypes && Object.prototype.hasOwnProperty.call(intentMemoryTypes, currentMessage.intent)
      ? intentMemoryTypes[currentMessage.intent]
      : undefined;
  if (secure && !allowedTypes) {
    return { decision: "deny", reason: "intent_unknown" };
  }
  if (allowedTypes && !allowedTypes.has(memory.memory_type)) {
    return { decision: "deny", reason: "intent_memory_type_mismatch" };
  }
  // Policy context.
  if (secure && !memory.policy_context) {
    return { decision: "deny", reason: "policy_context_missing" };
  }
  if (memory.policy_context && memory.policy_context !== currentMessage.policy_context) {
    return { decision: "deny", reason: "policy_context_mismatch" };
  }
  return { decision: "allow", reason: "message_bound_access_granted" };
}

module.exports = {
  clockOf,
  parentIdsOf,
  verifyCausalEdge,
  verifiedCausalClosure,
  causalAncestryFromMessages,
  evaluateMemoryGate,
};
