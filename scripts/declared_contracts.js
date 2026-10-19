#!/usr/bin/env node
"use strict";

// A contract name that nothing branches on is a clause with no door.
//
// scripts/name_flow.js answers the weaker question -- is this name mentioned
// anywhere outside the act of writing it -- and that claim is strong when the
// answer is no. It is worth very little when the answer is yes: `allowed_outputs`
// is mentioned three times outside its write sites, and all three are a
// construction, a field assignment and a store. None of them DECIDES anything,
// and a lane deleted the director's hypothesis because nothing did.
//
// So this asks the sharper question of a much smaller set: for every name this
// repository DECLARES as a contract, does any line anywhere compare it, match
// on it, filter by it, or branch on it?
//
// The declarations are read from where they live, not copied here:
//   * the state-provenance table's artifact kinds
//   * the blocker-owner table's reasons
//   * the dispatch-authority signal list
//   * the lane contract's own fields
//
// so the vocabulary is whatever the repository declares this week, and a new
// contract is covered the day it is written.
//
//   node scripts/declared_contracts.js           what nothing branches on
//   node scripts/declared_contracts.js --json
//   node scripts/declared_contracts.js --all     every declared name, with counts
//
// Exits 1 when a declared name has no decision site, so it can sit in a check.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { sourceFiles } = require("./name_flow");

const DECLARATION_SITES = {
  state_artifact_kind: {
    where: "src/provenance/state_provenance.js",
    read: () => Object.keys(require(path.join(ROOT, "src/provenance/state_provenance.js")).STATE_PROVENANCE),
  },
  inter_role_signal: {
    where: "src/policy/dispatch_authority.js",
    read: () => require(path.join(ROOT, "src/policy/dispatch_authority.js"))
      .INTER_ROLE_SIGNALS.map((entry) => entry.signal),
  },
  blocker_reason: {
    where: "native/researchlab-harness/src/labdirector/gates/blocker_release.rs",
    read: () => {
      const text = fs.readFileSync(
        path.join(ROOT, "native/researchlab-harness/src/labdirector/gates/blocker_release.rs"),
        "utf8",
      );
      const block = text.slice(text.indexOf("BLOCKER_OWNERS"));
      const names = new Set();
      const re = /"(waiting-for-[a-z0-9-]+)"/g;
      let match;
      while ((match = re.exec(block.slice(0, block.indexOf("];")))) !== null) names.add(match[1]);
      return [...names];
    },
  },
  lane_contract_field: {
    where: "native/researchlab-harness/src/core/model.rs",
    read: () => {
      const text = fs.readFileSync(path.join(ROOT, "native/researchlab-harness/src/core/model.rs"), "utf8");
      const start = text.indexOf("struct LaneContract");
      if (start < 0) return [];
      const body = text.slice(start, text.indexOf("}", start));
      const names = [];
      const re = /^\s*(?:pub(?:\([a-z()]+\))?\s+)?([a-z][a-z0-9_]{2,})\s*:/gm;
      let match;
      while ((match = re.exec(body)) !== null) names.push(match[1]);
      return names;
    },
  },
};

// --- what a decision looks like ----------------------------------------------
//
// Line-level and deliberately generous: the goal is to clear a name the moment
// anything plausibly branches on it, so that whatever survives is worth a human
// minute. A false "this decides something" costs nothing; a false "nothing
// decides this" would waste the reader's trust, and trust is the only thing
// that makes a report like this get read twice.

const DECISION_PATTERNS = [
  /\bif\b/, /\bmatch\b/, /\bwhile\b/, /\bunless\b/, /\belif\b/,
  /[!=]==?[^=]/, /[<>]=?[^=]/,
  /\.contains\(/, /\.includes\(/, /\.some\(/, /\.every\(/, /\.filter\(/,
  /\.any\(/, /\.all\(/, /\.starts_with\(/, /\.startsWith\(/, /\.ends_with\(/,
  /\.is_empty\(\)/, /\.is_some\(\)/, /\.is_none\(\)/, /\bin\s/, /\bassert/,
  /\breturn\b.*\?/, /\?\?/, /&&|\|\|/,
];

function isDecisionLine(line) {
  return DECISION_PATTERNS.some((pattern) => pattern.test(line));
}

function stripComments(text, relPath) {
  if (relPath.endsWith(".py")) {
    return text
      .replace(/"""[\s\S]*?"""/g, " ")
      .replace(/'''[\s\S]*?'''/g, " ")
      .replace(/(^|[^"'\\])#[^\n]*/g, "$1 ");
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1 ");
}

function isTest(relPath) {
  return /(^|\/)tests?\//.test(relPath) || /[._]test\.(js|py)$|\.test\.js$|_test\.py$/.test(relPath);
}

function corpus() {
  const files = [];
  for (const file of sourceFiles()) {
    const relPath = path.relative(ROOT, file).split(path.sep).join("/");
    if (isTest(relPath)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files.push([relPath, stripComments(text, relPath).split(String.fromCharCode(10))]);
  }
  return files;
}

function sitesFor(name, files) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp("\\b" + escaped + "\\b|\"" + escaped + "\"");
  const decisions = [];
  let mentions = 0;
  for (const [relPath, lines] of files) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes(name)) continue;
      if (!token.test(line)) continue;
      mentions += 1;
      if (isDecisionLine(line)) decisions.push(`${relPath}:${index + 1}`);
    }
  }
  return { mentions, decisions };
}

function build() {
  const files = corpus();
  const rows = [];
  for (const [kind, site] of Object.entries(DECLARATION_SITES)) {
    let names;
    try {
      names = site.read();
    } catch (error) {
      rows.push({ kind, declared_in: site.where, error: String(error && error.message) });
      continue;
    }
    for (const name of names) {
      const { mentions, decisions } = sitesFor(name, files);
      rows.push({
        kind,
        name,
        declared_in: site.where,
        mentions,
        decision_sites: decisions.slice(0, 6),
        decisions: decisions.length,
      });
    }
  }
  return rows;
}

// Each vocabulary sets its own bar.
//
// A binary "nothing branches on this" cries wolf. Artifact kinds are FILENAMES
// -- nothing is supposed to branch on one, it opens the file -- and blocker
// reasons are matched generically (`reason.starts_with("waiting-for-")`), so
// seventeen of twenty show zero and all seventeen are correct as written. Both
// would drown the one finding worth having.
//
// So the comparison is within a kind, against its own siblings. A vocabulary
// whose busiest member is branched on hard is a vocabulary meant to be branched
// on, and a member of it sitting near zero is the outlier. Measured on this
// repository, lane-contract fields run role 543, cycle_id 379, lane_id 289,
// mode 125, runtime_class 42, cwd 33, task_file 15 -- and then allowed_outputs
// 3, output_artifact 2, fallback_strategy 1, allowed_inputs 1. That cliff is the
// report; `allowed_outputs` sitting at the bottom of it is the lane scope no
// code enforced while a lane deleted the director's hypothesis.
const KIND_IS_PREDICATE_THRESHOLD = 5;
const OUTLIER_SHARE_OF_BUSIEST = 0.05;

function flagOutliers(rows) {
  const byKind = new Map();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, []);
    byKind.get(row.kind).push(row);
  }
  const flagged = [];
  const dataOnlyKinds = [];
  for (const [kind, members] of byKind) {
    const counts = members.map((row) => row.decisions).sort((a, b) => a - b);
    const busiest = counts[counts.length - 1];
    // The MEDIAN, not the maximum. One artifact kind out of a hundred and nine
    // happens to share a token with heavily-branched code and scores 114; on
    // the maximum that single outlier promoted the whole filename vocabulary to
    // "meant to be branched on" and dragged a hundred innocent names into the
    // report. The median says what the vocabulary is FOR.
    const typical = counts[Math.floor(counts.length / 2)];
    if (typical < KIND_IS_PREDICATE_THRESHOLD) {
      dataOnlyKinds.push({ kind, members: members.length, busiest, typical });
      continue;
    }
    const bar = Math.max(1, Math.floor(busiest * OUTLIER_SHARE_OF_BUSIEST));
    for (const row of members) {
      if (row.decisions < bar) flagged.push({ ...row, kind_busiest: busiest, bar });
    }
  }
  return { flagged, dataOnlyKinds };
}

function main() {
  const rows = build().filter((row) => !row.error);
  const { flagged, dataOnlyKinds } = flagOutliers(rows);
  const undecided = flagged;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({
      schema: "researchlab.declared_contracts.v1",
      generated_at: new Date().toISOString(),
      declared: rows.length,
      nothing_branches_on_it: undecided,
      all: process.argv.includes("--all") ? rows : undefined,
    }, null, 2));
    process.exit(undecided.length ? 1 : 0);
  }

  const byKind = new Map();
  for (const row of rows) byKind.set(row.kind, (byKind.get(row.kind) || 0) + 1);
  console.log(`declared contract names: ${rows.length}`);
  for (const [kind, count] of byKind) console.log(`  ${kind.padEnd(22)} ${count}`);
  console.log("");

  if (process.argv.includes("--all")) {
    for (const row of rows.sort((a, b) => a.decisions - b.decisions || a.name.localeCompare(b.name))) {
      console.log(`  ${String(row.decisions).padStart(4)} decisions  ${String(row.mentions).padStart(5)} mentions  ${row.kind.padEnd(22)} ${row.name}`);
    }
    console.log("");
  }

  for (const item of dataOnlyKinds) {
    console.log(`  ${item.kind}: data, not predicates — typical member is branched on ${item.typical} time(s), so none is an outlier`);
  }
  if (dataOnlyKinds.length) console.log("");

  console.log(`branched on far less than their siblings (${undecided.length}):`);
  for (const row of undecided.sort((a, b) => a.decisions - b.decisions || a.name.localeCompare(b.name))) {
    console.log(
      `  ${row.name.padEnd(24)} ${row.kind.padEnd(22)} ${String(row.decisions).padStart(3)} decisions`
      + `  (${row.mentions} mentions; the busiest ${row.kind} has ${row.kind_busiest})`,
    );
  }
  process.exit(undecided.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { build, DECLARATION_SITES, isDecisionLine };
