"use strict";

const fs = require("fs");
const path = require("path");
const {
  classifyReviewBlockers,
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  normalizeActions,
  readJsonIfExists,
  uniqueStrings,
  writeJson,
} = require("./research_note_utils");

function reviewSnapshot(review, scoreKey, bandKey) {
  if (!review || typeof review !== "object") return null;
  return {
    mode: review.mode || null,
    score: review[scoreKey] ?? review.score ?? null,
    band: review[bandKey] || null,
    passed:
      review.gate_passed === true ||
      review.conclusion_gate_passed === true ||
      review.approval_gate_passed === true ||
      review.pass === true,
  };
}

function latestValidationSummary({ chronicleNotes, gate }) {
  const chronicleSummary = compactText(chronicleNotes?.latest_validation?.summary || "", 700);
  if (chronicleSummary) return chronicleSummary;
  const laneId = gate?.latest_validation_lane_id || gate?.scientific_value_gate?.latest_validation_lane_id || null;
  if (!laneId) return null;
  const status = gate?.latest_validation_summary?.overall_status ||
    gate?.scientific_value_gate?.latest_validation_summary?.overall_status ||
    null;
  const passed = gate?.latest_validation_summary?.checks_passed ??
    gate?.scientific_value_gate?.latest_validation_summary?.checks_passed ??
    null;
  const total = gate?.latest_validation_summary?.checks_total ??
    gate?.scientific_value_gate?.latest_validation_summary?.checks_total ??
    null;
  const statusText = status ? ` (${status})` : "";
  const checksText = passed != null && total != null ? `, ${passed}/${total} checks` : "";
  return `${laneId}${statusText}${checksText}`;
}

function masterTableGateSatisfied(gate) {
  const summaries = [
    gate?.latest_validation_summary,
    gate?.scientific_value_gate?.latest_validation_summary,
  ];
  return summaries.some((summary) =>
    summary?.analysis_master_table_gate?.satisfied === true ||
    summary?.checks?.analysis_master_table_gate_satisfied === true ||
    summary?.checks?.analysis_master_table_created === true
  );
}

function resolvedBlockerPatternsForEvidence({ gate }) {
  const patterns = [];
  if (masterTableGateSatisfied(gate)) {
    patterns.push(
      /master[-\s]?table.*blueprint interface/i,
      /analysis_master_table_created.*blueprint interface/i,
      /repair the analysis_master_table_created blueprint interface/i,
      /repair the master[-\s]?table blueprint interface/i,
    );
  }
  return patterns;
}

function staleNoLeadSummary(value, hasCurrentLead) {
  if (!hasCurrentLead) return false;
  return /\bno executable lead claim\b|\bno lead hypothesis\b|\bnothing scientifically falsifiable\b/i.test(String(value || ""));
}

function activeSummary({ candidate, fallback, hasCurrentLead }) {
  const text = compactText(candidate, 900);
  if (!text || staleNoLeadSummary(text, hasCurrentLead)) return fallback;
  return text;
}

function latestRoleLanes({ root, cycleId, role, limit = 5 }) {
  const cycleStatePath = path.join(root, "state", `${cycleId}-cycle-run-state.json`);
  const cycleState = readJsonIfExists(cycleStatePath) || {};
  const fromState = Array.isArray(cycleState.lane_statuses)
    ? cycleState.lane_statuses.filter((lane) => lane?.role === role)
    : [];
  if (fromState.length > 0) {
    return fromState.slice(-limit).reverse().map((lane) => ({
      lane_id: lane.lane_id || lane.id || null,
      role: lane.role || role,
      status: lane.status || null,
      degraded: lane.degraded === true,
      runtime_class: lane.runtime_class || null,
    }));
  }
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  return fs.readdirSync(lanesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes(role))
    .map((entry) => {
      const resultPath = path.join(lanesRoot, entry.name, "result.json");
      const result = readJsonIfExists(resultPath) || {};
      return {
        lane_id: entry.name,
        role,
        status: result.status || null,
        degraded: result.degraded === true,
        mtime: fileMtimeMs(resultPath),
      };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

function scoutFailurePattern({ root, cycleId }) {
  const cycleState = readJsonIfExists(path.join(root, "state", `${cycleId}-cycle-run-state.json`)) || {};
  const failedScouts = Array.isArray(cycleState.lane_statuses)
    ? cycleState.lane_statuses.filter((lane) => lane?.role === "scout" && lane?.status === "failed")
    : [];
  const recent = failedScouts.slice(-8).map((lane) => lane.lane_id || lane.id || "").filter(Boolean);
  return {
    failed_scout_count: failedScouts.length,
    recent_failed_scout_lanes: recent,
    likely_duplicate_acquisition_loop: recent.length >= 3,
    note: recent.length >= 3
      ? "Several scout lanes failed recently; LabDirector should avoid reissuing the same acquisition target without a changed download strategy or explicit rejection log."
      : null,
  };
}

function writeMarkdownDigest(filePath, digest) {
  const lines = [
    `# Agent Communication Digest: ${digest.cycle_id}`,
    "",
    `- updated_at: ${digest.updated_at}`,
    `- generated_by: ${digest.generated_by}`,
    "",
    "## Current Focus",
    `- lead_hypothesis: ${digest.current_focus?.lead_hypothesis || "none"}`,
    `- dataset: ${JSON.stringify(digest.current_focus?.dataset || null)}`,
    `- latest_validation: ${digest.current_focus?.latest_validation || "unknown"}`,
    `- scores: ${JSON.stringify(digest.current_focus?.scores || {})}`,
    "",
    "## Communication Diagnosis",
    markdownList(digest.communication_diagnosis),
    "",
    "## Active Blockers",
    markdownList(digest.active_blockers),
    "",
    "## Resolved Or Superseded Blockers",
    markdownList(digest.resolved_or_superseded_blockers),
    "",
    "## Handoffs",
    `- lab_director: ${digest.handoffs?.lab_director?.summary || "none"}`,
    `- chronicle: ${digest.handoffs?.chronicle?.summary || "none"}`,
    `- gatekeeper: ${digest.handoffs?.gatekeeper?.summary || "none"}`,
    `- scout: ${digest.handoffs?.scout?.summary || "none"}`,
    "",
    "## Role Boundaries",
    markdownList(digest.role_boundaries),
    "",
    "## Timeline",
    markdownList(digest.timeline),
    "",
  ];
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function ensureAgentCommunicationDigest({ root, cycleId, force = false }) {
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  const jsonPath = path.join(stateRoot, `${cycleId}-agent-communication-digest.json`);
  const markdownPath = path.join(stateRoot, `${cycleId}-agent-communication-digest.md`);
  const labNotesPath = path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`);
  const chronicleNotesPath = path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`);
  const gatePath = path.join(stateRoot, `${cycleId}-gate-review.json`);
  const approvalPath = path.join(stateRoot, `${cycleId}-approval-review.json`);
  const conclusionPath = path.join(stateRoot, `${cycleId}-conclusion-review.json`);
  const cycleStatePath = path.join(stateRoot, `${cycleId}-cycle-run-state.json`);
  const sourceMtime = Math.max(
    fileMtimeMs(labNotesPath),
    fileMtimeMs(chronicleNotesPath),
    fileMtimeMs(gatePath),
    fileMtimeMs(approvalPath),
    fileMtimeMs(conclusionPath),
    fileMtimeMs(cycleStatePath),
  );
  const digestMtime = Math.max(fileMtimeMs(jsonPath), fileMtimeMs(markdownPath));
  if (!force && digestMtime >= sourceMtime && fs.existsSync(jsonPath) && fs.existsSync(markdownPath)) {
    return {
      json_path: jsonPath,
      markdown_path: markdownPath,
      updated: false,
      reason: "up_to_date",
    };
  }

  const labNotes = readJsonIfExists(labNotesPath) || {};
  const chronicleNotes = readJsonIfExists(chronicleNotesPath) || {};
  const gate = readJsonIfExists(gatePath) || {};
  const approval = readJsonIfExists(approvalPath) || {};
  const conclusion = readJsonIfExists(conclusionPath) || {};
  const cycleState = readJsonIfExists(cycleStatePath) || {};
  const resolvedBlockerPatterns = resolvedBlockerPatternsForEvidence({ gate });
  const blockerClassification = classifyReviewBlockers([
    ...(gate.blockers || []),
    ...(gate.major_objections || []),
    ...(approval.approval_blockers || []),
    ...(conclusion.conclusion_blockers || []),
    ...(labNotes.open_blockers || []),
  ], {
    hasLeadHypothesis: Boolean(labNotes.current_lead_hypothesis?.statement),
    hasDataset: Boolean(labNotes.current_lead_hypothesis?.materialized_dataset || labNotes.current_lead_hypothesis?.dataset_or_accession),
    hasValidationEvidence: Number(cycleState.lane_counts?.completed || 0) > 0,
    currentLeadHypothesis: labNotes.current_lead_hypothesis,
    resolvedBlockerPatterns,
  });
  const scoutPattern = scoutFailurePattern({ root, cycleId });
  const communicationDiagnosis = uniqueStrings([
    labNotes.communication_quality?.stale_blocker_count > 0
      ? `${labNotes.communication_quality.stale_blocker_count} stale/resolved blockers were being carried forward as if active.`
      : "",
    labNotes.current_lead_hypothesis?.statement_source === "lab_director_lane_payload"
      ? "LabDirector's latest lane payload is now the source for the lead-hypothesis statement when the canonical hypothesis artifact is incomplete."
      : "",
    ...(chronicleNotes.communication_gaps || []),
    scoutPattern.note || "",
  ], 12);
  const nextActions = normalizeActions(labNotes.next_action_assignments || labNotes.next_actions || [], 8);
  const leadHypothesis = compactText(labNotes.current_lead_hypothesis?.statement || "", 260);
  const hasCurrentLead = Boolean(leadHypothesis);
  const chronicleHandoffSummary = activeSummary({
    candidate: chronicleNotes.handoff_for_lab_director,
    hasCurrentLead,
    fallback: hasCurrentLead
      ? `Trace the current lead "${leadHypothesis}" through live runner evidence and keep stale no-lead statements in resolved history only.`
      : null,
  });
  const gatekeeperHandoffSummary = activeSummary({
    candidate: gate.decision_reason || gate.blockers?.[0],
    hasCurrentLead,
    fallback: hasCurrentLead
      ? `Evaluate active blockers for current lead "${leadHypothesis}" and ignore resolved no-lead setup blockers.`
      : null,
  });
  const latestValidation = latestValidationSummary({ chronicleNotes, gate });
  const digest = {
    cycle_id: cycleId,
    updated_at: new Date().toISOString(),
    generated_by: "refresh-cycle-agent-communication-digest",
    current_focus: {
      lead_hypothesis: labNotes.current_lead_hypothesis?.statement || null,
      hypothesis_id: labNotes.current_lead_hypothesis?.hypothesis_id || null,
      dataset:
        labNotes.current_lead_hypothesis?.materialized_dataset ||
        labNotes.current_lead_hypothesis?.dataset_or_accession ||
        null,
      latest_validation: latestValidation,
      scores: {
        gate: reviewSnapshot(gate, "score", "band"),
        approval: reviewSnapshot(approval, "approval_readiness_score", "approval_readiness_band"),
        conclusion: reviewSnapshot(conclusion, "conclusion_score", "conclusion_band"),
      },
    },
    communication_quality: {
      ...blockerClassification,
      chronicle_gap_count: Array.isArray(chronicleNotes.communication_gaps) ? chronicleNotes.communication_gaps.length : 0,
      duplicate_acquisition_loop: scoutPattern.likely_duplicate_acquisition_loop,
    },
    communication_diagnosis: communicationDiagnosis,
    active_blockers: blockerClassification.active_blockers.slice(0, 24),
    resolved_or_superseded_blockers: blockerClassification.resolved_or_superseded_blockers.slice(0, 24),
    handoffs: {
      lab_director: {
        summary: labNotes.handoff_for_next_lab_director || null,
        next_actions: nextActions,
        latest_decision_lane_id: labNotes.latest_lab_director_decision?.lane_id || null,
      },
      chronicle: {
        summary: chronicleHandoffSummary,
        gatekeeper_summary: chronicleNotes.handoff_for_gatekeeper || null,
        reopen_questions: chronicleNotes.reopen_questions || [],
        next_probe_targets: chronicleNotes.next_probe_targets || [],
      },
      gatekeeper: {
        summary: gatekeeperHandoffSummary,
        latest_lane_id: gate.gatekeeper_review_lane_id || null,
        active_blockers: blockerClassification.active_blockers.slice(0, 10),
      },
      runner: {
        summary: latestValidation,
        latest_lanes: latestRoleLanes({ root, cycleId, role: "lab-runner", limit: 5 }),
      },
      scout: {
        summary: scoutPattern.note || null,
        latest_lanes: latestRoleLanes({ root, cycleId, role: "scout", limit: 5 }),
        failure_pattern: scoutPattern,
      },
    },
    role_boundaries: [
      "LabDirector owns scientific direction: lead hypothesis, pivot/demotion decisions, validation priorities, and research-note updates.",
      "Chronicle owns traceability: corpus map, evidence ledger, stale sink detection, and concise handoff of what changed over time.",
      "Supervisor and watchdog own process completion and anomaly reporting; they should not invent research claims.",
      "Gatekeeper evaluates only the active scientific blockers and records resolved or superseded blockers separately.",
    ],
    timeline: uniqueStrings([
      labNotes.latest_lab_director_decision?.lane_id
        ? `${labNotes.latest_lab_director_decision.lane_id}: ${labNotes.latest_lab_director_decision.summary || labNotes.latest_lab_director_decision.rationale || "LabDirector decision recorded."}`
        : "",
      chronicleNotes.dci_lane_id
        ? `${chronicleNotes.dci_lane_id}: ${chronicleNotes.dci_summary || "Chronicle DCI checkpoint recorded."}`
        : "",
      latestValidation
        ? `latest validation: ${latestValidation}`
        : "",
      gate.gatekeeper_review_lane_id
        ? `${gate.gatekeeper_review_lane_id}: gate status ${gate.gatekeeper_review_status || "unknown"}; mode ${gate.mode || "unknown"}`
        : "",
    ], 20),
    source_paths: {
      lab_director_research_notes: fs.existsSync(labNotesPath) ? labNotesPath : null,
      chronicle_research_notes: fs.existsSync(chronicleNotesPath) ? chronicleNotesPath : null,
      gate_review: fs.existsSync(gatePath) ? gatePath : null,
      approval_review: fs.existsSync(approvalPath) ? approvalPath : null,
      conclusion_review: fs.existsSync(conclusionPath) ? conclusionPath : null,
      cycle_state: fs.existsSync(cycleStatePath) ? cycleStatePath : null,
    },
  };

  writeJson(jsonPath, digest);
  writeMarkdownDigest(markdownPath, digest);
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    updated: true,
    reason: "refreshed",
  };
}

module.exports = {
  ensureAgentCommunicationDigest,
};
