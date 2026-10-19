"use strict";

const fs = require("fs");
const path = require("path");
const { runtimeRoot } = require("../runtime/native_client");
const { writeJson } = require("../shared/json");
const { compactRolePlan } = require("../shared/context_compaction");
const { buildLaneQueryPlan, loadCyclePlanningContext } = require("../agents/lab_director/query_plan");
const { normalizeResearchStage } = require("../policy/stage_policy");
const { partitionPlansByDispatchStage } = require("../policy/dispatch_policy");

function unlinkIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function readJsonIfObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hasCandidateCheckpoint(laneRoot) {
  for (const name of ["literature-candidates.json", "abstract-review-queue.json", "abstract-reviews.json"]) {
    const value = readJsonIfObject(path.join(laneRoot, name));
    if (Array.isArray(value?.papers) && value.papers.length > 0) return true;
    if (Array.isArray(value?.candidates) && value.candidates.length > 0) return true;
    if (Array.isArray(value?.queue) && value.queue.length > 0) return true;
    if (Array.isArray(value?.reviews) && value.reviews.length > 0) return true;
  }
  return false;
}

function hasJournalCheckpoint(laneRoot) {
  const journal = readJsonIfObject(path.join(laneRoot, "search-agent-journal.json"));
  if (!journal) return false;
  return (Array.isArray(journal.search_rounds) && journal.search_rounds.length > 0)
    || (Array.isArray(journal?.synthesis?.claim_paper_links) && journal.synthesis.claim_paper_links.length > 0)
    || (Array.isArray(journal?.synthesis?.closest_prior_art) && journal.synthesis.closest_prior_art.length > 0);
}

function isStaleApprovedDataWorkflow(plan) {
  if (process.env.RESEARCHLAB_LITERATURE_NETWORK_POLICY !== "approved-scholarly-metadata-v1") return false;
  const action = String(plan?.action_type || plan?.task_type || "").toLowerCase();
  return action === "data_acquisition_followup" || action === "reasoning_data_scout";
}

function resumableAdaptiveScoutPlan({ existingPlan, laneRoot, role, prompt }) {
  const contract = existingPlan?.search_agent_contract;
  if (role !== "scout" || !contract || typeof contract !== "object") return false;
  if (isStaleApprovedDataWorkflow(existingPlan)) return false;
  if (contract.agent_kind !== "hypothesis_conditioned_literature_agent"
      || contract.contract_version !== "adaptive-search-agent-v1") return false;
  if (existingPlan.objective !== prompt || existingPlan.screening_objective !== prompt) return false;
  return hasCandidateCheckpoint(laneRoot) || hasJournalCheckpoint(laneRoot);
}

function injectLabDirectorQueries({ cwd, cycleId, prompt, laneManifestPath, researchStage = "evidence" }) {
  // Defensive parse: a partial manifest write must not abort
  // run-research. Treat the manifest as empty (no queries to inject)
  // and let the supervisor loop's next pass retry; an empty manifest
  // simply produces zero query plans, which is the same behaviour as
  // an absent manifest.
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(laneManifestPath, "utf8"));
  } catch {
    manifest = {};
  }
  const plans = buildLaneQueryPlan({ cwd, cycleId, prompt, manifest, researchStage });
  const root = runtimeRoot(cwd);
  const cyclePlanningContext = loadCyclePlanningContext({ cwd, cycleId });
  const normalizedStage = normalizeResearchStage(researchStage);
  const partitioned = partitionPlansByDispatchStage(plans, normalizedStage);
  const activePlans = [];
  const deferredPlans = [...partitioned.deferred];

  for (const plan of plans) {
    const laneRoot = path.join(root, "lanes", cycleId, plan.lane_id);
    const role = String(plan.role || "").trim();
    const rolePlanPath = path.join(laneRoot, "role-plan.json");
    const queriesPath = path.join(laneRoot, "queries.json");
    if (!partitioned.active.includes(plan)) {
      unlinkIfExists(rolePlanPath);
      unlinkIfExists(queriesPath);
      continue;
    }
    const existingPlan = readJsonIfObject(rolePlanPath);
    if (resumableAdaptiveScoutPlan({ existingPlan, laneRoot, role, prompt })) {
      // The Scout has started an adaptive investigation.  Rebuilding this plan
      // on run-research restart would erase its authored hypotheses, inquiry
      // sequence, and contract while its candidate/review checkpoint remains.
      // Keep the same-cycle plan and queries intact; stale data workflows are
      // deliberately excluded above so approved-scope routing can replace them.
      activePlans.push(existingPlan);
      continue;
    }
    const compactedPlan = compactRolePlan(plan);
    compactedPlan.research_stage = normalizedStage;
    compactedPlan.stage_valid = true;
    compactedPlan.prompt_preflight = {
      token_budget: compactedPlan?._context_compaction?.token_budget || null,
      estimated_tokens: compactedPlan?._context_compaction?.estimated_tokens || null,
      aggressive_compaction: compactedPlan?._context_compaction?.aggressive === true,
    };
    writeJson(rolePlanPath, compactedPlan);
    if (Array.isArray(compactedPlan.queries) && compactedPlan.queries.length > 0) {
      writeJson(queriesPath, compactedPlan);
    }
    activePlans.push(compactedPlan);
  }

  const summaryPath = path.join(root, "plans", `${cycleId}-lab-director-query-plan.json`);
  writeJson(summaryPath, {
    cycle_id: cycleId,
    prompt,
    research_stage: normalizedStage,
    injected_at: new Date().toISOString(),
    consumed_cycle_state: {
      has_next_cycle_plan: Boolean(cyclePlanningContext?.next_cycle_plan),
      has_family_package_ledger: Boolean(cyclePlanningContext?.family_package_ledger),
      has_family_nomination: Boolean(cyclePlanningContext?.family_nomination),
      has_validation_results: Boolean(cyclePlanningContext?.validation_results),
      has_researcher_view: Boolean(cyclePlanningContext?.researcher_view),
    },
    active_roles: Array.from(new Set(activePlans.map((plan) => plan.role))),
    deferred_roles: Array.from(new Set(deferredPlans.map((plan) => plan.role))),
    lanes: activePlans,
    deferred_lanes: deferredPlans,
  });

  return summaryPath;
}

module.exports = {
  injectLabDirectorQueries,
  resumableAdaptiveScoutPlan,
};
