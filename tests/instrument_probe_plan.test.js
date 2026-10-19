"use strict";

// Who decides which backends exist, and what happens to one nobody names.
//
// The default used to be the literal "python", and the launcher set nothing, so
// cycle-g-v91 -- a computer-graphics rendering cycle -- measured the standard
// library's statistics module and never ran instrument_probes/mitsuba.py: four
// hundred lines, sitting beside it, never executed. Mitsuba 3.8.0 renders in
// that container. Every hypothesis must cite the resulting inventory, so the
// cycle held a rendering hypothesis it believed it had no renderer for.
//
// The repair after that put the decision in TWO places -- a directory scan here
// that excluded a hardcoded ["common", "provisioning"], and a hardcoded map of
// two names in the driver. Same rule, two languages, both name lists. This file
// no longer decides: a plan that names no backend sends no list, and the driver,
// which can import the modules, takes every one implementing the contract.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { buildInstrumentProbePlan, resolveProbeConfig } = require("../src/agents/lab_runner/instrument_probe_plan");

test("naming no backend defers to the driver rather than choosing one here", () => {
  // Empty, not `{backend: "python"}`: a default chosen in this file is a second
  // opinion about what exists, and the wrong one is what went unnoticed.
  assert.deepEqual(resolveProbeConfig({ env: {} }), {});
  const plan = buildInstrumentProbePlan({
    prompt: "Analyze measurements; an old Mitsuba probe failed",
    laneId: "lab-runner-01",
    cycleId: "test",
  });
  assert.deepEqual(plan.probe_config, {});
  assert.deepEqual(JSON.parse(plan.probe_invocation.argv[2]), {});
  assert.equal(plan.requires_analyst_handoff, false);
  assert.deepEqual(plan.validation_checks, []);
});

test("a word in the prompt still never selects a backend", () => {
  // The rule that survives from the old design, and for the same reason: a
  // backend picked because a description mentions it is the substring
  // classifier that has taken this harness down three times. The plan carries
  // no renderer vocabulary of its own.
  const plan = buildInstrumentProbePlan({
    prompt: "Analyze measurements; an old Mitsuba probe failed",
    laneId: "lab-runner-01",
    cycleId: "test",
  });
  const { prompt, ...instructions } = plan;
  assert.doesNotMatch(JSON.stringify(instructions), /mi\.render|spp|AOV|36s|49s/i);
});

test("an explicit tool selection reaches the structured invocation", () => {
  const plan = buildInstrumentProbePlan({
    prompt: "Measure the selected tool",
    laneId: "lab-runner-01",
    cycleId: "selection",
    probeConfig: { backend: "mitsuba" },
  });
  assert.deepEqual(plan.probe_config, { backends: ["mitsuba"] });
  assert.deepEqual(JSON.parse(plan.probe_invocation.argv[2]), { backends: ["mitsuba"] });
  assert.equal(plan.probe_invocation.argv[1], "--config-json");
  assert.equal(
    plan.validation_coding_task.required_artifact,
    ".research-lab/state/selection-instrument-inventory.json",
  );
  assert.doesNotMatch(JSON.stringify(plan), /mi\.render|spp|AOV|36s|49s/i);
});

test("explicit simulator config reaches the structured invocation without shell quoting", () => {
  const config = { backend: "superdex", source_root: path.resolve("copied folder"), policy_path: path.resolve("copied folder/policy.zip") };
  const plan = buildInstrumentProbePlan({ prompt: "Robot control", laneId: "lab-runner-01", cycleId: "robot", probeConfig: config });
  const expected = { backends: ["superdex"], source_root: config.source_root, policy_path: config.policy_path };
  assert.deepEqual(plan.probe_config, expected);
  assert.deepEqual(JSON.parse(plan.probe_invocation.argv[2]), expected);
  assert.equal(plan.probe_invocation.argv[1], "--config-json");
  assert.equal(plan.validation_coding_task.required_artifact, ".research-lab/state/robot-instrument-inventory.json");
  assert.doesNotMatch(JSON.stringify(plan), /mitsuba|mi\.render|scene|renderer|spp|AOV/i);
});

test("several backends can be named together", () => {
  assert.deepEqual(
    resolveProbeConfig({ probeConfig: { backends: ["mitsuba", "python", "mitsuba"] } }),
    { backends: ["mitsuba", "python"] },
  );
});

test("environment selection is explicit and invalid selections do not fall back", () => {
  assert.deepEqual(
    resolveProbeConfig({ env: { RESEARCHLAB_INSTRUMENT_PROBE_BACKEND: "mitsuba" } }),
    { backends: ["mitsuba"] },
  );
  assert.deepEqual(
    resolveProbeConfig({ probeConfig: { backend: "python" }, env: { RESEARCHLAB_INSTRUMENT_PROBE_BACKEND: "mitsuba" } }),
    { backends: ["python"] },
  );
  assert.throws(() => resolveProbeConfig({ env: { RESEARCHLAB_INSTRUMENT_PROBE_BACKEND: "unknown" } }), /unsupported/);
  assert.deepEqual(resolveProbeConfig({ probeConfig: { backend: " python " } }), { backends: ["python"] });
  assert.throws(() => resolveProbeConfig({ probeConfig: { backend: "" } }), /unsupported/);
  assert.throws(() => resolveProbeConfig({ probeConfig: [] }), /must be an object/);
  assert.throws(() => resolveProbeConfig({ probeConfig: { backend: "superdex" } }), /source_root and policy_path/);
  assert.throws(() => resolveProbeConfig({ probeConfig: { backend: "superdex", source_root: "relative", policy_path: "policy.zip" } }), /absolute path/);
});

test("this file keeps no list of what a backend is", () => {
  // The check that would have caught my own repair. A name list here is a
  // second registry, and the first thing a second registry does is disagree.
  const source = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "agents", "lab_runner", "instrument_probe_plan.js"),
    "utf8",
  );
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /\[\s*"common"|"provisioning"\s*\]/, "an exclusion list is back");
  assert.doesNotMatch(code, /backend:\s*"python"/, "a default backend name is back");
});
