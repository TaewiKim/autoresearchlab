#![allow(unused_imports)]
use super::*;
use std::collections::{BTreeMap, BTreeSet};

// --- expert-grade problem selection ---------------------------------------------
//
// The lead is chosen by a panel from a slate of candidates that each deny a named
// belief of the field, after the idea itself has been searched for and the host
// has been shown able to test it -- and the owner picks among the survivors.
//
// MEASURED ON cycle-b-20260919, 2026-09-19. The verified field landscape
// (labdirector::field_landscape) was in place and valid: five subfields, 48
// verified papers, five attributed open problems. lab-director-01 still chose,
// alone and in one lane, a narrow diagnostic on the most ready local asset --
// "per-link force dispersion predicts held-lift failure in the SuperDex xArm
// grasp simulator, AUROC > 0.60" -- and labelled it itself an "exploration
// candidate pending direct-prior-art audit". Four causes, each one a thing the
// landscape gate could not see:
//   * the director ranked with the instrument inventory in view, so the problem
//     it could run tonight looked like the problem worth running;
//   * there was one candidate, so nothing competed with it;
//   * nobody who works in the field was asked whether a result would change
//     their research, or whether they could already call the outcome;
//   * the landscape's open problems were generic ("no settled equal-budget
//     explanation"), so naming one cost nothing.
//
// "Interesting" is given an operational meaning (Davis 1971, "That's
// Interesting!"): a result is interesting when it denies or sharply qualifies an
// assumption its audience holds. Confirming what is known is dull; denying what
// nobody believes is irrelevant. So every candidate here targets a belief the
// field is shown to hold, and is valued by how much a reviewer's research would
// change times how uncertain the reviewer is about the outcome.
//
// The stages, each waiting on the artifact of the one before, all published to
// the cycle state by the harness and never by the agent:
//   landscape -> SOTA cards (sota_deep_read, labdirector::sota_cards)
//   -> field beliefs      <cycle>-field-beliefs.json      (director action)
//   -> candidate slate    <cycle>-candidate-slate.json    (director action, instrument-blind)
//   -> expert panel       <cycle>-expert-panel.json       (4-5 independent reviewer lanes)
//   -> novelty refutation <cycle>-novelty-audit.json      (scout, the idea itself)
//   -> feasibility        <cycle>-candidate-feasibility.json (pass/fail, never a score)
//   -> owner checkpoint   <cycle>-owner-candidates.{json,md} + an `owner_selection` pause
//   -> lead               through the landscape gate, and only from the slate.
// Leverage of open-source code, checkpoints, datasets and benchmark environments
// is a first-class criterion from the slate on: a candidate names the card assets
// it builds on, and feasibility demands a reproduction anchor -- one number from
// a card, reproduced here first.

mod beliefs;
pub(crate) use beliefs::*;
mod cards;
pub(crate) use cards::*;
mod dispatch;
pub(crate) use dispatch::*;
mod feasibility;
pub(crate) use feasibility::*;
mod gate;
pub(crate) use gate::*;
mod novelty;
pub(crate) use novelty::*;
mod owner;
pub(crate) use owner::*;
mod panel;
pub(crate) use panel::*;
mod projection;
pub(crate) use projection::*;
mod prompt;
pub(crate) use prompt::*;
mod schema;
pub(crate) use schema::*;
mod slate;
pub(crate) use slate::*;
mod strategies;
pub(crate) use strategies::*;

#[cfg(test)]
mod tests;

pub(crate) const FIELD_BELIEFS_ACTION: &str = "expert_field_beliefs_map";
pub(crate) const CANDIDATE_SLATE_ACTION: &str = "expert_candidate_slate";
pub(crate) const EXPERT_PANEL_ACTION: &str = "expert_panel_review";
pub(crate) const NOVELTY_REFUTATION_ACTION: &str = "expert_novelty_refutation";
pub(crate) const FEASIBILITY_AUDIT_ACTION: &str = "expert_feasibility_audit";
/// The pause a checkpoint writes. A wait on a person, never plumbing: the
/// maintainer lists it among its waiting pause types.
pub(crate) const OWNER_SELECTION_BLOCK: &str = "owner_selection";
pub(crate) const NOVELTY_AUDIT_OUTPUT_FILE: &str = "novelty-audit.json";
/// What an owner writes to lift the slate requirement when no candidate survived.
pub(crate) const OWNER_RELEASE_CANDIDATE_ID: &str = "release";

/// What the owner decided at the checkpoint. One value, named, so no reader has
/// to infer it from a bare flag.
///
/// MEASURED ON cycle-a-20260919, 2026-09-20. The recorded selection
/// carried `released: false`, true only for the "release" id that lifts the
/// slate requirement. The LabDirector read it as an owner approval still to
/// come and deferred every execution action ("after ... owner release") for
/// hours after the lead was already set from the owner's pick.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OwnerDecision {
    /// No owner-selection file yet.
    Pending,
    /// The owner picked a slate candidate: the lead is that candidate.
    CandidatePicked,
    /// The owner lifted the slate requirement instead.
    SlateReleased,
}

impl OwnerDecision {
    pub(crate) fn of_candidate_id(candidate_id: &str) -> Self {
        if candidate_id.eq_ignore_ascii_case(OWNER_RELEASE_CANDIDATE_ID) {
            Self::SlateReleased
        } else {
            Self::CandidatePicked
        }
    }

    /// The decision a recorded selection carries. `decision` is authoritative;
    /// a selection written before it existed is read from its own fields.
    pub(crate) fn of_selection(selection: Option<&serde_json::Value>) -> Self {
        let Some(selection) = selection else {
            return Self::Pending;
        };
        match selection.get("decision").and_then(serde_json::Value::as_str) {
            Some(value) if value == Self::SlateReleased.as_str() => Self::SlateReleased,
            Some(value) if value == Self::CandidatePicked.as_str() => Self::CandidatePicked,
            Some(value) if value == Self::Pending.as_str() => Self::Pending,
            _ => {
                if selection.get("released").and_then(serde_json::Value::as_bool) == Some(true) {
                    Self::SlateReleased
                } else if selection
                    .get("candidate_id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| !id.trim().is_empty())
                {
                    Self::of_candidate_id(
                        selection.get("candidate_id").and_then(serde_json::Value::as_str).unwrap_or(""),
                    )
                } else {
                    Self::Pending
                }
            }
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::CandidatePicked => "candidate_picked",
            Self::SlateReleased => "slate_released",
        }
    }

    /// What the decision means for the lead, in the words the LabDirector reads.
    pub(crate) fn lead_rule(self) -> &'static str {
        match self {
            Self::Pending => "the owner has not picked yet; no lead may be selected",
            Self::CandidatePicked => "the owner has chosen this candidate and nothing further is awaited from the owner: the lead is this candidate",
            Self::SlateReleased => "the owner lifted the slate requirement: the lead answers only to the field-landscape gate",
        }
    }

    pub(crate) fn slate_requirement_lifted(self) -> bool {
        matches!(self, Self::SlateReleased)
    }
}
const ATTEMPTS_KEPT: usize = 60;

/// Every stage action, with the role that runs it and its lane-id prefix.
///
/// Distinct prefixes keep these lanes out of every reader that finds a role by
/// lane id -- the gate review collects `followup-gatekeeper-*` as gate reviews,
/// and a panel reviewer is not one. The novelty auditor is an ordinary
/// literature scout and keeps the scout prefix, so what it admits joins the
/// cycle's corpus.
pub(crate) const EXPERT_SELECTION_STAGES: &[(&str, &str, &str)] = &[
    (FIELD_BELIEFS_ACTION, "lab-director", "followup-selection-beliefs-"),
    (CANDIDATE_SLATE_ACTION, "lab-director", "followup-selection-slate-"),
    (EXPERT_PANEL_ACTION, "gatekeeper", "followup-selection-panel-"),
    (NOVELTY_REFUTATION_ACTION, "scout", "followup-scout-"),
    (FEASIBILITY_AUDIT_ACTION, "lab-director", "followup-selection-feasibility-"),
];

pub(crate) fn is_expert_selection_action(action_type: &str) -> bool {
    EXPERT_SELECTION_STAGES
        .iter()
        .any(|(action, _, _)| *action == action_type)
}

pub(crate) fn expert_selection_action_of(role_plan: Option<&Value>) -> Option<&'static str> {
    let action = role_plan
        .and_then(|plan| plan.get("action_type"))
        .and_then(Value::as_str)?;
    EXPERT_SELECTION_STAGES
        .iter()
        .find(|(known, _, _)| *known == action)
        .map(|(known, _, _)| *known)
}

/// Whether this lane is one of the pipeline's own stage lanes, read from its
/// role plan on disk.
pub(crate) fn expert_selection_stage_lane(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> bool {
    let path = lane_role_plan_path(paths, cycle_id, lane_id);
    read_role_plan_index_fields(&path)
        .ok()
        .flatten()
        .and_then(|fields| fields.action_type)
        .is_some_and(|action| is_expert_selection_action(&action))
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ExpertSelectionConfig {
    pub(crate) enabled: bool,
    /// Distinct SOTA cards a field belief must be shown held by.
    pub(crate) belief_min_cards: usize,
    pub(crate) min_beliefs: usize,
    pub(crate) slate_min: usize,
    pub(crate) slate_max: usize,
    pub(crate) min_slate_subfields: usize,
    /// Distinct origin strategies the slate must spread across (strategies.rs);
    /// never more than the published map can support.
    pub(crate) min_slate_strategies: usize,
    /// What the field map must carry for the transfer and latent strategies.
    pub(crate) min_known_bottlenecks: usize,
    pub(crate) min_latent_signals: usize,
    /// Cards a latent_bottleneck candidate must show its demand in.
    pub(crate) latent_min_evidence: usize,
    pub(crate) panel_size: usize,
    pub(crate) novelty_top_k: usize,
    pub(crate) owner_top_n: usize,
    pub(crate) max_attempts: usize,
    pub(crate) host_vram_gb: f64,
    pub(crate) novelty_window_months: u32,
    pub(crate) owner_timeout_minutes: Option<u64>,
    pub(crate) local_reference_roots: Vec<String>,
}

impl Default for ExpertSelectionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            belief_min_cards: 2,
            min_beliefs: 4,
            slate_min: 8,
            slate_max: 10,
            min_slate_subfields: 3,
            min_slate_strategies: 3,
            min_known_bottlenecks: 1,
            min_latent_signals: 2,
            latent_min_evidence: 2,
            panel_size: MAX_PANEL_SIZE,
            novelty_top_k: 3,
            owner_top_n: 3,
            max_attempts: 3,
            host_vram_gb: 8.0,
            novelty_window_months: 18,
            owner_timeout_minutes: None,
            // The operator's to name (RESEARCHLAB_LOCAL_REFERENCE_ROOTS); no default.
            local_reference_roots: Vec::new(),
        }
    }
}

impl ExpertSelectionConfig {
    pub(crate) fn as_value(&self) -> Value {
        json!({
            "enabled": self.enabled,
            "belief_min_cards": self.belief_min_cards,
            "min_beliefs": self.min_beliefs,
            "slate_min": self.slate_min,
            "slate_max": self.slate_max,
            "min_slate_subfields": self.min_slate_subfields,
            "min_slate_strategies": self.min_slate_strategies,
            "min_known_bottlenecks": self.min_known_bottlenecks,
            "min_latent_signals": self.min_latent_signals,
            "latent_min_evidence": self.latent_min_evidence,
            "panel_size": self.panel_size,
            "novelty_top_k": self.novelty_top_k,
            "owner_top_n": self.owner_top_n,
            "max_attempts": self.max_attempts,
            "host_vram_gb": self.host_vram_gb,
            "novelty_window_months": self.novelty_window_months,
            "owner_timeout_minutes": self.owner_timeout_minutes,
            "local_reference_roots": self.local_reference_roots,
        })
    }
}

fn selection_env<T: std::str::FromStr>(name: &str) -> Option<T> {
    env::var(name).ok().and_then(|raw| raw.trim().parse::<T>().ok())
}

/// On unless the owner turns it off: `RESEARCHLAB_EXPERT_SELECTION=0|false|off|no`.
pub(crate) fn expert_selection_enabled() -> bool {
    !matches!(
        env::var("RESEARCHLAB_EXPERT_SELECTION")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

/// The configuration in force, every count overridable from the environment.
pub(crate) fn expert_selection_config() -> ExpertSelectionConfig {
    let defaults = ExpertSelectionConfig::default();
    let positive = |name: &str, fallback: usize| {
        selection_env::<usize>(name).filter(|value| *value > 0).unwrap_or(fallback)
    };
    let slate_min = positive("RESEARCHLAB_EXPERT_SELECTION_SLATE_MIN", defaults.slate_min);
    let slate_max = positive("RESEARCHLAB_EXPERT_SELECTION_SLATE_MAX", defaults.slate_max).max(slate_min);
    ExpertSelectionConfig {
        enabled: expert_selection_enabled(),
        belief_min_cards: positive("RESEARCHLAB_EXPERT_SELECTION_BELIEF_MIN_CARDS", defaults.belief_min_cards),
        min_beliefs: positive("RESEARCHLAB_EXPERT_SELECTION_MIN_BELIEFS", defaults.min_beliefs),
        slate_min,
        slate_max,
        min_slate_subfields: positive(
            "RESEARCHLAB_EXPERT_SELECTION_MIN_SLATE_SUBFIELDS",
            defaults.min_slate_subfields,
        ),
        min_slate_strategies: positive(
            "RESEARCHLAB_EXPERT_SELECTION_MIN_SLATE_STRATEGIES",
            defaults.min_slate_strategies,
        )
        .min(ORIGIN_STRATEGIES.len()),
        // Zero turns a floor off; these two are allowed to.
        min_known_bottlenecks: selection_env::<usize>("RESEARCHLAB_EXPERT_SELECTION_MIN_KNOWN_BOTTLENECKS")
            .unwrap_or(defaults.min_known_bottlenecks),
        min_latent_signals: selection_env::<usize>("RESEARCHLAB_EXPERT_SELECTION_MIN_LATENT_SIGNALS")
            .unwrap_or(defaults.min_latent_signals),
        latent_min_evidence: positive("RESEARCHLAB_EXPERT_SELECTION_LATENT_MIN_EVIDENCE", defaults.latent_min_evidence),
        panel_size: positive("RESEARCHLAB_EXPERT_PANEL_SIZE", defaults.panel_size)
            .min(MAX_PANEL_SIZE),
        novelty_top_k: positive("RESEARCHLAB_EXPERT_SELECTION_NOVELTY_TOP_K", defaults.novelty_top_k),
        owner_top_n: positive("RESEARCHLAB_EXPERT_SELECTION_OWNER_TOP_N", defaults.owner_top_n),
        max_attempts: positive("RESEARCHLAB_EXPERT_SELECTION_MAX_ATTEMPTS", defaults.max_attempts),
        host_vram_gb: selection_env::<f64>("RESEARCHLAB_HOST_VRAM_GB")
            .filter(|value| *value > 0.0)
            .unwrap_or(defaults.host_vram_gb),
        novelty_window_months: selection_env::<u32>("RESEARCHLAB_EXPERT_SELECTION_NOVELTY_WINDOW_MONTHS")
            .filter(|value| *value > 0)
            .unwrap_or(defaults.novelty_window_months),
        owner_timeout_minutes: selection_env::<u64>("RESEARCHLAB_OWNER_SELECTION_TIMEOUT_MINUTES")
            .filter(|value| *value > 0),
        local_reference_roots: env::var("RESEARCHLAB_LOCAL_REFERENCE_ROOTS")
            .ok()
            .map(|raw| {
                raw.split(';')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|roots| !roots.is_empty())
            .unwrap_or(defaults.local_reference_roots),
    }
}

// --- paths ------------------------------------------------------------------------

pub(crate) fn expert_selection_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-expert-selection.json"))
}

fn expert_selection_attempts_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-expert-selection-attempts.json"))
}

pub(crate) fn field_beliefs_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-field-beliefs.json"))
}

pub(crate) fn candidate_slate_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-candidate-slate.json"))
}

pub(crate) fn expert_panel_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-expert-panel.json"))
}

/// The reviewers the panel was dispatched with (panel::fix_panel_personas).
pub(crate) fn expert_panel_personas_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-expert-panel-personas.json"))
}

/// Each reviewer's scores, sealed here until every persona has submitted.
pub(crate) fn expert_panel_submissions_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-expert-panel-submissions.json"))
}

pub(crate) fn novelty_audit_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-novelty-audit.json"))
}

pub(crate) fn candidate_feasibility_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-candidate-feasibility.json"))
}

pub(crate) fn owner_candidates_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-owner-candidates.json"))
}

pub(crate) fn owner_candidates_markdown_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-owner-candidates.md"))
}

pub(crate) fn owner_selection_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-owner-selection.json"))
}

// --- small shared helpers ---------------------------------------------------------

pub(crate) fn selection_text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

pub(crate) fn selection_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

pub(crate) fn selection_array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub(crate) fn selection_strings(value: &Value, key: &str) -> Vec<String> {
    selection_array(value, key)
        .iter()
        .filter_map(|item| selection_text(Some(item)))
        .map(ToString::to_string)
        .collect()
}

pub(crate) fn clip_text(value: Option<&Value>, max_chars: usize) -> Value {
    match value.and_then(Value::as_str) {
        Some(text) if text.chars().count() > max_chars => {
            json!(format!("{}...", text.chars().take(max_chars).collect::<String>()))
        }
        Some(text) => json!(text),
        None => Value::Null,
    }
}

/// The published artifact, or `None`. Only a valid stage output is ever
/// published, so presence is the verdict.
pub(crate) fn read_published(path: &Path) -> Option<Value> {
    read_json(path).ok().filter(Value::is_object)
}

/// The lane's structured output: the final message Codex parsed against the
/// stage's strict schema, or a file of the same name the lane wrote.
pub(crate) fn stage_output(payload: &Value, lane_dir: &Path, file_name: &str, marker_key: &str) -> Option<Value> {
    payload
        .get("extracted_json")
        .filter(|value| value.get(marker_key).is_some())
        .cloned()
        .or_else(|| payload.get(marker_key).is_some().then(|| payload.clone()))
        .or_else(|| read_json(&lane_dir.join(file_name)).ok().filter(|value| value.get(marker_key).is_some()))
}

// --- engagement -------------------------------------------------------------------

/// The pipeline is engaged for a cycle once it has started there. A cycle that
/// already had a lead before the pipeline could start is left alone, so a cycle
/// resumed on a new build is never re-gated mid-flight.
pub(crate) fn expert_selection_engaged(paths: &AppPaths, cycle_id: &str) -> bool {
    expert_selection_enabled() && expert_selection_state_path(paths, cycle_id).is_file()
}

pub(crate) fn expert_selection_state(paths: &AppPaths, cycle_id: &str) -> Value {
    read_json(&expert_selection_state_path(paths, cycle_id)).unwrap_or_else(|_| json!({}))
}

pub(crate) fn update_expert_selection_state(
    paths: &AppPaths,
    cycle_id: &str,
    update: impl FnOnce(&mut serde_json::Map<String, Value>),
) -> Result<Value> {
    let path = expert_selection_state_path(paths, cycle_id);
    let mut state = read_json(&path).ok().filter(Value::is_object).unwrap_or_else(|| json!({}));
    if let Some(object) = state.as_object_mut() {
        object.insert("cycle_id".to_string(), json!(cycle_id));
        update(object);
        object.insert("updated_at".to_string(), json!(now_iso()));
    }
    write_json(&path, &state)?;
    Ok(state)
}

pub(crate) fn cycle_has_lead_file(paths: &AppPaths, cycle_id: &str) -> bool {
    state_root(paths)
        .join(format!("{cycle_id}-lab-director-hypothesis.json"))
        .exists()
}

// --- stage lanes and attempts -------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct StageLane {
    pub(crate) lane_id: String,
    pub(crate) finished: bool,
    pub(crate) role_plan_path: PathBuf,
}

fn lane_sequence(lane_id: &str) -> (String, usize) {
    let number = lane_id
        .rsplit('-')
        .next()
        .and_then(|tail| tail.parse::<usize>().ok())
        .unwrap_or(0);
    (lane_id.trim_end_matches(|c: char| c.is_ascii_digit()).to_string(), number)
}

/// Every lane of this cycle whose role plan names `action`, oldest first.
pub(crate) fn stage_lanes(paths: &AppPaths, cycle_id: &str, action: &str) -> Vec<StageLane> {
    let mut lanes = Vec::new();
    let Ok(entries) = fs::read_dir(cycle_lanes_root(paths, cycle_id)) else {
        return lanes;
    };
    for entry in entries.flatten() {
        let lane_dir = entry.path();
        if !lane_dir.is_dir() {
            continue;
        }
        let lane_id = entry.file_name().to_string_lossy().to_string();
        let role_plan_path = lane_dir.join("role-plan.json");
        let matches = read_role_plan_index_fields(&role_plan_path)
            .ok()
            .flatten()
            .and_then(|fields| fields.action_type)
            .is_some_and(|found| found == action);
        if !matches {
            continue;
        }
        lanes.push(StageLane {
            finished: lane_dir.join("final-status.json").exists(),
            lane_id,
            role_plan_path,
        });
    }
    lanes.sort_by_key(|lane| {
        let (prefix, number) = lane_sequence(&lane.lane_id);
        (number, prefix)
    });
    lanes
}

pub(crate) fn read_stage_attempts(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    read_json(&expert_selection_attempts_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("attempts").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

pub(crate) fn record_stage_attempt(
    paths: &AppPaths,
    cycle_id: &str,
    stage: &str,
    lane_id: &str,
    valid: bool,
    reasons: &[String],
    warnings: &[String],
) -> Result<()> {
    let mut attempts = read_stage_attempts(paths, cycle_id);
    attempts.push(json!({
        "stage": stage,
        "lane_id": lane_id,
        "checked_at": now_iso(),
        "valid": valid,
        "reasons": reasons.iter().take(20).collect::<Vec<_>>(),
        "warnings": warnings.iter().take(20).collect::<Vec<_>>(),
    }));
    let skip = attempts.len().saturating_sub(ATTEMPTS_KEPT);
    write_json(
        &expert_selection_attempts_path(paths, cycle_id),
        &json!({ "cycle_id": cycle_id, "attempts": attempts.into_iter().skip(skip).collect::<Vec<_>>() }),
    )
}

/// The newest attempt recorded for a stage, handed to the next lane of it so it
/// is told exactly what failed.
pub(crate) fn latest_stage_attempt(paths: &AppPaths, cycle_id: &str, stage: &str) -> Value {
    read_stage_attempts(paths, cycle_id)
        .into_iter()
        .rev()
        .find(|attempt| attempt.get("stage").and_then(Value::as_str) == Some(stage))
        .unwrap_or(Value::Null)
}

/// Finished lanes at the end of a stage's history that produced nothing valid.
///
/// A lane that finished without its output ever being projected -- aborted,
/// killed, or a degraded payload with no structured output -- counts as a
/// failure too; otherwise a stage whose lanes die before projection would be
/// redispatched without bound.
pub(crate) fn trailing_stage_failures(paths: &AppPaths, cycle_id: &str, lanes: &[StageLane]) -> usize {
    let attempts = read_stage_attempts(paths, cycle_id);
    let valid_lanes: BTreeSet<&str> = attempts
        .iter()
        .filter(|attempt| attempt.get("valid").and_then(Value::as_bool) == Some(true))
        .filter_map(|attempt| attempt.get("lane_id").and_then(Value::as_str))
        .collect();
    lanes
        .iter()
        .rev()
        .filter(|lane| lane.finished)
        .take_while(|lane| !valid_lanes.contains(lane.lane_id.as_str()))
        .count()
}

/// A lead selection was refused after the newest attempt of this stage, so the
/// cap has earned the stage one more try: a gate must never be left with
/// nothing that can open it (the same rule as the field landscape).
pub(crate) fn selection_refused_since_stage_attempt(paths: &AppPaths, cycle_id: &str, stage: &str) -> bool {
    let last_attempt = latest_stage_attempt(paths, cycle_id, stage)
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

/// Sol at high effort for every stage, fixed.
///
/// The generic router would send an opening lab-director lane to the reserved
/// Astra budget (two routes a cycle) and a long prompt to a different tier; the
/// choice of problem is too important to vary with prompt length, and too
/// frequent across five stages to spend the cycle's Astra routes on.
pub(crate) fn expert_selection_model_route() -> Value {
    json!({
        "model": crate::labdirector::policy::CODEX_DEFAULT_AGENT_MODEL,
        "reasoning_effort": "high",
        "route_reason": "expert problem-selection stage: fixed reasoning route (Sol, high effort)",
        "route_version": "codex-tier-router-v1",
        "fallback_chain": [
            crate::labdirector::policy::CODEX_TERRA_MODEL,
            crate::labdirector::policy::CODEX_LUNA_MODEL
        ],
        "astra_eligible": false,
    })
}
