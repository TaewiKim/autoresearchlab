# InfiAgent-DABench adapter (data analysis / Analyst)

DABench / DAEval (arXiv:2401.05507) makes open-ended data-analysis questions
**closed-form and auto-gradeable**: the agent must emit each requested quantity
as a marker `@answer_name[value]`, which is regex-parsed and exact-matched to
gold (numeric rounded to the question's decimals; categorical exact). A question
is correct only if **all** its sub-answers match. It is the cheapest benchmark
to wire in (no LLM judge), so it is implemented right after DiscoveryBench.

## Layout
- `questions/*.json` — `{ question, constraints, format, file_name, level, labels:[{name,value,decimals}] }`.
- `responses/*.json` — the analysis stage's `{ response }` (free text containing markers), by id.
- `data/` — the CSVs referenced by `file_name` (add the real DAEval CSVs here).
- `results/*.jsonl` — generated telemetry (git-ignored).

## Run
```
node scripts/run_dabench.js          # ABQ / APSQ / AUSQ + by-level
```

## Metrics (faithful to the paper)
- **ABQ** — Accuracy By Questions: fraction with ALL sub-answers correct.
- **APSQ** — mean per-question fraction of correct sub-answers.
- **AUSQ** — overall fraction of correct sub-answers.
Reported overall and by difficulty (easy/medium/hard).

## Seam (live integration)
`formatHarnessInput(question)` turns a question into the analysis-stage input
(CSV + question + constraints + the closed-form answer instruction). Running the
analysis stage on it and capturing the response is the live integration; the
scorer (`src/evals/benchmarks/dabench_adapter.js`) is exact and offline. Fetch
the real DAEval set from InfiAgent into `questions/` + `data/`.
