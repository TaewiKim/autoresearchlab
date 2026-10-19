//! Deterministic completion boundary for a reasoning literature Scout.
//!
//! Successful CLI execution says nothing about literature admission or search
//! coverage. Revalidate saved artifacts after the agent exits, independently of
//! its final message, before scheduling downstream hypothesis work.
use anyhow::Result;
use serde_json::{json, Value};
use std::fs::{self, File};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

use super::codex_policy::role_plan_action_type;
use super::process::terminate_process_group;
use super::research_api_policy::apply_cli_environment;
use super::runtime_drivers::mark_pending_literature_recovery;
use crate::core::model::{AppPaths, LaneContract};
use crate::core::support::write_json;

fn read_optional(path: &Path) -> Option<Value> {
    // Lane artifacts are scoped, but a broken agent can still leave huge files.
    if fs::metadata(path).ok()?.len() > 25 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // PowerShell's UTF-8 writers prefix a byte-order mark. On cycle-b-20260917g
    // a scout's valid six-round journal read as absent because of it, and the lane
    // failed on search_rounds_empty.
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice(bytes).ok()
}

fn journal_round_count(journal: &Value) -> usize {
    journal
        .get("search_rounds")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn attach_saved_synthesis(journal: &mut Value, saved: Option<Value>) {
    if !journal.is_object() {
        return;
    }
    if let Some(synthesis) = saved.filter(Value::is_object) {
        // MEASURED ON cycle-a-20260919, 2026-10-14: scout 457
        // finalized search-agent-synthesis.json, but an older, partial
        // journal.synthesis made the completion validator ignore that file.
        journal["synthesis"] = synthesis;
    } else if !journal
        .get("synthesis")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        journal["synthesis"] = Value::Null;
    }
}

/// The fullest search journal this cycle holds, other than this lane's own.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18. An abstract-review follow-up
/// resumes the lane that queued the abstracts, and that lane can be an
/// external-driver scout, which keeps no journal. followup-scout-04 and -06
/// reviewed thirteen and twelve papers and were then failed for
/// `search_rounds_empty`: the reviews had nowhere to land. The search they
/// belong to is the one the scout chain is building, so they inherit it.
fn richest_cycle_journal(paths: &AppPaths, contract: &LaneContract, own_dir: &Path) -> Option<Value> {
    let lanes_root = crate::core::support::cycle_lanes_root(paths, &contract.cycle_id);
    let mut best: Option<(usize, Value)> = None;
    for entry in fs::read_dir(lanes_root).ok()?.flatten() {
        let dir = entry.path();
        if dir == own_dir || !dir.is_dir() {
            continue;
        }
        let Some(journal) = read_optional(&dir.join("search-agent-journal.json")) else {
            continue;
        };
        let rounds = journal_round_count(&journal);
        if rounds > best.as_ref().map(|(count, _)| *count).unwrap_or(0) {
            best = Some((rounds, journal));
        }
    }
    best.map(|(_, journal)| journal)
}

fn pending_assessment(reason: &str) -> Value {
    json!({"valid": false, "decision_ready": false, "status": "pending",
           "gaps": [reason], "screened_paper_ids": [], "accepted_evidence_ids": []})
}

fn validate_saved_payload(project_root: &Path, output_dir: &Path, input: &Value) -> Result<Value> {
    let input_path = output_dir.join("search-agent-validation-input.json");
    let assessment_path = output_dir.join("search-agent-assessment.json");
    write_json(&input_path, input)?;
    let mut command = Command::new("node");
    command
        .arg(project_root.join("src/agents/scout/search_agent.js"))
        .arg("--validate")
        .arg(&input_path)
        .current_dir(project_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(File::create(&assessment_path)?))
        .stderr(Stdio::from(File::create(
            output_dir.join("search-agent-validation-stderr.log"),
        )?));
    apply_cli_environment(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let assessment = match command.spawn() {
        Ok(mut child) => match child.wait_timeout(Duration::from_secs(20))? {
            Some(status) if status.success() => read_optional(&assessment_path)
                .unwrap_or_else(|| pending_assessment("search_agent_assessment_unreadable")),
            Some(_) => pending_assessment("search_agent_validator_failed"),
            None => {
                terminate_process_group(child.id());
                let _ = child.wait();
                pending_assessment("search_agent_validator_timeout")
            }
        },
        Err(_) => pending_assessment("search_agent_validator_unavailable"),
    };
    write_json(&assessment_path, &assessment)?;
    Ok(assessment)
}

fn apply_assessment(payload: &mut Value, candidate_papers: &Value, assessment: Value) -> bool {
    let screened_ids = assessment
        .get("screened_paper_ids")
        .and_then(Value::as_array);
    let papers: Vec<Value> = candidate_papers
        .as_array()
        .into_iter()
        .flatten()
        .filter(|paper| {
            let identity = paper.pointer("/literature_screening/review/paper_id");
            identity.is_some()
                && screened_ids
                    .map(|ids| ids.contains(identity.unwrap()))
                    .unwrap_or(false)
        })
        .cloned()
        .collect();
    let ready = !papers.is_empty()
        && assessment.get("valid").and_then(Value::as_bool) == Some(true)
        && assessment.get("decision_ready").and_then(Value::as_bool) == Some(true);
    payload["paper_count"] = json!(papers.len());
    payload["evidence_ready"] = json!(!papers.is_empty());
    payload["papers"] = json!(papers);
    payload["search_agent_assessment"] = assessment;
    payload["search_decision_ready"] = json!(ready);
    payload["status"] = json!(if ready {
        "completed"
    } else {
        "insufficient_corpus"
    });
    ready
}

pub(super) fn enforce_literature_agent_completion(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    payload: &mut Value,
) -> Result<Option<&'static str>> {
    if contract.role != "scout"
        || matches!(
            role_plan_action_type(role_plan),
            // A deep read writes cards, not a search journal (labdirector::sota_cards).
            "data_acquisition_followup" | "reasoning_data_scout" | crate::labdirector::SOTA_DEEP_READ_ACTION
        )
    {
        return Ok(None);
    }
    let lane_dir = contract.task_file.parent().unwrap_or(&contract.cwd);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(lane_dir);
    fs::create_dir_all(output_dir)?;
    let role_plan_path = lane_dir.join("role-plan.json");
    // The Scout may define initially unresolved field facets in its saved plan.
    let plan = read_optional(&role_plan_path)
        .or_else(|| role_plan.cloned())
        .unwrap_or_else(|| json!({}));
    let source_result = read_optional(&output_dir.join("result.json")).unwrap_or_else(|| json!({}));
    let papers = read_optional(&output_dir.join("papers.json"))
        .or_else(|| source_result.get("papers").cloned())
        .unwrap_or_else(|| json!([]));
    let mut journal =
        read_optional(&output_dir.join("search-agent-journal.json")).unwrap_or(Value::Null);
    if role_plan_action_type(role_plan) == "abstract_review_followup" && journal_round_count(&journal) == 0
    {
        if let Some(mut inherited) = richest_cycle_journal(paths, contract, output_dir) {
            if journal_round_count(&inherited) > 0 {
                inherited["inherited_by_abstract_review_lane"] = json!(contract.lane_id);
                write_json(&output_dir.join("search-agent-journal.json"), &inherited)?;
                payload["search_agent_journal_inherited"] = json!(true);
                journal = inherited;
            }
        }
    }
    attach_saved_synthesis(
        &mut journal,
        read_optional(&output_dir.join("search-agent-synthesis.json")),
    );
    // Defining field facets must not change the original assignment objective.
    let original_objective = role_plan
        .and_then(|value| {
            value
                .get("screening_objective")
                .or_else(|| value.get("objective"))
                .or_else(|| value.get("prompt"))
        })
        .filter(|value| {
            value
                .as_str()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        });
    let objective = original_objective
        .or_else(|| plan.get("screening_objective"))
        .or_else(|| plan.get("objective"))
        .or_else(|| plan.get("prompt"))
        .cloned()
        .unwrap_or(Value::Null);
    let input = json!({"objective": objective, "role_plan": plan, "papers": papers,
                       "search_agent_journal": journal});
    let assessment = validate_saved_payload(&paths.project_root, output_dir, &input)?;
    payload["role_plan"] = input["role_plan"].clone();
    payload["search_agent_contract"] = input["role_plan"]["search_agent_contract"].clone();
    payload["search_agent_journal"] = input["search_agent_journal"].clone();
    payload["search_agent_journal_path"] = json!(output_dir.join("search-agent-journal.json"));
    payload["literature_screening"] = source_result
        .get("literature_screening")
        .cloned()
        .unwrap_or(Value::Null);
    let ready = apply_assessment(payload, &input["papers"], assessment);
    // Publish only independently revalidated papers, even on a failed lane.
    write_json(&output_dir.join("papers.json"), &payload["papers"])?;
    let execution_status = if ready {
        "completed"
    } else {
        mark_pending_literature_recovery(
            payload,
            contract,
            Some(&input["role_plan"]),
            output_dir,
            &role_plan_path,
        )
        .unwrap_or("failed")
    };
    write_json(
        &output_dir.join("reviewed-literature-result.json"),
        &json!({
            "driver": "literature-search-driver", "role": "scout", "status": payload["status"],
            "role_plan": input["role_plan"], "papers": payload["papers"], "paper_count": payload["paper_count"],
            "search_agent_contract": payload["search_agent_contract"], "search_agent_journal": payload["search_agent_journal"],
            "search_agent_assessment": payload["search_agent_assessment"], "search_decision_ready": ready,
            "literature_screening": payload["literature_screening"]
        }),
    )?;
    Ok(Some(execution_status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_abstract_review_lane_inherits_the_cycles_fullest_journal() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths {
            project_root: temp.path().join("project"),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: std::path::PathBuf::from("stats.py"),
            literature_driver_script: std::path::PathBuf::from("literature.py"),
        };
        let lanes = crate::core::support::cycle_lanes_root(&paths, "cycle-review");
        let write_journal = |lane: &str, rounds: usize| {
            let dir = lanes.join(lane);
            fs::create_dir_all(&dir).unwrap();
            let rounds: Vec<Value> = (0..rounds).map(|i| json!({"round_id": format!("r{i}")})).collect();
            write_json(&dir.join("search-agent-journal.json"), &json!({"search_rounds": rounds})).unwrap();
        };
        write_journal("followup-scout-01", 11);
        write_journal("followup-scout-05", 14);
        // The lane that queued the abstracts kept no journal of its own.
        fs::create_dir_all(lanes.join("followup-scout-02")).unwrap();
        let own = lanes.join("followup-scout-06");
        fs::create_dir_all(&own).unwrap();

        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "cycle-review", "lane_id": "followup-scout-06", "role": "scout",
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": temp.path(), "task_file": own.join("task.md"),
            "output_artifact": own.join("result.json"), "fallback_strategy": null,
        }))
        .unwrap();
        let inherited = richest_cycle_journal(&paths, &contract, &own).expect("no journal inherited");
        assert_eq!(journal_round_count(&inherited), 14);

        // Its own journal, once it has rounds, is never replaced.
        write_journal("followup-scout-06", 2);
        let own_journal = read_optional(&own.join("search-agent-journal.json")).unwrap();
        assert_eq!(journal_round_count(&own_journal), 2);
    }

    #[test]
    fn a_journal_with_a_powershell_byte_order_mark_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("search-agent-journal.json");
        fs::write(&path, b"\xef\xbb\xbf{\"search_rounds\":[{\"round_id\":\"r1\"}]}").unwrap();
        let journal = read_optional(&path).expect("a BOM-prefixed journal read as absent");
        assert_eq!(journal["search_rounds"][0]["round_id"], "r1");
        let plain = dir.path().join("plain.json");
        fs::write(&plain, b"{\"a\":1}").unwrap();
        assert_eq!(read_optional(&plain).unwrap()["a"], 1);
        assert_eq!(crate::core::support::read_json(&path).unwrap()["search_rounds"][0]["round_id"], "r1");
    }

    #[test]
    fn finalized_synthesis_replaces_a_stale_embedded_checkpoint() {
        // MEASURED ON cycle-a-20260919, 2026-10-14: scout 457's
        // standalone synthesis had all required sections while the embedded
        // checkpoint had only saturation and next-search fields.
        let mut journal = json!({"synthesis": {
            "next_search_decisions": ["stale"],
            "saturation": {"termination_reason": "old checkpoint"}
        }});
        let finalized = json!({
            "claim_paper_links": [{"hypothesis_ids": ["assigned-hypothesis-1"], "paper_ids": ["p1"]}],
            "closest_prior_art": [{"paper_id": "p1"}],
            "coverage_gaps": [],
            "next_search_decisions": [],
            "saturation": {"search_complete": true, "termination_reason": "stable boundary"}
        });
        attach_saved_synthesis(&mut journal, Some(finalized.clone()));
        assert_eq!(journal["synthesis"], finalized);
    }

    #[test]
    fn successful_model_message_cannot_override_pending_search_or_inject_raw_papers() {
        let screened = json!({"title": "reviewed", "literature_screening": {"review": {"paper_id": "doi:verified"}}});
        let mut payload = json!({"status": "completed", "extracted_json": {"status": "ok"}});
        let ready = apply_assessment(
            &mut payload,
            &json!([screened.clone(), {"title": "raw"}]),
            json!({"valid": false, "decision_ready": false, "screened_paper_ids": ["doi:verified"], "gaps": ["forward_citation_missing"]}),
        );
        assert!(!ready);
        assert_eq!(payload["status"], "insufficient_corpus");
        assert_eq!(payload["papers"], json!([screened]));
        assert_eq!(payload["evidence_ready"], true);
    }

    #[test]
    fn validator_unavailability_fails_closed_and_empty_evidence_is_never_ready() {
        let mut payload = json!({"status": "completed"});
        assert!(!apply_assessment(
            &mut payload,
            &json!([{ "title": "raw" }]),
            pending_assessment("node unavailable")
        ));
        assert_eq!(payload["paper_count"], 0);
        assert!(!apply_assessment(
            &mut payload,
            &json!([]),
            json!({"valid": true, "decision_ready": true, "screened_paper_ids": []})
        ));
    }

    #[test]
    fn native_completion_calls_the_real_js_validator_without_model_or_network() {
        let tmp = tempfile::tempdir().unwrap();
        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let assessment = validate_saved_payload(
            project_root,
            tmp.path(),
            &json!({
                "objective": "A bounded test question", "role_plan": {},
                "papers": [{"title": "unreviewed candidate"}],
                "search_agent_journal": {"status": "completed"}
            }),
        )
        .unwrap();
        assert_eq!(assessment["valid"], false);
        assert_eq!(assessment["screened_paper_ids"], json!([]));
        assert!(assessment["gaps"]
            .as_array()
            .unwrap()
            .contains(&json!("search_agent_contract_missing")));
    }
}
