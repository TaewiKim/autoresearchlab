#![allow(unused_imports)]
use super::*;
use tempfile::TempDir;

// The expert problem selection (labdirector::problem_selection), stage by stage
// and end to end. MEASURED ON cycle-b-20260919, 2026-09-19: with a valid
// field landscape in place, one director alone still chose a diagnostic on the
// most ready local asset (SuperDex, "per-link force dispersion predicts
// held-lift failure, AUROC > 0.60").

fn selection_test_paths(root: &Path) -> AppPaths {
    let runtime_root = root.join(".research-lab");
    AppPaths {
        project_root: root.to_path_buf(),
        runtime_root,
        data_root: root.join("datasets"),
        stats_driver_script: PathBuf::from("/dev/null"),
        literature_driver_script: PathBuf::from("/dev/null"),
    }
}

const OBJECTIVE: &str = "# Robotics simulation research cycle\n\nResearch problem: which robot-learning claims that this PC's simulators can test are still unsettled?\n\nChoose the question from the field, not from the tools. The instruments below decide whether a candidate question can be tested here; they do not pick the question.\n\n## Instruments on this host\n\nWindows 11, NVIDIA RTX 4060 (8 GB).\n- SuperDex xArm grasp simulator: copy at `.research-lab/datasets/superdex`, interpreter `D:/projects/superdex/.venv/Scripts/python.exe`.\n\n## What each role delivers\n\n- Scout: first build the field landscape.\n";

const LETTERS: [&str; 4] = ["a", "b", "c", "d"];

fn fixture_card(letter: &str) -> Value {
    json!({
        "paper_id": format!("arxiv:card-{letter}"),
        "title": format!("Card {letter}"),
        "year": 2025,
        "core_claims": [{"claim": format!("{letter} reaches 85.0% success on the benchmark"), "evidence_ref": format!("{letter}:claim1"), "numbers": ["85.0%"]}],
        "load_bearing_beliefs": [{"belief": "scale beats structure", "evidence_ref": format!("{letter}:belief1")}],
        "ablations_missing": [{"what": "an equal-budget comparison", "why_it_matters": "data and architecture are confounded"}],
        "assets": {
            "code": [{"url": format!("https://github.com/org/{letter}"), "license": "MIT"}],
            "checkpoints": [], "datasets": [], "envs": [],
            "min_vram_gb_eval": 6,
            "local_copy_path": format!("D:/projects/reference-repos/repos/{letter}")
        }
    })
}

fn fixture_cards() -> ExpertCards {
    ExpertCards::from_cards(LETTERS.iter().map(|letter| fixture_card(letter)).collect())
}

fn holder_of(belief: &str) -> &'static str {
    match belief {
        "b1" => "a",
        "b2" => "b",
        "b3" => "c",
        _ => "d",
    }
}

fn beliefs_output() -> Value {
    let belief = |id: &str, a: &str, b: &str| {
        json!({
            "belief_id": id, "subfield_id": "sf0", "statement": format!("the field holds {id}"),
            "held_by": [
                {"paper_id": format!("arxiv:card-{a}"), "evidence_ref": format!("{a}:belief1"), "claim": "stated"},
                {"paper_id": format!("arxiv:card-{b}"), "evidence_ref": format!("{b}:claim1"), "claim": "stated"}
            ],
            "rests_on": "two benchmark results at unequal budgets",
            "untested": [{"what": "an equal-budget ablation", "why_it_matters": "confounded", "paper_id": null}],
            "landscape_open_problem_ids": ["op_sf0"]
        })
    };
    json!({
        "beliefs": [belief("b1", "a", "b"), belief("b2", "b", "c"), belief("b3", "c", "d"), belief("b4", "d", "a")],
        "contradictions": [],
        "subfield_maturity": [
            {"subfield_id": "sf0", "maturity": "immature", "evidence": "the best number moves 20 points between cards", "dominant_approach": "none settled"},
            {"subfield_id": "sf1", "maturity": "maturing", "evidence": "two approaches compete", "dominant_approach": "diffusion policies"}
        ],
        "known_bottlenecks": [{
            "bottleneck_id": "bn1", "subfield_id": "sf0", "statement": "policies fail off the demonstration support",
            "named_by": [{"paper_id": "arxiv:card-a", "evidence_ref": "a:claim1"}, {"paper_id": "arxiv:card-b", "evidence_ref": "b:claim1"}],
            "approaches_tried": ["domain randomization", "system identification"],
            "why_they_stall": "they widen the support instead of detecting its edge"
        }],
        "latent_signals": [
            {"signal_id": "ls1", "subfield_id": "sf0", "observation": "every card hand-tunes the episode horizon per task", "seen_in": [{"paper_id": "arxiv:card-c", "evidence_ref": "c:claim1"}], "demand_it_implies": "a horizon the policy chooses", "why_unnamed": "treated as an evaluation detail"},
            {"signal_id": "ls2", "subfield_id": "sf1", "observation": "success is reported without the time to first contact", "seen_in": [{"paper_id": "arxiv:card-d", "evidence_ref": "d:belief1"}], "demand_it_implies": "a contact-timing metric", "why_unnamed": "no benchmark asks for it"}
        ],
        "summary": "four beliefs"
    })
}

/// Candidates cycle through the four origin strategies, so a slate of four or
/// more spreads across all of them.
fn fixture_candidate(index: usize) -> Value {
    let subfield = index % 3;
    let belief = format!("b{}", (index % 4) + 1);
    let strategy = [BELIEF_DENIAL, METHOD_LEAP, BOTTLENECK_TRANSFER, LATENT_BOTTLENECK][index % 4];
    let mut candidate = json!({
        "candidate_id": format!("cand_{index}"),
        "subfield_id": format!("sf{subfield}"),
        "problem": format!("problem {index}"),
        "hypothesis": format!("hypothesis {index}"),
        "origin_strategy": strategy,
        "target_belief_id": belief,
        "belief_statement": "stated",
        "papers_holding_belief": [format!("arxiv:card-{}", holder_of(&belief))],
        "method_leap": Value::Null,
        "bottleneck_transfer": Value::Null,
        "latent_bottleneck": Value::Null,
        "differing_prediction": "a different ordering at equal budget",
        "informative_either_way": {"if_confirmed": "the belief is qualified", "if_refuted": "the belief survives a real test"},
        "decisive_experiment": "an equal-budget comparison with matched seeds",
        "open_source_assets": [{"kind": "code", "name": "a", "url": "https://github.com/org/a", "from_card_paper_id": "arxiv:card-a"}],
        "landscape_open_problem_id": format!("op_sf{subfield}"),
        "landscape_paper_ids": [format!("doi:10.1/sf{subfield}-c0"), format!("doi:10.1/sf{subfield}-c1"), format!("arxiv:sf{subfield}-f0")]
    });
    match strategy {
        METHOD_LEAP => {
            candidate["method_leap"] = json!({
                "new_mechanism": "a contact-triggered horizon the policy ends itself",
                "departs_from": [{"paper_id": "arxiv:card-a", "approach": "fixed-horizon diffusion rollout", "what_is_dropped": "the fixed horizon"}]
            });
        }
        BOTTLENECK_TRANSFER => {
            candidate["bottleneck_transfer"] = json!({
                "bottleneck_id": "bn1",
                "concept": "stretch-reflex gain scheduling",
                "source_field": "vertebrate motor control",
                "mechanism_mapping": "reflex gain rises at the support edge, where the policy's own error grows",
                "why_untried_here": "no card models where the support ends"
            });
        }
        LATENT_BOTTLENECK => {
            candidate["latent_bottleneck"] = json!({
                "demand": "a horizon the policy chooses",
                "why_unnamed": "treated as an evaluation detail",
                "latent_signal_id": "ls1",
                "evidence": [
                    {"paper_id": "arxiv:card-c", "evidence_ref": "c:claim1", "observation": "horizon hand-tuned per task"},
                    {"paper_id": "arxiv:card-d", "evidence_ref": "d:claim1", "observation": "horizon hand-tuned per task"}
                ]
            });
        }
        _ => {}
    }
    candidate
}

fn slate_output(count: usize) -> Value {
    json!({"candidates": (0..count).map(fixture_candidate).collect::<Vec<_>>(), "summary": "a slate"})
}

fn test_open_problems() -> BTreeSet<String> {
    ["op_sf0", "op_sf1", "op_sf2"].iter().map(ToString::to_string).collect()
}

fn setup_cycle(paths: &AppPaths, cycle: &str) {
    fs::create_dir_all(state_root(paths)).unwrap();
    fs::create_dir_all(cycle_lanes_root(paths, cycle)).unwrap();
    fs::create_dir_all(plans_root(paths)).unwrap();
    write_json(&plans_root(paths).join(format!("{cycle}-cycle-plan.json")), &json!({"objective": OBJECTIVE})).unwrap();
    let mut landscape = crate::labdirector::valid_field_landscape_fixture(cycle);
    for subfield in landscape["subfields"].as_array_mut().unwrap() {
        for problem in subfield["open_problems"].as_array_mut().unwrap() {
            problem["instrument_fit"]["instruments"] = json!(["SuperDex xArm grasp simulator"]);
        }
    }
    write_json(&field_landscape_state_path(paths, cycle), &landscape).unwrap();
    write_json(
        &expert_sota_cards_path(paths, cycle),
        &json!({"cards": LETTERS.iter().map(|letter| fixture_card(letter)).collect::<Vec<_>>()}),
    )
    .unwrap();
    write_json(
        &state_root(paths).join(format!("{cycle}-instrument-inventory.json")),
        &json!({"simulators": [{"backend": "superdex", "interpreter_path": "D:/projects/superdex/.venv/Scripts/python.exe"}]}),
    )
    .unwrap();
}

fn contract_of(paths: &AppPaths, cycle: &str, lane_id: &str) -> LaneContract {
    serde_json::from_value(read_json(&lane_root(paths, cycle, lane_id).join("lane-contract.json")).unwrap()).unwrap()
}

fn role_plan_of(paths: &AppPaths, cycle: &str, lane_id: &str) -> Value {
    read_json(&lane_role_plan_path(paths, cycle, lane_id)).unwrap()
}

fn finish(paths: &AppPaths, cycle: &str, lane_id: &str) {
    write_json(&lane_root(paths, cycle, lane_id).join("final-status.json"), &json!({"status": "completed"})).unwrap();
}

fn created_ids(created: &[Value]) -> Vec<String> {
    created.iter().map(|lane| lane["lane_id"].as_str().unwrap().to_string()).collect()
}

fn opening_director(paths: &AppPaths, cycle: &str) -> LaneContract {
    LaneContract {
        cycle_id: cycle.to_string(),
        lane_id: "lab-director-01".to_string(),
        role: "lab-director".to_string(),
        runtime_class: "codex-agent".to_string(),
        mode: "read-write-scoped".to_string(),
        cwd: paths.project_root.clone(),
        task_file: lane_root(paths, cycle, "lab-director-01").join("task.md"),
        allowed_inputs: vec![],
        allowed_outputs: vec![],
        output_artifact: None,
        fallback_strategy: None,
    }
}

// --- stage 1 -----------------------------------------------------------------------

#[test]
fn a_field_belief_needs_two_cards_through_their_own_evidence_refs() {
    let config = ExpertSelectionConfig::default();
    let (validation, accepted) = validate_field_beliefs(&beliefs_output(), &fixture_cards(), &test_open_problems(), &config);
    assert!(validation.valid, "{:?}", validation.reasons);
    assert_eq!(accepted.len(), 4);

    // One support cites a reference its card does not carry: that belief is now
    // held by one card, which is a paper's claim, not the field's.
    let mut output = beliefs_output();
    output["beliefs"][0]["held_by"][1]["evidence_ref"] = json!("b:invented");
    output["beliefs"][1]["held_by"][0]["paper_id"] = json!("arxiv:not-a-card");
    let (validation, accepted) = validate_field_beliefs(&output, &fixture_cards(), &test_open_problems(), &config);
    assert_eq!(accepted.len(), 2);
    assert!(!validation.valid);
    assert!(validation.warnings.iter().any(|w| w.contains("'b:invented' is not one the card")), "{:?}", validation.warnings);
    assert!(validation.warnings.iter().any(|w| w.contains("not a SOTA card")), "{:?}", validation.warnings);
    assert!(validation.reasons[0].contains("at least 4 required"), "{:?}", validation.reasons);

    // Nothing untested named: not a target.
    let mut output = beliefs_output();
    output["beliefs"][2]["untested"] = json!([]);
    let (_, accepted) = validate_field_beliefs(&output, &fixture_cards(), &test_open_problems(), &config);
    assert_eq!(accepted.len(), 3);
}

// --- stage 2 -----------------------------------------------------------------------

#[test]
fn the_objective_loses_its_host_sections_and_host_sentences_but_keeps_the_field() {
    let blind = instrument_blind_objective(OBJECTIVE);
    assert!(blind.starts_with("# Robotics simulation research cycle"), "{blind}");
    for host in ["SuperDex", "D:/", "RTX", ".research-lab", "this PC", "instruments below", "Instruments on this host"] {
        assert!(!blind.contains(host), "'{host}' survived:\n{blind}");
    }
    assert!(blind.contains("Choose the question from the field, not from the tools."));
    assert!(blind.contains("## What each role delivers"));
    assert!(blind.contains("instrument-blind"));
}

#[test]
fn a_slate_candidate_must_deny_a_mapped_belief_and_build_on_card_assets() {
    let config = ExpertSelectionConfig::default();
    let beliefs = beliefs_output();
    let (validation, accepted) =
        validate_candidate_slate(&slate_output(9), &beliefs, &fixture_cards(), &test_open_problems(), &config);
    assert!(validation.valid, "{:?}", validation.reasons);
    assert_eq!(accepted.len(), 9);

    let mut output = slate_output(9);
    output["candidates"][0]["target_belief_id"] = json!("b_invented");
    output["candidates"][1]["open_source_assets"] = json!([{"kind": "code", "name": "x", "url": "https://github.com/else/where", "from_card_paper_id": "x"}]);
    output["candidates"][2]["decisive_experiment"] = json!("run the copy at D:/projects/superdex with the trained policy");
    output["candidates"][3]["informative_either_way"]["if_refuted"] = json!("");
    output["candidates"][4]["papers_holding_belief"] = json!(["arxiv:card-z"]);
    let (validation, accepted) =
        validate_candidate_slate(&output, &beliefs, &fixture_cards(), &test_open_problems(), &config);
    assert_eq!(accepted.len(), 4);
    assert!(!validation.valid);
    let warnings = validation.warnings.join("\n");
    for expected in ["not in the field-beliefs map", "builds on no open-source", "names a local path", "informative_either_way", "papers_holding_belief"] {
        assert!(warnings.contains(expected), "no '{expected}' in {warnings}");
    }

    // Competition across the field, not within one corner of it.
    let mut one_corner = slate_output(9);
    for candidate in one_corner["candidates"].as_array_mut().unwrap() {
        candidate["subfield_id"] = json!("sf0");
        candidate["landscape_open_problem_id"] = json!("op_sf0");
    }
    let (validation, _) = validate_candidate_slate(&one_corner, &beliefs, &fixture_cards(), &test_open_problems(), &config);
    assert!(validation.reasons.iter().any(|r| r.contains("span 1 subfield")), "{:?}", validation.reasons);
}

// OWNER DECISION 2026-10-06: a slate written under one strategy is one bet made
// eight times. Each strategy's basis is checked against the map and the cards.
#[test]
fn a_slate_spreads_across_origin_strategies_and_each_candidate_carries_its_basis() {
    let config = ExpertSelectionConfig::default();
    let map = beliefs_output();
    let cards = fixture_cards();
    let check = |output: &Value| validate_candidate_slate(output, &map, &cards, &test_open_problems(), &config);

    // Eight belief denials: valid candidates, invalid slate.
    let mut one_bet = slate_output(8);
    for (index, candidate) in one_bet["candidates"].as_array_mut().unwrap().iter_mut().enumerate() {
        candidate["origin_strategy"] = json!(BELIEF_DENIAL);
        candidate["target_belief_id"] = json!(format!("b{}", (index % 4) + 1));
        candidate["papers_holding_belief"] = json!([format!("arxiv:card-{}", holder_of(&format!("b{}", (index % 4) + 1)))]);
    }
    let (validation, accepted) = check(&one_bet);
    assert_eq!(accepted.len(), 8);
    assert!(!validation.valid);
    assert!(
        validation.reasons.iter().any(|r| r.contains("1 origin strategy") && r.contains("at least 3 required")),
        "{:?}",
        validation.reasons
    );

    // The floor never exceeds what the map supports: no bottleneck mapped, three strategies open.
    let mut thin_map = beliefs_output();
    thin_map["known_bottlenecks"] = json!([]);
    assert_eq!(strategies_available(&thin_map), vec![BELIEF_DENIAL, METHOD_LEAP, LATENT_BOTTLENECK]);
    assert_eq!(required_slate_strategies(&thin_map, &config), 3);
    let mut two_strategies = ExpertSelectionConfig::default();
    two_strategies.min_slate_strategies = 2;
    assert_eq!(required_slate_strategies(&thin_map, &two_strategies), 2);

    // Each basis, broken one way each.
    let mut output = slate_output(8);
    let candidates = output["candidates"].as_array_mut().unwrap();
    // cand_1 is a method leap: move it to a subfield the map rates mature.
    candidates[1]["subfield_id"] = json!("sf_mature");
    // cand_2 imports a concept the bottleneck has already seen.
    candidates[2]["bottleneck_transfer"]["concept"] = json!("Domain Randomization");
    // cand_3 shows its latent demand in one card only.
    candidates[3]["latent_bottleneck"]["evidence"] = json!([{"paper_id": "arxiv:card-c", "evidence_ref": "c:claim1", "observation": "x"}]);
    // cand_5 is a method leap with no card approach it departs from.
    candidates[5]["method_leap"]["departs_from"] = json!([]);
    // cand_6 names a bottleneck the map does not have.
    candidates[6]["bottleneck_transfer"]["bottleneck_id"] = json!("bn_invented");
    // cand_7 declares a strategy but leaves its basis null.
    candidates[7]["latent_bottleneck"] = Value::Null;
    let mut mature_map = beliefs_output();
    mature_map["subfield_maturity"].as_array_mut().unwrap().push(json!({"subfield_id": "sf_mature", "maturity": "mature", "evidence": "settled", "dominant_approach": "d"}));
    let (validation, accepted) = validate_candidate_slate(&output, &mature_map, &cards, &test_open_problems(), &config);
    let ids: Vec<&str> = accepted.iter().map(|c| c["candidate_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["cand_0", "cand_4"], "{:?}", validation.warnings);
    let warnings = validation.warnings.join("\n");
    for expected in [
        "rates mature",
        "already tried against 'bn1'",
        "at least 2 required",
        "departs_from names no card approach",
        "'bn_invented' is not in the field-beliefs map",
        "latent_bottleneck is null",
    ] {
        assert!(warnings.contains(expected), "no '{expected}' in {warnings}");
    }

    // An unknown strategy is refused, and a candidate written before strategies existed denies a belief.
    let mut output = slate_output(2);
    output["candidates"][0]["origin_strategy"] = json!("vibes");
    output["candidates"][1].as_object_mut().unwrap().remove("origin_strategy");
    let (validation, accepted) = check(&output);
    assert_eq!(accepted.len(), 1, "{:?}", validation.warnings);
    assert_eq!(candidate_origin_strategy(&accepted[0]), BELIEF_DENIAL);
    assert!(validation.warnings.iter().any(|w| w.contains("'vibes' is not one of")), "{:?}", validation.warnings);
}

#[test]
fn the_field_map_needs_a_named_bottleneck_and_two_latent_signals() {
    let config = ExpertSelectionConfig::default();
    let mut output = beliefs_output();
    output["known_bottlenecks"] = json!([]);
    output["latent_signals"] = json!([]);
    let (validation, accepted) = validate_field_beliefs(&output, &fixture_cards(), &test_open_problems(), &config);
    assert_eq!(accepted.len(), 4, "the beliefs themselves still pass");
    assert!(!validation.valid);
    assert!(validation.reasons.iter().any(|r| r.contains("0 known bottleneck(s)") && r.contains("at least 1 required")), "{:?}", validation.reasons);
    assert!(validation.reasons.iter().any(|r| r.contains("0 latent signal(s)") && r.contains("at least 2 required")), "{:?}", validation.reasons);

    // A bottleneck one card names is that paper's complaint; one nobody attacked is latent.
    let mut output = beliefs_output();
    output["known_bottlenecks"][0]["named_by"][1]["evidence_ref"] = json!("b:invented");
    output["latent_signals"][1]["seen_in"] = json!([{"paper_id": "arxiv:not-a-card", "evidence_ref": "x"}]);
    output["subfield_maturity"][0]["maturity"] = json!("legendary");
    let (validation, _) = validate_field_beliefs(&output, &fixture_cards(), &test_open_problems(), &config);
    assert!(!validation.valid);
    let warnings = validation.warnings.join("\n");
    for expected in ["named by 1 card(s)", "seen in no card", "maturity must be one of immature|maturing|mature"] {
        assert!(warnings.contains(expected), "no '{expected}' in {warnings}");
    }
    let (_, _, map) = validate_strategy_map(&output, &fixture_cards(), &config);
    assert_eq!(map["known_bottlenecks"].as_array().unwrap().len(), 0);
    assert_eq!(map["latent_signals"].as_array().unwrap().len(), 1);
    assert_eq!(map["subfield_maturity"].as_array().unwrap().len(), 1);

    // Both floors can be turned off.
    let mut off = ExpertSelectionConfig::default();
    off.min_known_bottlenecks = 0;
    off.min_latent_signals = 0;
    let mut bare = beliefs_output();
    bare["known_bottlenecks"] = json!([]);
    bare["latent_signals"] = json!([]);
    let (validation, _) = validate_field_beliefs(&bare, &fixture_cards(), &test_open_problems(), &off);
    assert!(validation.valid, "{:?}", validation.reasons);
}

#[test]
fn the_owner_sees_each_candidates_strategy_and_the_mix() {
    let map = beliefs_output();
    let cards = vec![
        {
            let candidate = fixture_candidate(3);
            json!({"owner_rank": 1, "candidate_id": "cand_3", "hypothesis": "h3", "origin_strategy": candidate_origin_strategy(&candidate), "strategy_basis_line": strategy_basis_line(&candidate, &map)})
        },
        {
            let candidate = fixture_candidate(2);
            json!({"owner_rank": 2, "candidate_id": "cand_2", "hypothesis": "h2", "origin_strategy": candidate_origin_strategy(&candidate), "strategy_basis_line": strategy_basis_line(&candidate, &map)})
        },
    ];
    let markdown = owner_candidates_markdown("c", &cards, &[], Path::new("sel.json"));
    assert!(markdown.contains("Strategy mix among the survivors: bottleneck_transfer x1, latent_bottleneck x1."), "{markdown}");
    assert!(markdown.contains("- **Origin strategy:** `latent_bottleneck` -- unnamed demand: a horizon the policy chooses"), "{markdown}");
    assert!(markdown.contains("- **Origin strategy:** `bottleneck_transfer` -- bottleneck `bn1` (policies fail off the demonstration support); imports stretch-reflex gain scheduling from vertebrate motor control"), "{markdown}");
}

// --- stage 3 -----------------------------------------------------------------------

fn review(candidate: &str, p: f64, impact: f64, soundness: f64) -> Value {
    json!({
        "candidate_id": candidate, "predicted_outcome_probability": p, "can_call_it": "no",
        "impact": impact, "impact_rationale": "r", "soundness": soundness, "soundness_concerns": [],
        "closest_prior_work": [{"title": "A close paper", "venue_year": "CoRL 2025", "paper_id": null, "overlap": "some"}],
        "critique": "c"
    })
}

#[test]
fn panel_value_is_impact_times_outcome_uncertainty_times_soundness_with_disagreement_reported() {
    let ids: Vec<String> = ["cand_a", "cand_b", "cand_c", "cand_d"].iter().map(ToString::to_string).collect();
    let mut submissions = BTreeMap::new();
    submissions.insert(
        "sim_to_real".to_string(),
        vec![review("cand_a", 0.5, 1.0, 1.0), review("cand_b", 0.99, 1.0, 1.0), review("cand_c", 0.1, 0.8, 0.5), review("cand_d", 0.1, 0.8, 0.5)],
    );
    submissions.insert(
        "vla_foundation_models".to_string(),
        vec![review("cand_a", 0.9, 0.5, 0.8), review("cand_b", 0.99, 1.0, 1.0), review("cand_c", 0.9, 0.8, 0.5), review("cand_d", 0.9, 0.8, 0.5)],
    );
    let panel = aggregate_expert_panel(&ids, &submissions);
    let row = |id: &str| panel_row(&panel, id).unwrap().clone();
    // a: (1 x 1 x 1 + 0.5 x 0.2 x 0.8) / 2
    assert_eq!(row("cand_a")["value"], json!(0.54));
    // b: both reviewers can call it -- high impact, but not new.
    assert_eq!(row("cand_b")["value"], json!(0.02));
    assert_eq!(row("cand_b")["predictable"], json!(true));
    // c: the reviewers disagree on the direction; reported, never averaged away.
    assert_eq!(row("cand_c")["value"], json!(0.08));
    assert_eq!(row("cand_c")["disagreement"]["probability_spread"], json!(0.8));
    assert_eq!(row("cand_c")["disagreement"]["contested"], json!(true));
    assert_eq!(row("cand_a")["per_reviewer"].as_array().unwrap().len(), 2);
    // Ranked by value; an exact tie keeps the slate's order.
    assert_eq!(panel["ranking"], json!(["cand_a", "cand_c", "cand_d", "cand_b"]));
    assert_eq!(row("cand_a")["rank"], json!(1));
    assert!((outcome_uncertainty(0.5) - 1.0).abs() < 1e-9);
    assert!(outcome_uncertainty(1.0).abs() < 1e-9);
}

#[test]
fn a_reviewer_scores_every_candidate_and_names_the_closest_prior_work() {
    let ids: Vec<String> = ["cand_a", "cand_b"].iter().map(ToString::to_string).collect();
    let good = json!({"reviewer_persona": "sim_to_real", "reviews": [review("cand_a", 0.5, 1.0, 1.0), review("cand_b", 0.4, 0.5, 0.5)], "summary": "s"});
    let (validation, reviews) = validate_panel_review(&good, &ids);
    assert!(validation.valid, "{:?}", validation.reasons);
    assert_eq!(reviews.len(), 2);

    let skipped = json!({"reviews": [review("cand_a", 0.5, 1.0, 1.0)]});
    assert!(validate_panel_review(&skipped, &ids).0.reasons.iter().any(|r| r.contains("cand_b is not scored")));

    let mut unnamed = review("cand_b", 0.4, 0.5, 0.5);
    unnamed["closest_prior_work"] = json!([{"title": "", "venue_year": null, "paper_id": null, "overlap": ""}]);
    let mut out_of_range = review("cand_a", 1.5, 0.5, 0.5);
    out_of_range["critique"] = json!("c");
    let (validation, _) = validate_panel_review(&json!({"reviews": [out_of_range, unnamed]}), &ids);
    assert!(!validation.valid);
    let reasons = validation.reasons.join("\n");
    assert!(reasons.contains("predicted_outcome_probability must be in [0, 1]"), "{reasons}");
    assert!(reasons.contains("closest_prior_work must name"), "{reasons}");
}

// --- stage 4 -----------------------------------------------------------------------

fn audit(candidate: &str, verdict: &str, citation: bool) -> Value {
    json!({
        "candidate_id": candidate,
        "core_idea": "the specific claim",
        "queries": [
            {"query": "the idea", "sources": ["semanticscholar"]},
            {"query": "the idea, reworded", "sources": ["arxiv"]}
        ],
        "closest_works": if citation {
            json!([{"title": "Already Did It", "paper_id": "arxiv:2507.00001", "url": null, "year": 2025, "overlap": "all of it"}])
        } else {
            json!([])
        },
        "verdict": verdict,
        "rationale": "r"
    })
}

#[test]
fn novelty_strikes_an_anticipated_candidate_with_its_citation_and_the_next_enters_play() {
    let assigned: Vec<String> = ["cand_1", "cand_2", "cand_3"].iter().map(ToString::to_string).collect();
    let (validation, accepted) = validate_novelty_audit(
        &json!({"audits": [audit("cand_1", "novel", false), audit("cand_2", "anticipated", true), audit("cand_3", "partially_anticipated", true)]}),
        &assigned,
    );
    assert!(validation.valid, "{:?}", validation.reasons);
    assert_eq!(accepted[1]["struck"], json!(true));
    assert_eq!(accepted[1]["citation"]["paper_id"], json!("arxiv:2507.00001"));
    assert_eq!(accepted[2]["struck"], json!(false));

    // A strike must cite; a search must cover Semantic Scholar and arXiv.
    let mut one_source = audit("cand_3", "novel", false);
    one_source["queries"] = json!([{"query": "q", "sources": ["semanticscholar"]}, {"query": "q2", "sources": ["semanticscholar"]}]);
    let (validation, accepted) = validate_novelty_audit(
        &json!({"audits": [audit("cand_1", "novel", false), audit("cand_2", "anticipated", false), one_source]}),
        &assigned,
    );
    assert!(!validation.valid);
    assert_eq!(accepted.len(), 1, "valid audits in a partly failed output are kept");
    let reasons = validation.reasons.join("\n");
    assert!(reasons.contains("cand_2: 'anticipated' strikes a candidate, so it must cite"), "{reasons}");
    assert!(reasons.contains("cand_3: at least two searches"), "{reasons}");

    // In the funnel the struck candidate leaves play and the next one enters.
    let ranking: Vec<String> = (1..=5).map(|index| format!("cand_{index}")).collect();
    let mut audits = BTreeMap::new();
    for item in [audit("cand_1", "novel", false), audit("cand_3", "novel", false)] {
        audits.insert(selection_key(item["candidate_id"].as_str().unwrap()), item);
    }
    let mut struck = audit("cand_2", "anticipated", true);
    struck["struck"] = json!(true);
    audits.insert("cand_2".to_string(), struck);
    let funnel = expert_funnel(&ranking, &audits, &BTreeMap::new(), 3);
    assert_eq!(funnel.in_play, vec!["cand_1", "cand_3", "cand_4"]);
    assert_eq!(funnel.novelty_pending, vec!["cand_4"]);
    assert_eq!(funnel.feasibility_pending, vec!["cand_1", "cand_3"]);
    assert_eq!(funnel.eliminated[0].0, "cand_2");
}

// --- stage 5 -----------------------------------------------------------------------

fn assessment(candidate: &str, verdict: &str) -> Value {
    json!({
        "candidate_id": candidate, "verdict": verdict,
        "blockers": if verdict == "fail" { json!(["needs 24 GB"]) } else { json!([]) },
        "cheapest_faithful_setup": "the released checkpoint, evaluation only",
        "assets": [{"kind": "code", "name": "a", "url": "https://github.com/org/a", "local_path": null, "license": "MIT", "license_ok": true, "min_vram_gb": 6, "verified_locally": true}],
        "peak_vram_gb": 6.5,
        "reproduction_anchor": {"paper_id": "arxiv:card-a", "claim": "85% success", "metric": "success rate", "reported_value": "85%", "evidence_ref": "a:claim1", "setup": "eval split", "expected_cost": "1 GPU-hour"},
        "experiment_plan": ["reproduce the anchor", "run the decisive comparison"],
        "cost": {"wall_clock_hours": 3, "gpu_hours": 2, "notes": "n"}
    })
}

// MEASURED ON cycle-a-20260919, 2026-09-19. The audit passed
// shared_coverage_decay (its plan peaks at 7.2 GB on an 8 GB host) and
// synthetic_scaling_is_gap_filling (6.5 GB, RoboCasa dropped for its licence).
// Both were downgraded: the first by the card floors of the canonical Diffusion
// Policy and ACT configurations it does not run, the second by the licence of
// the assets its own setup drops. The owner checkpoint then had no candidate.
#[test]
fn a_dropped_asset_and_a_card_floor_the_plan_does_not_run_do_not_strike_a_pass() {
    let config = ExpertSelectionConfig::default();
    let cards = fixture_cards();
    let assigned: Vec<String> = ["c1", "c2", "c3", "c4"].iter().map(ToString::to_string).collect();

    // The setup drops a licence-incompatible dataset and says so.
    let mut dropped = assessment("c1", "pass");
    dropped["assets"] = json!([
        {"kind": "code", "name": "a", "url": null, "local_path": null, "license": "MIT", "license_ok": true, "min_vram_gb": 6, "verified_locally": true, "used": true},
        {"kind": "dataset", "name": "restricted", "url": null, "local_path": null, "license": "CC-NC", "license_ok": false, "min_vram_gb": null, "verified_locally": false, "used": false},
    ]);
    // The canonical configuration's floor is above the host; the plan is smaller.
    let mut reduced = assessment("c2", "pass");
    reduced["assets"] = json!([
        {"kind": "code", "name": "canonical", "url": null, "local_path": null, "license": "MIT", "license_ok": true, "min_vram_gb": 11, "verified_locally": false, "used": true},
    ]);
    reduced["peak_vram_gb"] = json!(7.2);
    reduced["vram_reduction"] = json!("ResNet18 at 96x96 with batch 32, trained sequentially");
    // The same floor with no stated reduction stays a fail.
    let mut unexplained = reduced.clone();
    unexplained["candidate_id"] = json!("c3");
    unexplained["vram_reduction"] = Value::Null;
    // A licence the setup still relies on strikes as before.
    let mut still_used = assessment("c4", "pass");
    still_used["assets"] = json!([
        {"kind": "dataset", "name": "restricted", "url": null, "local_path": null, "license": "CC-NC", "license_ok": false, "min_vram_gb": null, "verified_locally": false, "used": true},
    ]);

    let (validation, accepted) = validate_feasibility(
        &json!({"assessments": [dropped, reduced, unexplained, still_used]}),
        &assigned,
        &cards,
        &config,
    );
    assert!(validation.valid, "{:?}", validation.reasons);
    let verdicts: Vec<&str> = accepted.iter().map(|item| item["verdict"].as_str().unwrap()).collect();
    assert_eq!(verdicts, vec!["pass", "pass", "fail", "fail"]);
    assert!(accepted[2]["harness_blockers"].to_string().contains("vram_reduction"));
    assert!(accepted[3]["harness_blockers"].to_string().contains("licence"));
    assert_eq!(accepted[1]["vram_reduction"], json!("ResNet18 at 96x96 with batch 32, trained sequentially"));
}

#[test]
fn feasibility_is_pass_or_fail_the_harness_only_downgrades_and_it_never_reorders() {
    let config = ExpertSelectionConfig::default();
    let cards = fixture_cards();
    let assigned: Vec<String> = ["c1", "c2", "c3", "c4", "c5"].iter().map(ToString::to_string).collect();
    let mut no_anchor = assessment("c2", "pass");
    no_anchor["reproduction_anchor"] = Value::Null;
    let mut invented_number = assessment("c3", "pass");
    invented_number["reproduction_anchor"]["reported_value"] = json!("97.3%");
    let mut too_big = assessment("c4", "pass");
    too_big["peak_vram_gb"] = json!(22.0);
    let (validation, accepted) = validate_feasibility(
        &json!({"assessments": [assessment("c1", "pass"), no_anchor, invented_number, too_big, assessment("c5", "fail")]}),
        &assigned,
        &cards,
        &config,
    );
    assert!(validation.valid, "{:?}", validation.reasons);
    let verdicts: Vec<&str> = accepted.iter().map(|item| item["verdict"].as_str().unwrap()).collect();
    assert_eq!(verdicts, vec!["pass", "fail", "fail", "fail", "fail"]);
    let blockers = |index: usize| accepted[index]["harness_blockers"].to_string();
    assert!(blockers(1).contains("no reproduction anchor"));
    assert!(blockers(2).contains("not a number the card"));
    assert!(blockers(3).contains("exceeds this host"));
    assert_eq!(accepted[4]["claimed_verdict"], json!("fail"));

    // The funnel keeps the panel's order: a failed candidate leaves, the rest
    // keep their places, and nothing that passed moves ahead of anything.
    let ranking: Vec<String> = ["r1", "r2", "r3", "r4", "r5"].iter().map(ToString::to_string).collect();
    let audits: BTreeMap<String, Value> = ranking
        .iter()
        .map(|id| (id.clone(), json!({"candidate_id": id, "verdict": "novel", "struck": false})))
        .collect();
    let mut feasibility = BTreeMap::new();
    feasibility.insert("r1".to_string(), json!({"candidate_id": "r1", "verdict": "fail"}));
    for id in ["r4", "r3", "r2"] {
        feasibility.insert(id.to_string(), json!({"candidate_id": id, "verdict": "pass", "peak_vram_gb": 1.0}));
    }
    let funnel = expert_funnel(&ranking, &audits, &feasibility, 3);
    assert_eq!(funnel.eligible, vec!["r2", "r3", "r4"]);
    assert_eq!(funnel.eliminated, vec![("r1".to_string(), "feasibility: fail".to_string())]);
}

// --- schemas and prompts -----------------------------------------------------------

fn assert_strict(schema: &Value, path: &str) {
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        let mut keys: Vec<&String> = properties.keys().collect();
        keys.sort();
        let mut required: Vec<String> = schema["required"]
            .as_array()
            .unwrap_or_else(|| panic!("{path}: no required"))
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect();
        required.sort();
        assert_eq!(required.iter().collect::<Vec<_>>(), keys, "{path}: required must list every property");
        assert_eq!(schema["additionalProperties"], json!(false), "{path}: additionalProperties must be false");
        for (key, child) in properties {
            assert_strict(child, &format!("{path}.{key}"));
        }
    }
    if let Some(items) = schema.get("items") {
        assert_strict(items, &format!("{path}[]"));
    }
}

#[test]
fn every_stage_schema_is_strict_and_its_output_contract_names_every_field() {
    for action in [FIELD_BELIEFS_ACTION, CANDIDATE_SLATE_ACTION, EXPERT_PANEL_ACTION, FEASIBILITY_AUDIT_ACTION] {
        let schema = expert_selection_output_schema(action).expect(action);
        assert_strict(&schema, action);
        let contract = expert_selection_output_contract(Some(&json!({"action_type": action}))).unwrap();
        fn names(schema: &Value, out: &mut Vec<String>) {
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (key, child) in properties {
                    out.push(key.clone());
                    names(child, out);
                }
            }
            if let Some(items) = schema.get("items") {
                names(items, out);
            }
        }
        let mut fields = Vec::new();
        names(&schema, &mut fields);
        for field in fields {
            assert!(contract.contains(&format!("\"{field}\"")), "{action}: contract omits {field}");
        }
    }
    // The novelty auditor is a literature scout and writes a file instead.
    assert!(expert_selection_output_schema(NOVELTY_REFUTATION_ACTION).is_none());
    assert!(expert_selection_output_contract(Some(&json!({"action_type": "lab_director_requery_followup"}))).is_none());
}

// --- the gate ----------------------------------------------------------------------

fn engage_with_selection(paths: &AppPaths, cycle: &str, selection: Option<Value>) {
    fs::create_dir_all(state_root(paths)).unwrap();
    write_json(
        &candidate_slate_path(paths, cycle),
        &json!({"candidates": [fixture_candidate(0), fixture_candidate(1), fixture_candidate(2)]}),
    )
    .unwrap();
    write_json(
        &owner_candidates_path(paths, cycle),
        &json!({"candidates": [{"candidate_id": "cand_0"}, {"candidate_id": "cand_1"}]}),
    )
    .unwrap();
    let mut state = json!({"engaged_at": now_iso()});
    if let Some(selection) = selection {
        state["owner_selection"] = selection;
    }
    write_json(&expert_selection_state_path(paths, cycle), &state).unwrap();
}

#[test]
fn once_engaged_a_lead_comes_from_the_slate_and_first_from_the_owners_pick() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-gate";
    fs::create_dir_all(state_root(&paths)).unwrap();
    let lead = |id: Option<&str>, problem: &str| {
        json!({"statement": "s", "slate_candidate_id": id, "landscape_open_problem_id": problem})
    };
    // Not engaged (a cycle that had its lead before the pipeline): no change.
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &lead(None, "op_sf0"), true).is_empty());

    engage_with_selection(&paths, cycle, None);
    let pending = lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("cand_0"), "op_sf0"), true);
    assert!(pending[0].starts_with("expert_selection_pending"), "{pending:?}");

    engage_with_selection(&paths, cycle, Some(json!({"candidate_id": "cand_0", "decision": "candidate_picked"})));
    let missing = lead_expert_selection_rejection_reasons(&paths, cycle, &lead(None, "op_sf0"), true);
    assert!(missing[0].starts_with("slate_candidate_id is missing"), "{missing:?}");
    let other = lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("cand_1"), "op_sf1"), true);
    assert!(other[0].contains("is not the owner's pick 'cand_0'"), "{other:?}");
    let wrong_problem = lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("cand_0"), "op_sf2"), true);
    assert!(wrong_problem[0].contains("landscape_open_problem_id must be 'op_sf0'"), "{wrong_problem:?}");
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("CAND_0"), "op_sf0"), true).is_empty());
    // A later replacement may be another vetted candidate, and nothing else.
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("cand_1"), "op_sf1"), false).is_empty());
    let unvetted = lead_expert_selection_rejection_reasons(&paths, cycle, &lead(Some("cand_2"), "op_sf2"), false);
    assert!(unvetted[0].contains("not an owner-vetted candidate"), "{unvetted:?}");

    // The owner may release the requirement.
    engage_with_selection(&paths, cycle, Some(json!({"candidate_id": "release", "decision": "slate_released"})));
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &lead(None, "op_sf0"), true).is_empty());
    // A selection written before the decision was named still reads correctly.
    engage_with_selection(&paths, cycle, Some(json!({"candidate_id": "release", "released": true})));
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &lead(None, "op_sf0"), true).is_empty());

    // MEASURED ON cycle-a-20260919, 2026-09-20. A pick plus a bare
    // `released: false` read to the LabDirector as an owner approval still to
    // come, and it deferred every execution action for hours.
    // A legacy selection: the decision is read from its own fields.
    engage_with_selection(&paths, cycle, Some(json!({"candidate_id": "cand_0", "released": false})));
    assert_eq!(OwnerDecision::of_selection(recorded_owner_selection(&paths, cycle).as_ref()), OwnerDecision::CandidatePicked);
    let context = expert_selection_director_context(&paths, cycle);
    let owner = &context["owner_selection"];
    assert_eq!(owner["candidate_id"], json!("cand_0"));
    assert!(owner.get("released").is_none(), "a bare released flag reads as a pending approval: {owner}");
    assert_eq!(owner["decision"], json!("candidate_picked"));
    assert!(owner["decision_means"].as_str().unwrap().contains("nothing further is awaited from the owner"));
    engage_with_selection(&paths, cycle, Some(json!({"candidate_id": "release", "decision": "slate_released"})));
    let released = expert_selection_director_context(&paths, cycle);
    assert_eq!(released["owner_selection"]["decision"], json!("slate_released"));
    assert!(OwnerDecision::of_selection(None) == OwnerDecision::Pending);
}

// --- the owner checkpoint ------------------------------------------------------------

fn publish_through_feasibility(paths: &AppPaths, cycle: &str) {
    setup_cycle(paths, cycle);
    write_json(&expert_selection_state_path(paths, cycle), &json!({"engaged_at": now_iso()})).unwrap();
    write_json(&field_beliefs_path(paths, cycle), &beliefs_output()).unwrap();
    write_json(&candidate_slate_path(paths, cycle), &slate_output(8)).unwrap();
    let ids: Vec<String> = (0..8).map(|index| format!("cand_{index}")).collect();
    let mut submissions = BTreeMap::new();
    submissions.insert(
        "sim_to_real".to_string(),
        ids.iter().enumerate().map(|(index, id)| review(id, 0.5, 1.0 - index as f64 * 0.1, 1.0)).collect(),
    );
    write_json(&expert_panel_path(paths, cycle), &aggregate_expert_panel(&ids, &submissions)).unwrap();
    write_json(
        &novelty_audit_path(paths, cycle),
        &json!({"audits": ids.iter().take(4).map(|id| {
            let mut item = audit(id, if id == "cand_1" { "anticipated" } else { "novel" }, true);
            item["struck"] = json!(id == "cand_1");
            item
        }).collect::<Vec<_>>()}),
    )
    .unwrap();
    write_json(
        &candidate_feasibility_path(paths, cycle),
        &json!({"assessments": [assessment("cand_0", "pass"), assessment("cand_2", "fail"), assessment("cand_3", "pass")]}),
    )
    .unwrap();
}

#[test]
fn the_owner_checkpoint_pauses_lead_selection_until_the_owner_picks_a_survivor() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-owner";
    publish_through_feasibility(&paths, cycle);
    // cand_1 struck as published, cand_2 failed feasibility; cand_4 is next in
    // play and has no audit yet.
    let progress = expert_selection_progress(&paths, cycle);
    assert_eq!(progress.stage, "novelty_refutation");
    assert_eq!(progress.funnel.as_ref().unwrap().in_play, vec!["cand_0", "cand_3", "cand_4"]);
    let mut audits = read_json(&novelty_audit_path(&paths, cycle)).unwrap();
    audits["audits"].as_array_mut().unwrap().push(audit("cand_4", "novel", false));
    write_json(&novelty_audit_path(&paths, cycle), &audits).unwrap();
    let mut assessments = read_json(&candidate_feasibility_path(&paths, cycle)).unwrap();
    assessments["assessments"].as_array_mut().unwrap().push(assessment("cand_4", "pass"));
    write_json(&candidate_feasibility_path(&paths, cycle), &assessments).unwrap();
    assert_eq!(expert_selection_progress(&paths, cycle).stage, "owner_checkpoint");

    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty());
    let owner = read_json(&owner_candidates_path(&paths, cycle)).unwrap();
    let ids: Vec<&str> = owner["candidates"].as_array().unwrap().iter().map(|card| card["candidate_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["cand_0", "cand_3", "cand_4"], "the owner sees the panel's order");
    assert_eq!(owner["candidates"][0]["reproduction_anchor"]["reported_value"], json!("85%"));
    assert_eq!(owner["candidates"][0]["belief_overturned"]["belief_id"], json!("b1"));
    let markdown = fs::read_to_string(owner_candidates_markdown_path(&paths, cycle)).unwrap();
    assert!(markdown.contains("Strategy mix among the survivors: belief_denial x2, latent_bottleneck x1."), "{markdown}");
    assert!(markdown.contains("- **Origin strategy:** `belief_denial` -- belief `b1` it would overturn: the field holds b1"), "{markdown}");
    assert!(markdown.contains("Reproduction anchor"));
    assert!(markdown.contains("`cand_1`: novelty: already published"));
    let marker = read_json(&shared_pause_marker_path(&paths, cycle)).unwrap();
    assert_eq!(marker["block_type"], json!(OWNER_SELECTION_BLOCK));
    assert!(is_cycle_paused(&paths, cycle));
    let hold = director_expert_selection_wait_reason(&paths, cycle).expect("no hold");
    assert!(hold.starts_with("waiting-for-owner-selection"), "{hold}");
    assert_eq!(blocker_descriptor(&hold).0, Some("owner"));
    // A lead is refused while the owner has not chosen.
    let reasons = lead_expert_selection_rejection_reasons(&paths, cycle, &json!({"statement": "s", "slate_candidate_id": "cand_0"}), true);
    assert!(reasons[0].starts_with("expert_selection_pending"));

    // Nothing to lift yet; an invalid pick is reported on the marker.
    assert!(!release_owner_selection_pause(&paths, cycle).unwrap());
    write_json(&owner_selection_path(&paths, cycle), &json!({"candidate_id": "cand_1", "note": "the struck one"})).unwrap();
    assert!(!release_owner_selection_pause(&paths, cycle).unwrap());
    let marker = read_json(&shared_pause_marker_path(&paths, cycle)).unwrap();
    assert!(marker["selection_error"].as_str().unwrap().contains("'cand_1' is not one of"));
    assert!(is_cycle_paused(&paths, cycle));

    write_json(&owner_selection_path(&paths, cycle), &json!({"candidate_id": "cand_3", "note": "most informative"})).unwrap();
    assert!(release_owner_selection_pause(&paths, cycle).unwrap());
    assert!(!is_cycle_paused(&paths, cycle));
    let recorded = recorded_owner_selection(&paths, cycle).unwrap();
    assert_eq!(recorded["candidate_id"], json!("cand_3"));
    assert_eq!(recorded["candidate"]["hypothesis"], json!("hypothesis 3"));
    assert_eq!(expert_selection_progress(&paths, cycle).stage, "selected");
    assert!(director_expert_selection_wait_reason(&paths, cycle).is_none());
    // The pause is not written again, and the lead gate now wants cand_3.
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty());
    assert!(!is_cycle_paused(&paths, cycle));
    let context = expert_selection_director_context(&paths, cycle);
    assert_eq!(context["selected_candidate"]["candidate_id"], json!("cand_3"));
    assert!(lead_expert_selection_rejection_reasons(
        &paths,
        cycle,
        &json!({"statement": "s", "slate_candidate_id": "cand_3", "landscape_open_problem_id": "op_sf0"}),
        true
    )
    .is_empty());
}

#[test]
fn with_a_timeout_the_owner_checkpoint_proceeds_with_the_panels_first_survivor() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-timeout";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(&expert_selection_state_path(&paths, cycle), &json!({"engaged_at": now_iso()})).unwrap();
    write_json(&owner_candidates_path(&paths, cycle), &json!({"candidates": [{"candidate_id": "cand_7"}, {"candidate_id": "cand_2"}]})).unwrap();
    let paused_at = (Utc::now() - chrono::Duration::minutes(5)).to_rfc3339();
    write_json(
        &shared_pause_marker_path(&paths, cycle),
        &json!({"block_type": OWNER_SELECTION_BLOCK, "paused_at": paused_at}),
    )
    .unwrap();
    // Unset: it waits however long it has been.
    assert!(!release_owner_selection_pause_after(&paths, cycle, None).unwrap());
    assert!(!release_owner_selection_pause_after(&paths, cycle, Some(10)).unwrap());
    assert!(release_owner_selection_pause_after(&paths, cycle, Some(3)).unwrap());
    assert!(!is_cycle_paused(&paths, cycle));
    let selection = read_json(&owner_selection_path(&paths, cycle)).unwrap();
    assert_eq!(selection["candidate_id"], json!("cand_7"));
    assert_eq!(selection["source"], json!("auto_timeout"));
    assert_eq!(recorded_owner_selection(&paths, cycle).unwrap()["source"], json!("auto_timeout"));

    // Any other pause is not this code's to lift.
    write_json(&shared_pause_marker_path(&paths, cycle), &json!({"reason": "lunch", "source": "researcher"})).unwrap();
    assert!(!release_owner_selection_pause_after(&paths, cycle, Some(0)).unwrap());
    assert!(is_cycle_paused(&paths, cycle));
}

// --- end to end ----------------------------------------------------------------------

#[test]
fn the_pipeline_runs_stage_by_stage_holds_the_director_and_never_shows_the_slate_the_host() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-flow";
    setup_cycle(&paths, cycle);
    let director = opening_director(&paths, cycle);
    let snapshot = || {
        let mut snapshot = dependency_snapshot(&paths, cycle).unwrap();
        snapshot.completed_scouts = 1;
        snapshot.counts.insert("chronicle".to_string(), 1);
        snapshot
    };
    let director_blocker = || dependency_blocker_for_lane_with_snapshot(&paths, cycle, &director, &snapshot()).unwrap();

    // Stage 1: beliefs.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    assert!(expert_selection_engaged(&paths, cycle));
    assert_eq!(created.len(), 1);
    let beliefs_lane = created_ids(&created).remove(0);
    assert!(beliefs_lane.starts_with("followup-selection-beliefs-"), "{beliefs_lane}");
    let plan = role_plan_of(&paths, cycle, &beliefs_lane);
    assert_eq!(plan["role"], json!("lab-director"));
    assert_eq!(plan["model_route"]["model"], json!(crate::labdirector::policy::CODEX_DEFAULT_AGENT_MODEL));
    assert_eq!(plan["model_route"]["reasoning_effort"], json!("high"));
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty(), "an open stage lane is not duplicated");
    let held = director_blocker().expect("the opening director is not held");
    assert!(held.starts_with("waiting-for-expert-selection stage=field_beliefs"), "{held}");
    // The stage lane itself waits on nothing the role gates know about.
    let beliefs_contract = contract_of(&paths, cycle, &beliefs_lane);
    assert!(dependency_blocker_for_lane_with_snapshot(&paths, cycle, &beliefs_contract, &dependency_snapshot(&paths, cycle).unwrap())
        .unwrap()
        .is_none());
    project_expert_selection_lane(&paths, &beliefs_contract, Some(&plan), &json!({"extracted_json": beliefs_output()})).unwrap();
    finish(&paths, cycle, &beliefs_lane);
    assert!(field_beliefs_path(&paths, cycle).is_file());

    // Stage 2: the slate, instrument-blind.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    let slate_lane = created_ids(&created).remove(0);
    assert!(slate_lane.starts_with("followup-selection-slate-"), "{slate_lane}");
    let slate_contract = contract_of(&paths, cycle, &slate_lane);
    refresh_role_plan_context_before_launch(&paths, cycle, &slate_contract).unwrap();
    let plan = role_plan_of(&paths, cycle, &slate_lane);
    let task = fs::read_to_string(&slate_contract.task_file).unwrap();
    let seen = format!("{plan}\n{task}");
    for host in ["instrument_fit", "instrument_inventory", "local_copy_path", "min_vram_gb_eval", "SuperDex", "D:/", ".research-lab/datasets", "RTX"] {
        assert!(!seen.contains(host), "the slate lane was shown '{host}'");
    }
    let contract_meta = &plan["planner_metadata"]["expert_selection_contract"];
    assert_eq!(contract_meta["field_beliefs"]["beliefs"].as_array().unwrap().len(), 4);
    assert_eq!(contract_meta["sota_cards"].as_array().unwrap().len(), 4);
    assert_eq!(contract_meta["field_landscape"]["open_problems"].as_array().unwrap().len(), 3);
    let prompt = crate::runtime::codex_prompt::build_codex_prompt(&slate_contract, Some(&plan)).unwrap();
    assert!(prompt.contains("CANDIDATE SLATE, INSTRUMENT-BLIND"));
    assert!(prompt.contains("\"target_belief_id\""));
    assert!(!prompt.contains("SuperDex"));
    assert!(!prompt.contains("SIMULATOR IS THE DATA SOURCE"));
    assert!(!prompt.contains("\"decision_status\""), "the slate lane was handed the director's lead contract");
    project_expert_selection_lane(&paths, &slate_contract, Some(&plan), &json!({"extracted_json": slate_output(8)})).unwrap();
    finish(&paths, cycle, &slate_lane);
    assert!(candidate_slate_path(&paths, cycle).is_file());

    // Stage 3: the panel, one lane per persona, all at once.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    // The field's own panel: one reviewer per subfield of its map (three), topped
    // up to four with a methodologist; fixed on dispatch.
    assert_eq!(created.len(), MIN_PANEL_SIZE);
    let fixed = read_json(&expert_panel_personas_path(&paths, cycle)).unwrap();
    let fixed_ids: Vec<&str> = fixed["personas"].as_array().unwrap().iter().map(|p| p["persona_id"].as_str().unwrap()).collect();
    assert_eq!(fixed_ids, vec!["subfield_sf0", "subfield_sf1", "subfield_sf2", "methodology"]);
    assert!(fixed["personas"][0]["persona"].as_str().unwrap().starts_with("a senior researcher in subfield 0"));
    assert!(!fixed.to_string().contains("manipulation"), "a robotics reviewer on a field map that names none");
    let ids: Vec<String> = (0..8).map(|index| format!("cand_{index}")).collect();
    for (position, lane_id) in created_ids(&created).into_iter().enumerate() {
        assert!(lane_id.starts_with("followup-selection-panel-"), "{lane_id}");
        let contract = contract_of(&paths, cycle, &lane_id);
        assert_eq!(contract.role, "gatekeeper");
        // Not a gate review: the gate's refresh and gates do not touch it.
        refresh_role_plan_context_before_launch(&paths, cycle, &contract).unwrap();
        let plan = role_plan_of(&paths, cycle, &lane_id);
        assert_eq!(plan["action_type"], json!(EXPERT_PANEL_ACTION));
        assert!(dependency_blocker_for_lane_with_snapshot(&paths, cycle, &contract, &dependency_snapshot(&paths, cycle).unwrap())
            .unwrap()
            .is_none());
        let prompt = crate::runtime::codex_prompt::build_codex_prompt(&contract, Some(&plan)).unwrap();
        assert!(prompt.contains("EXPERT PANEL REVIEW"));
        assert!(prompt.contains("\"predicted_outcome_probability\""));
        assert!(!prompt.contains("reviewer_focus_rubric"), "a panel reviewer was handed the gate-review contract");
        assert!(!read_published(&expert_panel_path(&paths, cycle)).is_some(), "scores unsealed before every reviewer submitted");
        let reviews: Vec<Value> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| review(id, 0.5, 1.0 - index as f64 * 0.1, if position == 0 { 1.0 } else { 0.9 }))
            .collect();
        project_expert_selection_lane(&paths, &contract, Some(&plan), &json!({"extracted_json": {"reviewer_persona": "x", "reviews": reviews, "summary": "s"}})).unwrap();
        finish(&paths, cycle, &lane_id);
    }
    let panel = read_json(&expert_panel_path(&paths, cycle)).unwrap();
    assert_eq!(panel["ranking"][0], json!("cand_0"));
    assert_eq!(panel["personas"].as_array().unwrap().len(), MIN_PANEL_SIZE);

    // Stage 4: novelty, a literature scout on the top three.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    let novelty_lane = created_ids(&created).remove(0);
    assert!(novelty_lane.starts_with("followup-scout-"), "{novelty_lane}");
    let plan = role_plan_of(&paths, cycle, &novelty_lane);
    assert_eq!(plan["planner_metadata"]["expert_selection_contract"]["candidate_ids"], json!(["cand_0", "cand_1", "cand_2"]));
    let novelty_contract = contract_of(&paths, cycle, &novelty_lane);
    let prompt = crate::runtime::codex_prompt::build_codex_prompt(&novelty_contract, Some(&plan)).unwrap();
    assert!(prompt.contains("NOVELTY REFUTATION"));
    assert!(prompt.contains("\"semanticscholar\""));
    write_json(
        &lane_root(&paths, cycle, &novelty_lane).join(NOVELTY_AUDIT_OUTPUT_FILE),
        &json!({"audits": [audit("cand_0", "novel", false), audit("cand_1", "anticipated", true), audit("cand_2", "novel", false)]}),
    )
    .unwrap();
    project_expert_selection_lane(&paths, &novelty_contract, Some(&plan), &json!({})).unwrap();
    finish(&paths, cycle, &novelty_lane);
    // cand_1 struck: cand_3 enters play and is audited next.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    let second_novelty = created_ids(&created).remove(0);
    let plan = role_plan_of(&paths, cycle, &second_novelty);
    assert_eq!(plan["planner_metadata"]["expert_selection_contract"]["candidate_ids"], json!(["cand_3"]));
    write_json(&lane_root(&paths, cycle, &second_novelty).join(NOVELTY_AUDIT_OUTPUT_FILE), &json!({"audits": [audit("cand_3", "novel", false)]})).unwrap();
    project_expert_selection_lane(&paths, &contract_of(&paths, cycle, &second_novelty), Some(&plan), &json!({})).unwrap();
    finish(&paths, cycle, &second_novelty);

    // Stage 5: feasibility, only now with the host in view.
    let created = dispatch_expert_selection(&paths, cycle).unwrap();
    let feasibility_lane = created_ids(&created).remove(0);
    assert!(feasibility_lane.starts_with("followup-selection-feasibility-"), "{feasibility_lane}");
    let plan = role_plan_of(&paths, cycle, &feasibility_lane);
    let meta = &plan["planner_metadata"]["expert_selection_contract"];
    assert_eq!(meta["candidate_ids"], json!(["cand_0", "cand_2", "cand_3"]));
    assert!(meta["instrument_inventory"]["inventory"]["simulators"].is_array());
    assert!(meta["sota_cards"][0]["assets"]["local_copy_path"].is_string());
    let assessments = json!({"assessments": [assessment("cand_0", "pass"), assessment("cand_2", "pass"), assessment("cand_3", "pass")], "summary": "s"});
    project_expert_selection_lane(&paths, &contract_of(&paths, cycle, &feasibility_lane), Some(&plan), &json!({"extracted_json": assessments})).unwrap();
    finish(&paths, cycle, &feasibility_lane);

    // Stage 6: the owner checkpoint, and the director waits for the owner.
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty());
    assert!(is_cycle_paused(&paths, cycle));
    assert!(director_blocker().unwrap().starts_with("waiting-for-owner-selection"));
    write_json(&owner_selection_path(&paths, cycle), &json!({"candidate_id": "cand_2", "note": "go"})).unwrap();
    assert!(release_owner_selection_pause(&paths, cycle).unwrap());
    assert!(director_blocker().is_none(), "the director is still held after the owner chose");
    let attempts = read_stage_attempts(&paths, cycle);
    assert!(attempts.iter().all(|attempt| attempt["valid"] == json!(true)), "{attempts:?}");
}

#[test]
fn a_stage_that_keeps_failing_stops_at_its_cap_and_the_director_is_then_not_held() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-cap";
    setup_cycle(&paths, cycle);
    for attempt in 1..=3 {
        let created = dispatch_expert_selection(&paths, cycle).unwrap();
        assert_eq!(created.len(), 1, "attempt {attempt} was not dispatched");
        let lane_id = created_ids(&created).remove(0);
        let plan = role_plan_of(&paths, cycle, &lane_id);
        assert_eq!(plan["planner_metadata"]["expert_selection_contract"]["attempt"], json!(attempt));
        // The lane dies with nothing projected.
        let _ = plan;
        finish(&paths, cycle, &lane_id);
    }
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty(), "retried without bound");
    assert!(director_expert_selection_wait_reason(&paths, cycle).is_none(), "held with nothing that can release it");
    // A refused lead selection earns the stage one more attempt.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    record_stage_attempt(&paths, cycle, FIELD_BELIEFS_ACTION, "followup-selection-beliefs-03", false, &["x".to_string()], &[]).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    record_lead_selection_rejection(&paths, cycle, "followup-lab-director-01", "a lead", &json!("replace"), &["x".to_string()]).unwrap();
    assert_eq!(dispatch_expert_selection(&paths, cycle).unwrap().len(), 1);
}

#[test]
fn a_cycle_that_already_has_a_lead_or_no_cards_is_never_engaged() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "selection-not-engaged";
    setup_cycle(&paths, cycle);
    write_json(&state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json")), &json!({"statement": "an older lead"})).unwrap();
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty());
    assert!(!expert_selection_engaged(&paths, cycle));
    assert!(director_expert_selection_wait_reason(&paths, cycle).is_none());

    let cycle = "selection-no-cards";
    setup_cycle(&paths, cycle);
    fs::remove_file(expert_sota_cards_path(&paths, cycle)).unwrap();
    assert!(dispatch_expert_selection(&paths, cycle).unwrap().is_empty());
    assert!(!expert_selection_engaged(&paths, cycle));
    assert!(lead_expert_selection_rejection_reasons(&paths, cycle, &json!({"statement": "s"}), true).is_empty());
}

// MEASURED ON cycle-a-20260919, 2026-09-28. The owner's 2026-09-20 pick
// was falsified by its own pre-registered experiment, the director asked for a
// new owner pick, and nothing could ask: a recorded selection was permanent. The
// owner's newest word through the selection file must be able to replace it.
#[test]
fn the_owner_can_change_their_pick_after_it_has_been_answered() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "owner-reselection";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &owner_candidates_path(&paths, cycle),
        &json!({"candidates": [
            {"candidate_id": "shared_coverage_decay", "hypothesis": "the falsified one"},
            {"candidate_id": "synthetic_scaling_is_gap_filling", "hypothesis": "another"},
        ]}),
    )
    .unwrap();
    write_json(
        &owner_selection_path(&paths, cycle),
        &json!({"candidate_id": "shared_coverage_decay", "note": "first pick"}),
    )
    .unwrap();
    update_expert_selection_state(&paths, cycle, |state| {
        state.insert(
            "owner_selection".to_string(),
            json!({"candidate_id": "shared_coverage_decay", "note": "first pick", "source": "owner"}),
        );
    })
    .unwrap();

    // Same file, same pick: nothing to do.
    assert!(!apply_owner_reselection(&paths, cycle).unwrap());

    // A choice that is not on the slate is not recorded.
    write_json(&owner_selection_path(&paths, cycle), &json!({"candidate_id": "invented"})).unwrap();
    assert!(!apply_owner_reselection(&paths, cycle).unwrap());
    assert_eq!(recorded_owner_selection(&paths, cycle).unwrap()["candidate_id"], json!("shared_coverage_decay"));

    // The owner re-chooses: release to the director, same question, new method.
    write_json(
        &owner_selection_path(&paths, cycle),
        &json!({"candidate_id": "release", "note": "same question, new method"}),
    )
    .unwrap();
    assert!(apply_owner_reselection(&paths, cycle).unwrap());
    let recorded = recorded_owner_selection(&paths, cycle).unwrap();
    assert_eq!(recorded["candidate_id"], json!("release"));
    assert_eq!(recorded["source"], json!("owner_reselection"));
    let history = expert_selection_state(&paths, cycle);
    let superseded = history["superseded_owner_selections"].as_array().unwrap();
    assert_eq!(superseded.len(), 1, "the replaced pick is kept as a record");
    assert_eq!(superseded[0]["selection"]["candidate_id"], json!("shared_coverage_decay"));

    // And it is not applied twice.
    assert!(!apply_owner_reselection(&paths, cycle).unwrap());

    // The owner corrects the note and keeps the choice: that is a new word too.
    write_json(
        &owner_selection_path(&paths, cycle),
        &json!({"candidate_id": "release", "note": "same question, new method; keep BC under removal"}),
    )
    .unwrap();
    assert!(apply_owner_reselection(&paths, cycle).unwrap(), "a corrected note was ignored");
    let recorded = recorded_owner_selection(&paths, cycle).unwrap();
    assert_eq!(recorded["note"], json!("same question, new method; keep BC under removal"));
    assert_eq!(
        expert_selection_state(&paths, cycle)["superseded_owner_selections"].as_array().unwrap().len(),
        2,
    );
    assert!(!apply_owner_reselection(&paths, cycle).unwrap());
}

#[test]
fn a_panel_already_reviewing_with_the_robotics_reviewers_keeps_them() {
    let temp = TempDir::new().unwrap();
    let paths = selection_test_paths(temp.path());
    let cycle = "legacy-panel";
    fs::create_dir_all(state_root(&paths)).unwrap();
    write_json(
        &expert_panel_submissions_path(&paths, cycle),
        &json!({"cycle_id": cycle, "submissions": {"sim_to_real": {"lane_id": "l1", "reviews": []}}}),
    )
    .unwrap();
    let personas = panel_personas(&paths, cycle, &ExpertSelectionConfig::default());
    assert_eq!(personas.len(), MAX_PANEL_SIZE);
    assert!(personas.iter().any(|(id, _)| id == "sim_to_real"));
    // With no map and no panel under way, the cross-cutting reviewers stand in.
    let fresh = panel_personas(&paths, "no-map", &ExpertSelectionConfig::default());
    assert_eq!(fresh.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), vec!["methodology", "adjacent_discipline", "field_generalist", "practitioner"]);
}
