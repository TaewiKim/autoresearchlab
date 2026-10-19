"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  prf,
  ontologyConformance,
  hallucinations,
  scoreExample,
  aggregate,
  tripleKey,
} = require("../src/evals/benchmarks/text2kg_adapter");

const ontology = { relations: ["member_of", "genre", "formed_in"], concepts: ["Band", "Person"] };
const sentence = "John Lennon was a member of The Beatles, a rock band formed in Liverpool.";
const gold = [
  { sub: "John Lennon", rel: "member_of", obj: "The Beatles" },
  { sub: "The Beatles", rel: "genre", obj: "rock" },
  { sub: "The Beatles", rel: "formed_in", obj: "Liverpool" },
];

test("triple key normalizes underscores/case/space", () => {
  assert.equal(tripleKey({ sub: "The_Beatles", rel: "Formed_In", obj: "Liverpool" }), tripleKey({ sub: "the beatles", rel: "formed in", obj: "liverpool" }));
});

test("precision/recall/f1 on triple-set match", () => {
  const pred = [
    { sub: "John Lennon", rel: "member_of", obj: "The Beatles" },
    { sub: "The Beatles", rel: "formed_in", obj: "Liverpool" },
  ];
  const r = prf(pred, gold);
  assert.equal(r.true_positives, 2);
  assert.equal(r.precision, 1); // both predicted are correct
  assert.equal(Math.round(r.recall * 100) / 100, 0.67); // 2 of 3 gold
});

test("ontology conformance flags relations outside the ontology", () => {
  const pred = [
    { sub: "a", rel: "member_of", obj: "b" },
    { sub: "a", rel: "invented_by", obj: "c" }, // not in ontology
  ];
  assert.equal(ontologyConformance(pred, new Set(["member_of", "genre", "formed_in"])), 0.5);
});

test("hallucination: entities absent from sentence / relation absent from ontology", () => {
  const relSet = new Set(["member_of", "genre", "formed_in"]);
  const pred = [
    { sub: "John Lennon", rel: "member_of", obj: "The Beatles" }, // clean
    { sub: "Paul McCartney", rel: "drummer_of", obj: "Wings" }, // subj/obj not in sentence, rel not in ontology
  ];
  const h = hallucinations(pred, sentence, relSet);
  assert.equal(h.subject_hallucination, 0.5);
  assert.equal(h.object_hallucination, 0.5);
  assert.equal(h.relation_hallucination, 0.5);
});

test("scoreExample returns the full 7-metric set", () => {
  const pred = [
    { sub: "John Lennon", rel: "member_of", obj: "The Beatles" },
    { sub: "The Beatles", rel: "formed_in", obj: "Liverpool" },
  ];
  const s = scoreExample({ predicted: pred, gold, sentence, ontology });
  assert.equal(s.precision, 1);
  assert.equal(s.recall, 0.667);
  assert.equal(s.ontology_conformance, 1);
  assert.equal(s.subject_hallucination, 0);
  assert.equal(s.relation_hallucination, 0);
  assert.equal(s.object_hallucination, 0);
});

test("aggregate computes micro + macro P/R/F1", () => {
  const results = [
    { id: "a", score: scoreExample({ predicted: gold, gold, sentence, ontology }) }, // perfect
    {
      id: "b",
      score: scoreExample({
        predicted: [{ sub: "x", rel: "member_of", obj: "y" }],
        gold: [{ sub: "x", rel: "member_of", obj: "y" }],
        sentence: "x is a member_of y",
        ontology,
      }),
    },
  ];
  const agg = aggregate(results);
  assert.equal(agg.examples, 2);
  assert.equal(agg.micro_precision, 1);
  assert.equal(agg.micro_recall, 1);
  assert.equal(agg.macro_f1, 1);
});
