use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

use super::codex_policy::{
    data_scout_should_fetch, role_plan_action_type, supervisor_constrained_data_scout_retry,
};
use super::process::write_process_metadata;
use super::research_api_policy::apply_research_driver_environment;
use super::role_plan::role_plan_dataset_override;
use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::{
    choose_dataset_bundle_path, dataset_bundle_paths_visible_to_cycle, dataset_bundle_summary,
    lane_process_path, lane_role_plan_path, lane_root, now_iso, read_json, write_json,
};

const APPROVED_SCHOLARLY_NETWORK_POLICY: &str = "approved-scholarly-metadata-v1";

fn approved_dataset_external_driver_forbidden(
    role: &str,
    action_type: &str,
    policy: Option<&str>,
) -> bool {
    role == "scout"
        && matches!(
            action_type,
            "data_acquisition_followup" | "reasoning_data_scout"
        )
        && policy == Some(APPROVED_SCHOLARLY_NETWORK_POLICY)
}

/// The lane's own declared budget, when the plan states one.
///
/// `src/execution/task_contract.js` writes `constraints.timeout_seconds` per
/// role (lab-runner: 1800). The harness used to ignore it entirely, so a plan
/// that asked for 1800s was executed with a 360s stopwatch.
fn declared_external_driver_timeout_seconds(role_plan: Option<&Value>) -> Option<u64> {
    let declared = role_plan?
        .get("constraints")?
        .get("timeout_seconds")?
        .as_u64()?;
    if declared == 0 {
        return None;
    }
    Some(declared.clamp(60, 3_600))
}

fn default_external_driver_timeout_seconds(
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> u64 {
    // The frontier harvest has its own budget: paced citation pages for every
    // anchor (labdirector::frontier_harvest).
    if contract.role == "scout"
        && role_plan_action_type(role_plan) == crate::labdirector::FRONTIER_HARVEST_ACTION
    {
        return crate::labdirector::frontier_harvest_timeout_seconds();
    }
    if let Some(declared) = declared_external_driver_timeout_seconds(role_plan) {
        return declared;
    }
    let action_type = role_plan_action_type(role_plan);
    if contract.role == "scout"
        && action_type == "data_acquisition_followup"
        && data_scout_should_fetch(role_plan)
    {
        1_800
    } else if contract.role == "lab-runner" {
        // Was 360, to keep repeated degraded executions returning to
        // Analyst/LabDirector repair instead of idling. That bound predates the
        // renders: it is now the SHORTEST timeout in the system, shorter than
        // the generic 600, and it censors real work.
        //
        // MEASURED. Lane durations end in a wall, not a tail — cycle-g-v78:
        // 154, 76, 197, 142, 14 and then 361, 363, 364 (3 of 8 launched runners
        // killed); cycle-g-v76: 357, 357, 357, 357 plus a cluster at 289-319.
        // Nothing survives past ~360s because nothing is allowed to. Meanwhile
        // 44c8e8e raised the per-blueprint compute budget 240s -> 1494s, a
        // budget this stopwatch made unreachable, and the analyst is told to
        // declare `timeout_seconds` for a scene x seed x method sweep.
        //
        // Reproducibility is the rubric only a completed run can raise, and it
        // is the one that never moves (cycle-g-v74, 86 gate rounds: novelty
        // reached 74, reproducibility never reached 30, median 8).
        //
        // 1800 matches what the lane contract already declares for this role.
        // The bound against a genuinely hung lane belongs to the supervisor's
        // stale/self-heal path, which owns it with far better evidence than a
        // stopwatch that cannot tell a hung render from a slow one.
        1_800
    } else {
        600
    }
}

fn compact_role_plan_for_lane_result(role_plan: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for key in [
        "role",
        "action_type",
        "target_rubric",
        "target_score",
        "current_score",
        "validation_coding_task",
        "instruction_handoff_sources",
        "analyst_handoff_path",
        "analysis_request",
        "failed_runner_context",
    ] {
        if let Some(value) = role_plan.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    if let Some(metadata) = role_plan.get("planner_metadata").and_then(Value::as_object) {
        let mut compact_metadata = serde_json::Map::new();
        for key in [
            "action_type",
            "analyst_handoff_path",
            "handoff_path",
            "failed_runner_context",
            "analysis_request",
            "repository_workflow_exhausted",
            "repository_workflow_repetition",
            "validation_results",
        ] {
            if let Some(value) = metadata.get(key) {
                compact_metadata.insert(key.to_string(), value.clone());
            }
        }
        if !compact_metadata.is_empty() {
            out.insert(
                "planner_metadata".to_string(),
                Value::Object(compact_metadata),
            );
        }
    }
    out.insert(
        "content_policy".to_string(),
        json!("compact lane-result projection; full role plan is available via role_plan_path"),
    );
    Value::Object(out)
}

pub(super) fn mark_pending_literature_recovery(
    payload: &mut Value,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    output_dir: &std::path::Path,
    role_plan_path: &std::path::Path,
) -> Option<&'static str> {
    if !matches!(contract.role.as_str(), "scout" | "analyst")
        || matches!(
            role_plan_action_type(role_plan),
            "data_acquisition_followup" | "reasoning_data_scout" | crate::labdirector::SOTA_DEEP_READ_ACTION
        )
    {
        return None;
    }
    let literature_status = payload
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if literature_status == "insufficient_corpus" {
        // Resume from this lane's latest merged journal/review state. The role
        // plan retains the original contract while the source lane and copied
        // artifact directory remain a consistent recovery checkpoint.
        let recovery_source_dir = output_dir.to_path_buf();
        let paper_count = payload
            .get("papers")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        let contract_value = role_plan
            .and_then(|plan| plan.get("search_agent_contract"))
            .cloned()
            .or_else(|| {
                role_plan
                    .and_then(|plan| plan.get("planner_metadata"))
                    .and_then(|metadata| metadata.get("search_agent_contract"))
                    .cloned()
            })
            .or_else(|| {
                role_plan
                    .and_then(|plan| plan.get("planner_metadata"))
                    .and_then(|metadata| metadata.get("review_action"))
                    .and_then(|action| action.get("search_agent_contract"))
                    .cloned()
            })
            .or_else(|| payload.get("search_agent_contract").cloned())
            .unwrap_or(Value::Null);
        let research_problem = contract_value
            .get("research_problem")
            .and_then(Value::as_str)
            .unwrap_or("the unchanged literature-search objective")
            .to_string();
        let gaps = payload
            .get("search_agent_assessment")
            .and_then(|assessment| assessment.get("gaps"))
            .cloned()
            .unwrap_or_else(|| json!(["adaptive_search_contract_incomplete"]));
        payload["degraded"] = json!(true);
        payload["evidence_ready"] = json!(paper_count > 0);
        payload["search_decision_ready"] = json!(false);
        payload["search_complete"] = json!(false);
        payload["paper_count"] = json!(paper_count);
        // A source the provider refused is not a field that holds nothing, and
        // until now both arrived as `adaptive_literature_search_incomplete`.
        //
        // MEASURED ON cycle-g-v91: OpenAlex 429'd and contributed 0 of 109
        // papers; arXiv supplied 92 with citation counts on 2 of them. OpenAlex
        // is the only source carrying the citation counts, percentiles and venue
        // metrics that the established-impact quality track needs, so with it
        // absent the ONLY admissible track was recency -- 107 of 109 papers
        // admitted on it, nothing older than 2021 admitted at all. The scout
        // then recorded, correctly, that "foundational native reuse literature
        // lacks accepted full-abstract evidence", declared its search
        // incomplete, and was marked failed. completed_scouts stayed 0 and
        // twelve downstream lanes waited on a number that could not change.
        //
        // The director saw "the literature search is incomplete" and could not
        // tell whether to retry or to conclude the field is thin. The provider
        // answered 200 in 1.4s when asked again by hand.
        // The lane's own retrieval receipts count too. An agent scout records
        // each refused request there, and the result it hands back does not
        // carry those receipts: on cycle-g-v91 followup-scout-99 logged
        // OpenAlex and arXiv 429s with `throttled: true` on every round and was
        // still labelled a search that merely had not finished.
        let mut throttled_sources = throttled_sources_in_result(&payload);
        for source in throttled_sources_in_retrieval_receipts(&recovery_source_dir) {
            if !throttled_sources.contains(&source) {
                throttled_sources.push(source);
            }
        }
        throttled_sources.sort();
        payload["failure_category"] = if throttled_sources.is_empty() {
            json!("adaptive_literature_search_incomplete")
        } else {
            payload["throttled_sources"] = json!(throttled_sources);
            json!("literature_retrieval_throttled")
        };
        payload["recovery_role"] = json!("scout");
        payload["recovery_runtime_class"] = json!("codex-agent");
        payload["recommended_actions"] = json!([{
            "type": "adaptive_search_followup",
            "preferred_role": "scout",
            "runtime_class": "codex-agent",
            "priority": "high",
            "source_lane_id": contract.lane_id,
            "literature_review_source_dir": recovery_source_dir,
            "literature_review_role_plan_path": role_plan_path,
            "search_agent_journal_path": recovery_source_dir.join("search-agent-journal.json"),
            "search_agent_synthesis_path": recovery_source_dir.join("search-agent-synthesis.json"),
            "search_agent_assessment_path": recovery_source_dir.join("search-agent-assessment.json"),
            "search_agent_contract": contract_value,
            "search_agent_gaps": gaps,
            "description": format!(
                "Resume the adaptive literature search in the original reviewed corpus at {} for the unchanged research problem: {}. Preserve accepted papers and completed abstract reviews. Read the saved journal and assessment, then run only gap-specific durable inquiries; do not re-review accepted abstracts or rerun the full query list.",
                recovery_source_dir.display(), research_problem
            ),
        }]);
        return Some("failed");
    }
    if !matches!(
        literature_status.as_str(),
        "pending_review" | "no_admitted_evidence"
    ) {
        return None;
    }
    let admitted_count = payload
        .get("papers")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    payload["degraded"] = json!(true);
    payload["evidence_ready"] = json!(admitted_count > 0);
    payload["paper_count"] = json!(admitted_count);
    payload["failure_category"] = json!("literature_abstract_review_required");
    payload["recovery_role"] = json!("scout");
    payload["recovery_runtime_class"] = json!("codex-agent");
    payload["recommended_actions"] = json!([{
        "type": "abstract_review_followup",
        "preferred_role": "scout",
        "runtime_class": "codex-agent",
        "priority": "high",
        "source_lane_id": contract.lane_id,
        "literature_review_source_dir": output_dir,
        "literature_review_role_plan_path": role_plan_path,
        "literature_review_queue_path": output_dir.join("abstract-review-queue.json"),
        "description": format!(
            "Resolve {literature_status} for literature lane {}. Reuse the saved candidates and abstract-review queue at {}; do not repeat retrieval merely because reviews are missing. Read full abstracts, provide objective-bound reviews, and finalize offline. If candidates are quarantined, repair the specifically recorded missing abstract/quality evidence or record exclusion; never pad the corpus. The recovery must use a reasoning Codex Scout.",
            contract.lane_id, output_dir.display()
        ),
    }]);
    // Preserve the literature-specific payload status while the execution lane
    // is failed/degraded, so schedulers cannot count it as usable completion.
    Some("failed")
}

/// Sources that refused this lane for RATE rather than for content.
///
/// `collect.py` classifies each source failure with `throttled: true` when the
/// provider answered 429 or 503 after the polite-fetch layer had spent its
/// retries. This reads that classification wherever the driver recorded it --
/// the payload carries `source_stats` differently depending on which collection
/// path ran, so the search is by key rather than by a fixed path.
fn throttled_sources_in_result(payload: &Value) -> Vec<String> {
    fn walk(value: &Value, depth: usize, found: &mut Vec<String>) {
        if depth > 5 {
            return;
        }
        match value {
            Value::Object(map) => {
                if let Some(Value::Array(failures)) = map.get("source_failures") {
                    for failure in failures {
                        if failure.get("throttled").and_then(Value::as_bool) != Some(true) {
                            continue;
                        }
                        if let Some(source) = failure.get("source").and_then(Value::as_str) {
                            if !found.iter().any(|item| item == source) {
                                found.push(source.to_string());
                            }
                        }
                    }
                }
                for nested in map.values() {
                    walk(nested, depth + 1, found);
                }
            }
            Value::Array(items) => {
                for item in items.iter().take(40) {
                    walk(item, depth + 1, found);
                }
            }
            _ => {}
        }
    }
    let mut found = Vec::new();
    walk(payload, 0, &mut found);
    found.sort();
    found
}

/// Throttled sources named in the lane's own retrieval receipts.
///
/// Each durable inquiry appends one receipt to `search-retrieval-events.jsonl`
/// with the source statistics the driver classified at the moment of the
/// request. A receipt that cannot be read is skipped, not guessed at.
fn throttled_sources_in_retrieval_receipts(output_dir: &std::path::Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(output_dir.join("search-retrieval-events.jsonl")) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(receipt) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        for source in throttled_sources_in_result(&receipt) {
            if !found.contains(&source) {
                found.push(source);
            }
        }
    }
    found.sort();
    found
}

pub(crate) fn run_external_driver(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<(String, Value, String, String, Vec<String>)> {
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| lane_dir.join("outputs"));
    fs::create_dir_all(&output_dir)?;

    let configured_python = env::var("RESEARCHLAB_PYTHON")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let venv_python = paths.project_root.join(".venv").join("bin").join("python3");
    let python_bin = configured_python.unwrap_or_else(|| {
        if venv_python.exists() {
            venv_python
        } else {
            PathBuf::from("python3")
        }
    });
    let mut command = Command::new(python_bin);
    let role_plan_path = lane_role_plan_path(paths, &contract.cycle_id, &contract.lane_id);
    let dataset_override = role_plan_dataset_override(role_plan);
    let (selected_dataset_root, dataset_bundle_source) = choose_dataset_bundle_path(
        paths,
        dataset_override.as_deref(),
        Some(contract.cycle_id.as_str()),
    )?;
    let action_type = role_plan_action_type(role_plan);
    // A lane contract can outlive the role-plan materializer that now upgrades
    // approved-scope data follow-ups to literature Scouts. Do not let an old
    // external-driver contract invoke data_scout_browser or a downloader after
    // the user limited network access to scholarly metadata.
    if approved_dataset_external_driver_forbidden(
        &contract.role,
        action_type,
        env::var("RESEARCHLAB_LITERATURE_NETWORK_POLICY")
            .ok()
            .as_deref(),
    ) {
        bail!(
            "approved scholarly metadata policy blocks external dataset Scout driver; rematerialize this Scout as reasoning_literature_scout"
        );
    }
    // Apply provider hygiene before adding lane-specific command overrides;
    // the policy reconstructs the inherited environment and must not erase
    // values intentionally set on this Command.
    apply_research_driver_environment(&mut command);
    let timeout_seconds = env::var("RESEARCHLAB_EXTERNAL_DRIVER_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_else(|| default_external_driver_timeout_seconds(contract, role_plan));
    command.env(
        "RESEARCHLAB_EXTERNAL_DRIVER_TIMEOUT_SECONDS",
        timeout_seconds.to_string(),
    );
    let driver_path = if contract.role == "scout" && action_type == "data_acquisition_followup" {
        // Domain-neutral open-dataset discovery + crawl. Replaces the
        // earlier open_data_bootstrap.py path. Reads
        // ``<state>/<cycle>-data-request.json`` if lab-director emitted one;
        // otherwise falls back to extracting hints from the role_plan's
        // ``followup_description`` + ``assigned_hypotheses``.
        let scout_script = paths
            .project_root
            .join("drivers")
            .join("data")
            .join("data_scout_browser.py");
        command
            .arg(&scout_script)
            .arg("--output-dir")
            .arg(&output_dir)
            .arg("--runtime-root")
            .arg(&paths.runtime_root)
            .arg("--cycle-id")
            .arg(&contract.cycle_id);
        let constrained_supervisor_retry = supervisor_constrained_data_scout_retry(role_plan);
        if constrained_supervisor_retry {
            command
                .arg("--max-queries")
                .arg("10")
                .arg("--max-candidates-per-query")
                .arg("6")
                .arg("--per-page-timeout")
                .arg("15");
        } else if timeout_seconds <= 120 {
            command
                .arg("--max-queries")
                .arg("2")
                .arg("--max-candidates-per-query")
                .arg("3")
                .arg("--per-page-timeout")
                .arg("8");
        }
        if !constrained_supervisor_retry && data_scout_should_fetch(role_plan) {
            command.arg("--fetch");
        } else {
            command.arg("--no-fetch");
        }
        if role_plan_path.exists() {
            command.arg("--role-plan-file").arg(&role_plan_path);
        }
        scout_script
    } else if contract.role == "scout" && action_type == crate::labdirector::FRONTIER_HARVEST_ACTION {
        // Deterministic: the anchors, horizon and revive roots come from the
        // role plan the harness wrote; no query is authored. Its top-K land in
        // this lane's review queue, and a `pending_review` result is sent to a
        // Codex abstract review by mark_pending_literature_recovery below.
        let harvest = role_plan
            .and_then(|plan| plan.pointer("/planner_metadata/frontier_harvest_contract"))
            .cloned()
            .unwrap_or(Value::Null);
        command
            .arg(&paths.literature_driver_script)
            .arg("--frontier-harvest")
            .arg("--output-dir")
            .arg(&output_dir);
        // Stop harvesting two minutes before the stopwatch, so the lane always
        // ranks, queues and writes what it has instead of being killed empty.
        command.env(
            "RESEARCHLAB_FRONTIER_DEADLINE_SECONDS",
            timeout_seconds.saturating_sub(120).max(60).to_string(),
        );
        if role_plan_path.exists() {
            command.arg("--role-plan-file").arg(&role_plan_path);
        }
        if let Some(anchors) = harvest.get("anchors_file").and_then(Value::as_str) {
            command.arg("--anchors-file").arg(anchors);
        }
        if let Some(since) = harvest.get("since").and_then(Value::as_str) {
            command.arg("--since").arg(since);
        }
        if let Some(top_k) = harvest.get("top_k").and_then(Value::as_u64) {
            command.arg("--top-k").arg(top_k.to_string());
        }
        for root in harvest
            .get("revive_roots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            command.arg("--revive-root").arg(root);
        }
        paths.literature_driver_script.clone()
    } else if contract.role == "scout" || contract.role == "analyst" {
        let queries_path = lane_dir.join("queries.json");
        command
            .arg(&paths.literature_driver_script)
            .arg("--role")
            .arg(&contract.role)
            .arg("--output-dir")
            .arg(&output_dir);
        if role_plan_path.exists() {
            command.arg("--role-plan-file").arg(&role_plan_path);
        }
        if queries_path.exists() {
            command.arg("--queries-file").arg(&queries_path);
        } else {
            command.arg("--task-file").arg(&contract.task_file);
        }
        paths.literature_driver_script.clone()
    } else {
        command
            .arg(&paths.stats_driver_script)
            .arg("--csv-root")
            .arg(&selected_dataset_root)
            .arg("--task-file")
            .arg(&contract.task_file)
            .arg("--output-dir")
            .arg(&output_dir);
        if role_plan_path.exists() {
            command.arg("--role-plan-file").arg(&role_plan_path);
        }
        paths.stats_driver_script.clone()
    };

    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("failed to run python driver {}", driver_path.display()))?;
    write_process_metadata(
        paths,
        contract,
        "external_driver_running",
        json!({
            "pid": child.id(),
            "started_at": now_iso(),
            "driver": driver_path,
        }),
    )?;
    let mut recovered_timeout_result = false;
    let output = match child.wait_timeout(Duration::from_secs(timeout_seconds))? {
        Some(_) => child.wait_with_output()?,
        None => {
            let _ = child.kill();
            let output = child.wait_with_output()?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            if let Ok(existing_payload) = read_json(&output_dir.join("result.json")) {
                if existing_payload.get("status").and_then(Value::as_str) == Some("completed") {
                    recovered_timeout_result = true;
                }
            }
            if !recovered_timeout_result {
                let _ = fs::remove_file(lane_process_path(
                    paths,
                    &contract.cycle_id,
                    &contract.lane_id,
                ));
                bail!(
                    "python external driver timed out after {timeout_seconds}s for {} stdout={} stderr={}",
                    driver_path.display(),
                    stdout.trim().chars().take(400).collect::<String>(),
                    stderr.trim().chars().take(400).collect::<String>(),
                );
            }
            output
        }
    };
    let _ = fs::remove_file(lane_process_path(
        paths,
        &contract.cycle_id,
        &contract.lane_id,
    ));

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() && !recovered_timeout_result {
        let status_text = output
            .status
            .code()
            .map(|code| format!("exit_code={code}"))
            .unwrap_or_else(|| "terminated_by_signal".to_string());
        let stderr_trimmed = stderr.trim();
        let stdout_trimmed = stdout.trim();
        let detail = if !stderr_trimmed.is_empty() {
            stderr_trimmed.to_string()
        } else if !stdout_trimmed.is_empty() {
            format!("stdout: {stdout_trimmed}")
        } else {
            "no stdout/stderr emitted".to_string()
        };
        bail!("python stats driver failed ({status_text}): {detail}");
    }

    let mut payload = read_json(&output_dir.join("result.json"))?;
    if recovered_timeout_result {
        payload["driver_timeout_recovered_from_result"] = json!(true);
        payload["driver_timeout_seconds"] = json!(timeout_seconds);
    }
    if let Some(role_plan) = role_plan {
        payload["role_plan"] = compact_role_plan_for_lane_result(role_plan);
        payload["role_plan_path"] = json!(role_plan_path);
    }
    if let Some(status) = mark_pending_literature_recovery(
        &mut payload,
        contract,
        role_plan,
        &output_dir,
        &role_plan_path,
    ) {
        write_json(&output_dir.join("result.json"), &payload)?;
        let artifacts = [
            "result.json",
            "papers.json",
            "abstract-review-queue.json",
            "literature-candidates.json",
            "literature-screening-audit.json",
            "search-agent-journal.json",
            "search-agent-synthesis.json",
            "search-agent-assessment.json",
        ]
        .iter()
        .map(|name| output_dir.join(name).display().to_string())
        .collect();
        return Ok((status.to_string(), payload, stdout, stderr, artifacts));
    }
    if contract.role == "analyst" {
        let analyst_handoff = payload
            .get("analyst_handoff")
            .cloned()
            .or_else(|| payload.get("handoff_validation_plan").cloned())
            .ok_or_else(|| {
                anyhow!("analyst external-driver output missing analyst_handoff contract")
            })?;
        let mut analyst_handoff = analyst_handoff;
        super::handoff_seal::seal_analyst_handoff(paths, &contract.cycle_id, &mut analyst_handoff);
        let handoff_path = output_dir.join("handoff-validation-plan.json");
        write_json(&handoff_path, &analyst_handoff)?;
        payload["analyst_handoff"] = analyst_handoff;
        payload["analyst_handoff_path"] = json!(handoff_path.display().to_string());
    }
    if contract.role != "scout" && contract.role != "analyst" {
        // The stats driver resolves its own root from the handoff when the
        // handoff's dataset references point elsewhere (python_stats
        // `_resolve_dataset_root`). What it actually read is the record, so its
        // answer is not overwritten with the bundle offered to it.
        let driver_resolved_root = payload
            .get("dataset_root_source")
            .and_then(Value::as_str)
            .map(|source| source != "harness_csv_root")
            .unwrap_or(false);
        if !driver_resolved_root {
            payload["dataset_root"] = json!(selected_dataset_root);
        }
        payload["dataset_bundle"] = json!({
            "dataset_root": selected_dataset_root,
            "dataset_bundle_source": dataset_bundle_source.as_str(),
            "content_policy": "compact lane-result projection; full dataset bundle is available from the cycle dataset bundle/artifact context",
        });
        payload["dataset_bundle_source"] = json!(dataset_bundle_source.as_str());
        // docs/data-fetcher-2026-04-28.md §E: when no cycle-scoped
        // bundle was materialised by the Phase 1 fetcher, surface a
        // structured warning so chronicle / promotion gates can see
        // the cycle ran against legacy / no-bundle data.
        if dataset_bundle_source.fell_back_to_legacy() {
            let warnings = payload.get_mut("warnings").and_then(Value::as_array_mut);
            let warning = json!({
                "code": "dataset_fallback_to_legacy",
                "source": dataset_bundle_source.as_str(),
                "dataset_root": selected_dataset_root,
                "cycle_id": contract.cycle_id,
            });
            match warnings {
                Some(arr) => arr.push(warning),
                None => {
                    payload["warnings"] = json!([warning]);
                }
            }
        }
    }
    let artifacts = if contract.role == "scout" || contract.role == "analyst" {
        let mut outputs = vec![
            output_dir.join("summary.md").display().to_string(),
            output_dir.join("result.json").display().to_string(),
            output_dir.join("papers.json").display().to_string(),
        ];
        if contract.role == "analyst" {
            outputs.push(
                output_dir
                    .join("handoff-validation-plan.json")
                    .display()
                    .to_string(),
            );
        }
        outputs
    } else {
        vec![
            output_dir.join("summary.md").display().to_string(),
            output_dir.join("tidy.csv").display().to_string(),
            output_dir.join("correlations.json").display().to_string(),
            output_dir.join("figure-spec.json").display().to_string(),
            output_dir.join("result.json").display().to_string(),
        ]
    };
    Ok(("completed".to_string(), payload, stdout, stderr, artifacts))
}

pub(crate) fn run_native_readonly(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<(String, Value, String, String, Vec<String>)> {
    let dataset_override = role_plan
        .and_then(|plan| plan.get("dataset_root").and_then(Value::as_str))
        .map(PathBuf::from);
    let (selected_dataset_root, dataset_bundle_source) = choose_dataset_bundle_path(
        paths,
        dataset_override.as_deref(),
        Some(contract.cycle_id.as_str()),
    )?;
    let candidates =
        dataset_bundle_paths_visible_to_cycle(paths, Some(contract.cycle_id.as_str()))?
            .into_iter()
            .map(|path| dataset_bundle_summary(paths, &path))
            .collect::<Vec<_>>();
    let mut payload = json!({
        "status": "completed",
        "driver": "native-readonly-scan",
        "lane_id": contract.lane_id,
        "dataset_root": selected_dataset_root,
        "dataset_bundle_source": dataset_bundle_source.as_str(),
        "selected_dataset_bundle": dataset_bundle_summary(paths, &selected_dataset_root),
        "dataset_candidates": candidates,
        "role_plan": role_plan.cloned(),
    });
    if dataset_bundle_source.fell_back_to_legacy() {
        payload["warnings"] = json!([{
            "code": "dataset_fallback_to_legacy",
            "source": dataset_bundle_source.as_str(),
            "dataset_root": selected_dataset_root,
            "cycle_id": contract.cycle_id,
        }]);
    }
    Ok((
        "completed".to_string(),
        payload,
        "native readonly scan completed\n".to_string(),
        String::new(),
        vec![],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn contract(role: &str) -> LaneContract {
        LaneContract {
            cycle_id: "cycle-test".to_string(),
            lane_id: format!("{role}-01"),
            role: role.to_string(),
            runtime_class: "external-driver".to_string(),
            mode: "driver-exec".to_string(),
            cwd: PathBuf::from("/tmp"),
            task_file: PathBuf::from("/tmp/task.md"),
            allowed_inputs: Vec::new(),
            allowed_outputs: Vec::new(),
            output_artifact: None,
            fallback_strategy: None,
        }
    }

    #[test]
    fn approved_policy_blocks_stale_external_dataset_scouts_but_not_literature_scouts() {
        assert!(approved_dataset_external_driver_forbidden(
            "scout",
            "data_acquisition_followup",
            Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
        ));
        assert!(approved_dataset_external_driver_forbidden(
            "scout",
            "reasoning_data_scout",
            Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
        ));
        assert!(!approved_dataset_external_driver_forbidden(
            "scout",
            "reasoning_literature_scout",
            Some(APPROVED_SCHOLARLY_NETWORK_POLICY),
        ));
        assert!(!approved_dataset_external_driver_forbidden(
            "scout",
            "data_acquisition_followup",
            None,
        ));
    }

    #[test]
    fn unreviewed_literature_is_failed_with_scout_recovery_not_completed_handoff() {
        for literature_status in ["pending_review", "no_admitted_evidence"] {
            let mut payload = json!({"status": literature_status, "papers": [], "paper_count": 0});
            let execution_status = mark_pending_literature_recovery(
                &mut payload,
                &contract("analyst"),
                None,
                std::path::Path::new("cycle/analyst-01"),
                std::path::Path::new("cycle/role-plan.json"),
            );
            assert_eq!(execution_status, Some("failed"));
            assert_eq!(payload["status"], literature_status);
            assert_eq!(payload["degraded"], true);
            assert_eq!(payload["paper_count"], 0);
            assert_eq!(payload["recommended_actions"][0]["preferred_role"], "scout");
            assert_eq!(
                payload["recommended_actions"][0]["type"],
                "abstract_review_followup"
            );
            assert_eq!(
                payload["recommended_actions"][0]["literature_review_source_dir"],
                "cycle/analyst-01"
            );
        }
        let mut numeric_payload = json!({"status": "completed", "metrics": {"accuracy": 0.9}});
        assert_eq!(
            mark_pending_literature_recovery(
                &mut numeric_payload,
                &contract("lab-runner"),
                None,
                std::path::Path::new("cycle/runner"),
                std::path::Path::new("cycle/role-plan.json"),
            ),
            None
        );
        assert_eq!(numeric_payload["status"], "completed");
        assert!(numeric_payload.get("recovery_role").is_none());
    }

    #[test]
    fn incomplete_adaptive_search_preserves_screened_papers_and_routes_gap_followup() {
        let role_plan = json!({
            "action_type": "adaptive_search_followup",
            "search_agent_contract": {
                "contract_version": "adaptive-search-agent-v1",
                "research_problem": "Which latency boundary changes the decision?"
            }
        });
        let mut payload = json!({
            "status": "insufficient_corpus",
            "papers": [{"id": "arxiv:1234.5678", "title": "Screened comparator"}],
            "paper_count": 1,
            "evidence_ready": true,
            "search_decision_ready": false,
            "search_agent_assessment": {"gaps": ["forward_citation_missing"]}
        });
        let execution_status = mark_pending_literature_recovery(
            &mut payload,
            &contract("scout"),
            Some(&role_plan),
            std::path::Path::new("cycle/scout-01"),
            std::path::Path::new("cycle/scout-01/role-plan.json"),
        );
        assert_eq!(execution_status, Some("failed"));
        assert_eq!(payload["papers"].as_array().unwrap().len(), 1);
        assert_eq!(payload["paper_count"], 1);
        assert_eq!(payload["evidence_ready"], true);
        assert_eq!(payload["search_decision_ready"], false);
        assert_eq!(
            payload["recommended_actions"][0]["type"],
            "adaptive_search_followup"
        );
        assert_eq!(
            payload["recommended_actions"][0]["literature_review_source_dir"],
            "cycle/scout-01"
        );
        assert_eq!(
            payload["recommended_actions"][0]["source_lane_id"],
            "scout-01"
        );
        assert_eq!(
            payload["recommended_actions"][0]["search_agent_gaps"][0],
            "forward_citation_missing"
        );
        let description = payload["recommended_actions"][0]["description"]
            .as_str()
            .unwrap();
        assert!(description.contains("unchanged research problem"));
        assert!(description.contains("Preserve accepted papers"));
        assert!(description.contains("do not re-review accepted abstracts"));
    }

    #[test]
    fn fetch_data_scout_gets_download_sized_timeout() {
        let role_plan = json!({
            "action_type": "data_acquisition_followup",
            "planner_metadata": {
                "source_discovery_mode": "validation-materialization-fetch"
            }
        });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("scout"), Some(&role_plan)),
            1_800
        );
    }

    #[test]
    fn the_frontier_harvest_has_its_own_budget() {
        // Paced citation pages for every anchor under the anonymous pool's 429s:
        // 1,649 s in the 2026-09-19 smoke (labdirector::frontier_harvest).
        let role_plan = json!({
            "action_type": crate::labdirector::FRONTIER_HARVEST_ACTION,
            "constraints": { "timeout_seconds": 600 }
        });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("scout"), Some(&role_plan)),
            crate::labdirector::frontier_harvest_timeout_seconds()
        );
        if env::var_os("RESEARCHLAB_FRONTIER_HARVEST_TIMEOUT_SECONDS").is_none() {
            assert_eq!(crate::labdirector::frontier_harvest_timeout_seconds(), 3_600);
        }
    }

    #[test]
    fn discovery_only_data_scout_keeps_short_timeout() {
        let role_plan = json!({
            "action_type": "data_acquisition_followup",
            "source_discovery_mode": "initial-search"
        });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("scout"), Some(&role_plan)),
            600
        );
    }

    #[test]
    fn lab_runner_default_matches_the_contract_it_is_given() {
        // Was 360 — the shortest timeout in the system, below the generic 600,
        // and it censored real renders (v78: 361/363/364; v76: 357 x4).
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("lab-runner"), None),
            1_800
        );
    }

    #[test]
    fn a_declared_lane_constraint_wins_over_the_role_default() {
        // task_contract.js writes constraints.timeout_seconds per role; the
        // harness used to ignore it, so a plan asking for 1800 ran with 360.
        let role_plan = json!({ "constraints": { "timeout_seconds": 900 } });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("lab-runner"), Some(&role_plan)),
            900
        );
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("chronicle"), Some(&role_plan)),
            900
        );
    }

    #[test]
    fn a_declared_constraint_is_clamped_and_zero_falls_back() {
        let absurd = json!({ "constraints": { "timeout_seconds": 86_400 } });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("lab-runner"), Some(&absurd)),
            3_600
        );
        let zero = json!({ "constraints": { "timeout_seconds": 0 } });
        assert_eq!(
            default_external_driver_timeout_seconds(&contract("chronicle"), Some(&zero)),
            600
        );
    }
}

#[cfg(test)]
mod throttle_classification_tests {
    use super::*;

    // cycle-g-v91: OpenAlex answered 429 and contributed 0 of 109 papers while
    // arXiv and crossref carried the round. Both a throttled source and a thin
    // field arrived downstream as `adaptive_literature_search_incomplete`, so
    // the director could not tell "retry this" from "there is nothing here".
    #[test]
    fn a_throttled_source_is_named() {
        let payload = json!({
            "papers": [],
            "source_stats": {
                "source_hits": { "arxiv": 36, "crossref": 11 },
                "source_failures": [{
                    "source": "openalex",
                    "query": "neural radiance caching foundational reuse",
                    "error": "HTTP Error 429: Too Many Requests",
                    "throttled": true,
                }],
            },
        });
        assert_eq!(throttled_sources_in_result(&payload), vec!["openalex".to_string()]);
    }

    #[test]
    fn a_failure_that_is_not_a_throttle_says_nothing_about_retrying() {
        let payload = json!({
            "source_stats": { "source_failures": [
                { "source": "crossref", "error": "HTTP Error 404: Not Found", "throttled": false },
            ]},
        });
        assert!(throttled_sources_in_result(&payload).is_empty());
    }

    #[test]
    fn a_clean_round_names_no_source() {
        assert!(throttled_sources_in_result(&json!({ "papers": [] })).is_empty());
    }

    #[test]
    fn refusals_in_the_lane_retrieval_receipts_name_the_throttled_sources() {
        // cycle-g-v91 followup-scout-99: every receipt carried OpenAlex and
        // arXiv 429s with throttled=true, and the lane was still recorded as a
        // search that had not finished, because only result.json was read.
        let dir = std::env::temp_dir().join(format!(
            "researchlab-receipts-{}-{}",
            std::process::id(),
            line!()
        ));
        fs::create_dir_all(&dir).unwrap();
        assert!(throttled_sources_in_retrieval_receipts(&dir).is_empty());
        let receipt = |source: &str, throttled: bool| {
            json!({ "query": "q", "source_stats": { "source_failures": [
                { "source": source, "error": "HTTP Error 429: Too Many Requests", "throttled": throttled },
            ]}})
            .to_string()
        };
        fs::write(
            dir.join("search-retrieval-events.jsonl"),
            format!(
                "{}\nnot json\n\n{}\n{}\n",
                receipt("openalex", true),
                receipt("arxiv", true),
                receipt("crossref", false),
            ),
        )
        .unwrap();
        assert_eq!(
            throttled_sources_in_retrieval_receipts(&dir),
            vec!["arxiv".to_string(), "openalex".to_string()]
        );

        let contract = LaneContract {
            cycle_id: "cycle".into(),
            lane_id: "followup-scout-99".into(),
            role: "scout".into(),
            mode: "followup".into(),
            runtime_class: "codex-agent".into(),
            cwd: PathBuf::from("."),
            task_file: PathBuf::from("task.md"),
            allowed_inputs: Vec::new(),
            allowed_outputs: Vec::new(),
            output_artifact: None,
            fallback_strategy: None,
        };
        let mut payload = json!({
            "status": "insufficient_corpus",
            "papers": [],
            "search_agent_assessment": { "gaps": ["required_inquiry_intent_missing:forward_citation"] },
        });
        let status = mark_pending_literature_recovery(
            &mut payload,
            &contract,
            None,
            &dir,
            &dir.join("role-plan.json"),
        );
        assert_eq!(status, Some("failed"));
        assert_eq!(payload["failure_category"], "literature_retrieval_throttled");
        assert_eq!(payload["throttled_sources"], json!(["arxiv", "openalex"]));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_classification_is_found_wherever_the_driver_recorded_it() {
        // The payload carries source_stats differently depending on which
        // collection path ran, so the reader searches by key rather than path.
        let nested = json!({ "extracted_json": { "literature": { "source_stats": {
            "source_failures": [{ "source": "openalex", "throttled": true }],
        }}}});
        assert_eq!(throttled_sources_in_result(&nested), vec!["openalex".to_string()]);
    }
}
