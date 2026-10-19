"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { POLICY_VERSION, hash, paperIdentity, isScreenedEvidence, hasQualityEvidence } = require("../src/policy/literature_screening");
const { synthesizeLaneResult, chronicleRelevanceDecision } = require("../src/agents/chronicle/literature_synthesis");
const { filterPapersToChronicleRelevance } = require("../src/reporting/reviews/gate/review_context");
const { buildScoutQueryPlan } = require("../src/agents/scout/query_plan");
const { paperSignalProfile } = require("../src/agents/chronicle/literature_synthesis/literature_graph");
const { compactPaper } = require("../src/agents/chronicle/literature_synthesis/compact");

const objective = "Learn when robot contact risk makes a clarification question useful during shared autonomy.";
const abstract = "We study human robot shared autonomy during uncertain contact. Our method asks targeted clarification questions from predicted contact risk. Experiments measure task success, peak force and the time spent answering questions.";

function reviewedPaper() {
  const paper = { title: "Contact risk and clarification", doi: "10.0000/fixture", year: new Date().getUTCFullYear(), abstract };
  // Three dimensions, three answers. Spreading one `link` object into all three
  // is the shape the gate now refuses: every v90 review answered study_task,
  // method and outcome with the same sentence.
  const linkage = {
    study_task: {
      abstract_evidence: "shared autonomy",
      objective_link: "The study addresses the shared autonomy setting the objective names.",
    },
    method: {
      abstract_evidence: "targeted clarification questions",
      objective_link: "The robot selects questions using physical contact uncertainty, the mechanism under study.",
    },
    outcome: {
      abstract_evidence: "predicted contact risk",
      objective_link: "The reported contact-risk outcome is the quantity the objective is scored on.",
    },
  };
  paper.literature_screening = { status: "accepted", policy_version: POLICY_VERSION, context_hash: hash("fixture context"),
    objective_hash: hash(objective), quality: { eligible: true, tracks: ["recent_frontier"] },
    review: { paper_id: paperIdentity(paper), objective_hash: hash(objective), abstract_sha256: hash(abstract), abstract_read_in_full: true,
      reviewer: { kind: "human", identity: "offline-test-fixture" }, reviewed_at: new Date().toISOString(), decision: "directly_relevant",
      direct_relevance_reason: "This study directly tests contact risk as a basis for robot clarification in shared autonomy.",
      supporting_passage: "Our method asks targeted clarification questions from predicted contact risk.",
      linkage: structuredClone(linkage),
      limitations: "The abstract does not establish generalization to unseen physical contact regimes." } };
  return paper;
}

test("only full abstract review bound to this objective and paper is accepted", () => {
  const paper = reviewedPaper();
  assert.equal(isScreenedEvidence(paper, { objective }), true);
  assert.equal(isScreenedEvidence({ ...paper, abstract: abstract + " Modified." }, { objective }), false);
  assert.equal(isScreenedEvidence({ ...paper, doi: "10.0000/different" }, { objective }), false);
  assert.equal(isScreenedEvidence(paper, { objective: "unrelated medical imaging objective" }), false);
  assert.equal(isScreenedEvidence({ ...paper, literature_screening: undefined }, { objective }), false);
  const fabricated = structuredClone(paper);
  fabricated.literature_screening.review.linkage.method.abstract_evidence = "a method never reported by this abstract";
  assert.equal(isScreenedEvidence(fabricated, { objective }), false);
});

test("quality tracks preserve new work but cannot infer journal prestige or missing citation evidence", () => {
  const old = { year: 2010, journal: "Nature", cited_by_count: 10000 };
  assert.equal(hasQualityEvidence(old), false);
  const verified = { ...old, citation_count_provenance: { value: 10000, source: "OpenAlex", source_url: "https://openalex.org/W1", observed_at: "2026-09-06" } };
  assert.equal(hasQualityEvidence(verified), true);
  assert.equal(hasQualityEvidence({ ...verified, cited_by_count: 9999 }), false);
  assert.equal(hasQualityEvidence({ year: new Date().getUTCFullYear(), cited_by_count: 0 }), true);
  assert.equal(hasQualityEvidence({ year: new Date().getUTCFullYear() + 1 }), false);
  assert.equal(paperSignalProfile(old).venueTier, "unknown");
  assert.equal(paperSignalProfile(old).citedByCount, null);
});

test("compact summaries preserve review hashes and distinguish frontier from verified impact", () => {
  const paper = reviewedPaper();
  assert.equal(isScreenedEvidence(compactPaper(paper), { objective }), true);
  const lane = synthesizeLaneResult({ role: "scout", driver: "fixture", papers: [paper] }, { cyclePrompt: objective, allowExternal: false });
  assert.equal(lane.paper_count, 1);
  assert.equal(lane.recent_frontier_papers.length, 1);
  assert.equal(lane.established_impact_papers.length, 0);
  assert.equal(paperSignalProfile(paper).evidenceStrength, "recent-frontier-impact-undetermined");
});

test("small or empty admit lists never restore a raw unreviewed corpus", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-screening-"));
  try {
    fs.mkdirSync(path.join(root, "state"));
    const file = path.join(root, "state", "test-chronicle-literature-relevance.json");
    const good = reviewedPaper();
    const raw = { title: "Unrelated popular paper", year: new Date().getUTCFullYear(), abstract: "Unrelated abstract", cited_by_count: 100000 };
    fs.writeFileSync(file, JSON.stringify({ kept: [{ doi: good.doi }] }));
    const decision = chronicleRelevanceDecision(root, "test");
    assert.equal(decision.mode, "admit");
    assert.equal(decision.keys.size, 1);
    assert.deepEqual(filterPapersToChronicleRelevance([good, raw], { root, cycleId: "test", objective }), [good]);
    fs.writeFileSync(file, JSON.stringify({ kept: [] }));
    assert.deepEqual(filterPapersToChronicleRelevance([good, raw], { root, cycleId: "test", objective }), []);
    fs.writeFileSync(file, "malformed");
    assert.deepEqual(filterPapersToChronicleRelevance([raw], { root, cycleId: "test", objective }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unreviewed sidecars and inline papers cannot seed hypotheses or stale scenarios", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-sidecar-"));
  try {
    const raw = { title: "Robot contact", year: new Date().getUTCFullYear(), abstract };
    fs.writeFileSync(path.join(root, "papers.json"), JSON.stringify([raw]));
    const synthesis = synthesizeLaneResult({ role: "scout", driver: "fixture", papers: [],
      hypothesis_scenarios: [{ statement: "Old unsupported claim" }], frontier_catalog: { families: ["unsupported"] } },
    { laneDir: root, cyclePrompt: objective, allowExternal: false });
    assert.equal(synthesis.paper_count, 0);
    assert.deepEqual(synthesis.hypotheses, []);
    assert.deepEqual(synthesis.hypothesis_scenarios, []);
    assert.deepEqual(synthesis.literature_graph.nodes, []);
    assert.equal(synthesis.literature_screening.status, "insufficient_corpus");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Scout protocol completes structured abstract review before publishing evidence", () => {
  const plan = buildScoutQueryPlan({ prompt: objective, laneId: "scout-02", cycleId: "test" });
  assert.match(plan.followup_description, /FULL abstract/);
  assert.match(plan.followup_description, /--finalize-review-dir/);
  assert.match(plan.followup_description, /insufficient_corpus/);
  assert.doesNotMatch(plan.followup_description, /title or abstract actually shares domain vocabulary/);
});
