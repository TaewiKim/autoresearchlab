# Text2KGBench adapter (KG construction / Chronicle)

Text2KGBench (ISWC 2023, arXiv:2308.02357) evaluates **ontology-driven KG
generation**: given an ontology (concepts, relations, domain/range) and a
sentence, extract triples `{sub, rel, obj}` faithful to the sentence and
conformant to the ontology. It directly scores this harness's Chronicle
text→KG construction step.

## Layout
- `ontologies/<name>.json` — pre-parsed ontology `{ concepts:[...], relations:[...] }`.
  (The real benchmark ships `.ttl`; convert to this shape — a documented seam.)
- `examples/<id>.json` — `{ id, ontology, sent, triples:[{sub,rel,obj}] }` (gold).
- `predictions/<id>.json` — the extracted `{ triples:[...] }`, by id.
- `results/*.jsonl` — generated telemetry (git-ignored).

## Run
```
node scripts/run_text2kg.js          # P/R/F1 + ontology conformance + hallucination
```

## The 7 metrics (faithful to the paper)
- **Precision / Recall / F1** — normalized triple-set match (case/underscore/space-insensitive).
- **Ontology Conformance** — fraction of triples whose relation is defined in the ontology.
- **Subject / Object Hallucination** — fraction whose subject/object does not appear in the sentence.
- **Relation Hallucination** — fraction whose relation is not in the ontology.
Reported micro (pooled) and macro (per-example mean).

## Seam (live integration)
`formatHarnessInput(example, ontology)` turns an example into the Chronicle
extraction input (sentence + allowed relations/concepts + faithfulness
instruction). Running Chronicle and capturing produced triples is the live
integration; the scorer (`src/evals/benchmarks/text2kg_adapter.js`) is exact and
offline. Fetch Wikidata-TekGen / DBpedia-WebNLG from the Text2KGBench repo into
`examples/` + `ontologies/`.
