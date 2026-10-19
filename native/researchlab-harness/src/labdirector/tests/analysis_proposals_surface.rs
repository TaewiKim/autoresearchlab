// The analysts asked 349 times and nothing was listening.
//
// `analysis_lane_proposals` existed in exactly two places: the output schema
// that asks the analyst for it, and the line that copies it into the lane
// result. MEASURED on cycle-a-20260919, 2026-09-23: 109 analyst lanes
// had filled it 349 times and not one proposal had ever reached a plan, while
// every analyst gate standard on that cycle named an official Push-T
// reproduction anchor as a promotion prerequisite and no such lane was ever
// dispatched.
//
// These tests hold the two properties that make the surfacing worth having: the
// proposals reach the director's digest at all, and a family proposed many times
// takes ONE row -- the director should see the breadth of what is outstanding,
// not the loudest repetition.

fn write_analyst_lane_with_proposals(
    paths: &AppPaths,
    cycle: &str,
    lane_id: &str,
    proposals: Value,
) {
    let lane_dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane_dir).unwrap();
    write_json(
        &lane_dir.join("final-status.json"),
        &json!({"lane_id": lane_id, "status": "completed"}),
    )
    .unwrap();
    write_json(
        &lane_dir.join("result.json"),
        &json!({
            "status": "completed",
            "extracted_json": { "analysis_lane_proposals": proposals },
        }),
    )
    .unwrap();
}

#[test]
fn the_director_sees_what_the_analysts_asked_for() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(&tmp.path().join(".research-lab"));
    let cycle = "cycle-analysis-proposals";
    fs::create_dir_all(state_root(&paths)).unwrap();

    write_analyst_lane_with_proposals(
        &paths,
        cycle,
        "followup-analyst-01",
        json!([{
            "target_family": "same_benchmark_reproduction_anchor",
            "description": "Produce the official Diffusion Policy Push-T latency 0-4 reproduction receipt.",
            "decision_value": "Closes the remaining literature-reproduction prerequisite.",
        }]),
    );

    let digest = compact_chronicle_decision_digest(&paths, cycle);
    let outstanding = digest
        .get("outstanding_analysis_proposals")
        .expect("the analysts' proposals never reached the digest");
    let entries = outstanding
        .get("newest_per_family")
        .and_then(Value::as_array)
        .expect("no newest_per_family");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0].get("target_family").and_then(Value::as_str),
        Some("same_benchmark_reproduction_anchor"),
        "the prerequisite that blocked the gate must be the row the director sees",
    );
    assert_eq!(
        entries[0].get("proposed_by_lane").and_then(Value::as_str),
        Some("followup-analyst-01"),
    );
}

#[test]
fn a_family_proposed_many_times_takes_one_row() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(&tmp.path().join(".research-lab"));
    let cycle = "cycle-analysis-proposals-repeated";
    fs::create_dir_all(state_root(&paths)).unwrap();

    // The live shape: one family proposed over and over (75 times on
    // cycle-a-20260919) beside the one that actually blocks the gate.
    for index in 1..=5 {
        write_analyst_lane_with_proposals(
            &paths,
            cycle,
            &format!("followup-analyst-{index:02}"),
            json!([{
                "target_family": "coverage_adjusted_cross_architecture_evaluation",
                "description": format!("attempt {index}"),
                "decision_value": "the loud one",
            }]),
        );
    }
    write_analyst_lane_with_proposals(
        &paths,
        cycle,
        "followup-analyst-06",
        json!([{
            "target_family": "same_benchmark_reproduction_anchor",
            "description": "the prerequisite nobody ran",
            "decision_value": "closes the gate",
        }]),
    );

    let digest = compact_chronicle_decision_digest(&paths, cycle);
    let outstanding = digest.get("outstanding_analysis_proposals").expect("no proposals");
    assert_eq!(
        outstanding.get("families_outstanding").and_then(Value::as_u64),
        Some(2),
        "six proposals over two families must be two rows, not six",
    );
    assert_eq!(
        outstanding.get("proposals_seen").and_then(Value::as_u64),
        Some(6),
        "the count of what was proposed is still reported",
    );
    let families: BTreeSet<String> = outstanding
        .get("newest_per_family")
        .and_then(Value::as_array)
        .expect("no rows")
        .iter()
        .filter_map(|row| row.get("target_family").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect();
    assert!(
        families.contains("same_benchmark_reproduction_anchor"),
        "the quiet prerequisite must not be crowded out by the loud family",
    );
    assert!(families.contains("coverage_adjusted_cross_architecture_evaluation"));
}
