#![allow(unused_imports)]
use super::*;

pub fn build_research_report(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let report_dir = paths.runtime_root.join("reports");
    fs::create_dir_all(&report_dir)?;
    let revision = next_revision(
        &report_dir,
        &format!("{cycle_id}-research-report-"),
        ".html",
    )?;
    let html_path = report_dir.join(format!("{cycle_id}-research-report-v{revision:04}.html"));
    let json_path = report_dir.join(format!("{cycle_id}-research-report-v{revision:04}.json"));

    let mut claims = Vec::new();
    let mut open_questions = Vec::new();
    let mut actions = Vec::new();
    let mut top_papers = Vec::new();
    let mut claim_trace_map: HashMap<String, Value> = HashMap::new();
    let hypothesis_papers = hypothesis_paper_map(paths, cycle_id);

    for brief in cycle_briefs(paths, cycle_id)? {
        let supporting_lanes = brief
            .get("lane_summaries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|item| item.get("lane_id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if let Some(items) = brief.get("claim_deltas").and_then(Value::as_array) {
            claims.extend(items.iter().cloned());
            for claim in items {
                let claim_id = claim
                    .get("claim_id")
                    .and_then(Value::as_str)
                    .unwrap_or("claim")
                    .to_string();
                let trace_entry = claim_trace_map.entry(claim_id.clone()).or_insert_with(|| {
                    json!({
                        "claim_id": claim_id,
                        "supporting_papers": [],
                        "supporting_lanes": [],
                        "lane_summaries": [],
                    })
                });
                if let Some(obj) = trace_entry.as_object_mut() {
                    let lanes = obj
                        .entry("supporting_lanes")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap();
                    for lane in &supporting_lanes {
                        if !lanes.iter().any(|item| item.as_str() == Some(lane)) {
                            lanes.push(json!(lane));
                        }
                    }
                    let summaries = obj
                        .entry("lane_summaries")
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                        .unwrap();
                    for lane in brief
                        .get("lane_summaries")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                    {
                        let lane_id = lane.get("lane_id").and_then(Value::as_str).unwrap_or("");
                        if lane_id.is_empty() {
                            continue;
                        }
                        if !summaries.iter().any(|item| {
                            item.get("lane_id").and_then(Value::as_str) == Some(lane_id)
                        }) {
                            summaries.push(lane);
                        }
                    }
                }
                if let Some(papers) = claim.get("supporting_papers").and_then(Value::as_array) {
                    if let Some(obj) = trace_entry.as_object_mut() {
                        let paper_bucket = obj
                            .entry("supporting_papers")
                            .or_insert_with(|| json!([]))
                            .as_array_mut()
                            .unwrap();
                        for paper in papers {
                            if !paper_bucket.iter().any(|item| item == paper) {
                                paper_bucket.push(paper.clone());
                            }
                        }
                    }
                    top_papers.extend(papers.iter().map(|paper| {
                        if paper.is_object() {
                            paper.clone()
                        } else {
                            json!({ "title": paper.as_str().unwrap_or("Untitled paper") })
                        }
                    }));
                }
            }
        }
        if let Some(items) = brief.get("open_questions").and_then(Value::as_array) {
            open_questions.extend(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string),
            );
        }
        if let Some(items) = brief.get("recommended_actions").and_then(Value::as_array) {
            actions.extend(items.iter().cloned());
        }
        if let Some(items) = brief.get("lane_summaries").and_then(Value::as_array) {
            for item in items {
                if let Some(papers) = item.get("top_papers").and_then(Value::as_array) {
                    top_papers.extend(papers.iter().cloned());
                }
            }
        }
    }

    claims = dedup_claims(claims);
    for claim in &mut claims {
        let claim_id = claim
            .get("claim_id")
            .and_then(Value::as_str)
            .unwrap_or("claim")
            .to_string();
        let supporting_hypotheses = claim
            .get("supporting_hypotheses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        if let Some(trace) = claim_trace_map.get(&claim_id) {
            let should_fill_supporting_papers = claim.get("supporting_papers").is_none()
                || claim
                    .get("supporting_papers")
                    .and_then(Value::as_array)
                    .map(|items| items.is_empty())
                    .unwrap_or(true);
            if let Some(obj) = claim.as_object_mut() {
                obj.insert(
                    "supporting_lanes".to_string(),
                    trace
                        .get("supporting_lanes")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                let merged_papers = trace
                    .get("supporting_papers")
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                if should_fill_supporting_papers {
                    obj.insert("supporting_papers".to_string(), merged_papers);
                }
                obj.insert(
                    "lane_summaries".to_string(),
                    trace
                        .get("lane_summaries")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
            }
        }
        if let Some(obj) = claim.as_object_mut() {
            let mut merged = obj
                .get("supporting_papers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for hypothesis_id in &supporting_hypotheses {
                if let Some(papers) = hypothesis_papers.get(hypothesis_id) {
                    for paper in papers {
                        if !merged.iter().any(|item| item == paper) {
                            merged.push(paper.clone());
                        }
                    }
                }
            }

            if merged.is_empty() {
                let reason_key = obj
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(slugify)
                    .unwrap_or_default();
                if !reason_key.is_empty() {
                    if let Some(papers) = hypothesis_papers.get(&reason_key) {
                        for paper in papers {
                            if !merged.iter().any(|item| item == paper) {
                                merged.push(paper.clone());
                            }
                        }
                    }
                }
            }

            obj.insert("supporting_papers".to_string(), json!(merged));
        }
    }
    let primary_claims = select_primary_claims(&claims);
    let supporting_claims = claims
        .iter()
        .filter(|claim| {
            let claim_id = claim
                .get("claim_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            !primary_claims.iter().any(|item| {
                item.get("claim_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    == claim_id
            })
        })
        .cloned()
        .collect::<Vec<_>>();
    open_questions = dedup_strings(open_questions);
    actions = dedup_actions(actions);
    let mut paper_map: HashMap<String, Value> = HashMap::new();
    for paper in top_papers {
        let key = slugify(
            paper
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("paper"),
        );
        if !key.is_empty() {
            paper_map.entry(key).or_insert(paper);
        }
    }
    let top_papers = paper_map.into_values().collect::<Vec<_>>();

    let report_json = json!({
        "cycle_id": cycle_id,
        "revision": revision,
        "generated_at": now_iso(),
        "claim_count": primary_claims.len(),
        "supporting_claim_count": supporting_claims.len(),
        "open_question_count": open_questions.len(),
        "recommended_action_count": actions.len(),
        "claims": primary_claims,
        "supporting_claims": supporting_claims,
        "open_questions": open_questions,
        "recommended_actions": actions,
        "top_papers": top_papers,
    });
    write_json(&json_path, &report_json)?;

    let claims_html = report_json["claims"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(20)
        .map(|claim| {
            let supporting = claim
                .get("supporting_papers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .take(4)
                .filter_map(|paper| {
                    if let Some(title) = paper.as_str() {
                        return Some(escape_html(title));
                    }
                    paper.get("title").and_then(Value::as_str).map(escape_html)
                })
                .collect::<Vec<_>>()
                .join("; ");
            let supporting_lanes = claim
                .get("supporting_lanes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .take(4)
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ");
            let supporting_label = if supporting.is_empty() {
                "supporting citations: none yet".to_string()
            } else {
                format!("supporting citations: {supporting}")
            };
            let lane_label = if supporting_lanes.is_empty() {
                "supporting lanes: none yet".to_string()
            } else {
                format!("supporting lanes: {supporting_lanes}")
            };
            format!(
                "<li><strong>{}</strong><div class=\"meta\">{}</div><div class=\"meta\">{}</div><div class=\"meta\">{}</div></li>",
                escape_html(
                    claim
                        .get("claim_id")
                        .and_then(Value::as_str)
                        .unwrap_or("claim")
                ),
                escape_html(
                    claim
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("no reason")
                ),
                escape_html(&supporting_label),
                escape_html(&lane_label)
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let questions_html = report_json["open_questions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(20)
        .filter_map(Value::as_str)
        .map(|question| format!("<li>{}</li>", escape_html(question)))
        .collect::<Vec<_>>()
        .join("");
    let actions_html = report_json["recommended_actions"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(20)
        .map(|action| {
            format!(
                "<li>{}</li>",
                escape_html(
                    action
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("action")
                )
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let papers_html = report_json["top_papers"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .take(8)
        .map(|paper| {
            format!(
                "<article class=\"paper\"><div class=\"paper-title\">{}</div><div class=\"meta\">{} {}</div></article>",
                escape_html(paper.get("title").and_then(Value::as_str).unwrap_or("Untitled paper")),
                escape_html(&paper.get("year").and_then(Value::as_i64).map(|v| v.to_string()).unwrap_or_else(|| "n/a".to_string())),
                escape_html(paper.get("doi").and_then(Value::as_str).unwrap_or(""))
            )
        })
        .collect::<Vec<_>>()
        .join("");

    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" /><title>Research Report {cycle_id}</title><style>
        :root {{ --bg:#f3f1ec; --ink:#1f2937; --muted:#6b7280; --panel:#fffdfa; --accent:#0f766e; --line:#ddd6cf; }}
        body {{ margin:0; font-family: Georgia, 'Iowan Old Style', serif; color:var(--ink); background:linear-gradient(180deg,#f8f5ef,#ece8de); }}
        main {{ max-width:1180px; margin:0 auto; padding:32px 20px 56px; }}
        .hero,.panel {{ background:var(--panel); border:1px solid var(--line); border-radius:22px; box-shadow:0 18px 40px rgba(17,24,39,.08); }}
        .hero {{ padding:32px; margin-bottom:18px; background:linear-gradient(135deg,rgba(15,118,110,.08),rgba(255,253,250,.98)); }}
        .eyebrow {{ font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }}
        h1,h2 {{ margin:0 0 12px; }}
        .grid {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-top:20px; }}
        .card {{ padding:18px; border-radius:16px; background:#fcfbf7; border:1px solid var(--line); }}
        .k {{ font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
        .v {{ font-size:34px; font-weight:700; margin-top:6px; }}
        .layout {{ display:grid; grid-template-columns:1.2fr .8fr; gap:18px; }}
        .stack {{ display:grid; gap:18px; }}
        .panel {{ padding:24px; }}
        ul {{ margin:0; padding-left:20px; }}
        li {{ margin:10px 0; line-height:1.45; }}
        .meta {{ color:var(--muted); font-size:14px; }}
        .paper {{ padding:12px 0; border-top:1px solid var(--line); }}
        .paper:first-child {{ border-top:0; padding-top:0; }}
        .paper-title {{ font-weight:700; }}
        @media (max-width: 960px) {{ .grid, .layout {{ grid-template-columns:1fr; }} }}
        </style></head><body><main>
        <section class=\"hero\"><div class=\"eyebrow\">Research Briefing</div><h1>{}</h1><p>This report explains why the research matters, what the strongest findings are, and which actions would materially improve approval readiness. It is designed to read like an executive strategy briefing rather than a runtime log.</p>
        <div class=\"grid\">
        <div class=\"card\"><div class=\"k\">Claim Updates</div><div class=\"v\">{}</div></div>
        <div class=\"card\"><div class=\"k\">Open Questions</div><div class=\"v\">{}</div></div>
        <div class=\"card\"><div class=\"k\">Recommended Actions</div><div class=\"v\">{}</div></div>
        <div class=\"card\"><div class=\"k\">Top Papers</div><div class=\"v\">{}</div></div>
        </div></section>
        <section class=\"layout\">
        <div class=\"stack\">
        <section class=\"panel\"><h2>Why This Research Matters</h2><p>The platform is optimizing for final researcher approval. That means it must not only find signals, but also turn them into evidence chains and visuals that a time-constrained decision-maker can trust quickly.</p></section>
        <section class=\"panel\"><h2>What We Found</h2><ul>{}</ul></section>
        <section class=\"panel\"><h2>What Still Needs Resolution</h2><ul>{}</ul></section>
        </div>
        <div class=\"stack\">
        <section class=\"panel\"><h2>Recommended Next Moves</h2><ul>{}</ul></section>
        <section class=\"panel\"><h2>Evidence Base</h2>{}</section>
        </div>
        </section></main></body></html>",
        escape_html(cycle_id),
        report_json["claim_count"].as_u64().unwrap_or(0),
        report_json["open_question_count"].as_u64().unwrap_or(0),
        report_json["recommended_action_count"].as_u64().unwrap_or(0),
        report_json["top_papers"].as_array().map(|v| v.len()).unwrap_or(0),
        claims_html,
        questions_html,
        actions_html,
        papers_html,
    );
    fs::write(&html_path, html)?;
    Ok(html_path)
}
