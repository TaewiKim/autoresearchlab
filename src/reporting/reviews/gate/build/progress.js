"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonIfExists: readJsonIfExistsSafe } = require("../../../final_claim_package");
const { readJsonIfExistsBounded } = require("../io");
const hypothesisProgress = require("../../../hypothesis_progress");
const { currentAnalysisContract } = require("../../../../policy/analysis_contract");
const {
  asArray,
  averageApplicableRubricScore,
  collectSearchText,
  extractGeoAccessions,
  hasForeignOnlyGeoAccessions,
  rubricBlockerReasons,
  uniqueStrings,
} = require("../utils");
const {
  isFailedExecutionNotEvidence,
  selectedLeadIdentity,
  pickLeadScopedRunner,
  runnerLeadMatchScore,
  datasetKeys,
} = require("../../../../agents/shared/lead_evidence_match");

function gateProgressSignals(summary, options = {}) {
  const primaryValidation = readPrimaryValidationEvidence(summary);
  const leadIdentity = selectedLeadIdentity(options?.root, options?.cycleId, summary);
  const latestRunnerValidation = readLatestRunnerValidationEvidence({ ...options, leadIdentity });
  const scopedPrimary = primaryValidation && !isFailedExecutionNotEvidence(primaryValidation.result)
    && (leadIdentity.datasets?.size
      ? runnerLeadMatchScore(primaryValidation.result, leadIdentity) >= 3
      : runnerLeadMatchScore(primaryValidation.result, leadIdentity) !== 0)
    ? primaryValidation : null;
  const validationEvidence = newestValidationEvidence(scopedPrimary, latestRunnerValidation);
  const text = collectSearchText({
    lead_outcome: summary?.lead_outcome,
    lead_outcome_label: summary?.lead_outcome_label,
    strongest_claim_summary: summary?.strongest_claim_summary,
    focus_hypotheses: summary?.focus_hypotheses,
    derivable_hypothesis_candidates: summary?.derivable_hypothesis_candidates,
    primary_evidence: summary?.primary_evidence,
    primary_validation: validationEvidence?.validation_summary,
    validation_results: summary?.validation_results,
    evidence_checkpoints: summary?.evidence_checkpoints,
    data_acquisition: summary?.data_acquisition,
    source_paths: summary?.source_paths,
    open_validation_gaps: summary?.open_validation_gaps,
  });
  const focusHypotheses = asArray(summary?.focus_hypotheses || summary?.hypotheses);
  const candidateHypotheses = asArray(summary?.derivable_hypothesis_candidates);
  const validationResults = asArray(summary?.validation_results?.validation_results || summary?.validation_results);
  const evidencePackets = asArray(summary?.evidence_packets || summary?.primary_evidence);
  const hasLeadHypothesis =
    focusHypotheses.length > 0 ||
    candidateHypotheses.length > 0 ||
    /lead_outcome|primary signal|lead hypothesis|focus hypothes|promoted hypothes/i.test(text);
  const hasDataset =
    /GSE\d+|GEO|dataset|fetched bundle|series matrix|cellxgene|sample metadata|expression matrix/i.test(text);
  const hasValidationEvidence =
    summary?.evidence_readiness?.ready === true ||
    validationResults.length > 0 ||
    evidencePackets.length > 0 ||
    /validation result|validation artifact|LOOCV|AUC|permutation|bootstrap|runner artifact|analysis trace/i.test(text);
  const checks = primaryValidation?.validation_summary?.checks || {};
  const hasPublishedEightGeneAudit = Boolean(
    checks.exact_8gene_panel_mapped === true &&
      checks.panel_cv_computed === true &&
      checks.material_drop_from_published_auc === true,
  );
  return {
    hasLeadHypothesis,
    hasDataset,
    hasValidationEvidence,
    hasPublishedEightGeneAudit,
    latestValidationLaneId: validationEvidence?.lane_id || null,
    latestValidationMtime: validationEvidence?.mtime || null,
    latestValidationSummary: validationEvidence?.validation_summary || null,
    latestValidationLeadMatchScore: validationEvidence
      ? runnerLeadMatchScore(validationEvidence.result, leadIdentity)
      : null,
    latestValidationProducedEvidence: validationEvidence
      ? validationEvidence.produced_evidence ?? executionsProducedEvidence(validationEvidence.result)
      : null,
    latestValidationArtifactPaths:
      validationEvidence?.artifact_paths
      || runnerArtifactPaths(validationEvidence?.result)
      || [],
    text,
  };
}

// Whether the run's executions measured anything, in the words of the driver
// that ran them (python_stats_lib _execution_produced_evidence): true or false
// when the executions say, null when they carry no flag. The dispatcher's hold
// on gate re-reviews (dependency_gates_01, waiting-for-new-lead-evidence) reads
// the same flag, and the two must agree; see isSupersededByNewerValidationEvidence.
function executionsProducedEvidence(result) {
  const executions = Array.isArray(result?.blueprint_executions) ? result.blueprint_executions : [];
  const flagged = executions.filter((item) => typeof item?.produced_evidence === "boolean");
  if (flagged.length === 0) return null;
  return flagged.some((item) => item.produced_evidence === true);
}

// The newest validation, if it belongs to the lead now selected: finished after
// that lead was selected. A validation from before the selection is the previous
// lead's (see the leadValidationSummary call in gate/build.js); null when it is.
function validationOfCurrentLead({ root, cycleId, progressSignals, currentLeadKey = null }) {
  let selectedMs = 0;
  try {
    const lead = JSON.parse(fs.readFileSync(path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`), "utf8"));
    selectedMs = Number(lead?.selected_at_epoch_ms) || 0;
  } catch {
    selectedMs = 0;
  }
  const validationMs = Number(progressSignals?.latestValidationMtime || 0);
  if (selectedMs > 0 && validationMs > 0 && validationMs <= selectedMs) return null;
  const summary = progressSignals?.latestValidationSummary || null;
  const boundHypothesisIds = [
    summary?.primary_hypothesis_id,
    summary?.handed_hypothesis_id,
    summary?.hypothesis_alignment?.handed_hypothesis_id,
    summary?.hypothesis_alignment?.reported_as,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  // MEASURED ON cycle-a-20260919, 2026-10-09: runners 207 and 208
  // explicitly bound their valid pilot falsification to hyp:8dfa8dc457fa6bfe,
  // but their analyst-authored family label differed from the director's family.
  // The family matcher therefore scored them zero and the novelty window kept
  // the falsified lead at lead_selected through 27 completed followups. An exact
  // driver-recorded hypothesis binding is stronger than that prose taxonomy.
  const explicitlyBound = Boolean(currentLeadKey)
    && boundHypothesisIds.includes(String(currentLeadKey).trim());
  // MEASURED ON cycle-a-20260919, 2026-10-07: the explicitly
  // loss/refinement runner-181 finished after the coverage/diversity lead was
  // selected. Recency alone retired the new lead and reopened owner_selection.
  if (!explicitlyBound && progressSignals?.latestValidationLeadMatchScore === 0) return null;
  return summary;
}

function newestValidationEvidence(...items) {
  return items
    .filter(Boolean)
    .sort((left, right) =>
      Number(right.mtime || 0) - Number(left.mtime || 0) ||
      naturalLaneNumber(right.lane_id) - naturalLaneNumber(left.lane_id) ||
      String(right.lane_id || "").localeCompare(String(left.lane_id || "")),
    )[0] || null;
}

function naturalLaneNumber(laneId) {
  const match = String(laneId || "").match(/-(\d+)(?:-|$)/g);
  if (!match || match.length === 0) return 0;
  const last = match.at(-1).match(/\d+/);
  return last ? Number(last[0]) : 0;
}

function readPrimaryValidationEvidence(summary) {
  const resultPath = String(summary?.primary_evidence?.source_result_path || "").trim();
  if (!resultPath) return null;
  const result = readJsonIfExistsBounded(resultPath, 10 * 1024 * 1024);
  const validationSummary = result?.validation_summary && typeof result.validation_summary === "object"
    ? result.validation_summary
    : result?.overall_status && result?.checks && typeof result.checks === "object"
      ? result
    : null;
  if (!validationSummary) return null;
  let mtime = null;
  try {
    mtime = fs.statSync(resultPath).mtimeMs;
  } catch {}
  return {
    lane_id: summary?.primary_evidence?.lane_id || path.basename(path.dirname(resultPath)),
    result_path: resultPath,
    mtime,
    validation_summary: validationSummary,
    result,
    produced_evidence: executionsProducedEvidence(result),
  };
}

// The paths to what a run actually produced: the per-blueprint tables and
// figures, plus the directory holding them.
//
// The reproducibility rubric asks for these by name and cycle-g-v89 capped at
// 55-68 without them, while 182 CSVs and 66 PNGs sat on disk with their absolute
// paths recorded in the very result the gate was already reading. The only
// existing writer of `validation_artifact_paths` stores chronicle's own
// bookkeeping JSON instead, which is not what the objection is about.
function runnerArtifactPaths(result) {
  const paths = [];
  const seen = new Set();
  const push = (kind, name, filePath) => {
    const text = String(filePath || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    paths.push({ kind, name: String(name || "").trim() || null, path: text });
  };
  for (const execution of asArray(result?.blueprint_executions)) {
    if (!execution || typeof execution !== "object") continue;
    for (const table of asArray(execution.tables)) {
      if (table && typeof table === "object") push("table", table.name, table.path);
    }
    for (const figure of asArray(execution.figures)) {
      if (figure && typeof figure === "object") push("figure", figure.name, figure.path);
    }
    push("output_dir", null, execution.output_dir);
  }
  // Bounded: a sweep can emit dozens of tables and the reviewer needs to see that
  // they exist and where, not read all of them. Prompts are already 70-160KB.
  return paths.slice(0, 24);
}

function readLatestRunnerValidationEvidence({ root, cycleId, leadIdentity = null } = {}) {
  if (!root || !cycleId) return null;
  const statsDir = path.join(root, "artifacts", "stats", cycleId);
  if (!fs.existsSync(statsDir)) return null;
  const candidates = [];
  for (const laneId of fs.readdirSync(statsDir)) {
    if (!/^followup-runner-|^lab-runner-/.test(laneId)) continue;
    const laneDir = path.join(statsDir, laneId);
    const resultPath = path.join(laneDir, "result.json");
    const result = readJsonIfExistsBounded(resultPath, 10 * 1024 * 1024);
    const validationSummary = result?.validation_summary && typeof result.validation_summary === "object"
      ? result.validation_summary
      : null;
    if (!validationSummary) continue;
    // A run that measured nothing is not evidence; see lead_evidence_match.
    if (isFailedExecutionNotEvidence(result)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(resultPath).mtimeMs;
    } catch {}
    candidates.push({
      lane_id: laneId,
      result_path: resultPath,
      filePath: resultPath,
      mtime,
      result,
      validation_summary: validationSummary,
    });
  }
  if (candidates.length === 0) return null;
  // Lead-scoped binding (mirrors collectPrimaryEvidenceDetails): prefer the runner
  // whose executed family/statement matches the selected lead; falls back to the
  // newest validation candidate when the lead has no identity, nothing is scopable,
  // or none match (no-regression contract in lead_evidence_match).
  const picked = leadIdentity?.hasIdentity
    ? pickLeadScopedRunner(candidates, leadIdentity)
    : null;
  if (picked) {
    return {
      lane_id: picked.lane_id,
      result_path: picked.result_path,
      mtime: picked.mtime,
      validation_summary: picked.validation_summary,
      result: picked.result,
      artifact_paths: runnerArtifactPaths(picked.result),
      produced_evidence: executionsProducedEvidence(picked.result),
    };
  }
  if (leadIdentity?.datasets?.size) return null;
  const newest = newestValidationEvidence(...candidates);
  if (newest && !newest.artifact_paths) {
    newest.artifact_paths = runnerArtifactPaths(newest.result);
  }
  return newest;
}

const STALE_SETUP_REVIEW_PATTERNS = [
  /\bno lead hypothesis\b/i,
  /\bnothing scientifically falsifiable\b/i,
  /\bno candidate hypotheses\b/i,
  /\bno validation evidence\b/i,
  /\bzero evidence packets\b/i,
  /\bcurrent evidence package is empty\b/i,
  /\bpackage is empty\b/i,
  /\bdataset mandate is unresolved\b/i,
  /\bhas not selected an executable fetched bundle\b/i,
  /\bselect at least one fetched GEO bundle\b/i,
  /\bretrieve same-dataset papers or dataset landing-page provenance\b/i,
  /\bdefine one or more falsifiable lead hypotheses\b/i,
  /\bno falsifiable lead hypothesis\b/i,
  /\bno executable validation result\b/i,
  /\bdoes not select one accession\b/i,
  /\bdoes not select one .* benchmark\b/i,
  /\bsubmission still does not select one accession\b/i,
  /\brequired Chronicle .* context is empty\b/i,
  /\bno same-dataset reference baseline has been extracted\b/i,
];

const STALE_PUBLISHED_EIGHT_GENE_REVIEW_PATTERNS = [
  /\bno exact (?:published )?8[-\s]?gene benchmark\b/i,
  /\bno published 8[-\s]?gene benchmark\b/i,
  /\bexact reproduction of the published 8[-\s]?gene\b/i,
  /\bpublished 8[-\s]?gene .*missing\b/i,
  /\bLOOCV AUC\s*0\.682\b/i,
  /\b0\.682\s+versus\s+0\.712\b/i,
  /\bunderperforms? (?:the )?(?:simpler )?covariate[-\s]?only baseline\b/i,
  /\bsex[-\s]?by[-\s]?diagnosis\b/i,
  /\bsex[-\s]?aware .*?(?:pathway|deconvolution|superiority|structured features)\b/i,
  /\bDESeq2\b/i,
  /\bCIBERSORT\b/i,
  /\bimmune deconvolution\b/i,
  /\bpathway scoring\b/i,
  /\bnested[-\s]?CV (?:model|claim|workflow|uplift|superiority)\b/i,
  /\bsuperiority claim\b/i,
  /\bcorrelation proxy\b/i,
  /\bnon[-\s]?commensurate\b/i,
];

function gatekeeperReviewSearchText(review) {
  return collectSearchText({
    lane_id: review?.lane_id,
    focus_rubric: review?.focus_rubric,
    verdict: review?.verdict,
    summary: review?.summary,
    major_objections: review?.major_objections,
    missing_validations: review?.missing_validations,
    switch_triggers: review?.switch_triggers,
    incumbent_rejection_reasons: review?.incumbent_rejection_reasons,
    required_response_from_lab_director: review?.required_response_from_lab_director,
    rubric: review?.rubric,
  }, 160, 24000);
}

function gatekeeperReviewPrimaryObjectionText(review) {
  return collectSearchText({
    lane_id: review?.lane_id,
    focus_rubric: review?.focus_rubric,
    verdict: review?.verdict,
    major_objections: review?.major_objections,
    incumbent_rejection_reasons: review?.incumbent_rejection_reasons,
    rubric: review?.rubric,
  }, 120, 18000);
}

function stalePublishedEightGeneReviewHits(review) {
  const text = gatekeeperReviewSearchText(review);
  return STALE_PUBLISHED_EIGHT_GENE_REVIEW_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

function isSupersededSetupGatekeeperReview(review, progressSignals) {
  if (
    !progressSignals?.hasLeadHypothesis ||
    !progressSignals?.hasDataset ||
    !progressSignals?.hasValidationEvidence
  ) {
    return false;
  }
  const text = gatekeeperReviewSearchText(review);
  const staleHitCount = STALE_SETUP_REVIEW_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );
  if (staleHitCount < 2) return false;
  const averageScore = averageApplicableRubricScore(review?.rubric);
  const reviewMtime = Number(review?.source_mtime || 0);
  const latestValidationMtime = Number(progressSignals?.latestValidationMtime || 0);
  const olderThanLatestValidation = reviewMtime > 0 && latestValidationMtime > 0 && reviewMtime < latestValidationMtime;
  if (olderThanLatestValidation && staleHitCount >= 3) {
    return averageScore == null || averageScore <= 25;
  }
  return averageScore == null || averageScore <= 8;
}

function isSupersededPublishedEightGeneGatekeeperReview(review, progressSignals, currentIdentity = null) {
  if (!progressSignals?.hasPublishedEightGeneAudit) return false;
  if (
    currentIdentity?.accessions?.length &&
    hasForeignOnlyGeoAccessions(progressSignals?.latestValidationSummary || {}, currentIdentity.accessions)
  ) {
    return false;
  }
  const reviewMtime = Number(review?.source_mtime || 0);
  const latestValidationMtime = Number(progressSignals?.latestValidationMtime || 0);
  if (reviewMtime > 0 && latestValidationMtime > 0 && reviewMtime >= latestValidationMtime) {
    return false;
  }
  const hits = stalePublishedEightGeneReviewHits(review);
  if (hits.length < 2) return false;
  const methodScore = Number(progressSignals?.latestValidationSummary?.method_appropriateness_score);
  const accuracyScore = Number(progressSignals?.latestValidationSummary?.analysis_accuracy_score);
  return (
    !Number.isFinite(methodScore) ||
    methodScore >= 90 ||
    !Number.isFinite(accuracyScore) ||
    accuracyScore >= 90
  );
}

function currentHypothesisIdentity({ root, cycleId, summary }) {
  const hypothesisPath = path.join(root, "state", `${cycleId}-lab-director-hypothesis.json`);
  const currentHypothesis = readJsonIfExistsSafe(hypothesisPath) || {};
  const focusHypotheses = asArray(summary?.focus_hypotheses).map((item) => ({
    statement: item?.statement,
    hypothesis_statement: item?.hypothesis_statement,
    dataset_or_accession: item?.dataset_or_accession,
    selected_accession: item?.selected_accession,
    identification_dataset_or_accession: item?.identification_strategy?.dataset_or_accession,
  }));
  const canonicalText = collectSearchText({
    statement: currentHypothesis.statement,
    hypothesis_statement: currentHypothesis.hypothesis_statement,
    selected_hypothesis_statement: currentHypothesis.selected_hypothesis?.statement,
    selected_hypothesis_dataset_or_accession: currentHypothesis.selected_hypothesis?.dataset_or_accession,
    selected_hypothesis_accession: currentHypothesis.selected_hypothesis?.selected_accession,
    selected_hypothesis_family: currentHypothesis.selected_hypothesis?.primary_family || currentHypothesis.selected_hypothesis?.family_root,
    lead_hypothesis_statement: currentHypothesis.lead_hypothesis?.statement,
    lead_hypothesis_dataset_or_accession: currentHypothesis.lead_hypothesis?.dataset_or_accession,
    dataset_or_accession: currentHypothesis.dataset_or_accession,
    selected_accession: currentHypothesis.selected_accession,
    identification_dataset_or_accession: currentHypothesis.identification_strategy?.dataset_or_accession,
    primary_family: currentHypothesis.primary_family || currentHypothesis.family_root,
  }, 100, 18000);
  const summaryText = collectSearchText({
    summary_selected_accession: summary?.data_acquisition?.selected_accession,
    summary_focus_hypotheses: focusHypotheses,
  }, 60, 10000);
  const canonicalAccessions = extractGeoAccessions(canonicalText);
  const primaryText = canonicalText.trim()
    ? canonicalText
    : collectSearchText({
        canonical_current_lead: canonicalText,
        summary_current_lead_fallback: summaryText,
      }, 120, 20000);
  const primaryAccessions = extractGeoAccessions(primaryText);
  const staleDatasetText = collectSearchText({
    materialized_dataset_accession: currentHypothesis.materialized_dataset?.accession,
    materialized_dataset_candidate_url: currentHypothesis.materialized_dataset?.candidate_url,
    materialized_dataset_bundle_path: currentHypothesis.materialized_dataset?.bundle_path,
    strategy_materialized_dataset: currentHypothesis.identification_strategy?.materialized_dataset,
    dataset_accession: currentHypothesis.dataset?.accession,
  }, 60, 10000);
  const primarySet = new Set(primaryAccessions);
  const staleDatasetAccessions = extractGeoAccessions(staleDatasetText)
    .filter((accession) => !primarySet.has(accession));
  const text = collectSearchText({
    primary_current_lead: primaryText,
    // If the current lead already declares an accession, stale bundle fields
    // are diagnostic only. Do not let them make old-family gate reviews look
    // current after a LabDirector pivot.
    materialized_dataset_context: primaryAccessions.length > 0 ? null : staleDatasetText,
  }, 120, 22000);
  const accessions = primaryAccessions.length > 0
    ? primaryAccessions
    : extractGeoAccessions(text);
  let mtime = 0;
  try {
    mtime = fs.statSync(hypothesisPath).mtimeMs;
  } catch {}
  return {
    source_path: fs.existsSync(hypothesisPath) ? hypothesisPath : null,
    source_mtime: mtime,
    // When this lead was SELECTED -- set when the lead's identity changes and
    // kept when the director upholds it and rewords it, unlike the file's
    // modification time, which moves with every restatement.
    selected_at_ms: Number(currentHypothesis.selected_at_epoch_ms) || 0,
    accessions,
    dataset_keys: [...datasetKeys([
      currentHypothesis.selected_hypothesis?.dataset_or_accession,
      currentHypothesis.selected_hypothesis?.identification_strategy?.dataset_or_accession,
      currentHypothesis.dataset_or_accession,
    ])],
    primary_text: primaryText,
    // The same key the progress ledger uses, so a review can be matched to the
    // lead it was actually briefed on rather than to a vocabulary overlap.
    //
    // hypothesisKey takes an OBJECT, not a statement string. Passing the string
    // silently produced sha256("") — a constant — for every lead, which made the
    // whole briefed-lead check inert (measured on cycle-g-v79: lead_key stayed
    // hyp:e3b0c44298fc1c14 while the artifact held a real statement).
    //
    // The arguments mirror the buildProgressRecord call in build.js so this key
    // tracks the same notion of "one lead" the ledger records.
    // The family the director declared in a FIELD. Reading it here is what stops
    // one idea from being filed as four leads every time the preamble is reworded
    // - see the note in hypothesisKey.
    primary_family:
      currentHypothesis.selected_hypothesis?.primary_family ||
      currentHypothesis.primary_family ||
      currentHypothesis.selected_hypothesis?.family_root ||
      null,
    analysis_contract_id: currentAnalysisContract(root, cycleId)?.contract_id || null,
    lead_key: hypothesisProgress.hypothesisKey({
      hypothesisId:
        currentHypothesis.hypothesis_id ||
        currentHypothesis.selected_hypothesis?.hypothesis_id ||
        null,
      familyRoot: (accessions || [])[0] || null,
      primaryFamily:
        currentHypothesis.selected_hypothesis?.primary_family ||
        currentHypothesis.primary_family ||
        currentHypothesis.selected_hypothesis?.family_root ||
        null,
      statement: primaryText || text || "",
    }),
    ignored_stale_dataset_accessions: staleDatasetAccessions,
    text,
  };
}

const STALE_CURRENT_LEAD_AUDIT_BLOCKER_PATTERNS = [
  /\b8[-\s]?gene\b/i,
  /\bP[-\s]?MCI\b|\bS[-\s]?MCI\b/i,
  /\bpublished AUC\s*0\.93\b/i,
  /\bLOOCV AUC\s*0\.682\b/i,
  /\b0\.682\s+(?:vs|versus)\s+0\.712\b/i,
  /\bage\/sex\b|\bage[-\s]?sex\b|\bcovariate[-\s]?only baseline\b/i,
  /\bsex[-\s]?by[-\s]?diagnosis\b/i,
  /\bCIBERSORT\b|\bleukocyte\b|\bblood[-\s]?cell\b/i,
  /\bsame[-\s]?dataset (?:baseline|paper|reproduction|audit)\b/i,
  /\breproducibility audit\b|\baudit of the published\b/i,
  /\bDESeq2\b.*\bsex\b|\bsex\b.*\bDESeq2\b/i,
  /\bimmune[-\s]?cell deconvolution from (?:the )?(?:open )?.*TPM\b/i,
  /\bnested[-\s]?(?:cross[-\s]?)?validation benchmark of the published\b/i,
  /\bpanel[-\s]?plus[-\s]?covariate\b|\bpublished .*panel\b/i,
  /\bgeneric leukocyte\b|\brepeated[-\s]?subject\b/i,
  /\bthreshold and pancreas\b|\bthreshold\/pancreas\b|\bliterature[-\s]?only threshold\b/i,
  /\bPCA[-\s]?style\b|\bsurrogate PCA\b|\bactual promoted model\b/i,
  /\bretained lead\b.*\bif pivoted\b|\bif (?:you )?pivot(?:ed)? to\b/i,
  /\bmulti[-\s]?omics framing\b|\bsecond modality\b/i,
  /\bexecuted local evidence\b.*\bbaseline\b|\bleakage[-\s]?aware predictive comparison\b/i,
  /\bcross[-\s]?family rivals\b|\bsame[-\s]?paper comparators\b/i,
  /\bpredictor[-\s]?superiority framing\b/i,
];

function mentionsAnyAccession(text, accessions) {
  const mentioned = new Set(extractGeoAccessions(text));
  return (accessions || []).some((accession) => mentioned.has(String(accession || "").toUpperCase()));
}

function mentionsForeignAccession(text, currentAccessions) {
  const current = new Set((currentAccessions || []).map((item) => String(item || "").toUpperCase()).filter(Boolean));
  return extractGeoAccessions(text).some((accession) => !current.has(accession));
}

function currentAccessionMentionsAreOnlyAlternativeContext(text, currentAccessions) {
  const normalized = String(text || "");
  let foundCurrent = false;
  for (const accession of currentAccessions || []) {
    const current = String(accession || "").toUpperCase();
    if (!current) continue;
    const pattern = new RegExp(`\\b${current}\\b`, "gi");
    let match = null;
    while ((match = pattern.exec(normalized)) !== null) {
      foundCurrent = true;
      const start = Math.max(0, match.index - 140);
      const end = Math.min(normalized.length, match.index + current.length + 140);
      const window = normalized.slice(start, end);
      if (!/\bpivot(?:ed|s)?\b|\bcross[-\s]?family\b|\balternative\b|\bswitch\b|\brival\b|\bif (?:you )?pivot\b|\bclearer upside\b|\boffer\b|\brestart\b|\bstale\b|\bnested state\b/i.test(window)) {
        return false;
      }
    }
  }
  return foundCurrent;
}

function distinctiveClaimTokens(value) {
  const stop = new Set([
    "about", "after", "against", "analysis", "claim", "current", "dataset", "effect",
    "evidence", "gate", "hypothesis", "primary", "review", "score", "signal", "study",
    "validation", "versus", "with", "without",
  ]);
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 5 && !stop.has(token) && !/^gse\d+$/i.test(token)),
  );
}

function alignedCurrentHypothesisReviewReason(review, currentIdentity) {
  if (!currentIdentity?.primary_text) return null;
  if (!["approve", "challenge"].includes(String(review?.verdict || "").toLowerCase())) return null;
  const reviewText = gatekeeperReviewSearchText(review);
  if (hasForeignOnlyGeoAccessions(reviewText, currentIdentity.accessions || [])) return null;
  const currentAccessions = currentIdentity.accessions || [];
  const sharesAccession =
    currentAccessions.length === 0 || mentionsAnyAccession(reviewText, currentAccessions);
  if (!sharesAccession) return null;
  const currentTokens = distinctiveClaimTokens(currentIdentity.primary_text);
  const reviewTokens = distinctiveClaimTokens(reviewText);
  const overlap = [...currentTokens].filter((token) => reviewTokens.has(token));
  const requiredOverlap = currentAccessions.length > 0 ? 3 : 6;
  if (overlap.length < requiredOverlap) return null;
  return {
    overlap_tokens: overlap.slice(0, 12),
    reason:
      "older gatekeeper review shares the current lead accession and claim terms; use as partial current-hypothesis credit rather than zeroing the rubric",
  };
}

function staleCurrentLeadAuditBlockerHits(value, currentIdentity) {
  if (!currentIdentity?.accessions?.length) return [];
  const text = String(value || "").trim();
  if (!text) return [];
  const hits = STALE_CURRENT_LEAD_AUDIT_BLOCKER_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  for (const accession of currentIdentity.ignored_stale_dataset_accessions || []) {
    const normalized = String(accession || "").toUpperCase();
    if (!normalized) continue;
    if (new RegExp(`\\b${normalized}\\b`, "i").test(text)) {
      hits.push(`ignored_stale_dataset_accession:${normalized}`);
    }
  }
  return uniqueStrings(hits);
}

function isSupersededCurrentLeadBlocker(value, currentIdentity) {
  if (!currentIdentity?.accessions?.length) return false;
  const text = String(value || "").trim();
  if (!text) return false;
  if (hasForeignOnlyGeoAccessions(text, currentIdentity.accessions)) return true;
  const hits = staleCurrentLeadAuditBlockerHits(text, currentIdentity);
  if (hits.length === 0) return false;
  const mentionsCurrent = mentionsAnyAccession(text, currentIdentity.accessions);
  const mentionsIgnoredStale = mentionsAnyAccession(text, currentIdentity.ignored_stale_dataset_accessions || []);
  if (mentionsIgnoredStale) return true;
  if (!mentionsCurrent) return true;
  return hits.length >= 2 && /\bpivot(?:ed)?\b|\babandon\b|\bretaining\b|\bwithdraw/i.test(text);
}

function scopeCurrentLeadReviewStrings(values, currentIdentity) {
  const kept = [];
  const superseded = [];
  for (const value of uniqueStrings(values || [])) {
    if (isSupersededCurrentLeadBlocker(value, currentIdentity)) {
      superseded.push({
        text: value,
        reason: hasForeignOnlyGeoAccessions(value, currentIdentity?.accessions || [])
          ? "foreign accession blocker does not apply to the current lead"
          : "stale audit blocker does not apply after the LabDirector current-lead pivot",
        current_accessions: currentIdentity?.accessions || [],
        ignored_stale_dataset_accessions: currentIdentity?.ignored_stale_dataset_accessions || [],
        stale_patterns: staleCurrentLeadAuditBlockerHits(value, currentIdentity),
      });
    } else {
      kept.push(value);
    }
  }
  return { kept, superseded };
}

function isSupersededForeignAccessionGatekeeperReview(review, currentIdentity) {
  if (!currentIdentity?.accessions?.length) return false;
  const fullText = gatekeeperReviewSearchText(review);
  const primaryObjectionText = gatekeeperReviewPrimaryObjectionText(review);
  if (hasForeignOnlyGeoAccessions(fullText, currentIdentity.accessions)) return true;
  if (hasForeignOnlyGeoAccessions(primaryObjectionText, currentIdentity.accessions)) return true;
  const stalePrimaryHits = staleCurrentLeadAuditBlockerHits(primaryObjectionText, currentIdentity);
  const hasIgnoredStaleDataset =
    (currentIdentity.ignored_stale_dataset_accessions || []).length > 0 &&
    mentionsAnyAccession(primaryObjectionText, currentIdentity.ignored_stale_dataset_accessions || []);
  const currentMentionsAreOnlyAlternatives = currentAccessionMentionsAreOnlyAlternativeContext(
    primaryObjectionText,
    currentIdentity.accessions,
  );
  if (
    stalePrimaryHits.length >= 2 &&
    mentionsForeignAccession(primaryObjectionText, currentIdentity.accessions) &&
    (
      !mentionsAnyAccession(primaryObjectionText, currentIdentity.accessions) ||
      currentMentionsAreOnlyAlternatives
    )
  ) {
    return true;
  }
  return (
    stalePrimaryHits.length >= 2 &&
    hasIgnoredStaleDataset &&
    !mentionsAnyAccession(primaryObjectionText, currentIdentity.accessions)
  );
}

function isSupersededCurrentHypothesisGatekeeperReview(review, currentIdentity) {
  if (currentIdentity?.dataset_keys?.length
      && review.briefed_primary_family === currentIdentity.primary_family) return false;
  const reviewMtime = Number(review?.source_mtime || 0);
  const currentHypothesisMtime = Number(currentIdentity?.source_mtime || 0);
  if (!(reviewMtime > 0 && currentHypothesisMtime > 0 && reviewMtime < currentHypothesisMtime)) {
    return false;
  }
  if (
    String(review?.verdict || "").toLowerCase() === "reject" &&
    gatekeeperReviewTargetsCurrentHypothesis(review, currentIdentity)
  ) {
    return false;
  }
  return true;
}

function latestValidationIsMateriallyNegative(progressSignals) {
  const summary = progressSignals?.latestValidationSummary;
  if (!summary || typeof summary !== "object") return false;
  const status = String(summary.overall_status || "").trim().toLowerCase();
  const negativeStatus =
    status === "failed" || status === "degraded" || status === "inconclusive";
  const failedChecksList = Array.isArray(summary.failed_checks) ? summary.failed_checks.length : 0;
  const checksFailed = Number(summary.checks_failed || 0);
  return negativeStatus || failedChecksList > 0 || checksFailed > 0;
}

function isSupersededByNewerValidationEvidence(review, progressSignals) {
  const reviewMtime = Number(review?.source_mtime || 0);
  const latestValidationMtime = Number(progressSignals?.latestValidationMtime || 0);
  if (!(reviewMtime > 0 && latestValidationMtime > 0 && reviewMtime < latestValidationMtime)) {
    return false;
  }
  const latestValidationLaneId = String(progressSignals?.latestValidationLaneId || "").trim();
  if (!latestValidationLaneId) return false;
  const reviewText = gatekeeperReviewSearchText(review);
  if (reviewText.includes(latestValidationLaneId)) return false;
  // A newer run whose executions measured nothing leaves the reviews standing.
  //
  // MEASURED ON cycle-a-20260919, 2026-10-01 18:39Z. followup-runner-104
  // was the v3 power analysis: status degraded, executions produced_evidence
  // false (no outcome was generated). Read as materially negative, it superseded
  // all seven reviews of round 48 and the gate fell to 0 on every rubric. The
  // dispatcher, reading produced_evidence, held all six re-reviews as
  // waiting-for-new-lead-evidence -- correctly, since there was nothing new to
  // review. Neither side moved, and the gate sat at 0 with no review running.
  // The run is still the latest validation shown to reviewers; it only does not
  // erase what they already said.
  if (progressSignals?.latestValidationProducedEvidence === false) return false;
  // Convergence fix (evidence-based, NOT time-based supersession):
  // A gatekeeper review is only stale-by-validation when the NEWER validation it
  // could not have seen is MATERIALLY NEGATIVE or CHANGED — a failing / degraded /
  // inconclusive outcome, or new failed checks. A newer validation that merely
  // RE-CONFIRMS the same passing evidence must NOT invalidate the review on mtime
  // alone. The old pure-mtime test ("review older than the newest validation
  // lane") was the gate-convergence churn: validation lanes are produced
  // continuously, so every review is perpetually "older than the latest run" and
  // the aggregate score resets to superseded/0 forever, so the gate can never
  // reach a stable verdict.
  // Fail-closed is preserved: genuinely new NEGATIVE evidence still supersedes and
  // forces a fresh review, and stale-setup / changed-hypothesis / foreign-accession
  // / stale-8gene-claim staleness are still handled by the sibling supersession
  // checks. This change only stops redundant PASSING re-validation from erasing an
  // otherwise-valid gatekeeper verdict.
  return latestValidationIsMateriallyNegative(progressSignals);
}

function gatekeeperReviewTargetsCurrentHypothesis(review, currentIdentity) {
  if (!currentIdentity?.primary_text) return false;
  const reviewText = gatekeeperReviewSearchText(review);
  if (hasForeignOnlyGeoAccessions(reviewText, currentIdentity.accessions || [])) return false;
  const currentAccessions = currentIdentity.accessions || [];
  const sharesAccession =
    currentAccessions.length === 0 || mentionsAnyAccession(reviewText, currentAccessions);
  if (!sharesAccession) return false;
  const currentTokens = distinctiveClaimTokens(currentIdentity.primary_text);
  const reviewTokens = distinctiveClaimTokens(reviewText);
  const overlap = [...currentTokens].filter((token) => reviewTokens.has(token));
  const requiredOverlap = currentAccessions.length > 0 ? 3 : 6;
  return overlap.length >= requiredOverlap;
}

// Was this review briefed on a DIFFERENT lead than the one now on the table?
//
// MEASURED ON cycle-g-v78. Four consecutive gate rounds reported novelty=72 and
// technical_quality=28 — identical across a LEAD CHANGE, from
// change_point_path_guiding to spatial_selective_cache_invalidation. Fifteen of
// the seventeen contributing gatekeeper reviews predated the current lead
// artifact; the two that did not were clarity and reproducibility, and those are
// precisely the only two axes whose scores moved. The gate was reporting one
// lead's scores as another lead's.
//
// isSupersededCurrentHypothesisGatekeeperReview does drop reviews older than the
// lead — except when the verdict is `reject` and the review "targets the current
// hypothesis". That target test needs 6 overlapping distinctive tokens, and with
// no accessions to anchor it (every non-biomedical cycle) two rendering leads
// share far more than 6 words: measured overlap was 18-28 for reviews of the
// PREVIOUS lead versus 30 for the current one. There is no threshold in that gap.
//
// So do not infer identity from prose. The dispatcher knows which lead it briefed
// the reviewer on; it now stamps it, and the review is matched by that key. This
// is the same move as d88fa38 — record the provenance instead of guessing it.
// Reviews with no stamp (dispatched before this, or by a path that does not carry
// it) fall through to the existing checks unchanged.
// A review is bound to the analysis contract it was briefed on, when it was
// briefed on one: once the lead's contract changes, that review judged a
// different analysis. A review briefed on NO contract judged this lead before
// any analysis under its contract had run; whether it is about this lead is
// the lead key's question below, and whether it saw the latest validation is
// the validation-binding check's.
//
// MEASURED ON cycle-a-20260919, 2026-10-14 08:22 to 2026-10-15: the
// lead's contract named a dataset not yet generated, so no validation existed
// under it and every gatekeeper was briefed with none. All 42 reviews of that
// very lead (lead key equal; 34 reject, 7 challenge, 1 approve) were set aside
// as "briefed on a superseded lead", the gate counted 0 reviews for 16 hours,
// scored every rubric 0, and kept dispatching more reviews -- 72 in a day.
function isBriefedOnSupersededLead(review, currentIdentity) {
  const briefedContract = String(review?.briefed_analysis_contract_id || "").trim();
  if (currentIdentity?.analysis_contract_id && briefedContract
      && briefedContract !== currentIdentity.analysis_contract_id) return true;
  const family = String(review?.briefed_primary_family || "").trim();
  if (family && currentIdentity?.primary_family && family !== currentIdentity.primary_family) return true;
  const briefed = String(review?.briefed_lead_key || "").trim();
  const current = String(currentIdentity?.lead_key || "").trim();
  if (currentIdentity?.dataset_keys?.length && !family && !briefed) return true;
  if (!briefed || !current) return false;
  return briefed !== current;
}

// A review of the evidence, made before this lead was selected and before it had
// the analysis contract it has now, is a review of something this contract never
// ran. The lead KEY is shared by every incarnation of one family, so such a review
// is matched to the lead again whenever the family is revisited, and it stands
// until something newer overrides it -- and nothing is requested for a rubric
// that is not pending.
//
// MEASURED ON cycle-a-20260919, 2026-10-28: a lead selected at 18:28 with
// a contract no runner had executed was judged by five rejections made 4 to 13
// days earlier (reproducibility 12 from 10-15), the gate read 37, nothing was
// pending, and the director was handed those scores as the lead's state.
//
// Only unstamped reviews: one briefed on a contract is matched by the contract,
// so a review of the very same analysis is kept, high or low. Novelty is exempt
// (it judges the claim against the literature, not the evidence), and a review
// made after the selection is current by construction, so this cannot repeat.
const EVIDENCE_RUBRICS_RECHECKED_AT_SELECTION = new Set([
  "technical_quality", "reproducibility", "clarity", "impact",
  "consort_reporting_completeness", "strobe_reporting_completeness",
]);

function isPreSelectionEvidenceReview(review, currentIdentity) {
  if (!currentIdentity?.analysis_contract_id) return false;
  if (!currentIdentity.selected_at_ms) return false;
  if (!EVIDENCE_RUBRICS_RECHECKED_AT_SELECTION.has(String(review?.focus_rubric || ""))) return false;
  if (String(review?.briefed_analysis_contract_id || "").trim()) return false;
  const madeAt = Number(review?.source_mtime || 0);
  return madeAt > 0 && madeAt < currentIdentity.selected_at_ms;
}

function unboundGatekeeperRubricsForRebind(reviews, currentIdentity) {
  const current = String(currentIdentity?.lead_key || "").trim();
  if (!current) return [];
  const boundRubrics = new Set((reviews || [])
    .filter((review) => String(review?.briefed_lead_key || "").trim() === current)
    .map((review) => String(review?.focus_rubric || "").trim())
    .filter(Boolean));
  // Roll out fail-closed: legacy cycles remain readable until one review proves
  // the fixed dispatcher is writing bindings. From that point, an unstamped
  // focused review must be replaced once; otherwise it can own that rubric
  // forever even after the director replaces the lead.
  if (boundRubrics.size === 0) return [];
  return uniqueStrings((reviews || [])
    .filter((review) => !String(review?.briefed_lead_key || "").trim())
    .map((review) => String(review?.focus_rubric || "").trim())
    .filter((rubric) => rubric && !boundRubrics.has(rubric)));
}

function filterSupersededGatekeeperReviews(parsedReviews, progressSignals, currentIdentity = null) {
  const activeReviews = [];
  const supersededReviews = [];
  for (const review of parsedReviews || []) {
    const supersededBriefedLead = isBriefedOnSupersededLead(review, currentIdentity);
    const supersededPreSelection = isPreSelectionEvidenceReview(review, currentIdentity);
    const supersededSetup = isSupersededSetupGatekeeperReview(review, progressSignals);
    const supersededEightGene = isSupersededPublishedEightGeneGatekeeperReview(review, progressSignals, currentIdentity);
    const supersededForeignAccession = isSupersededForeignAccessionGatekeeperReview(review, currentIdentity);
    const supersededCurrentHypothesis = isSupersededCurrentHypothesisGatekeeperReview(review, currentIdentity);
    const supersededValidationBinding = currentIdentity?.dataset_keys?.length
      && progressSignals?.latestValidationLeadMatchScore >= 3
      && progressSignals?.latestValidationLaneId
      && review.briefed_validation_lane_id !== progressSignals.latestValidationLaneId
      && !gatekeeperReviewSearchText(review).includes(progressSignals.latestValidationLaneId);
    // Novelty judges the claim against the literature, and a newer measurement
    // of the same claim does not change the literature: its review stands
    // across new validation, and is still set aside when the lead, its contract
    // or its family change (above and below). The rubrics that judge the
    // evidence -- technical quality, reproducibility, clarity of the evidence
    // chain, impact of the validated finding -- are re-reviewed, and only they.
    // MEASURED ON cycle-a-20260919, 2026-10-26: a new runner result on
    // an unchanged lead and contract set aside every review, and a novelty of 82
    // went back to 0 and was bought again.
    const supersededByNewerValidation = review.focus_rubric !== "novelty"
      && Boolean(supersededValidationBinding || isSupersededByNewerValidationEvidence(review, progressSignals));
    // No partial credit for a review of a different lead: partial credit exists
    // for a review that IS about this lead but predates its latest restatement.
    const currentHypothesisPartialCredit = supersededCurrentHypothesis && !currentIdentity?.dataset_keys?.length && !supersededForeignAccession && !supersededByNewerValidation && !supersededBriefedLead && !supersededPreSelection
      ? alignedCurrentHypothesisReviewReason(review, currentIdentity)
      : null;
    if (currentHypothesisPartialCredit) {
      activeReviews.push({
        ...review,
        partial_current_hypothesis_credit: true,
        partial_current_hypothesis_credit_reason: currentHypothesisPartialCredit.reason,
        partial_current_hypothesis_overlap_tokens: currentHypothesisPartialCredit.overlap_tokens,
      });
      continue;
    }
    if (supersededBriefedLead || supersededPreSelection || supersededSetup || supersededEightGene || supersededForeignAccession || supersededCurrentHypothesis || supersededByNewerValidation) {
      supersededReviews.push({
        lane_id: review.lane_id || null,
        focus_rubric: review.focus_rubric || null,
        verdict: review.verdict || null,
        score: averageApplicableRubricScore(review.rubric),
        superseded_kind: supersededBriefedLead
          ? "superseded_briefed_lead_review"
          : supersededPreSelection
          ? "superseded_pre_selection_review"
          : supersededForeignAccession
          ? "superseded_foreign_accession_review"
          : supersededEightGene
            ? "superseded_claim_review"
            : supersededByNewerValidation
              ? "superseded_validation_evidence_review"
              : supersededCurrentHypothesis
                ? "superseded_current_hypothesis_review"
                : "superseded_setup_review",
        reason:
          supersededBriefedLead
            ? `superseded briefed-lead review: this reviewer was briefed on lead ${review.briefed_lead_key}, the gate is now judging ${currentIdentity?.lead_key}`
            : supersededPreSelection
            ? `superseded pre-selection review: made before this lead was selected (${new Date(currentIdentity.selected_at_ms).toISOString()}) and before the analysis contract it now has; it judged evidence this contract never ran`
            : supersededForeignAccession
            ? `superseded foreign-accession review: review only references accessions outside the current lead (${(currentIdentity?.accessions || []).join(", ")})`
            : supersededEightGene
              ? "superseded claim-faithfulness review: a newer primary runner executed the published 8-gene audit and made the older objection stale"
              : supersededByNewerValidation
                ? `superseded validation-evidence review: this review is not bound to current validation ${progressSignals.latestValidationLaneId}`
                : supersededCurrentHypothesis
                  ? "superseded current-hypothesis review: LabDirector changed the authoritative hypothesis after this gatekeeper review was produced"
                  : "superseded setup review: current researcher view now has a lead hypothesis, dataset signal, and validation evidence",
        briefed_lead_key: review.briefed_lead_key || null,
        briefed_primary_family: review.briefed_primary_family || null,
        briefed_validation_lane_id: review.briefed_validation_lane_id || null,
        current_lead_key: currentIdentity?.lead_key || null,
        review_source_mtime: review.source_mtime || null,
        latest_validation_lane_id: progressSignals?.latestValidationLaneId || null,
        latest_validation_mtime: progressSignals?.latestValidationMtime || null,
        current_hypothesis_source_mtime: currentIdentity?.source_mtime || 0,
        stale_setup_blockers: uniqueStrings(
          [
            ...(review.major_objections || []),
            ...(review.missing_validations || []),
            ...rubricBlockerReasons(review.rubric, 95),
          ].filter((item) => STALE_SETUP_REVIEW_PATTERNS.some((pattern) => pattern.test(item))),
        ),
        stale_claim_review_patterns: supersededEightGene ? stalePublishedEightGeneReviewHits(review) : [],
        stale_foreign_accessions: supersededForeignAccession
          ? extractGeoAccessions(gatekeeperReviewPrimaryObjectionText(review) || gatekeeperReviewSearchText(review))
          : [],
        stale_current_lead_patterns: supersededForeignAccession
          ? staleCurrentLeadAuditBlockerHits(gatekeeperReviewPrimaryObjectionText(review), currentIdentity)
          : [],
        current_accessions: supersededForeignAccession ? currentIdentity.accessions : [],
        superseded_by_lane_id: supersededEightGene ? progressSignals.latestValidationLaneId : null,
      });
      continue;
    }
    activeReviews.push(review);
  }
  return { activeReviews, supersededReviews };
}

module.exports = {
  gateProgressSignals,
  validationOfCurrentLead,
  readPrimaryValidationEvidence,
  gatekeeperReviewSearchText,
  gatekeeperReviewPrimaryObjectionText,
  stalePublishedEightGeneReviewHits,
  staleCurrentLeadAuditBlockerHits,
  isSupersededCurrentLeadBlocker,
  scopeCurrentLeadReviewStrings,
  isSupersededSetupGatekeeperReview,
  isSupersededPublishedEightGeneGatekeeperReview,
  currentHypothesisIdentity,
  isSupersededForeignAccessionGatekeeperReview,
  isSupersededCurrentHypothesisGatekeeperReview,
  unboundGatekeeperRubricsForRebind,
  filterSupersededGatekeeperReviews,
};
