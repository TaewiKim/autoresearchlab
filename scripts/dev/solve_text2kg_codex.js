#!/usr/bin/env node
"use strict";

// Baseline solver: extract KG triples from Text2KGBench sentences with codex and
// write predictions for run_text2kg.js. Runs in the codex-sandbox container
// (root, codex auth). One codex exec per sentence; codex is told to emit ONLY a
// JSON array of {sub,rel,obj} using only the ontology's relations.
//
//   node scripts/dev/solve_text2kg_codex.js --examples <dir> --ontologies <dir> \
//        --out <predictions dir> [--sample N] [--effort low]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function parseArgs(argv) {
  const a = { effort: "low", sample: 0, fewshot: 0, out: "evals/text2kg/_real/predictions_codex" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--examples") a.examples = argv[++i];
    else if (argv[i] === "--ontologies") a.ontologies = argv[++i];
    else if (argv[i] === "--out") a.out = argv[++i];
    else if (argv[i] === "--sample") a.sample = Number(argv[++i]);
    else if (argv[i] === "--effort") a.effort = argv[++i];
    else if (argv[i] === "--fewshot") a.fewshot = Number(argv[++i]);
    else if (argv[i] === "--train-dir") a.trainDir = argv[++i];
    else if (argv[i] === "--sim-dir") a.simDir = argv[++i];
    else if (argv[i] === "--max-triples") a.maxTriples = Number(argv[++i]);
  }
  return a;
}

// Few-shot (in-context) demos: the Text2KGBench method selects the most
// sentence-similar train examples per test sentence. We reuse the benchmark's
// precomputed test_train_sent_similarity ranking + train labels.
const _trainCache = {};
const _simCache = {};
function readJsonl(f) {
  return fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}
function loadTrain(dir, ont) {
  if (_trainCache[ont]) return _trainCache[ont];
  const p = path.join(dir, `${ont}_train.jsonl`);
  const map = {};
  if (fs.existsSync(p)) {
    for (const r of readJsonl(p)) {
      // wikidata_tekgen: flat sub_label/rel_label/obj_label (1 triple/line).
      // dbpedia_webnlg: a triples[] array (possibly multiple).
      const triples = Array.isArray(r.triples) && r.triples.length
        ? r.triples.map((t) => ({ sub: t.sub, rel: t.rel, obj: t.obj }))
        : r.sub_label
        ? [{ sub: r.sub_label, rel: r.rel_label, obj: r.obj_label }]
        : [];
      map[r.id] = { sent: r.sent, triples };
    }
  }
  return (_trainCache[ont] = map);
}
function loadSim(dir, ont) {
  if (_simCache[ont]) return _simCache[ont];
  const p = path.join(dir, `${ont}_test_train_similarity.json`);
  return (_simCache[ont] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {});
}
function fewshotBlock(a, ex) {
  if (!a.fewshot || !a.trainDir || !a.simDir) return "";
  const train = loadTrain(a.trainDir, ex.ontology);
  const sim = loadSim(a.simDir, ex.ontology);
  const ids = (sim[ex.id] || []).slice(0, a.fewshot);
  const demos = ids
    .map((tid) => train[tid])
    .filter((d) => d && d.triples && d.triples.length)
    .map((d) => `Sentence: ${d.sent}\nTriples: ${JSON.stringify(d.triples)}`);
  return demos.length ? `Examples:\n${demos.join("\n")}\n\n` : "";
}
function loadOnt(dir, name, cache) {
  if (cache[name]) return cache[name];
  const p = path.join(dir, `${name}.json`);
  return (cache[name] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : { relations: [] });
}
function extractTriples(text) {
  const m = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((t) => t && (t.sub || t.rel || t.obj)) : [];
  } catch {
    return [];
  }
}

function main() {
  const a = parseArgs(process.argv);
  if (!a.examples || !a.ontologies) {
    console.error("usage: solve_text2kg_codex.js --examples <dir> --ontologies <dir> --out <dir> [--sample N] [--effort low]");
    process.exit(2);
  }
  fs.mkdirSync(a.out, { recursive: true });
  const cache = {};
  let files = fs.readdirSync(a.examples).filter((f) => f.endsWith(".json")).sort();
  // stratify across ontologies by spreading the picks
  if (a.sample) {
    const byOnt = {};
    for (const f of files) {
      const ex = JSON.parse(fs.readFileSync(path.join(a.examples, f), "utf8"));
      (byOnt[ex.ontology] = byOnt[ex.ontology] || []).push(f);
    }
    const onts = Object.keys(byOnt).sort();
    const per = Math.max(1, Math.floor(a.sample / onts.length));
    files = onts.flatMap((o) => byOnt[o].slice(0, per)).slice(0, a.sample);
  }
  console.log(`solving ${files.length} sentences with codex (effort=${a.effort})`);

  let done = 0;
  let skipped = 0;
  for (const f of files) {
    const ex = JSON.parse(fs.readFileSync(path.join(a.examples, f), "utf8"));
    // Resume: skip examples already solved in --out (incremental runs).
    if (fs.existsSync(path.join(a.out, `${ex.id}.json`))) {
      skipped += 1;
      continue;
    }
    const ont = loadOnt(a.ontologies, ex.ontology, cache);
    const rels = (ont.relations || []).join(", ");
    const demos = fewshotBlock(a, ex);
    const cap = a.maxTriples
      ? `Output at most ${a.maxTriples} triple(s): only the most central fact(s) explicitly stated about the main subject; omit peripheral or inferred triples.`
      : "";
    const styleRule = demos
      ? "Render every subject/object EXACTLY in the same surface form and naming convention as the Examples: keep parenthetical type-disambiguation suffixes (e.g. _(comicsCharacter)), use underscores for multi-word names, and wrap literal string/number values in double quotes. Match the example formatting precisely."
      : "";
    const prompt = [
      "Extract knowledge-graph triples from the sentence below.",
      `Use ONLY these relations: [${rels}].`,
      "Use only entities that appear in the sentence.",
      styleRule,
      cap,
      'Output ONLY a JSON array of objects {"sub":..,"rel":..,"obj":..}, no prose.',
      demos ? `\n${demos}Now extract for:` : "",
      `Sentence: ${ex.sent}`,
    ].join(" ");
    const cmd = `codex exec --skip-git-repo-check --sandbox read-only -c model_reasoning_effort="${a.effort}" ${JSON.stringify(prompt)}`;
    let resp = "";
    const t0 = Date.now();
    try {
      resp = execSync(cmd, { encoding: "utf8", timeout: 240000, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      resp = (e.stdout || "").toString();
    }
    resp = resp.replace(/\x1b\[[0-9;]*m/g, "");
    let triples = extractTriples(resp);
    if (a.maxTriples) triples = triples.slice(0, a.maxTriples); // cap to lift precision
    fs.writeFileSync(path.join(a.out, `${ex.id}.json`), JSON.stringify({ id: ex.id, triples }, null, 2) + "\n");
    done += 1;
    console.log(`[${done}/${files.length}] ${ex.id} (${ex.ontology}) ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`wrote ${done} predictions (skipped ${skipped} existing) -> ${a.out}`);
}

main();
