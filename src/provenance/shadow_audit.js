"use strict";

// Phase 1 SHADOW audit: build the cycle's lane causal graph, compute the active decision's causal
// ancestor closure, and run the message-bound reference monitor over the gatekeeper-review records —
// WITHOUT enforcing anything. Prints what the gate WOULD admit/deny and why, so we can validate that
// the reconstructed causal closure separates the current decision lineage from abandoned/forked
// branches (the foreign-accession heuristic's job) before wiring enforcement into the gate build.
//
// Usage: node src/provenance/shadow_audit.js <RESEARCH_LAB_ROOT> <CYCLE_ID>

const fs = require("fs");
const path = require("path");
const { causalAncestryFromMessages, evaluateMemoryGate } = require("./message_bound_gate");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function isLaneId(x) {
  return typeof x === "string" && /^(followup-)?[a-z-]+-\d+$/i.test(x);
}
function laneSeq(laneId) {
  const m = String(laneId).match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}
function roleOf(laneId) {
  const m = String(laneId).match(/^(?:followup-)?([a-z-]+?)-\d+$/i);
  return m ? m[1] : "unknown";
}

function buildMessages(root, cycleId) {
  const lanesDir = path.join(root, ".research-lab", "lanes", cycleId);
  const entries = fs.existsSync(lanesDir) ? fs.readdirSync(lanesDir) : [];
  const messages = [];
  for (const laneId of entries) {
    const laneDir = path.join(lanesDir, laneId);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(laneDir).mtimeMs;
    } catch {}
    // Prefer the stamped causal envelope (dispatch_causal_stamp_v1); fall back to reconstruction from
    // role-plan lineage signals for lanes created before stamping was deployed.
    const prov = readJson(path.join(laneDir, "provenance.json"));
    let parents;
    let createdAt;
    if (prov && prov.stamped_by) {
      parents = (Array.isArray(prov.parents) ? prov.parents : [prov.parent_message_id])
        .filter((x) => isLaneId(x) && x !== laneId);
      createdAt = prov.created_at || new Date(mtimeMs || Date.now()).toISOString();
    } else {
      const rp = readJson(path.join(laneDir, "role-plan.json")) || {};
      const pm = rp.planner_metadata || {};
      parents = [rp.source_brief_id, pm.lab_director_response_lane_id, pm.latest_validation_lane_id].filter(
        (x) => isLaneId(x) && x !== laneId,
      );
      createdAt = new Date(mtimeMs || Date.now()).toISOString();
    }
    messages.push({
      message_id: laneId,
      run_id: cycleId,
      task_id: roleOf(laneId),
      created_at: createdAt,
      parents: [...new Set(parents)],
      stamped: !!(prov && prov.stamped_by),
    });
  }
  return messages;
}

function activeDecisionMessage(root, cycleId, messages) {
  // The current authoritative lead lane = lab-director-hypothesis.json generated_by, else the newest
  // lab-director lane. This is the message on whose behalf the gate evaluates.
  const hyp =
    readJson(
      path.join(root, ".research-lab", "state", `${cycleId}-lab-director-hypothesis.json`),
    ) || {};
  let activeId = isLaneId(hyp.generated_by) ? hyp.generated_by : null;
  if (!activeId) {
    const dirs = messages
      .filter((m) => m.task_id === "lab-director")
      .sort((a, b) => (laneSeq(b.message_id) || 0) - (laneSeq(a.message_id) || 0));
    activeId = dirs[0] && dirs[0].message_id;
  }
  return activeId;
}

function geoAcc(text) {
  return [...new Set((String(text).match(/(?:GSE|SRP|PRJNA)\d+/gi) || []).map((s) => s.toUpperCase()))];
}

function main() {
  const root = process.argv[2];
  const cycleId = process.argv[3];
  const messages = buildMessages(root, cycleId);
  const activeId = activeDecisionMessage(root, cycleId, messages);
  const activeMsg = messages.find((m) => m.message_id === activeId) || {
    message_id: activeId,
    run_id: cycleId,
  };
  const closure = causalAncestryFromMessages(messages, activeMsg);

  const currentMessage = {
    run_id: cycleId,
    task_id: "gate",
    receiver: "gatekeeper",
    intent: "gate_review",
    policy_context: undefined,
  };

  // Gatekeeper review records: one "memory" per completed gatekeeper lane. We tag scope=run and
  // allowed_readers=['*'] in Phase 1 (no reader model yet) and status=active, so the DISCRIMINATOR
  // under test is purely the causal-closure provenance check.
  const gk = messages.filter((m) => m.task_id === "gatekeeper");
  let admit = 0;
  const denyReasons = {};
  const rows = [];
  for (const m of gk) {
    const laneDir = path.join(root, ".research-lab", "lanes", cycleId, m.message_id);
    let blob = "";
    try {
      blob = fs.readFileSync(path.join(laneDir, "stdout.log"), "utf8").slice(0, 40000);
    } catch {}
    const accs = geoAcc(blob);
    const topic = accs.includes("GSE318067")
      ? "SLE/318067"
      : accs.some((a) => ["GSE228779", "GSE322943"].includes(a))
        ? "ovarian/322943-lineage"
        : accs[0] || "?";
    // A gatekeeper review's provenance source is the DECISION IT REVIEWED, not the review lane itself
    // (reviews are children of decisions). Authorize iff that reviewed-decision lies in the active
    // lead's causal lineage. Prefer the stamped causal parent; fall back to role-plan response lane.
    const prov = readJson(path.join(laneDir, "provenance.json"));
    const rp = readJson(path.join(laneDir, "role-plan.json")) || {};
    const reviewedDecision =
      (prov && isLaneId(prov.parent_message_id) && prov.parent_message_id) ||
      (rp.planner_metadata && isLaneId(rp.planner_metadata.lab_director_response_lane_id)
        ? rp.planner_metadata.lab_director_response_lane_id
        : null) ||
      m.message_id;
    const memory = {
      memory_id: m.message_id,
      source_message_id: reviewedDecision,
      run_id: cycleId,
      task_id: "gatekeeper",
      scope: "run",
      status: "active",
      allowed_readers: ["*"],
      memory_type: "gate_review",
    };
    const { decision, reason } = evaluateMemoryGate(memory, currentMessage, { eventGraph: closure });
    if (decision === "allow") admit += 1;
    else denyReasons[reason] = (denyReasons[reason] || 0) + 1;
    rows.push({ lane: m.message_id, topic, in_closure: closure.has(m.message_id), decision, reason });
  }

  console.log("=== Phase 1 SHADOW audit (no enforcement) ===");
  console.log("active decision lane:", activeId, "| closure size:", closure.size, "/", messages.length, "lanes");
  console.log("gatekeeper reviews:", gk.length, "| WOULD admit:", admit, "| deny:", gk.length - admit);
  console.log("deny reasons:", JSON.stringify(denyReasons));
  // Cross-tab: does causal closure separate SLE (current lineage) from ovarian (abandoned branch)?
  const xtab = {};
  for (const r of rows) {
    const k = r.topic + " :: " + r.decision;
    xtab[k] = (xtab[k] || 0) + 1;
  }
  console.log("topic x decision:", JSON.stringify(xtab, null, 0));
  console.log("--- sample rows ---");
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.lane} [${r.topic}] in_closure=${r.in_closure} -> ${r.decision} (${r.reason})`);
  }
}

main();
