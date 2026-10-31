use serde_json::{json, Value};
use std::env;

// Legacy defaults remain for old role plans. New plans attach a model_route:
// Luna handles short routine work, Terra structured execution, Sol synthesis
// and falsification, and Astra at most two decisive hypothesis decisions per
// cycle. External-driver / native-readonly bypass model routing.
//
// The exact model id strings depend on RESEARCHLAB_AGENT_RUNTIME so the
// supervisor's runtime-created followup lanes ship the same provider as
// the JS-side initial agent plan (codex catalogue vs claude catalogue).
// These MUST stay in sync with src/agents/lab_director/agent_plan.js.
pub(crate) const CODEX_LAB_DIRECTOR_MODEL: &str = "gpt-6.1-sol";
pub(crate) const CODEX_DEFAULT_AGENT_MODEL: &str = "gpt-6.1-sol";
pub(crate) const CODEX_ANALYST_MODEL: &str = "gpt-6.1-sol";
pub(crate) const CODEX_LAB_RUNNER_MODEL: &str = "gpt-6.1-terra";
pub(crate) const CODEX_ASTRA_MODEL: &str = "gpt-6-astra";
pub(crate) const CODEX_TERRA_MODEL: &str = "gpt-6.1-terra";
pub(crate) const CODEX_LUNA_MODEL: &str = "gpt-6-luna";

pub(crate) const CLAUDE_LAB_DIRECTOR_MODEL: &str = "claude-opus-4-7";
pub(crate) const CLAUDE_DEFAULT_AGENT_MODEL: &str = "claude-sonnet-4-6";
pub(crate) const CLAUDE_LAB_RUNNER_MODEL: &str = "claude-sonnet-4-6";

pub(crate) const EXTERNAL_DRIVER_MODEL: &str = "python-external-driver";
pub(crate) const NATIVE_READONLY_MODEL: &str = "native-readonly-runtime";

pub(crate) const PLANNING_ONLY_SCOPE: &str = "planning-only";

/// What the field is stuck on, and what has been proposed against it.
///
/// Required of EVERY director lane, not only the first. These clauses used to
/// sit inline in the base task string, which reaches `lab-director-01` and
/// nothing else -- and every director lane a running cycle dispatches is a
/// follow-up. Measured: cycle-g-v90 and cycle-g-v91 produced no
/// research-trend-analysis.json at all, while v89's best gate review scored
/// novelty 66 against an "incompletely audited" prior-art picture the cycle had
/// no artifact to hold.
///
/// Same failure as `chronicle_literature_relevance_contract`, found the same
/// way: read what a dispatched lane actually received rather than the source
/// that looks like it says so.
pub(crate) fn research_trend_survey_directive(cycle_id: &str) -> String {
    format!("- research_trend_mapping_stage: BEFORE proposing any hypothesis, survey the field from Chronicle's compact trend/digest summary, and survey it as PROBLEMS and METHODS rather than as topics. A topic label says what people write about; it does not say what they are stuck on, and a hypothesis that does not answer an open problem cannot be novel however new its wording is. Two questions, both answered concretely: (1) WHICH PROBLEMS is this field currently trying to solve -- stated as a problem, with the quantity that would settle it, why it is still open, and who says so; (2) WHAT METHODS are being proposed against each problem -- what each one actually does differently, what it claims to improve, against which baseline, on what evaluation, and the limitation its own authors state. Name every problem and method from papers you can cite, never from what the field is generally understood to care about. Alongside these, record where attention is concentrated, which datasets and baselines recur, live controversies, and gaps nobody is working. Do not load full graphs for this; request a Chronicle digest refresh if the summary is insufficient, and say so rather than filling the fields from memory.\n- research_trend_artifact: write .research-lab/state/{}-research-trend-analysis.json before the hypothesis artifact. It must contain `dominant_clusters`, `attention_concentration`, `rising_methods`, `repeated_datasets`, `saturated_baselines`, `underexplored_gaps`, `selection_implications`, `paper_ids_by_cluster`, and the two that carry the survey itself: `open_problems[]` with `problem` (stated as what is not yet achievable, not as a topic), `why_open`, `decisive_quantity` (what measurement would settle it), `paper_ids` (papers that state it), and `status` (contested | consolidating | stalled); and `proposed_methods[]` with `method`, `addresses_problem` (an entry in open_problems), `what_it_does_differently`, `claimed_improvement`, `compared_against`, `evaluated_on`, `stated_limitation`, and `paper_ids`. Every entry in both lists must carry at least one paper_id drawn from the admitted corpus, which reaches you as `role_plan.planner_metadata.chronicle_decision_digest.citable_corpus` -- both evidence tracks, each paper with the id the screening gate itself validated. Cite those ids verbatim; an id you compose will not match anything downstream; an entry you cannot attribute is an impression, and it belongs in `unattributed_impressions[]` where a reviewer can see it was not evidence. If the corpus cannot support this survey, emit the lists you can support and state the shortfall in `survey_coverage_gaps[]` rather than padding either list.", cycle_id)
}

pub(crate) fn research_scope_blocks_role(scope: Option<&str>, role: &str) -> bool {
    scope
        .map(str::trim)
        .map(|value| value.eq_ignore_ascii_case(PLANNING_ONLY_SCOPE))
        .unwrap_or(false)
        && role == "lab-runner"
}

pub(crate) fn planning_only_scope_blocks_role(role: &str) -> bool {
    research_scope_blocks_role(env::var("RESEARCHLAB_RESEARCH_SCOPE").ok().as_deref(), role)
}

fn agent_runtime_label() -> &'static str {
    match env::var("RESEARCHLAB_AGENT_RUNTIME")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("claude") => "claude",
        _ => "codex",
    }
}

pub(crate) fn lab_director_agent_model() -> &'static str {
    if agent_runtime_label() == "claude" {
        CLAUDE_LAB_DIRECTOR_MODEL
    } else {
        CODEX_LAB_DIRECTOR_MODEL
    }
}

pub(crate) fn default_agent_model() -> &'static str {
    if agent_runtime_label() == "claude" {
        CLAUDE_DEFAULT_AGENT_MODEL
    } else {
        CODEX_DEFAULT_AGENT_MODEL
    }
}

pub(crate) fn analyst_agent_model() -> &'static str {
    if agent_runtime_label() == "claude" {
        CLAUDE_DEFAULT_AGENT_MODEL
    } else {
        CODEX_ANALYST_MODEL
    }
}

pub(crate) fn lab_runner_agent_model() -> &'static str {
    if agent_runtime_label() == "claude" {
        CLAUDE_LAB_RUNNER_MODEL
    } else {
        CODEX_LAB_RUNNER_MODEL
    }
}

pub(crate) fn assigned_model_parameter(role: &str, runtime_class: &str) -> &'static str {
    match (role, runtime_class) {
        ("lab-director", _) => lab_director_agent_model(),
        ("lab-runner", _) => lab_runner_agent_model(),
        ("analyst", _) => analyst_agent_model(),
        ("scout", "native-readonly") => NATIVE_READONLY_MODEL,
        ("scout", "external-driver") => EXTERNAL_DRIVER_MODEL,
        (_, "external-driver") => EXTERNAL_DRIVER_MODEL,
        _ => default_agent_model(),
    }
}

/// The route of a Codex literature scout converted from an approved scholarly
/// data follow-up. It is routed like any reasoning literature scout.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18. These scouts were pinned to
/// Luna at low effort. followup-scout-43 and -46 read the review queue's
/// top-level `abstract` (absent; the text is under `paper.abstract`), concluded
/// all 102 abstracts were missing and reviewed none. The Sol scouts of the same
/// cycle found and read all 163.
pub(crate) fn literature_scout_model_route() -> Value {
    model_route_parameter(
        "scout",
        "codex-agent",
        "reasoning_literature_scout",
        "approved scholarly literature scout",
        0,
        0,
        false,
        false,
        CODEX_DEFAULT_AGENT_MODEL,
    )
}

pub(crate) fn model_route_parameter(
    role: &str,
    runtime_class: &str,
    action_type: &str,
    task_text: &str,
    estimated_prompt_bytes: usize,
    candidate_count: usize,
    allow_astra: bool,
    // The cycle has not chosen a lead yet, so this is the decision every later
    // round is built on.
    opening_decision: bool,
    legacy_assigned_model: &str,
) -> Value {
    // Route from the requested operation only. `action_type` is a
    // system-generated identifier, so it reads the same whatever language the
    // objective is written in; matching prose meant an objective in an
    // unlisted language scored as routine and was silently downgraded.
    let routing_task = action_type.to_ascii_lowercase();
    let unknown_action = routing_task.trim().is_empty();
    let _ = task_text;

    if runtime_class == "external-driver"
        || runtime_class == "native-readonly"
        || legacy_assigned_model == EXTERNAL_DRIVER_MODEL
        || legacy_assigned_model == NATIVE_READONLY_MODEL
    {
        return json!({
            "model": legacy_assigned_model,
            "reasoning_effort": "none",
            "route_reason": "non-Codex runtime bypasses language-model routing",
            "route_version": "codex-tier-router-v1",
            "fallback_chain": [],
        });
    }
    if !legacy_assigned_model.starts_with("gpt-") {
        return json!({
            "model": legacy_assigned_model,
            "reasoning_effort": "none",
            "route_reason": "provider-specific runtime preserves its assigned model",
            "route_version": "codex-tier-router-v1",
            "fallback_chain": [],
        });
    }

    // Fragments of the action identifiers this runtime emits. A chronicle
    // arguing a gate ("deliberation") is doing science, not summarising it, and
    // scored as routine until it was listed here.
    const REASONING_ACTIONS: &[&str] = &[
        "hypothesis",
        "novelty",
        "falsif",
        "adjudicat",
        "deliberat",
        "pivot",
        "gate_restart",
        "confound",
        "comparison",
        "recovery_followup",
        "reasoning_literature",
        // Resuming a search is the same work as the search: read what the saved
        // assessment still lacks and design the inquiry that closes it. Routed as
        // routine, cycle-b-20260917i's six resume scouts each took the cheap
        // tier, copied the artifacts, re-validated and returned in about eighty
        // seconds, adding no round and no paper.
        "adaptive_search",
        "abstract_review",
        "experiment",
        // Running the LabDirector's simulation order exactly as ordered --
        // conditions, seeds, budget, emitted columns -- and returning a blocker
        // instead of a substitute is not routine copying.
        "simulation_data_generation",
        // Mapping a whole field -- naming each subfield's canonical and frontier
        // work, verifying it, and attributing open problems -- is the survey every
        // later decision is chosen from (field_landscape_scout; see
        // labdirector::field_landscape).
        "landscape",
        // Reading a SOTA paper in full and deciding which component carries its
        // gain, which ablation is missing and what the field takes for granted
        // (sota_deep_read; see labdirector::sota_cards).
        "deep_read",
    ];
    // An action nobody classified is treated as reasoning work. A cheap model on
    // an unknown task is the failure that leaves no trace.
    let complex = unknown_action
        || REASONING_ACTIONS
            .iter()
            .any(|needle| routing_task.contains(needle));
    let decisive = ["decisive", "tournament", "final_adjudication"]
        .iter()
        .any(|needle| routing_task.contains(needle));
    let candidate_synthesis = ["hypothesis", "novelty"]
        .iter()
        .any(|needle| routing_task.contains(needle))
        && ["generation", "strategy", "tournament", "adjudication"]
            .iter()
            .any(|needle| routing_task.contains(needle));
    // The opening hypothesis and research direction take the top tier. Everything
    // downstream is built on that choice, so it is the decision where a cheaper
    // model costs the most. The old rule required three candidates to compare,
    // which the opening decision does not have yet, so it excluded precisely the
    // case it should have covered.
    let opening_direction = opening_decision && role == "lab-director" && complex;
    let astra_eligible = allow_astra
        && matches!(role, "lab-director" | "gatekeeper")
        && complex
        && (opening_direction
            || (role == "lab-director" && candidate_synthesis && candidate_count >= 3)
            || decisive);

    let mut model = if astra_eligible {
        CODEX_ASTRA_MODEL
    } else {
        match role {
            // Routine work for these roles takes the floor; complex work for the
            // SAME roles used to fall through to TERRA, the execution tier, which
            // downgraded them exactly when reasoning was wanted.
            "scout" | "chronicle" | "author" | "illustrator" => {
                if complex {
                    CODEX_DEFAULT_AGENT_MODEL
                } else {
                    CODEX_LUNA_MODEL
                }
            }
            "lab-runner" => CODEX_TERRA_MODEL,
            // Provisioning is execution work and takes the execution tier, but a
            // build that fails is read, not re-run: a linker error, a missing
            // system library or an incompatible ABI is diagnosis, so complex
            // engineer work rises the way the reasoning roles do.
            "engineer" if complex => CODEX_DEFAULT_AGENT_MODEL,
            "engineer" => CODEX_TERRA_MODEL,
            "analyst" | "gatekeeper" if complex => CODEX_DEFAULT_AGENT_MODEL,
            "lab-director" if complex => CODEX_LAB_DIRECTOR_MODEL,
            "analyst" | "gatekeeper" | "lab-director" => CODEX_DEFAULT_AGENT_MODEL,
            _ => CODEX_TERRA_MODEL,
        }
    };
    let length_band = if estimated_prompt_bytes > 160_000 {
        "long"
    } else if estimated_prompt_bytes > 32_000 {
        "medium"
    } else {
        "short"
    };
    if estimated_prompt_bytes > 160_000 && model == CODEX_LUNA_MODEL {
        model = CODEX_TERRA_MODEL;
    }
    if estimated_prompt_bytes > 160_000 && complex && model == CODEX_TERRA_MODEL {
        model = CODEX_DEFAULT_AGENT_MODEL;
    }
    let reasoning_effort = if model == CODEX_ASTRA_MODEL {
        "xhigh"
    } else if model == CODEX_DEFAULT_AGENT_MODEL {
        "high"
    } else if model == CODEX_TERRA_MODEL {
        "medium"
    } else {
        "low"
    };
    let fallback_chain = match model {
        CODEX_ASTRA_MODEL => json!([
            CODEX_DEFAULT_AGENT_MODEL,
            CODEX_TERRA_MODEL,
            CODEX_LUNA_MODEL
        ]),
        CODEX_DEFAULT_AGENT_MODEL => json!([CODEX_TERRA_MODEL, CODEX_LUNA_MODEL]),
        CODEX_TERRA_MODEL => json!([CODEX_LUNA_MODEL]),
        _ => json!([]),
    };
    let route_reason = if astra_eligible {
        format!("reserved Astra route for procedure-distinct hypothesis synthesis or decisive adjudication; {length_band} prompt")
    } else {
        format!("role/action complexity route; {length_band} prompt; complex={complex}")
    };
    json!({
        "model": model,
        "reasoning_effort": reasoning_effort,
        "route_reason": route_reason,
        "route_version": "codex-tier-router-v1",
        "fallback_chain": fallback_chain,
        "astra_eligible": astra_eligible,
    })
}

fn analyst_cycle_question(_objective: &str) -> &'static str {
    // Kept domain-neutral: the analyst must derive its own hypothesis families
    // from the objective and whatever datasets are actually available in the
    // current cycle, rather than inheriting a hardcoded template.
    "For the current cycle pass, derive the strongest currently testable hypothesis family from the stated objective and the datasets actually available in this cycle, then return exactly one executable validation handoff for lab-runner."
}

// Whether the DATA is large enough to need a specialised workflow.
//
// This is what the mandatory-discovery rule actually depended on, and it is a
// property of the data, not of the field. The predicate it replaces mixed the
// two: eighteen of its twenty-two terms named one field's assays and archives,
// so "is this large-scale" was answered by "is this biology".
fn objective_indicates_large_scale_data(objective: &str) -> bool {
    let lowered = objective.to_ascii_lowercase();
    [
        "high-throughput",
        "high throughput",
        "high-dimensional",
        "high dimensional",
        "large-scale",
        "large scale",
        "at scale",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

// Domain-appropriate external-repository search targets for the open-source
// analysis-agent discovery policy.
// Where to look for something reusable, in any field.
//
// This matched a domain label to one of three lists, and two of them named that
// field's own repositories and packages. The third -- the one every field
// nobody had listed received -- says the same thing without naming anything,
// which is why it is now the only one.
fn open_source_search_targets() -> Value {
    json!([
        "same-task or same-benchmark repositories and supplementary code from the papers this cycle retrieved",
        "open-source agents, pipelines and workflow repositories matching the task modality",
        "package indexes and system packages carrying task-specific analysis, simulation or rendering workflows",
        "maintained benchmark suites, reference datasets and workflow catalogues this objective's own field uses",
    ])
}

/// Is external-tool discovery required for this lane, and for which reason?
///
/// Two producers set this flag -- the follow-up role plan and the pre-launch
/// refresh -- and both wrote `true` whenever a mandate merely EXISTED. That is
/// a different claim from the mandate's own `mandatory`, so a lane could be told
/// discovery was required while the mandate riding beside it said it was not.
/// The contradiction reached every cycle whose data did not trigger the mandate.
///
/// Two reasons, kept apart because they are different facts: the DATA is large
/// enough that ad hoc analysis code is the wrong answer, or a lab-runner has
/// already FAILED on the selected tool, which implicates the tool whatever the
/// data's scale.
pub(crate) fn open_source_discovery_requirement(
    mandate: &Value,
    recovering_from_runner_failure: bool,
) -> (bool, &'static str) {
    let scale_requires = mandate
        .get("mandatory")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if recovering_from_runner_failure {
        (
            true,
            "a lab-runner failed on the selected tool, so the tool is implicated whatever the data's scale",
        )
    } else if scale_requires {
        (
            true,
            "the data is large enough that ad hoc analysis code is the wrong answer",
        )
    } else {
        (
            false,
            "not required: neither the data's scale nor a runner failure implicates an external tool",
        )
    }
}

pub(crate) fn open_source_analysis_agent_policy(
    mandatory: bool,
    detection_reasons: &[String],
) -> Value {
    let search_targets = open_source_search_targets();
    // What used to be four mutually exclusive rules -- one naming omics
    // pipelines, one naming renderers, one for the fields nobody listed, and an
    // empty string for whichever did not apply. The surviving rule is the one
    // that was written for the unlisted fields, because it is the only one that
    // states the requirement rather than the field: discover the tool the
    // objective actually names, and do not let a local adapter stand in for it.
    let tool_discovery_rule = json!(
        "When the objective, the retrieved literature or the verified inventory names a specific external tool, engine, workflow or benchmark, discovering it is mandatory: search for it, compare the candidates, and either select one or reject it with reasons. A local generic adapter, a package import check or a repository inventory is only an auxiliary fallback and by itself satisfies neither the selection nor the gate. When the data is high-dimensional or large-scale, compare the specialised workflows that exist for it before writing ad hoc analysis code."
    );
    json!({
        "active": true,
        "mandatory": mandatory,
        "priority": if mandatory { "critical" } else { "high" },
        "detection_reasons": detection_reasons,
        "must_run_before": [
            "dataset_profile",
            "validation_design_candidates",
            "handoff_checks",
            "validation_code_blueprints",
        ],
        "search_targets": search_targets,
        "download_and_apply_protocol": [
            "For each high-fit repository candidate, download or clone it into a scratch/tool cache path such as `.research-lab/tools/<cycle_id>/<tool_slug>` or an equivalent temporary directory; do not vendor external repos into ResearchLab source control.",
            "Inspect README, LICENSE, examples/config files, entrypoints, dependency manifests, and expected input/output formats before recommending reuse.",
            "Run only a lightweight verification such as `--help`, import check, or dry-run config parse when dependencies permit; if imports fail, record missing dependencies instead of pretending the tool ran.",
            "For config-driven agents or workflow engines, generate or adapt the required config file from the selected dataset paths and hypothesis goal, then put the exact command, dependencies, credential/runtime requirements, and fallback plan into the analyst handoff.",
            "Only execute a heavy pipeline through lab-runner when its license, dependencies, credentials, hardware requirements, runtime budget, and dataset privacy constraints are satisfied."
        ],
        "debug_and_apply_protocol": [
            "The analyst handoff must give lab-runner enough detail to run or smoke-test the selected tool: local_path, setup commands, smoke_test_command, application_command, expected_outputs, and failure_interpretation.",
            "When smoke_test_command and application_command are present for the selected open-source analysis agent, lab-runner executes them before validation_code_blueprints and records stdout, stderr, return code, and output_dir in external_agent_runs.",
            "For mandatory high-dimensional or large-scale work, application_command must do more than inventory the repository or profile CSV columns: it must invoke a repository-native workflow, skill, CLI, or domain package function on the selected dataset and leave hypothesis-relevant outputs such as result.json, figures, tables, or a workflow report.",
            "If lab-runner fails because the selected repository workflow cannot consume the dataset, read failed_runner_context, stderr_excerpt, returncode, script_path, analyst_handoff and the selected tool metadata, and separate the two kinds of failure before acting. A path, config, dependency, environment-variable, command-flag or build failure is an ENGINEER responsibility: state it as a capability requirement and let an engineer lane provision and verify it, rather than repairing it inside a design lane. What is yours is the METHOD: repair the column mapping, derive a scientifically faithful modality-specific feature table when the workflow contract can represent the estimand, or choose a compatible workflow or domain package. Never substitute a tool because it was the one that happened to install -- that changes the experiment and is your decision to make explicitly.",
            "Prefer small fixes first, and route each to the role that owns it: path/config correction, missing dependency declaration, environment variable wiring and command flag correction go to the engineer; schema/column mapping repair and falling back to a simpler compatible workflow are method decisions and stay here.",
            "If the external tool still cannot run after the engineer reports a blocker, explicitly reject it and produce a self-contained validation blueprint that preserves the scientific method choice learned from the tool review."
        ],
        "selection_rule": "Before designing the analysis, search for reusable open-source analysis agents, pipelines, or maintained tool repositories that match the dataset modality, scale, and identification strategy. Prefer tools tied to the same dataset/paper or a directly comparable benchmark. Select one only if its license, inputs, assumptions, and outputs are compatible with the current handoff; otherwise record why each candidate was rejected.",
        "reuse_rule": "If a compatible agent or pipeline exists, adapt its preprocessing/modeling choices or package dependencies in validation_code_blueprints and cite it in open_source_agent_discovery. Keep generated runner code self-contained unless the dependency is explicitly declared and installable.",
            "tool_discovery_rule": tool_discovery_rule,
        "hardcoding_guard": "Do not hardcode AutoBA or any single repository name. Generate search terms from the dataset modality, platform, identifier, analysis goal, and identification strategy; then compare the best candidates found at runtime.",
        "required_output_fields": [
            "open_source_agent_discovery",
            "selected_open_source_analysis_agent",
            "open_source_agent_discovery.candidates[*].download_command",
            "open_source_agent_discovery.candidates[*].local_path",
            "open_source_agent_discovery.candidates[*].smoke_test_command",
            "open_source_agent_discovery.candidates[*].application_command",
            "open_source_agent_discovery.candidates[*].debug_attempts",
            "selected_open_source_analysis_agent.smoke_test_command",
            "selected_open_source_analysis_agent.application_command",
            "validation_code_blueprints[*].dependencies",
            "validation_code_blueprints[*].execution_notes",
            "self_review.assumption_checks",
        ],
    })
}

pub(crate) fn initial_analyst_role_plan(agent: &Value, objective: &str) -> Value {
    let lane_id = agent["agent_id"].as_str().unwrap_or("unknown");
    let is_primary_selector = lane_id.ends_with("-01");
    // The seed plan is intentionally domain-neutral: analyst-01 picks one
    // incumbent candidate derived from the prompt + discovered datasets;
    // analyst-02 generates rival candidates against whatever incumbent ends
    // up being proposed. No hardcoded domain families — every template item
    // tells the analyst to derive the candidate set from the objective and
    // from the evidence collected so far in this cycle.
    let analysis_goal = if is_primary_selector {
        "Read the stated objective and the datasets/papers collected so far in this cycle, derive the strongest currently testable incumbent hypothesis family, then emit one baseline executable handoff check for lab-runner."
    } else {
        "Read the stated objective, the current incumbent candidate (if any), and the collected evidence so far, then generate at least two distinct rival hypothesis families and emit one executable handoff check per rival. Do not default to any pre-existing domain template."
    };
    let candidate_family_instructions = if is_primary_selector {
        json!([
            {
                "guideline": "Do not assume any specific scientific domain — the family must fall out of the objective and the evidence bundle present in this cycle's state.",
                "required_fields": ["family_root", "why_competitive", "supporting_evidence_reference", "priority"]
            },
            {
                "guideline": "If no evidence bundle exists yet, emit one exploratory family that names the datasets/queries the analyst believes the scout should chase next.",
                "required_fields": ["family_root", "why_competitive", "priority"]
            }
        ])
    } else {
        json!([
            {
                "guideline": "Rival families must come from the objective and the current evidence snapshot; do not replay a prior cycle's families.",
                "required_fields": ["family_root", "why_competitive", "supporting_evidence_reference", "priority"]
            },
            {
                "guideline": "At least one rival must be structurally distinct from the incumbent (different exposure, different mechanism, or different measurement channel).",
                "required_fields": ["family_root", "distinct_axis_vs_incumbent", "priority"]
            }
        ])
    };
    // Guidance for the analyst's derived-indicator synthesis step. These
    // instructions are read at prompt time alongside dataset_bundle column
    // profiles and the knowledge graph digest.
    let derived_indicator_guidance = json!({
        "requirement": "propose new columns (ratios, deltas, z-scores, interactions, residuals, composites, rolling/lag features, subgroup gaps) whenever the hypothesis cannot be tested with raw columns alone",
        "selection_rules": [
            "Every derived indicator must name its source_columns and a concrete formula that the validation-code blueprint can compute.",
            "Prefer indicators that (a) sharpen identification of the primary hypothesis, (b) close an evidence_gap surfaced by the knowledge graph, or (c) let the analysis contrast rival family predictions head-to-head.",
            "Skip derived indicators that merely rescale a column without adding information (e.g., unit conversions), unless the estimand demands it.",
            "If the dataset genuinely has no useful derivation beyond raw columns, emit an empty list and cite the reason in evidence_gaps."
        ],
        "knowledge_graph_signals_to_consider": [
            "named exposure/outcome pairs already asserted by the reasoning_graph or data_graph",
            "confounder candidates listed in the graph",
            "mechanism nodes that suggest a composite indicator (e.g., inequality, access, timing)",
            "edges marked as unresolved or contested"
        ]
    });
    // Mandatory when the data is large enough that ad hoc code is the wrong
    // answer -- not when the objective's words match one field's vocabulary.
    let discovery_mandatory = objective_indicates_large_scale_data(objective);
    let discovery_reasons = if discovery_mandatory {
        vec!["objective_indicates_large_scale_data".to_string()]
    } else {
        Vec::new()
    };
    let open_source_agent_policy =
        open_source_analysis_agent_policy(discovery_mandatory, &discovery_reasons);
    json!({
        "lane_id": lane_id,
        "role": "analyst",
        "source": "initial-cycle-plan",
        "objective": objective,
        "analysis_goal": analysis_goal,
        "assigned_model": assigned_model_parameter("analyst", "external-driver"),
        // Explicit empty list so downstream consumers never misread a stale
        // template — the analyst must populate this from the objective.
        "candidate_primary_families": json!([]),
        "candidate_family_instructions": candidate_family_instructions,
        // The derived-indicator field is authored by the analyst; start empty.
        // Having the key present on the initial plan signals the obligation.
        "derived_indicators": json!([]),
        "derived_indicator_instructions": derived_indicator_guidance,
        "open_source_analysis_agent_discovery": open_source_agent_policy.clone(),
        "planner_metadata": {
            "initial_lane": true,
            "require_executable_handoff": true,
            "require_derived_indicator_pass": true,
            "require_open_source_analysis_agent_discovery": true,
            "open_source_analysis_agent_mandate": open_source_agent_policy,
            "question_mode": if is_primary_selector { "single-check" } else { "rival-checks" },
            "analysis_mode": if is_primary_selector { "incumbent_selection" } else { "rival_family_ranking" },
            "minimum_handoff_checks": if is_primary_selector { 1 } else { 2 },
            "derive_families_from_objective": true,
            "forbid_hardcoded_domain_templates": true
        }
    })
}

pub(crate) fn initial_lab_runner_role_plan(agent: &Value, objective: &str) -> Value {
    let lane_id = agent["agent_id"].as_str().unwrap_or("unknown");
    // Previously each lab-runner was hardcoded to a specific analyst + check
    // id (e.g. "confound_control_immunization_coverage_01"), which forced
    // every cycle — regardless of prompt — into an immunization-research
    // shape. Now the plan names an analyst source and an assigned slot, and
    // the actual check id is resolved at runtime from whatever that analyst
    // emits during its handoff. lab-runner-01 takes the incumbent baseline,
    // lab-runner-02/03 take rival-family checks, lab-runner-04 reruns one of
    // them for robustness. The specific domain falls out of the analyst's
    // output, not this template.
    let (assigned_handoff_source, handoff_slot, analysis_goal) = match lane_id {
        "lab-runner-01" => (
            "analyst-01",
            "primary_incumbent_baseline",
            "Execute the incumbent baseline validation check that analyst-01 emits this cycle — resolve the specific check_id from analyst-01's handoff payload.",
        ),
        "lab-runner-02" => (
            "analyst-02",
            "primary_rival_family",
            "Execute the highest-priority rival-family validation check that analyst-02 emits this cycle.",
        ),
        "lab-runner-03" => (
            "analyst-02",
            "secondary_rival_family",
            "Execute the second-priority rival-family validation check that analyst-02 emits this cycle.",
        ),
        "lab-runner-04" => (
            "analyst-02",
            "robustness_rerun",
            "Rerun one of analyst-02's rival-family validation checks with a robustness variation (different sample filter, estimator, or outcome proxy).",
        ),
        _ => (
            "analyst-01",
            "current_analyst_handoff",
            "Execute whichever handoff check the assigned analyst has most recently emitted.",
        ),
    };
    json!({
        "lane_id": lane_id,
        "role": "lab-runner",
        "source": "initial-cycle-plan",
        "objective": objective,
        "analysis_goal": analysis_goal,
        "assigned_model": assigned_model_parameter("lab-runner", "external-driver"),
        "planner_metadata": {
            "initial_lane": true,
            "assigned_handoff_source": assigned_handoff_source,
            "handoff_slot": handoff_slot,
            // The concrete check_id is resolved from the assigned analyst's
            // handoff payload at dispatch time — this template does not bind
            // a specific domain.
            "assigned_handoff_check_id": null,
            "require_analyst_handoff": true,
            "forbid_hardcoded_domain_templates": true
        }
    })
}

pub(crate) fn initial_data_scout_role_plan(agent: &Value, objective: &str) -> Value {
    let lane_id = agent["agent_id"].as_str().unwrap_or("unknown");
    json!({
        "lane_id": lane_id,
        "role": "scout",
        "source": "initial-cycle-plan",
        "objective": objective,
        "action_type": "data_acquisition_followup",
        "followup_description": "Search for open, downloadable datasets that can support the current research objective. Materialise the strongest tabular bundle under the cycle dataset directory for analyst validation.",
        "assigned_model": assigned_model_parameter("scout", "external-driver"),
        "planner_metadata": {
            "initial_lane": true,
            "preferred_role": "scout",
            "source_discovery_mode": "initial-open-data-search",
            "selection_scope": "objective-conditioned-data-search",
            "forbid_hardcoded_domain_templates": true
        }
    })
}

pub(crate) fn initial_gatekeeper_role_plan(agent: &Value, objective: &str) -> Value {
    let lane_id = agent["agent_id"].as_str().unwrap_or("unknown");
    let duty = agent["duty"].as_str().unwrap_or("independent gate review");
    json!({
        "lane_id": lane_id,
        "role": "gatekeeper",
        "source": "initial-cycle-plan",
        "objective": objective,
        "review_goal": "Independently review the lab-director hypothesis, prior gate/conclusion/report/paper review comments, analyst handoff, lab-runner validation outputs, Chronicle trend summary, latest papers, literature graph, data graph, and trend analysis before issuing an approve/challenge/reject verdict.",
        "review_scope": [
            "hypothesis novelty against the inferred state of the art",
            "technical quality of the identification and validation strategy",
            "reproducibility and traceability from claim to data and code",
            "clarity and researcher-facing decision usefulness",
            "completeness against the reporting standard this field expects, when applicable"
        ],
        "required_artifacts": [
            "state/<cycle>-research-trend-analysis.json",
            "state/<cycle>-trend-summary.json",
            "state/<cycle>-lab-director-hypothesis.json",
            "state/<cycle>-literature-graph.json",
            "state/<cycle>-data-graph.json",
            "plans/<cycle>-lab-director-literature.json",
            "state/<cycle>-conclusion-review.json",
            "state/<cycle>-gate-review.json",
            "state/<cycle>-report-review.json",
            "state/<cycle>-paper-review.json",
            "artifacts/stats/<cycle>/analyst-*/handoff-validation-plan.json",
            "artifacts/stats/<cycle>/lab-runner-*/validation-summary.json"
        ],
        "assigned_model": assigned_model_parameter("gatekeeper", "codex-agent"),
        "planner_metadata": {
            "initial_lane": true,
            "duty": duty,
            "gate_review_mode": "independent-challenge",
            "require_concrete_artifact_review": true,
            "reject_if_role_plan_missing": true,
            "ignore_operational_timing_as_scientific_blocker": true,
            "forbid_stale_or_generic_review_frame": true,
            "must_read_previous_review_comments": true,
            "must_read_chronicle_research_context": true,
            "previous_review_comment_sources": [
                "state/<cycle>-gate-review.json",
                "state/<cycle>-conclusion-review.json",
                "state/<cycle>-report-review.json",
                "state/<cycle>-paper-review.json"
            ],
            "chronicle_context_sources": [
                "state/<cycle>-trend-summary.json",
                "state/<cycle>-research-trend-analysis.json",
                "plans/<cycle>-lab-director-literature.json",
                "state/<cycle>-literature-graph.json"
            ]
        }
    })
}

pub(crate) fn build_long_run_blueprint() -> Value {
    json!({
        "blueprint_id": "general-research-long-run-v1",
        "objective": "Run a sustained multi-agent research cycle over user-provided tasks and datasets for at least 8 hours, with the explicit goal of earning final researcher approval by pursuing the strongest achievable result and presenting it in a form that is fast for a time-constrained researcher to understand.",
        "success_standard": {
            "primary_goal": "earn final researcher approval",
            "performance_goal": "pursue the highest-quality result the available evidence and time budget can support",
            "communication_goal": "produce artifacts that a busy researcher can understand quickly without reading raw runtime logs",
        },
        "approval_rubric_weights": {
            "novelty": 0.20,
            "technical_quality": 0.24,
            "reproducibility": 0.18,
            "clarity": 0.12,
            "impact": 0.14,
            "consort_reporting_completeness": 0.06,
            "strobe_reporting_completeness": 0.06
        },
        "approval_rubric_priority_order": [
            "technical_quality",
            "reproducibility",
            "novelty",
            "impact",
            "clarity",
            "consort_reporting_completeness",
            "strobe_reporting_completeness"
        ],
        "minimum_runtime_hours": 8,
        "orchestration_mode": "asynchronous",
        "supervision_model": "chronicle-mediated",
        "agents": [
            { "agent_id": "lab-director-01", "role": "lab-director", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "supervision, research-trend mapping before hypothesis generation, decomposition, strategy decisions, and final approval readiness management" },
            { "agent_id": "chronicle-01", "role": "chronicle", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "brief generation, evidence linking, dialogue support" },
            { "agent_id": "gatekeeper-01", "role": "gatekeeper", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "research novelty/impact-focused gate review using literature evidence and the knowledge graph to infer the state of the art baseline" },
            { "agent_id": "gatekeeper-02", "role": "gatekeeper", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "research technical quality and reproducibility-focused gate review" },
            { "agent_id": "gatekeeper-03", "role": "gatekeeper", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "research clarity plus reporting-completeness gate review" },
            { "agent_id": "scout-01", "role": "scout", "lane_mode": "read-only", "runtime_class": "native-readonly", "duty": "open-data source discovery, metadata scan, capability inference, and source integrity checks" },
            { "agent_id": "scout-02", "role": "scout", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "goal-conditioned literature discovery, full-abstract relevance review, and accepted-only evidence finalization for the active research topic" },
            { "agent_id": "scout-03", "role": "scout", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "initial open-data acquisition and cycle-scoped dataset materialisation" },
            { "agent_id": "analyst-01", "role": "analyst", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "statistician: define hypotheses, figure questions, estimands, and decisive validation tasks using primary evidence and official Python-library documentation when method details matter" },
            { "agent_id": "analyst-02", "role": "analyst", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "statistician: comparative ranking, confound/moderator mapping, falsification strategy, and follow-up validation design using primary evidence and official Python-library documentation when method details matter" },
            { "agent_id": "engineer-01", "role": "engineer", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "research engineer: build the isolated runtime, acquire and build the tools the analyst's design declared it needs, prove each one executes here with a recorded smoke run, and repair a tool, dependency, config or command that failed a lab-runner. Owns the MEANS and exercises engineering judgment over them -- which route, build, version and implementation, and what to try next when one fails. Does not decide the SCIENCE: it proposes a design change with its evidence and never makes one silently" },
            { "agent_id": "lab-runner-01", "role": "lab-runner", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "validation-coder: baseline toolkit plus one Codex-written validation check" },
            { "agent_id": "lab-runner-02", "role": "lab-runner", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "validation-coder: pairwise contest or sensitivity validation execution" },
            { "agent_id": "lab-runner-03", "role": "lab-runner", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "validation-coder: time-window, subgroup, or threshold validation execution" },
            { "agent_id": "lab-runner-04", "role": "lab-runner", "lane_mode": "driver-exec", "runtime_class": "external-driver", "duty": "validation-coder: secondary outcome and robustness validation execution" },
            { "agent_id": "illustrator-01", "role": "illustrator", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "figure specs, chart review, visual consistency" },
            { "agent_id": "author-01", "role": "author", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "methods and data section drafting" },
            { "agent_id": "author-02", "role": "author", "lane_mode": "read-write-scoped", "runtime_class": "codex-agent", "duty": "results and discussion drafting" }
        ],
        "phases": [
            { "phase": "bootstrap", "window": "0h-0.5h", "goals": ["discover candidate open datasets", "infer source capabilities and schema", "seed initial claim candidates"] },
            { "phase": "research-trend-mapping", "window": "0.5h-1h", "goals": ["infer the overall state of the field from retrieved papers", "identify where researcher attention is concentrated by topic, method, subject matter, and controversy", "separate saturated baselines from underexplored gaps before hypothesis selection"] },
            { "phase": "exploration", "window": "1h-2h", "goals": ["discover strong candidate relationships", "identify major partitions", "form first hypothesis set from the trend map plus literature/data graphs"] },
            { "phase": "analysis-design", "window": "1h-3h", "goals": ["map confounds", "define analysis families", "prepare experiment bundles"] },
            { "phase": "execution", "window": "2h-6h", "goals": ["run multiple statistical lanes asynchronously", "refresh Chronicle briefs continuously", "branch follow-up analyses when signals appear"] },
            { "phase": "synthesis", "window": "4h-7h", "goals": ["merge claims and evidence", "prepare figure candidates", "draft methods/results", "compress findings into researcher-readable summaries"] },
            { "phase": "refine-and-close", "window": "6h-8h", "goals": ["apply final refine or pivot decisions", "stabilize summaries", "produce approval-ready artifacts that are easy for the researcher to review quickly"] }
        ],
        "chronicle_cadence": {
            "brief_every_minutes": 20,
            "dialogue_every_minutes": 30,
            "open_question_refresh_every_minutes": 60
        },
        "strategy_checkpoints": [
            { "hour_mark": 1.0, "decision_scope": "nudge_or_refine" },
            { "hour_mark": 2.0, "decision_scope": "refine_or_expand" },
            { "hour_mark": 4.0, "decision_scope": "hold_refine_or_pivot" },
            { "hour_mark": 6.0, "decision_scope": "stabilize_or_pivot" },
            { "hour_mark": 7.5, "decision_scope": "final_hold_or_small_nudge" }
        ],
        "termination_conditions": {
            "minimum_runtime_hours": 8,
            "minimum_supported_claims": 2,
            "minimum_completed_experiment_lanes": 4,
            "required_outputs": [
                "cycle-run-state.json",
                "strategy-decision.json",
                "chronicle briefs",
                "workgraph projection",
                "lane timeline projection",
                "aggregate metrics projection",
                "statistical result artifacts",
                "researcher-view html",
                "paper draft"
            ],
            "approval_goal": "lab-director should not consider the cycle done unless the final artifacts are strong enough and clear enough to plausibly earn researcher approval"
        }
    })
}

/// Bullet line that tells an analyst lane to pick a `dataset_root` and
/// declare a `column_mapping` from the cycle-scoped fetched bundles
/// surfaced in `planner_metadata.candidate_datasets`. Shared between
/// the base analyst `task_markdown` and the followup-analyst markdown
/// path so both code routes apply the same Phase 1 directive
/// (docs/data-fetcher-2026-04-28.md §E).
pub(crate) fn pick_dataset_for_hypothesis_directive() -> &'static str {
    "- pick_dataset_for_hypothesis: read role_plan.planner_metadata.candidate_datasets (a list of cycle-scoped bundles materialised by the data-fetcher; each entry carries `bundle_path`, `provider`, `candidate_doi`, and `csvs[]` where each csv has `name`, `csv_path`, `row_count`, `columns`, `format_hint`, `source_url`). Match the hypothesis's x_variable / y_variable (and any control variables) against `csvs[].columns` across all bundles, pick the bundle whose columns best satisfy the identification_strategy, and treat its `bundle_path` as the `dataset_root` for downstream analysis. Also read role_plan.planner_metadata.reference_resources / role_plan.reference_resource_context when present: GitHub repositories, data-availability pages, and supplementary resources from same-dataset reference papers are high-value evidence. Actively mine them for dataset URLs/accessions, sample metadata, preprocessing scripts, feature definitions, model baselines, validation splits, and reproducibility constraints; cite which resource was reused or rejected in the handoff. Then declare both `dataset_root` and a `column_mapping` (object mapping hypothesis variables → bundle column names) in your handoff_checks / validation_code_blueprints so lab-runner reproduces the same selection. If candidate_datasets is empty or no bundle's columns cover the required variables, return status=deferred with `reason: \"no_matching_bundle\"` and list the variables that could not be resolved — do NOT fall back to legacy datasets silently. A bundle with `provider: \"simulation\"` is the episodes.csv an engineer generated from the LabDirector's simulation order `request_id` (its `manifest_path` records how it was produced): pick and analyse it exactly like a fetched bundle; you do not design, change or re-run the simulation, and a blueprint only READS that CSV."
}

/// The LabDirector designs and orders the simulation.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18: the approved-scholarly policy
/// forbade dataset acquisition, the study was meant to generate its data in Isaac
/// Sim / MuJoCo (both probed clean), and every analyst emitted only
/// `blocked-no-matching-bundle` because the directive above told it to defer on an
/// empty `candidate_datasets`; the engineer who would have run the simulation was
/// never dispatched. An analyst-declared request followed, and the owner then
/// assigned simulation orchestration to the LabDirector: an analyst-declared
/// request let the analyst choose the experiment. The order is director (designs
/// the run against the selected hypothesis) -> engineer (runs it) -> analyst
/// (analyses the CSV as a bundle) -> lab-runner.
pub(crate) fn simulation_orders_directive(cycle_id: &str) -> String {
    format!(
        "- simulation_orders: when role_plan.planner_metadata.materialized_bundle_mandate.procedural_data_generation_acceptable is true AND role_plan.planner_metadata.instrument_inventory.simulators is non-empty, the simulator IS this cycle's data source and YOU design the experiment that tests the selected hypothesis. After selecting the hypothesis, emit `simulation_orders` (an array, usually one order) where each order has `request_id` (short snake_case, stable while the design is unchanged — re-emit the same orders on every later decision while the selected hypothesis still needs them), `simulator_backend` and `interpreter_path` copied from one `instrument_inventory.simulators[]` entry, `scenario` (the scene, robot/bodies and task each episode runs), `conditions[]` ({{factor, levels[]}} — the manipulated variables), `seeds[]`, `episodes_per_condition`, `step_or_time_budget` (physics steps or simulated seconds per episode, sized to the measured realtime_factor and the compute budget), `emitted_columns[]` ({{name, unit, meaning}} — one row per episode, including the condition factors, the seed and every outcome the test reads), `output_path` = `.research-lab/datasets/{cycle_id}/simulations/<request_id>/episodes.csv`, and `hypothesis_link` (how this design decides the selected hypothesis: which contrast between which conditions, on which emitted column, would support it and which would meet its falsifier). You do NOT run the simulation: one engineer lane runs exactly each order and writes that CSV plus a manifest.json next to it; analysts wait for those files and then analyse them as a dataset bundle. Set `simulation_orders` to null when the conditions above do not hold or the selected hypothesis is tested on fetched data."
    )
}

/// The LabDirector must name the method family of the lead it selects.
///
/// Nothing downstream infers it any more. The projection used to guess the family
/// from keyword lists over the hypothesis prose, which is how a Mitsuba rendering
/// lead ended up labelled `tumor_immune_resistance` on cycle-g-v73 (the marker
/// "tan" matched inside "s-tan-dard control variates") — and the family routes
/// novelty scoring, so a wrong label scores the lead against the wrong corpus. No
/// keyword list can cover a domain nobody enumerated, and the agent that chose
/// the hypothesis is the one that knows where it belongs.
pub(crate) fn lead_family_declaration_directive() -> &'static str {
    "- lead_family_declaration: state `primary_family` on the lead you select — a short snake_case name for the METHOD FAMILY the hypothesis belongs to, in the vocabulary of THIS cycle's field (use a method-family label grounded in this objective's retrieved literature). It is your call and nothing else infers it: a lead with no declared family projects a null family, and novelty is then scored without a family anchor. Keep the SAME family name while you keep refining the same lead, and change it only when you genuinely switch method families — the family is how the ledger and the gatekeeper tell one lead's lineage from another."
}

/// The lead's CLAIM must be scoped to the evidence this cycle can actually produce.
///
/// THE FAILURE THIS CLOSES (measured on cycle-g-v74). The runner produced a clean,
/// honest render result — variance-guided allocation vs uniform at matched 24 spp
/// against a 256-spp reference, 2 scenes x 5 seeds, +0.84 dB on the high-variance
/// scene and -0.19 dB on the low-variance one, a real falsification boundary. The
/// LEAD attached to it, however, claimed scene-conditioned sequential transport with
/// ReSTIR-style reuse, edit-severity crossovers and ESS/overlap gating. The
/// gatekeeper rejected it at novelty 30 / technical_quality 12 / reproducibility 15
/// and its `missing_validations` were exactly the distance between the two:
/// matched-time comparison against reuse/guiding/allocation baselines, bootstrap
/// intervals on the crossover, prospective calibration of the gates, FLIP/latency/
/// memory telemetry. Every one of those objections was CORRECT. The experiment was
/// not weak; the claim was several sizes too big for it, and nothing in the loop
/// ever compared the two — the director was told to raise novelty, the analyst was
/// told to author an executable blueprint, and no contract asked whether the
/// evidence being authored could establish the claim being made.
///
/// Narrowing is not retreat. A claim the cycle can actually establish scores as a
/// result; a claim it cannot scores as nothing, however good the experiment under
/// it. The cut is to GENERALITY (fewer scenes, fewer baselines, a bounded regime),
/// never to the mechanism — an idea narrowed to its demonstrable core is still the
/// idea, which is why this cannot be traded against the novelty bar.
pub(crate) fn claim_evidence_scope_directive() -> &'static str {
    "- claim_evidence_scope: state your lead at the scope the evidence THIS cycle can actually reach. With the lead, emit `required_evidence_for_claim` — the minimum set of comparisons, baselines, metrics, conditions and repeats that would let an independent reviewer say the claim is established — and mark each item `feasible_this_cycle` true/false against what the runners have already produced and what an analyst could realistically author next. If ANY required item is infeasible, do not keep the broad claim and hope: NARROW it until every remaining required item is feasible, and record what you cut in `claim_scope_narrowed_from`. Cut GENERALITY (fewer experimental conditions, one baseline family instead of four, an explicitly bounded regime), never the mechanism — the narrowed claim must still assert the same idea, just over the ground you can defend. A claim whose required evidence cannot be produced is scored as UNSUPPORTED no matter how clean the experiment beneath it, and that is the single most common way a good result is thrown away: the reviewer's `missing_validations` list is then simply the distance between what you claimed and what you ran. Read that list as a SCOPE signal, not only a work list — when the same evidence gap survives a round because it cannot be produced here, narrow the claim to what the completed validation does establish (including its falsification boundary: where the method FAILS is part of the result, not a defect) instead of re-defending the broad version. Conversely, if the required evidence is feasible and simply has not been run, say so and request it — do not pre-emptively shrink a claim you can afford."
}

/// The analyst must say which parts of the lead's claim its blueprint establishes.
///
/// The other half of `claim_evidence_scope_directive`: the director can only scope
/// a claim to its evidence if somebody reports the coverage honestly, and the
/// analyst authoring the blueprint is the only party that knows which claim
/// elements its checks actually touch. Without this the gap surfaces for the first
/// time at the gate, several rounds and a full runner budget later.
/// The analyst must size its sweep to the wall clock it actually gets.
///
/// Nothing disclosed the budget, so feasibility was being judged against an
/// invisible constraint. On cycle-g-v74 the analyst authored a visibility-hazard
/// prospective design — multi-seed, held-out AUC, TINMSE/FLIP/latency/memory
/// telemetry — and two runners died at exactly 240.3s, the per-blueprint default,
/// producing no numbers for a claim that then reached the gate unsupported.
pub(crate) fn compute_budget_directive() -> &'static str {
    "- compute_budget: the whole handoff shares a ~1500s driver wall clock, and a blueprint that says nothing gets a 240s default. A single blueprint may use nearly all of the budget; N blueprints split it. A condition x repetition x method sweep may need more than 240s depending on the measured cost per run, so declare `timeout_seconds` on the blueprint when yours does — you are the only party that can estimate it, and the driver honours the request up to what the budget can pay for. Size the design to that budget: a COMPLETED comparison with independent repetitions is evidence, while an oversized condition x repetition x method grid killed at the wall produces no numbers at all and leaves the claim it was meant to support arriving at the gate unsupported. If the design genuinely cannot fit, report it in `claim_coverage.not_covered` instead of authoring it anyway."
}

pub(crate) fn claim_coverage_directive() -> &'static str {
    "- claim_coverage: break the lead's claim into its elements (each asserted effect, each compared baseline, each condition/regime it generalizes over, each metric it is asserted in) and map every element to the specific handoff_check / blueprint check that establishes it. Emit `claim_coverage` with `covered` (element -> check_id) and `not_covered` (element -> why: baseline not runnable here, metric not measurable with this setup, condition outside the conditions/data available, cost beyond the lane budget). Do NOT quietly author a smaller experiment under a bigger claim — an uncovered element does not disappear, it becomes the reviewer's blocker after the budget is spent. If `not_covered` is non-empty, say plainly in the handoff which narrower claim the blueprint DOES establish, so the LabDirector can scope the lead to it. Reporting an honest partial coverage is a good outcome; a blueprint that appears to validate a claim it never tested is not."
}

/// Prior work first, for FOLLOW-UP analyst lanes.
///
/// DELIVERY GAP THIS CLOSES. The `reference` stage that opens the analyst's
/// analysis_loop is built in `src/agents/analyst/query_plan.js`, which only
/// builds the BASE analyst plan. Every analyst lane in a running cycle is a
/// follow-up and gets its plan from this builder instead, whose role plans carry
/// no `analysis_loop` at all -- so the stage would have been authored into a
/// branch the cycle never takes. Same gap, same file, as the blueprint contract
/// below.
///
/// WHY IT MATTERS. Without this the estimator, the comparator and the endpoint
/// are chosen from scratch every cycle, and the first time prior work meets the
/// design is the gatekeeper scoring novelty against it -- after the run is
/// executed and paid for.
pub(crate) fn reference_first_directive(cycle_id: &str) -> String {
    format!(
        "- reference first: BEFORE choosing an estimator, a comparator or an endpoint, read what this cycle already retrieved and answer how this quantity has been measured before, what that work compared against, and which endpoint it reported. Read narrowly: `.research-lab/state/{cycle_id}-literature-summary.json` for `top_papers` and the `lanes[].claims` of the families this hypothesis touches, and `.research-lab/state/{cycle_id}-literature-graph.json` for the nodes and edges naming its variables and mechanisms — never the whole of either file, they run to megabytes. Then emit `reference_basis`: for the estimator, the comparator and the endpoint you choose, the prior work each is drawn from and what you deliberately do differently, with the reason. Finding nothing is a valid answer and must be stated as one — name what you searched and say the corpus holds no prior work for this question. An absence you record can be scored; silence cannot, and a design that cites nothing and explains nothing is not finished."
    )
}

/// Blueprint-authoring contract for FOLLOW-UP analyst lanes.
///
/// DELIVERY GAP THIS CLOSES. The analyst's validation profile — `blueprint_rules`
/// plus the `column_mapping_contract` — is assembled in
/// `src/agents/analyst/query_plan.js`, which only builds the plan for the BASE
/// analyst lanes. Follow-up analyst lanes get their plan from this Rust builder
/// instead, and it carried none of it: measured on v71, 75 follow-up analyst
/// lanes were created after the contract shipped and 0 of their role plans
/// contained it (nor the earlier "implement the proposed method" and
/// "self-generating render" rules). Since follow-ups author most of the
/// blueprints, three authoring fixes in a row looked ignored when in fact they
/// were never delivered — the failures they targeted (renders dying on a missing
/// column_mapping before mi.render runs) kept recurring.
///
/// Keep this in sync with CS_BLUEPRINT_RULES / column_mapping_contract in the JS
/// profile; it is the same contract, condensed to the two rules that were
/// actually costing runs.
/// What the author owes a reader, stated by the owner 2026-09-13.
///
/// Follow-up author lanes -- which is every author lane in a running cycle --
/// carried no author directive at all. They received the generic follow-up
/// header, the action description, and nothing about how to make a claim.
///
/// Each rule below is here because its absence produced a specific failure, and
/// each is written as work to do rather than as a value to hold.
pub(crate) fn author_claim_discipline_directive() -> &'static str {
    "- same_problem_needs_new_method_and_better_numbers: if this work addresses the SAME problem as its closest prior work, then it must be both -- a method that is genuinely different, AND a measured result that is better on the quantity that problem is judged by. Not one of the two. A new method that does not beat the prior number is not a contribution to that problem, and a better number from a method that is a rewording of prior work is not one either. Name the closest prior work, name the quantity, and give both numbers side by side. If the work cannot be both, do NOT write it up as an improvement on that problem: redefine the problem so that what this work actually does is the thing being asked. A problem nobody has posed in this form is a contribution even when the method is ordinary; an unimproved answer to a posed problem is not.\n- highest_value_result_is_figure_one: the first figure is the result with the most value to a reader, not the pipeline diagram, not the setup, not the first result chronologically. Decide which single result would most change what a reader believes, and put that one first. Everything explaining how it was produced comes after it. State in the caption what the figure establishes, in the terms the claim uses.\n- disclosure_is_not_hedging: not hiding a weakness and making a timid claim are DIFFERENT THINGS, and doing the second is not a way of doing the first. State the claim at the full strength the evidence supports, and state the weakness plainly and separately. Do not soften the claim itself with `may`, `appears to`, `suggests`, or a narrowed scope as a substitute for naming what is unresolved. A reader must be able to read exactly what is being asserted and exactly what is not yet established, as two clear statements. Weakening the first to cover the second hides both.\n- a_weakness_is_work_not_a_sentence: when you find a weakness, the next step is to address it and THEN write, not to write that it exists. Run the missing control, add the ablation, get the baseline number, bound the failure case, or narrow the claim to what the evidence actually covers -- and report what you did. A limitations section that lists an unaddressed weakness the cycle had the means to close is an unfinished experiment reported as prose. If a weakness genuinely cannot be closed here, say what specifically would close it -- the measurement, the data, the comparison -- so it reads as a defined next step and not as a disclaimer."
}

pub(crate) fn blueprint_authoring_directive(objective: &str) -> String {
    let mut directive = String::from(
        "- blueprint_authoring_contract: if the validation script you author reads `column_mapping` from the handoff check — in ANY form (a preflight raising 'handoff check requires a non-empty column_mapping' or 'column_mapping missing semantic keys') — then the handoff check you emit MUST carry a `column_mapping` that satisfies it, keyed by the SAME names the script asks for: in the handoff check it is a list of {\"key\": <name the script reads>, \"column\": <dataset column>} pairs, and the script receives it as the dict spec[\"column_mapping\"] = {key: column}. An external dataset (a simulator's episodes.csv, a fetched bundle) is mapped from its real column names. A script that blocks on a mapping you did not supply raises before it computes anything, so the lane produces no evidence at all; this is the single most common way a validation dies. For a SELF-GENERATED run (procedural experimental inputs / synthetic data / in-code sweeps, however you spell the dataset name) the columns are the ones your own code writes, so the mapping is the IDENTITY ({\"measurement\": \"measurement\", ...}) — or simply drop the precondition and read your own columns directly. Also list the columns the run will emit as `emitted_columns` on the handoff check.",
    );
    // No longer gated to one field. A method a cycle invented is not a built-in
    // of whatever tool it selected, in any field, and a comparison whose novel
    // arm never ran produces numbers that mean nothing -- which is how three
    // consecutive cycles reported passing lanes on all-null evidence.
    {
        directive.push_str(
            " Additionally: a method THIS cycle invented is not automatically available as a built-in plugin or API in the selected tool. IMPLEMENT the proposed method using that tool's documented extension interface, register or configure it if required, and verify that the novel arm actually executes in a minimal smoke test before the full comparison. Record the implementation and measured output. If it cannot be implemented in this environment, report an implementation gap instead of authoring a comparison whose novel arm cannot execute. Select tools from the objective and the verified inventory; no particular tool is required by this contract.",
        );
    }
    directive
}

pub(crate) fn open_source_analysis_agent_directive() -> &'static str {
    "- open_source_analysis_agent_discovery: before building dataset_profile, validation_design_candidates, handoff_checks, or validation_code_blueprints, search for reusable open-source analysis agents, maintained pipelines, or package workflows that match the selected dataset modality and identification strategy. Start with role_plan.planner_metadata.reference_resources / role_plan.reference_resource_context, then search relevant open-source repositories and package/workflow catalogues. For high-dimensional or large-scale data this step is mandatory: compare specialized workflows for preprocessing, normalization, batch correction, differential analysis, enrichment, dimensionality reduction, annotation, and validation before writing ad hoc analysis code. Do not hardcode any single repository; generate search terms from the dataset modality, platform, identifier, analysis goal, and identification strategy. A local generic single-library adapter, repository inventory, or CSV profiling pass is only an auxiliary fallback and MUST NOT be recorded as the selected_open_source_analysis_agent or as gate-ready application for mandatory high-dimensional or large-scale analysis. Emit `open_source_agent_discovery` with candidate names/URLs/licenses/fit scores/reuse decisions, and set `selected_open_source_analysis_agent` to the selected repository/workflow/domain package or null. SELECTION IS WHERE YOUR PART ENDS: you do not clone, install, build, configure, smoke-test or debug the tool, and you do not repair a command that failed for lab-runner. Declare what the selection needs in `capability_requirements` -- the tool, the version or interface it must expose, the input contract it must accept, and the outputs it must produce -- and an engineer lane provisions it and returns either a recorded capability or a blocker. Cite that capability record in validation_code_blueprints.dependencies and execution_notes; never claim a tool ran on evidence you do not have. If a requirement comes back unsatisfiable, that is a constraint on the METHOD and the decision is yours: choose a compatible workflow or domain package, or write an explicit rejection/waiver plus replacement method before falling back to a self-contained blueprint."
}

/// What an engineer lane is for.
///
/// The clause above used to end by telling the analyst to clone the repository,
/// install its dependencies, generate its config, smoke-test it, and repair
/// whatever had failed for the runner. That is a second job with a different
/// failure mode, and a lane holding both spends its reasoning on whichever one
/// is louder. It moved here; the analyst keeps the selection, which is a method
/// decision, and states what it needs as a requirement.
pub(crate) fn engineer_provisioning_directive(cycle_id: &str) -> String {
    format!(
        "- capability_provisioning_contract: you provision what the design declared and prove it runs here. You do not choose the science and you do not write validation code. FIRST read the analyst handoff's `capability_requirements` and `selected_open_source_analysis_agent`, and the measured inventory at .research-lab/state/{cycle_id}-instrument-inventory.json: a requirement the inventory already satisfies is already provisioned, and reinstalling it spends the lane for nothing. For each unsatisfied requirement, create or reuse an isolated runtime, acquire the tool from its own distribution or source into a cycle-scoped tool cache path (for example .research-lab/tools/{cycle_id}/<tool_slug>), read its README/LICENSE/entrypoints/dependencies, satisfy the system-level prerequisites it names, generate or adapt its config from the input contract the analyst declared, then run the smallest command that exercises it end to end and keep that command, its stdout/stderr, its return code and its elapsed time. Append one line per attempt to .research-lab/state/{cycle_id}-engineering-capability.jsonl and NEVER rewrite or truncate that file: an install that failed is a measurement of this machine, and a later cycle has to be able to tell a tool nobody tried from one that refused to run. A capability is available only with a successful run behind it -- never assert one. When a lab-runner failed, read failed_runner_context and its stderr, repair the command, config, dependency, path or environment, and report exactly what was wrong. ADAPT BEFORE YOU STOP. The first command that fails is a measurement, not an answer: diagnose what it actually says, and try the next route on your own initiative -- another source or mirror, another version, a build from source, a different interpreter, the system prerequisite it is really missing. A requirement is unsatisfiable only once you have run out of means, and the blocker must show them in `alternatives_tried`. When a declared requirement cannot be satisfied at all, record every attempt with its error and RETURN THE BLOCKER: do not SILENTLY substitute a different tool, because swapping the tool changes the experiment and that decision belongs to the analyst -- but do say which tool you would swap it for and what it would cost the claim, in `proposed_design_change`. Deliver what you did get working even when something else blocked you; a lane that provisioned three of four requirements reports three, and an empty-handed lane that stopped at the first error is an unfinished lane, not a blocked one. Emit `runner_invocation_contract` with the executable, argv, working directory and environment the lab-runner uses to run inside the runtime you built, and `capability_blockers` for everything you could not deliver."
    )
}

/// What an engineer lane owes when it is sent to AUDIT how a result was produced.
///
/// Two different reviews sit on one runner result. The analyst asks what the
/// numbers mean; this asks whether the run that produced them did what it said.
/// A result can be perfectly interpretable and still be the output of a tool
/// that silently fell back to a default, a checkpoint that never loaded, or a
/// training step that could not have happened in the time it took.
///
/// It is an audit, not a rerun and not an interpretation: the lane reads what
/// the run recorded and what it left on disk, and says whether they agree.
pub(crate) fn engineer_execution_audit_directive(cycle_id: &str) -> String {
    format!(
        "- execution_audit_contract: applies when role_plan.planner_metadata.audit_target names a completed lane. You are not judging the science and not re-running anything: you are asking whether the run that produced this result did what it reported. Read the target lane's handoff or order, its recorded command/argv, return codes, config, environment and elapsed time, and the artifacts it actually left on disk. Check, and say how you checked each one: (1) IDENTITY -- the tool, version, commit or package build that ran is the one the handoff named, and the config and checkpoint paths it loaded are the ones it was given; (2) NO SILENT FALLBACK -- nothing substituted a default, a stub, a CPU path, a smaller model or a locally written stand-in for the declared implementation, and the logs show what was actually loaded; (3) PLAUSIBILITY -- the work reported is possible in the wall time, hardware and step budget recorded (a model trained in milliseconds, a GPU run with no GPU touched, or an episode count that cannot fit the elapsed time is a FAIL, whatever the outputs look like); (4) COMPLETENESS -- the outputs cover the cells, seeds and columns the handoff declared, and the row counts and hashes match what the record claims; (5) POSITIVE CONTROL -- where the design has a condition that MUST work if the run is sound (the reproduction anchor, the in-support cells, a known baseline number), it did. Return `execution_audit` with a verdict of pass or fail and the evidence for each check; a fail names precisely which check failed and what the recorded evidence was. Never repair the science and never soften a finding into a warning: an audit that cannot say a run did what it claimed reports fail, and the analyst and the gate are not entitled to the result until the owner of that failure has answered. Append your audit line to .research-lab/state/{cycle_id}-engineering-capability.jsonl."
    )
}

/// What an engineer lane owes when it is sent to RUN a simulation, not provision a tool.
///
/// The LabDirector's simulation order is the experiment DESIGN -- conditions,
/// seeds, episode count, emitted columns, budget. Everything the design needs in
/// order to run -- the scene, the demonstration corpus, the policy arms named as
/// condition levels, the generation script -- is this lane's to BUILD from the
/// cycle's open-source assets. The order does not ship them and no other role
/// produces them.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-02 read
/// "run EXACTLY the ordered request ... never substitute" as a ban on building
/// anything, found no checkpoints, demonstrations or generator on disk, and
/// returned "creating replacements would change the experiment". The cycle's own
/// brief assigns exactly that construction to the engineer, so the order could
/// never be run by anyone.
///
/// See simulation_orders_directive for the earlier incident
/// (cycle-b-20260918: no engineer was ever dispatched, so no data ever existed).
pub(crate) fn simulation_execution_directive(cycle_id: &str) -> String {
    format!(
        "- simulation_execution_contract: applies when role_plan.planner_metadata.simulation_order is present (the LabDirector's order). Run EXACTLY the ordered request: every condition level x seed x episodes_per_condition, with the named `simulator_backend`, headless, one GPU simulator process at a time, within `step_or_time_budget`. BUILD what the design needs and does not ship: the scene, the demonstration corpus, the policy arms the condition levels name, and the generation script, from the open-source assets this cycle declares (reuse their own entry points; do not reimplement what a repository already provides). Building them is this lane's job and is NOT a design change. Missing checkpoints, demonstrations, configurations or generator are therefore never a blocker on their own -- only a capability you tried to build and could not is. Use the order's `interpreter_path`; if it cannot be executed here, provision a cycle-scoped interpreter that runs the SAME `simulator_backend` at the same version, record both paths and the denial in `manifest.json`, and carry on -- the interpreter is provenance, the backend is the design. Write `episodes.csv` at the order's `output_path` with exactly the `emitted_columns` in that order, one row per episode, and `manifest.json` in the same directory carrying request_id, the command/argv you ran, every return code, simulator and physics-engine versions, the seeds, hashes of the scripts and assets you used, wall time and the row count. Keep your generation script next to them. Append one line per attempt to .research-lab/state/{cycle_id}-engineering-capability.jsonl and never rewrite that file. VERIFY IN SUPPORT BEFORE YOU SWEEP: run the in-support cells first -- the smallest distance level of every arm -- and check that what you built actually works there, where a policy that learned anything reproduces its own demonstrations. An arm near zero in support is a BUILD YOU GOT WRONG, not a measurement: fix it, or return the blocker with your proposal. Never spend the sweep on arms you have not seen succeed in support, and record it in `manifest.json` as `in_support_validation`: {{\"passed\": true|false, \"note\": \"...\", \"arms\": [{{\"name\": \"the condition level\", \"in_support_success_rate\": 0.0, \"episodes\": 0}}]}}. Data with no such record, or a record that passes while an arm sits at zero, is rejected unread. An outcome column that never varies is rejected and the order is re-issued, so a sweep at zero costs the cycle an attempt and buys it nothing. BUILD FROM THE DECLARED ASSETS: the cycle names the implementations to use (its open-source assets and local reference copies) -- use them through their own entry points. A miniature stand-in you wrote yourself is not the policy the hypothesis is about; if a declared implementation will not run here, say so in `proposed_design_change` rather than quietly substituting a look-alike, and name in `manifest.json` which asset each arm came from. WRITE AS YOU GO: append each episode's row to `episodes.csv` as it finishes and keep `manifest.json` current, so a lane that runs out of time leaves the episodes it ran instead of nothing. MEASURE FIRST, THEN DECIDE: time one episode and one training run before committing to the full grid. If the ordered scale will not fit the time you have, run COMPLETE cells -- whole condition x seed combinations -- rather than truncating every cell, record in the manifest exactly which cells ran and which did not, and say in `proposed_design_change` what scale your measurement supports and what it costs the claim. Partial rows from complete cells are evidence; a uniformly truncated grid is not. THINK LIKE THE ENGINEER OF THIS EXPERIMENT, not a script: the order fixes WHAT must be measured, and every choice about HOW -- which repository, which implementation, how the demonstrations are generated, how the distance is computed, how the work is staged -- is yours to make and to justify in the manifest. If the simulator will not run, or the order cannot be run as written, record every attempt with its error and RETURN THE BLOCKER: never substitute a different simulator backend, change conditions, seeds, emitted columns or budget, or write rows that were not simulated — those are the LabDirector's decisions, and a CSV and manifest that exist are what release the analysts. A blocker comes AFTER you have adapted and run out of means, never instead of trying, and it carries `alternatives_tried` and, when the design itself is what blocks you, `proposed_design_change`. No analysis, no statistics, no claims. Report `simulation_outputs` [{{request_id, csv_path, manifest_path, rows, return_code}}]."
    )
}

#[cfg(test)]
mod simulation_execution_directive_tests {
    use super::simulation_execution_directive;

    // cycle-a-20260919: the engineer read the contract as a ban on
    // building anything, so an order whose policy arms nobody had trained could
    // not be run by any role.
    #[test]
    fn the_contract_separates_the_design_from_what_the_lane_must_build() {
        let directive = simulation_execution_directive("cycle-0001");
        for built in ["demonstration corpus", "policy arms", "generation script"] {
            assert!(directive.contains(built), "missing `{built}`: {directive}");
        }
        assert!(directive.contains("NOT a design change"), "{directive}");
        assert!(
            directive.contains("never a blocker on their own"),
            "{directive}"
        );
        // The design itself is still untouchable, and the interpreter is not
        // part of it.
        assert!(
            directive.contains("never substitute a different simulator backend"),
            "{directive}"
        );
        assert!(
            directive.contains("the interpreter is provenance, the backend is the design"),
            "{directive}"
        );
    }

    // The owner, 2026-09-21: an engineer that only follows the order is not an
    // engineer. It owns every choice about HOW, adapts when a route fails,
    // leaves the episodes it did run, and proposes rather than stops.
    #[test]
    fn the_contract_asks_the_lane_to_adapt_rather_than_stop() {
        let directive = simulation_execution_directive("cycle-0001");
        for mandate in [
            "WRITE AS YOU GO",
            "MEASURE FIRST, THEN DECIDE",
            "THINK LIKE THE ENGINEER OF THIS EXPERIMENT",
            "run COMPLETE cells",
            "never instead of trying",
            "proposed_design_change",
        ] {
            assert!(directive.contains(mandate), "missing `{mandate}`: {directive}");
        }
    }

    // The same standard where the engineer provisions tools: the first failing
    // command is a measurement, not an answer.
    #[test]
    fn provisioning_asks_for_the_next_route_before_a_blocker() {
        let directive = super::engineer_provisioning_directive("cycle-0001");
        for mandate in [
            "ADAPT BEFORE YOU STOP",
            "alternatives_tried",
            "proposed_design_change",
            "unfinished lane",
        ] {
            assert!(directive.contains(mandate), "missing `{mandate}`: {directive}");
        }
        // Silent substitution is still forbidden.
        assert!(
            directive.contains("do not SILENTLY substitute a different tool"),
            "{directive}"
        );
    }
}

/// The analyst's design discipline, delivered.
///
/// Every clause here was already written in `src/agents/analyst/query_plan.js`
/// -- sources_of_truth_policy, concept_resolution_protocol, provenance_policy,
/// pre_validation_master_table_gate, analyst_quality_standard_policy,
/// data_quality_freshness_policy -- and reached NOTHING. Measured on
/// cycle-g-v89: 0 of 225 dispatched analyst lanes carried any of those keys,
/// and 0 of 225 carried the words "canonical column", "provenance footer" or
/// "sources of truth" in any other form. The JS plan builders are not the
/// dispatch path; this is. See src/policy/dispatch_authority.js.
pub(crate) fn analysis_design_discipline_directive() -> &'static str {
    "- analysis_design_discipline: the design you hand off is judged on whether someone else could rebuild it from what you wrote, so five things travel with it. (1) SOURCES OF TRUTH IN ORDER: resolve a definition against the semantic or documented definition first, then lineage and grain, then a curated reference, and only then a library's own docs; never open with a broad raw retrieval and reverse-engineer meaning from column names. (2) ONE CANONICAL RESOLUTION PER CONCEPT: every concept your design models resolves to EXACTLY ONE column or measured output, and you record the near-duplicate candidates you rejected and why -- a concept resolved two ways is the single commonest way a validation measures something other than what was claimed. A concept you cannot resolve is a BLOCKER, not a guess. (3) PROVENANCE FOOTER ON EVERY RESOLUTION AND EVERY CLAIM: what produced this number, which dataset/definition id, which snapshot or version, when it was retrieved, and who owns it if known. (4) THE MASTER TABLE COMES FIRST: declare the one analysis-ready table the hypothesis is tested against -- row grain, join keys, required columns, group labels, covariates, exclusion rules, output path -- and require the blueprint that builds it to emit checks.analysis_master_table_created=true BEFORE any hypothesis test runs. Validation that joins ad hoc inside the final test is not reproducible and does not clear the gate. (5) A PINNED QUALITY STANDARD AND A SELF-EVALUATION AGAINST IT: state the acceptance criteria before the run, in terms of observables your own blueprints actually emit, then report each criterion's achieved value including the fraction of concepts that reached a canonical resolution. A criterion referring to a number your blueprints never produce fails the check forever, so choose observables you emit. Finally, run a freshness and quality self-check on every referenced field: confirm it exists, is populated, matches the assumed unit and grain, and pin the snapshot the table is built from -- flag a stale or unknown-freshness field as a risk rather than proceeding quietly."
}

pub(crate) fn lab_director_research_notes_directive(cycle_id: &str) -> String {
    format!(
        "- research_notes_duty: maintain a durable scientific notebook at .research-lab/state/{cycle_id}-lab-director-research-notes.md and a machine-readable companion at .research-lab/state/{cycle_id}-lab-director-research-notes.json. Before making a new hypothesis, pivot, or requery decision, read any existing notes and preserve the core scientific reasoning chain: current active lead, key pivot rationale, decisive evidence paths, unresolved scientific blockers, rejected/demoted hypotheses and why, selected dataset/tool context, falsification criteria, and next decision-critical actions. Do not dump raw lane logs, duplicate blocker lists, or routine status counters into the notebook except where they change the scientific judgment. After a decision, update both notes with concise fields: `cycle_id`, `updated_at`, `current_lead_hypothesis`, `decision_log`, `evidence_snapshot` limited to decision-critical evidence, `open_blockers`, `rejected_or_demoted_hypotheses`, `dataset_and_tool_context`, `next_actions`, and `handoff_for_next_lab_director`. The Markdown should be short enough for a new LabDirector to read first and resume the reasoning without chat context.
- research_clues_duty: the notebook above is a summary of where the cycle stands now and is rewritten at each decision; a CLUE is what you want to keep whatever happens to the lead. `planner_metadata.research_clues` is your register of them (importance and status first). Read it before you choose, refine, replace or conclude a lead. In every decision, record in `research_clue_updates` what this round taught that the next lead should not have to find out again: a measured result and what it rules in or out (`measured_result`), the prior art that closes or narrows a direction (`prior_art`), the part of a design that earned a high score and must not be lost (`design_strength`), a path that is dead and why (`dead_end`), a fact about the data or instruments (`data_fact`), a question still open (`open_question`), an idea worth trying that nothing has yet (`idea`). Each clue stands on its own, names its evidence (lane ids or artifact paths), and says what it changes about the next decision. Importance is a budget: at most 6 live clues can be `high` (`planner_metadata.research_clues.high_cap`), for what would change which lead you choose or how you refine it; most things are `medium` or `low`. A new clue that does not fit is recorded as `medium`, making another `high` is refused until you lower one, and a register found over budget is brought within it (the clues in use, then the most recently touched, keep `high`); `planner_metadata.research_clues.feedback` says what was not applied as you wrote it, and why. Lower a clue when it stops being decisive. Update a clue when it is used (`in_use`), answered (`resolved`) or shown wrong (`retired`); resolving or retiring one needs a `note` saying why. Do not record routine status, restate the notebook, or add what the register already holds."
    )
}

pub(crate) fn lab_director_hypothesis_gate_efficiency_directive() -> &'static str {
    "- hypothesis_gate_efficiency_mandate: the current priority is to pass the independent hypothesis gate with the minimum valid time and token spend. Start from the current hypothesis-gate blockers and map each blocker to the smallest missing artifact or reviewer action. Reuse existing validation, negative-control, sensitivity, external-validation failed-attempt, promotion, and gate-review artifacts when they scientifically apply. Do not repeat broad scout searches, LabDirector requery loops, runner reruns, or hypothesis replacement attempts unless the latest gate blocker explicitly requires that action. If the remaining blocker is stale, already resolved by newer evidence, too broad for the narrowed claim, or should be replaced by a sharper blocker, emit `gate_blocker_review_requests` so an independent gatekeeper can adjudicate remove/downgrade/resolved/superseded/uphold. If the remaining blocker is a stale/missing `technical_quality` or `strobe_reporting_completeness` review for the current hypothesis, request the smallest targeted gatekeeper/rubric review instead of opening new discovery or analysis branches. Do not lower scientific standards; reduce wasted exploration and duplicate attempts. This efficiency rule never applies to the field landscape: while `role_plan.planner_metadata.field_landscape.status` is not `valid`, field-wide acquisition across every subfield of the objective is required, and you must not tell scouts to stop, narrow or defer broad acquisition."
}

pub(crate) fn analyst_research_notes_directive(cycle_id: &str) -> String {
    format!(
        "- analyst_research_notes_duty: maintain a durable Analyst scientific notebook at .research-lab/state/{cycle_id}-analyst-research-notes.md and a machine-readable companion at .research-lab/state/{cycle_id}-analyst-research-notes.json. Before issuing or revising an analysis-design memo or runner handoff, read any existing Analyst notes and preserve the core validation reasoning chain: current validation focus, why the selected design is testable, schema-backed exposure/outcome/covariate mapping, selected/rejected open-source workflow or tool context, unresolved methodological blockers, rejected/deferred designs and why, falsification/null-test criteria, and next decision-critical actions. Do not dump raw lane logs, full table previews, duplicate blocker lists, or routine status counters into the notebook except where they change the scientific judgment. After a material Analyst decision, update both notes with concise fields: `cycle_id`, `updated_at`, `current_validation_focus`, `analysis_reasoning_log`, `evidence_snapshot` limited to decision-critical evidence, `open_methodological_blockers`, `rejected_or_deferred_designs`, `dataset_and_tool_context`, `falsification_criteria`, `next_actions`, and `handoff_for_next_analyst`. The Markdown should be short enough for a new Analyst to read first and continue validation design without chat context."
    )
}

pub(crate) fn chronicle_direct_corpus_interaction_directive(cycle_id: &str) -> String {
    format!(
        "- direct_corpus_interaction_duty: apply the DCI-Agent direct-corpus-interaction pattern from arXiv:2605.05242 and github.com/DCI-Agent/DCI-Agent-Lite to Chronicle's evidence synthesis. Do not depend only on semantic top-k summaries. First inspect the generated review map at .research-lab/review-map/{cycle_id}/manifest.json when present; it provides stage-ordered and agent-ordered aliases for the cycle. Build a cycle-scoped corpus map at .research-lab/state/{cycle_id}-chronicle-dci-corpus-map.json covering only current-cycle scout results, literature artifacts, state graphs, data-bundles, analyst handoffs, runner summaries, gate reviews, report drafts, and review-map aliases. Search that raw corpus directly with scoped terminal tools (`rg`, `jq`, `sed`, `ls`, and short scripts) to verify exact terms, sparse clue conjunctions, local context, and multi-hop links. Preserve the existing bounded scan rule: never scan the whole repository; every command must name a current-cycle root or known artifact path. Maintain .research-lab/state/{cycle_id}-chronicle-dci-evidence-ledger.json with query, file_path, matched_terms, local_context_summary, evidence_role, and graph_edge_or_blocker for each high-signal hit. Maintain .research-lab/state/{cycle_id}-chronicle-dci-checkpoint.json using DCI-Agent-Lite-style context management: truncate bulky tool output, compact older probes into summaries, and keep reopen_questions plus next_probe_targets so a later Chronicle lane can resume without chat context."
    )
}

pub(crate) fn task_markdown(agent: &Value, cycle_id: &str, objective: &str) -> String {
    let role = agent["role"].as_str().unwrap_or("unknown");
    if role == "lab-director" {
        let agent_id = agent["agent_id"].as_str().unwrap_or("unknown");
        let duty = agent["duty"].as_str().unwrap_or("unknown");
        return format!(
            "# Task for {agent_id}\n\n- cycle_id: {cycle_id}\n- user_prompt: {objective}\n- role: {role}\n- duty: {duty}\n- final_goal: map the verified research frontier, generate at least five candidates with distinct executable procedure signatures, and assign the correct admission state without fabricating scientific scores.\n- compact_context: read the Chronicle decision digest and existing LabDirector notes first. Open only named source references needed to resolve a decision-critical gap.\n- corpus_gate: primary-source identity, objective identity, inclusion reason, and claim provenance must be verified before a paper can support novelty. Family labels, pseudo IDs, repeated citations, graph size, and agent agreement are discovery signals only.\n- procedure_frontier: candidates must differ in intervention, data construction, measured quantity, or analysis design. For each candidate record research_question, mechanism, boundary_conditions, procedure_signature, closest_prior_art, exact novelty_delta, strongest_inversion, boring_baseline, primary_estimand, smallest_useful_effect, falsification_criteria, null_contribution, evidence_route, instrument_limitations, and a bounded minimum kill test.\n- rename_test: remove domain and method labels and compare the remaining operations with the closest prior procedure. Cosmetic renaming does not create diversity or novelty.\n- score_integrity: keep novelty and impact unknown until an attributed independent assessment cites primary evidence. Keywords, paper counts, agent counts, and self-assigned thresholds cannot raise them.\n- admission: use exploration_candidate_selected for an evidence-backed frontier item whose novelty or experiment contract is unresolved. Use validation_lead_ready only when the full procedure and evidence contract passes. A literature-only objective ends after the frontier and must not dispatch Analyst or LabRunner.\n- human_hci_gate: simulation and model judges can establish algorithmic feasibility only. Trust, workload, usability, preference, and appropriate-reliance claims require actual participant evidence and matching outcomes.\n- outputs: write .research-lab/state/{cycle_id}-research-trend-analysis.json and .research-lab/state/{cycle_id}-hypothesis-frontier.json. Write .research-lab/state/{cycle_id}-lab-director-hypothesis.json only for a validation_lead_ready item; otherwise record the smallest evidence action needed for admission.\n{}\n{}\n{}\n- completion_rule: persist updated research notes and return a compact rationale with selected admission state, unresolved blockers, evidence references, and next decision. Do not execute validation yourself.\n",
            lab_director_research_notes_directive(cycle_id),
            lab_director_hypothesis_gate_efficiency_directive(),
            // The director orders the simulation -- see simulation_orders_directive.
            simulation_orders_directive(cycle_id),
        );
    }
    if role == "gatekeeper" {
        format!(
            "# Task for {}\n\n- cycle_id: {}\n- user_prompt: {}\n- role: {}\n- duty: {}\n- review_scope: evaluate the work under research novelty, technical quality, reproducibility, clarity, and impact, plus completeness against the reporting standard this objective's own field expects, when applicable\n- novelty_review_requirement: infer the state-of-the-art baseline from the collected paper set and the knowledge graph before judging novelty\n- family_switch_requirement: do not mainly improve the incumbent family; state explicit cross-family alternatives, switch triggers, and incumbent rejection conditions when the current root family is weak\n- exclude_from_review: runtime duration, pass counts, active window timing, missing paper/report artifacts as operational issues, formatting polish, and operational contract compliance unless they directly invalidate the evidence itself\n",
            agent["agent_id"].as_str().unwrap_or("unknown"),
            cycle_id,
            objective,
            role,
            agent["duty"].as_str().unwrap_or("unknown"),
        )
    } else if role == "chronicle" {
        format!(
            "# Task for {}\n\n- cycle_id: {}\n- user_prompt: {}\n- role: {}\n- duty: {}\n- final_goal: build the literature_graph and data_graph after the initial literature/data scout searches, summarise trends, and participate in a hypothesis-formulation discussion with lab-director.\n- required_order: consume completed scout literature results and completed scout data-discovery results first; then write KG artifacts; only after those artifacts exist should lab-director synthesize a hypothesis.\n- scout_inputs: scout lanes write to .research-lab/lanes/{}/scout-*/result.json and .research-lab/artifacts/stats/{}/scout-*/result.json. Use both locations when named in context, but keep probes scoped to the current cycle.\n- SEQUENTIAL_EXECUTION_RULE: execute file probes / bash commands STRICTLY ONE AT A TIME. Do not spawn multiple `command_execution` items in parallel — the v14 cycle aborted because four simultaneous bash commands left two hanging which tripped the orchestrator's stale-event detector. After each command, emit a short `agent_message` (≤2 sentences) describing what you found before issuing the next command. This keeps the lane's stdout heartbeat alive.\n- bounded_filesystem_scans: never run an unbounded `find` or `rg --files` over the whole repository. Use scoped commands like `ls .research-lab/lanes/{}/scout-02/result.json` and `cat <known-path>`. If you need to locate a file, prefer one targeted `ls` per directory rather than a recursive scan.\n{}\n- emit_artifacts_before_polishing: write literature-graph.json + data-graph.json + trend-summary.json to disk AS SOON as you have a usable first version, then return the final compact JSON brief. Do not iterate on the artifacts after they're on disk — graph polish is a follow-up cycle's job.\n- no_empty_kg_from_missing_downloads: do NOT leave the literature_graph or data_graph empty merely because validation data has not been downloaded. Literature search hits become mechanism/variable/outcome nodes; dataset/accession mentions in papers or data-scout candidates become candidate dataset nodes with access_status open/credentialing_required/restricted/unknown. Mark metadata.materialized=false when needed.\n- short_final_message: the final output-last-message.txt must be ≤2 KB. Long discussion logs go inline in trend-summary.json, not the final message. The final message is a small JSON object with keys `status` (set to `ok`), `graph_artifact_paths` (paths to the three artifacts), and `discussion_seed_for_lab_director` (≤500 chars summarising the most actionable hypothesis seed).\n- literature_graph_duty: at .research-lab/state/{}-literature-graph.json emit nodes for candidate variable families, mechanisms, and outcomes referenced in the retrieved literature, with edges annotated by the paper ids that support each link. If retrieved papers are broad reviews, still extract high-level mechanism/outcome families instead of writing an empty graph.\n- data_graph_duty: at .research-lab/state/{}-data-graph.json emit nodes for the SPECIFIC datasets, collections or registries named in the user prompt, surfaced by retrieved papers, or returned by data-scout candidates -- whatever this field reuses and cites. Each dataset node MUST have ``type: \"dataset\"`` and ``metadata`` carrying ``dataset_name`` (string), ``access_status`` (one of ``open``, ``credentialing_required``, ``restricted``, ``unknown``), ``materialized`` (boolean), and ``candidate_url``/``candidate_doi``/``accession`` when known. Add variable/outcome nodes even when no dataset has been materialized; connect them with `candidate_validation_target` or `measured_in` edges where evidence supports it.\n- data_acquisition_recommendation_duty: when a dataset node is emitted with ``access_status`` of ``open`` or ``credentialing_required`` AND no on-disk bundle exists yet under ``.research-lab/datasets/<cycle_id>/``, add a ``recommended_actions`` entry with ``type: \"data_acquisition_followup\"``, ``priority: \"high\"`, and ``description`` naming the dataset or its identifier. This is for validation materialization after hypothesis generation, not a reason to suppress KG nodes.\n- trend_summary_duty: at .research-lab/state/{}-trend-summary.json emit a compact JSON with `cluster_labels`, `dominant_mechanisms`, `rising_methodologies`, `saturated_baselines`, `open_gaps`, `research_attention_map`, and `attention_concentration` — each grounded in the retrieved papers (include paper_ids, recency/citation signals when available, and note which topics appear crowded versus underexplored).\n- discussion_duty: lab-director will read the Chronicle decision digest and propose a hypothesis; respond with targeted critique in digest form (which evidence edges are under-supported, which cluster is over-represented, which validation datasets the digest implies). Lab-director's final hypothesis artifact should cite compact literature/data edge IDs from the digest, not load full graphs.\n- output_rule: return a compact JSON brief (≤2 KB) summarising `cluster_labels`, `dominant_mechanisms`, `attention_concentration`, `hypothesis_candidates`, `graph_artifact_paths`, `open_questions_for_lab_director`, and `dci_artifact_paths`. Heavy detail belongs in the on-disk artifacts; the final message stays small.\n",
            agent["agent_id"].as_str().unwrap_or("unknown"),
            cycle_id,
            objective,
            role,
            agent["duty"].as_str().unwrap_or("unknown"),
            cycle_id,
            cycle_id,
            chronicle_direct_corpus_interaction_directive(cycle_id),
            cycle_id,
            cycle_id,
            cycle_id,
            cycle_id,
        )
    } else if role == "lab-director" {
        format!(
            "# Task for {}\n\n- cycle_id: {}\n- user_prompt: {}\n- role: {}\n- duty: {}\n- final_goal: synthesise ONE hypothesis as the research-wide decision maker, using Chronicle's compact decision digest rather than raw KG/lane dumps. Emit the hypothesis to .research-lab/state/{}-lab-director-hypothesis.json so analyst and lab-runner consume it downstream.\n- pre_requisite: read role_plan.planner_metadata.chronicle_decision_digest and existing LabDirector research notes first. Do NOT read or inline the full literature_graph, full data_graph, full trend_summary, full state directory, review-map tree, or full lane tree. If a precise detail is missing, ask Chronicle to refresh .research-lab/state/<cycle>-chronicle-decision-digest.json or open exactly one named source_ref from the digest.\n- hypothesis_before_validation_rule: first synthesize the best falsifiable hypothesis from Chronicle's decision-ready digest, even if the concrete dataset bundle has not yet been downloaded. The digest may contain candidate dataset nodes that are not materialized yet; use them to choose a data-verifiable hypothesis and mark `identification_strategy.validation_data_status` as `needs_materialization` when appropriate. High impact is necessary but not sufficient: when choosing among candidate hypotheses, rank each candidate by both expected scientific impact and concrete validation-data availability. Prefer a slightly lower-impact hypothesis with a materialized/open dataset and resolvable exposure/outcome variables over a higher-impact hypothesis whose dataset, accession, schema, or variable mapping is speculative. Process stages are advisory safety rails; a LabDirector override requires a recorded `stage_gate_override` rationale, and a lane held on a `waiting-for-` dependency blocker is released by a recorded `dependency_gate_override` naming that exact blocker string with a rationale. Neither can override forbidden dataset reuse.\n- materialized_bundle_mandate: also read .research-lab/state/{}-data-bundles.json when present. If it lists any `status: \"fetched\"` bundles that match the chosen hypothesis, record `bundle_path`, `candidate_doi`, and required CSV/column families in `identification_strategy.materialized_dataset`. If no matching fetched bundle exists, DO NOT defer hypothesis selection solely for that reason; emit the hypothesis plus a concrete `data_acquisition_followup` naming the dataset or identifier needed for validation. Analyst/lab-runner validation remains blocked until the bundle is materialized.
- validation_data_ranking_mandate: the hypothesis artifact must include `candidate_hypothesis_ranking[]`; each candidate must carry `expected_impact_score`, `novelty_delta_score`, `testability_score`, `data_feasibility_score`, `validation_data_availability_score`, `validation_dataset_accession_or_bundle`, `validation_variable_mapping`, and `validation_data_blockers`. The selected lead must explain why its combined impact + validation-data availability outranks alternatives. If the highest-impact candidate lacks a concrete validation dataset or variable mapping, demote it or mark it `needs_materialization` with an explicit acquisition path.\n{}\n{}\n{}\n- hypothesis_selection_rule: prefer hypotheses that are both high-impact and data-verifiable, with a named dataset/accession/bundle and enough schema evidence to map exposure/outcome variables. If you choose a crowded cluster, explicitly justify the non-obvious mechanism, moderator, dataset, or falsification angle that makes it worth testing. If you choose a high-impact but not-yet-materialized lead over an already materialized backup, record why the expected impact gain outweighs the validation-data risk and specify the deterministic fallback.\n- hypothesis_contract: the hypothesis JSON must carry `statement`, `primary_family`, `identification_strategy`, `supporting_literature_edges` (paper ids or literature_graph edge ids; this is the name the output schema enforces, and a second name for the same evidence is how it goes missing), `supporting_data_graph_edges`, `rival_mechanisms`, `falsification_conditions`, `chronicle_dialogue` (the ≤3-exchange discussion log with chronicle that led to this hypothesis), `research_trend_analysis_path`, `trend_positioning`, and `attention_concentration_basis`.\n- both_graphs_mandate: every hypothesis MUST cite at least one literature_graph edge AND at least one data_graph edge. If the data_graph is too sparse to cite, explicitly state that the data-graph coverage is insufficient and list the minimal data-graph extension chronicle needs to run before the hypothesis is actionable.\n- completion_rule: stop after emitting the research trend analysis artifact, the hypothesis artifact, updated research notes, and a 1-paragraph rationale in output-last-message. Do not attempt to execute the validation yourself.\n",
            agent["agent_id"].as_str().unwrap_or("unknown"),
            cycle_id,
            objective,
            role,
            agent["duty"].as_str().unwrap_or("unknown"),
            cycle_id,
            cycle_id,
            lab_director_research_notes_directive(cycle_id),
            lab_director_hypothesis_gate_efficiency_directive(),
            research_trend_survey_directive(cycle_id),
        )
    } else if role == "analyst" {
        format!(
            "# Task for {}\n\n- cycle_id: {}\n- research_question: {}\n- cycle_objective_context: {}\n- role: {}\n- duty: {}\n- final_goal: VERIFY the hypothesis emitted by lab-director through analysis, and UPDATE the data_graph with the analysis result.\n- NOT a generator: you do not design new hypotheses. Read the lab-director hypothesis from .research-lab/state/{}-lab-director-hypothesis.json; if the file is missing, return status=deferred with a short reason and stop.\n{}\n{}\n{}\n- verification_workflow: (0) complete open_source_analysis_agent_discovery and record the selected/rejected tool decision plus download/smoke-test/debug attempts, (1) load the lab-director hypothesis + chronicle's literature_graph and data_graph, (2) identify the smallest dataset slice required to test the hypothesis's identification_strategy, (3) write a compact analysis script (analyst-scratch.py) that runs the identification strategy the hypothesis actually declares, whatever design that is, together with the assumption checks that design requires and a statement of which assumption would break the estimate; adapting or invoking a compatible open-source agent/pipeline when available, (4) execute and parse the output into numeric metrics, (5) emit handoff_checks and validation_code_blueprints for lab-runner to reproduce at scale and debug if it fails.\n- lab_runner_debug_contract: validation_code_blueprints must contain enough information for lab-runner to run or smoke-test the selected tool: dependencies, setup notes, local_path, smoke_test_command, application_command, expected_outputs, and clear failure interpretation. If this is a runner-failure recovery, read role_plan.planner_metadata.failed_runner_context first and fix the failed command/config/dependencies/column mapping before issuing the revised handoff. If failed_runner_context.repository_workflow_exhausted or repository_workflow_repetition is present, do not reuse the same repository workflow handoff unchanged; emit a repository_workflow_compatibility_decision that repairs the input contract, replaces the workflow/domain package, or rejects it with waiver evidence and a replacement method before any LabRunner repeat.\n- data_graph_update_duty: after analysis, append the observed effect-size edge, its uncertainty, and the verdict (supported / falsified / weakened / inconclusive) back into .research-lab/state/{}-data-graph.json. Preserve existing edges; add a new `analysis_result` edge tagged with your lane_id and completed_at. This is a HARD requirement — lab-runner and gatekeeper depend on the updated graph.\n- output_rule: return a JSON object with keys `hypothesis_id_verified`, `verification_verdict`, `effect_size`, `uncertainty`, `sample_slice`, `identification_strategy_used`, `dataset_root`, `column_mapping`, `open_source_agent_discovery`, `selected_open_source_analysis_agent`, `data_graph_update_path`, `handoff_checks`, `validation_code_blueprints`, `self_review`.\n- library_discovery_policy: inspect the current Python environment (pip list, python -c 'import ...', scanning .venv/lib if available) BEFORE proposing methods. Pick libraries according to the detected data modality, identification strategy, selected open-source analysis agent/pipeline, and installed package set; do not assume a domain-specific stack unless the hypothesis and source data require it.\n- forbid_open_ended_exploration: optimize only for verifying the assigned hypothesis and updating the data_graph. Do not open a new cycle of hypothesis generation.\n",
            agent["agent_id"].as_str().unwrap_or("unknown"),
            cycle_id,
            analyst_cycle_question(objective),
            objective,
            role,
            agent["duty"].as_str().unwrap_or("unknown"),
            cycle_id,
            pick_dataset_for_hypothesis_directive(),
            open_source_analysis_agent_directive(),
            analyst_research_notes_directive(cycle_id),
            cycle_id,
        )
    } else {
        format!(
            "# Task for {}\n\n- cycle_id: {}\n- user_prompt: {}\n- role: {}\n- duty: {}\n- final_goal: earn researcher approval by maximizing result quality and keeping outputs easy to review quickly\n{}\n",
            agent["agent_id"].as_str().unwrap_or("unknown"),
            cycle_id,
            objective,
            role,
            agent["duty"].as_str().unwrap_or("unknown"),
            if role == "author" {
                author_claim_discipline_directive()
            } else {
                ""
            },
        )
    }
}

#[cfg(test)]
mod model_route_tests {
    use super::*;

    #[test]
    fn planning_only_scope_blocks_only_lab_runner_execution() {
        assert!(research_scope_blocks_role(
            Some("planning-only"),
            "lab-runner"
        ));
        assert!(research_scope_blocks_role(
            Some(" PLANNING-ONLY "),
            "lab-runner"
        ));
        assert!(!research_scope_blocks_role(
            Some("planning-only"),
            "analyst"
        ));
        assert!(!research_scope_blocks_role(Some("full"), "lab-runner"));
        assert!(!research_scope_blocks_role(None, "lab-runner"));
    }

    #[test]
    fn fallback_literature_scout_can_review_abstracts_while_data_scout_keeps_driver() {
        let blueprint = build_long_run_blueprint();
        let agents = blueprint["agents"].as_array().unwrap();
        let literature = agents
            .iter()
            .find(|agent| agent["agent_id"] == "scout-02")
            .unwrap();
        let data = agents
            .iter()
            .find(|agent| agent["agent_id"] == "scout-03")
            .unwrap();
        assert_eq!(literature["runtime_class"], "codex-agent");
        assert_eq!(literature["lane_mode"], "read-write-scoped");
        assert_eq!(data["runtime_class"], "external-driver");
        assert_eq!(data["lane_mode"], "driver-exec");
    }

    #[test]
    fn routine_followups_use_lower_cost_tiers() {
        let chronicle = model_route_parameter(
            "chronicle",
            "codex-agent",
            "digest_refresh",
            "summarize evidence",
            8_000,
            0,
            true,
            false,
            CODEX_DEFAULT_AGENT_MODEL,
        );
        assert_eq!(chronicle["model"], CODEX_LUNA_MODEL);
        assert_eq!(chronicle["reasoning_effort"], "low");

        let analyst = model_route_parameter(
            "analyst",
            "codex-agent",
            "falsification_comparison",
            "compare rival mechanisms",
            40_000,
            1,
            true,
            false,
            CODEX_ANALYST_MODEL,
        );
        assert_eq!(analyst["model"], CODEX_DEFAULT_AGENT_MODEL);
    }

    #[test]
    fn resuming_a_literature_search_is_routed_as_the_search_it_continues() {
        for action in ["adaptive_search_followup", "abstract_review_followup"] {
            let route = model_route_parameter(
                "scout",
                "codex-agent",
                action,
                "resume the saved corpus",
                8_000,
                0,
                true,
                false,
                CODEX_DEFAULT_AGENT_MODEL,
            );
            assert_ne!(route["model"], CODEX_LUNA_MODEL, "{action} took the cheap tier");
            assert_ne!(route["reasoning_effort"], "low", "{action} reasons at low effort");
        }
    }

    #[test]
    fn astra_requires_a_procedure_distinct_tournament_and_budget() {
        let astra = model_route_parameter(
            "lab-director",
            "codex-agent",
            "hypothesis_tournament",
            "decisive novelty adjudication",
            50_000,
            4,
            true,
            false,
            CODEX_LAB_DIRECTOR_MODEL,
        );
        assert_eq!(astra["model"], CODEX_ASTRA_MODEL);
        assert_eq!(astra["reasoning_effort"], "xhigh");

        let capped = model_route_parameter(
            "lab-director",
            "codex-agent",
            "hypothesis_tournament",
            "decisive novelty adjudication",
            50_000,
            4,
            false,
            false,
            CODEX_LAB_DIRECTOR_MODEL,
        );
        assert_eq!(capped["model"], CODEX_LAB_DIRECTOR_MODEL);
    }

    #[test]
    fn external_drivers_bypass_model_tiers() {
        let route = model_route_parameter(
            "scout",
            "external-driver",
            "literature_search",
            "retrieve papers",
            2_000,
            0,
            true,
            false,
            EXTERNAL_DRIVER_MODEL,
        );
        assert_eq!(route["model"], EXTERNAL_DRIVER_MODEL);
        assert_eq!(route["reasoning_effort"], "none");
    }

    #[test]
    fn evidence_words_and_candidate_counts_do_not_upgrade_a_routine_digest() {
        let route = model_route_parameter(
            "lab-director", "codex-agent", "status_digest",
            "decisive novelty hypothesis tournament in cited source text",
            200_000, 20, true, false, CODEX_LAB_DIRECTOR_MODEL,
        );
        // The point is that evidence words and a high candidate count do not
        // UPGRADE a routine digest, and that still holds. What changed under
        // 692dd85 is the floor: a reasoning role's routine work used to fall
        // through to TERRA -- the execution tier -- "which downgraded them
        // exactly when reasoning was wanted", in that commit's own words. So a
        // routine lab-director digest sits at its role's ordinary tier, and the
        // assertion is that it does not climb above it.
        assert_eq!(route["model"], CODEX_DEFAULT_AGENT_MODEL);
        // The only tier a routine digest could wrongly climb to is ASTRA:
        // CODEX_LAB_DIRECTOR_MODEL and CODEX_DEFAULT_AGENT_MODEL are the same
        // value today, so asserting they differ would assert nothing.
        assert_ne!(route["model"], CODEX_ASTRA_MODEL);
        assert_eq!(route["astra_eligible"], false);
    }
}
