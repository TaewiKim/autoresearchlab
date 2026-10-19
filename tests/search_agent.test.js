"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  SEARCH_AGENT_JOURNAL_SCHEMA,
  buildSearchAgentContract,
  validateSearchJournal,
} = require("../src/agents/scout/search_agent");
const { buildScoutQueryPlan } = require("../src/agents/scout/query_plan");
const { POLICY_VERSION, hash, paperIdentity } = require("../src/policy/literature_screening");
const { synthesizeLaneResult, synthesizeCycleLiterature } = require("../src/agents/chronicle/literature_synthesis");
const { collectChronicleResearchContext } = require("../src/reporting/reviews/gate/review_context");

const objective = "Determine when contact-risk-aware clarification improves shared robot autonomy with LLM and VLA policies.";
const context = {
  research_problem: "When should shared-autonomy systems ask a clarification question under contact uncertainty?",
  research_scopes: ["HCI", "robot control", "LLM-mediated interaction", "vision-language-action"],
  hypothesis_candidates: [
    { hypothesis_id: "H1", statement: "Contact-risk-calibrated clarification improves safe task completion." },
    { hypothesis_id: "H2", statement: "VLA uncertainty alone is insufficient without human interaction calibration." },
  ],
};

function round({ id, intent, source, parent = [], paper, facets }) {
  return {
    round_id: id,
    inquiry_intent: intent,
    question: `What does ${paper} tell us about ${intent}?`,
    reason: "This result changes the comparison or falsification decision for H1.",
    query: `adaptive inquiry ${id}`,
    source,
    parent_paper_ids: parent,
    result_ids: [paper],
    reading_decisions: [{
      paper_id: paper,
      abstract_read_in_full: true,
      decision: "directly_relevant",
      hypothesis_ids: ["H1"],
      facet_ids: facets,
      reason: "The full abstract directly reports the task, method, and outcome needed for H1.",
    }],
    evidence_accepted_ids: [paper],
  };
}

function completeJournal(contract) {
  return {
    status: "completed",
    research_problem: contract.research_problem,
    search_rounds: [
      round({ id: "r1", intent: "hypothesis_direct", source: "scholarly index", paper: "p1", facets: ["field-1"] }),
      round({ id: "r2", intent: "closest_prior_art", source: "publisher record", paper: "p2", facets: ["field-2"] }),
      round({ id: "r3", intent: "backward_citation", source: "citation graph", parent: ["p2"], paper: "p3", facets: ["field-3"] }),
      round({ id: "r4", intent: "forward_citation", source: "citation graph", parent: ["p1"], paper: "p4", facets: ["field-4"] }),
      round({ id: "r5", intent: "adversarial", source: "scholarly index", paper: "p5", facets: ["field-1"] }),
    ],
    coverage: { unanswered_questions: [] },
    synthesis: {
      claim_paper_links: [{ hypothesis_id: "H1", paper_ids: ["p1", "p2", "p3", "p4", "p5"] }],
      closest_prior_art: [{ paper_id: "p2", relation: "closest procedural baseline" }],
      next_search_decisions: [],
      coverage_gaps: [],
      saturation: { termination_reason: "The last adversarial and citation inquiries did not change the closest-prior-art or falsification decision." },
    },
  };
}

function journalUsingPaperId(contract, paperId) {
  const journal = completeJournal(contract);
  for (const item of journal.search_rounds) {
    item.result_ids = [paperId];
    item.evidence_accepted_ids = [paperId];
    item.reading_decisions[0].paper_id = paperId;
    if (item.parent_paper_ids.length) item.parent_paper_ids = [paperId];
  }
  journal.synthesis.claim_paper_links[0].paper_ids = [paperId];
  journal.synthesis.closest_prior_art[0].paper_id = paperId;
  return journal;
}

function screenedPaper() {
  const abstract = "This full abstract evaluates contact-risk clarification in shared robot autonomy and reports safety outcomes.";
  const paper = { title: "Risk-aware robot clarification", doi: "10.1234/search-agent", year: new Date().getUTCFullYear(), abstract };
  paper.literature_screening = {
    status: "accepted", policy_version: POLICY_VERSION, context_hash: hash("fixture"), objective_hash: hash(objective),
    quality: { eligible: true, tracks: ["recent_frontier"] },
    review: {
      paper_id: paperIdentity(paper), objective_hash: hash(objective), abstract_sha256: hash(abstract), abstract_read_in_full: true,
      decision: "directly_relevant", direct_relevance_reason: `"${paper.title}" evaluates the target robot clarification task and its safety outcome.`,
      // A quote, not the abstract verbatim: the gate now refuses a passage that IS
      // the document, which is what every v90 review supplied.
      supporting_passage: "contact-risk clarification in shared robot", reviewer: { kind: "codex_cli", identity: "test-fixture" }, reviewed_at: new Date().toISOString(),
      linkage: {
        study_task: { abstract_evidence: "shared robot autonomy", objective_link: "The shared-autonomy task is the same robot clarification setting in the objective." },
        method: { abstract_evidence: "contact-risk clarification", objective_link: "The method directly uses contact-risk clarification, as specified in the objective." },
        outcome: { abstract_evidence: "reports safety outcomes", objective_link: "Safety outcomes test the objective's requested improvement in safe robot autonomy." },
      },
      limitations: "This fixture does not establish generalization beyond the reported robot task.",
    },
  };
  return paper;
}

test("Scout plan carries a hypothesis-conditioned adaptive search-agent contract", () => {
  const plan = buildScoutQueryPlan({ prompt: objective, laneId: "scout-02", cycleId: "cycle-agent", cyclePlanningContext: context });
  assert.equal(plan.search_agent_contract.agent_kind, "hypothesis_conditioned_literature_agent");
  assert.deepEqual(plan.assigned_hypotheses.map((item) => item.hypothesis_id), ["H1", "H2"]);
  assert.deepEqual(plan.research_scopes, context.research_scopes);
  assert.match(plan.followup_description, /backward and forward citation/i);
  assert.match(plan.followup_description, /search-agent-journal\.json/);
  assert.ok(SEARCH_AGENT_JOURNAL_SCHEMA.round_required_fields.includes("parent_paper_ids"));
  const structuredProblem = buildSearchAgentContract({
    prompt: "fallback objective", laneId: "scout-02",
    cyclePlanningContext: { research_problem: { question: "Which contact signal should trigger a clarification?" } },
  });
  assert.equal(structuredProblem.research_problem, "Which contact signal should trigger a clarification?");
});

test("a full evidence checkpoint stays pending until the agent declares reasoned completion", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  for (const status of [undefined, "pending_review", "running", "budget_exhausted"]) {
    const journal = completeJournal(contract);
    journal.status = status;
    const result = validateSearchJournal(journal, { contract, acceptedPaperIds: ["p1", "p2", "p3", "p4", "p5"] });
    assert.equal(result.decision_ready, false);
    assert.equal(result.status, "pending");
    assert.ok(result.gaps.includes("search_not_completed"));
  }
  const complete = completeJournal(contract);
  delete complete.synthesis.saturation;
  assert.equal(validateSearchJournal(complete, { contract }).decision_ready, false);
});

test("adaptive rounds bind accepted full-abstract evidence to hypotheses and parent citations", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const journal = completeJournal(contract);
  const result = validateSearchJournal(journal, { contract, acceptedPaperIds: ["p1", "p2", "p3", "p4", "p5"] });
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.decision_ready, true);
  assert.deepEqual(result.covered_facet_ids, ["field-1", "field-2", "field-3", "field-4"]);
  assert.deepEqual(journal.search_rounds[2].parent_paper_ids, ["p2"]);
  assert.deepEqual(journal.search_rounds[3].parent_paper_ids, ["p1"]);
});

test("completed scout artifacts accept documented completion and equivalent arXiv IDs", () => {
  // MEASURED ON cycle-a-20260919, 2026-10-14: scouts 457 and 476
  // returned search_complete=true, plural hypothesis_ids, and used an arXiv
  // query ID for a parent admitted under its canonical DOI/URL identity.
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const journal = completeJournal(contract);
  delete journal.status;
  journal.synthesis.saturation.search_complete = true;
  journal.synthesis.claim_paper_links[0] = { hypothesis_ids: ["H1"], paper_ids: ["p1", "p2", "p3", "p4", "p5"] };
  journal.search_rounds[0].result_ids = ["url:http://arxiv.org/abs/2505.05787v1"];
  journal.search_rounds[0].reading_decisions[0].paper_id = "url:http://arxiv.org/abs/2505.05787v1";
  journal.search_rounds[0].evidence_accepted_ids = ["url:http://arxiv.org/abs/2505.05787v1"];
  journal.search_rounds[1].result_ids = ["doi:10.48550/arxiv.2505.05787"];
  journal.search_rounds[1].reading_decisions[0].paper_id = "doi:10.48550/arxiv.2505.05787";
  journal.search_rounds[1].evidence_accepted_ids = ["doi:10.48550/arxiv.2505.05787"];
  journal.search_rounds[2].parent_paper_ids = ["arxiv:2505.05787"];
  journal.search_rounds[3].parent_paper_ids = ["arxiv:2505.05787"];
  journal.synthesis.closest_prior_art[0].paper_id = "doi:10.48550/arxiv.2505.05787";
  journal.synthesis.claim_paper_links[0].paper_ids[0] = "url:http://arxiv.org/abs/2505.05787v1";
  journal.synthesis.claim_paper_links[0].paper_ids[1] = "doi:10.48550/arxiv.2505.05787";
  const accepted = ["url:http://arxiv.org/abs/2505.05787v1", "doi:10.48550/arxiv.2505.05787", "p3", "p4", "p5"];
  const result = validateSearchJournal(journal, { contract, acceptedPaperIds: accepted });
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.decision_ready, true);
});

test("result counts and structural logs cannot claim coverage without accepted facet evidence", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const journal = completeJournal(contract);
  journal.search_rounds[3].reading_decisions[0].decision = "irrelevant";
  journal.search_rounds[3].evidence_accepted_ids = [];
  journal.coverage = { unanswered_questions: [] };
  journal.synthesis.saturation.termination_reason = "Five searches returned many results.";
  const result = validateSearchJournal(journal, { contract, acceptedPaperIds: ["p1", "p2", "p3", "p4", "p5"] });
  assert.equal(result.valid, false);
  assert.ok(result.gaps.includes("required_field_facet_pending:field-4"));
  assert.ok(result.gaps.includes("count_based_saturation_claim"));
  assert.ok(result.gaps.includes("self_claimed_complete_with_unmet_contract"));
});

test("validator rejects fake citation labels, stale problem text, raw claim IDs, and unresolved questions", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const journal = completeJournal(contract);
  journal.research_problem = "A different research problem.";
  journal.search_rounds[2].source = { type: "citation graph" };
  journal.search_rounds[2].parent_paper_ids = ["invented-parent"];
  journal.search_rounds[3].reading_decisions[0].facet_ids = ["not-a-contract-facet"];
  journal.synthesis.claim_paper_links[0].paper_ids = ["raw-unreviewed-paper"];
  journal.coverage.unanswered_questions = ["Does contact risk transfer across robot embodiments?"];
  const result = validateSearchJournal(journal, { contract, acceptedPaperIds: ["p1", "p2", "p3", "p4", "p5"] });
  assert.equal(result.valid, false);
  assert.equal(result.decision_ready, false);
  assert.ok(result.gaps.includes("journal_research_problem_mismatch"));
  assert.ok(result.gaps.includes("round_3_source_not_scalar"));
  assert.ok(result.gaps.includes("citation_round_missing_citation_source:3"));
  assert.ok(result.gaps.includes("citation_round_parent_not_previously_accepted:3:invented-parent"));
  assert.ok(result.gaps.includes("accepted_evidence_unknown_facet_binding:p4:not-a-contract-facet"));
  assert.ok(result.gaps.includes("claim_link_unscreened_paper:1:raw-unreviewed-paper"));
  assert.ok(result.gaps.includes("unanswered_questions_pending"));
});

test("validator fails closed for an object-shaped but incomplete contract", () => {
  const journal = { research_problem: "A question", search_rounds: [], coverage: { unanswered_questions: [] }, synthesis: {} };
  const result = validateSearchJournal(journal, { contract: { research_problem: "A question" }, acceptedPaperIds: [] });
  assert.equal(result.valid, false);
  assert.equal(result.decision_ready, false);
  assert.ok(result.gaps.includes("contract_hypotheses_missing"));
  assert.ok(result.gaps.includes("contract_required_field_facets_missing"));
  assert.ok(result.gaps.includes("contract_required_inquiry_intents_missing"));
  assert.ok(result.gaps.includes("contract_round_schema_missing"));
});

test("irrelevant cross-field bridges stay excluded and cannot manufacture coverage", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const journal = completeJournal(contract);
  journal.search_rounds.push({
    round_id: "r6",
    inquiry_intent: "cross_field_bridge",
    question: "Does a generic language benchmark transfer to contact-safe robot control?",
    reason: "Test whether the bridge changes the executed control or interaction procedure.",
    query: "generic language benchmark robot contact",
    source: "field repository",
    parent_paper_ids: [], result_ids: ["irrelevant-bridge"], evidence_accepted_ids: [],
    bridge_applicability: { classification: "inapplicable", applicability_reason: "The benchmark does not affect the executed robot-control procedure.", changed_execution_element: null },
    reading_decisions: [{ paper_id: "irrelevant-bridge", abstract_read_in_full: true, decision: "irrelevant", hypothesis_ids: ["H1"], facet_ids: ["field-4"], reason: "It changes neither the control method nor the interaction measurement." }],
  });
  const result = validateSearchJournal(journal, { contract, acceptedPaperIds: ["p1", "p2", "p3", "p4", "p5"] });
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.ok(!result.accepted_evidence_ids.includes("irrelevant-bridge"));
  assert.ok(!result.covered_facet_ids.includes("irrelevant-bridge"));
});

test("Chronicle preserves screened papers but blocks claims and Gate novelty when the journal is incomplete", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const paper = screenedPaper();
  const lane = synthesizeLaneResult({
    role: "scout", driver: "fixture", papers: [paper],
    role_plan: { objective, search_agent_contract: contract },
  }, { cyclePrompt: objective, allowExternal: false });
  assert.equal(lane.paper_count, 1, "screened literature remains available for audit");
  assert.equal(lane.literature_screening.status, "insufficient_corpus");
  assert.equal(lane.search_agent_contract.decision_ready, false);
  assert.deepEqual(lane.hypotheses, [], "incomplete search coverage cannot create promotable claims");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-gate-"));
  try {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", "cycle-prompt.txt"), objective);
    fs.writeFileSync(path.join(root, "plans", "cycle-lab-director-literature.json"), JSON.stringify({
      literature_screening: { policy_version: POLICY_VERSION, objective_hash: hash(objective) },
      top_papers: [paper], search_agent_contract: lane.search_agent_contract,
    }));
    const gateContext = collectChronicleResearchContext({ root, cycleId: "cycle", researcherView: {}, summary: {} });
    assert.equal(gateContext.literature_screening_status, "insufficient_corpus");
    assert.equal(gateContext.search_agent_contract.decision_ready, false);
    assert.match(gateContext.reviewer_instruction, /contract is incomplete/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real cycle synthesis carries active Scout contract blockers into Gate context", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-cycle-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle";
  const laneDir = path.join(root, "lanes", cycleId, "scout-02");
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  try {
    fs.mkdirSync(laneDir, { recursive: true });
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(laneDir, "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [screenedPaper()],
      role_plan: { objective, search_agent_contract: contract },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.search_agent_contract.decision_ready, false);
    assert.deepEqual(output.summary.search_agent_contract.pending_lane_ids, ["scout-02"]);
    assert.equal(output.summary.literature_screening.status, "insufficient_corpus");
    assert.equal(output.summary.lanes[0].search_agent_contract.decision_ready, false);
    const gateContext = collectChronicleResearchContext({ root, cycleId, researcherView: {}, summary: {} });
    assert.equal(gateContext.search_agent_contract.decision_ready, false);
    assert.equal(gateContext.literature_screening_status, "insufficient_corpus");
    assert.match(gateContext.reviewer_instruction, /contract is incomplete/i);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a validated successor lifts only its identical, round-inherited source contract", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-recovery-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-recovery";
  const sourceContract = buildSearchAgentContract({ prompt: objective, laneId: "scout-source", cyclePlanningContext: context });
  const sourcePaper = screenedPaper();
  const paperId = paperIdentity(sourcePaper);
  const sourceJournal = {
    research_problem: sourceContract.research_problem,
    search_rounds: [round({ id: "source-r0", intent: "hypothesis_direct", source: "scholarly index", paper: paperId, facets: ["field-1"] })],
  };
  const successorJournal = journalUsingPaperId(sourceContract, paperId);
  successorJournal.search_rounds.unshift(sourceJournal.search_rounds[0]);
  try {
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-source"), { recursive: true });
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-recovery"), { recursive: true });
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-source", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [sourcePaper], search_agent_journal: sourceJournal,
      role_plan: { objective, search_agent_contract: sourceContract },
    }));
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-recovery", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [sourcePaper], search_agent_journal: successorJournal,
      role_plan: { objective, search_agent_contract: sourceContract, planner_metadata: { source_lane_id: "scout-source" } },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.search_agent_contract.decision_ready, true);
    assert.deepEqual(output.summary.search_agent_contract.pending_lane_ids, []);
    assert.deepEqual(output.summary.search_agent_contract.verified_recoveries.map((item) => item.source_lane_id), ["scout-source"]);
    assert.equal(output.summary.lanes.find((lane) => lane.lane_id === "scout-recovery").search_agent_contract.source_contract.research_problem, sourceContract.research_problem);

    const mismatched = structuredClone(sourceContract);
    mismatched.research_problem = "An unrelated research problem.";
    const unrelatedJournal = journalUsingPaperId(mismatched, paperId);
    unrelatedJournal.search_rounds.unshift(sourceJournal.search_rounds[0]);
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-recovery", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [sourcePaper], search_agent_journal: unrelatedJournal,
      role_plan: { objective, search_agent_contract: mismatched, planner_metadata: { source_lane_id: "scout-source" } },
    }));
    const unrelatedOutput = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(unrelatedOutput.summary.search_agent_contract.decision_ready, false);
    assert.deepEqual(unrelatedOutput.summary.search_agent_contract.pending_lane_ids, ["scout-source"]);
    assert.deepEqual(unrelatedOutput.summary.search_agent_contract.verified_recoveries, []);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("an abstract-review follow-up may repair receipts with the same inherited rounds", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-receipt-repair-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-receipt-repair";
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-source", cyclePlanningContext: context });
  const paper = screenedPaper();
  const paperId = paperIdentity(paper);
  const invalidSourceJournal = journalUsingPaperId(contract, paperId);
  for (const inquiry of invalidSourceJournal.search_rounds) inquiry.reading_decisions[0].abstract_read_in_full = false;
  const repairedJournal = journalUsingPaperId(contract, paperId);
  try {
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-source"), { recursive: true });
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-receipt-repair"), { recursive: true });
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-source", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: invalidSourceJournal,
      role_plan: { objective, search_agent_contract: contract },
    }));
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-receipt-repair", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: repairedJournal,
      role_plan: {
        objective, search_agent_contract: contract, action_type: "abstract_review_followup",
        planner_metadata: { source_lane_id: "scout-source" },
      },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.search_agent_contract.decision_ready, true);
    assert.deepEqual(output.summary.search_agent_contract.verified_recoveries.map((item) => item.source_lane_id), ["scout-source"]);
    assert.equal(output.summary.lanes.find((lane) => lane.lane_id === "scout-receipt-repair").search_agent_contract.lineage.action_type, "abstract_review_followup");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("a valid successor recovers an empty-history contracted Scout", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-empty-recovery-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-empty-recovery";
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-empty", cyclePlanningContext: context });
  const paper = screenedPaper();
  const paperId = paperIdentity(paper);
  try {
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-empty"), { recursive: true });
    fs.mkdirSync(path.join(root, "lanes", cycleId, "scout-successor"), { recursive: true });
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-empty", "result.json"), JSON.stringify({
      driver: "codex-agent-executor", role: "scout", papers: [],
      role_plan: { objective, search_agent_contract: contract },
    }));
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-successor", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: journalUsingPaperId(contract, paperId),
      role_plan: { objective, search_agent_contract: contract, planner_metadata: { source_lane_id: "scout-empty" } },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.search_agent_contract.decision_ready, true);
    assert.deepEqual(output.summary.search_agent_contract.verified_recoveries.map((item) => item.source_lane_id), ["scout-empty"]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("recovery follows an inherited-round chain only to a validated terminal successor", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-chain-recovery-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-chain-recovery";
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-a", cyclePlanningContext: context });
  const paper = screenedPaper();
  const paperId = paperIdentity(paper);
  const aJournal = { research_problem: contract.research_problem, search_rounds: [round({ id: "a-r0", intent: "hypothesis_direct", source: "scholarly index", paper: paperId, facets: ["field-1"] })] };
  const bJournal = structuredClone(aJournal);
  bJournal.search_rounds.push(round({ id: "b-r1", intent: "adversarial", source: "scholarly index", paper: paperId, facets: ["field-1"] }));
  const cJournal = journalUsingPaperId(contract, paperId);
  cJournal.search_rounds.unshift(...structuredClone(bJournal.search_rounds));
  try {
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    for (const laneId of ["scout-a", "scout-b", "scout-c"]) fs.mkdirSync(path.join(root, "lanes", cycleId, laneId), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-a", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: aJournal,
      role_plan: { objective, search_agent_contract: contract },
    }));
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-b", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: bJournal,
      role_plan: { objective, search_agent_contract: contract, planner_metadata: { source_lane_id: "scout-a" } },
    }));
    fs.writeFileSync(path.join(root, "lanes", cycleId, "scout-c", "result.json"), JSON.stringify({
      driver: "literature-search-driver", role: "scout", papers: [paper], search_agent_journal: cJournal,
      role_plan: { objective, search_agent_contract: contract, planner_metadata: { source_lane_id: "scout-b" } },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.search_agent_contract.decision_ready, true);
    assert.deepEqual(output.summary.search_agent_contract.pending_lane_ids, []);
    assert.deepEqual(output.summary.search_agent_contract.verified_recoveries.map((item) => item.source_lane_id), ["scout-a", "scout-b"]);
    assert.ok(output.summary.search_agent_contract.verified_recoveries.every((item) => item.successor_lane_id === "scout-c"));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("an empty contracted Codex Scout remains a pending literature lane and blocks Gate", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "search-agent-empty-codex-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-empty-codex";
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-empty", cyclePlanningContext: context });
  try {
    const laneDir = path.join(root, "lanes", cycleId, "scout-empty");
    fs.mkdirSync(laneDir, { recursive: true });
    fs.mkdirSync(path.join(root, "plans"), { recursive: true });
    fs.writeFileSync(path.join(root, "plans", `${cycleId}-prompt.txt`), objective);
    fs.writeFileSync(path.join(laneDir, "result.json"), JSON.stringify({
      driver: "codex-agent-executor", role: "scout", papers: [],
      search_agent_contract: contract,
      role_plan: { role: "scout", objective, search_agent_contract: contract },
    }));
    const output = synthesizeCycleLiterature({ cwd, cycleId, researchStage: "evidence" });
    assert.equal(output.summary.lane_count, 1);
    assert.equal(output.summary.lanes[0].paper_count, 0);
    assert.equal(output.summary.search_agent_contract.applicable, true);
    assert.equal(output.summary.search_agent_contract.decision_ready, false);
    assert.deepEqual(output.summary.search_agent_contract.pending_lane_ids, ["scout-empty"]);
    assert.equal(output.summary.literature_screening.status, "insufficient_corpus");
    const gateContext = collectChronicleResearchContext({ root, cycleId, researcherView: {}, summary: {} });
    assert.equal(gateContext.search_agent_contract.decision_ready, false);
    assert.match(gateContext.reviewer_instruction, /contract is incomplete/i);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("validator CLI accepts stdin and fails closed when the contract or journal is missing", () => {
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const invocation = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "agents", "scout", "search_agent.js"), "--validate", "-"], {
    input: JSON.stringify({ objective, role_plan: { search_agent_contract: contract }, papers: [screenedPaper()] }),
    encoding: "utf8",
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  const assessment = JSON.parse(invocation.stdout);
  assert.equal(assessment.status, "pending");
  assert.equal(assessment.decision_ready, false);
  assert.ok(assessment.gaps.includes("search_rounds_empty"));
});

test("a scout is told the journal rules its validator enforces", () => {
  // cycle-b-20260917e: scouts with working network restated the problem and
  // listed several providers per round, and failed validation on exactly that.
  const plan = buildScoutQueryPlan({ prompt: objective, laneId: "scout-02", cycleId: "cycle-agent", cyclePlanningContext: context });
  assert.match(plan.followup_description, /research_problem must be search_agent_contract\.research_problem copied verbatim/);
  assert.match(plan.followup_description, /source is ONE string/);

  // Following those rules is what the validator accepts for those two checks.
  const contract = plan.search_agent_contract;
  const round = (source) => ({ round_id: "r1", inquiry_intent: "hypothesis_direct", question: "q", reason: "r", query: "q", source, parent_paper_ids: [], result_ids: [], reading_decisions: [], evidence_accepted_ids: [] });
  const listed = validateSearchJournal({ research_problem: "my own restatement", search_rounds: [round(["openalex", "crossref"])] }, { contract });
  assert.ok(listed.errors.includes("journal_research_problem_mismatch"));
  assert.ok(listed.errors.includes("round_1_source_not_scalar"));
  const followed = validateSearchJournal({ research_problem: contract.research_problem, search_rounds: [round("openalex")] }, { contract });
  assert.ok(!followed.errors.includes("journal_research_problem_mismatch"));
  assert.ok(!followed.errors.includes("round_1_source_not_scalar"));
});

test("a journal written through Windows PowerShell still validates as the same problem", () => {
  // cycle-b-20260917g: PowerShell 5.1 prefixed a BOM and turned the
  // objective's em dash into "??". The scout had copied the problem verbatim.
  const { readJson } = require("../src/shared/json");
  const plan = buildScoutQueryPlan({ prompt: objective, laneId: "scout-02", cycleId: "cycle-agent", cyclePlanningContext: context });
  const contract = { ...plan.search_agent_contract, research_problem: "Robotics research cycle — simulation-first on this PC" };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bom-journal-"));
  try {
    const file = path.join(dir, "search-agent-journal.json");
    const journal = { research_problem: "Robotics research cycle ?? simulation-first on this PC", search_rounds: [] };
    fs.writeFileSync(file, "﻿" + JSON.stringify(journal), "utf8");
    const loaded = readJson(file);
    const result = validateSearchJournal(loaded, { contract });
    assert.ok(!result.errors.includes("journal_research_problem_mismatch"), result.errors.join(","));
    assert.ok(!result.errors.includes("journal_research_problem_missing"));
    // A genuinely different problem is still rejected.
    const other = validateSearchJournal({ ...loaded, research_problem: "A different question" }, { contract });
    assert.ok(other.errors.includes("journal_research_problem_mismatch"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unformulated objective is not a problem statement the journal must copy", () => {
  // cycle-b-20260917h: with no research problem formulated yet the contract
  // held the whole 1400-character objective, and every scout failed the match.
  const longObjective = "# Robotics research cycle\n\n" + "Find a falsifiable robotics question using the simulators on this PC. ".repeat(20);
  const plan = buildScoutQueryPlan({ prompt: longObjective, laneId: "scout-02", cycleId: "cycle-objective", cyclePlanningContext: {} });
  const contract = plan.search_agent_contract;
  assert.equal(contract.research_problem_source, "objective_text");
  assert.match(plan.followup_description, /research_problem_source is objective_text/);
  const journal = { research_problem: "Does uncertainty-gated pausing reduce unsafe contacts in simulated grasping?", search_rounds: [] };
  const stated = validateSearchJournal(journal, { contract });
  assert.ok(!stated.errors.includes("journal_research_problem_mismatch"), stated.errors.join(","));
  // It must still state one.
  const missing = validateSearchJournal({ search_rounds: [] }, { contract });
  assert.ok(missing.errors.includes("journal_research_problem_missing"));
  // A formulated problem is still matched.
  const formulated = buildScoutQueryPlan({ prompt: objective, laneId: "scout-02", cycleId: "cycle-agent", cyclePlanningContext: context }).search_agent_contract;
  assert.equal(formulated.research_problem_source, "planning_context");
  assert.ok(validateSearchJournal(journal, { contract: formulated }).errors.includes("journal_research_problem_mismatch"));
});

// cycle-a-20260919, 2026-10-07: scouts with 50 reviewed papers ended
// "search_not_completed" because their open questions were ones only an
// experiment, the host, or the established absence of prior work can answer.
test("only a literature question keeps the search open; the rest go to the director", () => {
  const { OPEN_ITEM_EXHAUSTED_MIN_ROUNDS } = require("../src/agents/scout/search_agent");
  const contract = buildSearchAgentContract({ prompt: objective, laneId: "scout-02", cyclePlanningContext: context });
  const accepted = ["p1", "p2", "p3", "p4", "p5"];

  const deferredOnly = completeJournal(contract);
  deferredOnly.coverage.unanswered_questions = [
    { question: "Will 96x96 rendering preserve enough texture for frozen features to differ?", kind: "experiment", reason: "Only the pilot can measure it." },
    { question: "Can the local MuJoCo assets expose appearance factors?", kind: "host_capability", reason: "The engineer's capability check answers it." },
    { question: "Has anyone compared tangent and normal support perturbations?", kind: "literature_exhausted", searched_in_round_ids: ["r1", "r5"] },
  ];
  deferredOnly.synthesis.coverage_gaps = [
    { gap: "No response-error mediation estimate exists.", kind: "literature_exhausted", searched_in_round_ids: ["r2", "r4"], reason: "closest prior art and its citations" },
  ];
  const ok = validateSearchJournal(deferredOnly, { contract, acceptedPaperIds: accepted });
  assert.equal(ok.valid, true, JSON.stringify(ok.gaps));
  assert.equal(ok.decision_ready, true);
  assert.equal(ok.deferred_open_items.length, 4);
  assert.deepEqual(ok.deferred_open_items.map((item) => item.kind).sort(),
    ["experiment", "host_capability", "literature_exhausted", "literature_exhausted"]);

  // A literature question still blocks, as a plain string always has.
  const open = completeJournal(contract);
  open.status = "in_progress";
  open.synthesis.next_search_decisions = ["search the citations of p2"];
  open.coverage.unanswered_questions = [{ question: "Which venue first reported this?", kind: "literature" }];
  const pending = validateSearchJournal(open, { contract, acceptedPaperIds: accepted });
  assert.ok(pending.gaps.includes("unanswered_questions_pending"));
  assert.equal(pending.decision_ready, false);

  // "The literature has no answer" needs the searches behind it, and a deferral needs its reason.
  const unearned = completeJournal(contract);
  unearned.coverage.unanswered_questions = [
    { question: "Is this new?", kind: "literature_exhausted", searched_in_round_ids: ["r1", "r-invented"] },
    { question: "Does it transfer?", kind: "experiment" },
    { question: "Is this reported?", kind: "a vibe" },
  ];
  const refused = validateSearchJournal(unearned, { contract, acceptedPaperIds: accepted });
  assert.equal(refused.valid, false);
  assert.ok(refused.gaps.includes("unanswered_question_exhausted_without_searches:1"), JSON.stringify(refused.gaps));
  assert.ok(refused.gaps.includes("unanswered_question_experiment_without_reason:2"));
  assert.ok(refused.gaps.includes("unanswered_questions_pending"));
  assert.ok(refused.gaps.includes("self_claimed_complete_with_unanswered_questions"));
  assert.equal(OPEN_ITEM_EXHAUSTED_MIN_ROUNDS, 2);
});
