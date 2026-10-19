# LitQA2 adapter (search / Scout)

LitQA2 (FutureHouse, part of LAB-Bench) is a multiple-choice benchmark over
recent full-text literature: questions are written so they cannot be answered
without retrieving the relevant paper. Each question includes an "insufficient
information / unsure" option, so the agent may **abstain**. It scores this
harness's Scout search stage.

## Layout
- `questions/*.json` — `{ id, question, options:[...], answer_index|answer, source_doi }`
  (include an "Insufficient information…" option to allow abstention).
- `responses/*.json` — Scout's `{ answer, retrieved_dois }`, by id.
- `results/*.jsonl` — generated telemetry (git-ignored).

## Run
```
node scripts/run_litqa2.js
```

## Metrics (LAB-Bench style)
- **accuracy** = correct / total
- **precision** = correct / answered (answered = non-abstained)
- **coverage** = answered / total
- **retrieval_recall** = source DOI retrieved / questions with a source DOI (search variant)

## Seam (live integration)
`formatHarnessInput(question)` turns a question into the Scout search input
(question + options + permission to answer "unsure" + request retrieved DOIs).
Running Scout and capturing `{answer, retrieved_dois}` is the live integration;
the scorer (`src/evals/benchmarks/litqa2_adapter.js`) is offline/exact. Fetch the
real LitQA2 set from FutureHouse / LAB-Bench into `questions/`.
