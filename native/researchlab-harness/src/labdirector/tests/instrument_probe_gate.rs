// The boot-time capability probe must not gate the gatekeeper.
//
// cycle-g-v87 halted twice on activity_without_gate_progress -- 33 lanes and then
// 30 more completed, both windows with ZERO gate rounds. Of eleven runner lanes
// exactly one produced a result: `lab-runner-01`, carrying
// `extracted_json.instrument_inventory` and a `not_applicable` validation status.
// That is the capability probe, not a validation run.
//
// `latest_runner_post_run_review_blocker` read it as the latest completed runner
// and deferred every gatekeeper while it had no analyst_handoff_path and was not
// gate-ready. A probe is neither and cannot become either, so ten gatekeeper
// lanes sat on it until the watchdog stopped the cycle. Twice.
//
// These tests build a REAL lane and go through the real context builder. The
// first version of them asserted against a hand-written object shaped the way I
// assumed the context looked -- it has no `extracted_json` at all -- so all four
// passed while the fix did nothing.

fn write_probe_runner_lane(paths: &AppPaths, cycle: &str, lane_id: &str) {
    let lane = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane).unwrap();
    create_lane_contract(paths, cycle, lane_id, "lab-runner", "external-driver", "driver-exec", "probe fixture").unwrap();
    write_json(&lane.join("final-status.json"), &json!({"lane_id": lane_id, "status": "completed"})).unwrap();
    write_json(&lane.join("role-plan.json"), &json!({"lane_id": lane_id, "role": "lab-runner"})).unwrap();
    // Exactly what the Python driver hook leaves behind.
    write_json(
        &lane.join("result.json"),
        &json!({
            "status": "completed",
            "driver": "python-stats-driver",
            "extracted_json": {
                "instrument_inventory": { "verified_instruments": ["procedural_scene_render"] },
                "summary": "probed"
            },
            "validation_summary": { "overall_status": "not_applicable" }
        }),
    )
    .unwrap();
}

fn write_real_runner_lane(paths: &AppPaths, cycle: &str, lane_id: &str, handoff_path: &str) {
    let lane = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&lane).unwrap();
    create_lane_contract(paths, cycle, lane_id, "lab-runner", "external-driver", "driver-exec", "runner fixture").unwrap();
    write_json(&lane.join("final-status.json"), &json!({"lane_id": lane_id, "status": "completed"})).unwrap();
    write_json(&lane.join("role-plan.json"), &json!({"lane_id": lane_id, "role": "lab-runner"})).unwrap();
    write_json(
        &lane.join("result.json"),
        &json!({
            "status": "completed",
            "role_plan": { "planner_metadata": { "analyst_handoff_path": handoff_path } },
            "validation_summary": {
                "overall_status": "passed",
                "checks_failed": 0,
                "blueprints_failed": 0,
                "analyst_quality_standard": {"satisfied": true}
            }
        }),
    )
    .unwrap();
}

#[test]
fn the_context_builder_stamps_the_probe() {
    // The marker has to be lifted while the raw result is in scope: the context
    // handed to the gate carries no extracted_json, which is precisely why the
    // first attempt at this fix did nothing.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-probe";
    write_probe_runner_lane(&paths, cycle, "lab-runner-01");

    let context = latest_completed_lab_runner_context(&paths, cycle).unwrap().unwrap();
    assert_eq!(
        context.get("instrument_probe").and_then(Value::as_bool),
        Some(true),
        "context must carry the stamp, got {context}"
    );
    assert!(runner_context_is_instrument_probe(&context));
}

#[test]
fn a_probe_only_cycle_does_not_block_the_gatekeeper() {
    // v87's exact situation: the probe is the ONLY completed runner.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-probe-only";
    write_probe_runner_lane(&paths, cycle, "lab-runner-01");

    let blocker = latest_runner_post_run_review_blocker(&paths, cycle).unwrap();
    assert!(
        blocker.is_none(),
        "probe must not defer the gatekeeper, got {blocker:?}"
    );
}

#[test]
fn a_real_runner_is_still_stamped_false_and_still_judged() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-real";
    write_real_runner_lane(&paths, cycle, "followup-runner-02", "/state/handoff.json");

    let context = latest_completed_lab_runner_context(&paths, cycle).unwrap().unwrap();
    assert_eq!(
        context.get("instrument_probe").and_then(Value::as_bool),
        Some(false),
        "a validation run must not be stamped as a probe"
    );
    assert!(!runner_context_is_instrument_probe(&context));
}

#[test]
fn the_exclusion_is_narrow() {
    // An exclusion that is too wide releases the gate on every runner, which is
    // what v61 through v63 each paid a full review budget for.
    assert!(!runner_context_is_instrument_probe(&json!({})));
    assert!(!runner_context_is_instrument_probe(&json!({ "lane_id": "lab-runner-01" })));
    assert!(!runner_context_is_instrument_probe(
        &json!({ "instrument_probe": false, "overall_status": "degraded" })
    ));
    // Not a prefix match.
    assert!(!runner_context_is_instrument_probe(
        &json!({ "lane_kind": "instrument_probe_followup" })
    ));
}
