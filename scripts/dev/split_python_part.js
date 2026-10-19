#!/usr/bin/env node
"use strict";

// Dev helper: split an exec-style Python "part" file (one of the part_*.py files
// that drivers/*/<name>.py executes sequentially into a shared globals()) into
// several sub-parts each under a line budget, at top-level def/class/decorator
// boundaries. Because the loader exec()s parts in order into the SAME namespace,
// concatenation order is preserved and nothing else changes — behaviour-
// identical. The replacement filenames (in order) are printed so the _PARTS
// list in the loader can be updated.
//
//   node scripts/dev/split_python_part.js <part_file.py> [maxLines=900]

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const maxLines = Number(process.argv[3] || 900);
if (!file) {
  console.error("usage: split_python_part.js <part_file.py> [maxLines]");
  process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
// Top-level boundary: col-0 def/class/decorator (decorator attaches to its def).
const boundaryRe = /^(@\w|def\s|class\s|async\s+def\s)/;
const attachable = (l) => /^(#|@)/.test(l);

const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  if (boundaryRe.test(lines[i])) {
    let s = i;
    while (s > 0 && attachable(lines[s - 1]) && !boundaryRe.test(lines[s - 1])) s -= 1;
    starts.push(s);
  }
}
const uniq = [...new Set(starts)].sort((a, b) => a - b);
if (uniq.length < 2) {
  console.error("fewer than 2 top-level def/class items — not splitting");
  process.exit(1);
}

const preamble = lines.slice(0, uniq[0]);
const blocks = [];
for (let i = 0; i < uniq.length; i += 1) {
  blocks.push(lines.slice(uniq[i], i + 1 < uniq.length ? uniq[i + 1] : lines.length));
}

const parts = [];
let part = [];
let n = 0;
for (const b of blocks) {
  if (n && n + b.length > maxLines) {
    parts.push(part);
    part = [];
    n = 0;
  }
  part.push(...b);
  n += b.length;
}
if (part.length) parts.push(part);
if (parts.length < 2) {
  console.error("fits in one part under budget — not splitting");
  process.exit(1);
}

const dir = path.dirname(file);
const base = path.basename(file, ".py");
const suffixes = "abcdefghij".split("");
const names = [];
parts.forEach((p, i) => {
  // First sub-part keeps the original name + preamble; rest are <base>_<letter>.
  const isFirst = i === 0;
  const name = isFirst ? `${base}.py` : `${base}_${suffixes[i]}.py`;
  const body = (isFirst ? [...preamble, ...p] : p).join("\n").replace(/\n*$/, "\n");
  fs.writeFileSync(path.join(dir, name), body, "utf8");
  names.push(name);
});

console.log(`split ${file} (${lines.length} lines) -> ${parts.length} parts:`);
names.forEach((nm, i) =>
  console.log(`  ${nm}: ${(i === 0 ? preamble.length + parts[0].length : parts[i].length)} lines`),
);
console.log("\nreplace the single _PARTS entry with (in order):");
console.log(names.map((nm) => `    '${nm}',`).join("\n"));
