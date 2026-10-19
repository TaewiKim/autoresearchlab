"use strict";

const LAB_DIRECTOR_LITERATURE_TRIAGE_POLICY = Object.freeze({
  policy_version: "abstract-direct-relevance-v1",
  primary_goal:
    "use literature only until it can support a decision: pick, keep, demote, or gate-review the lead hypothesis",
  when_to_start: [
    "before initial lead selection, to seed the literature KG and state-of-art baseline",
    "after a gatekeeper novelty or impact objection names an unresolved literature baseline",
    "when the current claim lacks same-dataset reference papers, competitor families, or cited mechanisms",
    "when Scout/Chronicle reports missing directly relevant, abstract-reviewed evidence for the active research question",
  ],
  sufficient_evidence_thresholds: {
    minimum_relevant_papers: null,
    minimum_high_signal_papers: null,
    never_pad_with_unscreened_papers: true,
    required_coverage: [
      "state-of-art baseline or closest comparator",
      "the research task, mechanism, population or system actually being studied",
      "at least one rival explanation or competitor family",
      "mechanism-to-outcome vocabulary sufficient to seed KG concepts/edges",
    ],
    abstract_only_allowed: true,
    abstract_only_rule:
      "Read the FULL abstract before admission. A structured review must link its study/task, method and outcome to the exact research objective using quoted abstract evidence. Title, keyword overlap, snippets and prestige alone cannot establish relevance. Full text is required for claims not supported by the abstract.",
    missing_abstract_or_review: "pending_or_quarantined_never_evidence",
    quality_tracks: {
      recent_frontier: "published within the past three years; record preprint/peer-review status and do not infer impact from recency",
      established_impact: "at least 100 sourced citations OR sourced field-normalized top 10% OR verified Q1 venue metric with source and metric year",
    },
    unknown_metrics: "unknown; never invent impact factors, citation counts, or venue quartiles",
  },
  budget: {
    max_scout_lanes_before_labdirector_decision: 2,
    max_queries_per_decision_pass: 10,
    max_papers_to_read_in_detail: 12,
    stop_after_no_new_high_signal_papers: 2,
  },
  when_to_stop: [
    "stop once the sufficiency thresholds are met and the next blocker is a gatekeeper rubric review",
    "stop after two consecutive literature/scout passes add no new high-signal paper, accession, rival family, or KG edge",
    "stop when remaining blockers are validation, reporting, figure, or gatekeeper-review artifacts rather than missing literature",
    "do not run broad literature rediscovery while the active gate asks for a targeted methods review",
  ],
  required_labdirector_decision_after_search:
    "After each literature pass, LabDirector must state keep/demote/pivot, cite the missing-or-sufficient coverage item, and assign exactly one next role. Only papers accepted by abstract-direct-relevance-v1 may support hypothesis novelty or graph edges. If reviewed coverage is insufficient, report insufficient_corpus; never restore excluded papers to reach a count.",
});

function buildLabDirectorLiteratureTriagePolicy() {
  return LAB_DIRECTOR_LITERATURE_TRIAGE_POLICY;
}

module.exports = {
  LAB_DIRECTOR_LITERATURE_TRIAGE_POLICY,
  buildLabDirectorLiteratureTriagePolicy,
};
