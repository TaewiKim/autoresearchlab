"use strict";

// The LabDirector's research clues, from the CLI.
//
//   researchlab clues --cycle-id <id> [--all] [--json]
//
// Clues are what the director keeps whatever happens to the lead: measured
// results, the prior art that closes a direction, what earned a high score,
// dead ends and why, facts about the data, open questions, ideas. The director
// records them in its decisions (src/reporting/research_clues.js); this reads
// them back, folding in any decision not yet applied.

const path = require("path");
const clues = require("../reporting/research_clues");

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function runCluesCommand(argv, { cwd = process.cwd(), out = process.stdout } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  if (!cycleId) throw new Error("clues requires --cycle-id <id>");
  const root = path.join(cwd, ".research-lab");
  try {
    clues.applyDirectorClueUpdates({ root, cycleId });
  } catch { /* show what is on disk */ }
  const register = clues.readRegister(root, cycleId);
  if (argv.includes("--json")) {
    out.write(`${JSON.stringify({ summary: clues.summarize(register), clues: register.clues }, null, 2)}
`);
    return register;
  }
  const summary = clues.summarize(register);
  out.write(`Research clues for ${cycleId}: ${summary.total} recorded, ${summary.live} live (${summary.high} high importance)

`);
  out.write(clues.renderClues(register, { all: argv.includes("--all") }));
  return register;
}

module.exports = { runCluesCommand };
