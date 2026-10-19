"use strict";

// Executable boundary-binding contracts.
//
// docs/artifact-contracts.md describes, in prose, which fields flow between the
// pipeline's producers and consumers. Prose does not fail CI. This module turns
// the load-bearing bindings into DATA so a rename on either side of a boundary
// becomes a loud test failure instead of a silent `undefined` at a read
// boundary (the "C1 broken-binding" failure class).
//
// Two enforcement layers, both additive — nothing here changes runtime control
// flow on its own:
//
//   1. checkContract(name, obj) — a fail-closed shape check a consumer MAY call
//      at its read boundary. A missing/wrong-typed required field is reported as
//      a structured violation, never as a silent default. Consumers adopt it
//      incrementally; the science pipeline's existing behavior is untouched
//      until a consumer opts in.
//
//   2. The cross-source binding linter (tests/artifact_contracts.test.js) reads
//      each contract's `producerFile` and `consumerFiles` and asserts every
//      declared field token appears as a literal in BOTH sides. This is the
//      part that catches JS<->Rust<->Python drift: if someone renames
//      `running_core_lane_count` in the JS producer but not in the Rust reader
//      (or vice-versa), the token vanishes from one side and the linter fails.
//
// The field tokens are exported as named constants so JS producers/consumers can
// import them instead of hardcoding the string in two places.

// ---------------------------------------------------------------------------
// Field-name constants — the single source of truth for each bound field name.
// Import these instead of writing the string literal at a read/write boundary.
// ---------------------------------------------------------------------------
const FIELD = Object.freeze({
  // analyst handoff (result.analyst_handoff)
  CANONICAL_VARIABLE_RESOLUTION: "canonical_variable_resolution",
  ANALYSIS_MASTER_TABLE: "analysis_master_table",
  DATASET_ROOT: "dataset_root",
  HANDOFF_CHECKS: "handoff_checks",
  // lane result.json -> chronicle
  VALIDATION_SUMMARY: "validation_summary",
  OVERALL_STATUS: "overall_status",
  SELECTED_HYPOTHESES: "selected_hypotheses",
  HYPOTHESIS_ID: "hypothesis_id",
  // researcher-view evidence_readiness (JS producer -> Rust reader)
  EVIDENCE_READINESS: "evidence_readiness",
  READY: "ready",
  RUNNING_CORE_LANE_COUNT: "running_core_lane_count",
  COMPLETED_CORE_LANE_COUNT: "completed_core_lane_count",
  COMPLETED_EVIDENCE_LANE_COUNT: "completed_evidence_lane_count",
  // gate-review.json (JS producer -> Rust reader)
  SCORE: "score",
  MODE: "mode",
});

// kind vocabulary for the runtime shape check.
const KINDS = Object.freeze([
  "string",
  "nonEmptyString",
  "number",
  "finiteNumber",
  "boolean",
  "array",
  "object",
  "any",
]);

// ---------------------------------------------------------------------------
// The contract registry. Each entry is one artifact whose fields cross one or
// more read boundaries. Bindings are declared PER FIELD, because different
// fields of the same artifact are frequently read by different consumers in
// different languages.
//
//   fields[].name       : the literal token that must appear on both sides.
//   fields[].producer   : repo-relative file that writes the field.
//   fields[].consumers  : repo-relative files that read it (>=1).
//   fields[].path       : dotted / `[]` accessor for the runtime checkContract,
//                         relative to the object passed to checkContract.
//                         Omit when no in-process object carries the field
//                         (LLM/driver-produced artifacts) — then the binding is
//                         enforced by the cross-source linter only.
//   fields[].kind       : expected type for the runtime check.
//   fields[].sourceLint : set false to skip the cross-source token check
//                         (for a field whose name is verified another way).
// ---------------------------------------------------------------------------
const RUST_RUN_LOOP = "native/researchlab-harness/src/labdirector/plan/run_loop.rs";

const CONTRACTS = Object.freeze([
  {
    name: "evidence_readiness",
    description:
      "researcher-view evidence_readiness block. The JS visualizer computes it; the Rust run_loop reads running_core_lane_count to gate the scientific-stagnation backstop; JS policy reads ready/completed_* to gate stage advance.",
    fields: [
      // The field the Rust scientific-stagnation backstop depends on — the
      // strongest JS<->Rust binding in the pipeline.
      {
        name: FIELD.RUNNING_CORE_LANE_COUNT,
        path: "running_core_lane_count",
        kind: "finiteNumber",
        producer: "src/reporting/visualizer/analysis/evidence_readiness.js",
        consumers: [RUST_RUN_LOOP],
      },
      {
        name: FIELD.READY,
        path: "ready",
        kind: "boolean",
        producer: "src/reporting/visualizer/analysis/evidence_readiness.js",
        consumers: ["src/policy/stage_policy.js", "src/reporting/approval_review.js"],
      },
      {
        name: FIELD.COMPLETED_CORE_LANE_COUNT,
        path: "completed_core_lane_count",
        kind: "finiteNumber",
        producer: "src/reporting/visualizer/analysis/evidence_readiness.js",
        consumers: ["src/policy/stage_policy.js"],
      },
      {
        name: FIELD.COMPLETED_EVIDENCE_LANE_COUNT,
        path: "completed_evidence_lane_count",
        kind: "finiteNumber",
        producer: "src/reporting/visualizer/analysis/evidence_readiness.js",
        consumers: ["src/policy/stage_policy.js"],
      },
      // The container key the block is nested under in the researcher-view; the
      // Rust side reads view.evidence_readiness.<field>. No in-process object
      // carries it, so it is source-linted only.
      {
        name: FIELD.EVIDENCE_READINESS,
        kind: "any",
        producer: "src/reporting/visualizer/researcher_view.js",
        consumers: [RUST_RUN_LOOP],
      },
    ],
  },
  {
    name: "gate_review",
    description:
      "gate-review.json. The gate builder stitches top-level score/mode; the Rust run_loop reads gate_review.score/mode into the scientific signature and pivot logic.",
    // score/mode are common English words; the linter matches them as whole
    // tokens, so this guards removal/rename but not every incidental use. The
    // distinctive-name contracts carry the strong guarantees.
    fields: [
      {
        name: FIELD.SCORE,
        path: "score",
        kind: "finiteNumber",
        producer: "src/reporting/reviews/gate/build.js",
        consumers: [RUST_RUN_LOOP],
      },
      {
        name: FIELD.MODE,
        path: "mode",
        kind: "string",
        producer: "src/reporting/reviews/gate/build.js",
        consumers: [RUST_RUN_LOOP],
      },
    ],
  },
  {
    name: "analyst_handoff",
    description:
      "result.analyst_handoff. The analyst declares canonical_variable_resolution (scored by the eval seam) and analysis_master_table (written by the literature driver, read by the analysis driver).",
    fields: [
      {
        name: FIELD.CANONICAL_VARIABLE_RESOLUTION,
        path: "canonical_variable_resolution",
        kind: "array",
        producer: "src/agents/analyst/query_plan.js",
        consumers: ["src/evals/capture_handoff.js"],
      },
      {
        name: FIELD.ANALYSIS_MASTER_TABLE,
        kind: "any",
        producer: "drivers/literature/search_lib/handoff_builder.py",
        consumers: ["drivers/analysis/python_stats_lib/validation_status.py"],
      },
    ],
  },
  {
    name: "lane_result_validation_summary",
    description:
      "lane result.json validation_summary. The Python analysis driver emits it; chronicle's ledger collector reads overall_status and the score fields to build evidence.",
    fields: [
      {
        name: FIELD.VALIDATION_SUMMARY,
        path: "validation_summary",
        kind: "object",
        producer: "drivers/analysis/python_stats_lib/validation_status.py",
        consumers: ["src/agents/chronicle/hypothesis_ledger/collectors.js"],
      },
      {
        name: FIELD.OVERALL_STATUS,
        kind: "any",
        producer: "drivers/analysis/python_stats_lib/validation_status.py",
        consumers: ["src/agents/chronicle/hypothesis_ledger/collectors.js"],
      },
    ],
  },
]);

function contractByName(name) {
  return CONTRACTS.find((c) => c.name === name) || null;
}

// Resolve a dotted / `[]` accessor path against an object.
// Returns { found: bool, value } — found=false means a segment was missing.
function resolvePath(obj, path) {
  if (!path) return { found: false, value: undefined };
  const segments = String(path).split(".");
  let current = obj;
  for (const rawSeg of segments) {
    const isArrayEach = rawSeg.endsWith("[]");
    const key = isArrayEach ? rawSeg.slice(0, -2) : rawSeg;
    if (current === null || typeof current !== "object" || !(key in current)) {
      return { found: false, value: undefined };
    }
    current = current[key];
    if (isArrayEach) {
      if (!Array.isArray(current)) return { found: false, value: current };
      // For array-each paths the caller only asks about the array itself here;
      // per-element checks are out of scope for the runtime shape check.
    }
  }
  return { found: true, value: current };
}

function kindMatches(kind, value) {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "nonEmptyString":
      return typeof value === "string" && value.trim().length > 0;
    case "number":
      return typeof value === "number";
    case "finiteNumber":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "any":
      return value !== undefined && value !== null;
    default:
      return false;
  }
}

// Fail-closed shape check. Returns { ok, contract, violations: [...] }.
// A required field that is missing, null, or the wrong type is a violation —
// never a silent default. Fields without a `path` are skipped at runtime (they
// are enforced by the cross-source binding linter instead).
function checkContract(name, obj) {
  const contract = contractByName(name);
  if (!contract) {
    return {
      ok: false,
      contract: null,
      violations: [{ path: null, reason: `unknown_contract:${name}` }],
    };
  }
  const violations = [];
  if (obj === null || typeof obj !== "object") {
    return {
      ok: false,
      contract: name,
      violations: [{ path: null, reason: "target_not_object" }],
    };
  }
  for (const field of contract.fields) {
    if (!field.path) continue;
    const { found, value } = resolvePath(obj, field.path);
    if (!found) {
      violations.push({ path: field.path, kind: field.kind, reason: "missing" });
      continue;
    }
    if (!kindMatches(field.kind, value)) {
      violations.push({
        path: field.path,
        kind: field.kind,
        reason: `wrong_type:${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
      });
    }
  }
  return { ok: violations.length === 0, contract: name, violations };
}

class ContractViolationError extends Error {
  constructor(name, violations) {
    const detail = violations
      .map((v) => `${v.path || "<root>"}:${v.reason}`)
      .join(", ");
    super(`artifact contract "${name}" violated: ${detail}`);
    this.name = "ContractViolationError";
    this.contract = name;
    this.violations = violations;
  }
}

// Fail-closed variant for boundaries that want a hard stop instead of a
// structured result. Returns obj on success so it can wrap a read.
function assertContractOrThrow(name, obj) {
  const result = checkContract(name, obj);
  if (!result.ok) throw new ContractViolationError(name, result.violations);
  return obj;
}

module.exports = {
  FIELD,
  KINDS,
  CONTRACTS,
  contractByName,
  resolvePath,
  kindMatches,
  checkContract,
  assertContractOrThrow,
  ContractViolationError,
};
