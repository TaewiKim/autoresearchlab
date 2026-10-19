"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ensureDir, writeJson } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");
const { buildFigureDeck } = require("./figure_deck");
const { normalizeReference, referenceQuality } = require("./reference_policy");
const {
  buildPaperPdf,
  documentRefinementEligible,
  buildPaperFigurePanels,
  buildReportFigureSpec,
} = require("./document_artifacts/figures");
const {
  collectAuthoredDocument,
  applyAuthoredDocument,
  applyAuthoredReport,
} = require("./document_artifacts/authored");
const {
  recordExperimentRequests,
  applyDirectorExperimentDecisions,
} = require("./experiment_requests");
const {
  renderReportMarkdown,
  renderReportHtml,
  renderPaperMarkdown,
  renderPaperTex,
} = require("./document_artifacts/renderers");

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function uniqueStrings(values, limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const value of asArray(values)) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function latexEscape(value) {
  return String(value || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function latestVersionedJson(dirPath, prefix) {
  if (!fs.existsSync(dirPath)) return null;
  const candidates = fs
    .readdirSync(dirPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  return candidates.length ? path.join(dirPath, candidates[candidates.length - 1]) : null;
}

function nextRevision(dirPath, prefix) {
  if (!fs.existsSync(dirPath)) return 1;
  let latest = 0;
  for (const name of fs.readdirSync(dirPath)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const middle = name.slice(prefix.length, -".json".length);
    const match = middle.match(/^v(\d+)$/);
    if (!match) continue;
    latest = Math.max(latest, Number(match[1] || 0));
  }
  return latest + 1;
}

function childFiles(root, cycleId, relativePath) {
  const candidates = [];
  for (const base of [
    path.join(root, "lanes", cycleId),
    path.join(root, "artifacts", "stats", cycleId),
  ]) {
    if (!fs.existsSync(base)) continue;
    for (const child of fs.readdirSync(base)) {
      const filePath = path.join(base, child, relativePath);
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

function normalizedText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]+/g, " ").trim();
}

function textTokenSet(value) {
  return new Set(
    normalizedText(value)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4),
  );
}

function overlapCount(left, right) {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function resultHypothesisText(result = {}) {
  return asArray(result.selected_hypotheses)
    .concat(asArray(result.hypothesis_results))
    .map((item) => String(item?.statement || item?.claim || item?.hypothesis || item || ""))
    .concat([
      result?.validation_summary?.primary_hypothesis_id,
      result?.primary_hypothesis_id,
      result?.summary,
    ].filter(Boolean))
    .join(" ");
}

function expectedDatasetRootFromResult(result = {}) {
  const rolePlan = result?.role_plan || {};
  return (
    rolePlan?.planner_metadata?.handoff_validation_plan?.dataset_root ||
    rolePlan?.planner_metadata?.analyst_handoff?.dataset_root ||
    rolePlan?.planner_metadata?.cycle_analyst_handoff?.dataset_root ||
    rolePlan?.planner_metadata?.cycle_analyst_handoff?.payload?.dataset_root ||
    rolePlan?.handoff_validation_plan?.dataset_root ||
    rolePlan?.analyst_handoff?.dataset_root ||
    null
  );
}

function pathContainsOrEquals(parent, child) {
  if (!parent || !child) return false;
  const parentPath = path.resolve(String(parent));
  const childPath = path.resolve(String(child));
  if (parentPath === childPath) return true;
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resultMatchesLeadHypothesis(result = {}, leadHypothesis = null) {
  if (result?.role_plan?.planner_metadata?.runner_handoff_required === true) return false;
  const expectedDatasetRoot = expectedDatasetRootFromResult(result);
  if (expectedDatasetRoot && !pathContainsOrEquals(expectedDatasetRoot, result?.dataset_root)) return false;
  const leadText = [
    leadHypothesis?.statement,
    leadHypothesis?.core_claim,
    leadHypothesis?.hypothesis_id,
    leadHypothesis?.family_root,
  ].filter(Boolean).join(" ");
  if (!leadText) return true;
  const leadTokens = textTokenSet(leadText);
  if (leadTokens.size < 4) return true;
  const resultTokens = textTokenSet(resultHypothesisText(result));
  const overlap = overlapCount(leadTokens, resultTokens);
  const requiredOverlap = Math.min(4, Math.max(2, Math.ceil(leadTokens.size * 0.08)));
  return overlap >= requiredOverlap;
}

function latestChildFile(root, cycleId, relativePath) {
  const candidates = childFiles(root, cycleId, relativePath);
  return candidates[0]?.filePath || null;
}

function latestRelevantChildFile(root, cycleId, relativePath, leadHypothesis) {
  const candidates = childFiles(root, cycleId, relativePath);
  for (const candidate of candidates) {
    const resultPath = relativePath === "result.json"
      ? candidate.filePath
      : path.join(path.dirname(candidate.filePath), "result.json");
    const result = readJsonIfExists(resultPath);
    if (!result || resultMatchesLeadHypothesis(result, leadHypothesis)) {
      return candidate.filePath;
    }
  }
  return null;
}

function latestArtifactDir(root, cycleId, relativePath = "") {
  const filePath = latestChildFile(root, cycleId, relativePath || "result.json");
  return filePath ? path.dirname(filePath) : null;
}

function numericIndicatorValue(item) {
  for (const key of ["value", "summary_stat", "score", "count"]) {
    const value = Number(item?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function topDerivedIndicators(derived, limit = 5) {
  return asArray(derived)
    .map((item) => ({
      name: String(item?.name || item?.label || "derived_indicator"),
      value: numericIndicatorValue(item),
      summary_stat: Number.isFinite(Number(item?.summary_stat)) ? Number(item.summary_stat) : null,
      raw: item,
    }))
    .filter((item) => item.value != null || item.summary_stat != null)
    .sort((a, b) => Math.abs(Number(b.value ?? b.summary_stat ?? 0)) - Math.abs(Number(a.value ?? a.summary_stat ?? 0)))
    .slice(0, limit);
}

function normalizeSupplementContext(supplement = {}) {
  const supplementArtifacts = supplement.supplement_artifacts || supplement.supplementary_tables || {};
  return {
    ...supplement,
    supplement_artifacts: supplementArtifacts,
    top_feature_results: asArray(supplement.top_feature_results).length
      ? asArray(supplement.top_feature_results)
      : asArray(supplement.top_de_genes),
    validation_panels: asArray(supplement.validation_panels).length
      ? asArray(supplement.validation_panels)
      : asArray(supplement.nk_marker_panel),
    category_normalized_tests: asArray(supplement.category_normalized_tests).length
      ? asArray(supplement.category_normalized_tests)
      : asArray(supplement.pathway_normalized_tests),
    model_feasibility_note: supplement.model_feasibility_note || supplement.deseq2_edger_note || null,
  };
}

function leadHypothesisFromView(researcherView) {
  const focus = asArray(researcherView?.summary?.focus_hypotheses || researcherView?.focus_hypotheses);
  return (
    focus.find((item) => item?.state === "provisionally_promoted" || item?.latest_status === "robust") ||
    focus[0] ||
    null
  );
}

function collectLeadEvidence({ root, cycleId, leadHypothesis }) {
  const validation = readJsonIfExists(path.join(root, "state", `${cycleId}-validation-results.json`)) || {};
  const traceState = readJsonIfExists(path.join(root, "state", `${cycleId}-claim-traces.json`)) || {};
  const runnerSummaryPath = latestRelevantChildFile(root, cycleId, "validation-summary.json", leadHypothesis);
  const preferredRunnerResultPath = runnerSummaryPath
    ? path.join(path.dirname(runnerSummaryPath), "result.json")
    : null;
  const runnerResultPath =
    (preferredRunnerResultPath && fs.existsSync(preferredRunnerResultPath) && preferredRunnerResultPath) ||
    latestRelevantChildFile(root, cycleId, "result.json", leadHypothesis);
  const runnerResult = readJsonIfExists(runnerResultPath) || {};
  const runnerSummary =
    readJsonIfExists(runnerSummaryPath) ||
    runnerResult.validation_summary ||
    {};
  const referenceContext =
    readJsonIfExists(path.join(root, "state", `${cycleId}-document-reference-context.json`)) || {};
  const supplementContext =
    readJsonIfExists(path.join(root, "state", `${cycleId}-document-supplement-context.json`)) || {};
  const hypothesisId = String(leadHypothesis?.hypothesis_id || "");
  const validations = asArray(validation.validation_results).filter((item) =>
    asArray(item?.target_hypothesis_ids).includes(hypothesisId),
  );
  const claimTrace = asArray(traceState.claim_traces).find((item) => item?.hypothesis_id === hypothesisId) || null;
  const derived = asArray(runnerResult.derived_indicator_outcomes);
  const topIndicators = topDerivedIndicators(derived);
  const primaryCorrelation =
    derived.find((item) => /(recomput|concord|correlat|agreement)/i.test(String(item?.name || item?.label || ""))) ||
    topIndicators.find((item) => Math.abs(Number(item.value ?? item.summary_stat ?? 0)) <= 1) ||
    null;
  const primarySignal = topIndicators[0] || null;
  const secondarySignal = topIndicators[1] || null;
  const artifactDir =
    (runnerSummaryPath && path.dirname(runnerSummaryPath)) ||
    (runnerResultPath && path.dirname(runnerResultPath)) ||
    latestArtifactDir(root, cycleId) ||
    path.join(root, "artifacts", "stats", cycleId);

  return {
    validation_results: validations,
    claim_trace: claimTrace,
    validation_summary: runnerSummary,
    derived_indicators: derived,
    metrics: {
      blueprint_passes: Number(runnerSummary.blueprints_passed || 0),
      checks_passed_count: Object.values(runnerSummary.checks || {}).filter(Boolean).length,
      method_appropriateness_score: Number(runnerSummary.method_appropriateness_score || 0),
      analysis_accuracy_score: Number(runnerSummary.analysis_accuracy_score || 0),
      primary_recompute_correlation: Number(numericIndicatorValue(primaryCorrelation) || 0),
      primary_signal_count: Number(primarySignal?.value || 0),
      secondary_signal_count: Number(secondarySignal?.value || 0),
      derived_indicator_count: derived.length,
      validation_result_count: validations.length,
    },
    artifacts: {
      runner_result: runnerResultPath,
      validation_summary: runnerSummaryPath,
      summary_md: latestChildFile(root, cycleId, "summary.md"),
      artifact_dir: artifactDir,
    },
    top_derived_indicators: topIndicators,
    reference_context: referenceContext,
    supplement_context: supplementContext,
  };
}

function highImpactSections({ cycleId, leadHypothesis, evidence, gateReview }) {
  const statement = String(leadHypothesis?.statement || "No promoted hypothesis statement was available.");
  const metrics = evidence.metrics || {};
  const sensitivity = evidence.validation_summary?.gatekeeper_challenge_response?.sensitivity_key_counts || [];
  const supplement = normalizeSupplementContext(evidence.supplement_context || {});
  const references = asArray(evidence.reference_context?.references);
  const normalizedReferences = references.map(normalizeReference);
  const limitations = uniqueStrings([
    "The inference is scoped to the materialized source data and generated validation artifacts available in this cycle.",
    "Internal reproducibility does not by itself establish external validity or population-level generalization.",
    "Source selection, measurement error, missingness, preprocessing choices, and model specification remain plausible threats unless directly tested.",
    "A high-impact original article should attempt independent, orthogonal, or sensitivity validation before broad mechanistic or policy generalization.",
  ]);
  const nextTests = uniqueStrings([
    "Attempt replication in an independent public dataset or document an explicit failed search with query, access, and mapping reasons.",
    "Run a stricter sensitivity analysis or negative-control analysis tied to the main identification strategy.",
    "Audit whether alternative preprocessing, feature construction, or model specifications change the promoted conclusion.",
    "Map the promoted signal to a concrete follow-up measurement or validation design before broad interpretation.",
  ]);
  const derivedFindings = asArray(evidence.top_derived_indicators)
    .slice(0, 3)
    .map((item) => `${item.name}: ${Number(item.value ?? item.summary_stat ?? 0).toFixed(3)}.`);
  const titleStem = statement.length > 92 ? `${statement.slice(0, 89)}...` : statement;
  return {
    title: `Scoped ResearchLab evidence package: ${titleStem}`,
    short_title: "Scoped ResearchLab evidence package",
    article_type: "high-impact brief report / research letter candidate",
    lead_claim: statement,
    executive_summary:
      "The promoted claim is deliberately narrow but decision-relevant: ResearchLab separates the dataset-native evidence that passed internal checks from broader claims that still require independent, orthogonal, or sensitivity validation. The document package is written for high-impact journal-style scrutiny by making artifact provenance, quantitative anchors, limitations, and next validation steps explicit.",
    key_findings: [
      `The validation blueprint passed ${metrics.checks_passed_count || 0} checks with method score ${metrics.method_appropriateness_score || "n/a"} and accuracy score ${metrics.analysis_accuracy_score || "n/a"}.`,
      Number.isFinite(metrics.primary_recompute_correlation) && metrics.primary_recompute_correlation !== 0
        ? `The strongest recomputation or concordance metric is ${Number(metrics.primary_recompute_correlation).toFixed(3)}, supporting an audit trail between source data and the promoted signal.`
        : null,
      metrics.validation_result_count
        ? `${metrics.validation_result_count} validation result(s) are linked directly to the promoted hypothesis.`
        : null,
      ...derivedFindings,
    ].filter(Boolean),
    sensitivity_summary: sensitivity,
    supplement,
    limitations,
    next_tests: nextTests,
    references: normalizedReferences,
    reference_quality: referenceQuality(normalizedReferences),
    gate_context: {
      hypothesis_gate_passed: gateReview?.gate_passed === true,
      gate_mode: gateReview?.mode || null,
      gatekeeper_review_count: asArray(gateReview?.gatekeeper_reviews).length,
    },
  };
}

function buildReportDocument({ cycleId, revision, sections, evidence, contentHash }) {
  const supplement = normalizeSupplementContext(sections.supplement || {});
  return {
    cycle_id: cycleId,
    revision,
    generated_at: new Date().toISOString(),
    generated_by: "document-artifact-builder",
    document_type: "research_report",
    content_hash: contentHash,
    high_impact_standard: {
      enabled: true,
      profile: "high-impact research report",
      standard: "claim discipline, exact quantitative evidence, auditability, bias disclosure, and decision-useful next tests",
    },
    title: sections.title,
    article_type: sections.article_type,
    executive_summary: sections.executive_summary,
    lead_claim: sections.lead_claim,
    key_findings: sections.key_findings,
    validation_metrics: evidence.metrics,
    sensitivity_summary: sections.sensitivity_summary,
    supplementary_tables: supplement.supplement_artifacts || {},
    top_feature_results: asArray(supplement.top_feature_results).slice(0, 12),
    validation_panels: asArray(supplement.validation_panels),
    category_normalized_tests: asArray(supplement.category_normalized_tests),
    category_test_note: "Class-size normalization compares each prespecified category's signal rate against the full tested background when such categories are supplied.",
    classification_rules: asArray(supplement.classification_rules),
    validation_checklist: asArray(supplement.validation_checklist),
    figure_captions: asArray(supplement.figure_captions),
    figure_deck: null,
    figure_asset_policy: null,
    ontology_version_note: supplement.ontology_version_note || null,
    model_feasibility_note: supplement.model_feasibility_note || null,
    ethics_note: supplement.ethics_note || null,
    accession_note: supplement.accession_note || null,
    reference_discussion_points: asArray(supplement.reference_discussion_points),
    limitations: sections.limitations,
    recommended_next_tests: sections.next_tests,
    references: sections.references,
    reference_quality: sections.reference_quality,
    evidence_artifacts: evidence.artifacts,
    primary_claim_count: 1,
    supporting_claim_count: sections.key_findings.length,
    open_question_count: sections.limitations.length,
    recommended_action_count: sections.next_tests.length,
    reviewer_contract: {
      report_gate: "must pass communication, evidence traceability, limitation transparency, actionability, visual/table support, and high-impact framing without overclaiming",
      paper_gate: "must pass abstract, IMRaD structure, reproducibility, statistical reporting, novelty positioning, limitations, data/code availability, references, and submission discipline",
    },
  };
}

function buildPaperDocument({ cycleId, revision, sections, evidence, contentHash }) {
  const supplement = normalizeSupplementContext(sections.supplement || {});
  return {
    cycle_id: cycleId,
    revision,
    generated_at: new Date().toISOString(),
    generated_by: "document-artifact-builder",
    document_type: "paper",
    content_hash: contentHash,
    high_impact_standard: {
      enabled: true,
      profile: "high-impact journal brief report / research letter",
      article_class: "brief_report",
    },
    title: sections.title,
    short_title: sections.short_title,
    abstract: {
      background: "ResearchLab promoted a scoped hypothesis after internal validation, but high-impact review requires clear separation between dataset-native evidence and broader generalization.",
      methods: "We assembled the gate-passed hypothesis, generated validation artifacts, source-data traces, quantitative checks, sensitivity notes, and reference context into an auditable manuscript draft. The manuscript preserves exact artifact paths and reports the validation assumptions that remain unresolved.",
      results: `The validation package passed ${evidence.metrics.checks_passed_count || 0} recorded checks with method score ${evidence.metrics.method_appropriateness_score || "n/a"} and accuracy score ${evidence.metrics.analysis_accuracy_score || "n/a"}. The strongest recomputation or concordance metric was ${Number(evidence.metrics.primary_recompute_correlation || 0).toFixed(3)}, and ${evidence.metrics.validation_result_count || 0} validation result(s) were directly linked to the promoted hypothesis.`,
      interpretation: "The result should be read as a bounded, hypothesis-generating claim unless independent, orthogonal, or stricter sensitivity validation is completed and archived.",
    },
    introduction: [
      "High-impact manuscript review rewards claims that are narrow enough to be falsifiable and traceable to generated evidence artifacts.",
      "The present draft tests whether the gate-passed ResearchLab hypothesis can be reported with sufficient quantitative specificity, provenance, limitation discipline, and next-validation clarity.",
    ],
    methods: [
      "Input evidence was restricted to the materialized source data, lane outputs, validation summaries, claim traces, and document-reference context available under the cycle runtime directory.",
      "The primary numeric audit uses generated validation metrics rather than manuscript prose as the source of truth.",
      "Sensitivity, category-normalized, or subgroup checks are reported when the runner supplies them; absent checks remain limitations rather than inferred support.",
      sections.supplement?.model_feasibility_note || "Additional model-based reanalysis is reported only when the source data and design metadata make it executable.",
      "Reporting explicitly marks source selection, measurement, missing-data, and external-validity gaps inherited from the available data.",
    ].filter(Boolean),
    results: [
      ...sections.key_findings,
      `Top quantitative feature anchors are reported in ${sections.supplement?.supplement_artifacts?.top_feature_results || "the supplementary feature table when available"}.`,
      `Validation panels and category checks are reported in ${sections.supplement?.supplement_artifacts?.validation_panels || "the available supplementary validation tables"}.`,
      `Sensitivity and class-size-normalized checks are reported in ${sections.supplement?.supplement_artifacts?.category_background_normalized || "the generated sensitivity artifacts when available"}.`,
    ],
    discussion: [
      "The central contribution is not a broad domain claim, but a disciplined statement of what the current evidence package most strongly supports.",
      "The manuscript should treat untested rival explanations and missing external validation as decision-critical, not as cosmetic caveats.",
      ...(sections.supplement?.reference_discussion_points || []),
      "A high-impact follow-up should test whether the promoted signal survives an independent dataset, orthogonal measurement, or stricter negative-control/sensitivity design.",
    ],
    limitations: sections.limitations,
    data_code_availability: [
      evidence.artifacts.runner_result ? `Primary runner result: ${evidence.artifacts.runner_result}.` : null,
      evidence.artifacts.artifact_dir ? `Generated analysis artifacts are under ${evidence.artifacts.artifact_dir}.` : null,
      "Source identifiers, generated tables, sensitivity notes, and bias/missing-data disclosures are archived with the runtime outputs when available.",
      sections.supplement?.accession_note || null,
      sections.supplement?.ethics_note || null,
    ].filter(Boolean),
    supplementary_tables: supplement.supplement_artifacts || {},
    top_feature_results: asArray(supplement.top_feature_results).slice(0, 12),
    validation_panels: asArray(supplement.validation_panels),
    category_normalized_tests: asArray(supplement.category_normalized_tests),
    category_test_note: "Class-size normalization compares each prespecified category's signal rate against the full tested background when such categories are supplied.",
    classification_rules: asArray(supplement.classification_rules),
    validation_checklist: asArray(supplement.validation_checklist),
    figure_captions: asArray(supplement.figure_captions),
    figure_deck: null,
    figure_asset_policy: null,
    ontology_version_note: supplement.ontology_version_note || null,
    model_feasibility_note: supplement.model_feasibility_note || null,
    ethics_note: supplement.ethics_note || null,
    accession_note: supplement.accession_note || null,
    references: sections.references,
    reference_quality: sections.reference_quality,
    tables_and_figures: [
      "Primary signal plot built from available quantitative feature anchors.",
      "Validation-summary chart contrasting main, rival, and sensitivity evidence when available.",
      "Evidence-trace panel linking claims to source tables, validation artifacts, and review constraints.",
      "Supplementary classification, sensitivity, and audit tables when supplied by the runner.",
      "Separate PPTX figure deck with SVG artwork and editable PPT text labels.",
    ],
    reviewer_contract: {
      claim_scope: "dataset-internal, descriptive, hypothesis-generating",
      no_overclaiming: true,
      figure_images_inserted_in_manuscript: true,
      detailed_figure_explanations_required: true,
      high_impact_reference_verification_required: true,
      high_impact_readiness_bar: "ready as a brief report/research letter draft only if reviewers accept the intentionally narrow claim class",
    },
  };
}

function ownerDocumentAuthorization({ root, cycleId }) {
  const filePath = path.join(root, "state", `${cycleId}-document-authorization.json`);
  const stored = readJsonIfExists(filePath);
  const authorized = stored?.authorized === true
    && String(stored?.reason || "").trim().length > 0;
  return { authorized, path: authorized ? filePath : null, record: stored || null };
}

function buildDocumentArtifacts({ cwd = process.cwd(), cycleId, researcherView, gateReview }) {
  const gate = gateReview?.review || gateReview || {};
  const independentlyApproved =
    gate.conclusion_gate_passed === true &&
    gate.gatekeeper_review?.verdict === "approve" &&
    asArray(gate.gatekeeper_pending_rubrics).length === 0 &&
    asArray(gate.challenge_questions).length === 0 &&
    asArray(gate.blockers).length === 0;
  const draftRefinementEligible = documentRefinementEligible(gate);
  const root = runtimeRoot(cwd);
  // The same authorization the Rust dependency gate reads to release the author
  // and illustrator lanes. Releasing the lanes but not the document build leaves
  // the manuscript inside a lane result, where no review can reach it -- opening
  // a path partway is the same as not opening it.
  const ownerAuthorization = ownerDocumentAuthorization({ root, cycleId });
  if (
    gate.gate_passed !== true
    && !independentlyApproved
    && !draftRefinementEligible
    && !ownerAuthorization.authorized
  ) {
    return {
      built: false,
      reason: "hypothesis gate has not passed or independent gatekeeper approval is incomplete",
      report_path: null,
      paper_path: null,
    };
  }
  const viewSummary = researcherView?.summary || researcherView || {};
  const leadHypothesis = leadHypothesisFromView(viewSummary);
  if (!leadHypothesis) {
    return {
      built: false,
      reason: "no focus hypothesis available for document generation",
      report_path: null,
      paper_path: null,
    };
  }
  const evidence = collectLeadEvidence({ root, cycleId, leadHypothesis });
  const sections = highImpactSections({ cycleId, leadHypothesis, evidence, gateReview: gate });
  const contentHash = stableHash({
    document_schema_version: 6,
    lead: leadHypothesis?.hypothesis_id,
    statement: sections.lead_claim,
    metrics: evidence.metrics,
    sensitivity: sections.sensitivity_summary,
    supplement: {
      feature_summary: sections.supplement?.feature_summary || sections.supplement?.de_summary || null,
      top_feature_results: asArray(sections.supplement?.top_feature_results).map((item) => item.feature_name || item.name || item.id || ""),
      normalized_tests: asArray(sections.supplement?.category_normalized_tests).map((item) => [
        item.analysis_type,
        item.class || item.category,
        item.class_sig_fdr_lt_0_1,
        item.class_terms,
      ]),
    },
    references: sections.references.map((item) => item.title || item.url || item.doi || ""),
  });
  const reportsDir = path.join(root, "reports");
  const papersDir = path.join(root, "papers");
  ensureDir(reportsDir);
  ensureDir(papersDir);
  const reportPrefix = `${cycleId}-research-report-`;
  const paperPrefix = `${cycleId}-paper-`;
  const latestReportPath = latestVersionedJson(reportsDir, reportPrefix);
  const latestReport = readJsonIfExists(latestReportPath);
  if (latestReport?.generated_by === "document-artifact-builder" && latestReport?.content_hash === contentHash) {
    const rev = Number(latestReport.revision || 1);
    const revSuffix = `v${String(rev).padStart(4, "0")}`;
    const reusePaths = {
      report_path: latestReportPath,
      report_markdown_path: path.join(reportsDir, `${cycleId}-research-report-${revSuffix}.md`),
      report_html_path: path.join(reportsDir, `${cycleId}-research-report-${revSuffix}.html`),
      paper_path: path.join(papersDir, `${cycleId}-paper-${revSuffix}.json`),
      paper_markdown_path: path.join(papersDir, `${cycleId}-paper-${revSuffix}.md`),
      paper_tex_path: path.join(papersDir, `${cycleId}-paper-${revSuffix}.tex`),
      paper_pdf_path: path.join(papersDir, `${cycleId}-paper-${revSuffix}.pdf`),
    };
    const requiredReusePaths = [
      reusePaths.report_path,
      reusePaths.report_markdown_path,
      reusePaths.report_html_path,
      reusePaths.paper_path,
      reusePaths.paper_markdown_path,
      reusePaths.paper_tex_path,
    ];
    const reusable = requiredReusePaths.every((filePath) => filePath && fs.existsSync(filePath));
    if (reusable) {
      const figureDeck = buildFigureDeck({ root, cycleId, revision: rev, sections, evidence, contentHash });
      const figureAssetPolicy = {
        separate_ppt_required: true,
        deck_format: "pptx",
        graphics_format: "svg",
        text_authoring: "panel labels, axis labels, legends, tick labels, value labels, and essential callouts are authored in PPT text boxes; captions, slide titles, and key-message prose are rendered by LaTeX/manifest text",
        svg_artwork_rule: "SVG artwork must not contain embedded text elements",
      };
      const report = buildReportDocument({ cycleId, revision: rev, sections, evidence, contentHash });
      const paper = buildPaperDocument({ cycleId, revision: rev, sections, evidence, contentHash });
      report.figure_deck = figureDeck;
      report.figure_asset_policy = figureAssetPolicy;
      report.figure_spec = buildReportFigureSpec(figureDeck);
      paper.figure_deck = figureDeck;
      paper.figure_asset_policy = figureAssetPolicy;
      paper.figure_panels = buildPaperFigurePanels({ figureDeck, paper, evidence });
      const authoredReuse = collectAuthoredDocument({ root, cycleId });
      applyAuthoredDocument(paper, authoredReuse);
      applyAuthoredReport(report, authoredReuse);
      // This path returns before the ledger below, so the author's requests
      // were folded, applied, and then dropped on every reuse pass.
      recordExperimentRequests({
        root,
        cycleId,
        requests: authoredReuse?.additional_experiments_requested,
        source: authoredReuse?.provenance?.author_lane_result || null,
      });
      applyDirectorExperimentDecisions({ root, cycleId });
      // Keep reused document files synchronized when figure deck schema or panel IDs evolve.
      writeJson(reusePaths.report_path, report);
      fs.writeFileSync(reusePaths.report_markdown_path, renderReportMarkdown(report), "utf8");
      fs.writeFileSync(reusePaths.report_html_path, renderReportHtml(report), "utf8");
      writeJson(reusePaths.paper_path, paper);
      fs.writeFileSync(reusePaths.paper_markdown_path, renderPaperMarkdown(paper), "utf8");
      fs.writeFileSync(reusePaths.paper_tex_path, renderPaperTex(paper), "utf8");
      const paperPdf = buildPaperPdf(reusePaths.paper_tex_path);
      paper.paper_pdf_path = paperPdf.paper_pdf_path;
      paper.paper_pdf_build = paperPdf.paper_pdf_build;
      writeJson(reusePaths.paper_path, paper);
      return {
        built: false,
        reused: true,
        reason: "latest document artifacts already match the current gate-passed claim",
        ...reusePaths,
        paper_pdf_path: paperPdf.paper_pdf_path,
        paper_pdf_build: paperPdf.paper_pdf_build,
        figure_deck: figureDeck,
        refreshed_existing_revision: true,
        revision: rev,
        content_hash: contentHash,
      };
    }
  }

  const revision = nextRevision(reportsDir, reportPrefix);
  const rev = String(revision).padStart(4, "0");
  const report = buildReportDocument({ cycleId, revision, sections, evidence, contentHash });
  const paper = buildPaperDocument({ cycleId, revision, sections, evidence, contentHash });
  const figureDeck = buildFigureDeck({ root, cycleId, revision, sections, evidence, contentHash });
  const figureAssetPolicy = {
    separate_ppt_required: true,
    deck_format: "pptx",
    graphics_format: "svg",
    text_authoring: "panel labels, axis labels, legends, tick labels, value labels, and essential callouts are authored in PPT text boxes; captions, slide titles, and key-message prose are rendered by LaTeX/manifest text",
    svg_artwork_rule: "SVG artwork must not contain embedded text elements",
  };
  report.figure_deck = figureDeck;
  report.figure_asset_policy = figureAssetPolicy;
  report.figure_spec = buildReportFigureSpec(figureDeck);
  paper.figure_deck = figureDeck;
  paper.figure_asset_policy = figureAssetPolicy;
  paper.figure_panels = buildPaperFigurePanels({ figureDeck, paper, evidence });
  const authoredDocument = collectAuthoredDocument({ root, cycleId });
  applyAuthoredDocument(paper, authoredDocument);
  applyAuthoredReport(report, authoredDocument);
  // Clause 1e lets the author name the run that would license a sentence it
  // cannot yet write. The requests are recorded here so they outlive the lane
  // result: the director decides on them, and an adopted one becomes analyst
  // work. Without this the author was asking into a file nobody opened.
  recordExperimentRequests({
    root,
    cycleId,
    requests: authoredDocument?.additional_experiments_requested,
    source: authoredDocument?.provenance?.author_lane_result || null,
  });
  applyDirectorExperimentDecisions({ root, cycleId });
  paper.owner_document_authorization = ownerAuthorization.record;
  const reportJsonPath = path.join(reportsDir, `${cycleId}-research-report-v${rev}.json`);
  const reportMarkdownPath = path.join(reportsDir, `${cycleId}-research-report-v${rev}.md`);
  const reportHtmlPath = path.join(reportsDir, `${cycleId}-research-report-v${rev}.html`);
  const paperJsonPath = path.join(papersDir, `${cycleId}-paper-v${rev}.json`);
  const paperMarkdownPath = path.join(papersDir, `${cycleId}-paper-v${rev}.md`);
  const paperTexPath = path.join(papersDir, `${cycleId}-paper-v${rev}.tex`);

  writeJson(reportJsonPath, report);
  fs.writeFileSync(reportMarkdownPath, renderReportMarkdown(report), "utf8");
  fs.writeFileSync(reportHtmlPath, renderReportHtml(report), "utf8");
  writeJson(paperJsonPath, paper);
  fs.writeFileSync(paperMarkdownPath, renderPaperMarkdown(paper), "utf8");
  fs.writeFileSync(paperTexPath, renderPaperTex(paper), "utf8");
  const paperPdf = buildPaperPdf(paperTexPath);
  paper.paper_pdf_path = paperPdf.paper_pdf_path;
  paper.paper_pdf_build = paperPdf.paper_pdf_build;
  writeJson(paperJsonPath, paper);

  return {
    built: true,
    report_path: reportJsonPath,
    report_markdown_path: reportMarkdownPath,
    report_html_path: reportHtmlPath,
    paper_path: paperJsonPath,
    paper_markdown_path: paperMarkdownPath,
    paper_tex_path: paperTexPath,
    paper_pdf_path: paperPdf.paper_pdf_path,
    paper_pdf_build: paperPdf.paper_pdf_build,
    figure_deck: figureDeck,
    revision,
    content_hash: contentHash,
  };
}

module.exports = {
  buildDocumentArtifacts,
  collectLeadEvidence,
  highImpactSections,
  buildReportDocument,
  buildPaperDocument,
  buildPaperFigurePanels,
  buildReportFigureSpec,
  renderReportMarkdown,
  renderReportHtml,
  renderPaperMarkdown,
  renderPaperTex,
  buildPaperPdf,
};
