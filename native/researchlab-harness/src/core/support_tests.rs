    use super::*;
    use tempfile::TempDir;

    // cycle-g-v85: one torn-write lane result out of 102 aborted the whole run,
    // 106 times in a crash-restart loop, because read_json uses
    // fs::read_to_string and every lane-scanning call site propagates with `?`.
    #[test]
    fn read_lane_result_json_recovers_json_that_survived_invalid_utf8() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("result.json");
        // Valid JSON whose transcript field carries a byte no UTF-8 decoder will
        // take -- the shape a torn write actually leaves behind.
        let mut bytes = br#"{"status":"completed","stdout":"trace "#.to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice(br#" tail"}"#);
        fs::write(&path, &bytes).expect("seed torn file");

        assert!(
            String::from_utf8(bytes.clone()).is_err(),
            "the fixture must be invalid UTF-8 or it tests nothing"
        );
        assert!(read_json(&path).is_err(), "strict read still refuses it");

        let value = read_lane_result_json(&path).expect("lossy read must not fail");
        assert_eq!(value["status"], json!("completed"));
        assert!(
            !dir.path().join("result.json.unreadable").exists(),
            "a file that parsed is not an unreadable lane"
        );
    }

    #[test]
    fn read_lane_result_json_records_and_skips_a_file_that_cannot_parse() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("result.json");
        fs::write(&path, b"{\"status\": \"completed\", truncated").expect("seed broken json");

        // Null, not an error: the caller skips this lane instead of aborting the
        // cycle. Silence would be worse than the crash, so it is also recorded.
        let value = read_lane_result_json(&path).expect("must not propagate an error");
        assert!(value.is_null());

        let marker = dir.path().join("result.json.unreadable");
        assert!(marker.exists(), "an unreadable lane must leave a trace");
        let recorded = read_json(&marker).expect("marker is valid json");
        assert_eq!(recorded["unreadable_lane_result"], json!(true));
        assert!(recorded["error"].as_str().unwrap_or("").len() > 0);
    }

    #[test]
    fn read_lane_result_json_still_fails_when_the_file_is_absent() {
        let dir = TempDir::new().expect("tempdir");
        // A MISSING lane result is a different fact from a corrupt one, and the
        // callers check existence first. Swallowing this too would hide real bugs.
        assert!(read_lane_result_json(&dir.path().join("nope.json")).is_err());
    }

    fn test_paths(dir: &TempDir) -> AppPaths {
        let project_root = dir.path().join("project");
        let runtime_root = project_root.join(".research-lab");
        AppPaths {
            project_root: project_root.clone(),
            runtime_root: runtime_root.clone(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: project_root.join("drivers/analysis/python_stats.py"),
            literature_driver_script: project_root.join("drivers/literature/search.py"),
        }
    }

    fn write_bundle(path: &Path) {
        fs::create_dir_all(path).expect("bundle dir");
        fs::write(path.join("data.csv"), "x,y\n1,2\n").expect("bundle csv");
    }

    #[cfg(unix)]
    #[test]
    fn write_json_replaces_existing_readonly_file_when_parent_is_writable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("state.json");
        fs::write(&path, "{\"old\":true}").expect("seed json");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).expect("readonly");

        write_json(&path, &json!({"new": true})).expect("replace readonly file");
        let value = read_json(&path).expect("read replaced json");

        assert_eq!(value["new"], json!(true));
    }

    #[test]
    fn choose_dataset_prefers_current_cycle_nested_csv_bundle() {
        let dir = TempDir::new().expect("tempdir");
        let paths = test_paths(&dir);
        let current = paths
            .runtime_root
            .join("datasets")
            .join("cycle-b")
            .join("bundle")
            .join("csv");
        let foreign = paths
            .runtime_root
            .join("datasets")
            .join("cycle-a")
            .join("bundle")
            .join("csv");
        write_bundle(&foreign);
        write_bundle(&current);

        let (selected, source) =
            choose_dataset_bundle_path(&paths, None, Some("cycle-b")).expect("selection");

        assert_eq!(canonical_or_self(&selected), canonical_or_self(&current));
        assert_eq!(source, DatasetBundleSource::CycleScoped);
    }

    #[test]
    fn choose_dataset_honors_preferred_root_with_nested_csv_bundle() {
        let dir = TempDir::new().expect("tempdir");
        let paths = test_paths(&dir);
        let preferred_root = paths
            .runtime_root
            .join("datasets")
            .join("cycle-b")
            .join("gse289864");
        let preferred_csv = preferred_root.join("csv");
        let other_csv = paths
            .runtime_root
            .join("datasets")
            .join("cycle-b")
            .join("gse318067")
            .join("csv");
        write_bundle(&preferred_csv);
        write_bundle(&other_csv);
        fs::write(other_csv.join("extra.csv"), "x,y\n3,4\n").expect("extra csv");

        let (selected, source) =
            choose_dataset_bundle_path(&paths, Some(&preferred_root), Some("cycle-b"))
                .expect("selection");

        assert_eq!(canonical_or_self(&selected), canonical_or_self(&preferred_csv));
        assert_eq!(source, DatasetBundleSource::Override);
    }

    #[test]
    fn cycle_visible_dataset_paths_exclude_foreign_managed_bundles() {
        let dir = TempDir::new().expect("tempdir");
        let paths = test_paths(&dir);
        let current = paths
            .runtime_root
            .join("datasets")
            .join("cycle-b")
            .join("bundle")
            .join("csv");
        let foreign = paths
            .runtime_root
            .join("datasets")
            .join("cycle-a")
            .join("bundle")
            .join("csv");
        let external = paths.project_root.join("local-data").join("csv");
        write_bundle(&current);
        write_bundle(&foreign);
        write_bundle(&external);

        let visible =
            dataset_bundle_paths_visible_to_cycle(&paths, Some("cycle-b")).expect("visible");
        let visible: HashSet<PathBuf> =
            visible.into_iter().map(|p| canonical_or_self(&p)).collect();

        assert!(visible.contains(&canonical_or_self(&current)));
        assert!(visible.contains(&canonical_or_self(&external)));
        assert!(!visible.contains(&canonical_or_self(&foreign)));
    }

    // The cache that stopped run-plan reading 17 GB of lane results per pass
    // only helps if a rewritten result is still seen. A lane result is written
    // once, when the lane finishes, so (len, modified) is the validity stamp --
    // and a lane that IS rewritten must not keep answering with the old body.
    #[test]
    fn lane_result_fields_keeps_the_asked_for_keys_and_notices_a_rewrite() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("result.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "driver": "native-readonly-scan",
                "lane_id": "followup-scout-01",
                "stdout": "x".repeat(4096),
            }))
            .expect("json"),
        )
        .expect("write");

        let fields = lane_result_fields(&path, &["driver", "lane_id"]).expect("fields");
        assert_eq!(fields.get("driver").and_then(Value::as_str), Some("native-readonly-scan"));
        assert_eq!(fields.get("lane_id").and_then(Value::as_str), Some("followup-scout-01"));
        // The transcript is what the sweeps were paying for; it is not carried.
        assert!(fields.get("stdout").is_none());
        // Reading again answers from the cache, with the same body.
        let again = lane_result_fields(&path, &["driver", "lane_id"]).expect("fields");
        assert_eq!(again, fields);

        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "driver": "data-scout-browser",
                "lane_id": "followup-scout-01",
            }))
            .expect("json"),
        )
        .expect("rewrite");
        let refreshed = lane_result_fields(&path, &["driver", "lane_id"]).expect("fields");
        assert_eq!(
            refreshed.get("driver").and_then(Value::as_str),
            Some("data-scout-browser")
        );
    }

    // cycle-a-20260919, 2026-10-01 09:59Z and 11:20Z: run-plan read a
    // lane file in the instant a lane runner had truncated it, and died on an
    // anonymous "EOF while parsing a value at line 1 column 0".
    #[test]
    fn a_rewrite_is_never_seen_empty_by_a_concurrent_reader() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("result.json");
        let big = json!({"status": "prepared", "stdout": "x".repeat(400_000)});
        write_json(&path, &big).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let path = path.clone();
            let stop = stop.clone();
            std::thread::spawn(move || {
                let mut torn = 0usize;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Ok(text) = fs::read_to_string(&path) {
                        if serde_json::from_str::<Value>(&text).is_err() {
                            torn += 1;
                        }
                    }
                }
                torn
            })
        };
        for round in 0..60 {
            write_json(&path, &json!({"status": "prepared", "round": round, "stdout": "y".repeat(400_000)})).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(reader.join().unwrap(), 0, "a reader saw a half-written file");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary files left behind");
    }

    #[test]
    fn an_unparseable_file_is_named_in_the_error() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("final-status.json");
        fs::write(&path, "").unwrap();
        let message = format!("{:#}", read_json(&path).unwrap_err());
        assert!(message.contains("final-status.json"), "{message}");
        assert!(message.contains("EOF while parsing a value"), "{message}");
    }

