"use strict";

const { buildFrontierDiscoveryFrame, frontierQueries } = require("../shared/frontier_discovery");
const { dedupe, inferTopicTerms } = require("../shared/topic_terms");
const { summarizeCanonicalReference } = require("../shared/canonical_reference");
const { loadCycleEvidence } = require("../shared/cycle_evidence");
const { resolveProfile } = require("../shared/derived_profile");
const { runtimeRoot } = require("../../runtime/native_client");

function prioritizedFamilies(cyclePlanningContext = null) {
  return Array.isArray(cyclePlanningContext?.next_cycle_plan?.prioritized_families)
    ? cyclePlanningContext.next_cycle_plan.prioritized_families
    : [];
}

function buildAnalystQueryPlan({ prompt, laneId, cycleId = null, cyclePlanningContext = null }) {
  // Named so the reference stage can point at this cycle's own retrieved
  // literature rather than at a directory to be searched.
  const cycleStatePrefix = cycleId ? `.research-lab/state/${cycleId}` : ".research-lab/state/<cycle>";
  // The profile comes from what this cycle MEASURED it can do, not from words
  // matched against a table of fields. Before any probe has run the mode is
  // unknown and the plan says so, which is a state a lane can act on; a field
  // label guessed from the prompt is not.
  const resolved = resolveProfile({
    ...loadCycleEvidence({ root: runtimeRoot(), cycleId }),
    context: prompt,
  });
  const profile = resolved.profile;
  const terms = inferTopicTerms(prompt);
  const hints = [...(profile.hints || [])];
  const queries = [];
  const frontier = frontierQueries(prompt, { role: "analyst", cycleId });
  const priorityQueries = [...frontier.queries];
  const prioritized = prioritizedFamilies(cyclePlanningContext);
  const canonicalReference = summarizeCanonicalReference(cyclePlanningContext?.canonical_reference);

  for (const term of terms) {
    for (const hint of hints) queries.push(`${term} ${hint}`.trim());
  }
  for (const item of prioritized.slice(0, 4)) {
    const family = String(item?.family_root || "").replaceAll("_", " ").trim();
    const action = String(item?.action || "monitor").replaceAll("_", " ").trim();
    if (!family) continue;
    queries.push(`${family} ${action} pairwise validation`);
    queries.push(`${family} family switch trigger analysis`);
  }

  return {
    lane_id: laneId,
    role: "analyst",
    source: "lab-director",
    prompt,
    // What this cycle can DO, measured, in place of what field a word-match said
    // it was in. Null until the capability probe has run, and a lane can act on
    // null; it could not act on a wrong field label.
    intervention_mode: resolved.intervention_mode,
    profile_provenance: resolved.provenance,
    research_execution_mode: "codex-research-with-docs",
    analysis_execution_mode: "design-plus-validation-code-blueprint",
    frontier_discovery: buildFrontierDiscoveryFrame(prompt),
    candidate_primary_families: frontier.families,
    candidate_outcomes: frontier.outcomes,
    analyst_identity: profile.identity,
    analysis_goal: profile.analysisGoal,
    statistical_mandate: profile.statisticalMandate,
    critique_protocol: {
      structured_critique_dimensions: ["identification", "novelty", "statistical validity", "concept-to-column resolution"],
      deep_verification_mode: "assumption-tree-and-dag-stress-test",
      ranking_mode: "pairwise-statistical-adjudication",
      impact_first_ranking_mode: "candidate-families-ranked-before-lead-selection",
      validation_data_ranking_mode: "candidate-families-ranked-by-accessible-dataset-and-variable-mapping-before-lead-promotion",
      competition_mode: "identifiability-aware",
      evolution_mode: "recombination-and-falsification",
    },
    // Adapted from Anthropic's "self-service data analytics with Claude": for
    // analysis work the dominant failure is not code generation but mapping an
    // ambiguous question to the single correct data-model entity. Most errors
    // trace to concept-to-entity ambiguity, staleness, and retrieval failure,
    // so we constrain the analyst with trust-ordered sources of truth, forced
    // concept-to-column resolution, provenance footers, and an explicit
    // adversarial review before handoff rather than leaving these to chance.
    sources_of_truth_policy: {
      rationale:
        "Most analysis errors come from concept-to-entity ambiguity, stale definitions, and retrieval failure, not from code. Resolve each concept against trusted sources in trust order before writing any test.",
      consult_in_trust_order: [
        {
          tier: "semantic_definitions",
          what: "the pinned canonical_reference (registry of datasets with trust tier + freshness, families, and hypothesis->family routing) and the data knowledge-graph digest (data_kg_digest)",
          use: "resolve each exposure, outcome, and covariate to one canonical column/dataset before anything else; prefer verified_semantic-tier datasets over discovered_unverified candidates",
        },
        {
          tier: "lineage_and_grain",
          what: "dataset provenance, row grain, join keys, and deprecation/staleness signals",
          use: "confirm the canonical column is current, correctly grained, and not deprecated",
        },
        {
          tier: "curated_reference",
          what: "distilled per-domain reference notes (gotchas, exclusions, routing triggers)",
          use: "prefer curated reference over broad raw retrieval; raw grep over many query/notebook files is a last resort and rarely improves accuracy",
        },
        {
          tier: "library_documentation",
          what: "official statistical-library documentation",
          use: "validate method semantics and edge cases (see python_library_docs_policy)",
        },
      ],
      anti_patterns: [
        "do not invent a metric/variable definition from raw columns when a canonical definition exists; auto-generated definitions tend to re-encode the very ambiguity we are trying to remove",
        "do not rely on broad raw retrieval across many files to find the right variable; structure the question-to-entity mapping instead",
        "do not promote a family whose key concepts cannot be resolved to a single canonical, current column",
      ],
    },
    concept_resolution_protocol: {
      requirement:
        "Before the analysis master table is defined, resolve every modeled concept (exposure, outcome, mediator, confounder, moderator) to exactly one canonical column with a recorded source tier and freshness.",
      // Concrete handoff field the offline eval harness scores against. Emit it
      // exactly so resolution accuracy can be measured automatically.
      handoff_field: "canonical_variable_resolution",
      item_shape: {
        concept: "the modeled concept being resolved (e.g. primary_exposure, outcome)",
        resolved_canonical_id: "the single canonical_reference dataset/column id chosen",
        resolved_accession: "the dataset accession when applicable",
        source_tier: "verified_semantic | discovered_unverified | curated_reference | raw_table",
        freshness: "snapshot/version/extraction date the resolution assumes",
        rejected_candidates: "list of {candidate, reason} for near-duplicates not chosen",
      },
      rules: [
        "name the single resolved column for each concept and list the rejected near-duplicate candidates with the reason each was rejected",
        "if a concept cannot be resolved to one canonical column, mark it unresolved and treat it as a validation blocker rather than guessing",
        "record the lookback window, inclusion/exclusion rules, and unit/grain each resolution assumes",
        "flag any resolution whose source definition is stale or whose freshness is unknown so the gate can see the staleness risk",
      ],
    },
    provenance_policy: {
      requirement:
        "Every variable resolution and every claim in the handoff must carry a provenance footer so downstream gate review can see whether an answer rests on a governed definition or an ad hoc raw-table read, and whether it is stale.",
      footer_fields: ["source_tier", "dataset_or_definition_id", "freshness_or_snapshot", "owner_if_known"],
      source_tier_order: ["semantic_definition", "curated_reference", "raw_table"],
    },
    // Offline-evaluation discipline, adapted to the analyst contract: the blog
    // gates each domain at a resolution/accuracy threshold and targets ~100%
    // of answers hitting the semantic (canonical) tier. The lab already
    // evaluates an `analyst_quality_standard` handoff field in the blueprint
    // driver, but nothing instructs the analyst to declare one. Declaring it
    // turns these targets into an enforced gate instead of an aspiration.
    analyst_quality_standard_policy: {
      requirement:
        "Declare an explicit analyst_quality_standard in the handoff with pinned, gate-checkable acceptance criteria before any family is promoted; do not leave the acceptance bar implicit. Every criterion must reference an observable your attached blueprints actually produce: never require a score floor for a metric no blueprint emits, and required_validation_checks must contain exact check_id values declared in this handoff (never prose descriptions - a sentence can never match the executed-check registry and phantom-fails every run).",
      recommended_standard_tabular: {
        applies_when: "the handoff validates via a tabular analysis master table -- any objective whose blueprints emit analysis_accuracy_score and method_appropriateness_score, whatever the field",
        minimum_blueprints_passed: 1,
        require_no_blueprint_failures: true,
        require_all_handoff_checks_resolved: true,
        required_validation_checks: ["analysis_master_table_created"],
        minimum_method_appropriateness_score: 80,
        minimum_analysis_accuracy_score: 80,
        allow_inconclusive_for_gate_review: false,
      },
      recommended_standard_procedural: {
        applies_when: "the handoff validates via instrument-based measurements or procedural/simulation checks (no tabular master table; blueprints do not emit analysis_accuracy_score)",
        minimum_blueprints_passed: 1,
        require_no_blueprint_failures: true,
        require_all_handoff_checks_resolved: true,
        required_validation_checks: "exact check_id values of THIS handoff's substantive science checks (e.g. the primary crossover/convergence check), never prose",
        minimum_method_appropriateness_score: null,
        minimum_analysis_accuracy_score: null,
        allow_inconclusive_for_gate_review: false,
      },
      canonical_resolution_target: {
        metric: "canonical_resolution_rate",
        definition: "share of modeled concepts resolved to a single canonical/semantic-tier column (not a raw-table guess)",
        target: 1.0,
        rationale:
          "Mirrors the ~100% semantic-layer-resolution target: every correct answer should rest on a governed definition, not an ad hoc raw read.",
        report_in: "self_evaluation",
      },
      rules: [
        "pick the recommended standard matching this handoff's validation modality (tabular vs experimental/procedural) and pin the acceptance criteria to those values (or stricter); report each one in a self_evaluation block alongside the canonical_resolution_rate actually achieved",
        "declare a score floor ONLY for metrics your blueprints emit; a floor on a metric that is never produced does not make the standard stricter - it auto-fails every run regardless of scientific merit and destroys the gate's discriminating power",
        "required_validation_checks entries must be exact check_id strings declared in this handoff; put prose expectations in the check descriptions or execution notes, never in required_validation_checks",
        "if the achieved canonical_resolution_rate is below target, treat the shortfall as a gate blocker and list the unresolved concepts rather than promoting the family",
        "keep the declared standard stable across the cycle so 'did that change help?' stays answerable; do not relax thresholds to pass",
      ],
    },
    // Owner directive 2026-07-11: consider the validation environment from the
    // moment the hypothesis is formed -- but if reaching it only needs another
    // driver installed or more data loaded, the cycle should attempt it rather
    // than rule the hypothesis out. Observed on cycle-g-v57: a sound procedural render lead (H-OPDD,
    // in-code Mitsuba scenes, novelty 58) stalled because the analyst authored a
    // PREREQ check demanding "a matching immutable cycle bundle" and then declared
    // it an irrecoverable schema blocker — for a hypothesis whose scenes are
    // GENERATED in code and whose held-outs are PUBLICLY downloadable, and in a
    // container with working outbound network + pip. That is the exact failure the
    // owner named: a dependency that is acquirable was treated as impossible.
    materializability_first_policy: {
      requirement:
        "A validation dependency may be declared a blocker ONLY after acquisition has been attempted and genuinely failed. Before writing any handoff, classify every validation dependency by how it is obtained, and prefer a hypothesis whose full dependency set is obtainable in THIS environment.",
      acquisition_ladder: [
        "code-generable — procedural experimental inputs / synthetic data / analytic references the blueprint constructs in-code with a verified method appropriate to the objective. This IS materialization: never require a downloaded 'immutable bundle' for a self-contained procedural/simulation lead, and never author a prereq check that demands one.",
        "installable — a library/tool available via pip/conda/apt (declare the exact install command in the blueprint execution notes; a missing package is a setup step, not a dead end).",
        "publicly downloadable — an open dataset / benchmark asset with a verified URL or accession relevant to the objective. Emit a scout data-acquisition action to fetch it into a cycle bundle; only if the fetch itself fails is it a blocker.",
        "genuinely unavailable — requires private data, paid entitlement, human subjects, or physical apparatus not present. ONLY this tier is a legitimate irrecoverable blocker, and it must trigger a re-scope of the claim to a materializable comparator, not a stall.",
      ],
      rules: [
        "do NOT declare 'no matching immutable cycle bundle' irrecoverable for a procedural/simulation lead — its experimental inputs are code-generable, so the in-code construction satisfies materialization (validation_data_status: materialized, mode: procedural).",
        "for every named comparator/baseline, state its acquisition tier; if a SOTA method has no obtainable implementation in this environment, replace it with the strongest baseline you CAN run (verified reference implementations and matched-resource controls appropriate to the objective) rather than blocking on the unobtainable one.",
        "for a public held-out requirement, emit the concrete fetch (source + accession) as a data_acquisition action, do not treat 'not yet fetched' as irrecoverable.",
        "an irrecoverable-blocker declaration MUST record which acquisition tiers were attempted and why each failed; a bare 'blocked, needs materialization' with no attempt is not acceptable.",
      ],
    },
    // YOU author both the blueprint script and the handoff check it reads, so you
    // are the only party that knows which columns the run will contain. Deciding
    // that is a judgment call about your own analysis — it is not something the
    // driver can pattern-match after the fact (it tried: guessing from
    // `procedural://` prefixes and `req=[...]` literals broke the moment a
    // blueprint named its dataset `procedural_mitsuba_*.csv` or declared its keys
    // as `cols = [...]`).
    column_mapping_contract: {
      requirement:
        "If your blueprint script reads `column_mapping` from the handoff check — in ANY form, e.g. a preflight that raises 'handoff check requires a non-empty column_mapping' or 'column_mapping missing semantic keys' — then the handoff check you emit MUST carry a `column_mapping` that satisfies that preflight: a list of {\"key\": <name the script reads>, \"column\": <dataset column>} pairs, which the script receives as the dict spec[\"column_mapping\"] = {key: column}. A script that blocks on a mapping you did not supply cannot run at all: it raises before the first measurement, produces no numbers, and the lane is recorded as failed.",
      how: [
        "Decide the mapping from YOUR OWN script: read the keys your preflight checks for, and map each to the column your code actually writes into its result frame.",
        "For a self-generated run (procedural experimental inputs, synthetic data, in-code parameter sweeps — regardless of how you spell the dataset name) the columns are the ones your script itself creates, so the mapping is the IDENTITY: {\"measurement\": \"measurement\", \"elapsed_time_s\": \"elapsed_time_s\", ...}. There is no external file whose headers need renaming.",
        "For a real external dataset, map each semantic key to that file's actual header.",
        "Keep the two sides in sync: every key the script requires must appear in the mapping under the SAME name the script asks for (do not require `regime` while the handoff declares `regime_id`).",
        "Simplest alternative, and usually better: if the frame is self-generated, drop the column_mapping precondition from the script and read your own columns directly. A precondition you do not satisfy is a self-inflicted failure, not a data problem.",
      ],
      also_emit:
        "Whichever route you take, list the columns your blueprint will emit as `emitted_columns: [...]` on the handoff check. That records your own intent and lets the runner recover the identity mapping if the mapping itself is ever lost in transit.",
    },
    // You author the blueprint, so you are the only party who knows which parts of
    // the lead's claim its checks actually touch. Nobody else can compare the two:
    // the director sees the claim, the runner sees the script, and the mismatch
    // surfaces for the first time at the gate — a full budget too late.
    //
    // Measured on cycle-g-v74: the blueprint produced a genuinely clean result
    // (adaptive vs uniform allocation, matched 24 spp against a 256-spp reference,
    // 2 scenes x 5 seeds, +0.84 dB on the high-variance scene and -0.19 dB on the
    // low-variance one — a real falsification boundary). The lead above it claimed
    // reuse/guiding under scene edits with ESS gating and crossover estimands. The
    // gatekeeper scored novelty 30 / technical_quality 12 / reproducibility 15 and
    // listed exactly the missing pieces. The experiment was fine; it had simply
    // been authored under a claim four sizes larger, and no contract asked.
    claim_coverage_contract: {
      requirement:
        "Break the lead's claim into its elements — each asserted effect, each compared baseline, each condition/regime it generalizes over, each metric it is asserted in — and map every element to the specific handoff_check / blueprint check that establishes it.",
      emit: {
        covered: "element -> check_id that actually establishes it",
        not_covered:
          "element -> why (baseline not runnable in this environment, metric not measurable with this setup, condition outside the available conditions/data, cost beyond the lane budget)",
        established_claim:
          "when not_covered is non-empty, state plainly the NARROWER claim this blueprint does establish, so the LabDirector can scope the lead to it",
      },
      rules: [
        "Do not author a smaller experiment under a bigger claim and leave the difference unsaid — an uncovered element does not disappear, it returns as the reviewer's blocker after the budget is spent.",
        "An honest partial coverage is a good outcome. A blueprint that appears to validate a claim it never tested is not.",
        "A falsification boundary is COVERAGE, not a gap: a condition where the method demonstrably loses establishes the claim's scope and belongs in `covered`.",
      ],
    },
    // The experiment has a wall clock, and until now nothing told the analyst so.
    // It designed a visibility-hazard prospective sweep (held-out AUC, multi-seed,
    // TINMSE/FLIP/latency/memory telemetry) and the driver gave it 240 seconds;
    // two runners on cycle-g-v74 died at exactly 240.3s. Feasibility cannot be
    // judged against a constraint nobody discloses, which is also why the
    // claim_coverage above could not have caught it.
    compute_budget_contract: {
      driver_wall_clock_seconds: 1500,
      default_per_blueprint_seconds: 240,
      requirement:
        "The whole handoff shares a ~1500s driver wall clock. A single blueprint may use nearly all of it; N blueprints split it. Size the sweep to that budget, or ask for what you need.",
      how: [
        "Declare `timeout_seconds` on the blueprint when your sweep needs more than the 240s default — a condition x repetition x method sweep may do so, depending on the measured cost per run. You are the only party that can estimate this.",
        "Prefer fewer, decisive conditions over a broad grid that cannot finish: a completed comparison with independent repetitions produces evidence; an oversized condition x repetition x method grid killed at timeout does not.",
        "If the design genuinely cannot fit, say so in `claim_coverage.not_covered` rather than authoring it anyway — a run killed at the wall produces no numbers at all, so the claim it was meant to support arrives at the gate unsupported.",
      ],
    },
    // Online-validation slice (data-quality checks + staleness), adapted to the
    // analyst contract. The correction-harvesting scheduled agent from the blog
    // is intentionally out of scope here — it is a separate operational feature.
    data_quality_freshness_policy: {
      requirement:
        "Before handoff, run a data-quality and freshness self-check on every referenced field and pin the dataset snapshot the resolution assumes.",
      checks: [
        "confirm each referenced column exists, is populated (not predominantly null), and matches the assumed unit/grain",
        "pin the dataset snapshot / version / extraction date the master table is built from, and record it in each provenance footer's freshness_or_snapshot",
        "flag any field whose source definition is stale or whose freshness is unknown as a quality risk, not silently",
      ],
    },
    analysis_loop: [
      {
        // Prior work comes first. Without it the estimator, the comparator and
        // the endpoint are invented per cycle, and the earliest anyone compares
        // them against the field is the gatekeeper scoring novelty -- after the
        // design is already executed.
        stage: "reference",
        question: "How has this quantity been measured before, what did that work compare against, and which endpoint did it report?",
        deliverables: [
          "reference methods: the estimator or design prior work used for this kind of question, each with the paper it comes from",
          "reference comparators: what that work treated as the baseline to beat",
          "reference endpoints: the quantity and unit it reported, and the threshold it called meaningful",
          "what this design takes from them and what it deliberately does differently, with the reason",
          "an explicit absence when the retrieved corpus holds no prior work for this question, naming what was searched",
        ],
        read_narrowly: [
          `${cycleStatePrefix}-literature-summary.json: read top_papers, and lanes[].claims for the families this hypothesis touches -- never the whole file`,
          `${cycleStatePrefix}-literature-graph.json: nodes and edges for the variables and mechanisms in this hypothesis`,
        ],
      },
      {
        stage: "ask",
        question: "What single validation question would most change the family ranking right now?",
        deliverables: ["target hypothesis", "estimand", "decision-changing comparison"],
      },
      {
        stage: "look",
        question: "What confounders, sample restrictions, and measurement risks matter for that check?",
        deliverables: ["adjustment set", "sample filters", "data assumptions", "falsification risks"],
      },
      {
        stage: "resolve",
        question: "Which single canonical column does each modeled concept resolve to, in source-of-truth trust order, and how fresh is each definition?",
        deliverables: ["canonical variable resolution table", "rejected near-duplicate candidates with reasons", "unresolved concepts flagged as blockers", "per-resolution provenance footer", "staleness flags"],
      },
      {
        stage: "master-table",
        question: "What single analysis master table must exist before the hypothesis is tested?",
        deliverables: ["row grain", "join keys", "required columns", "group labels", "covariates", "exclusion rules", "output path"],
      },
      {
        // Choosing the workflow is a method decision and stays here. Making it
        // run is not: acquiring a tool, building it, repairing its config and
        // proving it executes on this machine belong to the engineer, whose lane
        // exists so that a design is not quietly reshaped by whatever happened to
        // install. This stage therefore names the requirement and stops.
        stage: "capability-requirement",
        question: "What must exist and actually run on this machine before this design can be executed, and which of that already does?",
        deliverables: [
          "capability_requirements: each runtime, tool or workflow this design needs, each naming the step of the design that needs it",
          "which requirements the recorded instrument inventory already satisfies, citing the measurement",
          "selected workflow, or an explicit rejection naming the replacement method and why",
          "the input contract that workflow must accept and the outputs it must produce",
          "repository_workflow_compatibility_decision when a prior runner blocker repeated: whether the method survives, not how to repair the command",
        ],
        hand_to: "engineer",
        // The requirement is stated, never satisfied here. An analyst that
        // installs its own way around a blocker has changed the experiment
        // without anyone deciding to.
        not_this_stage: [
          "installing, cloning, building or configuring anything",
          "repairing a failed command, dependency or path",
          "declaring a capability available without a recorded run behind it",
        ],
      },
      {
        stage: "design",
        question: "What executable model specification should the lab-runner implement?",
        deliverables: ["handoff check", "model family", "fixed effects", "success/failure criteria"],
      },
      {
        stage: "prototype",
        question: "What concrete validation code blueprint should be generated for the check?",
        deliverables: ["language choice", "entrypoint", "code blueprint", "execution notes"],
      },
      {
        stage: "self-review",
        question: "Adversarially challenge the design: which concept-to-column resolution is most likely wrong, what assumption would overturn the result, and why is the code still trustworthy enough to hand off?",
        deliverables: ["self-review verdict", "adversarial challenge of the weakest variable resolution", "assumption checks", "failure modes", "requested revisions if any"],
      },
    ],
    code_generation_protocol: {
      requirement:
        "generate a pre-validation master-table blueprint plus at least one validation-code blueprint in Python or equivalent analysis language that directly implements one handoff_check",
      blueprint_rules: profile.blueprintRules || [],
      self_review_rules: [
        "review the code against the stated estimand and adjustment set",
        "name the biggest identification or data-quality risks",
        "say whether the blueprint is approved for handoff or needs revision",
      ],
    },
    required_output: [
      "reference_basis: for the estimator, the comparator and the endpoint this design chooses, the prior work each is drawn from and what this design does differently -- or an explicit statement that the retrieved corpus holds none, naming what was searched. A design that cites nothing and says nothing about why is not finished",
      "canonical variable resolution table: each modeled concept mapped to exactly one canonical column, with rejected near-duplicate candidates and reasons, source tier, and freshness",
      "provenance footers on every variable resolution and claim (source_tier, dataset_or_definition_id, freshness_or_snapshot, owner_if_known)",
      "candidate primary variable families",
      "candidate mechanisms and estimands",
      "rival DAGs",
      "mediators vs confounders vs competing exposures",
      "negative controls and falsification ideas",
      "evidence gaps that could overturn the incumbent family",
      "analysis lane proposals for the most decision-changing validation work",
      "validation-data availability assessment with dataset/accession/bundle path and variable-mapping blockers",
      "analysis_master_table contract with row grain, join keys, required columns, group label construction, covariates, exclusion rules, output path, and quality checks",
      "capability_requirements: every runtime, tool or workflow this design needs in order to run, each with the design step that needs it and whether the measured instrument inventory already satisfies it. This is the engineer's work order; a design whose requirements are unstated cannot be provisioned for",
      "repository-native workflow compatibility decision with the selected workflow or an explicit rejection/waiver and replacement method",
      "repository_workflow_compatibility_decision.json contents when a prior workflow blocker repeated",
      "validation code blueprint with execution notes",
      "claim_coverage map (covered / not_covered / established_claim) tying each element of the lead's claim to the check that establishes it",
      "per-candidate-hypothesis falsification battery (>= 2 explicit executable falsification tests attached to each hypothesis) plus a methodological_rigor self-score (0-100) with justification, targeting the gate's falsification, method-validation, and reproducibility blockers",
      "declared analyst_quality_standard with pinned, gate-checkable acceptance criteria",
      "self_evaluation reporting each acceptance criterion and the achieved canonical_resolution_rate against target",
      "data quality and freshness self-check with the pinned dataset snapshot and any staleness/quality flags",
      "self-review of the proposed validation code",
    ],
    pre_validation_master_table_gate: {
      required: true,
      gate_id: "analysis_master_table_gate",
      required_check_id: "analysis_master_table_created",
      required_artifact_name_pattern: "master_table",
      must_run_before_hypothesis_validation: true,
      handoff_field: "analysis_master_table",
      rationale:
        "Hypothesis validation must be run against one explicit analysis-ready master table, not ad hoc joins inside the final test.",
    },
    library_documentation_policy: {
      requirement:
        "when the analysis design depends on the behaviour of a specific library, consult that library's own primary documentation before proposing code-heavy methods",
      source_rule:
        "the libraries available here are a measured fact, not an assumption: read the recorded instrument inventory and the engineering capability record for what is installed and verified, and name a library the design needs but that is absent as a capability requirement rather than assuming it",
      usage_rules: [
        "prefer primary documentation over blog posts or recollection",
        "cite the library or API section in analyst reasoning when it materially affects method choice",
        "use documentation to validate function semantics, model assumptions, and edge-case behavior before proposing implementation details",
      ],
    },
    next_cycle_context: cyclePlanningContext?.next_cycle_plan || null,
    data_kg_digest: cyclePlanningContext?.data_graph_digest || null,
    // Pinned semantic/canonical tier the sources_of_truth_policy resolves
    // against first. Null on cycles with no data graph yet.
    canonical_reference: canonicalReference,
    queries: dedupe([...priorityQueries, ...queries]).slice(0, 16),
  };
}

module.exports = {
  buildAnalystQueryPlan,
};
