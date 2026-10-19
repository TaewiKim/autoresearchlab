"use strict";

const fs = require("fs");
const path = require("path");
const { GATE_REVIEW_RUBRICS, filterRubricNamesForObjective } = require("../constants");
const { parseJsonFromText, readJsonIfExists, readJsonIfExistsBounded } = require("../io");
const { uniqueStrings } = require("../utils");

function completedRolePlanCandidates({ root, cycleId, role, actionType, allowMissingActionType = false, maxCandidates = null }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  const candidates = [];
  for (const laneId of fs.readdirSync(lanesRoot)) {
    // Avoid parsing every large role-plan/result in the cycle.  Some analyst
    // recovery plans legitimately carry huge chronicle contexts; gate review
    // only needs gatekeeper/falsifier/lab-director lanes here.
    const laneRoleHint = String(laneId).startsWith("followup-")
      ? String(laneId).slice("followup-".length).split("-").slice(0, role === "lab-director" ? 2 : 1).join("-")
      : String(laneId).split("-").slice(0, role === "lab-director" ? 2 : 1).join("-");
    if (laneRoleHint !== role) continue;
    const laneDir = path.join(lanesRoot, laneId);
    const finalStatus = readJsonIfExists(path.join(laneDir, "final-status.json"));
    if (!finalStatus || finalStatus.status !== "completed") continue;
    const resultPath = path.join(laneDir, "result.json");
    if (!fs.existsSync(resultPath)) continue;
    const embeddedResult = !fs.existsSync(path.join(laneDir, "role-plan.json"))
      ? readJsonIfExistsBounded(resultPath, 10 * 1024 * 1024)
      : null;
    // Some older/native executor lanes embedded the authoritative role plan
    // inside result.json but did not materialize role-plan.json. Gate review
    // must still aggregate those completed gatekeeper reviews; otherwise the
    // cycle appears to have never received independent gate review.
    const rolePlan = readJsonIfExists(path.join(laneDir, "role-plan.json")) || embeddedResult?.role_plan || {
      role,
      action_type: actionType,
      lane_id: laneId,
    };
    if (!rolePlan || rolePlan.role !== role) continue;
    const matchesActionType = rolePlan.action_type === actionType;
    const matchesMissingActionType = allowMissingActionType && (rolePlan.action_type == null || rolePlan.action_type === "");
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(laneDir, "result.json")).mtimeMs;
    } catch {}
    let action_match = "other";
    if (matchesActionType) {
      action_match = "exact";
    } else if (matchesMissingActionType) {
      action_match = "missing-action-type";
    } else if (String(rolePlan.action_type || "").trim() === "recovery_followup") {
      action_match = "recovery-followup";
    }
    candidates.push({
      laneId,
      laneDir,
      rolePlan,
      finalStatus,
      result: embeddedResult,
      resultPath,
      mtime,
      action_match,
      target_rubric:
        rolePlan?.planner_metadata?.target_rubric ||
        rolePlan?.target_rubric ||
        null,
    });
  }
  candidates.sort((a, b) => {
    const rank = (candidate) =>
      candidate.action_match === "exact"
        ? 0
        : candidate.action_match === "missing-action-type"
          ? 1
          : candidate.action_match === "recovery-followup"
            ? 2
            : 3;
    return rank(a) - rank(b) || b.mtime - a.mtime || a.laneId.localeCompare(b.laneId);
  });
  const selected = Number.isFinite(Number(maxCandidates)) && Number(maxCandidates) > 0
    ? candidates.slice(0, Number(maxCandidates))
    : candidates;
  return selected
    .map((candidate) => ({
      ...candidate,
      result: candidate.result || readJsonIfExistsBounded(candidate.resultPath, 10 * 1024 * 1024),
    }))
    .filter((candidate) => candidate.result);
}

function selectParsedCandidate(candidates, parseFn) {
  const list = Array.isArray(candidates) ? candidates : [];
  let fallback = null;
  for (const candidate of list) {
    fallback ||= candidate;
    const parsed = parseFn(candidate);
    if (parsed) return { candidate, parsed };
  }
  return { candidate: fallback, parsed: null };
}

function expectedGateRubrics({ conclusion, approval, objective = null }) {
  // Which reporting rubrics the gate asks for. An objective that does not
  // describe that kind of study drops the two study-design reporting standards,
  // so the gate is not blocked by a standard the work can never satisfy.
  //
  // With one exception, below: a rubric this cycle's own conclusion or approval
  // review already SCORED was judged applicable by a reviewer who looked at the
  // work, and dropping it would discard that judgement -- and with it the score
  // the gate carries forward.
  const effectiveObjective =
    objective || conclusion?.objective || approval?.objective || null;
  const sourceRubric =
    (Array.isArray(conclusion?.conclusion_rubric) && conclusion.conclusion_rubric.length > 0
      ? conclusion.conclusion_rubric
      : Array.isArray(approval?.approval_rubric)
        ? approval.approval_rubric
        : []);
  const applicable = sourceRubric
    .filter((item) => item?.applicable !== false)
    .map((item) => String(item?.name || "").trim())
    .filter(Boolean);
  const names = applicable.length > 0 ? uniqueStrings(applicable) : GATE_REVIEW_RUBRICS.slice();
  const alreadyScored = new Set(
    sourceRubric
      .filter((item) => typeof item?.score === "number")
      .map((item) => String(item?.name || "").trim())
      .filter(Boolean),
  );
  const filtered = filterRubricNamesForObjective(names, effectiveObjective);
  return uniqueStrings([...filtered, ...names.filter((name) => alreadyScored.has(name))]);
}

function parseLabDirectorRequeryOutput(candidate) {
  if (!candidate?.result) return null;
  const result = candidate.result;
  const payload =
    (result?.extracted_json && typeof result.extracted_json === "object" ? result.extracted_json : null) ||
    (result?.lab_director_requery && typeof result.lab_director_requery === "object"
      ? result.lab_director_requery
      : null) ||
    parseJsonFromText(result?.output_last_message) ||
    parseJsonFromText(result?.stdout) ||
    parseJsonFromText(result?.stderr) ||
    parseJsonFromText(result?.summary);
  if (!payload || typeof payload !== "object") return null;
  const inferredDecision = (() => {
    const direct = String(
      payload.requery_decision ||
      payload.decision ||
      payload?.director_decision?.mode ||
      "",
    ).trim().toLowerCase();
    if (direct === "hold_promotion_and_requery") return "requery";
    if (direct === "hold") return "requery";
    if (direct === "pivot") return "requery";
    if (direct) return direct;
    const recommendedState = String(payload?.director_verdict?.recommended_state || "").trim().toLowerCase();
    if (recommendedState.includes("restart")) return "restart";
    if (recommendedState.includes("replace")) return "replace";
    if (recommendedState.includes("requery") || recommendedState.includes("hold")) return "requery";
    if (payload?.director_assessment || payload?.director_verdict || payload?.director_decision) return "uphold";
    return "";
  })();
  const decision = inferredDecision;
  if (!["uphold", "replace", "restart", "requery"].includes(decision)) return null;
  const normalizeBlockerReviewRequests = (values) =>
    Array.isArray(values)
      ? values
          .map((item, index) => {
            if (!item || typeof item !== "object") return null;
            const blocker = String(item.blocker || item.comment || item.issue || "").trim();
            const requestedAction = String(
              item.requested_action ||
                item.request ||
                item.action ||
                "reconsider",
            ).trim().toLowerCase();
            if (!blocker) return null;
            return {
              request_id:
                String(item.request_id || item.id || "").trim() ||
                `lab-director-blocker-review-${index + 1}`,
              blocker,
              target_rubric: String(item.target_rubric || item.rubric || "gate_independence").trim(),
              requested_action: [
                "reconsider",
                "remove",
                "downgrade",
                "mark_resolved",
                "supersede",
              ].includes(requestedAction)
                ? requestedAction
                : "reconsider",
              rationale: String(item.rationale || item.reason || item.evidence_summary || "").trim() || null,
              evidence_refs: Array.isArray(item.evidence_refs)
                ? item.evidence_refs.map((value) => String(value || "").trim()).filter(Boolean)
                : [],
              replacement_blocker:
                String(item.replacement_blocker || item.replacement_comment || "").trim() || null,
            };
          })
          .filter(Boolean)
      : [];
  return {
    lane_id: candidate.laneId,
    source_action_match: candidate.action_match || "unknown",
    decision,
    rationale:
      String(
        payload.rationale ||
          payload?.director_decision?.reason ||
          payload.summary ||
          payload?.director_assessment?.primary_reason ||
          payload?.director_verdict?.recommended_state ||
          "",
      ).trim() || null,
    replacement_hypotheses: Array.isArray(payload.replacement_hypotheses)
      ? payload.replacement_hypotheses
      : [],
    validation_changes: uniqueStrings(
      payload.validation_changes ||
      payload.blocking_issues ||
      payload.blockers ||
      [],
    ),
    next_actions: Array.isArray(payload.next_actions)
      ? payload.next_actions
      : Array.isArray(payload.highest_yield_next_actions)
        ? payload.highest_yield_next_actions
        : Array.isArray(payload?.director_decision?.approved_actions)
          ? payload.director_decision.approved_actions
        : [],
    gate_blocker_review_requests: normalizeBlockerReviewRequests(
      payload.gate_blocker_review_requests ||
        payload.blocker_review_requests ||
        payload.unresolved_blocker_review_requests ||
        [],
    ),
    raw: payload,
  };
}

module.exports = {
  completedRolePlanCandidates,
  selectParsedCandidate,
  expectedGateRubrics,
  parseLabDirectorRequeryOutput,
};
