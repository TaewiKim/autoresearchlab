"use strict";

// The owner checkpoint, from the CLI.
//
//   researchlab candidates --cycle-id <id> [--json]
//   researchlab select --cycle-id <id> --candidate <candidate-id> [--note "<why>"]
//   researchlab select --cycle-id <id> --candidate release [--note "<why>"]
//
// Before a lead is chosen, the cycle builds a slate of candidate problems,
// has an expert panel rank them, tries to refute each one's novelty against
// the literature and checks feasibility. The survivors are written to
// state/<cycle>-owner-candidates.{json,md}, and the cycle pauses until the
// owner picks one (native problem_selection/owner.rs). The pick is the file
// state/<cycle>-owner-selection.json, {candidate_id, note}: `select` writes
// it, after checking the id, and the cycle resumes on its own. Picking again
// later replaces the pick. `release` lifts the slate requirement instead.

const fs = require("fs");
const path = require("path");

const RELEASE = "release";

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function statePaths(cwd, cycleId) {
  const state = path.join(cwd, ".research-lab", "state");
  return {
    candidates: path.join(state, `${cycleId}-owner-candidates.json`),
    markdown: path.join(state, `${cycleId}-owner-candidates.md`),
    selection: path.join(state, `${cycleId}-owner-selection.json`),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function key(id) {
  return String(id || "").trim().toLowerCase();
}

function runCandidatesCommand(argv, { cwd = process.cwd(), out = process.stdout } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  if (!cycleId) throw new Error("candidates requires --cycle-id <id>");
  const paths = statePaths(cwd, cycleId);
  const candidates = readJson(paths.candidates);
  if (!candidates) {
    out.write(`No candidates yet for ${cycleId}: the expert selection has not reached the owner checkpoint (see \`researchlab status --cycle-id ${cycleId}\`).\n`);
    return null;
  }
  if (argv.includes("--json")) {
    out.write(`${JSON.stringify(candidates, null, 2)}\n`);
    return candidates;
  }
  let text = "";
  try {
    text = fs.readFileSync(paths.markdown, "utf8");
  } catch {
    text = (candidates.candidates || []).map((card) => `- ${card.candidate_id}: ${card.hypothesis || ""}`).join("\n");
  }
  out.write(`${text.trim()}\n\n`);
  const current = readJson(paths.selection);
  if (current?.candidate_id) out.write(`Current pick: ${current.candidate_id}\n`);
  out.write(`Choose with:  researchlab select --cycle-id ${cycleId} --candidate <candidate-id> --note "why"\n`);
  return candidates;
}

function runSelectCommand(argv, { cwd = process.cwd(), out = process.stdout } = {}) {
  const cycleId = readFlag(argv, "--cycle-id");
  const candidateId = readFlag(argv, "--candidate");
  if (!cycleId || !candidateId) throw new Error("usage: researchlab select --cycle-id <id> --candidate <candidate-id|release> [--note \"why\"]");
  const paths = statePaths(cwd, cycleId);
  const candidates = readJson(paths.candidates);
  if (!candidates) throw new Error(`no candidates for ${cycleId} yet (state/${cycleId}-owner-candidates.json does not exist)`);
  const ids = (candidates.candidates || []).map((card) => String(card.candidate_id || "")).filter(Boolean);
  const chosen = key(candidateId) === RELEASE ? RELEASE : ids.find((id) => key(id) === key(candidateId));
  if (!chosen) {
    throw new Error(`"${candidateId}" is not one of the candidates: ${ids.join(", ") || "(none survived)"}, or "${RELEASE}"`);
  }
  const note = readFlag(argv, "--note") || "";
  const temporary = `${paths.selection}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ candidate_id: chosen, note, selected_with: "researchlab select", written_at: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(temporary, paths.selection);
  out.write(chosen === RELEASE
    ? `Recorded "release" for ${cycleId}: the lead is no longer bound to the slate. The cycle resumes on its own.\n`
    : `Recorded ${chosen} for ${cycleId}. The cycle resumes on its own and the LabDirector sets the lead from it.\n`);
  return chosen;
}

module.exports = { runCandidatesCommand, runSelectCommand };
