"use strict";

const { compactGraph, compactHypotheses, compactValidationGaps } = require("../../../shared/context_compaction");
const { GATE_REVIEWER_BRIEFS } = require("./constants");
const { GATE_THRESHOLD } = require("../../../policy/research_gate");
const { attachGateReviewerContextsToActions } = require("./review_context");
const { asArray, compactText, uniqueStrings, withImpactFirstActionMandate } = require("./utils");

function takeCandidateHypotheses(summary, count = 5) {
  return Array.isArray(summary?.derivable_hypothesis_candidates)
    ? summary.derivable_hypothesis_candidates.slice(0, count)
    : [];
}

function takeOpenValidationGaps(summary, count = 5) {
  return Array.isArray(summary?.open_validation_gaps)
    ? summary.open_validation_gaps.slice(0, count)
    : [];
}

function buildChallengeQuestions(summary) {
  const questions = [];
  const candidates = takeCandidateHypotheses(summary, 3);
  const gaps = takeOpenValidationGaps(summary, 3);
  const reasoningGraph = summary?.reasoning_graph || {};
  const schemaQuality = summary?.schema_quality || {};

  if (candidates.length > 0) {
    questions.push(
      "Are there stronger lead hypotheses in the current candidate pool that LabDirector should elevate over the current promoted set?",
    );
  }
  if (gaps.length > 0) {
    questions.push(
      "Which unresolved validation gaps are still strong enough to block confident gate closure, and what is the highest-yield validation pass to close them?",
    );
  }
  if (Number(reasoningGraph.unresolved_gap_count || 0) > 0) {
    questions.push(
      "Does the reasoning graph still indicate missing falsification, rival-explanation, or moderator tests that make the current conclusion premature?",
    );
  }
  if (
    Number(schemaQuality.falsification_test_count || 0) <
    Math.max(3, Number(reasoningGraph.claim_count || 0))
  ) {
    questions.push(
      "Are the attached falsification tests rich enough, or should LabDirector request a stricter validation family before accepting the current result?",
    );
  }

  return uniqueStrings(questions);
}

// Artifact paths reach the gate in two shapes: the run's own tables and figures
// as an array of {kind, name, path}, and chronicle's bookkeeping paths as a plain
// object keyed by artifact name. Both are useful to a reviewer asking how to
// reproduce a result; neither is useful wrapped in a single array slot.
function normalizeArtifactPaths(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null).slice(0, 24);
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => typeof item === "string" && item.trim())
      .map(([name, item]) => ({ kind: "artifact", name, path: item }))
      .slice(0, 24);
  }
  return [];
}

function compactGateValidationResults(summary) {
  const focusHypotheses = asArray(summary?.focus_hypotheses || summary?.hypotheses).slice(0, 6).map((item) => ({
    hypothesis_id: item?.hypothesis_id || item?.id || null,
    family_root: item?.family_root || item?.family || null,
    status: item?.status || item?.latest_status || null,
    score: item?.score ?? item?.hypothesis_score ?? item?.evidence_quality_score ?? null,
    validating_lanes: asArray(item?.validating_lanes).slice(0, 6),
    statement: compactText(item?.statement || item?.claim || "", 360) || null,
  }));
  // The run's own reproducibility evidence, lifted BEFORE the per-entry map so
  // both branches below can reach it. rigor_profile is written once per lane at
  // validation_summary.rigor_profile; it is not a field of the per-validation
  // entries, which is why reading it off `item` found nothing on v86 and v87.
  const latestValidationSummary =
    summary?.latest_validation_summary && typeof summary.latest_validation_summary === "object"
      ? summary.latest_validation_summary
      : summary?.primary_validation?.validation_summary && typeof summary.primary_validation.validation_summary === "object"
        ? summary.primary_validation.validation_summary
        : null;
  const runRigorProfile = compactRigorProfile(latestValidationSummary?.rigor_profile);
  const validationResults = asArray(summary?.validation_results?.validation_results || summary?.validation_results)
    .slice(0, 8)
    .map((item) => ({
      lane_id: item?.lane_id || item?.source_lane_id || null,
      hypothesis_id: item?.hypothesis_id || item?.hypothesis_id_verified || null,
      verdict: item?.verdict || item?.verification_verdict || item?.status || null,
      pass_fail: item?.pass_fail || item?.metrics?.pass_fail || null,
      score: item?.score ?? item?.validation_score ?? null,
      summary: compactText(item?.summary || item?.notes || item?.reason || "", 360) || null,
      measured_quantities: asArray(
        item?.measured_quantities || item?.metrics?.measured_quantities,
      ).slice(0, 8),
      // The evidence for the REPRODUCIBILITY rubric. It was computed, written to
      // the lane result, and dropped here: v86 ran 24 lanes at
      // reproducibility_grade="supported" while all 38 gatekeeper prompts
      // contained the string zero times, and the gate scored reproducibility=2
      // for twelve rounds with that rubric binding on nine of them -- an honest
      // reading of an empty input.
      rigor_profile: compactRigorProfile(item?.rigor_profile || item?.metrics?.rigor_profile),
      metrics: item?.metrics && typeof item.metrics === "object"
        ? Object.fromEntries(Object.entries(item.metrics).slice(0, 12))
        : null,
    }))
    .filter((item) =>
      item.lane_id ||
      item.hypothesis_id ||
      item.verdict ||
      item.pass_fail ||
      item.score != null ||
      item.summary ||
      item.measured_quantities.length > 0 ||
      item.rigor_profile ||
      item.metrics,
    );
  if (validationResults.length === 0 && latestValidationSummary) {
    validationResults.push({
      lane_id:
        summary?.latest_validation_lane_id ||
        summary?.primary_validation?.lane_id ||
        latestValidationSummary.lane_id ||
        null,
      hypothesis_id:
        latestValidationSummary.primary_hypothesis_id ||
        latestValidationSummary.hypothesis_id ||
        null,
      verdict: latestValidationSummary.overall_status || latestValidationSummary.status || null,
      pass_fail:
        latestValidationSummary.pass_fail ||
        latestValidationSummary.overall_status ||
        null,
      score:
        latestValidationSummary.analysis_accuracy_score ??
        latestValidationSummary.method_appropriateness_score ??
        latestValidationSummary.score ??
        null,
      summary: compactText(
        latestValidationSummary.summary ||
          latestValidationSummary.notes ||
          [
            latestValidationSummary.overall_status
              ? `overall_status=${latestValidationSummary.overall_status}`
              : "",
            Number.isFinite(Number(latestValidationSummary.checks_passed)) &&
            Number.isFinite(Number(latestValidationSummary.checks_total))
              ? `checks=${latestValidationSummary.checks_passed}/${latestValidationSummary.checks_total}`
              : "",
            Array.isArray(latestValidationSummary.failed_checks) && latestValidationSummary.failed_checks.length > 0
              ? `failed_checks=${latestValidationSummary.failed_checks.slice(0, 8).join(",")}`
              : "",
          ].filter(Boolean).join("; "),
        480,
      ) || null,
      // The run's own measurements, alongside the workflow counters. This object
      // used to be counters ONLY — a fixed whitelist of checks_passed /
      // blueprints_passed / accuracy_score — so a render that measured +0.84 dB
      // reached the gate as "13/13 checks" and the reviewer said so verbatim.
      // measured_quantities comes from the driver and is domain-blind: whatever
      // the blueprint reported, bounded.
      measured_quantities: asArray(latestValidationSummary.measured_quantities).slice(0, 8),
      metrics: {
        overall_status: latestValidationSummary.overall_status || null,
        checks_passed: latestValidationSummary.checks_passed ?? null,
        checks_failed: latestValidationSummary.checks_failed ?? null,
        checks_total: latestValidationSummary.checks_total ?? null,
        blueprints_passed: latestValidationSummary.blueprints_passed ?? null,
        blueprints_failed: latestValidationSummary.blueprints_failed ?? null,
        external_agent_runs_passed: latestValidationSummary.external_agent_runs_passed ?? null,
        external_agent_runs_total: latestValidationSummary.external_agent_runs_total ?? null,
        analysis_accuracy_score: latestValidationSummary.analysis_accuracy_score ?? null,
        method_appropriateness_score: latestValidationSummary.method_appropriateness_score ?? null,
      },
    });
  }
  const evidencePackets = asArray(summary?.evidence_packets).slice(0, 8).map((item) => ({
    hypothesis_id: item?.hypothesis_id || null,
    lane_id: item?.lane_id || item?.source_lane_id || null,
    status: item?.status || item?.verdict || null,
    quality_score: item?.quality_score ?? item?.evidence_quality_score ?? null,
    summary: compactText(item?.summary || item?.finding || item?.reason || "", 360) || null,
  }));
  return {
    focus_hypotheses: focusHypotheses,
    validation_results: validationResults,
    // The evidence for the REPRODUCIBILITY rubric, delivered once at the level
    // it is measured at. v86 ran 24 lanes at reproducibility_grade="supported"
    // and v87 four more, while every gatekeeper prompt in both cycles contained
    // the string zero times and the rubric was scored on an empty input.
    rigor_profile: runRigorProfile,
    evidence_packets: evidencePackets,
    // Accepts either shape. The run's paths arrive as an array of
    // {kind, name, path}; chronicle's older bookkeeping field is an OBJECT, and
    // asArray would have wrapped it into one opaque blob rather than listing it.
    validation_artifact_paths: normalizeArtifactPaths(summary?.validation_artifact_paths),
    counts: {
      focus_hypothesis_count: focusHypotheses.length,
      validation_result_count: validationResults.length,
      evidence_packet_count: Number(summary?.evidence_packet_count || evidencePackets.length || 0),
      graph_update_count: Number(summary?.graph_update_count || 0),
    },
  };
}

function buildGateFollowupActions(summary, challengeQuestions, pendingRubrics, reviewerContexts = {}) {
  const candidateHypotheses = takeCandidateHypotheses(summary);
  const compactCandidates = compactHypotheses(candidateHypotheses, 5);
  const validationResults = compactGateValidationResults(summary);
  const score = Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0);
  if (pendingRubrics.length === 0) {
    return [];
  }
  // Never dispatch a rubric reviewer with nothing to review.
  //
  // A rubric review that is handed no hypothesis and no measurement scores 0 —
  // and then OWNS that rubric for the rest of the cycle, because
  // aggregateGatekeeperReviews takes the focused reviewer and `pendingRubrics`
  // never lists a rubric that already has one.
  //
  // MEASURED ON cycle-g-v77. The first gate round authored all five rubric
  // reviews while the summary still held zero candidate hypotheses and zero
  // validation results. Their 129KB prompts contained no lead statement and no
  // measurement (0 mentions of the lead's estimator, 0 of PSNR/SSIM); the five
  // reviewers correctly answered "there is no estimator, algorithm, comparator,
  // or result to assess" and scored 0-12. technical_quality and reproducibility
  // were never assigned to another reviewer for the remaining 4.5 hours, so the
  // aggregate carried technical_quality=0 and reproducibility=0 while nine later
  // gatekeepers — reading the same package WITH the runner evidence — scored
  // those axes 24-58 and 35-61. The gate could not pass on a package it had
  // never actually failed, and 56 of the cycle's 154 lanes were
  // gate_restart_followup.
  //
  // Holding the rubric pending is the honest state: there is nothing to score
  // yet, and the round is re-requested as soon as there is.
  const evidenceCounts = validationResults?.counts || {};
  const reviewableEvidence =
    compactCandidates.length > 0 ||
    Number(evidenceCounts.focus_hypothesis_count || 0) > 0 ||
    Number(evidenceCounts.validation_result_count || 0) > 0 ||
    Number(evidenceCounts.evidence_packet_count || 0) > 0;
  if (!reviewableEvidence) {
    return [];
  }

  return attachGateReviewerContextsToActions(pendingRubrics.map((targetRubric) => ({
      type: "independent_gate_review_followup",
      priority: ["technical_quality", "strobe_reporting_completeness"].includes(targetRubric)
        ? "critical"
        : "high",
      priority_score: ["technical_quality", "strobe_reporting_completeness"].includes(targetRubric)
        ? 10000
        : 9800,
      preferred_role: "gatekeeper",
      target_rubric: targetRubric,
      target_score: 95,
      current_score: score,
      gate_closure_goal: "close the missing current-hypothesis independent rubric without opening new discovery or analysis branches",
      avoid_redundant_work: true,
      candidate_hypotheses: compactCandidates,
      validation_results: validationResults,
      // Which lead this reviewer is being briefed on. Read back at aggregation
      // so a review is matched to the lead it actually saw — see
      // isBriefedOnSupersededLead. Without it the gate reported one lead's
      // scores as another lead's for four consecutive rounds on cycle-g-v78.
      gate_review_lead_key: summary?.current_lead_key || null,
      latest_validation_lane_id: summary?.latest_validation_lane_id || null,
      latest_validation_summary: summary?.latest_validation_summary || null,
      review_standard: GATE_REVIEWER_BRIEFS[targetRubric]?.standard || null,
      description:
        GATE_REVIEWER_BRIEFS[targetRubric]?.description ||
        "independently audit the supplied hypotheses and validation results for the target rubric",
    })).map(withImpactFirstActionMandate), reviewerContexts);
}

// Dispatch order (dispatch.rs sorts descending on priority_score) against a
// 3-slot concurrency budget, so this ranking decides what actually gets to run.
//
// THE STARVATION IT CAUSED (cycle-g-v74). lab-runner sat at 9750, BELOW the
// gatekeeper's 9850, and the gate emits gatekeeper work on every rejection. Of
// the cycle's runner lanes, 67 were superseded WITHOUT EVER LAUNCHING: they
// queued behind an endless stream of higher-priority reviews until a newer
// analyst handoff made them stale, and were discarded. Across 158 gate reviews
// novelty reached 55 while reproducibility stayed at 14-25 — the one role that
// manufactures evidence was the one role that never got a slot.
//
// A gate review re-scores evidence that already exists; it cannot raise
// reproducibility on its own. A runner produces evidence that does not exist
// yet. When both are queued and only one can run, the runner is what moves the
// blocked rubric, so it now outranks the reviewer.
//
// The LabDirector stays on top: it is cheap, it decides which lead the runner
// would even be validating, and it is not what was crowding runners out. The
// analyst stays below the gatekeeper deliberately — analyst churn is what makes
// runners stale in the first place (see the supersession grace in
// supervisor_recovery.rs), so promoting it too would feed the same loop.
function gateActionPriorityScore(action) {
  const type = String(action?.type || action?.action_type || "").trim();
  const role = String(action?.preferred_role || "").trim();
  if (type === "gate_restart_followup") return 9950;
  if (type === "lab_director_requery_followup" || role === "lab-director") return 9900;
  if (role === "lab-runner") return 9870;
  if (type === "independent_gate_review_followup" || role === "gatekeeper" || role === "falsifier") return 9850;
  if (role === "analyst") return 9750;
  if (role === "scout") return 9300;
  return 9700;
}

function buildLabDirectorBlockerReviewActions({
  summary,
  labDirectorResponse,
  gateBlockers,
}) {
  const requests = asArray(labDirectorResponse?.gate_blocker_review_requests)
    .filter((item) => item && typeof item === "object" && item.blocker);
  if (requests.length === 0) return [];
  const blockers = uniqueStrings([
    ...asArray(gateBlockers),
    ...requests.map((item) => item.blocker),
  ]);
  const compactCandidates = compactHypotheses(takeCandidateHypotheses(summary), 5);
  const validationResults = compactGateValidationResults(summary);
  const score = Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0);
  const requestsByRubric = new Map();
  for (const request of requests) {
    const targetRubric = String(request.target_rubric || "gate_independence").trim() || "gate_independence";
    if (!requestsByRubric.has(targetRubric)) requestsByRubric.set(targetRubric, []);
    requestsByRubric.get(targetRubric).push(request);
  }
  return Array.from(requestsByRubric.entries()).map(([targetRubric, groupedRequests]) => ({
    type: "independent_gate_review_followup",
    priority: "critical",
    priority_score: 10050,
    preferred_role: "gatekeeper",
    target_rubric: targetRubric,
    target_score: 95,
    current_score: score,
    gate_closure_goal:
      "adjudicate LabDirector's request to reconsider, remove, downgrade, or mark resolved stale gate blockers",
    review_mode: "lab_director_blocker_adjudication",
    gate_review_lead_key: summary?.current_lead_key || null,
    latest_validation_lane_id: summary?.latest_validation_lane_id || null,
    latest_validation_summary: summary?.latest_validation_summary || null,
    avoid_redundant_work: true,
    candidate_hypotheses: compactCandidates,
    validation_results: validationResults,
    blocker_reasons: blockers,
    challenge_questions: groupedRequests.map((request) =>
      `LabDirector requests ${request.requested_action || "reconsider"} for blocker: ${request.blocker}`,
    ),
    lab_director_response_lane_id: labDirectorResponse?.lane_id || null,
    lab_director_blocker_review_requests: groupedRequests,
    review_standard: GATE_REVIEWER_BRIEFS[targetRubric]?.standard || "research",
    description:
      "independently adjudicate LabDirector's blocker review request; uphold blockers that remain scientifically valid, and mark only stale, resolved, superseded, or mis-scoped blockers for removal/downgrade",
  })).map(withImpactFirstActionMandate);
}

// Pre-gate, the gatekeeper routes its reporting/figure blockers (clarity
// figures, STROBE precision) to post-gate roles (illustrator/author). The
// dispatcher does NOT spawn illustrator/author lanes before gate_passed, so
// those followups never run and the clarity/STROBE blockers can never close —
// the reporting last mile deadlocks even when the science already scores ~95.
// Re-route them to the pre-gate executors that actually produce the artifacts:
// lab-runner regenerates clearer primary/robustness figures + precision/CI
// tables from the validation; analyst redesigns the precision reporting into
// the runner handoff. Non-reporting roles pass through unchanged.
function pregateReportingRole(preferredRole, type) {
  const role = String(preferredRole || "").trim().toLowerCase();
  if (role !== "illustrator" && role !== "author") return preferredRole;
  const t = String(type || "").toLowerCase();
  if (
    role === "illustrator" ||
    t.includes("visual") ||
    t.includes("figure") ||
    t.includes("clarity") ||
    t.includes("display") ||
    t.includes("plot")
  ) {
    return "lab-runner";
  }
  // reporting / precision / STROBE completeness -> analyst designs it into the
  // handoff, lab-runner then executes it.
  return "analyst";
}

// What the reviewers already cleared, as the text the LabDirector reads.
//
// The director was told the score, the rubric to raise and the objections --
// never which rubrics were already at the bar or what earned them, so a
// refinement could not know what not to touch. MEASURED ON
// cycle-a-20260919, 2026-10-17/18: a lead reached novelty 78 /
// technical_quality 84 / reproducibility 92 / clarity 86 with only impact (67)
// short, and was replaced rather than improved at the one rubric that lacked.
// Rubrics with no reviewer of their own yet are not scores, and are left out.
function retainedStrengthsPrefix(rubric) {
  const rows = asArray(rubric).filter((row) =>
    row && typeof row === "object" && row.applicable !== false
    && row.focused_review_missing !== true && Number.isFinite(Number(row.score)));
  const cleared = rows.filter((row) => Number(row.score) >= GATE_THRESHOLD);
  if (!cleared.length) return "";
  const below = rows.filter((row) => Number(row.score) < GATE_THRESHOLD);
  const basis = (row) => asArray(row.reasons).map((text) => String(text).trim()).filter(Boolean)
    .slice(0, 2).map((text) => compactText(text, 220)).join(" | ") || "no basis stated";
  return (
    `RUBRICS ALREADY AT THE BAR (${GATE_THRESHOLD}) -- KEEP WHAT EARNED THEM: ` +
    cleared.map((row) => `${row.name}=${row.score} (reviewer: ${basis(row)})`).join("; ") + ". " +
    (below.length ? `The work left is ${below.map((row) => `${row.name}=${row.score}`).join(", ")}. ` : "") +
    "Improve the lead in place. Do not change the claim, estimands, comparators, data or validity gates " +
    "those scores rest on unless the evidence forces it; if you do, name the cleared rubric you are " +
    "putting at risk and why. A cleared rubric that falls again is a regression, not a fresh start. "
  );
}

// The ledger's protection, as the text the LabDirector reads.
//
// Extracted so it can be applied to EVERY requery routed to the director. It
// used to be computed inline in the one action this file authors, which left the
// gatekeeper's own `recommended_actions` able to open a second, unprotected
// requery channel -- see the note at the call site.
function leadProtectionPrefix(leadSupersession) {
  // MEASURED ON cycle-a-20260919, 2026-10-07: a valid falsification
  // produced decision=allow and therefore an empty directive. The director
  // actions never received the release, repeatedly upheld the dead current
  // method, and the cycle remained at conclusion through three scout, three
  // runner and six gate-review completions. An allow releases the pivot guard;
  // it does not erase the measured instruction to retire this method.
  if (leadSupersession?.reason === "lead_falsified_by_completed_run") {
    return (
      "FALSIFICATION RELEASE: the current METHOD" +
      (leadSupersession?.lead ? ` (${leadSupersession.lead})` : "") +
      " met its recorded kill condition and is retired; do NOT uphold, refine, or resubmit it. " +
      "Select and record a replacement method for the surviving research question. "
    );
  }
  // A DORMANT best lead: the ledger allows the pivot (refusing would rebuild the
  // v75 deadlock) but the answer is "go back to it", not "pick anything". Without
  // this the allow reads as a blank cheque, and on cycle-g-v81 it was cashed 95
  // times while leads averaged 2.04 rounds each.
  const resume = leadSupersession && leadSupersession.reason === "best_lead_dormant_resume_before_replacing"
    ? leadSupersession.resume_lead
    : null;
  if (resume) {
    const bests = Object.entries(resume.best_by_rubric || {})
      .map(([name, score]) => `${name}=${score}`)
      .join(", ");
    return (
      "THE STRONGEST LEAD THIS CYCLE HAS PRODUCED WAS ABANDONED, NOT DISPROVED. " +
      `It is ${resume.memory_id}` +
      (resume.statement ? ` — "${String(resume.statement).slice(0, 400)}"` : "") +
      `. It was scored ${resume.rounds} time(s), last at round ${resume.last_round_index} of ` +
      `${resume.current_round}, reaching ${bests || "no recorded rubric scores"}. ` +
      "Nothing about it failed; the cycle simply stopped working on it, and every round since has " +
      "started a new hypothesis from scratch. BEFORE proposing any new lead, say what this one still " +
      "needs — the specific experiment or evidence that would raise its weakest rubric — and prefer " +
      "resuming it. Replace it only if you can name the reason it cannot reach the gate. Answer in " +
      `\`resume_lead_decision\`: {"lead_id": "${resume.memory_id}", "decision": "resume" or "decline", ` +
      '"reason": "...", "evidence_refs": ["the lanes or artifacts that show it"]}. A decline with its ' +
      "reason is recorded and this lead is not put to you again. Starting a further new lead without " +
      "addressing this one is the churn that has kept every lead at about two rounds of work. "
    );
  }
  // MEASURED ON cycle-a-20260919, 2026-10-03: the ledger correctly
  // released a falsified method but temporarily denied an unaccountable pivot;
  // treating that deny as incumbent protection told the director both to emit
  // a replacement and to never author one, which no lane could satisfy.
  if (
    leadSupersession?.decision === "deny" &&
    leadSupersession?.falsification_released === true
  ) {
    return (
      "FALSIFICATION RELEASE / REPLACEMENT ACCOUNTABILITY: the current METHOD is retired; " +
      "do NOT keep refining or resubmit it. " +
      (String(leadSupersession?.director_guidance || "").trim() ||
        "Emit a replacement hypothesis that states the research question it answers and the methods already tried against that question. ") +
      " "
    );
  }
  const ledgerDeniesPivot = Boolean(leadSupersession && leadSupersession.decision === "deny");
  if (!ledgerDeniesPivot) return "";
  // ACM-CP anti-suppression: if the append-only progress graph says the
  // best-so-far lead is STILL IMPROVING, the requery must keep refining THAT
  // lead (raise only its binding rubric) and NOT pivot to a different
  // hypothesis — abandoning an improving lead suppresses the critical memory.
  const bindingName = leadSupersession?.binding_rubric?.name || leadSupersession?.keep_refining || null;
  const bindingIsSoundness =
    bindingName != null && !["novelty", "impact"].includes(String(bindingName).toLowerCase());
  // COMMIT LOCK: the current lead has a statistically STRONG completed validation
  // of its own and has not yet consolidated its novelty. A strong cross-domain
  // result must be raised in place, not abandoned at the field's novelty ceiling.
  const commitLock =
    leadSupersession &&
    leadSupersession.decision === "deny" &&
    leadSupersession.reason === "strong_validation_commit_window";
  // OWNER DECISION 2026-07-10 ("change the pivot condition"): a DENY from the progress
  // ledger is AUTHORITATIVE for this round's requery, regardless of which rubric
  // is binding. The previous rule waived the protection when the binding rubric
  // was novelty/impact (the "novelty pivot escape"), and the trailing guidance
  // then told the director to author a brand-new hypothesis — so the director
  // churned away leads the ledger said were still improving. Observed on
  // cycle-g-v56: H-REVS-01 was abandoned at novelty 68 mid-climb (96 deny
  // records, zero stall-permits); novelty crashed to 18 and soundness never
  // accumulated because each lead died before its own validation completed.
  // This is NOT a permanent lock: the guard itself returns
  // allow(lead_stalled_pivot_permitted) once the lead's binding rubric stays
  // flat for STALL_ROUNDS reviewed rounds, and a strictly-better candidate
  // (higher composite AND no-worse binding rubric) still promotes immediately.
  const keepRefining = ledgerDeniesPivot;
  // Name the lead being protected. Identifying it only by its `hyp:<hash>`
  // memory_id leaves the director unable to tell WHICH hypothesis it must keep
  // refining: on v72 it wrote the token itself into the lead ("attempt 42
  // currently exposes only unauditable token hyp:54495e...., so no rendering
  // claim may be inferred"), the gatekeeper scored a lead with no scientific
  // content ("The lead is unidentified"), and novelty collapsed from 64 to ~0.
  const leadStatementText = String(leadSupersession?.lead_statement || "").trim();
  const leadIdentity = leadStatementText
    ? `THE LEAD YOU MUST KEEP REFINING IS: "${leadStatementText}"${
        leadSupersession?.lead ? ` (ledger id ${leadSupersession.lead})` : ""
      }. Restate THIS hypothesis as your selected lead — never substitute its ledger id, a placeholder, or a note about the ledger for the scientific claim itself. `
    : "";
  // Novelty/impact-binding deny: same protection, but the in-place work is
  // contribution escalation (mechanism, head-to-head vs the named prior art,
  // contribution reframe) rather than soundness strengthening.
  const bindingIsContribution = keepRefining && !bindingIsSoundness && !commitLock;
  // The measured price of the decision the director is about to make. Prose
  // ("every prior lead died this way") did not move it on v85: 12 lead changes
  // in 28 rounds, and the lead abandoned at 07:34 held the cycle's best novelty
  // AND technical_quality. Numbers, from the ledger, in the same breath as the
  // rule.
  const cost = leadSupersession?.churn_cost || null;
  const costClause = (() => {
    if (!cost || !Number.isFinite(cost.gate_rounds) || cost.gate_rounds < 2) return "";
    const parts = [];
    if (Number.isFinite(cost.lead_changes) && cost.rounds_per_lead) {
      parts.push(
        `THE MEASURED COST SO FAR: this cycle has changed leads ${cost.lead_changes} time(s) across ` +
          `${cost.gate_rounds} gate round(s) — ${cost.rounds_per_lead} rounds per lead.`,
      );
    }
    const holds = Array.isArray(cost.lead_holds_cycle_best) ? cost.lead_holds_cycle_best : [];
    if (holds.length) {
      parts.push(
        `The lead you are being asked to keep holds this cycle's BEST ` +
          holds.map((h) => `${h.rubric}=${h.score}`).join(", ") +
          `. Abandoning it abandons those numbers; a replacement starts from nothing.`,
      );
    }
    if (Number.isFinite(cost.pivots_that_scored_worse) && cost.pivots_that_scored_worse > 0) {
      parts.push(
        `Of the pivots already taken, ${cost.pivots_that_scored_worse} landed on a lead that scored ` +
          `WORSE than the one it replaced` +
          (cost.pivots_that_scored_better ? `, ${cost.pivots_that_scored_better} better` : "") +
          `.`,
      );
    }
    parts.push(
      "A cycle whose rubrics stop improving for five consecutive rounds is halted automatically, " +
        "and every pivot resets that lead's accumulation to zero.",
    );
    return parts.join(" ") + " ";
  })();
  const antiThrashPrefix = leadIdentity + costClause + (commitLock
    ? "COMMIT-LOCK / ANTI-CHURN RULE: this lead has already produced a statistically STRONG, completed validation of ITS OWN (a real p<0.01 / large-effect result" +
      (leadSupersession.validation_lane_id ? ` from ${leadSupersession.validation_lane_id}` : "") +
      "). That is the single most valuable asset in this cycle and it has NOT yet been consolidated at the gatekeeper novelty table (" +
      `${leadSupersession.novelty_rounds_done ?? 0}/${leadSupersession.commit_novelty_rounds ?? 2} novelty rounds done). Do NOT pivot to a different hypothesis and do NOT abandon this validated lead this round — switching to a fresh UNVALIDATED idea to chase a higher novelty band throws away proven evidence and is exactly the churn that keeps every lead stuck at ~44 novelty. Instead RAISE THIS lead's novelty IN PLACE: (1) sharpen the cross-domain MECHANISM that makes the validated result surprising (what imported method/insight produced it, and why the crowded native baselines could not); (2) run the head-to-head against the SPECIFIC prior-art baselines the reviewer named, using the already-strong validation as the anchor; (3) reframe the contribution around what the strong result proves that the state-of-the-art does not. Keep the validated evidence and every earned rubric; escalate novelty on top of it. A pivot is reconsidered only AFTER this lead has completed its novelty consolidation rounds. `
    : bindingIsContribution
    ? "ANTI-CHURN / NOVELTY-IN-PLACE RULE: the append-only progress ledger shows the current best-so-far lead is STILL IMPROVING across recent rounds; its binding constraint is " +
      (bindingName ? `'${bindingName}'` : "a contribution rubric (novelty/impact)") +
      ". Do NOT pivot to a different hypothesis this round and do NOT author a replacement lead — abandoning an improving lead suppresses the best accumulated progress and resets soundness to zero (every prior lead died this way before its own validation completed). Raise the contribution IN PLACE on THIS lead: (1) sharpen the cross-domain MECHANISM that makes the result surprising (what imported method/insight does the crowded native baseline lack); (2) run the head-to-head against the SPECIFIC prior-art baselines the reviewer named; (3) reframe the contribution around what this lead demonstrates that the named state-of-the-art does not. Keep every earned rubric. The ledger permits a pivot automatically once this lead's binding rubric stays flat across consecutive reviewed rounds (lead_stalled_pivot_permitted) or a strictly better candidate appears — until then a pivot is denied. "
    : keepRefining
    ? "ANTI-THRASH / CRITICAL-MEMORY RULE: the append-only progress ledger shows the current best-so-far lead is STILL IMPROVING across recent rounds and its binding constraint is a SOUNDNESS rubric" +
      (bindingName ? ` ('${bindingName}')` : "") +
      " that is fixed by strengthening THIS hypothesis. Do NOT pivot to a different hypothesis this round and do NOT abandon this lead — that would suppress the best accumulated progress. KEEP this exact lead and raise ONLY that single binding rubric with new evidence/validation; carry every already-earned rubric forward. The ledger permits a pivot automatically once this lead has genuinely stalled (no binding-rubric gain across consecutive reviewed rounds) or a strictly better candidate appears — until then a pivot is denied. "
    : "");
  return antiThrashPrefix;
}

// Reproducibility evidence, trimmed to what a reviewer needs to score it.
// Gatekeeper prompts already run 70-99KB, so the generic `affordable_here` prose
// (identical on every lane) is dropped and the specifics are kept: which signals
// the run actually produced, the grade, and the named columns behind it.
function compactRigorProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const evidence = profile.table_evidence && typeof profile.table_evidence === "object"
    ? profile.table_evidence
    : {};
  const named = {};
  for (const axis of ["multi_seed", "comparator"]) {
    const entry = evidence[axis];
    if (entry && typeof entry === "object") {
      named[axis] = {
        column: entry.column || null,
        distinct_values: entry.distinct_values ?? null,
        table: entry.table || null,
        ...(entry.arms ? { arms: asArray(entry.arms).slice(0, 6) } : {}),
      };
    }
  }
  const compact = {
    reproducibility_grade: profile.reproducibility_grade || null,
    signals: profile.signals && typeof profile.signals === "object" ? profile.signals : null,
    core_present: asArray(profile.core_present).slice(0, 6),
    core_missing: asArray(profile.core_missing).slice(0, 6),
  };
  if (Object.keys(named).length) compact.table_evidence = named;
  return compact;
}

function authoritativeGateFollowupActions({
  summary,
  aggregateReview,
  labDirectorResponse,
  previousReviewContext,
  chronicleResearchContext,
  leadSupersession = null,
}) {
  const candidateHypotheses =
    aggregateReview?.cross_family_alternatives?.length > 0
      ? aggregateReview.cross_family_alternatives
      : aggregateReview?.better_alternative_hypotheses?.length > 0
      ? aggregateReview.better_alternative_hypotheses
      : takeCandidateHypotheses(summary);
  const openValidationGaps = takeOpenValidationGaps(summary);
  const reasoningGraph = compactGraph(summary?.reasoning_graph || null);
  const dataGraph = compactGraph(summary?.data_graph || null);
  const compactCandidates = compactHypotheses(candidateHypotheses, 5);
  const compactGaps = compactValidationGaps(openValidationGaps, 5);
  // What the runs ACTUALLY established (lane, verdict, metrics). The director's
  // requery/restart actions carried the objections and the candidate pool but
  // never this, so the one thing needed to scope a claim down to its evidence —
  // the evidence — was the one thing missing from the round that decides the
  // scope. On v74 the director kept re-asserting a reuse/guiding claim while a
  // completed run held +0.84 dB adaptive-vs-uniform at matched spp with a clean
  // falsification boundary; it could not narrow toward a result it was not shown.
  const establishedValidationResults = compactGateValidationResults(summary);
  const score = Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0);
  const challengeQuestions = uniqueStrings([
    ...(aggregateReview?.major_objections || []),
    ...(aggregateReview?.missing_validations || []),
    ...(aggregateReview?.switch_triggers || []),
    ...(aggregateReview?.incumbent_rejection_reasons || []),
    ...(aggregateReview?.required_response_from_lab_director || []),
  ]);
  const actions = buildGateFollowupActions(
    summary,
    challengeQuestions,
    aggregateReview?.pendingRubrics || [],
    { previousReviewContext, chronicleResearchContext },
  );

  // The ledger's protection has to reach EVERY requery, not just the one this
  // file authors.
  //
  // MEASURED ON cycle-g-v75. The progress ledger denied a pivot 59 consecutive
  // times, protecting hyp:f199ba08 (failure_boundary_modeling), and the director
  // changed lead anyway — three different hypotheses inside forty minutes, none
  // of them the protected one. The deny was not ignored: it never arrived.
  // followup-lab-director-30 carried `action_type: lab_director_requery_followup`
  // and its role plan had no `lead_supersession` and none of the anti-churn text,
  // because it was not built below — it came from the gatekeeper's own
  // `recommended_actions`, and that loop composes its action from the reviewer's
  // description alone.
  //
  // So there were two ways to ask the director to requery and only one of them
  // was protected. Anything routed to lab-director as a requery now carries the
  // same lead identity and the same anti-churn rule, whoever proposed it.
  const leadProtection = leadProtectionPrefix(leadSupersession);
  const retainedStrengths = retainedStrengthsPrefix(aggregateReview?.rubric);
  const isDirectorRequery = (action) =>
    String(action?.preferred_role || "") === "lab-director" ||
    String(action?.type || "").includes("requery") ||
    String(action?.type || "") === "gate_restart_followup";

  for (const item of aggregateReview?.recommended_actions || []) {
    const type = String(item?.type || "").trim();
    const description = String(item?.description || "").trim();
    const rawRole = String(item?.preferred_role || "").trim();
    if (!type || !description || !rawRole) continue;
    const preferredRole = pregateReportingRole(rawRole, type);
    const routedDescription =
      preferredRole !== rawRole
        ? `${description} (pre-gate reporting task re-routed from ${rawRole}: produce the clearer primary/robustness figures and precision/CI reporting the gate review requires so the clarity and reporting-completeness blockers can close before final authoring)`
        : description;
    const proposed = {
      type,
      priority: "high",
      preferred_role: preferredRole,
      target_rubric: item?.target_rubric || "gate_independence",
      target_score: 95,
      current_score: score,
      blocker_reasons: challengeQuestions,
      challenge_questions: challengeQuestions,
      candidate_hypotheses: compactCandidates,
      // The reviewer's own recommended_actions open gatekeeper lanes too; stamp
      // them with the same lead so both dispatch paths stay matchable.
      gate_review_lead_key: summary?.current_lead_key || null,
      latest_validation_lane_id: summary?.latest_validation_lane_id || null,
      latest_validation_summary: summary?.latest_validation_summary || null,
      reasoning_graph: reasoningGraph,
      data_graph: dataGraph,
      open_validation_gaps: compactGaps,
      description: routedDescription,
    };
    if (leadProtection && isDirectorRequery(proposed)) {
      proposed.description = leadProtection + retainedStrengths + proposed.description;
      proposed.lead_supersession = leadSupersession || null;
      proposed.validation_results = establishedValidationResults;
    } else if (retainedStrengths && isDirectorRequery(proposed)) {
      proposed.description = retainedStrengths + proposed.description;
    }
    actions.push(proposed);
    actions[actions.length - 1].priority_score = gateActionPriorityScore(actions[actions.length - 1]);
  }

  // OWNER DECISION 2026-07-10, second half: the reject/restart path was the
  // remaining pivot channel that bypassed the ledger. On cycle-g-v56, 38
  // lab-director lanes carried gate_restart_followup while the ledger denied a
  // pivot 119 times with zero stall-permits — every "restart from scratch"
  // authored a fresh lead, so no lead ever survived to its own completed
  // validation. A ledger DENY now routes a reject/restart round into the same
  // keep-refining requery (improve the protected lead in place); the restart
  // action fires only when the ledger permits a pivot (lead stalled for
  // STALL_ROUNDS, a strictly-better candidate, or no lead to protect). An
  // honest gatekeeper rejection is therefore delayed at most STALL_ROUNDS
  // reviewed rounds, never suppressed.
  const ledgerDeniesPivot = Boolean(leadSupersession && leadSupersession.decision === "deny");
  const falsificationReplacementPending =
    ledgerDeniesPivot && leadSupersession?.falsification_released === true;
  const restartRequested =
    aggregateReview?.restart_recommended === true ||
    aggregateReview?.verdict === "reject" ||
    labDirectorResponse?.decision === "restart";
  if (aggregateReview?.verdict === "challenge" || (ledgerDeniesPivot && restartRequested)) {
    const antiThrashPrefix = leadProtectionPrefix(leadSupersession);
    // CLAIM-EVIDENCE PROPORTIONALITY. Every branch above tells the director to
    // push the claim UP (escalate novelty, sharpen the mechanism, reframe the
    // contribution). Nothing ever told it the claim could be too big for the
    // evidence, so an over-scoped lead had only one direction to move, and the
    // reviewer's missing_validations list was read as a work order rather than as
    // the measured distance between what was claimed and what was run.
    //
    // On cycle-g-v74 that distance was the whole failure: a completed run held a
    // clean matched-spp adaptive-vs-uniform result with a real falsification
    // boundary (+0.84 dB on the high-variance scene, -0.19 dB on the low-variance
    // one), while the lead claimed reuse/guiding under scene edits with ESS gating
    // and crossover estimands. Scores 30/12/15, reject, and the objections were
    // all correct. Narrowing to the demonstrated claim was never on the table.
    //
    // The rule is deliberately two-sided: narrow only what the cycle CANNOT
    // produce, and only in generality — never trade the mechanism away, or this
    // becomes a novelty-retreat channel and the hard novelty bar above kills it.
    const missingValidationCount = asArray(aggregateReview?.missing_validations).length;
    const claimScopeRule = missingValidationCount > 0
      ? "CLAIM-EVIDENCE PROPORTIONALITY: the reviewer listed " +
        `${missingValidationCount} missing validation(s). That list is the measured distance between the claim you are ` +
        "making and the evidence that exists — read it as a SCOPE signal, not only as a work order. Decide, per item, " +
        "whether it is (a) feasible here and simply not yet run — then request it and keep the claim, or (b) not " +
        "producible in this cycle (the baseline has no runnable implementation, the metric is not measurable with this " +
        "setup, the condition needs scenes/data that do not exist here). If ANY blocking item is (b), NARROW the claim " +
        "until every remaining required item is feasible, and say in `rationale` what you cut. Look at " +
        "`validation_results` before you decide: a completed run that established a smaller claim cleanly is worth far " +
        "more than a broad claim with nothing under it — a claim whose required evidence cannot be produced scores as " +
        "UNSUPPORTED however good the experiment beneath it. Where the method demonstrably FAILS is part of the result " +
        "and belongs in the narrowed claim as its boundary, not hidden. Cut GENERALITY only (fewer conditions, one " +
        "baseline family, an explicitly bounded regime) and NEVER the mechanism: the narrowed claim must still assert " +
        "the same idea over ground you can defend, because a claim narrowed into an incremental one still fails the " +
        "novelty bar below. If every missing item is type (a), do NOT shrink a claim you can afford — request the runs. "
      : "";
    actions.push({
      type: "lab_director_requery_followup",
      priority: "high",
      priority_score: 9900,
      preferred_role: "lab-director",
      target_rubric: "gate_independence",
      target_score: 95,
      current_score: score,
      blocker_reasons: challengeQuestions,
      challenge_questions: challengeQuestions,
      candidate_hypotheses: compactCandidates,
      reasoning_graph: reasoningGraph,
      data_graph: dataGraph,
      open_validation_gaps: compactGaps,
      validation_results: establishedValidationResults,
      lead_supersession: leadSupersession || null,
      description:
        antiThrashPrefix +
        retainedStrengths +
        claimScopeRule +
        (falsificationReplacementPending
          ? "respond to the independent gate review by recording the replacement method and its accountable research question. "
          : "respond to the independent gate review and IMPROVE the lead using the reviewer's specific feedback. ") +
        "HARD-GATE RULE: the gate is a per-rubric bar — EVERY rubric (including novelty and impact) must " +
        `independently reach the threshold (${GATE_THRESHOLD}). A hypothesis that scores high on technical quality, ` +
        "reproducibility, and clarity but LOW on novelty CANNOT pass, no matter how robustly it validates. So " +
        "retreating to a safe, cleanly-validated but incremental idea is a GUARANTEED gate failure and a dead " +
        "end — a low-novelty lead is NOT progress even if every other rubric is perfect. Whichever rubric is " +
        "the current binding constraint is the ONLY thing that matters this round; if that is novelty/impact, a " +
        "robust validation of an incremental idea does not help. " +
        // When the ledger DENIES a pivot, the novelty objection must be answered by
        // escalating THIS lead in place — telling the director to author a new
        // hypothesis here is what churned every improving lead (cycle-g-v56). The
        // author-a-new-hypothesis escalation applies only once the ledger permits
        // a pivot (lead stalled, or a strictly better candidate).
        (falsificationReplacementPending
          ? "The completed falsification retired the current METHOD. Do not defend, narrow, or refine that method again. " +
            "Instead, emit `replacement_hypotheses` with `research_problem_question` and `methods_tried` so the " +
            "question-accountability guard can evaluate and release the replacement. "
          : ledgerDeniesPivot
          ? "If the blocking objections are about NOVELTY or IMPACT, escalate novelty IN PLACE on THIS lead as " +
            "instructed above (mechanism sharpening, head-to-head against the reviewer's named prior art, " +
            "contribution reframe) — do NOT author a different hypothesis while the ledger protects this one. " +
            "If instead the binding objection is about evidence, reproducibility, or reporting, strengthen " +
            "those with new validation. Each round must measurably close the reviewer's top (binding) " +
            "objection versus the previous round. "
          : "If the blocking objections are about NOVELTY or IMPACT — e.g. the reviewer judged the current lead a " +
            "within-family / incremental / textbook variant rather than a material advance over the surfaced " +
            "state-of-the-art prior art — then defending the same lead or making a minor parameter/controller tweak " +
            "will NOT clear the novelty rubric: author a materially MORE NOVEL hypothesis that directly answers the " +
            "reviewer's objections, drawing on the supplied cross-family / better-alternative candidates and the " +
            "surfaced prior-art baseline, and do NOT resubmit the same-family variant the reviewer already judged " +
            "incremental — accept the extra validation risk of a genuinely novel direction, because a safe " +
            "incremental one can never clear the bar. If instead the binding objection is about evidence, " +
            "reproducibility, or reporting, strengthen those with new validation. Each round must measurably close " +
            "the reviewer's top (binding) objection versus the previous round; defend with NEW evidence, replace, or " +
            "upgrade — but keep escalating toward a genuine state-of-the-art contribution rather than re-defending " +
            "an incremental one."),
    });
  }

  // Restart only when the ledger permits a pivot — see the OWNER DECISION note
  // above. Under a deny, the reject round was already routed into the
  // keep-refining requery; pushing a "restart from scratch" beside it would
  // reintroduce exactly the churn channel this closes.
  if (restartRequested && !ledgerDeniesPivot) {
    actions.push({
      type: "gate_restart_followup",
      priority: "high",
      priority_score: 9950,
      preferred_role: "lab-director",
      target_rubric: "gate_independence",
      target_score: 95,
      current_score: score,
      blocker_reasons: challengeQuestions,
      challenge_questions: challengeQuestions,
      candidate_hypotheses: compactCandidates,
      reasoning_graph: reasoningGraph,
      data_graph: dataGraph,
      open_validation_gaps: compactGaps,
      validation_results: establishedValidationResults,
      description:
        "reject the current lead set and restart hypothesis generation from scratch using the gatekeeper objections, alternative hypotheses, and unresolved validation gaps as the new starting frame. " +
        "Scope the new lead to evidence this cycle can actually produce: check each claim element against `validation_results` (what completed runs already established) and against what an analyst could realistically author next, and state the claim at that scope rather than at the scope you wish were reachable — a restart that re-authors an unrunnable claim spends the remaining budget reaching the same reject.",
    });
  }

  // FIX-AC: apply the pre-gate reporting re-route to EVERY action, not just the
  // aggregateReview.recommended_actions loop above. Conclusion-review-sourced
  // close-out actions (logic_followup/visualization_followup -> author/illustrator
  // for clarity, reporting_followup -> author for STROBE) reach this list through
  // buildGateFollowupActions WITHOUT the re-route, so they keep pointing at
  // POST-gate roles (author/illustrator) that never run before the gate passes —
  // a deadlock: the clarity/STROBE rubrics can't improve, so the gate can't pass,
  // so the post-gate authors never run. Re-route those to pre-gate executors
  // (lab-runner/analyst) so the improvement work can actually run pre-gate. This
  // changes WHO executes the close-out, never the gate verdict or threshold
  // (fail-closed preserved).
  const rerouted = actions.map((item) => {
    const rawRole = String(item.preferred_role || "").trim();
    const remapped = pregateReportingRole(rawRole, item.type);
    if (remapped === rawRole) return item;
    return {
      ...item,
      preferred_role: remapped,
      pre_gate_reporting_reroute: { from: rawRole, to: remapped },
      description: `${item.description || ""} (pre-gate reporting task re-routed from ${rawRole} to ${remapped}: produce the clearer primary/robustness figures and precision/CI reporting the gate requires so the clarity and reporting-completeness blockers can close before final authoring)`,
    };
  });

  return rerouted.filter((item, index, items) =>
    items.findIndex((other) =>
      other.type === item.type &&
      other.preferred_role === item.preferred_role &&
      String(other.target_rubric || "") === String(item.target_rubric || "")
    ) === index,
  ).map(withImpactFirstActionMandate);
}

module.exports = {

  authoritativeGateFollowupActions,

  pregateReportingRole,

  buildChallengeQuestions,

  retainedStrengthsPrefix,

  buildGateFollowupActions,

  buildLabDirectorBlockerReviewActions,

  compactGateValidationResults,

  gateActionPriorityScore,

  leadProtectionPrefix,

  takeCandidateHypotheses,

  takeOpenValidationGaps,

};
