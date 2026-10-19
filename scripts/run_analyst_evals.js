#!/usr/bin/env node
"use strict";

// Offline eval runner for the analyst's concept-to-entity resolution.
//
//   node scripts/run_analyst_evals.js [--cases DIR] [--handoffs DIR]
//        [--out FILE] [--accuracy N] [--rate N]
//
// Loads each case under --cases, scores the matching recorded handoff under
// --handoffs (by case_id), appends a telemetry row per case to --out, prints a
// summary table, and exits non-zero if any domain is below its gate. Producing
// the handoffs live (running the analyst agent through the Rust runtime per
// case prompt) is the documented extension seam; this runner scores whatever
// handoffs are present so it works in CI today.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { evaluateCase, telemetryRecord } = require("../src/evals/analyst_resolution_eval");

function parseArgs(argv) {
  const args = { cases: "evals/analyst/cases", handoffs: "evals/analyst/handoffs", out: "evals/analyst/results/latest.jsonl" };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--cases") args.cases = value, (i += 1);
    else if (flag === "--handoffs") args.handoffs = value, (i += 1);
    else if (flag === "--out") args.out = value, (i += 1);
    else if (flag === "--accuracy") args.accuracy = Number(value), (i += 1);
    else if (flag === "--rate") args.rate = Number(value), (i += 1);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gitSha() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv);
  const caseDir = path.resolve(args.cases);
  const handoffDir = path.resolve(args.handoffs);
  if (!fs.existsSync(caseDir)) {
    console.error(`no cases directory at ${caseDir}`);
    process.exit(2);
  }
  const thresholds = {};
  if (Number.isFinite(args.accuracy)) thresholds.accuracy_threshold = args.accuracy;
  if (Number.isFinite(args.rate)) thresholds.resolution_rate_target = args.rate;

  const sha = gitSha();
  const ts = new Date().toISOString();
  const caseFiles = fs.readdirSync(caseDir).filter((f) => f.endsWith(".json")).sort();

  const telemetry = [];
  const rows = [];
  let failures = 0;

  for (const file of caseFiles) {
    const evalCase = readJson(path.join(caseDir, file));
    const handoffPath = path.join(handoffDir, `${evalCase.case_id}.json`);
    if (!fs.existsSync(handoffPath)) {
      console.error(`! ${evalCase.case_id}: no recorded handoff at ${handoffPath} (skipped)`);
      failures += 1;
      continue;
    }
    const handoff = readJson(handoffPath);
    const result = evaluateCase({
      evalCase,
      handoff,
      thresholds: Object.keys(thresholds).length ? thresholds : undefined,
    });
    if (!result.gate.passed) failures += 1;
    telemetry.push(
      telemetryRecord({
        caseId: result.case_id,
        domain: result.domain,
        snapshotId: evalCase.pinned && evalCase.pinned.snapshot_id,
        gitSha: sha,
        ts,
        score: result.score,
        gate: result.gate,
      }),
    );
    rows.push(result);
  }

  // Write telemetry (append, like the blog stores eval results as queryable history).
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.appendFileSync(
    path.resolve(args.out),
    telemetry.map((r) => JSON.stringify(r)).join("\n") + (telemetry.length ? "\n" : ""),
    "utf8",
  );

  // Summary.
  console.log("\nAnalyst resolution eval");
  console.log("case_id".padEnd(28), "domain".padEnd(18), "acc", " rate", " gate");
  for (const r of rows) {
    console.log(
      String(r.case_id).padEnd(28),
      String(r.domain || "-").padEnd(18),
      r.score.accuracy.toFixed(2),
      r.score.canonical_resolution_rate.toFixed(2),
      r.gate.passed ? "PASS" : `BLOCK (${r.gate.reasons.join("; ")})`,
    );
  }
  console.log(`\n${rows.length - failures}/${rows.length} cases passed; telemetry -> ${args.out}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
