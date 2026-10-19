#!/usr/bin/env node
"use strict";

// Import the real InfiAgent-DABench DAEval (da-dev) into this repo's DABench
// adapter format. The benchmark data is external (kept out of git via
// evals/dabench/_real/.gitignore); only the converter is committed.
//
//   node scripts/dev/import_dabench.js --src <da-dev dir> --out evals/dabench/_real [--gold-responses]
//
// --src must contain da-dev-questions.jsonl, da-dev-labels.jsonl, da-dev-tables/.
// --gold-responses also writes responses/ where each prediction == the gold
// answer markers, for a self-consistency check that the adapter scores the real
// format correctly (expected ABQ = 1.0).

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { out: "evals/dabench/_real", gold: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--src") a.src = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--gold-responses") a.gold = true;
  }
  return a;
}
function readJsonl(f) {
  return fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}
function decimalsFor(text) {
  const t = String(text || "").toLowerCase();
  if (/four decimal/.test(t)) return 4;
  if (/three decimal/.test(t)) return 3;
  if (/(one|1) decimal/.test(t)) return 1;
  return 2;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.src) {
    console.error("usage: import_dabench.js --src <da-dev dir> [--out DIR] [--gold-responses]");
    process.exit(2);
  }
  const questions = readJsonl(path.join(args.src, "da-dev-questions.jsonl"));
  const labels = readJsonl(path.join(args.src, "da-dev-labels.jsonl"));
  const labelById = new Map(labels.map((l) => [l.id, l.common_answers || []]));

  const qDir = path.join(args.out, "questions");
  const rDir = path.join(args.out, "responses");
  fs.mkdirSync(qDir, { recursive: true });
  if (args.gold) fs.mkdirSync(rDir, { recursive: true });

  let written = 0;
  for (const q of questions) {
    const common = labelById.get(q.id) || [];
    const dflt = decimalsFor(`${q.constraints} ${q.format}`);
    const labelsOut = common.map(([name, value]) => ({ name, value, decimals: dflt }));
    const id = `dab-${q.id}`;
    fs.writeFileSync(
      path.join(qDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          file_name: q.file_name,
          question: q.question,
          constraints: q.constraints,
          format: q.format,
          level: q.level,
          concepts: q.concepts,
          labels: labelsOut,
        },
        null,
        2,
      ) + "\n",
    );
    if (args.gold) {
      const markers = labelsOut.map((l) => `@${l.name}[${l.value}]`).join(", ");
      fs.writeFileSync(path.join(rDir, `${id}.json`), JSON.stringify({ id, response: `Gold: ${markers}` }, null, 2) + "\n");
    }
    written += 1;
  }
  console.log(`imported ${written} questions -> ${qDir}${args.gold ? ` (+ gold responses -> ${rDir})` : ""}`);
}

main();
