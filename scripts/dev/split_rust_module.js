#!/usr/bin/env node
"use strict";

// Dev helper: split a large single-module Rust source file into several files
// each under a line budget, joined back via `include!` — the same mechanism the
// crate already uses for its test modules (see labdirector/tests.rs). Because
// `include!` pastes the text into the SAME module scope, the module's `use`
// imports and all item visibilities are unchanged: the split is purely textual
// and behaviour-identical. The compiler verifies it.
//
//   node scripts/dev/split_rust_module.js <file.rs> [maxLines=900]
//
// Splits only at top-level item boundaries (col-0 fn/struct/enum/impl/trait/
// mod/type/const/static), keeping the leading `use`/doc preamble in the main
// file. A single item larger than the budget is left whole in its own part
// (and reported), since we never split inside an item.

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const maxLines = Number(process.argv[3] || 900);
if (!file) {
  console.error("usage: split_rust_module.js <file.rs> [maxLines]");
  process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split("\n");

// A top-level item start: col-0 line beginning an item (not `use`).
const itemRe =
  /^(pub(\([^)]*\))?\s+)?((async|unsafe|const|default|extern)(\s+|\s*"[^"]*"\s+))*(fn|struct|enum|union|impl|trait|mod|type|static|const)\b/;
const attrOrComment = (l) => /^(#\[|#!\[|\/\/)/.test(l);
const isUse = (l) => /^(pub\s+)?use\b/.test(l);

// Find item-start indices, each extended backward over the item's attached
// attributes / doc comments.
const starts = [];
for (let i = 0; i < lines.length; i += 1) {
  if (itemRe.test(lines[i]) && !isUse(lines[i])) {
    let s = i;
    while (s > 0 && attrOrComment(lines[s - 1])) s -= 1;
    // don't swallow lines already inside the previous block's trailing region
    starts.push(s);
  }
}
const uniqStarts = [...new Set(starts)].sort((a, b) => a - b);
if (uniqStarts.length < 2) {
  console.error("fewer than 2 top-level items (or a single giant item) — not splitting");
  process.exit(1);
}

const preamble = lines.slice(0, uniqStarts[0]);
const blocks = [];
for (let i = 0; i < uniqStarts.length; i += 1) {
  const from = uniqStarts[i];
  const to = i + 1 < uniqStarts.length ? uniqStarts[i + 1] : lines.length;
  blocks.push(lines.slice(from, to));
}

// Greedily pack blocks into parts under the budget.
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
  console.error("everything fits in one part under the budget — not splitting");
  process.exit(1);
}

const dir = path.dirname(file);
const base = path.basename(file, ".rs");
const subdir = path.join(dir, base);
fs.mkdirSync(subdir, { recursive: true });

const includes = [];
parts.forEach((p, i) => {
  const suffix = String(i + 1).padStart(2, "0");
  const outRel = `${base}/${base}_${suffix}.rs`;
  let text = p.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  fs.writeFileSync(path.join(dir, outRel), text, "utf8");
  includes.push(`include!("${outRel}");`);
});

// Rewrite the main module file: preamble + a note + the include! lines.
const header = [
  ...preamble,
  "",
  `// Split into <${maxLines}-line parts joined via include! (same module scope,`,
  "// so imports and visibilities are unchanged). See scripts/dev/split_rust_module.js.",
  ...includes,
  "",
];
fs.writeFileSync(file, header.join("\n").replace(/\n*$/, "\n"), "utf8");

console.log(`split ${file} (${lines.length} lines) -> preamble + ${parts.length} parts:`);
parts.forEach((p, i) => {
  const over = p.length > 1000 ? "  <-- STILL >1000 (single large item)" : "";
  console.log(`  ${base}/${base}_${String(i + 1).padStart(2, "0")}.rs: ${p.length} lines${over}`);
});
