#!/usr/bin/env node
"use strict";

// Correction-harvesting runner (meant to be invoked periodically — e.g. from
// the existing watchdog loop or a scheduled task, the same pattern as
// scripts/watch_cycle_long_run.sh; this script does one pass).
//
//   node scripts/harvest_corrections.js --cycle <cycleId> [--apply] [--open-pr]
//
// It reads the cycle gate-review + data graph, the analyst eval telemetry, and
// the current governed overlay; distils correction signals into proposed
// reference-notes patches; and writes:
//   reference/analyst/reference_notes_overlay.proposed.json
//   reference/analyst/PATCH_SUMMARY.md
// With --apply it promotes the proposed overlay to the live overlay file.
// --open-pr (with --apply) is the documented thin shell that would call `gh`.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { buildCanonicalReference } = require("../src/agents/shared/canonical_reference");
const {
  harvestCorrections,
  mergeIntoOverlay,
  renderPatchSummary,
} = require("../src/agents/shared/correction_harvester");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const args = { cycle: null, apply: false, openPr: false, root: ".research-lab" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--cycle") args.cycle = argv[++i];
    else if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--open-pr") args.openPr = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.cycle) {
    console.error("usage: harvest_corrections.js --cycle <cycleId> [--apply] [--open-pr]");
    process.exit(2);
  }
  const stateDir = path.join(args.root, "state");
  const gateReview = readJson(path.join(stateDir, `${args.cycle}-gate-review.json`), {});
  const dataGraph = readJson(path.join(stateDir, `${args.cycle}-data-graph.json`), { nodes: [], edges: [] });
  const evalTelemetry = readJsonl("evals/analyst/results/latest.jsonl");

  const overlayDir = path.join("reference", "analyst");
  const overlayPath = path.join(overlayDir, "reference_notes_overlay.json");
  const overlay = readJson(overlayPath, {});

  const canonicalReference = buildCanonicalReference({
    dataGraph,
    cycleId: args.cycle,
    referenceNotesOverlay: overlay,
  });

  const harvest = harvestCorrections({
    gateReview,
    evalTelemetry,
    canonicalReference,
  });

  fs.mkdirSync(overlayDir, { recursive: true });
  const proposedOverlay = mergeIntoOverlay(overlay, harvest.patches);
  fs.writeFileSync(
    path.join(overlayDir, "reference_notes_overlay.proposed.json"),
    JSON.stringify(proposedOverlay, null, 2) + "\n",
    "utf8",
  );
  const summary = renderPatchSummary(harvest);
  fs.writeFileSync(path.join(overlayDir, "PATCH_SUMMARY.md"), summary + "\n", "utf8");

  const patchCount = Object.keys(harvest.patches).length;
  console.log(summary);
  console.log(`\nsignals=${harvest.signals_seen} families_patched=${patchCount}`);

  if (args.apply && patchCount) {
    fs.writeFileSync(overlayPath, JSON.stringify(proposedOverlay, null, 2) + "\n", "utf8");
    console.log(`applied -> ${overlayPath}`);
    if (args.openPr) {
      // Thin shell: colocate the doc change with the data model, as the blog does.
      try {
        execSync(`git add ${overlayPath}`, { stdio: "inherit" });
        console.log("staged overlay; create the PR with: gh pr create --fill");
      } catch (err) {
        console.error("git add failed:", err.message);
      }
    }
  }
  // Non-zero when there is something to review, so a scheduler can notice.
  process.exit(patchCount ? 3 : 0);
}

main();
