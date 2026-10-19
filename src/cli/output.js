"use strict";

const fs = require("fs");
const path = require("path");

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compactResumePayload(payload, cycleId = null) {
  const diskCycleStatePath = cycleId
    ? path.join(process.cwd(), ".research-lab", "state", `${cycleId}-cycle-run-state.json`)
    : null;
  const diskCycleState = diskCycleStatePath ? safeReadJson(diskCycleStatePath) : null;
  const refreshedCycleState = payload?.refreshed_outputs?.cycle_state || null;
  const laneCounts = refreshedCycleState?.lane_counts || diskCycleState?.lane_counts || null;
  return {
    status: payload?.status || "resume-cycle-complete",
    cycle_id: payload?.cycle_id || cycleId,
    passes_completed: payload?.passes_completed ?? payload?.pass_summaries?.length ?? null,
    self_heal_actions: payload?.self_heal_actions || [],
    payload_parse_error: payload?.payload_parse_error || null,
    lane_counts: laneCounts,
    termination_code: payload?.termination_code || null,
    refreshed_outputs: payload?.refreshed_outputs || diskCycleState
      ? {
          cycle_state_path: payload?.refreshed_outputs?.cycle_state_path || diskCycleStatePath || null,
          cycle_state: refreshedCycleState || diskCycleState
            ? {
                cycle_id: refreshedCycleState?.cycle_id || diskCycleState?.cycle_id || cycleId,
                lane_counts: laneCounts,
              }
            : null,
        }
      : null,
  };
}

function compactRefreshPayload(payload, cycleId = null) {
  const diskCycleStatePath = cycleId
    ? path.join(process.cwd(), ".research-lab", "state", `${cycleId}-cycle-run-state.json`)
    : null;
  const diskCycleState = diskCycleStatePath ? safeReadJson(diskCycleStatePath) : null;
  const cycleState = payload?.cycle_state || diskCycleState || null;
  return {
    status: "refresh-cycle-complete",
    cycle_id: payload?.cycle_id || cycleId,
    refresh_context_only: payload?.refresh_context_only === true,
    refresh_gate_fast: payload?.refresh_gate_fast === true,
    refresh_deferred: payload?.refresh_deferred === true,
    refresh_deferred_reason: payload?.refresh_deferred_reason || null,
    gate_refresh_applied: payload?.gate_refresh_applied === true,
    gate_refresh_error: payload?.gate_refresh_error || null,
    termination_code: payload?.termination_code || null,
    approval_review: payload?.approval_review?.review
      ? {
          approval_readiness_score: payload.approval_review.review.approval_readiness_score ?? null,
          heuristic_approval_readiness_score: payload.approval_review.review.heuristic_approval_readiness_score ?? null,
          approval_score_policy: payload.approval_review.review.approval_score_policy || null,
          score_limiting_stage: payload.approval_review.review.approval_stage_summary?.score_limiting_stage || null,
        }
      : null,
    gate_review: payload?.gate_review?.review
      ? {
          score: payload.gate_review.review.score ?? payload.gate_review.review.gate_score ?? null,
          gate_passed: payload.gate_review.review.gate_passed ?? payload.gate_review.review.pass ?? null,
          gatekeeper_review_status: payload.gate_review.review.gatekeeper_review_status || null,
          pending_rubrics: payload.gate_review.review.gatekeeper_pending_rubrics || null,
          recommended_followup_actions: Array.isArray(payload.gate_review.review.recommended_followup_actions)
            ? payload.gate_review.review.recommended_followup_actions.slice(0, 12).map((item) => ({
                type: item?.type || item?.action_type || null,
                preferred_role: item?.preferred_role || null,
                target_rubric: item?.target_rubric || null,
                priority: item?.priority || null,
                priority_score: item?.priority_score ?? null,
              }))
            : null,
        }
      : null,
    cycle_state: cycleState
      ? {
          cycle_id: cycleState.cycle_id || cycleId,
          status: cycleState.status || null,
          lane_counts: cycleState.lane_counts || null,
          updated_at: cycleState.updated_at || null,
        }
      : null,
    created_followups: payload?.created_followups || null,
    context_health: payload?.context_health || null,
    cycle_memory: payload?.cycle_memory
      ? {
          updated: payload.cycle_memory.updated === true,
          reason: payload.cycle_memory.reason || null,
          memory_summary_path: payload.cycle_memory.memory_summary_path || null,
          index_path: payload.cycle_memory.index_path || null,
        }
      : null,
    agent_mailboxes: payload?.agent_mailboxes
      ? {
          updated: payload.agent_mailboxes.updated === true,
          reason: payload.agent_mailboxes.reason || null,
          ledger_path: payload.agent_mailboxes.ledger_path || null,
        }
      : null,
    agent_protocol: payload?.agent_protocol
      ? {
          updated: payload.agent_protocol.updated === true,
          reason: payload.agent_protocol.reason || null,
          snapshot_path: payload.agent_protocol.snapshot_path || null,
          thread_id: payload.agent_protocol.thread_id || null,
          thread_status: payload.agent_protocol.thread_status || null,
          run_count: payload.agent_protocol.run_count ?? null,
          active_run_count: payload.agent_protocol.active_run_count ?? null,
        }
      : null,
  };
}

function stringifyCliPayload(payload, fallbackPayload = null) {
  if (fallbackPayload) return JSON.stringify(fallbackPayload, null, 2);
  try {
    const rendered = JSON.stringify(payload, null, 2);
    if (rendered.length <= 5 * 1024 * 1024) return rendered;
  } catch {
    // Fall through to compact output.
  }
  return JSON.stringify(fallbackPayload || compactResumePayload(payload), null, 2);
}

module.exports = {
  compactRefreshPayload,
  compactResumePayload,
  safeReadJson,
  stringifyCliPayload,
};
