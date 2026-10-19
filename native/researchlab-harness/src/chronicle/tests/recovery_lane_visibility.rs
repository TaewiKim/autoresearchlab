// A recovery lane could never succeed.
//
// `cached_terminal_lane_statuses` is keyed by BASE lane id and `base_lane_id`
// strips `-recovery-N`, so once `scout-02` reached a terminal state the entry
// under `scout-02` was remembered -- and `scout-02-recovery-01`, whose base id
// is also `scout-02`, hit that entry and was skipped before its run-state was
// read. The lane the cycle opened to repair a failure was invisible to the
// record of the failure.
//
// `lane_status_priority` ranks a recovery lane above the lane it replaces when
// it did at least as well. That rule was right and never ran -- and once it
// could run it showed its own flaw: the recovery bonus outranked STATUS, so a
// failed retry displaced a completed lane. Status ranks first now.
//
// MEASURED ON cycle-g-v91, 2026-09-12: scout-02 failed on
// `adaptive_literature_search_incomplete`; scout-02-recovery-01 then completed
// with 232 candidates retrieved and 70 papers admitted through the screening
// gate, `decision_ready: true`, `valid: true`. None of it counted.
// `completed_literature_scout_count` stayed at 0, chronicle sat on
// `waiting-for-literature-scout-before-kg`, no decision digest was written, and
// the LabDirector -- correctly refusing to cite evidence it had not been given
// -- reported zero open problems and zero proposed methods. Thirteen lanes
// waited on a count no succeeding lane could raise.

fn write_lane(paths: &AppPaths, cycle: &str, lane_id: &str, role: &str, status: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    fs::create_dir_all(events_root(paths)).unwrap();
    let dir = lane_root(paths, cycle, lane_id);
    fs::create_dir_all(&dir).unwrap();
    write_json(
        &dir.join("lane-contract.json"),
        &json!({
            "cycle_id": cycle,
            "lane_id": lane_id,
            "role": role,
            "runtime_class": "codex-agent",
            "mode": "read-write-scoped",
            "cwd": dir,
            "task_file": dir.join("task.md"),
            "output_artifact": null,
            "fallback_strategy": null,
        }),
    )
    .unwrap();
    write_json(
        &dir.join("run-state.json"),
        &json!({ "lane_id": lane_id, "role": role, "status": status, "runtime_class": "codex-agent" }),
    )
    .unwrap();
    write_json(
        &dir.join("final-status.json"),
        &json!({ "lane_id": lane_id, "role": role, "status": status }),
    )
    .unwrap();
    write_json(&dir.join("result.json"), &json!({ "lane_id": lane_id })).unwrap();
}

fn lane_status_for<'a>(state: &'a Value, lane_id: &str) -> Option<&'a Value> {
    state
        .get("lane_statuses")?
        .as_array()?
        .iter()
        .find(|lane| lane.get("lane_id").and_then(Value::as_str) == Some(lane_id))
}

#[test]
fn a_recovery_lane_is_seen_even_after_the_lane_it_replaces_was_cached_as_terminal() {
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-recovery-visibility";

    // Pass one: the base lane fails and is remembered as terminal.
    write_lane(&paths, cycle, "scout-02", "scout", "failed");
    aggregate_cycle(&paths, cycle).unwrap();
    let state = read_json(&state_root(&paths).join(format!("{cycle}-cycle-run-state.json"))).unwrap();
    assert!(
        lane_status_for(&state, "scout-02").is_some(),
        "the failed lane should be recorded",
    );

    // Pass two: the recovery lane completes. Its base id is `scout-02`, which is
    // exactly what the cache already holds.
    write_lane(&paths, cycle, "scout-02-recovery-01", "scout", "completed");
    aggregate_cycle(&paths, cycle).unwrap();
    let state = read_json(&state_root(&paths).join(format!("{cycle}-cycle-run-state.json"))).unwrap();

    let recovered = lane_status_for(&state, "scout-02-recovery-01");
    assert!(
        recovered.is_some(),
        "the recovery lane is still invisible: {}",
        serde_json::to_string(state.get("lane_statuses").unwrap()).unwrap(),
    );
    assert_eq!(
        recovered.unwrap().get("status").and_then(Value::as_str),
        Some("completed"),
    );
    // One slot per base: the recovery replaces the failure, it does not sit
    // beside it, or every downstream count would see the lane twice.
    assert!(
        lane_status_for(&state, "scout-02").is_none(),
        "the failed lane and its recovery are both present",
    );
}

#[test]
fn a_terminal_lane_with_no_recovery_is_still_served_from_the_cache() {
    // The short circuit exists so a finished lane is not re-read on every pass.
    // Only the sibling case changes; the ordinary one must not.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-recovery-cache-kept";

    write_lane(&paths, cycle, "analyst-01", "analyst", "completed");
    aggregate_cycle(&paths, cycle).unwrap();

    // Corrupt the lane's own files. If the cache is still consulted for the lane
    // it describes, the aggregate does not notice.
    let dir = lane_root(&paths, cycle, "analyst-01");
    fs::write(dir.join("run-state.json"), b"{ not json").unwrap();
    fs::write(dir.join("final-status.json"), b"{ not json").unwrap();

    aggregate_cycle(&paths, cycle).unwrap();
    let state = read_json(&state_root(&paths).join(format!("{cycle}-cycle-run-state.json"))).unwrap();
    assert_eq!(
        lane_status_for(&state, "analyst-01")
            .and_then(|lane| lane.get("status"))
            .and_then(Value::as_str),
        Some("completed"),
        "the terminal cache stopped serving the lane it describes",
    );
}

#[test]
fn a_failed_recovery_does_not_displace_a_completed_base_lane() {
    // Priority, not recency. A recovery that fails must not overwrite a base
    // lane that succeeded, or a retry would be able to erase a real result.
    let temp = TempDir::new().unwrap();
    let paths = build_paths(temp.path());
    let cycle = "cg-gate-recovery-loses";

    write_lane(&paths, cycle, "scout-02", "scout", "completed");
    aggregate_cycle(&paths, cycle).unwrap();
    write_lane(&paths, cycle, "scout-02-recovery-01", "scout", "failed");
    aggregate_cycle(&paths, cycle).unwrap();

    let state = read_json(&state_root(&paths).join(format!("{cycle}-cycle-run-state.json"))).unwrap();
    let surviving = state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .find(|lane| {
            lane.get("lane_id")
                .and_then(Value::as_str)
                .map(|id| id.starts_with("scout-02"))
                .unwrap_or(false)
        })
        .unwrap();
    assert_eq!(
        surviving.get("status").and_then(Value::as_str),
        Some("completed"),
        "a failed recovery erased a completed lane",
    );
}
