"use strict";

const fs = require("fs");
const path = require("path");
const { writeAuthoritativeState } = require("../provenance/state_provenance");
const {
  classifyReviewBlockers,
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  normalizeActions,
  parseJsonPayload,
  readJsonIfExists,
  readTextIfExists,
  uniqueStrings,
  writeJson,
} = require("./research_note_utils");
const {
  promotionArtifactFollowupActions,
  readPromotionArtifacts,
} = require("./promotion_artifacts");

function payloadFromResult(result) {
  if (!result || typeof result !== "object") return null;
  return (
    (result.extracted_json && typeof result.extracted_json === "object" ? result.extracted_json : null) ||
    (result.lab_director_requery && typeof result.lab_director_requery === "object" ? result.lab_director_requery : null) ||
    parseJsonPayload(result.output_last_message) ||
    parseJsonPayload(result.stdout) ||
    parseJsonPayload(result.stderr) ||
    parseJsonPayload(result.summary)
  );
}

function hypothesisStatement(value) {
  if (!value || typeof value !== "object") return "";
  return compactText(value.statement || value.hypothesis || value.claim || value.core_claim || "", 900);
}

function selectLeadFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const direct = payload.selected_hypothesis || payload.lead_hypothesis || payload.current_lead_hypothesis || null;
  if (hypothesisStatement(direct)) return direct;
  const replacements = Array.isArray(payload.replacement_hypotheses) ? payload.replacement_hypotheses : [];
  const gse282742 = replacements.find((item) =>
    /GSE282742|subject-aware|P-MCI|S-MCI|8-gene/i.test(JSON.stringify(item || {})),
  );
  return gse282742 || replacements.find((item) => hypothesisStatement(item)) || null;
}

function summarizeLeadCandidate(candidate, source = {}) {
  if (!candidate || typeof candidate !== "object") return null;
  const statement = hypothesisStatement(candidate);
  if (!statement) return null;
  return {
    statement,
    hypothesis_id: candidate.hypothesis_id || candidate.id || source.hypothesis_id || null,
    dataset_or_accession:
      candidate.dataset_or_accession ||
      candidate.accession ||
      (/GSE282742/i.test(JSON.stringify(candidate)) ? "GSE282742" : null),
    family_root: candidate.primary_family || candidate.family_root || candidate.family || source.family_root || null,
    why_selected: compactText(candidate.why_selected || candidate.rationale || "", 900) || null,
    same_dataset_reference_papers: Array.isArray(candidate.same_dataset_reference_papers)
      ? candidate.same_dataset_reference_papers.slice(0, 4)
      : [],
    reference_methods_baseline: compactText(candidate.reference_methods_baseline || "", 1200) || null,
    source_lane_id: source.lane_id || null,
    source: source.source || null,
  };
}

function summarizeLabDirectorDecision(payload, laneId) {
  if (!payload || typeof payload !== "object") return null;
  const selected = summarizeLeadCandidate(selectLeadFromPayload(payload), {
    lane_id: laneId,
    source: "lab_director_lane_payload",
  });
  return {
    lane_id: laneId,
    requery_decision:
      payload.requery_decision ||
      payload.decision ||
      payload?.director_decision?.mode ||
      null,
    summary: compactText(payload.summary || payload.rationale || "", 1200) || null,
    rationale: compactText(payload.rationale || payload?.director_decision?.reason || "", 1400) || null,
    selected_hypothesis: selected,
    replacement_hypotheses: Array.isArray(payload.replacement_hypotheses)
      ? payload.replacement_hypotheses
          .map((item) => summarizeLeadCandidate(item, { lane_id: laneId, source: "replacement_hypothesis" }))
          .filter(Boolean)
          .slice(0, 5)
      : [],
    next_actions: normalizeActions(
      payload.next_actions ||
        payload.highest_yield_next_actions ||
        payload?.director_decision?.approved_actions ||
        [],
      10,
    ),
  };
}

function latestLabDirectorLaneSummaries({ root, cycleId, limit = 8 }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  return fs.readdirSync(lanesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("lab-director"))
    .map((entry) => {
      const laneDir = path.join(lanesRoot, entry.name);
      const resultPath = path.join(laneDir, "result.json");
      const finalStatusPath = path.join(laneDir, "final-status.json");
      const messagePath = path.join(laneDir, "output-last-message.txt");
      const rolePlanPath = path.join(laneDir, "role-plan.json");
      return {
        lane_id: entry.name,
        laneDir,
        resultPath,
        finalStatusPath,
        messagePath,
        rolePlanPath,
        updated_at_epoch_ms: Math.max(fileMtimeMs(resultPath), fileMtimeMs(messagePath), fileMtimeMs(rolePlanPath), fileMtimeMs(finalStatusPath)),
      };
    })
    .sort((a, b) => b.updated_at_epoch_ms - a.updated_at_epoch_ms)
    .slice(0, limit)
    .map((lane) => {
      const { resultPath, finalStatusPath, messagePath, rolePlanPath } = lane;
      const result = readJsonIfExists(resultPath) || {};
      const finalStatus = readJsonIfExists(finalStatusPath) || {};
      const payload = payloadFromResult(result) || parseJsonPayload(readTextIfExists(messagePath, 1024 * 1024));
      return {
        lane_id: lane.lane_id,
        status: finalStatus.status || result.status || null,
        superseded_by_user_instruction: Boolean(result.superseded_by_user_instruction || finalStatus.superseded_by_user_instruction),
        error: result.error || finalStatus.error || null,
        result_path: fs.existsSync(resultPath) ? resultPath : null,
        role_plan_path: fs.existsSync(rolePlanPath) ? rolePlanPath : null,
        output_last_message_path: fs.existsSync(messagePath) ? messagePath : null,
        output_last_message_excerpt: readTextIfExists(messagePath, 1200),
        structured_decision: summarizeLabDirectorDecision(payload, lane.lane_id),
        updated_at_epoch_ms: lane.updated_at_epoch_ms,
      };
    });
}

function latestStructuredDecision(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .find((item) => {
      if (!item?.structured_decision) return false;
      if (item.superseded_by_user_instruction) return false;
      if (["failed", "cancelled", "superseded"].includes(String(item.status || "").toLowerCase())) return false;
      return true;
    })?.structured_decision || null;
}

// Biomedical statement markers. Used ONLY to (a) infer a bio family when the
// statement is genuinely biomedical and (b) REJECT a stale bio family label that
// was carried onto a non-bio (e.g. graphics) statement. Do NOT hardcode a bio
// family as a generic fallback — on cycle-g-v59 the tumor_immune_resistance
// fallback stuck to graphics leads and the gatekeeper scored their novelty
// against an off-topic biomedical corpus.
// The family a lead belongs to is the LabDirector's own judgment, declared on the
// lead it authors. This code only reads that declaration.
//
// It used to guess from keyword lists, and keyword lists misfire: the Rust mirror
// of this logic matched the marker "tan" (tumour-associated neutrophils) inside
// "s-tan-dard control variates" and stamped `tumor_immune_resistance` onto a
// Mitsuba rendering lead on cycle-g-v73, which routes novelty scoring at an
// off-topic corpus. Adding word boundaries would only postpone the next
// collision ("gene" in "gene-ral", "immune" in a metaphor, an unlisted domain
// with no markers at all). Whoever wrote the hypothesis knows its family; nothing
// downstream can recover it more reliably by pattern-matching prose.
//
// A lead that declares no family gets `null`, and the caller carries a null
// rather than inventing a domain — the director is prompted to declare one
// (see the family declaration contract in the LabDirector policy).
function familyForStatement({ explicitFamily, fallbackFamily, sameLead = true }) {
  const declared = String(explicitFamily || "").trim();
  if (declared) return declared;
  // Only inherit the previous family while we are still on the SAME lead; a new
  // lead that declares nothing must not silently inherit the old lead's domain.
  if (!sameLead) return null;
  const inherited = String(fallbackFamily || "").trim();
  return inherited || null;
}

function summarizeHypothesis(hypothesis, latestDecision = null) {
  const nested =
    hypothesis?.selected_hypothesis ||
    hypothesis?.lead_hypothesis ||
    hypothesis?.current_lead_hypothesis ||
    null;
  const decisionLead = latestDecision?.selected_hypothesis || null;
  const directLead = summarizeLeadCandidate(nested, {
    source: "lab_director_hypothesis_artifact",
    hypothesis_id: hypothesis?.hypothesis_id,
    family_root: hypothesis?.family_root,
  });
  const selectedLead = decisionLead || directLead;
  const statement =
    selectedLead?.statement ||
    compactText(hypothesis?.statement || hypothesis?.hypothesis || hypothesis?.claim || "", 900) ||
    null;
  const statementAccession = statement?.match(/\bGSE\d+\b/i)?.[0]?.toUpperCase() || null;
  const primaryFamily = familyForStatement({
    explicitFamily: selectedLead?.family_root || selectedLead?.primary_family || hypothesis?.family || hypothesis?.family_root,
    fallbackFamily: hypothesis?.primary_family,
  });
  const datasetOrAccession =
    selectedLead?.dataset_or_accession ||
    statementAccession ||
    nested?.dataset_or_accession ||
    hypothesis?.identification_strategy?.dataset_or_accession ||
    hypothesis?.dataset_or_accession ||
    null;
  const materializedDataset = selectMaterializedDatasetForLead({
    leadDataset: datasetOrAccession,
    candidates: [
      selectedLead?.materialized_dataset,
      nested?.materialized_dataset,
      hypothesis?.identification_strategy?.materialized_dataset,
      hypothesis?.materialized_dataset,
    ],
  });
  return {
    status: hypothesis?.status || hypothesis?.latest_status || null,
    statement,
    hypothesis_id: hypothesis?.hypothesis_id || selectedLead?.hypothesis_id || null,
    primary_family: primaryFamily,
    dataset_or_accession: datasetOrAccession,
    materialized_dataset: materializedDataset,
    same_dataset_reference_papers:
      selectedLead?.same_dataset_reference_papers?.length > 0
        ? selectedLead.same_dataset_reference_papers
        : materializedDataset?.same_dataset_reference_papers || [],
    reference_methods_baseline:
      selectedLead?.reference_methods_baseline ||
      nested?.reference_methods_baseline ||
      materializedDataset?.reference_methods_baseline ||
      null,
    why_selected: selectedLead?.why_selected || nested?.why_selected || materializedDataset?.why_selected || null,
    trend_positioning: hypothesis?.trend_positioning || null,
    falsification_conditions: hypothesis?.falsification_conditions || [],
    statement_source: selectedLead?.source || (hypothesis?.statement ? "lab_director_hypothesis_artifact" : null),
    source_lane_id: selectedLead?.source_lane_id || null,
  };
}

function accessionText(value) {
  return String(value || "").trim().toLowerCase();
}

function bundleMatchesAccession(bundle, accession) {
  const wanted = accessionText(accession);
  if (!wanted || !bundle || typeof bundle !== "object") return false;
  return [
    bundle.accession,
    bundle.dataset_or_accession,
    bundle.candidate_accession,
    bundle.candidate_doi,
    bundle.candidate_url,
    bundle.candidate_title,
    bundle.bundle_path,
    bundle.manifest_path,
  ].some((item) => accessionText(item).includes(wanted));
}

function materializedDatasetMatchesLead(dataset, accession) {
  if (!dataset || typeof dataset !== "object") return false;
  const wanted = accessionText(accession);
  if (!wanted) return true;
  return bundleMatchesAccession(dataset, accession);
}

function selectMaterializedDatasetForLead({ leadDataset, candidates }) {
  for (const candidate of candidates || []) {
    if (materializedDatasetMatchesLead(candidate, leadDataset)) {
      return candidate;
    }
  }
  return null;
}

function fetchedBundleForAccession(dataBundles, accession) {
  const bundles = Array.isArray(dataBundles?.bundles) ? dataBundles.bundles : [];
  return bundles.find((bundle) =>
    bundleMatchesAccession(bundle, accession) &&
    String(bundle.status || "").toLowerCase() === "fetched" &&
    Number(bundle.csv_count || 0) > 0
  ) || null;
}

function focusHypothesisForAccession(hypothesisLedger, accession) {
  const candidates = [
    ...(Array.isArray(hypothesisLedger?.focus_hypotheses) ? hypothesisLedger.focus_hypotheses : []),
    ...(Array.isArray(hypothesisLedger?.hypotheses) ? hypothesisLedger.hypotheses : []),
  ];
  return candidates.find((item) => bundleMatchesAccession(item, accession)) || null;
}

function extractAccessionsFromText(value) {
  const matches = String(value || "").match(/\bGSE\d+\b/gi) || [];
  return [...new Set(matches.map((item) => item.toUpperCase()))];
}

function forcedStrategyDecisionLead({ strategyDecision, dataBundles, hypothesisLedger }) {
  const decisionText = JSON.stringify({
    reason: strategyDecision?.reason,
    note: strategyDecision?.note,
    trigger_signals: strategyDecision?.trigger_signals,
    source: strategyDecision?.source,
    forced: strategyDecision?.forced,
  });
  const accessions = extractAccessionsFromText(decisionText);
  const explicitlyTargetsDataset = accessions.length > 0 &&
    (/user|explicit|selected|force|forced|pivot|operator|manual/i.test(decisionText) || strategyDecision?.forced === true);
  if (strategyDecision?.mode !== "pivot" || !explicitlyTargetsDataset) return null;
  const accession = accessions[0];
  const bundle = fetchedBundleForAccession(dataBundles, accession);
  if (!bundle) return null;
  const ledgerLead = focusHypothesisForAccession(hypothesisLedger, accession) || {};
  const materializedDataset = {
    accession,
    bundle_path: bundle.bundle_path || null,
    manifest_path: bundle.manifest_path || null,
    provider: bundle.provider || null,
    status: bundle.status || "fetched",
    csv_count: bundle.csv_count ?? null,
    downloaded_count: bundle.downloaded_count ?? null,
    candidate_url: bundle.candidate_url || null,
    candidate_title: bundle.candidate_title || null,
  };
  return {
    status: "selected",
    statement: compactText(
      ledgerLead.statement || ledgerLead.core_claim ||
        `Materialized dataset ${accession} is the operator-selected validation target; LabDirector must still evaluate whether any hypothesis using it is scientifically justified.`,
      900,
    ),
    hypothesis_id: ledgerLead.hypothesis_id || ledgerLead.id || null,
    primary_family: ledgerLead.family_root || ledgerLead.primary_family || null,
    dataset_or_accession: accession,
    materialized_dataset: materializedDataset,
    same_dataset_reference_papers: Array.isArray(ledgerLead.same_dataset_reference_papers)
      ? ledgerLead.same_dataset_reference_papers.slice(0, 4)
      : [],
    reference_methods_baseline: ledgerLead.reference_methods_baseline || null,
    why_selected: compactText(
      `Explicit strategy decision selected already materialized ${accession} as a validation target. This is advisory context for LabDirector, not a hard lock; LabDirector may keep, replace, or demote it with scientific rationale. ${strategyDecision?.reason || ""}`,
      1200,
    ),
    trend_positioning: ledgerLead.trend_positioning || null,
    falsification_conditions: Array.isArray(ledgerLead.falsification_conditions) ? ledgerLead.falsification_conditions : [],
    statement_source: "forced_strategy_decision",
    source_lane_id: strategyDecision?.decision_id || "strategy-decision",
  };
}

function gateSnapshot(gateReview) {
  if (!gateReview || typeof gateReview !== "object") return null;
  return {
    mode: gateReview.mode || null,
    score: gateReview.score ?? gateReview.gate_score ?? null,
    gate_passed: gateReview.gate_passed === true,
    conclusion_gate_passed: gateReview.conclusion_gate_passed === true,
    approval_gate_passed: gateReview.approval_gate_passed === true,
  };
}

function approvalSnapshot(approvalReview) {
  if (!approvalReview || typeof approvalReview !== "object") return null;
  return {
    mode: approvalReview.mode || null,
    approval_readiness_score: approvalReview.approval_readiness_score ?? null,
    approval_readiness_band: approvalReview.approval_readiness_band || null,
    score_limiting_stage: approvalReview.approval_stage_summary?.score_limiting_stage || null,
  };
}

function conclusionSnapshot(conclusionReview) {
  if (!conclusionReview || typeof conclusionReview !== "object") return null;
  return {
    mode: conclusionReview.mode || null,
    conclusion_score: conclusionReview.conclusion_score ?? null,
    conclusion_band: conclusionReview.conclusion_band || null,
    conclusion_gate_passed: conclusionReview.conclusion_gate_passed === true,
  };
}

function masterTableGateSatisfied(gateReview) {
  const summaries = [
    gateReview?.latest_validation_summary,
    gateReview?.scientific_value_gate?.latest_validation_summary,
  ];
  return summaries.some((summary) =>
    summary?.analysis_master_table_gate?.satisfied === true ||
    summary?.checks?.analysis_master_table_gate_satisfied === true ||
    summary?.checks?.analysis_master_table_created === true
  );
}

function resolvedBlockerPatternsForEvidence({ gateReview }) {
  const patterns = [];
  if (masterTableGateSatisfied(gateReview)) {
    patterns.push(
      /master[-\s]?table.*blueprint interface/i,
      /analysis_master_table_created.*blueprint interface/i,
      /repair the analysis_master_table_created blueprint interface/i,
      /repair the master[-\s]?table blueprint interface/i,
    );
  }
  return patterns;
}

function deriveNextActions({ activeBlockers, currentLeadHypothesis, latestDecision, gateReview }) {
  const blockerText = uniqueStrings(activeBlockers, 12);
  const decisionActions = normalizeActions(latestDecision?.next_actions || [], 10);
  if (decisionActions.length > 0) return decisionActions;
  const gateRejected = gateReview && gateReview.gate_passed !== true && (
    /reject|defer|revise/i.test(String(gateReview.verdict || gateReview.mode || "")) ||
    // An absent score is 0, not full marks. Defaulting it to 100 made "the gate
    // has not scored this yet" indistinguishable from "the gate is satisfied":
    // the comparison below went false, the director was never told the gate had
    // rejected, and no requery action was raised. Every other score path in this
    // runtime already reads a missing value as 0 -- `average()` returns 0 for an
    // empty rubric and treats an unscored item as 0 -- so this was the one place
    // that failed open.
    Number(gateReview.score ?? gateReview.gate_score ?? 0) < 60 ||
    Array.isArray(gateReview.gate_scientific_blockers) && gateReview.gate_scientific_blockers.length > 0
  );
  const selectedAccessions = extractAccessionsFromText(JSON.stringify(currentLeadHypothesis || {}));
  if (gateRejected && selectedAccessions.length > 0) {
    const accession = selectedAccessions[0];
    return normalizeActions([
      { description: `Answer the Gatekeeper rejection directly for ${accession}: rerank at least three mechanism-level families, then keep, replace, or demote the lead with explicit scientific rationale.`, preferred_role: "lab-director", type: "lab_director_requery_followup" },
      { description: `Recover the same-dataset ${accession} published baseline and define the claimed quantitative delta over that baseline before any runner promotion.`, preferred_role: "scout", type: "novelty_followup" },
      { description: `Write the ${accession} executable validation design with real exposure variables, outcome/proxy, covariates, comparator models, confounder adjustment, and transportability plan.`, preferred_role: "analyst", type: "methods_followup" },
    ], 8);
  }
  const actions = [];
  if (!currentLeadHypothesis?.statement) {
    actions.push({ description: "Select one falsifiable lead hypothesis from the literature_graph + data_graph; if validation data is not yet materialized, name the needed dataset/accession in a data_acquisition_followup.", preferred_role: "lab-director", type: "hypothesis_followup" });
  }
  if (blockerText.some((item) => /same-dataset|baseline|8-gene|auc/i.test(item))) {
    actions.push({ description: "Map the same-dataset baseline methods, endpoint, covariates, and benchmark genes to executable local columns.", preferred_role: "analyst", type: "baseline_mapping_followup" });
  }
  if (blockerText.some((item) => /deconvolution|pathway|DESeq2|nested/i.test(item))) {
    actions.push({ description: "Run the claim-faithful validation rather than a proxy analysis: DESeq2 interaction terms, pathway scoring, immune deconvolution, and subject-grouped nested CV.", preferred_role: "lab-runner", type: "hypothesis_validation_followup" });
  }
  if (blockerText.some((item) => /confound|leukocyte|medication|comorbidity/i.test(item))) {
    actions.push({ description: "Record which confounders are locally available, which are missing, and how sensitivity or negative-control tests bound the remaining risk.", preferred_role: "analyst", type: "confound_followup" });
  }
  return normalizeActions(actions.length ? actions : blockerText, 8);
}

function writeMarkdownNotes(filePath, notes) {
  const lines = [
    `# LabDirector Research Notes: ${notes.cycle_id}`,
    "",
    `- updated_at: ${notes.updated_at}`,
    `- generated_by: ${notes.generated_by}`,
    `- note_status: ${notes.note_status}`,
    "",
    "## Current Lead Hypothesis",
    notes.current_lead_hypothesis?.statement || "none selected",
    "",
    "## Latest LabDirector Decision",
    `- lane_id: ${notes.latest_lab_director_decision?.lane_id || "none"}`,
    `- decision: ${notes.latest_lab_director_decision?.requery_decision || "unknown"}`,
    notes.latest_lab_director_decision?.summary || notes.latest_lab_director_decision?.rationale || "none",
    "",
    "## Evidence Snapshot",
    `- lane_counts: ${JSON.stringify(notes.evidence_snapshot?.lane_counts || {})}`,
    `- gate: ${JSON.stringify(notes.evidence_snapshot?.gate || {})}`,
    `- approval: ${JSON.stringify(notes.evidence_snapshot?.approval || {})}`,
    `- conclusion: ${JSON.stringify(notes.evidence_snapshot?.conclusion || {})}`,
    "",
    "## Active Blockers",
    markdownList(notes.open_blockers),
    "",
    "## Resolved Or Superseded Blockers",
    markdownList(notes.resolved_or_superseded_blockers),
    "",
    "## Dataset And Tool Context",
    `- selected_dataset: ${JSON.stringify(notes.dataset_and_tool_context?.selected_dataset || null)}`,
    `- repository_workflow_context: ${JSON.stringify(notes.dataset_and_tool_context?.repository_workflow_context || null)}`,
    "",
    "## Next Actions",
    markdownList(notes.next_actions),
    "",
    "## Communication Quality",
    `- stale_blocker_count: ${notes.communication_quality?.stale_blocker_count || 0}`,
    `- duplicate_blocker_count: ${notes.communication_quality?.duplicate_blocker_count || 0}`,
    `- active_blocker_count: ${notes.communication_quality?.active_blocker_count || 0}`,
    "",
    "## Recent LabDirector Lanes",
    markdownList((notes.latest_lab_director_outputs || []).map((item) => {
      return `${item.lane_id}: ${item.status || "unknown"} ${item.output_last_message_path || ""}`;
    })),
    "",
    "## Handoff For Next LabDirector",
    notes.handoff_for_next_lab_director,
    "",
  ];
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function notesFileExists(jsonPath, markdownPath) {
  return fs.existsSync(jsonPath) || fs.existsSync(markdownPath);
}

function preserveExistingResearchNotes({ jsonPath, markdownPath, reason = "preserved_existing_lab_director_notes" }) {
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    updated: false,
    reason,
    preserved_existing_notes: true,
  };
}

function projectNotesLeadToHypothesis({ stateRoot, cycleId, notes }) {
  const lead = notes?.current_lead_hypothesis || null;
  const statement = compactText(lead?.statement || "", 1600);
  if (!statement) return null;
  const hypothesisPath = path.join(stateRoot, `${cycleId}-lab-director-hypothesis.json`);
  const existing = readJsonIfExists(hypothesisPath) || {};
  // The lead is replaced in one place: the harness projection of a director
  // result, which holds a lead until its own evidence has been gated. Notes carry
  // the latest director DECISION, and re-projecting it here would apply the very
  // replacement that projection just deferred. A lead the operator forced is not
  // a director payload and still passes.
  if (
    lead?.source === "lab_director_lane_payload" &&
    existing.selected_at_epoch_ms != null &&
    existing.statement &&
    String(existing.statement).trim() !== statement.trim()
  ) {
    return null;
  }
  const inferredLeadDataset = extractAccessionsFromText(statement)[0] || null;
  const leadDataset = lead.dataset_or_accession || lead.accession || inferredLeadDataset || null;
  const existingDataset = existing?.identification_strategy?.dataset_or_accession || existing?.dataset_or_accession || null;
  const datasetChanged = leadDataset && existingDataset && accessionText(leadDataset) !== accessionText(existingDataset);
  const materializedDataset = selectMaterializedDatasetForLead({
    leadDataset: leadDataset || existingDataset,
    candidates: datasetChanged
      ? [lead.materialized_dataset]
      : [lead.materialized_dataset, existing?.identification_strategy?.materialized_dataset],
  });
  const identificationStrategy = {
    ...(!datasetChanged && existing.identification_strategy && typeof existing.identification_strategy === "object"
      ? existing.identification_strategy
      : {}),
    restart_frame: "lab_director_research_notes_projection",
  };
  if (leadDataset) {
    identificationStrategy.dataset_or_accession = leadDataset;
  }
  const validationDataStatus = materializedDataset
    ? "materialized"
    : (
        lead.validation_data_status && !/^materialized$/i.test(String(lead.validation_data_status))
          ? lead.validation_data_status
          : "needs_materialization"
      );
  if (materializedDataset) {
    identificationStrategy.materialized_dataset = materializedDataset;
  } else {
    delete identificationStrategy.materialized_dataset;
  }
  identificationStrategy.validation_data_status = validationDataStatus;
  const primaryFamily = familyForStatement({
    explicitFamily: lead.primary_family || lead.family_root || lead.family,
    fallbackFamily: existing.primary_family || existing.family_root,
    // Inherit the previous family only while the lead itself is unchanged; a new
    // hypothesis that declares no family must not adopt the old one's domain.
    sameLead:
      String(statement || "").trim() === String(existing.statement || "").trim(),
  });
  const projected = {
    ...existing,
    status: "selected",
    statement,
    primary_family:
      primaryFamily,
    hypothesis_id: lead.hypothesis_id || existing.hypothesis_id || null,
    dataset_or_accession: leadDataset || existing.dataset_or_accession || null,
    validation_data_status: validationDataStatus,
    selected_hypothesis: lead,
    identification_strategy: identificationStrategy,
    same_dataset_reference_papers: Array.isArray(lead.same_dataset_reference_papers)
      ? lead.same_dataset_reference_papers
      : [],
    reference_methods_baseline: lead.reference_methods_baseline || existing.reference_methods_baseline || null,
    why_selected: lead.why_selected || existing.why_selected || null,
    updated_at: notes.updated_at,
    generated_by: notes.generated_by,
    projection_source: "lab_director_research_notes",
  };
  // The director's choice for the cycle, and the one record in this file that
  // nothing regenerates -- classified authoritative in
  // src/provenance/state_provenance.js. Keep the version being replaced.
  //
  // cycle-g-v91 lost this artifact between 20:02 and 20:06 on 2026-09-13 with
  // no actor, no reason and no copy anywhere: the review-map entries that look
  // like archived snapshots are symlinks back into state, so they went dangling
  // with it. Whatever removed it, the version before it is now survivable.
  const outcome = writeAuthoritativeState({
    // `root` here is the directory CONTAINING .research-lab, which is what
    // recordStateWrite and archiveStatePath both join onto; stateRoot is
    // <root>/.research-lab/state, so it is two levels up.
    root: path.dirname(path.dirname(stateRoot)),
    cycleId,
    kind: "lab-director-hypothesis",
    filePath: hypothesisPath,
    value: projected,
    actor: notes.generated_by || "lab_director_research_notes_projection",
    reason: "the director's research notes named a new current lead",
  });
  if (!outcome.written) {
    // Fail-closed: the prior lead could not be copied, so it is still on disk
    // and still readable. Null is what this function already returns when it
    // projected nothing -- the caller reports it as hypothesis_projection_path,
    // and a path that claims a write which did not happen is worse than none.
    console.error(
      `[research-notes] lead projection refused (${outcome.refused}): kept the existing ${hypothesisPath}`,
    );
    return null;
  }
  return hypothesisPath;
}

function ensureLabDirectorResearchNotes({ root, cycleId, force = false }) {
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  const jsonPath = path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`);
  const markdownPath = path.join(stateRoot, `${cycleId}-lab-director-research-notes.md`);
  const existing = readJsonIfExists(jsonPath) || {};
  if (!force && notesFileExists(jsonPath, markdownPath)) {
    // Research notes are LabDirector's durable scientific notebook, not a
    // regenerable status projection.  Refresh-cycle may read them and build
    // derived views, but it must not overwrite the notebook with blocker dumps
    // or lane summaries just because a newer gate/digest file appeared.  If the
    // notebook is missing entirely we still create a minimal bootstrap note
    // below so fresh cycles have a place to start.
    return preserveExistingResearchNotes({ jsonPath, markdownPath });
  }
  const cycleStatePath = path.join(stateRoot, `${cycleId}-cycle-run-state.json`);
  const hypothesisPath = path.join(stateRoot, `${cycleId}-lab-director-hypothesis.json`);
  const trendPath = path.join(stateRoot, `${cycleId}-research-trend-analysis.json`);
  const gatePath = path.join(stateRoot, `${cycleId}-gate-review.json`);
  const approvalPath = path.join(stateRoot, `${cycleId}-approval-review.json`);
  const conclusionPath = path.join(stateRoot, `${cycleId}-conclusion-review.json`);
  const strategyDecisionPath = path.join(stateRoot, `${cycleId}-strategy-decision.json`);
  const dataBundlesPath = path.join(stateRoot, `${cycleId}-data-bundles.json`);
  const hypothesisLedgerPath = path.join(stateRoot, `${cycleId}-hypothesis-ledger.json`);
  const cycleState = readJsonIfExists(cycleStatePath) || {};
  const hypothesis = readJsonIfExists(hypothesisPath);
  const trend = readJsonIfExists(trendPath);
  const gateReview = readJsonIfExists(gatePath);
  const approvalReview = readJsonIfExists(approvalPath);
  const conclusionReview = readJsonIfExists(conclusionPath);
  const strategyDecision = readJsonIfExists(strategyDecisionPath) || {};
  const dataBundles = readJsonIfExists(dataBundlesPath) || {};
  const strategyDecisionText = JSON.stringify({
    reason: strategyDecision?.reason,
    note: strategyDecision?.note,
    trigger_signals: strategyDecision?.trigger_signals,
    source: strategyDecision?.source,
    forced: strategyDecision?.forced,
  });
  const needsHypothesisLedger =
    strategyDecision?.mode === "pivot" &&
    extractAccessionsFromText(strategyDecisionText).length > 0 &&
    (/user|explicit|selected|force|forced|pivot|operator|manual/i.test(strategyDecisionText) || strategyDecision?.forced === true);
  const hypothesisLedger = needsHypothesisLedger ? readJsonIfExists(hypothesisLedgerPath) || {} : {};
  const latestLabDirectorOutputs = latestLabDirectorLaneSummaries({ root, cycleId });
  const latestDecision = latestStructuredDecision(latestLabDirectorOutputs);
  const latestSourceMtime = Math.max(
    fileMtimeMs(cycleStatePath),
    fileMtimeMs(hypothesisPath),
    fileMtimeMs(trendPath),
    fileMtimeMs(gatePath),
    fileMtimeMs(approvalPath),
    fileMtimeMs(conclusionPath),
    fileMtimeMs(strategyDecisionPath),
    fileMtimeMs(dataBundlesPath),
    fileMtimeMs(hypothesisLedgerPath),
    ...latestLabDirectorOutputs.map((item) => item.updated_at_epoch_ms || 0),
  );
  const notesMtime = Math.max(fileMtimeMs(jsonPath), fileMtimeMs(markdownPath));
  if (!force && notesMtime >= latestSourceMtime && fs.existsSync(jsonPath) && fs.existsSync(markdownPath)) {
    return {
      json_path: jsonPath,
      markdown_path: markdownPath,
      updated: false,
      reason: "up_to_date",
    };
  }
  const forcedLead = forcedStrategyDecisionLead({ strategyDecision, dataBundles, hypothesisLedger });
  const currentLeadHypothesis = forcedLead || summarizeHypothesis(hypothesis, latestDecision);
  const hasValidationEvidence =
    Number(cycleState.lane_counts?.completed || 0) > 0 ||
    (Array.isArray(cycleState.lane_statuses) && cycleState.lane_statuses.some((lane) =>
      lane?.role === "lab-runner" && lane?.status === "completed"
    ));
  const blockerClassification = classifyReviewBlockers([
    ...(gateReview?.blockers || []),
    ...(gateReview?.major_objections || []),
    ...(approvalReview?.approval_blockers || []),
    ...(conclusionReview?.conclusion_blockers || []),
  ], {
    hasLeadHypothesis: Boolean(currentLeadHypothesis?.statement),
    hasDataset: Boolean(currentLeadHypothesis?.materialized_dataset || currentLeadHypothesis?.dataset_or_accession),
    hasValidationEvidence,
    currentLeadHypothesis,
    resolvedBlockerPatterns: resolvedBlockerPatternsForEvidence({ gateReview }),
  });
  const promotionArtifacts = readPromotionArtifacts({ root, cycleId });
  const nextActionAssignments = deriveNextActions({
    activeBlockers: blockerClassification.active_blockers,
    currentLeadHypothesis,
    latestDecision,
    gateReview,
  }).concat(promotionArtifactFollowupActions({
    promotionArtifacts,
    score: gateReview?.score ?? approvalReview?.approval_readiness_score ?? conclusionReview?.conclusion_score ?? null,
    blockers: blockerClassification.active_blockers,
  }));
  const notes = {
    ...existing,
    cycle_id: cycleId,
    updated_at: new Date().toISOString(),
    generated_by: "refresh-cycle-lab-director-research-notes",
    note_status: existing.generated_by ? "refreshed" : "fallback_created_because_lab_director_note_files_were_missing",
    current_lead_hypothesis: currentLeadHypothesis,
    latest_lab_director_decision: latestDecision,
    decision_log: Array.isArray(existing.decision_log) ? existing.decision_log.slice(-20) : [],
    evidence_snapshot: {
      lane_counts: cycleState.lane_counts || {},
      gate: gateSnapshot(gateReview),
      approval: approvalSnapshot(approvalReview),
      conclusion: conclusionSnapshot(conclusionReview),
      trend_available: Boolean(trend),
      hypothesis_available: Boolean(hypothesis),
    },
    open_blockers: blockerClassification.active_blockers.slice(0, 24),
    resolved_or_superseded_blockers: blockerClassification.resolved_or_superseded_blockers.slice(0, 24),
    stale_blockers: blockerClassification.stale_blockers.slice(0, 24),
    duplicate_blockers: blockerClassification.duplicate_blockers.slice(0, 24),
    communication_quality: {
      ...blockerClassification,
      missing_lead_statement: !currentLeadHypothesis?.statement,
      latest_decision_lane_id: latestDecision?.lane_id || null,
    },
    promotion_artifact_resolution: promotionArtifacts,
    rejected_or_demoted_hypotheses: Array.isArray(existing.rejected_or_demoted_hypotheses)
      ? existing.rejected_or_demoted_hypotheses
      : [],
    dataset_and_tool_context: {
      selected_dataset: currentLeadHypothesis?.materialized_dataset || currentLeadHypothesis?.dataset_or_accession || null,
      same_dataset_reference_papers: currentLeadHypothesis?.same_dataset_reference_papers || [],
      reference_methods_baseline: currentLeadHypothesis?.reference_methods_baseline || null,
      repository_workflow_context:
        blockerClassification.active_blockers.find((item) => item.toLowerCase().includes("repository-native")) || null,
    },
    next_action_assignments: nextActionAssignments,
    next_actions: nextActionAssignments.map((item) => item.description),
    latest_lab_director_outputs: latestLabDirectorOutputs,
    source_paths: {
      cycle_state: fs.existsSync(cycleStatePath) ? cycleStatePath : null,
      hypothesis: fs.existsSync(hypothesisPath) ? hypothesisPath : null,
      research_trend_analysis: fs.existsSync(trendPath) ? trendPath : null,
      gate_review: fs.existsSync(gatePath) ? gatePath : null,
      approval_review: fs.existsSync(approvalPath) ? approvalPath : null,
      conclusion_review: fs.existsSync(conclusionPath) ? conclusionPath : null,
      strategy_decision: fs.existsSync(strategyDecisionPath) ? strategyDecisionPath : null,
      data_bundles: fs.existsSync(dataBundlesPath) ? dataBundlesPath : null,
      hypothesis_ledger: fs.existsSync(hypothesisLedgerPath) ? hypothesisLedgerPath : null,
    },
  };
  notes.handoff_for_next_lab_director = [
    "Read this notebook before choosing the next hypothesis or pivot.",
    notes.current_lead_hypothesis?.statement
      ? `Current lead hypothesis: ${notes.current_lead_hypothesis.statement}`
      : "No accepted lead hypothesis is recorded yet.",
    notes.next_actions.length
      ? `Next concrete action: ${notes.next_actions[0]}`
      : notes.open_blockers.length
        ? `Resolve first active blocker: ${notes.open_blockers[0]}`
        : "No active blocker is currently recorded by gate/approval/conclusion review.",
    notes.resolved_or_superseded_blockers.length
      ? "Do not reissue resolved empty-package blockers as active work; keep them only in the resolved/superseded section."
      : "",
  ].filter(Boolean).join(" ");

  writeJson(jsonPath, notes);
  writeMarkdownNotes(markdownPath, notes);
  const hypothesisProjectionPath = projectNotesLeadToHypothesis({
    stateRoot,
    cycleId,
    notes,
  });
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    hypothesis_projection_path: hypothesisProjectionPath,
    updated: true,
    reason: notes.note_status,
  };
}

module.exports = {
  ensureLabDirectorResearchNotes,
  // Exported so the archive-before-replace rule can be tested on the function
  // that actually writes the lead, rather than asserted against source text.
  projectNotesLeadToHypothesis,
};
