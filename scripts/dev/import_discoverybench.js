#!/usr/bin/env node
"use strict";

// Import real DiscoveryBench (train split, which carries gold true_hypothesis)
// into eval tasks. External data kept out of git (evals/discoverybench/_real/.gitignore).
//
//   node scripts/dev/import_discoverybench.js --src <discoverybench/real/train> \
//        --out evals/discoverybench/_real [--per-domain N]
//
// Each metadata_*.json -> one task per query that has a true_hypothesis:
// { task_id, domain, query, dataset_dir, datasets:[csv], gold:{hypothesis} }.

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const a = { out: "evals/discoverybench/_real", per: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--src") a.src = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--per-domain") a.per = Number(argv[++i]);
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.src) {
    console.error("usage: import_discoverybench.js --src <real/train> [--out DIR] [--per-domain N]");
    process.exit(2);
  }
  const taskDir = path.join(a.out, "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  let n = 0;
  for (const domain of fs.readdirSync(a.src)) {
    const dDir = path.join(a.src, domain);
    if (!fs.statSync(dDir).isDirectory()) continue;
    let perDomain = 0;
    for (const f of fs.readdirSync(dDir).filter((x) => /^metadata_\d+\.json$/.test(x)).sort()) {
      if (perDomain >= a.per) break;
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dDir, f), "utf8"));
      } catch {
        continue;
      }
      const datasets = (meta.datasets || []).map((d) => d.name).filter(Boolean);
      // meta.queries is an array of query-groups (array of arrays) -> flatten.
      const queries = (meta.queries || []).flat();
      for (const q of queries) {
        if (!q.true_hypothesis || perDomain >= a.per) continue;
        const id = `db-${domain}-${meta.id}-${q.qid}`;
        fs.writeFileSync(
          path.join(taskDir, `${id}.json`),
          JSON.stringify(
            {
              task_id: id,
              domain,
              query: q.question,
              question_type: q.question_type || null,
              dataset_dir: dDir,
              datasets,
              gold: { hypothesis: q.true_hypothesis },
            },
            null,
            2,
          ) + "\n",
        );
        n += 1;
        perDomain += 1;
      }
    }
  }
  console.log(`imported ${n} DiscoveryBench tasks -> ${taskDir}`);
}

main();
