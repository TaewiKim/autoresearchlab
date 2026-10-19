"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readApprovalState } = require("../src/policy/approval_policy");
const { readGateState } = require("../src/policy/gate_policy");
const { conclusionFollowupActions } = require("../src/policy/retry_policy");
const { buildApprovalReview } = require("../src/reporting/approval_review");
const { buildConclusionReview } = require("../src/reporting/conclusion_review");
const { paperRubric, buildPaperReview, buildPaperReviewComments, paperAnalysisRequests, paperFigureProductionRequests } = require("../src/reporting/document_reviews");
const { referenceQuality } = require("../src/reporting/reference_policy");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function passingTextBoxQuality() {
  return {
    passed: true,
    text_box_count: 10,
    minimum_font_size: 8,
    minimum_required_font_size: 8,
    undersized_text_boxes: [],
    overlap_count: 0,
    overlaps: [],
    out_of_bounds: [],
  };
}

function passingRenderedImageQuality() {
  return {
    passed: true,
    width: 1600,
    height: 900,
    content_bbox_width_fraction: 0.9,
    content_bbox_height_fraction: 0.7,
    dark_pixel_ratio: 0.02,
    issues: [],
  };
}

test("approval policy prefers unified review schema fields", () => {
  const summary = {
    researcher_view: {
      summary: {
        research_outcome: "approved",
      },
    },
    report_review: {
      review: {
        communication_gate_passed: true,
      },
    },
    paper_review: {
      review: {
        submission_gate_passed: true,
      },
    },
    approval_review: {
      review: {
        score: 93,
        blockers: ["needs one more validation"],
        recommended_actions: [{ type: "methods_followup" }],
        decision_mode: "refine",
        decision_reason: "approval blockers remain",
      },
    },
  };

  const state = readApprovalState(summary);
  assert.equal(state.passed, true);
  assert.equal(state.score, 93);
  assert.deepEqual(state.blockers, ["needs one more validation"]);
  assert.deepEqual(state.recommended_actions, [{ type: "methods_followup" }]);
  assert.equal(state.decision_mode, "refine");
  assert.equal(state.decision_reason, "approval blockers remain");
});

test("gate policy prefers unified review schema fields", () => {
  const summary = {
    gate_review: {
      review: {
        pass: false,
        score: 81,
        blockers: ["pending gate rubric: novelty"],
        recommended_actions: [{ type: "gate_restart_followup" }],
        decision_mode: "pivot",
        decision_reason: "gatekeeper rejected the incumbent lead package",
      },
    },
  };

  const state = readGateState(summary);
  assert.equal(state.passed, false);
  assert.equal(state.restart_demand, true);
  assert.deepEqual(state.followup_actions, [{ type: "gate_restart_followup" }]);
  assert.equal(state.score, 81);
  assert.deepEqual(state.blockers, ["pending gate rubric: novelty"]);
  assert.equal(state.decision_mode, "pivot");
  assert.equal(state.decision_reason, "gatekeeper rejected the incumbent lead package");
});

test("retry policy prefers unified recommended_actions field", () => {
  const summary = {
    conclusion_review: {
      review: {
        recommended_actions: [{ type: "logic_followup" }],
      },
    },
  };

  assert.deepEqual(conclusionFollowupActions(summary), [{ type: "logic_followup" }]);
});

test("approval review caps final readiness at the lowest evaluated stage gate", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-staged-approval-"));
  const cycleId = "staged-approval-cycle";
  const root = path.join(cwd, ".research-lab");
  const researcherView = {
    jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
    summary: {
      evidence_readiness: { ready: true, reasons: [] },
      approval_readiness_score: 93,
      approval_readiness_band: "nearly-ready",
      approval_blockers: ["Impact: too few high-confidence promoted hypotheses are visible"],
      approval_rubric: [
        {
          name: "impact",
          score: 81,
          applicable: true,
          reasons: ["Impact: too few high-confidence promoted hypotheses are visible"],
        },
      ],
    },
  };

  const { review } = buildApprovalReview({
    cwd,
    cycleId,
    researcherView,
    staged: true,
    conclusionReview: {
      review: {
        conclusion_gate_passed: false,
        conclusion_score: 93,
        conclusion_blockers: ["Novelty: alternative hypothesis families are still too limited"],
      },
    },
    gateReview: {
      review: {
        gate_passed: false,
        score: 22,
        blockers: ["the frozen sample-level score failed the declared robustness checks"],
        recommended_followup_actions: [{ type: "gate_restart_followup", preferred_role: "lab-director" }],
      },
    },
  });

  const hypothesisStage = review.approval_stage_gates.find((stage) => stage.name === "hypothesis");
  const reportStage = review.approval_stage_gates.find((stage) => stage.name === "report");

  assert.equal(review.approval_score_policy, "stage-gated-minimum");
  assert.equal(review.heuristic_approval_readiness_score, 93);
  assert.equal(review.approval_readiness_score, 22);
  assert.equal(review.score, 22);
  assert.equal(review.approval_gate_passed, false);
  assert.equal(hypothesisStage.status, "blocked");
  assert.equal(hypothesisStage.score, 22);
  assert.equal(reportStage.status, "pending");
  assert.match(review.blockers.join("\n"), /Independent hypothesis gate: the frozen sample-level score failed/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("approval review passes only after conclusion, hypothesis, report, and paper gates pass", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-staged-approval-pass-"));
  const cycleId = "staged-approval-pass-cycle";
  const root = path.join(cwd, ".research-lab");

  const { review } = buildApprovalReview({
    cwd,
    cycleId,
    staged: true,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        evidence_readiness: { ready: true, reasons: [] },
        approval_readiness_score: 99,
        approval_readiness_band: "ready",
        approval_blockers: [],
        approval_rubric: [{ name: "impact", score: 99, applicable: true, reasons: [] }],
      },
    },
    conclusionReview: { review: { conclusion_gate_passed: true, conclusion_score: 97, conclusion_blockers: [] } },
    gateReview: { review: { gate_passed: true, score: 96, blockers: [] } },
    reportReview: { review: { communication_gate_passed: true, report_score: 98, report_blockers: [] } },
    paperReview: { review: { submission_gate_passed: true, paper_score: 96, paper_blockers: [] } },
  });

  assert.equal(review.approval_gate_passed, true);
  assert.equal(review.pass, true);
  assert.equal(review.score, 96);
  assert.equal(review.all_stage_gates_passed, true);
  assert.deepEqual(review.approval_stage_gates.map((stage) => stage.status), [
    "passed",
    "passed",
    "passed",
    "passed",
    "passed",
  ]);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("approval review applies promotion artifacts before staged approval minimum", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-staged-approval-artifacts-"));
  const cycleId = "staged-approval-artifacts-cycle";
  const root = path.join(cwd, ".research-lab");
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  writeJson(path.join(root, "state", `${cycleId}-baseline-confounder-waiver.json`), {
    waiver_decision: "accepted",
    baseline: { unavailable_items: ["reference code", "numeric metric"] },
    confounders: { unavailable_fields: ["age", "sex"] },
    limitations: ["unavailable fields are reported limitations"],
  });
  writeJson(path.join(root, "state", `${cycleId}-robustness-display-addendum.json`), {
    addendum_complete: true,
    primary_effects: { mitochondrial_oxidative: 0.14, interferon: -0.12 },
    patient_aggregation: "directionally aligned",
    robustness_checks: ["leave-one sensitivity"],
  });
  writeJson(path.join(root, "state", `${cycleId}-competitor-screen.json`), {
    screen_complete: true,
    screened_candidates: [{ id: "literature-only" }],
    demoted_candidates: [{ id: "literature-only" }],
    lead_retention_rationale: "current executable lead remains strongest",
  });
  writeJson(path.join(root, "state", `${cycleId}-transportability-decision.json`), {
    decision: "internal_only_promotion",
    gse229459: { executable: false },
    internal_only_rationale: "external companion not materialized",
  });

  const { review } = buildApprovalReview({
    cwd,
    cycleId,
    staged: true,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        evidence_readiness: { ready: true, reasons: [] },
        approval_readiness_score: 63,
        approval_readiness_band: "blocked",
        approval_blockers: [
          "Reproducibility: analytical confidence is still limited",
          "Clarity: clearer primary and robustness figures are still needed",
          "Impact: too few high-confidence promoted hypotheses are visible",
        ],
        approval_rubric: [
          { name: "novelty", score: 88, reasons: ["Novelty: need a broader set of non-trivial hypotheses"], applicable: true },
          { name: "technical_quality", score: 100, reasons: [], applicable: true },
          { name: "reproducibility", score: 81, reasons: ["Reproducibility: analytical confidence is still limited"], applicable: true },
          { name: "clarity", score: 82, reasons: ["Clarity: clearer primary and robustness figures are still needed"], applicable: true },
          { name: "impact", score: 62, reasons: ["Impact: too few high-confidence promoted hypotheses are visible"], applicable: true },
          { name: "strobe_reporting_completeness", score: 95, reasons: [], applicable: true },
        ],
      },
    },
    conclusionReview: { review: { conclusion_gate_passed: true, conclusion_score: 96, conclusion_blockers: [] } },
    gateReview: {
      review: {
        gate_passed: false,
        score: 63,
        blockers: ["additional validation has not been attempted before hypothesis gate closure"],
      },
    },
  });

  // Promotion artifacts clear the blockers they document. They no longer FLOOR a
  // rubric a reviewer actually scored.
  //
  // A competitor-screen artifact carrying scoreFloor=95 used to overwrite an
  // honest gatekeeper novelty of 20-42 -- reject, prior art named -- with 95, and
  // the whole active-search novelty stack was defeated at aggregation. The floor
  // now applies only to unreviewed placeholders. So the heuristic still rises
  // above the raw score because the documented blockers are gone, and the
  // reviewer's own numbers survive underneath it.
  assert.equal(review.heuristic_approval_readiness_score, 83);
  assert.equal(review.raw_heuristic_approval_readiness_score, 63);
  assert.equal(review.approval_readiness_score, 63);
  assert.equal(review.approval_stage_summary.score_limiting_stage.name, "hypothesis");
  assert.deepEqual(
    review.approval_rubric.map((item) => [item.name, item.score]),
    [
      ["novelty", 88],
      ["technical_quality", 100],
      ["reproducibility", 81],
      ["clarity", 82],
      ["impact", 62],
    ],
    "a scored rubric is reported as scored, not raised to the artifact floor",
  );
  assert.equal(review.approval_blockers.some((blocker) => /Reproducibility: analytical confidence/.test(blocker)), false);
  assert.equal(review.approval_blockers.some((blocker) => /additional validation has not been attempted/.test(blocker)), true);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("conclusion gate asks lab-director to revise weak hypothesis strategy before stopping", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-conclusion-gate-"));
  const researcherView = {
    jsonPath: path.join(cwd, ".research-lab", "state", "researcher-view.json"),
    summary: {
      evidence_readiness: { ready: true, reasons: [] },
      conclusion_readiness_score: 72,
      conclusion_rubric: [
        {
          // Below the gate bar (80): a weak hypothesis strategy must NOT pass and
          // must draw a lab-director revise request. Kept below-threshold after the
          // owner's 90 -> 80 move so the test still exercises the weak-strategy path.
          name: "novelty",
          score: 72,
          reasons: [
            "alternative hypothesis families are still too limited",
            "moderator or partition originality is still weak",
          ],
        },
      ],
      claim_count: 2,
      hypothesis_quality_score: 68,
      derivable_hypothesis_candidates: [
        { statement: "candidate one", rationale: "graph-derived gap" },
        { statement: "candidate two", rationale: "rival mechanism" },
      ],
      schema_quality: {
        falsification_test_count: 1,
      },
      reasoning_graph: {
        claim_count: 2,
        unresolved_gap_count: 5,
      },
      open_validation_gaps: [
        { gap: "independent validation missing", severity: "high" },
      ],
    },
  };

  const { review } = buildConclusionReview({
    cwd,
    cycleId: "weak-hypothesis-cycle",
    researcherView,
  });
  const labDirectorAction = review.recommended_followup_actions.find(
    (item) => item.type === "lab_director_requery_followup",
  );

  assert.equal(review.conclusion_gate_passed, false);
  assert.equal(labDirectorAction?.preferred_role, "lab-director");
  assert.equal(labDirectorAction?.target_rubric, "hypothesis_strategy");
  assert.equal(labDirectorAction?.expected_artifacts.includes("next_validation_lane_assignments.json"), true);
});

test("conclusion review treats documented unavailable checks as promotion artifacts instead of permanent rubric blockers", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-promotion-artifacts-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-promotion-artifacts";
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  writeJson(path.join(root, "state", `${cycleId}-baseline-confounder-waiver.json`), {
    waiver_decision: "accepted",
    baseline: {
      unavailable_items: ["same-paper executable code", "reference numeric metric", "baseline-step mapping"],
    },
    confounders: {
      unavailable_fields: ["age", "sex", "repeated-subject", "leukocyte-composition"],
    },
    limitations: ["These unavailable items are reported as exploratory limitations, not hidden pass/fail failures."],
  });
  writeJson(path.join(root, "state", `${cycleId}-robustness-display-addendum.json`), {
    addendum_complete: true,
    primary_effects: { mitochondrial_oxidative_vili_minus_aih: 0.1, interferon_vili_minus_aih: -0.12 },
    patient_aggregation: "directions preserved",
    robustness_checks: ["leave-one Patient_Code", "SlideName/TMA/Region/QC/AOI bounds"],
    display_outputs: ["primary-effect-panel.png"],
  });
  writeJson(path.join(root, "state", `${cycleId}-competitor-screen.json`), {
    screen_complete: true,
    screened_candidates: [{ id: "literature-only-rival" }],
    demoted_candidates: [{ id: "literature-only-rival", reason: "no executable data support" }],
    lead_retention_rationale: "current GSE228779 lead has executable support and retained directional evidence",
  });
  writeJson(path.join(root, "state", `${cycleId}-transportability-decision.json`), {
    decision: "internal_only_promotion",
    gse229459: { executable: false, reason: "not materialized as same-paper companion" },
    internal_only_rationale: "PRJNA951615 or companion validation remains future work, so promotion scope is GSE228779-internal.",
  });

  const { review } = buildConclusionReview({
    cwd,
    cycleId,
    researcherView: {
      jsonPath: path.join(root, "researcher-views", `${cycleId}-researcher-view.json`),
      summary: {
        evidence_readiness: { ready: true, reasons: [] },
        conclusion_readiness_score: 85,
        conclusion_blockers: [
          "Reproducibility: analytical confidence is still limited",
          "Clarity: clearer primary and robustness figures are still needed",
          "Novelty: need a broader set of non-trivial hypotheses",
          "Impact: too few high-confidence promoted hypotheses are visible",
        ],
        conclusion_rubric: [
          { name: "novelty", score: 88, reasons: ["Novelty: need a broader set of non-trivial hypotheses"], applicable: true },
          { name: "technical_quality", score: 100, reasons: [], applicable: true },
          { name: "reproducibility", score: 81, reasons: ["Reproducibility: analytical confidence is still limited"], applicable: true },
          { name: "clarity", score: 82, reasons: ["Clarity: clearer primary and robustness figures are still needed"], applicable: true },
          { name: "impact", score: 62, reasons: ["Impact: too few high-confidence promoted hypotheses are visible"], applicable: true },
          { name: "strobe_reporting_completeness", score: 95, reasons: [], applicable: true },
        ],
      },
    },
  });

  // What the artifacts do is retire the blockers they DOCUMENT: three of the four
  // are gone, which is the behaviour this test is named for.
  //
  // What they no longer do is carry the gate. The competitor screen used to floor
  // every rubric to 95, so a documented waiver could pass a cycle whose impact a
  // reviewer had scored 62 with a written reason. Impact is not an unavailable
  // check -- it is a judgement -- so it survives as a blocker and the gate stays
  // shut on the number underneath.
  assert.equal(review.conclusion_gate_passed, false);
  assert.equal(review.conclusion_score, 83);
  assert.deepEqual(review.conclusion_blockers, [
    "Impact: too few high-confidence promoted hypotheses are visible",
  ]);
  assert.equal(review.promotion_artifact_resolution.resolved.baselineConfounderWaiver, true);
  assert.equal(review.promotion_artifact_resolution.resolved.robustnessDisplayAddendum, true);
  assert.equal(review.promotion_artifact_resolution.resolved.competitorScreen, true);
  assert.equal(review.promotion_artifact_resolution.resolved.transportabilityDecision, true);
  assert.equal(
    review.recommended_followup_actions.some((item) => item.type === "baseline_confounder_waiver_followup"),
    false,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("paper gate emits detailed comments, author analyses, and PPT/SVG figure requests", () => {
  const paper = {
    title: "Dataset-internal primary signal with scoped validation",
    abstract: {
      background: "A sufficiently detailed background paragraph for journal triage and scope control.",
      methods: "A sufficiently detailed methods paragraph with source data, artifact path, validation metrics, preprocessing, threshold, model sensitivity, and checklist audit details.",
      results: "A sufficiently detailed results paragraph with correlation, threshold sensitivity, main signal, rival category, and validation panel details.",
      interpretation: "A sufficiently detailed interpretation paragraph that keeps the claim hypothesis-generating.",
    },
    introduction: ["one", "two"],
    methods: ["source data identifier and artifact path", "preprocessing threshold validation metrics sensitivity", "model-feasibility checklist secondary-analysis audit", "n=3 vs n=3"],
    results: ["correlation r=0.984", "threshold sensitivity", "main signal rival category", "validation panel"],
    discussion: ["hypothesis-generating", "independent validation", "orthogonal validation"],
    limitations: ["measurement", "single-source", "missing metadata", "model specification"],
    data_code_availability: ["source identifier", "artifacts", "classification sensitivity"],
    tables_and_figures: ["primary signal", "validation summary", "evidence trace", "supplement"],
    reviewer_contract: { no_overclaiming: true },
  };
  const rubric = paperRubric(paper);
  const comments = buildPaperReviewComments(paper, rubric);
  const analysisRequests = paperAnalysisRequests(paper, comments);
  const figureRequests = paperFigureProductionRequests(paper, comments);

  assert.equal(comments.length >= 6, true);
  assert.equal(comments.some((item) => item.section === "figures_tables"), true);
  assert.equal(analysisRequests.some((item) => item.request_id === "author-analysis-model-feasibility"), true);
  assert.equal(figureRequests[0].production_policy.deck_format, "pptx");
  assert.equal(figureRequests[0].production_policy.graphics_format, "svg");
  assert.match(figureRequests[0].production_policy.pptx_generation_policy, /python-pptx/);
  assert.equal(figureRequests[0].production_policy.ppt_text_policy.includes("PPT text"), true);
  assert.match(figureRequests[0].production_policy.caption_policy, /LaTeX/);
  assert.match(figureRequests[0].production_policy.manuscript_image_policy, /paper_image_png_path/);
  assert.match(figureRequests[0].production_policy.quality_gate_policy, /undersized text boxes/);
  assert.match(figureRequests[0].production_policy.image_quality_policy, /rendered_image_quality/);
  assert.equal(figureRequests[0].acceptance_criteria.some((item) => /raw \.svg/i.test(item)), true);
  assert.equal(figureRequests[0].acceptance_criteria.some((item) => /caption, figure title, key message/i.test(item)), true);
  assert.equal(figureRequests[0].acceptance_criteria.some((item) => /rendered_image_quality/i.test(item)), true);
});

test("high impact is read from a reference's citation record, not from its publisher", () => {
  // It used to be a venue whitelist, and every name on it was biomedical: Nature
  // Medicine, Lancet, NEJM, JAMA, Immunity, cell.com. No ACM TOG, no SIGGRAPH, no
  // TVCG, no Eurographics -- so in a graphics cycle NO reference could ever be
  // high-impact while "at least two high-impact references" stayed a hard gate
  // blocker. Any fixed list fails that way for every field nobody enumerated.
  //
  // The venue is still resolved and reported, because a reader wants to see it.
  // It just no longer decides impact.
  const options = { minimumReferences: 3, minimumVerified: 3, minimumHighImpact: 1 };
  const byPublisher = referenceQuality([
    { title: "Verified indexed context article one", type: "article", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11449708/" },
    { title: "Verified indexed context article two", type: "article", url: "https://www.nature.com/articles/s41598-024-63898-9" },
    { title: "Verified indexed context article three", type: "article", url: "https://pubs.acs.org/doi/10.1021/acsnano.2c12722" },
  ], options);

  assert.equal(byPublisher.verified_article_reference_count, 3);
  assert.equal(byPublisher.high_impact_reference_count, 0, "a well-known publisher is not evidence of impact");
  assert.equal(byPublisher.normalized_references[1].venue, "Scientific Reports");

  // What does count: the citation record collected for every paper, or an
  // explicit upstream judgment.
  const byCitations = referenceQuality([
    { title: "Cited graphics method", type: "article", url: "https://dl.acm.org/doi/10.1145/3592433", cited_by_count: 140 },
    { title: "Uncited preprint", type: "article", url: "https://arxiv.org/abs/2401.00001", cited_by_count: 0 },
    { title: "Judged important upstream", type: "article", url: "https://example.org/paper", high_impact: true },
  ], options);

  assert.equal(byCitations.high_impact_reference_count, 2);
  assert.equal(byCitations.normalized_references[1].high_impact_venue, false, "an uncited preprint cannot promote itself");
});

test("paper gate blocks required high-impact reference refresh even when rubric score is high", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-paper-gate-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "reference-gate-cycle";
  const manifestPath = path.join(root, "figures", `${cycleId}-figure-deck-manifest.json`);
  const pptxPath = path.join(root, "figures", `${cycleId}-figure-deck.pptx`);
  const paperImagePath = path.join(root, "figures", `${cycleId}-figure-1.png`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(pptxPath, "pptx placeholder");
  fs.writeFileSync(paperImagePath, "<svg></svg>");
  fs.writeFileSync(manifestPath, JSON.stringify({
    pptx_generation_method: "python-pptx",
    slides: [
      {
        figure_id: "figure-1-primary-signal",
        ppt_text_boxes: [
          "x axis title",
          "y axis title",
          "x tick negative",
          "x tick zero",
          "x tick positive",
          "y tick zero",
          "y tick five",
          "y tick ten",
          "threshold label",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-2-validation-summary",
        ppt_text_boxes: [
          "x category primary signal",
          "x category rival signal",
          "x category validation signal",
          "y axis title",
          "y tick zero",
          "y tick ten",
          "y tick twenty",
          "value label primary signal",
          "value label rival signal",
          "value label validation signal",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-3-evidence-trace",
        ppt_text_boxes: [
          "x axis title",
          "x tick source",
          "x tick validation",
          "x tick review",
          "row label note",
          "trace label 1",
          "trace label 2",
          "trace label 3",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
    ],
  }));
  const paper = {
    title: "Dataset-internal primary signal with scoped validation",
    abstract: {
      background: "A sufficiently detailed background paragraph for journal triage and scope control in this dataset-internal secondary analysis.",
      methods: "A sufficiently detailed methods paragraph with source data, artifact path, validation metrics, preprocessing, threshold, model sensitivity, and checklist audit details for reproducibility.",
      results: "A sufficiently detailed results paragraph with correlation r=0.984, threshold sensitivity, main signal, rival category, and validation panel details.",
      interpretation: "A sufficiently detailed interpretation paragraph that keeps the claim hypothesis-generating and not population-level.",
    },
    introduction: ["hypothesis-generating dataset-internal primary-signal context", "independent public dataset and orthogonal validation opportunity"],
    methods: ["source data identifier and artifact path", "preprocessing threshold validation metrics sensitivity", "model-feasibility checklist secondary-analysis audit", "n=3 vs n=3"],
    results: ["correlation r=0.984", "threshold sensitivity", "main signal rival category", "validation panel"],
    discussion: ["hypothesis-generating", "independent public dataset validation", "orthogonal validation"],
    limitations: ["measurement", "single-source", "missing metadata", "model specification"],
    data_code_availability: [
      "Every input this analysis reads ships with the submission under `artifacts/`: the source identifier manifest, the generated tables, and the classification sensitivity sweep.",
      "Each reported number is regenerated by running `artifacts/analysis.py` against `artifacts/inputs.json` and comparing its output against the supplementary tables.",
    ],
    tables_and_figures: ["primary signal", "validation summary", "evidence trace", "supplement"],
    figure_deck: {
      pptx_path: pptxPath,
      manifest_path: manifestPath,
      policy: "SVG artwork and editable PPT text boxes",
    },
    figure_panels: [
      { figure_id: "figure-1-primary-signal", caption: "Primary signal", image_path: paperImagePath, source_tables: ["primary.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-2-validation-summary", caption: "Validation summary", image_path: paperImagePath, source_tables: ["validation.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-3-evidence-trace", caption: "Evidence trace", image_path: paperImagePath, source_tables: ["trace.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
    ],
    reviewer_contract: { no_overclaiming: true },
    // Both declarations are required of every manuscript: the claim a paper is
    // allowed to make depends on which kind it is, and "no control reproduced
    // our result" has to be asserted rather than left out.
    contribution_type: "method",
    controls_that_reproduce_the_result: [],
    references: [
      { title: "Primary dataset", type: "dataset", doi: "10.5281/example" },
      { title: "PubMed indexed context one", type: "article", pmid: "1", venue: "Specialty Journal" },
      { title: "PubMed indexed context two", type: "article", pmid: "2", venue: "Specialty Journal" },
      { title: "PubMed indexed context three", type: "article", pmid: "3", venue: "Specialty Journal" },
      { title: "PubMed indexed context four", type: "article", pmid: "4", venue: "Specialty Journal" },
      { title: "High impact context", type: "article", doi: "10.1126/example", venue: "Science" },
    ],
  };
  const paperPath = path.join(root, "papers", `${cycleId}-paper-v0001.json`);
  fs.mkdirSync(path.dirname(paperPath), { recursive: true });
  fs.writeFileSync(paperPath, JSON.stringify(paper));

  const { review } = buildPaperReview({ cwd, cycleId, documentArtifacts: { paper_path: paperPath } });

  assert.equal(review.paper_raw_score >= 90, true);
  assert.equal(review.paper_score < 90, true);
  assert.equal(review.paper_gate_passed, false);
  assert.equal(review.reference_requests[0].required_for_gate, true);
  // The blocker names the citation floor it applied, because "high-impact
  // journal" told an author nothing they could act on once the venue whitelist
  // was gone -- and the floor is computed from this cycle's own reference set,
  // so it is different for a graphics corpus than for a biomedical one.
  assert.equal(
    review.paper_blockers.includes("reference list needs at least 2 well-cited references (>= 25 citations for this set)"),
    true,
    JSON.stringify(review.paper_blockers),
  );
});

test("paper score is capped for narrow secondary-analysis editorial risk even after gate blockers clear", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-paper-risk-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "editorial-risk-cycle";
  const manifestPath = path.join(root, "figures", `${cycleId}-figure-deck-manifest.json`);
  const pptxPath = path.join(root, "figures", `${cycleId}-figure-deck.pptx`);
  const paperImagePath = path.join(root, "figures", `${cycleId}-figure-1.png`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(pptxPath, "pptx placeholder");
  fs.writeFileSync(paperImagePath, "<svg></svg>");
  fs.writeFileSync(manifestPath, JSON.stringify({
    pptx_generation_method: "python-pptx",
    slides: [
      {
        figure_id: "figure-1-primary-signal",
        ppt_text_boxes: [
          "x axis title",
          "y axis title",
          "x tick negative",
          "x tick zero",
          "x tick positive",
          "y tick zero",
          "y tick five",
          "y tick ten",
          "threshold label",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-2-validation-summary",
        ppt_text_boxes: [
          "x category primary signal",
          "x category rival signal",
          "x category validation signal",
          "y axis title",
          "y tick zero",
          "y tick ten",
          "y tick twenty",
          "value label primary signal",
          "value label rival signal",
          "value label validation signal",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-3-evidence-trace",
        ppt_text_boxes: [
          "x axis title",
          "x tick source",
          "x tick validation",
          "x tick review",
          "row label note",
          "trace label 1",
          "trace label 2",
          "trace label 3",
        ],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
    ],
  }));
  const paper = {
    title: "Dataset-internal primary signal with scoped validation",
    high_impact_standard: {
      article_class: "brief_report",
    },
    abstract: {
      background: "A sufficiently detailed background paragraph for journal triage and scope control in this dataset-internal secondary analysis.",
      methods: "A sufficiently detailed methods paragraph with source data, artifact path, validation metrics, preprocessing, threshold, model sensitivity, and checklist audit details for reproducibility.",
      results: "A sufficiently detailed results paragraph with correlation r=0.984, threshold sensitivity, main signal, rival category, and validation panel details.",
      interpretation: "A sufficiently detailed interpretation paragraph that keeps the claim hypothesis-generating and not population-level.",
    },
    introduction: ["hypothesis-generating dataset-internal primary-signal context", "independent public dataset and orthogonal validation opportunity"],
    methods: ["source data identifier and artifact path", "preprocessing threshold validation metrics sensitivity", "model-feasibility checklist secondary-analysis audit", "n=3 vs n=3"],
    results: ["correlation r=0.984", "threshold sensitivity", "main signal rival category", "validation panel", "model-based sensitivity audit", "class-size-normalized one-sided Fisher category audit"],
    discussion: ["hypothesis-generating", "independent cohort", "orthogonal validation"],
    limitations: ["measurement", "single-source public 3-vs-3 slice", "missing metadata", "model specification", "independent or orthogonal validation is still required before broad mechanistic generalization"],
    data_code_availability: [
      "Every input this analysis reads ships with the submission under `artifacts/`: the source identifier manifest, the generated tables, and the classification sensitivity sweep.",
      "Each reported number is regenerated by running `artifacts/analysis.py` against `artifacts/inputs.json` and comparing its output against the supplementary tables.",
      "Source ethics and consent metadata must be verified from the source publication.",
    ],
    supplementary_tables: {
      model_feasibility: "model_feasibility.json",
      validation_panels: "validation_panels.csv",
      category_background_normalized: "category_background_normalized.csv",
    },
    tables_and_figures: ["primary signal", "validation summary", "evidence trace", "supplement"],
    figure_deck: {
      pptx_path: pptxPath,
      manifest_path: manifestPath,
      policy: "SVG artwork and editable PPT text boxes",
    },
    figure_panels: [
      { figure_id: "figure-1-primary-signal", caption: "Primary signal", image_path: paperImagePath, source_tables: ["primary.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-2-validation-summary", caption: "Validation summary", image_path: paperImagePath, source_tables: ["validation.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-3-evidence-trace", caption: "Evidence trace", image_path: paperImagePath, source_tables: ["trace.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
    ],
    reviewer_contract: {
      no_overclaiming: true,
      high_impact_readiness_bar: "ready as a brief report/research letter draft only if reviewers accept the intentionally narrow claim class",
    },
    // Both declarations are required of every manuscript: the claim a paper is
    // allowed to make depends on which kind it is, and "no control reproduced
    // our result" has to be asserted rather than left out.
    contribution_type: "method",
    controls_that_reproduce_the_result: [],
    references: [
      { title: "Primary dataset", type: "dataset", doi: "10.5281/example" },
      { title: "PubMed indexed context one", type: "article", pmid: "1", venue: "Specialty Journal" },
      { title: "PubMed indexed context two", type: "article", pmid: "2", venue: "Specialty Journal" },
      { title: "PubMed indexed context three", type: "article", pmid: "3", venue: "Specialty Journal" },
      // High impact is read from the citation record now, not from the venue
      // name: the old whitelist was all biomedical, so no reference in a
      // graphics cycle could ever satisfy the two-high-impact gate blocker.
      { title: "High impact context one", type: "article", doi: "10.1126/example", venue: "Science", cited_by_count: 310 },
      { title: "High impact context two", type: "article", doi: "10.1136/example", venue: "Gut", cited_by_count: 145 },
    ],
  };
  const paperPath = path.join(root, "papers", `${cycleId}-paper-v0001.json`);
  fs.mkdirSync(path.dirname(paperPath), { recursive: true });
  fs.writeFileSync(paperPath, JSON.stringify(paper));

  const { review } = buildPaperReview({ cwd, cycleId, documentArtifacts: { paper_path: paperPath } });

  assert.equal(review.paper_blockers.length, 0);
  assert.equal(review.paper_gate_passed, true);
  assert.equal(review.paper_raw_score >= 95, true);
  assert.equal(review.paper_score < review.paper_raw_score, true);
  assert.equal(review.paper_score <= 92, true);
  assert.match(review.paper_editorial_risk.score_cap_reasons.join("\n"), /independent|brief-report/);
  const editorialComment = review.paper_review_comments.find((item) => item.section === "editorial_readiness");
  assert.equal(Boolean(editorialComment), true);
  assert.equal(editorialComment.severity, "substantive");
  assert.match(editorialComment.concerns.join("\n"), /single public|independent|brief-report/);
  assert.equal(editorialComment.suggested_additional_analysis.some((item) => /independent public dataset|orthogonal validation/.test(item)), true);
});

test("paper gate separates author, figure, and integration gate ownership", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-paper-subgates-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "subgate-cycle";
  const manifestPath = path.join(root, "figures", `${cycleId}-figure-deck-manifest.json`);
  const pptxPath = path.join(root, "figures", `${cycleId}-figure-deck.pptx`);
  const paperImagePath = path.join(root, "figures", `${cycleId}-figure-1.png`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(pptxPath, "pptx placeholder");
  fs.writeFileSync(paperImagePath, "<svg></svg>");
  fs.writeFileSync(manifestPath, JSON.stringify({
    pptx_generation_method: "python-pptx",
    slides: [
      {
        figure_id: "figure-1-primary-signal",
        ppt_text_boxes: ["x axis title", "y axis title", "x tick negative", "x tick zero", "x tick positive", "y tick zero", "y tick five", "y tick ten", "threshold label"],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-2-validation-summary",
        ppt_text_boxes: ["x category primary signal", "x category rival signal", "x category validation signal", "y axis title", "y tick zero", "y tick ten", "y tick twenty", "value label primary signal", "value label rival signal", "value label validation signal"],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
      {
        figure_id: "figure-3-evidence-trace",
        ppt_text_boxes: ["x axis title", "x tick source", "x tick validation", "x tick review", "row label note", "trace label 1", "trace label 2", "trace label 3"],
        paper_image_png_path: paperImagePath,
        ppt_artwork_png_path: paperImagePath,
        svg_contains_text_elements: false,
        text_box_quality: passingTextBoxQuality(),
        rendered_image_quality: passingRenderedImageQuality(),
      },
    ],
  }));
  const basePaper = {
    title: "Dataset-internal primary signal with scoped validation",
    abstract: {
      background: "A sufficiently detailed background paragraph for journal triage and scope control in this dataset-internal secondary analysis.",
      methods: "A sufficiently detailed methods paragraph with source data, artifact path, validation metrics, preprocessing, threshold, model sensitivity, and checklist audit details for reproducibility.",
      results: "A sufficiently detailed results paragraph with correlation r=0.984, threshold sensitivity, main signal, rival category, and validation panel details.",
      interpretation: "A sufficiently detailed interpretation paragraph that keeps the claim hypothesis-generating and not population-level.",
    },
    introduction: ["hypothesis-generating dataset-internal primary-signal context", "independent public dataset and orthogonal validation opportunity"],
    methods: ["source data identifier and artifact path", "preprocessing threshold validation metrics sensitivity", "model-feasibility checklist secondary-analysis audit", "sample structure"],
    results: ["correlation r=0.984", "threshold sensitivity", "main signal rival category", "validation panel", "model-based sensitivity audit", "class-size-normalized one-sided Fisher category audit"],
    discussion: ["hypothesis-generating", "independent cohort", "orthogonal validation"],
    limitations: ["measurement", "single-source", "missing metadata", "model specification", "external validity"],
    data_code_availability: [
      "Every input this analysis reads ships with the submission under `artifacts/`: the source identifier manifest, the generated tables, and the classification sensitivity sweep.",
      "Each reported number is regenerated by running `artifacts/analysis.py` against `artifacts/inputs.json` and comparing its output against the supplementary tables.",
    ],
    supplementary_tables: {
      model_feasibility: "model_feasibility.json",
      validation_panels: "validation_panels.csv",
      category_background_normalized: "category_background_normalized.csv",
    },
    tables_and_figures: ["primary signal", "validation summary", "evidence trace", "supplement"],
    figure_deck: {
      pptx_path: pptxPath,
      manifest_path: manifestPath,
      policy: "SVG artwork and editable PPT text boxes",
    },
    figure_panels: [
      { figure_id: "figure-1-primary-signal", caption: "Primary signal", image_path: paperImagePath, source_tables: ["primary.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-2-validation-summary", caption: "Validation summary", image_path: paperImagePath, source_tables: ["validation.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
      { figure_id: "figure-3-evidence-trace", caption: "Evidence trace", image_path: paperImagePath, source_tables: ["trace.csv"], detailed_explanation: "Detailed explanation ".repeat(12) },
    ],
    reviewer_contract: { no_overclaiming: true },
    // Both declarations are required of every manuscript: the claim a paper is
    // allowed to make depends on which kind it is, and "no control reproduced
    // our result" has to be asserted rather than left out.
    contribution_type: "method",
    controls_that_reproduce_the_result: [],
    references: [
      { title: "Primary dataset", type: "dataset", doi: "10.5281/example" },
      { title: "PubMed indexed context one", type: "article", pmid: "1", venue: "Specialty Journal" },
      { title: "PubMed indexed context two", type: "article", pmid: "2", venue: "Specialty Journal" },
      { title: "PubMed indexed context three", type: "article", pmid: "3", venue: "Specialty Journal" },
      // High impact is read from the citation record now, not from the venue
      // name: the old whitelist was all biomedical, so no reference in a
      // graphics cycle could ever satisfy the two-high-impact gate blocker.
      { title: "High impact context one", type: "article", doi: "10.1126/example", venue: "Science", cited_by_count: 310 },
      { title: "High impact context two", type: "article", doi: "10.1136/example", venue: "Gut", cited_by_count: 145 },
    ],
  };

  const missingFigureDeck = {
    ...basePaper,
    figure_deck: {},
    figure_panels: [],
  };
  const missingFigurePath = path.join(root, "papers", `${cycleId}-paper-v0001.json`);
  fs.mkdirSync(path.dirname(missingFigurePath), { recursive: true });
  fs.writeFileSync(missingFigurePath, JSON.stringify(missingFigureDeck));

  const { review: figureBlocked } = buildPaperReview({ cwd, cycleId, documentArtifacts: { paper_path: missingFigurePath } });
  assert.equal(figureBlocked.author_gate_passed, true);
  assert.equal(figureBlocked.figure_gate_passed, false);
  assert.equal(figureBlocked.paper_integration_gate_passed, false);
  assert.equal(figureBlocked.paper_gate_passed, false);
  assert.equal(figureBlocked.recommended_followup_actions.some((item) => item.preferred_role === "illustrator"), true);
  assert.equal(figureBlocked.recommended_followup_actions.some((item) => item.preferred_role === "author" && item.target_rubric === "tables_figures_submission_discipline"), false);

  const missingConcordance = {
    ...basePaper,
    abstract: {
      ...basePaper.abstract,
      results: "A sufficiently detailed results paragraph with threshold sensitivity, main signal, rival category, and validation panel details.",
    },
    results: ["threshold sensitivity", "main signal rival category", "validation panel", "model-based sensitivity audit", "class-size-normalized one-sided Fisher category audit"],
  };
  const missingConcordancePath = path.join(root, "papers", `${cycleId}-paper-v0002.json`);
  fs.writeFileSync(missingConcordancePath, JSON.stringify(missingConcordance));

  const { review: authorBlocked } = buildPaperReview({ cwd, cycleId, documentArtifacts: { paper_path: missingConcordancePath } });
  assert.equal(authorBlocked.author_gate_passed, false);
  assert.equal(authorBlocked.figure_gate_passed, true);
  assert.equal(authorBlocked.paper_integration_gate_passed, true);
  // At the 80-point floor statistical reporting clears the score bar, but the
  // absent measured claim remains a required author-owned standard blocker.
  assert.equal(authorBlocked.recommended_followup_actions.some((item) => item.preferred_role === "author" && item.target_rubric === "claim_and_venue_standard" && item.required_for_gate), true);
  assert.equal(authorBlocked.recommended_followup_actions.some((item) => item.preferred_role === "illustrator" && item.target_rubric === "claim_and_venue_standard"), false);

  const overlapManifestPath = path.join(root, "figures", `${cycleId}-figure-deck-overlap-manifest.json`);
  const overlapManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  overlapManifest.slides[0].text_box_quality = {
    passed: false,
    minimum_font_size: 8,
    minimum_required_font_size: 8,
    undersized_text_boxes: [],
    overlap_count: 1,
    overlaps: [{ boxes: ["x axis title", "x tick zero"], overlap_ratio: 0.35 }],
    out_of_bounds: [],
  };
  fs.writeFileSync(overlapManifestPath, JSON.stringify(overlapManifest));
  const overlappingFigureText = {
    ...basePaper,
    figure_deck: {
      ...basePaper.figure_deck,
      manifest_path: overlapManifestPath,
    },
  };
  const overlappingFigureTextPath = path.join(root, "papers", `${cycleId}-paper-v0003.json`);
  fs.writeFileSync(overlappingFigureTextPath, JSON.stringify(overlappingFigureText));

  const { review: overlapBlocked } = buildPaperReview({ cwd, cycleId, documentArtifacts: { paper_path: overlappingFigureTextPath } });
  assert.equal(overlapBlocked.author_gate_passed, true);
  assert.equal(overlapBlocked.figure_gate_passed, false);
  assert.match(overlapBlocked.figure_gate.blockers.join("\n"), /overlapping editable text boxes/);
});
