#![allow(unused_imports)]
use super::*;

// Stage 5: feasibility, and only now the host. For each candidate still in play,
// in the panel's order, a director lane checks the instrument inventory AND the
// SOTA cards' open-source assets -- code, checkpoints, datasets, environments,
// their licences and VRAM floors against this host -- and the local reference
// copies, and returns PASS or FAIL with the cheapest faithful setup. Never a
// score: a feasibility score would reorder the panel by convenience, which is
// the failure this pipeline exists to prevent. A pass must carry a reproduction
// anchor -- one number a SOTA card reports, reproduced here first -- and the
// harness downgrades a pass it can see is not one; it never upgrades a fail.

fn anchor_matches_card(anchor: &Value, cards: &ExpertCards) -> Result<(), String> {
    let Some(paper_id) = selection_text(anchor.get("paper_id")) else {
        return Err("reproduction_anchor names no paper_id".to_string());
    };
    let Some(card) = cards.card(paper_id) else {
        return Err(format!("reproduction_anchor paper_id '{paper_id}' is not a SOTA card"));
    };
    let reported = anchor
        .get("reported_value")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let anchor_numbers = expert_numeric_tokens(&reported);
    if anchor_numbers.is_empty() {
        return Err("reproduction_anchor.reported_value carries no number".to_string());
    }
    let card_numbers = expert_card_reported_numbers(card);
    if anchor_numbers.intersection(&card_numbers).next().is_none() {
        return Err(format!(
            "reproduction_anchor.reported_value '{reported}' is not a number the card for '{paper_id}' reports in its core_claims"
        ));
    }
    Ok(())
}

/// Each assigned candidate's assessment, with the harness's own downgrades.
pub(crate) fn validate_feasibility(
    output: &Value,
    assigned: &[String],
    cards: &ExpertCards,
    config: &ExpertSelectionConfig,
) -> (ExpertStageValidation, Vec<Value>) {
    let mut out = ExpertStageValidation::default();
    let mut accepted = Vec::new();
    let assessments = selection_array(output, "assessments");
    if assessments.is_empty() {
        out.reasons.push("assessments[] is missing or empty".to_string());
        return (out, accepted);
    }
    for id in assigned {
        let key = selection_key(id);
        let Some(assessment) = assessments
            .iter()
            .find(|item| selection_text(item.get("candidate_id")).is_some_and(|found| selection_key(found) == key))
        else {
            out.reasons.push(format!("{id}: not assessed"));
            continue;
        };
        let claimed = selection_text(assessment.get("verdict")).map(str::to_ascii_lowercase);
        let Some(claimed) = claimed.filter(|verdict| verdict == "pass" || verdict == "fail") else {
            out.reasons.push(format!("{id}: verdict must be pass or fail -- feasibility is never a score"));
            continue;
        };
        let blockers = selection_strings(assessment, "blockers");
        let setup = selection_text(assessment.get("cheapest_faithful_setup"));
        let plan = selection_strings(assessment, "experiment_plan");
        if claimed == "fail" && blockers.is_empty() {
            out.reasons.push(format!("{id}: a fail must name its blockers"));
            continue;
        }
        if claimed == "pass" && (setup.is_none() || plan.is_empty()) {
            out.reasons.push(format!("{id}: a pass must give the cheapest faithful setup and the experiment plan"));
            continue;
        }
        let mut harness_blockers = Vec::new();
        if claimed == "pass" {
            match assessment.get("reproduction_anchor").filter(|anchor| anchor.is_object()) {
                None => harness_blockers.push(
                    "no reproduction anchor: one SOTA number from a card must be reproduced on this host before the new experiment".to_string(),
                ),
                Some(anchor) => {
                    if let Err(reason) = anchor_matches_card(anchor, cards) {
                        harness_blockers.push(reason);
                    }
                }
            }
            if let Some(peak) = assessment.get("peak_vram_gb").and_then(Value::as_f64) {
                if peak > config.host_vram_gb {
                    harness_blockers.push(format!(
                        "peak_vram_gb {peak} exceeds this host's {} GB",
                        config.host_vram_gb
                    ));
                }
            }
            // An asset the setup does not use cannot block it, and a card's
            // VRAM floor is the published configuration, not this plan's.
            //
            // MEASURED ON cycle-a-20260919, 2026-09-19. The audit
            // passed shared_coverage_decay (plan peak 7.2 GB) and
            // synthetic_scaling_is_gap_filling (6.5 GB, RoboCasa excluded for
            // its licence); both were downgraded to fail — one by the card
            // floors of the canonical Diffusion Policy and ACT configurations,
            // the other by the licence of the assets its own setup dropped.
            // The owner checkpoint then offered no candidate at all.
            let reduction = selection_text(assessment.get("vram_reduction"));
            for asset in selection_array(assessment, "assets") {
                let name = selection_text(asset.get("name"))
                    .or_else(|| selection_text(asset.get("url")))
                    .unwrap_or("an asset");
                if asset.get("used") == Some(&Value::Bool(false)) {
                    continue;
                }
                if asset.get("license_ok") == Some(&Value::Bool(false)) {
                    harness_blockers.push(format!("{name}: its licence does not permit this use"));
                }
                if let Some(vram) = asset.get("min_vram_gb").and_then(Value::as_f64) {
                    if vram > config.host_vram_gb && reduction.is_none() {
                        harness_blockers.push(format!(
                            "{name}: its card reports {vram} GB VRAM against this host's {} GB, and the plan states no vram_reduction that explains its lower peak",
                            config.host_vram_gb
                        ));
                    }
                }
            }
        }
        let verdict = if claimed == "pass" && harness_blockers.is_empty() { "pass" } else { "fail" };
        if claimed == "pass" && verdict == "fail" {
            out.warnings.push(format!("{id}: pass downgraded to fail: {}", harness_blockers.join("; ")));
        }
        accepted.push(json!({
            "candidate_id": id,
            "verdict": verdict,
            "claimed_verdict": claimed,
            "blockers": blockers,
            "harness_blockers": harness_blockers,
            "cheapest_faithful_setup": assessment.get("cheapest_faithful_setup").cloned().unwrap_or(Value::Null),
            "assets": assessment.get("assets").cloned().unwrap_or_else(|| json!([])),
            "peak_vram_gb": assessment.get("peak_vram_gb").cloned().unwrap_or(Value::Null),
            "vram_reduction": assessment.get("vram_reduction").cloned().unwrap_or(Value::Null),
            "reproduction_anchor": assessment.get("reproduction_anchor").cloned().unwrap_or(Value::Null),
            "experiment_plan": plan,
            "cost": assessment.get("cost").cloned().unwrap_or(Value::Null),
        }));
    }
    out.valid = out.reasons.is_empty();
    (out, accepted)
}

pub(crate) fn feasibility_assessments(paths: &AppPaths, cycle_id: &str) -> BTreeMap<String, Value> {
    read_json(&candidate_feasibility_path(paths, cycle_id))
        .ok()
        .map(|value| {
            selection_array(&value, "assessments")
                .iter()
                .filter_map(|item| selection_text(item.get("candidate_id")).map(|id| (selection_key(id), item.clone())))
                .collect()
        })
        .unwrap_or_default()
}

/// A compact digest of the host's measured instruments, for the feasibility
/// lane only.
/// The host's GPU, measured by the harness itself, outside any lane sandbox.
///
/// MEASURED ON cycle-a-20260919, 2026-11-07. All seven slate candidates
/// failed feasibility on "PyTorch reports zero CUDA devices; nvidia-smi: GPU access
/// blocked by the operating system". The research interpreter run directly in the
/// container reports `cuda_available=True, device_count=1`; run under the lane
/// sandbox (`codex sandbox`) it reports False/0 because the sandbox's minimal
/// `/dev` hides `/dev/dxg`. The auditor could only probe from inside the sandbox,
/// so it measured the sandbox and recorded it as the host. The harness probes from
/// outside and hands the result over as the authority on the host's GPU.
pub(crate) fn harness_gpu_probe() -> Value {
    let python = env::var("RESEARCHLAB_PYTHON").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "python3".to_string());
    let script = "import json\ntry:\n import torch\n n=torch.cuda.device_count()\n print(json.dumps({'torch':torch.__version__,'cuda_available':bool(torch.cuda.is_available()),'device_count':n,'devices':[{'name':torch.cuda.get_device_name(i),'total_memory_gb':round(torch.cuda.get_device_properties(i).total_memory/2**30,1)} for i in range(n)]}))\nexcept Exception as e:\n print(json.dumps({'error':str(e)[:300]}))";
    let output = std::process::Command::new(&python).args(["-c", script]).output();
    let mut probe = match output {
        Ok(out) => serde_json::from_slice::<Value>(out.stdout.split(|b| *b == b'\n').rev().find(|line| !line.is_empty()).unwrap_or(b"{}"))
            .unwrap_or_else(|_| json!({"error": "probe printed no JSON"})),
        Err(error) => json!({"error": format!("could not start {python}: {error}")}),
    };
    if let Some(object) = probe.as_object_mut() {
        object.insert("interpreter".to_string(), json!(python));
        object.insert("measured_at".to_string(), json!(now_iso()));
        object.insert("measured_by".to_string(), json!("the harness, outside the lane sandbox"));
        object.insert(
            "authority".to_string(),
            json!("Your sandbox hides the GPU device, so a probe run from inside it reads zero CUDA devices on a host that has one. This measurement is the host's GPU. Do not fail a candidate for a GPU your own sandbox cannot see; judge GPU feasibility from this."),
        );
    }
    probe
}

pub(crate) fn instrument_inventory_for_feasibility(paths: &AppPaths, cycle_id: &str) -> Value {
    let path = state_root(paths).join(format!("{cycle_id}-instrument-inventory.json"));
    match read_json(&path) {
        Ok(value) => {
            let text = value.to_string();
            if text.len() > 24_000 {
                json!({"path": path, "excerpt": text.chars().take(24_000).collect::<String>(), "truncated": true})
            } else {
                json!({"path": path, "inventory": value})
            }
        }
        Err(_) => json!({"path": path, "missing": true}),
    }
}

pub(crate) fn project_feasibility(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
    payload: &Value,
) -> Result<Option<PathBuf>> {
    let config = expert_selection_config();
    let cycle_id = &contract.cycle_id;
    let lane_dir = lane_root(paths, cycle_id, &contract.lane_id);
    let assigned = assigned_candidate_ids(role_plan);
    let output = stage_output(payload, &lane_dir, "feasibility.json", "assessments");
    let cards = expert_cards_status(paths, cycle_id);
    let (validation, accepted) = match output.as_ref() {
        Some(value) => validate_feasibility(value, &assigned, &cards, &config),
        None => (
            ExpertStageValidation {
                reasons: vec!["the lane returned no assessments[]".to_string()],
                ..Default::default()
            },
            Vec::new(),
        ),
    };
    record_stage_attempt(
        paths,
        cycle_id,
        FEASIBILITY_AUDIT_ACTION,
        &contract.lane_id,
        validation.valid,
        &validation.reasons,
        &validation.warnings,
    )?;
    if accepted.is_empty() {
        return Ok(None);
    }
    let mut assessments = feasibility_assessments(paths, cycle_id);
    for mut assessment in accepted {
        let key = selection_text(assessment.get("candidate_id")).map(selection_key).unwrap_or_default();
        if assessments.contains_key(&key) {
            continue;
        }
        assessment["lane_id"] = json!(contract.lane_id);
        assessment["assessed_at"] = json!(now_iso());
        assessments.insert(key, assessment);
    }
    let path = candidate_feasibility_path(paths, cycle_id);
    write_json(
        &path,
        &json!({
            "cycle_id": cycle_id,
            "updated_at": now_iso(),
            "host_vram_gb": config.host_vram_gb,
            "rule": "pass/fail only; feasibility strikes candidates and never reorders the panel ranking",
            "assessments": assessments.into_values().collect::<Vec<_>>(),
        }),
    )?;
    Ok(Some(path))
}

#[cfg(test)]
mod gpu_probe_tests {
    use super::*;

    #[test]
    fn the_harness_probe_says_who_measured_and_why_it_outranks_the_sandbox() {
        let probe = harness_gpu_probe();
        // Whatever the machine has, the probe is always an object that names its
        // interpreter, its time, its measurer and its authority; a missing torch is
        // reported as an error, never as zero devices.
        assert_eq!(probe["measured_by"], json!("the harness, outside the lane sandbox"));
        assert!(probe["interpreter"].is_string());
        assert!(probe["measured_at"].is_string());
        assert!(probe["authority"].as_str().unwrap().contains("sandbox"));
        assert!(probe.get("cuda_available").is_some() || probe.get("error").is_some(), "{probe}");
    }
}
