use anyhow::Result;
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;

use crate::core::model::LaneContract;
use crate::runtime::owner_directives::owner_directive_clause;
use crate::runtime::prompt_budget::{apply_prompt_context_budget, budget_note};

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = String::with_capacity(max_chars + 1);
    for (idx, ch) in value.chars().enumerate() {
        if idx >= max_chars.saturating_sub(1) {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> String {
    if value.as_bytes().len() <= max_bytes {
        return value.to_string();
    }
    if max_bytes == 0 {
        return String::new();
    }
    let marker = "\n[... tail truncated to keep Codex input below the hard byte limit ...]";
    let marker_bytes = marker.as_bytes().len();
    if max_bytes <= marker_bytes {
        return "…".to_string();
    }
    let keep = max_bytes.saturating_sub(marker_bytes);
    let mut end = 0usize;
    for (idx, ch) in value.char_indices() {
        let next = idx + ch.len_utf8();
        if next > keep {
            break;
        }
        end = next;
    }
    format!("{}{}", &value[..end], marker)
}

fn codex_max_prompt_bytes() -> usize {
    env::var("RESEARCHLAB_CODEX_MAX_PROMPT_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (64_000..=950_000).contains(value))
        // Keep well below Codex's 1 MiB request limit because the CLI adds
        // framing, schemas, model metadata, and other request fields around
        // our stdin prompt. The old 850 KB prompt cap still allowed the final
        // request to exceed 1,048,576 bytes on data-heavy cycles.
        .unwrap_or(650_000)
}

pub(crate) fn codex_cli_supported_model(model: &str) -> &str {
    model
}

fn python_runtime_clause_for(configured: Option<&str>, windows: bool) -> String {
    let interpreter = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(if windows { "python" } else { "python3" });
    // Show an executable command for the lane's actual shell, including paths
    // with spaces or quotes. Generic driver examples may still say python3.
    let invocation = if windows {
        format!("& '{}'", interpreter.replace('\'', "''"))
    } else {
        format!("'{}'", interpreter.replace('\'', "'\"'\"'"))
    };
    format!(
        "\n\nPYTHON RUNTIME: Execute Python drivers as `{invocation} <script.py> <arguments>` using separate arguments. This interpreter comes from RESEARCHLAB_PYTHON when configured. Substitute this invocation for every generic `python3` or `python` example in the task and role plan, including outdated interpreter paths in previous failure logs. Do not assume a python3 alias exists or install another interpreter when this one is configured. If this interpreter cannot start before the driver executes, record one runtime_execution_blocked failure and return status=blocked with its exact error. Do not repeat different search queries against the same failed interpreter or interpret an execution failure as evidence that no papers or datasets exist.\n"
    )
}

fn python_runtime_clause() -> String {
    python_runtime_clause_for(
        env::var("RESEARCHLAB_PYTHON").ok().as_deref(),
        cfg!(windows),
    )
}

fn research_network_clause_for(policy: Option<&str>) -> &'static str {
    if policy == Some("approved-scholarly-metadata-v1") {
        "\n\nAPPROVED RESEARCH LOOKUPS: The user permits public scholarly search terms and paper identifiers to OpenAlex, Semantic Scholar, Crossref and arXiv only. Use the literature driver's approved GET-only metadata path for retrieval and citations; preserve its receipts in the search journal. Do not send local source code, documents, file contents, filesystem paths, credentials or research artifacts to these services. Do not upload files, use another host, or work around a denied request. Retrieve abstracts, citations and references through the approved indexes; a publisher/dataset link is a discovery pointer, not permission to visit that destination. Assess local dataset feasibility from the copied snapshot and approved paper metadata. If an additional service is necessary, retain the concrete gap for a later authorization instead of broadening access.\n"
    } else {
        ""
    }
}

// What a read costs, stated where every role can see it.
//
// This runtime bounds the prompt it SENDS with a hard byte limit and truncates
// the tail when it bites. Nothing bounds what the agent then pulls in, and that
// is where cycle-g-v89's budget went: 293 MB of tool results against 12 MB of
// prompts, one `jq` of one state file returning 1,245 KB, and a provider bill of
// 75.5M input tokens against a meter reporting 31.8M.
fn context_cost_clause() -> &'static str {
    "\n\nREAD NARROWLY. Every byte a command prints is added to this session and \
re-sent on each following turn, so an unbounded read is charged again and again. \
Never print a whole artifact: no `jq '.' <file>` and no `cat` of a result, state \
or role-plan JSON -- these run to megabytes. Ask for the fields you need \
(`jq -c '{field_a, field_b}' <file>`), bound every match (`rg -m 20`), and bound \
every dump (`head -c 20000`). `head -N` is NOT a limit on these files: they hold \
JSON with megabyte-long lines, and `rg ... | head -200` returned 1.1 MB. Do not \
list or search broad trees; open the paths your role_plan and context_refs name. \
If an artifact is genuinely too large to read narrowly, say so in your output and \
name what you needed from it -- that is a finding, not a failure."
}

// cycle-a-20260919, 2026-10-02: a director wrote its own "immutable
// lead manifest" into state/, and the directors after it treated it as a second
// record of the lead. src/orchestrator/state_boundary.js moves such files into
// the lane that wrote them; this says so before the lane writes one.
fn state_boundary_clause() -> &'static str {
    "\n\nSTATE BELONGS TO THE HARNESS. Do not create new files in `.research-lab/state/`: \
the harness writes the cycle's state from your result. Keep your own records -- notes, \
manifests, dispositions, ledgers -- in your lane directory and name them in your output. \
A new file you leave in state/ is moved into your lane directory when you finish, and no \
other role will read it there as the cycle's state."
}

fn runtime_environment_clause() -> String {
    format!(
        "{}{}{}{}",
        context_cost_clause(),
        state_boundary_clause(),
        python_runtime_clause(),
        research_network_clause_for(
            env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY")
                .ok()
                .as_deref(),
        )
    )
}

fn fit_prompt_to_byte_limit(
    render_prompt: &dyn Fn(&str, &str, &str) -> String,
    role_plan_text: &str,
    task_text: &str,
    truncation_note: &str,
    max_prompt_bytes: usize,
) -> (String, String, String, String) {
    let mut note = truncation_note.to_string();
    let mut role_text = role_plan_text.to_string();
    let mut task = task_text.to_string();
    let mut prompt = render_prompt(&role_text, &task, &note);
    if prompt.as_bytes().len() <= max_prompt_bytes {
        return (prompt, role_text, task, note);
    }

    note = format!(
        "{}\nPrompt note: context exceeded the hard input byte limit; oversized trailing content was truncated before dispatch.",
        note
    );
    task = truncate_utf8_bytes(&task, 4_000);
    let overhead = render_prompt("", &task, &note).as_bytes().len();
    let available_for_role = max_prompt_bytes
        .saturating_sub(overhead)
        .saturating_sub(1024);
    role_text = truncate_utf8_bytes(&role_text, available_for_role);
    prompt = render_prompt(&role_text, &task, &note);

    if prompt.as_bytes().len() > max_prompt_bytes {
        let overhead = render_prompt("", "", &note).as_bytes().len();
        let remaining = max_prompt_bytes
            .saturating_sub(overhead)
            .saturating_sub(1024);
        let task_budget = remaining.min(2_000);
        task = truncate_utf8_bytes(&task, task_budget);
        let role_budget = remaining.saturating_sub(task.as_bytes().len());
        role_text = truncate_utf8_bytes(&role_text, role_budget);
        prompt = render_prompt(&role_text, &task, &note);
    }

    if prompt.as_bytes().len() > max_prompt_bytes {
        prompt = truncate_utf8_bytes(&prompt, max_prompt_bytes);
    }
    (prompt, role_text, task, note)
}

fn compact_role_plan_for_prompt(role_plan: &Value) -> Value {
    let mut compacted = role_plan.clone();

    if let Some(obj) = compacted.as_object_mut() {
        if let Some(actions) = obj
            .get_mut("recommended_followup_actions")
            .and_then(Value::as_array_mut)
        {
            actions.truncate(6);
            for action in actions.iter_mut() {
                if let Some(action_obj) = action.as_object_mut() {
                    if let Some(candidates) = action_obj
                        .get_mut("candidate_hypotheses")
                        .and_then(Value::as_array_mut)
                    {
                        candidates.truncate(3);
                    }
                    if let Some(gaps) = action_obj
                        .get_mut("open_validation_gaps")
                        .and_then(Value::as_array_mut)
                    {
                        gaps.truncate(3);
                    }
                    if let Some(questions) = action_obj
                        .get_mut("challenge_questions")
                        .and_then(Value::as_array_mut)
                    {
                        questions.truncate(4);
                    }
                }
            }
        }
        if let Some(candidates) = obj
            .get_mut("candidate_hypotheses")
            .and_then(Value::as_array_mut)
        {
            candidates.truncate(3);
        }
        if let Some(gaps) = obj
            .get_mut("open_validation_gaps")
            .and_then(Value::as_array_mut)
        {
            gaps.truncate(3);
        }
        if let Some(traces) = obj.get_mut("analysis_traces").and_then(Value::as_array_mut) {
            traces.truncate(4);
        }
        if let Some(results) = obj
            .get_mut("validation_results")
            .and_then(Value::as_array_mut)
        {
            results.truncate(4);
        }
        if let Some(queries) = obj.get_mut("queries").and_then(Value::as_array_mut) {
            queries.truncate(8);
        }
        if let Some(metadata) = obj
            .get_mut("planner_metadata")
            .and_then(Value::as_object_mut)
        {
            if let Some(candidates) = metadata
                .get_mut("candidate_hypotheses")
                .and_then(Value::as_array_mut)
            {
                candidates.truncate(3);
            }
            if let Some(gaps) = metadata
                .get_mut("open_validation_gaps")
                .and_then(Value::as_array_mut)
            {
                gaps.truncate(3);
            }
            if let Some(actions) = metadata
                .get_mut("recommended_actions")
                .and_then(Value::as_array_mut)
            {
                actions.truncate(4);
            }
            if let Some(reasons) = metadata
                .get_mut("blocker_reasons")
                .and_then(Value::as_array_mut)
            {
                reasons.truncate(4);
            }
            if let Some(questions) = metadata
                .get_mut("challenge_questions")
                .and_then(Value::as_array_mut)
            {
                questions.truncate(4);
            }
        }
    }

    compacted
}

/// Every `role_plan.<key>` a prompt names, that the role plan does not actually
/// carry.
///
/// THE BUG CLASS THIS CATCHES. A prompt can tell an agent to consult
/// `role_plan.X` while nothing ever put X in the plan, and nothing notices: the
/// agent looks, finds nothing, and proceeds — which reads afterwards as the agent
/// ignoring a rule. That misreading is the most repeated diagnosis error in this
/// repo, and it has always been a delivery failure rather than disobedience.
///
/// FOUND THIS WAY on cycle-g-v81: the LabDirector prompt said "Hypothesis-narrowing
/// protocol (MANDATORY — see role_plan.hypothesis_narrowing_protocol)". That key
/// has never existed in a single role-plan.json, in v81 or in ANY cycle in the
/// container's history — `agents/index.js` builds the block and the Rust followup
/// builder composes its own plan without merging it. The protocol only worked
/// because a full copy is inlined in the prompt text; the pointer was decorative.
///
/// A missing key is reported INTO the prompt rather than silently dropped, so the
/// agent stops hunting for it, and so the warning lands in the lane's prompt.txt
/// where it can be grepped across every lane at once.
fn unresolved_role_plan_references(prompt: &str, role_plan: &Value) -> Vec<String> {
    const NEEDLE: &str = "role_plan.";
    let has_key = |key: &str| {
        role_plan.get(key).is_some()
            || role_plan
                .get("planner_metadata")
                .and_then(|meta| meta.get(key))
                .is_some()
    };
    let mut missing: Vec<String> = Vec::new();
    let mut rest = prompt;
    while let Some(at) = rest.find(NEEDLE) {
        rest = &rest[at + NEEDLE.len()..];
        let key: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        // `role_plan.` followed by nothing identifier-like is prose, not a reference.
        if key.is_empty() || has_key(&key) || missing.contains(&key) {
            continue;
        }
        missing.push(key);
    }
    missing.sort();
    missing
}

#[cfg(test)]
mod role_plan_reference_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_reference_to_a_missing_key_is_reported() {
        let plan = json!({ "objective": "x", "planner_metadata": { "review_action": 1 } });
        assert_eq!(
            unresolved_role_plan_references(
                "see role_plan.hypothesis_narrowing_protocol now",
                &plan
            ),
            vec!["hypothesis_narrowing_protocol"]
        );
    }

    #[test]
    fn a_key_present_at_either_level_is_fine() {
        let plan = json!({ "objective": "x", "planner_metadata": { "review_action": 1 } });
        assert!(unresolved_role_plan_references("role_plan.objective", &plan).is_empty());
        assert!(unresolved_role_plan_references("role_plan.review_action", &plan).is_empty());
    }

    #[test]
    fn each_missing_key_is_named_once_and_prose_is_ignored() {
        let plan = json!({});
        assert_eq!(
            unresolved_role_plan_references(
                "role_plan.alpha and role_plan.alpha and role_plan. ",
                &plan
            ),
            vec!["alpha"]
        );
    }
}

/// The LabDirector's output contract.
///
/// Named rather than inlined so the rules inside it can be asserted on. A
/// contract clause has no compiler behind it -- when cycle-g-v87 abandoned its
/// research question after a single falsification, the fix was a paragraph, and
/// a paragraph deleted in a later edit fails nothing. See
/// labdirector::tests::method_persistence.
/// The author's output contract.
///
/// The role had none: the chain covered gatekeeper, lab-director, chronicle and
/// analyst, and author fell through to an empty string. Named as a const for the
/// same reason as LAB_DIRECTOR_OUTPUT_CONTRACT -- a prompt rule has no compiler
/// behind it, so a test that reads the text is the only thing that fails when a
/// later edit drops a clause.
/// The illustrator's output contract.
///
/// The role had none: illustrator-01 ran on cycle-g-v89 with a 632-byte prompt,
/// `Role Plan: null`, and returned an empty extracted_json. Named as a const so
/// the rules can be asserted on, for the same reason as the other two.
pub(crate) const ILLUSTRATOR_OUTPUT_CONTRACT: &str = "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"central_claim\": \"the ONE sentence a reader should come away with, stated before any figure is designed\",\n  \"figure_only_read\": \"what a reader who sees ONLY the figures, in order, would be able to say about the result - and if that is less than central_claim, the figure set is not finished\",\n  \"figures\": [{\"id\": \"...\", \"kind\": \"distribution|curve|crossover|boundary|frontier|per_seed_scatter|calibration|ablation|schematic\", \"claim_carried\": \"the part of central_claim THIS figure carries on its own\", \"why_not_a_table\": \"what this shows that a table of the same numbers would hide\", \"source_artifact\": \"committed result file the data is drawn from\", \"generator\": \"the script that produced it from that artifact\", \"path\": \"the emitted image path\", \"caption\": \"states what the figure SHOWS about the subject - never how the paper presents it\", \"axes\": {\"x\": \"quantity and unit\", \"y\": \"quantity and unit\"}, \"reference_marks\": [\"preregistered thresholds, baselines or bounds drawn ON the figure rather than described in the caption\"], \"layout_check\": {\"text_overlaps\": 0, \"text_over_data_overlaps\": 0, \"clipped_artists\": 0, \"min_font_pt\": 0, \"measured_with\": \"how you obtained the extents\"}}],\n  \"coverage_check\": [{\"claim_component\": \"one component of central_claim\", \"carried_by\": [\"figure ids\"], \"gap\": \"null when a figure carries it; otherwise what is still unshown\"}],\n  \"rejected_figures\": [{\"idea\": \"...\", \"why_rejected\": \"decorative, duplicates a table, or carries no part of the claim\"}]\n}\n\nDESIGN FROM THE CLAIM, NOT FROM THE DATA (MANDATORY). State central_claim first, decompose it, and give every component a figure that carries it. A figure that carries no component of the claim does not go in the paper - record it in rejected_figures instead. Then answer figure_only_read honestly: if the figures alone say less than the claim, the set is incomplete and you say so rather than padding it.\n\nSHOW WHAT A TABLE CANNOT (MANDATORY). Prefer the shapes that hold information a table flattens: a DISTRIBUTION and its spread rather than a mean; a CURVE and the point where two of them cross rather than the endpoints; a BOUNDARY with the region either side of it; PER-SEED scatter against the preregistered threshold rather than an aggregate pass/fail; a FRONTIER when two costs trade off; a CALIBRATION plot when a predictor's reliability is the claim. Draw preregistered bounds, baselines and thresholds ON the figure as reference marks - a threshold mentioned only in the caption is a number the reader has to hold in their head while looking somewhere else.\n\nEVERY FIGURE COMES FROM A COMMITTED RESULT FILE (MANDATORY). Name the source_artifact and the generator for each one. A figure drawn from a number nobody can trace is the same defect as a number typed into prose: to change what a figure shows, change the result it is drawn from.\n\nCAPTIONS DESCRIBE THE SUBJECT (MANDATORY). Write what the figure shows about the science. Do not write how the paper presents it, what the reader should notice, or what will be added later. No 'this figure demonstrates', no 'note that', no 'will be updated'.\n\nDRAW THE FIGURE, DO NOT ADOPT A DIAGNOSTIC PLOT (MANDATORY). A plot emitted by a validation runner was made for whoever was reading that run, with whatever defaults were convenient at the time. Read the source_artifact and emit a NEW image designed for the claim it carries. The generator you name must be a script THIS lane wrote; a path under a runner's blueprint directory is a selection, not a figure, and selecting is how a four-panel plot with no axis labels reached a manuscript. Reuse a runner's image only if you have opened it and it already satisfies the rule below, and say so in why_not_a_table.\n\nLEGIBILITY (MANDATORY). Axis labels carry quantity AND unit, on EVERY panel of a multi-panel figure, and every panel carries its own title - a panel a reader cannot name is a panel they cannot use. Every series is distinguishable without colour alone. A SERIES WHOSE VALUE IS ZERO MUST STILL BE VISIBLE: a zero-height bar draws nothing, so an empty panel reads as missing data when what it means is that the quantity is zero - mark the point and annotate it, and when the zero IS the result, say so on the figure. Do not rescale an axis to make a difference look larger than it is, and state the axis range when a truncated axis is unavoidable.\n\nOPEN WHAT YOU EMITTED (MANDATORY). Before reporting coverage, read back each image you wrote and confirm it is non-empty, that every panel is labelled, and that claim_carried is visible in the pixels rather than only in the caption. coverage_check asks whether the claim is CARRIED, which is a question about the rendered image and not about the data you passed to the plotting call.\n\nMEASURE THE LAYOUT, DO NOT EYEBALL IT (MANDATORY). A label resting on another label, an annotation printed over a data marker, or a legend clipped at the figure edge makes a correct figure unreadable, and it is the first thing a reviewer sees. Your plotting library can tell you: after drawing, every text artist has a bounding box in display coordinates, so overlaps and out-of-bounds extents are measurable rather than a matter of opinion. In the generator you wrote, before saving, check each figure for text overlapping other text, text overlapping a plotted mark or line, and any artist extending outside its axes or the figure canvas. Fix the layout and re-emit rather than shrinking the font until the collision disappears.\n\nReport what you measured per figure as layout_check: {\"text_overlaps\": 0, \"text_over_data_overlaps\": 0, \"clipped_artists\": 0, \"min_font_pt\": 0, \"measured_with\": \"how you obtained the extents\"}. A figure with no layout_check is unmeasured, which is not the same as clean.";

/// The engineer's output contract.
///
/// Written with the role rather than after it. Both the author and the
/// illustrator reached this chain with no branch of their own and ran against
/// an empty output contract; a role added without one repeats that. The shape
/// is what the two roles downstream each need back -- an invocation the
/// lab-runner can type, and a blocker the analyst can make a method decision
/// against.
pub(crate) const ENGINEER_OUTPUT_CONTRACT: &str = "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"runtime\": {\n    \"path\": \"where the isolated runtime lives\",\n    \"activate_command\": \"the exact command that enters it\",\n    \"interpreter_version\": \"...\",\n    \"isolated\": true\n  },\n  \"provisioned\": [\n    {\n      \"requirement\": \"the requirement text as the analyst declared it\",\n      \"tool\": \"what was installed or built\",\n      \"source\": \"distribution, repository URL or package index it came from\",\n      \"version\": \"...\",\n      \"local_path\": \"...\",\n      \"install_command\": \"...\",\n      \"install_return_code\": 0,\n      \"smoke_command\": \"the smallest command that exercises it end to end\",\n      \"smoke_return_code\": 0,\n      \"smoke_output\": \"what it printed, truncated but not summarised away\",\n      \"elapsed_seconds\": 0,\n      \"verdict\": \"available|unavailable\"\n    }\n  ],\n  \"already_satisfied\": [\n    {\n      \"requirement\": \"...\",\n      \"evidence\": \"the inventory or capability-record line showing it already runs here\"\n    }\n  ],\n  \"runner_invocation_contract\": {\n    \"executable\": \"...\",\n    \"argv\": [\n      \"...\"\n    ],\n    \"working_directory\": \"...\",\n    \"environment\": {\n      \"NAME\": \"value\"\n    },\n    \"notes\": \"the limits of what was provisioned\"\n  },\n  \"runner_failure_repair\": {\n    \"failed_command\": \"...\",\n    \"root_cause\": \"what was actually wrong, not what was retried\",\n    \"fix_applied\": \"...\",\n    \"verified_by\": \"the command that now succeeds\"\n  },\n  \"capability_blockers\": [\n    {\n      \"requirement\": \"...\",\n      \"attempts\": [\n        {\n          \"command\": \"...\",\n          \"error\": \"...\"\n        }\n      ],\n      \"alternatives_tried\": [\n        {\n          \"approach\": \"the different route you tried on your own initiative -- another source, version, build path, mirror, interpreter or equivalent implementation\",\n          \"outcome\": \"what it did, with the error or the measurement\"\n        }\n      ],\n      \"why_unsatisfiable\": \"...\",\n      \"decision_owner\": \"analyst\"\n    }\n  ],\n  \"proposed_design_change\": {\n    \"what_i_would_change\": \"the smallest change to the DESIGN that would let this run, stated precisely -- null when nothing in the design is in the way\",\n    \"why\": \"the measurement on this host that makes the ordered form impossible, not a preference\",\n    \"what_it_costs_the_claim\": \"what the hypothesis could no longer say under your version, stated honestly\",\n    \"decision_owner\": \"lab-director\"\n  },\n  \"simulation_outputs\": [\n    {\n      \"request_id\": \"the LabDirector's simulation order request_id this lane ran; empty list when no simulation_order was assigned\",\n      \"csv_path\": \"the episodes.csv written at the order's output_path\",\n      \"manifest_path\": \"the manifest.json beside it\",\n      \"rows\": 0,\n      \"return_code\": 0\n    }\n  ],\n  \"execution_audit\": {\n    \"target_lane_id\": \"the lane whose result this audits; null when this lane was not sent to audit one\",\n    \"verdict\": \"pass|fail\",\n    \"checks\": [\n      {\n        \"check\": \"identity|no_silent_fallback|plausibility|completeness|positive_control\",\n        \"verdict\": \"pass|fail\",\n        \"declared\": \"what the handoff or order said would run\",\n        \"observed\": \"what the record and the artifacts show actually ran\",\n        \"evidence\": \"the line, path, hash, count or elapsed time you read it from\"\n      }\n    ]\n  },\n  \"capability_record_appended\": \"path of the append-only record this lane added lines to\"\n}\nA capability is reported available ONLY with a successful smoke run behind it. A requirement you could not satisfy is a blocker, never a silent substitution: choosing a different tool changes the experiment, and that decision belongs to the analyst. A blocker is what you return AFTER you have adapted and run out of means, never instead of trying: it must carry `alternatives_tried`, and where the design itself is what blocks you, a `proposed_design_change` that says what you would do and what it would cost the claim. Stopping at the first error and handing back the message is not a blocker -- it is an unfinished lane.";

/// How an engineer installs, now that it can reach the registries.
///
/// Owner decision, 2026-09-19: engineers install open-source libraries and
/// physical-AI platforms (runtime::codex_policy::OPEN_SOURCE_ASSET_DOMAINS).
/// Code an agent installs runs on this host, so every install is isolated per
/// cycle and recorded well enough to audit or rebuild. The git/curl note is
/// MEASURED ON this host, 2026-09-19: inside the Windows sandbox, git's
/// default schannel backend and curl.exe failed with SEC_E_NO_CREDENTIALS while
/// Python/pip and `git -c http.sslBackend=openssl` reached the same hosts.
pub(crate) const ENGINEER_INSTALL_CLAUSE: &str = "\nINSTALLS (MANDATORY): install only into an isolated per-cycle environment (a venv/conda env or tool cache under .research-lab/envs/<cycle_id>/, or D:/envs/<cycle_id>-<name> where the sandbox can write) - never into a system or shared interpreter, and never modify the local reference repositories: install one editable into the cycle env, or copy it. Prefer the official registry or the project's own repository (PyPI, npm, crates.io, Maven Central, GitHub/GitLab, Hugging Face, NVIDIA/Meta/Google distribution hosts) and respect each licence. Record every install in the lane's provisioning record (`provisioned[*]` and the engineering-capability jsonl): package, version, source URL, and hash where the tool gives one, plus the resolved set (`pip freeze`, the conda export, or the lockfile). Never pass, embed or request credentials or tokens. Only the hosts of this lane's network profile are reachable (invocation.json `permission_profile`); a refused host is a capability blocker, not a reason to find another route. In the Windows sandbox use Python/pip for downloads and `git -c http.sslBackend=openssl` for git; curl.exe and git's default TLS backend fail there.";

pub(crate) const GATEKEEPER_FIGURE_VERIFICATION_CLAUSE: &str = "\n\nFIGURE VERIFICATION (MANDATORY FOR THIS REVIEW). You are not scoring the manuscript here. For each figure named in the role plan, OPEN the image and read every assertion it makes in pixels - panel titles, annotations, reference lines, axis ranges, and the relative position of marks - then open its source artifact and check each assertion against the numbers. Two shapes of error have reached a manuscript in this project and you are looking for both: a panel title that the panel's own marks refute, such as naming two arms as clearing a threshold the same chart draws four bars past; and an offset that separates values the artifact records as EQUAL, such as adding plus and minus a constant to two measurements of zero on an axis zoomed to a tenth of a unit, in the figure whose claim is that they coincide.\n\nAn assertion the artifact does not support is a discrepancy even when the caption is correct, because a reader takes the drawing as the finding. A figure you could not open is not verified. Report per figure:\n{\"figure_id\": \"...\", \"verified\": true|false, \"checked_against\": \"artifact path and the columns you read\", \"on_image_assertions\": [\"each claim the image makes\"], \"discrepancies\": [\"each assertion the artifact does not support\"]}\n\n`verified` is true only when every on-image assertion is supported. Leaving `checked_against` empty makes the verdict an opinion and it will not clear the figure.";

pub(crate) const ABSTRACT_SCREENING_POLICY: &str = "\n\nLITERATURE SCREENING POLICY (MANDATORY, UNIVERSAL). For any literature search, create a pending abstract-review queue before admission. The lane that ran the search -- a scout, or a gatekeeper checking prior art -- must read the FULL abstract of each candidate it relies on and emit review JSON matching `queue.review_contract`, then finalize with `--finalize-review-dir <lane_dir> --reviews-file <file>`. Only a review with exact objective and abstract hashes, route-relevant evidence, and sufficient quality may enter a hypothesis or graph. Missing abstract, missing review, hash mismatch, or failed quality remains pending or excluded. Never refill a minimum paper count and never use a legacy title-only corpus. Keep recent (<=3 years) work in a separate track from established cited/verified venue-impact work. Older Scout or Chronicle instructions defer to this policy.";

pub(crate) const RESEARCH_API_POLICY: &str = "\n\nRESEARCH API POLICY (MANDATORY, UNIVERSAL). Direct model API calls are permitted only through `drivers/analysis/research_llm.py` using exactly model `gpt-5.6-luna`; do not call a provider SDK, endpoint, or alternate model directly, and do not fall back to another provider or model. Codex CLI work uses the ChatGPT subscription login and must not consume provider API credentials.";

fn compact_search_journal_for_prompt(mut journal: Value) -> Value {
    let Some(rounds) = journal
        .get_mut("search_rounds")
        .and_then(Value::as_array_mut)
    else {
        return journal;
    };
    const MAX_RESUME_ROUNDS: usize = 12;
    if rounds.len() > MAX_RESUME_ROUNDS {
        let omitted = rounds.len() - MAX_RESUME_ROUNDS;
        rounds.drain(0..omitted);
        if let Some(object) = journal.as_object_mut() {
            object.insert("prompt_resume_rounds_omitted".to_string(), json!(omitted));
        }
    }
    journal
}

fn scout_search_journal_candidates(contract: &LaneContract) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(output_dir) = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
    {
        paths.push(output_dir.join("search-agent-journal.json"));
    }
    if let Some(lane_dir) = contract.task_file.parent() {
        let candidate = lane_dir.join("search-agent-journal.json");
        if !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
    paths
}

fn attach_scout_search_journal(mut role_plan: Value, contract: &LaneContract) -> Value {
    if contract.role != "scout" {
        return role_plan;
    }
    let loaded = scout_search_journal_candidates(contract)
        .into_iter()
        .find_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            if metadata.len() > 512 * 1024 {
                return None;
            }
            let value: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            Some((path, compact_search_journal_for_prompt(value)))
        });
    let Some((path, journal)) = loaded else {
        return role_plan;
    };
    if !role_plan.is_object() {
        role_plan = json!({});
    }
    role_plan["search_agent_journal_resume_path"] = json!(path);
    role_plan["search_agent_journal_resume"] = journal;
    role_plan
}

fn native_scout_abstract_review_protocol(
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> String {
    let action_type = role_plan
        .and_then(|plan| plan.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if contract.role != "scout"
        || matches!(
            action_type,
            "data_acquisition_followup" | "reasoning_data_scout" | crate::labdirector::SOTA_DEEP_READ_ACTION
        )
    {
        return String::new();
    }
    let lane_dir = contract.task_file.parent().unwrap_or(&contract.cwd);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(lane_dir);
    let role_plan_path = lane_dir.join("role-plan.json");
    let queue_path = output_dir.join("abstract-review-queue.json");
    let reviews_path = output_dir.join("abstract-reviews.json");
    let journal_path = output_dir.join("search-agent-journal.json");
    let synthesis_path = output_dir.join("search-agent-synthesis.json");
    let probe_args = json!([
        "drivers/literature/search.py",
        "--query",
        "<one inquiry query from the journal>",
        "--output-dir",
        output_dir,
        "--role-plan-file",
        role_plan_path
    ]);
    let import_args = json!([
        "drivers/literature/search.py",
        "--import-candidates-file",
        "<one authored batch JSON>",
        "--output-dir",
        output_dir,
        "--role-plan-file",
        role_plan_path
    ]);
    let citation_args = json!([
        "drivers/literature/search.py",
        "--citations-of",
        "<parent paper DOI>",
        "--direction",
        "references|citations",
        "--output-dir",
        output_dir,
        "--role-plan-file",
        role_plan_path
    ]);
    let finalize_args = json!([
        "drivers/literature/search.py",
        "--finalize-review-dir",
        output_dir,
        "--reviews-file",
        reviews_path,
        "--role-plan-file",
        role_plan_path,
    ]);
    let recovery_source = role_plan
        .and_then(|plan| plan.get("literature_review_source_dir"))
        .and_then(Value::as_str)
        .or_else(|| {
            role_plan
                .and_then(|plan| plan.get("planner_metadata"))
                .and_then(|metadata| metadata.get("literature_review_source_dir"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            role_plan
                .and_then(|plan| plan.get("planner_metadata"))
                .and_then(|metadata| metadata.get("review_action"))
                .and_then(|action| action.get("literature_review_source_dir"))
                .and_then(Value::as_str)
        });
    let recovery_clause = recovery_source
        .map(|source| {
            if action_type == "abstract_review_followup" {
                format!(
                    "RECOVERY OVERRIDE: This is an abstract-review recovery, not a new search. Reuse the saved literature-candidates.json, abstract-review-queue.json, literature-screening-audit.json, abstract-reviews.json, papers.json and reviewed-literature-result.json from {source}. Copy available named artifacts into {} if the current lane has no queue, preserve their manifest and accepted papers, and verify the objective matches this task. Then review only unresolved queue items and finalize below; do not re-run retrieval or re-review already accepted abstracts. If the corpus has only quarantined records, resolve specifically documented missing abstract/quality metadata or record exclusion.\n",
                    output_dir.display()
                )
            } else {
                format!(
                    "ADAPTIVE SEARCH RECOVERY: Resume the original reviewed corpus at {source} without changing `search_agent_contract.research_problem`, hypothesis IDs, or facet IDs. Copy the available search-agent-journal.json, search-agent-synthesis.json, search-agent-assessment.json, literature-candidates.json, retrieval receipts, abstract-review-queue.json, abstract-reviews.json, papers.json, literature-screening-audit.json and reviewed-literature-result.json into {} when this is a distinct lane. Preserve all completed rounds and accepted reviews. Read the saved assessment gaps and run the next gap-specific durable inquiries; do not rerun the full query list or re-review accepted abstracts. RESUMING MEANS SEARCHING: append at least one NEW journal round from a real retrieval before returning, and keep going while the budget allows. Copying the artifacts and re-validating them is not a resumption and the lane is wasted. Start a backward- or forward-citation round only from a paper already accepted in the journal. Before returning, write the synthesis file's claim_paper_links, closest_prior_art, coverage_gaps, unanswered_questions and saturation for the evidence you do hold, even when the search stays incomplete.\n",
                    output_dir.display()
                )
            }
        })
        .unwrap_or_default();
    format!(
        "\n\nNATIVE LITERATURE SCOUT EXECUTION — ADAPTIVE SEARCH AGENT:\n{recovery_clause}\n1. Read the current lane role plan at {} and obey `search_agent_contract`. Its research problem, named hypotheses, and required field facets define scope; facets must come from this objective or its planning context, never from a global domain template. Replace any `pending_scope_definition` facet with agent-authored objective-specific fields before claiming coverage. If a fallback lane has no role-plan.json, create it with the exact research objective from Task and the same contract shape; do not invent a different objective.\n2. Create or resume {} before retrieval. Preserve prior rounds on retries. Each round records round_id, inquiry_intent, hypothesis_ids, facet_ids, question, reason, query, source, parent_paper_ids, result_ids, reading_decisions, and evidence_accepted_ids. The journal's research_problem is search_agent_contract.research_problem copied verbatim, unless search_agent_contract.research_problem_source is objective_text: then it is the ONE question this search answers, stated in a sentence. Put any narrower working question in a separate working_question field. Each round's source is ONE string naming one source, so a query sent to several indexes is one round per index, and a backward- or forward-citation round's source names the citation or reference source it used (for example \"opencitations citation graph\"). The validator rejects a restated problem or a list of sources whatever the round found. Start with two independently motivated inquiries, then change the next query only after reading what the previous round established, contradicted, or left unresolved.\n3. Run one durable inquiry at a time using the interpreter in RESEARCHLAB_PYTHON (or python3 if unset) with argv shaped like {}. This merges candidates, retrieval receipts, and reusable reviews into the same lane directory. For primary or citation-graph candidates authored outside the probe driver, write one batch JSON containing query, sources, and papers, then import it with argv shaped like {}. For a backward- or forward-citation inquiry from a parent paper that has a DOI, run argv shaped like {} with `--direction references` for backward and `--direction citations` for forward; it resolves the parent's citation links through a citation index, fetches each neighbour's registry record, and records the receipt like a query probe, so name that parent in parent_paper_ids. To fetch a known paper by name, use the probe argv with `--title \"<exact title>\"` (repeatable; or `--arxiv-id`/`--doi`) in place of `--query`: it resolves each through arXiv, Semantic Scholar, OpenAlex and Crossref into the same review queue and reports matched/ambiguous/not_found per title; `--sources semanticscholar` (comma list) narrows a `--query` probe, and a citation parent may be an arXiv ID. A refused lookup is recorded with its source and throttle status; record it as a journal round too. Never run an unrecorded lookup. Read the FULL abstract from a primary or trusted scholarly source before accepting any candidate. Bind every accepted paper ID to a named hypothesis and objective-specific facet and record quoted study/task, method, outcome, and limitation evidence. A result ID without that reading decision is screened discovery, not evidence.\n4. The adaptive sequence must include the closest procedure-level prior art, at least one backward-citation inquiry from a relevant parent, at least one forward-citation inquiry, and an adversarial inquiry designed to refute or absorb the proposed novelty. Parent/citation inquiries must name the parent paper IDs and provenance. A failed inquiry is still a journal round and must drive a reasoned pivot; never replace it with generic corpus filling.\n5. Inspect {} after each durable inquiry. Each probe/import updates the queue in place; DO NOT rerun a final batch over the full query list. An existing pending_review queue requires semantic review, not another batch search. Read each queued FULL abstract and write {} according to queue.review_contract. Copy the supplied context_hash, objective_hash, paper_id and abstract_sha256. Missing abstracts, weak route relevance, and malformed or unverified records remain pending/excluded.\n6. EXECUTE the same interpreter with argv {} to finalize WITHOUT repeated retrieval. Inspect papers.json and the screening audit. If validation reports a malformed review, repair the review against the original abstract and finalize again; do not silently admit it. Finalization proves screening integrity only; FINALIZATION ALONE DOES NOT MEAN SEARCH COMPLETE.\n7. Write {} with claim_paper_links, closest_prior_art, coverage_gaps, unanswered_questions, saturation.termination_reason, and next_search_decisions. Coverage is qualitative: every required inquiry intent and field facet needs screened evidence or an explicit unresolved gap. Write each unanswered question and coverage gap as an object {{\"question\": \"...\", \"kind\": \"literature|experiment|host_capability|literature_exhausted\", \"reason\": \"...\", \"searched_in_round_ids\": []}}: `literature` = a further search could answer it (it blocks completion and needs a next_search_decision); `experiment` = only running the study can answer it, and `host_capability` = it is about this machine or its instruments (both say in reason what will answer it); `literature_exhausted` = you searched for it and the literature does not contain it -- name at least two round_ids of this journal that looked. Only `literature` items keep the search open; the others go to the LabDirector. Never label a question you have not searched for `literature_exhausted`. Paper counts, query counts, source counts, and a successful finalize command never establish saturation. If the contract remains incomplete, return status=insufficient_corpus and preserve the next search decisions instead of claiming completion.\n8. Preserve the finalized result.json as reviewed-literature-result.json before returning because the lane runtime writes its execution envelope to result.json. Return compact JSON containing status, evidence_ready, search_complete, journal_path, synthesis_path, papers_path and reviewed_literature_result_path. `search_complete` may be true only when the journal and synthesis satisfy the contract; never claim pending candidates are admitted evidence.\n",
        role_plan_path.display(), journal_path.display(), probe_args, import_args,
        citation_args, queue_path.display(), reviews_path.display(), finalize_args,
        synthesis_path.display(),
    )
}

pub(crate) const AUTHOR_OUTPUT_CONTRACT: &str = "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"target_venue\": {\"standard\": {\"acceptance_rate\": \"the rate the venue itself publishes, as a fraction or a percent\", \"source_url\": \"where you read it\", \"checked_on\": \"ISO date\", \"evaluation_norm\": {\"described\": \"what this venue's OWN recent papers evaluate on - scenes, resolution, sample counts, scale\", \"papers_read\": [{\"title\": \"...\", \"doi\": \"...\", \"what_it_evaluated_on\": \"...\"}]}, \"accepts_contribution_types\": [\"method|benchmark|evaluation|negative_result\"]}, \"name\": \"the journal or conference this manuscript is written FOR\", \"why_this_venue\": \"what about the result fits this venue's scope, in one sentence\", \"guidelines_url\": \"the venue's own current author guidelines that you READ\", \"checked_on\": \"ISO date you read them\", \"format\": {\"anonymity\": \"double-anonymous|single-blind|open|as stated by the venue\", \"length_limit\": \"as stated\", \"section_structure\": \"as stated\", \"abstract_style\": \"structured|unstructured - what the venue's own instructions require, and 'unknown' if they do not say\", \"figure_submission\": \"direct_image_files|figure_deck|unknown - how the venue's template takes figures: a LaTeX class that includes image files is direct_image_files, a venue that asks for a slide deck of editable figures is figure_deck, and 'unknown' if the instructions do not say\", \"reference_style\": \"as stated\", \"template\": \"as stated\"}, \"nearest_paper_in_venue\": {\"title\": \"...\", \"year\": 0, \"what_it_claims\": \"read from THAT paper, not inferred from its title\", \"how_this_differs\": \"one sentence, at the level of the executed procedure\"}},\n  \"manuscript\": {\"title\": \"...\", \"abstract\": {\"background\": \"the problem and why it is open\", \"methods\": \"what was executed\", \"results\": \"what came out, with the numbers\", \"interpretation\": \"what it means and how far it reaches\", \"summary\": \"the same abstract as ONE paragraph, for a venue that prints it that way\"}, \"sections\": [{\"heading\": \"...\", \"body\": \"the section, written in PARAGRAPHS separated by a blank line - review counts them, and one unbroken block of prose scores as a single thin paragraph however long it is\"}], \"figures\": [{\"id\": \"...\", \"caption\": \"...\", \"source_artifact\": \"path to the committed result file this figure is drawn from\"}], \"references\": [{\"key\": \"...\", \"type\": \"article|dataset|software\", \"title\": \"...\", \"venue\": \"journal or proceedings name\", \"year\": 0, \"doi\": \"bare DOI, no URL prefix; omit if the work has none\", \"url\": \"only when there is no DOI\", \"cited_by_count\": 0, \"citation_count_source\": \"where you READ that count, with the date - omit the count entirely rather than estimating it\", \"citation\": \"the formatted reference as it appears in the bibliography\", \"verified_from\": \"where you read what this work claims\"}]},\n  \"contribution_type\": \"method|benchmark|evaluation|negative_result - REQUIRED\", \"controls_that_reproduce_the_result\": [\"REQUIRED, may be empty: every control, sham or ablation whose result MATCHES the proposed method's\"], \"baselines\": [{\"name\": \"...\", \"kind\": \"implementation|proxy\"}], \"evaluation_scale\": {\"described\": \"what you actually evaluated on\", \"matches_venue_norm\": true, \"why\": \"if false, what would have to be measured to reach it\"}, \"next_approach\": {\"approach\": \"what to try next, if anything here did not work\", \"derived_from\": \"the measurement IN THIS WORK that points there - name the number\", \"source_artifact\": \"the artifact that number is in\"}, \"withdrawn_claims\": [\"claims this cycle gave up, in the words they were made in\"], \"refutes\": {\"claim\": \"for a negative_result: the standing claim this kills\", \"source\": {\"title\": \"...\", \"doi\": \"...\"}}, \"additional_experiments_requested\": [{\"claim_it_would_support\": \"the sentence you would write if this existed, written out in full\", \"why_current_evidence_is_short\": \"what the committed artifacts do and do not establish\", \"experiment\": \"what to run, concretely enough for the analyst to design it\", \"what_it_would_measure\": \"the quantity and the comparison\", \"result_that_licenses_the_claim\": \"the outcome under which the sentence becomes true\", \"result_that_refutes_it\": \"the outcome under which you would drop the sentence instead\"}],\n  \"sensitivity_analyses\": [{\"what_was_varied\": \"the knob you turned - budget mode, measurement precision, seed, threshold, arm\", \"range\": \"the values it took\", \"what_moved\": \"the reported quantity, before and after, with its uncertainty\", \"conclusion_holds\": \"yes|no|partly, and under which values it stops holding\", \"source_artifact\": \"committed file the numbers come from\"}],\n  \"supplementary_material\": [{\"id\": \"S1, S2, ... in the order the main text refers to them\", \"title\": \"...\", \"kind\": \"table|figure|derivation|protocol|code|data_dictionary\", \"what_it_contains\": \"the actual content, not a description of its category\", \"why_not_in_main_text\": \"why this belongs in the supplement - length, per-seed detail, or a reader who wants to reproduce rather than to follow the argument\", \"source_artifact\": \"committed file it is drawn from, or the generator that writes it\", \"columns\": [\"for a table: each column and what it holds\"]}],\n  \"numbers_manifest\": [{\"value\": \"the figure as it appears in the prose\", \"source_artifact\": \"committed result file it was generated from\", \"assertion\": \"the check the generator ran before writing it\"}],\n  \"ai_use_disclosure\": {\"writing\": \"...\", \"code\": \"...\"},\n  \"self_check\": {\"read_end_to_end\": true, \"forbidden_phrases_found\": [], \"identity_leak_check\": \"how you checked the PDF's raw bytes\"}\n}\n\nSTAGE 0 - TARGET VENUE, BEFORE ANY PROSE (MANDATORY). Decide where this manuscript is going, then read that venue's OWN current author guidelines and fill target_venue from them. Do not answer from memory: a venue policy recalled rather than read has already been wrong here - T-RO was described as single-blind when it has been double-anonymous since 2025, and submitting on that recollection would have broken the policy. Record the URL you read and the date. Then retrieve the CLOSEST paper published in that venue and state what it claims by reading THAT paper; if you cannot verify a claim about it, weaken your sentence rather than assert it. The venue decides anonymity, length and section structure, so the manuscript cannot be shaped before this is settled. Write the abstract as all five fields whatever the venue's format: the four components are what review checks the abstract COVERS, and `summary` is the single paragraph a venue prints - one abstract, two renderings, so obeying a venue's layout never costs a component. Record abstract_style from the instructions you read rather than from the shape of papers you remember: the review rubric asks for a structured background/methods/results/interpretation abstract by default, and a venue that requires a single unstructured paragraph is the only thing that excuses one - so an unread or guessed answer either forces the wrong abstract or waives a real requirement. figure_submission works the same way: the review checks by default that every figure came through a slide deck of editable panels, which is wrong for a venue whose template simply includes image files, and right for one that asks for the deck.\n\nWRITING RULES (MANDATORY).\n1. LEAD WITH WHAT IS NEW, AND DO NOT KILL IT YOURSELF. Every section, the abstract and any cover letter state the contribution POSITIVELY first. 'Not X but Y' leaves the reader holding X. An honest limitation appears ONCE, in the Discussion, after the contribution, as a subordinate clause and as material rather than as the result. Do not invent novelty that is not there either.\n\n1a. STATE THE CONTRIBUTION AS A CLAIM, NOT AS A GENRE. 'This manuscript contributes a benchmark and a decision audit' names a kind of object; a reader can neither agree nor disagree with it. Write the proposition the work establishes - what is now known, or measurable, or decidable that was not before - in one sentence, in the first paragraph, in the active voice. The category of artifact belongs in the Methods.\n\n1b. THE QUALIFIER NEVER PRECEDES THE RESULT. 'The positive result is narrow and concrete' tells the reader to discount a finding they have not read yet. State the finding, then its scope. Never open a section, a paragraph or the abstract with narrow, limited, preliminary, modest, or only. Do not soften an exact result into a tolerance: a policy that localized the crossing exactly did not match it 'within zero bins'. Where the evidence supports it, write shows, establishes, or measures - not argues for, suggests, or is consistent with.\n\n1c. COUNT YOUR OWN LIMITATION SENTENCES IN THE FRAMING, AND WRITE THEM IN FULL AT THE END. Rule 1 says once, and a draft obeys it sentence by sentence while breaking it across the paper: the v89 manuscript stated its limitation in the abstract, again in the introduction, and twice more in the discussion, each time as a co-equal sentence. Before returning, count the sentences in the abstract and the introduction whose subject is what the work does NOT establish. That count must be zero, and scope belongs there as a subordinate clause instead.\n\nThis is about the FRAMING, not about hiding what the work cannot do. A DEDICATED LIMITATIONS SECTION IS REQUIRED near the end, and deleting it is a worse failure than over-hedging the abstract: the first draft to read this rule removed a 1,622-character Limitations section entirely. Write it in full there - measurement error, what was not measured, model and parameter choices that could carry the result, how the cases were selected, and what stops this from generalising beyond them - with each threat stated as a threat to a specific claim you made rather than as a generic caveat. A sentence about what a prior method does not do is a novelty claim and is not a limitation; do not count it as one and do not move it.\n\n1d. A FALSIFICATION THAT PROVES THE METHOD IS A CONTRIBUTION. When your own audit catches a confound that a conventional evaluation would have shipped, that is the strongest evidence the audit works, and it belongs with the contribution rather than in the limitations. Say what the instrument caught and what would have been published without it. Reporting it as a failure hands away the result you actually have.\n\n1e. IF THE STRONG SENTENCE IS NOT SUPPORTED, ASK FOR THE EXPERIMENT. Do not write it anyway, and do not quietly weaken it either - a hedge is a decision that the paper stays weaker than it needs to be, made where nobody can act on it. Write the sentence you WOULD write, say what the committed artifacts fall short of, and name the run that would close the gap in additional_experiments_requested. Then write the honest weaker sentence in the manuscript meanwhile. Asking costs a cycle; overclaiming costs the paper.\n\nA REVISION RETURNS THE WHOLE MANUSCRIPT, IN THIS SAME SHAPE. When you are asked to clear a gate blocker, reply with the manuscript object above, complete, with the blocker fixed inside it. Do NOT reply with a report ABOUT the revision - no `author_response`, no `resolution`, no `updated_manuscript` wrapper, no diff, no summary of what you changed. Those names appear in this prompt as REVIEW COMMENT ids and as artifact filenames; they are not a reply format, and a reply in that shape is read by nothing. A revision that answers a blocker in a shape the gate cannot read leaves the blocker standing and the next round asks you the same question.\n\nSAY SOMETHING, AND BE ABLE TO DEFEND IT. Not overclaiming is a constraint on a claim; it is not a claim. A manuscript whose every result sentence is qualified has not been careful, it has been empty, and the gate now reads for exactly that: at least one sentence that states what this work establishes, carrying the measured quantity that makes it attackable, with no qualifier in front of it.\n\nA CONTROL THAT REPRODUCES YOUR RESULT HAS REMOVED YOUR MECHANISM. List every sham, ablation and control whose number matches the proposed method's in `controls_that_reproduce_the_result` - the empty list is an assertion you are making, not a field you may omit. If one matches, you do not have a method result yet. The way out is the experiment that separates them, asked for through `additional_experiments_requested`: a condition where the control must fail and the method must not. RESTATING THE SAME EVIDENCE AS A BENCHMARK, AN AUDIT OR A NEGATIVE RESULT IS NOT THE WAY OUT. That is lowering the claim until it fits what you already measured, and it reads as integrity while being a retreat.\n\nA NEGATIVE RESULT HAS A TARGET. If the contribution is that something does not work, name in `refutes` the standing claim it kills and cite where somebody made it. Failing to meet a bound this cycle set for itself is a failed search - a reason to run the next experiment, not a paper.\n\nDO NOT FINISH BY SUBTRACTION. If claims were withdrawn, record them in `withdrawn_claims` AND state what now answers the question they were answering. Retiring a method leaves the question open; a manuscript that only reports what it gave up has not answered anything.\n\nA NEGATIVE RESULT IS AN INPUT, NOT AN ENDING. When something fails, the failure is evidence about where the answer is, and you owe the move it points to. Fill `next_approach`: what to try, and the measurement IN THIS WORK that points there, named as a number. Twenty-seven methods missing the SAME bound is not twenty-seven failures, it is one finding about the problem - say what it implies. `Future work: more scenes, higher resolution` is refused, because it could have been written before the experiment ran, which means the result taught you nothing. Then put that approach in `additional_experiments_requested` so the director can decide to run it: a next step recorded only in the discussion is future work, and future work is where results go to stop.\n2. DO NOT LEAK FILENAMES, PATHS OR IDENTITY. Check the PDF's RAW BYTES, not only the text: pdfTeX stamps figure source paths into /PTEX.FileName, which is how this was caught before. Keep \\pdfsuppressptexinfo=-1. AND CHECK THE VISIBLE TEXT, NOT ONLY THE BYTES. The metadata scan passed on this manuscript while its Data and Code Availability section printed /opt/researchlab/.research-lab/artifacts/stats/<cycle>/followup-runner-102/result.json four times, handing a double-anonymous reviewer the directory layout, the cycle id and the lane numbering. Cite an artifact by the name it has INSIDE the submission package - artifacts/03-summary.csv - or by a repository or archive reference. Never by an absolute path on the machine that produced it: at an anonymous venue it identifies you, and at any venue it is a path no reader can follow. The same rule covers the supplement, the figure captions and the reference list.\n3. DO NOT NARRATE THE WRITING PROCESS. Remove 'will be finalized', 'before submission', 'pending', 'this draft', 'we now added', 'reported in the text', and captions that explain how the paper shows something. A paper describes the research, not its own state.\n4. NO LLM REGISTER, NO IMPRECISE INTENSIFIERS. Banned: additionally, moreover, furthermore, notably, importantly, crucially; leverage, comprehensive, seamless, underscore, delve; very, just, simply, clearly, obviously, various. Keep the field's own terms of art exactly as the field writes them.\n5. EVERY NUMBER IS GENERATED FROM A COMMITTED RESULT FILE, AND WRITTEN LIKE A MEASUREMENT. Do not type a figure into prose. A generator asserts the total, then writes it, and numbers_manifest records the exact value, the source artifact and the assertion. To change a number, change the result, not the sentence. ROUND FOR THE PROSE: carry only the precision the measurement supports - five seeds do not justify sixteen digits, and '0.4444444444444445' is a float's binary expansion, not a result. Quote a ratio of small integer counts AS the counts ('4 of 9 queries'), since that is what was measured and the decimal is an artefact of dividing it. Keep the exact value in numbers_manifest so the rounding is auditable, and state uncertainty to the same precision as the estimate it qualifies.\n6. VENUE POLICY COMES FROM THE VENUE, and a claim about another paper comes from that paper. Where you cannot verify, weaken the sentence. A REFERENCE IS STRUCTURED DATA, not a formatted string: review reads doi, title, type, venue and cited_by_count as fields, so a DOI that appears only inside the citation text is a reference nobody can verify. Report cited_by_count only when you have READ it somewhere you can name, and omit the field otherwise - an invented citation count is a fabricated fact about someone else's work, and a missing one costs a rubric point.\n7. STATISTICAL RIGOUR. Exact tests where they apply (Clopper-Pearson intervals, exact McNemar), the distributional assumptions stated, and any weighting declared as an assumption rather than presented as an observed frequency.\n8. READ THE WHOLE THING ONCE, END TO END. Pattern search does not catch a sentence citing a theorem that does not exist, or a result written as 'collapses the trust boundary' when the number is right there to state.\n9. DISCLOSE AI USE CONSERVATIVELY, limited to writing and code, with no hedged or provisional wording.\n10a. STATE WHAT YOU VARIED AND WHAT MOVED. Review asks whether the result was probed for fragility, and a reader cannot tell from a summary number. For every knob this study turned - budget mode, measurement precision, seed, threshold, arm - record the range it took, the reported quantity before and after with its uncertainty, and whether the conclusion still holds. Where it stops holding, say at which value. An entry that names an artifact without saying what moved is not a sensitivity analysis. If a knob was never varied, leave it out rather than describing an analysis that was not run.\n\n10. WRITE THE SUPPLEMENT IN FULL. The main text carries the argument; the supplement carries what a reader needs to CHECK it, and it is the cheapest place to be thorough. Include, at minimum: the per-unit results the main text summarises (per seed, per family, per condition - not just the mean); the exact configuration needed to re-run the study, naming software versions, seeds, instrument settings, sample counts and any hardware the timing depends on; every preregistered threshold with the value it was fixed at and when; and the full statistical procedure for each reported test, including the alternative, the correction if any, and how ties or boundaries were handled. Bind every item to a committed artifact, and say for each one why it is supplementary rather than main text. Do not list a filename and call it a supplement, and do not promise material that does not exist.\n\nWrite the manuscript from the cycle's committed artifacts: the validation results, the per-seed tables and figures named in validation_artifact_paths, the rigor profile, and the gate reviews. Where the gate's own verdict bears on how strongly a claim may be stated, say so in the Discussion under rule 1.";

pub(crate) const LAB_DIRECTOR_OUTPUT_CONTRACT: &str = "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"decision_status\": \"final|needs_chronicle_evidence\",\n  \"requery_decision\": \"uphold|replace|restart|defer_for_chronicle\",\n  \"summary\": \"brief response to the current evidence and blockers\",\n  \"rationale\": \"why the current lead should be upheld, replaced, restarted, or deferred for a Chronicle evidence request\",\n  \"simulation_orders\": null or [{\"request_id\": \"snake_case id, stable while the design is unchanged\", \"simulator_backend\": \"from planner_metadata.instrument_inventory.simulators[]\", \"interpreter_path\": \"interpreter_path of that entry\", \"scenario\": \"scene, bodies and task per episode\", \"conditions\": [{\"factor\": \"...\", \"levels\": [\"...\"]}], \"seeds\": [0], \"episodes_per_condition\": 0, \"step_or_time_budget\": \"physics steps or simulated seconds per episode\", \"emitted_columns\": [{\"name\": \"...\", \"unit\": \"...\", \"meaning\": \"...\"}], \"output_path\": \".research-lab/datasets/<cycle>/simulations/<request_id>/episodes.csv\", \"hypothesis_link\": \"which contrast on which emitted column supports the selected hypothesis and which meets its falsifier\", \"pilot\": {\"seeds\": [\"a few of the order's seeds\"], \"episodes_per_condition\": 0, \"criteria\": [{\"name\": \"...\", \"metric\": \"a quantity computable from the pilot's episodes.csv\", \"comparator\": \">=|<=\", \"threshold\": 0.0, \"why\": \"what failing it would say about the design\"}]}, \"pilot_only\": false, \"for_candidate\": null}] -- PILOT FIRST (enforced): the engineer runs `pilot` before the full sweep and sweeps only when every criterion holds, so give criteria that would stop a doomed design early (the premise your falsifier assumes, an in-support floor, an effect the full run must at least detect); omit `pilot` and the harness pilots the first two seeds with no criteria beyond the in-support check. RUNNER-UP PILOTS: you may add up to two extra orders with `pilot_only: true` and `for_candidate` = the statement of a candidate_hypothesis_ranking entry; the engineer runs only their pilot, they hold no analyst or gate, and their results reach you as planner_metadata.alternate_pilots when the lead is next reconsidered -- a replacement then starts from a pilot, not from zero. null unless materialized_bundle_mandate.procedural_data_generation_acceptable is true and instrument_inventory.simulators is non-empty; you design the run, one engineer lane runs each order, and analysts analyse its episodes.csv,\n  \"chronicle_requests\": [{\"question\": \"precise evidence clue Chronicle should find\", \"why_needed_for_decision\": \"which decision this answer could change\", \"source_scope\": [\"compact source refs or named artifacts Chronicle should inspect\"], \"priority\": \"critical|high|medium\"}],\n  \"experiment_request_decisions\": [{\"claim_it_would_support\": \"copy it verbatim from pending_experiment_requests\", \"decision\": \"adopt|decline\", \"reason\": \"REQUIRED either way\"}], \"replacement_hypotheses\": [{\"research_problem_question\": \"the ONE question this replacement still answers, restated in full - the same question as the lead it replaces unless you are retiring it\", \"methods_tried\": [{\"approach\": \"what was tried against THIS question\", \"outcome\": \"what the run measured\", \"what_it_rules_out\": \"what the failure tells you to change\"}], \"retires_the_question\": \"false when this is a different METHOD for the same question, which is the normal case after a falsification; true only when methods_tried already holds three distinct approaches and you are abandoning the question itself\", \"landscape_open_problem_id\": \"as in selected_hypothesis\", \"landscape_paper_ids\": [\"as in selected_hypothesis\"], \"slate_candidate_id\": \"as in selected_hypothesis; a replacement names another id of expert_selection.owner_vetted_candidate_ids\",\"statement\": \"...\", \"primary_family\": \"...\", \"why_selected\": \"...\", \"supporting_literature_edges\": [\"literature_graph edge ids or summaries\"], \"supporting_data_graph_edges\": [\"data_graph edge ids or dataset-node links\"], \"validation_data_status\": \"materialized|needs_materialization\", \"dataset_or_accession\": \"candidate validation dataset or its identifier when known\"}],\n  \"research_problem\": {\"question\": \"the ONE question this cycle sets out to answer, stated before any hypothesis exists\", \"source\": \"field_flagged_gap|unposed\", \"why_not_already_answered\": \"what has stopped anyone from answering it - missing instrument, missing data, unexamined assumption, or simply never asked\", \"evidence_of_absence\": [\"for an unposed question: the component queries showing each element is well covered while the conjunction is not. Chronicle returns these as component_absence_matrix - one row per component with the query it ran and what it found - so COPY those rows here rather than restating what you are still waiting for. A verdict of corpus_too_thin_to_say is a usable answer: record it, state the question as provisionally unposed with that caveat, and PROCEED to a hypothesis. Do not defer a second time for the same matrix; cycle-g-v84 held a well-formed question for 99 minutes and 22 lanes at zero gate rounds doing exactly that.\"], \"who_or_what_it_blocks\": \"what someone would do differently once it is answered\", \"answerable_here_because\": \"CITE a verified instrument: name an entry from instrument_inventory.verified_instruments or instrument_inventory.measurable_quantities and the measurement in it that makes this question answerable. This is a citation of something a probe already RAN in this container, not a promise about what an unverified instrument might support.\", \"instrument_gap\": \"if the question needs an observable that is NOT in the inventory: name it here and EITHER restate the question over an observable that IS verified, OR emit one methods_followup asking a runner lane to build the instrument and re-probe. Do NOT retire the problem for a missing instrument - cycle-g-v82 retired 100 problems in a row that way and produced zero gate rounds in 5.5 hours. An empty or absent instrument_inventory means NOT PROBED YET, never NOT POSSIBLE: request the probe and keep the question.\", \"methods_tried\": [{\"method\": \"the distinct approach attempted for THIS question - the estimator, instrument or design that was executed, not the hypothesis wording\", \"outcome\": \"falsified|inconclusive|blocked\", \"evidence\": \"the run and the number that settled it\", \"why_the_next_method_differs\": \"what this failure tells you to change - a failed method is a measurement about the problem, so use it\"}], \"problem_retirement\": \"leave null while the question stands. Set it ONLY when the question itself is answered or shown ill-posed - not when a method failed - and state which result answered it. A falsification kills the METHOD; the question survives it. cycle-g-v87 measured the cost of confusing the two: nine of eleven falsification-driven replacements changed the question, the cycle wandered five families in ten hours and then re-derived its own opening question by accident, having tried three different predictors for that one boundary under three different questions - so none was ever a second attempt at the first.\"},
  \"selected_hypothesis\": {\"statement\": \"...\", \"answers_research_problem\": \"restate the research_problem.question this hypothesis answers\", \"primary_family\": \"...\", \"dataset_or_accession\": \"candidate validation dataset or its identifier when known\", \"validation_data_status\": \"materialized|needs_materialization\", \"supporting_literature_edges\": [\"...\"], \"supporting_data_graph_edges\": [\"...\"], \"same_dataset_reference_papers\": [], \"reference_methods_baseline\": null, \"falsification_conditions\": [\"the observation that would show this hypothesis false - a number and a direction, not a topic\"], \"rival_mechanisms\": [\"a mechanism that would produce the same measurement without this hypothesis being true\"], \"candidate_hypothesis_ranking\": [{\"statement\": \"a candidate you did NOT select\", \"expected_impact_score\": 0, \"validation_data_availability_score\": 0, \"validation_data_blockers\": [\"what stops it being validated here\"], \"why_not_selected\": \"one sentence\"}], \"identification_strategy\": {\"design\": \"the design actually declared, whatever kind it is\", \"outcome\": \"the measured quantity\", \"estimands\": [\"...\"], \"validation_data_status\": \"materialized|needs_materialization\", \"materialized_dataset\": null}, \"trend_positioning\": \"where this sits against research_trend_analysis - which open_problem it answers and which proposed_method it is nearest to\", \"attention_concentration_basis\": \"the attention_concentration entry this judgement rests on\", \"research_trend_analysis_path\": \"the path of the trend analysis you wrote\", \"landscape_open_problem_id\": \"the open_problem_id in role_plan.planner_metadata.field_landscape.open_problems this lead answers\", \"landscape_paper_ids\": [\"paper_ids from field_landscape.papers this lead builds on - at least field_landscape.min_lead_citations, at least one with frontier=true\"], \"slate_candidate_id\": \"once planner_metadata.expert_selection.engaged is true: selected_candidate.candidate_id, the owner's pick from the expert-selected slate; null otherwise\", \"chronicle_dialogue\": [\"each exchange with Chronicle that led here, one string per turn, at most three\"]},\n  \"validation_changes\": [\"specific validation changes LabDirector will request next\"],\n  \"rebuttal_experiments\": [{\"answers_objection\": \"copied verbatim from planner_metadata.rebuttal_targets.objections\", \"target_rubric\": \"the rubric it would raise\", \"experiment\": \"the run that would settle it and the number it must show\", \"preferred_role\": \"lab-runner|analyst|scout\"}],\n  \"gate_blocker_review_requests\": [{\"request_id\": \"stable id\", \"blocker\": \"exact unresolved blocker text\", \"target_rubric\": \"novelty|technical_quality|reproducibility|clarity|impact|strobe_reporting_completeness|gate_independence\", \"requested_action\": \"reconsider|remove|downgrade|mark_resolved|supersede\", \"rationale\": \"why supplied evidence makes the blocker stale, resolved, mis-scoped, or too broad\", \"evidence_refs\": [\"paths or compact evidence labels\"], \"replacement_blocker\": null}],\n  \"next_actions\": [\n    {\"type\": \"hypothesis_followup|methods_followup|novelty_followup|gate_restart_followup|data_acquisition_followup|chronicle_evidence_request_followup\", \"description\": \"...\", \"preferred_role\": \"lab-runner|analyst|scout|lab-director|chronicle\"}\n  ]\n}\nDo not scan broad directories. Read only current-cycle artifacts explicitly named in role_plan/context_refs. You may freely ask Chronicle for targeted evidence before deciding: if a crucial clue is missing, set decision_status=needs_chronicle_evidence, requery_decision=defer_for_chronicle, and emit precise chronicle_requests instead of fabricating a final decision. After Chronicle responses appear in planner_metadata.chronicle_evidence_responses, adjudicate them and either ask a sharper follow-up or issue the final keep/replace/restart decision. If a gate blocker is unresolved only because it is stale, already answered by newer validation evidence, too broad for the narrowed claim, or should be replaced by a sharper blocker, emit `gate_blocker_review_requests` and cite exact evidence_refs; do not silently delete reviewer objections yourself. PROBLEM BEFORE HYPOTHESIS (MANDATORY): decide WHAT QUESTION you are answering before you write any hypothesis. Emit `research_problem` first and let it constrain everything after it; a hypothesis authored before its problem is a method looking for a use, which is how a cycle ends up re-confirming an established result with a slightly different estimator. If you cannot yet state the question - because the corpus is too thin to tell what is unsolved or to prove a question is unasked - do NOT invent a hypothesis to fill the gap: set decision_status=needs_chronicle_evidence and ask for exactly the evidence that would let you state it. selected_hypothesis MUST carry answers_research_problem naming that question. Hypothesis-narrowing protocol (MANDATORY, stated in full here): do NOT emit a full lead in one shot from the densest evidence cluster (that yields a re-confirmation of an established result = honest-low novelty). NARROW it progressively, in DIALOGUE with the literature AND data scouts: (1) survey the field's current state of the art and its distinct active directions from the literature_graph/trend summary; (2) identify a real OPEN PROBLEM from EITHER of two sources - (2i) an unsolved/contested/named limitation across that prior art, which is ceiling-bound because a gap the field already flagged is one the field is already working on; or (2ii) an UNPOSED PROBLEM you CONSTRUCT - a question answerable with this environment's instruments whose answer would change what someone does and that NO ONE HAS ASKED. Do not look for (2ii) in the field's stated limitations; build it, then use the literature to verify its ABSENCE rather than to find it, and name the question's components (objects, measured quantity, setting, instrument) showing each is well covered while the QUESTION is not - without that evidence the gatekeeper must score it unverified rather than novel. A new TASK outranks a new method for an old task; (2b) NOVELTY MUST COME FROM THE METHOD FAMILY, NOT ONLY THE DOMAIN — name the densest prior-art METHOD family (the family your own and the gatekeeper prior-art search will most heavily populate, grounded in this objective's retrieved literature) and prefer an open problem whose best-fit solution is a DIFFERENT method family (with a substantively different executed procedure and a documented prior-art gap), because a domain or benchmark shift, or a stronger comparator on the SAME saturated method family, lifts honest novelty only marginally and leaves it structurally capped below the gate; do not mistake a domain shift or a stronger baseline for a novelty pivot; (2c) VALUE TEST, discard the lead if any check fails: V1 non-obvious (if a domain expert could confidently bet on the outcome before the experiment, e.g. a purpose-built method beating a weaker baseline on the very regime it was designed for, it is an EXPECTED RESULT - discard, and state WHY the outcome is not already predicted by the named prior art); V2 informative either way (both the TRUE and the FALSE outcome must teach something substantive); V3 structural claim not a horse-race (claim WHEN/WHY/HOW MUCH: mechanism, quantified trade-off, scaling law, failure boundary, crossover condition - not just X beats Y); V4 named delta versus the STRONGEST SOTA the gatekeeper search will surface (beating uniform/weak baselines does not clear the gate); V5 real falsification risk (name the outcome that kills the hypothesis and why it is plausible); write the V1 justification and V4 named-SOTA delta into the hypothesis statement itself; (2d) CROSS-DOMAIN METHOD TRANSFER - exploit your LLM advantage but transfer the METHOD, never just the story: the gatekeeper prior-art search scores the experimental PROCEDURE the validation actually executes, not the hypothesis vocabulary, so renaming a saturated in-field method in another field language changes nothing (observed: a rare-event-transport-lens NARRATIVE over unchanged path guiding scored novelty 20 while an imported epidemiology-style confounding-audit DESIGN, where the audit itself was the experiment, scored 38, the cycle high). A lead counts as cross-domain ONLY if the import changes at least one of: the sampling/estimation procedure executed, the analysis design applied to outputs, the data/experiment construction, or the quantity measured and modeled. Transfer shapes: IMPORT an estimator or analysis design from another field and RUN it (epidemiology confounding/artifact audit as the experiment itself; importance splitting / subset simulation implemented as the actual sampler; a psychophysical threshold model fitted as the error metric); EXPORT this domain methods onto a MATERIALIZED foreign regime where a core assumption measurably breaks (volumetric microscopy, gravitational lensing, non-Euclidean transport) and claim the failure structure; or TRANSFER a formal bound/scaling law/phase transition into a quantitative prediction the in-field literature does not contain, then test it. RENAME TEST before finalizing: delete every cross-domain word and describe only what the validation executes - if what remains is a standard in-field comparison, the transfer is cosmetic, discard or redo it at the procedure level; ask which field literature holds the closest prior art for the PROCEDURE - if still this domain dense cluster, no shift happened. Generate 2-3 candidates that survive this test, prefer the thinnest procedure-level prior art, and still pass the value test and testability; (2e) INVERSION - generate at least ONE candidate that reverses what the field treats as waste: name something practitioners REMOVE, SUPPRESS, CLAMP or TOLERATE (measurement noise, residual errors, sample correlation, missing observations, quantization, temporal lag), ask what it measurably ENCODES, and make it the INSTRUMENT - 'the field removes X; X encodes Y; we estimate Y FROM X'. Shape from another field: motion blur is normally deblurred away, yet it encodes the camera and scene motion during the exposure, so the exposure interval's dynamics can be recovered from the blur itself - the defect became the data. This inverts an assumption rather than swapping a method family, so the closest prior art is about DELETING X and thin on MEASURING Y. Same bars apply: it must pass the value test and the rename test, and the validation must actually MEASURE Y against simulation ground truth, not re-describe an existing method as 'exploiting' X; (3) scope it to what THIS environment/data can actually test - validation must be COMPLETABLE with accessible data (materialized bundles, procedural generation, confirmed public registries) and this runtime's real methods; PREFER hypothesis shapes supported by the verified instruments. When simulation is appropriate and verified, use only the ground truth, replication, parameter sweeps, and controlled counterfactual pairs it actually supports to test scaling laws, failure boundaries, crossovers, and mechanism isolation; cite measured capabilities and costs from the current inventory, and state any synthetic-to-real transfer boundary as part of the claim; (4) if the corpus is too broad, misses the open problem's direct prior art, or the needed data/experiment is unconfirmed, DO NOT GUESS — set decision_status=needs_chronicle_evidence with precise chronicle_requests AND emit next_actions asking the literature scout (novelty_followup) for the open-problem prior art and the data scout (data_acquisition_followup) for the dataset or experimental conditions that make it testable, then refine against what returns and repeat. Only finalize selected_hypothesis when it is SPECIFIC (a concrete mechanism/claim, not a family label), targets a real open problem (novel beyond the prior art you actually retrieved), and is TESTABLE here. Select hypotheses from literature_graph + data_graph first. Same-dataset reference papers and baseline methods are validation-design requirements, not prerequisites for initial hypothesis selection. If the best hypothesis lacks a fetched bundle, set validation_data_status=needs_materialization and add a concrete data_acquisition_followup naming the needed dataset or its identifier; do not restart solely because validation data is not materialized yet.\nNovelty-rejection pivot rule (MANDATORY): it applies once the lead's refinement window has closed. While the harness's lead ledger denies a pivot (a LEDGER PIVOT DENY or lead-protection directive in your role plan, e.g. novelty_refinement_window -- a lead's first two novelty-reviewed gate rounds), refine the lead in place and do not apply this rule; a valid falsification releases the lead at once. Otherwise: when the gate verdict is reject or challenge primarily for low novelty or low impact — especially when `major_objections`, `incumbent_rejection_reasons`, or `switch_triggers` in role_plan / planner_metadata.review_action indicate that a same-dataset or prior publication already reports the incumbent lead's headline finding — you MUST NOT answer requery_decision=uphold. Choose `replace` (or `restart`) and adopt the strongest supplied `cross_family_alternatives` / `family_switch_recommendations` / `better_alternative_hypotheses` as the new selected_hypothesis with its primary_family, stating in rationale why it materially exceeds the state-of-the-art baseline the gate cited. If that alternative family's dataset is not yet fetched, set validation_data_status=needs_materialization and add a concrete data_acquisition_followup naming it; do not keep the incumbent merely because the alternative needs materialization. You may uphold a lead the gate rejected for novelty ONLY if you cite specific new evidence that the incumbent genuinely exceeds the prior work the gate named; defending it without such evidence, or re-upholding the same lead across passes while the same novelty objection stands, is not allowed. Anti-circumvention: choosing requery_decision=replace but then re-selecting the rejected incumbent (same primary_family/dataset/accession) as selected_hypothesis or as the first replacement_hypotheses entry is the SAME violation as uphold and is not allowed. When the gate rejected the incumbent for novelty, the new selected_hypothesis and the first replacement_hypotheses entry MUST be a different primary_family and dataset than the rejected incumbent. Data-readiness, executability, an already-fetched bundle, or a Chronicle digest ranking the incumbent as the \"strongest executable lead\" are NOT novelty and MUST NOT be used to keep or re-rank the rejected incumbent ahead of a genuinely more-novel alternative; if the chosen novel family's data is not fetched, set validation_data_status=needs_materialization and emit a data_acquisition_followup for it and let materialization proceed.\nDECIDE THE EXPERIMENTS THE AUTHOR ASKED FOR. `pending_experiment_requests` in your role plan holds runs the author says would license a claim it cannot yet write. You own that decision - the author may ask, and only you may commit the programme's budget to it. Answer EVERY pending request in `experiment_request_decisions`, copying `claim_it_would_support` verbatim so the ledger can match it, with `adopt` or `decline` and a reason. A reason is required in BOTH directions: declining without one is indistinguishable from not having read it, and the request stays pending forever if you leave it out. Adopt when the run would settle a claim the manuscript is currently making without support - a control that reproduces the method's result is exactly that case. Decline when the programme should spend the budget elsewhere, and say where.\n\nLead-hold rule (ENFORCED by the harness, not advisory): a new lead cannot be replaced until a runner has executed a handoff written for it and a gate round has reviewed that evidence, unless that evidence validly falsified it, or it has already held the configured number of gate rounds. A replacement you propose before then is NOT applied; it is recorded in the lead file under replacement_deferred with the reason and what releases it. So when the current lead has no evidence of its own yet, do not spend this decision on a new lead: name the experiment the current lead needs and request it in next_actions. Your deferred replacement stays on record for the director who decides after the evidence arrives.\nField-landscape gate (ENFORCED by the harness, not advisory): no lead is selected or replaced until role_plan.planner_metadata.field_landscape.status is valid, and a selection is applied only when selected_hypothesis (or the replacement_hypotheses entry that would become the lead) carries landscape_open_problem_id naming one of field_landscape.open_problems and landscape_paper_ids citing at least field_landscape.min_lead_citations of field_landscape.papers, at least one of them frontier=true. Anything else is NOT applied; the precise reason is recorded in field_landscape.last_selection_rejections. INSTRUMENTS DECIDE FEASIBILITY, NEVER THE PROBLEM: first choose the open problem across ALL subfields of the landscape by significance and frontier gap, then read its instrument_fit to decide whether and how this host can test it; if none of the significant problems is testable here, say so and name the instrument gap rather than retreating to the question the most ready instrument can answer. While the landscape is missing or invalid, set decision_status=needs_chronicle_evidence, do not select a lead, and never tell scouts to stop, narrow or defer broad acquisition.\nExpert-selection gate (ENFORCED by the harness once role_plan.planner_metadata.expert_selection.engaged is true): the lead comes from the expert-selected slate. No lead is selected until the owner has picked a candidate; then selected_hypothesis IS expert_selection.selected_candidate -- its hypothesis (sharpen the wording, never change the claim), slate_candidate_id set to its candidate_id, and its landscape_open_problem_id and landscape_paper_ids -- with its reproduction anchor planned first. A later replacement must be another id in expert_selection.owner_vetted_candidate_ids. Anything else is NOT applied and the reason is recorded where the landscape gate records its own.\nMethod-persistence rule (MANDATORY):EVERY replacement_hypotheses entry carries research_problem_question and methods_tried, and that is where this rule is counted. A replacement that keeps the question repeats the question verbatim and appends the dead approach to methods_tried with what it rules out; a replacement that abandons it sets retires_the_question true, which is only permitted once methods_tried already holds three distinct approaches. Leaving either field empty is not a neutral omission - it is the pivot that this rule cannot see, and 118 replacements in one cycle carried neither.  A VALID FALSIFICATION RETIRES THE METHOD, NOT THE QUESTION. When a run correctly executes and kills the current approach, that is a measurement ABOUT your research_problem, not a verdict against it - keep the question and bring a DIFFERENT method to it. Record the dead approach in research_problem.methods_tried with what the failure tells you to change, and let that shape the next one: a predictor that lost to a sham says the signal is not where you looked, not that the boundary is unfindable. You may NOT retire a research_problem until methods_tried holds at least THREE distinct approaches for it - distinct in the procedure EXECUTED (different estimator, instrument, or design), not in wording - and even then you must say in problem_retirement which result answered the question rather than which method failed. This is the falsification twin of the instrument_gap rule above, and it exists for the same reason: cycle-g-v87 abandoned its opening question after ONE falsified predictor, spent ten hours and five unrelated families, and then re-derived that same question from scratch - while the two other predictors it needed had each already been built and attached to a different question. Changing the question is the expensive move: it discards the literature scan, the absence matrix, the instruments and every round the gate has already spent. Changing the method keeps all of it. When the gate rejects for novelty AND your method was just falsified, prefer a genuinely different method for the same question over a new question - the novelty-rejection rule above asks for a different method FAMILY, which a second attempt at the same problem satisfies.\nNovelty-first sequencing rule (MANDATORY): ESTABLISH THE AXIS YOU CANNOT BUY BEFORE SPENDING BUDGET ON THE ONES YOU CAN. Prior art either exists or it does not, so no number of additional runs can raise novelty; technical_quality, reproducibility and clarity are precisely what more seeds, more comparators, tighter intervals and better writing DO buy. Plan in that order. While novelty is below the gate threshold, the next action you request must be a novelty action -- a prior-art audit that names the closest PROCEDURE-level neighbour, a method-family shift, or an inversion that makes the executed procedure differ from the dense cluster -- and NOT another validation run on a lead whose differentiation is still unverified. Once novelty is established, convert the remaining budget into the buyable axes as fast as it will go. MEASURED ON cycle-g-v89, at round 46 with 56% of the budget spent: clarity 91, reproducibility 86, technical_quality 82, novelty 64, impact 58. The cycle bought everything buyable and reached the wall held by the one thing it could not buy, with 35 rounds left that could not help. Corollary for reading the gate: when the binding (lowest) rubric is technical_quality or reproducibility, more validation is the right answer; when it is novelty, more validation is the WRONG answer however cheap it looks, and a differentiation or method-family move is the only one that moves it.\nREBUTTAL BEFORE REPLACEMENT (MANDATORY when planner_metadata.rebuttal_targets is present): the gate's binding rubric and its answerable objections are listed there. When you uphold, emit at least one rebuttal_experiments entry that answers the binding rubric's objection -- the run that would settle it and the number it must show; it is dispatched like next_actions, so make it executable here. When you replace instead, say in rationale why no experiment could answer those objections. A runner-up you ordered with pilot_only appears in planner_metadata.alternate_pilots with its pilot's numbers; a replacement should start from a pilot that passed, not from zero.";

/// The LabDirector's simulation-orders duty, rendered when the lane LAUNCHES.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18. A rule written only into task.md
/// reaches a lane when it is CREATED; followup-analyst-09 was created before the
/// build that added the simulator rule and launched after, so it never read it.
/// The owner then assigned simulation orchestration to the LabDirector (an
/// analyst-declared request let the analyst choose the experiment), and director
/// lanes queued before that build carry the same stale task.md. The role plan is
/// refreshed at launch, so the condition is read from there.
/// The field-landscape scout's own deliverable, on top of the ordinary adaptive
/// search protocol (cycle-b-20260918: no field-wide survey was ever run, and
/// the first query was already the most ready instrument's topic). See
/// labdirector::field_landscape.
fn field_landscape_scout_clause(contract: &LaneContract, role_plan: Option<&Value>) -> String {
    let action_type = role_plan
        .and_then(|plan| plan.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let deep_read = action_type == crate::labdirector::SOTA_DEEP_READ_ACTION;
    if contract.role != "scout" || (action_type != crate::labdirector::FIELD_LANDSCAPE_SCOUT_ACTION && !deep_read) {
        return String::new();
    }
    let lane_dir = contract.task_file.parent().unwrap_or(&contract.cwd);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(lane_dir);
    // The SOTA deep read's own protocol replaces the abstract-screening one
    // (labdirector::sota_cards): it reads full texts and writes cards.
    if deep_read {
        return crate::labdirector::sota_deep_read_scout_protocol(output_dir, &lane_dir.join("role-plan.json"));
    }
    crate::labdirector::field_landscape_scout_protocol(output_dir, &lane_dir.join("role-plan.json"))
}

fn lab_director_simulation_orders_clause(
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> String {
    if contract.role != "lab-director"
        || crate::labdirector::expert_selection_action_of(role_plan).is_some()
    {
        return String::new();
    }
    let metadata = role_plan.and_then(|plan| plan.get("planner_metadata"));
    let generated_data_accepted = metadata
        .and_then(|value| value.get("materialized_bundle_mandate"))
        .and_then(|value| value.get("procedural_data_generation_acceptable"))
        .and_then(Value::as_bool)
        == Some(true);
    let has_simulator = metadata
        .and_then(|value| value.get("instrument_inventory"))
        .and_then(|value| value.get("simulators"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    if !(generated_data_accepted && has_simulator) {
        return String::new();
    }
    format!(
        "\n\nSIMULATOR IS THE DATA SOURCE AND YOU ORDER THE SIMULATION (no analyst designs it; an engineer runs your order, then analysts analyse its output):\n{}",
        crate::labdirector::policy::simulation_orders_directive(&contract.cycle_id)
    )
}

pub(crate) fn build_codex_prompt(
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<String> {
    let max_prompt_bytes: usize = codex_max_prompt_bytes();
    let max_task_chars: usize = 24_000;
    let compacted_role_plan = role_plan.map(compact_role_plan_for_prompt);
    let raw_task_text = fs::read_to_string(&contract.task_file).unwrap_or_default();
    let mut task_text = truncate_chars(&raw_task_text, max_task_chars);
    let action_type = compacted_role_plan
        .as_ref()
        .and_then(|value| value.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let target_rubric = compacted_role_plan
        .as_ref()
        .and_then(|value| value.get("planner_metadata"))
        .and_then(|value| value.get("target_rubric"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let review_standard = compacted_role_plan
        .as_ref()
        .and_then(|value| value.get("planner_metadata"))
        .and_then(|value| value.get("review_standard"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let figure_verification_clause =
        if contract.role == "gatekeeper" && target_rubric == "figure_evidence" {
            GATEKEEPER_FIGURE_VERIFICATION_CLAUSE
        } else {
            ""
        };
    let gatekeeper_focus_clause = if contract.role == "gatekeeper" && !target_rubric.is_empty() {
        format!(
            "\nYou are one reviewer in a multi-reviewer gate. Your primary review focus is `{}` under `{}`. Score that rubric directly and score coupled rubrics only if they are necessary to justify your verdict.",
            target_rubric,
            if review_standard.is_empty() { "the specified review standard" } else { review_standard }
        )
    } else {
        String::new()
    };
    // An expert-selection stage answers in its stage's own shape, whatever its
    // role (labdirector::problem_selection).
    let expert_selection_contract = crate::labdirector::expert_selection_output_contract(role_plan);
    let output_contract = if let Some(stage_contract) = expert_selection_contract.as_deref() {
        stage_contract
    } else if contract.role == "gatekeeper" {
        "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"reviewer_id\": \"short stable reviewer label\",\n  \"reviewer_focus_rubric\": \"novelty|technical_quality|reproducibility|clarity|impact|consort_reporting_completeness|strobe_reporting_completeness\",\n  \"reviewer_standard\": \"research|CONSORT|STROBE\",\n  \"verdict\": \"approve|challenge|reject\",\n  \"summary\": \"one-paragraph critical assessment\",\n  \"rubric\": [\n    {\"name\": \"novelty\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"technical_quality\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"reproducibility\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"clarity\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"impact\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"consort_reporting_completeness\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true},\n    {\"name\": \"strobe_reporting_completeness\", \"score\": 0-100, \"reasons\": [\"...\"], \"applicable\": true}\n  ],\n  \"major_objections\": [\"critical external-review objections about hypothesis quality, reporting completeness, or evidentiary weakness only\"],\n  \"same_family_alternatives\": [{\"statement\": \"...\", \"why_better\": \"...\"}],\n  \"cross_family_alternatives\": [{\"statement\": \"...\", \"family_root\": \"...\", \"why_better\": \"...\"}],\n  \"family_switch_recommendations\": [{\"from_family\": \"...\", \"to_family\": \"...\", \"reason\": \"...\"}],\n  \"switch_triggers\": [\"conditions under which the incumbent family should be abandoned\"],\n  \"incumbent_rejection_reasons\": [\"why the current family should lose against rival families\"],\n  \"better_alternative_hypotheses\": [{\"statement\": \"...\", \"why_better\": \"...\"}],\n  \"missing_validations\": [\"validation the current work still lacks\"],\n  \"required_response_from_lab_director\": [\"questions LabDirector must answer about hypothesis choice or validation quality\"],\n  \"blocker_adjudications\": [{\"blocker\": \"prior/current blocker text under review\", \"decision\": \"uphold|remove|resolved|superseded|downgrade\", \"rationale\": \"why the blocker should remain or be removed\", \"target_rubric\": \"...\", \"evidence_refs\": [\"artifact paths or evidence labels\"]}],\n  \"restart_recommended\": true,\n  \"recommended_actions\": [\n    {\"type\": \"gate_restart_followup|lab_director_requery_followup|methods_followup|novelty_followup\", \"description\": \"...\", \"preferred_role\": \"lab-director|lab-runner|analyst|scout\"}\n  ]\n}\nGatekeeper context requirements: before scoring, read `role_plan.previous_review_context`, `role_plan.gate_reviewer_context.previous_review_context`, and `role_plan.planner_metadata.review_action.previous_review_context` when present. Address unresolved prior gate, conclusion, report, or paper review comments explicitly as resolved, still blocking, or superseded. Also read `role_plan.chronicle_research_context`, `role_plan.gate_reviewer_context.chronicle_research_context`, and `role_plan.planner_metadata.review_action.chronicle_research_context` when present; use Chronicle's trend summary, research-trend analysis, literature graph, and latest paper list to infer the current state-of-the-art baseline. If `role_plan.planner_metadata.review_action.lab_director_blocker_review_requests` or `role_plan.lab_director_blocker_review_requests` is present, adjudicate each requested blocker in `blocker_adjudications`; remove/downgrade only blockers that are stale, resolved by supplied evidence, superseded by a sharper blocker, or outside the current hypothesis scope. Do not rely only on stale reviewer memory or only on the current lane's narrow task text.\nAct like an independent critical reviewer, not like LabDirector's assistant. Judge only the quality of the hypotheses, evidence, identification strategy, confound handling, falsification, robustness, validation completeness, and reporting completeness under the specified standard. For `novelty`, do NOT rely only on the handed-over retrieved paper set — it is often topically incomplete or biased toward one sub-area (e.g. papers about an adjacent method family while the lead's own closest comparators are absent), which makes a non-novel lead look novel. FIRST search for the lead's DIRECT prior art yourself: author 2-4 targeted prior-art queries in the field's own expert vocabulary (name the lead's specific method/claim plus foundational / survey / 'baseline' / seminal-method terms — not just the trendiest recent sub-area) and run `python3 drivers/literature/search.py --query \"<your query>\"` for each. Your search is screened like any other: read the FULL abstracts of the candidates in your lane's `abstract-review-queue.json` that bear on the lead's core claim (its direct prior art first; you need not review the whole queue), write them to `abstract-reviews.json` matching `queue.review_contract`, and finalize with `python3 drivers/literature/search.py --finalize-review-dir <your lane dir> --reviews-file <that file>`. Judge novelty from what you reviewed. \"Novelty is unverified because the candidates are pending review\" is not a finding: reviewing them is this lane's job, and no other lane will. THEN infer the state-of-the-art baseline from BOTH what your own search returns AND the handed retrieved paper set, Chronicle research context, and knowledge graph, and judge whether the lead materially exceeds it. If your own search surfaces prior work that already reports the lead's core claim or technique, score novelty LOW and NAME that prior work in `reasons`; award high novelty ONLY when neither the handed corpus NOR your own targeted search finds the direct prior art. (The search driver is read-only retrieval; run it one query at a time and do not otherwise scan the repository.) Do not mainly propose better variants inside the same incumbent family. Prefer cross-family alternatives when the current root family is weak. State explicit switch triggers that tell LabDirector when to abandon the incumbent family. Do not use runtime duration, active-window timing, pass counts, missing paper/report artifacts as operational issues, formatting polish, or operational contract compliance as reasons to reject or challenge unless they directly make the scientific evidence invalid. If the current hypothesis family is too weak, too obvious, insufficiently falsified, incompletely reported under the applicable checklist, or clearly dominated by better alternatives, use verdict \"reject\" and set restart_recommended=true."
    } else if contract.role == "lab-director" {
        LAB_DIRECTOR_OUTPUT_CONTRACT
    } else if contract.role == "chronicle" {
        "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"summary\": \"short chronicle summary of what changed in this pass\",\n  \"lab_director_question_answer\": {\"question_answered\": \"...\", \"answer\": \"decision-relevant clue\", \"confidence\": \"high|medium|low\", \"source_paths\": [\"...\"], \"decision_implication\": \"what LabDirector should decide differently if this clue is accepted\"},\n  \"component_absence_matrix\": {\"asked_for\": true|false, \"combined_question\": \"the conjunction LabDirector wants to establish as unposed, restated\", \"components\": [{\"component\": \"one element of the conjunction (an object, a measured quantity, a setting, or an instrument)\", \"query_run\": \"the search you actually ran for it\", \"established\": true|false, \"evidence\": [\"paper titles or literature_graph edge ids that establish it, or [] when it is not established\"], \"count\": 0}], \"combined_question_found\": true|false, \"closest_prior_art\": {\"title\": \"nearest work that DOES address the conjunction, or null\", \"why_not_the_same\": \"what it does differently\", \"edge_id\": \"...\"}, \"verdict\": \"components_established_conjunction_absent|conjunction_already_addressed|corpus_too_thin_to_say\", \"corpus_scope\": \"how many papers you searched and from which sources, so the verdict can be read as retrieval-relative\"},\n  \"claim_deltas\": [\n    {\"claim_id\": \"...\", \"previous\": \"...\", \"current\": \"...\", \"reason\": \"...\"}\n  ],\n  \"open_questions\": [\"...\"],\n  \"recommended_actions\": [\n    {\"type\": \"...\", \"priority\": \"high|medium|low\", \"description\": \"...\"}\n  ],\n  \"hypothesis_candidates\": [\"...\"],\n  \"strategy_advice\": {\"mode\": \"refine|pivot|close\", \"reason\": \"...\"}\n}\nDo not dump raw files, FILE: markers, transcripts, or copied artifacts. If LabDirector asked a targeted question, answer that question first with source paths and decision implication; otherwise summarize only the decision-relevant deltas for this pass. WHEN LabDirector ASKS WHETHER A COMBINED QUESTION IS UNPOSED - component-wise absence, \\\"are the components individually established while the conjunction is absent\\\" - you MUST fill component_absence_matrix, one row per component, each with the query you ran and what it returned. Answering that request in prose is what stalls the cycle: LabDirector cannot fill research_problem.evidence_of_absence from a paragraph, so it defers for more evidence and asks again. cycle-g-v84 spent 99 minutes and 22 lanes at zero gate rounds in exactly that loop, with the director holding a well-formed unposed question and 4 absence entries it could not complete. An HONEST negative is what is wanted: if the corpus cannot settle it, set verdict=corpus_too_thin_to_say and say what is missing - never pad the matrix with components you did not search."
    } else if contract.role == "author" {
        AUTHOR_OUTPUT_CONTRACT
    } else if contract.role == "illustrator" {
        ILLUSTRATOR_OUTPUT_CONTRACT
    } else if contract.role == "engineer" {
        ENGINEER_OUTPUT_CONTRACT
    } else if contract.role == "analyst"
        && action_type == "runner_result_interpretation_followup"
    {
        "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"lab_director_validation_report\": {\n    \"runner_lane_id\": \"the LabRunner lane in role_plan.source_brief_id\",\n    \"gate_ready\": true,\n    \"hypothesis_decision\": \"supported|falsified|weakened|inconclusive|invalid\",\n    \"effect_direction\": \"the measured direction, or none\",\n    \"effect_strength\": \"the measured magnitude and uncertainty, or why unavailable\",\n    \"controls\": [\"controls actually executed and what they showed\"],\n    \"negative_controls\": [\"negative controls actually executed and what they showed\"],\n    \"confounder_assessment\": \"what the completed run resolves and leaves open\",\n    \"falsification_assessment\": \"which registered falsifiers fired or survived\",\n    \"protocol_deviations\": [\"deviations from the sealed handoff\"],\n    \"failure_modes\": [\"remaining scientific or execution failure modes\"],\n    \"artifacts\": [\"exact result, table, and figure paths read\"],\n    \"summary\": \"concise interpretation for LabDirector and Gatekeeper\",\n    \"revised_handoff_required\": false,\n    \"revision_reason\": null\n  }\n}\nThis is POST-RUN interpretation. Read role_plan.planner_metadata.validation_results and the named LabRunner artifacts. Do not design or emit another validation blueprint. Set gate_ready=true only when the executed evidence is scientifically interpretable; otherwise set gate_ready=false, revised_handoff_required=true, and state the concrete revision reason. A supported, falsified, weakened, or inconclusive scientific result may be gate-ready when execution and controls are valid; gate_ready is not a claim-strength override."
    } else if contract.role == "analyst" {
        "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON.\n{\n  \"summary\": \"one-paragraph analyst brief\",\n  \"primary_hypothesis_id\": \"stable hypothesis identifier\",\n  \"candidate_primary_families\": [\n    {\"family\": \"...\", \"why_competitive\": \"...\", \"priority\": \"high|medium|low\"}\n  ],\n  \"candidate_estimands\": [\"...\"],\n  \"dataset_profile\": {\n    \"tables\": [{\"table_id\": \"...\", \"columns\": [{\"name\": \"...\", \"roles\": [\"entity_key|time_key|batch_or_source|exposure_candidate|outcome_candidate|numeric|descriptive\"]}]}],\n    \"entity_keys\": [\"schema-backed sample/entity keys\"],\n    \"batch_or_source_fields\": [\"schema-backed batch/source/caller/platform fields\"],\n    \"modality_hints\": [\"data-derived modality hints only\"]\n  },\n  \"validation_design_candidates\": [\n    {\"design_id\": \"paired_concordance|source_batch_confounding_audit|adjusted_association_sensitivity|within_unit_or_event_study|graph_edge_permutation|schema_identity_audit\", \"feasible\": true, \"feasibility_score\": 0-100, \"rationale\": \"why the observed schema supports or blocks this design\", \"required_inputs\": [\"...\"]}\n  ],\n  \"validation_targets\": [\n    {\"target_hypothesis_id\": \"...\", \"claim_text\": \"...\", \"selected_design_id\": \"...\", \"candidate_exposure_variables\": [\"schema-backed columns or derived indicators\"], \"candidate_outcome_variables\": [\"schema-backed columns or derived indicators\"], \"required_pairing_or_join_keys\": [\"...\"], \"confounder_or_batch_fields\": [\"...\"], \"negative_or_permutation_controls\": [\"...\"], \"design_blocked\": false, \"missing_requirements\": [\"...\"]}\n  ],\n  \"analysis_design_memo\": {\n    \"artifact_type\": \"analysis-design-memo\",\n    \"phase\": \"exploratory_scientific_design_before_runner_handoff\",\n    \"dataset_exploration\": {\"tables\": [], \"metadata_fields\": [], \"same_dataset_baseline_context\": [], \"open_questions\": []},\n    \"design_candidates\": [{\"design_id\": \"...\", \"scientific_question\": \"...\", \"schema_backing\": {\"exposures\": [], \"outcomes\": [], \"confounders\": []}, \"feasible\": true, \"runner_handoff_ready\": false, \"blocking_reason\": null}],\n    \"final_handoff_readiness\": {\"ready_for_runner\": false, \"blocking_reason\": \"...\", \"fallback_topic_or_path_token_checks_allowed\": false}\n  },\n  \"open_source_agent_discovery\": {\n    \"query_log\": [\"where you searched and why\"],\n    \"candidates\": [{\"name\": \"...\", \"url\": \"...\", \"license\": \"...\", \"domain\": \"...\", \"fit_score\": 0-100, \"reuse_decision\": \"reuse|adapt|reject\", \"evidence\": \"why it fits or fails\"}],\n    \"selected_agent\": {\"name\": \"...\", \"url\": \"...\", \"reuse_decision\": \"reuse|adapt|reject\", \"reason\": \"...\"},\n    \"rejection_summary\": \"why no tool was reused, if selected_agent is null\"\n  },\n  \"selected_open_source_analysis_agent\": {\"name\": \"...\", \"url\": \"...\", \"reuse_decision\": \"reuse|adapt|reject\", \"reason\": \"...\"},\n  \"rival_dags\": [\"...\"],\n  \"confounders\": [\"...\"],\n  \"falsification_ideas\": [\"...\"],\n  \"evidence_gaps\": [\"...\"],\n  \"analysis_lane_proposals\": [\n    {\"description\": \"...\", \"target_family\": \"...\", \"decision_value\": \"...\"}\n  ],\n  \"analyst_quality_standard\": {\n    \"minimum_blueprints_passed\": 1,\n    \"require_no_blueprint_failures\": true,\n    \"require_all_handoff_checks_pass\": false,\n    \"require_all_handoff_checks_resolved\": true,\n    \"required_validation_checks\": [\"technical/repository runner checks that must strictly pass\"],\n    \"minimum_method_appropriateness_score\": 80,\n    \"minimum_analysis_accuracy_score\": 80,\n    \"allow_inconclusive_for_gate_review\": false,\n    \"rationale\": \"why this standard is sufficient before asking LabDirector/Gatekeeper to review\"\n  },\n  \"derived_indicators\": [\n    {\"name\": \"snake_case column name to synthesize\", \"formula_description\": \"concise formula or pseudocode\", \"source_columns\": [\"existing column A\", \"existing column B\"], \"rationale\": \"why this indicator sharpens identification of the hypothesis\", \"unit\": \"ratio|percentage_points|z_score|delta_per_year|unitless|...\", \"direction\": \"positive|negative|mixed|n/a\", \"blueprint_id_reference\": \"blueprint that computes it\"}\n  ],\n  \"handoff_checks\": [\n    {\n      \"check_id\": \"stable validation identifier\",\n      \"goal\": \"what lab-runner must estimate or falsify\",\n      \"dataset\": \"ABSOLUTE path of the dataset file this check reads (a panel name only when the check reads no file)\",\n      \"column_mapping\": {\"<semantic_key>\": \"<actual dataset column name or literal value>\"},\n      \"outcome\": \"primary outcome column\",\n      \"exposures\": [\"primary exposure columns\"],\n      \"adjustment_set\": [\"confounders to adjust for\"],\n      \"fixed_effects\": [\"fixed effects to include\"],\n      \"sample_filters\": [\"sample restrictions\"],\n      \"model_family\": \"ols|logit|poisson|panel-ols|other concise label\",\n      \"success_criteria\": {\n        \"expected_sign\": \"negative|positive|mixed|n/a\",\n        \"p_value_max\": 0.05,\n        \"minimum_effect_description\": \"brief threshold description\"\n      },\n      \"failure_criteria\": [\"conditions that would falsify or weaken the hypothesis\"],\n      \"reproducibility_design\": {\"seeds\": [\"THREE OR MORE pinned seed values this check runs at, e.g. [0,1,2,3,4]\"], \"comparator\": \"the named rival arm this is measured AGAINST - the current practice, the obvious cheaper alternative, or the ablation that removes the mechanism. A number with nothing beside it is not evidence.\", \"dispersion_statistic\": \"the across-seed statistic the blueprint MUST emit alongside the point estimate: std, IQR, or min/max\", \"matched_budget\": \"what is held equal between the arms - equal sample count, equal wall time, or equal computational work - so the comparison is fair\", \"why_this_is_affordable\": \"cite the measured cost from role_plan.planner_metadata.instrument_inventory.experiment_cost_anchor. Use only measurements for the selected instrument and configuration in this cycle; estimate the complete condition x repetition x arm cost, including reference runs, and justify any budget or replication limits. Do not reuse cost or reproducibility assumptions from another domain or cycle.\"}\n    }\n  ],\n  \"validation_code_blueprints\": [\n    {\n      \"blueprint_id\": \"stable blueprint id\",\n      \"emits_per_seed_rows\": \"true when the code writes one result row PER SEED, each carrying the seed value, so the across-seed spread can be recomputed from the output rather than taken on trust. The driver reads what was EMITTED, not what was declared: a design that names five seeds and prints one number has one seed. Measured on cycle-g-v84 - of 17 hypothesis-bound runner lanes, 17 emitted no seed field at all, 16 named no comparator, 15 reported no dispersion, and the gate scored technical_quality 35 and reproducibility 76 on that evidence, which was an honest reading of it.\",\n      \"check_id\": \"handoff check this code implements\",\n      \"language\": \"python|r|sql|other concise label\",\n      \"entrypoint\": \"function or script entrypoint\",\n      \"code\": \"<complete Python script — see blueprint contract below>\",\n      \"code_file\": \"null, or the absolute path of an existing script file to dispatch byte-for-byte (see blueprint contract below)\",\n      \"dependencies\": [\"libraries or tools the runner needs\"],\n      \"execution_notes\": [\"how to run or adapt this blueprint\"],\n      \"review_focus\": [\"what the self-review concentrated on\"],\n      \"review_status\": \"ready_for_runner|needs_revision|needs_runner_execution\"\n    }\n  ],\n  \"self_review\": {\n    \"review_status\": \"approved_for_handoff|needs_revision\",\n    \"summary\": \"short critical review of the proposed code\",\n    \"assumption_checks\": [\"data or specification assumptions\"],\n    \"failure_modes\": [\"ways the code could mislead or fail\"],\n    \"requested_revisions\": [\"changes needed before execution, if any\"]\n  }\n}\n\nBlueprint code contract (MANDATORY for `validation_code_blueprints[*].code`):\n- Must be a complete, self-contained Python script that can be run directly with `python3 <script>`.\n- The script must be PLAIN SOURCE. Do NOT emit it as an encoded or compressed payload that decodes itself at runtime (base64 + gzip/zlib/bz2/lzma into `exec`/`eval`). Such a blueprint cannot be reviewed or diffed, and you cannot reproduce it: cycle-g-v86 lost four lanes to one, where the base64 and the gzip header were both valid and the compressed stream yielded ZERO bytes before erroring, the identical unusable blob being dispatched three times. If the script is too long, split the check across blueprints.\n- To dispatch a script that already exists as a file (one you wrote in your lane directory, or a reviewed source another lane stored), set `code_file` to its absolute path. The harness copies the file's exact bytes into `code` when it records your handoff, so `code` may then hold a one-line description. Do not retype an existing file into `code`: on cycle-g-v91 two analysts retyped a reviewed 27,379-byte source and dispatched 24,409 and 20,877 bytes, and both runs measured nothing. The file must lie under this cycle's lane or artifact directories; a path that cannot be copied is recorded in `code_file_error` and the blueprint does not run. Otherwise set `code_file` to null.\n- At runtime the script receives two environment variables set by the lab-runner driver: `RESEARCHLAB_CSV_ROOT` (directory containing the analysis-ready CSV files declared by `handoff_checks[*].dataset`) and `RESEARCHLAB_OUTPUT_DIR` (directory where every artifact must be written). It also receives `--csv-root` and `--output-dir` as argv fallbacks; use whichever is easier.\n- `RESEARCHLAB_PRIOR_ARTIFACTS_ROOT` is also set: the cycle-wide directory holding the tables and figures EARLIER lanes of this cycle already wrote. If your check re-analyses a previous run instead of rerunning the experiment (a reuse-only or leave-one-condition-out check), search THERE for the upstream table - `RESEARCHLAB_CSV_ROOT` is the dataset root and does NOT contain another lane output. Measured on cycle-g-v85: three lanes died with \"required pre-existing no-rerender table missing: benchmark_results.csv\" while three copies of that exact file sat under sibling lanes. Never hardcode a sibling lane id; glob for the filename under this root, and if it is absent fail with the root path in the message.\n- HARD WALL-CLOCK BUDGET: your blueprint is killed at the per-blueprint timeout (about 1500s when the handoff carries one blueprint, proportionally less when it carries several). Size the sweep to fit it using the measured costs in `role_plan.planner_metadata.instrument_inventory`, and state your expected runtime in `execution_notes`. An overrun is recorded as `design_overrun` and MUST be shrunk, never resubmitted unchanged. Measured on cycle-g-v85: BP-RESERVOIR-CROSSOVER-01 was submitted three times and killed at the identical 1494s cap all three times.\n- Must set the matplotlib backend to \"Agg\" before importing pyplot so figures render headless.\n- Must produce AT LEAST ONE rendered figure with `plt.savefig(<output_dir>/<name>.png, dpi>=100)` and AT LEAST ONE tabular artifact with `DataFrame.to_csv(<output_dir>/<name>.csv, index=False)`. Figures that answer the hypothesis visually (comparisons, distributions, region/group panels, regression diagnostic plots, coefficient plots) are preferred over generic scatterplots.\n- Must print exactly one JSON object on the final line of stdout summarising the result, with at least these keys: `{\"check_id\": \"...\", \"pass_fail\": \"pass|fail|inconclusive\", \"correlations\": {\"<exposure>_vs_<outcome>\": <float>, ...} (optional), \"evidence_grade\": {\"<outcome>_link\": \"robust|exploratory|weak\", ...} (optional), \"notes\": \"...\"}`. The driver parses this JSON to populate chronicle and live-view.\n- When `pass_fail` is \"fail\" because the HYPOTHESIS was falsified - the run executed correctly, the tables were written, the effect simply was not there - you MUST also emit `\"resolution_status\": \"valid_falsification\"` (or `\"valid_falsification_result\": true`) on that same final line. Reserve a bare `pass_fail: \"fail\"` with no resolution field for output you cannot stand behind. This is the difference between \"we tested it and it is false\" and \"the run broke\", and the whole downstream chain reads it: a falsification you fail to label is counted as a broken blueprint, your own `analyst_quality_standard` then reports unsatisfied, the lane is stamped failed, and the Gatekeeper scores that label instead of your evidence. Measured on cycle-g-v85: three lanes exited 0 after 855s of real rendering, emitted six CSVs and a figure, correctly falsified their own joint-signal hypothesis at Wilcoxon p=8.7e-17 against the uniform baseline - and were all stamped \"failed\" because this one field was missing.\n- Do NOT hardcode dataset or column names not declared in `handoff_checks` — read them from the handoff via the `RESEARCHLAB_CHECK_SPEC` env var (a path to the handoff-check JSON). If the blueprint reads or validates `column_mapping` from that check spec, the SAME `handoff_checks` item in THIS handoff JSON MUST carry the complete non-empty `column_mapping` (semantic key -> actual dataset column); a separate check-spec file saved to state/ is NOT delivered to the blueprint, so leaving `handoff_checks[*].column_mapping` empty guarantees the blueprint fails at startup.\n- If `handoff_checks[*].dataset_root` uses a `procedural://` scheme, or the declared dataset CSV does not already exist under `RESEARCHLAB_CSV_ROOT`, the blueprint MUST materialize the dataset itself IN-CODE as its first stage: construct the required experimental inputs and run the verified instrument or data-generation method appropriate to the objective for every sweep cell, and write the comparator table to `RESEARCHLAB_OUTPUT_DIR` with exactly the columns declared in `column_mapping`; then run the analysis on that just-materialized table within the same execution. NEVER fail merely because the procedural dataset CSV does not pre-exist — materializing it is part of the blueprint job, and a `dataset CSV not found` error on a procedural dataset means the blueprint was authored wrong.\n- Your handoff is SEALED when this lane finishes: every `handoff_checks[*].dataset` that names a file is resolved to exactly one file under this cycle's datasets, hashed, and its bundle copied to a read-only snapshot; `dataset` and `dataset_root` are rewritten to the snapshot, so the runner reads exactly the data you designed against even if the source is regenerated later. A name that matches several files (a bare `episodes.csv`) with no SHA-256 to pick one, or a SHA-256 you pinned that the file no longer has, is REFUSED and returned to you unexecuted. Name each file by absolute path and pin its current SHA-256. Read the dataset path from the check spec (`RESEARCHLAB_CHECK_SPEC`) or `RESEARCHLAB_CSV_ROOT`, never from a path typed into the code: code that opens the source bundle directly reads the live files, not the snapshot. Measured on cycle-a-20260919: runners read the retired lead's `episodes.csv` for a relative name, and a bundle pinned at 06:05 was regenerated in place at 06:56 before its runners started.
- The blueprint should degrade gracefully: if a referenced column is absent, raise a clear `ValueError` naming the missing column rather than crashing mid-analysis.\n\nOpen-source analysis agent discovery (MANDATORY before dataset_profile, validation design, and code):\n- Read `role_plan.planner_metadata.open_source_analysis_agent_mandate` and perform the requested search before proposing handoff_checks.\n- Start from same-dataset GitHub/supplementary resources, then search maintained open-source analysis agents, pipelines, or package workflows that match the selected modality, scale, and identification strategy.\n- For high-dimensional or large-scale datasets, compare specialized workflows for preprocessing, normalization, batch correction, differential analysis, enrichment, dimensionality reduction, annotation, and validation before writing ad hoc pandas/statistics code.\n- If a compatible tool is selected, reflect it in `selected_open_source_analysis_agent`, `validation_code_blueprints[*].dependencies`, and `execution_notes`; if none is safe to reuse, keep `selected_open_source_analysis_agent` null and give scientific rejection reasons in `open_source_agent_discovery.rejection_summary`.\n\nDataset-structured design selection (MANDATORY before declaring handoff_checks):\n- First build `dataset_profile` and `analysis_design_memo` from `role_plan.dataset_bundle.files[*].column_profiles`, `planner_metadata.selected_dataset_bundle`, `planner_metadata.candidate_datasets`, same-dataset paper/baseline context, and any data/knowledge graph schema nodes. Do not infer scientific variables from filesystem paths, usernames, lane ids, JSON filenames, or frequent runtime tokens.\n- Use `analysis_design_memo` for free scientific exploration: inspect schema and metadata, compare multiple validation candidates, reject infeasible designs explicitly, and decide what evidence would actually test the biology before writing runner handoff checks.\n- Generate `validation_design_candidates` from the observed schema, not from the disease/domain label: paired tables require entity/join keys; source/batch/caller audits require source-like fields; adjusted associations require mapped exposure/outcome or numeric features; within-unit/event designs require entity + time keys; graph-edge permutation requires an edge-like claim and sample-level data.\n- Emit `validation_targets` before `handoff_checks`. Each target must map requested exposure/outcome variables to schema-backed columns or explicit derived indicators. If mapping or feasibility is missing, set `design_blocked=true` and request schema/Analyst repair instead of inventing variables.\n- Only set `analysis_design_memo.final_handoff_readiness.ready_for_runner=true` and emit executable `handoff_checks` when the design directly tests biological variables/outcomes/proxies from the materialized dataset. Topic-token, path-token, or runtime-token dominance checks are exploratory notes only and must not be promoted as final handoff checks.\n- `handoff_checks[*].dataset`, `outcome`, `exposures`, `adjustment_set`, `fixed_effects`, and every blueprint column reference must come from the chosen `validation_targets`, `analysis_design_memo`, and `dataset_profile`.\n\nDerived-indicator synthesis (MANDATORY before declaring handoff_checks):\n- Start by reading `role_plan.dataset_bundle.files[*].column_profiles` and any supplied `role_plan.knowledge_graph` / `planner_metadata.reasoning_graph` / `planner_metadata.data_graph`. Enumerate the numeric columns, their ranges and means, and every relationship the knowledge graph already asserts (exposure → outcome edges, confounder candidates, mechanism nodes).\n- If the hypothesis calls for ratios, deltas, z-scores, interactions, residuals, subgroup gaps, cumulative totals, rolling means, lag features, composite indices, or any other transformation that is NOT already a column, propose it in `derived_indicators`. Prefer indicators that (a) sharpen identification of the primary hypothesis, (b) close an `evidence_gap` the knowledge graph exposes, or (c) let the analysis contrast rival family predictions directly.\n- Do NOT propose a derived indicator that merely rescales a column without changing information (e.g., pure unit conversions) unless that rescaling is required by the estimand.\n- Every derived indicator MUST appear in exactly one `validation_code_blueprints[*]` via `blueprint_id_reference` and be computed inside the blueprint's `code` field using the `source_columns`. Downstream `handoff_checks[*].exposures` and `adjustment_set` may reference the derived column by its `name`.\n- If the dataset truly cannot support any useful derived indicator beyond the raw columns, emit an empty `derived_indicators: []` list and state why in `evidence_gaps`.\n\nAnalyst-controlled LabRunner loop (MANDATORY):\n- Declare `analyst_quality_standard` before handoff. It is your own scientific acceptance threshold for this handoff, not a Gatekeeper shortcut.\n- The standard must be dataset/design-specific enough to prevent weak/inconclusive runner output from being promoted: include required checks, artifact/blueprint expectations, and minimum method/accuracy scores when applicable. Prefer `require_all_handoff_checks_resolved=true` over requiring every scientific check to pass; non-pass outcomes are acceptable only when they are valid falsification/negative results or explicitly irrecoverable data/schema impossibilities with `resolution_status` evidence, not ambiguous inconclusive output.\n- When this lane is repairing a failed/degraded runner, read `role_plan.planner_metadata.validation_results`, `failed_runner_context`, and `analysis_request.failed_runner_context`; explicitly fix each failed check in the new handoff. Do not merely rerun the same blueprint.\n- LabRunner will evaluate your declared standard. If it is not satisfied, LabDirector should route back to Analyst for revision instead of entering final gate review.\n\nGenerate at least one concrete validation-code blueprint that satisfies the contract above and review it yourself before handoff. The blueprint must implement one named `handoff_checks` item and compute every derived indicator it is responsible for. The self-review must explicitly discuss data assumptions, specification risks, open-source agent/tool selection, derived-indicator robustness, your analyst_quality_standard, and whether the lab-runner should execute the blueprint as-is or revise it. Finish once you can return one useful analyst brief with at least one executable `handoff_checks` item, one `validation_code_blueprints` item, one `analyst_quality_standard`, and one `self_review` item for the current cycle pass. Do not keep exploring indefinitely."
    } else {
        ""
    };
    // The owner steers this programme through recorded directives rather than
    // through whatever I happened to paste into one role plan.
    let owner_clause = owner_directive_clause(&contract.cwd, &contract.cycle_id, &contract.role);
    let simulation_orders_clause = lab_director_simulation_orders_clause(contract, role_plan);
    let analyst_docs_clause = if contract.role == "analyst"
        && action_type != "runner_result_interpretation_followup"
    {
        "\nWhen method selection depends on a specific library's behaviour, or on an open-source agent or pipeline, consult primary documentation or repository READMEs before proposing code-heavy methods. Prefer official docs for pandas, NumPy, SciPy, statsmodels, scikit-learn, matplotlib, seaborn, and domain-specific packages selected through open_source_agent_discovery.\nOpen-source agent handoff requirements: `open_source_agent_discovery.candidates[*]` must include download_command, local_path, setup_commands, smoke_test_command, application_command, expected_outputs, debug_attempts, and evidence. `selected_open_source_analysis_agent` must repeat local_path, smoke_test_command, and application_command for the selected tool. For high-fit repository candidates, download or clone into a cycle scratch/tool cache, inspect README/LICENSE/examples/entrypoints/dependencies, generate or adapt any required config from selected dataset paths, and run a lightweight help/import/config-parse/smoke test when dependencies permit. For high-dimensional or large-scale analysis, a local generic single-library adapter is never enough to satisfy the selected-agent requirement: it may be recorded only as a rejected or auxiliary fallback unless a real external repository/workflow/domain package was downloaded or installed, inspected, smoke-tested, debugged as needed, and applied to the selected dataset through a repository-native workflow, skill, CLI, or domain-package function. Repository inventory, import checks, or CSV profiling alone do not count as application; the run must produce hypothesis-relevant outputs such as result.json, figures, tables, or a workflow report. Do not hardcode AutoBA or any specific repository; derive search queries from the active dataset modality, platform, identifier, hypothesis, and identification strategy. Record every failed or blocked command with stderr_excerpt and fix_or_blocker; do not claim successful execution until the command actually runs. Lab-runner executes selected smoke/application commands before validation blueprints and records `external_agent_runs`. If lab-runner failed, read `role_plan.planner_metadata.failed_runner_context` and repair path/config/dependency/flag/column-mapping issues before issuing the revised handoff."
    } else {
        ""
    };
    let engineer_install_clause = if contract.role == "engineer" {
        ENGINEER_INSTALL_CLAUSE
    } else {
        ""
    };

    let scout_review_protocol = format!(
        "{}{}{}",
        native_scout_abstract_review_protocol(contract, role_plan),
        field_landscape_scout_clause(contract, role_plan),
        crate::labdirector::expert_selection_prompt_clause(contract, role_plan)
    );
    let python_clause = runtime_environment_clause();
    // A decision the director owes is not context to be reached eventually. This
    // renders it in the header, ahead of the role plan, because role plan keys are
    // serialised ALPHABETICALLY -- serde_json is built without preserve_order -- so
    // no amount of reordering the object moves it earlier.
    let experiment_decision_clause = {
        let pending = role_plan
            .and_then(|plan| plan.get("pending_experiment_requests"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if pending.is_empty() {
            String::new()
        } else {
            // A previous lane answered these -- "All three experiment requests
            // are declined" -- in `summary`, and the ledger did not see it,
            // because the ledger reads one field. Telling the role where the
            // answer has to go is the half that was missing; repeating the
            // demand at a role that already answered is not.
            let answered_in_prose = pending.iter().any(|request| {
                request
                    .get("answered_in_prose_by")
                    .and_then(Value::as_array)
                    .map(|lanes| !lanes.is_empty())
                    .unwrap_or(false)
            });
            let shape_note = if answered_in_prose {
                " A previous lane decided these in prose, in `summary` or `rationale`, and the decision was lost: nothing reads those fields for a decision. Say it again in `experiment_request_decisions` and it will be recorded."
            } else {
                ""
            };
            let mut lines = String::new();
            for (index, request) in pending.iter().enumerate() {
                let claim = request
                    .get("claim_it_would_support")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let experiment = request.get("experiment").and_then(Value::as_str).unwrap_or("");
                lines.push_str(&format!(
                    "\n  {}. claim_it_would_support: {}\n     experiment: {}",
                    index + 1,
                    claim,
                    experiment
                ));
            }
            format!(
                "\n\nDECIDE THESE BEFORE ANYTHING ELSE. The author has asked the programme to run {} experiment(s). You own that decision and nothing else in this cycle can settle it. Answer EVERY one in `experiment_request_decisions`, copying `claim_it_would_support` VERBATIM so the ledger can match it, with `adopt` or `decline` and a reason either way. Declining is a perfectly good answer and releases the hold immediately; silence is not, because it cannot be told apart from not having read this.{}{}",
                pending.len(),
                shape_note,
                lines
            )
        }
    };

    let render_prompt = |role_plan_text: &str, task_text: &str, truncation_note: &str| {
        format!(
            "You are a ResearchLab codex-agent lane.\nLane ID: {}\nRole: {}\nMode: {}\nOperate only within the allowed task scope.\nReturn concise structured output for Chronicle consumption.{}{}{}{}{}{}{}{}{}{}{} \n\nRole Plan:\n{}\n\nTask:\n{}",
            contract.lane_id,
            contract.role,
            contract.mode,
            python_clause,
            output_contract,
            experiment_decision_clause.as_str(),
            owner_clause.as_str(),
            gatekeeper_focus_clause,
            figure_verification_clause,
            format!("{analyst_docs_clause}{engineer_install_clause}{simulation_orders_clause}"),
            ABSTRACT_SCREENING_POLICY,
            RESEARCH_API_POLICY,
            scout_review_protocol,
            truncation_note,
            role_plan_text,
            task_text
        )
    };

    // Every context block that sits at the top level AND under planner_metadata
    // is rendered into the prompt twice and billed twice.
    //
    // MEASURED ON cycle-g-v79, over all 783 role plans in the cycle: 11.32 MB of
    // 87.07 MB — 13% of everything sent to the model — was byte-identical
    // duplication. gate_reviewer_context 3.26 MB, gate_restart_policy 2.47 MB,
    // previous_review_context 1.62 MB, chronicle_research_context 1.51 MB,
    // impact_first_hypothesis_mandate 1.09 MB, hypothesis_generation_policy
    // 0.92 MB. The gatekeeper is the worst hit: its top-level and metadata
    // copies of gate_reviewer_context, previous_review_context,
    // chronicle_research_context and reference_resources are all paired.
    //
    // Dropped at the PROMPT boundary only. The role plan on disk is untouched,
    // so every Rust and JS reader still sees both copies; only the model stops
    // reading the same block twice.
    //
    // The budget runs FIRST, and for every role. The nine-key cap table it
    // replaces sat behind `if role != "lab-director" { return }`, so on
    // cycle-g-v89 the gatekeeper broke its own caps on 373 of 374 plans. It also
    // ran on `planner_metadata` alone, while the largest blocks in the cycle sat
    // at the top level -- and trimming one placement and not the other makes the
    // two differ, which is exactly what stops the dedupe below from collapsing
    // them. See runtime/prompt_budget.rs.
    let role_plan_path = contract.task_file.parent().map(|dir| dir.join("role-plan.json"));
    let (budgeted_role_plan, budget_outcome) = apply_prompt_context_budget(
        compacted_role_plan.unwrap_or(Value::Null),
        role_plan_path.as_deref(),
    );
    let mut role_plan_value = attach_scout_search_journal(
        drop_gatekeeper_dataset_catalog(
            drop_duplicated_planner_metadata(budgeted_role_plan),
            &contract.role,
        ),
        contract,
    );
    let mut role_plan_text = serde_json::to_string_pretty(&role_plan_value)?;
    // The budget note is not a truncation note, and the fallbacks below must not
    // erase it: a role handed a shortened block needs to know where the rest is
    // whether or not the prompt then also overflowed.
    let budget_clause = budget_note(&budget_outcome);
    let mut truncation_note = budget_clause.clone();
    let mut prompt_text = render_prompt(&role_plan_text, &task_text, &truncation_note);

    if prompt_text.len() > max_prompt_bytes {
        if let Some(obj) = role_plan_value.as_object_mut() {
            obj.remove("validation_results");
            obj.remove("analysis_traces");
            obj.remove("queries");
            if let Some(metadata) = obj
                .get_mut("planner_metadata")
                .and_then(Value::as_object_mut)
            {
                metadata.remove("candidate_hypotheses");
                metadata.remove("open_validation_gaps");
                metadata.remove("challenge_questions");
                metadata.remove("recommended_actions");
            }
        }
        role_plan_text = serde_json::to_string_pretty(&role_plan_value)?;
        truncation_note = format!(
            "{budget_clause}\nPrompt note: oversized planning context was compacted aggressively before dispatch."
        );
        prompt_text = render_prompt(&role_plan_text, &task_text, &truncation_note);
    }

    if prompt_text.len() > max_prompt_bytes {
        task_text = truncate_chars(&task_text, 8_000);
        truncation_note = format!(
            "{budget_clause}\nPrompt note: oversized planning context and task text were compacted aggressively before dispatch. Focus on the highest-value deliverable only."
        );
        prompt_text = render_prompt(&role_plan_text, &task_text, &truncation_note);
    }

    if prompt_text.len() > max_prompt_bytes {
        // Deep fallback keeps only the minimum fields the lane needs. For the
        // analyst we preserve dataset_bundle + knowledge_graph because the
        // analyst cannot propose derived indicators without knowing what
        // columns exist and which relationships have already been charted.
        role_plan_text = match role_plan_value {
            Value::Object(ref obj) => {
                let mut digest = json!({
                    "lane_id": obj.get("lane_id").cloned().unwrap_or(Value::Null),
                    "role": obj.get("role").cloned().unwrap_or(Value::Null),
                    "action_type": obj.get("action_type").cloned().unwrap_or(Value::Null),
                    "objective": obj.get("objective").cloned().unwrap_or(Value::Null),
                    "followup_description": obj.get("followup_description").cloned().unwrap_or(Value::Null),
                    "assigned_hypotheses": obj.get("assigned_hypotheses").cloned().unwrap_or(json!([])),
                    "target_rubric": obj.get("target_rubric").cloned().unwrap_or(Value::Null),
                    "current_score": obj.get("current_score").cloned().unwrap_or(Value::Null),
                    "target_score": obj.get("target_score").cloned().unwrap_or(Value::Null),
                });
                for key in [
                    "search_agent_contract",
                    "screening_objective",
                    "source_lane_id",
                    "literature_review_source_dir",
                    "next_search_decisions",
                    "previous_review_context",
                    "chronicle_research_context",
                    "gate_reviewer_context",
                    "review_context_policy",
                    "open_source_analysis_agent_discovery",
                ] {
                    if let Some(value) = obj.get(key) {
                        digest[key] = value.clone();
                    }
                }
                if contract.role == "gatekeeper" {
                    if let Some(metadata) = obj.get("planner_metadata") {
                        let mut meta = json!({});
                        for key in [
                            "review_action",
                            "previous_review_context",
                            "chronicle_research_context",
                            "must_read_previous_review_comments",
                            "must_read_chronicle_research_context",
                        ] {
                            if let Some(value) = metadata.get(key) {
                                meta[key] = value.clone();
                            }
                        }
                        if meta.as_object().map_or(false, |m| !m.is_empty()) {
                            digest["planner_metadata"] = meta;
                        }
                    }
                }
                if matches!(contract.role.as_str(), "analyst" | "lab-director") {
                    if let Some(bundle) = obj.get("dataset_bundle") {
                        digest["dataset_bundle"] = bundle.clone();
                    }
                    if let Some(context) = obj.get("materialized_dataset_context") {
                        digest["materialized_dataset_context"] = context.clone();
                    }
                    if let Some(metadata) = obj.get("planner_metadata") {
                        let mut meta = json!({});
                        for key in [
                            "knowledge_graph",
                            "reasoning_graph",
                            "data_graph",
                            "dataset_root",
                            "dataset_mapping",
                            "selected_dataset_bundle",
                            "candidate_datasets",
                            "materialized_bundle_mandate",
                            "open_source_analysis_agent_mandate",
                            "require_open_source_analysis_agent_discovery",
                            "validation_results",
                            "failed_runner_context",
                            "analysis_request",
                            // The lead gate's inputs; without them no selection
                            // this lane makes can be applied.
                            "field_landscape",
                            "expert_selection",
                            "expert_selection_contract",
                        ] {
                            if let Some(value) = metadata.get(key) {
                                meta[key] = value.clone();
                            }
                        }
                        if meta.as_object().map_or(false, |m| !m.is_empty()) {
                            digest["planner_metadata"] = meta;
                        }
                    }
                    if contract.role == "analyst" {
                        if let Some(instructions) = obj.get("derived_indicator_instructions") {
                            digest["derived_indicator_instructions"] = instructions.clone();
                        }
                    } else if contract.role == "lab-director" {
                        for key in [
                            "cycle_memory_context",
                            "agent_mailbox_context",
                            "agent_communication_digest_context",
                            "research_notes_context",
                            "context_budget_policy",
                            "context_input_trace",
                            "research_notes_contract",
                        ] {
                            if let Some(value) = obj.get(key) {
                                digest[key] = value.clone();
                            }
                        }
                    }
                }
                serde_json::to_string_pretty(&digest)?
            }
            _ => "null".to_string(),
        };
        task_text = truncate_chars(&task_text, 4_000);
        truncation_note = format!(
            "{budget_clause}\nPrompt note: only a minimal role-plan digest is included because the full context exceeded the Codex input limit. Prioritize the explicit deliverable over exhaustive context coverage."
        );
    }

    // Harness-level delivery check: never send an agent to a key that is not there.
    {
        // role_plan_value, not the pre-dedupe copy: this is the plan the agent is
        // actually handed, so a key dropped upstream still counts as missing.
        let missing = unresolved_role_plan_references(&prompt_text, &role_plan_value);
        if !missing.is_empty() {
            truncation_note = format!(
                "{}
Prompt note: this prompt references role_plan fields that are NOT present in the role plan you were given — {}. Do not go looking for them; treat any instruction that depends on them as stated in full in this prompt or not stated at all. This is a harness delivery gap, not a hidden instruction.",
                truncation_note,
                missing.join(", ")
            );
        }
    }

    let (prompt_text, _, _, _) = fit_prompt_to_byte_limit(
        &render_prompt,
        &role_plan_text,
        &task_text,
        &truncation_note,
        max_prompt_bytes,
    );

    Ok(prompt_text)
}

pub(crate) fn build_codex_context_retry_prompt(
    contract: &LaneContract,
    role_plan: Option<&Value>,
    stdout: &str,
    stderr: &str,
    output_last_message: &str,
) -> Result<String> {
    let max_prompt_bytes = codex_max_prompt_bytes().min(260_000);
    let role_plan_value = attach_scout_search_journal(
        role_plan
            .map(compact_role_plan_for_prompt)
            .unwrap_or(Value::Null),
        contract,
    );
    let role_plan_text =
        truncate_utf8_bytes(&serde_json::to_string_pretty(&role_plan_value)?, 90_000);
    let task_text = truncate_utf8_bytes(
        &fs::read_to_string(&contract.task_file).unwrap_or_default(),
        3_000,
    );
    let failure_excerpt = truncate_utf8_bytes(
        &format!("stdout:\n{stdout}\n\nstderr:\n{stderr}\n\nlast_message:\n{output_last_message}"),
        6_000,
    );
    let scout_review_protocol = format!(
        "{}{}{}",
        native_scout_abstract_review_protocol(contract, role_plan),
        field_landscape_scout_clause(contract, role_plan),
        crate::labdirector::expert_selection_prompt_clause(contract, role_plan)
    );
    let prompt = format!(
        "You are a ResearchLab codex-agent lane retrying after the previous request exceeded Codex input limits.\nLane ID: {}\nRole: {}\nMode: {}\n\nRetry policy:\n- Do not ask for more context.\n- Use only this compact digest and the current-lane artifacts explicitly named by its execution protocol.\n- Return concise structured JSON or the smallest useful structured summary for downstream recovery.\n- Preserve the scientific/execution decision value; omit raw listings, transcripts, and large file previews.\n{}{}{}{}\nPrevious failure excerpt:\n{}\n\nCompact Role Plan Digest:\n{}\n\nTask Digest:\n{}",
        contract.lane_id, contract.role, contract.mode,
        runtime_environment_clause(), ABSTRACT_SCREENING_POLICY, RESEARCH_API_POLICY, scout_review_protocol,
        failure_excerpt, role_plan_text, task_text
    );
    Ok(truncate_utf8_bytes(&prompt, max_prompt_bytes))
}

/// Remove `planner_metadata.X` when it is byte-identical to top-level `X`.
///
/// Prompt-side only — see the call site for the cycle-g-v79 measurement. The
/// top-level copy is the one kept, because that is the name the reviewer and
/// director instructions refer to.
///
/// `research_notes_contract` is exempt: it is the one duplicated key this repo
/// actually reads back off `planner_metadata`, and at 0.22 MB it is not worth
/// the risk of proving otherwise.
/// The gatekeeper scores a finished result; it does not choose data.
///
/// MEASURED ON cycle-g-v79: `candidate_datasets` was 4.08 MB across the 270
/// gatekeeper role plans, 14% of everything that role read — the single largest
/// line in a reviewer's input. It exists so the ANALYST can match hypothesis
/// variables against `candidate_datasets[].csvs[].columns` and so the lab-runner
/// can trace its dataset_root; a rubric reviewer uses neither.
///
/// Dropped at the prompt boundary for gatekeepers only, and named in the plan.
/// The dataset actually used still reaches the reviewer through the validation
/// evidence and the lead's own `dataset_or_accession`, so a reproducibility
/// score can still be earned or refused on provenance.
fn drop_gatekeeper_dataset_catalog(mut role_plan: Value, role: &str) -> Value {
    if role != "gatekeeper" {
        return role_plan;
    }
    let Some(metadata) = role_plan
        .get_mut("planner_metadata")
        .and_then(Value::as_object_mut)
    else {
        return role_plan;
    };
    if metadata.remove("candidate_datasets").is_some() {
        metadata.insert(
            "candidate_datasets_omitted".to_string(),
            json!("dataset catalog is analyst/lab-runner context; score the evidence in validation_results"),
        );
    }
    role_plan
}

fn drop_duplicated_planner_metadata(mut role_plan: Value) -> Value {
    const KEEP: [&str; 1] = ["research_notes_contract"];
    let Some(object) = role_plan.as_object() else {
        return role_plan;
    };
    let Some(metadata) = object.get("planner_metadata").and_then(Value::as_object) else {
        return role_plan;
    };
    let duplicated: Vec<String> = metadata
        .iter()
        .filter(|(key, value)| {
            !KEEP.contains(&key.as_str()) && object.get(key.as_str()) == Some(*value)
        })
        .map(|(key, _)| key.clone())
        .collect();
    if duplicated.is_empty() {
        return role_plan;
    }
    if let Some(metadata) = role_plan
        .get_mut("planner_metadata")
        .and_then(Value::as_object_mut)
    {
        for key in &duplicated {
            metadata.remove(key);
        }
        // Say what was removed rather than letting a block vanish silently.
        metadata.insert(
            "deduplicated_against_role_plan_top_level".to_string(),
            json!(duplicated),
        );
    }
    role_plan
}

#[cfg(test)]
mod prompt_dedupe_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approved_research_lookups_keep_the_user_data_and_destination_scope() {
        assert_eq!(research_network_clause_for(None), "");
        let clause = research_network_clause_for(Some("approved-scholarly-metadata-v1"));
        assert!(clause.contains("public scholarly search terms and paper identifiers"));
        assert!(clause.contains("OpenAlex, Semantic Scholar, Crossref and arXiv only"));
        assert!(clause.contains("Do not send local source code"));
        assert!(clause.contains("GET-only"));
    }

    #[test]
    fn configured_python_is_rendered_as_a_quoted_shell_invocation() {
        let windows = python_runtime_clause_for(Some("C:/Research Tools/O'Brien/python.exe"), true);
        assert!(windows.contains("& 'C:/Research Tools/O''Brien/python.exe' <script.py>"));
        assert!(windows.contains("Substitute this invocation"));
        let unix = python_runtime_clause_for(Some("/opt/research env/O'Brien/python"), false);
        assert!(unix.contains("'/opt/research env/O'\"'\"'Brien/python' <script.py>"));
        assert!(python_runtime_clause_for(None, true).contains("& 'python' <script.py>"));
        assert!(python_runtime_clause_for(Some("  "), false).contains("'python3' <script.py>"));
    }

    #[test]
    fn native_literature_scout_gets_search_review_finalize_protocol() {
        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "review-cycle", "lane_id": "followup-scout-01", "role": "scout",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": "workspace", "task_file": "workspace/lane with spaces/task.md",
            "output_artifact": "workspace/lane with spaces/result.json", "fallback_strategy": null,
        }))
        .unwrap();
        let protocol = native_scout_abstract_review_protocol(
            &contract,
            Some(&json!({"action_type": "novelty_followup"})),
        );
        assert!(protocol.contains("ADAPTIVE SEARCH AGENT"));
        assert!(protocol.contains("--role-plan-file"));
        assert!(protocol.contains("lane with spaces"));
        assert!(protocol.contains("FULL abstract"));
        assert!(protocol.contains("backward-citation inquiry"));
        assert!(protocol.contains("forward-citation inquiry"));
        assert!(protocol.contains("adversarial inquiry"));
        assert!(protocol.contains("FINALIZATION ALONE DOES NOT MEAN SEARCH COMPLETE"));
        assert!(protocol.contains("Paper counts"));
        assert!(protocol.contains("--finalize-review-dir"));
        assert!(
            protocol.contains("without repeated retrieval")
                || protocol.contains("WITHOUT repeated retrieval")
        );
        assert!(protocol.contains("reviewed-literature-result.json"));
        assert!(native_scout_abstract_review_protocol(
            &contract,
            Some(&json!({"action_type": "data_acquisition_followup"}))
        )
        .is_empty());
        assert!(native_scout_abstract_review_protocol(
            &contract,
            Some(&json!({"action_type": "reasoning_data_scout"}))
        )
        .is_empty());
        let retry = build_codex_context_retry_prompt(
            &contract,
            Some(&json!({"action_type": "novelty_followup"})),
            "",
            "input limit",
            "",
        )
        .unwrap();
        assert!(retry.contains(ABSTRACT_SCREENING_POLICY));
        assert!(retry.contains(RESEARCH_API_POLICY));
        assert!(retry.contains("PYTHON RUNTIME:"));
        assert!(retry.contains("ADAPTIVE SEARCH AGENT"));
        let recovery = native_scout_abstract_review_protocol(
            &contract,
            Some(&json!({
                "action_type": "abstract_review_followup",
                "planner_metadata": {"review_action": {"literature_review_source_dir": "workspace/prior-literature"}},
            })),
        );
        assert!(recovery.contains("RECOVERY OVERRIDE"));
        assert!(recovery.contains("workspace/prior-literature"));
        assert!(recovery.contains("do not re-run retrieval"));
    }

    #[test]
    fn scout_resume_journal_is_loaded_into_the_prompt_payload() {
        let temp = tempfile::tempdir().unwrap();
        let lane = temp.path().join("scout-lane");
        fs::create_dir_all(&lane).unwrap();
        let task_file = lane.join("task.md");
        fs::write(&task_file, "search this objective").unwrap();
        fs::write(
            lane.join("search-agent-journal.json"),
            serde_json::to_vec(&json!({
                "research_problem": "Which mechanism remains unresolved?",
                "search_rounds": [{"round_id": "round-1", "query": "first query"}],
                "coverage": {"unanswered_questions": ["direct falsifier"]}
            }))
            .unwrap(),
        )
        .unwrap();
        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "review-cycle", "lane_id": "followup-scout-02", "role": "scout",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": temp.path(), "task_file": task_file,
            "output_artifact": lane.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap();
        let prompt = build_codex_prompt(
            &contract,
            Some(&json!({
                "action_type": "novelty_followup",
                "search_agent_contract": {"contract_version": "adaptive-search-agent-v1"}
            })),
        )
        .unwrap();
        assert!(prompt.contains("search_agent_journal_resume"));
        assert!(prompt.contains("Which mechanism remains unresolved?"));
        assert!(prompt.contains("first query"));
        assert!(prompt.contains("PYTHON RUNTIME:"));
    }

    #[test]
    fn a_lab_director_launched_with_a_verified_simulator_is_told_to_order_the_simulation() {
        let temp = tempfile::tempdir().unwrap();
        let lane = temp.path().join("followup-lab-director-09");
        fs::create_dir_all(&lane).unwrap();
        let task_file = lane.join("task.md");
        // A task written before the rule existed.
        fs::write(&task_file, "- kg_first_hypothesis_scope: decide from the digest").unwrap();
        let contract_for = |role: &str| -> LaneContract {
            serde_json::from_value(json!({
                "cycle_id": "cycle-sim", "lane_id": "followup-lab-director-09", "role": role,
                "runtime_class": "codex-agent", "mode": "read-write-scoped",
                "cwd": temp.path(), "task_file": task_file,
                "output_artifact": lane.join("result.json"), "fallback_strategy": null,
            }))
            .unwrap()
        };
        let with_simulator = json!({
            "action_type": "lab_director_requery_followup",
            "planner_metadata": {
                "materialized_bundle_mandate": {"procedural_data_generation_acceptable": true},
                "instrument_inventory": {"simulators": [{"backend": "mujoco", "interpreter_path": "python.exe"}]}
            }
        });
        let prompt = build_codex_prompt(&contract_for("lab-director"), Some(&with_simulator)).unwrap();
        assert!(prompt.contains("YOU ORDER THE SIMULATION"));
        assert!(prompt.contains("- simulation_orders:"));
        assert!(prompt.contains(".research-lab/datasets/cycle-sim/simulations/"));
        assert!(prompt.contains("hypothesis_link"));

        let without_simulator = json!({"action_type": "lab_director_requery_followup", "planner_metadata": {}});
        let prompt = build_codex_prompt(&contract_for("lab-director"), Some(&without_simulator)).unwrap();
        assert!(!prompt.contains("YOU ORDER THE SIMULATION"));

        // The analyst analyses; it is not told to order or design a simulation.
        let prompt = build_codex_prompt(&contract_for("analyst"), Some(&with_simulator)).unwrap();
        assert!(!prompt.contains("YOU ORDER THE SIMULATION"));
        assert!(!prompt.contains("simulation_request"));
    }

    #[test]
    fn only_an_engineer_is_told_how_to_install() {
        let temp = tempfile::tempdir().unwrap();
        let task_file = temp.path().join("task.md");
        fs::write(&task_file, "provision the tool").unwrap();
        let contract_for = |role: &str| -> LaneContract {
            serde_json::from_value(json!({
                "cycle_id": "cycle-sim", "lane_id": format!("followup-{role}-01"), "role": role,
                "runtime_class": "codex-agent", "mode": "read-write-scoped",
                "cwd": temp.path(), "task_file": task_file,
                "output_artifact": null, "fallback_strategy": null,
            }))
            .unwrap()
        };
        let plan = json!({"action_type": "capability_provisioning_followup"});
        let prompt = build_codex_prompt(&contract_for("engineer"), Some(&plan)).unwrap();
        assert!(prompt.contains(ENGINEER_INSTALL_CLAUSE));
        for rule in ["isolated per-cycle environment", "never modify the local reference repositories", "pip freeze", "Never pass, embed or request credentials", "http.sslBackend=openssl"] {
            assert!(prompt.contains(rule), "{rule}");
        }
        for role in ["analyst", "scout", "lab-runner"] {
            let prompt = build_codex_prompt(&contract_for(role), Some(&plan)).unwrap();
            assert!(!prompt.contains("INSTALLS (MANDATORY)"), "{role}");
        }
    }

    #[test]
    fn a_literature_scout_prompt_states_the_journal_rules_the_validator_enforces() {
        // cycle-b-20260917f: the first literature scouts restated the problem
        // and listed several indexes per round, and failed validation on that alone.
        let temp = tempfile::tempdir().unwrap();
        let lane = temp.path().join("scout-02");
        fs::create_dir_all(&lane).unwrap();
        let task_file = lane.join("task.md");
        fs::write(&task_file, "search this objective").unwrap();
        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "journal-rules", "lane_id": "scout-02", "role": "scout",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": temp.path(), "task_file": task_file,
            "output_artifact": lane.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap();
        let prompt = build_codex_prompt(
            &contract,
            Some(&json!({
                "action_type": "reasoning_literature_scout",
                "search_agent_contract": {"contract_version": "adaptive-search-agent-v1"}
            })),
        )
        .unwrap();
        assert!(prompt.contains("NATIVE LITERATURE SCOUT EXECUTION"));
        assert!(prompt.contains("search_agent_contract.research_problem copied verbatim"));
        assert!(prompt.contains("source is ONE string naming one source"));
    }

    #[test]
    fn an_identical_metadata_copy_is_dropped_and_named() {
        let out = drop_duplicated_planner_metadata(json!({
            "gate_reviewer_context": { "a": 1 },
            "planner_metadata": { "gate_reviewer_context": { "a": 1 }, "other": 2 },
        }));
        let metadata = out["planner_metadata"].as_object().unwrap();
        assert!(!metadata.contains_key("gate_reviewer_context"));
        assert_eq!(metadata["other"], json!(2));
        assert_eq!(
            metadata["deduplicated_against_role_plan_top_level"],
            json!(["gate_reviewer_context"])
        );
        assert_eq!(out["gate_reviewer_context"], json!({ "a": 1 }));
    }

    #[test]
    fn a_diverged_copy_is_kept() {
        let out = drop_duplicated_planner_metadata(json!({
            "previous_review_context": { "a": 1 },
            "planner_metadata": { "previous_review_context": { "a": 2 } },
        }));
        assert_eq!(
            out["planner_metadata"]["previous_review_context"],
            json!({ "a": 2 })
        );
        assert!(out["planner_metadata"]
            .get("deduplicated_against_role_plan_top_level")
            .is_none());
    }

    #[test]
    fn the_exempt_key_survives_even_when_identical() {
        let out = drop_duplicated_planner_metadata(json!({
            "research_notes_contract": { "a": 1 },
            "planner_metadata": { "research_notes_contract": { "a": 1 } },
        }));
        assert_eq!(
            out["planner_metadata"]["research_notes_contract"],
            json!({ "a": 1 })
        );
    }

    #[test]
    fn the_gatekeeper_dataset_catalog_is_dropped_and_named() {
        let plan = json!({
            "planner_metadata": { "candidate_datasets": [{ "csvs": [] }], "review_action": 1 }
        });
        let out = drop_gatekeeper_dataset_catalog(plan.clone(), "gatekeeper");
        let metadata = out["planner_metadata"].as_object().unwrap();
        assert!(!metadata.contains_key("candidate_datasets"));
        assert!(metadata.contains_key("candidate_datasets_omitted"));
        assert_eq!(metadata["review_action"], json!(1));

        // Every other role still gets it: the analyst matches hypothesis
        // variables against the catalog's columns.
        for role in ["analyst", "lab-runner", "lab-director"] {
            let kept = drop_gatekeeper_dataset_catalog(plan.clone(), role);
            assert!(
                kept["planner_metadata"].get("candidate_datasets").is_some(),
                "{role} must keep the dataset catalog"
            );
        }
    }

    #[test]
    fn a_plan_without_planner_metadata_is_returned_unchanged() {
        let plan = json!({ "role": "gatekeeper" });
        assert_eq!(drop_duplicated_planner_metadata(plan.clone()), plan);
        assert_eq!(drop_duplicated_planner_metadata(Value::Null), Value::Null);
    }
}
