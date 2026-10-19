"use strict";

const CONTRACT_VERSION = "1.0";

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function normalizeStage(stage) {
  const value = String(stage || "").trim().toLowerCase();
  return value || "evidence";
}

function roleTaskType(role) {
  const value = String(role || "").trim();
  if (value === "scout") return "literature-search";
  if (value === "analyst") return "analysis-design";
  if (value === "lab-runner") return "validation-execution";
  if (value === "chronicle") return "cycle-synthesis";
  if (value === "author") return "document-production";
  if (value === "illustrator") return "visual-production";
  if (value === "gatekeeper") return "gate-review";
  return "lane-execution";
}

function defaultConstraintsForRole(role) {
  switch (String(role || "").trim()) {
    case "scout":
      return { budget_tokens: 8000, timeout_seconds: 900, max_retries: 1 };
    case "analyst":
      return { budget_tokens: 12000, timeout_seconds: 1800, max_retries: 2 };
    case "lab-runner":
      return { budget_tokens: 12000, timeout_seconds: 1800, max_retries: 2 };
    case "chronicle":
      return { budget_tokens: 10000, timeout_seconds: 1200, max_retries: 1 };
    case "author":
      return { budget_tokens: 10000, timeout_seconds: 1200, max_retries: 1 };
    case "illustrator":
      return { budget_tokens: 10000, timeout_seconds: 1200, max_retries: 1 };
    case "gatekeeper":
      return { budget_tokens: 10000, timeout_seconds: 1200, max_retries: 1 };
    default:
      return { budget_tokens: 8000, timeout_seconds: 900, max_retries: 1 };
  }
}

function expectedOutputSchemaRefForRole(role) {
  switch (String(role || "").trim()) {
    case "scout":
      return "schema:literature-result";
    case "analyst":
      return "schema:analysis-plan";
    case "lab-runner":
      return "schema:validation-result";
    case "chronicle":
      return "schema:chronicle-brief";
    case "author":
      return "schema:document-artifact";
    case "illustrator":
      return "schema:visual-artifact";
    case "gatekeeper":
      return "schema:gate-review";
    default:
      return "schema:generic-artifact";
  }
}

function defaultContextRefs({ rolePlan = {}, cyclePlanningContext = null }) {
  const incumbentFamily = cyclePlanningContext?.data_graph_digest?.incumbent_family || null;
  return {
    subgraph_ref: rolePlan.input_subgraph_ref || (incumbentFamily ? `sg:${incumbentFamily}` : null),
    artifact_refs: asArray(rolePlan.artifact_refs).slice(0, 8),
  };
}

function teamIdForRole({ cycleId, role, researchStage }) {
  const stage = normalizeStage(researchStage);
  const value = String(role || "").trim();
  if (value === "author" || value === "illustrator") return `team:${cycleId}:document`;
  if (value === "gatekeeper") return `team:${cycleId}:gate`;
  if (value === "scout" || value === "analyst" || value === "lab-runner" || value === "chronicle") {
    return `team:${cycleId}:${stage}`;
  }
  return null;
}

function teamGoalForRole({ role, researchStage }) {
  const stage = normalizeStage(researchStage);
  if (stage === "document") return "materialize document and visual artifacts from the approved claim set";
  if (stage === "gate") return "stress-test claim quality and review readiness against explicit gate standards";
  return `advance the ${stage} stage with role-specific work`;
}

function completionRequirementsForRole(role) {
  if (role === "analyst") {
    return [
      "analyst brief",
      "executable validation blueprint",
      "self-review verdict",
    ];
  }
  if (role === "author") {
    return [
      "document artifact",
      "claim-evidence map",
      "review-comment response map",
      "review-driven analysis artifact when requested",
      "revision summary",
    ];
  }
  if (role === "illustrator") {
    return [
      "figure manifest",
      "figure generator script that rebuilds every figure from committed data",
      "emitted figure images with their source artifacts named",
      "visual claim map or visual takeaway list",
      "primary visual specification",
    ];
  }
  return [];
}

function deriveDecisionId({ cycleId, researchStage, role }) {
  const stage = normalizeStage(researchStage);
  const suffix = stage === "document"
    ? "document"
    : stage === "gate"
      ? "gate"
      : stage === "conclusion"
        ? "conclusion"
        : "evidence";
  return `decision:${cycleId}:${suffix}:${role || "task"}`;
}

function buildTaskContract({
  cycleId,
  laneId,
  role,
  researchStage = "evidence",
  assignedModel = null,
  rolePlan = {},
  cyclePlanningContext = null,
}) {
  const taskType = rolePlan.task_type || rolePlan.action_type || roleTaskType(role);
  const constraints = {
    ...defaultConstraintsForRole(role),
    ...(rolePlan.constraints || {}),
  };
  const contextRefs = {
    ...defaultContextRefs({ rolePlan, cyclePlanningContext }),
    ...(rolePlan.context_refs || {}),
  };
  const teamId = rolePlan.team_id || teamIdForRole({ cycleId, role, researchStage });
  const decisionId = rolePlan?.provenance?.decision_id || deriveDecisionId({ cycleId, researchStage, role });
  const taskId = rolePlan.task_id || laneId;

  return {
    contract_version: CONTRACT_VERSION,
    task_id: taskId,
    cycle_id: cycleId,
    team_id: teamId,
    team_goal: rolePlan.team_goal || teamGoalForRole({ role, researchStage }),
    role,
    task_type: taskType,
    research_stage: normalizeStage(researchStage),
    control_state: "DISPATCH",
    input: rolePlan.input || {},
    context_refs: contextRefs,
    constraints,
    expected_output_schema_ref:
      rolePlan.expected_output_schema_ref || expectedOutputSchemaRefForRole(role),
    expected_output_schema: rolePlan.expected_output_schema || {},
    completion_requirements: completionRequirementsForRole(role),
    provenance: {
      decision_id: decisionId,
      parent_task_id: rolePlan?.provenance?.parent_task_id || null,
    },
    assigned_model: assignedModel,
  };
}

function validateTaskContract(contract) {
  const required = [
    "contract_version",
    "task_id",
    "cycle_id",
    "role",
    "task_type",
    "research_stage",
    "control_state",
    "context_refs",
    "constraints",
    "provenance",
  ];
  const missing = required.filter((key) => !(key in (contract || {})));
  if (missing.length > 0) {
    return {
      valid: false,
      missing,
    };
  }
  return {
    valid: true,
    missing: [],
  };
}

module.exports = {
  CONTRACT_VERSION,
  buildTaskContract,
  completionRequirementsForRole,
  defaultConstraintsForRole,
  deriveDecisionId,
  expectedOutputSchemaRefForRole,
  teamGoalForRole,
  teamIdForRole,
  validateTaskContract,
};
