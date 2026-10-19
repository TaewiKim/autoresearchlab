#!/usr/bin/env node
"use strict";

// Dev helper: split an `include!`-style Rust test file (a flat list of top-level
// `#[test]` / `#[tokio::test]` functions sharing helpers from support.rs) into
// several files each under a line budget, at test-function boundaries only.
// Pure textual partition — no logic, ordering, or visibility changes.
//
//   node scripts/dev/split_included_tests.js <file.rs> [maxLines=950]
//
// Writes <base>_01.rs, <base>_02.rs, ... next to the original, removes the
// original, and prints the include! lines to substitute in the parent module.

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const maxLines = Number(process.argv[3] || 950);
if (!file) {
  console.error("usage: split_included_tests.js <file.rs> [maxLines]");
  process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").split("\n");
const isBoundary = (l) => /^#\[(tokio::)?test\]\s*$/.test(l);

// Build blocks: a leading preamble (anything before the first #[test]) then one
// block per test function (from its #[test] attr up to the next boundary).
const blocks = [];
let current = [];
let started = false;
for (const line of lines) {
  if (isBoundary(line)) {
    if (current.length) blocks.push(current);
    current = [line];
    started = true;
  } else {
    current.push(line);
  }
}
if (current.length) blocks.push(current);
if (!started) {
  console.error("no #[test] boundaries found; not splitting");
  process.exit(1);
}

// Greedily pack blocks into parts under the line budget (a single oversized
// block still gets its own part — we never split inside a function).
const parts = [];
let part = [];
let partLines = 0;
for (const block of blocks) {
  if (partLines && partLines + block.length > maxLines) {
    parts.push(part);
    part = [];
    partLines = 0;
  }
  part.push(...block);
  partLines += block.length;
}
if (part.length) parts.push(part);

const dir = path.dirname(file);
const baseName = path.basename(file, ".rs");
const includeDirName = path.basename(dir); // e.g. "tests"
const includes = [];
parts.forEach((partLinesArr, i) => {
  const suffix = String(i + 1).padStart(2, "0");
  const outName = `${baseName}_${suffix}.rs`;
  let text = partLinesArr.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  fs.writeFileSync(path.join(dir, outName), text, "utf8");
  includes.push(`include!("${includeDirName}/${outName}");`);
});

fs.unlinkSync(file);

console.log(`split ${file} (${lines.length} lines) -> ${parts.length} parts:`);
parts.forEach((p, i) => console.log(`  ${baseName}_${String(i + 1).padStart(2, "0")}.rs: ${p.length} lines`));
console.log("\nreplace the single include with:");
console.log(includes.join("\n"));
