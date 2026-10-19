"use strict";

const fs = require("fs");
const path = require("path");
const {
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  parseJsonPayload,
  readJsonIfExists,
  readTextIfExists,
  writeJson,
} = require("./research_note_utils");

function notesFileExists(jsonPath, markdownPath) {
  return fs.existsSync(jsonPath) || fs.existsSync(markdownPath);
}

function preserveExistingAnalystResearchNotes({ jsonPath, markdownPath, reason }) {
  return {
    updated: false,
    reason,
    jsonPath,
    markdownPath,
    existing: {
      json: fs.existsSync(jsonPath),
      markdown: fs.existsSync(markdownPath),
    },
  };
}

function isoFromMs(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function numericSuffix(value) {
  const match = String(value || "").match(/-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function artifactLaneIdFromPath(filePath) {
  const parts = String(filePath || "").split(path.sep);
  return parts.find((part) => /^followup-analyst-/.test(part)) || null;
}

function extractAccessionsFromText(value) {
  const matches = String(value || "").match(/\bGSE\d+\b/gi) || [];
  return [...new Set(matches.map((item) => item.toUpperCase()))];
}

function setsOverlap(left, right) {
  const rightSet = new Set(right || []);
  return (left || []).some((item) => rightSet.has(item));
}

function labDirectorPrimaryAccessions(payload, jsonText) {
  const candidates = [];
  const appendFrom = (value) => {
    for (const accession of extractAccessionsFromText(JSON.stringify(value || ""))) {
      if (!candidates.includes(accession)) candidates.push(accession);
    }
  };
  appendFrom(payload?.selected_hypothesis);
  if (Array.isArray(payload?.replacement_hypotheses) && payload.replacement_hypotheses.length > 0) {
    appendFrom(payload.replacement_hypotheses[0]);
  }
  if (Array.isArray(payload?.candidate_hypotheses) && payload.candidate_hypotheses.length > 0) {
    appendFrom(payload.candidate_hypotheses[0]);
  }
  if (candidates.length > 0) return candidates;
  return extractAccessionsFromText(jsonText);
}

function latestAnalystMemos({ root, cycleId, limit = 8 }) {
  const statsRoot = path.join(root, "artifacts", "stats", cycleId);
  if (!fs.existsSync(statsRoot)) return [];
  return fs.readdirSync(statsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^followup-analyst-/.test(entry.name))
    .map((entry) => {
      const memoPath = path.join(statsRoot, entry.name, "analysis-design-memo.json");
      const handoffPath = path.join(statsRoot, entry.name, "handoff-validation-plan.json");
      return {
        lane_id: entry.name,
        memoPath,
        handoffPath,
        updated_at_epoch_ms: Math.max(fileMtimeMs(memoPath), fileMtimeMs(handoffPath)),
      };
    })
    .filter((item) => fs.existsSync(item.memoPath) || fs.existsSync(item.handoffPath))
    .sort((a, b) => {
      const byTime = b.updated_at_epoch_ms - a.updated_at_epoch_ms;
      if (byTime !== 0) return byTime;
      return numericSuffix(b.lane_id) - numericSuffix(a.lane_id);
    })
    .slice(0, limit)
    .map((item) => {
      const { memoPath, handoffPath } = item;
      const memo = readJsonIfExists(memoPath) || null;
      const handoff = readJsonIfExists(handoffPath) || null;
      return {
        lane_id: item.lane_id,
        memo_path: fs.existsSync(memoPath) ? memoPath : null,
        handoff_path: fs.existsSync(handoffPath) ? handoffPath : null,
        updated_at_epoch_ms: item.updated_at_epoch_ms,
        memo,
        handoff,
      };
    });
}

function payloadFromResult(result, outputText) {
  if (result?.extracted_json && typeof result.extracted_json === "object") return result.extracted_json;
  if (result?.lab_director_requery && typeof result.lab_director_requery === "object") {
    return result.lab_director_requery;
  }
  return parseJsonPayload(result?.output_last_message) || parseJsonPayload(outputText) || null;
}

function latestLabDirectorDecisions({ root, cycleId, limit = 5 }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  return fs.readdirSync(lanesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /lab-director/.test(entry.name))
    .map((entry) => {
      const laneDir = path.join(lanesRoot, entry.name);
      const resultPath = path.join(laneDir, "result.json");
      const outputPath = path.join(laneDir, "output-last-message.txt");
      return {
        lane_id: entry.name,
        resultPath,
        outputPath,
        updated_at_epoch_ms: Math.max(fileMtimeMs(resultPath), fileMtimeMs(outputPath)),
      };
    })
    .sort((a, b) => b.updated_at_epoch_ms - a.updated_at_epoch_ms)
    .slice(0, limit)
    .map((lane) => {
      const { resultPath, outputPath } = lane;
      const result = readJsonIfExists(resultPath) || {};
      const outputText = readTextIfExists(outputPath, 512 * 1024);
      const payload = payloadFromResult(result, outputText) || {};
      const summary = compactText(payload.summary || payload.rationale || outputText || "", 1400) || null;
      const jsonText = JSON.stringify(payload || {});
      const accessions = labDirectorPrimaryAccessions(payload, jsonText);
      return {
        lane_id: lane.lane_id,
        result_path: fs.existsSync(resultPath) ? resultPath : null,
        updated_at_epoch_ms: lane.updated_at_epoch_ms,
        requery_decision: payload.requery_decision || payload.decision || null,
        summary,
        rationale: compactText(payload.rationale || "", 1400) || null,
        mentioned_accessions: accessions,
        primary_accession: accessions[0] || null,
      };
    })
    .filter((item) => item.result_path || item.summary);
}

function inferDatasetText(item) {
  const memo = item?.memo || {};
  const handoff = item?.handoff || {};
  const selectedRoot = memo?.dataset_exploration?.selected_dataset_root || handoff.dataset_root || "";
  return `${memo.hypothesis_statement || ""} ${selectedRoot} ${JSON.stringify(handoff.column_mapping || {})}`;
}

function summarizeMemo(item) {
  if (!item) return null;
  const memo = item.memo || {};
  const handoff = item.handoff || {};
  return {
    lane_id: item.lane_id,
    memo_path: item.memo_path,
    handoff_path: item.handoff_path,
    updated_at: isoFromMs(item.updated_at_epoch_ms),
    phase: memo.phase || null,
    primary_hypothesis_id: memo.primary_hypothesis_id || null,
    primary_family: memo.primary_family || null,
    hypothesis_statement: compactText(memo.hypothesis_statement || handoff?.column_mapping?.hypothesis_statement || "", 1400) || null,
    selected_dataset_root: memo?.dataset_exploration?.selected_dataset_root || handoff.dataset_root || null,
    handoff_status: handoff.status || null,
    final_handoff_readiness: memo.final_handoff_readiness || null,
    minimum_final_handoff_requirements: Array.isArray(memo.minimum_final_handoff_requirements)
      ? memo.minimum_final_handoff_requirements.slice(0, 12)
      : [],
  };
}

function designRejectedBecauseStale(staleAgainstLabDirector, latestMemoSummary, latestLabDirector) {
  if (!staleAgainstLabDirector) return [];
  return [
    {
      design: latestMemoSummary?.hypothesis_statement || "latest Analyst handoff",
      status: "deferred_or_rejected_as_current_handoff",
      reason:
        `A newer LabDirector decision appears to target ${latestLabDirector?.primary_accession || "a different dataset/accession"}; treat the older Analyst handoff as historical until refreshed against the current LabDirector lead.`,
    },
  ];
}

function buildAnalystResearchNotes({ root, cycleId }) {
  const latestMemos = latestAnalystMemos({ root, cycleId, limit: 8 });
  const latestMemo = latestMemos[0] || null;
  const latestLabDirector = latestLabDirectorDecisions({ root, cycleId, limit: 5 })[0] || null;
  const analystText = inferDatasetText(latestMemo);
  const analystAccessions = extractAccessionsFromText(analystText);
  const labDirectorAccessions = latestLabDirector?.mentioned_accessions || [];
  const labNewer = latestLabDirector && latestMemo
    ? latestLabDirector.updated_at_epoch_ms > latestMemo.updated_at_epoch_ms
    : false;
  const staleAgainstLabDirector = Boolean(
    labNewer &&
      labDirectorAccessions.length > 0 &&
      analystAccessions.length > 0 &&
      !setsOverlap(labDirectorAccessions, analystAccessions),
  );
  const latestMemoSummary = summarizeMemo(latestMemo);
  const labDirectorLead = latestLabDirector?.primary_accession || latestLabDirector?.summary || "latest LabDirector lead";
  const noteStatus = !latestMemo
    ? "missing_analyst_memo"
    : staleAgainstLabDirector
      ? "stale_against_latest_lab_director_decision"
      : "current_projection_from_latest_analyst_memo";
  const activeUsePolicy = staleAgainstLabDirector
    ? "do_not_use_latest_analyst_memo_as_current_runner_handoff; spawn or wait for an analyst refresh bound to the latest LabDirector lead"
    : "latest analyst memo may be used only if gate and LabDirector state agree";
  const currentValidationFocus = staleAgainstLabDirector
    ? {
        status: "blocked_until_refreshed",
        active_lead_from_lab_director: labDirectorLead,
        stale_or_superseded_handoff: latestMemoSummary?.hypothesis_statement || null,
        required_refresh:
          "Rewrite Analyst validation design around the latest LabDirector lead with schema-backed exposure/outcome, adjustment set, nulls, and open-source workflow/tool choice.",
      }
    : {
        status: latestMemo ? "candidate_current_handoff" : "no_analyst_handoff_found",
        active_handoff: latestMemoSummary?.hypothesis_statement || null,
        dataset_root: latestMemoSummary?.selected_dataset_root || null,
      };

  return {
    cycle_id: cycleId,
    generated_by: "refresh-cycle-analyst-research-notes",
    updated_at: new Date().toISOString(),
    note_policy:
      "Durable Analyst scientific notebook: preserve core validation reasoning, schema/tool choices, rejected designs, falsification criteria, and next decision-critical actions. Do not dump raw lane logs or routine status counters.",
    note_status: noteStatus,
    active_use_policy: activeUsePolicy,
    current_validation_focus: currentValidationFocus,
    analysis_reasoning_log: [
      {
        source: latestMemoSummary?.lane_id || null,
        reasoning:
          staleAgainstLabDirector
            ? "Latest Analyst handoff is scientifically stale because it targets a different dataset/accession than the newer LabDirector decision. Treat it as historical evidence only, not the current runner plan."
            : latestMemoSummary
              ? "Latest Analyst memo is the current candidate validation design, subject to LabDirector/gate consistency checks."
              : "No Analyst memo was found; validation design must be authored before runner/gate promotion.",
      },
    ],
    evidence_snapshot: {
      latest_analyst_memo: latestMemoSummary,
      latest_lab_director_decision: latestLabDirector
        ? {
            lane_id: latestLabDirector.lane_id,
            result_path: latestLabDirector.result_path,
            updated_at: isoFromMs(latestLabDirector.updated_at_epoch_ms),
            requery_decision: latestLabDirector.requery_decision,
            summary: latestLabDirector.summary,
            rationale: latestLabDirector.rationale,
            mentioned_accessions: latestLabDirector.mentioned_accessions,
            primary_accession: latestLabDirector.primary_accession,
          }
        : null,
    },
    open_methodological_blockers: staleAgainstLabDirector
      ? [
          "Current Analyst memo targets a different dataset/accession than the latest LabDirector lead.",
          "Latest-lead-specific schema-backed exposure/outcome mapping and adjustment set are not yet captured in the canonical Analyst notebook.",
          "Runner handoff must wait for a refreshed Analyst design with falsification/null tests and tool/workflow decision.",
        ]
      : [],
    rejected_or_deferred_designs: designRejectedBecauseStale(staleAgainstLabDirector, latestMemoSummary, latestLabDirector),
    dataset_and_tool_context: {
      latest_analyst_dataset_root: latestMemoSummary?.selected_dataset_root || null,
      latest_analyst_handoff_status: latestMemoSummary?.handoff_status || null,
      tool_context_status:
        "Use the per-lane analysis-design-memo/open_source_agent_discovery for detailed tool attempts; keep this notebook to decision-critical tool implications only.",
    },
    falsification_criteria: staleAgainstLabDirector
      ? [
          "A refreshed Analyst design must fail closed if required labels, identifiers, endpoint/outcome fields, adjustment variables, or QC covariates cannot be joined.",
          "Require patient-aware and QC-adjusted models plus label-shuffled, pathway-size matched, and region/composition-preserving nulls before runner/gate promotion.",
        ]
      : latestMemoSummary?.minimum_final_handoff_requirements || [],
    next_actions: staleAgainstLabDirector
      ? [
          "Do not route the latest mismatched Analyst handoff to lab-runner as the current scientific plan.",
          "Spawn or wait for an Analyst lane that rewrites the validation memo for the latest LabDirector lead if that lead remains active.",
          "Keep author/document/gate promotion blocked until the refreshed Analyst memo is schema-backed and runner-validated.",
        ]
      : [
          "Before consuming an Analyst handoff, confirm it matches the latest LabDirector lead and current gate review.",
        ],
    handoff_for_next_analyst: staleAgainstLabDirector
      ? "Start from the latest LabDirector decision, not the stale Analyst memo. Produce a compact analysis-design-memo with schema-backed variable mapping, adjustment set, open-source workflow/tool decision, null tests, and runner blueprint."
      : "Read this notebook first, then inspect only the named latest memo/handoff artifacts needed to continue validation reasoning.",
    recent_analyst_memos_index: latestMemos.map(summarizeMemo).filter(Boolean).slice(0, 5),
    mismatch_assessment: {
      analyst_accessions: analystAccessions,
      latest_lab_director_accessions: labDirectorAccessions,
      latest_lab_director_newer_than_analyst_memo: labNewer,
      stale_against_lab_director: staleAgainstLabDirector,
    },
    // Backward-compatible aliases used by existing refresh/report consumers.
    latest_analyst_memo: latestMemoSummary,
    latest_lab_director_decision: latestLabDirector
      ? {
          lane_id: latestLabDirector.lane_id,
          result_path: latestLabDirector.result_path,
          updated_at: isoFromMs(latestLabDirector.updated_at_epoch_ms),
          requery_decision: latestLabDirector.requery_decision,
          summary: latestLabDirector.summary,
          rationale: latestLabDirector.rationale,
          mentioned_accessions: latestLabDirector.mentioned_accessions,
          primary_accession: latestLabDirector.primary_accession,
        }
      : null,
    next_decision_critical_actions: staleAgainstLabDirector
      ? [
          "Do not route the latest mismatched analyst handoff to lab-runner as the current scientific plan.",
          "Spawn or wait for an analyst lane that rewrites the validation memo for the latest LabDirector lead if still active.",
          "Keep author/document/gate promotion blocked until the refreshed analyst memo is schema-backed and runner-validated.",
        ]
      : [
          "Before consuming an analyst handoff, confirm it matches the latest LabDirector lead and current gate review.",
        ],
  };
}

function renderMarkdown(notes) {
  const latest = notes.latest_analyst_memo || {};
  const lab = notes.latest_lab_director_decision || {};
  const focus = notes.current_validation_focus || {};
  return [
    `# Analyst Research Notes — ${notes.cycle_id}`,
    "",
    `- updated_at: ${notes.updated_at}`,
    `- note_status: ${notes.note_status}`,
    `- active_use_policy: ${notes.active_use_policy}`,
    `- note_policy: ${notes.note_policy}`,
    "",
    "## Current Validation Focus",
    `- status: ${focus.status || "unknown"}`,
    `- active_lead_from_lab_director: ${focus.active_lead_from_lab_director || "not specified"}`,
    `- active_handoff: ${focus.active_handoff || focus.stale_or_superseded_handoff || "none"}`,
    `- required_refresh: ${focus.required_refresh || "none"}`,
    "",
    "## Core Analyst Reasoning",
    markdownList((notes.analysis_reasoning_log || []).map((item) => item.reasoning || item)),
    "",
    "## Decision-Critical Evidence Snapshot",
    `- latest_analyst_lane: ${latest.lane_id || "none"}`,
    `- latest_analyst_memo: ${latest.memo_path || "none"}`,
    `- latest_analyst_handoff: ${latest.handoff_path || "none"}`,
    `- latest_analyst_hypothesis: ${latest.hypothesis_statement || "none"}`,
    `- latest_analyst_dataset_root: ${latest.selected_dataset_root || "none"}`,
    `- latest_lab_director_lane: ${lab.lane_id || "none"}`,
    `- latest_lab_director_summary: ${lab.summary || "none"}`,
    "",
    "## Open Methodological Blockers",
    markdownList(notes.open_methodological_blockers),
    "",
    "## Rejected or Deferred Designs",
    markdownList(notes.rejected_or_deferred_designs),
    "",
    "## Dataset and Tool Context",
    `- latest_analyst_dataset_root: ${notes.dataset_and_tool_context?.latest_analyst_dataset_root || "none"}`,
    `- latest_analyst_handoff_status: ${notes.dataset_and_tool_context?.latest_analyst_handoff_status || "unknown"}`,
    `- tool_context_status: ${notes.dataset_and_tool_context?.tool_context_status || "unknown"}`,
    "",
    "## Falsification Criteria",
    markdownList(notes.falsification_criteria),
    "",
    "## Next Decision-Critical Actions",
    markdownList(notes.next_actions || notes.next_decision_critical_actions),
    "",
    "## Handoff for Next Analyst",
    notes.handoff_for_next_analyst || "none",
    "",
  ].join("\n");
}

function ensureAnalystResearchNotes({ root, cycleId, force = false, allowOverwrite = false } = {}) {
  if (!root) throw new Error("root is required");
  if (!cycleId) throw new Error("cycleId is required");
  const stateRoot = path.join(root, "state");
  const jsonPath = path.join(stateRoot, `${cycleId}-analyst-research-notes.json`);
  const markdownPath = path.join(stateRoot, `${cycleId}-analyst-research-notes.md`);
  if (notesFileExists(jsonPath, markdownPath) && !allowOverwrite) {
    return preserveExistingAnalystResearchNotes({
      jsonPath,
      markdownPath,
      reason: force ? "preserved_existing_analyst_notes_despite_force" : "preserved_existing_analyst_notes",
    });
  }
  ensureDir(stateRoot);
  const notes = buildAnalystResearchNotes({ root, cycleId });
  writeJson(jsonPath, notes);
  fs.writeFileSync(markdownPath, renderMarkdown(notes), "utf8");
  return {
    updated: true,
    reason: "analyst_research_notes_refreshed",
    jsonPath,
    markdownPath,
    note_status: notes.note_status,
  };
}

module.exports = {
  ensureAnalystResearchNotes,
  latestAnalystMemos,
  buildAnalystResearchNotes,
  notesFileExists,
  preserveExistingAnalystResearchNotes,
};
