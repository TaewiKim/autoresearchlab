#[test]
fn comparator_validation_outranks_literature_restart_after_refactor() {
    let comparator = json!({
        "type": "labdirector_comparator_validation_followup",
        "priority": "high",
        "target_rubric": "hypothesis_comparison",
    });
    let literature_restart = json!({
        "brief_id": "hypothesis-gate-literature-restart",
        "type": "data_acquisition_followup",
        "priority": "high",
        "target_rubric": "literature_restart",
    });

    assert_eq!(followup_action_sort_key(&comparator, false, false), (1, 0));
    assert!(
        followup_action_sort_key(&comparator, false, false)
            < followup_action_sort_key(&literature_restart, false, false)
    );
}

#[test]
fn latest_analyst_handoff_ignores_superseded_geo_lead() {
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-current-geo-handoff";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")),
        &json!({
            "statement": "GSE228779 vaccine-associated liver injury spatial transcriptomics lead",
            "dataset_or_accession": "GSE228779"
        }),
    )
    .unwrap();

    for (lane, accession) in [
        ("followup-analyst-01", "GSE228779"),
        ("followup-analyst-99", "GSE322943"),
    ] {
        let lane_dir = lane_root(&paths, cycle, lane);
        fs::create_dir_all(&lane_dir).unwrap();
        create_lane_contract(
            &paths,
            cycle,
            lane,
            "analyst",
            "external-driver",
            "driver-exec",
            "analyst handoff fixture",
        )
        .unwrap();
        write_json(
            &lane_dir.join("run-state.json"),
            &json!({"lane_id": lane, "role": "analyst", "status": "completed"}),
        )
        .unwrap();
        write_json(
            &lane_dir.join("final-status.json"),
            &json!({"lane_id": lane, "status": "completed"}),
        )
        .unwrap();
        write_json(
            &lane_dir.join("handoff-validation-plan.json"),
            &json!({
                "status": "ready",
                "summary": format!("validate {accession}"),
                "handoff_checks": [{"check_id": format!("check_{accession}"), "hypothesis_text": accession, "exposures": ["exposure_variable"], "dataset": "materialized-bundle"}],
                "validation_code_blueprints": [{"check_id": format!("check_{accession}"), "code": "print('ok')"}]
            }),
        )
        .unwrap();
    }

    let signal = latest_analyst_handoff_signal(&paths, cycle)
        .unwrap()
        .expect("current handoff should be selected");
    assert!(
        signal
            .get("path")
            .and_then(Value::as_str)
            .unwrap()
            .contains("followup-analyst-01"),
        "stale GSE322943 handoff must not outrank current GSE228779 handoff"
    );
}

#[test]
fn a_sealed_handoff_from_a_clean_runners_interpretation_is_the_latest_plan() {
    // cycle-a-20260919, 2026-10-15: analyst-843 interpreted a runner
    // that had passed cleanly and issued a repaired executable handoff; the
    // picker filed it as a report and chose analyst-842's older handoff.
    let tmp = TempDir::new().unwrap();
    let paths = build_paths(tmp.path());
    let cycle = "cycle-interpretation-handoff";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let handoff = |execution_id: Option<&str>| {
        let mut value = json!({
            "status": "ready",
            "summary": "validate the registered comparator",
            "handoff_checks": [{"check_id": "paired", "exposures": ["policy_class"], "dataset": "sealed-panel"}],
            "validation_code_blueprints": [{"check_id": "paired", "code": "print('measure')"}]
        });
        if let Some(id) = execution_id {
            value["handoff_seal"] = json!({"execution_id": id, "status": "sealed"});
        }
        value
    };
    let resolved_interpretation = json!({
        "action_type": "runner_result_interpretation_followup",
        "planner_metadata": {"validation_results": {
            "blueprints_failed": 0,
            "analyst_quality_standard": {"satisfied": true},
            "handoff_check_resolutions": [{"check_id": "paired", "resolved": true}]
        }}
    });
    let lanes = [
        ("followup-analyst-842", json!({"action_type": "labdirector_comparator_validation_followup"}), handoff(Some("5549570b"))),
        ("followup-analyst-843", resolved_interpretation.clone(), handoff(Some("420b4053"))),
    ];
    for (lane, role_plan, plan) in lanes.iter() {
        let lane_dir = lane_root(&paths, cycle, lane);
        fs::create_dir_all(&lane_dir).unwrap();
        create_lane_contract(&paths, cycle, lane, "analyst", "external-driver", "driver-exec", "fixture").unwrap();
        write_json(&lane_dir.join("run-state.json"), &json!({"lane_id": lane, "role": "analyst", "status": "completed"})).unwrap();
        write_json(&lane_dir.join("final-status.json"), &json!({"lane_id": lane, "status": "completed"})).unwrap();
        let mut role_plan = role_plan.clone();
        role_plan["lane_id"] = json!(lane);
        role_plan["role"] = json!("analyst");
        write_json(&lane_dir.join("role-plan.json"), &role_plan).unwrap();
        write_json(&lane_dir.join("handoff-validation-plan.json"), plan).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let picked = |paths: &AppPaths| {
        latest_analyst_handoff_signal(paths, cycle)
            .unwrap()
            .and_then(|signal| signal.get("path").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default()
    };
    assert!(picked(&paths).contains("followup-analyst-843"), "{}", picked(&paths));

    // An unsealed handoff from the same kind of lane is still taken as a report.
    write_json(&lane_root(&paths, cycle, "followup-analyst-843").join("handoff-validation-plan.json"), &handoff(None)).unwrap();
    assert!(picked(&paths).contains("followup-analyst-842"), "{}", picked(&paths));
}

#[test]
fn geo_scoped_actions_skip_foreign_accession_requests() {
    let current = BTreeSet::from(["GSE228779".to_string()]);
    let stale_action = json!({
        "type": "chronicle_evidence_request_followup",
        "description": "search hidden TRM/TLS supplement files for GSE322943"
    });
    let current_action = json!({
        "type": "chronicle_evidence_request_followup",
        "description": "recover patient-aware metadata for GSE228779"
    });

    assert!(!value_mentions_current_geo(&stale_action, &current));
    assert!(value_mentions_current_geo(&current_action, &current));
}
