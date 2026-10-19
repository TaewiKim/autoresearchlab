#![allow(unused_imports)]
use super::*;

pub fn build_paper_draft(paths: &AppPaths, cycle_id: &str) -> Result<PathBuf> {
    let report_dir = paths.runtime_root.join("reports");
    let paper_dir = paths.runtime_root.join("papers");
    fs::create_dir_all(&paper_dir)?;
    let mut latest_report_json: Option<PathBuf> = None;
    let mut latest_report_rev = 0usize;
    if report_dir.exists() {
        for entry in read_dir(&report_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let json_prefix = format!("{cycle_id}-research-report-v");
            if name.starts_with(&json_prefix) && name.ends_with(".json") {
                let middle = name
                    .trim_start_matches(&json_prefix)
                    .trim_end_matches(".json");
                if let Ok(rev) = middle.parse::<usize>() {
                    if rev >= latest_report_rev {
                        latest_report_rev = rev;
                        latest_report_json = Some(entry.path());
                    }
                }
            }
        }
    }
    let revision = latest_report_rev.max(1);
    let paper_path = paper_dir.join(format!("{cycle_id}-paper-v{revision:04}.tex"));

    let report_json = if let Some(path) = latest_report_json.as_ref() {
        read_json(path)?
    } else {
        json!({})
    };
    let cycle_plan = read_json(&plans_root(paths).join(format!("{cycle_id}-cycle-plan.json")))?;
    let objective = cycle_plan
        .get("objective")
        .and_then(Value::as_str)
        .unwrap_or("Untitled research objective");

    let claims = report_json
        .get("claims")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let open_questions = report_json
        .get("open_questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let actions = report_json
        .get("recommended_actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let top_papers = report_json
        .get("top_papers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let claims_tex = claims
        .iter()
        .take(20)
        .map(|claim| {
            let supporting = claim
                .get("supporting_papers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .take(3)
                .filter_map(|paper| {
                    if let Some(title) = paper.as_str() {
                        return Some(latex_escape(title));
                    }
                    paper.get("title").and_then(Value::as_str).map(latex_escape)
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
                .map(latex_escape)
                .collect::<Vec<_>>()
                .join(", ");
            format!(
                "\\item \\textbf{{{}}} {}{}{}",
                latex_escape(
                    claim
                        .get("claim_id")
                        .and_then(Value::as_str)
                        .unwrap_or("claim")
                ),
                latex_escape(
                    claim
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("no reason")
                ),
                if supporting.is_empty() {
                    "".to_string()
                } else {
                    format!(" [supporting citations: {}]", supporting)
                },
                if supporting_lanes.is_empty() {
                    "".to_string()
                } else {
                    format!(" [supporting lanes: {}]", supporting_lanes)
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let questions_tex = open_questions
        .iter()
        .take(20)
        .filter_map(Value::as_str)
        .map(|question| format!("\\item {}", latex_escape(question)))
        .collect::<Vec<_>>()
        .join("\n");
    let actions_tex = actions
        .iter()
        .take(20)
        .map(|action| {
            format!(
                "\\item {}",
                latex_escape(
                    action
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("action")
                )
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let refs_tex = top_papers
        .iter()
        .take(12)
        .map(|paper| {
            format!(
                "\\item {} ({}) {}",
                latex_escape(
                    paper
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Untitled paper")
                ),
                paper
                    .get("year")
                    .and_then(Value::as_i64)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "n.d.".to_string()),
                latex_escape(paper.get("doi").and_then(Value::as_str).unwrap_or(""))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let tex = format!(
        "\\documentclass[11pt]{{article}}
\\usepackage[margin=1in]{{geometry}}
\\usepackage{{hyperref}}
\\usepackage{{booktabs}}
\\title{{Autonomous Research Draft: {}}}
\\author{{ResearchLab}}
\\date{{\\today}}
\\begin{{document}}
\\maketitle
\\begin{{abstract}}
This paper draft summarizes an autonomous research cycle executed for the following objective: {}. The document is formatted as a LaTeX manuscript so it can be revised directly into a submission-ready paper.
\\end{{abstract}}
\\section{{Introduction}}
This study asks: {}.
\\section{{Method}}
The platform decomposed the work into scout, analyst, lab-runner, chronicle, illustrator, and author roles. Chronicle briefs served as the reporting interface to LabDirector, while the orchestrator maintained filesystem-backed state and recovery-aware execution.
\\section{{Results}}
\\begin{{itemize}}
{}
\\end{{itemize}}
\\section{{Open Questions}}
\\begin{{itemize}}
{}
\\end{{itemize}}
\\section{{Next Actions}}
\\begin{{itemize}}
{}
\\end{{itemize}}
\\section{{References Snapshot}}
\\begin{{itemize}}
{}
\\end{{itemize}}
\\end{{document}}
",
        latex_escape(cycle_id),
        latex_escape(objective),
        latex_escape(objective),
        claims_tex,
        questions_tex,
        actions_tex,
        refs_tex,
    );

    fs::write(&paper_path, tex)?;
    Ok(paper_path)
}
