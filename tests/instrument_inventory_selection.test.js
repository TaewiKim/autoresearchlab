"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildRolePlan } = require("../src/agents");

const ENV_KEYS = [
  "RESEARCHLAB_INSTRUMENT_PROBE_BACKEND",
  "RESEARCHLAB_DATA_ROOT",
  "RESEARCHLAB_INSTRUMENT_PROBE_POLICY",
];
const SOURCE = path.resolve(os.tmpdir(), "selected-superdex-source");
const POLICY = path.resolve(os.tmpdir(), "selected-superdex-policy.zip");
const MITSUBA_ENV = { RESEARCHLAB_INSTRUMENT_PROBE_BACKEND: "mitsuba" };
const SUPERDEX_ENV = {
  RESEARCHLAB_INSTRUMENT_PROBE_BACKEND: "superdex",
  RESEARCHLAB_DATA_ROOT: SOURCE,
  RESEARCHLAB_INSTRUMENT_PROBE_POLICY: POLICY,
};

function withInventory(inventory, env, check) {
  const originalCwd = process.cwd();
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-inventory-selection-"));
  try {
    process.chdir(directory);
    for (const key of ENV_KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    if (inventory !== null) {
      fs.mkdirSync(".research-lab/state", { recursive: true });
      fs.writeFileSync(".research-lab/state/selection-instrument-inventory.json", JSON.stringify(inventory));
    }
    check(buildRolePlan({
      prompt: "Measure the selected local tool",
      cycleId: "selection",
      lane: { lane_id: "lab-runner-01", role: "lab-runner" },
    }));
  } finally {
    process.chdir(originalCwd);
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    // This is the exact temporary directory created for this fixture.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function measured(probeConfig, overrides = {}) {
  return {
    status: "measured", exit_code: 0,
    verified_instruments: ["measured-capability"],
    probe_config: probeConfig,
    ...overrides,
  };
}

test("a complete measurement is reused; a partial one is not", () => {
  // The default selection is no longer a named tool but every backend the
  // driver implements, so "was this the selected tool" became "did this measure
  // everything". The inventory answers it: `implemented_but_not_probed` lists
  // backends that exist and were not run.
  //
  // A python-only inventory used to satisfy the default. It is exactly the
  // inventory cycle-g-v91 ran on -- one verified instrument, a renderer probe
  // beside it that had never executed -- so it must NOT satisfy it now.
  withInventory(
    measured({ backends: ["python"] }, { implemented_but_not_probed: ["mitsuba"] }),
    {},
    (plan) => {
      assert.equal(plan.lane_kind, "instrument_probe", "a partial measurement was reused");
    },
  );
  withInventory(
    measured({ backends: ["mitsuba", "python"] }, { implemented_but_not_probed: [] }),
    {},
    (plan) => {
      assert.notEqual(plan.lane_kind, "instrument_probe", "a complete measurement was re-run");
    },
  );
});

test("an inventory that cannot say what it skipped is re-measured", () => {
  // An older file has no `implemented_but_not_probed`, so it cannot claim to be
  // complete, and a claim that cannot be checked is not one.
  withInventory(measured({ backends: ["python"] }), {}, (plan) => {
    assert.equal(plan.lane_kind, "instrument_probe");
  });
});

test("an explicit renderer selection does not reuse a successful default inventory", () => {
  withInventory(measured({ backends: ["python"] }), MITSUBA_ENV, (plan) => {
    assert.equal(plan.lane_kind, "instrument_probe");
    assert.deepEqual(plan.probe_config.backends, ["mitsuba"]);
  });
});

test("a matching explicit backend is reused after normalization", () => {
  withInventory(measured({ backend: " mitsuba " }, { implemented_but_not_probed: [] }), MITSUBA_ENV, (plan) => {
    assert.notEqual(plan.lane_kind, "instrument_probe");
  });
});

test("selecting SuperDex does not reuse a successful Mitsuba inventory", () => {
  withInventory(measured({ backend: "mitsuba" }), SUPERDEX_ENV, (plan) => {
    assert.equal(plan.lane_kind, "instrument_probe");
    assert.deepEqual(plan.probe_config.backends, ["superdex"]);
  });
});

test("a matching SuperDex inventory is reused after path normalization", () => {
  withInventory(measured({
    backend: "superdex",
    source_root: `${SOURCE}${path.sep}..${path.sep}${path.basename(SOURCE)}`,
    policy_path: `${path.dirname(POLICY)}${path.sep}.${path.sep}${path.basename(POLICY)}`,
  }), SUPERDEX_ENV, (plan) => {
    assert.notEqual(plan.lane_kind, "instrument_probe");
  });
});

test("returning to the default selection requires a fresh measurement", () => {
  // A renderer-only measurement did not measure everything, so the default --
  // every backend -- is not satisfied by it, and the plan names nothing so the
  // driver decides.
  withInventory(
    measured({ backends: ["mitsuba"] }, { implemented_but_not_probed: ["python"] }),
    {},
    (plan) => {
      assert.equal(plan.lane_kind, "instrument_probe");
      assert.deepEqual(plan.probe_config, {});
    },
  );
});

test("a changed SuperDex source directory or policy requires a fresh measurement", () => {
  for (const probeConfig of [
    { backend: "superdex", source_root: `${SOURCE}-old`, policy_path: POLICY },
    { backend: "superdex", source_root: SOURCE, policy_path: `${POLICY}-old` },
  ]) {
    withInventory(measured(probeConfig), SUPERDEX_ENV,
      (plan) => assert.equal(plan.lane_kind, "instrument_probe"));
  }
});

test("legacy, failed, empty, or invalid inventories cannot suppress the probe", () => {
  for (const inventory of [
    null,
    measured(undefined),
    measured({ backend: "python" }, { status: "failed" }),
    measured({ backend: "python" }, { exit_code: 1 }),
    measured({ backend: "python" }, { exit_code: undefined }),
    measured({ backend: "python" }, { verified_instruments: [] }),
    measured({ backend: "python" }, { verified_instruments: [null, ""] }),
    measured({ backend: "unsupported" }),
  ]) {
    withInventory(inventory, {}, (plan) => assert.equal(plan.lane_kind, "instrument_probe"));
  }
});

// A cycle that changed machines must be allowed to re-measure.
//
// cycle-a-20260919 moved from Windows into a container on
// 2026-09-22 and kept an inventory measured on the old machine: mujoco 3.10.0
// under C:\...\Python311\python.exe, source_root D:\projects\.... Every
// engineer execution audit then failed its identity check against that
// declaration and the cycle froze at lead_selected for 4,851 minutes. The
// re-probe was already gated correctly on "is this a measurement of the
// current selection"; it was simply unreachable, because arming ALSO required
// the lane to be lab-runner-01 -- a lane that had already run, on the machine
// that no longer existed.
function probeArmedFor(laneId, { inventory, attempts = null }) {
  const originalCwd = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-reprobe-"));
  try {
    process.chdir(directory);
    fs.mkdirSync(".research-lab/state", { recursive: true });
    fs.writeFileSync(".research-lab/state/venue-instrument-inventory.json", JSON.stringify(inventory));
    if (attempts !== null) {
      fs.writeFileSync(
        ".research-lab/state/venue-instrument-probe-attempts.json",
        JSON.stringify({ attempts }),
      );
    }
    const plan = buildRolePlan({
      prompt: "Run the validation",
      cycleId: "venue",
      lane: { lane_id: laneId, role: "lab-runner" },
    });
    return plan.lane_kind === "instrument_probe";
  } finally {
    process.chdir(originalCwd);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a later runner lane re-probes when the inventory measured another machine", () => {
  const foreign = measured(
    { backends: ["python"], source_root: path.resolve(os.tmpdir(), "a-machine-that-is-gone") },
    { implemented_but_not_probed: [] },
  );
  assert.equal(probeArmedFor("followup-runner-42", { inventory: foreign }), true);
});

test("a failing probe cannot consume every runner lane", () => {
  const foreign = measured(
    { backends: ["python"], source_root: path.resolve(os.tmpdir(), "a-machine-that-is-gone") },
    { implemented_but_not_probed: [] },
  );
  assert.equal(probeArmedFor("followup-runner-42", { inventory: foreign, attempts: 3 }), false);
  // lab-runner-01 still arms regardless: it is the cycle's first measurement.
  assert.equal(probeArmedFor("lab-runner-01", { inventory: foreign, attempts: 3 }), true);
});

test("a lane that already ran is never re-planned as a probe", () => {
  // buildLaneQueryPlan maps over a manifest, so one planning pass sees lanes
  // that finished days ago. On 2026-09-23 that spent the whole probe budget in
  // under a minute re-planning three completed lanes, and measured nothing.
  const originalCwd = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-ranprobe-"));
  try {
    process.chdir(directory);
    fs.mkdirSync(".research-lab/state", { recursive: true });
    fs.mkdirSync(".research-lab/lanes/venue/lab-runner-01", { recursive: true });
    fs.writeFileSync(
      ".research-lab/state/venue-instrument-inventory.json",
      JSON.stringify(measured(
        { backends: ["python"], source_root: path.resolve(os.tmpdir(), "a-machine-that-is-gone") },
        { implemented_but_not_probed: [] },
      )),
    );
    fs.writeFileSync(
      ".research-lab/lanes/venue/lab-runner-01/final-status.json",
      JSON.stringify({ status: "completed" }),
    );
    const plan = buildRolePlan({
      prompt: "Run the validation",
      cycleId: "venue",
      lane: { lane_id: "lab-runner-01", role: "lab-runner" },
    });
    assert.notEqual(plan.lane_kind, "instrument_probe");
  } finally {
    process.chdir(originalCwd);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a complete measurement that recorded superdex among the backends it ran is not re-probed", () => {
  // With nothing named the driver runs every backend and records the list,
  // superdex included. Replaying that record demanded superdex's source_root and
  // policy_path, threw, and the catch called a complete measurement "needed".
  // MEASURED 2026-09-28: a fresh in-container probe of all five backends would
  // have re-armed on every new runner lane until the attempt cap.
  withInventory(
    measured(
      { backends: ["isaacsim", "mitsuba", "mujoco", "python", "superdex"] },
      { implemented_but_not_probed: [] },
    ),
    {},
    (plan) => assert.notEqual(plan.lane_kind, "instrument_probe"),
  );
});
