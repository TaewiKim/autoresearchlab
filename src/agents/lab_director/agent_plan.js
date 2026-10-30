"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { writeJson } = require("../../shared/json");
const {
  STAGE_ROLE_POLICY,
  isPlanningOnlyScope,
  normalizeResearchScope,
  normalizeResearchStage,
} = require("../../policy/stage_policy");
const { chooseModelRoute } = require("../../policy/model_router");
const { buildImpactFirstHypothesisMandate } = require("../shared/impact_first");
const { buildLabDirectorLiteratureTriagePolicy } = require("../shared/literature_policy");
const {
  supervisorLabDirectorRoleBoundary,
  supervisorEscalationPolicy,
} = require("../shared/role_boundaries");

// Legacy defaults for callers that have not adopted model_route. New plans use
// the dynamic Luna/Terra/Sol/Astra router below. The Claude side retains its
// provider-specific mapping.
const CODEX_MODEL_PARAMETERS = Object.freeze({
  labDirectorModel: "gpt-6.1-sol",
  defaultCodexAgentModel: "gpt-6.1-sol",
  labRunnerCodexModel: "gpt-6.1-terra",
});

const CLAUDE_MODEL_PARAMETERS = Object.freeze({
  labDirectorModel: "claude-opus-4-7",
  defaultCodexAgentModel: "claude-sonnet-4-6",
  labRunnerCodexModel: "claude-sonnet-4-6",
});

const SHARED_MODEL_PARAMETERS = Object.freeze({
  externalDriverModel: "python-external-driver",
  nativeReadonlyModel: "native-readonly-runtime",
});

// Backwards-compat shim — older code imports MODEL_PARAMETERS expecting the
// codex tier names. Keep the codex set as the default surface.
const MODEL_PARAMETERS = Object.freeze({
  ...CODEX_MODEL_PARAMETERS,
  ...SHARED_MODEL_PARAMETERS,
});

const HYPOTHESIS_GATE_EFFICIENCY_MANDATE = Object.freeze({
  primary_goal: "pass the independent hypothesis gate with the minimum valid time and token spend",
  strategy:
    "target only the current gate blockers and missing rubric evidence before opening new hypothesis, scout, or runner branches",
  anti_repetition_rules: [
    "do not repeat broad scout searches when a failed-attempt artifact or candidate exclusion record already closes the external-validation requirement",
    "do not dispatch another LabRunner for the same repository-native workflow blocker after repository_workflow_exhausted is true; require Analyst to repair the input contract, replace the workflow/domain package, or record an explicit waiver with replacement method",
    "do not restart or replace the lead hypothesis unless the latest gatekeeper review rejects the scientific claim, not merely because rubric artifacts are stale or missing",
    "do not schedule redundant LabDirector requery lanes; if the next action is a technical_quality or reporting-completeness review, dispatch the smallest gatekeeper/rubric action directly",
    "do not spend tokens re-reading full graphs, full state trees, or full lane logs when compact gate-review, Chronicle digest, and research notes identify the blocker",
  ],
  required_triage_order: [
    "read current hypothesis-gate blockers",
    "after every completed analyst report, refresh the gate/conclusion/approval review artifacts before deciding whether to requery, rerun, or promote",
    "if a blocker includes repository_workflow_exhausted or repeated repository_workflow_repetition, dispatch only the Analyst compatibility-decision repair until it names a materially revised handoff, replacement workflow, or waiver-backed fallback",
    "map each blocker to the smallest missing artifact or reviewer action",
    "when a blocker is stale, already resolved by newer evidence, too broad for the narrowed claim, or should be replaced by a sharper blocker, emit a gate_blocker_review_request for independent gatekeeper adjudication instead of silently removing it or rerunning broad analysis",
    "reuse existing validation, negative-control, sensitivity, external-validation failed-attempt, and promotion artifacts when scientifically applicable",
    "spawn only the next role needed to close the blocker",
  ],
});

function approvedScholarlyMetadataPolicyEnabled() {
  return String(process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY || "").trim() === "approved-scholarly-metadata-v1";
}

function modelParametersFor(runtime) {
  const normalized = String(runtime || "codex").trim().toLowerCase();
  if (normalized === "claude") {
    return { ...CLAUDE_MODEL_PARAMETERS, ...SHARED_MODEL_PARAMETERS };
  }
  return { ...CODEX_MODEL_PARAMETERS, ...SHARED_MODEL_PARAMETERS };
}

function resolveAgentRuntime(explicit) {
  if (explicit) return String(explicit).trim().toLowerCase();
  const envValue = String(process.env.RESEARCHLAB_AGENT_RUNTIME || "")
    .trim()
    .toLowerCase();
  return envValue || "codex";
}

function complexityScore(prompt) {
  const text = String(prompt || "").toLowerCase();
  let score = 1;
  if (text.length > 40) score += 1;
  if (text.length > 120) score += 1;
  if (/novel|innovation/.test(text)) score += 1;
  if (/paper|citation|literature/.test(text)) score += 1;
  if (/data|analy|experiment/.test(text)) score += 1;
  if (/visual|graph|chart|report/.test(text)) score += 1;
  return Math.min(score, 6);
}

function chooseAgentModel(role, runtime, routingContext = {}) {
  const params = modelParametersFor(runtime);
  if (String(runtime || "codex").trim().toLowerCase() !== "claude") {
    return chooseModelRoute({ role, runtime, ...routingContext }).model;
  }
  if (role === "lab-director") return params.labDirectorModel;
  if (role === "lab-runner") return params.labRunnerCodexModel;
  return params.defaultCodexAgentModel;
}

// Backwards-compat alias retained so older callers that imported the
// codex-only helper keep working; new code should call chooseAgentModel.
function chooseCodexModel(role, score) {
  return chooseAgentModel(role, "codex", { complexityScore: score });
}

function initialActionType(agent) {
  if (agent.role === "lab-director") return "hypothesis_tournament";
  if (agent.role === "gatekeeper") return "independent_gate_review";
  if (agent.role === "analyst") return "analysis_design";
  if (agent.role === "lab-runner") return "validation_execution";
  if (agent.role === "chronicle") return "evidence_digest";
  if (agent.role === "scout") return "literature_and_data_discovery";
  return "routine_role_work";
}

function routeInitialAgent(agent, { prompt, runtime, complexityScore: score }) {
  const modelRoute = chooseModelRoute({
    role: agent.role,
    runtime,
    runtimeClass: agent.runtime_class,
    laneMode: agent.lane_mode,
    prompt,
    complexityScore: score,
    actionType: initialActionType(agent),
    // The director's initial task explicitly asks for a comparative set when
    // the user request does. The router also verifies that this is a genuine
    // candidate-synthesis task before permitting Astra.
    // The scientific admission contract now requires at least five distinct
    // executable procedure signatures before a frontier can be considered.
    candidateCount: agent.role === "lab-director" ? 5 : 0,
  });
  return { ...agent, model: modelRoute.model, model_route: modelRoute };
}

function buildAgent(role, index, overrides = {}) {
  const two = String(index).padStart(2, "0");
  const activationStages = role === "lab-director"
    ? ["evidence", "conclusion", "gate", "document", "done"]
    : Object.entries(STAGE_ROLE_POLICY)
        .filter(([, roles]) => roles.includes(role))
        .map(([stage]) => stage);
  return {
    agent_id: `${role}-${two}`,
    role,
    activation_stages: activationStages,
    ...overrides,
  };
}

function buildDynamicAgentPlan({
  prompt,
  catalogPath,
  researchStage = "evidence",
  runtime = null,
  researchScope = null,
}) {
  const score = complexityScore(prompt);
  const initialStage = normalizeResearchStage(researchStage);
  const agentRuntime = resolveAgentRuntime(runtime);
  const effectiveResearchScope = normalizeResearchScope(researchScope);
  const planningOnly = isPlanningOnlyScope(effectiveResearchScope);
  const params = modelParametersFor(agentRuntime);
  const impactFirstHypothesisMandate = buildImpactFirstHypothesisMandate();
  const literatureTriagePolicy = buildLabDirectorLiteratureTriagePolicy();
  const supervisorRoleBoundary = supervisorLabDirectorRoleBoundary();
  const supervisorInstructionPolicy = supervisorEscalationPolicy();
  const scoutCount = Math.max(3, score >= 4 ? 3 : 2);
  const analystCount = score >= 3 ? 2 : 1;
  const runnerCount = score >= 5 ? 5 : score >= 3 ? 4 : 2;
  const authorCount = score >= 4 ? 2 : 1;
  const illustratorCount = 1;
  const gatekeeperCount = 3;

  const approvedScholarlyOnly = approvedScholarlyMetadataPolicyEnabled();
  const agents = [
    buildAgent("lab-director", 1, {
      lane_mode: "read-write-scoped",
      runtime_class: "codex-agent",
      duty:
        "scientific direction, impact-and-verifiable-data hypothesis generation from literature and data knowledge graphs, research-trend mapping, decomposition, model assignment, and approval readiness management; first ensure literature/data search evidence is converted into KG nodes/edges, then rank candidate families by impact, novelty delta, decision relevance, testability, and concrete validation-data availability. Use the literature triage policy to decide when literature search is necessary, sufficient, or wasteful; abstract-only papers are acceptable KG seeds when full text is unavailable. Same-dataset reference papers and baseline methods are required before validation design/promotion, not before initial hypothesis generation; however, the lead hypothesis must name a validation dataset/accession/bundle or a credible near-term acquisition path before promotion. When supervisor reports a stall, LabDirector must not treat the supervisor text as an analysis plan; LabDirector must independently make the scientific corrective decision, author the next research instruction, update research notes, and assign the next concrete evidence task. LabDirector must also pursue independent hypothesis gate passage with the minimum valid time/token spend: target current gate blockers, reuse existing valid artifacts, and avoid broad repeated scout/requery/runner attempts unless the latest blocker requires them.",
      model: chooseAgentModel("lab-director", agentRuntime),
      role_boundary: supervisorRoleBoundary,
      supervisor_instruction_policy: supervisorInstructionPolicy,
      literature_triage_policy: literatureTriagePolicy,
      hypothesis_gate_efficiency_mandate: HYPOTHESIS_GATE_EFFICIENCY_MANDATE,
    }),
    buildAgent("chronicle", 1, {
      lane_mode: "read-write-scoped",
      runtime_class: "codex-agent",
      duty: "brief generation, evidence linking, dialogue support, and rubric memory",
      model: chooseAgentModel("chronicle", agentRuntime),
    }),
    buildAgent("scout", 1, {
      lane_mode: "read-only",
      runtime_class: "native-readonly",
      duty: "discover open data sources, infer source capabilities, and verify dataset structure against semantic research targets",
      model: params.nativeReadonlyModel,
    }),
  ];

  for (let i = 1; i <= gatekeeperCount; i += 1) {
    agents.push(
      buildAgent("gatekeeper", i, {
        lane_mode: "read-write-scoped",
        runtime_class: "codex-agent",
        duty:
          i === 1
            ? "research novelty and impact review using the paper set plus knowledge graph to infer the state of the art baseline; reject low-impact reproduction-only audits unless they create a decision-changing claim"
            : i === 2
              ? "research technical quality and reproducibility review"
              : "research clarity, and completeness against the reporting standard this objective's own field expects",
        model: chooseAgentModel("gatekeeper", agentRuntime),
      }),
    );
  }

  for (let i = 2; i <= scoutCount; i += 1) {
    if (i === 2) {
      // Literature scout is now a REASONING codex-agent: it authors its own
      // search queries, probes them via `search.py --query`, refines/deepens
      // iteratively, and finalizes the canonical result.json through the driver
      // (see SCOUT SEARCH PROTOCOL in the codex prompt). This replaces the old
      // deterministic query builders (frontier keyword pairs + the terms×hints
      // template + gate external-validation epi suffixes) that produced
      // off-topic and biomedical-drifted queries.
      agents.push(
        buildAgent("scout", i, {
          lane_mode: "read-write-scoped",
          runtime_class: "codex-agent",
          duty:
            "reasoning literature scout: author your own field-appropriate search queries, probe them, and iteratively deepen the search (narrow/broaden/pivot) before finalizing the canonical literature result via the driver; prioritize mechanism/outcome/variable-family evidence and papers that name reusable datasets or accessions for KG seeding",
          model: chooseAgentModel("scout", agentRuntime),
        }),
      );
      continue;
    }
    // Data scout (i>=3) is also a REASONING codex-agent now: it authors its own
    // dataset/benchmark queries for the objective's ACTUAL field (graphics scene
    // sets, ML benchmarks, etc.), probes the multi-domain data browser
    // (`data_scout_browser.py --query`), refines, and finalizes the canonical
    // result.json — no longer hardcoded to biomedical GEO/ArrayExpress/PRIDE.
    agents.push(
      buildAgent("scout", i, {
        lane_mode: "read-write-scoped",
        runtime_class: "codex-agent",
        duty:
          approvedScholarlyOnly
            ? "approved-scholarly data/evaluation literature scout: author adaptive inquiries about datasets, benchmarks, evaluation protocols, and feasibility evidence using approved scholarly metadata plus the local cycle snapshot only; do not download datasets or probe external registries"
            : "reasoning data scout: author your own dataset AND benchmark queries in the objective's own field vocabulary, probe the multi-domain data registries, refine, and finalize the canonical data result via the driver; surface concrete reusable datasets/benchmarks/accessions with metadata for KG seeding",
        model: chooseAgentModel("scout", agentRuntime),
      }),
    );
  }

  for (let i = 1; i <= analystCount; i += 1) {
    // Analyst is now FULLY a reasoning codex-agent (was external-driver for the
    // initial discovery-phase literature synthesis). It designs the validation
    // handoff (dataset_profile, validation_targets, analysis_design_memo,
    // handoff_checks, validation_code_blueprints, self_review) by reasoning over
    // the lab-director hypothesis + dataset. When run before a hypothesis exists
    // it defers gracefully; literature synthesis is covered by the codex scout
    // and chronicle.
    agents.push(
      buildAgent("analyst", i, {
        lane_mode: "read-write-scoped",
        runtime_class: "codex-agent",
        duty:
          i === 1
            ? "statistician (reasoning): after reviewing same-dataset reference papers and their analysis methods, define impact-ranked and validation-data-ranked hypotheses, estimands, and decisive validation tasks; design an executable analysis handoff that improves on that baseline"
            : "statistician (reasoning): pairwise family ranking by impact, novelty, identifiability, validation-data availability, and feasibility, plus confound/moderator analysis, falsification strategy, and follow-up validation design grounded in same-dataset prior methods",
        model: chooseAgentModel("analyst", agentRuntime),
      }),
    );
  }

  for (let i = 1; i <= (planningOnly ? 0 : runnerCount); i += 1) {
    agents.push(
      buildAgent("lab-runner", i, {
        lane_mode: "driver-exec",
        runtime_class: "external-driver",
        duty: `validation-coder lane ${i}: execute one statistician-defined validation check with baseline tools plus Codex-written code`,
        model: chooseAgentModel("lab-runner", agentRuntime),
      }),
    );
  }

  for (let i = 1; i <= illustratorCount; i += 1) {
    agents.push(
      buildAgent("illustrator", i, {
        lane_mode: "read-write-scoped",
        runtime_class: "codex-agent",
        duty: "visual synthesis and researcher-facing presentation refinement",
        model: chooseAgentModel("illustrator", agentRuntime),
      }),
    );
  }

  for (let i = 1; i <= authorCount; i += 1) {
    agents.push(
      buildAgent("author", i, {
        lane_mode: "read-write-scoped",
        runtime_class: "codex-agent",
        duty: i === 1 ? "methods and data narrative" : "results, discussion, and approval narrative",
        model: chooseAgentModel("author", agentRuntime),
      }),
    );
  }

  const routedAgents = agents.map((agent) => routeInitialAgent(agent, {
    prompt,
    runtime: agentRuntime,
    complexityScore: score,
  }));

  return {
    generated_at: new Date().toISOString(),
    planner: "js-lab-director",
    prompt,
    initial_research_stage: initialStage,
    stage_role_policy: STAGE_ROLE_POLICY,
    complexity_score: score,
    model_catalog_path: catalogPath,
    agent_runtime: agentRuntime,
    research_scope: effectiveResearchScope || "full",
    supervisor_role_contract: {
      role_boundary: supervisorRoleBoundary,
      escalation_policy: supervisorInstructionPolicy,
    },
    hypothesis_gate_efficiency_mandate: HYPOTHESIS_GATE_EFFICIENCY_MANDATE,
    lab_director_literature_triage_policy: literatureTriagePolicy,
    impact_first_hypothesis_mandate: impactFirstHypothesisMandate,
    agent_count: routedAgents.length,
    active_agent_count: routedAgents.filter((agent) => agent.activation_stages.includes(initialStage)).length,
    active_roles_for_initial_stage: Array.from(
      new Set(
        routedAgents
          .filter((agent) => agent.activation_stages.includes(initialStage))
          .map((agent) => agent.role),
      ),
    ),
    agents: routedAgents,
  };
}

function writeAgentPlan({ cwd = process.cwd(), cycleId, prompt, catalogPath, researchStage, runtime = null }) {
  const plan = buildDynamicAgentPlan({ prompt, catalogPath, researchStage, runtime });
  const outputPath = path.join(runtimeRoot(cwd), "plans", `${cycleId}-agent-plan.json`);
  writeJson(outputPath, plan);
  return { outputPath, plan };
}

module.exports = {
  buildDynamicAgentPlan,
  writeAgentPlan,
  chooseAgentModel,
  modelParametersFor,
  resolveAgentRuntime,
};
