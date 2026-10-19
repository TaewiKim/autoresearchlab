"use strict";

// DABStep adapter (data-analysis agent, multi-step reasoning over docs + data).
//
// DABStep (Adyen + HF, arXiv:2506.23719) has a public DEV split WITH answers
// (scorable locally) and a HF leaderboard for the hidden test (so SOTA is known:
// overall ~16% o3-mini; by level easy ~76% / hard ~14.5%). Tasks are factoid:
// the agent reads a shared context (payments.csv + fees.json + manual.md + ...)
// and answers per per-task `guidelines` (e.g. "a number rounded to 2 decimals",
// "a list", "a country code"). Scoring = normalized answer match.
//
// formatHarnessInput() turns a task into the analysis-stage input; a codex
// solver computes the answer; this scorer checks it against the dev gold.

function norm(s) {
  return String(s ?? "").trim().toLowerCase();
}
function stripNum(s) {
  return String(s ?? "").trim().replace(/[$€£,%\s]/g, "");
}
function asList(s) {
  // gold/pred lists: "[a, b]" or "a, b" -> sorted normalized item set
  const inner = String(s ?? "").trim().replace(/^[\[(]/, "").replace(/[\])]$/, "");
  return inner
    .split(/[,;]/)
    .map((x) => norm(x).replace(/^['"]|['"]$/g, ""))
    .filter(Boolean)
    .sort();
}

// ---------------------------------------------------------------------------
// Faithful JS port of the OFFICIAL DABStep scorer (the function the leaderboard
// uses, so our numbers are measured by the same standard as the published
// SOTA): huggingface.co/spaces/adyen/DABstep — dabstep_benchmark/evaluation/
// scorer.py (question_scorer). Numeric: exact, else isclose(rel=1e-4,
// abs=1e-4) for |values|<1, else round to the shorter printed precision then
// isclose. Lists: sorted exact, else pairwise recursive. Strings: cleaned
// equality, single-word subset, else SequenceMatcher ratio > 0.95.

function isNumericWithCommas(value) {
  const v = String(value).trim();
  return /^\$?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+[.,]\d+)$/.test(v);
}

function extractNumeric(value) {
  const v = String(value).replace(/,/g, "").replace(/\$/g, "");
  const m = v.match(/(\d*\.\d+|\d+\.?\d*)%?/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isNaN(n) ? null : n;
}

function compareNumeric(num1, num2) {
  if (num1 === num2) return true;
  const isclose = (a, b) => Math.abs(a - b) <= Math.max(1e-4 * Math.max(Math.abs(a), Math.abs(b)), 1e-4);
  if (num1 < 1 && num2 < 1) return isclose(num1, num2);
  const dec = (x) => (String(x).includes(".") ? String(x).split(".").pop().length : 0);
  const roundTo = Math.min(dec(num1), dec(num2));
  if (Number(num1.toFixed(roundTo)) === Number(num2.toFixed(roundTo))) return true;
  return isclose(num1, num2);
}

// difflib.SequenceMatcher.ratio() — Ratcliff/Obershelp: 2*M/T with M summed
// over recursively found longest matching blocks.
function sequenceRatio(a, b) {
  function longestMatch(al, ah, bl, bh) {
    let besti = al, bestj = bl, bestsize = 0;
    const j2len = new Map();
    for (let i = al; i < ah; i += 1) {
      const newj2len = new Map();
      for (let j = bl; j < bh; j += 1) {
        if (a[i] === b[j]) {
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len.clear();
      for (const [k, v] of newj2len) j2len.set(k, v);
    }
    return [besti, bestj, bestsize];
  }
  function matches(al, ah, bl, bh) {
    const [i, j, k] = longestMatch(al, ah, bl, bh);
    if (!k) return 0;
    return k + matches(al, i, bl, j) + matches(i + k, ah, j + k, bh);
  }
  const total = a.length + b.length;
  if (!total) return 1;
  return (2 * matches(0, a.length, 0, b.length)) / total;
}

function compareStrings(str1, str2) {
  const clean1 = str1.replace(/[^\w]/g, "");
  const clean2 = str2.replace(/[^\w]/g, "");
  if (clean1 === clean2) return true;
  const words1 = str1.toLowerCase().match(/\b\w+\b/g) || [];
  const words2 = str2.toLowerCase().match(/\b\w+\b/g) || [];
  if ((words1.length === 1 || words2.length === 1) && words1.length && words2.length) {
    const s1 = new Set(words1);
    const s2 = new Set(words2);
    return words1.every((w) => s2.has(w)) || words2.every((w) => s1.has(w));
  }
  return sequenceRatio(str1, str2) > 0.95;
}

function compareLists(list1, list2) {
  const split = (s) => s.replace(/^\[|\]$/g, "").split(/[,;]/).map((x) => x.trim()).filter(Boolean).sort();
  const items1 = split(list1.trim());
  const items2 = split(list2.trim());
  if (items1.length === items2.length && items1.every((x, i) => x === items2[i])) return true;
  if (items1.length !== items2.length) return false;
  return items1.every((x, i) => questionScorer(x, items2[i]));
}

function questionScorer(input1, input2) {
  const i1 = String(input1 ?? "").trim().toLowerCase();
  const i2 = String(input2 ?? "").trim().toLowerCase();
  if (isNumericWithCommas(i1) || isNumericWithCommas(i2)) {
    const n1 = extractNumeric(i1);
    const n2 = extractNumeric(i2);
    return n1 !== null && n2 !== null ? compareNumeric(n1, n2) : false;
  }
  if (/[,;]/.test(i1) || /[,;]/.test(i2)) return compareLists(i1, i2);
  const n1 = extractNumeric(i1);
  const n2 = extractNumeric(i2);
  if (n1 !== null && n2 !== null) return compareNumeric(n1, n2);
  return compareStrings(i1, i2);
}

// Match a predicted factoid answer to gold using the official scorer
// semantics. `guidelines` kept for API compatibility (the official scorer
// does not consult it).
function matchAnswer(predicted, gold, guidelines) { // eslint-disable-line no-unused-vars
  const g = norm(gold);
  if (g === "") return norm(predicted) === "";
  return questionScorer(predicted, gold);
}

function formatHarnessInput(task, contextFiles) {
  return {
    benchmark: "dabstep",
    task_id: task.task_id,
    question: task.question,
    guidelines: task.guidelines || "",
    level: task.level || null,
    context_files: contextFiles || [],
    answer_instruction:
      "Analyze the data/doc files in the current directory and answer. Obey the guidelines exactly. End with a line: FINAL ANSWER: <answer>.",
  };
}

function evaluateTask({ task, predicted }) {
  return { task_id: task.task_id, level: task.level || null, match: matchAnswer(predicted, task.answer, task.guidelines), predicted, gold: task.answer };
}

function aggregate(results) {
  const n = results.length;
  if (!n) return { tasks: 0, accuracy: null, by_level: {} };
  const correct = results.filter((r) => r.match).length;
  const byLevel = {};
  for (const r of results) {
    const b = (byLevel[r.level || "unknown"] = byLevel[r.level || "unknown"] || { n: 0, correct: 0 });
    b.n += 1;
    if (r.match) b.correct += 1;
  }
  const round = (x) => Math.round(x * 1000) / 1000;
  for (const b of Object.values(byLevel)) b.accuracy = round(b.correct / b.n);
  return { tasks: n, accuracy: round(correct / n), by_level: byLevel };
}

module.exports = { matchAnswer, questionScorer, asList, formatHarnessInput, evaluateTask, aggregate };
