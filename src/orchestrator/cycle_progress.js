"use strict";

// Where the cycle actually IS, derived from the artifacts the harness writes.
//
// MEASURED ON cycle-a-20260919, 2026-09-20: the lead hypothesis was
// recorded at 15:02:55 local (lab-director-hypothesis.selected_at_epoch_ms =
// 1789884175267). For the next five and a half hours nothing executed -- the
// LabDirector read a recorded `released: false` as a pending owner approval
// (4263fe7) and deferred every execution action -- while requery, novelty,
// gate-restart and comparator lanes finished one after another. There was no
// pause, no harness stop, no repeated identical failure and no exhausted
// recovery chain, so maintainer.js never fired. Nothing in the harness tracked
// where the pipeline was, how long it had been there, or what it waited on.
//
// This is that missing model. It reads the cycle's own published state and
// answers three questions: which milestone the pipeline has reached, when it
// reached it, and what the NEXT milestone is waiting on. Everything else --
// stall detection, churn, budget attribution -- is built on those three.
//
// The milestone list is a table, not prose, because the pipeline grows: a new
// stage is one entry with a predicate over its own artifact.
//
// POSITION, NOT HIGH-WATER MARK. The current milestone is the last one whose
// predicate holds AND all of whose predecessors hold. The gate review is the
// reason: gate-review-history.jsonl on the cycle above already held 11 rounds
// from before the lead existed, so "the furthest artifact that exists" would
// have reported a cycle deep in review while it had not run a single
// experiment. A pipeline position cannot skip what it has not done.

const fs = require("fs");
const path = require("path");

const { writeJson } = require("../shared/json");

// A lane runs for 2-15 minutes, so 90 minutes of no progress is a dozen lanes
// spent going nowhere. The guard against a false alarm is not a long clock but
// ADVANCING_ACTIONS below: while a lane that can move THIS milestone is still
// running, the cycle is working, however long that lane's own budget is (a
// landscape scout or a deep read may legitimately take an hour).
//
// MEASURED ON cycle-a-20260919, 2026-09-21, replayed: the dead zone
// would have been caught at 90 minutes; at 30 it is caught after ~6 wasted
// lanes instead of ~17.
const DEFAULT_STALL_MINUTES = 30;
const DEFAULT_LANE_CHURN = 3;
const DEFAULT_NO_EVIDENCE_MINUTES = 90;

/// The action types whose lanes can move each milestone forward. A running one
/// means the cycle is working on this milestone, not stuck at it. The director
/// actions are deliberately absent: a director lane re-deciding is exactly what
/// churns while nothing moves.
const ADVANCING_ACTIONS = {
  field_landscape: ["field_landscape_scout"],
  frontier_harvest_reviewed: ["frontier_harvest", "abstract_review_followup"],
  sota_cards: ["sota_deep_read"],
  field_beliefs: ["expert_field_beliefs_map"],
  candidate_slate: ["expert_candidate_slate"],
  expert_panel: ["expert_panel_review"],
  novelty_audit: ["expert_novelty_refutation"],
  candidate_feasibility: ["expert_feasibility_audit"],
  lead_selected: ["simulation_data_generation_followup", "capability_provisioning_followup"],
  reproduction_anchor: ["simulation_data_generation_followup", "methods_followup", "data_acquisition_followup"],
  experiment_data: ["simulation_data_generation_followup", "data_acquisition_followup", "methods_followup"],
  analysis: ["falsification_comparison_followup", "methods_followup", "external_validation_analysis_followup"],
};

// Enough of a cap that a huge lane tree cannot turn a supervisor pass into a
// directory walk of the whole disk.
const MAX_EVIDENCE_WALK_DEPTH = 6;
const MAX_EVIDENCE_FILES = 5000;

// ---------------------------------------------------------------------------
// reading the cycle's own state

function researchRoot(cwd) {
  return path.join(cwd, ".research-lab");
}

function stateFile(cwd, cycleId, kind) {
  return path.join(researchRoot(cwd), "state", `${cycleId}-${kind}`);
}

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function readJsonlRows(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A row written half-way through an append; the next pass sees it whole.
    }
  }
  return rows;
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function parseMs(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonEmpty(value) {
  return Array.isArray(value) ? value.length > 0 : false;
}

function isoOf(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function csvFields(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field.trim());
  return fields;
}

function simulationOutcomeVaries(csvPath, order) {
  const declared = Array.isArray(order?.emitted_columns) ? order.emitted_columns : [];
  const outcome = declared.find((column) => String(column?.name || "").toLowerCase() === "success")?.name;
  if (!outcome) return true;
  let lines;
  try {
    lines = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim());
  } catch {
    return false;
  }
  const index = csvFields(lines[0] || "").indexOf(outcome);
  if (index < 0) return false;
  const values = new Set(lines.slice(1).map((line) => csvFields(line)[index]).filter((value) => value !== undefined));
  return lines.length < 3 || values.size > 1;
}

function resumableManifestMatchesOrder(manifest, order) {
  const completed = Array.isArray(manifest?.completed_cells) ? manifest.completed_cells : [];
  const remaining = Array.isArray(manifest?.remaining_cells) ? manifest.remaining_cells : [];
  if (!completed.length || !remaining.length || !(Number(manifest?.rows) > 0)) return false;
  if (manifest?.request_id !== String(order?.request_id || "").trim()) return false;
  if (Number(manifest?.episodes_per_condition) !== Number(order?.episodes_per_condition)) return false;
  if (String(manifest?.simulator_backend || "") !== String(order?.simulator_backend || "")) return false;

  const canonicalValue = (value) => {
    const text = String(value);
    return text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text;
  };
  const sameValues = (left, right) => (
    JSON.stringify((left || []).map(canonicalValue)) === JSON.stringify((right || []).map(canonicalValue))
  );
  if (!sameValues(manifest?.seeds, order?.seeds)) return false;
  const manifestColumns = new Set(Array.isArray(manifest?.emitted_columns) ? manifest.emitted_columns.map(String) : []);
  const orderColumns = Array.isArray(order?.emitted_columns) ? order.emitted_columns.map((column) => String(column?.name || "")) : [];
  if (!orderColumns.length || !orderColumns.every((name) => manifestColumns.has(name))) return false;
  const levels = manifest?.condition_levels;
  if (!levels || !Array.isArray(order?.conditions)) return false;
  return order.conditions.every((condition) => (
    typeof condition?.factor === "string"
      && sameValues(levels[condition.factor], condition.levels)
  ));
}

function selectedSimulationOutput(ctx) {
  const orderState = ctx.read("simulation-orders").value;
  const orders = orderState?.simulation_orders;
  if (!Array.isArray(orders)) return { count: 0, ms: 0, selected_simulation: false, dataset_path: null };
  const orderMs = parseMs(orderState?.updated_at);

  let count = 0;
  let newestMs = 0;
  let newestPath = null;
  for (const order of orders) {
    const raw = typeof order?.output_path === "string" ? order.output_path.trim().replace(/\\/g, "/") : "";
    const prefix = `.research-lab/datasets/${ctx.cycleId}/`;
    const relative = raw.replace(/^\.\//, "");
    if (!relative.startsWith(prefix) || relative.split("/").includes("..")) continue;
    const csvPath = path.join(ctx.datasetsDir, ...relative.slice(prefix.length).split("/"));
    const manifestPath = path.join(path.dirname(csvPath), "manifest.json");
    const manifest = readJsonOrNull(manifestPath);
    const requestId = String(order?.request_id || "").trim();
    const validation = manifest?.in_support_validation;
    const arms = Array.isArray(validation?.arms) ? validation.arms : [];
    // MEASURED ON cycle-a-20260919, 2026-09-21: the selected
    // simulation order produced its auditable bundle while the lead projection
    // still said `needs_materialization`. That field is the director's recorded
    // plan, not a live veto; the execution contract's own validation is the
    // materialization decision. Failed old pilots remain excluded here.
    const validated = validation?.passed === true
      && arms.length > 0
      && arms.every((arm) => Number(arm?.in_support_success_rate) > 0);
    // MEASURED ON cycle-a-20260919, 2026-09-21: the director
    // rejected the 09:39 stand-in pilot and reissued the order at 15:28, but
    // those old files still satisfied every later milestone and left progress
    // at terminal conclusion. A reissued order is a new decision epoch: both
    // halves of its bundle must have been written after it.
    // MEASURED ON cycle-a-20260919, 2026-09-21: the same stable v2
    // execution was rephrased by each director requery, so `updated_at` moved
    // past a hash-recorded 10/90-cell resumable bundle. Recover that already
    // measured state only when its manifest matches every structured order
    // field; rejected complete pilots still require post-issue files.
    const outputIsCurrent = !orderMs
      || (mtimeMs(csvPath) >= orderMs && mtimeMs(manifestPath) >= orderMs)
      || resumableManifestMatchesOrder(manifest, order);
    if (!requestId || manifest?.request_id !== requestId || !validated || !isFile(csvPath)
      || !outputIsCurrent
      || !simulationOutcomeVaries(csvPath, order)) continue;
    count += 1;
    const bundleMs = Math.max(mtimeMs(csvPath), mtimeMs(manifestPath));
    if (bundleMs >= newestMs) {
      newestMs = bundleMs;
      newestPath = csvPath;
    }
  }
  return { count, ms: newestMs, selected_simulation: true, dataset_path: newestPath };
}

function selectedMaterializedSimulation(ctx) {
  if (ctx.materializedSimulation) return ctx.materializedSimulation;
  const lead = ctx.read("lab-director-hypothesis").value;
  const selected = lead?.selected_hypothesis;
  // MEASURED ON cycle-a-20260919, 2026-10-10: the selected lead's
  // materialized_dataset was `{mode, rows, sha256}` with no path. That truthy
  // metadata hid its concrete dataset_or_accession and held lead_selected
  // through five adaptive-search followups despite a validated 34,560-row CSV.
  const raw = [
    selected?.identification_strategy?.materialized_dataset,
    lead?.identification_strategy?.materialized_dataset,
    // MEASURED ON cycle-a-20260919, 2026-10-03: execution wrote the
    // selected residual-guided CSV and a passing 4,000-row manifest, but no
    // executor rewrote the lead's materialized_dataset=null planning field.
    // Its concrete dataset_or_accession path is the durable execution link.
    selected?.identification_strategy?.dataset_or_accession,
    selected?.dataset_or_accession,
    lead?.identification_strategy?.dataset_or_accession,
    lead?.dataset_or_accession,
  ].find((candidate) => (
    (typeof candidate === "string" && candidate.trim())
      || (typeof candidate?.path === "string" && candidate.path.trim())
  ));
  const empty = { reached: false, ms: 0, dataset_path: null };
  // MEASURED ON cycle-a-20260919, 2026-10-03: the canonical lead
  // projection stored the validated CSV as `{path, manifest, rows, sha256}`.
  // Progress accepted only the agent-facing string form, so the materialized
  // 20,000-row anchor was invisible and the cycle stayed at lead_selected.
  const rawPath = typeof raw === "string" ? raw : raw?.path;
  if (typeof rawPath !== "string" || !rawPath.trim()) return (ctx.materializedSimulation = empty);

  const sealedRoot = path.join(researchRoot(ctx.cwd), "sealed-datasets", ctx.cycleId);
  const sealedCsv = path.resolve(ctx.cwd, rawPath.trim());
  const inside = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
  };
  const validationFor = (csvPath) => {
    const manifestPath = path.join(path.dirname(csvPath), "manifest.json");
    const manifest = readJsonOrNull(manifestPath);
    const validation = manifest?.in_support_validation;
    const arms = Array.isArray(validation?.arms) ? validation.arms : [];
    const validated = validation?.passed === true
      && arms.length > 0
      && arms.every((arm) => Number(arm?.in_support_success_rate) > 0);
    return { manifest, manifestPath, validated };
  };
  const manifestRows = (manifest) => Number(manifest?.rows ?? manifest?.row_count);
  if (inside(ctx.datasetsDir, sealedCsv) && isFile(sealedCsv)) {
    const { manifest, manifestPath, validated } = validationFor(sealedCsv);
    const requestId = path.basename(path.dirname(sealedCsv));
    // MEASURED ON cycle-a-20260919, 2026-10-03: the selected lead
    // named the validated 20,000-row procedural CSV, while simulation_orders
    // was null and a stale top-level planning flag held lead_selected through
    // four completed director requeries. The selected, validated source bundle
    // is the reproduction anchor even before an optional seal is written.
    const reached = manifest?.request_id === requestId
      && manifestRows(manifest) > 0
      && validated;
    return (ctx.materializedSimulation = {
      reached,
      ms: reached ? Math.max(mtimeMs(manifestPath), mtimeMs(sealedCsv)) : 0,
      dataset_path: reached ? sealedCsv : null,
    });
  }
  if (!inside(sealedRoot, sealedCsv) || !isFile(sealedCsv)) {
    return (ctx.materializedSimulation = empty);
  }
  const sealPath = path.join(path.dirname(sealedCsv), ".sealed.json");
  const seal = readJsonOrNull(sealPath);
  if (!seal?.sha256 || seal?.data_file !== path.basename(sealedCsv) || typeof seal?.source_bundle !== "string") {
    return (ctx.materializedSimulation = empty);
  }
  const sourceBundle = path.resolve(ctx.cwd, seal.source_bundle);
  if (!inside(ctx.datasetsDir, sourceBundle)) return (ctx.materializedSimulation = empty);
  const sourceCsv = path.join(sourceBundle, seal.data_file);
  const { manifest, manifestPath, validated } = validationFor(sourceCsv);
  // MEASURED ON cycle-a-20260919, 2026-10-02: the selected H-ARR
  // lead named a sealed 48,000-row simulation bundle with passing in-support
  // validation, but a later `simulation_orders: null` erased the order record.
  // Three methods lanes then finished at `lead_selected`. The sealed source
  // provenance is execution evidence, not a planning flag, so it satisfies the
  // same reproduction milestone without inventing or re-running an order.
  const reached = Boolean(manifest?.request_id)
    && manifestRows(manifest) > 0
    && validated
    && isFile(sourceCsv);
  return (ctx.materializedSimulation = {
    reached,
    ms: reached ? Math.max(mtimeMs(sealPath), mtimeMs(manifestPath), mtimeMs(sourceCsv)) : 0,
    dataset_path: reached ? sourceCsv : null,
  });
}

function experimentData(ctx) {
  if (ctx.experimentData) return ctx.experimentData;
  const status = ctx.read("lab-director-hypothesis").value?.validation_data_status;
  if (status && status !== "materialized") {
    const ordered = selectedSimulationOutput(ctx);
    const sealed = selectedMaterializedSimulation(ctx);
    ctx.experimentData = ordered.count > 0 || !sealed.reached
      ? ordered
      : { count: 1, ms: sealed.ms, selected_simulation: true, dataset_path: sealed.dataset_path };
  } else {
    const selected = selectedMaterializedSimulation(ctx);
    // MEASURED ON cycle-a-20260919, 2026-10-04: the selected lead
    // recorded `validation_data_status=materialized` and named its validated
    // 90,000-row bundle, then Runner-128 produced fresh evidence. Treating that
    // recorded flag as permission to scan generic data disabled evidence-epoch
    // checks, so pre-run gate/conclusion artifacts kept progress at terminal
    // conclusion while methods followups churned. A concrete selected bundle
    // still owns the evidence epoch after the planning flag becomes materialized.
    ctx.experimentData = selected.reached
      ? { count: 1, ms: selected.ms, selected_simulation: true, dataset_path: selected.dataset_path }
      : newestFileUnder(ctx.datasetsDir);
  }
  return ctx.experimentData;
}

function readyAnalysisHandoffMs(ctx, data) {
  if (!data?.selected_simulation || !data.dataset_path) return 0;
  const target = path.resolve(data.dataset_path);
  let entries = [];
  try {
    entries = fs.readdirSync(ctx.lanesDir);
  } catch {
    return 0;
  }
  let newest = 0;
  for (const laneId of entries) {
    const laneDir = path.join(ctx.lanesDir, laneId);
    const finalStatus = readJsonOrNull(path.join(laneDir, "final-status.json"));
    if (finalStatus?.status !== "completed") continue;
    const handoff = readJsonOrNull(path.join(laneDir, "handoff-validation-plan.json"));
    if (handoff?.analysis_design_memo?.final_handoff_readiness?.ready_for_runner !== true) continue;
    const declared = [
      ...(Array.isArray(handoff.handoff_checks) ? handoff.handoff_checks.flatMap((check) => [check?.dataset_declared, check?.dataset]) : []),
      ...(Array.isArray(handoff.handoff_seal?.datasets) ? handoff.handoff_seal.datasets.flatMap((item) => [item?.declared, item?.resolved]) : []),
    ].filter((value) => typeof value === "string" && value.trim());
    if (!declared.some((value) => path.resolve(ctx.cwd, value.replace(/\\/g, path.sep)) === target)) continue;
    newest = Math.max(newest, laneFinishedMs(laneDir, finalStatus));
  }
  return newest;
}

function sourceLaneFinishedMs(ctx, laneId) {
  if (typeof laneId !== "string" || !laneId.trim()) return 0;
  const laneDir = path.join(ctx.lanesDir, laneId.trim());
  const finalStatus = readJsonOrNull(path.join(laneDir, "final-status.json"));
  return finalStatus ? laneFinishedMs(laneDir, finalStatus) : 0;
}

function analysisEvidence(ctx) {
  if (ctx.analysisEvidence) return ctx.analysisEvidence;
  const validationResults = ctx.read("validation-results").value?.validation_results;
  const evidencePackets = ctx.read("evidence-packets").value?.evidence_packets;
  const present = nonEmpty(validationResults) && nonEmpty(evidencePackets);
  const data = experimentData(ctx);
  if (!present || !data.selected_simulation) {
    ctx.analysisEvidence = { reached: present, ms: 0, strict_epoch: false };
    return ctx.analysisEvidence;
  }

  const validationMs = Math.max(0, ...validationResults.map((result) => (
    sourceLaneFinishedMs(ctx, result?.provenance?.lane_id)
  )));
  const packetMs = Math.max(0, ...evidencePackets.flatMap((packet) => (
    Array.isArray(packet?.provenance)
      ? packet.provenance.map((laneId) => sourceLaneFinishedMs(ctx, laneId))
      : []
  )));
  // MEASURED ON cycle-a-20260919, 2026-09-21: after the selected
  // 4,500-row simulation bundle completed, validation/evidence projections
  // were republished with fresh mtimes but still named only pre-bundle failed
  // runner lanes. Existence (or projection mtime) cannot make that old analysis
  // answer a replacement data epoch; both projections must cite a lane that
  // finished after the bundle did.
  const reached = validationMs >= data.ms && packetMs >= data.ms;
  ctx.analysisEvidence = {
    reached,
    ms: reached ? Math.max(validationMs, packetMs) : 0,
    strict_epoch: true,
  };
  return ctx.analysisEvidence;
}

/**
 * One read of the cycle's state, shared by every milestone predicate.
 *
 * A milestone asks for an artifact by kind and gets its parsed body plus the
 * moment it was written -- the artifact's own timestamp when it carries one,
 * because a file's mtime moves every time the harness republishes a projection
 * and would make a milestone look newer than the decision inside it.
 */
function openCycleState({ cwd, cycleId }) {
  const cache = new Map();
  const read = (kind) => {
    if (!cache.has(kind)) {
      const filePath = stateFile(cwd, cycleId, `${kind}.json`);
      cache.set(kind, { path: filePath, value: readJsonOrNull(filePath), mtime_ms: mtimeMs(filePath) });
    }
    return cache.get(kind);
  };
  const jsonl = new Map();
  const readJsonl = (kind) => {
    if (!jsonl.has(kind)) {
      const filePath = stateFile(cwd, cycleId, `${kind}.jsonl`);
      jsonl.set(kind, { path: filePath, rows: readJsonlRows(filePath), mtime_ms: mtimeMs(filePath) });
    }
    return jsonl.get(kind);
  };
  return {
    cwd,
    cycleId,
    read,
    readJsonl,
    datasetsDir: path.join(researchRoot(cwd), "datasets", cycleId),
    lanesDir: path.join(researchRoot(cwd), "lanes", cycleId),
  };
}

// The moment an artifact records for itself, newest field first, falling back
// to the file's mtime.
function artifactMs(entry, fields = []) {
  const value = entry?.value;
  if (value && typeof value === "object") {
    for (const field of fields) {
      const ms = parseMs(value[field]);
      if (ms) return ms;
    }
  }
  return entry?.mtime_ms || 0;
}

// frontier_harvest.rs::resolution_rank -- anything else is still pending.
const RESOLVED_REVIEW_STATUSES = new Set(["accepted", "excluded", "quarantined"]);

function pendingTopK(harvest) {
  const items = harvest && Array.isArray(harvest.top_k) ? harvest.top_k : [];
  return items.filter((item) => !RESOLVED_REVIEW_STATUSES.has(String(item?.review_status || "pending")));
}

function newestRejections(ctx, limit = 4) {
  const rejections = ctx.read("lead-selection-rejections").value?.rejections;
  if (!Array.isArray(rejections) || !rejections.length) return [];
  const newest = rejections[rejections.length - 1];
  const reasons = Array.isArray(newest?.reasons) ? newest.reasons : [];
  return reasons.slice(0, limit).map((reason) => String(reason));
}

function currentLeadRejections(ctx, limit = 4) {
  const reasons = newestRejections(ctx, limit);
  const harvest = ctx.read("frontier-harvest").value;
  if (!harvest || pendingTopK(harvest).length > 0) return reasons;
  // MEASURED ON cycle-a-20260919, 2026-10-02: the append-only
  // rejection history still ended in a 12-paper frontier wait from Sep 20 even
  // though the published harvest had settled all 20 papers on Sep 21. History
  // remains evidence, but a cleared live gate is not a current wait condition.
  return reasons.filter((reason) => !reason.startsWith("frontier_harvest_unreviewed:"));
}

// ---------------------------------------------------------------------------
// the milestone table
//
// `id`        the milestone's name, used in the progress file and in triggers
// `artifact`  the state kind it is published as (for the report, and the
//             default "not written yet" wait reason)
// `reached`   the predicate over the cycle's state
// `at`        when it was reached (artifact timestamp fields, newest first)
// `waiting`   why it has NOT been reached, for the milestone AFTER the current
//             one; the generic reason is used when this returns nothing
//
// Adding a stage is adding a row. Nothing else in this file knows the names.

const MILESTONES = [
  {
    id: "field_landscape",
    artifact: "field-landscape",
    at: ["projected_at"],
    reached: (ctx) => nonEmpty(ctx.read("field-landscape").value?.subfields),
    waiting: (ctx) => {
      const attempts = ctx.read("field-landscape-attempts").value;
      const rows = Array.isArray(attempts?.attempts) ? attempts.attempts : [];
      const last = rows[rows.length - 1];
      return last?.reason ? [`field_landscape_invalid: ${last.reason}`] : [];
    },
  },
  {
    id: "frontier_harvest_reviewed",
    artifact: "frontier-harvest",
    at: ["reviewed_at", "projected_at"],
    // labdirector::frontier_harvest::frontier_harvest_status: resolved only
    // when every harvested top-K candidate is reviewed or excluded.
    reached: (ctx) => {
      const harvest = ctx.read("frontier-harvest").value;
      return Boolean(harvest) && pendingTopK(harvest).length === 0;
    },
    waiting: (ctx) => {
      const pending = pendingTopK(ctx.read("frontier-harvest").value);
      if (!pending.length) return [];
      const names = pending.slice(0, 8).map((item) => `${item?.paper_id || "?"} (${String(item?.title || "").slice(0, 70)})`);
      return [`frontier_harvest_unreviewed: ${pending.length} harvested top-K candidate(s) still unreviewed (${names.join("; ")})`];
    },
  },
  {
    id: "sota_cards",
    artifact: "sota-cards",
    at: ["projected_at"],
    reached: (ctx) => nonEmpty(ctx.read("sota-cards").value?.cards),
  },
  {
    id: "field_beliefs",
    artifact: "field-beliefs",
    at: ["projected_at"],
    reached: (ctx) => nonEmpty(ctx.read("field-beliefs").value?.beliefs),
  },
  {
    id: "candidate_slate",
    artifact: "candidate-slate",
    at: ["projected_at"],
    reached: (ctx) => nonEmpty(ctx.read("candidate-slate").value?.candidates),
  },
  {
    id: "expert_panel",
    artifact: "expert-panel",
    at: ["projected_at"],
    reached: (ctx) => nonEmpty(ctx.read("expert-panel").value?.ranking),
  },
  {
    id: "novelty_audit",
    artifact: "novelty-audit",
    at: ["updated_at"],
    reached: (ctx) => nonEmpty(ctx.read("novelty-audit").value?.audits),
  },
  {
    id: "candidate_feasibility",
    artifact: "candidate-feasibility",
    at: ["updated_at"],
    reached: (ctx) => nonEmpty(ctx.read("candidate-feasibility").value?.assessments),
  },
  {
    id: "owner_checkpoint",
    artifact: "owner-candidates",
    at: ["published_at"],
    reached: (ctx) => {
      const owner = ctx.read("owner-candidates").value;
      return Boolean(owner?.published_at) && nonEmpty(owner?.candidates);
    },
  },
  {
    id: "owner_selection",
    artifact: "owner-selection",
    at: ["decided_at", "updated_at"],
    // The owner's pick. This one legitimately waits on a person, which is why
    // WAITING_ON_OWNER below excludes it from the stall triggers.
    reached: (ctx) => Boolean(ctx.read("owner-selection").value?.candidate_id),
    waiting: () => ["owner_checkpoint_open: the owner has not picked a candidate yet"],
  },
  {
    id: "lead_selected",
    artifact: "lab-director-hypothesis",
    at: ["selected_at_epoch_ms", "updated_at"],
    reached: (ctx) => selectedLeadMs(ctx) > 0,
    waiting: (ctx) => currentLeadFalsificationRelease(ctx)
      ? ["lead_falsified: the LabDirector must select a replacement method for the surviving research question"]
      : currentLeadRejections(ctx),
  },
  {
    id: "reproduction_anchor",
    artifact: "simulation-orders",
    at: (ctx) => artifactMs(ctx.read("simulation-orders"), ["updated_at"])
      || selectedMaterializedSimulation(ctx).ms,
    // Feasibility passes a candidate only with a reproduction anchor -- one
    // number a SOTA card reports, reproduced here BEFORE the new experiment
    // (labdirector::problem_selection::feasibility). The anchor has left the
    // plan once the director has issued the orders that execute it.
    reached: (ctx) => nonEmpty(ctx.read("simulation-orders").value?.simulation_orders)
      || selectedMaterializedSimulation(ctx).reached,
    waiting: (ctx) => {
      const lead = ctx.read("lab-director-hypothesis").value;
      const reasons = [];
      if (lead?.validation_data_status && lead.validation_data_status !== "materialized") {
        reasons.push(`lead_validation_data_status=${lead.validation_data_status}`);
      }
      const deferred = Array.isArray(lead?.replacement_deferred) ? lead.replacement_deferred : [];
      if (deferred.length) {
        const last = deferred[deferred.length - 1];
        reasons.push(`replacement_deferred at ${last?.deferred_at || "?"}: ${String(last?.rationale || "").slice(0, 200)}`);
      }
      return reasons;
    },
  },
  {
    id: "experiment_data",
    artifact: "datasets/<cycle>/**",
    reached: (ctx) => experimentData(ctx).count > 0,
    at: (ctx) => experimentData(ctx).ms,
    waiting: (ctx) => {
      const status = ctx.read("lab-director-hypothesis").value?.validation_data_status;
      return status && status !== "materialized"
        ? [`lead_validation_data_status=${status}`]
        : ["no_experiment_data: nothing has been written under .research-lab/datasets/<cycle>"];
    },
  },
  {
    id: "analysis",
    artifact: "validation-results",
    at: (ctx) => analysisEvidence(ctx).ms
      || artifactMs(ctx.read("validation-results"), ["updated_at", "generated_at"]),
    reached: (ctx) => analysisEvidence(ctx).reached,
    waiting: (ctx) => analysisEvidence(ctx).strict_epoch
      ? ["analysis_stale_for_experiment_data: validation results and evidence packets cite no lane completed after the selected simulation bundle"]
      : [],
  },
  {
    id: "gate_review",
    artifact: "gate-review-history",
    // A gate round that reviewed THIS lead's evidence, not the rounds that ran
    // before the lead existed.
    reached: (ctx) => gateRoundForCurrentEvidence(ctx).ms > 0,
    at: (ctx) => gateRoundForCurrentEvidence(ctx).ms,
    waiting: (ctx) => {
      const blockers = ctx.read("gate-review").value?.gate_scientific_blockers;
      return Array.isArray(blockers) ? blockers.slice(0, 4).map((item) => `gate_blocker: ${String(item?.blocker || item).slice(0, 200)}`) : [];
    },
  },
  {
    id: "conclusion",
    artifact: "conclusion-review",
    at: ["ts"],
    // MEASURED ON cycle-a-20260919, 2026-09-21: a gate-review
    // cycle stayed at gate_review for 1208 minutes while 187 followups ran.
    // Entering the conclusion stage means its review was published; requiring
    // that review to PASS kept failed/pending reviews attributed to the prior
    // stage and made publication look like the unsatisfied condition.
    reached: (ctx) => conclusionForCurrentEvidence(ctx),
    waiting: (ctx) => {
      const blockers = ctx.read("conclusion-review").value?.conclusion_blockers;
      return Array.isArray(blockers) ? blockers.slice(0, 4).map((item) => `conclusion_blocker: ${String(item?.blocker || item).slice(0, 200)}`) : [];
    },
  },
];

const MILESTONE_IDS = MILESTONES.map((item) => item.id);

// The one wait in the pipeline that is a person, not a defect. A cycle sitting
// here is correct, and raising a stall against it would teach the maintainer to
// "fix" the owner checkpoint away -- the same mistake as deleting a check.
const WAITING_ON_OWNER = new Set(["owner_selection"]);

function selectedLeadMs(ctx) {
  const lead = ctx.read("lab-director-hypothesis");
  if (String(lead.value?.status || "") !== "selected") return 0;
  if (!Boolean(lead.value?.statement || lead.value?.selected_hypothesis)) return 0;
  const selectedMs = artifactMs(lead, ["selected_at_epoch_ms", "updated_at"]);
  // MEASURED ON cycle-a-20260919, 2026-10-07: a typed
  // falsification release at 18:04 retired the 15:05 selected method, but the
  // durable selection projection still made every old downstream artifact
  // satisfy the pipeline through terminal conclusion. The release is the live
  // decision until the director publishes a newer replacement selection.
  return currentLeadFalsificationRelease(ctx, selectedMs) ? 0 : selectedMs;
}

function currentLeadFalsificationRelease(ctx, selectedMs = null) {
  const protection = ctx.read("lead-protection").value;
  if (protection?.decision !== "allow" || protection?.reason !== "lead_falsified_by_completed_run") {
    return null;
  }
  const releaseMs = parseMs(protection?.ts);
  const leadMs = selectedMs == null
    ? artifactMs(ctx.read("lab-director-hypothesis"), ["selected_at_epoch_ms", "updated_at"])
    : selectedMs;
  return releaseMs > leadMs ? protection : null;
}

function currentLeadFalsificationReleaseStartedMs(ctx) {
  const release = currentLeadFalsificationRelease(ctx);
  if (!release) return 0;
  const leadMs = artifactMs(ctx.read("lab-director-hypothesis"), ["selected_at_epoch_ms", "updated_at"]);
  const lead = String(release.lead || "");
  const firstDecision = ctx.readJsonl("hypothesis-progress").rows
    .filter((row) => row?.event_type === "lead_supersession_decision")
    .filter((row) => row?.decision?.reason === "lead_falsified_by_completed_run")
    .filter((row) => !lead || String(row?.decision?.lead || "") === lead)
    .map((row) => parseMs(row?.ts))
    .filter((ms) => ms > leadMs)
    .sort((a, b) => a - b)[0];
  return firstDecision || parseMs(release.ts);
}

function gateRoundAfterLead(ctx) {
  const leadMs = selectedLeadMs(ctx);
  if (!leadMs) return { ms: 0, rounds: 0 };
  const rows = ctx.readJsonl("gate-review-history").rows;
  let newest = 0;
  let rounds = 0;
  for (const row of rows) {
    const ms = parseMs(row?.ts);
    if (ms > leadMs) {
      rounds += 1;
      if (ms > newest) newest = ms;
    }
  }
  return { ms: newest, rounds };
}

function gateRoundForCurrentEvidence(ctx) {
  const analysis = analysisEvidence(ctx);
  if (!analysis.strict_epoch) return gateRoundAfterLead(ctx);
  const afterMs = analysis.ms;
  if (!afterMs) return { ms: 0, rounds: 0 };
  const rows = ctx.readJsonl("gate-review-history").rows;
  let newest = 0;
  let rounds = 0;
  for (const row of rows) {
    const ms = parseMs(row?.ts);
    if (ms > afterMs) {
      rounds += 1;
      if (ms > newest) newest = ms;
    }
  }
  return { ms: newest, rounds };
}

function gateSourceEvidenceMs(ctx) {
  const statuses = ctx.read("gate-review").value?.gatekeeper_review_status_by_rubric;
  if (!Array.isArray(statuses)) return 0;
  return Math.max(0, ...statuses
    .filter((status) => status?.superseded !== true)
    .map((status) => Number(status?.source_mtime || 0))
    .filter(Number.isFinite));
}

function conclusionForCurrentEvidence(ctx) {
  const review = ctx.read("conclusion-review").value;
  const published = typeof review?.conclusion_gate_passed === "boolean";
  const analysis = analysisEvidence(ctx);
  if (!analysis.strict_epoch) return published || ctx.read("gate-review").value?.gate_passed === true;
  const gateMs = gateRoundForCurrentEvidence(ctx).ms;
  // MEASURED ON cycle-a-20260919, 2026-10-04: conclusion-review was
  // built from gatekeeper-187 at 17:06:25, then the same refresh appended its
  // derived gate history at 17:06:28. Comparing sibling write times made that
  // current conclusion permanently stale. Freshness belongs to the gatekeeper
  // source evidence; history time remains the fallback for legacy snapshots.
  const sourceMs = gateSourceEvidenceMs(ctx);
  const freshnessMs = Math.max(analysis.ms, sourceMs || gateMs);
  return gateMs > 0 && published && parseMs(review?.ts) > freshnessMs;
}

// ---------------------------------------------------------------------------
// evidence
//
// What counts as a MEASUREMENT this cycle produced, as opposed to a projection
// the harness rewrites on every pass. cycle-aggregate-metrics and
// cycle-run-state are deliberately absent: both are refreshed every scheduling
// pass, so either would make "no new evidence" impossible to observe.

const EVIDENCE_STATE_KINDS = [
  "validation-results",
  "evidence-packets",
  "claim-traces",
  "external-validation-results",
  "independent-validation-results",
  "negative-control-results",
  "sensitivity-validation-results",
];

function newestFileUnder(dir, depth = 0, seen = { count: 0, ms: 0, path: null }) {
  if (depth > MAX_EVIDENCE_WALK_DEPTH || seen.count >= MAX_EVIDENCE_FILES) return seen;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return seen;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newestFileUnder(full, depth + 1, seen);
      continue;
    }
    if (!entry.isFile()) continue;
    seen.count += 1;
    const ms = mtimeMs(full);
    if (ms > seen.ms) {
      seen.ms = ms;
      seen.path = full;
    }
    if (seen.count >= MAX_EVIDENCE_FILES) break;
  }
  return seen;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (Array.isArray(value[key])) return value[key].length;
    }
  }
  return 0;
}

/**
 * The newest measurement artifact this cycle has written, and a FINGERPRINT.
 *
 * The fingerprint is the point. validation-results, evidence-packets and
 * claim-traces carry no timestamp of their own and the harness republishes them
 * on every scheduling pass, so an mtime says only that the pass ran -- on
 * cycle-a-20260919 all three were re-stamped hours after the last
 * measurement that changed them. "New evidence" therefore means the CONTENT
 * changed: how many results, packets and traces exist, and what the newest
 * dataset file is. recordProgress remembers when that last moved.
 */
function newestEvidence(ctx) {
  let best = { path: null, ms: 0, kind: null };
  const counts = {};
  for (const kind of EVIDENCE_STATE_KINDS) {
    const entry = ctx.read(kind);
    if (!entry.value) continue;
    counts[kind] = countOf(entry.value);
    const ms = artifactMs(entry, ["updated_at", "generated_at", "ts"]);
    if (ms > best.ms) best = { path: entry.path, ms, kind };
  }
  const dataset = newestFileUnder(ctx.datasetsDir);
  if (dataset.count) {
    counts.datasets = dataset.count;
    if (dataset.ms > best.ms) best = { path: dataset.path, ms: dataset.ms, kind: "datasets" };
  }
  const fingerprint = [
    ...Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}=${count}`),
    `newest=${dataset.path ? path.basename(dataset.path) : ""}@${dataset.ms}`,
  ].join(";");
  return { ...best, counts, fingerprint };
}

// ---------------------------------------------------------------------------
// lanes finished since the milestone advanced

/// The lanes running right now, by action type: a lane with a run-state and no
/// terminal marker (self-healing renames that marker to final-status.json.*).
function runningLanes(ctx) {
  let entries = [];
  try {
    entries = fs.readdirSync(ctx.lanesDir);
  } catch {
    return [];
  }
  const running = [];
  for (const laneId of entries) {
    const laneDir = path.join(ctx.lanesDir, laneId);
    let ended = false;
    try {
      ended = fs.readdirSync(laneDir).some((name) => name.startsWith("final-status.json"));
    } catch {
      continue;
    }
    if (ended) continue;
    const runState = readJsonOrNull(path.join(laneDir, "run-state.json"));
    if (String(runState?.status || "") !== "running") continue;
    running.push({
      lane_id: laneId,
      action_type: laneActionType(laneDir, laneId),
      started_at: runState.started_at || null,
    });
  }
  return running;
}

function laneActionType(laneDir, laneId) {
  const plan = readJsonOrNull(path.join(laneDir, "role-plan.json"));
  const declared = plan && (plan.action_type || plan.requested_action_type);
  if (declared) return String(declared);
  const contract = readJsonOrNull(path.join(laneDir, "lane-contract.json"));
  if (contract?.role) return `${contract.role}:unspecified`;
  const match = /^(?:followup-)?([a-z]+(?:-[a-z]+)*?)-\d+$/.exec(laneId);
  return match ? `${match[1]}:unspecified` : "unknown";
}

function laneFinishedMs(laneDir, finalStatus) {
  const declared = parseMs(finalStatus?.completed_at || finalStatus?.finished_at);
  if (declared) return declared;
  return mtimeMs(path.join(laneDir, "final-status.json"));
}

/**
 * Every lane that finished after `sinceMs`, grouped by action_type.
 *
 * This is the churn signal: a cycle where nothing moves but everything runs
 * looks exactly like a healthy one to anything that counts lanes.
 */
function lanesFinishedSince(ctx, sinceMs) {
  let entries = [];
  try {
    entries = fs.readdirSync(ctx.lanesDir);
  } catch {
    return { total: 0, by_action_type: {}, newest: [] };
  }
  const byAction = new Map();
  const finished = [];
  for (const laneId of entries) {
    const laneDir = path.join(ctx.lanesDir, laneId);
    const finalStatus = readJsonOrNull(path.join(laneDir, "final-status.json"));
    if (!finalStatus) continue;
    const ms = laneFinishedMs(laneDir, finalStatus);
    if (!(ms > sinceMs)) continue;
    const actionType = laneActionType(laneDir, laneId);
    const row = {
      lane_id: laneId,
      action_type: actionType,
      status: String(finalStatus.status || ""),
      failure_category: finalStatus.failure_category || null,
      finished_at: isoOf(ms),
      finished_ms: ms,
    };
    finished.push(row);
    if (!byAction.has(actionType)) byAction.set(actionType, { action_type: actionType, completed: 0, failed: 0, total: 0, lane_ids: [] });
    const group = byAction.get(actionType);
    group.total += 1;
    if (row.status === "completed") group.completed += 1;
    else if (row.status === "failed") group.failed += 1;
    group.lane_ids.push(laneId);
  }
  finished.sort((a, b) => a.finished_ms - b.finished_ms);
  const table = Object.fromEntries(
    [...byAction.values()]
      .sort((a, b) => b.total - a.total)
      .map((group) => [group.action_type, { ...group, lane_ids: group.lane_ids.slice(-8) }]),
  );
  return {
    total: finished.length,
    by_action_type: table,
    newest: finished.slice(-8).reverse().map(({ finished_ms, ...rest }) => rest),
  };
}

// ---------------------------------------------------------------------------
// the progress model

function progressPath({ cwd, cycleId }) {
  return path.join(researchRoot(cwd), "state", `${cycleId}-progress.json`);
}

function milestoneAt(entry, ctx) {
  if (typeof entry.at === "function") return entry.at(ctx);
  return artifactMs(ctx.read(entry.artifact), entry.at || ["updated_at", "generated_at", "projected_at"]);
}

/**
 * Where the cycle is, what it waits on, and what has run since it got there.
 *
 * Pure: it reads state and returns a value. `recordProgress` is what persists.
 */
function deriveProgress({ cwd, cycleId, now = Date.now(), pinnedReachedAtMs = 0 }) {
  const ctx = openCycleState({ cwd, cycleId });

  let reachedIndex = -1;
  for (let index = 0; index < MILESTONES.length; index += 1) {
    let ok = false;
    try {
      ok = MILESTONES[index].reached(ctx) === true;
    } catch {
      ok = false;
    }
    if (!ok) break;
    reachedIndex = index;
  }

  const current = reachedIndex >= 0 ? MILESTONES[reachedIndex] : null;
  const next = MILESTONES[reachedIndex + 1] || null;
  // The CURRENT milestone's own moment, not the newest of all of them. Several
  // earlier stages are projections the harness republishes on every scheduling
  // pass (frontier-harvest's review state is refreshed once a pass), and taking
  // the newest would let one of those reset the stall clock forever.
  // recordProgress pins this further: while the milestone id is unchanged, the
  // first moment it was observed is the one that is kept.
  // `pinnedReachedAtMs` is recordProgress handing back the first moment IT
  // observed this milestone, so the churn window below is measured from there
  // and the lane tree is walked once per pass, not twice.
  const derivedMs = current ? (milestoneAt(current, ctx) || 0) : 0;
  const currentData = current?.id === "experiment_data" ? experimentData(ctx) : null;
  // MEASURED ON cycle-a-20260919, 2026-10-06: the milestone was
  // pinned to the v1 pilot at 17:36 even after the selected v2 bundle landed
  // at 20:25. The churn trigger consequently counted three v1 methods lanes
  // against v2's fresh-analysis wait just as the v2 Analyst handoff finished.
  // A selected replacement bundle and its runner-ready analysis handoff start
  // new evidence contracts inside the same milestone; only work after the
  // latest contract can diagnose whether that contract is stuck.
  const selectedDataEpochMs = currentData?.selected_simulation ? currentData.ms : 0;
  const analysisHandoffEpochMs = readyAnalysisHandoffMs(ctx, currentData);
  // MEASURED ON cycle-a-20260919, 2026-10-09: a freshly falsified
  // lead reopened owner_selection, but its clock came from the eight-day-old
  // owner-selection artifact. The supervisor immediately attributed 1,241 old
  // lanes (191 gate restarts) to the new replacement wait. The append-only
  // first release decision is the start of this new contract; lead-protection's
  // projected timestamp is only a fallback because that projection is refreshed.
  const replacementEpochMs = current?.id === "owner_selection"
    ? currentLeadFalsificationReleaseStartedMs(ctx)
    : 0;
  const currentMs = current && pinnedReachedAtMs
    ? Math.max(pinnedReachedAtMs, selectedDataEpochMs, analysisHandoffEpochMs, replacementEpochMs)
    : Math.max(derivedMs, replacementEpochMs);

  let waitingOn = [];
  if (next) {
    try {
      waitingOn = (next.waiting ? next.waiting(ctx) : []) || [];
    } catch {
      waitingOn = [];
    }
    if (!waitingOn.length) {
      waitingOn = [`${next.id}_not_published: ${next.artifact} has not been written`];
    }
  }

  const churn = lanesFinishedSince(ctx, currentMs);
  const running = runningLanes(ctx);
  const evidence = newestEvidence(ctx);
  const lead = ctx.read("lab-director-hypothesis");
  const leadMs = selectedLeadMs(ctx);
  const directorNextActions = (() => {
    const fromLead = lead.value?.lab_director_decision?.next_actions;
    if (Array.isArray(fromLead) && fromLead.length) return fromLead.slice(0, 8);
    const notes = ctx.read("lab-director-research-notes").value;
    const fromNotes = notes?.next_actions;
    return Array.isArray(fromNotes) ? fromNotes.slice(0, 8) : [];
  })();

  return {
    cycle_id: cycleId,
    generated_at: new Date(now).toISOString(),
    milestone_order: MILESTONE_IDS,
    current_milestone: current ? current.id : null,
    current_milestone_index: reachedIndex,
    reached_at: isoOf(currentMs),
    minutes_in_milestone: currentMs ? Math.round(((now - currentMs) / 60000) * 10) / 10 : null,
    next_milestone: next ? next.id : null,
    next_milestone_artifact: next ? next.artifact : null,
    waiting_on: waitingOn,
    lead: {
      selected: leadMs > 0,
      selected_at: isoOf(leadMs),
      status: lead.value?.status || null,
      validation_data_status: lead.value?.validation_data_status || null,
      generated_by: lead.value?.generated_by || null,
    },
    lead_selection_rejections: newestRejections(ctx, 6),
    director_next_actions: directorNextActions,
    lanes_since_milestone: churn,
    running_lanes: running,
    last_evidence: {
      path: evidence.path,
      kind: evidence.kind,
      counts: evidence.counts,
      fingerprint: evidence.fingerprint,
      written_at: isoOf(evidence.ms),
      minutes_ago: evidence.ms ? Math.round(((now - evidence.ms) / 60000) * 10) / 10 : null,
    },
    // When the evidence CONTENT last changed. deriveProgress can only guess it
    // from the artifacts; recordProgress pins it across passes.
    evidence_changed_at: isoOf(evidence.ms) || isoOf(leadMs),
  };
}

/**
 * Persist the model, keeping the first moment each milestone was OBSERVED.
 *
 * An artifact's own timestamp is the better answer when it has one, but some
 * stages publish without one; for those, the first pass that saw the milestone
 * is the only record there will ever be of when it happened, and re-deriving it
 * from an mtime a later republish moved would quietly reset every stall clock.
 */
function recordProgress({ cwd, cycleId, now = Date.now() }) {
  const filePath = progressPath({ cwd, cycleId });
  const previous = readJsonOrNull(filePath);
  // While the milestone has not changed, the first moment it was observed is
  // the moment. An artifact republished with a newer timestamp does not mean
  // the cycle moved, and letting it say so is how a stall stays invisible.
  const progress = deriveProgress({
    cwd,
    cycleId,
    now,
    pinnedReachedAtMs: parseMs(previous?.reached_at),
  });

  const history = Array.isArray(previous?.history) ? previous.history : [];
  const advanced = previous?.current_milestone !== progress.current_milestone;
  if (advanced) {
    // A different milestone: the pin belonged to the previous one. Re-derive.
    Object.assign(progress, deriveProgress({ cwd, cycleId, now }));
  }
  if (!progress.reached_at && progress.current_milestone) {
    progress.reached_at = new Date(now).toISOString();
    progress.minutes_in_milestone = 0;
  }
  // Same rule for evidence: an unchanged fingerprint means nothing new was
  // measured, however many times the projection was republished.
  if (previous?.last_evidence?.fingerprint === progress.last_evidence.fingerprint && previous?.evidence_changed_at) {
    progress.evidence_changed_at = previous.evidence_changed_at;
  } else if (previous && previous.last_evidence?.fingerprint !== progress.last_evidence.fingerprint) {
    progress.evidence_changed_at = new Date(now).toISOString();
  }
  if (advanced && progress.current_milestone) {
    history.push({ milestone: progress.current_milestone, reached_at: progress.reached_at, observed_at: new Date(now).toISOString() });
  }
  progress.history = history.slice(-Math.max(MILESTONES.length * 2, 32));
  progress.previous_milestone = previous?.current_milestone ?? null;
  progress.advanced = advanced;
  try {
    writeJson(filePath, progress);
  } catch {
    // Observing must never be the thing that stops a cycle.
  }
  return { path: filePath, progress };
}

// ---------------------------------------------------------------------------
// thresholds

function supervisorConfig(env = process.env) {
  const positive = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    stallMinutes: positive(env.RESEARCHLAB_SUPERVISOR_STALL_MINUTES, DEFAULT_STALL_MINUTES),
    laneChurn: positive(env.RESEARCHLAB_SUPERVISOR_LANE_CHURN, DEFAULT_LANE_CHURN),
    noEvidenceMinutes: positive(env.RESEARCHLAB_SUPERVISOR_NO_EVIDENCE_MINUTES, DEFAULT_NO_EVIDENCE_MINUTES),
  };
}

/**
 * The stall triggers, as plain findings. maintainer.js turns these into runs.
 *
 * Each says what the cycle is doing INSTEAD of moving, because that is the
 * diagnosis: a stall is a contract defect (a state field read wrongly, a gate
 * nothing can satisfy, a wait condition nobody can clear), and the churn table
 * names the lanes that kept being dispatched against it.
 */
function stallFindings({ progress, config, now = Date.now() }) {
  const findings = [];
  const milestone = progress.current_milestone;
  if (!milestone) return findings;
  if (WAITING_ON_OWNER.has(progress.next_milestone)) return findings;
  // A lane that can move the NEXT milestone is running: the cycle is working.
  const advancing = new Set(ADVANCING_ACTIONS[progress.next_milestone] || []);
  const working = (progress.running_lanes || []).some((lane) => advancing.has(lane.action_type));
  if (working) return findings;

  const reachedMs = parseMs(progress.reached_at);
  const minutes = reachedMs ? (now - reachedMs) / 60000 : 0;
  const churn = progress.lanes_since_milestone || { total: 0, by_action_type: {} };

  if (reachedMs && minutes >= config.stallMinutes && churn.total > 0) {
    findings.push({
      kind: "no_milestone_progress",
      signature: `no_milestone_progress:${milestone}`,
      detail: `the cycle has been at milestone ${milestone} for ${Math.round(minutes)} minutes (threshold ${config.stallMinutes}) while ${churn.total} lane(s) finished; it is waiting on: ${(progress.waiting_on || []).join(" | ") || "(nothing recorded)"}`,
      lane_ids: (churn.newest || []).map((lane) => lane.lane_id).slice(0, 6),
      milestone,
      minutes_in_milestone: Math.round(minutes),
    });
  }

  for (const [actionType, group] of Object.entries(churn.by_action_type || {})) {
    if (group.total < config.laneChurn) continue;
    findings.push({
      kind: "lane_churn",
      signature: `lane_churn:${milestone}:${actionType}`,
      detail: `${group.total} ${actionType} lane(s) finished since the cycle reached ${milestone} and the milestone did not change (threshold ${config.laneChurn})`,
      lane_ids: (group.lane_ids || []).slice(-6),
      milestone,
      action_type: actionType,
    });
  }

  if (progress.lead?.selected) {
    const leadMs = parseMs(progress.lead.selected_at);
    const evidenceMs = Math.min(
      parseMs(progress.evidence_changed_at) || now,
      parseMs(progress.last_evidence?.written_at) || now,
    );
    const sinceMs = Math.min(Math.max(leadMs, evidenceMs), now);
    const quietMinutes = sinceMs ? (now - sinceMs) / 60000 : 0;
    if (sinceMs && quietMinutes >= config.noEvidenceMinutes) {
      findings.push({
        kind: "no_evidence",
        signature: `no_evidence:${milestone}`,
        detail: `no new measurement or evidence artifact for ${Math.round(quietMinutes)} minutes (threshold ${config.noEvidenceMinutes}) although a lead was selected at ${progress.lead.selected_at}; newest evidence: ${progress.last_evidence?.path || "(none)"}`,
        lane_ids: (churn.newest || []).map((lane) => lane.lane_id).slice(0, 6),
        milestone,
        quiet_minutes: Math.round(quietMinutes),
      });
    }
  }

  return findings;
}

module.exports = {
  MILESTONES,
  MILESTONE_IDS,
  WAITING_ON_OWNER,
  EVIDENCE_STATE_KINDS,
  DEFAULT_STALL_MINUTES,
  DEFAULT_LANE_CHURN,
  DEFAULT_NO_EVIDENCE_MINUTES,
  deriveProgress,
  recordProgress,
  progressPath,
  stallFindings,
  supervisorConfig,
  __private: { openCycleState, lanesFinishedSince, newestEvidence, pendingTopK, laneActionType },
};
