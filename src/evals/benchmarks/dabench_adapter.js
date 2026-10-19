"use strict";

// InfiAgent-DABench adapter (data-analysis stage / Analyst).
//
// DABench (DAEval, arXiv:2401.05507) turns open-ended data-analysis questions
// into CLOSED-FORM, auto-gradeable ones: the agent must emit answers as
// `@answer_name[value]` markers, parsed by regex and exact-matched to gold
// (numeric rounded to a per-question number of decimals; categorical exact). A
// question counts correct only if ALL its sub-answers match. Reported metrics:
//   ABQ  Accuracy By Questions      — fraction with ALL sub-answers correct
//   APSQ Accuracy Proportional/SubQ — mean per-question fraction correct
//   AUSQ Accuracy Uniform/SubQ      — overall fraction of correct sub-answers
//
// This probes the Analyst's data-analysis capability with cheap automatic
// scoring. formatHarnessInput() turns a question into the analysis-stage input
// (CSV + question + constraints + required format); running that stage and
// capturing its response is the live seam — scoring works on recorded responses.

const MARKER = /@([A-Za-z0-9_]+)\s*\[([^\]]*)\]/g;

// Parse all `@name[value]` markers into a name -> [values] map. Values are
// kept as a list so repeated names (e.g. a per-group answer emitted once per
// group) are preserved and matched as a multiset rather than collapsing.
function parseMarkers(text) {
  const out = {};
  const s = String(text || "");
  let m;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(s)) !== null) {
    (out[m[1]] = out[m[1]] || []).push(m[2].trim());
  }
  return out;
}

function roundTo(x, d) {
  const f = Math.pow(10, d);
  return Math.round(x * f) / f;
}

// One predicted value vs one gold value. Numeric => round both to `decimals`;
// otherwise trimmed case-insensitive string match (robust to agent formatting).
function valueMatches(pred, gold, decimals = 2) {
  if (pred === undefined || pred === null) return false;
  const ps = String(pred).trim().replace(/^[$%]/, "").replace(/[,%]/g, "");
  const gs = String(gold).trim().replace(/^[$%]/, "").replace(/[,%]/g, "");
  const pn = Number(ps);
  const gn = Number(gs);
  if (gs !== "" && ps !== "" && !Number.isNaN(pn) && !Number.isNaN(gn)) {
    return roundTo(pn, decimals) === roundTo(gn, decimals);
  }
  return String(pred).trim().toLowerCase() === String(gold).trim().toLowerCase();
}

// Gold may be a dict {name: value} or a list of {name, value, decimals?}.
function normalizeGold(gold, defaultDecimals) {
  if (Array.isArray(gold)) {
    return gold.map((g) => ({ name: g.name, value: g.value, decimals: g.decimals ?? defaultDecimals }));
  }
  if (gold && typeof gold === "object") {
    return Object.entries(gold).map(([name, value]) => ({ name, value, decimals: defaultDecimals }));
  }
  return [];
}

function scoreQuestion({ response, gold, decimals }) {
  const pred = parseMarkers(response); // name -> [values]
  const golds = normalizeGold(gold, decimals ?? 2);
  const subs = [];
  let correct = 0;
  const used = {}; // name -> Set of consumed predicted indices (multiset match)
  for (const g of golds) {
    const cands = pred[g.name] || [];
    const consumed = (used[g.name] = used[g.name] || new Set());
    let matchedIdx = -1;
    for (let i = 0; i < cands.length; i += 1) {
      if (!consumed.has(i) && valueMatches(cands[i], g.value, g.decimals ?? 2)) {
        matchedIdx = i;
        break;
      }
    }
    const ok = matchedIdx >= 0;
    if (ok) {
      consumed.add(matchedIdx);
      correct += 1;
    }
    subs.push({ name: g.name, expected: g.value, got: ok ? cands[matchedIdx] : cands[0] ?? null, match: ok });
  }
  const total = golds.length;
  return {
    total,
    correct,
    all_correct: total > 0 && correct === total, // ABQ indicator
    subquestion_accuracy: total ? correct / total : 1,
    subs,
  };
}

function aggregate(results) {
  const n = results.length;
  if (!n) return { questions: 0, ABQ: null, APSQ: null, AUSQ: null, by_level: {} };
  const allCorrect = results.filter((r) => r.score.all_correct).length;
  const apsq = results.reduce((a, r) => a + r.score.subquestion_accuracy, 0) / n;
  const subCorrect = results.reduce((a, r) => a + r.score.correct, 0);
  const subTotal = results.reduce((a, r) => a + r.score.total, 0);
  const round3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
  const byLevel = {};
  for (const r of results) {
    const lvl = r.level || "unknown";
    const b = (byLevel[lvl] = byLevel[lvl] || { n: 0, allCorrect: 0 });
    b.n += 1;
    if (r.score.all_correct) b.allCorrect += 1;
  }
  for (const b of Object.values(byLevel)) b.ABQ = round3(b.allCorrect / b.n);
  return {
    questions: n,
    ABQ: round3(allCorrect / n),
    APSQ: round3(apsq),
    AUSQ: round3(subTotal ? subCorrect / subTotal : 0),
    by_level: byLevel,
  };
}

// A DABench question -> the analysis-stage input it should drive.
function formatHarnessInput(q) {
  return {
    benchmark: "infiagent-dabench",
    question_id: q.id ?? q.question_id ?? null,
    csv: q.file_name || q.file || null,
    question: q.question || "",
    constraints: q.constraints || "",
    required_format: q.format || "",
    level: q.level || null,
    // The analysis stage must answer in DABench closed form so it is auto-gradeable.
    answer_format_instruction:
      "Provide every requested quantity as a marker `@answer_name[value]`, comma-separated, matching the required_format exactly.",
  };
}

function evaluateQuestion({ question, response, decimals }) {
  const score = scoreQuestion({ response, gold: question.labels ?? question.answers ?? question.gold, decimals });
  return { question_id: question.id ?? question.question_id ?? null, level: question.level || null, score };
}

module.exports = {
  parseMarkers,
  valueMatches,
  scoreQuestion,
  aggregate,
  formatHarnessInput,
  evaluateQuestion,
};
