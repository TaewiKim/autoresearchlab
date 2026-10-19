    #[test]
    fn legacy_analyst_dispatch_gets_reasoning_runtime_but_numeric_runner_keeps_driver() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        for (role, expected_runtime, expected_mode) in [
            ("analyst", "codex-agent", "read-write-scoped"),
            ("lab-runner", "external-driver", "driver-exec"),
            ("scout", "external-driver", "driver-exec"),
        ] {
            let path = create_lane_contract(&paths, "route-cycle", &format!("{role}-01"), role,
                "external-driver", "driver-exec", "# Assigned research task").unwrap();
            let created = crate::core::support::read_json(&path).unwrap();
            assert_eq!(created["runtime_class"], expected_runtime);
            assert_eq!(created["mode"], expected_mode);
        }
    }

    #[test]
    fn lane_contract_index_tracks_created_contracts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let cycle = "cycle-index";

        let analyst = create_lane_contract(
            &paths,
            cycle,
            "analyst-01",
            "analyst",
            "codex-agent",
            "read-write-scoped",
            "# Analyst",
        )
        .expect("analyst contract");
        let scout = create_lane_contract(
            &paths,
            cycle,
            "scout-01",
            "scout",
            "codex-agent",
            "read-write-scoped",
            "# Scout",
        )
        .expect("scout contract");

        let mut expected = vec![analyst, scout];
        expected.sort();
        let contracts = all_cycle_contract_paths(&paths, cycle).expect("contract paths");
        assert_eq!(contracts, expected);

        let index = crate::core::support::read_json(&contract_index_path(&paths, cycle))
            .expect("contract index");
        let indexed = index
            .get("contracts")
            .and_then(|value| value.as_array())
            .expect("contracts array");
        assert_eq!(indexed.len(), 2);

        let queue = crate::core::support::read_json(&contract_queue_path(&paths, cycle))
            .expect("contract queue");
        let queued = queue
            .get("items")
            .and_then(|value| value.as_array())
            .expect("queue items");
        assert_eq!(queued.len(), 2);
        assert_eq!(queued[0]["status"], json!("queued"));
        assert_eq!(queued[0]["queue_kind"], json!("lane_contract_pipeline"));

        let conn =
            rusqlite::Connection::open(pipeline_queue_db_path(&paths)).expect("sqlite queue");
        let sqlite_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pipeline_queue WHERE cycle_id = ?1",
                rusqlite::params![cycle],
                |row| row.get(0),
            )
            .expect("sqlite queue count");
        assert_eq!(sqlite_count, 2);
    }

    #[test]
    fn lane_contract_queue_preserves_creation_order_ahead_of_sorted_index() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = test_paths(dir.path());
        let cycle = "cycle-queue-order";

        let scout = create_lane_contract(
            &paths,
            cycle,
            "scout-01",
            "scout",
            "codex-agent",
            "read-write-scoped",
            "# Scout",
        )
        .expect("scout contract");
        let analyst = create_lane_contract(
            &paths,
            cycle,
            "analyst-01",
            "analyst",
            "codex-agent",
            "read-write-scoped",
            "# Analyst",
        )
        .expect("analyst contract");

        let contracts = all_cycle_contract_paths(&paths, cycle).expect("contract paths");
        assert_eq!(contracts, vec![scout.clone(), analyst]);

        let queue = crate::core::support::read_json(&contract_queue_path(&paths, cycle))
            .expect("contract queue");
        let queued = queue
            .get("items")
            .and_then(|value| value.as_array())
            .expect("queue items");
        assert_eq!(queued[0]["lane_id"], json!("scout-01"));
        assert_eq!(queued[1]["lane_id"], json!("analyst-01"));
        assert_eq!(queued[0]["sequence"], json!(1));
        assert_eq!(queued[1]["sequence"], json!(2));

        let conn =
            rusqlite::Connection::open(pipeline_queue_db_path(&paths)).expect("sqlite queue");
        let first_sqlite_lane: String = conn
            .query_row(
                "SELECT lane_id FROM pipeline_queue WHERE cycle_id = ?1 ORDER BY sequence ASC LIMIT 1",
                rusqlite::params![cycle],
                |row| row.get(0),
            )
            .expect("first sqlite queued lane");
        assert_eq!(first_sqlite_lane, "scout-01");

        let role_plan_path = scout.parent().unwrap().join("role-plan.json");
        annotate_contract_queue_role_plan(
            &paths,
            cycle,
            "scout-01",
            &role_plan_path,
            "data_acquisition_followup",
            "hypothesis-gate-literature-restart",
        )
        .expect("annotate queue role plan");
        let queue = crate::core::support::read_json(&contract_queue_path(&paths, cycle))
            .expect("contract queue after annotation");
        let queued = queue
            .get("items")
            .and_then(|value| value.as_array())
            .expect("queue items");
        assert_eq!(queued[0]["status"], json!("planned"));
        assert_eq!(queued[0]["action_type"], json!("data_acquisition_followup"));
        assert_eq!(
            queued[0]["source_brief_id"],
            json!("hypothesis-gate-literature-restart")
        );
        let (status, action_type, source_brief_id): (String, String, String) = conn
            .query_row(
                "SELECT status, action_type, source_brief_id FROM pipeline_queue WHERE cycle_id = ?1 AND lane_id = 'scout-01'",
                rusqlite::params![cycle],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("sqlite queue annotation");
        assert_eq!(status, "planned");
        assert_eq!(action_type, "data_acquisition_followup");
        assert_eq!(source_brief_id, "hypothesis-gate-literature-restart");

        update_sqlite_contract_queue_status(&paths, cycle, "scout-01", "running", None)
            .expect("mark running");
        let running_status: String = conn
            .query_row(
                "SELECT status FROM pipeline_queue WHERE cycle_id = ?1 AND lane_id = 'scout-01'",
                rusqlite::params![cycle],
                |row| row.get(0),
            )
            .expect("running sqlite queue status");
        assert_eq!(running_status, "running");

        update_sqlite_contract_queue_status(&paths, cycle, "scout-01", "completed", None)
            .expect("mark completed");
        let (completed_status, completed_at): (String, Option<String>) = conn
            .query_row(
                "SELECT status, completed_at FROM pipeline_queue WHERE cycle_id = ?1 AND lane_id = 'scout-01'",
                rusqlite::params![cycle],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("completed sqlite queue status");
        assert_eq!(completed_status, "completed");
        assert!(completed_at.is_some());
    }

    #[test]
    fn process_metadata_validates_required_stage_fields() {
        let contract = test_contract("lab-runner", PathBuf::from("task.md"));
        let metadata = process_metadata(
            &contract,
            "agent_running",
            json!({
                "pid": 42,
                "started_at": "2026-05-10T00:00:00Z",
                "driver": "codex-agent-executor",
                "agent_runtime": "codex",
            }),
        )
        .expect("valid agent process metadata");
        assert_eq!(
            metadata.get("stage").and_then(|v| v.as_str()),
            Some("agent_running")
        );
        assert_eq!(
            metadata.get("cycle_id").and_then(|v| v.as_str()),
            Some("cycle-test")
        );
        assert_eq!(
            metadata.get("lane_id").and_then(|v| v.as_str()),
            Some("lab-runner-01")
        );
    }

    #[test]
    fn process_metadata_accepts_chronicle_continuation_stage() {
        // FIX-U continuation writes this stage; it must be a valid agent stage
        // (requires agent_runtime) or the continuation pass dies before spawning
        // codex with "invalid process stage".
        let contract = test_contract("chronicle", PathBuf::from("task.md"));
        let metadata = process_metadata(
            &contract,
            "chronicle_continuation_running",
            json!({
                "pid": 99,
                "started_at": "2026-06-19T00:00:00Z",
                "driver": "codex-agent-executor",
                "agent_runtime": "codex",
                "continuation_attempt": 1,
            }),
        )
        .expect("valid chronicle continuation process metadata");
        assert_eq!(
            metadata.get("stage").and_then(|v| v.as_str()),
            Some("chronicle_continuation_running")
        );
        // Missing agent_runtime must still be rejected for this stage.
        let bad = json!({
            "stage": "chronicle_continuation_running",
            "pid": 99,
            "cycle_id": "cycle-test",
            "lane_id": "chronicle-01",
            "role": "chronicle",
            "runtime_class": "codex-agent",
            "started_at": "2026-06-19T00:00:00Z"
        });
        assert!(validate_process_metadata("chronicle_continuation_running", &bad).is_err());
    }

    #[test]
    fn process_metadata_rejects_stage_specific_missing_fields() {
        let bad = json!({
            "stage": "external_driver_running",
            "pid": 42,
            "cycle_id": "cycle-test",
            "lane_id": "scout-01",
            "role": "scout",
            "runtime_class": "external-driver",
            "started_at": "2026-05-10T00:00:00Z"
        });
        assert!(validate_process_metadata("external_driver_running", &bad).is_err());
    }


    // `kill -0` succeeds for a defunct process, so a lane whose agent died while
    // its supervisor was restarting read as RUNNING for the rest of the cycle:
    // `orphaned-running` never fired and the dispatcher would not open a
    // replacement, because it could see one already open. cycle-g-v89 lost 38
    // minutes that way with the only role that could clear its gate blockers
    // permanently unavailable.
    #[cfg(not(windows))]
    #[test]
    fn a_zombie_is_not_alive() {
        use crate::runtime::process::process_is_alive;
        use std::thread::sleep;
        use std::time::Duration;

        assert!(!process_is_alive(0), "pid 0 is not a process");

        // Spawn and deliberately do not reap: the pid survives as a corpse,
        // which is exactly the state that fooled the old check.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("spawn");
        let pid = child.id();

        let mut became_zombie = false;
        for _ in 0..50 {
            let out = std::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output();
            if let Ok(out) = out {
                if String::from_utf8_lossy(&out.stdout).trim().starts_with('Z') {
                    became_zombie = true;
                    break;
                }
            }
            sleep(Duration::from_millis(20));
        }

        if became_zombie {
            assert!(
                !process_is_alive(pid),
                "a defunct pid holds a slot; it is not a running lane",
            );
        }
        let _ = child.wait();
    }
