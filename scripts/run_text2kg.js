#!/usr/bin/env node
"use strict";

// Text2KGBench runner: score recorded Chronicle KG-extraction outputs against
// gold triples — Precision/Recall/F1, Ontology Conformance, and
// subject/relation/object hallucination — and append telemetry.
//
//   node scripts/run_text2kg.js [--examples DIR] [--predictions DIR] [--ontologies DIR] [--out FILE]
//
// examples/<id>.json holds {sent, ontology, triples}; predictions/<id>.json
// holds the extracted {triples}; ontologies/<name>.json is the pre-parsed
// ontology. Running Chronicle live (formatHarnessInput -> extract -> capture)
// is the documented seam; this scores recorded outputs so it runs in CI today.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateExample, aggregate } = require("../src/evals/benchmarks/text2kg_adapter");

function parseArgs(argv) {
  const a = {
    examples: "evals/text2kg/examples",
    predictions: "evals/text2kg/predictions",
    ontologies: "evals/text2kg/ontologies",
    out: "evals/text2kg/results/latest.jsonl",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--examples") a.examples = argv[++i];
    else if (argv[i] === "--predictions") a.predictions = argv[++i];
    else if (argv[i] === "--ontologies") a.ontologies = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
  }
  return a;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const exDir = path.resolve(args.examples);
  if (!fs.existsSync(exDir)) {
    console.error(`no examples dir at ${exDir}`);
    process.exit(2);
  }
  const ontCache = {};
  const loadOnt = (name) => {
    if (!name) return {};
    if (ontCache[name]) return ontCache[name];
    const p = path.join(path.resolve(args.ontologies), `${name}.json`);
    return (ontCache[name] = fs.existsSync(p) ? readJson(p) : {});
  };

  const sha = gitSha();
  const ts = new Date().toISOString();
  const files = fs.readdirSync(exDir).filter((f) => f.endsWith(".json")).sort();
  const results = [];
  let missing = 0;
  for (const f of files) {
    const ex = readJson(path.join(exDir, f));
    const id = ex.id || path.basename(f, ".json");
    const pPath = path.join(path.resolve(args.predictions), `${id}.json`);
    if (!fs.existsSync(pPath)) {
      console.error(`! ${id}: no prediction at ${pPath} (skipped)`);
      missing += 1;
      continue;
    }
    const pred = readJson(pPath);
    results.push(evaluateExample({ example: ex, predicted: pred.triples || pred.predicted || [], ontology: loadOnt(ex.ontology) }));
  }

  const agg = aggregate(results);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.appendFileSync(
    path.resolve(args.out),
    JSON.stringify({ ts, git_sha: sha, benchmark: "text2kgbench", ...agg }) + "\n",
    "utf8",
  );

  console.log("\nText2KGBench (ontology-driven triple extraction)");
  console.log("id".padEnd(22), "P", "  R", "  F1", " OC", " halluc(s/r/o)");
  for (const r of results) {
    const s = r.score;
    console.log(
      String(r.id).padEnd(22),
      s.precision,
      s.recall,
      s.f1,
      s.ontology_conformance,
      `${s.subject_hallucination}/${s.relation_hallucination}/${s.object_hallucination}`,
    );
  }
  console.log(
    `\nmicro P/R/F1 ${agg.micro_precision}/${agg.micro_recall}/${agg.micro_f1} | macro F1 ${agg.macro_f1} | OC ${agg.macro_ontology_conformance}`,
  );
  console.log(
    `ENTITY-F1 (relation-agnostic, SOTA-comparable): micro ${agg.micro_entity_f1} (P ${agg.micro_entity_precision}/R ${agg.micro_entity_recall}) | macro ${agg.macro_entity_f1}`,
  );
  console.log(
    `halluc (macro s/r/o): ${agg.macro_subject_hallucination}/${agg.macro_relation_hallucination}/${agg.macro_object_hallucination} over ${agg.examples} (${missing} missing) -> ${args.out}`,
  );
}

main();
