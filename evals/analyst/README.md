# Analyst resolution evals

Offline evaluation of the analyst's concept-to-entity resolution — the
"Validation" layer adapted from Anthropic's self-service data-analytics design.
The hard part of analysis is mapping an ambiguous question to the single
correct data-model entity; this harness gates that against pinned ground truth.

## Layout

- `cases/*.json` — eval cases. Each pins ground truth (which canonical entity
  each modeled concept should resolve to) to a data-graph snapshot, plus
  per-domain `thresholds`.
- `handoffs/*.json` — analyst handoffs to score, keyed by `case_id`. Capture a
  real one from a completed production lane with:

  ```
  node scripts/capture_analyst_handoff.js --lane <cycleId/laneId> --case <case_id>
  ```

  Running the analyst *live* for a fresh prompt (build the role plan with
  `buildAnalystQueryPlan`, dispatch via `runResearch`/`runNative`, then capture
  the lane) is the documented extension on top of the same capture path.
  Handoffs emitted before the `concept_resolution_protocol` contract are
  projected at `raw_table` tier by the capture tool (see `_projected: true`).
- `results/*.jsonl` — generated telemetry (git-ignored), one row per case per
  run, so "did that change help?" is a query.

## Run

```
node scripts/run_analyst_evals.js            # scores all cases, gates per domain
node scripts/run_analyst_evals.js --accuracy 0.95 --rate 1.0
```

Exits non-zero if any case is below its gate (accuracy threshold +
`canonical_resolution_rate` target). Scoring lives in
`src/evals/analyst_resolution_eval.js`.

## Cases

- `example-sle-severity` — post-contract handoff with an explicit
  `canonical_variable_resolution`; PASSES.
- `real-gse318067-analyst-01` — a real handoff captured from a production lane
  that predates the contract. It is correct on entity but is **expected to be
  BLOCKED** on `canonical_resolution_rate` (resolution was projected at
  `raw_table` tier), documenting the gap the contract closes. The runner
  therefore exits non-zero until analysts emit explicit canonical resolutions.

## Two metrics

- **accuracy** — share of concepts resolved to the *correct* entity.
- **canonical_resolution_rate** — share resolved at the canonical/semantic tier
  (not a raw-table guess). Targets ~100%, matching the analyst contract's
  `analyst_quality_standard_policy.canonical_resolution_target`.
