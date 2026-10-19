"use strict";

const fs = require("fs");
const path = require("path");
const {
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  normalizeActions,
  parseJsonPayload,
  readJsonIfExists,
  readTextIfExists,
  uniqueStrings,
  writeJson,
} = require("./research_note_utils");

function payloadFromResult(result) {
  if (!result || typeof result !== "object") return null;
  return (
    (result.extracted_json && typeof result.extracted_json === "object" ? result.extracted_json : null) ||
    (result.chronicle_dci && typeof result.chronicle_dci === "object" ? result.chronicle_dci : null) ||
    parseJsonPayload(result.output_last_message) ||
    parseJsonPayload(result.stdout) ||
    parseJsonPayload(result.stderr) ||
    parseJsonPayload(result.summary)
  );
}

function latestChronicleLaneSummaries({ root, cycleId, limit = 8 }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  return fs.readdirSync(lanesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("chronicle"))
    .map((entry) => {
      const laneDir = path.join(lanesRoot, entry.name);
      const resultPath = path.join(laneDir, "result.json");
      const messagePath = path.join(laneDir, "output-last-message.txt");
      const rolePlanPath = path.join(laneDir, "role-plan.json");
      return {
        lane_id: entry.name,
        resultPath,
        messagePath,
        rolePlanPath,
        updated_at_epoch_ms: Math.max(fileMtimeMs(resultPath), fileMtimeMs(messagePath), fileMtimeMs(rolePlanPath)),
      };
    })
    .sort((a, b) => b.updated_at_epoch_ms - a.updated_at_epoch_ms)
    .slice(0, limit)
    .map((lane) => {
      const { resultPath, messagePath, rolePlanPath } = lane;
      const result = readJsonIfExists(resultPath) || {};
      const payload = payloadFromResult(result) || parseJsonPayload(readTextIfExists(messagePath, 1024 * 1024));
      return {
        lane_id: lane.lane_id,
        status: result.status || null,
        result_path: fs.existsSync(resultPath) ? resultPath : null,
        output_last_message_path: fs.existsSync(messagePath) ? messagePath : null,
        output_last_message_excerpt: readTextIfExists(messagePath, 1200),
        summary: compactText(payload?.summary || result.summary || "", 1400) || null,
        claim_deltas: Array.isArray(payload?.claim_deltas) ? payload.claim_deltas.slice(0, 8) : [],
        open_questions: uniqueStrings(payload?.open_questions || payload?.reopen_questions || [], 8),
        recommended_actions: normalizeActions(payload?.recommended_actions || [], 8),
        updated_at_epoch_ms: lane.updated_at_epoch_ms,
      };
    });
}

function summarizeCommunicationGaps({ checkpoint, corpusMap, evidenceLedger }) {
  const checkpointText = [
    checkpoint?.summary,
    ...(Array.isArray(checkpoint?.completed_probes) ? checkpoint.completed_probes.map((item) => item.summary) : []),
    ...(Array.isArray(evidenceLedger?.entries) ? evidenceLedger.entries.map((item) => item.local_context_summary || item.graph_edge_or_blocker) : []),
  ].filter(Boolean).join(" ");
  const manifestCheck = corpusMap?.manifest_check || {};
  const gaps = [];
  if (Array.isArray(manifestCheck.missing_expected_aliases) && manifestCheck.missing_expected_aliases.length > 0) {
    gaps.push(`review-map aliases missing: ${manifestCheck.missing_expected_aliases.join(", ")}`);
  }
  if (/claim-traces?.*stale|validation-results?.*stale|canonical sinks? remain stale|stop at runner/i.test(checkpointText)) {
    gaps.push("canonical claim/validation sinks lag the live runner frontier");
  }
  if (/brief-index.*null|brief-index.*lag/i.test(checkpointText)) {
    gaps.push("brief-index is not carrying usable claim deltas or strategy advice");
  }
  if (/papers\.json.*does not expose|same-dataset.*nested|baseline.*nested-not-top-level|not materialized/i.test(checkpointText)) {
    gaps.push("same-dataset baseline is nested in handoff artifacts instead of top-level searchable literature fields");
  }
  if (/no report json|report json artifact/i.test(checkpointText)) {
    gaps.push("report-level JSON traceability is missing");
  }
  return uniqueStrings(gaps, 12);
}

function latestValidationFromLedger(evidenceLedger) {
  const entries = Array.isArray(evidenceLedger?.entries) ? evidenceLedger.entries : [];
  const latest = entries.find((item) => item.evidence_role === "latest_validation_status") ||
    entries.find((item) => /validation/i.test(String(item.evidence_role || item.graph_edge_or_blocker || "")));
  if (!latest) return null;
  return {
    summary: compactText(latest.local_context_summary || "", 900) || null,
    graph_edge_or_blocker: latest.graph_edge_or_blocker || null,
    file_path: latest.file_path || null,
    matched_terms: Array.isArray(latest.matched_terms) ? latest.matched_terms.slice(0, 12) : [],
  };
}

function traceFocus(corpusMap) {
  const focus = corpusMap?.trace_focus || {};
  const lead = focus.lead_executable_claim || {};
  return {
    latest_live_frontier: focus.latest_live_frontier || null,
    lead_executable_claim: Object.keys(lead).length > 0
      ? {
          claim_id: lead.claim_id || null,
          hypothesis_id: lead.hypothesis_id || null,
          selected_family: lead.selected_family || null,
          source_chain: Array.isArray(lead.source_chain) ? lead.source_chain.slice(0, 12) : [],
        }
      : null,
  };
}

function writeMarkdownNotes(filePath, notes) {
  const lines = [
    `# Chronicle Research Notes: ${notes.cycle_id}`,
    "",
    `- updated_at: ${notes.updated_at}`,
    `- generated_by: ${notes.generated_by}`,
    `- note_status: ${notes.note_status}`,
    "",
    "## DCI Summary",
    notes.dci_summary || "none",
    "",
    "## Trace Focus",
    `- lead_executable_claim: ${JSON.stringify(notes.trace_focus?.lead_executable_claim || null)}`,
    `- latest_validation: ${JSON.stringify(notes.latest_validation || null)}`,
    "",
    "## Communication Gaps",
    markdownList(notes.communication_gaps),
    "",
    "## Reopen Questions",
    markdownList(notes.reopen_questions),
    "",
    "## Recommended Actions",
    markdownList(notes.recommended_actions),
    "",
    "## Recent Chronicle Lanes",
    markdownList((notes.latest_chronicle_outputs || []).map((item) => `${item.lane_id}: ${item.status || "unknown"} ${item.output_last_message_path || ""}`)),
    "",
    "## Handoff For LabDirector",
    notes.handoff_for_lab_director,
    "",
    "## Handoff For Gatekeeper",
    notes.handoff_for_gatekeeper,
    "",
  ];
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function ensureChronicleResearchNotes({ root, cycleId, force = false }) {
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  const jsonPath = path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`);
  const markdownPath = path.join(stateRoot, `${cycleId}-chronicle-research-notes.md`);
  const checkpointPath = path.join(stateRoot, `${cycleId}-chronicle-dci-checkpoint.json`);
  const corpusMapPath = path.join(stateRoot, `${cycleId}-chronicle-dci-corpus-map.json`);
  const evidenceLedgerPath = path.join(stateRoot, `${cycleId}-chronicle-dci-evidence-ledger.json`);
  const checkpoint = readJsonIfExists(checkpointPath) || {};
  const corpusMap = readJsonIfExists(corpusMapPath) || {};
  const evidenceLedger = readJsonIfExists(evidenceLedgerPath) || {};
  const latestChronicleOutputs = latestChronicleLaneSummaries({ root, cycleId });
  const latestOutput = latestChronicleOutputs[0] || null;
  const latestSourceMtime = Math.max(
    fileMtimeMs(checkpointPath),
    fileMtimeMs(corpusMapPath),
    fileMtimeMs(evidenceLedgerPath),
    ...latestChronicleOutputs.map((item) => item.updated_at_epoch_ms || 0),
  );
  const notesMtime = Math.max(fileMtimeMs(jsonPath), fileMtimeMs(markdownPath));
  if (!force && notesMtime >= latestSourceMtime && fs.existsSync(jsonPath) && fs.existsSync(markdownPath)) {
    return {
      json_path: jsonPath,
      markdown_path: markdownPath,
      updated: false,
      reason: "up_to_date",
    };
  }
  const communicationGaps = summarizeCommunicationGaps({ checkpoint, corpusMap, evidenceLedger });
  const recommendedActions = normalizeActions([
    ...(latestOutput?.recommended_actions || []),
    ...(checkpoint?.recommended_actions || []),
    ...(checkpoint?.next_actions || []),
    ...(Array.isArray(checkpoint?.reopen_questions) ? checkpoint.reopen_questions.map((item) => ({ description: item, preferred_role: "chronicle", type: "reopen_question" })) : []),
  ], 12);
  const notes = {
    cycle_id: cycleId,
    updated_at: new Date().toISOString(),
    generated_by: "refresh-cycle-chronicle-research-notes",
    note_status: fs.existsSync(jsonPath) ? "refreshed" : "fallback_created_from_chronicle_dci_artifacts",
    dci_lane_id: checkpoint.lane_id || latestOutput?.lane_id || null,
    dci_updated_at: checkpoint.updated_at || null,
    dci_status: checkpoint.status || null,
    dci_summary: compactText(checkpoint.summary || latestOutput?.summary || "", 1800) || null,
    trace_focus: traceFocus(corpusMap),
    latest_validation: latestValidationFromLedger(evidenceLedger),
    completed_probes: Array.isArray(checkpoint.completed_probes) ? checkpoint.completed_probes.slice(0, 20) : [],
    compacted_older_probes: Array.isArray(checkpoint.compacted_older_probes) ? checkpoint.compacted_older_probes.slice(0, 12) : [],
    communication_gaps: communicationGaps,
    reopen_questions: uniqueStrings(checkpoint.reopen_questions || latestOutput?.open_questions || [], 12),
    next_probe_targets: Array.isArray(checkpoint.next_probe_targets) ? checkpoint.next_probe_targets.slice(0, 20) : [],
    recommended_action_assignments: recommendedActions,
    recommended_actions: recommendedActions.map((item) => item.description),
    latest_chronicle_outputs: latestChronicleOutputs,
    source_paths: {
      checkpoint: fs.existsSync(checkpointPath) ? checkpointPath : null,
      corpus_map: fs.existsSync(corpusMapPath) ? corpusMapPath : null,
      evidence_ledger: fs.existsSync(evidenceLedgerPath) ? evidenceLedgerPath : null,
    },
  };
  notes.handoff_for_lab_director = [
    notes.trace_focus?.lead_executable_claim?.hypothesis_id
      ? `Treat ${notes.trace_focus.lead_executable_claim.hypothesis_id} as the only executable lead unless LabDirector explicitly pivots.`
      : "No executable lead claim was found in Chronicle DCI artifacts.",
    notes.latest_validation?.summary
      ? `Latest validation status: ${notes.latest_validation.summary}`
      : "",
    communicationGaps.length
      ? `Do not let these communication gaps masquerade as new science: ${communicationGaps.join("; ")}.`
      : "",
  ].filter(Boolean).join(" ");
  notes.handoff_for_gatekeeper = [
    "Use cycle-run-state and the freshest runner outputs as the live frontier when canonical sinks lag.",
    notes.latest_validation?.file_path ? `Latest validation evidence path: ${notes.latest_validation.file_path}.` : "",
    notes.reopen_questions.length ? `Open trace questions: ${notes.reopen_questions.slice(0, 3).join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  writeJson(jsonPath, notes);
  writeMarkdownNotes(markdownPath, notes);
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    updated: true,
    reason: notes.note_status,
  };
}

module.exports = {
  ensureChronicleResearchNotes,
};
