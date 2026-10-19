# Research request: do deep tabular models still beat gradient-boosted trees once tuning budgets are matched?

## Scientific direction

Papers on deep learning for tabular data (transformer and retrieval-based
models) report gains over gradient-boosted decision trees. Benchmarks rarely
give every model family the same hyperparameter-tuning budget, the same
preprocessing, or the same number of evaluation splits.

Ask whether a reported deep-tabular advantage survives once the tuning budget,
preprocessing and split protocol are controlled explicitly.

## What to deliver

- A field landscape from the recent literature (scout), and an open problem
  chosen from it, not from the tools available.
- A falsifiable lead hypothesis with its estimands, falsification conditions
  and rival mechanisms.
- An experiment that can measure it on this machine (CPU; public benchmark
  datasets from the Hugging Face Hub, which engineer lanes can reach), with
  preregistered validity gates.
- Measured results with simultaneous intervals, and an honest verdict: support,
  falsification, or inconclusive.

## Constraints

- CPU only; keep each training run within a declared time budget.
- Use open-source code and public datasets; record every source.
- Prefer one clean, fully controlled comparison over many loosely controlled ones.
