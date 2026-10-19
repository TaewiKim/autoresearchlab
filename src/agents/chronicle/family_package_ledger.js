"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { ensureDir, writeJson } = require("../../shared/json");

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (!value) return [];
  return [value];
}

function buildFamilyPackageLedger({ cwd = process.cwd(), cycleId, hypotheses = [], evidencePackets = null, graphDiff = null }) {
  const root = runtimeRoot(cwd);
  const outputDir = path.join(root, "state");
  ensureDir(outputDir);

  const families = new Map();
  for (const item of hypotheses) {
    const familyRoot = String(item?.family_root || "unclassified_family").trim() || "unclassified_family";
    if (!families.has(familyRoot)) {
      families.set(familyRoot, {
        family_root: familyRoot,
        hypothesis_ids: [],
        states: {},
        primary_exposure_variables: new Set(),
        outcome_variables: new Set(),
        mechanism_ids: new Set(),
        rival_family_ids: new Set(),
        required_validations: new Set(),
        support_count: 0,
        family_score: 0,
        top_hypothesis_score: 0,
        package_state: "candidate",
        package_penalties: new Set(),
      });
    }
    const entry = families.get(familyRoot);
    if (item?.hypothesis_id) entry.hypothesis_ids.push(item.hypothesis_id);
    entry.states[item?.state || "candidate"] = (entry.states[item?.state || "candidate"] || 0) + 1;
    for (const variable of asArray(item?.primary_exposure_variables || item?.primary_exposure || item?.x_variable)) {
      entry.primary_exposure_variables.add(String(variable));
    }
    for (const variable of asArray(item?.outcome_variables || item?.y_variable)) {
      entry.outcome_variables.add(String(variable));
    }
    for (const mechanism of asArray(item?.mechanism_ids || item?.mechanism_path || item?.mechanisms || item?.mechanism)) {
      entry.mechanism_ids.add(String(mechanism));
    }
    for (const rival of asArray(item?.rival_family_ids || item?.rival_to || item?.rivals)) {
      entry.rival_family_ids.add(String(rival));
    }
    for (const validation of asArray(item?.required_validations || item?.test_plan || item?.validation_plan)) {
      entry.required_validations.add(String(validation));
    }
    entry.support_count += Number(item?.support_count || 0);
    entry.top_hypothesis_score = Math.max(entry.top_hypothesis_score, Number(item?.promotion_readiness_score || 0));
    for (const penalty of asArray(item?.promotion_penalties)) {
      entry.package_penalties.add(String(penalty));
    }
  }

  for (const packet of asArray(evidencePackets?.evidence_packets)) {
    for (const implication of asArray(packet?.family_implications)) {
      const familyId = String(implication?.family_id || "").replace(/^family:/, "").trim();
      if (!familyId || !families.has(familyId)) continue;
      families.get(familyId).family_score += Number(implication?.delta_score || 0);
    }
    // Tournament elimination signal: count how many pairwise contests
    // this packet's family lost. Threshold fires in the second pass below.
    const familyRoot = String(packet?.family_root || "").trim();
    if (familyRoot && families.has(familyRoot)) {
      const outcomes = Array.isArray(packet?.tested_edges?.[0]?.robustness?.validation_outcomes)
        ? packet.tested_edges[0].robustness.validation_outcomes
        : [];
      const entry = families.get(familyRoot);
      if (!Number.isFinite(entry.pairwise_loss_count)) entry.pairwise_loss_count = 0;
      for (const outcome of outcomes) {
        if (
          String(outcome?.validation_type || "") === "family_pairwise_contest" &&
          String(outcome?.verdict || "") === "falsified"
        ) {
          entry.pairwise_loss_count += 1;
        }
      }
    }
  }

  for (const update of asArray(graphDiff?.updates)) {
    if (String(update?.target_type) !== "family") continue;
    const familyId = String(update?.target_id || "").replace(/^family:/, "").trim();
    if (!familyId || !families.has(familyId)) continue;
    const entry = families.get(familyId);
    if (update.operation === "demote") entry.package_state = "demoted";
    else if (update.operation === "challenge" && entry.package_state !== "demoted") entry.package_state = "challenged";
    else if (update.operation === "strengthen" && entry.package_state === "candidate") entry.package_state = "provisionally_promoted";
  }

  for (const entry of families.values()) {
    if (entry.package_state !== "candidate") continue;
    if (entry.states.provisionally_promoted > 0) entry.package_state = "provisionally_promoted";
    else if (entry.states.challenged > 0) entry.package_state = "challenged";
    else if (entry.states.demoted > 0) entry.package_state = "demoted";
    else if (entry.states.contending > 0) entry.package_state = "contending";
  }

  // Tournament elimination rule: a family that lost ≥ 2 pairwise contests
  // is force-demoted regardless of its per-hypothesis state distribution.
  // This closes the "contending forever" loop where pairwise_loss used to
  // be annotated but never acted on (root cause of the 0-promotion trap).
  const PAIRWISE_LOSS_DEMOTION_THRESHOLD = 2;
  for (const entry of families.values()) {
    const losses = Number(entry.pairwise_loss_count || 0);
    if (losses >= PAIRWISE_LOSS_DEMOTION_THRESHOLD) {
      if (entry.package_state !== "demoted") {
        entry.package_state = "demoted";
        entry.package_penalties.add("pairwise_tournament_elimination");
      }
    } else if (losses === 1 && entry.package_state === "candidate") {
      entry.package_state = "challenged";
      entry.package_penalties.add("pairwise_loss_warning");
    }
  }

  const family_packages = Array.from(families.values())
    .map((entry) => ({
      family_root: entry.family_root,
      hypothesis_ids: entry.hypothesis_ids,
      primary_exposure_variables: Array.from(entry.primary_exposure_variables),
      outcome_variables: Array.from(entry.outcome_variables),
      mechanism_ids: Array.from(entry.mechanism_ids),
      rival_family_ids: Array.from(entry.rival_family_ids),
      required_validations: Array.from(entry.required_validations),
      support_count: entry.support_count,
      family_score: entry.family_score,
      top_hypothesis_score: entry.top_hypothesis_score,
      package_state: entry.package_state,
      package_penalties: Array.from(entry.package_penalties),
      pairwise_loss_count: Number(entry.pairwise_loss_count || 0),
      states: entry.states,
    }))
    .sort((a, b) =>
      b.family_score - a.family_score ||
      b.top_hypothesis_score - a.top_hypothesis_score ||
      b.support_count - a.support_count ||
      a.family_root.localeCompare(b.family_root),
    );

  const summary = {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    family_package_count: family_packages.length,
    incumbent_family: family_packages[0]?.family_root || null,
    family_packages,
  };

  const outputPath = path.join(outputDir, `${cycleId}-family-package-ledger.json`);
  writeJson(outputPath, summary);
  return { outputPath, summary };
}

module.exports = {
  buildFamilyPackageLedger,
};
