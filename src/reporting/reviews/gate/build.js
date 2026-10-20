"use strict";

const fs = require("fs");
const path = require("path");
const { assertHarnessSourceCurrent } = require("../../../runtime/source_revision");
const { appendReviewOnce } = require("../../../observability/cycle_logs");
const { writeJson } = require("../../../shared/json");
const hypothesisProgress = require("../../hypothesis_progress");
const { runtimeRoot } = require("../../../runtime/native_client");
const { compactGraph, compactHypotheses, compactValidationGaps } = require("../../../shared/context_compaction");
const { canAdvanceWithHighScoreNudge } = require("../../conclusion_review");
const {
  attachUnifiedReviewFields,
  readJsonIfExists: readJsonIfExistsSafe,
} = require("../../final_claim_package");
const { GATE_REVIEW_RUBRICS, GATE_REVIEWER_BRIEFS } = require("./constants");
const { parseJsonFromText, readJsonIfExists, readJsonIfExistsBounded } = require("./io");
const {
  appendJsonl,
  asArray,
  averageApplicableRubricScore,
  collectSearchText,
  compactText,
  extractGeoAccessions,
  hasForeignOnlyGeoAccessions,
  keepResearchQualityReasons,
  rubricBlockerReasons,
  uniqueStrings,
  withImpactFirstActionMandate,
} = require("./utils");
const {
  collectChronicleResearchContext,
  collectPreviousReviewContext,
  attachGateReviewerContextsToActions,
} = require("./review_context");
const {
  aggregateGatekeeperReviews,
  collectParsedGatekeeperReviews,
} = require("./gatekeeper_reviews");
const {
  externalValidationGateReview,
  openSourceAgentGateReview,
} = require("./external_validation");
const {
  authoritativeGateFollowupActions,
  pregateReportingRole,
  buildChallengeQuestions,
  buildGateFollowupActions,
  buildLabDirectorBlockerReviewActions,
  compactGateValidationResults,
  leadProtectionPrefix,
  takeCandidateHypotheses,
  takeOpenValidationGaps,
} = require("./actions");
const {
  gateProgressSignals,
  currentHypothesisIdentity,
  filterSupersededGatekeeperReviews,
  scopeCurrentLeadReviewStrings,
  unboundGatekeeperRubricsForRebind,
  validationOfCurrentLead,
} = require("./build/progress");
const { scientificValueGateReview, maybeApplyStagedGateFallback } = require("./build/scientific_value");
const { unansweredExperimentRequests } = require("../../experiment_requests");
const { recordReviewSnapshot } = require("../../review_history");
const {
  conclusionScienceBlockers,
  normalizeConclusionFollowupActions,
  scientificGateComments,
} = require("./build/conclusion");
const {
  applyPromotionArtifactResolutions,
  promotionArtifactFollowupActions,
  readPromotionArtifacts,
} = require("../../promotion_artifacts");
const {
  completedRolePlanCandidates,
  selectParsedCandidate,
  expectedGateRubrics,
  parseLabDirectorRequeryOutput,
} = require("./build/candidates");

// Elevate a gatekeeper novelty/impact REJECT into a binding active scientific
// blocker. LabDirector treats only gate_scientific_blockers as binding (its
// rationale: "the gate review does not provide novelty objections; its live
// blocker is STROBE"); the gatekeeper's reject verdict + cross-family
// recommendation otherwise stay in advisory challenge_questions and the
// non-novel lead is never pivoted. This does NOT change gate pass/fail
// (gatePassed still requires verdict==="approve") — it only surfaces the
// rejection so the LabDirector novelty-pivot rule fires.
const GATEKEEPER_NOVELTY_GATE_FLOOR = 60;
function buildGatekeeperNoveltyBlockers(aggregateReview) {
  if (
    !aggregateReview ||
    !Array.isArray(aggregateReview.reviews) ||
    aggregateReview.reviews.length === 0
  ) {
    return [];
  }
  if (aggregateReview.staged_gate_fallback && aggregateReview.staged_gate_fallback.applied === true) {
    return [];
  }
  const verdict = aggregateReview.verdict;
  if (verdict !== "reject" && verdict !== "challenge") return [];
  const rubric = Array.isArray(aggregateReview.rubric) ? aggregateReview.rubric : [];
  const scoreOf = (name) => {
    const item = rubric.find((r) => r && r.name === name && r.applicable !== false);
    const n = item ? Number(item.score) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const novelty = scoreOf("novelty");
  const impact = scoreOf("impact");
  const noveltyLow = novelty !== null && novelty < GATEKEEPER_NOVELTY_GATE_FLOOR;
  const impactLow = impact !== null && impact < GATEKEEPER_NOVELTY_GATE_FLOOR;
  if (!noveltyLow && !impactLow) return [];
  const reasons = uniqueStrings([
    ...(aggregateReview.incumbent_rejection_reasons || []),
    ...(aggregateReview.major_objections || []),
  ]).slice(0, 2);
  const alt = (aggregateReview.cross_family_alternatives || [])[0];
  const altText = alt
    ? ` Gatekeeper recommends pivoting to a more novel family: ${alt.family_root || alt.statement || ""}.`
    : "";
  const dimLabel = noveltyLow && impactLow ? "NOVELTY/IMPACT" : noveltyLow ? "NOVELTY" : "IMPACT";
  const whyText = reasons.length ? ` ${reasons.join(" ")}` : "";
  return [
    `${dimLabel} (blocking): independent gate review rejected the current lead for low ${dimLabel.toLowerCase()} (novelty=${
      novelty === null ? "n/a" : novelty
    }, impact=${impact === null ? "n/a" : impact}).${whyText}${altText}`,
  ];
}

function normalizeBlockerForMatch(value) {
  return String(value || "")
    .toLowerCase()
    // Keep letters and digits in any script; a blocker written in another
    // language must still normalise to something matchable.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockerTextsMatch(left, right) {
  const a = normalizeBlockerForMatch(left);
  const b = normalizeBlockerForMatch(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const minLength = Math.min(a.length, b.length);
  return minLength >= 24 && (a.includes(b) || b.includes(a));
}

function applyGateBlockerAdjudications(blockers, adjudications) {
  const active = [];
  const removed = [];
  const downgraded = [];
  const upheld = [];
  const decisions = asArray(adjudications)
    .filter((item) => item && typeof item === "object" && item.blocker)
    .map((item) => ({
      ...item,
      decision: String(item.decision || "").trim().toLowerCase(),
    }));

  for (const blocker of asArray(blockers)) {
    const matching = decisions.find((item) => blockerTextsMatch(blocker, item.blocker));
    if (!matching) {
      active.push(blocker);
      continue;
    }
    if (["remove", "resolved", "superseded"].includes(matching.decision)) {
      removed.push({ blocker, adjudication: matching });
      continue;
    }
    if (matching.decision === "downgrade") {
      downgraded.push({ blocker, adjudication: matching });
      continue;
    }
    upheld.push({ blocker, adjudication: matching });
    active.push(blocker);
  }

  return {
    active_blockers: uniqueStrings(active),
    removed_blockers: removed,
    downgraded_blockers: downgraded,
    upheld_blockers: upheld,
  };
}

// Durable hypothesis identity for the progress ledger. The LabDirector rewrites
// the lead statement's wording each round; keying progress on the statement would
// fragment one lead into many. The lab-director hypothesis file carries a stable
// hypothesis_id (and primary_family) that survives paraphrase — use it so all
// rounds of one hypothesis accrue to a single lead memory. Falls back to null
// (buildProgressRecord then keys on the statement) only if none is present.
function stableHypothesisId(root, cycleId, currentIdentity) {
  try {
    const hyp = readJsonIfExistsSafe(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`)) || {};
    const id =
      hyp.hypothesis_id ||
      hyp.selected_hypothesis?.hypothesis_id ||
      hyp.primary_family ||
      currentIdentity?.hypothesis_id ||
      null;
    return id ? String(id).trim() || null : null;
  } catch {
    return null;
  }
}

// The replacement record behind the lead currently under review.
//
// Leads change through `replacement_hypotheses[]` in director followup lanes, so
// that array is where the question and the methods spent on it are written. Match
// on the statement, because the hypothesis key is assigned after the proposal.
function latestReplacementRecord(root, cycleId, hypothesisKey) {
  try {
    const fs = require("fs");
    const path = require("path");
    const lanesDir = path.join(root, "lanes", cycleId);
    const lanes = fs.readdirSync(lanesDir)
      .filter((name) => name.includes("lab-director"))
      .map((name) => path.join(lanesDir, name, "result.json"))
      .filter((file) => fs.existsSync(file))
      .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const wanted = String(hypothesisKey || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    let fallback = null;
    for (const lane of lanes.slice(0, 8)) {
      const parsed = JSON.parse(fs.readFileSync(lane.file, "utf8"));
      const replacements = parsed?.extracted_json?.replacement_hypotheses;
      if (!Array.isArray(replacements) || !replacements.length) continue;
      if (!wanted) return replacements[0];
      const match = replacements.find((item) => {
        const statement = String(item?.statement || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        return statement && (statement.includes(wanted) || wanted.includes(statement.slice(0, 40)));
      });
      if (match) return match;
      // The director proposed something and the statement match failed. Judging
      // the proposal it actually made beats treating it as no proposal at all --
      // a substring test against a lead statement is not the thing being
      // enforced here.
      if (!fallback) fallback = replacements[0];
    }
    return fallback;
  } catch (error) {
    // A torn or missing lane result must leave the guard permissive rather than
    // deny every pivot for a read failure.
    return null;
  }
}

function buildGateReview({
  cwd = process.cwd(),
  cycleId,
  researcherView,
  conclusionReview = null,
  approvalReview = null,
}) {
  assertHarnessSourceCurrent({ cwd });
  const root = runtimeRoot(cwd);
  const summary = researcherView?.summary || researcherView || {};
  const conclusion = conclusionReview?.review || conclusionReview || {};
  const approval = approvalReview?.review || approvalReview || {};
  const strategyDecision = readJsonIfExistsSafe(path.join(root, "state", `${cycleId}-strategy-decision.json`));
  const conclusionReadyForGate =
    conclusion?.conclusion_gate_passed === true || canAdvanceWithHighScoreNudge(conclusion);
  const reviewPath = path.join(root, "state", `${cycleId}-gate-review.json`);
  const previousGateReview = readJsonIfExistsBounded(reviewPath, 1024 * 1024);
  const promotionArtifacts = readPromotionArtifacts({ root, cycleId });
  const reportReview = readJsonIfExistsSafe(path.join(root, "state", `${cycleId}-report-review.json`));
  const paperReview = readJsonIfExistsSafe(path.join(root, "state", `${cycleId}-paper-review.json`));
  const expectedRubrics = expectedGateRubrics({
    conclusion,
    approval,
    objective: summary?.objective || conclusion?.objective || approval?.objective || null,
  });
  const gatekeeperCandidates = completedRolePlanCandidates({
    root,
    cycleId,
    role: "gatekeeper",
    actionType: "independent_gate_review_followup",
    allowMissingActionType: true,
  });
  // Falsifier lanes (adversarial gatekeeper variant) are pulled alongside
  // so their objections enter the aggregate. See stage_policy "falsifier"
  // entry and agents/index.js falsifier role plan (hardening item #4).
  const falsifierCandidates = completedRolePlanCandidates({
    root,
    cycleId,
    role: "falsifier",
    actionType: "falsifier_review_followup",
    allowMissingActionType: true,
  });
  // Gatekeeper lanes that ran in review_mode="falsifier" are also counted
  // as adversarial for aggregation purposes.
  const falsifierModeGatekeepers = gatekeeperCandidates.filter((cand) => {
    const mode =
      cand?.rolePlan?.review_mode ||
      cand?.rolePlan?.planner_metadata?.review_mode ||
      null;
    return String(mode || "").toLowerCase() === "falsifier";
  });
  const adversarialCandidates = [...falsifierCandidates, ...falsifierModeGatekeepers];
  const combinedCandidates = [...gatekeeperCandidates, ...falsifierCandidates];
  const gatekeeperCollection = collectParsedGatekeeperReviews(combinedCandidates);
  const currentIdentity = currentHypothesisIdentity({ root, cycleId, summary });
  const progressSignals = gateProgressSignals(summary, { root, cycleId });
  const scientificValueGate = scientificValueGateReview({
    summary,
    progressSignals,
    conclusion,
    approval,
    conclusionReadyForGate,
    currentIdentity,
  });
  const filteredGatekeeperCollection = filterSupersededGatekeeperReviews(
    gatekeeperCollection.parsedReviews,
    progressSignals,
    currentIdentity,
  );
  const supersededGatekeeperLaneIds = new Set(
    filteredGatekeeperCollection.supersededReviews.map((item) => item.lane_id).filter(Boolean),
  );
  const supersededGatekeeperByLaneId = new Map(
    filteredGatekeeperCollection.supersededReviews
      .filter((item) => item.lane_id)
      .map((item) => [item.lane_id, item]),
  );
  const gatekeeperReviewStatusByRubric = gatekeeperCollection.statusByRubric.map((item) =>
    supersededGatekeeperLaneIds.has(item.lane_id)
      ? {
          ...item,
          parse_status: supersededGatekeeperByLaneId.get(item.lane_id)?.superseded_kind || "superseded_review",
          superseded: true,
          superseded_by_lane_id: supersededGatekeeperByLaneId.get(item.lane_id)?.superseded_by_lane_id || null,
        }
      : item,
  );
  const aggregateReviewBase = aggregateGatekeeperReviews({
    parsedReviews: filteredGatekeeperCollection.activeReviews,
    expectedRubrics,
  });
  const aggregateReview = maybeApplyStagedGateFallback({
    aggregateReview: aggregateReviewBase,
    expectedRubrics,
    filteredGatekeeperCollection,
    progressSignals,
    conclusion,
    approval,
    conclusionReadyForGate,
    scientificValueGate,
  });
  // MEASURED ON cycle-a-20260919, 2026-10-04: five unstamped reviews
  // of retired leads occupied focused rubrics after a lead replacement. Once a
  // correctly bound review arrives, re-request each still-unbound rubric once.
  const gatekeeperPendingRubrics = conclusionReadyForGate
    ? uniqueStrings([
        ...(aggregateReview.pendingRubrics || []),
        ...unboundGatekeeperRubricsForRebind(
          filteredGatekeeperCollection.activeReviews,
          currentIdentity,
        ),
      ])
    : [];
  const labDirectorSelection = selectParsedCandidate(
    completedRolePlanCandidates({
      root,
      cycleId,
      role: "lab-director",
      actionType: "lab_director_requery_followup",
      allowMissingActionType: true,
      maxCandidates: 12,
    }),
    parseLabDirectorRequeryOutput,
  );
  const labDirectorLane = labDirectorSelection.candidate;
  const labDirectorResponse = labDirectorSelection.parsed;
  const externalValidationReview = externalValidationGateReview({
    root,
    cycleId,
    summary,
    conclusionReadyForGate,
  });
  const openSourceAgentReview = openSourceAgentGateReview({
    root,
    cycleId,
    summary,
    conclusionReadyForGate,
  });
  const conclusionBlockerResolution = applyPromotionArtifactResolutions({
    rubric: [],
    blockers: conclusionScienceBlockers({ conclusion, approval, currentIdentity }),
    promotionArtifacts,
  });
  const rawConclusionBlockers = conclusionBlockerResolution.blockers;
  const gateBlockerAdjudicationResolution = applyGateBlockerAdjudications(
    rawConclusionBlockers,
    aggregateReview.blocker_adjudications || [],
  );
  const conclusionBlockers = uniqueStrings([
    ...gateBlockerAdjudicationResolution.active_blockers,
    ...buildGatekeeperNoveltyBlockers(aggregateReview),
  ]);
  const conclusionComments = scientificGateComments(conclusionBlockers);
  const previousReviewContext = collectPreviousReviewContext({
    root,
    cycleId,
    previousGateReview,
    conclusion,
    approval,
    reportReview,
    paperReview,
    currentHypothesisIdentity: currentIdentity,
  });
  const chronicleResearchContext = collectChronicleResearchContext({
    root,
    cycleId,
    researcherView,
    summary,
  });
  const searchAgentContractPending = chronicleResearchContext.search_agent_contract?.applicable === true
    && chronicleResearchContext.search_agent_contract?.decision_ready !== true;
  const searchAgentContractBlocker = searchAgentContractPending
    ? `search-agent contract incomplete: ${(chronicleResearchContext.search_agent_contract?.gaps || []).slice(0, 3).join(", ") || "targeted search coverage remains pending"}`
    : null;
  const gateReviewerContext = {
    required_for_gatekeeper: true,
    previous_review_context: previousReviewContext,
    chronicle_research_context: chronicleResearchContext,
    reviewer_must_read_context: [
      "previous_review_context",
      "chronicle_research_context",
    ],
    reviewer_instructions: [
      "Read prior gate, conclusion, report, and paper review comments before issuing a verdict.",
      "Use Chronicle trend/literature context and latest papers to infer the state-of-the-art baseline.",
      "Do not promote novelty or decision readiness when chronicle_research_context.search_agent_contract is incomplete.",
      "For each unresolved prior scientific objection, state whether it is resolved, still blocking, or superseded by stronger evidence.",
    ],
  };
  const stagedReviewRubric =
    (Array.isArray(conclusion?.conclusion_rubric) ? conclusion.conclusion_rubric : []) ||
    (Array.isArray(approval?.approval_rubric) ? approval.approval_rubric : []);
  const rawReviewRubric = !conclusionReadyForGate
    ? stagedReviewRubric
    : aggregateReview.rubric.length > 0
      ? aggregateReview.rubric
      : stagedReviewRubric;
  const reviewRubricResolution = applyPromotionArtifactResolutions({
    rubric: rawReviewRubric,
    blockers: [],
    promotionArtifacts,
  });
  const reviewRubric = reviewRubricResolution.rubric;
  const score = averageApplicableRubricScore(reviewRubric);

  const rawChallengeQuestions = !conclusionReadyForGate
    ? uniqueStrings([
        ...(scientificValueGate.blockers || []),
        ...buildChallengeQuestions(summary),
        ...(externalValidationReview.challenge_questions || []),
        ...(openSourceAgentReview.challenge_questions || []),
        ...(searchAgentContractBlocker ? [searchAgentContractBlocker] : []),
        ...conclusionBlockers,
      ])
    : aggregateReview.staged_gate_fallback?.applied === true
    ? uniqueStrings([
        ...(scientificValueGate.blockers || []),
        ...(externalValidationReview.challenge_questions || []),
        ...(openSourceAgentReview.challenge_questions || []),
        ...(searchAgentContractBlocker ? [searchAgentContractBlocker] : []),
      ])
    : aggregateReview.reviews.length > 0
    ? uniqueStrings([
        ...(scientificValueGate.blockers || []),
        ...(aggregateReview.major_objections || []),
        ...(aggregateReview.missing_validations || []),
        ...(aggregateReview.switch_triggers || []),
        ...(aggregateReview.incumbent_rejection_reasons || []),
        ...(aggregateReview.required_response_from_lab_director || []),
        ...(externalValidationReview.challenge_questions || []),
        ...(openSourceAgentReview.challenge_questions || []),
        ...(searchAgentContractBlocker ? [searchAgentContractBlocker] : []),
      ])
    : uniqueStrings([
        ...(scientificValueGate.blockers || []),
        ...buildChallengeQuestions(summary),
        ...(externalValidationReview.challenge_questions || []),
        ...(openSourceAgentReview.challenge_questions || []),
        ...(searchAgentContractBlocker ? [searchAgentContractBlocker] : []),
      ]);
  const challengeQuestionScope = scopeCurrentLeadReviewStrings(rawChallengeQuestions, currentIdentity);
  const challengeQuestions = challengeQuestionScope.kept;
  const actionSummary = {
    ...summary,
    latest_validation_lane_id: progressSignals.latestValidationLaneId,
    latest_validation_summary: progressSignals.latestValidationSummary,
    // What the run wrote, and where. The reproducibility rubric asks for exactly
    // this and v89 was capped at 55-68 without it while the files sat on disk.
    validation_artifact_paths: progressSignals.latestValidationArtifactPaths,
    // Stamped onto every gate-review action so the reviewer's verdict can later
    // be matched to the lead it was briefed on rather than inferred from prose.
    current_lead_key: currentIdentity.lead_key || null,
  };
  if (currentIdentity.dataset_keys?.length) {
    const lead = readJsonIfExistsSafe(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`));
    const selected = lead?.selected_hypothesis || lead?.lead_hypothesis || lead;
    actionSummary.focus_hypotheses = selected ? [selected] : [];
    actionSummary.derivable_hypothesis_candidates = selected ? [selected] : [];
    actionSummary.validation_results = progressSignals.latestValidationSummary
      ? [{ lane_id: progressSignals.latestValidationLaneId,
           ...progressSignals.latestValidationSummary,
           metrics: progressSignals.latestValidationSummary }] : [];
    actionSummary.evidence_packets = asArray(summary.evidence_packets).filter((item) =>
      (item.lane_id || item.source_lane_id) === progressSignals.latestValidationLaneId);
    actionSummary.evidence_packet_count = actionSummary.evidence_packets.length;
  }
  // Even when an early rubric rejects the package, keep requesting the
  // remaining independent rubric reviews. LabDirector needs the full critique
  // surface (novelty, reproducibility, clarity, impact, reporting, etc.) to
  // produce a scientifically targeted recovery plan rather than optimizing
  // against only the first failing dimension.
  const pendingIndependentGateReviews = conclusionReadyForGate
    ? buildGateFollowupActions(
        actionSummary,
        challengeQuestions,
        gatekeeperPendingRubrics,
        { previousReviewContext, chronicleResearchContext },
      )
    : [];
  const followupActionsRaw = !conclusionReadyForGate
    ? normalizeConclusionFollowupActions({
        conclusion,
        approval,
        blockers: conclusionBlockers,
        score,
      }).concat(pendingIndependentGateReviews)
    : authoritativeGateFollowupActions({
        summary: actionSummary,
        aggregateReview,
        labDirectorResponse,
        previousReviewContext,
        chronicleResearchContext,
        // ACM-CP anti-suppression guard on the pivot decision, computed from the
        // append-only progress log of PRIOR rounds (this round is appended after
        // the review is written). "deny" => the best-so-far lead is still
        // improving; the requery must keep refining it, not pivot away.
        leadSupersession: (() => {
          try {
            // Identify THIS round's hypothesis so the guard can tell "the lead
            // improving itself" (protect) from "a different better candidate"
            // (promote). Passing only the composite without the key made the lead
            // promote against ITSELF and defeated the anti-thrash guard.
            const currentKey = hypothesisProgress.hypothesisKey({
              hypothesisId: stableHypothesisId(root, cycleId, currentIdentity),
              statement: currentIdentity.primary_text || currentIdentity.text || "",
              familyRoot: (currentIdentity.accessions || [])[0] || null,
              primaryFamily: currentIdentity.primary_family || null,
            });
            // Anti-churn commit lock signal: is the newest completed validation
            // (a) statistically STRONG and (b) about the CURRENT lead (subject-token
            // overlap with the current lead statement)? If so, the strong lead must
            // consolidate/raise novelty IN PLACE for a bounded window instead of
            // being abandoned at the field's ~44 novelty ceiling.
            //
            // OWNER DECISION 2026-10-05: every lead gets the window, not only a
            // statistically strong one. On cycle-a-20260919 the gate
            // rejected nearly every lead for novelty (30-56), the novelty pivot
            // rule then required a new family and dataset, and 16 of 24 director
            // decisions in 21 hours replaced the lead -- five times in two hours --
            // each new lead starting the gate from zero. A lead now has its first
            // COMMIT_NOVELTY_ROUNDS novelty-reviewed gate rounds to raise novelty
            // in place; after them the ordinary rules (stall, strictly-better
            // candidate) decide, and a valid falsification releases it at once.
            const strongValidationCommit = (() => {
              try {
                const validation = progressSignals?.latestValidationSummary || null;
                if (!hypothesisProgress.validationIsStatisticallyStrong(validation)) {
                  return { active: true, leadKey: currentKey, kind: "novelty_refinement" };
                }
                // The strong result belongs to the current lead because this is the
                // newest completed validation and the gate round is being built for
                // the current lead's evidence. Prose token-overlap linkage was WRONG
                // here: validation summaries are numeric (p-values, correlations,
                // check names) and carry none of the lead's statement prose, so
                // coverage was ~0 for every validation and the lock could never fire.
                // The round context (newest validation the gate is reviewing) is the
                // correct binding to the current lead.
                return {
                  active: true,
                  leadKey: currentKey,
                  validationLaneId: progressSignals?.latestValidationLaneId || null,
                };
              } catch {
                return null;
              }
            })();
            const decision = hypothesisProgress.evaluateLeadSupersession({
              records: hypothesisProgress.readProgressLog(root, cycleId),
              cycleId,
              proposedComposite: hypothesisProgress.compositeScore(reviewRubric),
              proposedRubric: reviewRubric,
              proposedHypothesisKey: currentKey,
              proposedStatement: currentIdentity.primary_text || currentIdentity.text || "",
              currentLeadKey: currentKey,
              currentLeadStatement: currentIdentity.primary_text || currentIdentity.text || "",
              strongValidationCommit,
              // The newest validation bound to this lead. Without it the guard
              // judges score movement only, and protects a method its own
              // preregistered kill condition has already retired -- 108 times on
              // cycle-g-v89, each one overridden by a director holding the number.
              //
              // Only a validation of THIS lead -- one that finished after the lead
              // was selected. MEASURED ON cycle-a-20260919, 2026-10-05:
              // runner-138 falsified policy_specific_failure_ranking at 23:49, the
              // director replaced it on that falsification at 23:55, and the next
              // gate read runner-138 as the NEW lead's validation and released the
              // new lead's refinement window at once. The native lead hold binds
              // evidence the same way (a handoff written after the selection).
              leadValidationSummary: validationOfCurrentLead({
                root,
                cycleId,
                progressSignals,
                currentLeadKey: currentKey,
              }),
              // Three is the threshold, and it lives here rather than in the
              // guard: one silent lane is a lane being busy, three is a refusal
              // to answer. Keeping it at the call site is also what stops this
              // from deadlocking a cycle the way v82 did.
              ignoredExperimentRequests: unansweredExperimentRequests({ root, cycleId, minIgnored: 3 }),
              // Dormant best leads the director has already declined to resume,
              // with a reason: asked and answered, so not asked again.
              declinedResumes: hypothesisProgress.directorResumeDeclines({ root, cycleId }),
              // The director's own replacement record for this proposal. Supplying
              // it is what turns the method floor from a contract sentence into a
              // condition: a replacement that names no research question cannot
              // supersede the lead. 118 of 118 named none on cycle-g-v89, and the
              // three-methods-per-question rule was never once evaluated.
              proposedReplacement: latestReplacementRecord(root, cycleId, currentKey),
              // This call site looked. Absence below is the director's answer,
              // not an unwired guard.
              replacementLookupPerformed: true,
            });
            // Write the guard decision back to the append-only event graph so the
            // keep-refine-vs-pivot choice is reconstructable (ACM-CP causal trace).
            try {
              hypothesisProgress.appendDecisionEvent(root, cycleId, decision, undefined, new Date().toISOString());
            } catch {
              /* best-effort */
            }
            // ...and publish the directive as TEXT, for the requery paths this
            // module does not build.
            //
            // MEASURED ON cycle-g-v81. The ledger emitted the dormant-lead
            // decision 14 times and not one lane ever received the directive: the
            // requery lanes being opened came from `labdirector-runner-recovery-*`
            // in the Rust dispatcher, which composes its own description and never
            // consults the ledger. The gate review's own followup actions carried
            // no lead_supersession at all, because in that state the gate emits
            // rubric reviews rather than requeries. So the protection lived on a
            // road the traffic was not using — the same one-path delivery gap that
            // has produced most of this repo's "the agent ignored the rule" bugs.
            //
            // The prose stays in ONE place (leadProtectionPrefix). This file only
            // renders it to a file the other dispatchers can read, so the two
            // paths cannot drift into two different rules.
            //
            // Written on every decision, with an empty directive when there is
            // nothing to say. Writing only non-empty directives left the last one
            // standing after the ledger changed its mind: on cycle-g-v91 the file
            // kept telling directors to resume a falsified lead, and the readers
            // treat a non-empty directive as active.
            try {
              const directive = leadProtectionPrefix(decision) || "";
              writeJson(path.join(runtimeRoot(cwd), "state", `${cycleId}-lead-protection.json`), {
                ts: new Date().toISOString(),
                cycle_id: cycleId,
                decision: decision.decision,
                reason: decision.reason,
                lead: decision.lead || null,
                directive,
              });
            } catch {
              /* best-effort */
            }
            return decision;
          } catch {
            return null;
          }
        })(),
      })
        .concat(externalValidationReview.recommended_actions || []);
  followupActionsRaw.push(...buildLabDirectorBlockerReviewActions({
    summary: actionSummary,
    labDirectorResponse,
    gateBlockers: rawConclusionBlockers,
  }));
  followupActionsRaw.push(...(openSourceAgentReview.recommended_actions || []));
  followupActionsRaw.push(...(scientificValueGate.recommended_actions || []));
  followupActionsRaw.push(...promotionArtifactFollowupActions({
    promotionArtifacts,
    score,
    blockers: challengeQuestions,
  }));
  // FIX-AC (branch-agnostic): apply the pre-gate reporting re-route to EVERY
  // followup action regardless of which branch produced it. The
  // `!conclusionReadyForGate` branch above uses normalizeConclusionFollowupActions
  // (the live path while rubrics sit under the gate bar), which passes the
  // conclusion-review close-out actions through with their POST-gate roles
  // (logic_followup/visualization_followup -> author/illustrator, reporting_followup
  // -> author). Those roles never run before the gate passes, so the clarity/STROBE
  // rubrics can never improve -> the gate can never pass -> the post-gate authors
  // never run (deadlock). Re-route them here to pre-gate executors (lab-runner for
  // figures/clarity, analyst for reporting/STROBE) so the close-out work runs
  // pre-gate. Changes WHO executes, never the gate verdict/threshold.
  const followupActionsRerouted = followupActionsRaw.map((item) => {
    const rawRole = String(item?.preferred_role || "").trim();
    const remapped = pregateReportingRole(rawRole, item?.type);
    if (remapped === rawRole) return item;
    return {
      ...item,
      preferred_role: remapped,
      pre_gate_reporting_reroute: { from: rawRole, to: remapped },
    };
  });
  const followupActions = attachGateReviewerContextsToActions(followupActionsRerouted, {
    previousReviewContext,
    chronicleResearchContext,
  }).filter((item, index, items) =>
    items.findIndex((other) =>
      other.type === item.type &&
      other.preferred_role === item.preferred_role &&
      String(other.target_rubric || "") === String(item.target_rubric || "") &&
      String(other.review_mode || "") === String(item.review_mode || "") &&
      JSON.stringify(other.lab_director_blocker_review_requests || []) ===
        JSON.stringify(item.lab_director_blocker_review_requests || [])
    ) === index,
  ).map(withImpactFirstActionMandate);
  const baseGatePassed =
    conclusionReadyForGate;
  const gatePassed =
    aggregateReview.verdict === "approve" &&
    gatekeeperPendingRubrics.length === 0 &&
    scientificValueGate.required_for_gate !== true &&
    externalValidationReview.required_for_gate !== true &&
    openSourceAgentReview.required_for_gate !== true &&
    !searchAgentContractPending &&
    baseGatePassed;
  const mode = !conclusionReadyForGate
    ? "defer"
    : scientificValueGate.required_for_gate === true
      ? "reject"
    : searchAgentContractPending
      ? "reject"
    : externalValidationReview.required_for_gate === true
      ? "challenge"
      : openSourceAgentReview.required_for_gate === true
      ? "challenge"
      : aggregateReview.verdict
      ? aggregateReview.verdict
      : gatePassed && followupActions.length === 0
        ? "hold"
        : gatePassed
          ? "challenge"
          : "refine";
  const rubric = reviewRubric;
  // Keep real scientific objections (challenge questions + explicit
  // reject/defer signals) separate from "gatekeeper never produced a
  // response for this rubric". The latter is an *infrastructure* failure
  // that should trigger recovery, not masquerade as a peer-review blocker.
  // A missing-rubric condition now lives on its own ``pending_rubric_blockers``
  // field and is NOT folded into the headline blockers count.
  const rawBlockers = uniqueStrings([
    ...challengeQuestions,
    ...(scientificValueGate.blockers || []),
    ...(externalValidationReview.blockers || []),
    ...(openSourceAgentReview.blocker ? [openSourceAgentReview.blocker] : []),
    ...(searchAgentContractBlocker ? [searchAgentContractBlocker] : []),
    ...(mode === "reject" ? ["independent gate review rejected the current lead package"] : []),
    ...(mode === "defer" ? ["gate review deferred until conclusion review becomes eligible"] : []),
  ]);
  const rawBlockerResolution = applyPromotionArtifactResolutions({
    rubric: [],
    blockers: rawBlockers,
    promotionArtifacts,
  });
  const blockerScope = scopeCurrentLeadReviewStrings(rawBlockerResolution.blockers, currentIdentity);
  const blockers = blockerScope.kept;
  const supersededCurrentLeadBlockers = uniqueStrings([
    ...challengeQuestionScope.superseded.map((item) => item.text),
    ...blockerScope.superseded.map((item) => item.text),
  ]).map((text) =>
    [...challengeQuestionScope.superseded, ...blockerScope.superseded].find((item) => item.text === text),
  ).filter(Boolean);
  const pendingRubricBlockers = gatekeeperPendingRubrics.map(
    (item) => `pending gate rubric: ${item}`,
  );

  const review = attachUnifiedReviewFields({
    ts: new Date().toISOString(),
    cycle_id: cycleId,
    type: "gate_review",
    mode,
    gate_passed: gatePassed,
    conclusion_gate_passed: conclusion?.conclusion_gate_passed === true,
    conclusion_gate_eligible: conclusionReadyForGate,
    approval_gate_passed: approval?.approval_gate_passed === true,
    rubric,
    scientific_gate_comments: conclusionComments,
    gate_scientific_blockers: conclusionBlockers,
    raw_gate_scientific_blockers: rawConclusionBlockers,
    gate_blocker_adjudications: aggregateReview.blocker_adjudications || [],
    gate_blocker_adjudication_resolution: gateBlockerAdjudicationResolution,
    lab_director_blocker_review_requests: labDirectorResponse?.gate_blocker_review_requests || [],
    gate_reviewer_context: gateReviewerContext,
    previous_review_context: previousReviewContext,
    chronicle_research_context: chronicleResearchContext,
    scientific_value_gate: scientificValueGate,
    current_hypothesis_identity: {
      lead_key: currentIdentity.lead_key || null,
      primary_family: currentIdentity.primary_family || null,
      dataset_keys: currentIdentity.dataset_keys || [],
      analysis_contract_id: currentIdentity.analysis_contract_id || null,
      source_path: currentIdentity.source_path || null,
      source_mtime: currentIdentity.source_mtime || 0,
      accessions: currentIdentity.accessions || [],
      ignored_stale_dataset_accessions: currentIdentity.ignored_stale_dataset_accessions || [],
      primary_text: compactText(currentIdentity.primary_text || currentIdentity.text || "", 1200),
    },
    upstream_conclusion_review: {
      mode: conclusion?.mode || null,
      score: conclusion?.conclusion_score ?? conclusion?.exploratory_score ?? null,
      passed: conclusion?.conclusion_gate_passed === true,
      blocker_count: conclusionBlockers.length,
    },
    challenge_questions: challengeQuestions,
    major_objections: aggregateReview.major_objections || [],
    missing_validations: aggregateReview.missing_validations || [],
    switch_triggers: aggregateReview.switch_triggers || [],
    incumbent_rejection_reasons: aggregateReview.incumbent_rejection_reasons || [],
    same_family_alternatives: aggregateReview.same_family_alternatives || [],
    cross_family_alternatives: aggregateReview.cross_family_alternatives || [],
    family_switch_recommendations: aggregateReview.family_switch_recommendations || [],
    better_alternative_hypotheses: aggregateReview.better_alternative_hypotheses || [],
    gatekeeper_review:
      aggregateReview.reviews.length > 0
        ? {
            verdict: aggregateReview.verdict,
            pending_rubrics: gatekeeperPendingRubrics,
            partial_current_hypothesis_credit: aggregateReview.partial_current_hypothesis_credit === true,
            reviews: aggregateReview.reviews.map((item) => item.raw || item),
          }
        : null,
    gatekeeper_reviews_normalized: aggregateReview.reviews,
    gatekeeper_reviews: aggregateReview.reviews.map((item) => item.raw || item),
    external_validation_review: externalValidationReview,
    open_source_agent_gate_review: openSourceAgentReview,
    adversarial_review: {
      falsifier_lane_count: adversarialCandidates.length,
      falsifier_mode_gatekeeper_count: falsifierModeGatekeepers.length,
      dedicated_falsifier_lane_count: falsifierCandidates.length,
    },
    lab_director_response_normalized: labDirectorResponse || null,
    lab_director_response: labDirectorResponse?.raw || null,
    gatekeeper_review_status: !conclusionReadyForGate
        ? "deferred"
        : gatekeeperPendingRubrics.length === 0 && aggregateReview.reviews.length === expectedRubrics.length
        ? "parsed"
        : aggregateReview.reviews.length > 0
          ? "partial"
          : gatekeeperCandidates.length > 0
            ? filteredGatekeeperCollection.supersededReviews.length > 0
              ? "superseded"
              : "parse_failed"
            : !conclusionReadyForGate
              ? "deferred"
              : "missing",
    gatekeeper_review_lane_id: aggregateReview.reviews.length > 0 ? aggregateReview.reviews[0].lane_id : null,
    gatekeeper_review_source_action_match: aggregateReview.reviews.length > 0 ? aggregateReview.reviews[0].source_action_match : null,
    gatekeeper_expected_rubrics: expectedRubrics,
    gatekeeper_pending_rubrics: gatekeeperPendingRubrics,
    gatekeeper_progress_signals: {
      has_lead_hypothesis: progressSignals.hasLeadHypothesis,
      has_dataset: progressSignals.hasDataset,
      has_validation_evidence: progressSignals.hasValidationEvidence,
      has_published_8gene_audit: progressSignals.hasPublishedEightGeneAudit,
      latest_validation_lane_id: progressSignals.latestValidationLaneId,
      latest_validation_mtime: progressSignals.latestValidationMtime,
    },
    validation_matches_current_lead: scientificValueGate.validation_matches_current_lead,
    latest_validation_lane_id: scientificValueGate.latest_validation_lane_id,
    superseded_gatekeeper_reviews: filteredGatekeeperCollection.supersededReviews,
    superseded_current_lead_blockers: supersededCurrentLeadBlockers,
    staged_gate_fallback: aggregateReview.staged_gate_fallback || { applied: false },
    // Infrastructure-level blockers — gatekeeper never produced a response
    // for these rubrics. Surfaced separately so the recovery path can tell
    // "gate failed silently" from "gate objected scientifically".
    pending_rubric_blockers: pendingRubricBlockers,
    promotion_artifact_resolution: promotionArtifacts,
    raw_rubric_before_promotion_artifacts: rawReviewRubric,
    gatekeeper_review_status_by_rubric: gatekeeperReviewStatusByRubric,
    lab_director_response_status: labDirectorLane
      ? labDirectorResponse
        ? "parsed"
        : "parse_failed"
      : !conclusionReadyForGate
        ? "deferred"
        : "missing",
    lab_director_response_lane_id: labDirectorLane?.laneId || null,
    lab_director_response_source_action_match: labDirectorResponse?.source_action_match || labDirectorLane?.action_match || null,
    recommended_followup_actions: followupActions,
    candidate_hypotheses: takeCandidateHypotheses(summary),
    open_validation_gaps: takeOpenValidationGaps(summary),
    reasoning_graph: summary?.reasoning_graph || null,
    data_graph: summary?.data_graph || null,
    researcher_view_path: researcherView?.jsonPath || null,
    objective: summary?.objective || null,
    final_claim_package_path: null,
  }, {
    score,
    pass: gatePassed,
    blockers,
    recommendedActions: followupActions,
    // decision_mode / decision_reason used to come from the deleted
    // ``buildFinalClaimPackage``; the gate review still writes its own
    // pass/score fields, so we report the mode that ``attachUnifiedReviewFields``
    // already captured on the review object (``mode``) and derive a reason
    // from the first blocker or the rubric verdict.
    decisionMode: scientificValueGate.required_for_gate === true ? "pivot" : mode,
    decisionReason: blockers[0] || (gatePassed ? "gate rubric passed" : "gate rubric blockers remain"),
  });

  // Append the trajectory before the value is overwritten. The file
  // below is rewritten on every refresh, so without this the only
  // record of a previous score is whatever has not been replaced yet.
  recordReviewSnapshot({ root, cycleId, kind: "gate-review", review });
  writeJson(reviewPath, review);
  // ACM-CP hypothesis-progress coupling: append this reviewed round to the
  // append-only progress event graph so the best-so-far lead becomes provenance-
  // bound, non-suppressible critical memory (see src/reporting/hypothesis_progress
  // .js). Side-effect only; never block gate assembly.
  try {
    if (aggregateReview.reviews.length > 0) {
      const prior = hypothesisProgress.readProgressLog(root, cycleId);
      // Stable hypothesis identity: the LabDirector paraphrases the lead statement
      // every round, so keying on the statement fragments one lead into many. Use
      // the durable hypothesis_id from the lab-director hypothesis file so all
      // paraphrase rounds accrue to ONE lead memory.
      const stableHypId = stableHypothesisId(root, cycleId, currentIdentity);
      // Round # counts only PROGRESS records (decision events are excluded), so a
      // round number cannot drift as decision events are interleaved.
      const priorProgress = prior.filter((r) => r && r.memory_type === "decision" && r.content);
      // Provenance for this round = the SET of gatekeeper lanes it aggregates, not
      // whichever one happens to sit first in the list.
      //
      // MEASURED ON cycle-g-v76. 19 gatekeeper lanes scored a rubric and the ledger
      // received 3 progress records; the watchdog halted the cycle on
      // `activity_without_gate_progress` (203 lanes completed, 0 gate rounds, in an
      // 89-minute window). `reviews.find(...)` returns the FIRST review carrying a
      // lane id, so `source_message_id` stayed pinned to the same early lane across
      // refreshes, and the idempotency guard below — which skips a write when the
      // newest record for this hypothesis came from the same source_message_id —
      // read every later round as a redundant re-append.
      //
      // This only became load-bearing once lead identity was fixed (7556279). While
      // every round minted a fresh memory_id, `lastForHyp` was always undefined and
      // the guard never fired; now that rounds correctly accrue to one lead, the
      // guard engages — and it was keying on an unstable pick.
      //
      // Sorting makes the id independent of list order, so re-aggregating the SAME
      // gatekeepers is still correctly recognised as redundant, while a genuinely
      // new gatekeeper result changes the set and writes a new round.
      const contributingLanes = Array.from(
        new Set(
          aggregateReview.reviews
            .map((r) => (r && (r.source_lane_id || r.lane_id)) || null)
            .filter(Boolean)
            .map(String),
        ),
      ).sort();
      const sourceLane = contributingLanes.length
        ? contributingLanes.join("+")
        : `${cycleId}-gate-review`;
      const record = hypothesisProgress.buildProgressRecord({
        cycleId,
        round: priorProgress.length + 1,
        reviewLaneId: sourceLane,
        hypothesisId: stableHypId,
        statement: currentIdentity.primary_text || currentIdentity.text || "",
        familyRoot: (currentIdentity.accessions || [])[0] || null,
        primaryFamily: currentIdentity.primary_family || null,
        rubric,
        verdict: aggregateReview.verdict || null,
        gatePassed,
        now: review.ts,
        eventId: `evt-${priorProgress.length + 1}`,
      });
      // Idempotency: if the newest progress record for THIS hypothesis already came
      // from the same gatekeeper review lane, this is a redundant re-append within
      // the same refresh pass — skip it so double/triple writes cannot inflate the
      // round count and falsely trip stall detection.
      const lastForHyp = priorProgress
        .filter((r) => r.memory_id === record.memory_id)
        .slice(-1)[0];
      const isRedundant = lastForHyp && lastForHyp.source_message_id === record.source_message_id;
      if (!isRedundant) {
        hypothesisProgress.appendProgressRecord(root, cycleId, record);
      }
    }
  } catch {
    // progress ledger is best-effort; a write failure must not fail the gate.
  }
  appendReviewOnce({ root, cycleId, slot: "gate_review", review, dialogueEventType: "independent_gate_review" });

  return { reviewPath, review };
}

module.exports = {
  buildGateReview,
};
