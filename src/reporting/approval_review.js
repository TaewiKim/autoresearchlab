"use strict";

const fs = require("fs");
const path = require("path");
const { appendReviewOnce } = require("../observability/cycle_logs");
const { ensureDir, writeJson } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");
const {
  attachUnifiedReviewFields,
  readJsonIfExists,
} = require("./final_claim_package");
const {
  applyPromotionArtifactResolutions,
  promotionArtifactFollowupActions,
  readPromotionArtifacts,
} = require("./promotion_artifacts");
const { isReportingStandardRubric, reportingRubricApplies } = require("./reviews/gate/constants");
const { recordReviewSnapshot } = require("./review_history");
const { selectedLeadReviewIdentity } = require("../agents/shared/lead_evidence_match");

// Drop the biomedical reporting-standard rubrics (CONSORT/STROBE) for a non-bio
// objective so a graphics/cs/generic approval review is not blocked by, and does
// not emit followups for, an observational-epidemiology reporting standard that
// the study can never satisfy. Mirrors the same filter in conclusion_review.js.
function dropInapplicableReportingRubrics(rubric, objective) {
  if (!Array.isArray(rubric)) return rubric;
  if (reportingRubricApplies(objective)) return rubric;
  return rubric.filter((item) => !isReportingStandardRubric(item?.name));
}

// Gate pass threshold. Lowered 95 -> 90 (owner decision 2026-07-05), then
// 90 -> 80 (owner decision 2026-07-15): with the anti-churn stack finally letting
// leads accumulate honest evidence (v60 bestTech 74, v61 novelty 58 + tech 38),
// the owner set the pass bar to "clearly good, defensible work" rather than
// near-publication polish. Still a CONJUNCTION over every applicable rubric with
// zero blockers, and soundness scoring stays fail-closed — only the bar moved.
const { GATE_THRESHOLD } = require("../policy/research_gate");

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function compactText(value, maxChars = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
}

function unwrapReview(value) {
  if (!value) return null;
  return value.review && typeof value.review === "object" ? value.review : value;
}

function finiteScore(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function averageApplicableRubricScore(rubric) {
  const applicable = Array.isArray(rubric)
    ? rubric.filter((item) => item?.applicable !== false && Number.isFinite(Number(item?.score)))
    : [];
  if (applicable.length === 0) return null;
  return Math.round(applicable.reduce((sum, item) => sum + Number(item.score), 0) / applicable.length);
}

function scoreBand(score) {
  if (score == null) return "pending-evidence";
  if (score >= GATE_THRESHOLD) return "ready";
  if (score >= GATE_THRESHOLD - 5) return "nearly-ready";
  if (score >= 70) return "needs-refinement";
  return "blocked";
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function rubricFollowupActions(rubric) {
  const actions = [];

  for (const item of rubric) {
    if (item?.applicable === false) continue;
    if (Number(item.score || 0) >= 70) continue;

    if (item.name === "novelty") {
      actions.push({
        type: "novelty_followup",
        priority: "high",
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "infer the state of the art from retrieved papers and the knowledge graph, then search for more original hypothesis families, moderators, thresholds, or rival explanations that materially raise the study novelty",
      });
    }
    if (item.name === "technical_quality") {
      actions.push({
        type: "methods_followup",
        priority: "high",
        preferred_role: "lab-runner",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "run robustness, confound-control, and sensitivity analyses to strengthen methodological adequacy",
      });
      actions.push({
        type: "data_acquisition_followup",
        priority: "high",
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "discover additional open datasets that can add confounders, alternate outcomes, or stronger validation coverage for the current hypotheses",
      });
    }
    if (item.name === "reproducibility") {
      actions.push({
        type: "accuracy_followup",
        priority: "high",
        preferred_role: "lab-runner",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "repeat analysis with stricter validation checks, data sanity checks, and error-focused review",
      });
      actions.push({
        type: "data_acquisition_followup",
        priority: "high",
        preferred_role: "scout",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "search for open-source datasets that can independently cross-check or extend the current validation set",
      });
      actions.push({
        type: "logic_trace_followup",
        priority: "high",
        preferred_role: "chronicle",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "make the evidence lineage, data transforms, and claim support trace explicit enough for reproduction",
      });
    }
    if (item.name === "clarity") {
      actions.push({
        type: "logic_followup",
        priority: "high",
        preferred_role: "author",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "rewrite the study narrative so claims, support, caveats, and takeaways are easier to follow",
      });
    }
    if (item.name === "impact") {
      actions.push({
        type: "impact_followup",
        priority: "medium",
        preferred_role: "analyst",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description: "identify higher-impact interpretations, stronger effect partitions, or more decision-relevant outcomes",
      });
    }
    if (item.name === "consort_reporting_completeness" || item.name === "strobe_reporting_completeness") {
      actions.push({
        type: "reporting_followup",
        priority: "medium",
        preferred_role: "author",
        target_rubric: item.name,
        target_score: GATE_THRESHOLD,
        current_score: Number(item.score || 0),
        blocker_reasons: item.reasons || [],
        description:
          item.name === "consort_reporting_completeness"
            ? "fill in missing CONSORT reporting elements for the current trial-style study"
            : "fill in missing STROBE reporting elements for the current observational study",
      });
    }
  }

  return actions;
}

function reviewActions(review) {
  if (Array.isArray(review?.recommended_actions)) return review.recommended_actions;
  if (Array.isArray(review?.recommended_followup_actions)) return review.recommended_followup_actions;
  return [];
}

function dedupeActions(actions) {
  const seen = new Set();
  return (actions || []).filter((item) => {
    if (!item || typeof item !== "object") return false;
    const key = [
      item.type || "",
      item.preferred_role || "",
      item.target_rubric || "",
      item.description || "",
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function blockersFrom(review, primaryKey, fallbackKey = "blockers") {
  return uniqueStrings(
    (Array.isArray(review?.[primaryKey]) ? review[primaryKey] : [])
      .concat(fallbackKey && Array.isArray(review?.[fallbackKey]) ? review[fallbackKey] : [])
      .concat(Array.isArray(review?.pending_rubric_blockers) ? review.pending_rubric_blockers : []),
  ).map((item) => compactText(item));
}

function makeStageGate({
  name,
  label,
  order,
  score = null,
  passed = false,
  status = null,
  blockers = [],
  recommendedActions = [],
  source = null,
  prerequisite = null,
}) {
  const finalStatus = status || (passed ? "passed" : "blocked");
  return {
    name,
    label,
    order,
    status: finalStatus,
    passed: finalStatus === "passed",
    evaluated: finalStatus !== "pending",
    score,
    source,
    prerequisite,
    blockers: uniqueStrings(blockers).slice(0, 12),
    recommended_actions: Array.isArray(recommendedActions) ? recommendedActions.slice(0, 12) : [],
  };
}

function buildApprovalStageGates({
  rawScore,
  rawBlockers,
  evidenceReadiness,
  conclusion,
  gate,
  report,
  paper,
}) {
  const evidenceReady = evidenceReadiness?.ready === true;
  const evidenceStage = makeStageGate({
    name: "evidence",
    label: "Evidence readiness",
    order: 1,
    score: evidenceReady ? 100 : 0,
    passed: evidenceReady,
    blockers: evidenceReady ? [] : (Array.isArray(evidenceReadiness?.reasons) ? evidenceReadiness.reasons : ["core evidence lanes are not complete enough for approval review"]),
    source: "researcher_view",
  });

  const conclusionScore = finiteScore(conclusion?.score, conclusion?.conclusion_score, conclusion?.exploratory_score);
  const conclusionPresent = Boolean(conclusion);
  const conclusionPassed = conclusion?.conclusion_gate_passed === true || conclusion?.exploratory_gate_passed === true;
  const conclusionStage = !evidenceReady
    ? makeStageGate({
        name: "conclusion",
        label: "Conclusion gate",
        order: 2,
        status: "pending",
        source: "conclusion_review",
        prerequisite: "evidence",
      })
    : makeStageGate({
        name: "conclusion",
        label: "Conclusion gate",
        order: 2,
        score: conclusionScore ?? 0,
        passed: conclusionPresent && conclusionPassed,
        blockers: conclusionPresent
          ? blockersFrom(conclusion, "conclusion_blockers")
          : ["conclusion review has not run"],
        recommendedActions: reviewActions(conclusion),
        source: "conclusion_review",
        prerequisite: "evidence",
      });

  const gateScore = finiteScore(gate?.score);
  const gatePresent = Boolean(gate);
  const gatePassed = gate?.gate_passed === true;
  const hypothesisStage = gatePresent
    ? makeStageGate({
        name: "hypothesis",
        label: "Independent hypothesis gate",
        order: 3,
        score: gateScore ?? 0,
        passed: gatePassed,
        blockers: blockersFrom(gate, "blockers")
          .concat(blockersFrom(gate, "gate_scientific_blockers", null))
          .concat(blockersFrom(gate, "major_objections", null)),
        recommendedActions: reviewActions(gate),
        source: "gate_review",
        prerequisite: "conclusion",
      })
    : conclusionStage.passed
      ? makeStageGate({
          name: "hypothesis",
          label: "Independent hypothesis gate",
          order: 3,
          score: 0,
          passed: false,
          blockers: ["independent hypothesis gate review has not run"],
          source: "gate_review",
          prerequisite: "conclusion",
        })
      : makeStageGate({
          name: "hypothesis",
          label: "Independent hypothesis gate",
          order: 3,
          status: "pending",
          source: "gate_review",
          prerequisite: "conclusion",
        });

  const reportScore = finiteScore(report?.score, report?.report_score);
  const reportPassed = report?.communication_gate_passed === true || report?.report_gate_passed === true;
  const reportStage = hypothesisStage.passed
    ? makeStageGate({
        name: "report",
        label: "Researcher communication gate",
        order: 4,
        score: reportScore ?? 0,
        passed: Boolean(report) && reportPassed,
        blockers: report ? blockersFrom(report, "report_blockers") : ["research report review has not run"],
        recommendedActions: reviewActions(report),
        source: "report_review",
        prerequisite: "hypothesis",
      })
    : makeStageGate({
        name: "report",
        label: "Researcher communication gate",
        order: 4,
        status: "pending",
        source: "report_review",
        prerequisite: "hypothesis",
      });

  const paperScore = finiteScore(paper?.score, paper?.paper_score);
  const paperPassed = paper?.submission_gate_passed === true || paper?.paper_gate_passed === true;
  const paperStage = hypothesisStage.passed
    ? makeStageGate({
        name: "paper",
        label: "Manuscript submission gate",
        order: 5,
        score: paperScore ?? 0,
        passed: Boolean(paper) && paperPassed,
        blockers: paper ? blockersFrom(paper, "paper_blockers") : ["manuscript review has not run"],
        recommendedActions: reviewActions(paper),
        source: "paper_review",
        prerequisite: "hypothesis",
      })
    : makeStageGate({
        name: "paper",
        label: "Manuscript submission gate",
        order: 5,
        status: "pending",
        source: "paper_review",
        prerequisite: "hypothesis",
      });

  const stages = [evidenceStage, conclusionStage, hypothesisStage, reportStage, paperStage];
  const evaluatedScores = stages
    .filter((stage) => stage.evaluated && stage.score != null)
    .map((stage) => Number(stage.score));
  const scoreInputs = [rawScore, ...evaluatedScores].filter((value) => value != null && Number.isFinite(Number(value)));
  const score = scoreInputs.length > 0 ? Math.round(Math.min(...scoreInputs)) : null;
  const failedStages = stages.filter((stage) => stage.evaluated && !stage.passed);
  const scoreLimitingStage = stages
    .filter((stage) => stage.evaluated && stage.score != null)
    .sort((a, b) => Number(a.score) - Number(b.score))[0] || null;
  const blockers = uniqueStrings(
    failedStages.flatMap((stage) =>
      stage.blockers.length > 0
        ? stage.blockers.map((blocker) => `${stage.label}: ${blocker}`)
        : [`${stage.label}: gate did not pass`],
    ).concat(rawBlockers || []),
  ).slice(0, 24);
  const recommendedActions = dedupeActions(
    failedStages.flatMap((stage) => stage.recommended_actions || []),
  );
  const allStageGatesPassed = stages.every((stage) => stage.passed);

  return {
    score,
    band: scoreBand(score),
    stages,
    failedStages,
    scoreLimitingStage,
    blockers,
    recommendedActions,
    allStageGatesPassed,
    decisionMode: allStageGatesPassed ? "approved" : score == null ? "wait" : score >= GATE_THRESHOLD - 5 ? "refine" : "refine",
    decisionReason: allStageGatesPassed
      ? "all staged approval gates passed"
      : blockers[0] || `${scoreLimitingStage?.label || "approval"} gate blockers remain`,
  };
}

// Revision P0-2: arbitrate between the heuristic approval rubric (derived
// from researcher-view aggregates) and the gatekeeper-lane rubric written to
// gate-review.json. When the gatekeeper lane was degraded (quota/rate_limit/
// timeout), its scores default to 0 and must NOT be taken as evidence that
// the heuristic rubric is wrong. We tag each approval rubric entry with a
// `confidence` marker so consumers can explain the provenance.
function annotateRubricConfidence({ rubric, gateReview, cycleState }) {
  const gateRubric = Array.isArray(gateReview?.rubric) ? gateReview.rubric : [];
  const gateByName = new Map();
  for (const item of gateRubric) {
    if (item && item.name) gateByName.set(item.name, item);
  }
  const gatekeeperLanes = Array.isArray(cycleState?.lane_statuses)
    ? cycleState.lane_statuses.filter((lane) => String(lane.role || "") === "gatekeeper")
    : [];
  const gatekeeperDegraded = gatekeeperLanes.some((lane) => lane.degraded === true);
  const gatekeeperFailed = gatekeeperLanes.some((lane) => lane.status === "failed");
  const gatekeeperMissingOrSilent = gatekeeperLanes.length === 0 || gateRubric.length === 0;

  return rubric.map((item) => {
    const gateItem = gateByName.get(item?.name);
    let confidence = "heuristic";
    let disputeDelta = null;
    let gateScore = null;
    if (gateItem && typeof gateItem.score === "number") {
      gateScore = gateItem.score;
      disputeDelta = Math.abs(Number(item.score || 0) - Number(gateItem.score || 0));
      if (gatekeeperDegraded || gatekeeperFailed) {
        confidence = "heuristic_gatekeeper_degraded";
      } else if (gatekeeperMissingOrSilent) {
        confidence = "heuristic_gatekeeper_missing";
      } else if (disputeDelta <= 15) {
        confidence = "corroborated";
      } else {
        confidence = "disputed";
      }
    } else if (gatekeeperDegraded || gatekeeperFailed) {
      confidence = "heuristic_gatekeeper_degraded";
    } else if (gatekeeperMissingOrSilent) {
      confidence = "heuristic_gatekeeper_missing";
    }
    return {
      ...item,
      confidence,
      gate_score: gateScore,
      dispute_delta: disputeDelta,
    };
  });
}

// Revision P0-3 (moved to approval_review layer): when the promotion
// pipeline itself was degraded, the blocker text that shouts "too few
// promoted hypotheses" is misleading — it reflects Codex failures, not
// research state. We replace those blockers with an honest "promotion
// pipeline degraded" notice when the relevant lanes were degraded.
function arbitrateBlockers({ blockers, cycleState }) {
  const lanes = Array.isArray(cycleState?.lane_statuses) ? cycleState.lane_statuses : [];
  const promotionLanesDegraded = lanes
    .filter((lane) => ["chronicle", "gatekeeper", "lab-director", "author"].includes(String(lane.role || "")))
    .some((lane) => lane.degraded === true);
  if (!promotionLanesDegraded) return { blockers, degraded_notices: [] };
  const filtered = blockers.filter((blocker) => {
    const text = String(blocker || "").toLowerCase();
    return !(text.includes("too few high-confidence promoted")
      || text.includes("alternative hypothesis families are still too limited")
      || text.includes("moderator or partition originality is still weak"));
  });
  const degradedLaneRoles = Array.from(new Set(
    lanes.filter((lane) => lane.degraded === true).map((lane) => String(lane.role || "")).filter(Boolean),
  ));
  const notice = `promotion pipeline ran on degraded fallback (affected roles: ${degradedLaneRoles.join(", ") || "unknown"}); rerun with Codex headroom before treating rubric scores as final`;
  return {
    blockers: [notice, ...filtered],
    degraded_notices: [notice],
  };
}

function buildApprovalReview({
  cwd = process.cwd(),
  cycleId,
  researcherView,
  conclusionReview = null,
  gateReview = null,
  reportReview = null,
  paperReview = null,
  staged = false,
}) {
  const root = runtimeRoot(cwd);
  const summary = researcherView?.summary || researcherView || {};
  const evidenceReadiness = summary.evidence_readiness || { ready: true, reasons: [] };
  const score =
    summary.approval_readiness_score == null
      ? null
      : Number(summary.approval_readiness_score || 0);
  const rawBlockers = Array.isArray(summary.approval_blockers) ? summary.approval_blockers : [];
  const rawRubric = dropInapplicableReportingRubrics(
    Array.isArray(summary.approval_rubric) ? summary.approval_rubric : [],
    summary.objective,
  );
  const promotionArtifacts = readPromotionArtifacts({ root, cycleId });
  const artifactAdjusted = applyPromotionArtifactResolutions({
    rubric: rawRubric,
    blockers: rawBlockers,
    promotionArtifacts,
  });
  const artifactScore = averageApplicableRubricScore(artifactAdjusted.rubric);
  const hasResolvedPromotionArtifact = Object.values(promotionArtifacts?.resolved || {}).some(Boolean);
  const heuristicScore = hasResolvedPromotionArtifact && artifactScore != null ? artifactScore : score;
  const cycleState = summary.cycle_state || {};
  const gateReviewForRubric = unwrapReview(gateReview) || readJsonIfExists(path.join(root, "state", `${cycleId}-gate-review.json`));
  const finalClaimPackage = readJsonIfExists(path.join(root, "state", `${cycleId}-final-claim-package.json`));
  // This one field short-circuits the whole staged ladder below, so it has to
  // mean what it says. On cycle-g-v89 it did not: the final claim package
  // stamped "approved" off the report and paper gates alone, and the cycle
  // terminated as approved with 129 hypothesis-gate blockers standing. The
  // package now records each gate separately; the explicit hypothesis check
  // here is so a reader cannot restore the short-circuit by editing one string.
  const documentGateApproved =
    finalClaimPackage?.research_outcome === "approved" &&
    finalClaimPackage?.high_impact_document_gates_passed === true &&
    finalClaimPackage?.hypothesis_gate_passed !== false;
  const rubric = annotateRubricConfidence({ rubric: artifactAdjusted.rubric, gateReview: gateReviewForRubric, cycleState });
  const blockerArbitration = arbitrateBlockers({ blockers: artifactAdjusted.blockers, cycleState });
  const blockers = blockerArbitration.blockers;
  const rubricProvenance = {
    confidence_counts: rubric.reduce((acc, item) => {
      const key = item.confidence || "heuristic";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    disputed_items: rubric
      .filter((item) => item.confidence === "disputed")
      .map((item) => ({ name: item.name, heuristic_score: item.score, gate_score: item.gate_score, delta: item.dispute_delta })),
    degraded_notices: blockerArbitration.degraded_notices,
  };
  const reviewPath = path.join(root, "state", `${cycleId}-approval-review.json`);
  const strategyDecision = readJsonIfExists(path.join(root, "state", `${cycleId}-strategy-decision.json`));
  const stageInputs = staged
    ? {
        conclusion: unwrapReview(conclusionReview) || readJsonIfExists(path.join(root, "state", `${cycleId}-conclusion-review.json`)),
        gate: unwrapReview(gateReview) || readJsonIfExists(path.join(root, "state", `${cycleId}-gate-review.json`)),
        report: unwrapReview(reportReview) || readJsonIfExists(path.join(root, "state", `${cycleId}-report-review.json`)),
        paper: unwrapReview(paperReview) || readJsonIfExists(path.join(root, "state", `${cycleId}-paper-review.json`)),
      }
    : null;
  const stagedApproval = staged
    ? buildApprovalStageGates({
        rawScore: heuristicScore,
        rawBlockers: blockers,
        evidenceReadiness,
        ...stageInputs,
      })
    : null;

  if (!evidenceReadiness.ready) {
    const waitBlockers = stagedApproval?.blockers?.length ? stagedApproval.blockers : blockers;
    const review = attachUnifiedReviewFields({
      ts: new Date().toISOString(),
      cycle_id: cycleId,
      type: "approval_review",
      mode: "wait",
      approval_readiness_score: null,
      approval_readiness_band: "pending-evidence",
      heuristic_approval_readiness_score: score,
      heuristic_approval_readiness_band: summary.approval_readiness_band || "unknown",
      approval_blockers: waitBlockers,
      approval_rubric: [],
      evidence_readiness: evidenceReadiness,
      approval_score_policy: staged ? "stage-gated-minimum" : "heuristic-readiness",
      approval_stage_gates: stagedApproval?.stages || [],
      all_stage_gates_passed: false,
      all_rubrics_approved: false,
      approval_gate_passed: false,
      recommended_followup_actions: [],
      researcher_view_path: researcherView.jsonPath,
      report_path: summary.source_paths?.report || null,
      objective: summary.objective || null,
    }, {
      score: null,
      pass: false,
      blockers: waitBlockers,
      recommendedActions: [],
      decisionMode: "wait",
      decisionReason: "core evidence lanes are not complete enough for approval review",
    });

    review.final_claim_package_path = null;

    // Append the trajectory before the value is overwritten. The file
  // below is rewritten on every refresh, so without this the only
  // record of a previous score is whatever has not been replaced yet.
  recordReviewSnapshot({ root, cycleId, kind: "approval-review", review });
  review.current_hypothesis_identity = selectedLeadReviewIdentity(root, cycleId, summary);
  writeJson(reviewPath, review);
    appendReviewOnce({ root, cycleId, slot: `approval_review:waiting:${staged ? "staged" : "direct"}`, review, dialogueEventType: "labdirector_approval_review" });

    return {
      reviewPath,
      review,
    };
  }

  const allRubricsApproved =
    documentGateApproved ||
    rubric.filter((item) => item?.applicable !== false).length > 0 &&
    rubric.filter((item) => item?.applicable !== false).every((item) => Number(item.score || 0) >= GATE_THRESHOLD);
  const heuristicApprovalGatePassed = documentGateApproved || (heuristicScore >= GATE_THRESHOLD && blockers.length === 0 && allRubricsApproved);
  const approvalGatePassed = staged
    ? Boolean(documentGateApproved || stagedApproval?.allStageGatesPassed)
    : heuristicApprovalGatePassed;
  const effectiveScore = staged ? stagedApproval.score : heuristicScore;
  const effectiveBand = staged ? stagedApproval.band : summary.approval_readiness_band || "unknown";
  const effectiveBlockers = staged ? stagedApproval.blockers : blockers;
  const mode = approvalGatePassed ? "hold" : effectiveScore == null ? "wait" : effectiveScore >= GATE_THRESHOLD - 5 ? "nudge" : "refine";
  const followupActions = staged
    ? dedupeActions([
        ...(stagedApproval.recommendedActions || []),
        ...rubricFollowupActions(rubric),
        ...promotionArtifactFollowupActions({ promotionArtifacts, score: effectiveScore, blockers: effectiveBlockers }),
      ])
    : dedupeActions([
        ...rubricFollowupActions(rubric),
        ...promotionArtifactFollowupActions({ promotionArtifacts, score: effectiveScore, blockers: effectiveBlockers }),
      ]);

  const review = attachUnifiedReviewFields({
    ts: new Date().toISOString(),
    cycle_id: cycleId,
    type: "approval_review",
    mode,
    approval_readiness_score: effectiveScore,
    approval_readiness_band: effectiveBand,
    heuristic_approval_readiness_score: heuristicScore,
    raw_heuristic_approval_readiness_score: score,
    heuristic_approval_readiness_band: summary.approval_readiness_band || "unknown",
    approval_blockers: effectiveBlockers,
    approval_rubric: rubric,
    promotion_artifact_resolution: artifactAdjusted.promotion_artifact_resolution,
    raw_approval_blockers: rawBlockers,
    raw_approval_rubric: rawRubric,
    rubric_provenance: rubricProvenance,
    approval_score_policy: staged ? "stage-gated-minimum" : "heuristic-readiness",
    approval_stage_gates: stagedApproval?.stages || [],
    approval_stage_summary: stagedApproval
      ? {
          all_stage_gates_passed: stagedApproval.allStageGatesPassed,
          failed_stage_names: stagedApproval.failedStages.map((stage) => stage.name),
          score_limiting_stage: stagedApproval.scoreLimitingStage
            ? {
                name: stagedApproval.scoreLimitingStage.name,
                label: stagedApproval.scoreLimitingStage.label,
                score: stagedApproval.scoreLimitingStage.score,
              }
            : null,
        }
      : null,
    document_gate_approval_override: documentGateApproved,
    raw_approval_gate_passed: heuristicApprovalGatePassed,
    final_claim_package_path: documentGateApproved
      ? path.join(root, "state", `${cycleId}-final-claim-package.json`)
      : null,
    all_rubrics_approved: allRubricsApproved,
    all_stage_gates_passed: staged ? stagedApproval.allStageGatesPassed : null,
    approval_gate_passed: approvalGatePassed,
    recommended_followup_actions: followupActions,
    researcher_view_path: researcherView.jsonPath,
    report_path: summary.source_paths?.report || null,
    objective: summary.objective || null,
  }, {
    score: effectiveScore,
    pass: approvalGatePassed,
    blockers: effectiveBlockers,
    recommendedActions: followupActions,
    decisionMode: approvalGatePassed ? "approved" : mode === "nudge" ? "refine" : mode,
    decisionReason: approvalGatePassed
      ? "approval gate passed"
      : stagedApproval?.decisionReason || effectiveBlockers[0] || "approval rubric blockers remain",
  });

  review.final_claim_package_path = null;

  // Append the trajectory before the value is overwritten. The file
  // below is rewritten on every refresh, so without this the only
  // record of a previous score is whatever has not been replaced yet.
  recordReviewSnapshot({ root, cycleId, kind: "approval-review", review });
  review.current_hypothesis_identity = selectedLeadReviewIdentity(root, cycleId, summary);
  writeJson(reviewPath, review);
  appendReviewOnce({ root, cycleId, slot: `approval_review:${staged ? "staged" : "direct"}`, review, dialogueEventType: "labdirector_approval_review" });

  return {
    reviewPath,
    review,
  };
}

module.exports = {
  buildApprovalReview,
};
