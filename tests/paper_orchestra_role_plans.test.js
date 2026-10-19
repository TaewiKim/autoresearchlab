"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildRolePlan } = require("../src/agents");

function makeCyclePlanningContext() {
  return {
    literature_summary: {
      writing_loop: {
        mode: "paper_orchestra_inspired",
        summary: {
          verified_citation_count: 3,
          section_count: 2,
          revision_item_count: 2,
        },
        venue_profile: {
          profile_id: "medical_observational",
          label: "Medical Observational",
          drafting_emphasis: ["measurement validity", "bias control"],
        },
        section_outline: [
          {
            section_id: "motivation-gap",
            title: "Research Gap and Motivation",
            objective: "Explain the gap.",
            target_queries: ["dtp3 life expectancy"],
          },
        ],
        section_packets: [
          {
            section_id: "motivation-gap",
            title: "Research Gap and Motivation",
            objective: "Explain the gap.",
            summary: "Coverage remains relevant but rival explanations persist.",
            target_queries: ["dtp3 life expectancy"],
            unresolved_gaps: ["Need stronger novelty comparison"],
            citation_packets: [
              {
                citation_id: "citation:1",
                title: "Coverage and Survival",
                year: 2024,
                verification_status: "verified",
              },
            ],
          },
        ],
        evidence_matrix: [
          {
            hypothesis_id: "hyp-1",
            statement: "Coverage remains informative after adjustment.",
            linked_claim: "Adjusted signal remains positive.",
            support_count: 2,
            citation_titles: ["Coverage and Survival"],
          },
        ],
        revision_queue: [
          {
            revision_id: "rev:motivation-gap:citations",
            severity: "high",
            section_id: "motivation-gap",
            issue: "citation grounding is too thin for a writing pass",
            recommended_action: "run another targeted search",
          },
        ],
      },
    },
    report_review: {
      recommended_followup_actions: [
        {
          type: "report_visual_followup",
          priority: "high",
          preferred_role: "illustrator",
          blocker_reasons: ["report lacks graphical summary elements"],
          description: "add stronger charts and executive visual summary",
        },
      ],
    },
    paper_review: {
      paper_review_comments: [
        {
          comment_id: "paper-review-03-methods",
          section: "methods_reproducibility",
          rubric_item: "methods_reproducibility",
          severity: "substantive",
          score: 86,
          concerns: ["methods need a count-model feasibility response"],
          required_revisions: ["add count-model feasibility audit"],
          suggested_additional_analysis: ["check whether raw-count DESeq2 is feasible"],
        },
      ],
      analysis_requests: [
        {
          request_id: "author-analysis-count-model-feasibility",
          preferred_role: "author",
          priority: "high",
          required_for_gate: true,
          allowed_author_execution: true,
          objective: "determine whether count-model reanalysis is feasible",
          expected_artifacts: ["count_model_feasibility.json"],
          trigger_comment_ids: ["paper-review-03-methods"],
        },
      ],
      figure_production_requests: [
        {
          request_id: "illustrator-paper-figure-deck",
          preferred_role: "illustrator",
          priority: "high",
          objective: "produce a separate PPTX figure deck",
        },
      ],
      recommended_followup_actions: [
        {
          type: "paper_structure_followup",
          priority: "high",
          preferred_role: "author",
          blocker_reasons: ["paper structure is still incomplete for submission"],
          description: "restructure the manuscript into a submission-ready LaTeX paper",
        },
        {
          type: "illustrator-paper-figure-deck",
          priority: "high",
          preferred_role: "illustrator",
          blocker_reasons: ["figure deck is missing"],
          description: "produce a separate PPTX figure deck with SVG artwork and PPT text",
        },
      ],
    },
    researcher_view: {
      primary_visual_kind: "life-adjustment-summary",
      lead_outcome: "life",
      figure_recommendations: [
        {
          figure_id: "life-adjustment-summary",
          title: "Life Expectancy adjustment summary",
          chart_type: "ranked horizontal evidence bars",
          priority: "highest",
          takeaway: "Lead with the adjusted life result.",
        },
      ],
      visual_takeaways: [
        {
          kind: "life-adjustment-summary",
          takeaway: "Adjusted life result stays positive.",
        },
      ],
      claim_bridge_rows: [
        {
          label: "Adjusted",
          value: 0.19,
        },
      ],
    },
  };
}

test("author role plan consumes writing-loop section packets and revision queue", () => {
  const plan = buildRolePlan({
    prompt: "Draft the paper",
    cycleId: "cycle-po-0001",
    researchStage: "document",
    lane: {
      lane_id: "author-01",
      role: "author",
      model: "gpt-5.4",
      agent_id: "author-01",
      activation_stages: ["document"],
    },
    cyclePlanningContext: makeCyclePlanningContext(),
  });

  assert.equal(plan.literature_positioning_summary.mode, "paper_orchestra_inspired");
  assert.equal(plan.venue_profile.profile_id, "medical_observational");
  assert.equal(plan.section_packets.length, 1);
  assert.equal(plan.revision_queue.length, 4);
  assert.equal(plan.author_draft_sections_experiment.length, 1);
  assert.equal(plan.section_packets[0].title, "Research Gap and Motivation");
  assert.equal(plan.paper_review_comments.length, 1);
  assert.equal(plan.analysis_requests.length, 1);
  assert.equal(plan.additional_analysis_policy.enabled, true);
  assert.equal(plan.manuscript_figure_integration_policy.enabled, true);
  assert.match(plan.manuscript_figure_integration_policy.constraints.join("\n"), /paper_image_png_path/);
  assert.match(plan.manuscript_figure_integration_policy.constraints.join("\n"), /raw \.svg/);
  assert.equal(plan.revision_queue.some((item) => item.revision_type === "additional_analysis"), true);
});

test("illustrator role plan consumes section packets and visual followups", () => {
  const plan = buildRolePlan({
    prompt: "Build the visual summary",
    cycleId: "cycle-po-0001",
    researchStage: "document",
    lane: {
      lane_id: "illustrator-01",
      role: "illustrator",
      model: "gpt-5.4",
      agent_id: "illustrator-01",
      activation_stages: ["document"],
    },
    cyclePlanningContext: makeCyclePlanningContext(),
  });

  assert.equal(plan.literature_positioning_summary.mode, "paper_orchestra_inspired");
  assert.equal(plan.section_packets.length, 1);
  assert.equal(plan.evidence_matrix_rows.length, 1);
  assert.equal(plan.visual_revision_queue.length, 2);
  assert.equal(plan.visual_execution_packets.length, 1);
  assert.equal(plan.visual_execution_packets[0].figure_id, "life-adjustment-summary");
  assert.equal(plan.visual_execution_mode, "deterministic_baseline_plus_illustrator_refinement");
  assert.equal(plan.visual_refinement_brief.mode, "deterministic_baseline_plus_illustrator_refinement");
  // Owner decision: figures are no longer authored through a PowerPoint deck.
  // What has to survive a run is the ability to rebuild a figure from committed
  // data, so the plan carries a production policy instead of a deck format.
  assert.match(plan.figure_production_policy.authoring, /generator script this lane writes/);
  assert.match(plan.figure_production_policy.generator_policy, /run again unattended/);
  assert.match(plan.figure_production_policy.image_format, /PNG or PDF/);
  assert.match(plan.figure_production_policy.caption_policy, /not baked into the image/);
  assert.equal(plan.figure_deck_policy, undefined, "the deck policy is gone, not renamed alongside");
  assert.equal(plan.visual_checks.some((item) => /overlap/i.test(item)), true);
  assert.equal(plan.visual_checks.some((item) => /8 pt/i.test(item)), true);
  // `rendered_image_quality` was a field in the deck manifest. The property it
  // stood for -- that the emitted image was measured rather than assumed -- is
  // now checked directly on the figure the generator wrote.
  assert.equal(plan.visual_checks.some((item) => /clipped at the axes or figure edge/i.test(item)), true);
  assert.equal(plan.visual_checks.some((item) => /generator that drew it/i.test(item)), true);
  assert.match(plan.figure_production_policy.regeneration_policy, /fix the generator and re-emit/);
  assert.equal(plan.figure_production_requests.length, 1);
  assert.equal(plan.visual_refinement_brief.focus_packets.length, 1);
  assert.equal(plan.visual_qa, null);
  assert.equal(plan.visual_revision_queue[0].revision_id, "report_visual_followup");
});

test("lab-director role plan forces family-switch restart after gate reject", () => {
  const plan = buildRolePlan({
    prompt: "Recover from gate reject",
    cycleId: "cycle-po-0001",
    researchStage: "evidence",
    lane: {
      lane_id: "lab-director-01",
      role: "lab-director",
      model: "gpt-5.4",
      agent_id: "lab-director-01",
      activation_stages: ["evidence"],
    },
    cyclePlanningContext: {
      source_paths: {
        gate_review: "/tmp/cycle-po-0001-gate-review.json",
      },
      gate_review: {
        score: 20,
        gatekeeper_review: { verdict: "reject" },
        rubric: [
          { name: "novelty", score: 18, reasons: ["not new enough"] },
          { name: "technical_quality", score: 20, reasons: ["missing comparator"] },
        ],
        gatekeeper_reviews: [
          {
            lane_id: "gatekeeper-09",
            focus_rubric: "strobe_reporting_completeness",
            verdict: "reject",
            rubric: [{ name: "strobe_reporting_completeness", score: 21 }],
            summary: "STROBE-critical elements are missing.",
          },
        ],
        challenge_questions: ["same-dataset comparator is absent"],
        candidate_hypotheses: [{ family_root: "latent_immune_state_superiority" }],
        cross_family_alternatives: [
          {
            family_root: "immune_evasion_programs",
            statement: "Interferon and antigen-presentation loss explain the worst immune landscapes.",
            why_better: "Mechanistic and directly falsifiable.",
          },
        ],
      },
    },
  });

  assert.equal(plan.action_type, "gate_restart_followup");
  assert.equal(plan.gate_restart_policy.required, true);
  assert.deepEqual(plan.gate_restart_policy.rubric_scores.map((item) => [item.name, item.score]), [
    ["novelty", 18],
    ["technical_quality", 20],
  ]);
  assert.equal(plan.gate_restart_policy.gatekeeper_review_summaries[0].lane_id, "gatekeeper-09");
  assert.equal(plan.gate_restart_policy.gatekeeper_review_summaries[0].score, 21);
  assert.equal(plan.gate_restart_policy.gate_review_source_path, "/tmp/cycle-po-0001-gate-review.json");
  assert.equal(plan.gate_restart_policy.review_comment_manifest.source_path, "/tmp/cycle-po-0001-gate-review.json");
  assert.ok(plan.gate_restart_policy.review_comment_manifest.total_unique_comment_count >= 4);
  assert.ok(plan.gate_restart_policy.review_comment_manifest.comments.some((item) => item.comment === "same-dataset comparator is absent"));
  assert.ok(plan.gate_restart_policy.review_comment_manifest.comments.some((item) => item.comment === "not new enough"));
  assert.ok(plan.gate_restart_policy.review_comment_manifest.comments.some((item) => item.comment === "STROBE-critical elements are missing."));
  assert.equal(plan.decision_policy.must_restart_from_literature_and_data_search_on_gate_reject, true);
  assert.equal(plan.decision_policy.must_apply_literature_triage_policy, true);
  assert.equal(plan.decision_policy.must_stop_literature_search_when_sufficient, true);
  assert.equal(plan.decision_policy.must_allow_abstract_only_kg_seeds, true);
  assert.equal(plan.literature_triage_policy.sufficient_evidence_thresholds.abstract_only_allowed, true);
  assert.ok(plan.required_output.some((item) => /literature sufficiency decision/i.test(item)));
  assert.equal(plan.decision_policy.must_switch_family_after_gate_reject, true);
  assert.deepEqual(plan.gate_restart_policy.rejected_incumbent_families, ["latent_immune_state_superiority"]);
  assert.equal(plan.gate_restart_policy.alternative_family_hints[0].family_root, "immune_evasion_programs");
  assert.match(plan.gate_restart_policy.mandatory_restart_steps.join("\n"), /Do not patch/);
});
