// A lane that wrote its own final status is not an orphan.
//
// MEASURED ON cycle-g-v91, 2026-09-13. followup-runner-54 wrote
// final-status.json `status: completed, degraded: false` at 20:03:08Z, with a
// 92 KB result.json beside it and 177 KB of external artifacts --
// validation-summary.json, summary.md, the lot -- and the orphan reconciler
// stamped run-state.json `aborted / orphaned running lane detected during
// status reconciliation` at the same second. The aggregate reads run-state, so
// a finished render counted as an abort; ten gatekeepers waiting on "a runner
// for the newest analyst handoff" were never released, and the gate sat at
// round 32 for three hours.

fn lane_with_final_status(paths: &AppPaths, cycle: &str, lane_id: &str, status: &str) -> PathBuf {
    let dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&dir).unwrap();
    write_json(
        &dir.join("final-status.json"),
        &json!({
            "lane_id": lane_id,
            "status": status,
            "completed_at": "2026-09-13T20:03:08Z",
            "degraded": false,
            "result_path": dir.join("result.json").display().to_string(),
        }),
    )
    .unwrap();
    write_json(
        &dir.join("run-state.json"),
        &json!({
            "lane_id": lane_id,
            "status": "running",
            "role": "lab-runner",
            "runtime_class": "external-driver",
            "result_path": dir.join("result.json").display().to_string(),
            "updated_at": "2026-09-13T19:37:09Z",
        }),
    )
    .unwrap();
    write_json(&dir.join("result.json"), &json!({ "blueprint_executions": [] })).unwrap();
    dir
}

#[test]
fn a_finished_lane_keeps_the_status_it_earned() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-orphan-finished";
    let dir = lane_with_final_status(&paths, cycle, "followup-runner-54", "completed");

    finalize_orphaned_running_lane(
        &paths,
        cycle,
        "followup-runner-54",
        "orphaned running lane detected during status reconciliation",
    )
    .unwrap();

    let run_state = read_json(&dir.join("run-state.json")).unwrap();
    assert_eq!(
        run_state.get("status").and_then(Value::as_str),
        Some("completed"),
        "a finished render was recorded as an abort",
    );
    // The fields the consumers read must survive the reconciliation.
    assert_eq!(run_state.get("role").and_then(Value::as_str), Some("lab-runner"));
    assert!(run_state.get("result_path").and_then(Value::as_str).is_some());
    assert_eq!(
        run_state.get("reconciled_from_final_status").and_then(Value::as_bool),
        Some(true),
        "the reconciliation left no trace of itself",
    );
    // And its own final status is untouched.
    let final_status = read_json(&dir.join("final-status.json")).unwrap();
    assert_eq!(final_status.get("status").and_then(Value::as_str), Some("completed"));
}

#[test]
fn a_lane_that_finished_as_failed_is_not_turned_into_an_abort() {
    // `failed` is a terminal status a lane earned, and several of this system's
    // handoffs are driven by it -- an abort would send the recovery elsewhere.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-orphan-failed";
    let dir = lane_with_final_status(&paths, cycle, "followup-scout-18", "failed");

    finalize_orphaned_running_lane(&paths, cycle, "followup-scout-18", "orphaned").unwrap();

    assert_eq!(
        read_json(&dir.join("run-state.json"))
            .unwrap()
            .get("status")
            .and_then(Value::as_str),
        Some("failed"),
    );
}

#[test]
fn a_lane_that_never_finished_is_still_aborted() {
    // The other half of the rule. A lane whose process vanished without writing
    // a final status IS an orphan, and reclaiming it is the whole point.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-orphan-real";
    let dir = lane_root(&paths, cycle, "followup-runner-99");
    fs::create_dir_all(&dir).unwrap();
    write_json(
        &dir.join("run-state.json"),
        &json!({ "lane_id": "followup-runner-99", "status": "running" }),
    )
    .unwrap();

    finalize_orphaned_running_lane(&paths, cycle, "followup-runner-99", "orphaned").unwrap();

    let run_state = read_json(&dir.join("run-state.json")).unwrap();
    assert_eq!(run_state.get("status").and_then(Value::as_str), Some("aborted"));
    assert_eq!(
        read_json(&dir.join("final-status.json"))
            .unwrap()
            .get("status")
            .and_then(Value::as_str),
        Some("aborted"),
    );
}
