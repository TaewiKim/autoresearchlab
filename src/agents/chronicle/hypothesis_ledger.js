"use strict";

const fs = require("fs");
const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { ensureDir, writeJson } = require("../../shared/json");
const { generateDerivedHypotheses } = require("./hypothesis_generator");
const {
  readDesignConstraints,
  deriveConstraintsFromCycle,
  appendDesignConstraint,
} = require("./design_constraints");
const { buildValidationArtifacts } = require("./data_graph_validation");
const { buildFamilyPackageLedger } = require("./family_package_ledger");
const { writeCycleStateArtifacts } = require("./cycle_state_artifacts");
const {
  applyGraphUpdateStates,
  mergeLedgerStatus,
  readGateReview,
  readCycleLiterature,
  selectFocusHypotheses,
} = require("./hypothesis_ledger/normalization");
const {
  collectLiteratureHypotheses,
  collectDataHypotheses,
  collectPromotions,
} = require("./hypothesis_ledger/collectors");
const {
  validationResultMatchesPlannerCandidate,
  bridgeLiteratureAndDataEvidence,
  aggregateKnowledgeGraphSummary,
  aggregateBridgeGraphSummary,
  summarizeSchemaQuality,
  aggregateReasoningSpineSummary,
} = require("./hypothesis_ledger/evidence");
const {
  finalizeLedgerEntries,
  computeFamilyPairwiseLossCounts,
  applyFamilyPairwiseLossRecount,
} = require("./hypothesis_ledger/scoring");

function buildHypothesisLedger({ cwd = process.cwd(), cycleId }) {
  const root = runtimeRoot(cwd);
  const outputDir = path.join(root, "state");
  ensureDir(outputDir);
  const ledger = new Map();

  collectLiteratureHypotheses(root, cycleId, ledger);
  collectDataHypotheses(root, cycleId, ledger);
  collectPromotions(root, cycleId, ledger);
  bridgeLiteratureAndDataEvidence(ledger);

  const gateReview = readGateReview(root, cycleId);
  const literature = readCycleLiterature(root, cycleId);
  const hypotheses = finalizeLedgerEntries(ledger, gateReview);
  const designConstraints = readDesignConstraints(cwd);
  const derivedHypotheses = generateDerivedHypotheses(hypotheses, { designConstraints });
  const literatureGraphCount = hypotheses.filter((item) => (item.source_graphs || []).includes("literature")).length;
  const dataGraphCount = hypotheses.filter((item) => (item.source_graphs || []).includes("data")).length;
  const summary = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    hypothesis_count: hypotheses.length,
    promoted_count: hypotheses.filter((item) => item.state === "provisionally_promoted").length,
    claim_candidate_count: hypotheses.filter((item) => item.state === "contending").length,
    strengthened_count: hypotheses.filter((item) => item.state === "challenged").length,
    weakened_count: hypotheses.filter((item) => item.state === "demoted").length,
    provisionally_promoted_count: hypotheses.filter((item) => item.state === "provisionally_promoted").length,
    challenged_count: hypotheses.filter((item) => item.state === "challenged").length,
    contending_count: hypotheses.filter((item) => item.state === "contending").length,
    candidate_count: hypotheses.filter((item) => item.state === "candidate").length,
    demoted_count: hypotheses.filter((item) => item.state === "demoted").length,
    retired_count: hypotheses.filter((item) => item.state === "retired").length,
    design_blocked_count: hypotheses.filter((item) => item.state === "design_blocked").length,
    design_block_reasons: Array.from(
      hypotheses
        .filter((item) => item.state === "design_blocked")
        .reduce((acc, item) => {
          for (const reason of item.design_block_reasons || []) acc.add(reason);
          return acc;
        }, new Set()),
    ),
    average_evidence_quality_score:
      hypotheses.length > 0
        ? Math.round(
            hypotheses.reduce((sum, item) => sum + Number(item.evidence_quality_score || 0), 0) /
              hypotheses.length,
          )
        : 0,
    average_hypothesis_score:
      hypotheses.length > 0
        ? Math.round(
            hypotheses.reduce((sum, item) => sum + Number(item.hypothesis_score || 0), 0) /
              hypotheses.length,
          )
        : 0,
    family_state_summary: Array.from(
      hypotheses.reduce((map, item) => {
        const root = item.family_root || "unclassified_family";
        if (!map.has(root)) {
          map.set(root, {
            family_root: root,
            count: 0,
            states: {},
          });
        }
        const entry = map.get(root);
        entry.count += 1;
        entry.states[item.state] = (entry.states[item.state] || 0) + 1;
        return map;
      }, new Map()).values(),
    ),
    knowledge_graph: {
      literature_graph: aggregateKnowledgeGraphSummary(hypotheses, "literature"),
      data_graph: aggregateKnowledgeGraphSummary(hypotheses, "data"),
      bridge_graph: aggregateBridgeGraphSummary(hypotheses),
      reasoning_graph: aggregateReasoningSpineSummary(hypotheses),
    },
    schema_quality: summarizeSchemaQuality(hypotheses),
    spec_compliance: {
      required_output_complete_count: hypotheses.filter((item) => item.required_output_complete).length,
      validation_protocol_count: hypotheses.filter((item) => item.validation_protocol).length,
      graph_supported_count: hypotheses.filter((item) => item.graph_support).length,
      codebook_grounded_count: hypotheses.filter((item) => item.codebook_grounding).length,
    },
    derivable_hypothesis_candidates: derivedHypotheses,
    focus_hypotheses: selectFocusHypotheses(hypotheses, 6),
    hypotheses,
  };

  const validationArtifacts = buildValidationArtifacts({
    cwd,
    cycleId,
    hypotheses,
    familyStateSummary: summary.family_state_summary,
  });

  summary.validation_plan = validationArtifacts.validationPlan;
  summary.evidence_packets = validationArtifacts.evidencePackets;
  summary.data_graph = validationArtifacts.graphUpdate.data_graph;
  summary.graph_update_log = validationArtifacts.graphUpdate.graph_diff;
  summary.validation_artifact_paths = validationArtifacts.paths;
  summary.validation_plan_count = Array.isArray(validationArtifacts.validationPlan?.planned_validations)
    ? validationArtifacts.validationPlan.planned_validations.length
    : 0;
  summary.evidence_packet_count = Array.isArray(validationArtifacts.evidencePackets?.evidence_packets)
    ? validationArtifacts.evidencePackets.evidence_packets.length
    : 0;
  summary.graph_update_count = Array.isArray(validationArtifacts.graphUpdate?.graph_diff?.updates)
    ? validationArtifacts.graphUpdate.graph_diff.updates.length
    : 0;
  summary.hypotheses = applyGraphUpdateStates(summary.hypotheses, validationArtifacts.graphUpdate.graph_diff);

  // Second-pass promotion adjustment — fold pairwise tournament outcomes
  // from evidence packets back into each hypothesis so state and scores
  // reflect the tournament, not just the single-family analysis run.
  const familyPairwiseLossCounts = computeFamilyPairwiseLossCounts(validationArtifacts.evidencePackets);
  summary.hypotheses = applyFamilyPairwiseLossRecount(summary.hypotheses, familyPairwiseLossCounts);
  summary.family_pairwise_loss_counts = Object.fromEntries(familyPairwiseLossCounts);

  summary.focus_hypotheses = selectFocusHypotheses(summary.hypotheses, 6);

  const familyPackageLedger = buildFamilyPackageLedger({
    cwd,
    cycleId,
    hypotheses,
    evidencePackets: validationArtifacts.evidencePackets,
    graphDiff: validationArtifacts.graphUpdate.graph_diff,
  });
  summary.family_package_ledger = familyPackageLedger.summary;
  summary.family_package_ledger_path = familyPackageLedger.outputPath;

  const cycleStateArtifacts = writeCycleStateArtifacts({
    cwd,
    cycleId,
    familyNomination: Array.isArray(literature?.family_nomination) ? literature.family_nomination : [],
    hypotheses,
    validationPlan: validationArtifacts.validationPlan,
    dataGraph: validationArtifacts.graphUpdate.data_graph,
    graphDiff: validationArtifacts.graphUpdate.graph_diff,
    familyPackageLedger: familyPackageLedger.summary,
    evidencePackets: validationArtifacts.evidencePackets,
  });
  summary.cycle_state_artifact_paths = cycleStateArtifacts.paths;
  summary.validation_results = cycleStateArtifacts.validationResultsArtifact;
  summary.claim_traces = cycleStateArtifacts.claimTraceArtifact;
  summary.next_cycle_plan = cycleStateArtifacts.nextCyclePlanArtifact;
  summary.design_constraints_in_effect = designConstraints.length;

  // Append new design constraints derived from this cycle's outcome. This
  // is the "negative memory" feedback loop (item #6) — next cycle's
  // hypothesis generator will read these and soft-filter candidates.
  const newConstraints = deriveConstraintsFromCycle({
    cycleId,
    summary,
    nextCyclePlan: cycleStateArtifacts.nextCyclePlanArtifact,
  });
  summary.design_constraints_appended = [];
  for (const constraint of newConstraints) {
    const row = appendDesignConstraint(cwd, constraint);
    summary.design_constraints_appended.push(row.id);
  }

  const outputPath = path.join(outputDir, `${cycleId}-hypothesis-ledger.json`);
  writeJson(outputPath, summary);
  return { outputPath, summary };
}

module.exports = {
  buildHypothesisLedger,
  __private: {
    mergeLedgerStatus,
    validationResultMatchesPlannerCandidate,
  },
};
