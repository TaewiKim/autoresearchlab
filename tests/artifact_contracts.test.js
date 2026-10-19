"use strict";

// The boundary-binding linter. See src/agents/shared/artifact_contracts.js.
//
// This suite is the executable half of docs/artifact-contracts.md: it fails
// when a producer or consumer renames a bound field without updating the other
// side of the boundary (the C1 "broken-binding" failure class), across JS, Rust
// and Python source.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  FIELD,
  KINDS,
  CONTRACTS,
  contractByName,
  checkContract,
  assertContractOrThrow,
  ContractViolationError,
} = require("../src/agents/shared/artifact_contracts");

const { computeEvidenceReadiness } = require("../src/reporting/visualizer/analysis/evidence_readiness");
const { buildAnalystQueryPlan } = require("../src/agents/analyst/query_plan");

const REPO_ROOT = path.join(__dirname, "..");

function readSource(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// Whole-token match, language-agnostic: matches `foo` in `foo,`, `"foo"`,
// `.get("foo")`, `foo:` etc., but not inside `foobar`.
function containsToken(source, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(source);
}

// Reverse map: field-name string -> the FIELD.<KEY> constant that holds it, so
// a JS file that imports the registry and uses the constant satisfies the
// binding by reference (the gold standard — it cannot drift), while Rust/Python
// files still satisfy it by literal match.
const TOKEN_TO_CONST = Object.fromEntries(
  Object.entries(FIELD).map(([key, value]) => [value, `FIELD.${key}`]),
);

function bindsToken(source, token) {
  if (containsToken(source, token)) return true;
  const constRef = TOKEN_TO_CONST[token];
  return Boolean(constRef) && source.includes(constRef);
}

test("contract registry is well-formed", () => {
  const seen = new Set();
  for (const contract of CONTRACTS) {
    assert.ok(contract.name, "contract must have a name");
    assert.ok(!seen.has(contract.name), `duplicate contract name: ${contract.name}`);
    seen.add(contract.name);
    assert.ok(Array.isArray(contract.fields) && contract.fields.length > 0);
    for (const field of contract.fields) {
      assert.ok(field.name, `${contract.name} field must have a name token`);
      assert.ok(KINDS.includes(field.kind), `${contract.name}.${field.name} has invalid kind ${field.kind}`);
      assert.ok(field.producer, `${contract.name}.${field.name} must declare a producer`);
      assert.ok(
        Array.isArray(field.consumers) && field.consumers.length > 0,
        `${contract.name}.${field.name} must declare at least one consumer`,
      );
    }
  }
});

test("every field's producer and consumer source files exist", () => {
  for (const contract of CONTRACTS) {
    for (const field of contract.fields) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, field.producer)),
        `${contract.name}.${field.name}: producer missing on disk: ${field.producer}`,
      );
      for (const consumerFile of field.consumers) {
        assert.ok(
          fs.existsSync(path.join(REPO_ROOT, consumerFile)),
          `${contract.name}.${field.name}: consumer missing on disk: ${consumerFile}`,
        );
      }
    }
  }
});

// The core cross-source binding lint. This is what catches a JS<->Rust<->Python
// rename: each field token must appear literally in its producer AND in at
// least one of its declared consumers.
test("each bound field token appears literally in its producer AND a consumer", () => {
  for (const contract of CONTRACTS) {
    for (const field of contract.fields) {
      if (field.sourceLint === false) continue;
      const producerSrc = readSource(field.producer);
      assert.ok(
        bindsToken(producerSrc, field.name),
        `${contract.name}: token "${field.name}" not found in producer ${field.producer} — a rename would silently break the binding`,
      );
      const inSomeConsumer = field.consumers.some((rel) => bindsToken(readSource(rel), field.name));
      assert.ok(
        inSomeConsumer,
        `${contract.name}: token "${field.name}" not found in any consumer (${field.consumers.join(", ")}) — the read boundary drifted from the producer`,
      );
    }
  }
});

// Runtime producer check: the visualizer's evidence_readiness output must
// satisfy its own contract. This is the JS side of the boundary the Rust
// scientific-stagnation backstop depends on (running_core_lane_count).
test("computeEvidenceReadiness output satisfies the evidence_readiness contract", () => {
  const output = computeEvidenceReadiness({
    cycleState: {
      lane_statuses: [
        { lane_id: "analyst-01", role: "analyst", status: "completed" },
        { lane_id: "lab-runner-01", role: "lab-runner", status: "running" },
      ],
    },
    report: {},
    literature: {},
  });
  const result = checkContract("evidence_readiness", output);
  assert.ok(result.ok, `evidence_readiness contract violated: ${JSON.stringify(result.violations)}`);
  // The exact field the Rust run_loop reads must be a finite number.
  assert.equal(typeof output[FIELD.RUNNING_CORE_LANE_COUNT], "number");
  assert.equal(output[FIELD.RUNNING_CORE_LANE_COUNT], 1);
});

// The analyst declares its handoff field names via the plan scaffold; those
// declared names must match the contract's field constants, so the analyst,
// the eval capture seam, and the contract can never drift apart.
test("analyst plan advertises the contracted handoff field names", () => {
  const plan = buildAnalystQueryPlan({ prompt: "does X affect Y", laneId: "analyst-01" });
  assert.equal(plan.concept_resolution_protocol.handoff_field, FIELD.CANONICAL_VARIABLE_RESOLUTION);
  assert.equal(plan.pre_validation_master_table_gate.handoff_field, FIELD.ANALYSIS_MASTER_TABLE);
});

// Fail-closed semantics: a missing/NaN/wrong-typed required field is a
// structured violation, never a silent pass.
test("checkContract fails closed on missing, null, NaN, and wrong-typed fields", () => {
  // missing running_core_lane_count
  const missing = checkContract("evidence_readiness", {
    ready: true,
    completed_core_lane_count: 0,
    completed_evidence_lane_count: 0,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.violations.some((v) => v.path === "running_core_lane_count" && v.reason === "missing"));

  // NaN is not a finite number (this is the gate_review score-NaN bug shape)
  const nan = checkContract("gate_review", { score: NaN, mode: "reject" });
  assert.equal(nan.ok, false);
  assert.ok(nan.violations.some((v) => v.path === "score"));

  // null field
  const nullField = checkContract("evidence_readiness", {
    ready: null,
    running_core_lane_count: 0,
    completed_core_lane_count: 0,
    completed_evidence_lane_count: 0,
  });
  assert.equal(nullField.ok, false);

  // wrong type
  const wrong = checkContract("gate_review", { score: 90, mode: 5 });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.violations.some((v) => v.path === "mode" && v.reason.startsWith("wrong_type")));

  // unknown contract also fails closed
  const unknown = checkContract("does_not_exist", {});
  assert.equal(unknown.ok, false);
});

test("assertContractOrThrow throws ContractViolationError with structured violations", () => {
  assert.throws(
    () => assertContractOrThrow("gate_review", { score: NaN }),
    (err) => {
      assert.ok(err instanceof ContractViolationError);
      assert.equal(err.contract, "gate_review");
      assert.ok(Array.isArray(err.violations) && err.violations.length > 0);
      return true;
    },
  );
  // a valid object passes through unchanged
  const valid = { score: 91.5, mode: "reject" };
  assert.equal(assertContractOrThrow("gate_review", valid), valid);
});

test("contractByName returns null for unknown, the contract for known", () => {
  assert.equal(contractByName("nope"), null);
  assert.equal(contractByName("evidence_readiness").name, "evidence_readiness");
});
