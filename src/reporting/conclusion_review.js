"use strict";

const path = require("path");
const { appendReviewOnce } = require("../observability/cycle_logs");
const { ensureDir, writeJson } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");
const { compactGraph, compactHypotheses, compactValidationGaps } = require("../shared/context_compaction");
const {
  applyPromotionArtifactResolutions,
  promotionArtifactFollowupActions,
  readPromotionArtifacts,
} = require("./promotion_artifacts");
const { isReportingStandardRubric, reportingRubricApplies } = require("./reviews/gate/constants");
const { leadProtectionPrefix } = require("./reviews/gate/actions");
const hypothesisProgress = require("./hypothesis_progress");
const { recordReviewSnapshot } = require("./review_history");
const { selectedLeadIdentity, selectedLeadReviewIdentity, reviewMatchesSelectedLead } = require("../agents/shared/lead_evidence_match");

// The conclusion review is a THIRD path that asks the LabDirector to requery,
// independent of the gate review, and it did not know the ledger exists.
//
// MEASURED ON cycle-g-v75 (2026-08-06). The ledger denied a pivot at 07:39 and
// 07:40; at 07:42 this file created followup-lab-director-33 --
// `lab_director_requery_followup`, `source_brief_id: conclusion-review` -- whose
// description told the director to "narrow, split, replace, or demote the lead
// hypotheses" and whose first challenge question was "Which current lead
// hypothesis should be narrowed, split, replaced, or demoted?". No
// lead_supersession, no anti-churn text. This file referenced the ledger zero
// times.
//
// It does not recompute the decision -- that logic lives in the gate path and
// duplicating it would let the two diverge. It reads the last decision the gate
// recorded, which is the ledger's own single source of truth.
function ledgerLeadProtection(root, cycleId, fsImpl) {
  try {
    const trail = hypothesisProgress.readDecisionTrail(root, cycleId, fsImpl);
    for (let i = trail.length - 1; i >= 0; i -= 1) {
      const decision = trail[i]?.decision;
      if (!decision?.decision) continue;
      // A deny is not the only decision the director needs to hear. When the
      // ledger ALLOWS a pivot because the best lead has gone dormant, the answer
      // it computes is "go back to it, and say what it still needs" -- and
      // `leadProtectionPrefix` already writes exactly that paragraph. Returning
      // null for every allow threw it away before the prefix builder ever saw it,
      // so on cycle-g-v89 the instruction was computed 19 times and reached 0 of
      // the 19 most recent director prompts.
      if (decision.decision === "deny") return decision;
      if (decision.reason === "best_lead_dormant_resume_before_replacing") return decision;
      return null;
    }
  } catch {
    // A missing or unreadable ledger means nothing is protected yet.
  }
  return null;
}

// Drop the biomedical reporting-standard rubrics (CONSORT/STROBE) from a rubric
// list for any non-bio objective. Keeps a graphics/cs/generic conclusion from
// carrying an unsatisfiable observational-epidemiology reporting blocker that
// drags conclusion_score down and spawns perpetual STROBE reporting followups.
function dropInapplicableReportingRubrics(rubric, objective) {
  if (!Array.isArray(rubric)) return rubric;
  if (reportingRubricApplies(objective)) return rubric;
  return rubric.filter((item) => !isReportingStandardRubric(item?.name));
}

// Gate pass threshold. Lowered 95 -> 90 (owner decision 2026-07-05), then
// 90 -> 80 (owner decision 2026-07-15), mirroring approval_review.js: the pass
// bar is "clearly good, defensible work"; the all-rubric conjunction, zero-blocker
// requirement, and fail-closed soundness scoring are unchanged.
const { GATE_THRESHOLD } = require("../policy/research_gate");
// After a rubric has driven this many conclusion-review followup rounds without
// crossing the gate threshold, stop regenerating its followup. A below-threshold
// dimension that will not improve (e.g. a genuinely non-novel finding whose
// novelty score is capped, or "clarity: clearer figures still needed" that the
// reviewer perpetually re-raises) otherwise spawns the same analyst/runner/
// illustrator followups every pass forever — the lane balloon that keeps the
// cycle from ever reaching author/conclusion. Saturating the blocker lets the
// cycle conclude honestly (gate not passed, here is why) instead of livelocking.
const RUBRIC_FOLLOWUP_ATTEMPT_CAP = 3;
const RELAXED_ADVANCE_RUBRICS = new Set([
  "impact",
  "clarity",
  "strobe_reporting_completeness",
  "consort_reporting_completeness",
]);

function appendJsonl(fs, filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

// The gatekeeper (the independent critical reviewer) is the source of truth for
// per-dimension scientific quality. Read its aggregate rubric so the conclusion
// review can be bounded by it.
function gatekeeperRubricScoreMap({ root, cycleId, fs }) {
  try {
    const gatePath = path.join(root, "state", `${cycleId}-gate-review.json`);
    if (!fs.existsSync(gatePath)) return null;
    const gate = JSON.parse(fs.readFileSync(gatePath, "utf8"));
    if (!reviewMatchesSelectedLead(gate, selectedLeadIdentity(root, cycleId))) return null;
    // Only cap by the gatekeeper's rubric when the gatekeeper has ACTUALLY
    // reviewed. Before it runs, the gate-review rubric is a placeholder default
    // (0s or 100s with no reasons) — capping by those either zeroed the whole
    // conclusion (default 0 -> conclusion_score 0) or did nothing (default 100).
    // The cap must reflect a real critical review, not a placeholder.
    //
    // Detect real reviews via `gatekeeper_review_status` (parsed | partial), NOT
    // a `gate.reviews` array — the gate build stores the ingested reviews under
    // other fields (gatekeeper_reviews_normalized/…) and leaves top-level
    // `reviews` undefined, so the old `reviews.length===0` guard NEVER capped even
    // once a gatekeeper had honestly scored (e.g. novelty=22 REJECT), letting the
    // conclusion stay at its floored placeholder (novelty 100, gate "passed") and
    // silently suppressing the honest low novelty → the gate never triggered a
    // pivot. Now: cap as soon as the status shows a real (even partial) review,
    // and only by rubric dimensions a gatekeeper actually scored (skip
    // focused_review_missing placeholders so an un-reviewed dimension is not
    // pinned to its optimistic default).
    const status = String(gate?.gatekeeper_review_status || "").toLowerCase();
    const reviews = Array.isArray(gate?.reviews) ? gate.reviews : [];
    const hasRealReview =
      status === "parsed" || status === "partial" || reviews.length > 0;
    if (!hasRealReview) return null;
    const rubric = Array.isArray(gate?.rubric) ? gate.rubric : [];
    const map = {};
    for (const item of rubric) {
      if (item?.focused_review_missing === true) continue;
      const name = String(item?.name || "").trim();
      const score = Number(item?.score);
      if (name && Number.isFinite(score)) map[name] = score;
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

// Bound each conclusion-rubric dimension by the gatekeeper's critical score. The
// conclusion review must never claim a dimension is stronger than the
// independent gate review found it — this is what let the conclusion display
// novelty 100 / "approval-ready" while the gatekeeper honestly scored novelty 34
// (a textbook adaptive-sampling finding). Capping keeps the surfaced novelty
// honest and makes conclusion_score reflect the real critical assessment.
function capConclusionRubricByGatekeeper(rubric, gatekeeperScores) {
  if (!gatekeeperScores || !Array.isArray(rubric)) return rubric;
  return rubric.map((item) => {
    const name = String(item?.name || "").trim();
    const gate = gatekeeperScores[name];
    const current = Number(item?.score || 0);
    if (!Number.isFinite(gate) || gate >= current) return item;
    return {
      ...item,
      score: gate,
      reasons: Array.from(
        new Set([
          ...(Array.isArray(item?.reasons) ? item.reasons : []),
          `Bounded by the gatekeeper's critical ${name || "rubric"} score (${gate}); the conclusion cannot exceed the independent gate review.`,
        ]),
      ),
      bounded_by_gatekeeper: true,
    };
  });
}

function canAdvanceWithHighScoreNudge(review) {
  const payload = review?.review || review || {};
  const score = Number(payload?.conclusion_score ?? payload?.approval_readiness_score ?? 0);
  const rubric = Array.isArray(payload?.conclusion_rubric)
    ? payload.conclusion_rubric
    : Array.isArray(payload?.approval_rubric)
      ? payload.approval_rubric
      : [];
  // A design-ceiling rubric has already driven the maximum followup rounds
  // without improving, and a relaxed-advance rubric is soft by policy — neither
  // should BLOCK advancement to the independent gatekeeper. Advance when the
  // ONLY sub-threshold rubrics left are saturated (design ceiling) or relaxed.
  //
  // We deliberately do NOT gate on the raw average conclusion_score: honest,
  // capped, saturated rubrics (e.g. reproducibility 52 for a textbook finding)
  // hold the average below 95 FOREVER. The old `score < GATE_THRESHOLD` early
  // return then permanently blocked the gatekeeper (conclusion stuck at ~81,
  // gatekeeper reviews=0, lanes ballooned into the hundreds). Once the cycle has
  // exhausted improving every problem rubric, the correct move is to reach the
  // gatekeeper for its final verdict — not to loop forever chasing 95.
  const designCeiling = new Set(
    Array.isArray(payload?.design_ceiling_rubrics) ? payload.design_ceiling_rubrics : [],
  );
  const blockingWeak = rubric.filter(
    (item) =>
      item?.applicable !== false &&
      Number(item?.score || 0) < GATE_THRESHOLD &&
      // MEASURED ON cycle-a-20260919, 2026-10-02: an independent
      // gate score of 52 capped the next conclusion to 50. Treating those
      // already-reviewed dimensions as pre-gate weaknesses deferred the gate,
      // made it copy the conclusion rubric, and alternated 52 -> 50 -> 52.
      item?.bounded_by_gatekeeper !== true &&
      !designCeiling.has(String(item?.name || "")) &&
      !RELAXED_ADVANCE_RUBRICS.has(String(item?.name || "")),
  );
  return blockingWeak.length === 0;
}

// Track, across passes, how many times each below-threshold rubric has driven a
// followup. Returns the set of rubric names that have hit the attempt cap and
// should no longer spawn followups (design ceiling reached).
function updateRubricFollowupAttempts({ root, cycleId, fs, rubric }) {
  const attemptsPath = path.join(root, "state", `${cycleId}-rubric-followup-attempts.json`);
  let attempts = {};
  try {
    if (fs.existsSync(attemptsPath)) attempts = JSON.parse(fs.readFileSync(attemptsPath, "utf8")) || {};
  } catch {
    attempts = {};
  }
  const saturated = new Set();
  for (const item of Array.isArray(rubric) ? rubric : []) {
    if (item?.applicable === false) continue;
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const score = Number(item?.score || 0);
    if (score >= GATE_THRESHOLD) {
      delete attempts[name]; // resolved — reset so a future regression can retry
      continue;
    }
    const prev = attempts[name] || { count: 0, best_score: -1 };
    const count = Number(prev.count || 0) + 1;
    attempts[name] = { count, best_score: Math.max(Number(prev.best_score ?? -1), score) };
    if (count > RUBRIC_FOLLOWUP_ATTEMPT_CAP) saturated.add(name);
  }
  try {
    writeJson(attemptsPath, attempts);
  } catch {
    // best-effort; a missing counter just means one extra retry, not a loop
  }
  return saturated;
}

function rubricFollowupActions(rubric, saturatedRubrics = new Set()) {
  const actions = [];

  for (const item of rubric) {
    if (item?.applicable === false) continue;
    const name = String(item?.name || "").trim();
    // Design ceiling reached for this rubric — stop regenerating its followup so
    // the cycle can conclude instead of looping on an unimprovable blocker.
    if (saturatedRubrics.has(name)) continue;
    const score = Number(item.score || 0);
    if (score >= GATE_THRESHOLD) continue;
    const priority = score < 85 ? "high" : "medium";

    if (item.name === "novelty") {
      actions.push({
        type: "novelty_followup",
        priority,
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "infer the state of the art from the retrieved paper set and the knowledge graph, then challenge the current hypothesis family with more original moderators, thresholds, partitions, or rival mechanisms",
      });
    }
    if (item.name === "technical_quality") {
      actions.push({
        type: "methods_followup",
        priority,
        preferred_role: "lab-runner",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "run robustness, confound-control, and sensitivity analyses to strengthen methodological adequacy",
      });
      actions.push({
        type: "data_acquisition_followup",
        priority,
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "search for additional open datasets that can test rival explanations, add missing confounders, or validate the current hypotheses under stronger measurement coverage",
      });
    }
    if (item.name === "reproducibility") {
      actions.push({
        type: "accuracy_followup",
        priority,
        preferred_role: "lab-runner",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "repeat analysis with stricter validation checks, data sanity checks, and error-focused review",
      });
      actions.push({
        type: "data_acquisition_followup",
        priority,
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "discover and add open-source datasets that can cross-check the current signal, improve coverage, or supply missing variables for stricter validation",
      });
      actions.push({
        type: "logic_trace_followup",
        priority,
        preferred_role: "chronicle",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "strengthen reproducibility by making each major claim explicitly traceable to source lanes, data transforms, and validation outputs",
      });
    }
    if (item.name === "clarity") {
      actions.push({
        type: "logic_followup",
        priority,
        preferred_role: "author",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "rewrite the conclusion so the core claims, support, limitations, and takeaways are easier to follow",
      });
      actions.push({
        type: "visualization_followup",
        priority,
        preferred_role: "illustrator",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "improve figures and visual summaries so the main result and caveats are understandable quickly",
      });
    }
    if (item.name === "impact") {
      actions.push({
        type: "impact_followup",
        priority,
        preferred_role: "analyst",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "identify higher-impact interpretations, stronger effect partitions, or more decision-relevant outcomes",
      });
    }
    if (item.name === "consort_reporting_completeness" || item.name === "strobe_reporting_completeness") {
      actions.push({
        type: "reporting_followup",
        priority,
        preferred_role: "author",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          item.name === "consort_reporting_completeness"
            ? "fill in missing randomized-trial reporting elements so the study is transparent under CONSORT"
            : "fill in missing observational-study reporting elements so the study is transparent under STROBE",
      });
      actions.push({
        type: "logic_trace_followup",
        priority,
        preferred_role: "chronicle",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: score,
        blocker_reasons: item.reasons || [],
        description:
          "build an explicit checklist-style evidence trace for the missing reporting fields so the next report revision is auditable",
      });
    }
  }

  return actions;
}

// A score the gatekeeper has capped cannot be raised by rewriting the
// hypotheses. `capConclusionRubricByGatekeeper` stamps `bounded_by_gatekeeper`
// on exactly those dimensions: their number is an independent review's number,
// and it moves only when new evidence is produced for that dimension.
//
// MEASURED ON cycle-g-v89. Reproducibility was capped at the gatekeeper's 25 and
// had passed the followup attempt cap, so `rubricFollowupActions` had stopped
// emitting its lab-runner and scout followups -- the evidence path had switched
// itself off. `hypothesisRegenerationActions` has no such cap, so the ONLY
// surviving action was `lab_director_requery_followup`: 149 of 160 director
// lanes, an attempt counter at 140, and 244 replacement hypotheses, none of
// which could move a bound number by one point.
//
// Saturation is a reason to stop repeating a request, not a reason to hand the
// work to someone who cannot do it. When every sub-threshold dimension is bound,
// the recipient is the experiment.
function boundEvidenceDeficit(rubric) {
  const applicable = (Array.isArray(rubric) ? rubric : []).filter(
    (item) => item?.applicable !== false,
  );
  const subThreshold = applicable.filter((item) => Number(item?.score || 0) < GATE_THRESHOLD);
  if (subThreshold.length === 0) return null;
  const bound = subThreshold.filter((item) => item?.bounded_by_gatekeeper === true);
  if (bound.length === 0 || bound.length !== subThreshold.length) return null;
  return bound;
}

function boundEvidenceActions(rubric) {
  const bound = boundEvidenceDeficit(rubric);
  if (!bound) return [];
  const dimensions = bound.map((item) => String(item?.name || "").trim()).filter(Boolean);
  const reasons = Array.from(
    new Set(bound.flatMap((item) => (Array.isArray(item?.reasons) ? item.reasons : []))),
  );
  const lowest = bound.reduce(
    (worst, item) => (Number(item?.score || 0) < Number(worst?.score || 0) ? item : worst),
    bound[0],
  );
  return [
    {
      type: "accuracy_followup",
      priority: "high",
      preferred_role: "lab-runner",
      target_rubric: String(lowest?.name || "").trim(),
      target_score: GATE_THRESHOLD,
      current_score: Number(lowest?.score || 0),
      blocker_reasons: reasons,
      bounded_dimensions: dimensions,
      description:
        `every remaining sub-threshold dimension (${dimensions.join(", ")}) is capped by the independent gate review, ` +
        "so no rewriting of the hypotheses can raise it: run the measurement that the lowest-scoring dimension is missing " +
        "— repeat the analysis under stricter validation, report the run-to-run spread, and record the exact command, " +
        "inputs, and environment needed to repeat it — and report the number it produces, whichever way it comes out",
    },
  ];
}

function hypothesisRegenerationActions({ summary, score, blockers, leadProtection = null, rubric = [] }) {
  // The director owns hypotheses. It does not own a number an independent review
  // has capped, and asking it to regenerate against one produced 244 hypotheses
  // and no movement. Route that deficit to the experiment instead.
  if (boundEvidenceDeficit(rubric)) return [];
  const claimCount = Number(summary?.claim_count || 0);
  const hypothesisQuality = Number(summary?.hypothesis_quality_score || 0);
  const derivableCandidates = Array.isArray(summary?.derivable_hypothesis_candidates)
    ? summary.derivable_hypothesis_candidates
    : [];
  const schemaQuality = summary?.schema_quality || {};
  const reasoningGraph = summary?.reasoning_graph || {};
  const openValidationGaps = Array.isArray(summary?.open_validation_gaps)
    ? summary.open_validation_gaps
    : [];
  const blockerText = (blockers || []).join(" ").toLowerCase();
  const needsRegeneration =
    claimCount < 2 ||
    score == null ||
    score < 70 ||
    hypothesisQuality < 75 ||
    derivableCandidates.length < 3 ||
    Number(schemaQuality.falsification_test_count || 0) < Math.max(3, claimCount) ||
    Number(reasoningGraph.claim_count || 0) < Math.max(2, claimCount) ||
    Number(reasoningGraph.unresolved_gap_count || 0) > Math.max(4, claimCount) ||
    blockerText.includes("too few concrete findings") ||
    blockerText.includes("validated findings are limited") ||
    blockerText.includes("too few high-confidence promoted hypotheses") ||
    blockerText.includes("need a broader set of non-trivial hypotheses") ||
    blockerText.includes("alternative hypothesis families are still too limited") ||
    blockerText.includes("moderator or partition originality is still weak");

  if (!needsRegeneration) return [];

  return [
    {
      type: "lab_director_requery_followup",
      priority: "high",
      preferred_role: "lab-director",
      target_rubric: "hypothesis_strategy",
      target_score: GATE_THRESHOLD,
      current_score: score ?? 0,
      blocker_reasons: blockers || [],
      candidate_count: derivableCandidates.length,
      candidate_hypotheses: compactHypotheses(derivableCandidates, 5),
      schema_quality: schemaQuality,
      reasoning_graph: compactGraph(reasoningGraph),
      open_validation_gaps: compactValidationGaps(openValidationGaps, 5),
      expected_artifacts: [
        "hypothesis_validation_upgrade_plan.json",
        "hypothesis_revision_decision_log.json",
        "next_validation_lane_assignments.json",
      ],
      // Under a ledger deny the questions must not invite the one move the
      // ledger just refused. "Replace or demote the lead" and "keep refining
      // this lead" cannot both be the instruction.
      challenge_questions: leadProtection
        ? [
            "How should THIS protected lead be narrowed or split — without replacing or demoting it?",
            "What independent, subgroup, orthogonal, sensitivity, or rival-mechanism validation would most reduce the strongest blocker ON THIS LEAD?",
            "Which concrete scout, analyst, or lab-runner lane should be assigned next to strengthen it?",
          ]
        : [
            "Which current lead hypothesis should be narrowed, split, replaced, or demoted?",
            "What independent, subgroup, orthogonal, sensitivity, or rival-mechanism validation would most reduce the strongest blocker?",
            "Which concrete scout, analyst, or lab-runner lane should be assigned next if the current evidence is not enough?",
          ],
      lead_supersession: leadProtection,
      description:
        (leadProtection ? leadProtectionPrefix(leadProtection) : "") +
        (leadProtection
          ? "do not stop at a weak conclusion: review the conclusion blockers, reasoning graph, data graph, and validation gaps; then NARROW or SPLIT the protected lead and assign the next concrete validation lanes needed to reach the gate threshold. Replacing or demoting it is not available this round."
          : "do not stop at a weak conclusion: review the conclusion blockers, reasoning graph, data graph, and validation gaps; then narrow, split, replace, or demote the lead hypotheses and assign the next concrete validation lanes needed to reach the gate threshold"),
    },
    {
      type: "hypothesis_regeneration_followup",
      priority: "high",
      preferred_role: "scout",
      target_rubric: "novelty",
      target_score: GATE_THRESHOLD,
      current_score: score ?? 0,
      blocker_reasons: blockers || [],
      candidate_count: derivableCandidates.length,
      candidate_hypotheses: compactHypotheses(derivableCandidates, 5),
      reasoning_graph: compactGraph(reasoningGraph),
      open_validation_gaps: compactValidationGaps(openValidationGaps, 5),
      description:
        "infer the state of the art from the retrieved papers and reasoning graph, then generate fresh literature-backed hypothesis families that are more impactful and more directly testable than the current weak conclusion set",
    },
    {
      type: "hypothesis_regeneration_synthesis_followup",
      priority: "high",
      preferred_role: "analyst",
      target_rubric: "impact",
      target_score: GATE_THRESHOLD,
      current_score: score ?? 0,
      blocker_reasons: blockers || [],
      schema_quality: schemaQuality,
      reasoning_graph: compactGraph(reasoningGraph),
      open_validation_gaps: compactValidationGaps(openValidationGaps, 5),
      candidate_hypotheses: compactHypotheses(derivableCandidates, 5),
      description:
        "synthesize newly generated hypothesis families, discard weak ones, and nominate replacement top hypotheses for the next validation pass",
    },
  ];
}

function averageApplicableRubricScore(rubric) {
  const applicable = Array.isArray(rubric)
    ? rubric.filter((item) => item?.applicable !== false && Number.isFinite(Number(item?.score)))
    : [];
  if (applicable.length === 0) return null;
  return Math.round(applicable.reduce((sum, item) => sum + Number(item.score), 0) / applicable.length);
}

function buildConclusionReview({ cwd = process.cwd(), cycleId, researcherView, fs = require("fs") }) {
  const root = runtimeRoot(cwd);
  const summary = researcherView?.summary || researcherView || {};
  const evidenceReadiness = summary.evidence_readiness || { ready: true, reasons: [] };
  const rawScore =
    summary.conclusion_readiness_score == null && summary.approval_readiness_score == null
      ? null
      : Number(summary.conclusion_readiness_score ?? summary.approval_readiness_score ?? 0);
  const rawBlockers = Array.isArray(summary.conclusion_blockers)
    ? summary.conclusion_blockers
    : Array.isArray(summary.approval_blockers)
      ? summary.approval_blockers
      : [];
  const rawRubric = dropInapplicableReportingRubrics(
    Array.isArray(summary.conclusion_rubric)
      ? summary.conclusion_rubric
      : Array.isArray(summary.approval_rubric)
        ? summary.approval_rubric
        : [],
    summary.objective,
  );
  const promotionArtifacts = readPromotionArtifacts({ root, cycleId });
  const artifactAdjusted = applyPromotionArtifactResolutions({
    rubric: rawRubric,
    blockers: rawBlockers,
    promotionArtifacts,
  });
  const gatekeeperScores = gatekeeperRubricScoreMap({ root, cycleId, fs });
  const rubric = capConclusionRubricByGatekeeper(artifactAdjusted.rubric, gatekeeperScores);
  const blockers = artifactAdjusted.blockers;
  const adjustedScore = averageApplicableRubricScore(rubric);
  const score = adjustedScore == null ? rawScore : adjustedScore;
  const gatedBlockers = rubric
    .filter((item) => Number(item.score || 0) < GATE_THRESHOLD)
    .flatMap((item) => item.reasons || [])
    .filter(Boolean);
  const reviewPath = path.join(root, "state", `${cycleId}-conclusion-review.json`);
  const legacyPath = path.join(root, "state", `${cycleId}-approval-review.json`);

  if (!evidenceReadiness.ready) {
    const review = {
      ts: new Date().toISOString(),
      cycle_id: cycleId,
      type: "conclusion_review",
      mode: "wait",
      exploratory_score: null,
      conclusion_score: null,
      conclusion_band: "pending-evidence",
      conclusion_blockers: blockers,
      conclusion_rubric: [],
      evidence_readiness: evidenceReadiness,
      all_rubrics_approved: false,
      exploratory_gate_passed: false,
      conclusion_gate_passed: false,
      recommended_followup_actions: [],
      researcher_view_path: researcherView.jsonPath,
      report_path: summary.source_paths?.report || null,
      objective: summary.objective || null,
    };

    // Append the trajectory before the value is overwritten. The file
  // below is rewritten on every refresh, so without this the only
  // record of a previous score is whatever has not been replaced yet.
  recordReviewSnapshot({ root, cycleId, kind: "conclusion-review", review });
  review.current_hypothesis_identity = selectedLeadReviewIdentity(root, cycleId, summary);
  writeJson(reviewPath, review);
    writeJson(legacyPath, {
      ...review,
      type: "approval_review",
      approval_readiness_score: null,
      approval_readiness_band: "pending-evidence",
      approval_blockers: blockers,
      approval_rubric: [],
      approval_gate_passed: false,
    });
    appendReviewOnce({ root, cycleId, slot: "conclusion_review:waiting", review, dialogueEventType: "labdirector_conclusion_review", fsImpl: fs });

    return { reviewPath, review };
  }

  const allRubricsApproved =
    rubric.filter((item) => item?.applicable !== false).length > 0 &&
    rubric.filter((item) => item?.applicable !== false).every((item) => Number(item.score || 0) >= GATE_THRESHOLD);
  const conclusionGatePassed = score >= GATE_THRESHOLD && gatedBlockers.length === 0;
  const mode = conclusionGatePassed ? "hold" : score >= GATE_THRESHOLD - 5 ? "nudge" : "refine";
  const saturatedRubrics = updateRubricFollowupAttempts({ root, cycleId, fs, rubric });
  const followupActions = [
    ...rubricFollowupActions(rubric, saturatedRubrics),
    ...boundEvidenceActions(rubric),
    ...hypothesisRegenerationActions({
      summary,
      score,
      blockers: gatedBlockers,
      leadProtection: ledgerLeadProtection(root, cycleId, fs),
      rubric,
    }),
    ...promotionArtifactFollowupActions({
      promotionArtifacts,
      score,
      blockers: gatedBlockers.length > 0 ? gatedBlockers : blockers,
    }),
  ];

  const review = {
    ts: new Date().toISOString(),
    cycle_id: cycleId,
    type: "conclusion_review",
    mode,
    exploratory_score: score,
    conclusion_score: score,
      conclusion_band: summary.conclusion_readiness_band || summary.approval_readiness_band || "unknown",
    conclusion_blockers: gatedBlockers,
    conclusion_rubric: rubric,
    promotion_artifact_resolution: artifactAdjusted.promotion_artifact_resolution,
    raw_conclusion_score: rawScore,
    raw_conclusion_blockers: rawBlockers,
    raw_conclusion_rubric: rawRubric,
    all_rubrics_approved: allRubricsApproved,
    exploratory_gate_passed: conclusionGatePassed,
    conclusion_gate_passed: conclusionGatePassed,
    design_ceiling_rubrics: Array.from(saturatedRubrics),
    recommended_followup_actions: followupActions,
    researcher_view_path: researcherView.jsonPath,
    report_path: summary.source_paths?.report || null,
    objective: summary.objective || null,
  };

  // Append the trajectory before the value is overwritten. The file
  // below is rewritten on every refresh, so without this the only
  // record of a previous score is whatever has not been replaced yet.
  recordReviewSnapshot({ root, cycleId, kind: "conclusion-review", review });
  review.current_hypothesis_identity = selectedLeadReviewIdentity(root, cycleId, summary);
  writeJson(reviewPath, review);
  writeJson(legacyPath, {
    ...review,
    type: "approval_review",
    approval_readiness_score: score,
    approval_readiness_band: summary.conclusion_readiness_band || summary.approval_readiness_band || "unknown",
    approval_blockers: gatedBlockers,
    approval_rubric: rubric,
    approval_gate_passed: conclusionGatePassed,
  });
  appendReviewOnce({ root, cycleId, slot: "conclusion_review", review, dialogueEventType: "labdirector_conclusion_review", fsImpl: fs });

  return { reviewPath, review };
}

module.exports = {
  boundEvidenceActions,
  ledgerLeadProtection,
  hypothesisRegenerationActions,
  buildConclusionReview,
  canAdvanceWithHighScoreNudge,
};
