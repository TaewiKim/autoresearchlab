#![allow(unused_imports)]
use super::*;
use crate::core::support::{external_artifacts_root, stats_artifacts_root};
use std::collections::{BTreeMap, BTreeSet};

// --- forward-citation frontier harvest ------------------------------------------------
//
// The landscape names what its scout can recall, and a model recalls nothing
// published after its knowledge horizon.
//
// MEASURED ON cycle-b-20260919, 2026-09-19. The owner named SimToolReal
// (RSS 2026, arXiv 2602.16863, 17 citations about seven months after release) as
// a representative SOTA paper the harness never found. A gatekeeper's prior-art
// search retrieved it once; it sat in `pending_abstract_review`, never reviewed,
// and never reached the landscape. It cites five of the landscape's canonical
// works. Nothing discovered post-horizon work systematically, and a retrieved
// candidate nobody reviewed could simply be abandoned.
//
// So, once the landscape is valid and before the SOTA deep read:
//   * a deterministic external-driver scout (`frontier_harvest`) pages the
//     forward citations of every canonical work the landscape verified, keeps
//     what was published on or after the knowledge horizon, ranks it by distinct
//     anchors cited and citation velocity (drivers/literature/search_lib/
//     frontier.py), revives the cycle's own retrieved-but-unreviewed candidates
//     through the same filter, and queues the top-K for the normal abstract
//     review. Anchors and horizon are data: the published landscape and the
//     owner's configuration, never a list in code;
//   * its top-K are published to `<cycle>-frontier-harvest.json` with each one's
//     review state, read from every screening artifact of the cycle;
//   * NO SILENT DROP: while any top-K candidate is neither reviewed nor excluded
//     with a reason, the deep read is not dispatched, published cards are invalid,
//     expert selection does not engage and no lead may be selected;
//   * admitted harvest papers join the landscape's verified papers, flagged
//     `post_horizon`, so the deep read chooses from them and a lead may cite them.
//
// Choice of wiring: an external-driver lane, not a clause in the landscape
// scout's protocol. The harvest is deterministic (no judgement until review),
// can take minutes of paced requests the Codex shell budget would not survive,
// and its anchors exist only once the landscape is published. Review goes
// through the existing path: a driver lane that ends `pending_review` gets a
// Codex `abstract_review_followup` (runtime_drivers::mark_pending_literature_recovery).

pub(crate) const FRONTIER_HARVEST_ACTION: &str = "frontier_harvest";
pub(crate) const FRONTIER_CANDIDATES_FILE: &str = "frontier-candidates.json";
const FRONTIER_ANCHORS_FILE: &str = "frontier-anchors.json";
/// Key under which admitted harvest papers are attached to a landscape subfield
/// when the landscape is read (never written into the published landscape).
pub(crate) const FRONTIER_HARVEST_WORKS_KEY: &str = "frontier_harvest_works";

fn env_value<T: std::str::FromStr>(name: &str) -> Option<T> {
    env::var(name).ok().and_then(|raw| raw.trim().parse::<T>().ok())
}

/// On unless the owner turns it off (`RESEARCHLAB_FRONTIER_HARVEST=0|false|off|no`).
pub(crate) fn frontier_harvest_enabled() -> bool {
    !matches!(
        env::var("RESEARCHLAB_FRONTIER_HARVEST")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

fn frontier_harvest_max_attempts() -> usize {
    env_value::<usize>("RESEARCHLAB_FRONTIER_HARVEST_MAX_ATTEMPTS")
        .filter(|value| *value > 0)
        .unwrap_or(2)
}

fn frontier_top_k() -> usize {
    env_value::<usize>("RESEARCHLAB_FRONTIER_TOP_K").filter(|value| *value > 0).unwrap_or(20)
}

/// The harvest's own time budget: paced Graph API pages for every anchor, with
/// patient retries on the anonymous pool's 429s. MEASURED ON the 2026-09-19
/// smoke from this host, while a live cycle shared the pool: five anchors and 30
/// revived candidates took 1,649 s, with 105 of 172 requests answered 429. The
/// driver stops two minutes before this (RESEARCHLAB_FRONTIER_DEADLINE_SECONDS)
/// and publishes what it has.
pub(crate) fn frontier_harvest_timeout_seconds() -> u64 {
    env_value::<u64>("RESEARCHLAB_FRONTIER_HARVEST_TIMEOUT_SECONDS")
        .filter(|value| *value > 0)
        .unwrap_or(3_600)
}

// --- the knowledge horizon -------------------------------------------------------------

/// `since` for the harvest: `RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON` (YYYY-MM-DD) when
/// the owner configured it, else the cycle date minus
/// `RESEARCHLAB_FRONTIER_WINDOW_MONTHS` (default 18). No date lives in code.
pub(crate) fn knowledge_horizon_for(cycle_date: chrono::NaiveDate) -> (chrono::NaiveDate, String) {
    if let Some(horizon) = env::var("RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON")
        .ok()
        .and_then(|raw| chrono::NaiveDate::parse_from_str(raw.trim().get(..10).unwrap_or(raw.trim()), "%Y-%m-%d").ok())
    {
        return (horizon, "RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON".to_string());
    }
    let window = env_value::<u32>("RESEARCHLAB_FRONTIER_WINDOW_MONTHS").unwrap_or(18);
    let since = cycle_date.checked_sub_months(chrono::Months::new(window)).unwrap_or(cycle_date);
    (since, format!("cycle_date {cycle_date} minus {window} months"))
}

/// The cycle's date: its plan's `created_at`, else today.
fn cycle_date(paths: &AppPaths, cycle_id: &str) -> chrono::NaiveDate {
    read_json(&plans_root(paths).join(format!("{cycle_id}-cycle-plan.json")))
        .ok()
        .and_then(|plan| plan.get("created_at").and_then(Value::as_str).map(ToString::to_string))
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(&text).ok())
        .map(|at| at.date_naive())
        .unwrap_or_else(|| chrono::Utc::now().date_naive())
}

pub(crate) fn cycle_knowledge_horizon(paths: &AppPaths, cycle_id: &str) -> (chrono::NaiveDate, String) {
    knowledge_horizon_for(cycle_date(paths, cycle_id))
}

pub(crate) fn frontier_harvest_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-frontier-harvest.json"))
}

/// Every directory of this cycle that can hold a screening artifact: lane
/// directories (codex lanes and their prior-art subdirectories), external-driver
/// output directories, and per-cycle artifact directories.
fn cycle_screening_roots(paths: &AppPaths, cycle_id: &str) -> Vec<PathBuf> {
    let mut roots = vec![
        cycle_lanes_root(paths, cycle_id),
        stats_artifacts_root(paths).join(cycle_id),
        paths.runtime_root.join("artifacts").join(cycle_id),
    ];
    roots.dedup();
    roots
}

// --- anchors ------------------------------------------------------------------------------

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

fn entry_ids(entry: &Value) -> Vec<String> {
    let mut ids: Vec<String> = text_of(entry.get("paper_id")).map(ToString::to_string).into_iter().collect();
    ids.extend(
        entry
            .get("paper_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| text_of(Some(item)).map(ToString::to_string)),
    );
    ids
}

/// The anchors: every canonical work of the published landscape that the
/// screening gate verified, with the subfields that name it.
pub(crate) fn landscape_anchors(landscape: &Value) -> Vec<Value> {
    let verified = landscape.get("verified_papers").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut subfields_of: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut order = Vec::new();
    for subfield in landscape.get("subfields").and_then(Value::as_array).into_iter().flatten() {
        let Some(subfield_id) = text_of(subfield.get("subfield_id")).or_else(|| text_of(subfield.get("name"))) else {
            continue;
        };
        for entry in subfield.get("canonical_works").and_then(Value::as_array).into_iter().flatten() {
            for id in entry_ids(entry) {
                let key = id.to_ascii_lowercase();
                if !verified.contains_key(&key) {
                    continue;
                }
                if !subfields_of.contains_key(&key) {
                    order.push(key.clone());
                }
                subfields_of.entry(key).or_default().insert(subfield_id.to_string());
            }
        }
    }
    order
        .into_iter()
        .map(|key| {
            let paper = &verified[&key];
            json!({
                "paper_id": paper.get("paper_id").cloned().unwrap_or_else(|| json!(key)),
                "title": paper.get("title").cloned().unwrap_or(Value::Null),
                "year": paper.get("year").cloned().unwrap_or(Value::Null),
                "subfield_ids": subfields_of.get(&key).cloned().unwrap_or_default(),
            })
        })
        .collect()
}

// --- identity across lanes ---------------------------------------------------------------

fn normalized_title(text: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}

fn strip_arxiv_version(id: &str) -> String {
    let lower = id.trim().to_ascii_lowercase();
    match lower.rfind('v') {
        Some(index) if index > 0 && lower[index + 1..].chars().all(|c| c.is_ascii_digit()) && index + 1 < lower.len() => {
            lower[..index].to_string()
        }
        _ => lower,
    }
}

/// The keys by which one work is recognised in any lane: DOI, arXiv id, Semantic
/// Scholar id and normalized title -- the same scheme frontier.py writes.
pub(crate) fn paper_aliases(paper: &Value) -> Vec<String> {
    let mut aliases = Vec::new();
    if let Some(doi) = text_of(paper.get("doi")) {
        let mut doi = doi.to_ascii_lowercase();
        for prefix in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"] {
            if let Some(rest) = doi.strip_prefix(prefix) {
                doi = rest.trim().to_string();
            }
        }
        if !doi.is_empty() {
            if let Some(arxiv) = doi.strip_prefix("10.48550/arxiv.") {
                aliases.push(format!("arxiv:{}", strip_arxiv_version(arxiv)));
            }
            aliases.insert(0, format!("doi:{doi}"));
        }
    }
    if let Some(arxiv) = text_of(paper.get("arxiv_id")) {
        aliases.push(format!("arxiv:{}", strip_arxiv_version(arxiv)));
    }
    if let Some(s2) = text_of(paper.get("semanticscholar_id")).or_else(|| text_of(paper.get("paperId"))) {
        aliases.push(format!("s2:{}", s2.to_ascii_lowercase()));
    }
    if let Some(title) = text_of(paper.get("title")) {
        let title = normalized_title(title);
        if !title.is_empty() {
            aliases.push(format!("title:{title}"));
        }
    }
    let mut seen = BTreeSet::new();
    aliases.retain(|alias| seen.insert(alias.clone()));
    aliases
}

// --- review state, read from the cycle's screening artifacts ------------------------------

#[derive(Clone, Debug, PartialEq)]
struct Resolution {
    status: &'static str,
    reason: String,
    source: String,
    admitted: Option<Value>,
}

fn resolution_rank(status: &str) -> u8 {
    match status {
        "accepted" => 3,
        "excluded" => 2,
        "quarantined" => 1,
        _ => 0,
    }
}

fn walk_named(root: &Path, names: &[&str], depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file() {
            if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| names.contains(&name)) {
                out.push(path);
            }
        } else if kind.is_dir() && depth > 0 {
            let skip = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| matches!(name, "superseded-literature-handoffs" | "sota-cards" | "__pycache__"));
            if !skip {
                walk_named(&path, names, depth - 1, out);
            }
        }
    }
}

fn record_resolution(
    found: &mut BTreeMap<usize, Resolution>,
    wanted: &BTreeMap<String, usize>,
    paper: &Value,
    candidate: Resolution,
) {
    for alias in paper_aliases(paper) {
        if let Some(index) = wanted.get(&alias) {
            let better = found
                .get(index)
                .map(|current| resolution_rank(candidate.status) > resolution_rank(current.status))
                .unwrap_or(true);
            if better {
                found.insert(*index, candidate.clone());
            }
            return;
        }
    }
}

/// The review state of each wanted candidate (by index), from every
/// `literature-screening-audit.json` and `papers.json` of the cycle. A file is
/// parsed only when its text names one of `needles`, so the cost of a pass is
/// one read of each file, not one parse.
fn review_resolutions(
    roots: &[PathBuf],
    wanted: &BTreeMap<String, usize>,
    needles: &[String],
) -> BTreeMap<usize, Resolution> {
    let mut found: BTreeMap<usize, Resolution> = BTreeMap::new();
    let mut files = Vec::new();
    for root in roots {
        walk_named(root, &["literature-screening-audit.json", "papers.json"], 5, &mut files);
    }
    files.sort();
    files.dedup();
    for file in files {
        let Ok(raw) = fs::read_to_string(&file) else {
            continue;
        };
        let lower = raw.to_ascii_lowercase();
        if !needles.iter().any(|needle| lower.contains(needle.as_str())) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(raw.strip_prefix('\u{feff}').unwrap_or(&raw)) else {
            continue;
        };
        let source = file.display().to_string();
        if file.file_name().and_then(|name| name.to_str()) == Some("papers.json") {
            let papers = value
                .as_array()
                .cloned()
                .or_else(|| value.get("papers").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            for paper in papers {
                if paper.pointer("/literature_screening/status").and_then(Value::as_str) != Some("accepted") {
                    continue;
                }
                let paper_id = text_of(paper.pointer("/literature_screening/review/paper_id"))
                    .or_else(|| text_of(paper.get("paper_id")))
                    .map(ToString::to_string);
                let admitted = paper_id.map(|id| {
                    json!({
                        "paper_id": id,
                        "title": paper.get("title").cloned().unwrap_or(Value::Null),
                        "year": paper.get("year").cloned().unwrap_or(Value::Null),
                    })
                });
                let reason = text_of(paper.pointer("/literature_screening/review/direct_relevance_reason"))
                    .unwrap_or("accepted after full-abstract review")
                    .chars()
                    .take(240)
                    .collect();
                record_resolution(
                    &mut found,
                    wanted,
                    &paper,
                    Resolution { status: "accepted", reason, source: source.clone(), admitted },
                );
            }
            continue;
        }
        for (key, status) in [("excluded", "excluded"), ("quarantined", "quarantined")] {
            for item in value.get(key).and_then(Value::as_array).into_iter().flatten() {
                let Some(paper) = item.get("paper") else {
                    continue;
                };
                let mut reasons: Vec<String> = item
                    .get("reasons")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|reason| reason.as_str().map(ToString::to_string))
                    .collect();
                if let Some(decision) = text_of(item.pointer("/review/decision")) {
                    reasons.push(format!("review decision: {decision}"));
                }
                // An exclusion is a resolution only when it says why.
                if reasons.is_empty() {
                    continue;
                }
                record_resolution(
                    &mut found,
                    wanted,
                    paper,
                    Resolution { status, reason: reasons.join("; "), source: source.clone(), admitted: None },
                );
            }
        }
    }
    found
}

/// Re-read the review state of every harvested top-K candidate and republish.
/// Candidates already accepted stay accepted; nothing is removed.
pub(crate) fn refresh_frontier_harvest_state(paths: &AppPaths, cycle_id: &str) -> Result<()> {
    let path = frontier_harvest_state_path(paths, cycle_id);
    let Ok(mut state) = read_json(&path) else {
        return Ok(());
    };
    let Some(top_k) = state.get("top_k").and_then(Value::as_array).cloned() else {
        return Ok(());
    };
    if top_k.iter().all(|item| item.get("review_status").and_then(Value::as_str) == Some("accepted")) {
        return Ok(());
    }
    let mut wanted = BTreeMap::new();
    let mut needles = BTreeSet::new();
    for (index, item) in top_k.iter().enumerate() {
        for alias in item.get("aliases").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            wanted.insert(alias.to_string(), index);
            // The title alone is too common a needle to pre-filter on.
            if let Some((kind, value)) = alias.split_once(':') {
                if kind != "title" && value.len() >= 6 {
                    needles.insert(value.to_string());
                }
            }
        }
    }
    let needles: Vec<String> = needles.into_iter().collect();
    let found = review_resolutions(&cycle_screening_roots(paths, cycle_id), &wanted, &needles);
    let mut changed = false;
    let refreshed: Vec<Value> = top_k
        .into_iter()
        .enumerate()
        .map(|(index, mut item)| {
            let current = item.get("review_status").and_then(Value::as_str).unwrap_or("pending").to_string();
            if let Some(resolution) = found.get(&index) {
                if resolution_rank(resolution.status) > resolution_rank(&current) {
                    item["review_status"] = json!(resolution.status);
                    item["review_reason"] = json!(resolution.reason);
                    item["review_source"] = json!(resolution.source);
                    item["admitted"] = resolution.admitted.clone().unwrap_or(Value::Null);
                    changed = true;
                }
            } else if item.get("review_status").is_none() {
                item["review_status"] = json!("pending");
                changed = true;
            }
            item
        })
        .collect();
    if changed || state.get("reviewed_at").is_none() {
        state["top_k"] = Value::Array(refreshed);
        state["reviewed_at"] = json!(now_iso());
        write_json(&path, &state)?;
    }
    Ok(())
}

// --- projection -------------------------------------------------------------------------------

fn role_plan_action(role_plan: Option<&Value>) -> &str {
    role_plan.and_then(|plan| plan.get("action_type")).and_then(Value::as_str).unwrap_or("")
}

/// Publish a finished harvest lane's top-K with their review state.
pub(crate) fn project_frontier_harvest(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<Option<PathBuf>> {
    if contract.role != "scout" || role_plan_action(role_plan) != FRONTIER_HARVEST_ACTION {
        return Ok(None);
    }
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| lane_dir.clone());
    let Some(source) = [output_dir.join(FRONTIER_CANDIDATES_FILE), lane_dir.join(FRONTIER_CANDIDATES_FILE)]
        .into_iter()
        .find(|path| path.is_file())
    else {
        return Ok(None);
    };
    let harvest = read_json(&source)?;
    let contract_meta = role_plan
        .and_then(|plan| plan.pointer("/planner_metadata/frontier_harvest_contract"))
        .cloned()
        .unwrap_or(Value::Null);
    let top_k: Vec<Value> = harvest
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("top_k").and_then(Value::as_bool) == Some(true))
        .map(|item| {
            let mut entry = item.clone();
            entry["review_status"] = json!("pending");
            entry
        })
        .collect();
    let path = frontier_harvest_state_path(paths, &contract.cycle_id);
    write_json(
        &path,
        &json!({
            "cycle_id": contract.cycle_id,
            "generated_by": contract.lane_id,
            "projected_at": now_iso(),
            "source_path": source,
            "lane_output_dir": output_dir,
            "since": harvest.get("since").cloned().unwrap_or(Value::Null),
            "horizon_source": harvest.get("horizon_source").cloned().unwrap_or(Value::Null),
            "scoring": harvest.get("scoring").cloned().unwrap_or(Value::Null),
            "anchors": contract_meta.get("anchors").cloned().unwrap_or(Value::Null),
            "anchor_count": harvest.get("anchors").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            "truncated_anchors": harvest.get("truncated_anchors").cloned().unwrap_or_else(|| json!([])),
            "unresolved_anchors": harvest.get("unresolved_anchors").cloned().unwrap_or_else(|| json!([])),
            "request_stats": harvest.get("request_stats").cloned().unwrap_or(Value::Null),
            "candidate_count": harvest.get("candidate_count").cloned().unwrap_or(Value::Null),
            "revived": harvest.get("revived").cloned().unwrap_or(Value::Null),
            "top_k": top_k,
        }),
    )?;
    refresh_frontier_harvest_state(paths, &contract.cycle_id)?;
    Ok(Some(path))
}

// --- status -----------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct FrontierHarvestStatus {
    /// `disabled`, `missing`, `pending_review` or `resolved`.
    pub(crate) state: &'static str,
    pub(crate) path: PathBuf,
    pub(crate) published: Value,
    /// Top-K candidates neither reviewed nor excluded with a reason.
    pub(crate) pending: Vec<Value>,
    /// Whether the stages after the harvest may proceed.
    pub(crate) settled: bool,
}

fn harvest_lane_counts(paths: &AppPaths, cycle_id: &str) -> (usize, usize) {
    let key = format!("scout::{FRONTIER_HARVEST_ACTION}");
    let total = count_followup_lanes_by_role_and_action(paths, cycle_id)
        .ok()
        .and_then(|counts| counts.get(&key).copied())
        .unwrap_or(0);
    let open = count_open_followup_lanes_by_role_and_action(paths, cycle_id)
        .ok()
        .and_then(|counts| counts.get(&key).copied())
        .unwrap_or(0);
    (total, open)
}

/// Read from the published file only; `refresh_frontier_harvest_state` (once per
/// scheduling pass, and after the harvest lane) keeps its review state current.
pub(crate) fn frontier_harvest_status(paths: &AppPaths, cycle_id: &str) -> FrontierHarvestStatus {
    let path = frontier_harvest_state_path(paths, cycle_id);
    if !frontier_harvest_enabled() {
        return FrontierHarvestStatus { state: "disabled", path, published: Value::Null, pending: Vec::new(), settled: true };
    }
    let Ok(published) = read_json(&path) else {
        // Not harvested yet. Settled only once every allowed attempt has ended
        // without a harvest (the network refused it), so a harvest that cannot
        // run cannot hold the cycle forever -- the director context says so.
        let (total, open) = harvest_lane_counts(paths, cycle_id);
        let settled = open == 0 && total >= frontier_harvest_max_attempts();
        return FrontierHarvestStatus { state: "missing", path, published: Value::Null, pending: Vec::new(), settled };
    };
    let pending = pending_top_k(&published);
    let state = if pending.is_empty() { "resolved" } else { "pending_review" };
    FrontierHarvestStatus { state, path, published, settled: pending.is_empty(), pending }
}

fn pending_top_k(published: &Value) -> Vec<Value> {
    published
        .get("top_k")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| resolution_rank(item.get("review_status").and_then(Value::as_str).unwrap_or("pending")) == 0)
        .cloned()
        .collect()
}

/// Why the stages after the harvest must wait: non-empty while any harvested
/// top-K candidate is neither reviewed nor excluded with a reason. Reads the
/// published file only: it is on the landscape's read path.
pub(crate) fn frontier_harvest_block_reasons(paths: &AppPaths, cycle_id: &str) -> Vec<String> {
    if !frontier_harvest_enabled() {
        return Vec::new();
    }
    let path = frontier_harvest_state_path(paths, cycle_id);
    let pending = read_json(&path).map(|published| pending_top_k(&published)).unwrap_or_default();
    if pending.is_empty() {
        return Vec::new();
    }
    let ids: Vec<String> = pending
        .iter()
        .take(8)
        .map(|item| {
            format!(
                "{} ({})",
                text_of(item.get("paper_id")).unwrap_or("?"),
                text_of(item.get("title")).map(|title| title.chars().take(70).collect::<String>()).unwrap_or_default()
            )
        })
        .collect();
    vec![format!(
        "frontier_harvest_unreviewed: {} harvested top-K candidate(s) are neither reviewed nor excluded with a reason ({}); their abstract review must finish before the deep read, expert selection or a lead -- see {}",
        pending.len(),
        ids.join("; "),
        path.display()
    )]
}

/// Admitted harvest papers, each with the subfields of the anchors it cites.
pub(crate) fn frontier_admitted_papers(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    if !frontier_harvest_enabled() {
        return Vec::new();
    }
    let Ok(published) = read_json(&frontier_harvest_state_path(paths, cycle_id)) else {
        return Vec::new();
    };
    let mut anchor_subfields: BTreeMap<String, Value> = BTreeMap::new();
    for anchor in published.get("anchors").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = text_of(anchor.get("paper_id")) {
            anchor_subfields.insert(id.to_ascii_lowercase(), anchor.get("subfield_ids").cloned().unwrap_or_else(|| json!([])));
        }
    }
    let since = published.get("since").cloned().unwrap_or(Value::Null);
    published
        .get("top_k")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("review_status").and_then(Value::as_str) == Some("accepted"))
        .filter_map(|item| {
            let admitted = item.get("admitted")?;
            let paper_id = text_of(admitted.get("paper_id"))?;
            let mut subfields = BTreeSet::new();
            for anchor in item.get("cites_anchors").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                for subfield in anchor_subfields
                    .get(&anchor.to_ascii_lowercase())
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    subfields.insert(subfield.to_string());
                }
            }
            Some(json!({
                "paper_id": paper_id,
                "title": admitted.get("title").cloned().or_else(|| item.get("title").cloned()).unwrap_or(Value::Null),
                "year": admitted.get("year").cloned().or_else(|| item.get("year").cloned()).unwrap_or(Value::Null),
                "publication_date": item.get("publication_date").cloned().unwrap_or(Value::Null),
                "post_horizon": true,
                "source": FRONTIER_HARVEST_ACTION,
                "since": since,
                "frontier_score": item.get("score").cloned().unwrap_or(Value::Null),
                "co_citation": item.get("co_citation").cloned().unwrap_or(Value::Null),
                "cites_anchors": item.get("cites_anchors").cloned().unwrap_or_else(|| json!([])),
                "subfield_ids": subfields,
            }))
        })
        .collect()
}

/// The landscape as every later stage reads it: the published landscape plus the
/// admitted harvest papers, in `verified_papers` (flagged `post_horizon`) and under
/// `frontier_harvest_works` of each subfield whose anchors they cite.
pub(crate) fn landscape_with_frontier(landscape: &Value, admitted: &[Value]) -> Value {
    if admitted.is_empty() || !landscape.is_object() {
        return landscape.clone();
    }
    let mut out = landscape.clone();
    if !out.get("verified_papers").is_some_and(Value::is_object) {
        out["verified_papers"] = json!({});
    }
    for paper in admitted {
        let Some(id) = text_of(paper.get("paper_id")) else {
            continue;
        };
        let key = id.to_ascii_lowercase();
        let verified = out["verified_papers"].as_object_mut().expect("object");
        match verified.get_mut(&key) {
            // Already a landscape paper: only flag it.
            Some(existing) => {
                existing["post_horizon"] = json!(true);
                existing["frontier_harvest"] = json!(true);
            }
            None => {
                verified.insert(
                    key.clone(),
                    json!({
                        "paper_id": id,
                        "title": paper.get("title").cloned().unwrap_or(Value::Null),
                        "year": paper.get("year").cloned().unwrap_or(Value::Null),
                        "post_horizon": true,
                        "frontier_harvest": true,
                    }),
                );
            }
        }
        let subfields: BTreeSet<&str> = paper
            .get("subfield_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        for subfield in out.get_mut("subfields").and_then(Value::as_array_mut).into_iter().flatten() {
            let id_matches = text_of(subfield.get("subfield_id"))
                .or_else(|| text_of(subfield.get("name")))
                .is_some_and(|subfield_id| subfields.contains(subfield_id));
            if !id_matches {
                continue;
            }
            if !subfield.get(FRONTIER_HARVEST_WORKS_KEY).is_some_and(Value::is_array) {
                subfield[FRONTIER_HARVEST_WORKS_KEY] = json!([]);
            }
            subfield[FRONTIER_HARVEST_WORKS_KEY].as_array_mut().expect("array").push(json!({
                "paper_id": id,
                "title": paper.get("title").cloned().unwrap_or(Value::Null),
                "post_horizon": true,
            }));
        }
    }
    out
}

// --- dispatch ---------------------------------------------------------------------------------

fn frontier_harvest_description(anchor_count: usize, since: &chrono::NaiveDate, attempt: usize) -> String {
    format!(
        "FRONTIER HARVEST, after the field landscape and before the SOTA deep read: page the forward citations of the landscape's {anchor_count} verified canonical works, keep papers published on or after {since} (the knowledge horizon), rank them by distinct anchors cited and citation velocity, revive this cycle's retrieved-but-never-reviewed candidates through the same filter, and queue the top-K for full-abstract review. Deterministic; no query is authored. [attempt {attempt}]"
    )
}

/// Refresh the published harvest's review state, then dispatch the harvest lane
/// once the landscape is valid and no harvest has been published. Called once per
/// scheduling pass, after the landscape dispatch.
pub(crate) fn dispatch_frontier_harvest(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !frontier_harvest_enabled() {
        return Ok(Vec::new());
    }
    refresh_frontier_harvest_state(paths, cycle_id)?;
    let landscape = field_landscape_status(paths, cycle_id);
    if landscape.state != "valid" {
        return Ok(Vec::new());
    }
    let status = frontier_harvest_status(paths, cycle_id);
    if status.state != "missing" {
        return Ok(Vec::new());
    }
    let (total, open) = harvest_lane_counts(paths, cycle_id);
    if open > 0 || total >= frontier_harvest_max_attempts() {
        return Ok(Vec::new());
    }
    let (since, horizon_source) = cycle_knowledge_horizon(paths, cycle_id);
    let anchors = landscape_anchors(&landscape.landscape);
    if anchors.is_empty() {
        // Nothing to harvest from: published as an empty, resolved harvest so the
        // stages after it are not held by a lane that can never be dispatched.
        write_json(
            &status.path,
            &json!({
                "cycle_id": cycle_id,
                "projected_at": now_iso(),
                "since": since.to_string(),
                "horizon_source": horizon_source,
                "anchors": [],
                "note": "the landscape verified no canonical work to harvest from",
                "top_k": [],
            }),
        )?;
        return Ok(Vec::new());
    }
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let attempt = total + 1;
    let description = frontier_harvest_description(anchors.len(), &since, attempt);
    let brief_id = "frontier-harvest";
    let task_body = followup_task_markdown(cycle_id, &objective, "scout", brief_id, &description, &[]);
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
    let contract_path =
        create_lane_contract(paths, cycle_id, &lane_id, "scout", "external-driver", "driver-exec", &task_body)?;
    let lane_dir = lane_root(paths, cycle_id, &lane_id);
    let anchors_file = lane_dir.join(FRONTIER_ANCHORS_FILE);
    write_json(&anchors_file, &json!({ "cycle_id": cycle_id, "anchors": anchors }))?;
    let revive_roots: Vec<String> = cycle_screening_roots(paths, cycle_id)
        .into_iter()
        .map(|root| root.display().to_string())
        .collect();
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        assigned_model_for_role("scout", "external-driver"),
        &objective,
        brief_id,
        &description,
        FRONTIER_HARVEST_ACTION,
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "frontier_harvest_gate",
            "preferred_role": "scout",
            "novelty_mode": "post-horizon-frontier",
            "selection_scope": "open",
            "frontier_harvest_contract": {
                "anchors_file": anchors_file,
                "anchors": anchors,
                "since": since.to_string(),
                "horizon_source": horizon_source,
                "top_k": frontier_top_k(),
                "revive_roots": revive_roots,
                "published_state_path": status.path,
                "attempt": attempt,
            },
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "scout",
        "contract_path": contract_path,
        "source_brief_id": brief_id,
        "role_plan_path": role_plan_path,
        "action_type": FRONTIER_HARVEST_ACTION,
    })])
}

// --- the harvest's own abstract review --------------------------------------------------------
//
// The harvest queues its top-K WITH abstracts and ends `pending_review`, so that
// runtime_drivers::mark_pending_literature_recovery turns the harvest lane's
// result into a Codex `abstract_review_followup` bound to that queue.
//
// MEASURED ON cycle-a-20260919, 2026-09-20. followup-scout-09 queued
// its 20 candidates, with abstracts, into its own output directory. The
// orchestrator's self-healing then renamed that lane's final-status.json,
// result.json and run-state.json to `*.self-heal-2026-09-19T16-22-43-875Z.bak`
// after an operator restart, and the pending_review handoff went with them --
// while the published `<cycle>-frontier-harvest.json` still recorded the pending
// top-K. Twelve candidates stayed pending with no lane bound to their queue: the
// generic literature-recovery scouts that did run were bound to OTHER source
// lanes, searched again instead of opening this queue, and several of those
// searches died on anonymous Semantic Scholar 429s. The no-silent-drop rule then
// held the deep read, the SOTA cards, expert selection and the lead gate, and the
// cycle could not reach its chosen lead.
//
// So the review handoff is triggered by the PUBLISHED harvest state -- the one
// artifact the self-heal does not touch -- and not by the harvest lane's
// transient files: while the published top-K has a pending candidate and no live
// lane is bound to the queue, exactly one Codex scout is dispatched against that
// queue, up to a bounded number of attempts. The decisions come back through the
// existing path: `review_resolutions` re-reads the screening audit and papers.json
// of every screening root of the cycle, so nothing below this weakens.

pub(crate) const FRONTIER_REVIEW_ACTION: &str = "abstract_review_followup";
const FRONTIER_REVIEW_QUEUE_FILE: &str = "abstract-review-queue.json";
const FRONTIER_REVIEW_REVIEWS_FILE: &str = "abstract-reviews.json";
/// Written into a review lane's own directory: what binds that lane to this
/// cycle's harvest queue, and what a later pass counts attempts by. A marker
/// file, so counting costs one `is_file` per lane instead of parsing every plan.
const FRONTIER_REVIEW_BINDING_FILE: &str = "frontier-review-binding.json";

/// How many review lanes the harvest queue may cost before the cycle gives up on
/// it (`RESEARCHLAB_FRONTIER_REVIEW_MAX_ATTEMPTS`, default 3).
fn frontier_review_max_attempts() -> usize {
    env_value::<usize>("RESEARCHLAB_FRONTIER_REVIEW_MAX_ATTEMPTS")
        .filter(|value| *value > 0)
        .unwrap_or(3)
}

/// Whether a lane has ENDED, by its own directory.
///
/// `final-status.json` is the marker, and the orchestrator's self-healing renames
/// it to `final-status.json.self-heal-<timestamp>.bak` rather than deleting it --
/// which is exactly how the harvest lane came to read as live forever. A lane
/// whose terminal marker was renamed away has still ended.
fn lane_has_ended(lane_dir: &Path) -> bool {
    if lane_dir.join("final-status.json").is_file() {
        return true;
    }
    fs::read_dir(lane_dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("final-status.json."))
            })
        })
        .unwrap_or(false)
}

/// (attempts so far, still live) review lanes bound to this cycle's harvest queue.
fn frontier_review_lane_counts(paths: &AppPaths, cycle_id: &str) -> (usize, usize) {
    let (mut total, mut live) = (0usize, 0usize);
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        if !lane_dir.join(FRONTIER_REVIEW_BINDING_FILE).is_file() {
            continue;
        }
        total += 1;
        if !lane_has_ended(&lane_dir) {
            live += 1;
        }
    }
    (total, live)
}

/// Every place `runtime::codex_prompt` reads an abstract-review lane's source
/// directory from, so a lane bound to a queue is recognised however it was made.
fn review_source_dirs(role_plan: &Value) -> Vec<PathBuf> {
    [
        role_plan.pointer("/literature_review_source_dir"),
        role_plan.pointer("/planner_metadata/literature_review_source_dir"),
        role_plan.pointer("/planner_metadata/review_action/literature_review_source_dir"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .map(PathBuf::from)
    .collect()
}

/// Whether a lane that has not ended is ALREADY reviewing this queue -- this
/// dispatch's own lane, or one the generic literature recovery produced from a
/// harvest lane that did hand off normally. Either way: one reviewer at a time.
fn queue_review_lane_is_live(paths: &AppPaths, cycle_id: &str, output_dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return false;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        if !lane_dir.is_dir() || lane_has_ended(&lane_dir) {
            continue;
        }
        let Ok(role_plan) = read_json(&lane_dir.join("role-plan.json")) else {
            continue;
        };
        if role_plan.get("action_type").and_then(Value::as_str) != Some(FRONTIER_REVIEW_ACTION) {
            continue;
        }
        if review_source_dirs(&role_plan).iter().any(|dir| dir == output_dir) {
            return true;
        }
    }
    false
}

/// The directory the harvest published its queue into.
fn harvest_queue_dir(published: &Value) -> Option<PathBuf> {
    if let Some(dir) = text_of(published.get("lane_output_dir")) {
        return Some(PathBuf::from(dir));
    }
    text_of(published.get("source_path"))
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(Path::to_path_buf))
}

fn frontier_review_description(
    queue_path: &Path,
    output_dir: &Path,
    reviews_path: &Path,
    harvest_role_plan: &Path,
    pending: &[Value],
    attempt: usize,
    max_attempts: usize,
) -> String {
    let ids: Vec<String> = pending
        .iter()
        .take(24)
        .map(|item| {
            format!(
                "{} ({})",
                text_of(item.get("paper_id")).unwrap_or("?"),
                text_of(item.get("title"))
                    .map(|title| title.chars().take(70).collect::<String>())
                    .unwrap_or_default()
            )
        })
        .collect();
    format!(
        "FRONTIER HARVEST ABSTRACT REVIEW -- NO RETRIEVAL. Decide every pending candidate in the frontier harvest's own abstract-review queue at {}. \
The harvest already retrieved and stored the FULL abstract of every queued candidate, so this lane performs NO new search: do not run a query probe, an import, or a citation inquiry, and make no network call at all. \
Read each queued candidate's stored abstract in place and write one review per candidate into {}, in the exact shape of the queue's `review_contract`, copying context_hash, objective_hash, paper_id and abstract_sha256 from the queue rather than inventing them. \
EVERY candidate still `pending_abstract_review` in that queue needs a decision -- `directly_relevant` with the quoted study/task, method and outcome passages, or `irrelevant`/`uncertain` with the reason it fails the objective. The harness admits, excludes and drops nothing without one, which is why these {} candidate(s) are holding the deep read, the SOTA cards, expert selection and the lead: {}. \
Then finalize OFFLINE with the interpreter in RESEARCHLAB_PYTHON (python3 if unset) and argv [\"drivers/literature/search.py\", \"--finalize-review-dir\", \"{}\", \"--reviews-file\", \"{}\", \"--role-plan-file\", \"{}\"]. That role plan is the HARVEST lane's, so the objective and its hashes stay the queue's own; do not finalize this queue against this lane's plan. \
Copy abstract-review-queue.json and literature-candidates.json into this lane's own directory and finalize it the same way as well, so this lane carries its own screening audit. \
The screening and quality policy is unchanged: never pad the corpus, never admit a candidate whose abstract you did not read in full, and never resolve a candidate by excluding it without a recorded reason. [attempt {attempt} of {max_attempts}]",
        queue_path.display(),
        reviews_path.display(),
        pending.len(),
        ids.join("; "),
        output_dir.display(),
        reviews_path.display(),
        harvest_role_plan.display(),
    )
}

/// While the published harvest has pending top-K candidates and no live lane is
/// reviewing them, dispatch exactly ONE Codex scout bound to the harvest's queue.
/// Called once per scheduling pass, after `dispatch_frontier_harvest`.
pub(crate) fn dispatch_frontier_review(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !frontier_harvest_enabled() {
        return Ok(Vec::new());
    }
    // The published state, never the harvest lane's final-status/result/run-state:
    // the self-heal renames those away and the handoff went with them.
    let status = frontier_harvest_status(paths, cycle_id);
    if status.state != "pending_review" {
        return Ok(Vec::new());
    }
    let Some(output_dir) = harvest_queue_dir(&status.published) else {
        return Ok(Vec::new());
    };
    let queue_path = output_dir.join(FRONTIER_REVIEW_QUEUE_FILE);
    if !queue_path.is_file() {
        // Nothing to bind a reviewer to; the harvest's own attempts still apply.
        return Ok(Vec::new());
    }
    let (attempts, live) = frontier_review_lane_counts(paths, cycle_id);
    // Never more than one open at a time, and never more than the configured cap.
    let max_attempts = frontier_review_max_attempts();
    if live > 0 || attempts >= max_attempts {
        return Ok(Vec::new());
    }
    if queue_review_lane_is_live(paths, cycle_id, &output_dir) {
        // The harvest lane's own pending_review handoff DID survive this time and
        // the generic literature recovery already bound a reviewer to the queue.
        return Ok(Vec::new());
    }
    let attempt = attempts + 1;
    let harvest_lane_id = text_of(status.published.get("generated_by")).unwrap_or("").to_string();
    let harvest_role_plan = lane_root(paths, cycle_id, &harvest_lane_id).join("role-plan.json");
    let reviews_path = output_dir.join(FRONTIER_REVIEW_REVIEWS_FILE);
    let description = frontier_review_description(
        &queue_path,
        &output_dir,
        &reviews_path,
        &harvest_role_plan,
        &status.pending,
        attempt,
        max_attempts,
    );
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let brief_id = if harvest_lane_id.is_empty() { "frontier-harvest" } else { harvest_lane_id.as_str() };
    let task_body = followup_task_markdown(cycle_id, &objective, "scout", brief_id, &description, &[]);
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
    let contract_path =
        create_lane_contract(paths, cycle_id, &lane_id, "scout", "codex-agent", "read-write-scoped", &task_body)?;
    let pending_paper_ids: Vec<Value> = status
        .pending
        .iter()
        .map(|item| item.get("paper_id").cloned().unwrap_or(Value::Null))
        .collect();
    let review_contract = json!({
        "cycle_id": cycle_id,
        "harvest_lane_id": harvest_lane_id,
        "harvest_state_path": status.path,
        "harvest_role_plan_path": harvest_role_plan,
        "lane_output_dir": output_dir,
        "queue_path": queue_path,
        "reviews_path": reviews_path,
        "pending_paper_ids": pending_paper_ids,
        "attempt": attempt,
        "max_attempts": max_attempts,
        "retrieval_allowed": false,
        "rule": "Every queued candidate still pending_abstract_review needs an admit or exclude decision with a reason. The abstracts are already stored in the queue, so no retrieval is needed or permitted.",
    });
    // The binding marker: what makes this lane countable as the harvest's review
    // lane on the next pass, independently of any file the self-heal renames.
    write_json(
        &lane_root(paths, cycle_id, &lane_id).join(FRONTIER_REVIEW_BINDING_FILE),
        &json!({ "lane_id": lane_id, "bound_at": now_iso(), "frontier_review_contract": review_contract }),
    )?;
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        assigned_model_for_role("scout", "codex-agent"),
        &objective,
        brief_id,
        &description,
        FRONTIER_REVIEW_ACTION,
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "frontier_harvest_review_gate",
            "preferred_role": "scout",
            "selection_scope": "open",
            // Read by runtime::codex_prompt to render the abstract-review
            // recovery clause, and by the literature agent to inherit a journal.
            "literature_review_source_dir": output_dir,
            "review_action": {
                "type": FRONTIER_REVIEW_ACTION,
                "source_lane_id": harvest_lane_id,
                "literature_review_source_dir": output_dir,
                "literature_review_queue_path": queue_path,
                "literature_review_role_plan_path": harvest_role_plan,
                "description": description,
            },
            "frontier_review_contract": review_contract,
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "scout",
        "contract_path": contract_path,
        "source_brief_id": brief_id,
        "role_plan_path": role_plan_path,
        "action_type": FRONTIER_REVIEW_ACTION,
    })])
}

/// What the director and the selection panel are told about the harvest.
pub(crate) fn frontier_harvest_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let status = frontier_harvest_status(paths, cycle_id);
    let (since, horizon_source) = match status.published.get("since").and_then(Value::as_str) {
        Some(since) => (
            since.to_string(),
            status.published.get("horizon_source").cloned().unwrap_or(Value::Null),
        ),
        None => {
            let (since, source) = cycle_knowledge_horizon(paths, cycle_id);
            (since.to_string(), json!(source))
        }
    };
    let top_k: Vec<Value> = status
        .published
        .get("top_k")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(30)
        .map(|item| {
            json!({
                "paper_id": item.get("paper_id").cloned().unwrap_or(Value::Null),
                "admitted_paper_id": item.pointer("/admitted/paper_id").cloned().unwrap_or(Value::Null),
                "title": item.get("title").cloned().unwrap_or(Value::Null),
                "publication_date": item.get("publication_date").cloned().unwrap_or(Value::Null),
                "co_citation": item.get("co_citation").cloned().unwrap_or(Value::Null),
                "velocity": item.get("velocity").cloned().unwrap_or(Value::Null),
                "score": item.get("score").cloned().unwrap_or(Value::Null),
                "review_status": item.get("review_status").cloned().unwrap_or_else(|| json!("pending")),
                "review_reason": item.get("review_reason").cloned().unwrap_or(Value::Null),
                "post_horizon": true,
            })
        })
        .collect();
    let review_lanes = frontier_review_lane_counts(paths, cycle_id);
    json!({
        "enabled": frontier_harvest_enabled(),
        "status": status.state,
        "settled": status.settled,
        "state_path": status.path,
        "since": since,
        "horizon_source": horizon_source,
        "truncated_anchors": status.published.get("truncated_anchors").cloned().unwrap_or_else(|| json!([])),
        "unresolved_anchors": status.published.get("unresolved_anchors").cloned().unwrap_or_else(|| json!([])),
        "top_k": top_k,
        "pending_review": status.pending.len(),
        "review_lanes_dispatched": review_lanes.0,
        "review_lane_open": review_lanes.1 > 0,
        "rule": "Papers with post_horizon=true were published after the model's knowledge horizon and reached this cycle only through the forward-citation frontier harvest from the landscape's canonical works. The names anyone can recall predate that horizon: never treat a subfield's frontier as covered from recall alone. While any top-K candidate is pending review, no deep read, expert selection or lead proceeds.",
    })
}

/// One clause, for the landscape and deep-read protocols.
pub(crate) fn frontier_recall_clause() -> String {
    "The works you can name from memory predate your knowledge horizon; frontier work published after it reaches this cycle only through the frontier harvest (the harness's forward-citation harvest from the landscape's verified canonical works, reviewed like any candidate, flagged post_horizon) -- never claim a subfield's frontier is covered from recall alone.".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            project_root: root.join("project"),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("data"),
            stats_driver_script: root.join("stats.py"),
            literature_driver_script: root.join("literature.py"),
        }
    }

    #[test]
    fn the_horizon_is_configuration_not_a_date_in_code() {
        let cycle = chrono::NaiveDate::from_ymd_opt(2026, 9, 19).unwrap();
        // Without the owner's horizon the window applies (unless the environment
        // running the tests configured one, in which case it wins).
        let (since, source) = knowledge_horizon_for(cycle);
        if env::var_os("RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON").is_none()
            && env::var_os("RESEARCHLAB_FRONTIER_WINDOW_MONTHS").is_none()
        {
            assert_eq!(since, chrono::NaiveDate::from_ymd_opt(2025, 3, 19).unwrap());
            assert!(source.contains("minus 18 months"), "{source}");
        }
    }

    #[test]
    fn anchors_are_the_verified_canonical_works_with_their_subfields() {
        let landscape = valid_field_landscape_fixture("c");
        let anchors = landscape_anchors(&landscape);
        assert_eq!(anchors.len(), 9);
        assert_eq!(anchors[0]["paper_id"], json!("doi:10.1/sf0-c0"));
        assert_eq!(anchors[0]["subfield_ids"], json!(["sf0"]));
        // A canonical work the gate did not verify is not an anchor.
        let mut unverified = landscape.clone();
        unverified["verified_papers"].as_object_mut().unwrap().remove("doi:10.1/sf0-c0");
        assert_eq!(landscape_anchors(&unverified).len(), 8);
    }

    #[test]
    fn aliases_match_the_driver_scheme() {
        let paper = json!({"doi": "10.48550/arXiv.2602.16863", "arxiv_id": "2602.16863v2",
                           "semanticscholar_id": "9242B2", "title": "SimToolReal: An Object-Centric Policy"});
        assert_eq!(
            paper_aliases(&paper),
            vec!["doi:10.48550/arxiv.2602.16863", "arxiv:2602.16863", "s2:9242b2", "title:simtoolreal an object centric policy"]
        );
    }

    fn harvest_lane(paths: &AppPaths, cycle: &str, lane: &str) -> LaneContract {
        let dir = lane_root(paths, cycle, lane);
        fs::create_dir_all(&dir).unwrap();
        let output = external_artifacts_root(paths, cycle, lane);
        fs::create_dir_all(&output).unwrap();
        LaneContract {
            cycle_id: cycle.to_string(),
            lane_id: lane.to_string(),
            role: "scout".to_string(),
            runtime_class: "external-driver".to_string(),
            mode: "driver-exec".to_string(),
            cwd: paths.project_root.clone(),
            task_file: dir.join("task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![output.clone()],
            output_artifact: Some(output.join("result.json")),
            fallback_strategy: None,
        }
    }

    fn candidate(rank: usize, arxiv: &str, title: &str, top_k: bool) -> Value {
        json!({
            "rank": rank, "top_k": top_k, "paper_id": format!("doi:10.48550/arxiv.{arxiv}"),
            "aliases": [format!("doi:10.48550/arxiv.{arxiv}"), format!("arxiv:{arxiv}"), format!("title:{}", normalized_title(title))],
            "title": title, "publication_date": "2026-02-18", "year": 2026, "post_horizon": true,
            "co_citation": 5, "cites_anchors": ["doi:10.1/sf0-c0", "doi:10.1/sf1-c0"], "score": 4.46, "velocity": 2.43,
        })
    }

    /// The measured failure: a harvested candidate nobody reviews holds every
    /// later stage, visibly, until a lane reviews it or excludes it with a reason.
    #[test]
    fn no_harvested_top_k_candidate_is_silently_dropped() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-no-silent-drop";
        fs::create_dir_all(state_root(&paths)).unwrap();
        write_json(&field_landscape_state_path(&paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
        let contract = harvest_lane(&paths, cycle, "followup-scout-02");
        let output = contract.output_artifact.as_ref().unwrap().parent().unwrap().to_path_buf();
        write_json(
            &output.join(FRONTIER_CANDIDATES_FILE),
            &json!({
                "since": "2025-11-01",
                "candidates": [
                    candidate(1, "2602.16863", "SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation", true),
                    candidate(2, "2601.00001", "A second frontier paper", true),
                    candidate(3, "2601.00002", "Below the cut", false),
                ],
            }),
        )
        .unwrap();
        let plan = json!({"action_type": FRONTIER_HARVEST_ACTION, "planner_metadata": {"frontier_harvest_contract": {
            "anchors": [{"paper_id": "doi:10.1/sf0-c0", "subfield_ids": ["sf0"]}, {"paper_id": "doi:10.1/sf1-c0", "subfield_ids": ["sf1"]}]}}});
        project_frontier_harvest(&paths, &contract, Some(&plan)).unwrap().unwrap();
        let status = frontier_harvest_status(&paths, cycle);
        assert_eq!(status.state, "pending_review");
        assert_eq!(status.pending.len(), 2, "only the top-K is owed a review");
        assert!(!status.settled);
        let reasons = frontier_harvest_block_reasons(&paths, cycle);
        assert!(reasons[0].starts_with("frontier_harvest_unreviewed: 2 harvested top-K candidate(s)"), "{reasons:?}");
        // The lead gate refuses while they are pending.
        let landscape = field_landscape_status(&paths, cycle);
        let refused = lead_landscape_rejection_reasons(&json!({}), &landscape, &field_landscape_thresholds());
        assert!(refused.iter().any(|reason| reason.starts_with("frontier_harvest_unreviewed")), "{refused:?}");

        // An exclusion WITHOUT a reason resolves nothing.
        let review_dir = lane_root(&paths, cycle, "followup-scout-03");
        fs::create_dir_all(&review_dir).unwrap();
        write_json(
            &review_dir.join("literature-screening-audit.json"),
            &json!({"excluded": [{"paper": {"doi": "10.48550/arXiv.2601.00001", "title": "A second frontier paper"}}], "quarantined": []}),
        )
        .unwrap();
        refresh_frontier_harvest_state(&paths, cycle).unwrap();
        assert_eq!(frontier_harvest_status(&paths, cycle).pending.len(), 2);

        // A review lane accepts one and excludes the other with a reason.
        write_json(
            &review_dir.join("literature-screening-audit.json"),
            &json!({"excluded": [{"paper": {"doi": "10.48550/arXiv.2601.00001", "title": "A second frontier paper"},
                                   "reasons": ["abstract_review_irrelevant"]}], "quarantined": []}),
        )
        .unwrap();
        write_json(
            &review_dir.join("papers.json"),
            &json!([{"title": "SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation",
                     "arxiv_id": "2602.16863", "year": 2026, "doi": "10.48550/arXiv.2602.16863",
                     "literature_screening": {"status": "accepted", "review": {"paper_id": "doi:10.48550/arxiv.2602.16863",
                                                                              "direct_relevance_reason": "dexterous tool use from sim"}}}]),
        )
        .unwrap();
        dispatch_frontier_harvest(&paths, cycle).unwrap();
        let status = frontier_harvest_status(&paths, cycle);
        assert_eq!(status.state, "resolved", "{}", status.published);
        assert!(status.settled);
        assert!(frontier_harvest_block_reasons(&paths, cycle).is_empty());
        let top = status.published["top_k"].as_array().unwrap();
        assert_eq!(top[0]["review_status"], json!("accepted"));
        assert_eq!(top[1]["review_status"], json!("excluded"));
        assert_eq!(top[1]["review_reason"], json!("abstract_review_irrelevant"));

        // The admitted paper joins the landscape, flagged post-horizon, citable by a lead.
        let admitted = frontier_admitted_papers(&paths, cycle);
        assert_eq!(admitted.len(), 1);
        assert_eq!(admitted[0]["subfield_ids"], json!(["sf0", "sf1"]));
        let landscape = field_landscape_status(&paths, cycle);
        let key = "doi:10.48550/arxiv.2602.16863";
        assert_eq!(landscape.landscape["verified_papers"][key]["post_horizon"], json!(true));
        assert!(landscape.validation.landscape_paper_keys.contains(key));
        assert!(landscape.validation.frontier_paper_keys.contains(key));
        let context = field_landscape_director_context(&paths, cycle);
        let paper = context["papers"].as_array().unwrap().iter().find(|paper| paper["paper_id"] == json!(key)).unwrap().clone();
        assert_eq!(paper["post_horizon"], json!(true));
        assert_eq!(context["frontier_harvest"]["status"], json!("resolved"));
    }

    #[test]
    fn the_harvest_is_dispatched_once_from_a_valid_landscape_as_a_driver_lane() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-dispatch";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
        fs::create_dir_all(plans_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
            &json!({"objective": "Pick ONE falsifiable question across manipulation and sim-to-real.", "created_at": "2026-09-19T13:20:06Z"}),
        )
        .unwrap();
        assert!(dispatch_frontier_harvest(&paths, cycle).unwrap().is_empty(), "no landscape yet");
        write_json(&field_landscape_state_path(&paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
        let created = dispatch_frontier_harvest(&paths, cycle).unwrap();
        assert_eq!(created.len(), 1);
        let lane_id = created[0]["lane_id"].as_str().unwrap().to_string();
        let contract = read_json(&lane_root(&paths, cycle, &lane_id).join("lane-contract.json")).unwrap();
        assert_eq!(contract["runtime_class"], json!("external-driver"));
        let role_plan = read_json(&lane_role_plan_path(&paths, cycle, &lane_id)).unwrap();
        assert_eq!(role_plan["action_type"], json!(FRONTIER_HARVEST_ACTION));
        let harvest = &role_plan["planner_metadata"]["frontier_harvest_contract"];
        assert_eq!(harvest["anchors"].as_array().unwrap().len(), 9);
        if env::var_os("RESEARCHLAB_MODEL_KNOWLEDGE_HORIZON").is_none() && env::var_os("RESEARCHLAB_FRONTIER_WINDOW_MONTHS").is_none() {
            assert_eq!(harvest["since"], json!("2025-03-19"));
        }
        let anchors = read_json(Path::new(harvest["anchors_file"].as_str().unwrap())).unwrap();
        assert_eq!(anchors["anchors"].as_array().unwrap().len(), 9);
        // The stages after it wait for it.
        assert!(!frontier_harvest_status(&paths, cycle).settled);
        // One at a time.
        assert!(dispatch_frontier_harvest(&paths, cycle).unwrap().is_empty());
    }

    /// A published harvest with two pending top-K candidates and the queue the
    /// harvest wrote beside them, abstracts already in it.
    fn published_harvest_with_queue(paths: &AppPaths, cycle: &str) -> PathBuf {
        fs::create_dir_all(state_root(paths)).unwrap();
        fs::create_dir_all(cycle_lanes_root(paths, cycle)).unwrap();
        fs::create_dir_all(plans_root(paths)).unwrap();
        write_json(&field_landscape_state_path(paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
        let contract = harvest_lane(paths, cycle, "followup-scout-02");
        let output = contract.output_artifact.as_ref().unwrap().parent().unwrap().to_path_buf();
        write_json(
            &output.join(FRONTIER_CANDIDATES_FILE),
            &json!({
                "since": "2025-11-01",
                "candidates": [
                    candidate(1, "2602.16863", "SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation", true),
                    candidate(2, "2601.00001", "A second frontier paper", true),
                ],
            }),
        )
        .unwrap();
        write_json(
            &output.join(FRONTIER_REVIEW_QUEUE_FILE),
            &json!({
                "manifest": {"objective": "the cycle objective", "objective_hash": "obj", "context_hash": "ctx"},
                "review_contract": {"policy_version": "abstract-direct-relevance-v1"},
                "candidates": [
                    {"paper_id": "doi:10.48550/arxiv.2602.16863", "status": "pending_abstract_review",
                     "paper": {"abstract": "a stored full abstract"}},
                    {"paper_id": "doi:10.48550/arxiv.2601.00001", "status": "pending_abstract_review",
                     "paper": {"abstract": "another stored full abstract"}},
                ],
            }),
        )
        .unwrap();
        let plan = json!({"action_type": FRONTIER_HARVEST_ACTION, "planner_metadata": {"frontier_harvest_contract": {
            "anchors": [{"paper_id": "doi:10.1/sf0-c0", "subfield_ids": ["sf0"]}]}}});
        project_frontier_harvest(paths, &contract, Some(&plan)).unwrap().unwrap();
        output
    }

    /// End a lane the way the orchestrator's self-healing does: the terminal
    /// marker is RENAMED, not written.
    fn end_lane_by_self_heal(lane_dir: &Path) {
        fs::write(lane_dir.join("final-status.json.self-heal-2026-09-19T16-22-43-875Z.bak"), "{}").unwrap();
        fs::write(lane_dir.join("result.json.self-heal-2026-09-19T16-22-43-875Z.bak"), "{}").unwrap();
    }

    /// The measured stall: the harvest queued its top-K with abstracts, the
    /// self-heal erased the lane's pending_review handoff, and no lane was ever
    /// bound to the queue. The published state is enough to bind one.
    #[test]
    fn a_pending_harvest_queue_gets_exactly_one_bound_review_lane() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-review-dispatch";
        let output = published_harvest_with_queue(&paths, cycle);
        // The harvest lane's own final-status/result were renamed away, so the
        // pending_review handoff that would have produced this lane is gone.
        end_lane_by_self_heal(&lane_root(&paths, cycle, "followup-scout-02"));
        assert_eq!(frontier_harvest_status(&paths, cycle).state, "pending_review");

        let created = dispatch_frontier_review(&paths, cycle).unwrap();
        assert_eq!(created.len(), 1, "{created:?}");
        assert_eq!(created[0]["action_type"], json!(FRONTIER_REVIEW_ACTION));
        let lane_id = created[0]["lane_id"].as_str().unwrap().to_string();
        let lane_dir = lane_root(&paths, cycle, &lane_id);
        let contract = read_json(&lane_dir.join("lane-contract.json")).unwrap();
        assert_eq!(contract["runtime_class"], json!("codex-agent"));
        assert_eq!(contract["role"], json!("scout"));
        let role_plan = read_json(&lane_dir.join("role-plan.json")).unwrap();
        assert_eq!(role_plan["action_type"], json!(FRONTIER_REVIEW_ACTION));
        let bound = &role_plan["planner_metadata"]["frontier_review_contract"];
        assert_eq!(bound["lane_output_dir"], json!(output));
        assert_eq!(bound["queue_path"], json!(output.join(FRONTIER_REVIEW_QUEUE_FILE)));
        assert_eq!(bound["retrieval_allowed"], json!(false));
        assert_eq!(bound["attempt"], json!(1));
        assert_eq!(bound["pending_paper_ids"].as_array().unwrap().len(), 2);
        // The recovery clause the Codex prompt renders reads this.
        assert_eq!(
            role_plan["planner_metadata"]["review_action"]["literature_review_source_dir"],
            json!(output)
        );
        assert!(lane_dir.join(FRONTIER_REVIEW_BINDING_FILE).is_file());
        // The task names the queue, the finalize command, the no-retrieval rule
        // and the decision it owes every pending candidate.
        let task = fs::read_to_string(lane_dir.join("task.md")).unwrap();
        for needle in [
            output.join(FRONTIER_REVIEW_QUEUE_FILE).display().to_string(),
            "--finalize-review-dir".to_string(),
            "--reviews-file".to_string(),
            "NO new search".to_string(),
            "pending_abstract_review".to_string(),
            "doi:10.48550/arxiv.2602.16863".to_string(),
        ] {
            assert!(task.contains(&needle), "task.md is missing {needle}: {task}");
        }
        // One at a time: a second pass while that lane is live adds nothing.
        assert!(dispatch_frontier_review(&paths, cycle).unwrap().is_empty());
    }

    /// A reviewer the GENERIC literature recovery already bound to the same queue
    /// (the harvest lane handed off normally) is not doubled by this dispatch.
    #[test]
    fn a_reviewer_the_generic_recovery_already_bound_is_not_doubled() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-review-no-double";
        let output = published_harvest_with_queue(&paths, cycle);
        let existing = lane_root(&paths, cycle, "followup-scout-07");
        fs::create_dir_all(&existing).unwrap();
        write_json(
            &existing.join("role-plan.json"),
            &json!({"action_type": FRONTIER_REVIEW_ACTION, "role": "scout",
                    "planner_metadata": {"review_action": {"literature_review_source_dir": output}}}),
        )
        .unwrap();
        assert!(dispatch_frontier_review(&paths, cycle).unwrap().is_empty());
        // Once it has ended without resolving them, the dispatch takes over.
        end_lane_by_self_heal(&existing);
        assert_eq!(dispatch_frontier_review(&paths, cycle).unwrap().len(), 1);
    }

    #[test]
    fn a_resolved_harvest_asks_for_no_review_lane() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-review-resolved";
        published_harvest_with_queue(&paths, cycle);
        // One accepted, one excluded WITH a reason: nothing is owed a review.
        let review_dir = lane_root(&paths, cycle, "followup-scout-03");
        fs::create_dir_all(&review_dir).unwrap();
        write_json(
            &review_dir.join("literature-screening-audit.json"),
            &json!({"excluded": [{"paper": {"doi": "10.48550/arXiv.2601.00001", "title": "A second frontier paper"},
                                   "reasons": ["abstract_review_irrelevant"]}], "quarantined": []}),
        )
        .unwrap();
        write_json(
            &review_dir.join("papers.json"),
            &json!([{"title": "SimToolReal: An Object-Centric Policy for Zero-Shot Dexterous Tool Manipulation",
                     "arxiv_id": "2602.16863", "year": 2026, "doi": "10.48550/arXiv.2602.16863",
                     "literature_screening": {"status": "accepted", "review": {"paper_id": "doi:10.48550/arxiv.2602.16863",
                                                                              "direct_relevance_reason": "dexterous tool use from sim"}}}]),
        )
        .unwrap();
        refresh_frontier_harvest_state(&paths, cycle).unwrap();
        assert_eq!(frontier_harvest_status(&paths, cycle).state, "resolved");
        assert!(dispatch_frontier_review(&paths, cycle).unwrap().is_empty());
    }

    /// A queue nobody can review must not cost the cycle unbounded lanes.
    #[test]
    fn the_review_attempt_cap_holds() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "frontier-review-cap";
        published_harvest_with_queue(&paths, cycle);
        let cap = frontier_review_max_attempts();
        for attempt in 1..=cap {
            let created = dispatch_frontier_review(&paths, cycle).unwrap();
            assert_eq!(created.len(), 1, "attempt {attempt} of {cap}: {created:?}");
            let lane_id = created[0]["lane_id"].as_str().unwrap().to_string();
            let lane_dir = lane_root(&paths, cycle, &lane_id);
            let bound = read_json(&lane_dir.join("role-plan.json")).unwrap();
            assert_eq!(bound["planner_metadata"]["frontier_review_contract"]["attempt"], json!(attempt));
            // The lane ends without resolving them -- and the self-heal renames
            // its terminal marker, which must still read as ENDED.
            end_lane_by_self_heal(&lane_dir);
            assert!(lane_has_ended(&lane_dir));
        }
        assert!(dispatch_frontier_review(&paths, cycle).unwrap().is_empty(), "the cap of {cap} did not hold");
        assert_eq!(frontier_review_lane_counts(&paths, cycle), (cap, 0));
        // The candidates are still owed a review; the block reason stands.
        assert!(!frontier_harvest_block_reasons(&paths, cycle).is_empty());
    }

    #[test]
    fn the_protocols_carry_the_recall_clause() {
        let landscape = field_landscape_scout_protocol(Path::new("/lane"), Path::new("/lane/role-plan.json"));
        let deep_read = crate::labdirector::sota_deep_read_scout_protocol(Path::new("/lane"), Path::new("/lane/role-plan.json"));
        for protocol in [landscape, deep_read] {
            assert!(protocol.contains("predate your knowledge horizon"), "{protocol}");
            assert!(protocol.contains("never claim a subfield's frontier is covered from recall alone"));
        }
    }
}
