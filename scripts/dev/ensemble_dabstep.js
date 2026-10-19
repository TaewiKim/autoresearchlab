#!/usr/bin/env node
"use strict";

// Gold-blind majority-vote ensemble over DABStep response dirs (self-consistency
// across solver runs/configs). For each task, normalized answers vote; the most
// frequent non-empty answer wins; ties break toward the LAST listed dir (put the
// most trusted config last). Never reads gold answers.
//
//   node scripts/dev/ensemble_dabstep.js --out <dir> <responses_dir> [<responses_dir> ...]

const fs = require("fs");
const path = require("path");

function norm(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function main() {
  const argv = process.argv.slice(2);
  const dirs = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") out = argv[++i];
    else dirs.push(argv[i]);
  }
  if (!out || dirs.length < 2) {
    console.error("usage: ensemble_dabstep.js --out <dir> <responses_dir> <responses_dir> [...]");
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const taskIds = new Set();
  for (const d of dirs) {
    for (const f of fs.readdirSync(d)) {
      if (/^[^.].*\.json$/.test(f) && !f.startsWith("work_")) taskIds.add(f.replace(/\.json$/, ""));
    }
  }
  for (const id of [...taskIds].sort()) {
    const votes = [];
    dirs.forEach((d, idx) => {
      const p = path.join(d, `${id}.json`);
      if (!fs.existsSync(p)) return;
      try {
        const r = JSON.parse(fs.readFileSync(p, "utf8"));
        const a = String(r.answer ?? "").trim();
        if (a) votes.push({ answer: a, key: norm(a), priority: idx });
      } catch {}
    });
    if (!votes.length) {
      fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ task_id: id, answer: "", votes: 0 }, null, 2) + "\n");
      continue;
    }
    const tally = new Map();
    for (const v of votes) {
      const t = tally.get(v.key) || { count: 0, answer: v.answer, priority: -1 };
      t.count += 1;
      if (v.priority > t.priority) {
        t.priority = v.priority;
        t.answer = v.answer;
      }
      tally.set(v.key, t);
    }
    const ranked = [...tally.values()].sort((a, b) => b.count - a.count || b.priority - a.priority);
    const winner = ranked[0];
    fs.writeFileSync(
      path.join(out, `${id}.json`),
      JSON.stringify({ task_id: id, answer: winner.answer, votes: winner.count, of: votes.length, distinct: ranked.length }, null, 2) + "\n",
    );
    console.log(`${id}: "${winner.answer.slice(0, 50)}" (${winner.count}/${votes.length} votes, ${ranked.length} distinct)`);
  }
  console.log(`wrote ensemble -> ${out}`);
}

main();
