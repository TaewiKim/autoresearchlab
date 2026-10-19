#![allow(unused_imports)]
use super::*;

// Stage 4: novelty refutation. For the best-valued candidates still in play, a
// literature scout searches for the IDEA ITSELF -- not the topic -- over the
// last 12-18 months, on Semantic Scholar and arXiv, starting from the prior work
// the reviewers named. A candidate whose core idea is already published is
// struck, with the citation. Striking is the only thing this stage can do: it
// never reorders the panel's ranking.

pub(crate) const NOVELTY_VERDICTS: &[&str] = &["novel", "partially_anticipated", "anticipated"];

fn query_sources(query: &Value) -> Vec<String> {
    let mut sources = selection_strings(query, "sources");
    if let Some(text) = selection_text(query.get("source")) {
        sources.push(text.to_string());
    }
    sources.into_iter().map(|source| source.to_ascii_lowercase()).collect()
}

/// Each assigned candidate's audit, checked. A valid audit names the core idea,
/// ran at least two searches between them covering Semantic Scholar and arXiv,
/// and gives a verdict; `anticipated` must cite the work that anticipates it,
/// by title and an identifier or URL. Valid audits are returned even when others
/// in the same output fail, so a partial audit is not thrown away.
pub(crate) fn validate_novelty_audit(output: &Value, assigned: &[String]) -> (ExpertStageValidation, Vec<Value>) {
    let mut out = ExpertStageValidation::default();
    let mut accepted = Vec::new();
    let audits = selection_array(output, "audits");
    if audits.is_empty() {
        out.reasons.push("audits[] is missing or empty".to_string());
        return (out, accepted);
    }
    for id in assigned {
        let key = selection_key(id);
        let Some(audit) = audits
            .iter()
            .find(|audit| selection_text(audit.get("candidate_id")).is_some_and(|found| selection_key(found) == key))
        else {
            out.reasons.push(format!("{id}: not audited"));
            continue;
        };
        let verdict = selection_text(audit.get("verdict")).map(str::to_ascii_lowercase);
        let Some(verdict) = verdict.filter(|value| NOVELTY_VERDICTS.contains(&value.as_str())) else {
            out.reasons.push(format!("{id}: verdict must be one of {}", NOVELTY_VERDICTS.join("|")));
            continue;
        };
        if selection_text(audit.get("core_idea")).is_none() {
            out.reasons.push(format!("{id}: core_idea is empty -- search for the idea itself, stated first"));
            continue;
        }
        let queries: Vec<&Value> = selection_array(audit, "queries")
            .iter()
            .filter(|query| selection_text(query.get("query")).is_some())
            .collect();
        let sources: BTreeSet<String> = queries.iter().flat_map(|query| query_sources(query)).collect();
        let covers = |name: &str| sources.iter().any(|source| source.contains(name));
        if queries.len() < 2 || !covers("semanticscholar") || !covers("arxiv") {
            out.reasons.push(format!(
                "{id}: at least two searches for the idea, between them on semanticscholar and arxiv, are required ({} recorded; sources {:?})",
                queries.len(),
                sources
            ));
            continue;
        }
        let closest: Vec<Value> = selection_array(audit, "closest_works")
            .iter()
            .filter(|work| selection_text(work.get("title")).is_some())
            .cloned()
            .collect();
        let citation = closest
            .iter()
            .find(|work| selection_text(work.get("paper_id")).is_some() || selection_text(work.get("url")).is_some())
            .cloned();
        if verdict == "anticipated" && citation.is_none() {
            out.reasons.push(format!(
                "{id}: 'anticipated' strikes a candidate, so it must cite the anticipating work by title and paper_id or url"
            ));
            continue;
        }
        if closest.is_empty() {
            out.warnings.push(format!("{id}: no closest work recorded"));
        }
        accepted.push(json!({
            "candidate_id": id,
            "verdict": verdict,
            "struck": verdict == "anticipated",
            "citation": if verdict == "anticipated" { citation.unwrap_or(Value::Null) } else { Value::Null },
            "core_idea": audit.get("core_idea").cloned().unwrap_or(Value::Null),
            "queries": queries.into_iter().cloned().collect::<Vec<_>>(),
            "closest_works": closest,
            "reviewer_prior_work_checked": audit.get("reviewer_prior_work_checked").cloned().unwrap_or_else(|| json!([])),
            "rationale": audit.get("rationale").cloned().unwrap_or(Value::Null),
        }));
    }
    out.valid = out.reasons.is_empty();
    (out, accepted)
}

/// Every audit recorded so far, by candidate key.
pub(crate) fn novelty_audits(paths: &AppPaths, cycle_id: &str) -> BTreeMap<String, Value> {
    read_json(&novelty_audit_path(paths, cycle_id))
        .ok()
        .map(|value| {
            selection_array(&value, "audits")
                .iter()
                .filter_map(|audit| {
                    selection_text(audit.get("candidate_id")).map(|id| (selection_key(id), audit.clone()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn novelty_output_dir(paths: &AppPaths, contract: &LaneContract) -> PathBuf {
    contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| lane_root(paths, &contract.cycle_id, &contract.lane_id))
}

pub(crate) fn assigned_candidate_ids(role_plan: Option<&Value>) -> Vec<String> {
    role_plan
        .and_then(|plan| plan.pointer("/planner_metadata/expert_selection_contract/candidate_ids"))
        .map(|ids| {
            ids.as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| selection_text(Some(id)).map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Merge a novelty scout's audits into `<cycle>-novelty-audit.json`. An audit
/// already recorded for a candidate is kept: a verdict, once published, is not
/// re-litigated by the next lane.
pub(crate) fn project_novelty_audit(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<Option<PathBuf>> {
    let cycle_id = &contract.cycle_id;
    let assigned = assigned_candidate_ids(role_plan);
    let output_dir = novelty_output_dir(paths, contract);
    let lane_dir = lane_root(paths, cycle_id, &contract.lane_id);
    let output = [output_dir.join(NOVELTY_AUDIT_OUTPUT_FILE), lane_dir.join(NOVELTY_AUDIT_OUTPUT_FILE)]
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| read_json(&path).ok());
    let (validation, accepted) = match output.as_ref() {
        Some(value) => validate_novelty_audit(value, &assigned),
        None => (
            ExpertStageValidation {
                reasons: vec![format!("the novelty scout wrote no {NOVELTY_AUDIT_OUTPUT_FILE}")],
                ..Default::default()
            },
            Vec::new(),
        ),
    };
    record_stage_attempt(
        paths,
        cycle_id,
        NOVELTY_REFUTATION_ACTION,
        &contract.lane_id,
        validation.valid,
        &validation.reasons,
        &validation.warnings,
    )?;
    if accepted.is_empty() {
        return Ok(None);
    }
    let mut audits = novelty_audits(paths, cycle_id);
    for mut audit in accepted {
        let key = selection_text(audit.get("candidate_id")).map(selection_key).unwrap_or_default();
        if audits.contains_key(&key) {
            continue;
        }
        audit["lane_id"] = json!(contract.lane_id);
        audit["audited_at"] = json!(now_iso());
        audits.insert(key, audit);
    }
    let struck: Vec<Value> = audits
        .values()
        .filter(|audit| audit.get("struck").and_then(Value::as_bool) == Some(true))
        .map(|audit| json!({"candidate_id": audit.get("candidate_id"), "citation": audit.get("citation")}))
        .collect();
    let path = novelty_audit_path(paths, cycle_id);
    write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "updated_at": now_iso(),
            "window_months": expert_selection_config().novelty_window_months,
            "audits": audits.into_values().collect::<Vec<_>>(),
            "struck": struck,
        }),
    )?;
    Ok(Some(path))
}
