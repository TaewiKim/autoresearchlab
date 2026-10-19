#!/usr/bin/env node
"use strict";

// Import the real Text2KGBench (Wikidata-TekGen) into this repo's adapter
// format. External benchmark data is kept out of git (evals/text2kg/_real/.gitignore);
// only the converter is committed.
//
//   node scripts/dev/import_text2kg.js --src <wikidata_tekgen dir> --out evals/text2kg/_real \
//        [--per-ontology N] [--gold-predictions]
//
// --src must contain ontologies/, ground_truth/ (jsonl with {id, sent, triples}).
// --gold-predictions writes predictions/ where each prediction == the gold
// triples, for a self-consistency check that the adapter scores the real format
// correctly (expected P/R/F1 = 1.0, OC = 1.0, hallucination ~ 0).

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { out: "evals/text2kg/_real", per: 25, gold: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--src") a.src = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--per-ontology") a.per = Number(argv[++i]);
    else if (argv[i] === "--gold-predictions") a.gold = true;
  }
  return a;
}
const readJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
const label = (x) => (typeof x === "string" ? x : x && (x.label || x.name || x.rel || x.pid || x.qid)) || "";

function main() {
  const args = parseArgs(process.argv);
  if (!args.src) {
    console.error("usage: import_text2kg.js --src <wikidata_tekgen dir> [--out DIR] [--per-ontology N] [--gold-predictions]");
    process.exit(2);
  }
  const ontDir = path.join(args.src, "ontologies");
  const gtDir = path.join(args.src, "ground_truth");
  const outOnt = path.join(args.out, "ontologies");
  const outEx = path.join(args.out, "examples");
  const outPred = path.join(args.out, "predictions");
  [outOnt, outEx, args.gold ? outPred : null].filter(Boolean).forEach((d) => fs.mkdirSync(d, { recursive: true }));

  // ontologies: N_<domain>_ontology.json -> ont id "ont_N_<domain>"
  const ontIdByFile = {};
  for (const f of fs.readdirSync(ontDir).filter((x) => x.endsWith(".json"))) {
    const o = JSON.parse(fs.readFileSync(path.join(ontDir, f), "utf8"));
    const ontId = o.id || `ont_${f.replace(/_ontology\.json$/, "")}`;
    ontIdByFile[f] = ontId;
    fs.writeFileSync(
      path.join(outOnt, `${ontId}.json`),
      JSON.stringify({ name: o.title || ontId, relations: (o.relations || []).map(label).filter(Boolean), concepts: (o.concepts || []).map(label).filter(Boolean) }, null, 2) + "\n",
    );
  }

  let written = 0;
  for (const f of fs.readdirSync(gtDir).filter((x) => x.endsWith(".jsonl"))) {
    // ont_N_<domain>_ground_truth.jsonl -> ont id "ont_N_<domain>"
    const ontId = f.replace(/_ground_truth\.jsonl$/, "");
    const rows = readJsonl(path.join(gtDir, f)).slice(0, args.per);
    for (const r of rows) {
      const id = r.id;
      fs.writeFileSync(path.join(outEx, `${id}.json`), JSON.stringify({ id, ontology: ontId, sent: r.sent, triples: r.triples || [] }, null, 2) + "\n");
      if (args.gold) fs.writeFileSync(path.join(outPred, `${id}.json`), JSON.stringify({ id, triples: r.triples || [] }, null, 2) + "\n");
      written += 1;
    }
  }
  console.log(`imported ${written} examples across ${Object.keys(ontIdByFile).length} ontologies -> ${outEx}${args.gold ? ` (+ gold predictions)` : ""}`);
}

main();
