"use strict";

const { GATE_REVIEWER_BRIEFS } = require("./constants");
const { parseJsonFromText } = require("./io");
const { keepResearchQualityReasons, uniqueStrings } = require("./utils");

// Relaxed conjunction (owner decision 2026-07-16). The gate verdict was strictly
// conjunctive: a single rubric reviewer's "challenge" dropped the aggregate to
// "challenge" and blocked the pass, so an excellent-on-two-axes lead with one
// merely-solid third axis could never gate-pass (v62 walled with the best lead at
// novelty 62 / tech 58 / repro 52 — and, more to the point, future leads at e.g.
// 85/82/74 would also have been blocked by the 74). We relax ONLY the pure-
// challenge case: a lead may still resolve to "approve" when the three hard
// rubrics are all >= the tolerable floor (no reject-band axis) and at least two
// are >= the approve bar. Any reject-band hard rubric (< floor), two weak hard
// rubrics, or partial-current-hypothesis credit still blocks — this rescues a
// one-solid-axis lead without gutting the bar or gaming scores.
const HARD_GATE_RUBRICS = ["novelty", "technical_quality", "reproducibility"];
const { GATE_THRESHOLD: GATE_APPROVE_MIN } = require("../../../policy/research_gate");
const GATE_TOLERABLE_FLOOR = 70; // challenge/reject band boundary; one hard axis may sit in 70-79

function hardRubricsTolerable(rubricMap) {
  const scores = HARD_GATE_RUBRICS.map((name) => {
    const item = rubricMap.get(name);
    return item && item.applicable !== false ? Number(item.score) : null;
  });
  if (scores.some((score) => score === null || !Number.isFinite(score))) return false;
  if (scores.some((score) => score < GATE_TOLERABLE_FLOOR)) return false;
  return scores.filter((score) => score >= GATE_APPROVE_MIN).length >= 2;
}

function normalizeAlternativeItems(values, { requireFamilyRoot = false } = {}) {
  return Array.isArray(values)
    ? values
        .map((item) => ({
          statement: String(item?.statement || "").trim(),
          family_root: String(item?.family_root || item?.family || "").trim() || null,
          why_better: String(item?.why_better || item?.reason || "").trim() || null,
        }))
        .filter((item) => item.statement && (!requireFamilyRoot || item.family_root))
    : [];
}

function normalizeAlternativeInput(payload, pluralKey, singularKey, options = {}) {
  const plural = normalizeAlternativeItems(payload?.[pluralKey] || [], options);
  if (plural.length > 0) return plural;
  const singularValue = payload?.[singularKey];
  if (!singularValue) return [];
  return normalizeAlternativeItems(
    [
      typeof singularValue === "string"
        ? { statement: singularValue, family_root: payload?.cross_family_alternative_family_root || null }
        : singularValue,
    ],
    options,
  );
}

function normalizeSwitchRecommendations(values) {
  return Array.isArray(values)
    ? values
        .map((item) => ({
          from_family: String(item?.from_family || "").trim() || null,
          to_family: String(item?.to_family || "").trim() || null,
          reason: String(item?.reason || "").trim() || null,
        }))
        .filter((item) => item.to_family && item.reason)
    : [];
}

function normalizeRubricItems(items) {
  return Array.isArray(items)
    ? items
        .map((item) => ({
          name: String(item?.name || item?.rubric || "").trim(),
          score: Number(item?.score || 0),
          reasons: Array.isArray(item?.reasons) ? item.reasons.map((value) => String(value || "").trim()).filter(Boolean) : [],
          applicable: item?.applicable !== false,
          framework: item?.framework ? String(item.framework) : null,
        }))
        .filter((item) => item.name)
    : [];
}

function normalizeBlockerAdjudications(values) {
  return Array.isArray(values)
    ? values
        .map((item) => {
          const decision = String(
            item?.decision ||
              item?.review_decision ||
              item?.blocker_decision ||
              "",
          ).trim().toLowerCase();
          return {
            blocker: String(item?.blocker || item?.comment || item?.issue || "").trim(),
            decision,
            rationale: String(item?.rationale || item?.reason || item?.summary || "").trim() || null,
            target_rubric: String(item?.target_rubric || item?.rubric || "").trim() || null,
            evidence_refs: Array.isArray(item?.evidence_refs)
              ? item.evidence_refs.map((value) => String(value || "").trim()).filter(Boolean)
              : [],
          };
        })
        .filter((item) =>
          item.blocker &&
          ["uphold", "remove", "resolved", "superseded", "downgrade"].includes(item.decision),
        )
    : [];
}

function collectParsedGatekeeperReviews(candidates) {
  const parsedReviews = [];
  const statusByRubric = new Map();
  const setRubricStatus = (rubric, status) => {
    const key = String(rubric || "").trim();
    if (!key) return;
    const existing = statusByRubric.get(key);
    if (!existing || Number(status.source_mtime || 0) >= Number(existing.source_mtime || 0)) {
      statusByRubric.set(key, status);
    }
  };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const targetRubric = String(candidate?.target_rubric || "").trim();
    const parsed = parseGatekeeperLaneOutput(candidate);
    if (targetRubric && !statusByRubric.has(targetRubric)) {
      setRubricStatus(targetRubric, {
        rubric: targetRubric,
        lane_id: candidate.laneId,
        parse_status: parsed ? "parsed" : "parse_failed",
        source_action_match: candidate.action_match || "unknown",
        source_mtime: candidate.mtime || null,
      });
    }
    if (!parsed) continue;
    const focusRubric = String(parsed.focus_rubric || targetRubric || "").trim();
    if (!focusRubric) continue;
    parsedReviews.push({
      ...parsed,
      focus_rubric: focusRubric,
      standard:
        parsed.standard ||
        candidate?.rolePlan?.planner_metadata?.review_standard ||
        GATE_REVIEWER_BRIEFS[focusRubric]?.standard ||
        null,
      // Which lead this reviewer was briefed on, as stamped at dispatch. Null
      // for lanes opened before the stamp existed, and the supersession check
      // treats a missing stamp as "unknown", never as "different".
      briefed_lead_key:
        candidate?.rolePlan?.planner_metadata?.gate_review_lead_key ||
        candidate?.rolePlan?.gate_review_lead_key ||
        null,
      briefed_primary_family:
        candidate?.rolePlan?.planner_metadata?.current_lead_under_review?.primary_family || null,
      briefed_validation_lane_id:
        candidate?.rolePlan?.planner_metadata?.latest_validation_lane_id || null,
      briefed_analysis_contract_id:
        candidate?.rolePlan?.planner_metadata?.latest_validation_summary?.analysis_contract_validation?.contract_id || null,
    });
    setRubricStatus(focusRubric, {
      rubric: focusRubric,
      lane_id: candidate.laneId,
      parse_status: "parsed",
      source_action_match: parsed.source_action_match || candidate.action_match || "unknown",
      verdict: parsed.verdict,
      source_mtime: candidate.mtime || null,
    });
  }
  return {
    parsedReviews,
    statusByRubric: Array.from(statusByRubric.values()),
  };
}

function aggregateGatekeeperReviews({ parsedReviews, expectedRubrics }) {
  const reviewsByRubric = new Map();
  const rubricEvidenceByName = new Map();
  for (const review of parsedReviews || []) {
    if (!reviewsByRubric.has(review.focus_rubric)) {
      reviewsByRubric.set(review.focus_rubric, review);
    }
    for (const item of Array.isArray(review.rubric) ? review.rubric : []) {
      const name = String(item?.name || "").trim();
      if (!name || item?.applicable === false || !Number.isFinite(Number(item?.score))) continue;
      const partialCurrentHypothesisCredit = review.partial_current_hypothesis_credit === true;
      const score = Number(item.score);
      if (!rubricEvidenceByName.has(name)) rubricEvidenceByName.set(name, []);
      rubricEvidenceByName.get(name).push({
        ...item,
        score: partialCurrentHypothesisCredit ? Math.min(score, 90) : score,
        source_lane_id: review.lane_id || null,
        source_focus_rubric: review.focus_rubric || null,
        partial_current_hypothesis_credit: partialCurrentHypothesisCredit,
        partial_current_hypothesis_credit_reason: review.partial_current_hypothesis_credit_reason || null,
      });
    }
  }
  const reviewList = expectedRubrics
    .map((rubric) => reviewsByRubric.get(rubric))
    .filter(Boolean);
  const pendingRubrics = expectedRubrics.filter((rubric) => !reviewsByRubric.has(rubric));
  const rubricMap = new Map();
  const rubricOwnerLaneId = new Map();
  for (const review of reviewList) {
    rubricOwnerLaneId.set(review.focus_rubric, review.lane_id || null);
    const matchingItem = (review.rubric || []).find((item) => item.name === review.focus_rubric);
    const partialCurrentHypothesisCredit = review.partial_current_hypothesis_credit === true;
    const selectedItem = matchingItem
      ? {
          ...matchingItem,
          score: partialCurrentHypothesisCredit
            ? Math.min(Number(matchingItem.score), 90)
            : Number(matchingItem.score),
          evidence_source: partialCurrentHypothesisCredit
            ? "partial_current_hypothesis_gatekeeper_review"
            : matchingItem.evidence_source,
          partial_current_hypothesis_credit: partialCurrentHypothesisCredit || undefined,
          partial_current_hypothesis_credit_reason: review.partial_current_hypothesis_credit_reason || undefined,
        }
      : null;
    rubricMap.set(
      review.focus_rubric,
      selectedItem || {
        name: review.focus_rubric,
        score: review.verdict === "approve" ? 95 : review.verdict === "challenge" ? 75 : 45,
        reasons: keepResearchQualityReasons([
          ...(review.major_objections || []),
          ...(review.missing_validations || []),
        ]),
        applicable: true,
        framework: GATE_REVIEWER_BRIEFS[review.focus_rubric]?.standard || null,
      },
    );
  }
  for (const name of expectedRubrics) {
    // A focused reviewer that returns 0 on an APPLICABLE rubric is reporting the
    // same thing this file already encodes as `focused_review_missing` further
    // down: there was nothing here to assess. It must not out-rank the reviewers
    // who did measure the axis.
    //
    // MEASURED ON cycle-g-v77 (see buildGateFollowupActions for the other half
    // of this): the sole technical_quality and reproducibility reviewers were
    // dispatched before any hypothesis or measurement existed and scored 0. They
    // owned both hard rubrics for the rest of the cycle, binding the gate at
    // technical_quality=0 while nine later gatekeepers scored that same package
    // 24-58. `pendingRubrics` never re-lists a covered rubric, so nothing ever
    // dislodged them.
    //
    // The rule is applied uniformly: a 0 on an applicable rubric is not an
    // observation, whether it arrives as the focused score or as cross-rubric
    // evidence. Without that, an evidence-blind reviewer poisons this path too —
    // it contributes a 0 to a rubric it did not own, and the MINIMUM rule below
    // then picks that 0 over the scores of reviewers who measured the axis.
    //
    // The replacement stays fail-closed: it takes the MINIMUM of what reviewers
    // actually measured, exactly as the missing-reviewer path already did, and
    // only when at least one of them scored the axis above 0. A rubric that
    // every reviewer scores 0 keeps its 0.
    const focused = rubricMap.get(name);
    const focusedIsUninformative = Boolean(focused) && Number(focused.score) === 0;
    if (focused && !focusedIsUninformative) continue;
    const evidence = (rubricEvidenceByName.get(name) || [])
      .filter((item) => item.applicable !== false && Number(item.score) > 0);
    if (evidence.length === 0) continue;
    const selected = evidence.reduce((lowest, item) =>
      Number(item.score) < Number(lowest.score) ? item : lowest,
    );
    rubricMap.set(name, {
      name,
      score: Number(selected.score),
      reasons: keepResearchQualityReasons(selected.reasons || []),
      applicable: true,
      framework: selected.framework || GATE_REVIEWER_BRIEFS[name]?.standard || null,
      evidence_source: selected.partial_current_hypothesis_credit
        ? "partial_current_hypothesis_cross_rubric_review"
        : "cross_rubric_gatekeeper_review",
      source_lane_id: selected.source_lane_id,
      source_focus_rubric: selected.source_focus_rubric,
      // Only a rubric with NO focused reviewer is "not yet observed". A rubric
      // whose focused reviewer scored 0 and was replaced by a measured
      // cross-rubric score is a real observation and must bind normally.
      focused_review_missing: focusedIsUninformative ? undefined : true,
      replaced_uninformative_focused_review: focusedIsUninformative
        ? rubricOwnerLaneId.get(name) || true
        : undefined,
      partial_current_hypothesis_credit: selected.partial_current_hypothesis_credit || undefined,
      partial_current_hypothesis_credit_reason: selected.partial_current_hypothesis_credit_reason || undefined,
    });
  }
  const hasPartialCurrentHypothesisCredit = reviewList.some((item) => item.partial_current_hypothesis_credit === true);
  const anyReject = reviewList.some((item) => item.verdict === "reject");
  const anyChallenge = reviewList.some((item) => item.verdict === "challenge");
  // Relaxed conjunction: a lone hard-rubric challenge (70-79) with two approves
  // and no reject-band axis resolves to "approve"; reject and partial-credit
  // still block. See hardRubricsTolerable above (owner decision 2026-07-16).
  const verdict = pendingRubrics.length > 0
    ? ""
    : anyReject
      ? "reject"
    : anyChallenge
      ? (!hasPartialCurrentHypothesisCredit && hardRubricsTolerable(rubricMap) ? "approve" : "challenge")
    : hasPartialCurrentHypothesisCredit
      ? "challenge"
    : reviewList.length > 0
      ? "approve"
      : "";
  return {
    verdict,
    pendingRubrics,
    partial_current_hypothesis_credit: hasPartialCurrentHypothesisCredit,
    reviews: reviewList,
    rubric: expectedRubrics.map((name) =>
      rubricMap.get(name) || {
        name,
        score: 0,
        reasons: [],
        applicable: true,
        framework: GATE_REVIEWER_BRIEFS[name]?.standard || null,
        // This rubric's gatekeeper lane did not return this round — it is a
        // "not-yet-observed" placeholder, NOT a genuine reviewer score of 0. Tag
        // it so downstream progress tracking excludes it from binding/stall
        // accounting (a transiently-missing lane must not inject a phantom 0 that
        // false-stalls and drops a still-improving lead).
        focused_review_missing: true,
      },
    ),
    major_objections: uniqueStrings(reviewList.flatMap((item) => item.major_objections || [])),
    missing_validations: uniqueStrings(reviewList.flatMap((item) => item.missing_validations || [])),
    same_family_alternatives: reviewList.flatMap((item) => item.same_family_alternatives || []),
    cross_family_alternatives: reviewList.flatMap((item) => item.cross_family_alternatives || []),
    family_switch_recommendations: reviewList.flatMap((item) => item.family_switch_recommendations || []),
    same_family_alternative:
      reviewList.flatMap((item) => item.same_family_alternatives || []).find((item) => item?.statement)?.statement || null,
    cross_family_alternative:
      reviewList.flatMap((item) => item.cross_family_alternatives || []).find((item) => item?.statement)?.statement || null,
    switch_triggers: uniqueStrings(reviewList.flatMap((item) => item.switch_triggers || [])),
    incumbent_rejection_reasons: uniqueStrings(reviewList.flatMap((item) => item.incumbent_rejection_reasons || [])),
    better_alternative_hypotheses: [
      ...reviewList.flatMap((item) => item.cross_family_alternatives || []),
      ...reviewList.flatMap((item) => item.better_alternative_hypotheses || []),
      ...reviewList.flatMap((item) => item.same_family_alternatives || []),
    ],
    required_response_from_lab_director: uniqueStrings(
      reviewList.flatMap((item) => item.required_response_from_lab_director || []),
    ),
    recommended_actions: reviewList.flatMap((item) => item.recommended_actions || []),
    blocker_adjudications: reviewList.flatMap((item) => item.blocker_adjudications || []),
    restart_recommended: reviewList.some((item) => item.restart_recommended === true || item.verdict === "reject"),
  };
}

function parseGatekeeperLaneOutput(candidate) {
  if (!candidate?.result) return null;
  const result = candidate.result;
  const payload =
    (result?.extracted_json && typeof result.extracted_json === "object" ? result.extracted_json : null) ||
    (result?.gate_review && typeof result.gate_review === "object" ? result.gate_review : null) ||
    parseJsonFromText(result?.output_last_message) ||
    parseJsonFromText(result?.stdout) ||
    parseJsonFromText(result?.stderr) ||
    parseJsonFromText(result?.summary);
  if (!payload || typeof payload !== "object") return null;
  const verdict = String(payload.verdict || payload.mode || "").trim().toLowerCase();
  if (!["approve", "challenge", "reject"].includes(verdict)) return null;
  return {
    lane_id: candidate.laneId,
    source_mtime: candidate.mtime || null,
    source_result_path: candidate.resultPath || null,
    source_action_match: candidate.action_match || "unknown",
    reviewer_id: String(payload.reviewer_id || candidate.laneId || "").trim() || null,
    focus_rubric:
      String(
        payload.reviewer_focus_rubric ||
          payload.target_rubric ||
          candidate.target_rubric ||
          "",
      ).trim() || null,
    standard:
      String(payload.reviewer_standard || payload.framework || "").trim() || null,
    verdict,
    summary: String(payload.summary || payload.rationale || "").trim() || null,
    rubric: normalizeRubricItems(payload.rubric),
    major_objections: keepResearchQualityReasons(payload.major_objections || payload.objections || []),
    same_family_alternatives: normalizeAlternativeInput(payload, "same_family_alternatives", "same_family_alternative"),
    cross_family_alternatives: normalizeAlternativeInput(
      payload,
      "cross_family_alternatives",
      "cross_family_alternative",
      { requireFamilyRoot: true },
    ),
    family_switch_recommendations: normalizeSwitchRecommendations(payload.family_switch_recommendations || []),
    switch_triggers: keepResearchQualityReasons(payload.switch_triggers || []),
    incumbent_rejection_reasons: keepResearchQualityReasons(payload.incumbent_rejection_reasons || []),
    better_alternative_hypotheses: [
      ...normalizeAlternativeItems(payload.cross_family_alternatives || [], { requireFamilyRoot: true }),
      ...normalizeAlternativeItems(payload.better_alternative_hypotheses || []),
      ...normalizeAlternativeItems(payload.same_family_alternatives || []),
    ],
    missing_validations: keepResearchQualityReasons(payload.missing_validations || []),
    required_response_from_lab_director: keepResearchQualityReasons(
      payload.required_response_from_lab_director || payload.challenge_questions || [],
    ),
    blocker_adjudications: normalizeBlockerAdjudications(
      payload.blocker_adjudications ||
        payload.gate_blocker_adjudications ||
        payload.lab_director_blocker_adjudications ||
        [],
    ),
    recommended_actions: Array.isArray(payload.recommended_actions) ? payload.recommended_actions : [],
    restart_recommended:
      payload.restart_recommended === true ||
      verdict === "reject" ||
      payload.rejection_reason != null,
    raw: payload,
  };
}

module.exports = {

  aggregateGatekeeperReviews,

  collectParsedGatekeeperReviews,

};
