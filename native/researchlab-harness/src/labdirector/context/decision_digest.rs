#![allow(unused_imports)]
use super::*;

/// FIX-AE: deterministic data-availability fail-closed signal for the active
/// lab-director lead. Reuses the same detectors FIX-AD uses to write the pivot
/// strategy-decision: an active lead whose dataset is being substituted by a
/// mismatched override across runner lanes, or a scout discovery that never
/// materialized. Returns the richer of the two signals when present.
pub(crate) fn lead_dataset_failclosed_signal(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    if crate::labdirector::active_lead_dataset_materialized_on_disk(paths, cycle_id) {
        return None;
    }
    let override_threshold = std::env::var("RESEARCHLAB_LEAD_OVERRIDE_MISMATCH_THRESHOLD")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(2);
    let scout_rounds = std::env::var("RESEARCHLAB_SCOUT_MATERIALIZATION_FAILCLOSED_ROUNDS")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(6);
    crate::labdirector::active_lead_dataset_override_mismatch(paths, cycle_id, override_threshold)
        .or_else(|| {
            crate::labdirector::latest_scout_discovery_without_materialization_summary(
                paths,
                cycle_id,
                scout_rounds,
            )
        })
}

/// FIX-AE: inject the fail-closed disqualification of a confirmed-unobtainable
/// lead directly into the chronicle decision digest the lab-director reads as
/// its decision basis. Prompt-level directives (role_plan) were reasoned around
/// by the director ("materialization is a validation-stage blocker, not a
/// hypothesis-stage prerequisite"); the director defers to Chronicle's digest
/// when it upholds, so placing the disqualification here turns its own
/// deference into a pivot. Additive only; never forces the gate verdict.
pub(crate) fn attach_data_availability_failclosed(
    digest: &mut Value,
    paths: &AppPaths,
    cycle_id: &str,
) {
    let Some(signal) = lead_dataset_failclosed_signal(paths, cycle_id) else {
        return;
    };
    let disqualified = signal
        .get("lead_accession")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let fact = json!({
        "status": "CONFIRMED_UNOBTAINABLE",
        "disqualified_dataset_or_accession": disqualified,
        "evidence": signal,
        "hypothesis_stage_ruling": "This dataset has repeatedly failed materialization and runners are validating on a mismatched override substitute instead of the lead's own data. Per the data-availability fail-closed rule it is DISQUALIFIED as a hypothesis-stage lead. Do NOT select, uphold, or revive any hypothesis bound to it. Materialization is normally a validation-stage concern, but a CONFIRMED-UNOBTAINABLE dataset is a hypothesis-stage disqualifier.",
        "required_action": "Replace the lead with a structurally distinct hypothesis family whose dataset is ALREADY materialized (a fetched bundle). 'uphold' of the disqualified lead is NOT a valid decision and will not unblock validation.",
    });
    if let Some(object) = digest.as_object_mut() {
        object.insert("data_availability_failclosed".to_string(), fact);
    } else {
        let original = digest.take();
        *digest = json!({
            "chronicle_digest": original,
            "data_availability_failclosed": fact,
        });
    }
}

/// FIX-INFORM: surface the system's OWN validation/promotion ranking into the lab-director's decision
/// digest as a NEUTRAL decision input. The lab-director owns the pivot/continue decision; the harness
/// never chooses or rewrites the lead. This only ensures the director can SEE which hypotheses are most
/// strongly validated (promotion readiness) when deciding whether to keep the current lead or pivot,
/// so the decision is informed rather than blind. Pairs with the fail-closed disqualification above,
/// which only FORBIDS unobtainable datasets (a constraint) without making the choice.
pub(crate) fn attach_validation_promotion_ranking(
    digest: &mut Value,
    paths: &AppPaths,
    cycle_id: &str,
) {
    let ledger_path = state_root(paths).join(format!("{cycle_id}-hypothesis-ledger.json"));
    let Ok(ledger) = read_json_cached(&ledger_path) else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut ranked: Vec<&Value> = Vec::new();
    for key in ["focus_hypotheses", "hypotheses"] {
        let Some(items) = ledger.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let id = item
                .get("hypothesis_id")
                .and_then(Value::as_str)
                .or_else(|| item.get("statement").and_then(Value::as_str))
                .unwrap_or("");
            if id.is_empty() || !seen.insert(id.to_string()) {
                continue;
            }
            let state = item
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let readiness = item
                .get("promotion_readiness_score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if state == "promoted" || state == "provisionally_promoted" || readiness >= 65.0 {
                ranked.push(item);
            }
        }
    }
    if ranked.is_empty() {
        return;
    }
    ranked.sort_by(|a, b| {
        let ra = a
            .get("promotion_readiness_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let rb = b
            .get("promotion_readiness_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
    });
    let entries: Vec<Value> = ranked
        .iter()
        .take(6)
        .map(|item| {
            json!({
                "hypothesis_id": item.get("hypothesis_id").cloned().unwrap_or(Value::Null),
                "statement": item.get("statement").and_then(Value::as_str).map(|text| truncate_string(text, 220)),
                "family_root": item.get("family_root").or_else(|| item.get("family")).cloned().unwrap_or(Value::Null),
                "promotion_readiness_score": item.get("promotion_readiness_score").cloned().unwrap_or(Value::Null),
                "state": item.get("state").cloned().unwrap_or(Value::Null),
                "promotion_blockers": item.get("promotion_blockers").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    let ranking = json!({
        "note": "Validation/promotion ranking of this cycle's hypotheses, strongest-validated first. DECISION INPUT ONLY: you (LabDirector) decide whether to CONTINUE the current lead or PIVOT to a stronger one — the harness does not choose the lead for you; it only surfaces this ranking and enforces fail-closed data-availability constraints. Weigh validated strength together with novelty and impact.",
        "ranked_by": "promotion_readiness_score",
        "hypotheses": entries,
    });
    if let Some(object) = digest.as_object_mut() {
        object.insert("validation_promotion_ranking".to_string(), ranking);
    }
}

/// INFORM (not forcing): distill, for the hypotheses already at promotion_readiness >= 65 that are
/// NOT yet promoted, (1) how many distinct families they span and (2) the most common remaining
/// promotion blocker. Surfaces the actual gap to the LabDirector as a neutral decision input so it
/// can choose to close a near-promotion blocker, broaden family diversity, or pivot — the harness
/// never chooses for it. Mirrors `attach_validation_promotion_ranking`'s governance.
pub(crate) fn attach_promotion_gap_summary(digest: &mut Value, paths: &AppPaths, cycle_id: &str) {
    let ledger_path = state_root(paths).join(format!("{cycle_id}-hypothesis-ledger.json"));
    let Ok(ledger) = read_json_cached(&ledger_path) else {
        return;
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut near: Vec<&Value> = Vec::new();
    for key in ["focus_hypotheses", "hypotheses"] {
        let Some(items) = ledger.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let id = item
                .get("hypothesis_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            if id.is_empty() || !seen.insert(id.to_string()) {
                continue;
            }
            let readiness = item
                .get("promotion_readiness_score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let state = item
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if readiness >= 65.0 && state != "promoted" {
                near.push(item);
            }
        }
    }
    if near.is_empty() {
        return;
    }
    let mut families: HashSet<String> = HashSet::new();
    let mut blocker_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for item in &near {
        if let Some(f) = item.get("family_root").and_then(Value::as_str) {
            families.insert(f.to_string());
        }
        if let Some(bs) = item.get("promotion_blockers").and_then(Value::as_array) {
            for b in bs {
                if let Some(bn) = b.as_str() {
                    *blocker_counts.entry(bn.to_string()).or_insert(0) += 1;
                }
            }
        }
    }
    near.sort_by(|a, b| {
        let ra = a
            .get("promotion_readiness_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let rb = b
            .get("promotion_readiness_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        rb.partial_cmp(&ra).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut blockers_sorted: Vec<(String, usize)> = blocker_counts.into_iter().collect();
    blockers_sorted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let dominant = blockers_sorted.first().map(|(k, _)| k.clone());
    let strongest = near.first().map(|item| {
        json!({
            "hypothesis_id": item.get("hypothesis_id").cloned().unwrap_or(Value::Null),
            "family_root": item.get("family_root").cloned().unwrap_or(Value::Null),
            "promotion_readiness_score": item.get("promotion_readiness_score").cloned().unwrap_or(Value::Null),
            "structural_novelty": item.get("structural_novelty").cloned().unwrap_or(Value::Null),
            "promotion_blockers": item.get("promotion_blockers").cloned().unwrap_or(Value::Null),
        })
    });
    let mut families_list: Vec<String> = families.iter().cloned().collect();
    families_list.sort();
    let summary = json!({
        "note": "Promotion-gap summary: hypotheses already at promotion_readiness>=65 that are NOT YET promoted, with the distinct families they span and the most common remaining blocker. DECISION INPUT ONLY: you (LabDirector) decide whether to (a) close the remaining blocker on a near-promotion hypothesis, (b) broaden family diversity, or (c) pivot — the harness surfaces this, it does not choose for you. Promotion needs claim specificity, cross-source/rival-family diversity, and role diversity together.",
        "near_promotion_count": near.len(),
        "distinct_family_count": families_list.len(),
        "families": families_list,
        "dominant_remaining_blocker": dominant,
        "blocker_frequency": blockers_sorted.iter().map(|(k, v)| json!({"blocker": k, "count": v})).collect::<Vec<_>>(),
        "strongest_near_promotion": strongest,
    });
    if let Some(object) = digest.as_object_mut() {
        object.insert("promotion_gap_summary".to_string(), summary);
    }
}

pub(crate) fn compact_chronicle_decision_digest(paths: &AppPaths, cycle_id: &str) -> Value {
    let state = state_root(paths);
    let digest_path = state.join(format!("{cycle_id}-chronicle-decision-digest.json"));
    if digest_path.exists() {
        if let Ok(content) = read_json(&digest_path) {
            let mut digest = compact_json_context(&content, 12_000);
            // Attached AFTER compaction, and on this branch as well as the
            // fallback below. The first version of this attached the corpus only
            // where the digest file is absent -- which is the branch that stops
            // running the moment the file exists. Chronicle wrote the file at
            // 07:57 on cycle-g-v91 and the very next director role plan, 08:10,
            // carried a digest with no `citable_corpus` at all.
            //
            // That is the primary-map-plus-fallback trap this repository keeps
            // walking into: a fix lands on one of two branches and the live path
            // is the other one. It is also why this runs after
            // `compact_json_context` rather than before -- the compactor is free
            // to drop fields to meet its budget, and the ids are the one thing
            // in here the trend directive cannot do without.
            attach_citable_corpus(&mut digest, paths, cycle_id);
            attach_data_availability_failclosed(&mut digest, paths, cycle_id);
            attach_validation_promotion_ranking(&mut digest, paths, cycle_id);
            attach_promotion_gap_summary(&mut digest, paths, cycle_id);
            attach_outstanding_analysis_proposals(&mut digest, paths, cycle_id);
            return digest;
        }
    }
    let literature_path = state.join(format!("{cycle_id}-literature-graph.json"));
    let data_path = state.join(format!("{cycle_id}-data-graph.json"));
    let trend_path = state.join(format!("{cycle_id}-trend-summary.json"));
    let literature = read_json(&literature_path).unwrap_or(Value::Null);
    let data = read_json(&data_path).unwrap_or(Value::Null);
    let trend = read_json(&trend_path).unwrap_or(Value::Null);
    let literature_edges = literature
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .take(8)
                    .map(compact_node_or_edge_for_director)
                    .collect(),
            )
        })
        .unwrap_or_else(|| json!([]));
    let candidate_datasets = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| {
            Value::Array(
                items
                    .iter()
                    .filter(|node| node.get("type").and_then(Value::as_str) == Some("dataset"))
                    .filter(|node| {
                        !node
                            .get("metadata")
                            .and_then(|metadata| metadata.get("forbidden_reuse"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    })
                    .take(8)
                    .map(compact_node_or_edge_for_director)
                    .collect(),
            )
        })
        .unwrap_or_else(|| json!([]));
    let mut digest = json!({
        "format": "chronicle_decision_digest_compact",
        "generated_by": "labdirector_context_guard",
        "preferred_source_path": digest_path.display().to_string(),
        "source_refs": {
            "literature_graph": literature_path.display().to_string(),
            "data_graph": data_path.display().to_string(),
            "trend_summary": trend_path.display().to_string(),
        },
        "content_policy": "Decision digest only. Do not inline or read the full KG/lane tree for LabDirector; ask Chronicle for a refreshed digest or open one named source_ref only when a specific decision requires it.",
        "artifact_counts": {
            "literature_nodes": graph_count(&literature, "nodes"),
            "literature_edges": graph_count(&literature, "edges"),
            "data_nodes": graph_count(&data, "nodes"),
            "data_edges": graph_count(&data, "edges"),
        },
        "top_literature_edges": literature_edges,
        "candidate_datasets": candidate_datasets,
        "trend_digest": compact_json_context(&trend, 3_500),
    });
    attach_citable_corpus(&mut digest, paths, cycle_id);
    attach_data_availability_failclosed(&mut digest, paths, cycle_id);
    attach_validation_promotion_ranking(&mut digest, paths, cycle_id);
    attach_promotion_gap_summary(&mut digest, paths, cycle_id);
    attach_outstanding_analysis_proposals(&mut digest, paths, cycle_id);
    digest
}

/// What the analysts have asked for and nobody has read.
///
/// MEASURED on cycle-a-20260919, 2026-09-23: 109 analyst lanes had
/// emitted 349 `analysis_lane_proposals`, and `analysis_lane_proposals` appears
/// nowhere in this repository except the output schema and the line that copies
/// it into the result. It is a write-only field. The analyst's answer to "what
/// should run next" has been a dead letter for the whole cycle.
///
/// It is not a cosmetic loss. Every analyst gate standard since 2026-09-22 has
/// required an official Diffusion Policy Push-T reproduction receipt before
/// promotion, each one proposed it as a `same_benchmark_reproduction_anchor`
/// lane, and no such lane has ever been dispatched -- while
/// chronicle_evidence_request ran 108 times, lab_director_requery 137 times and
/// adaptive_search 89 times, one of them reporting "attempt 95" on a question
/// whose answer stays "no" until that anchor exists.
///
/// This SURFACES them; it does not dispatch them. Which lane runs next is the
/// LabDirector's decision, exactly as `attach_validation_promotion_ranking`
/// leaves the lead to the director -- the harness owes it the information, not
/// the choice. Newest proposal per target_family, so a family proposed
/// seventy-five times takes one row and the director sees the breadth of what
/// is outstanding rather than the loudest repetition.
/// The analysts' outstanding proposals: the newest one per target_family,
/// newest first, and how many proposals were seen in all.
///
/// One function, two readers -- the LabDirector's digest and the decision
/// action in plan::task_graph -- so what the director is shown and what the
/// director is asked to decide cannot drift apart.
pub(crate) struct OutstandingAnalysisProposals {
    pub(crate) rows: Vec<(std::time::SystemTime, String, Value)>,
    pub(crate) proposals_seen: usize,
}

pub(crate) fn outstanding_analysis_proposals(
    paths: &AppPaths,
    cycle_id: &str,
) -> OutstandingAnalysisProposals {
    let mut newest_by_family: HashMap<String, (std::time::SystemTime, String, Value)> =
        HashMap::new();
    let mut proposals_seen = 0usize;
    let lane_dirs =
        crate::labdirector::lane_state::lane_dirs_from_contract_index(paths, cycle_id)
            .unwrap_or_default();
    for (lane_id, lane_dir) in lane_dirs {
        if !lane_id.contains("analyst") {
            continue;
        }
        let result_path = lane_dir.join("result.json");
        if !result_path.is_file() {
            continue;
        }
        let Ok(metadata) = fs::metadata(&result_path) else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        let Ok(fields) = lane_result_fields(&result_path, &["extracted_json"]) else {
            continue;
        };
        let Some(proposals) = fields
            .pointer("/extracted_json/analysis_lane_proposals")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for proposal in proposals {
            let Some(family) = proposal.get("target_family").and_then(Value::as_str) else {
                continue;
            };
            proposals_seen += 1;
            let replace = newest_by_family
                .get(family)
                .map(|(seen, _, _)| modified > *seen)
                .unwrap_or(true);
            if replace {
                newest_by_family.insert(
                    family.to_string(),
                    (modified, lane_id.clone(), proposal.clone()),
                );
            }
        }
    }
    let mut rows: Vec<(std::time::SystemTime, String, Value)> =
        newest_by_family.into_values().collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    OutstandingAnalysisProposals { rows, proposals_seen }
}

fn attach_outstanding_analysis_proposals(digest: &mut Value, paths: &AppPaths, cycle_id: &str) {
    let OutstandingAnalysisProposals { rows, proposals_seen: proposal_count } =
        outstanding_analysis_proposals(paths, cycle_id);
    if rows.is_empty() {
        return;
    }
    let families_outstanding = rows.len();
    let entries: Vec<Value> = rows
        .iter()
        .take(8)
        .map(|(_, lane_id, proposal)| {
            json!({
                "proposed_by_lane": lane_id,
                "target_family": proposal.get("target_family").cloned().unwrap_or(Value::Null),
                "description": proposal.get("description").and_then(Value::as_str)
                    .map(|text| truncate_string(text, 260)),
                "decision_value": proposal.get("decision_value").and_then(Value::as_str)
                    .map(|text| truncate_string(text, 260)),
            })
        })
        .collect();
    if let Some(object) = digest.as_object_mut() {
        object.insert(
            "outstanding_analysis_proposals".to_string(),
            json!({
                "note": "Lanes the analysts asked for and the plan has not run. DECISION INPUT ONLY: you (LabDirector) decide which of these to issue, in what order, or none -- the harness surfaces them and does not dispatch them. A proposal here has been made and not acted on; if a gate standard names one of these as a prerequisite, no amount of review-class work will satisfy that gate until it runs.",
                "families_outstanding": families_outstanding,
                "proposals_seen": proposal_count,
                "newest_per_family": entries,
            }),
        );
    }
}

/// The papers the LabDirector is allowed to cite, with their ids.
///
/// The trend survey directive requires `open_problems[]` and
/// `proposed_methods[]` where every entry carries at least one `paper_id` from
/// the admitted corpus, and says plainly that an entry which cannot be
/// attributed is an impression and belongs in `unattributed_impressions[]`
/// instead. The director is also told -- correctly -- not to read the full
/// graphs or the state tree, and to work from this digest.
///
/// The digest carried eight literature EDGES and a topic-level trend summary.
/// Neither contains a paper id. So the director was required to attribute and
/// given nothing attributable, and the only honest output available to it was
/// an empty survey with the shortfall recorded.
///
/// MEASURED ON cycle-g-v91: `open_problems: []`, `proposed_methods: []`, and
/// `survey_coverage_gaps` saying "no policy-compliant paper_id is therefore
/// available ... padding those arrays would fabricate evidence". That is the
/// contract working and the input failing it.
///
/// Both evidence tracks are carried, and separately, because they answer
/// different questions: recency shows what the field is doing now, and
/// citation-backed standing is what a novelty baseline is measured against.
/// The id the screening gate itself validated for this paper.
///
/// An admitted paper carries no top-level `paper_id`; the identity is computed
/// by `paper_identity()` in the screening driver -- doi, then pmid, openalex_id,
/// arxiv_id, url, and a title hash last -- and the accepted review is checked
/// against it before admission. So the id already exists, already agrees with
/// the gate, and is stamped at `literature_screening.review.paper_id` on every
/// admitted paper (41 of 41 on cycle-g-v91).
///
/// Reading it is the point. Recomputing that precedence here would put a second
/// implementation of one identity rule in a second language, and the whole
/// class of failure this cycle has been fixing is two copies of a rule where
/// only one runs. A director citing an id the gate does not recognise would be
/// worse than citing none.
fn citable_paper_id(paper: &Value) -> Value {
    paper
        .pointer("/literature_screening/review/paper_id")
        .cloned()
        .or_else(|| paper.get("paper_id").cloned())
        .unwrap_or(Value::Null)
}

fn attach_citable_corpus(digest: &mut Value, paths: &AppPaths, cycle_id: &str) {
    let summary_path = state_root(paths).join(format!("{cycle_id}-literature-summary.json"));
    let Ok(summary) = read_json_cached(&summary_path) else {
        return;
    };
    let mut carried = json!({});
    let mut total = 0usize;
    for track in ["recent_frontier_papers", "established_impact_papers"] {
        let papers = summary
            .get(track)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(40)
                    .map(|paper| {
                        json!({
                            "paper_id": citable_paper_id(paper),
                            "title": paper.get("title").cloned().unwrap_or(Value::Null),
                            "year": paper.get("year").cloned().unwrap_or(Value::Null),
                            "doi": paper.get("doi").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        total += papers.len();
        carried[track] = Value::Array(papers);
    }
    if let Some(object) = digest.as_object_mut() {
        carried["note"] = json!(
            "The admitted corpus, with ids. Every open_problems[] and proposed_methods[] entry must cite at least one paper_id from here; anything you cannot attribute to one belongs in unattributed_impressions[]."
        );
        carried["admitted_paper_count"] = json!(total);
        object.insert("citable_corpus".to_string(), carried);
    }
}

pub(crate) fn write_chronicle_decision_digest(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let digest_path = state_root(paths).join(format!("{cycle_id}-chronicle-decision-digest.json"));
    let mut digest = compact_chronicle_decision_digest(paths, cycle_id);
    if let Some(object) = digest.as_object_mut() {
        object.insert("generated_by".to_string(), json!("chronicle"));
        object.insert("updated_at".to_string(), json!(now_iso()));
    }
    write_json(&digest_path, &digest)?;
    Ok(digest_path)
}
