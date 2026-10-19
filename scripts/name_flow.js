#!/usr/bin/env node
"use strict";

// Which names cross a runtime boundary, and who is on the other side.
//
// This system is three runtimes talking through JSON on disk. A symbol graph
// answers "who calls this function" and says nothing about the other half of
// the wiring: a KEY written into an artifact by one runtime and read by
// another. Those keys are not symbols. They are strings, and a string nobody
// reads looks exactly like a string everybody reads.
//
// MEASURED, in one night on cycle-g-v91:
//   * `allowed_outputs` -- the lane contract's own scope declaration -- was
//     written by several sites, stored by another, and READ BY NOBODY. Every
//     codex lane could delete any cycle state, and one did: the director's
//     hypothesis, mid-rewrite, with no copy anywhere.
//   * Seven analyst rules reached 0 of 225 lanes because producer and consumer
//     had drifted apart (already fenced, by hand, for ten signals, in
//     src/policy/dispatch_authority.js).
//   * A cap table sat behind a role check, so six of eight roles were uncapped.
//
// Same shape every time: a name with a writer and no reader, or a reader and no
// writer. This finds them by reading the code rather than by remembering to
// look.
//
//   node scripts/name_flow.js                 the gaps
//   node scripts/name_flow.js --json          the whole map
//   node scripts/name_flow.js --name <key>    where one name is written, and read
//
// It names no field and no domain term: the vocabulary is whatever the code
// writes this week.

const fs = require("fs");
const path = require("path");

const NEWLINE = String.fromCharCode(10);
const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["src", "native/researchlab-harness/src", "drivers"];
const SOURCE_EXTENSIONS = new Set([".js", ".rs", ".py"]);
// A test reading a key must not keep a dead clause alive, and a scratch tree is
// not the system -- but a test-only reader is worth SAYING, so tests are scanned
// and kept apart rather than skipped.
const EXCLUDED_SEGMENTS = ["node_modules", "scratchpad", "target", "__pycache__"];

function runtimeOf(relPath) {
  if (relPath.endsWith(".rs")) return "rust";
  if (relPath.endsWith(".py")) return "python";
  return "js";
}

function isTest(relPath) {
  return /(^|\/)tests?\//.test(relPath) || /[._]test\.(js|py)$|\.test\.js$|_test\.py$/.test(relPath);
}

function sourceFiles() {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_SEGMENTS.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT, dir));
  return found;
}

// --- writing a name ----------------------------------------------------------
//
// Shaped around how each runtime actually spells "put this key in the record".
// Deliberately NOT trying to decide WHICH artifact a key belongs to: the useful
// signal is coarser, and a key nobody anywhere reads is dead whatever record it
// was going into.

const WRITE_PATTERNS = [
  // json!({ "key": ... }) and object literals, all three runtimes.
  { re: /"([a-z][a-z0-9_]{2,})"\s*:/g },
  // value["key"] = ...
  { re: /\[\s*"([a-z][a-z0-9_]{2,})"\s*\]\s*=/g },
  // A serde struct field is a key the moment the struct is serialized.
  { runtime: "rust", re: /^\s*(?:pub(?:\([a-z()]+\))?\s+)?([a-z][a-z0-9_]{2,})\s*:\s*[A-Z_]/gm },
  // Bare JS object-literal keys.
  { runtime: "js", re: /^\s*([a-z][a-z0-9_]{2,})\s*:\s*[^:=]/gm },
];

// --- reading a name ----------------------------------------------------------
//
// A name is READ if it appears anywhere that is not the act of writing it.
//
// The first cut of this looked for `.get("k")`, `["k"]` and attribute access on
// a short list of receiver names, and called 3,336 of 4,954 names dead -- a
// haystack, not a finding. Most reads here are spelled in ways such a list
// cannot see: destructuring, a struct field on a receiver nobody thought to
// call `record`, an interpolation, a key passed on as a variable.
//
// So the test is inverted and made strict. Strip the write forms and ask
// whether the token survives anywhere else, in any file. A name that appears
// ONLY where it is written is dead with very little room for argument, and that
// is the only claim worth making automatically.

function writeFormPatterns(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp('"' + escaped + '"\\s*:', "g"),
    new RegExp("^\\s*" + escaped + "\\s*:", "gm"),
    new RegExp("\\[\\s*\"" + escaped + "\"\\s*\\]\\s*=", "g"),
    new RegExp("^\\s*(?:pub(?:\\([a-z()]+\\))?\\s+)?" + escaped + "\\s*:\\s*[A-Z_]", "gm"),
  ];
}

// Prose is not a consumer.
//
// FOUND BY THIS SCRIPT ON ITS FIRST RUN, against itself: `allowed_outputs` came
// back ALIVE, read in three production files. Two of them were comments written
// the same night saying that no code reads the field -- an explanation of the
// gap, counted as the gap being filled. A tool that reads its own commentary as
// evidence will certify anything anybody has described.
function stripComments(text, runtime) {
  if (runtime === "python") {
    return text
      .replace(/"""[\s\S]*?"""/g, " ")
      .replace(/'''[\s\S]*?'''/g, " ")
      .replace(/(^|[^"'\\])#[^\n]*/g, "$1 ");
  }
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1 ");
}

function readSites(name, corpus) {
  const sites = [];
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const token = new RegExp("\\b" + escaped + "\\b");
  const stripPatterns = writeFormPatterns(name);
  for (const [relPath, text] of corpus) {
    if (!text.includes(name)) continue;
    let stripped = stripComments(text, runtimeOf(relPath));
    for (const pattern of stripPatterns) stripped = stripped.replace(pattern, " ");
    if (token.test(stripped)) sites.push(relPath);
  }
  return sites;
}

function collectWrites(text, relPath, runtime, sink) {
  for (const { re, runtime: only } of WRITE_PATTERNS) {
    if (only && only !== runtime) continue;
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      if (!name) continue;
      let site = sink.get(name);
      if (!site) {
        site = new Set();
        sink.set(name, site);
      }
      site.add(relPath);
    }
  }
}

function buildMap() {
  const writes = new Map();
  const writesInTests = new Map();
  const production = [];
  const tests = [];

  for (const file of sourceFiles()) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const relPath = path.relative(ROOT, file).split(path.sep).join("/");
    const runtime = runtimeOf(relPath);
    if (isTest(relPath)) {
      collectWrites(text, relPath, runtime, writesInTests);
      tests.push([relPath, text]);
    } else {
      collectWrites(text, relPath, runtime, writes);
      production.push([relPath, text]);
    }
  }
  return { writes, writesInTests, production, tests };
}

function runtimesOf(files) {
  return [...new Set([...files].map(runtimeOf))].sort();
}

function report(map) {
  const { writes, writesInTests, production, tests } = map;
  const dead = [];
  for (const [name, files] of writes) {
    // A writer reading its own key back is still a reader, so the writing files
    // are not excluded from the search; the write FORMS are.
    if (readSites(name, production).length) continue;
    dead.push({
      name,
      written_by: [...files].sort(),
      runtimes: runtimesOf(files),
      read_only_by_tests: readSites(name, tests),
    });
  }
  const testOnly = [];
  for (const [name, files] of writesInTests) {
    if (writes.has(name)) continue;
    if (!readSites(name, production).length) continue;
    testOnly.push({ name, written_by: [...files].sort() });
  }
  return {
    schema: "researchlab.name_flow.v1",
    generated_at: new Date().toISOString(),
    files_scanned: production.length + tests.length,
    names_written: writes.size,
    written_and_never_read: dead.sort(
      (a, b) => b.written_by.length - a.written_by.length || a.name.localeCompare(b.name),
    ),
    written_only_by_tests_and_read_in_production: testOnly.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function main() {
  const map = buildMap();
  const nameArgIndex = process.argv.indexOf("--name");
  if (nameArgIndex >= 0 && process.argv[nameArgIndex + 1]) {
    const name = process.argv[nameArgIndex + 1];
    const written = [...(map.writes.get(name) || []), ...(map.writesInTests.get(name) || [])].sort();
    const readProduction = readSites(name, map.production);
    const readTests = readSites(name, map.tests);
    console.log(name);
    console.log(`  written in ${written.length} file(s):`);
    for (const file of written) console.log(`    ${file}`);
    console.log(`  read in ${readProduction.length} production file(s):`);
    for (const file of readProduction) console.log(`    ${file}`);
    if (readTests.length) console.log(`  read in ${readTests.length} test file(s)`);
    process.exit(written.length && !readProduction.length ? 1 : 0);
  }

  const result = report(map);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.written_and_never_read.length ? 1 : 0);
  }

  console.log(`${result.files_scanned} files, ${result.names_written} names written`);
  console.log("");
  console.log(`written and never read (${result.written_and_never_read.length}):`);
  for (const item of result.written_and_never_read) {
    console.log(`  ${item.name.padEnd(40)} ${item.runtimes.join("+").padEnd(16)} ${item.written_by.length} writer(s)`);
    for (const file of item.written_by.slice(0, 4)) console.log(`      ${file}`);
    if (item.read_only_by_tests.length) {
      console.log(`      read only by tests: ${item.read_only_by_tests.join(", ")}`);
    }
  }
  if (result.written_only_by_tests_and_read_in_production.length) {
    console.log("");
    console.log("read in production and written only by tests:");
    for (const item of result.written_only_by_tests_and_read_in_production) {
      console.log(`  ${item.name}`);
    }
  }
  process.exit(result.written_and_never_read.length ? 1 : 0);
}

if (require.main === module) main();

module.exports = { buildMap, report, readSites, sourceFiles };
