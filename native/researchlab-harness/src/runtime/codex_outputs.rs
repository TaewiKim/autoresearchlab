use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use super::codex_prompt::truncate_chars;
use crate::core::model::AppPaths;
use crate::core::support::state_root;

pub(crate) fn extract_codex_last_message(stdout: &str) -> String {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if parsed.get("type").and_then(Value::as_str) != Some("item.completed") {
            continue;
        }
        let item = match parsed.get("item") {
            Some(value) => value,
            None => continue,
        };
        if item.get("type").and_then(Value::as_str) != Some("agent_message") {
            continue;
        }
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn synthesized_validation_code_blueprints(parsed: &Value, handoff_checks: &[Value]) -> Vec<Value> {
    if let Some(items) = parsed
        .get("validation_code_blueprints")
        .and_then(Value::as_array)
    {
        if !items.is_empty() {
            return items.clone();
        }
    }
    let Some(check) = handoff_checks.first() else {
        return Vec::new();
    };
    let check_id = check
        .get("check_id")
        .and_then(Value::as_str)
        .unwrap_or("analyst_check_01");
    let dataset = check
        .get("dataset")
        .and_then(Value::as_str)
        .unwrap_or("analysis_table.csv");
    let outcome = check
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("outcome");
    let exposures = check
        .get("exposures")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "<exposure_column_from_handoff_check>".to_string());
    let adjustment_set = check
        .get("adjustment_set")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "<adjustment_columns_from_handoff_check>".to_string());
    let model_family = check
        .get("model_family")
        .and_then(Value::as_str)
        .unwrap_or("ols");
    let code = format!(
        "import pandas as pd\n\n\
df = pd.read_csv(\"{dataset}\")\n\
# TODO: verify required columns before execution.\n\
required = [{required_columns}]\n\
missing = [col for col in required if col not in df.columns]\n\
if missing:\n\
    raise ValueError(f\"missing required columns: {{missing}}\")\n\n\
# Planned analyst blueprint for {check_id}\n\
# exposures: {exposures}\n\
# adjustment_set: {adjustment_set}\n\
# model_family: {model_family}\n\
analysis_df = df.dropna(subset=required).copy()\n\
print({{\"check_id\": \"{check_id}\", \"rows\": len(analysis_df)}})\n",
        dataset = dataset,
        required_columns = serde_json::to_string(
            &check
                .get("exposures")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .chain(std::iter::once(json!(outcome)))
                .chain(
                    check
                        .get("adjustment_set")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter(),
                )
                .collect::<Vec<_>>()
        )
        .unwrap_or_else(|_| "[]".to_string()),
        check_id = check_id,
        exposures = exposures,
        adjustment_set = adjustment_set,
        model_family = model_family,
    );
    vec![json!({
        "blueprint_id": format!("blueprint:{check_id}"),
        "check_id": check_id,
        "language": "python",
        "entrypoint": format!("run_{}", check_id.replace('-', "_")),
        "code": code,
        "dependencies": ["pandas"],
        "execution_notes": [
            format!("Load `{}` and confirm the requested columns exist before fitting the model.", dataset),
            format!("Implement `{}` for outcome `{}` with exposures `{}`.", model_family, outcome, exposures),
            format!("Apply adjustment set `{}` and any fixed effects or sample filters from the handoff check.", adjustment_set),
        ],
        "review_focus": [
            "column availability",
            "model-spec alignment",
            "sample-filter correctness",
        ],
        "review_status": "needs_runner_execution",
    })]
}

fn synthesized_analyst_self_review(parsed: &Value, handoff_checks: &[Value]) -> Value {
    if let Some(review) = parsed.get("self_review") {
        if review.is_object() {
            return review.clone();
        }
    }
    let linked_check = handoff_checks
        .first()
        .and_then(|item| item.get("check_id"))
        .and_then(Value::as_str)
        .unwrap_or("analyst_check_01");
    json!({
        "review_status": "approved_for_handoff",
        "summary": format!("Fallback self-review attached a minimal executable blueprint for `{}` and flagged runner-side verification as still required.", linked_check),
        "assumption_checks": [
            "The named dataset and columns exist in the normalized analysis bundle.",
            "The adjustment set matches the intended estimand and does not omit the main planned controls.",
            "The specified model family is appropriate for the outcome scale.",
        ],
        "failure_modes": [
            "Column names differ from the analyst plan.",
            "Sample restrictions or fixed effects need tightening before execution.",
            "The blueprint is structurally valid but still needs real execution against the active dataset.",
        ],
        "requested_revisions": [],
    })
}

/// Largest script file a blueprint may name in `code_file`.
const CODE_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Directories a blueprint's `code_file` may point into: this cycle's lanes and
/// the artifact tree runners write to.
pub(crate) fn blueprint_code_file_roots(paths: &AppPaths, lane_root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(cycle_lanes) = lane_root.parent() {
        roots.push(cycle_lanes.to_path_buf());
    }
    roots.push(paths.runtime_root.join("artifacts"));
    roots
}

/// Copy the exact bytes of each blueprint's `code_file` into its `code`.
///
/// On cycle-g-v91 the director asked for a reviewed 27,379-byte source to be
/// dispatched verbatim. The only channel was the `code` string of the final
/// message, so two analysts retyped the file and dispatched 24,409 and 20,877
/// bytes; both runners stopped on the scripts' own integrity check having
/// measured nothing. A file that already exists is copied, not retyped.
///
/// A reference that cannot be copied leaves `code` as written and records why
/// in `code_file_error`, so it reads as unexecutable rather than as a silent swap.
pub(crate) fn inline_blueprint_code_files(handoff: &mut Value, allowed_roots: &[PathBuf]) {
    let roots: Vec<PathBuf> = allowed_roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect();
    let Some(blueprints) = handoff
        .get_mut("validation_code_blueprints")
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    for blueprint in blueprints.iter_mut() {
        let Some(requested) = blueprint
            .get("code_file")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        match read_code_file(Path::new(&requested), &roots) {
            Ok((path, source)) => {
                blueprint["code_file_bytes"] = json!(source.len());
                blueprint["code_inlined_from"] = json!(path.display().to_string());
                blueprint["code"] = json!(source);
            }
            Err(reason) => {
                blueprint["code_file_error"] = json!(format!("{requested}: {reason}"));
            }
        }
    }
}

fn read_code_file(requested: &Path, roots: &[PathBuf]) -> Result<(PathBuf, String), String> {
    let path = fs::canonicalize(requested).map_err(|err| format!("cannot be resolved ({err})"))?;
    if !roots.iter().any(|root| path.starts_with(root)) {
        return Err("is outside this cycle's lane and artifact directories".to_string());
    }
    let metadata = fs::metadata(&path).map_err(|err| format!("cannot be read ({err})"))?;
    if !metadata.is_file() {
        return Err("is not a regular file".to_string());
    }
    if metadata.len() > CODE_FILE_MAX_BYTES {
        return Err(format!(
            "is {} bytes, over the {CODE_FILE_MAX_BYTES} byte limit",
            metadata.len()
        ));
    }
    let bytes = fs::read(&path).map_err(|err| format!("cannot be read ({err})"))?;
    let source = String::from_utf8(bytes).map_err(|_| "is not UTF-8 text".to_string())?;
    Ok((path, source))
}

#[cfg(test)]
mod code_file_tests {
    use super::*;

    fn handoff(code_file: Value) -> Value {
        json!({
            "validation_code_blueprints": [{ "check_id": "CHK-01", "code": "# see file", "code_file": code_file }]
        })
    }

    #[test]
    fn a_named_file_is_dispatched_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let lanes = dir.path().join("lanes");
        fs::create_dir_all(&lanes).unwrap();
        let source = "import sys\r\nprint('x')   \n\n# no final newline";
        let file = lanes.join("check.py");
        fs::write(&file, source).unwrap();
        let mut payload = handoff(json!(file.display().to_string()));
        inline_blueprint_code_files(&mut payload, &[lanes]);
        let blueprint = &payload["validation_code_blueprints"][0];
        assert_eq!(blueprint["code"].as_str(), Some(source));
        assert_eq!(blueprint["code_file_bytes"].as_u64(), Some(source.len() as u64));
        assert!(blueprint.get("code_file_error").is_none());
    }

    #[test]
    fn a_file_outside_the_allowed_roots_is_refused_and_code_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let lanes = dir.path().join("lanes");
        fs::create_dir_all(&lanes).unwrap();
        fs::write(dir.path().join("elsewhere.py"), "print('no')").unwrap();
        let escaping = lanes.join("..").join("elsewhere.py");
        let mut payload = handoff(json!(escaping.display().to_string()));
        inline_blueprint_code_files(&mut payload, &[lanes]);
        let blueprint = &payload["validation_code_blueprints"][0];
        assert_eq!(blueprint["code"].as_str(), Some("# see file"));
        assert!(blueprint["code_file_error"].as_str().unwrap().contains("outside"));
    }

    #[test]
    fn a_missing_file_is_reported_not_swapped() {
        let dir = tempfile::tempdir().unwrap();
        let mut payload = handoff(json!(dir.path().join("absent.py").display().to_string()));
        inline_blueprint_code_files(&mut payload, &[dir.path().to_path_buf()]);
        let blueprint = &payload["validation_code_blueprints"][0];
        assert_eq!(blueprint["code"].as_str(), Some("# see file"));
        assert!(blueprint["code_file_error"].as_str().unwrap().contains("cannot be resolved"));
    }

    #[test]
    fn a_null_code_file_changes_nothing() {
        let mut payload = handoff(Value::Null);
        let before = payload.clone();
        inline_blueprint_code_files(&mut payload, &[PathBuf::from("/nonexistent")]);
        assert_eq!(payload, before);
    }

    #[test]
    fn the_analyst_schema_carries_code_file() {
        let schema = super::super::codex_schema::codex_output_schema("analyst", "")
            .expect("analyst schema");
        let items = &schema["properties"]["validation_code_blueprints"]["items"];
        assert!(items["properties"].get("code_file").is_some());
        assert!(items["required"].as_array().unwrap().iter().any(|v| v == "code_file"));
    }
}

pub(crate) fn analyst_handoff_payload(output_last_message: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(output_last_message).ok()?;
    let handoff_checks = parsed.get("handoff_checks")?.as_array()?;
    if handoff_checks.is_empty() {
        return None;
    }
    let validation_code_blueprints =
        synthesized_validation_code_blueprints(&parsed, handoff_checks.as_slice());
    if validation_code_blueprints.is_empty() {
        return None;
    }
    let self_review = synthesized_analyst_self_review(&parsed, handoff_checks.as_slice());
    let analysis_design_memo = analyst_design_memo(&parsed);
    Some(json!({
        "summary": parsed.get("summary").cloned().unwrap_or_else(|| json!("")),
        "primary_hypothesis_id": parsed.get("primary_hypothesis_id").cloned().unwrap_or_else(|| json!("")),
        "candidate_primary_families": parsed.get("candidate_primary_families").cloned().unwrap_or_else(|| json!([])),
        "candidate_estimands": parsed.get("candidate_estimands").cloned().unwrap_or_else(|| json!([])),
        "dataset_profile": parsed.get("dataset_profile").cloned().unwrap_or_else(|| json!({})),
        "validation_design_candidates": parsed.get("validation_design_candidates").cloned().unwrap_or_else(|| json!([])),
        "validation_targets": parsed.get("validation_targets").cloned().unwrap_or_else(|| json!([])),
        "analysis_design_memo": analysis_design_memo,
        "open_source_agent_discovery": parsed.get("open_source_agent_discovery").cloned().unwrap_or_else(|| json!({
            "query_log": [],
            "candidates": [],
            "selected_agent": null,
            "rejection_summary": "Analyst output did not report open-source analysis agent discovery."
        })),
        "selected_open_source_analysis_agent": parsed.get("selected_open_source_analysis_agent").cloned().unwrap_or(Value::Null),
        "rival_dags": parsed.get("rival_dags").cloned().unwrap_or_else(|| json!([])),
        "confounders": parsed.get("confounders").cloned().unwrap_or_else(|| json!([])),
        "falsification_ideas": parsed.get("falsification_ideas").cloned().unwrap_or_else(|| json!([])),
        "evidence_gaps": parsed.get("evidence_gaps").cloned().unwrap_or_else(|| json!([])),
        "analysis_lane_proposals": parsed.get("analysis_lane_proposals").cloned().unwrap_or_else(|| json!([])),
        "analyst_quality_standard": parsed.get("analyst_quality_standard").cloned().unwrap_or_else(|| json!({
            "minimum_blueprints_passed": 1,
            "require_no_blueprint_failures": true,
            "require_all_handoff_checks_pass": false,
            "require_all_handoff_checks_resolved": true,
            "required_validation_checks": [],
            // Structural criteria only. Score floors are modality-specific: a
            // render/procedural handoff's blueprints never emit
            // analysis_accuracy_score, so an unconditional 80 floor auto-degraded
            // every such validation (113/123 on cycle-g-v55). Floors must be
            // declared by the analyst only for metrics its blueprints emit.
            "minimum_method_appropriateness_score": null,
            "minimum_analysis_accuracy_score": null,
            "allow_inconclusive_for_gate_review": false,
            "rationale": "Default structural handoff quality standard inserted because analyst output omitted an explicit standard. Structural criteria only: score floors apply only when the analyst declares them for metrics the attached blueprints emit."
        })),
        "handoff_checks": Value::Array(handoff_checks.clone()),
        "validation_code_blueprints": Value::Array(validation_code_blueprints),
        "self_review": self_review,
    }))
}

fn slugify_family_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_underscore = true;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.extend(ch.to_lowercase());
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "candidate_family".to_string()
    } else {
        trimmed
    }
}

fn skeleton_handoff_check_for_family(family: &str) -> Value {
    let slug = slugify_family_name(family);
    json!({
        "check_id": format!("handoff_skeleton_{slug}_01"),
        "goal": format!(
            "Skeleton handoff synthesized for candidate family `{family}` after the analyst lane \
             did not emit an executable contract. The planner must regenerate dataset, outcome, \
             exposures, adjustment set, model family, and success/failure criteria from the \
             objective and evidence bundle before dispatching a runner.",
        ),
        "dataset": Value::Null,
        "outcome": Value::Null,
        "exposures": Vec::<Value>::new(),
        "adjustment_set": Vec::<Value>::new(),
        "fixed_effects": Vec::<Value>::new(),
        "sample_filters": Vec::<Value>::new(),
        "model_family": Value::Null,
        "success_criteria": json!({}),
        "failure_criteria": Vec::<Value>::new(),
        "requires_planner_regeneration": true,
    })
}

pub(crate) fn synthesized_analyst_handoff(
    role_plan: Option<&Value>,
    output_last_message: &str,
) -> Option<Value> {
    let parsed_output: Value = extract_first_json_object(output_last_message)
        .or_else(|| serde_json::from_str(output_last_message).ok())
        .unwrap_or(Value::Null);

    let candidate_families = parsed_output
        .get("candidate_primary_families")
        .and_then(Value::as_array)
        .cloned()
        .filter(|items| !items.is_empty())
        .or_else(|| {
            role_plan
                .and_then(|value| value.get("candidate_primary_families"))
                .and_then(Value::as_array)
                .cloned()
                .filter(|items| !items.is_empty())
        })
        .unwrap_or_default();

    let primary_family = candidate_families
        .iter()
        .filter_map(|item| {
            item.get("family_root")
                .or_else(|| item.get("family"))
                .and_then(Value::as_str)
        })
        .find(|value| !value.trim().is_empty())
        .map(str::to_string);

    // Without a family name anywhere we refuse to fabricate one — the planner
    // must see a failed analyst lane and regenerate the contract from the
    // cycle objective and current evidence bundle.
    let primary_family = primary_family?;

    // Prefer analyst-proposed handoff checks when present; otherwise emit a
    // skeleton that explicitly requires planner regeneration. No domain
    // defaults (dataset, outcome, exposures) are injected here.
    let handoff_checks = parsed_output
        .get("handoff_checks")
        .and_then(Value::as_array)
        .cloned()
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| vec![skeleton_handoff_check_for_family(&primary_family)]);

    let validation_code_blueprints =
        synthesized_validation_code_blueprints(&parsed_output, handoff_checks.as_slice());
    let self_review = synthesized_analyst_self_review(&parsed_output, handoff_checks.as_slice());

    let primary_hypothesis_id = parsed_output
        .get("primary_hypothesis_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("hyp-{}-pending", slugify_family_name(&primary_family)));

    Some(json!({
        "summary": parsed_output
            .get("summary")
            .cloned()
            .or_else(|| {
                role_plan
                    .and_then(|value| value.get("analysis_goal"))
                    .cloned()
            })
            .unwrap_or_else(|| json!(
                "Fallback analyst handoff synthesized from role plan after missing structured output. \
                 Planner must regenerate the handoff contract before runner dispatch."
            )),
        "primary_hypothesis_id": primary_hypothesis_id,
        "candidate_primary_families": if candidate_families.is_empty() {
            json!([{
                "family_root": primary_family,
                "why_competitive": "Candidate family preserved from partial analyst output; planner must justify competitiveness from current evidence.",
                "priority": "high"
            }])
        } else {
            Value::Array(candidate_families)
        },
        "candidate_estimands": parsed_output
            .get("candidate_estimands")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "dataset_profile": parsed_output
            .get("dataset_profile")
            .cloned()
            .unwrap_or_else(|| json!({})),
        "validation_design_candidates": parsed_output
            .get("validation_design_candidates")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "validation_targets": parsed_output
            .get("validation_targets")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "analysis_design_memo": parsed_output
            .get("analysis_design_memo")
            .cloned()
            .unwrap_or_else(|| json!({
                "artifact_type": "analysis-design-memo",
                "phase": "exploratory_scientific_design_before_runner_handoff",
                "design_candidates": [],
                "final_handoff_readiness": {"ready_for_runner": false, "blocking_reason": "synthesized handoff requires analyst regeneration", "fallback_topic_or_path_token_checks_allowed": false}
            })),
        "rival_dags": parsed_output
            .get("rival_dags")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "confounders": parsed_output
            .get("confounders")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "falsification_ideas": parsed_output
            .get("falsification_ideas")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "evidence_gaps": parsed_output
            .get("evidence_gaps")
            .cloned()
            .unwrap_or_else(|| json!([
                "Analyst lane did not emit a full structured contract, so this handoff was synthesized as a skeleton and still requires planner regeneration against the current objective and evidence bundle."
            ])),
        "analysis_lane_proposals": parsed_output
            .get("analysis_lane_proposals")
            .cloned()
            .unwrap_or_else(|| json!([
                {
                    "description": "Regenerate a concrete validation check for the synthesized primary family using the current objective and evidence bundle.",
                    "target_family": primary_family,
                    "decision_value": "high"
                }
            ])),
        "analyst_quality_standard": parsed_output.get("analyst_quality_standard").cloned().unwrap_or_else(|| json!({
            "minimum_blueprints_passed": 1,
            "require_no_blueprint_failures": true,
            "require_all_handoff_checks_pass": false,
            "require_all_handoff_checks_resolved": true,
            "required_validation_checks": [],
            // Structural criteria only. Score floors are modality-specific: a
            // render/procedural handoff's blueprints never emit
            // analysis_accuracy_score, so an unconditional 80 floor auto-degraded
            // every such validation (113/123 on cycle-g-v55). Floors must be
            // declared by the analyst only for metrics its blueprints emit.
            "minimum_method_appropriateness_score": null,
            "minimum_analysis_accuracy_score": null,
            "allow_inconclusive_for_gate_review": false,
            "rationale": "Default structural handoff quality standard inserted because analyst output omitted an explicit standard. Structural criteria only: score floors apply only when the analyst declares them for metrics the attached blueprints emit."
        })),
        "handoff_checks": handoff_checks,
        "validation_code_blueprints": validation_code_blueprints,
        "self_review": self_review,
        "handoff_generation_mode": "synthesized-skeleton-requires-regeneration"
    }))
}

pub(crate) fn extract_first_json_object(text: &str) -> Option<Value> {
    let bytes = text.as_bytes();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escape = false;

    for (idx, &b) in bytes.iter().enumerate() {
        if start.is_none() {
            if b == b'{' {
                start = Some(idx);
                depth = 1;
                in_string = false;
                escape = false;
            }
            continue;
        }

        if in_string {
            if escape {
                escape = false;
                continue;
            }
            match b {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }

        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let begin = start?;
                    let candidate = &text[begin..=idx];
                    if let Ok(parsed) = serde_json::from_str::<Value>(candidate) {
                        return Some(parsed);
                    }
                    start = None;
                }
            }
            _ => {}
        }
    }

    None
}

pub(crate) fn synthesized_author_payload(
    role_plan: Option<&Value>,
    output_last_message: &str,
) -> Value {
    json!({
        "status": "completed",
        "summary": if output_last_message.trim().is_empty() {
            "fallback author synthesized a concise narrative scaffold from available role-plan context"
        } else {
            output_last_message.trim()
        },
        "deliverables": role_plan
            .and_then(|value| value.get("deliverables").cloned())
            .or_else(|| role_plan.and_then(|value| value.get("outputs").cloned()))
            .unwrap_or_else(|| json!([])),
        "next_steps": role_plan
            .and_then(|value| value.get("revision_goals").cloned())
            .unwrap_or_else(|| json!([])),
        "fallback_mode": "author-soft-complete",
    })
}

pub(crate) fn synthesized_chronicle_payload(
    role_plan: Option<&Value>,
    output_last_message: &str,
) -> Value {
    let parsed_output = extract_first_json_object(output_last_message).unwrap_or(Value::Null);
    let summary_contract = role_plan
        .and_then(|value| value.get("summary_contract"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    json!({
        "status": "completed",
        "summary": parsed_output
            .get("summary")
            .cloned()
            .unwrap_or_else(|| {
                if output_last_message.trim().is_empty() {
                    json!("fallback chronicle synthesized a concise pass summary from the role plan")
                } else {
                    json!(truncate_chars(output_last_message.trim(), 1200))
                }
            }),
        "claim_deltas": parsed_output
            .get("claim_deltas")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "open_questions": parsed_output
            .get("open_questions")
            .cloned()
            .unwrap_or_else(|| {
                summary_contract
                    .get("include")
                    .cloned()
                    .unwrap_or_else(|| json!([]))
            }),
        "recommended_actions": parsed_output
            .get("recommended_actions")
            .or_else(|| parsed_output.get("next_actions"))
            .cloned()
            .unwrap_or_else(|| json!([])),
        "hypothesis_candidates": parsed_output
            .get("hypothesis_candidates")
            .cloned()
            .unwrap_or_else(|| json!([])),
        "strategy_advice": parsed_output
            .get("strategy_advice")
            .cloned()
            .unwrap_or_else(|| json!({
                "mode": "refine",
                "reason": "chronicle fallback preserved the summary contract and any recoverable structured content"
            })),
        "fallback_mode": "chronicle-soft-complete",
    })
}

fn chronicle_result_payload_sources<'a>(payload: &'a Value) -> Vec<&'a Value> {
    ["extracted_json", "chronicle_fallback"]
        .iter()
        .filter_map(|key| payload.get(*key).filter(|value| value.is_object()))
        .collect()
}

pub(crate) fn chronicle_required_artifacts_present(paths: &AppPaths, cycle_id: &str) -> bool {
    let state = state_root(paths);
    [
        state.join(format!("{}-literature-graph.json", cycle_id)),
        state.join(format!("{}-data-graph.json", cycle_id)),
        state.join(format!("{}-trend-summary.json", cycle_id)),
    ]
    .iter()
    .all(|path| {
        fs::metadata(path)
            .map(|metadata| metadata.is_file() && metadata.len() > 2)
            .unwrap_or(false)
    })
}

fn first_nonempty_chronicle_array(payload: &Value, keys: &[&str]) -> Vec<Value> {
    for embedded in chronicle_result_payload_sources(payload) {
        for key in keys {
            if let Some(array) = embedded.get(*key).and_then(Value::as_array) {
                if !array.is_empty() {
                    return array.clone();
                }
            }
        }
    }
    for key in keys {
        if let Some(array) = payload.get(*key).and_then(Value::as_array) {
            if !array.is_empty() {
                return array.clone();
            }
        }
    }
    Vec::new()
}

fn first_nonempty_chronicle_string(payload: &Value, key: &str) -> Option<String> {
    chronicle_result_payload_sources(payload)
        .into_iter()
        .filter_map(|embedded| embedded.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
}

fn first_chronicle_object(payload: &Value, key: &str) -> Option<Value> {
    chronicle_result_payload_sources(payload)
        .into_iter()
        .find_map(|embedded| embedded.get(key).filter(|value| value.is_object()).cloned())
        .or_else(|| payload.get(key).filter(|value| value.is_object()).cloned())
}

pub(crate) fn normalize_chronicle_result_payload(payload: &mut Value) {
    let claim_deltas = first_nonempty_chronicle_array(payload, &["claim_deltas"]);
    let open_questions = first_nonempty_chronicle_array(payload, &["open_questions"]);
    let recommended_actions =
        first_nonempty_chronicle_array(payload, &["recommended_actions", "next_actions"]);
    let hypothesis_candidates = first_nonempty_chronicle_array(payload, &["hypothesis_candidates"]);
    let summary = first_nonempty_chronicle_string(payload, "summary");
    let strategy_advice = first_chronicle_object(payload, "strategy_advice");

    if let Some(obj) = payload.as_object_mut() {
        if let Some(summary) = summary {
            obj.insert("summary".to_string(), json!(summary));
        }
        obj.insert(
            "claim_deltas".to_string(),
            Value::Array(claim_deltas.clone()),
        );
        obj.insert("claim_delta_count".to_string(), json!(claim_deltas.len()));
        obj.insert(
            "open_questions".to_string(),
            Value::Array(open_questions.clone()),
        );
        obj.insert(
            "open_question_count".to_string(),
            json!(open_questions.len()),
        );
        obj.insert(
            "recommended_actions".to_string(),
            Value::Array(recommended_actions.clone()),
        );
        obj.insert(
            "recommended_action_count".to_string(),
            json!(recommended_actions.len()),
        );
        obj.insert(
            "hypothesis_candidates".to_string(),
            Value::Array(hypothesis_candidates.clone()),
        );
        obj.insert(
            "hypothesis_candidate_count".to_string(),
            json!(hypothesis_candidates.len()),
        );
        if let Some(strategy_advice) = strategy_advice {
            obj.insert("strategy_advice".to_string(), strategy_advice);
        }
    }
}

/// The analyst's own word on whether a runner may execute its handoff.
///
/// MEASURED ON cycle-a-20260919, 2026-09-28. Readiness was read from
/// `analysis_design_memo`, which the analyst's strict output schema does not
/// contain, so it was never there; the fallback below then wrote
/// `ready_for_runner: false` in the analyst's name. All 163 handoffs on the cycle
/// carried that fallback -- 90 of them from analysts whose summaries did not
/// defer, the newest saying outright that the handoff was ready -- and every
/// lab-runner waited on a handoff that could not exist. The planner, with no
/// runner work to give, kept re-asking the director the same question instead.
///
/// The schema now carries `handoff_readiness`, and this reads it. A memo the
/// model supplied still wins; a handoff that states nothing stays blocked, which
/// is what keeps an old or deferred handoff from dispatching unread (2026-09-20:
/// ten runners failed on a handoff whose CSV did not exist yet).
pub(crate) fn analyst_design_memo(parsed: &Value) -> Value {
    if let Some(memo) = parsed.get("analysis_design_memo") {
        return memo.clone();
    }
    let stated = parsed.get("handoff_readiness");
    let ready = stated
        .and_then(|readiness| readiness.get("ready_for_runner"))
        .and_then(Value::as_bool);
    let reason = stated
        .and_then(|readiness| readiness.get("reason"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let readiness = match ready {
        Some(ready) => json!({
            "ready_for_runner": ready,
            "blocking_reason": if ready { Value::Null } else { json!(reason) },
            "stated_by": "analyst",
            "reason": reason,
            "fallback_topic_or_path_token_checks_allowed": false,
        }),
        None => json!({
            "ready_for_runner": false,
            "blocking_reason": "analyst did not state handoff_readiness",
            "stated_by": "harness_default",
            "fallback_topic_or_path_token_checks_allowed": false,
        }),
    };
    json!({
        "artifact_type": "analysis-design-memo",
        "phase": "exploratory_scientific_design_before_runner_handoff",
        "design_candidates": [],
        "final_handoff_readiness": readiness,
    })
}
