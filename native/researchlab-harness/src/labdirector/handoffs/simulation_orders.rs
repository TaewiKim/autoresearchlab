#![allow(unused_imports)]
//! The LabDirector's `simulation_orders`: what an engineer runs and an analyst
//! then analyses.
//!
//! MEASURED ON cycle-b-20260918, 2026-09-18: the owner assigned simulation
//! orchestration to the LabDirector; an analyst-declared request let the analyst
//! choose the experiment. The order is now director -> engineer -> analyst ->
//! lab-runner. The director designs each run against its selected hypothesis;
//! one engineer lane per order writes `episodes.csv` + `manifest.json`; analysts
//! wait for those files and then see them as an ordinary dataset bundle.

use super::*;

/// Failed engineer attempts at one order before it stops being offered. The
/// blocker the engineer returns is the director's to act on; a third identical
/// run of a simulator that will not start is not progress.
///
/// `RESEARCHLAB_MAX_SIMULATION_ATTEMPTS` raises it without a rebuild. An attempt
/// that failed on a harness fault since repaired -- a lane budget too small for
/// the order, a contract that forbade the lane from building what the order
/// needs -- is not the repetition this cap exists to stop, and the owner can say
/// so at launch instead of waiting for the next cycle.
pub(crate) const MAX_FAILED_SIMULATION_ATTEMPTS: usize = 2;

pub(crate) fn max_failed_simulation_attempts() -> usize {
    std::env::var("RESEARCHLAB_MAX_SIMULATION_ATTEMPTS")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(MAX_FAILED_SIMULATION_ATTEMPTS)
}

/// An order anyone can run names a request id and where its rows go.
pub(crate) fn simulation_order_is_runnable(order: &Value) -> bool {
    let non_empty = |key: &str| {
        order
            .get(key)
            .and_then(Value::as_str)
            .map(|text| !text.trim().is_empty())
            .unwrap_or(false)
    };
    order.is_object() && non_empty("request_id") && non_empty("output_path")
}

pub(crate) fn simulation_order_request_id(order: &Value) -> String {
    order
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Where an order's `episodes.csv` and `manifest.json` land.
///
/// The director writes `.research-lab/datasets/...`; that prefix is the runtime
/// root, which in a test (or a relocated runtime) is not `<project>/.research-lab`.
pub(crate) fn simulation_order_output_paths(
    paths: &AppPaths,
    order: &Value,
) -> Option<(PathBuf, PathBuf)> {
    let raw = order.get("output_path").and_then(Value::as_str)?.trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = raw.replace('\\', "/");
    // Joined segment by segment so the path the analyst is handed uses one
    // separator throughout.
    let under = |root: &Path, rest: &str| {
        rest.split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .fold(root.to_path_buf(), |path, segment| path.join(segment))
    };
    let relative = normalized.strip_prefix("./").unwrap_or(&normalized);
    let csv = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else if let Some(rest) = relative.strip_prefix(".research-lab/") {
        under(&paths.runtime_root, rest)
    } else {
        under(&paths.project_root, relative)
    };
    let manifest = csv.parent()?.join("manifest.json");
    Some((csv, manifest))
}

/// Both halves of an order's output exist: the rows and the record of how they
/// were produced. Rows without a manifest are data nobody can audit.
pub(crate) fn simulation_order_outputs_present(paths: &AppPaths, order: &Value) -> bool {
    simulation_order_output_paths(paths, order)
        .map(|(csv, manifest)| csv.is_file() && manifest.is_file())
        .unwrap_or(false)
}

/// Whether the run's own manifest shows the arms worked where they must.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-03 swept
/// 4500 episodes and every arm failed IN SUPPORT -- Diffusion Policy 0/300,
/// chunked behaviour cloning 0/300, the retriever 30/300 -- while success ROSE
/// with distance from the support for two of them, the opposite of the
/// hypothesis and the signature of an outcome that is noise. A policy that
/// cannot reproduce its own demonstrations has learned nothing, so no contrast
/// drawn across those arms means anything. The outcome varied, so a variance
/// check passes it; only the in-support rate catches it.
///
/// The harness does not compute the rate -- the lane that ran the episodes does,
/// and states it. What the harness refuses is data with no such statement, or
/// one that contradicts itself.
fn manifest_in_support_reason(manifest: &Path) -> Option<String> {
    let Ok(value) = read_json(manifest) else {
        return Some("manifest.json could not be read".to_string());
    };
    let Some(validation) = value.get("in_support_validation").filter(|item| item.is_object()) else {
        return Some(
            "manifest.json records no `in_support_validation`: the run never showed that its arms work in support, where a policy that learned its demonstrations reproduces them"
                .to_string(),
        );
    };
    if validation.get("passed").and_then(Value::as_bool) != Some(true) {
        let note = validation
            .get("note")
            .and_then(Value::as_str)
            .unwrap_or("no note recorded");
        return Some(format!("the run's own `in_support_validation` did not pass: {note}"));
    }
    // MEASURED ON cycle-a-20260919, 2026-10-04: the selected run's
    // manifest said `status=running` and `rows=8360` of `expected_rows=19200`,
    // but used `complete_cells` rather than the older remaining-cells ledger.
    // Passing pilot checks made the scheduler call it fulfilled, so no engineer
    // could resume the only action capable of producing the missing evidence.
    let status = value.get("status").and_then(Value::as_str).unwrap_or("");
    let rows = value.get("rows").and_then(Value::as_u64);
    let expected_rows = value.get("expected_rows").and_then(Value::as_u64);
    if status.eq_ignore_ascii_case("running")
        || matches!((rows, expected_rows), (Some(rows), Some(expected)) if rows < expected)
    {
        return Some(format!(
            "the run is not complete (status={status:?}, rows={} of {} expected): keep and resume the existing bundle",
            rows.map_or_else(|| "?".to_string(), |count| count.to_string()),
            expected_rows.map_or_else(|| "?".to_string(), |count| count.to_string()),
        ));
    }
    // A run that says it did not finish did not finish. The contract asks for
    // COMPLETE cells rather than a uniformly truncated grid, and partial cells
    // are progress worth keeping -- but the ordered contrast needs the cells the
    // design declared, and a lane that stopped at its budget says so itself.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-22.
    // coverage_decay_planar_push_power_v2 wrote 31,262 episodes over 11 of 90
    // cells: diffusion_policy at all five distances, the retriever at three, the
    // chunked baseline at one. Every arm passed in support and the outcome
    // varied, so both existing checks admitted it -- and no contrast across the
    // arms at matched distance could be computed from it.
    let remaining = value
        .get("remaining_cells")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if remaining > 0 {
        let done = value
            .get("completed_cells")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        return Some(format!(
            "the run records {remaining} of the design's cells as still to run ({done} completed): keep the rows, but the ordered contrast needs the cells the design declared"
        ));
    }
    let arms = validation.get("arms").and_then(Value::as_array).cloned().unwrap_or_default();
    if arms.is_empty() {
        return Some("`in_support_validation` passed but lists no arms".to_string());
    }
    for arm in &arms {
        let name = arm.get("name").and_then(Value::as_str).unwrap_or("an arm");
        match arm.get("in_support_success_rate").and_then(Value::as_f64) {
            None => {
                return Some(format!("`in_support_validation` gives no in_support_success_rate for {name}"))
            }
            Some(rate) if rate <= 0.0 => {
                return Some(format!(
                    "`in_support_validation` claims to pass while {name} succeeds in {rate} of its in-support episodes: an arm that cannot reproduce its own demonstrations is a build that did not work, not a measurement"
                ))
            }
            Some(_) => {}
        }
    }
    None
}

// --- pilot first ---------------------------------------------------------------
//
// OWNER DECISION 2026-10-06, after ScientistTwo (arXiv 2609.19644) whose ideas
// are screened on a benchmark slice before the full set. On
// cycle-a-20260919 every order ran at full size and was falsified
// afterwards -- v3 was ordered at 70 seeds (eight hours) before anyone asked
// whether its premise held, and the director later asked for a pilot itself.
// Every order now carries a pilot slice: the engineer runs it first, computes
// the order's pilot criteria on it, records them in manifest.pilot, and runs
// the full sweep only when every criterion holds. A pilot that fails is a
// blocker for the director, with the pilot's numbers, not a full sweep.

/// The number of seeds and episodes a pilot takes when the director gave none.
const DEFAULT_PILOT_SEEDS: usize = 2;
const DEFAULT_PILOT_EPISODES_PER_CONDITION: u64 = 10;

/// The pilot slice of an order: the director's `pilot` when it names seeds,
/// otherwise the order's first seeds at a reduced episode count, with no
/// criteria beyond the in-support and variance checks every run must pass.
pub(crate) fn simulation_order_pilot(order: &Value) -> Value {
    if let Some(pilot) = order.get("pilot").filter(|item| item.is_object()) {
        let has_seeds = pilot
            .get("seeds")
            .and_then(Value::as_array)
            .is_some_and(|seeds| !seeds.is_empty());
        if has_seeds {
            let mut pilot = pilot.clone();
            if !pilot.get("criteria").is_some_and(Value::is_array) {
                pilot["criteria"] = json!([]);
            }
            return pilot;
        }
    }
    let seeds: Vec<Value> = order
        .get("seeds")
        .and_then(Value::as_array)
        .map(|seeds| seeds.iter().take(DEFAULT_PILOT_SEEDS).cloned().collect())
        .unwrap_or_default();
    let episodes = order
        .get("episodes_per_condition")
        .and_then(Value::as_u64)
        .map(|count| count.min(DEFAULT_PILOT_EPISODES_PER_CONDITION))
        .unwrap_or(DEFAULT_PILOT_EPISODES_PER_CONDITION);
    json!({
        "seeds": seeds,
        "episodes_per_condition": episodes,
        "criteria": [],
        "harness_default": true,
    })
}

/// An order the director placed only to pilot a runner-up candidate: its pilot
/// is the whole job, and it never holds an analyst or a gate.
pub(crate) fn simulation_order_is_pilot_only(order: &Value) -> bool {
    order.get("pilot_only").and_then(Value::as_bool) == Some(true)
}

/// Why the manifest's pilot record does not license the data: no record, or a
/// pilot whose own criteria did not pass. A pilot-only order is settled by the
/// record either way.
fn manifest_pilot_reason(manifest: &Path, order: &Value) -> Option<String> {
    let Ok(value) = read_json(manifest) else {
        return Some("manifest.json could not be read".to_string());
    };
    let Some(pilot) = value.get("pilot").filter(|item| item.is_object()) else {
        return Some(
            "manifest.json records no `pilot`: the run never showed that its pilot slice passed the order's pilot criteria before the full sweep"
                .to_string(),
        );
    };
    if simulation_order_is_pilot_only(order) {
        return None;
    }
    match pilot.get("passed").and_then(Value::as_bool) {
        Some(true) => None,
        _ => {
            let note = pilot
                .get("note")
                .and_then(Value::as_str)
                .unwrap_or("no note recorded");
            Some(format!("the run's own pilot gate did not pass: {note}"))
        }
    }
}

/// The order's files exist AND the outcome they carry can answer it.
///
/// `simulation_order_outputs_present` is the file test; this is the one every
/// decision about the order should ask, because a CSV whose outcome never varied
/// settles nothing. The reason, when there is one, is what the next engineer
/// needs to be told.
pub(crate) fn simulation_order_unusable_reason(paths: &AppPaths, order: &Value) -> Option<String> {
    if !simulation_order_outputs_present(paths, order) {
        return None;
    }
    let (csv, manifest) = simulation_order_output_paths(paths, order)?;
    simulation_outcome_has_no_variance(&csv, order)
        .or_else(|| manifest_in_support_reason(&manifest))
        .or_else(|| manifest_pilot_reason(&manifest, order))
}

pub(crate) fn simulation_order_outputs_usable(paths: &AppPaths, order: &Value) -> bool {
    simulation_order_outputs_present(paths, order)
        && simulation_order_unusable_reason(paths, order).is_none()
}

pub(crate) fn simulation_order_issued_ms(paths: &AppPaths, cycle_id: &str) -> Option<i64> {
    read_json(&simulation_orders_record_path(paths, cycle_id))
        .ok()
        .and_then(|record| {
            record
                .get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(&raw).ok())
        .map(|time| time.timestamp_millis())
}

pub(crate) fn file_modified_ms(path: &Path) -> Option<u128> {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
}

/// A later LabDirector decision may reject and reissue an otherwise well-formed
/// bundle. In that case the files from the earlier attempt cannot settle the
/// new order merely because they still occupy its output path.
pub(crate) fn simulation_order_outputs_current(
    paths: &AppPaths,
    cycle_id: &str,
    order: &Value,
) -> bool {
    if !simulation_order_outputs_usable(paths, order) {
        return false;
    }
    let issued_ms = simulation_order_issued_ms(paths, cycle_id);
    let Some(issued_ms) = issued_ms else {
        return true;
    };
    let Some((csv, manifest)) = simulation_order_output_paths(paths, order) else {
        return false;
    };
    [csv, manifest]
        .iter()
        .all(|file| file_modified_ms(file).is_some_and(|ms| ms >= issued_ms.max(0) as u128))
}

/// Where the newest LabDirector answer on `simulation_orders` is kept.
pub(crate) fn simulation_orders_record_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-simulation-orders.json"))
}

fn simulation_order_execution_identity(order: &Value) -> Value {
    let emitted_columns = order
        .get("emitted_columns")
        .and_then(Value::as_array)
        .map(|columns| {
            columns
                .iter()
                .map(|column| {
                    json!({
                        "name": column.get("name").cloned().unwrap_or(Value::Null),
                        "unit": column.get("unit").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "request_id": order.get("request_id").cloned().unwrap_or(Value::Null),
        "simulator_backend": order.get("simulator_backend").cloned().unwrap_or(Value::Null),
        "conditions": order.get("conditions").cloned().unwrap_or(Value::Null),
        "seeds": order.get("seeds").cloned().unwrap_or(Value::Null),
        "episodes_per_condition": order.get("episodes_per_condition").cloned().unwrap_or(Value::Null),
        "step_or_time_budget": order.get("step_or_time_budget").cloned().unwrap_or(Value::Null),
        "emitted_columns": emitted_columns,
        "output_path": order.get("output_path").cloned().unwrap_or(Value::Null),
    })
}

fn simulation_orders_have_same_execution(previous: &Value, projected: &Value) -> bool {
    let identities = |value: &Value| {
        value.as_array().map(|orders| {
            orders
                .iter()
                .map(simulation_order_execution_identity)
                .collect::<Vec<_>>()
        })
    };
    identities(previous) == identities(projected)
}

/// Record a completed LabDirector lane's `simulation_orders`, when it answered.
///
/// Written when the lane completes, next to the hypothesis projection, because
/// the readers -- the analyst gate, the task graph and the role-plan refresh --
/// run on every scheduling pass, and a LabDirector lane result is about half a
/// megabyte (cycle-b-20260918: 103 results, 55 MB). Re-reading them all on
/// each pass to find the one that mentions orders is what this file avoids.
///
/// A director that never mentions the field -- one created before the directive
/// existed -- leaves an earlier director's orders in place; one that answers
/// `null` withdraws them.
pub(crate) fn record_lab_director_simulation_orders(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    decision: &Value,
) -> Result<Option<PathBuf>> {
    let Some(orders) = decision.get("simulation_orders") else {
        return Ok(None);
    };
    let path = simulation_orders_record_path(paths, cycle_id);
    let projected_orders = if orders.is_array() {
        orders.clone()
    } else {
        Value::Null
    };
    // Repeating an unchanged order is not another rejection epoch. Preserve
    // its first issue time so a routine director requery cannot make an
    // engineer's in-flight (or already valid) output stale after the fact.
    // MEASURED ON cycle-a-20260919, 2026-09-21: ten consecutive
    // requeries kept the same request, factors, seeds, cell size, schema and
    // budget but rephrased scenario/hypothesis prose (and alternated equivalent
    // host interpreter paths), resetting the epoch beyond a valid 10-cell
    // resumable bundle every time.
    let updated_at = read_json(&path)
        .ok()
        .filter(|previous| {
            previous
                .get("simulation_orders")
                .is_some_and(|orders| simulation_orders_have_same_execution(orders, &projected_orders))
        })
        .and_then(|previous| previous.get("updated_at").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(now_iso);
    write_json(
        &path,
        &json!({
            "generated_by": lane_id,
            "updated_at": updated_at,
            "simulation_orders": projected_orders,
        }),
    )?;
    Ok(Some(path))
}

/// The simulation orders the newest answering LabDirector issued. Runnable
/// orders only, first occurrence per request_id; empty when none were issued.
pub(crate) fn latest_lab_director_simulation_orders(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Vec<Value>> {
    let path = simulation_orders_record_path(paths, cycle_id);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let Ok(record) = read_json(&path) else {
        return Ok(Vec::new());
    };
    let mut seen = HashSet::new();
    Ok(record
        .get("simulation_orders")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|order| simulation_order_is_runnable(order))
                .filter(|order| seen.insert(simulation_order_request_id(order)))
                .cloned()
                .collect()
        })
        .unwrap_or_default())
}

/// Where one order stands with the engineers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SimulationOrderProgress {
    /// `episodes.csv` and `manifest.json` both exist.
    Fulfilled,
    /// An engineer lane for it is open.
    Running,
    /// No engineer lane is open and another attempt is due.
    NeedsEngineer,
    /// The attempts ran out: the engineer's blocker is the director's to
    /// answer, not something to wait on.
    Settled,
}

pub(crate) fn simulation_order_brief_id(order: &Value) -> String {
    format!("simulation-{}", simulation_order_request_id(order))
}

/// What the cycle index says a lane ended as, for lanes whose own files are gone.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. The self-healer returns a
/// retryable failed lane to pending by renaming its final-status.json,
/// run-state.json and result.json aside. On a cycle large enough to use the
/// cached lane-status index, the index still reported followup-engineer-02 as
/// `failed`, so nothing re-ran it -- while this function read the lane directory,
/// saw no final status, and called the order Running. The order waited on a lane
/// that no longer existed, and the two readers disagreed for as long as the
/// cycle lived.
fn lane_status_from_cycle_index(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> Option<String> {
    let path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    let state = read_json(&path).ok()?;
    state
        .get("lane_statuses")
        .and_then(Value::as_array)?
        .iter()
        .find(|lane| lane.get("lane_id").and_then(Value::as_str) == Some(lane_id))
        .and_then(|lane| lane.get("status").and_then(Value::as_str))
        .map(str::to_string)
}

pub(crate) fn simulation_order_progress(
    paths: &AppPaths,
    cycle_id: &str,
    order: &Value,
) -> Result<SimulationOrderProgress> {
    // MEASURED ON cycle-a-20260919, 2026-09-21: LabDirector rejected
    // the 09:39 stand-in pilot and reissued this order at 15:28, but the stale
    // files made the scheduler call it fulfilled forever, so no replacement
    // engineer could run.
    if simulation_order_outputs_current(paths, cycle_id, order) {
        return Ok(SimulationOrderProgress::Fulfilled);
    }
    let brief_id = simulation_order_brief_id(order);
    let issued_ms = simulation_order_issued_ms(paths, cycle_id).unwrap_or(0).max(0) as u128;
    // An engineer that ends without episodes.csv and manifest.json is an
    // attempt, whatever status it wrote.
    //
    // MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-01
    // ended `completed` with no outputs; the order counted as settled, so no
    // engineer was ever dispatched again. followup-runner-08 then blocked for
    // missing data and the LabDirector spent fifteen hours re-running novelty
    // adjudications instead of the approved experiment.
    let mut failed_attempts = 0usize;
    // Read the lanes directory, not the contract index: on a large cycle the
    // index is a cached status snapshot, and a lane created seconds ago is not in
    // it yet. MEASURED ON cycle-b-20260918, 2026-09-18: followup-engineer-01
    // and -02 were both created for superdex_shadow_continuation_v1, six seconds
    // apart, because the second pass could not see the first.
    let engineer_lanes = fs::read_dir(cycle_lanes_root(paths, cycle_id))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (lane_id, lane_dir) in engineer_lanes {
        if super::lane_identity::infer_followup_role_from_lane_id(&lane_id) != "engineer" {
            continue;
        }
        // The index fields, not the whole plan. A role plan on this cycle averages
        // 162 KB and there are 630 of them; read_role_plan_index_fields reads the
        // first 64 KB and caches by size+mtime, while read_json parses all of it
        // on every call -- and this scan runs several times per pass.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-23: 99.7 MB of role
        // plans and 280 MB of results under one cycle, and a pass that had not
        // dispatched a lane in six hours while burning 0.85 s of CPU per second.
        let Ok(Some(fields)) = super::followup_counts::read_role_plan_index_fields(
            &lane_dir.join("role-plan.json"),
        ) else {
            continue;
        };
        let same_order = fields.action_type.as_deref() == Some(SIMULATION_DATA_GENERATION_ACTION)
            && fields.source_brief_id.as_deref() == Some(brief_id.as_str());
        if !same_order {
            continue;
        }
        // A reissue starts a new attempt epoch as well as a new output epoch.
        // Otherwise the rejected attempt's exhausted cap prevents the very
        // replacement run the later director decision requested.
        if issued_ms > 0
            && file_modified_ms(&lane_dir.join("role-plan.json"))
                .is_some_and(|ms| ms < issued_ms)
        {
            continue;
        }
        let final_status = read_json(&lane_dir.join("final-status.json")).ok();
        // A lane the harness swept up after a restart never ran the order. It is
        // the owner's restart, not the engineer's attempt, and counting it spends
        // the order's budget on nothing -- the harness opens its own recovery
        // lane for exactly this case, which is the attempt.
        //
        // MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-04
        // was spawned 20 seconds before a rebuild stopped the cycle and came back
        // as "orphaned running lane detected during status reconciliation".
        if final_status
            .as_ref()
            .and_then(|status| status.get("reason").and_then(Value::as_str))
            .is_some_and(|reason| reason.contains("orphaned running lane"))
        {
            continue;
        }
        let status = final_status
            .and_then(|status| status.get("status").and_then(Value::as_str).map(str::to_string))
            .or_else(|| lane_status_from_cycle_index(paths, cycle_id, &lane_id));
        match status.as_deref() {
            None | Some("pending" | "running") => return Ok(SimulationOrderProgress::Running),
            Some(_) => {
                failed_attempts += 1;
                // MEASURED ON cycle-a-20260919, 2026-09-30: six
                // completed engineers returned the same structured CUDA / GPU
                // capability blocker. Treating each as an ordinary failed
                // attempt kept offering the unchanged order instead of sending
                // the unsatisfiable requirement to its decision owner.
                if lane_reasoned_blocker(paths, cycle_id, &lane_id).is_some() {
                    return Ok(SimulationOrderProgress::Settled);
                }
            }
        }
    }
    if failed_attempts >= max_failed_simulation_attempts() {
        Ok(SimulationOrderProgress::Settled)
    } else {
        Ok(SimulationOrderProgress::NeedsEngineer)
    }
}

/// Why an analyst must wait for an engineer before it can analyse anything.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18: with no bundle to fetch, every
/// analyst deferred on `no_matching_bundle`. The LabDirector's orders are the
/// cycle's data; until an engineer has written them there is nothing to
/// analyse. No orders, or orders an engineer has settled without data, hold no
/// one -- a cycle without a simulator behaves exactly as before.
pub(crate) fn simulation_data_wait_reason(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<String>> {
    for order in latest_lab_director_simulation_orders(paths, cycle_id)? {
        // A runner-up's pilot holds no one; see simulation_order_is_pilot_only.
        if simulation_order_is_pilot_only(&order) {
            continue;
        }
        match simulation_order_progress(paths, cycle_id, &order)? {
            SimulationOrderProgress::Running | SimulationOrderProgress::NeedsEngineer => {
                return Ok(Some(format!(
                    "waiting-for-simulation-data request_id={} (engineer)",
                    simulation_order_request_id(&order)
                )));
            }
            SimulationOrderProgress::Fulfilled | SimulationOrderProgress::Settled => {}
        }
    }
    Ok(None)
}

/// A CSV header split into column names. Handles quoted names; the engineer is
/// told to write plain ones.
fn csv_header_columns(line: &str) -> Vec<String> {
    let mut columns = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => columns.push(std::mem::take(&mut current).trim().to_string()),
            _ => current.push(ch),
        }
    }
    columns.push(current.trim().to_string());
    columns
}

/// Header columns and data-row count, read from the file itself.
fn csv_columns_and_rows(csv: &Path) -> Option<(Vec<String>, usize)> {
    use std::io::BufRead;
    let file = fs::File::open(csv).ok()?;
    let mut lines = std::io::BufReader::new(file).lines();
    let header = lines.next()?.ok()?;
    let rows = lines
        .map_while(|line| line.ok())
        .filter(|line| !line.trim().is_empty())
        .count();
    Some((csv_header_columns(header.trim_end_matches('\r')), rows))
}

/// Which emitted column carries the episode outcome, when the order declares one.
///
/// The order names its own columns, so this looks for a binary outcome the
/// design declared -- `unit: "binary"` -- and falls back to a column literally
/// called `success`.
fn outcome_column_of(order: &Value) -> Option<String> {
    let columns = order.get("emitted_columns").and_then(Value::as_array)?;
    columns
        .iter()
        .find(|column| {
            column.get("unit").and_then(Value::as_str) == Some("binary")
                && column
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case("success"))
        })
        .or_else(|| {
            columns.iter().find(|column| {
                column
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case("success"))
            })
        })
        .and_then(|column| column.get("name").and_then(Value::as_str))
        .map(str::to_string)
}

/// An outcome column with no variance measures nothing.
///
/// MEASURED ON cycle-a-20260919, 2026-09-21. followup-engineer-03 built
/// its three "policy arms" in 15 milliseconds from half a second of
/// demonstrations -- a ridge regression, a linear epsilon predictor and a
/// nearest-neighbour table standing in for Diffusion Policy, chunked behaviour
/// cloning and the retriever -- and swept 1458 episodes at 1 success. Zero
/// successes IN SUPPORT, where a working policy reproduces its own
/// demonstrations, is a broken build; every later contrast is then a comparison
/// of nothing with nothing. The rows existed, the files existed, and the order
/// would have counted as fulfilled.
///
/// This is not a quality score and it does not judge the science: it asks only
/// whether the outcome the design declared ever varied. An all-zero or all-one
/// column cannot support any contrast the hypothesis needs, whatever the design.
pub(crate) fn simulation_outcome_has_no_variance(csv: &Path, order: &Value) -> Option<String> {
    use std::io::BufRead;
    let column = outcome_column_of(order)?;
    let file = fs::File::open(csv).ok()?;
    let mut lines = std::io::BufReader::new(file).lines();
    let header = csv_header_columns(lines.next()?.ok()?.trim_end_matches('\r'));
    let index = header.iter().position(|name| name == &column)?;
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut rows = 0usize;
    for line in lines.map_while(|line| line.ok()) {
        if line.trim().is_empty() {
            continue;
        }
        let fields = csv_header_columns(line.trim_end_matches('\r'));
        let Some(value) = fields.get(index) else {
            continue;
        };
        rows += 1;
        seen.insert(value.trim().to_string());
        if seen.len() > 1 {
            return None;
        }
    }
    // Too few rows to say anything is a different problem, and the row-count
    // checks already own it.
    if rows < 2 {
        return None;
    }
    let only = seen.iter().next().cloned().unwrap_or_default();
    Some(format!(
        "every one of the {rows} episodes reports `{column}` = {only}: the outcome the design declared never varied, so no contrast in this order can be computed from it"
    ))
}

/// Each fulfilled order as a `candidate_datasets` entry, shaped like a fetched
/// bundle so the analyst's pick_dataset path reads it unchanged.
pub(crate) fn simulation_order_bundles(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    let mut bundles = Vec::new();
    for order in latest_lab_director_simulation_orders(paths, cycle_id)? {
        let Some((csv, manifest)) = simulation_order_output_paths(paths, &order) else {
            continue;
        };
        if !(csv.is_file() && manifest.is_file()) {
            continue;
        }
        let Some((columns, row_count)) = csv_columns_and_rows(&csv) else {
            continue;
        };
        let bundle_path = csv.parent().map(Path::to_path_buf).unwrap_or_default();
        let name = csv
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "episodes.csv".to_string());
        bundles.push(json!({
            "bundle_path": bundle_path.display().to_string(),
            "provider": "simulation",
            "request_id": simulation_order_request_id(&order),
            "manifest_path": manifest.display().to_string(),
            "simulator_backend": order.get("simulator_backend").cloned().unwrap_or(Value::Null),
            "hypothesis_link": order.get("hypothesis_link").cloned().unwrap_or(Value::Null),
            "csvs": [{
                "name": name,
                "csv_path": csv.display().to_string(),
                "row_count": row_count,
                "columns": columns,
                "format_hint": "csv",
            }],
        }));
    }
    Ok(bundles)
}

#[cfg(test)]
mod simulation_orders_tests {
    use super::*;
    use tempfile::TempDir;

    fn outcome_order() -> Value {
        json!({
            "request_id": "sweep",
            "emitted_columns": [
                {"name": "episode_id", "unit": "identifier", "meaning": "id"},
                {"name": "success", "unit": "binary", "meaning": "task completion"}
            ]
        })
    }

    fn write_csv(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("episodes.csv");
        fs::write(&path, body).unwrap();
        path
    }

    // cycle-a-20260919: 1458 episodes, 1 success, zero of them in
    // support. The files existed and the order would have counted as fulfilled.
    #[test]
    fn an_outcome_that_never_varied_is_reported_as_unusable() {
        let temp = TempDir::new().unwrap();
        let order = outcome_order();
        let csv = write_csv(
            temp.path(),
            "episode_id,success
a,0
b,0
c,0
",
        );
        let reason = simulation_outcome_has_no_variance(&csv, &order)
            .unwrap_or_else(|| panic!("an all-zero outcome must be rejected"));
        assert!(reason.contains("`success`"), "{reason}");
        assert!(reason.contains("never varied"), "{reason}");

        // All-one is the same failure seen from the other side.
        let ones = write_csv(temp.path(), "episode_id,success
a,1
b,1
");
        assert!(simulation_outcome_has_no_variance(&ones, &order).is_some());
    }

    // OWNER DECISION 2026-10-06: every order is piloted before the full sweep.
    #[test]
    fn an_order_without_a_pilot_gets_the_harness_default_and_a_pilot_only_order_is_known() {
        let order = json!({"request_id": "sweep", "seeds": [3, 4, 5, 6], "episodes_per_condition": 30});
        let pilot = simulation_order_pilot(&order);
        assert_eq!(pilot["seeds"], json!([3, 4]));
        assert_eq!(pilot["episodes_per_condition"], json!(10));
        assert_eq!(pilot["criteria"], json!([]));
        assert_eq!(pilot["harness_default"], json!(true));
        assert!(!simulation_order_is_pilot_only(&order));

        let directed = json!({
            "request_id": "sweep", "seeds": [3, 4, 5, 6], "episodes_per_condition": 30,
            "pilot": {"seeds": [5], "episodes_per_condition": 4, "criteria": [{"name": "floor", "metric": "success", "comparator": ">=", "threshold": 0.3}]},
            "pilot_only": true,
        });
        assert_eq!(simulation_order_pilot(&directed)["seeds"], json!([5]));
        assert!(simulation_order_is_pilot_only(&directed));
        // A pilot naming no seeds is no pilot.
        let empty = json!({"request_id": "sweep", "seeds": [3, 4], "pilot": {"seeds": []}});
        assert_eq!(simulation_order_pilot(&empty)["seeds"], json!([3, 4]));
    }

    #[test]
    fn data_without_a_passing_pilot_record_is_unusable_unless_the_order_was_pilot_only() {
        let temp = TempDir::new().unwrap();
        let manifest = temp.path().join("manifest.json");
        let order = outcome_order();
        fs::write(&manifest, "{}").unwrap();
        let reason = manifest_pilot_reason(&manifest, &order).expect("no pilot record must be refused");
        assert!(reason.contains("no `pilot`"), "{reason}");

        fs::write(&manifest, serde_json::to_string(&json!({"pilot": {"passed": false, "note": "in-support floor 0.12 < 0.30"}})).unwrap()).unwrap();
        let reason = manifest_pilot_reason(&manifest, &order).expect("a failed pilot must be refused");
        assert!(reason.contains("did not pass: in-support floor 0.12 < 0.30"), "{reason}");

        fs::write(&manifest, serde_json::to_string(&json!({"pilot": {"passed": true}})).unwrap()).unwrap();
        assert_eq!(manifest_pilot_reason(&manifest, &order), None);

        // A runner-up's pilot is the whole job: its record settles the order either way.
        let mut pilot_only = outcome_order();
        pilot_only["pilot_only"] = json!(true);
        fs::write(&manifest, serde_json::to_string(&json!({"pilot": {"passed": false}})).unwrap()).unwrap();
        assert_eq!(manifest_pilot_reason(&manifest, &pilot_only), None);
        fs::write(&manifest, "{}").unwrap();
        assert!(manifest_pilot_reason(&manifest, &pilot_only).is_some(), "a pilot-only order still needs its pilot record");
    }

    #[test]
    fn an_outcome_that_varied_is_left_alone() {
        let temp = TempDir::new().unwrap();
        let order = outcome_order();
        let csv = write_csv(temp.path(), "episode_id,success
a,0
b,1
c,0
");
        assert_eq!(simulation_outcome_has_no_variance(&csv, &order), None);
    }

    // An order that declares no binary outcome is not this check's business.
    #[test]
    fn an_order_with_no_declared_outcome_is_not_judged() {
        let temp = TempDir::new().unwrap();
        let order = json!({
            "request_id": "sweep",
            "emitted_columns": [{"name": "path_length", "unit": "meter", "meaning": "length"}]
        });
        let csv = write_csv(temp.path(), "path_length
1.0
1.0
");
        assert_eq!(simulation_outcome_has_no_variance(&csv, &order), None);
    }

    #[test]
    fn a_csv_header_reads_quoted_and_plain_columns() {
        assert_eq!(
            csv_header_columns("friction, seed,\"lift, success\""),
            vec!["friction", "seed", "lift, success"]
        );
    }

    #[test]
    fn row_count_ignores_the_header_and_blank_lines() {
        let temp = TempDir::new().unwrap();
        let csv = temp.path().join("episodes.csv");
        fs::write(&csv, "friction,seed,lift_success\r\n0.4,1,1\r\n0.8,1,0\r\n\r\n").unwrap();
        let (columns, rows) = csv_columns_and_rows(&csv).unwrap();
        assert_eq!(columns, vec!["friction", "seed", "lift_success"]);
        assert_eq!(rows, 2);
    }

    #[test]
    fn narrative_rephrasing_does_not_reissue_the_same_execution() {
        // MEASURED ON cycle-a-20260919, 2026-09-21: the v2 order's
        // scenario, hypothesis_link, column meanings and equivalent host
        // interpreter path drifted on each requery while all 90 cells stayed
        // fixed; byte equality repeatedly made its 10 completed cells stale.
        let first = json!([{
            "request_id": "coverage_decay_planar_push_power_v2",
            "simulator_backend": "mujoco",
            "interpreter_path": "C:/Users/user/Python311/python.exe",
            "scenario": "A planar Push-T scene.",
            "conditions": [{"factor": "distance", "levels": [0, 1]}],
            "seeds": [0, 1, 2],
            "episodes_per_condition": 2842,
            "step_or_time_budget": "15000 physics steps",
            "emitted_columns": [{"name": "success", "unit": "binary", "meaning": "completion"}],
            "output_path": ".research-lab/datasets/cycle/simulations/power_v2/episodes.csv",
            "hypothesis_link": "first wording"
        }]);
        let mut rephrased = first.clone();
        rephrased[0]["interpreter_path"] = json!("D:/projects/superdex/.venv/Scripts/python.exe");
        rephrased[0]["scenario"] = json!("One headless planar controlled-pusher scene.");
        rephrased[0]["hypothesis_link"] = json!("same contrast, rewritten");
        rephrased[0]["emitted_columns"][0]["meaning"] = json!("task success at deadline");
        assert!(simulation_orders_have_same_execution(&first, &rephrased));

        rephrased[0]["conditions"][0]["levels"] = json!([0, 0.5, 1]);
        assert!(!simulation_orders_have_same_execution(&first, &rephrased));
    }
}
