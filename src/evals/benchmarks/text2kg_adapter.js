"use strict";

// Text2KGBench adapter (KG-construction stage / Chronicle).
//
// Text2KGBench (ISWC 2023, arXiv:2308.02357) evaluates ontology-driven KG
// generation: given an ontology (concepts, relations, domain/range) and a
// sentence, extract triples {sub, rel, obj} that are faithful to the sentence
// and conform to the ontology. It scores our Chronicle text->KG step. The 7
// metrics, faithful to the paper:
//   Precision / Recall / F1   — on normalized triple match vs gold
//   Ontology Conformance      — fraction of triples whose relation is in the ontology
//   Subject / Object Hallucination — fraction whose subject/object is absent from the sentence
//   Relation Hallucination    — fraction whose relation is absent from the ontology
//
// The ontology is passed as a pre-parsed JSON { relations:[...], concepts:[...] }
// (the real .ttl -> this shape is a documented seam). formatHarnessInput()
// turns an example into the Chronicle extraction input; running that and
// capturing produced triples is the live integration. Scoring is offline/exact.

// Matches the official Text2KGBench evaluation normalization
// (re.sub(r"\s+", "", label).lower()): drop ALL whitespace/underscores and
// lowercase, so our P/R/F1 is directly comparable to the paper's reported numbers.
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\s]+/g, "");
}
function tripleKey(t) {
  return `${norm(t.sub)}|${norm(t.rel)}|${norm(t.obj)}`;
}
function round(x) {
  return x == null ? null : Math.round(x * 1000) / 1000;
}
function asTriples(v) {
  return Array.isArray(v) ? v.filter((t) => t && (t.sub || t.rel || t.obj)) : [];
}
// Accepts an ontology object, a relation-name array, or a Set (normalized or
// not) and returns a normalized relation-name Set, so callers need not pre-norm.
function toRelSet(relations) {
  let arr;
  if (relations instanceof Set) arr = [...relations];
  else if (Array.isArray(relations)) arr = relations;
  else arr = (relations && relations.relations) || [];
  return new Set(arr.map((r) => norm(typeof r === "string" ? r : r.name || r.rel || r.id)));
}

// Precision / Recall / F1 on normalized triple-set match.
function prf(pred, gold) {
  const goldKeys = new Set(gold.map(tripleKey));
  const seen = new Set();
  let tp = 0;
  for (const t of pred) {
    const k = tripleKey(t);
    if (goldKeys.has(k) && !seen.has(k)) {
      tp += 1;
      seen.add(k);
    }
  }
  const precision = pred.length ? tp / pred.length : gold.length ? 0 : 1;
  const recall = gold.length ? tp / gold.length : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { true_positives: tp, precision, recall, f1 };
}

// Entity-level P/R/F1 (relation-agnostic): the set of subject+object entities,
// matching the metric SOTA text-to-graph leaderboards (Lettria) report as
// "Entity F1". More lenient than triple-exact F1 (ignores the relation).
function entityPRF(pred, gold) {
  const ents = (ts) => {
    const s = new Set();
    for (const t of ts) {
      if (t.sub) s.add(norm(t.sub));
      if (t.obj) s.add(norm(t.obj));
    }
    return s;
  };
  const g = ents(gold);
  const p = ents(pred);
  let tp = 0;
  for (const e of p) if (g.has(e)) tp += 1;
  const precision = p.size ? tp / p.size : g.size ? 0 : 1;
  const recall = g.size ? tp / g.size : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, p: p.size, g: g.size, entity_precision: precision, entity_recall: recall, entity_f1: f1 };
}

function ontologyConformance(pred, relations) {
  if (!pred.length) return 1;
  const relSet = toRelSet(relations);
  const ok = pred.filter((t) => relSet.has(norm(t.rel))).length;
  return ok / pred.length;
}

// Hallucination: subject/object must appear in the sentence; relation must be
// in the ontology. Rates = fraction of generated triples that violate each.
function hallucinations(pred, sentence, relations) {
  if (!pred.length) {
    return { subject_hallucination: 0, relation_hallucination: 0, object_hallucination: 0 };
  }
  const relSet = toRelSet(relations);
  const sent = norm(sentence);
  let subj = 0;
  let rel = 0;
  let obj = 0;
  for (const t of pred) {
    if (!sent.includes(norm(t.sub))) subj += 1;
    if (!relSet.has(norm(t.rel))) rel += 1;
    if (!sent.includes(norm(t.obj))) obj += 1;
  }
  return {
    subject_hallucination: subj / pred.length,
    relation_hallucination: rel / pred.length,
    object_hallucination: obj / pred.length,
  };
}

function scoreExample({ predicted, gold, sentence, ontology }) {
  const pred = asTriples(predicted);
  const goldT = asTriples(gold);
  const p = prf(pred, goldT);
  const e = entityPRF(pred, goldT);
  const h = hallucinations(pred, sentence, ontology);
  return {
    gold_count: goldT.length,
    pred_count: pred.length,
    true_positives: p.true_positives,
    precision: round(p.precision),
    recall: round(p.recall),
    f1: round(p.f1),
    entity_precision: round(e.entity_precision),
    entity_recall: round(e.entity_recall),
    entity_f1: round(e.entity_f1),
    entity_tp: e.tp,
    entity_pred: e.p,
    entity_gold: e.g,
    ontology_conformance: round(ontologyConformance(pred, ontology)),
    subject_hallucination: round(h.subject_hallucination),
    relation_hallucination: round(h.relation_hallucination),
    object_hallucination: round(h.object_hallucination),
  };
}

function aggregate(results) {
  const n = results.length;
  if (!n) return { examples: 0 };
  const keys = [
    "precision",
    "recall",
    "f1",
    "entity_precision",
    "entity_recall",
    "entity_f1",
    "ontology_conformance",
    "subject_hallucination",
    "relation_hallucination",
    "object_hallucination",
  ];
  const out = { examples: n };
  // macro average
  for (const k of keys) out[`macro_${k}`] = round(results.reduce((a, r) => a + (r.score[k] || 0), 0) / n);
  // micro triple P/R/F1 from pooled counts
  const tp = results.reduce((a, r) => a + r.score.true_positives, 0);
  const predTot = results.reduce((a, r) => a + r.score.pred_count, 0);
  const goldTot = results.reduce((a, r) => a + r.score.gold_count, 0);
  const microP = predTot ? tp / predTot : 1;
  const microR = goldTot ? tp / goldTot : 1;
  out.micro_precision = round(microP);
  out.micro_recall = round(microR);
  out.micro_f1 = round(microP + microR ? (2 * microP * microR) / (microP + microR) : 0);
  // micro ENTITY P/R/F1 from pooled entity counts
  const etp = results.reduce((a, r) => a + (r.score.entity_tp || 0), 0);
  const epred = results.reduce((a, r) => a + (r.score.entity_pred || 0), 0);
  const egold = results.reduce((a, r) => a + (r.score.entity_gold || 0), 0);
  const emicroP = epred ? etp / epred : 1;
  const emicroR = egold ? etp / egold : 1;
  out.micro_entity_precision = round(emicroP);
  out.micro_entity_recall = round(emicroR);
  out.micro_entity_f1 = round(emicroP + emicroR ? (2 * emicroP * emicroR) / (emicroP + emicroR) : 0);
  return out;
}

function formatHarnessInput(example, ontology) {
  return {
    benchmark: "text2kgbench",
    id: example.id || null,
    sentence: example.sent || example.sentence || "",
    ontology_relations: (ontology && ontology.relations) || [],
    ontology_concepts: (ontology && ontology.concepts) || [],
    extraction_instruction:
      "Extract triples {sub, rel, obj} faithful to the sentence; use only relations defined in the ontology, and only entities present in the sentence.",
  };
}

function evaluateExample({ example, predicted, ontology }) {
  const score = scoreExample({
    predicted,
    gold: example.triples || example.gold || [],
    sentence: example.sent || example.sentence || "",
    ontology,
  });
  return { id: example.id || null, score };
}

module.exports = {
  norm,
  tripleKey,
  prf,
  ontologyConformance,
  hallucinations,
  scoreExample,
  aggregate,
  formatHarnessInput,
  evaluateExample,
};
