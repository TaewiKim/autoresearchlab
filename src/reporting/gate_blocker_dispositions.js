"use strict";

const path = require("path");
const { selectedLeadIdentity, reviewMatchesSelectedLead } = require("../agents/shared/lead_evidence_match");

// MEASURED ON cycle-a-20260919, 2026-11-06: the independent gate
// retired objections, but downstream reviews regenerated them from heuristics.
// Consume the gate's applied dispositions, not Director requests or lane-local
// patches. This changes reasons only: scores, conjunctions and raw audits stay.
function applyPublishedGateDispositions({ root, cycleId, rubric, blockers, fs = require("fs") }) {
  let gate;
  try {
    gate = JSON.parse(fs.readFileSync(path.join(root, "state", `${cycleId}-gate-review.json`), "utf8"));
  } catch {
    return { rubric, blockers, gate_blocker_adjudication_resolution: null };
  }
  if (!reviewMatchesSelectedLead(gate, selectedLeadIdentity(root, cycleId))) {
    return { rubric, blockers, gate_blocker_adjudication_resolution: null };
  }
  const resolution = gate.gate_blocker_adjudication_resolution;
  if (!resolution) return { rubric, blockers, gate_blocker_adjudication_resolution: null };
  const retired = new Set([
    ...(Array.isArray(resolution.removed_blockers) ? resolution.removed_blockers : []),
    ...(Array.isArray(resolution.downgraded_blockers) ? resolution.downgraded_blockers : []),
  ].map((item) => item?.blocker).filter((text) => typeof text === "string"));
  const keep = (text) => !retired.has(text);
  return {
    rubric: rubric.map((item) => ({ ...item, reasons: (item.reasons || []).filter(keep) })),
    blockers: blockers.filter(keep),
    gate_blocker_adjudication_resolution: resolution || null,
  };
}

module.exports = { applyPublishedGateDispositions };
