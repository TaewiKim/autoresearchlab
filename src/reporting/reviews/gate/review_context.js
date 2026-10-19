"use strict";

const fs = require("fs");
const path = require("path");
const { classifyReviewBlockers } = require("../../research_note_utils");
const { readJsonIfExistsBounded } = require("./io");
const { asArray, compactText, hasForeignOnlyGeoAccessions, uniqueStrings } = require("./utils");

const { POLICY_VERSION, hash, filterScreenedEvidence, screeningEvidenceFields, splitEvidenceTracks } = require("../../../policy/literature_screening");
const { chronicleRelevanceDecision } = require("../../../agents/chronicle/literature_synthesis");
const { reviewMatchesSelectedLead } = require("../../../agents/shared/lead_evidence_match");

function filterPapersToChronicleRelevance(papers, { root, cycleId, objective = "" } = {}) {
  const screened = filterScreenedEvidence(papers, { objective });
  const decision = chronicleRelevanceDecision(root, cycleId);
  if (decision.mode === "none") return screened;
  const key = (paper) => paper.doi
    ? "doi:" + String(paper.doi).trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    : "title:" + String(paper.title || "").trim().toLowerCase().replace(/\s+/g, " ");
  return screened.filter((paper) => decision.mode === "admit" ? decision.keys.has(key(paper)) : !decision.keys.has(key(paper)));
}

function reviewCommentText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  const direct = item.comment || item.summary || item.issue || item.reason || item.description;
  const parts = [
    direct,
    ...asArray(item.concerns),
    ...asArray(item.required_revisions),
    ...asArray(item.suggested_additional_analysis),
    ...asArray(item.reasons),
  ];
  return uniqueStrings(parts).join(" | ");
}

function pushReviewComments(rows, values, source, defaults = {}) {
  for (const item of asArray(values)) {
    const comment = compactText(reviewCommentText(item));
    if (!comment) continue;
    const object = item && typeof item === "object" ? item : {};
    rows.push({
      source,
      rubric: object.rubric || object.rubric_item || object.name || defaults.rubric || null,
      section: object.section || defaults.section || null,
      comment_id: object.comment_id || object.id || defaults.comment_id || null,
      severity: object.severity || defaults.severity || "blocking",
      score: object.score ?? defaults.score ?? null,
      comment,
      required_revisions: asArray(object.required_revisions).map((value) => compactText(value, 180)).slice(0, 3),
    });
  }
}

function collectPreviousReviewContext({
  root,
  cycleId,
  previousGateReview,
  conclusion,
  approval,
  reportReview,
  paperReview,
  currentHypothesisIdentity = null,
}) {
  const rows = [];
  const unresolved = [];
  const lead = { family: currentHypothesisIdentity?.primary_family, datasets: new Set(currentHypothesisIdentity?.dataset_keys || []) };
  const supersededSources = [];
  const scope = (review, source) => {
    if (!review || reviewMatchesSelectedLead(review, lead)) return review;
    supersededSources.push({ source, reason: "review was not bound to the selected family and dataset" });
    return null;
  };
  previousGateReview = scope(previousGateReview, "previous_gate_review");
  conclusion = scope(conclusion, "conclusion_review");
  approval = scope(approval, "approval_review");
  const previousGateReviewPath = path.join(root, "state", `${cycleId}-gate-review.json`);
  pushReviewComments(rows, previousGateReview?.scientific_gate_comments, "previous_gate_review");
  pushReviewComments(rows, previousGateReview?.challenge_questions, "previous_gate_review", { severity: "blocking" });
  pushReviewComments(rows, previousGateReview?.blockers, "previous_gate_review", { severity: "blocking" });
  pushReviewComments(rows, previousGateReview?.pending_rubric_blockers, "previous_gate_review", { severity: "blocking" });
  for (const review of asArray(previousGateReview?.gatekeeper_reviews_normalized).concat(asArray(previousGateReview?.gatekeeper_reviews))) {
    pushReviewComments(rows, review?.major_objections, "previous_gatekeeper_lane", {
      rubric: review?.focus_rubric || review?.reviewer_focus_rubric || null,
      severity: "blocking",
    });
    pushReviewComments(rows, review?.missing_validations, "previous_gatekeeper_lane", {
      rubric: review?.focus_rubric || review?.reviewer_focus_rubric || "reproducibility",
      severity: "blocking",
    });
    pushReviewComments(rows, review?.required_response_from_lab_director, "previous_gatekeeper_lane", {
      rubric: review?.focus_rubric || review?.reviewer_focus_rubric || null,
      severity: "blocking",
    });
    pushReviewComments(rows, review?.switch_triggers, "previous_gatekeeper_lane", {
      rubric: review?.focus_rubric || review?.reviewer_focus_rubric || "impact",
      severity: "blocking",
    });
  }
  for (const action of asArray(previousGateReview?.recommended_followup_actions)) {
    pushReviewComments(rows, action?.blocker_reasons, "previous_gate_followup_action", {
      rubric: action?.target_rubric || null,
      severity: "blocking",
    });
    pushReviewComments(rows, action?.challenge_questions, "previous_gate_followup_action", {
      rubric: action?.target_rubric || null,
      severity: "blocking",
    });
  }

  pushReviewComments(rows, conclusion?.conclusion_blockers, "current_conclusion_review");
  pushReviewComments(rows, approval?.approval_blockers || approval?.blockers, "current_approval_review");
  pushReviewComments(rows, paperReview?.paper_blockers || paperReview?.blockers, "paper_review");
  pushReviewComments(rows, paperReview?.paper_review_comments || paperReview?.section_review_comments, "paper_review");
  pushReviewComments(rows, reportReview?.report_blockers || reportReview?.blockers, "report_review");
  pushReviewComments(rows, reportReview?.report_review_comments || reportReview?.section_review_comments, "report_review");

  const scopedRows = rows.filter((row) =>
    !hasForeignOnlyGeoAccessions(row.comment, currentHypothesisIdentity?.accessions || []),
  );

  for (const item of scopedRows) {
    if (item.severity === "blocking" || /block|unresolved|missing|reject|insufficient|weak/i.test(item.comment)) {
      unresolved.push(item.comment);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const row of scopedRows) {
    const key = `${row.source}::${row.rubric || ""}::${row.comment}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const unresolvedClassification = classifyReviewBlockers(unresolved, {
    hasLeadHypothesis: rows.some((row) => /lead .*exists|hypothesis.*exists|selected fetched bundle|validation artifacts are present/i.test(row.comment)),
    hasDataset: rows.some((row) => /GSE|dataset|fetched bundle|same-dataset paper/i.test(row.comment)),
    hasValidationEvidence: rows.some((row) => /runner|validation artifacts|validation evidence|LOOCV|AUC/i.test(row.comment)),
    currentLeadAccessions: currentHypothesisIdentity?.accessions || [],
    currentLeadText: currentHypothesisIdentity?.primary_text || currentHypothesisIdentity?.text || "",
  });

  return {
    source: "gate_review_memory",
    superseded_review_sources: supersededSources,
    required_for_gatekeeper: true,
    previous_gate_review_path: fs.existsSync(previousGateReviewPath) ? previousGateReviewPath : null,
    review_comments: deduped.slice(0, 20),
    unresolved_blockers: unresolvedClassification.active_blockers.slice(0, 12),
    resolved_or_superseded_blockers: unresolvedClassification.resolved_or_superseded_blockers.slice(0, 12),
    communication_quality: {
      stale_blocker_count: unresolvedClassification.stale_blocker_count,
      duplicate_blocker_count: unresolvedClassification.duplicate_blocker_count,
      active_blocker_count: unresolvedClassification.active_blocker_count,
    },
    reviewer_instruction:
      "Before scoring, check whether each prior scientific review comment is resolved, still blocking, or superseded by stronger Chronicle/literature evidence.",
  };
}

function normalizePaperItem(item, source = null) {
  if (!item || typeof item !== "object") return null;
  const title = compactText(item.title || item.paper_title || item.name || item.citation_title || "", 220);
  const doi = compactText(item.doi || item.DOI || "", 140);
  const paperId = compactText(
    item.paper_id || item.citation_id || item.pmid || item.pmcid || ((title || doi) ? item.id : "") || "",
    120,
  );
  if (!title && !paperId && !doi) return null;
  return {
    ...screeningEvidenceFields(item),
    title: item.title || title || null,
    paper_id: paperId || null,
    year: item.year || item.publication_year || item.pub_year || null,
    doi: doi || null,
    venue: compactText(item.venue || item.journal || item.source || "", 160) || null,
    url: item.url || item.source_url || null,
    source,
  };
}

function collectKnownPaperItems(value, source = "chronicle", limit = 12) {
  const papers = [];
  const seen = new Set();
  const add = (items, itemSource) => {
    for (const item of asArray(items).slice(0, limit)) {
      const paper = normalizePaperItem(item, itemSource);
      if (!paper) continue;
      const key = String(paper.doi || paper.title || paper.paper_id || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      papers.push(paper);
      if (papers.length >= limit) return;
    }
  };
  if (!value || typeof value !== "object") return papers;
  add(value.papers, source);
  add(value.top_papers, source);
  add(value.recent_frontier_papers, source);
  add(value.established_impact_papers, source);
  add(value.citation_ledger, source);
  add(value.references, source);
  add(value.writing_loop?.citation_ledger, "writing_loop.citation_ledger");
  add(value.writing_loop?.top_papers, "writing_loop.top_papers");
  add(value.writing_loop?.verified_citations, "writing_loop.verified_citations");
  for (const lane of asArray(value.lanes).slice(0, 8)) {
    add(lane?.papers, "literature_lane.papers");
    add(lane?.top_papers, "literature_lane.top_papers");
    add(lane?.writing_loop?.citation_ledger, "literature_lane.citation_ledger");
    if (papers.length >= limit) break;
  }
  return papers.slice(0, limit);
}

/**
 * A bounded projection of one survey list, keeping the fields a reviewer scores.
 *
 * Flattening these into a string list was the alternative and it loses the link
 * the score depends on: which method was proposed against which problem, and
 * what its own authors said it could not do.
 */
function compactSurveyEntries(entries, fields, limit) {
  return asArray(entries)
    .slice(0, limit)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const out = {};
      for (const field of fields) {
        const value = entry[field];
        if (Array.isArray(value)) {
          const items = value.map((item) => compactText(item, 120)).filter(Boolean).slice(0, 6);
          if (items.length) out[field] = items;
        } else {
          const text = compactText(value, 240);
          if (text) out[field] = text;
        }
      }
      return Object.keys(out).length ? out : null;
    })
    .filter(Boolean);
}

function compactTrendValues(values, limit = 12) {
  return uniqueStrings(
    asArray(values).map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return (
        item.label ||
        item.cluster ||
        item.topic ||
        item.name ||
        item.summary ||
        item.gap ||
        item.mechanism ||
        item.method ||
        item.rationale ||
        JSON.stringify(item).slice(0, 240)
      );
    }),
  ).map((item) => compactText(item, 240)).slice(0, limit);
}

function literatureGraphDigest(graph) {
  if (!graph || typeof graph !== "object") return null;
  const nodes = asArray(graph.nodes);
  const edges = asArray(graph.edges);
  return {
    node_count: nodes.length || Number(graph.node_count || 0),
    edge_count: edges.length || Number(graph.edge_count || 0),
    top_concepts: nodes
      .map((item) => item?.label || item?.name || item?.node_id || item?.id)
      .filter(Boolean)
      .slice(0, 12),
    evidence_edge_examples: edges
      .map((item) => ({
        source: item?.source || item?.from || null,
        target: item?.target || item?.to || null,
        relation: item?.relation || item?.type || null,
        paper_ids: asArray(item?.paper_ids || item?.supporting_paper_ids).slice(0, 4),
      }))
      .slice(0, 8),
  };
}

function collectChronicleResearchContext({ root, cycleId, researcherView, summary }) {
  const trendSummaryPath = path.join(root, "state", `${cycleId}-trend-summary.json`);
  const trendAnalysisPath = path.join(root, "state", `${cycleId}-research-trend-analysis.json`);
  const literaturePath = path.join(root, "plans", `${cycleId}-lab-director-literature.json`);
  const literatureGraphPath = path.join(root, "state", `${cycleId}-literature-graph.json`);
  const trendSummary = readJsonIfExistsBounded(trendSummaryPath) || {};
  const trendAnalysis = readJsonIfExistsBounded(trendAnalysisPath) || {};
  const literature = readJsonIfExistsBounded(literaturePath) || {};
  const literatureGraph = readJsonIfExistsBounded(literatureGraphPath) || {};
  const chronicle =
    researcherView?.chronicle_reporting ||
    researcherView?.summary?.chronicle_reporting ||
    summary?.chronicle_reporting ||
    {};
  const papers = []
    .concat(collectKnownPaperItems(literature, "lab_director_literature", 10))
    .concat(collectKnownPaperItems(trendSummary, "trend_summary", 6))
    .concat(collectKnownPaperItems(trendAnalysis, "research_trend_analysis", 6))
    .concat(collectKnownPaperItems(literatureGraph, "literature_graph", 6));
  const dedupedPapers = [];
  const seenPapers = new Set();
  for (const paper of papers) {
    const key = String(paper.doi || paper.title || paper.paper_id || "").toLowerCase();
    if (!key || seenPapers.has(key)) continue;
    seenPapers.add(key);
    dedupedPapers.push(paper);
  }
  // Apply Chronicle's relevance verdict so an off-domain corpus does not
  // contaminate the novelty judgment (gatekeeper finding). The decision is
  // Chronicle's; this only enforces it.
  let objective = "";
  try { objective = fs.readFileSync(path.join(root, "plans", cycleId + "-prompt.txt"), "utf8"); } catch {}
  const domainPapers = filterPapersToChronicleRelevance(dedupedPapers, { root, cycleId, objective });
  // Legacy trend/graph text lacks paper-level review receipts. Do not pass it
  // back as evidence merely because one reviewed paper exists elsewhere.
  const screenedSummary = literature.literature_screening?.policy_version === POLICY_VERSION
    && (!objective || literature.literature_screening.objective_hash === hash(objective));
  const searchAgentContract = literature.search_agent_contract && typeof literature.search_agent_contract === "object"
    ? literature.search_agent_contract
    : null;
  const searchAgentPending = searchAgentContract?.applicable === true && searchAgentContract.decision_ready !== true;
  const sourcePaths = {
    trend_summary_path: fs.existsSync(trendSummaryPath) ? trendSummaryPath : null,
    research_trend_analysis_path: fs.existsSync(trendAnalysisPath) ? trendAnalysisPath : null,
    lab_director_literature_path: fs.existsSync(literaturePath) ? literaturePath : null,
    literature_graph_path: fs.existsSync(literatureGraphPath) ? literatureGraphPath : null,
  };
  return {
    source: "chronicle",
    required_for_gatekeeper: true,
    source_paths: sourcePaths,
    missing_sources: Object.entries(sourcePaths)
      .filter(([, value]) => !value)
      .map(([key]) => key),
    what_changed_since_previous_pass: compactTrendValues(chronicle.what_changed_since_previous_pass || trendSummary.what_changed_since_previous_pass, 8),
    latest_high_signal_lane_ids: asArray(chronicle.latest_high_signal_lane_ids || trendSummary.latest_high_signal_lane_ids).slice(0, 8),
    approval_blockers: compactTrendValues(chronicle.approval_blockers || trendSummary.approval_blockers || trendSummary.blockers, 8),
    open_questions: compactTrendValues(chronicle.open_questions || trendSummary.open_questions || trendSummary.open_gaps || trendAnalysis.underexplored_gaps, 8),
    recommended_actions: compactTrendValues(chronicle.recommended_actions || trendSummary.recommended_actions, 8),
    dominant_mechanisms: screenedSummary && !searchAgentPending ? compactTrendValues(chronicle.dominant_mechanisms || trendSummary.dominant_mechanisms, 8) : [],
    latest_research_trends: screenedSummary && !searchAgentPending ? compactTrendValues([
      ...asArray(trendSummary.cluster_labels),
      ...asArray(trendSummary.rising_methodologies),
      ...asArray(trendSummary.saturated_baselines),
      ...asArray(trendSummary.open_gaps),
      ...asArray(trendAnalysis.dominant_clusters),
      ...asArray(trendAnalysis.rising_methods),
      // Both names. The prompt now asks for `repeated_datasets`; every trend
      // analysis recorded before that asked for `repeated_datasets_or_cohorts`,
      // and dropping the old key would silently blank that field for every
      // cycle already on disk.
      ...asArray(trendAnalysis.repeated_datasets),
      ...asArray(trendAnalysis.repeated_datasets_or_cohorts),
      ...asArray(trendAnalysis.saturated_baselines),
      ...asArray(trendAnalysis.underexplored_gaps),
      ...asArray(trendAnalysis.selection_implications),
    ], 14) : [],
    // The survey the director built, kept STRUCTURED rather than flattened into
    // latest_research_trends. Novelty is scored as "does this lead answer an
    // open problem, and is its method different from the ones already proposed
    // against it" -- a reviewer cannot ask that of a list of topic strings.
    open_problems: compactSurveyEntries(trendAnalysis.open_problems, [
      "problem", "why_open", "decisive_quantity", "status", "paper_ids",
    ], 8),
    proposed_methods: compactSurveyEntries(trendAnalysis.proposed_methods, [
      "method", "addresses_problem", "what_it_does_differently", "claimed_improvement",
      "compared_against", "evaluated_on", "stated_limitation", "paper_ids",
    ], 10),
    survey_coverage_gaps: compactTrendValues(trendAnalysis.survey_coverage_gaps, 6),
    latest_papers: domainPapers.slice(0, 12),
    ...splitEvidenceTracks(domainPapers),
    literature_graph_digest: screenedSummary && !searchAgentPending ? literatureGraphDigest(literatureGraph) : null,
    literature_screening_status: domainPapers.length && !searchAgentPending ? "screened" : "insufficient_corpus",
    search_agent_contract: searchAgentContract,
    reviewer_instruction:
      searchAgentPending
        ? "Accepted papers remain available for audit, but the adaptive search-agent contract is incomplete. Leave novelty and decision readiness undetermined; request the contract gaps before promotion."
        : "Only latest_papers that passed abstract review are evidence. Verify trend claims against those paper IDs; do not reuse legacy unscreened text. If the corpus is insufficient, leave novelty undetermined and request targeted retrieval.",
  };
}

function compactPreviousReviewSummary(previousReviewContext) {
  if (!previousReviewContext || typeof previousReviewContext !== "object") {
    return { review_comments: [], unresolved_blockers: [] };
  }
  return {
    review_comments: asArray(previousReviewContext.review_comments).slice(0, 10).map((item) => ({
      source: item?.source || null,
      rubric: item?.rubric || null,
      severity: item?.severity || null,
      score: item?.score ?? null,
      comment: compactText(item?.comment || item?.summary || item?.reason || "", 260) || null,
      required_revisions: asArray(item?.required_revisions).map((value) => compactText(value, 160)).slice(0, 2),
    })).filter((item) => item.comment),
    unresolved_blockers: asArray(previousReviewContext.unresolved_blockers)
      .map((item) => compactText(item, 220))
      .filter(Boolean)
      .slice(0, 8),
  };
}

function compactReferenceLiteratureSummary(chronicleResearchContext) {
  if (!chronicleResearchContext || typeof chronicleResearchContext !== "object") {
    return { latest_papers: [], literature_baseline_notes: [] };
  }
  return {
    latest_papers: asArray(chronicleResearchContext.latest_papers).slice(0, 8).map((paper) => ({
      title: compactText(paper?.title || "", 180) || null,
      year: paper?.year || null,
      venue: compactText(paper?.venue || "", 120) || null,
      doi: paper?.doi || null,
      paper_id: paper?.paper_id || null,
      source: paper?.source || null,
      quality_tracks: paper?.literature_screening?.quality?.tracks || [],
      abstract_relevance: paper?.literature_screening?.review?.direct_relevance_reason || null,
      study_limitations: paper?.literature_screening?.review?.limitations || null,
    })).filter((paper) => paper.title || paper.doi || paper.paper_id),
    literature_baseline_notes: uniqueStrings([
      ...asArray(chronicleResearchContext.latest_research_trends),
      ...asArray(chronicleResearchContext.dominant_mechanisms),
      ...asArray(chronicleResearchContext.open_questions),
      ...asArray(chronicleResearchContext.approval_blockers),
    ]).map((item) => compactText(item, 220)).slice(0, 10),
    literature_graph_digest: chronicleResearchContext.literature_graph_digest
      ? {
          node_count: chronicleResearchContext.literature_graph_digest.node_count || 0,
          edge_count: chronicleResearchContext.literature_graph_digest.edge_count || 0,
          top_concepts: asArray(chronicleResearchContext.literature_graph_digest.top_concepts).slice(0, 8),
        }
      : null,
  };
}

function attachGateReviewerContextsToActions(actions, { previousReviewContext, chronicleResearchContext }) {
  const previousReviewSummary = compactPreviousReviewSummary(previousReviewContext);
  const referenceLiteratureSummary = compactReferenceLiteratureSummary(chronicleResearchContext);
  return asArray(actions).map((item) => {
    const role = String(item?.preferred_role || "").trim();
    const type = String(item?.type || "").trim();
    if (role !== "gatekeeper" && type !== "independent_gate_review_followup") return item;
    // Gatekeeper followups should receive compact scientific context, not raw
    // multi-MB review/literature artifacts. Keep the reviewer grounded with
    // hypotheses, validation evidence, reference-literature summary, and prior
    // review outcomes while avoiding full Chronicle graphs or open-gap dumps.
    const blockerReviewRequests = asArray(item.lab_director_blocker_review_requests)
      .filter((request) => request && typeof request === "object" && request.blocker)
      .slice(0, 6);
    const gateReviewerInstructions = [
      "Score the target rubric using the supplied candidate_hypotheses, validation_results, reference_literature_summary, and previous_review_summary.",
      // CALIBRATION (owner decision 2026-07-06): score on a REALISTIC peer-review
      // 0-100 scale. The pass bar is 80 (owner decision 2026-07-15; was 90). Anchors: 80-100 = clearly good, defensible
      // -quality work on this dimension — correct, adequately supported, reproducible,
      // clearly communicated, and a genuine contribution; this is the EXPECTED score
      // for solid, competent research, NOT a reward reserved for flawless or
      // paradigm-shifting work. 70-79 = real merit but a specific, fixable gap.
      // Below 70 = a genuine disqualifying flaw on this dimension (unsound method,
      // missing/irreproducible evidence, off-topic/absent prior-art baseline for
      // novelty, or a claim that merely restates established textbook prior art).
      // Do NOT deflate a sound, well-executed, reproducible result into the 50s-60s
      // merely because it is incremental, not perfect, or not revolutionary — judge
      // it on whether the dimension is actually met, and reserve sub-70 scores for a
      // real defect you can name. For novelty specifically, 80 means a clear genuine
      // contribution beyond the RELEVANT on-topic prior art (a new method, analysis,
      // combination, or result not already established) — it need not be a paradigm
      // shift; still require a relevant on-topic baseline (never score novelty high on
      // an off-topic/mismatched paper set).",
      "Set your verdict from the target rubric score: score >= 80 with no nameable disqualifying flaw => \"approve\"; 70-79 (real but fixable gap) => \"challenge\"; below 70 (genuine unsoundness, missing evidence, off-topic baseline, or restated textbook prior art) => \"reject\". Be decisive: if the dimension is genuinely met at a clearly-good, defensible level, approve it — do not withhold approval for perfectionism.",
      "Treat unresolved previous review comments as still blocking unless the validation results directly resolve them.",
      "Use the reference literature summary to judge novelty/impact baselines, but do not request or infer unprovided full-text context.",
    ];
    if (blockerReviewRequests.length > 0) {
      gateReviewerInstructions.push(
        "LabDirector has challenged one or more unresolved blockers. Independently adjudicate each challenged blocker in blocker_adjudications as uphold, remove, downgrade, resolved, or superseded; never remove a blocker merely because LabDirector asks.",
      );
    }
    return {
      ...item,
      previous_review_summary: previousReviewSummary,
      reference_literature_summary: referenceLiteratureSummary,
      lab_director_blocker_review_requests: blockerReviewRequests,
      previous_review_context: {
        required_for_gatekeeper: true,
        ...previousReviewSummary,
      },
      chronicle_research_context: {
        required_for_gatekeeper: true,
        ...referenceLiteratureSummary,
      },
      reviewer_must_read_context: [
        "candidate_hypotheses",
        "validation_results",
        "reference_literature_summary",
        "previous_review_summary",
        "previous_review_context",
        "chronicle_research_context",
        ...(blockerReviewRequests.length > 0 ? ["lab_director_blocker_review_requests"] : []),
      ],
      gate_reviewer_instructions: gateReviewerInstructions,
    };
  });
}

module.exports = {

  attachGateReviewerContextsToActions,

  collectChronicleResearchContext,

  collectPreviousReviewContext,
  filterPapersToChronicleRelevance,

};
