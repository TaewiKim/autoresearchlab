"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { compactRolePlan } = require("../src/shared/context_compaction");

test("context compaction becomes aggressive under low token budget", () => {
  const longParagraph = "evidence ".repeat(500);
  const exactObjective = "Determine whether adaptive clarification improves safety under contact uncertainty.";
  const searchAgentContract = {
    contract_version: "adaptive-search-agent-v1",
    research_problem: exactObjective,
    hypotheses: [{ hypothesis_id: "H1", statement: "Clarification improves safety." }],
    required_field_facets: [{ facet_id: "interaction", label: "human interaction" }],
    required_inquiry_intents: ["hypothesis_direct", "backward_citation", "forward_citation", "adversarial"],
    round_schema: { required_fields: ["round_id", "query"] },
  };
  const compacted = compactRolePlan({
    role: "author",
    prompt: longParagraph,
    task: longParagraph,
    objective: exactObjective,
    action_type: "reasoning_literature_scout",
    search_agent_contract: searchAgentContract,
    queries: Array.from({ length: 20 }, (_, index) => `query-${index}-${longParagraph}`),
    analysis_traces: Array.from({ length: 12 }, () => ({
      summary: longParagraph,
      notes: [longParagraph, longParagraph],
    })),
    validation_results: Array.from({ length: 12 }, () => ({
      finding: longParagraph,
      details: { body: longParagraph },
    })),
    planner_metadata: {
      notes: {
        body: longParagraph,
      },
      blocker_reasons: Array.from({ length: 10 }, (_, index) => `blocker-${index}-${longParagraph}`),
    },
    constraints: {
      budget_tokens: 800,
    },
  });

  assert.equal(compacted._context_compaction.token_budget, 800);
  assert.equal(compacted._context_compaction.aggressive, true);
  // The prompt target is a soft budget: a durable execution contract may be
  // larger than it, because dropping it changes the task rather than merely
  // shortening context.
  assert.ok(
    compacted._context_compaction.estimated_tokens > compacted._context_compaction.target_prompt_tokens,
  );
  assert.equal(compacted._preflight_reduction, "skeletonized-for-token-budget");
  assert.ok(compacted.queries.length <= 6);
  assert.match(compacted.prompt, /\[truncated\]$/);
  assert.equal(compacted.action_type, "reasoning_literature_scout");
  assert.equal(compacted.objective, exactObjective);
  assert.equal(compacted.screening_objective, exactObjective);
  assert.deepEqual(compacted.search_agent_contract, searchAgentContract);
});

test("skeleton compaction retains canonical source-bound Scout recovery controls", () => {
  const longParagraph = "recovery context ".repeat(900);
  const sourceContract = {
    contract_version: "adaptive-search-agent-v1",
    research_problem: "Which clarification policy reduces unsafe contact?",
    hypotheses: [{ hypothesis_id: "H1", statement: "Risk-aware clarification reduces unsafe contact." }],
    required_field_facets: [{ facet_id: "hri", label: "human-robot interaction" }],
    required_inquiry_intents: ["hypothesis_direct"],
    round_schema: { required_fields: ["round_id"] },
  };
  const nextSearchDecisions = [{ question: "Which prior art treats contact uncertainty?", reason: "The closest baseline is still unresolved." }];
  const compacted = compactRolePlan({
    lane_id: "followup-scout-01",
    role: "scout",
    prompt: longParagraph,
    objective: "Which clarification policy reduces unsafe contact?",
    action_type: "abstract_review_followup",
    source_brief_id: "scout-02",
    model_route: { model: "gpt-5.6-terra", reason: "targeted review" },
    planner_metadata: {
      notes: { body: longParagraph },
      review_action: {
        source_lane_id: "scout-02",
        literature_review_source_dir: ".research-lab/lanes/cycle/scout-02",
        literature_review_role_plan_path: ".research-lab/lanes/cycle/scout-02/role-plan.json",
        literature_review_queue_path: ".research-lab/lanes/cycle/scout-02/review-queue.json",
        search_agent_journal_resume_path: ".research-lab/lanes/cycle/scout-02/search-agent-journal.json",
        search_agent_synthesis_path: ".research-lab/lanes/cycle/scout-02/search-agent-synthesis.json",
        search_agent_contract: sourceContract,
        coverage_gaps: ["facet pending"],
        next_search_decisions: nextSearchDecisions,
      },
    },
    // Force the terminal skeleton rather than only the first trimming pass.
    analysis_traces: Array.from({ length: 16 }, () => ({ summary: longParagraph, detail: { body: longParagraph } })),
    validation_results: Array.from({ length: 16 }, () => ({ finding: longParagraph, detail: { body: longParagraph } })),
    constraints: { budget_tokens: 800 },
  });

  assert.equal(compacted._preflight_reduction, "skeletonized-for-token-budget");
  assert.equal(compacted.source_lane_id, "scout-02");
  assert.equal(compacted.literature_review_source_dir, ".research-lab/lanes/cycle/scout-02");
  assert.equal(compacted.search_agent_journal_resume_path, ".research-lab/lanes/cycle/scout-02/search-agent-journal.json");
  assert.deepEqual(compacted.next_search_decisions, nextSearchDecisions);
  assert.deepEqual(compacted.search_agent_contract, sourceContract);
  assert.deepEqual(compacted.model_route, { model: "gpt-5.6-terra", reason: "targeted review" });
  assert.deepEqual(compacted.planner_metadata.review_action.next_search_decisions, nextSearchDecisions);
  assert.equal(compacted.planner_metadata.review_action.source_lane_id, "scout-02");
});
