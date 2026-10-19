# DiscoveryBench adapter (most general benchmark)

DiscoveryBench (allenai/discoverybench, arXiv:2407.01725) is the most general,
agent‑neutral, multi‑domain benchmark for this co‑scientist: **given dataset(s)
+ a discovery goal, derive a hypothesis**, scored by *faceted Hypothesis
Matching* against a gold hypothesis. It maps 1:1 onto the harness core loop, so
it supplies external ground truth for end‑to‑end yield (the HyperAgent‑style
single headline metric in the paper plan).

## Layout
- `tasks/*.json` — `{ query, dataset_metadata, gold: { hypothesis, context, variables[], relationship } }`.
- `predictions/*.json` — the harness‑derived `{ hypothesis }` for each task (by `task_id`).
- `results/*.jsonl` — generated telemetry (git‑ignored).

## Run
```
node scripts/run_discoverybench.js          # faceted HMS over all tasks
```

## Scoring (faceted Hypothesis Matching)
`src/evals/benchmarks/discoverybench_adapter.js` decomposes the match into
DiscoveryBench facets — **variables**, **context**, **relationship** — and
reports a strict all‑facets **HMS (0/1)** plus a soft mean. The canonical
DiscoveryBench evaluator uses an LLM judge for semantic facet matching; we ship
a deterministic structural matcher (offline/testable) and expose a `judge` hook
to plug in the LLM judge.

## Two seams (documented)
- **Task → cycle**: `formatHarnessInput(task)` turns a task into a harness cycle
  input (goal prompt + dataset metadata). Running the cycle and capturing the
  promoted hypothesis is the live integration.
- **Faithful judge**: pass `judge` to `scoreHypothesis` for LLM‑based facet
  matching matching DiscoveryBench's `discovery_eval.py`.

To use the real benchmark, fetch tasks from `allenai/discoverybench` (HF) into
`tasks/` in the shape above.
