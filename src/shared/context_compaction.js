"use strict";

function sliceTop(items, limit) {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function estimateTokens(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function trimText(value, maxChars) {
  if (typeof value !== "string") return value;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 20)).trimEnd()} [truncated]`;
}

function trimStructuredValue(value, options = {}) {
  const maxArray = Number(options.maxArray || 6);
  const maxString = Number(options.maxString || 600);
  const maxDepth = Number(options.maxDepth || 4);
  const depth = Number(options.depth || 0);
  if (typeof value === "string") return trimText(value, maxString);
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return value.slice(0, maxArray);
    if (value && typeof value === "object") return { _truncated: true };
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, maxArray).map((item) =>
      trimStructuredValue(item, { ...options, depth: depth + 1 }),
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      trimStructuredValue(item, { ...options, depth: depth + 1 }),
    ]),
  );
}

function compactGraph(graph, options = {}) {
  if (!graph || typeof graph !== "object") return null;
  const nodeLimit = Number(options.nodeLimit || 12);
  const edgeLimit = Number(options.edgeLimit || 20);
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.slice(0, nodeLimit) : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.slice(0, edgeLimit) : [];
  return {
    node_count: Array.isArray(graph.nodes) ? graph.nodes.length : Number(graph.node_count || 0),
    edge_count: Array.isArray(graph.edges) ? graph.edges.length : Number(graph.edge_count || 0),
    claim_count: Number(graph.claim_count || 0),
    analysis_result_count: Number(graph.analysis_result_count || 0),
    test_count: Number(graph.test_count || 0),
    unresolved_gap_count: Number(graph.unresolved_gap_count || 0),
    nodes: nodes.map((item) => ({
      node_id: item?.node_id || null,
      type: item?.type || null,
      label: item?.label || null,
      status: item?.status || null,
    })),
    edges: edges.map((item) => ({
      source: item?.source || null,
      target: item?.target || null,
      relation: item?.relation || item?.type || null,
      status: item?.status || null,
    })),
  };
}

function compactHypotheses(items, limit = 5) {
  return sliceTop(items, limit).map((item) => ({
    hypothesis_id: item?.hypothesis_id || null,
    family_root: item?.family_root || item?.family || null,
    statement: item?.statement || item?.core_claim || null,
    why_better: item?.why_better || null,
    status: item?.status || item?.state || null,
    hypothesis_score: item?.hypothesis_score ?? null,
  }));
}

function compactValidationGaps(items, limit = 5) {
  return sliceTop(items, limit).map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return String(item || "");
    return item.summary || item.description || item.gap || item.validation_type || JSON.stringify(item).slice(0, 200);
  });
}

function compactActionPayload(action) {
  if (!action || typeof action !== "object") return action;
  const compacted = { ...action };
  if ("reasoning_graph" in compacted) compacted.reasoning_graph = compactGraph(compacted.reasoning_graph);
  if ("data_graph" in compacted) compacted.data_graph = compactGraph(compacted.data_graph);
  if ("knowledge_graph" in compacted) compacted.knowledge_graph = compactGraph(compacted.knowledge_graph);
  if ("candidate_hypotheses" in compacted) compacted.candidate_hypotheses = compactHypotheses(compacted.candidate_hypotheses);
  if ("better_alternative_hypotheses" in compacted) compacted.better_alternative_hypotheses = compactHypotheses(compacted.better_alternative_hypotheses);
  if ("open_validation_gaps" in compacted) compacted.open_validation_gaps = compactValidationGaps(compacted.open_validation_gaps);
  if ("previous_review_context" in compacted) {
    compacted.previous_review_context = trimStructuredValue(compacted.previous_review_context, {
      maxArray: 8,
      maxString: 260,
      maxDepth: 4,
    });
  }
  if ("chronicle_research_context" in compacted) {
    compacted.chronicle_research_context = trimStructuredValue(compacted.chronicle_research_context, {
      maxArray: 8,
      maxString: 260,
      maxDepth: 4,
    });
  }
  if ("failed_runner_context" in compacted) {
    compacted.failed_runner_context = trimStructuredValue(compacted.failed_runner_context, {
      maxArray: 8,
      maxString: 320,
      maxDepth: 4,
    });
  }
  if ("open_source_agent_requirement" in compacted) {
    compacted.open_source_agent_requirement = trimStructuredValue(compacted.open_source_agent_requirement, {
      maxArray: 8,
      maxString: 320,
      maxDepth: 4,
    });
  }
  if (Array.isArray(compacted.challenge_questions)) compacted.challenge_questions = compacted.challenge_questions.slice(0, 6);
  if (Array.isArray(compacted.blocker_reasons)) compacted.blocker_reasons = compacted.blocker_reasons.slice(0, 8);
  return compacted;
}

// Follow-up plans are often produced from a large review action. At the
// skeleton stage, generic metadata trimming is intentionally lossy, but these
// fields change which corpus/journal a Scout resumes and which model route it
// may use. Extract them before trimming and retain the canonical copy both at
// the role-plan root and under planner_metadata.review_action for native
// follow-up consumers.
function extractSearchControl(plan) {
  const metadata = plan?.planner_metadata && typeof plan.planner_metadata === "object"
    ? plan.planner_metadata
    : {};
  const reviewAction = metadata.review_action && typeof metadata.review_action === "object"
    ? metadata.review_action
    : {};
  const keys = [
    "source_lane_id",
    "literature_review_source_dir",
    "literature_review_role_plan_path",
    "literature_review_queue_path",
    "search_agent_journal_path",
    "search_agent_synthesis_path",
    "search_agent_assessment",
    "search_agent_journal_resume_path",
    "coverage_gaps",
    "next_search_decisions",
    "recovery_reason",
  ];
  const control = {};
  for (const key of keys) {
    const value = plan?.[key] ?? metadata?.[key] ?? reviewAction?.[key];
    if (value !== undefined && value !== null) control[key] = value;
  }
  return control;
}

function compactRolePlan(plan) {
  if (!plan || typeof plan !== "object") return plan;
  // Capture execution controls before either compaction pass mutates nested
  // metadata. The final skeleton must remain able to resume a source-bound
  // search even when review_action itself is far larger than the prompt.
  const originalPlannerMetadata = plan.planner_metadata && typeof plan.planner_metadata === "object"
    ? plan.planner_metadata
    : {};
  const originalReviewAction = originalPlannerMetadata.review_action && typeof originalPlannerMetadata.review_action === "object"
    ? originalPlannerMetadata.review_action
    : {};
  const durableSearchControl = extractSearchControl(plan);
  const durableSearchAgentContract = plan.search_agent_contract && typeof plan.search_agent_contract === "object"
    ? plan.search_agent_contract
    : originalPlannerMetadata.search_agent_contract && typeof originalPlannerMetadata.search_agent_contract === "object"
      ? originalPlannerMetadata.search_agent_contract
      : originalReviewAction.search_agent_contract && typeof originalReviewAction.search_agent_contract === "object"
        ? originalReviewAction.search_agent_contract
        : null;
  const durableObjective = typeof plan.objective === "string"
    ? plan.objective
    : typeof plan.screening_objective === "string"
      ? plan.screening_objective
      : null;
  let compacted = { ...plan };
  const tokenBudget = Number(compacted?.constraints?.budget_tokens || compacted?.budget_tokens || 0) || 0;
  const targetPromptTokens = tokenBudget > 0 ? Math.max(512, Math.floor(tokenBudget * 0.65)) : null;

  if (Array.isArray(compacted.recommended_followup_actions)) {
    compacted.recommended_followup_actions = compacted.recommended_followup_actions.map(compactActionPayload).slice(0, 12);
  }
  if (Array.isArray(compacted.candidate_hypotheses)) {
    compacted.candidate_hypotheses = compactHypotheses(compacted.candidate_hypotheses, 5);
  }
  if (Array.isArray(compacted.open_validation_gaps)) {
    compacted.open_validation_gaps = compactValidationGaps(compacted.open_validation_gaps, 5);
  }
  if ("reasoning_graph" in compacted) compacted.reasoning_graph = compactGraph(compacted.reasoning_graph);
  if ("data_graph" in compacted) compacted.data_graph = compactGraph(compacted.data_graph);
  if ("knowledge_graph" in compacted) compacted.knowledge_graph = compactGraph(compacted.knowledge_graph);
  if ("previous_review_context" in compacted) {
    compacted.previous_review_context = trimStructuredValue(compacted.previous_review_context, {
      maxArray: 10,
      maxString: 320,
      maxDepth: 4,
    });
  }
  if ("chronicle_research_context" in compacted) {
    compacted.chronicle_research_context = trimStructuredValue(compacted.chronicle_research_context, {
      maxArray: 10,
      maxString: 320,
      maxDepth: 4,
    });
  }

  if (Array.isArray(compacted.validation_results) && compacted.validation_results.length > 12) {
    compacted.validation_results = compacted.validation_results.slice(0, 12);
  }
  if (Array.isArray(compacted.analysis_traces) && compacted.analysis_traces.length > 12) {
    compacted.analysis_traces = compacted.analysis_traces.slice(0, 12);
  }

  if (compacted.planner_metadata && typeof compacted.planner_metadata === "object") {
    const plannerMetadata = { ...compacted.planner_metadata };
    if ("reasoning_graph" in plannerMetadata) plannerMetadata.reasoning_graph = compactGraph(plannerMetadata.reasoning_graph);
    if ("data_graph" in plannerMetadata) plannerMetadata.data_graph = compactGraph(plannerMetadata.data_graph);
    if ("candidate_hypotheses" in plannerMetadata) plannerMetadata.candidate_hypotheses = compactHypotheses(plannerMetadata.candidate_hypotheses, 5);
    if ("better_alternative_hypotheses" in plannerMetadata) plannerMetadata.better_alternative_hypotheses = compactHypotheses(plannerMetadata.better_alternative_hypotheses, 5);
    if ("open_validation_gaps" in plannerMetadata) plannerMetadata.open_validation_gaps = compactValidationGaps(plannerMetadata.open_validation_gaps, 5);
    if ("review_action" in plannerMetadata) plannerMetadata.review_action = compactActionPayload(plannerMetadata.review_action);
    if ("failed_runner_context" in plannerMetadata) {
      plannerMetadata.failed_runner_context = trimStructuredValue(plannerMetadata.failed_runner_context, {
        maxArray: 8,
        maxString: 320,
        maxDepth: 4,
      });
    }
    if ("open_source_agent_requirement" in plannerMetadata) {
      plannerMetadata.open_source_agent_requirement = trimStructuredValue(plannerMetadata.open_source_agent_requirement, {
        maxArray: 8,
        maxString: 320,
        maxDepth: 4,
      });
    }
    if ("previous_review_context" in plannerMetadata) {
      plannerMetadata.previous_review_context = trimStructuredValue(plannerMetadata.previous_review_context, {
        maxArray: 10,
        maxString: 320,
        maxDepth: 4,
      });
    }
    if ("chronicle_research_context" in plannerMetadata) {
      plannerMetadata.chronicle_research_context = trimStructuredValue(plannerMetadata.chronicle_research_context, {
        maxArray: 10,
        maxString: 320,
        maxDepth: 4,
      });
    }
    if (Array.isArray(plannerMetadata.blocker_reasons)) plannerMetadata.blocker_reasons = plannerMetadata.blocker_reasons.slice(0, 8);
    if (Array.isArray(plannerMetadata.challenge_questions)) plannerMetadata.challenge_questions = plannerMetadata.challenge_questions.slice(0, 6);
    if (Array.isArray(plannerMetadata.recommended_actions)) plannerMetadata.recommended_actions = plannerMetadata.recommended_actions.slice(0, 6);
    compacted.planner_metadata = plannerMetadata;
  }

  const budgetBytes = targetPromptTokens ? Math.max(12000, targetPromptTokens * 4) : 200000;
  let serializedBytes = Buffer.byteLength(JSON.stringify(compacted));
  let estimatedTokens = estimateTokens(compacted);
  let aggressive = false;
  if (serializedBytes > budgetBytes || (targetPromptTokens && estimatedTokens > targetPromptTokens)) {
    if (Array.isArray(compacted.queries)) compacted.queries = compacted.queries.slice(0, 12);
    if (Array.isArray(compacted.analysis_traces)) compacted.analysis_traces = compacted.analysis_traces.slice(0, 6);
    if (Array.isArray(compacted.validation_results)) compacted.validation_results = compacted.validation_results.slice(0, 6);
    if (Array.isArray(compacted.deliverables)) compacted.deliverables = compacted.deliverables.slice(0, 6);
    if (Array.isArray(compacted.outputs)) compacted.outputs = compacted.outputs.slice(0, 6);
    if (Array.isArray(compacted.revision_goals)) compacted.revision_goals = compacted.revision_goals.slice(0, 6);
    if (Array.isArray(compacted.presentation_goals)) compacted.presentation_goals = compacted.presentation_goals.slice(0, 6);
    if (Array.isArray(compacted.claim_evidence_map)) compacted.claim_evidence_map = compacted.claim_evidence_map.slice(0, 6);
    if (typeof compacted.prompt === "string") compacted.prompt = trimText(compacted.prompt, 1200);
    if (typeof compacted.review_goal === "string") compacted.review_goal = trimText(compacted.review_goal, 800);
    if (compacted.planner_metadata && typeof compacted.planner_metadata === "object") {
      const plannerMetadata = { ...compacted.planner_metadata };
      if (Array.isArray(plannerMetadata.blocker_reasons)) plannerMetadata.blocker_reasons = plannerMetadata.blocker_reasons.slice(0, 4);
      if (Array.isArray(plannerMetadata.challenge_questions)) plannerMetadata.challenge_questions = plannerMetadata.challenge_questions.slice(0, 4);
      if ("candidate_hypotheses" in plannerMetadata) plannerMetadata.candidate_hypotheses = compactHypotheses(plannerMetadata.candidate_hypotheses, 3);
      if ("open_validation_gaps" in plannerMetadata) plannerMetadata.open_validation_gaps = compactValidationGaps(plannerMetadata.open_validation_gaps, 3);
      if ("review_action" in plannerMetadata) plannerMetadata.review_action = compactActionPayload(plannerMetadata.review_action);
      plannerMetadata.notes = trimStructuredValue(plannerMetadata.notes, { maxArray: 4, maxString: 400 });
      compacted.planner_metadata = plannerMetadata;
    }
    serializedBytes = Buffer.byteLength(JSON.stringify(compacted));
    estimatedTokens = estimateTokens(compacted);
  }
  if (targetPromptTokens && estimatedTokens > targetPromptTokens) {
    aggressive = true;
    if (Array.isArray(compacted.queries)) compacted.queries = compacted.queries.slice(0, 6);
    if (Array.isArray(compacted.recommended_followup_actions)) compacted.recommended_followup_actions = compacted.recommended_followup_actions.slice(0, 4);
    if (Array.isArray(compacted.analysis_traces)) compacted.analysis_traces = compacted.analysis_traces.map((item) =>
      trimStructuredValue(item, { maxArray: 4, maxString: 280, maxDepth: 3 }),
    ).slice(0, 3);
    if (Array.isArray(compacted.validation_results)) compacted.validation_results = compacted.validation_results.map((item) =>
      trimStructuredValue(item, { maxArray: 4, maxString: 280, maxDepth: 3 }),
    ).slice(0, 3);
    compacted.planner_metadata = trimStructuredValue(compacted.planner_metadata, {
      maxArray: 4,
      maxString: 280,
      maxDepth: 3,
    });
    compacted.context_refs = trimStructuredValue(compacted.context_refs, {
      maxArray: 4,
      maxString: 240,
      maxDepth: 2,
    });
    if (typeof compacted.prompt === "string") compacted.prompt = trimText(compacted.prompt, 600);
    if (typeof compacted.task === "string") compacted.task = trimText(compacted.task, 600);
    serializedBytes = Buffer.byteLength(JSON.stringify(compacted));
    estimatedTokens = estimateTokens(compacted);
  }
  if (targetPromptTokens && estimatedTokens > targetPromptTokens) {
    // The last-resort projection is written to the lane and later used as
    // the dispatch contract.  A Scout cannot reconstruct an adaptive search
    // assignment from a truncated prompt or a task_type alias: preserve the
    // objective and complete contract as durable control data.  These fields
    // are deliberately not passed through trimStructuredValue.
    const plannerMetadata = compacted.planner_metadata && typeof compacted.planner_metadata === "object"
      ? compacted.planner_metadata
      : {};
    const searchControl = durableSearchControl;
    const searchAgentContract = durableSearchAgentContract;
    const exactObjective = durableObjective;
    const compactPlannerMetadata = trimStructuredValue(plannerMetadata, {
      maxArray: 4,
      maxString: 280,
      maxDepth: 3,
    });
    if (Object.keys(searchControl).length) {
      // Keep the native consumer's existing location while avoiding a second
      // unbounded copy of the whole review action.
      compactPlannerMetadata.review_action = searchControl;
    }
    compacted = {
      lane_id: compacted.lane_id || null,
      role: compacted.role || null,
      source: compacted.source || null,
      prompt: trimText(compacted.prompt, 320),
      task: trimText(compacted.task, 320),
      // Keep action_type separate from task_type.  Several downstream paths
      // classify follow-ups by this exact field.
      action_type: compacted.action_type || null,
      task_type: compacted.task_type || compacted.action_type || null,
      // `objective` is the source-of-truth research statement; prompt is
      // presentation context and may be shortened safely.
      objective: exactObjective,
      screening_objective: exactObjective,
      search_agent_contract: searchAgentContract,
      source_brief_id: plan.source_brief_id || null,
      model_route: plan.model_route || null,
      ...searchControl,
      assigned_model: compacted.assigned_model || null,
      research_stage: compacted.research_stage || null,
      control_state: compacted.control_state || null,
      review_goal: trimText(compacted.review_goal, 240),
      previous_review_context: trimStructuredValue(compacted.previous_review_context, {
        maxArray: 4,
        maxString: 180,
        maxDepth: 3,
      }),
      chronicle_research_context: trimStructuredValue(compacted.chronicle_research_context, {
        maxArray: 4,
        maxString: 180,
        maxDepth: 3,
      }),
      review_context_policy: compacted.review_context_policy || null,
      queries: sliceTop(compacted.queries, 3).map((item) => trimText(String(item || ""), 160)),
      deliverables: sliceTop(compacted.deliverables, 4).map((item) => trimStructuredValue(item, { maxArray: 2, maxString: 140, maxDepth: 2 })),
      outputs: sliceTop(compacted.outputs, 4).map((item) => trimStructuredValue(item, { maxArray: 2, maxString: 140, maxDepth: 2 })),
      revision_goals: sliceTop(compacted.revision_goals, 4).map((item) => trimText(String(item || ""), 160)),
      presentation_goals: sliceTop(compacted.presentation_goals, 4).map((item) => trimText(String(item || ""), 160)),
      planner_metadata: compactPlannerMetadata,
      context_refs: trimStructuredValue(compacted.context_refs, {
        maxArray: 3,
        maxString: 120,
        maxDepth: 2,
      }),
      constraints: compacted.constraints || null,
      expected_output_schema_ref: compacted.expected_output_schema_ref || null,
      completion_requirements: sliceTop(compacted.completion_requirements, 4),
      provenance: compacted.provenance || null,
      team_id: compacted.team_id || null,
      team_goal: trimText(compacted.team_goal, 200),
      _preflight_reduction: "skeletonized-for-token-budget",
    };
    serializedBytes = Buffer.byteLength(JSON.stringify(compacted));
    estimatedTokens = estimateTokens(compacted);
  }
  compacted._context_compaction = {
    budget_bytes: budgetBytes,
    serialized_bytes: serializedBytes,
    estimated_tokens: estimatedTokens,
    token_budget: tokenBudget || null,
    target_prompt_tokens: targetPromptTokens,
    aggressive,
  };

  return compacted;
}

module.exports = {
  compactActionPayload,
  compactGraph,
  compactHypotheses,
  compactRolePlan,
  compactValidationGaps,
  estimateTokens,
};
