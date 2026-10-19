#![allow(unused_imports)]
use super::*;
use std::collections::BTreeSet;

// --- field landscape --------------------------------------------------------------
//
// The field is surveyed before any lead is chosen, and the lead has to answer a
// problem the survey found.
//
// MEASURED ON cycle-b-20260918, 2026-09-18/19. The objective asked for ONE
// falsifiable question across manipulation, legged locomotion, sim-to-real,
// contact safety and language/vision-conditioned policies. There was never a
// field-wide survey: the very first scout query was already "robotic grasping
// domain randomization reinforcement learning sim-to-real object pose", the
// direction the most ready instrument in the objective (a copied SuperDex xArm
// grasp simulator with a trained PPO policy) pointed at. lab-director-01 recorded
// "only one admitted 2021 review, no recent-frontier papers" and then told the
// scouts "Do not restart broad acquisition". 290 papers were admitted and none of
// the field's SOTA -- Diffusion Policy, RT-2, OpenVLA, pi0, Octo, ACT/ALOHA, Open
// X-Embodiment, DROID, ManiSkill3, Eureka, RMA, legged_gym -- was ever retrieved.
// The lead ended as a question about whether a guard-triggered early termination
// overstates one checkpoint's advantage in that one simulator: a problem chosen by
// instrument availability, not by a frontier gap.
//
// So three things, all deterministic:
//   * a landscape scout is dispatched at cycle start and whenever the landscape is
//     missing or invalid (`dispatch_field_landscape_scout`);
//   * its landscape is validated here, against the papers the screening gate
//     itself admitted, and published to `<cycle>-field-landscape.json`;
//   * the lead projection refuses a selection or replacement until that landscape
//     is valid, and refuses a lead that does not name one of its open problems and
//     cite enough of its papers, at least one of them frontier work.
// Instrument fit is recorded per open problem as an annotation. It is never the
// selection criterion.

pub(crate) const FIELD_LANDSCAPE_SCOUT_ACTION: &str = "field_landscape_scout";
pub(crate) const FIELD_LANDSCAPE_OUTPUT_FILE: &str = "field-landscape.json";
const REJECTIONS_KEPT: usize = 5;
const ATTEMPTS_KEPT: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FieldLandscapeThresholds {
    pub(crate) min_subfields: usize,
    pub(crate) canonical_per_subfield: usize,
    pub(crate) frontier_per_subfield: usize,
    pub(crate) frontier_year: i64,
    pub(crate) min_lead_citations: usize,
    pub(crate) max_attempts: usize,
}

impl Default for FieldLandscapeThresholds {
    fn default() -> Self {
        Self {
            min_subfields: 3,
            canonical_per_subfield: 3,
            frontier_per_subfield: 5,
            frontier_year: 2024,
            min_lead_citations: 3,
            max_attempts: 3,
        }
    }
}

impl FieldLandscapeThresholds {
    pub(crate) fn as_value(&self) -> Value {
        json!({
            "min_subfields": self.min_subfields,
            "canonical_per_subfield": self.canonical_per_subfield,
            "frontier_per_subfield": self.frontier_per_subfield,
            "frontier_year": self.frontier_year,
            "min_lead_citations": self.min_lead_citations,
            "max_attempts": self.max_attempts,
        })
    }
}

fn env_number<T: std::str::FromStr>(name: &str) -> Option<T> {
    env::var(name).ok().and_then(|raw| raw.trim().parse::<T>().ok())
}

/// The thresholds in force, each overridable from the environment.
pub(crate) fn field_landscape_thresholds() -> FieldLandscapeThresholds {
    let defaults = FieldLandscapeThresholds::default();
    FieldLandscapeThresholds {
        min_subfields: env_number::<usize>("RESEARCHLAB_FIELD_LANDSCAPE_MIN_SUBFIELDS")
            .filter(|value| *value > 0)
            .unwrap_or(defaults.min_subfields),
        canonical_per_subfield: env_number("RESEARCHLAB_FIELD_LANDSCAPE_CANONICAL_PER_SUBFIELD")
            .unwrap_or(defaults.canonical_per_subfield),
        frontier_per_subfield: env_number("RESEARCHLAB_FIELD_LANDSCAPE_FRONTIER_PER_SUBFIELD")
            .unwrap_or(defaults.frontier_per_subfield),
        frontier_year: env_number("RESEARCHLAB_FIELD_LANDSCAPE_FRONTIER_YEAR")
            .unwrap_or(defaults.frontier_year),
        min_lead_citations: env_number("RESEARCHLAB_FIELD_LANDSCAPE_MIN_LEAD_CITATIONS")
            .unwrap_or(defaults.min_lead_citations),
        max_attempts: env_number("RESEARCHLAB_FIELD_LANDSCAPE_MAX_ATTEMPTS")
            .unwrap_or(defaults.max_attempts),
    }
}

/// On unless the owner turns it off. `0`, `false`, `off` and `no` disable both the
/// dispatch and the selection gate.
pub(crate) fn field_landscape_gate_enabled() -> bool {
    !matches!(
        env::var("RESEARCHLAB_FIELD_LANDSCAPE_GATE")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

pub(crate) fn field_landscape_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-field-landscape.json"))
}

fn field_landscape_attempts_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-field-landscape-attempts.json"))
}

pub(crate) fn lead_selection_rejections_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-lead-selection-rejections.json"))
}

/// Ids are compared the way the screening gate stamps them, ignoring case and
/// surrounding space -- `doi:10.1/X` and `doi:10.1/x` are one paper.
fn paper_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

fn nonempty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn paper_year(paper: &Value) -> Option<i64> {
    let from_value = |value: &Value| -> Option<i64> {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.trim().get(..4)?.parse().ok()))
    };
    paper
        .get("year")
        .and_then(from_value)
        .or_else(|| paper.get("publication_year").and_then(from_value))
        .or_else(|| paper.get("publication_date").and_then(from_value))
}

/// The id the screening gate validated for an admitted paper, if it admitted it.
///
/// Same identity as `citable_paper_id` in the decision digest: the gate stamps it
/// at `literature_screening.review.paper_id`. A paper the gate reviewed and did not
/// accept, or whose abstract was not read in full, is not admitted.
fn admitted_paper_id(paper: &Value) -> Option<String> {
    let screening = paper.get("literature_screening");
    let id = nonempty_str(paper.pointer("/literature_screening/review/paper_id"))
        .or_else(|| nonempty_str(paper.get("paper_id")))?;
    if let Some(status) = screening.and_then(|item| item.get("status")).and_then(Value::as_str) {
        if status != "accepted" {
            return None;
        }
    } else if screening.and_then(|item| item.get("review")).is_none() {
        return None;
    }
    if paper.pointer("/literature_screening/review/abstract_read_in_full")
        == Some(&Value::Bool(false))
    {
        return None;
    }
    Some(id.to_string())
}

/// Admitted papers from any list of paper records, keyed by `paper_key`.
pub(crate) fn admitted_paper_registry(papers: &[Value]) -> serde_json::Map<String, Value> {
    let mut registry = serde_json::Map::new();
    for paper in papers {
        let Some(id) = admitted_paper_id(paper) else {
            continue;
        };
        registry.insert(
            paper_key(&id),
            json!({
                "paper_id": id,
                "title": paper.get("title").cloned().unwrap_or(Value::Null),
                "year": paper_year(paper),
            }),
        );
    }
    registry
}

fn paper_array(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .cloned()
        .or_else(|| value.get("papers").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// Every paper this cycle's screening gate has admitted that the landscape lane
/// can see: its own finalized `papers.json` and the cycle literature summary.
fn cycle_admitted_papers(paths: &AppPaths, cycle_id: &str, lane_dir: &Path) -> Vec<Value> {
    let mut papers = read_json(&lane_dir.join("papers.json"))
        .map(|value| paper_array(&value))
        .unwrap_or_default();
    if let Ok(summary) =
        read_json(&state_root(paths).join(format!("{cycle_id}-literature-summary.json")))
    {
        for track in ["recent_frontier_papers", "established_impact_papers", "papers"] {
            if let Some(items) = summary.get(track).and_then(Value::as_array) {
                papers.extend(items.iter().cloned());
            }
        }
    }
    papers
}

#[derive(Clone, Debug, Default)]
pub(crate) struct FieldLandscapeValidation {
    pub(crate) valid: bool,
    pub(crate) reasons: Vec<String>,
    pub(crate) warnings: Vec<String>,
    pub(crate) open_problem_ids: BTreeSet<String>,
    /// Every verified paper the landscape names, by `paper_key`.
    pub(crate) landscape_paper_keys: BTreeSet<String>,
    /// The subset whose admitted record is dated at or after the frontier year.
    pub(crate) frontier_paper_keys: BTreeSet<String>,
    pub(crate) subfield_counts: Vec<Value>,
}

impl FieldLandscapeValidation {
    pub(crate) fn as_value(&self) -> Value {
        json!({
            "valid": self.valid,
            "reasons": self.reasons,
            "warnings": self.warnings.iter().take(40).collect::<Vec<_>>(),
            "open_problem_ids": self.open_problem_ids,
            "landscape_paper_count": self.landscape_paper_keys.len(),
            "frontier_paper_count": self.frontier_paper_keys.len(),
            "subfield_counts": self.subfield_counts,
        })
    }
}

fn entry_paper_ids(entry: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(id) = nonempty_str(entry.get("paper_id")) {
        ids.push(id.to_string());
    }
    if let Some(items) = entry.get("paper_ids").and_then(Value::as_array) {
        ids.extend(items.iter().filter_map(|item| nonempty_str(Some(item))).map(ToString::to_string));
    }
    ids
}

/// Deterministic validation of a landscape against the admitted papers.
///
/// `verified` maps `paper_key` to the admitted record (`year` is read from it,
/// never from what the landscape claims). A paper the gate did not admit is a
/// warning and counts for nothing.
pub(crate) fn validate_field_landscape(
    landscape: &Value,
    verified: &serde_json::Map<String, Value>,
    thresholds: &FieldLandscapeThresholds,
) -> FieldLandscapeValidation {
    let mut out = FieldLandscapeValidation::default();
    let verified_year = |key: &str| verified.get(key).and_then(|paper| paper.get("year")).and_then(Value::as_i64);
    let Some(subfields) = landscape.get("subfields").and_then(Value::as_array) else {
        out.reasons.push("subfields[] is missing".to_string());
        return out;
    };
    let mut subfield_ids = BTreeSet::new();
    for (index, subfield) in subfields.iter().enumerate() {
        let Some(subfield_id) =
            nonempty_str(subfield.get("subfield_id")).or_else(|| nonempty_str(subfield.get("name")))
        else {
            out.reasons.push(format!("subfields[{index}] has no subfield_id"));
            continue;
        };
        if !subfield_ids.insert(subfield_id.to_string()) {
            out.reasons.push(format!("subfield_id '{subfield_id}' is used twice"));
            continue;
        }
        let note_unverified = |kind: &str, id: &str, out: &mut FieldLandscapeValidation| {
            out.warnings.push(format!(
                "subfield {subfield_id}: {kind} paper_id '{id}' is not an admitted, abstract-reviewed paper of this cycle"
            ));
        };

        let mut canonical = BTreeSet::new();
        for entry in subfield.get("canonical_works").and_then(Value::as_array).into_iter().flatten() {
            for id in entry_paper_ids(entry) {
                let key = paper_key(&id);
                if verified.contains_key(&key) {
                    out.landscape_paper_keys.insert(key.clone());
                    if verified_year(&key).is_some_and(|year| year >= thresholds.frontier_year) {
                        out.frontier_paper_keys.insert(key.clone());
                    }
                    canonical.insert(key);
                } else {
                    note_unverified("canonical", &id, &mut out);
                }
            }
        }
        let mut frontier = BTreeSet::new();
        for entry in subfield.get("frontier_works").and_then(Value::as_array).into_iter().flatten() {
            for id in entry_paper_ids(entry) {
                let key = paper_key(&id);
                if !verified.contains_key(&key) {
                    note_unverified("frontier", &id, &mut out);
                    continue;
                }
                out.landscape_paper_keys.insert(key.clone());
                match verified_year(&key) {
                    Some(year) if year >= thresholds.frontier_year => {
                        out.frontier_paper_keys.insert(key.clone());
                        frontier.insert(key);
                    }
                    year => out.warnings.push(format!(
                        "subfield {subfield_id}: frontier paper_id '{id}' has admitted year {} (< {})",
                        year.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string()),
                        thresholds.frontier_year
                    )),
                }
            }
        }
        if canonical.len() < thresholds.canonical_per_subfield {
            out.reasons.push(format!(
                "subfield {subfield_id}: {} verified canonical work(s), at least {} required",
                canonical.len(),
                thresholds.canonical_per_subfield
            ));
        }
        if frontier.len() < thresholds.frontier_per_subfield {
            out.reasons.push(format!(
                "subfield {subfield_id}: {} verified frontier work(s) dated {}+, at least {} required",
                frontier.len(),
                thresholds.frontier_year,
                thresholds.frontier_per_subfield
            ));
        }
        let approaches = subfield
            .get("dominant_approaches")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if approaches == 0 {
            out.reasons.push(format!("subfield {subfield_id}: dominant_approaches[] is empty"));
        }
        for key in ["dominant_approaches", "benchmarks"] {
            for entry in subfield.get(key).and_then(Value::as_array).into_iter().flatten() {
                for id in entry_paper_ids(entry) {
                    let paper = paper_key(&id);
                    if verified.contains_key(&paper) {
                        out.landscape_paper_keys.insert(paper.clone());
                        if verified_year(&paper).is_some_and(|year| year >= thresholds.frontier_year) {
                            out.frontier_paper_keys.insert(paper);
                        }
                    }
                }
            }
        }
        match subfield.get("benchmarks") {
            Some(Value::Array(items)) if items.is_empty() => out
                .warnings
                .push(format!("subfield {subfield_id}: benchmarks[] is empty")),
            Some(Value::Array(_)) => {}
            _ => out.reasons.push(format!("subfield {subfield_id}: benchmarks[] is missing")),
        }

        let mut attributed = 0usize;
        for (problem_index, problem) in subfield
            .get("open_problems")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let label = nonempty_str(problem.get("open_problem_id"))
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{subfield_id}.open_problems[{problem_index}]"));
            let Some(problem_id) = nonempty_str(problem.get("open_problem_id")) else {
                out.warnings.push(format!("{label}: no open_problem_id; not usable by a lead"));
                continue;
            };
            if nonempty_str(problem.get("problem")).is_none() {
                out.warnings.push(format!("{label}: problem statement is empty"));
                continue;
            }
            let cited: Vec<String> = entry_paper_ids(problem)
                .iter()
                .map(|id| paper_key(id))
                .filter(|key| verified.contains_key(key))
                .collect();
            if cited.is_empty() {
                out.warnings.push(format!(
                    "{label}: attributed to no admitted paper; an open problem must cite the papers that state it"
                ));
                continue;
            }
            let fit = problem.get("instrument_fit");
            let testable = fit
                .and_then(|item| item.get("testable_here"))
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase());
            if !matches!(testable.as_deref(), Some("yes") | Some("partial") | Some("no")) {
                out.warnings.push(format!(
                    "{label}: instrument_fit.testable_here must be yes|partial|no"
                ));
                continue;
            }
            if !out.open_problem_ids.insert(problem_id.to_string()) {
                out.reasons.push(format!("open_problem_id '{problem_id}' is used twice"));
                continue;
            }
            for key in cited {
                if verified_year(&key).is_some_and(|year| year >= thresholds.frontier_year) {
                    out.frontier_paper_keys.insert(key.clone());
                }
                out.landscape_paper_keys.insert(key);
            }
            attributed += 1;
        }
        if attributed == 0 {
            out.reasons.push(format!(
                "subfield {subfield_id}: no open problem that is attributed to admitted papers and carries an instrument_fit annotation"
            ));
        }
        out.subfield_counts.push(json!({
            "subfield_id": subfield_id,
            "canonical_verified": canonical.len(),
            "frontier_verified": frontier.len(),
            "attributed_open_problems": attributed,
        }));
    }
    if subfield_ids.len() < thresholds.min_subfields {
        out.reasons.push(format!(
            "{} subfield(s) mapped, at least {} required -- enumerate every subfield the objective names or implies",
            subfield_ids.len(),
            thresholds.min_subfields
        ));
    }
    out.valid = out.reasons.is_empty();
    out
}

#[derive(Clone, Debug)]
pub(crate) struct FieldLandscapeStatus {
    /// `missing`, `invalid` or `valid`.
    pub(crate) state: &'static str,
    pub(crate) path: PathBuf,
    pub(crate) landscape: Value,
    pub(crate) validation: FieldLandscapeValidation,
    /// Why no lead may be selected yet although the landscape is valid: harvested
    /// frontier candidates still owed a review (labdirector::frontier_harvest).
    pub(crate) frontier_block: Vec<String>,
}

/// The published landscape, re-validated from the file on every read, against
/// the admitted records the harness stamped into it.
pub(crate) fn field_landscape_status(paths: &AppPaths, cycle_id: &str) -> FieldLandscapeStatus {
    let path = field_landscape_state_path(paths, cycle_id);
    let Ok(landscape) = read_json(&path) else {
        return FieldLandscapeStatus {
            state: "missing",
            path,
            landscape: Value::Null,
            validation: FieldLandscapeValidation {
                reasons: vec!["no field landscape has been published for this cycle".to_string()],
                ..Default::default()
            },
            frontier_block: Vec::new(),
        };
    };
    let verified = landscape
        .get("verified_papers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let thresholds = field_landscape_thresholds();
    let mut validation = validate_field_landscape(&landscape, &verified, &thresholds);
    // The landscape as every later stage reads it: plus the post-horizon papers
    // the frontier harvest found and the screening gate admitted. They are
    // citable like any landscape paper; validity is decided before they join.
    let mut landscape = landscape;
    let mut frontier_block = Vec::new();
    if validation.valid {
        let admitted = frontier_admitted_papers(paths, cycle_id);
        for paper in &admitted {
            if let Some(id) = nonempty_str(paper.get("paper_id")) {
                let key = paper_key(id);
                if paper_year(paper).is_some_and(|year| year >= thresholds.frontier_year) {
                    validation.frontier_paper_keys.insert(key.clone());
                }
                validation.landscape_paper_keys.insert(key);
            }
        }
        landscape = landscape_with_frontier(&landscape, &admitted);
        frontier_block = frontier_harvest_block_reasons(paths, cycle_id);
    }
    FieldLandscapeStatus {
        state: if validation.valid { "valid" } else { "invalid" },
        path,
        landscape,
        validation,
        frontier_block,
    }
}

fn role_plan_action(role_plan: Option<&Value>) -> &str {
    role_plan
        .and_then(|plan| plan.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// Validate the landscape a finished landscape scout wrote and publish it.
///
/// The published file is the agent's landscape plus what only the harness may
/// say: which of its papers the screening gate admitted (`verified_papers`), the
/// thresholds, and the verdict. A valid landscape is never replaced by an invalid
/// later attempt; every attempt is kept in `<cycle>-field-landscape-attempts.json`
/// so the next scout is told exactly what failed.
pub(crate) fn project_field_landscape(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<Option<PathBuf>> {
    if contract.role != "scout" || role_plan_action(role_plan) != FIELD_LANDSCAPE_SCOUT_ACTION {
        return Ok(None);
    }
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| lane_dir.clone());
    let source = [output_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE), lane_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE)]
        .into_iter()
        .find(|path| path.is_file());
    let thresholds = field_landscape_thresholds();
    let landscape = source.as_ref().and_then(|path| read_json(path).ok());
    let registry = admitted_paper_registry(&cycle_admitted_papers(paths, &contract.cycle_id, &output_dir));
    let validation = match landscape.as_ref() {
        Some(value) if value.is_object() => validate_field_landscape(value, &registry, &thresholds),
        _ => FieldLandscapeValidation {
            reasons: vec![format!(
                "the landscape scout wrote no {FIELD_LANDSCAPE_OUTPUT_FILE} in its lane directory"
            )],
            ..Default::default()
        },
    };
    record_field_landscape_attempt(paths, &contract.cycle_id, &contract.lane_id, &validation)?;
    let Some(mut landscape) = landscape.filter(Value::is_object) else {
        return Ok(None);
    };
    let state_path = field_landscape_state_path(paths, &contract.cycle_id);
    if !validation.valid && field_landscape_status(paths, &contract.cycle_id).state == "valid" {
        return Ok(None);
    }
    // Only the papers the landscape names, so the file stays readable.
    let mut named = serde_json::Map::new();
    for key in &validation.landscape_paper_keys {
        if let Some(paper) = registry.get(key) {
            named.insert(key.clone(), paper.clone());
        }
    }
    landscape["cycle_id"] = json!(contract.cycle_id);
    landscape["generated_by"] = json!(contract.lane_id);
    landscape["projected_at"] = json!(now_iso());
    landscape["source_path"] = json!(source.map(|path| path.display().to_string()));
    landscape["verified_papers"] = Value::Object(named);
    landscape["thresholds"] = thresholds.as_value();
    landscape["validation"] = validation.as_value();
    write_json(&state_path, &landscape)?;
    Ok(Some(state_path))
}

fn record_field_landscape_attempt(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    validation: &FieldLandscapeValidation,
) -> Result<()> {
    let path = field_landscape_attempts_path(paths, cycle_id);
    let mut attempts = read_json(&path)
        .ok()
        .and_then(|value| value.get("attempts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    attempts.push(json!({
        "lane_id": lane_id,
        "checked_at": now_iso(),
        "valid": validation.valid,
        "reasons": validation.reasons,
        "warnings": validation.warnings.iter().take(20).collect::<Vec<_>>(),
    }));
    let skip = attempts.len().saturating_sub(ATTEMPTS_KEPT);
    write_json(
        &path,
        &json!({ "cycle_id": cycle_id, "attempts": attempts.into_iter().skip(skip).collect::<Vec<_>>() }),
    )
}

fn latest_field_landscape_attempt(paths: &AppPaths, cycle_id: &str) -> Value {
    read_json(&field_landscape_attempts_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("attempts").and_then(Value::as_array).and_then(|items| items.last().cloned()))
        .unwrap_or(Value::Null)
}

/// Why this lead may not be selected, or an empty list when it may.
///
/// The lead must name an `open_problem_id` of a VALID landscape and cite at least
/// `min_lead_citations` of the landscape's verified papers, at least one of which
/// the admitted record dates to the frontier year or later.
pub(crate) fn lead_landscape_rejection_reasons(
    lead: &Value,
    status: &FieldLandscapeStatus,
    thresholds: &FieldLandscapeThresholds,
) -> Vec<String> {
    if status.state != "valid" {
        let mut reasons = vec![format!(
            "field_landscape_{}: no lead may be selected or replaced until a valid field landscape exists at {}",
            status.state,
            status.path.display()
        )];
        reasons.extend(status.validation.reasons.iter().take(6).cloned());
        return reasons;
    }
    // No silent drop: a harvested frontier candidate nobody has reviewed holds the
    // lead, as it holds the deep read (labdirector::frontier_harvest).
    let mut reasons: Vec<String> = status.frontier_block.clone();
    let known = &status.validation.open_problem_ids;
    match nonempty_str(lead.get("landscape_open_problem_id")) {
        None => reasons.push(format!(
            "landscape_open_problem_id is missing; name the landscape open problem this lead answers (one of: {})",
            known.iter().take(24).cloned().collect::<Vec<_>>().join(", ")
        )),
        Some(id) if !known.contains(id) => reasons.push(format!(
            "landscape_open_problem_id '{id}' is not an open problem in the landscape (one of: {})",
            known.iter().take(24).cloned().collect::<Vec<_>>().join(", ")
        )),
        Some(_) => {}
    }
    let cited: Vec<String> = lead
        .get("landscape_paper_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| nonempty_str(Some(item)))
        .map(ToString::to_string)
        .collect();
    let mut recognised = BTreeSet::new();
    let mut unrecognised = Vec::new();
    for id in &cited {
        let key = paper_key(id);
        if status.validation.landscape_paper_keys.contains(&key) {
            recognised.insert(key);
        } else {
            unrecognised.push(id.clone());
        }
    }
    if recognised.len() < thresholds.min_lead_citations {
        let mut reason = format!(
            "landscape_paper_ids cites {} verified landscape paper(s); at least {} are required",
            recognised.len(),
            thresholds.min_lead_citations
        );
        if !unrecognised.is_empty() {
            reason.push_str(&format!(
                " (not landscape papers: {})",
                unrecognised.iter().take(8).cloned().collect::<Vec<_>>().join(", ")
            ));
        }
        reasons.push(reason);
    }
    if !recognised
        .iter()
        .any(|key| status.validation.frontier_paper_keys.contains(key))
    {
        reasons.push(format!(
            "landscape_paper_ids cites no frontier work: at least one cited landscape paper must be dated {} or later",
            thresholds.frontier_year
        ));
    }
    reasons
}

/// Kept where every later director reads it (`field_landscape.last_selection_rejections`).
pub(crate) fn record_lead_selection_rejection(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    statement: &str,
    requery_decision: &Value,
    reasons: &[String],
) -> Result<()> {
    let path = lead_selection_rejections_path(paths, cycle_id);
    let mut rejections = read_json(&path)
        .ok()
        .and_then(|value| value.get("rejections").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    rejections.push(json!({
        "lane_id": lane_id,
        "rejected_at": now_iso(),
        "requery_decision": requery_decision,
        "statement": statement,
        "gate": "field_landscape",
        "reasons": reasons,
        "fix": "select an open problem from the valid field landscape, then set selected_hypothesis.landscape_open_problem_id to its open_problem_id and selected_hypothesis.landscape_paper_ids to the landscape paper_ids the lead builds on; once planner_metadata.expert_selection.engaged is true, wait for the owner's pick and set selected_hypothesis.slate_candidate_id to it, copying its landscape references (labdirector::problem_selection)",
    }));
    let skip = rejections.len().saturating_sub(REJECTIONS_KEPT);
    write_json(
        &path,
        &json!({ "cycle_id": cycle_id, "rejections": rejections.into_iter().skip(skip).collect::<Vec<_>>() }),
    )
}

fn field_landscape_scout_counts(paths: &AppPaths, cycle_id: &str) -> Result<(usize, usize)> {
    let key = format!("scout::{FIELD_LANDSCAPE_SCOUT_ACTION}");
    let total = count_followup_lanes_by_role_and_action(paths, cycle_id)?
        .get(&key)
        .copied()
        .unwrap_or(0);
    let open = count_open_followup_lanes_by_role_and_action(paths, cycle_id)?
        .get(&key)
        .copied()
        .unwrap_or(0);
    Ok((total, open))
}

/// The dependency hold on a director while a landscape it will need is being built.
///
/// Only the OPENING decision is held, and only while a landscape scout is actually
/// pending or running: a hold with no lane behind it is one nothing can release.
pub(crate) fn director_field_landscape_wait_reason(
    paths: &AppPaths,
    cycle_id: &str,
) -> Option<String> {
    if !field_landscape_gate_enabled() {
        return None;
    }
    let status = field_landscape_status(paths, cycle_id);
    if status.state == "valid" {
        return None;
    }
    let (_, open) = field_landscape_scout_counts(paths, cycle_id).ok()?;
    (open > 0).then(|| {
        format!(
            "waiting-for-field-landscape status={} landscape_scouts_open={open}",
            status.state
        )
    })
}

fn selection_refused_since_last_attempt(paths: &AppPaths, cycle_id: &str) -> bool {
    let last_attempt = latest_field_landscape_attempt(paths, cycle_id)
        .get("checked_at")
        .and_then(Value::as_str)
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok());
    let last_rejection = read_json(&lead_selection_rejections_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("rejections").and_then(Value::as_array).and_then(|items| items.last().cloned()))
        .and_then(|row| row.get("rejected_at").and_then(Value::as_str).map(ToString::to_string))
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(&text).ok());
    match (last_attempt, last_rejection) {
        (Some(attempt), Some(rejection)) => rejection > attempt,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn field_landscape_scout_description(attempt: usize) -> String {
    format!(
        "FIELD LANDSCAPE, before any lead is chosen: enumerate every subfield this objective names or implies; for EACH, name its canonical works and its 2024-2026 frontier works (methods, datasets, benchmarks) from your own knowledge and verify every one by exact title / arXiv id / DOI lookup through the literature driver; expand by citations to the 2024-2026 work each subfield builds on; screen every candidate's full abstract through the normal review queue and finalize; then write {FIELD_LANDSCAPE_OUTPUT_FILE} with per-subfield canonical and frontier works, dominant approaches, benchmarks, and open problems attributed to the papers that state them. Instruments are annotated per open problem (instrument_fit); they never choose the subfield, the query or the problem. [attempt {attempt}]"
    )
}

/// Dispatch the landscape scout when the landscape is missing or invalid and none
/// is already open. Called once per scheduling pass, from the first.
pub(crate) fn dispatch_field_landscape_scout(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !field_landscape_gate_enabled() {
        return Ok(Vec::new());
    }
    let status = field_landscape_status(paths, cycle_id);
    if status.state == "valid" {
        return Ok(Vec::new());
    }
    let thresholds = field_landscape_thresholds();
    let (total, open) = field_landscape_scout_counts(paths, cycle_id)?;
    // The attempt cap bounds a scout that keeps failing the same way. It must not
    // leave the cycle with a gate nothing can open, so once the cap is reached a
    // director whose selection was refused AFTER the last attempt earns one more.
    if open > 0
        || (total >= thresholds.max_attempts && !selection_refused_since_last_attempt(paths, cycle_id))
    {
        return Ok(Vec::new());
    }
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let attempt = total + 1;
    let description = field_landscape_scout_description(attempt);
    let brief_id = "field-landscape";
    let task_body = followup_task_markdown(cycle_id, &objective, "scout", brief_id, &description, &[]);
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
    let contract_path = create_lane_contract(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        "codex-agent",
        "read-write-scoped",
        &task_body,
    )?;
    let lane_dir = lane_root(paths, cycle_id, &lane_id);
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        assigned_model_for_role("scout", "codex-agent"),
        &objective,
        brief_id,
        &description,
        FIELD_LANDSCAPE_SCOUT_ACTION,
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "field_landscape_gate",
            "preferred_role": "scout",
            "novelty_mode": "field-wide-landscape",
            "selection_scope": "open",
            "field_landscape_contract": {
                "output_path": lane_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE),
                "published_state_path": status.path,
                "thresholds": thresholds.as_value(),
                "attempt": attempt,
                "current_landscape_status": status.state,
                "previous_attempt": latest_field_landscape_attempt(paths, cycle_id),
                "instrument_fit_is_annotation_only": true,
            },
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "scout",
        "contract_path": contract_path,
        "source_brief_id": brief_id,
        "role_plan_path": role_plan_path,
        "action_type": FIELD_LANDSCAPE_SCOUT_ACTION,
    })])
}

fn truncate_text(value: Option<&Value>, max_chars: usize) -> Value {
    match value.and_then(Value::as_str) {
        Some(text) if text.chars().count() > max_chars => {
            json!(format!("{}...", text.chars().take(max_chars).collect::<String>()))
        }
        Some(text) => json!(text),
        None => Value::Null,
    }
}

/// What every director lane is handed about the landscape: its status, the open
/// problems a lead may answer, the papers a lead may cite, and why the last
/// selection was refused.
pub(crate) fn field_landscape_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let thresholds = field_landscape_thresholds();
    let status = field_landscape_status(paths, cycle_id);
    let verified = status
        .landscape
        .get("verified_papers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut open_problems = Vec::new();
    let mut subfields = Vec::new();
    for subfield in status
        .landscape
        .get("subfields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let subfield_id = subfield
            .get("subfield_id")
            .or_else(|| subfield.get("name"))
            .cloned()
            .unwrap_or(Value::Null);
        let names = |key: &str, field: &str| -> Value {
            Value::Array(
                subfield
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(8)
                    .map(|item| truncate_text(item.get(field).or(Some(item)), 120))
                    .collect(),
            )
        };
        subfields.push(json!({
            "subfield_id": subfield_id,
            "name": subfield.get("name").cloned().unwrap_or(Value::Null),
            "dominant_approaches": names("dominant_approaches", "approach"),
            "benchmarks": names("benchmarks", "name"),
        }));
        for problem in subfield.get("open_problems").and_then(Value::as_array).into_iter().flatten() {
            let Some(id) = nonempty_str(problem.get("open_problem_id")) else {
                continue;
            };
            if !status.validation.open_problem_ids.contains(id) {
                continue;
            }
            open_problems.push(json!({
                "open_problem_id": id,
                "subfield_id": subfield_id,
                "problem": truncate_text(problem.get("problem"), 400),
                "why_open": truncate_text(problem.get("why_open"), 300),
                "decisive_quantity": truncate_text(problem.get("decisive_quantity"), 200),
                "paper_ids": problem.get("paper_ids").cloned().unwrap_or_else(|| json!([])),
                "instrument_fit": problem.get("instrument_fit").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    // Post-horizon papers first, so the cap never cuts the ones no reader can
    // recall. A landscape paper is post-horizon when the harvest flagged it or its
    // admitted year is after the horizon's year (a year equal to it may predate it).
    let horizon_year = frontier_harvest_director_context_since_year(paths, cycle_id);
    let post_horizon = |paper: &Value| {
        paper.get("post_horizon").and_then(Value::as_bool) == Some(true)
            || horizon_year.is_some_and(|since| paper_year(paper).is_some_and(|year| year > since))
    };
    let mut ordered: Vec<(&String, &Value)> = verified.iter().collect();
    ordered.sort_by_key(|(_, paper)| !post_horizon(paper));
    let papers: Vec<Value> = ordered
        .into_iter()
        .take(200)
        .map(|(key, paper)| {
            json!({
                "paper_id": paper.get("paper_id").cloned().unwrap_or_else(|| json!(key)),
                "title": truncate_text(paper.get("title"), 140),
                "year": paper.get("year").cloned().unwrap_or(Value::Null),
                "frontier": status.validation.frontier_paper_keys.contains(key),
                "post_horizon": post_horizon(paper),
            })
        })
        .collect();
    let rejections = read_json(&lead_selection_rejections_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("rejections").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let skip = rejections.len().saturating_sub(3);
    json!({
        "gate_enabled": field_landscape_gate_enabled(),
        "status": status.state,
        "state_path": status.path,
        "validation_reasons": status.validation.reasons.iter().take(12).collect::<Vec<_>>(),
        "min_lead_citations": thresholds.min_lead_citations,
        "frontier_year": thresholds.frontier_year,
        "subfields": subfields,
        "open_problems": open_problems,
        "papers": papers,
        "frontier_harvest": frontier_harvest_director_context(paths, cycle_id),
        "frontier_block": status.frontier_block,
        "last_selection_rejections": rejections.into_iter().skip(skip).collect::<Vec<_>>(),
        "selection_rule": format!(
            "ENFORCED: no lead is selected or replaced until status is valid. The lead must answer one of open_problems -- set selected_hypothesis.landscape_open_problem_id to its open_problem_id -- and cite at least {} of papers in selected_hypothesis.landscape_paper_ids, at least one with frontier=true (dated {}+). Choose the problem by significance and frontier gap across ALL subfields first; instrument_fit then decides whether and how this host can test it. An instrument never chooses the problem: 'the simulator we have can answer X' is a feasibility note, not a reason to pick X.",
            thresholds.min_lead_citations, thresholds.frontier_year
        ),
        "broad_acquisition_override": if status.state == "valid" {
            Value::Null
        } else {
            json!("The field landscape is missing or invalid, so field-wide acquisition is REQUIRED now. Directives to avoid broad or repeated scout searches (hypothesis_gate_efficiency_mandate, literature_triage_policy budgets and stop rules) do not apply to it, and you must not instruct scouts to stop, narrow or defer broad acquisition ('do not restart broad acquisition' and the like). Set decision_status=needs_chronicle_evidence rather than selecting a lead.")
        },
    })
}

/// A landscape that passes the default thresholds: three subfields, three
/// canonical (2015) and five frontier (2025) admitted papers each, one attributed
/// open problem `op_sf<i>` per subfield. Shared by the labdirector and runtime tests.
#[cfg(test)]
pub(crate) fn valid_field_landscape_fixture(cycle_id: &str) -> Value {
    let mut verified = serde_json::Map::new();
    let mut subfields = Vec::new();
    for subfield in 0..3 {
        let mut canonical = Vec::new();
        let mut frontier = Vec::new();
        for index in 0..3 {
            let id = format!("doi:10.1/sf{subfield}-c{index}");
            verified.insert(id.clone(), json!({"paper_id": id, "title": format!("canonical {subfield}.{index}"), "year": 2015}));
            canonical.push(json!({"paper_id": id, "year": 2015}));
        }
        for index in 0..5 {
            let id = format!("arxiv:sf{subfield}-f{index}");
            verified.insert(id.clone(), json!({"paper_id": id, "title": format!("frontier {subfield}.{index}"), "year": 2025}));
            frontier.push(json!({"paper_id": id, "year": 2025}));
        }
        subfields.push(json!({
            "subfield_id": format!("sf{subfield}"),
            "name": format!("subfield {subfield}"),
            "canonical_works": canonical,
            "frontier_works": frontier,
            "dominant_approaches": [{"approach": "an approach", "paper_ids": [format!("arxiv:sf{subfield}-f0")]}],
            "benchmarks": [{"name": "a benchmark", "paper_ids": []}],
            "open_problems": [{
                "open_problem_id": format!("op_sf{subfield}"),
                "problem": "something not yet achievable",
                "why_open": "stated by the papers",
                "decisive_quantity": "a measurement",
                "paper_ids": [format!("arxiv:sf{subfield}-f1")],
                "instrument_fit": {"testable_here": "partial", "instruments": [], "how": "...", "blockers": []},
            }],
        }));
    }
    json!({ "cycle_id": cycle_id, "subfields": subfields, "verified_papers": verified })
}

/// The literature-scout clause for a landscape lane, appended to the ordinary
/// adaptive-search protocol so screening and finalization are unchanged.
pub(crate) fn field_landscape_scout_protocol(output_dir: &Path, role_plan_path: &Path) -> String {
    let thresholds = field_landscape_thresholds();
    let title_args = json!([
        "drivers/literature/search.py",
        "--title",
        "<exact title>",
        "--title",
        "<another exact title>",
        "--output-dir",
        output_dir,
        "--role-plan-file",
        role_plan_path
    ]);
    let id_args = json!([
        "drivers/literature/search.py",
        "--arxiv-id",
        "<arXiv id>",
        "--doi",
        "<DOI>",
        "--output-dir",
        output_dir,
        "--role-plan-file",
        role_plan_path
    ]);
    let landscape_path = output_dir.join(FIELD_LANDSCAPE_OUTPUT_FILE);
    format!(
        "\n\nFIELD LANDSCAPE SCOUT (this lane maps the whole field BEFORE any lead exists; the harness refuses every lead until the landscape it writes is valid):\n\
A. Scope from the objective, not from the instruments. Enumerate every subfield the objective names or implies (at least {min_subfields}). The objective's list of instruments, simulators, checkpoints or robots does NOT decide a subfield, a query or a problem; do not open with a query about the most ready instrument.\n\
B. Name, then verify. For EACH subfield write down from your own knowledge more than {canonical} canonical works (what the field's own surveys build on) and more than {frontier} frontier works dated {year} or later (state-of-the-art methods, foundation policies, datasets, benchmarks). Verify every one by exact lookup with argv shaped like {title_args} (batch several --title flags per call) or {id_args}. Record each lookup as a journal round whose source names the index it used. A work no index returns stays in `unverified_candidates` with the lookup you tried -- never admit a paper from memory.\n\
C. Expand by citations: from the canonical works run forward-citation inquiries (`--citations-of <DOI> --direction citations`) to reach the {year}+ work each subfield actually builds on, and backward ones where a frontier paper's baselines are missing.\n\
D. Screen and finalize exactly as the protocol above: full abstract, review JSON per queue.review_contract, finalize. Only papers in the finalized papers.json count, under the id stamped at `literature_screening.review.paper_id`; cite that id verbatim.\n\
E. Write {landscape} as JSON: {{\"objective_subfield_rationale\": \"why these subfields cover the objective\", \"subfields\": [{{\"subfield_id\": \"snake_case\", \"name\": \"...\", \"scope\": \"...\", \"canonical_works\": [{{\"paper_id\": \"admitted id\", \"title\": \"...\", \"year\": 0, \"why_canonical\": \"...\"}}], \"frontier_works\": [{{\"paper_id\": \"admitted id\", \"title\": \"...\", \"year\": 0, \"what_it_advances\": \"...\"}}], \"dominant_approaches\": [{{\"approach\": \"...\", \"paper_ids\": [\"...\"]}}], \"benchmarks\": [{{\"name\": \"...\", \"paper_ids\": [\"...\"]}}], \"open_problems\": [{{\"open_problem_id\": \"unique snake_case id\", \"problem\": \"what is not yet achievable, stated as a problem\", \"why_open\": \"...\", \"decisive_quantity\": \"the measurement that would settle it\", \"paper_ids\": [\"the admitted papers that state it\"], \"instrument_fit\": {{\"testable_here\": \"yes|partial|no\", \"instruments\": [\"...\"], \"how\": \"how the listed instruments could test it, or why they cannot\", \"blockers\": [\"...\"]}}}}]}}], \"unverified_candidates\": [{{\"title\": \"...\", \"lookup\": \"...\", \"reason\": \"...\"}}]}}.\n\
F. Open problems come from the papers, attributed to the specific ones that state them. `instrument_fit` is an annotation written AFTER the problem is stated: never drop, reorder or reword a problem because no instrument here can test it.\n\
G. The harness validates deterministically and publishes the landscape to the cycle state: at least {min_subfields} subfields; per subfield at least {canonical} canonical and {frontier} frontier ({year}+ by the admitted record's year) admitted papers; non-empty dominant_approaches; a benchmarks list; and at least one open problem with a unique open_problem_id, admitted paper_ids and an instrument_fit annotation. Any failure is returned to the next attempt in `field_landscape_contract.previous_attempt`. Breadth across subfields is this lane's deliverable; do not narrow to one subfield or to the question the most ready simulator can answer.\n\
H. {recall_clause} Name and verify what you know; the harness runs that harvest once your landscape is valid.\n",
        min_subfields = thresholds.min_subfields,
        canonical = thresholds.canonical_per_subfield,
        frontier = thresholds.frontier_per_subfield,
        year = thresholds.frontier_year,
        title_args = title_args,
        id_args = id_args,
        landscape = landscape_path.display(),
        recall_clause = frontier_recall_clause(),
    )
}

/// The year of the harvest's `since`, for marking landscape papers post-horizon.
fn frontier_harvest_director_context_since_year(paths: &AppPaths, cycle_id: &str) -> Option<i64> {
    let since = read_json(&frontier_harvest_state_path(paths, cycle_id))
        .ok()
        .and_then(|state| state.get("since").and_then(Value::as_str).map(ToString::to_string))
        .unwrap_or_else(|| cycle_knowledge_horizon(paths, cycle_id).0.to_string());
    since.get(..4).and_then(|year| year.parse().ok())
}
