#![allow(unused_imports)]
use super::*;

// What each stage lane is told. The output contract is rendered FROM the strict
// schema, so the two cannot drift: a contract that asks for a field the schema
// forbids deletes that requirement without a word (see
// tests/contract_matches_schema.rs for the measured case).

/// A JSON skeleton of a schema: every property, in the shape it must take.
pub(crate) fn schema_skeleton(schema: &Value) -> Value {
    let types: Vec<&str> = match schema.get("type") {
        Some(Value::String(name)) => vec![name.as_str()],
        Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let nullable = types.contains(&"null");
    let primary = types.iter().find(|name| **name != "null").copied().unwrap_or("string");
    let rendered = match primary {
        "object" => {
            let mut out = serde_json::Map::new();
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (key, child) in properties {
                    out.insert(key.clone(), schema_skeleton(child));
                }
            }
            Value::Object(out)
        }
        "array" => json!([schema_skeleton(schema.get("items").unwrap_or(&Value::Null))]),
        "number" | "integer" => json!(0),
        "boolean" => json!(true),
        _ => match schema.get("enum").and_then(Value::as_array) {
            Some(options) => json!(options
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("|")),
            None => json!("..."),
        },
    };
    if nullable && primary != "object" {
        match rendered {
            Value::String(text) => json!(format!("{text} or null")),
            other => other,
        }
    } else {
        rendered
    }
}

/// The output contract for a stage lane that answers in its final message.
pub(crate) fn expert_selection_output_contract(role_plan: Option<&Value>) -> Option<String> {
    let action = expert_selection_action_of(role_plan)?;
    let schema = expert_selection_output_schema(action)?;
    let skeleton = serde_json::to_string_pretty(&schema_skeleton(&schema)).ok()?;
    Some(format!(
        "\n\nOutput Contract:\nReturn JSON only. No prose outside JSON. Every field is required; use null only where the shape says \"or null\".\n{skeleton}"
    ))
}

/// The file the novelty auditor writes.
pub(crate) fn novelty_audit_file_shape() -> Value {
    json!({
        "audits": [{
            "candidate_id": "the candidate id, verbatim",
            "core_idea": "the specific claim and method in one sentence -- not the topic",
            "queries": [{"query": "the search as run", "sources": ["semanticscholar"], "since": "YYYY-MM-DD", "hits_screened": 0}],
            "reviewer_prior_work_checked": [{"title": "a work a reviewer named", "relation": "how it relates to the core idea"}],
            "closest_works": [{"title": "...", "paper_id": "admitted id, DOI or arXiv id, or null", "url": "or null", "year": 0, "overlap": "what of the core idea it already does"}],
            "verdict": NOVELTY_VERDICTS.join("|"),
            "rationale": "why that verdict, against the closest work"
        }]
    })
}

const INTERESTING: &str = "\"Interesting\" is operational here (Davis 1971): a result is interesting when it DENIES or SHARPLY QUALIFIES an assumption its audience holds. Confirming what the field already believes is dull; denying what nobody believes is irrelevant.";

fn clause_for(action: &str, contract: &LaneContract, role_plan: Option<&Value>) -> String {
    let config = expert_selection_config();
    let meta = role_plan
        .and_then(|plan| plan.pointer("/planner_metadata/expert_selection_contract"))
        .cloned()
        .unwrap_or(Value::Null);
    match action {
        FIELD_BELIEFS_ACTION => format!(
            "\n\nEXPERT SELECTION -- FIELD BELIEFS (the harness validates what you return and publishes it; you write no state file):\n\
1. Read role_plan.planner_metadata.expert_selection_contract.sota_cards. A field belief is something the field treats as settled and a result could deny. It counts only when at least {min_cards} cards hold it: list each in held_by with the card's paper_id and the card's OWN evidence_ref, copied verbatim from its load_bearing_beliefs or core_claims -- the harness matches every reference against the card, and one it cannot find supports nothing.\n\
2. For each belief: rests_on (the evidence it actually rests on), untested (missing ablations and uncontrolled confounds, from ablations_missing, unstated_assumptions and stated_limitations), and the field_landscape open problems it bears on.\n\
3. contradictions: where cards disagree in claims or numbers.\n\
4. At least {min_beliefs} beliefs. Prefer beliefs whose denial would change what many groups do next over beliefs only one paper states. {INTERESTING}\n\
5. Denying a belief is one of four ways the slate finds a problem (expert_selection_contract.strategies); the next three sections give the other three their targets.\n\
6. subfield_maturity: for every field_landscape subfield, immature | maturing | mature, with the evidence (how far the best numbers move between cards, whether one approach has settled) and the dominant_approach. A method_leap candidate -- a large gain through a mechanism the field has not tried -- is only written for a subfield that is not mature.\n\
7. known_bottlenecks (at least {min_bottlenecks}): the bottlenecks everybody names -- named_by at least {min_cards} cards through their stated_limitations or core_claims evidence_refs -- with approaches_tried (what the cards and the work they cite already did about it) and why_they_stall. These are the targets for a concept imported from another discipline or a natural system.\n\
8. latent_signals (at least {min_latent}): demands or bottlenecks NO paper names. Read the cards' setup, unstated_assumptions, stated_limitations and ablations_missing for what papers work around, assume away or leave unmeasured; each seen_in a card through its own evidence_ref, with demand_it_implies and why_unnamed. This is where the most novelty is and the most effort goes: spend it.\n\
9. This host and its instruments are not part of this stage; do not consider what can run here.\n\
expert_selection_contract.previous_attempt, when present, says why the last attempt was refused.",
            min_cards = config.belief_min_cards,
            min_beliefs = config.min_beliefs,
            min_bottlenecks = config.min_known_bottlenecks,
            min_latent = config.min_latent_signals,
        ),
        CANDIDATE_SLATE_ACTION => format!(
            "\n\nEXPERT SELECTION -- CANDIDATE SLATE, INSTRUMENT-BLIND (the harness validates and publishes; you write no state file):\n\
{INTERESTING} That is one of four ways a problem worth a programme is found, and a slate written under one of them is one bet made {min} times.\n\
1. Write {min}-{max} candidates spanning at least {subfields} of expert_selection_contract.field_landscape.subfields AND at least {strategies} of the origin strategies in expert_selection_contract.strategies (those this map supports are expert_selection_contract.strategies_available). Each candidate is a (problem, hypothesis) pair with origin_strategy set and ONLY that strategy's basis filled, the other bases null:\n\
   - belief_denial: target_belief_id from field_beliefs.beliefs, belief_statement verbatim, papers_holding_belief from that belief's held_by.\n\
   - method_leap: for a subfield field_beliefs.subfield_maturity rates immature or maturing, where a large gain still changes what the field does. method_leap.new_mechanism says what the method does that no card's method does; departs_from names the card approaches it deliberately drops (paper_id, approach, what_is_dropped). Not a refinement, a recombination or a scaling of what is published: a mechanism the field has not tried.\n\
   - bottleneck_transfer: bottleneck_id from field_beliefs.known_bottlenecks, whose approaches_tried have stalled, and a concept imported from another discipline or a natural system (control theory, neuroscience, ecology, materials, economics, animal and plant mechanics, ...): source_field, mechanism_mapping (how the concept's mechanism meets the bottleneck's CAUSE, not its symptom) and why_untried_here. A concept already in approaches_tried under another name is refused.\n\
   - latent_bottleneck: a demand or bottleneck no paper names, from field_beliefs.latent_signals or your own reading of the cards: latent_bottleneck.demand, why_unnamed, and evidence from at least {latent_evidence} cards (paper_id, the card's own evidence_ref, the observation: the workaround, the assumption, the missing measurement). The most novelty and the most room; it is earned with the evidence, never asserted.\n\
2. For every candidate, whatever its strategy: differing_prediction (what the hypothesis predicts that the field's belief, dominant approach or practice does not), informative_either_way (what the field learns if it is confirmed AND if it is refuted -- both substantive), decisive_experiment (the one experiment, and its measurement, that separates them).\n\
3. open_source_assets: the released code, checkpoints, datasets and benchmark environments from sota_cards[].assets the work builds on, url verbatim. Almost all SOTA work is open source; a question that reuses it can be settled in days rather than years, and leverage is a selection criterion.\n\
4. landscape_open_problem_id from expert_selection_contract.field_landscape.open_problems and landscape_paper_ids from expert_selection_contract.field_landscape.papers (at least expert_selection_contract.field_landscape.min_lead_citations, one of them frontier): the lead gate needs both.\n\
5. You are deliberately NOT shown this host, its simulators, robots, GPU or local copies. Choose by what would change the field. Do not name local paths or hardware; do not narrow a candidate to what one released checkpoint or one simulator can show. A diagnostic of one artefact, a question whose answer the field can already call, and a denial of something nobody believes are all weak candidates.\n\
6. candidate_id: short, unique, snake_case.\n\
expert_selection_contract.previous_attempt, when present, says why the last attempt was refused.",
            min = config.slate_min,
            max = config.slate_max,
            subfields = config.min_slate_subfields,
            strategies = config.min_slate_strategies,
            latent_evidence = config.latent_min_evidence,
        ),
        EXPERT_PANEL_ACTION => format!(
            "\n\nEXPERT SELECTION -- EXPERT PANEL REVIEW. You are {persona}. Score EVERY candidate in expert_selection_contract.candidates, on your own:\n\
- predicted_outcome_probability: your probability, 0-1, that the hypothesis holds. can_call_it: whether you could have called the outcome and why. A result you can predict is not new.\n\
- impact, 0-1: would a result -- either way -- change your own research or what your subfield does next? 0 = no; 1 = it would redirect it. impact_rationale says how.\n\
- soundness, 0-1: would the decisive experiment actually separate the hypothesis from the belief it targets? soundness_concerns names the confounds.\n\
- closest_prior_work: the closest work you know, by title, with venue/year and an id when you know them. 'Nothing close' is not an answer; name the nearest.\n\
- critique: what an area chair in your subfield would say.\n\
- Each candidate declares its origin_strategy; expert_selection_contract.strategies explains the four. Judge it on its own terms: method_leap -- is new_mechanism new to the field or a recombination of what it departs_from, and would the gain change practice; bottleneck_transfer -- does the imported concept meet the bottleneck's cause or only its symptom, and has the transfer been tried; latent_bottleneck -- is the demand real (would practitioners recognise it once named) and does the evidence show it being worked around; belief_denial -- as above. Favour no strategy; favour the question.\n\
{INTERESTING} Judge the question for the field, not whether any particular lab can run it.\n\
{independence}\n\
reviewer_persona: {persona_id}.",
            persona = selection_text(meta.get("persona")).unwrap_or("a senior researcher in the field"),
            persona_id = selection_text(meta.get("persona_id")).unwrap_or(""),
            independence = selection_text(meta.get("independence")).unwrap_or(""),
        ),
        NOVELTY_REFUTATION_ACTION => {
            let lane_dir = contract.task_file.parent().unwrap_or(&contract.cwd);
            let output_dir = contract
                .output_artifact
                .as_ref()
                .and_then(|path| path.parent())
                .unwrap_or(lane_dir);
            let role_plan_path = lane_dir.join("role-plan.json");
            let query_args = json!([
                "drivers/literature/search.py", "--query", "<the core idea, in the words a paper claiming it would use>",
                "--sources", "semanticscholar", "--output-dir", output_dir, "--role-plan-file", role_plan_path
            ]);
            let title_args = json!([
                "drivers/literature/search.py", "--title", "<a reviewer-named work>",
                "--output-dir", output_dir, "--role-plan-file", role_plan_path
            ]);
            format!(
                "\n\nEXPERT SELECTION -- NOVELTY REFUTATION (this scout tries to show each assigned candidate is ALREADY PUBLISHED; a candidate it cannot strike survives):\n\
A. For each entry of expert_selection_contract.candidates, write its core idea in one sentence: the specific claim and method, not the topic.\n\
B. Search for the idea itself, published on or after {since} ({months} months): at least two searches per candidate, between them on Semantic Scholar AND arXiv -- argv shaped like {query_args}, then again with `--sources arxiv`; vary the wording the way a paper claiming the idea would phrase it. Look up every work the reviewers named in reviewer_named_prior_work by exact title, argv like {title_args}.\n\
C. Screen and finalize what you find exactly as the protocol above.\n\
D. Verdict per candidate: `anticipated` when a paper already makes the core claim with the core method -- cite it (title, paper_id or url, year); `partially_anticipated` when a key ingredient is published but not the specific prediction; `novel` otherwise.\n\
   By origin_strategy: for a bottleneck_transfer candidate also search for the imported concept applied to this bottleneck, in this field and in the source field's own transfer literature; for a latent_bottleneck candidate also search for the demand being NAMED (a paper that states the bottleneck) -- a named demand goes in closest_works and the rationale, and strikes the candidate only when claim and method are anticipated; for a method_leap candidate search for the mechanism, not for the performance.\n\
E. Write {output} as JSON shaped {shape}. The harness strikes every `anticipated` candidate with its citation; the panel's order of the rest is unchanged.",
                since = selection_text(meta.get("searched_on_or_after")).unwrap_or(""),
                months = config.novelty_window_months,
                query_args = query_args,
                title_args = title_args,
                output = output_dir.join(NOVELTY_AUDIT_OUTPUT_FILE).display(),
                shape = novelty_audit_file_shape(),
            )
        }
        FEASIBILITY_AUDIT_ACTION => format!(
            "\n\nEXPERT SELECTION -- FEASIBILITY, PASS OR FAIL (never a score; the harness keeps the panel's order and only strikes):\n\
For each candidate in expert_selection_contract.candidates:\n\
1. Assets: find each of its open_source_assets in expert_selection_contract.sota_cards -- licence, min_vram_gb_eval / min_vram_gb_train, local_copy_path -- and check the local copies under host.local_reference_roots and the instrument_inventory (list directories, read README and LICENSE; modify nothing and install nothing: this is a check). A benchmark environment that is not present here (ManiSkill, MuJoCo Playground and the like) counts when its documented requirements fit this Python, CUDA and GPU: record installing it as a setup step, with the evidence.\n\
2. peak_vram_gb of the cheapest FAITHFUL setup against host.vram_gb ({vram} GB). A setup that only fits by changing the question is a fail, not a pass. A card's min_vram_gb is its published configuration, not your plan: when your peak is lower, say in vram_reduction what makes it lower (smaller backbone, lower resolution, shorter horizon, smaller batch, sequential instead of parallel training) and why the question survives it.\n\
3. reproduction_anchor: ONE number a card reports in its core_claims -- paper_id, metric, reported_value copied from the card, its evidence_ref -- and the setup that reproduces it here FIRST, before the new experiment. No anchor, no pass.\n\
4. cheapest_faithful_setup, experiment_plan (the anchor first, then the decisive experiment), cost.\n\
5. Set used=false on every asset your cheapest_faithful_setup drops (a licence you cannot accept, a model that does not fit): a dropped asset does not block the candidate, but the setup must still answer the same question without it.\n\
6. verdict pass or fail, with blockers for a fail. The harness downgrades a pass whose anchor is not a number the card reports, whose own peak VRAM exceeds this host, whose used asset's licence forbids the use, or whose used asset's card floor exceeds this host with no vram_reduction stated.",
            vram = config.host_vram_gb,
        ),
        _ => String::new(),
    }
}

/// The stage clause for an expert-selection lane, or nothing for any other lane.
pub(crate) fn expert_selection_prompt_clause(contract: &LaneContract, role_plan: Option<&Value>) -> String {
    match expert_selection_action_of(role_plan) {
        Some(action) => clause_for(action, contract, role_plan),
        None => String::new(),
    }
}
