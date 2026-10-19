#!/usr/bin/env node
"use strict";

// Capture a completed analyst lane's handoff into the offline eval set.
//
//   node scripts/capture_analyst_handoff.js --lane <cycleId/laneId | result.json path>
//        --case <case_id> [--root .research-lab] [--handoffs evals/analyst/handoffs]
//
// This is the working runtime->eval seam: the analyst agent already ran in a
// real cycle, and we capture what it produced so run_analyst_evals.js can score
// it. Running the analyst *live* for a fresh prompt (build the role plan with
// buildAnalystQueryPlan, dispatch via runResearch/runNative, then capture the
// resulting lane) is the documented extension on top of this same path.

const fs = require("fs");
const path = require("path");
const { extractEvalHandoff } = require("../src/evals/capture_handoff");

function parseArgs(argv) {
  const args = { root: ".research-lab", handoffs: "evals/analyst/handoffs" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--lane") args.lane = argv[++i];
    else if (argv[i] === "--case") args.case = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--handoffs") args.handoffs = argv[++i];
  }
  return args;
}

// Accept either a direct result.json path, a lane dir, or "<cycleId>/<laneId>".
function resolveResultPath(lane, root) {
  if (lane.endsWith(".json") && fs.existsSync(lane)) return lane;
  const candidates = [];
  if (fs.existsSync(lane) && fs.statSync(lane).isDirectory()) {
    candidates.push(path.join(lane, "result.json"));
  }
  const [cycleId, laneId] = lane.split("/");
  if (cycleId && laneId) {
    candidates.push(path.join(root, "lanes", cycleId, laneId, "result.json"));
    candidates.push(path.join(root, "artifacts", "stats", cycleId, laneId, "result.json"));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.lane || !args.case) {
    console.error("usage: capture_analyst_handoff.js --lane <cycleId/laneId|path> --case <case_id>");
    process.exit(2);
  }
  const resultPath = resolveResultPath(args.lane, args.root);
  if (!resultPath) {
    console.error(`could not find a result.json for lane "${args.lane}"`);
    process.exit(2);
  }
  let result;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch (err) {
    console.error(`failed to read ${resultPath}: ${err.message}`);
    process.exit(2);
  }

  const captured = extractEvalHandoff(result, { caseId: args.case, laneRef: args.lane });
  if (!captured.ok) {
    console.error(`capture failed: ${captured.reason}`);
    process.exit(1);
  }

  fs.mkdirSync(args.handoffs, { recursive: true });
  const outPath = path.join(args.handoffs, `${args.case}.json`);
  fs.writeFileSync(outPath, JSON.stringify(captured.handoff, null, 2) + "\n", "utf8");

  const rows = captured.handoff.canonical_variable_resolution;
  console.log(`captured ${rows.length} resolution row(s) from ${resultPath}`);
  console.log(`projected (pre-contract handoff): ${captured.projected}`);
  console.log(`-> ${outPath}`);
}

main();
