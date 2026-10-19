"use strict";

const fs = require("fs");
const path = require("path");
const { readJsonIfExists, readJsonIfExistsBounded } = require("./io");
const { asArray, compactText, uniqueStrings } = require("./utils");

function completedExternalValidationAttempts({ root, cycleId }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  const attempts = [];
  const artifactPaths = [
    {
      path: path.join(root, "state", `${cycleId}-external-validation-results.json`),
      source: "state_artifact",
    },
    {
      path: path.join(root, "state", `${cycleId}-independent-validation-results.json`),
      source: "state_artifact",
    },
    {
      path: path.join(root, "state", `${cycleId}-external-validation-failed-attempt.json`),
      source: "failed_attempt_artifact",
    },
    {
      path: path.join(root, "state", `${cycleId}-negative-control-results.json`),
      source: "fallback_validation_artifact",
    },
    {
      path: path.join(root, "state", `${cycleId}-sensitivity-validation-results.json`),
      source: "fallback_validation_artifact",
    },
    {
      path: path.join(root, "state", `${cycleId}-transportability-decision.json`),
      source: "fallback_validation_artifact",
    },
  ];
  for (const entry of artifactPaths) {
    const artifactPath = entry.path;
    const artifact = readJsonIfExists(artifactPath);
    if (artifact) {
      attempts.push({
        source: entry.source,
        artifact_path: artifactPath,
        status: artifact.status || artifact.verdict || "present",
        fallback_validation_type: artifact.validation_type || artifact.artifact_type || null,
      });
    }
  }
  if (!fs.existsSync(lanesRoot)) return attempts;
  for (const laneId of fs.readdirSync(lanesRoot)) {
    const laneDir = path.join(lanesRoot, laneId);
    const rolePlanPath = path.join(laneDir, "role-plan.json");
    let rolePlanSize = 0;
    try { rolePlanSize = fs.statSync(rolePlanPath).size; } catch {}
    // Some analyst/scout recovery role plans carry hundreds of MB of context.
    // External-validation discovery only needs compact lane metadata, so do not
    // parse huge plans during gate review refresh.
    if (rolePlanSize > 5 * 1024 * 1024) continue;
    const rolePlan = readJsonIfExists(rolePlanPath);
    const finalStatus = readJsonIfExists(path.join(laneDir, "final-status.json"));
    if (!rolePlan || !finalStatus || finalStatus.status !== "completed") continue;
    const actionType = String(rolePlan.action_type || rolePlan.task_type || "").trim();
    const targetRubric = String(rolePlan.target_rubric || rolePlan?.planner_metadata?.target_rubric || "").trim();
    const reviewAction = rolePlan?.planner_metadata?.review_action || {};
    const isExternalValidation =
      actionType === "external_validation_followup" ||
      actionType === "external_validation_analysis_followup" ||
      actionType === "negative_control_followup" ||
      actionType === "sensitivity_followup" ||
      reviewAction.type === "external_validation_followup" ||
      reviewAction.type === "negative_control_followup" ||
      reviewAction.type === "sensitivity_followup" ||
      targetRubric === "external_validity";
    if (!isExternalValidation) continue;
    attempts.push({
      source: "lane",
      lane_id: laneId,
      role: rolePlan.role || null,
      action_type: actionType,
      target_rubric: targetRubric || null,
      status: finalStatus.status,
    });
  }
  return attempts;
}

function validationPressureSignals(summary) {
  const text = JSON.stringify(summary || {});
  const openGaps = Array.isArray(summary?.open_validation_gaps) ? summary.open_validation_gaps : [];
  const focus = Array.isArray(summary?.focus_hypotheses) ? summary.focus_hypotheses : [];
  const hypothesisText = JSON.stringify(openGaps.concat(focus));
  const signals = [];
  if (/single-source|single source|one public|public .*slice|single .*dataset/i.test(text)) {
    signals.push("single-source evidence");
  }
  if (/small n|n\s*=\s*\d+|3-vs-3|\bn=3\b/i.test(text)) {
    signals.push("small-sample evidence");
  }
  if (/internally reproducible|within[- ]slice|dataset-internal|internal reproducibility/i.test(text)) {
    signals.push("internal-reproducibility-only claim");
  }
  if (/independent cohort|external validation|replication|orthogonal validation|subgroup[- ]resolved validation/i.test(text)) {
    signals.push("existing text already names external validation as needed");
  }
  if (/batch|normalization|contamin|measurement state|sample purity|confound|selection|missing metadata/i.test(hypothesisText)) {
    signals.push("unresolved measurement or confounding risk");
  }
  return uniqueStrings(signals);
}

function extractValidationSearchTerms(summary) {
  const values = [];
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) values.push(text);
  };
  add(summary?.strongest_claim_summary);
  add(summary?.lead_outcome_label);
  add(summary?.lead_outcome);
  for (const item of Array.isArray(summary?.focus_hypotheses) ? summary.focus_hypotheses.slice(0, 3) : []) {
    add(item?.primary_exposure);
    add(item?.x_variable);
    add(item?.y_variable);
    add(item?.family_root);
    add(item?.statement);
    for (const mechanism of Array.isArray(item?.mechanisms) ? item.mechanisms.slice(0, 3) : []) add(mechanism);
  }
  const cleaned = uniqueStrings(values)
    .map((item) => item.replace(/[^\w\s/-]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((item) => item.length >= 4);
  return cleaned.slice(0, 8);
}

function genericExternalValidationPlan(summary) {
  const terms = extractValidationSearchTerms(summary);
  const base = terms.slice(0, 3).join(" ") || "lead claim";
  const searchQueries = uniqueStrings([
    `${base} independent public dataset`,
    `${base} replication dataset`,
    `${base} public research data repository`,
    `${base} subgroup resolved public dataset`,
    `${base} orthogonal validation dataset`,
  ].filter((item) => item.trim().split(/\s+/).length > 3));
  return {
    principle: "Before hypothesis-gate closure, single-source or internally reproducible claims should trigger an attempt at public independent, orthogonal, or sensitivity validation.",
    acceptable_outcomes: [
      "external validation passes on an independent public dataset",
      "external validation weakens or falsifies the promoted hypothesis and the gate reopens",
      "no accessible/mappable public dataset is found, but a concrete failed-attempt artifact records searched repositories, queries, exclusion reasons, and why direct experiment or collaboration would be needed",
    ],
    validation_strategies: [
      "replication on an independent public dataset",
      "subgroup-resolved replication when the claim is tied to a specific population, stratum, sample class, or measurement state",
      "orthogonal measurement or setting cross-check when exact replication is unavailable",
      "stricter sensitivity or negative-control analysis when no external dataset can be materialized",
    ],
    suggested_search_queries: searchQueries,
    extracted_terms: terms,
  };
}

function externalValidationGateReview({ root, cycleId, summary, conclusionReadyForGate }) {
  const attempts = completedExternalValidationAttempts({ root, cycleId });
  const signals = validationPressureSignals(summary);
  const needsExternalValidation =
    signals.some((item) => /single-source|small-sample|internal-reproducibility-only/.test(item)) &&
    signals.some((item) => /external validation|measurement|confounding/.test(item));
  const requiredForGate = conclusionReadyForGate && needsExternalValidation && attempts.length === 0;
  const plan = genericExternalValidationPlan(summary);
  const reviewComment = needsExternalValidation
    ? "Gate review must not treat internally reproducible single-source evidence as enough for high-impact closure before ResearchLab attempts public independent, orthogonal, or explicitly failed validation."
    : null;
  const blockers = requiredForGate
    ? [
        "additional validation has not been attempted before hypothesis gate closure despite single-source or internally reproducible evidence risk",
      ]
    : [];
  const challengeQuestions = requiredForGate
    ? [
        "Can ResearchLab reproduce the promoted signal in an independent public dataset, subgroup-resolved dataset, orthogonal measurement, or stricter sensitivity/negative-control analysis before closing the hypothesis gate?",
        "If no accessible or mappable public dataset exists, has ResearchLab written an explicit failed-attempt artifact rather than silently deferring validation to the paper stage?",
      ]
    : [];
  const recommendedActions = requiredForGate
    ? [
        {
          type: "lab_director_requery_followup",
          priority: "high",
          preferred_role: "lab-director",
          target_rubric: "external_validity",
          target_score: 95,
          current_score: Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0),
          blocker_reasons: blockers,
          challenge_questions: challengeQuestions,
          validation_objective:
            "Persistently evolve the promoted hypothesis under external-validation pressure: narrow, split, replace, or demote the claim rather than stopping at a paper-ready internal result.",
          validation_plan: plan,
          expected_artifacts: [
            "hypothesis_validation_upgrade_plan.json",
            "external_validation_decision_log.json",
            "next_validation_lane_assignments.json",
          ],
          description:
            "re-plan the lead hypothesis under unresolved external-validation pressure; choose a narrower claim, a replacement hypothesis, or a concrete validation/failed-attempt path and assign follow-up lanes",
        },
        {
          type: "external_validation_followup",
          priority: "high",
          preferred_role: "scout",
          target_rubric: "external_validity",
          target_score: 95,
          current_score: Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0),
          blocker_reasons: blockers,
          challenge_questions: challengeQuestions,
          validation_objective:
            "Attempt public independent, orthogonal, or stricter sensitivity validation before hypothesis-gate closure; materialize an open dataset if possible and write an explicit failure artifact if access or mapping blocks analysis.",
          validation_plan: plan,
          expected_artifacts: [
            "external_validation_dataset_manifest.json",
            "external_validation_feasibility.json",
            "external_validation_analysis_plan.md",
            "external_validation_failed_attempt.md when data access or mapping blocks execution",
          ],
          description:
            "attempt public independent, orthogonal, or stricter sensitivity validation before allowing hypothesis-gate closure; download/materialize accessible data or write a concrete failed-attempt artifact",
        },
        {
          type: "external_validation_analysis_followup",
          priority: "high",
          preferred_role: "analyst",
          target_rubric: "external_validity",
          target_score: 95,
          current_score: Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0),
          blocker_reasons: blockers,
          challenge_questions: challengeQuestions,
          validation_objective:
            "Turn the external-validation search space into an executable decision tree: dataset mapping, fallback sensitivity tests, and demotion criteria.",
          validation_plan: plan,
          expected_artifacts: [
            "external_validation_feasibility.json",
            "external_validation_analysis_plan.md",
            "hypothesis_demote_or_refine_criteria.json",
          ],
          description:
            "design the next executable external-validation or fallback sensitivity analysis, including explicit criteria for narrowing, replacing, or demoting the current hypothesis",
        },
      ]
    : [];
  return {
    required_for_gate: requiredForGate,
    needs_external_validation: needsExternalValidation,
    pressure_signals: signals,
    review_comment: reviewComment,
    validation_plan: plan,
    attempts,
    blockers,
    challenge_questions: challengeQuestions,
    recommended_actions: recommendedActions,
  };
}

function isGenericOpenSourceAdapter(agent) {
  if (!agent || typeof agent !== "object") return false;
  const text = [
    agent.name,
    agent.url,
    agent.download_command,
    agent.local_path,
    agent.source_kind,
  ].map((value) => String(value || "").toLowerCase()).join(" ");
  return (
    text.includes("python-open-source-workflow-adapter") ||
    text.includes("generic_package_adapter") ||
    text.includes("no git clone required")
  );
}

function completedRunnerResults({ root, cycleId, maxCandidates = 12 }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  const candidates = [];
  for (const laneId of fs.readdirSync(lanesRoot)) {
    if (!String(laneId).toLowerCase().includes("runner")) continue;
    const laneDir = path.join(lanesRoot, laneId);
    const finalStatus = readJsonIfExists(path.join(laneDir, "final-status.json"));
    if (!finalStatus || finalStatus.status !== "completed") continue;
    const resultPath = path.join(laneDir, "result.json");
    let mtime = 0;
    try { mtime = fs.statSync(resultPath).mtimeMs; } catch {}
    candidates.push({ lane_id: laneId, result_path: resultPath, mtime });
  }
  return candidates
    .sort((a, b) => b.mtime - a.mtime || a.lane_id.localeCompare(b.lane_id))
    .slice(0, maxCandidates)
    .map((candidate) => {
      const laneResult = readJsonIfExistsBounded(candidate.result_path, 10 * 1024 * 1024);
      if (laneResult && !laneResult.__omitted_large_json) {
        return { ...candidate, result: laneResult };
      }
      const artifactResultPath = path.join(
        root,
        "artifacts",
        "stats",
        cycleId,
        candidate.lane_id,
        "result.json",
      );
      const artifactResult = readJsonIfExistsBounded(artifactResultPath, 10 * 1024 * 1024);
      if (artifactResult && !artifactResult.__omitted_large_json) {
        return {
          ...candidate,
          lane_result_path: candidate.result_path,
          result_path: artifactResultPath,
          result: artifactResult,
          large_lane_result_omitted: laneResult || null,
        };
      }
      const validationSummaryPath = path.join(
        root,
        "artifacts",
        "stats",
        cycleId,
        candidate.lane_id,
        "validation-summary.json",
      );
      const validationSummary = readJsonIfExistsBounded(validationSummaryPath, 1024 * 1024);
      if (validationSummary && !validationSummary.__omitted_large_json) {
        return {
          ...candidate,
          lane_result_path: candidate.result_path,
          result_path: validationSummaryPath,
          result: { validation_summary: validationSummary },
          large_lane_result_omitted: laneResult || null,
        };
      }
      return { ...candidate, result: laneResult };
    })
    .filter((candidate) => candidate.result && !candidate.result.__omitted_large_json);
}

function extractOpenSourceAgentRequirementFromRunner(candidate) {
  const result = candidate?.result || {};
  const validation = result.validation_summary || {};
  const requirement =
    validation.open_source_agent_requirements ||
    result.open_source_agent_requirements ||
    {};
  const handoff =
    result?.role_plan?.planner_metadata?.analyst_handoff ||
    result?.role_plan?.planner_metadata?.analysis_request?.analyst_handoff ||
    result?.analyst_handoff ||
    {};
  const discovery = handoff.open_source_agent_discovery || {};
  const selected =
    handoff.selected_open_source_analysis_agent ||
    discovery.selected_agent ||
    null;
  const selectedIsGeneric = isGenericOpenSourceAdapter(selected);
  const discoveryText = JSON.stringify({
    discovery,
    selected,
    requirement,
  }).toLowerCase();
  const looksOmicsOrHighDimensional = /omics|transcript|rna|rnaseq|gene|expression|proteom|metabolom|methyl|single[- ]cell|high[-_ ]dimensional|large[- ]scale/.test(discoveryText);
  const repositoryRequired =
    requirement.repository_agent_required === true ||
    discovery.repository_agent_required === true ||
    (discovery.mandatory === true && looksOmicsOrHighDimensional && selectedIsGeneric);
  const substantiveWorkflowFromRuns = asArray(result.external_agent_runs).some((run) => {
    if (
      run?.stage !== "application" ||
      run?.status !== "completed" ||
      isGenericOpenSourceAdapter({ name: run.agent_name, local_path: run.cwd })
    ) {
      return false;
    }
    const summary = run.output_dir
      ? readJsonIfExistsBounded(path.join(run.output_dir, "external_repository_agent_summary.json"), 1024 * 1024)
      : null;
    const workflow = run.output_dir
      ? readJsonIfExistsBounded(path.join(run.output_dir, "external_repository_workflow_result.json"), 1024 * 1024)
      : null;
    return (
      summary?.substantive_repository_workflow_applied === true ||
      workflow?.substantive_repository_workflow_applied === true ||
      asArray(summary?.repo_workflow_runs).some((item) => item?.status === "completed" && item?.substantive === true) ||
      asArray(workflow?.repo_workflow_runs).some((item) => item?.status === "completed" && item?.substantive === true)
    );
  });
  const repositoryApplicationCompleted =
    requirement.repository_agent_applied === true ||
    requirement.repository_agent_application_completed === true ||
    asArray(result.external_agent_runs).some((run) =>
      run?.stage === "application" &&
      run?.status === "completed" &&
      !isGenericOpenSourceAdapter({
        name: run.agent_name,
        local_path: run.cwd,
      })
    );
  const substantiveWorkflowApplied =
    requirement.substantive_repository_workflow_applied === true ||
    substantiveWorkflowFromRuns;
  const repositoryApplied = repositoryRequired
    ? repositoryApplicationCompleted && substantiveWorkflowApplied
    : repositoryApplicationCompleted;
  const missingSubstantiveWorkflow =
    repositoryRequired && repositoryApplicationCompleted && !substantiveWorkflowApplied;
  const workflowSummaries = asArray(requirement.external_agent_workflow_summaries);
  const workflowBlockers = workflowSummaries
    .flatMap((item) => asArray(item?.substantive_workflow_blockers))
    .map((item) => compactText(item, 280))
    .filter(Boolean)
    .slice(0, 8);
  const workflowResultPaths = workflowSummaries
    .map((item) => item?.workflow_result_path || item?.summary_path || null)
    .filter(Boolean)
    .slice(0, 6);
  return {
    lane_id: candidate?.lane_id || null,
    result_path: candidate?.result_path || null,
    repository_agent_required: repositoryRequired,
    repository_agent_applied: repositoryApplied,
    repository_agent_application_completed: repositoryApplicationCompleted,
    substantive_repository_workflow_applied: substantiveWorkflowApplied,
    selected_agent_name: selected?.name || null,
    selected_agent_url: selected?.url || null,
    selected_agent_is_generic_adapter: selectedIsGeneric,
    validation_status: validation.overall_status || null,
    failed_checks: asArray(validation.failed_checks),
    workflow_blockers: workflowBlockers,
    workflow_result_paths: workflowResultPaths,
    blocker:
      repositoryRequired && !repositoryApplied
        ? missingSubstantiveWorkflow
          ? "mandatory high-dimensional or large-scale analysis only completed repository inventory/CSV profiling; it must run a repository-native workflow/skill/domain command and produce hypothesis-relevant output artifacts before the hypothesis gate can pass"
          : "mandatory high-dimensional or large-scale analysis has not applied a real external repository/workflow/domain package; generic package adapters do not satisfy the hypothesis gate"
        : null,
  };
}

function normalizeWorkflowBlockerSignatureText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/cycle-[a-z0-9_-]+/g, "cycle")
    .replace(/followup-runner-\d+/g, "followup-runner")
    .replace(/followup-analyst-\d+/g, "followup-analyst")
    .replace(/[a-z]:[\\/][^\s"',;]+/g, "<path>")
    .replace(/\/workspace\/[^\s"',;]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 640);
}

function repositoryWorkflowBlockerSignature(item) {
  const selectedAgent = compactText(
    item?.selected_agent_name ||
      item?.selected_agent_url ||
      asArray(item?.validation_results?.open_source_agent_requirement?.real_repository_agent_names)[0] ||
      "unknown-agent",
    120,
  );
  const blockerText = normalizeWorkflowBlockerSignatureText(
    asArray(item?.workflow_blockers).join(" | ") || item?.blocker || "",
  );
  if (!blockerText) return null;
  return `${selectedAgent.toLowerCase()}::${blockerText}`;
}

function repeatedRepositoryWorkflowBlocker(requirements, latestBlocking) {
  const signature = repositoryWorkflowBlockerSignature(latestBlocking);
  if (!signature) {
    return {
      repeated: false,
      exhausted: false,
      repeated_count: 0,
      lane_ids: [],
      signature: null,
      threshold: 2,
    };
  }
  const matches = requirements.filter((item) =>
    item.repository_agent_required &&
    !item.repository_agent_applied &&
    item.repository_agent_application_completed &&
    item.substantive_repository_workflow_applied !== true &&
    repositoryWorkflowBlockerSignature(item) === signature
  );
  const laneIds = uniqueStrings(matches.map((item) => item.lane_id).filter(Boolean));
  const repeatedCount = matches.length;
  const threshold = 2;
  return {
    repeated: repeatedCount >= threshold,
    exhausted: repeatedCount >= threshold,
    repeated_count: repeatedCount,
    lane_ids: laneIds,
    signature,
    threshold,
    selected_agent_name: latestBlocking?.selected_agent_name || null,
    selected_agent_url: latestBlocking?.selected_agent_url || null,
    latest_runner_lane_id: latestBlocking?.lane_id || null,
    blocker_family: compactText(asArray(latestBlocking?.workflow_blockers).join(" | "), 360),
    required_next_decision:
      repeatedCount >= threshold
        ? "analyst_compatibility_decision_required_before_runner_repeat"
        : "analyst_repair_or_replacement_required",
  };
}

function openSourceAgentGateReview({ root, cycleId, summary, conclusionReadyForGate }) {
  const runnerRequirements = completedRunnerResults({ root, cycleId })
    .map(extractOpenSourceAgentRequirementFromRunner)
    .filter((item) => item.repository_agent_required || item.selected_agent_is_generic_adapter)
    .slice(0, 6);
  const latestSuccessfulIndex = runnerRequirements.findIndex((item) =>
    item.repository_agent_required && item.repository_agent_applied
  );
  const latestBlocking = runnerRequirements.find((item, index) =>
    item.repository_agent_required &&
    !item.repository_agent_applied &&
    (latestSuccessfulIndex < 0 || index < latestSuccessfulIndex)
  );
  const supersededBlocking = latestSuccessfulIndex >= 0
    ? runnerRequirements
        .slice(latestSuccessfulIndex + 1)
        .filter((item) => item.repository_agent_required && !item.repository_agent_applied)
        .map((item) => ({
          lane_id: item.lane_id,
          result_path: item.result_path,
          blocker: item.blocker,
          selected_agent_name: item.selected_agent_name,
          validation_status: item.validation_status,
        }))
    : [];
  const requiredForGate = conclusionReadyForGate && Boolean(latestBlocking);
  const recoveryRequired = Boolean(latestBlocking);
  const blocker = latestBlocking?.blocker || null;
  const repositoryWorkflowRepetition = repeatedRepositoryWorkflowBlocker(
    runnerRequirements,
    latestBlocking,
  );
  const repositoryWorkflowExhausted = repositoryWorkflowRepetition.exhausted === true;
  const blockerReasons = recoveryRequired
    ? [
        blocker,
        repositoryWorkflowExhausted
          ? `same repository workflow blocker repeated ${repositoryWorkflowRepetition.repeated_count} times; do not rerun the unchanged workflow handoff`
          : null,
      ].filter(Boolean)
    : [];
  const challengeQuestions = recoveryRequired
    ? [
        "Has the analyst searched for a modality-matched external repository/workflow/domain package, downloaded or installed it into the cycle tool cache, smoke-tested/debugged it, and applied it to the selected high-dimensional or large-scale dataset before relying on generated blueprint code?",
        "Did the application run a repository-native workflow/skill/domain command that produced hypothesis-relevant output artifacts, rather than only repository inventory or CSV profiling?",
        "If no compatible external workflow exists, does the handoff contain a concrete rejection log with repository URLs, license/input/runtime blockers, and the scientific method choices preserved in the fallback blueprint?",
        repositoryWorkflowExhausted
          ? "Because the same repository workflow blocker has repeated, has Analyst explicitly retired this unchanged workflow attempt and selected a repaired input contract, a replacement workflow, or a waiver-backed fallback method?"
          : null,
      ].filter(Boolean)
    : [];
  const recoveryInstruction = repositoryWorkflowExhausted
    ? "The selected repository workflow has repeated the same blocker. Analyst must not issue another handoff that reuses this workflow unchanged. Produce a repository-workflow compatibility decision: repair with a concrete new input contract/column mapping, choose a different workflow/domain package, or record an explicit rejection/waiver with a replacement method. LabRunner should only execute a materially revised analyst handoff."
    : "Analyst must resolve the degraded repository-agent evidence before another validation handoff: repair the selected workflow command/config/column mapping, choose a compatible workflow/domain package, or record a concrete rejection/waiver with a replacement method. LabRunner should only execute the revised analyst handoff.";
  const recommendedActions = recoveryRequired
    ? [
        {
          type: "methods_followup",
          priority: "high",
          preferred_role: "analyst",
          target_rubric: "reproducibility",
          target_score: 95,
          current_score: Number(summary?.conclusion_readiness_score ?? summary?.approval_readiness_score ?? 0),
          blocker_reasons: blockerReasons,
          challenge_questions: challengeQuestions,
          open_source_agent_requirement: {
            repository_agent_required: true,
            generic_adapter_satisfies_requirement: false,
            latest_runner_lane_id: latestBlocking.lane_id,
            selected_agent_name: latestBlocking.selected_agent_name,
            substantive_repository_workflow_applied: false,
            repository_workflow_exhausted: repositoryWorkflowExhausted,
            repository_workflow_repetition: repositoryWorkflowRepetition,
          },
          failed_runner_context: {
            lane_id: latestBlocking.lane_id,
            result_path: latestBlocking.result_path,
            validation_status: latestBlocking.validation_status,
            failed_checks: latestBlocking.failed_checks,
            selected_agent_name: latestBlocking.selected_agent_name,
            selected_agent_url: latestBlocking.selected_agent_url,
            repository_agent_application_completed: latestBlocking.repository_agent_application_completed,
            substantive_repository_workflow_applied: false,
            workflow_blockers: latestBlocking.workflow_blockers,
            workflow_result_paths: latestBlocking.workflow_result_paths,
            blocker,
            repository_workflow_exhausted: repositoryWorkflowExhausted,
            repository_workflow_repetition: repositoryWorkflowRepetition,
            recovery_instruction: recoveryInstruction,
          },
          validation_results: {
            lane_id: latestBlocking.lane_id,
            result_path: latestBlocking.result_path,
            validation_status: latestBlocking.validation_status,
            failed_checks: latestBlocking.failed_checks,
            open_source_agent_requirement: {
              repository_agent_required: true,
              repository_agent_application_completed: latestBlocking.repository_agent_application_completed,
              substantive_repository_workflow_applied: false,
              selected_agent_name: latestBlocking.selected_agent_name,
              workflow_blockers: latestBlocking.workflow_blockers,
              repository_workflow_exhausted: repositoryWorkflowExhausted,
              repository_workflow_repetition: repositoryWorkflowRepetition,
            },
          },
          expected_artifacts: [
            "Analyst research-note update with the workflow compatibility decision",
            "repository_workflow_compatibility_decision.json naming repair, replacement, or waiver",
            "Revised analyst handoff with selected workflow command/config or explicit rejection/waiver",
            "Rationale for repairing, replacing, or rejecting the incompatible repository workflow before LabRunner execution",
          ],
          repository_workflow_exhausted: repositoryWorkflowExhausted,
          repository_workflow_repetition: repositoryWorkflowRepetition,
          recovery_protocol:
            "repeated repository-native workflow blockers require an Analyst compatibility decision before another LabRunner execution",
          description: repositoryWorkflowExhausted
            ? "same repository workflow blocker repeated; force Analyst compatibility decision, replacement workflow, or waiver before LabRunner repeats validation"
            : "route repository-workflow incompatibility back to Analyst for handoff repair before LabRunner repeats validation",
        },
      ]
    : [];
  return {
    required_for_gate: requiredForGate,
    runner_requirements: runnerRequirements,
    superseded_blocking_runner_requirements: supersededBlocking,
    repository_workflow_repetition: repositoryWorkflowRepetition,
    repository_workflow_exhausted: repositoryWorkflowExhausted,
    blocker,
    challenge_questions: challengeQuestions,
    recommended_actions: recommendedActions,
  };
}

module.exports = {

  externalValidationGateReview,

  openSourceAgentGateReview,

};
