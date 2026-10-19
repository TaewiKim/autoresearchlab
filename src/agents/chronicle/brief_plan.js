"use strict";

function buildChronicleBriefPlan({ prompt, laneId, cycleId = "<cycle_id>" }) {
  return {
    lane_id: laneId,
    role: "chronicle",
    source: "lab-director",
    prompt,
    direct_corpus_interaction_contract: {
      required: true,
      source_refs: [
        {
          title: "Beyond Semantic Similarity: Rethinking Retrieval for Agentic Search via Direct Corpus Interaction",
          arxiv: "2605.05242",
          url: "https://arxiv.org/abs/2605.05242",
        },
        {
          name: "DCI-Agent-Lite",
          url: "https://github.com/DCI-Agent/DCI-Agent-Lite",
        },
      ],
      rule: "Use DCI-style raw corpus interaction over current-cycle artifacts instead of relying only on semantic top-k summaries.",
      corpus_scope: [
        `.research-lab/lanes/${cycleId}/scout-*/result.json`,
        `.research-lab/artifacts/stats/${cycleId}/**/*literature*`,
        `.research-lab/artifacts/stats/${cycleId}/**/handoff-validation-plan.json`,
        `.research-lab/artifacts/stats/${cycleId}/**/validation-summary.json`,
        `.research-lab/review-map/${cycleId}/manifest.json`,
        `.research-lab/review-map/${cycleId}/by-stage/**`,
        `.research-lab/review-map/${cycleId}/by-agent/**`,
        `.research-lab/state/${cycleId}-*.json`,
      ],
      allowed_tools: ["rg", "jq", "sed", "ls", "cat", "short_cycle_scoped_scripts"],
      forbidden: [
        "whole-repository recursive search",
        "semantic-top-k-only synthesis",
        "uncited trend claims",
        "large unbounded tool output in final message",
      ],
      required_artifacts: {
        corpus_map_path: `.research-lab/state/${cycleId}-chronicle-dci-corpus-map.json`,
        evidence_ledger_path: `.research-lab/state/${cycleId}-chronicle-dci-evidence-ledger.json`,
        checkpoint_path: `.research-lab/state/${cycleId}-chronicle-dci-checkpoint.json`,
      },
      context_management: {
        truncate_large_tool_outputs: true,
        compact_older_probes: true,
        summarize_checkpoint_for_resume: true,
      },
    },
    literature_relevance_review: {
      required: true,
      // Chronicle — not a hardcoded keyword filter — decides which scout papers
      // belong in this cycle's literature graph. The graph builder only ENFORCES
      // your decision; it applies no domain logic of its own.
      rule:
        "The literature graph is the gatekeeper's novelty baseline, so it must contain the cycle's OWN field. Scout corpora are polluted by shared method words: a rendering objective's 'importance sampling'/'variance reduction'/'adaptive sampling' queries pull in statistics, finance, medical-imaging, genomics and ML papers that share the phrase but not the field. Measured: a scout run collected 5,114 unique papers of which only ~6% were graphics, and the resulting 2,731-node graph was rejected outright by the gatekeeper — 'Chronicle's paper set and graph are largely unrelated to rendering, so they provide no valid novelty baseline' — which caps novelty scoring no matter how original the lead is.",
      how:
        "Do NOT try to read all of them; the corpus is far larger than one pass can review, and a partial review that only names exclusions lets thousands of unreviewed off-domain papers through. Instead: SELECT the papers that should form the baseline. Rank the corpus by how relevant it is to THIS cycle's objective (subject category — papers carry `primary_category`/`categories`, whose values are this field's own category codes — plus journal/venue, title and abstract, citation weight and recency), take roughly the top 150-400, and judge those with your own reasoning. Prefer the field's real prior art: the venues this field publishes in and the preprint categories it uses, the named methods the lead competes against, plus foundational works that predate categories). Include genuine cross-disciplinary prior art; exclude papers that merely share a method word. A smaller, on-domain baseline is far more useful than a large polluted one.",
      emit_artifact: {
        path: `.research-lab/state/${cycleId}-chronicle-literature-relevance.json`,
        shape:
          "{ reviewed_at, cycle_domain, kept_count, dropped_count, kept: [{ id|doi|title }], dropped: [{ id|doi|title, category, reason }] } — `kept` is an ADMIT-LIST: the graph is built from EXACTLY those papers (identify each by doi when present, else exact title), so anything you do not list is excluded whether or not you examined it. Emit `dropped` too, with reasons, for the notable off-domain ones you rejected. If you genuinely cannot rank the corpus this pass, emit `dropped` only and leave `kept` empty — the builder then falls back to excluding just those.",
      },
    },
    summary_contract: {
      include: [
        "claim deltas",
        "open questions",
        "recommended actions",
        "hypothesis changes",
        "supporting evidence paths",
      ],
      emphasize: [
        "what changed since the previous pass",
        "which findings are robust vs exploratory",
        "which blockers prevent researcher approval",
      ],
    },
    interpretation_schema: {
      required_signals: ["summary"],
      optional_signals: [
        "claim_deltas",
        "open_questions",
        "recommended_actions",
        "hypothesis_candidates",
        "strategy_advice",
      ],
      preferred_json_keys: [
        "summary",
        "claim_deltas",
        "open_questions",
        "recommended_actions",
      ],
      raw_text_cues: [
        "what changed",
        "robust vs exploratory",
        "blockers",
        "recommended actions",
        "next steps",
      ],
      fallback_interpretation_rules: [
        "If no JSON is present, summarize the raw output into a concise chronicle pass summary.",
        "If claim deltas are absent, preserve actionability and blockers over schema completeness.",
        "If output is noisy, recover the most decision-relevant signals for Lab Director instead of failing the lane.",
      ],
    },
  };
}

module.exports = {
  buildChronicleBriefPlan,
};
