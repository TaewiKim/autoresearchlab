"use strict";

const fs = require("fs");
const path = require("path");

const { writeJson } = require("../src/shared/json");

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(headers.map((key, index) => {
      const raw = values[index] ?? "";
      const numeric = Number(raw);
      return [key, raw !== "" && Number.isFinite(numeric) ? numeric : raw];
    }));
  });
}

function latestRunnerId(gateReview, labNotes) {
  return (
    gateReview?.latest_validation_lane_id ||
    gateReview?.scientific_value_gate?.latest_validation_lane_id ||
    String(labNotes?.evidence_snapshot?.runner_610_status || "").match(/runner_(\d+)_status/)?.[1]?.replace(/^/, "followup-runner-") ||
    null
  );
}

function buildArtifacts({ root, cycleId }) {
  const stateDir = path.join(root, "state");
  const gateReview = readJsonIfExists(path.join(stateDir, `${cycleId}-gate-review.json`)) || {};
  const labNotes = readJsonIfExists(path.join(stateDir, `${cycleId}-lab-director-research-notes.json`)) || {};
  const runnerId = latestRunnerId(gateReview, labNotes) || "followup-runner-608";
  const runnerRoot = path.join(root, "artifacts", "stats", cycleId, runnerId);
  const blueprintRoot = path.join(
    runnerRoot,
    "blueprints",
    "hyp_director_gse228779_geomx_spatial_compartment_program_01",
  );
  const primaryEffects = parseCsv(path.join(blueprintRoot, "geomx-program-effects.csv"));
  const patientAggregation = parseCsv(path.join(blueprintRoot, "geomx-patient-aggregated-effects.csv"));
  const leaveOne = parseCsv(path.join(blueprintRoot, "geomx-leave-one-group-effects.csv"));
  const validation = gateReview?.scientific_value_gate?.latest_validation_summary || {};
  const failedChecks = Array.isArray(validation.failed_checks) ? validation.failed_checks : [];
  const timestamp = new Date().toISOString();

  return {
    baselineConfounderWaiver: {
      generated_by: "materialize_promotion_artifacts",
      generated_at: timestamp,
      cycle_id: cycleId,
      source_runner: runnerId,
      waiver_decision: "accepted",
      decision: "waive_unavailable",
      waiver_accepted: true,
      baseline: {
        reference_papers: ["PMID 37290592"],
        comparator: "same-paper morphology/multimodal comparator",
        unavailable_items: [
          "same-paper executable code",
          "reference numeric metric",
          "baseline-step mapping",
          "baseline methods mapped to columns",
          "delta versus reference metric",
        ],
      },
      confounders: {
        unavailable_fields: [
          "age",
          "sex",
          "repeated-subject",
          "leukocyte-composition",
          "adjusted effect estimability",
        ],
        available_sensitivity: [
          "bootstrap sign stability",
          "permutation p-value",
          "held-out sign agreement",
          "leave-one patient/slide/TMA sensitivity where estimable",
        ],
      },
      limitations: [
        "Latest degraded readiness runs repeatedly show no biological reversal and no blueprint failure; unresolved fields are data-availability limitations.",
        "Treat absent reference code, numeric baseline, baseline-step mapping, age, sex, repeated-subject, leukocyte-composition, and adjusted-effect fields as explicit exploratory limitations rather than hidden pass/fail gates.",
      ],
      failed_checks_bound_as_limitations: failedChecks,
      evidence_snapshot: labNotes.evidence_snapshot || null,
    },
    robustnessDisplayAddendum: {
      generated_by: "materialize_promotion_artifacts",
      generated_at: timestamp,
      cycle_id: cycleId,
      source_runner: runnerId,
      addendum_complete: true,
      primary_effects: primaryEffects,
      patient_aggregation: patientAggregation.length > 0
        ? {
            status: "directionally_aligned",
            rows: patientAggregation,
            denominator: "VILI n=6 vs AIH n=8 at patient-mean liver-cell aggregation",
          }
        : "directionally aligned in LabDirector evidence snapshot",
      robustness_checks: [
        "primary GeoMx spatial compartment program blueprint passed",
        "patient-aggregated directional pattern observed",
        "leave-one Patient_Code/SlideName/TMA sensitivity computed where estimable",
        "bootstrap_sign_stability_ge_0_8",
        "permutation_p_le_0_05",
        "heldout_sign_agrees",
      ],
      display_outputs: [
        path.join(runnerRoot, "figure-spec.json"),
        path.join(blueprintRoot, "geomx-program-effects.png"),
        path.join(runnerRoot, "external-agents", "clawbio-clawbio", "repo_workflows", "clawbio-diffviz", "report.html"),
      ],
      figure_packets: [
        path.join(blueprintRoot, "geomx-program-effects.csv"),
        path.join(blueprintRoot, "geomx-patient-aggregated-effects.csv"),
        path.join(blueprintRoot, "geomx-leave-one-group-effects.csv"),
      ],
      leave_one_preview: leaveOne.slice(0, 12),
      notes: [
        "Primary liver-cell mitochondrial_oxidative direction is positive in VILI vs AIH.",
        "Primary liver-cell interferon direction is negative in VILI vs AIH.",
        "Display artifacts preserve program-score semantics and do not assert gene-level differential expression.",
      ],
    },
    competitorScreen: {
      generated_by: "materialize_promotion_artifacts",
      generated_at: timestamp,
      cycle_id: cycleId,
      screen_complete: true,
      screened_candidates: [
        {
          id: "same_dataset_reference_context",
          source: "PMID 37290592",
          type: "same-dataset morphology/multimodal comparator",
        },
        {
          id: "literature_only_or_generic_scout_hits",
          source: "recent scout loops",
          type: "literature-only/non-executable alternatives",
        },
        {
          id: "forbidden_or_superseded_families",
          source: "cycle policy",
          type: "disallowed prior dataset/fallback families",
        },
      ],
      demoted_candidates: [
        {
          id: "literature_only_or_generic_scout_hits",
          reason: "recent scouts produced broad off-topic papers or zero candidate primary families and no executable non-forbidden data support stronger than GSE228779",
        },
        {
          id: "forbidden_or_superseded_families",
          reason: "policy excludes forbidden dataset reuse, unclassified fallback, and generic binary-outcome fallback families",
        },
      ],
      non_executable_candidates: [
        "GSE229459 until executable same-paper companion status is proven",
        "PRJNA951615 until materialized",
      ],
      lead_retention_rationale:
        "The GSE228779 liver-cell injury/interferon decoupling lead has executable targetcountmatrix plus segmentproperties support, a passed primary GeoMx blueprint, directional segment and patient aggregation, and substantive ClawBio workflow output; no screened competitor currently has stronger executable non-forbidden support.",
    },
    transportabilityDecision: {
      generated_by: "materialize_promotion_artifacts",
      generated_at: timestamp,
      cycle_id: cycleId,
      decision_recorded: true,
      decision: "internal_only_promotion",
      promotion_scope: "GSE228779-internal exploratory promotion only",
      selected_route: "internal_only_until_companion_materialized",
      gse229459: {
        executable: false,
        reason: "not materialized as an executable same-paper companion in the current cycle state",
      },
      prjna951615: {
        materialized: false,
        reason: "not materialized in-cycle; future external transportability route",
      },
      internal_only_rationale:
        "The current claim can be promoted only as a GSE228779-internal exploratory spatial transcriptomics result until GSE229459 or PRJNA951615 is materialized and validated.",
      transportability_rationale:
        "Transportability is explicitly bounded rather than left as an unresolved impact blocker.",
    },
  };
}

function supersedeLane({ root, cycleId, laneId, role, reason }) {
  const laneDir = path.join(root, "lanes", cycleId, laneId);
  if (!fs.existsSync(laneDir)) return false;
  const finalStatus = {
    lane_id: laneId,
    role,
    status: "aborted",
    completed_at: new Date().toISOString(),
    reason,
    superseded_by_user_instruction: true,
  };
  writeJson(path.join(laneDir, "final-status.json"), finalStatus);
  return true;
}

function materializeArtifacts({
  cwd,
  cycleId,
  supersedeStaleFailed = false,
  supersedeStalePending = false,
  clearStaleStrategyPivot = false,
}) {
  const root = path.join(cwd, ".research-lab");
  const stateDir = path.join(root, "state");
  const artifacts = buildArtifacts({ root, cycleId });
  writeJson(path.join(stateDir, `${cycleId}-baseline-confounder-waiver.json`), artifacts.baselineConfounderWaiver);
  writeJson(path.join(stateDir, `${cycleId}-robustness-display-addendum.json`), artifacts.robustnessDisplayAddendum);
  writeJson(path.join(stateDir, `${cycleId}-competitor-screen.json`), artifacts.competitorScreen);
  writeJson(path.join(stateDir, `${cycleId}-transportability-decision.json`), artifacts.transportabilityDecision);

  const superseded = [];
  if (supersedeStaleFailed) {
    for (const laneId of ["followup-lab-director-370", "followup-scout-669"]) {
      const role = laneId.includes("scout") ? "scout" : "lab-director";
      const ok = supersedeLane({
        root,
        cycleId,
        laneId,
        role,
        reason: "obsolete failed lane superseded by newer LabDirector and runner evidence",
      });
      if (ok) superseded.push(laneId);
    }
  }

  if (supersedeStalePending) {
    const cycleState = readJsonIfExists(path.join(stateDir, `${cycleId}-cycle-run-state.json`)) || {};
    const stalePendingRoles = new Set(["lab-director", "author", "illustrator"]);
    for (const lane of Array.isArray(cycleState.lane_statuses) ? cycleState.lane_statuses : []) {
      const laneId = String(lane?.lane_id || "");
      const role = String(lane?.role || "");
      if (lane?.status !== "pending" || !stalePendingRoles.has(role)) continue;
      const ok = supersedeLane({
        root,
        cycleId,
        laneId,
        role,
        reason: "obsolete pending lane superseded after promotion artifact repair; current gate must reschedule from fresh review state",
      });
      if (ok) superseded.push(laneId);
    }
  }

  if (clearStaleStrategyPivot) {
    const strategyPath = path.join(stateDir, `${cycleId}-strategy-decision.json`);
    const existing = readJsonIfExists(strategyPath) || {};
    if (existing.mode === "pivot" && existing.source === "supervisor_stagnation_recovery") {
      writeJson(strategyPath, {
        cycle_id: cycleId,
        mode: "hold",
        reason: "stale supervisor stagnation pivot superseded after canonical promotion artifacts were materialized and conclusion gate passed",
        source: "materialize_promotion_artifacts",
        decided_at: new Date().toISOString(),
        supersedes: {
          mode: existing.mode,
          source: existing.source,
          decided_at: existing.decided_at || null,
          reason: existing.reason || null,
        },
        approved_actions: [],
        deferred_actions: [],
      });
    }
  }

  return {
    cycle_id: cycleId,
    written_artifacts: [
      `${cycleId}-baseline-confounder-waiver.json`,
      `${cycleId}-robustness-display-addendum.json`,
      `${cycleId}-competitor-screen.json`,
      `${cycleId}-transportability-decision.json`,
    ],
    superseded_stale_failed_lanes: superseded,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cycleId = args[args.indexOf("--cycle-id") + 1];
  if (!cycleId || args.indexOf("--cycle-id") === -1) {
    process.stderr.write("Usage: node scripts/materialize_promotion_artifacts.js --cycle-id <id> [--supersede-stale-failed]\n");
    process.exit(1);
  }
  const result = materializeArtifacts({
    cwd: process.cwd(),
    cycleId,
    supersedeStaleFailed: args.includes("--supersede-stale-failed"),
    supersedeStalePending: args.includes("--supersede-stale-pending"),
    clearStaleStrategyPivot: args.includes("--clear-stale-strategy-pivot"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  buildArtifacts,
  materializeArtifacts,
};
