# Instrument probes

The first `lab-runner` lane measures an explicitly selected tool before a research
hypothesis is available. A probe verifies capabilities; it is not hypothesis
validation and must not be scored as a successful research experiment.

The common entry point is `drivers/analysis/instrument_probe.py`. Its default is
a standard-library Python arithmetic and serialization check. It does not import,
install or require a renderer.

## Selecting a tool

The role plan declares `probe_config`:

```json
{
  "backend": "superdex",
  "source_root": "C:/workspace/superdex",
  "policy_path": "C:/workspace/superdex/results/rl_grasp_hw/ppo_xarm_grasp_hw.zip"
}
```

Supported backends:

| Backend | What is measured | Required configuration |
| --- | --- | --- |
| `python` | Standard-library statistics and JSON round trip | None |
| `mitsuba` | Rendering capabilities of the explicitly selected renderer | Installed renderer and a working backend |
| `mujoco` | One short rigid-body drop: stepping, contact count and contact force, and step throughput | MuJoCo in this interpreter, or `RESEARCHLAB_MUJOCO_PYTHON` / `probe_config.mujoco_python` naming one that has it |
| `isaacsim` | One headless Kit session: PhysX stepping, gravity response, physics timestep, throughput and whether CUDA is visible | `RESEARCHLAB_ISAACSIM_PYTHON` / `probe_config.isaacsim_python` naming an Isaac Sim interpreter; the session runs headless with a hard timeout |
| `superdex` | A bounded learned-policy simulation, observation/action shapes and measured gripper-force query coverage | Absolute `source_root` and explicit trained PPO `policy_path`; installed SuperDex/SB3 environment |

`buildInstrumentProbePlan({ probeConfig, ... })` accepts this object directly;
`backends` may list several. `source_root` and `policy_path` are passed to every
backend that runs.
Without that argument, the planner reads:

- `RESEARCHLAB_INSTRUMENT_PROBE_BACKEND` (unset: the driver runs every backend it implements)
- `RESEARCHLAB_DATA_ROOT` for `source_root`
- `RESEARCHLAB_INSTRUMENT_PROBE_POLICY` for `policy_path`

`RESEARCHLAB_PYTHON` selects the interpreter that executes the external driver.
The driver passes `role_plan.probe_config` to the probe; it does not infer a
tool from keywords in the objective or from a prior cycle's tool choice. An
unknown backend is an error, and failure does not trigger another backend.

Before importing a selected backend's tools, the probe uses the normal runner's
package installer for that backend's declared PyPI dependencies. Already available
packages are reused; missing packages are installed with the same Python interpreter
that will run the probe. If that environment omits pip, the runner first bootstraps
it with that interpreter's standard-library `ensurepip`. Installation status and
logs are retained in `pip_installs` in both the inventory and lane result. A failed
bootstrap or package installation leaves the probe failed.
The default Python probe needs no additional packages. The SuperDex native SDK is
supplied by the chosen local environment; its name is not guessed as a PyPI package.
Import names in exceptions are not blindly treated as distribution names, and a
missing `import` statement for a standard-library module requires a code correction.

## Evidence and failures

The inventory records the selected configuration, measured capabilities,
unavailable capabilities, errors and raw measurements. A failed probe remains
failed even if some partial capabilities were measured. Previous inventory files
must not make a failed attempt look successful.

SuperDex probing uses simulation only. It does not load hardware adapters or
operate a physical robot. Force measurements are sampled at policy-step
endpoints; their maxima are not continuous-time peaks or hardware safety bounds.
The selected source and policy are recorded so a measurement can be traced to
the supplied working copy.

## Supervisor pass limits

`run-research --max-supervisor-passes 0` removes the total supervisor-pass cap.
Simply omitting the flag uses the CLI's default of 12. `--max-passes` controls
each native scheduler batch, not the total number of supervisor passes. Removing
the pass cap does not disable research gates, stop requests or process timeouts.
