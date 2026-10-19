use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::model::AppPaths;

fn find_package_root(start: &Path) -> Option<PathBuf> {
    for candidate in start.ancestors() {
        let package_json = candidate.join("package.json");
        let cli_entry = candidate.join("src").join("cli").join("index.js");
        if package_json.is_file() && cli_entry.is_file() {
            return Some(candidate.to_path_buf());
        }
        let nested = candidate.join("researchlab");
        let nested_package = nested.join("package.json");
        let nested_cli = nested.join("src").join("cli").join("index.js");
        if nested_package.is_file() && nested_cli.is_file() {
            return Some(nested);
        }
    }
    None
}

pub(crate) fn app_paths() -> Result<AppPaths> {
    let cwd = env::current_dir()?;
    let package_root = env::var("RESEARCHLAB_PACKAGE_ROOT")
        .map(PathBuf::from)
        .ok()
        .or_else(|| find_package_root(&cwd))
        .or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| find_package_root(&path))
        })
        .unwrap_or_else(|| cwd.clone());
    let project_root = package_root.clone();
    let runtime_root = project_root.join(".research-lab");
    let data_root = env::var("RESEARCHLAB_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| runtime_root.join("datasets"));
    let stats_driver_script = env::var("RESEARCHLAB_PYTHON_STATS_DRIVER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            package_root
                .join("drivers")
                .join("analysis")
                .join("python_stats.py")
        });
    let literature_driver_script = env::var("RESEARCHLAB_LITERATURE_DRIVER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            package_root
                .join("drivers")
                .join("literature")
                .join("search.py")
        });

    Ok(AppPaths {
        project_root,
        runtime_root,
        data_root,
        stats_driver_script,
        literature_driver_script,
    })
}

pub(crate) fn ensure_runtime_dirs(paths: &AppPaths) -> Result<()> {
    for relative in [
        "state",
        "chronicle",
        "chronicle/briefs",
        "plans",
        "lanes",
        "bundles",
        "artifacts",
        "artifacts/stats",
        "reports",
        "papers",
        "events",
        "indexes",
        "viz",
        "policies",
        "runtime",
    ] {
        fs::create_dir_all(paths.runtime_root.join(relative))?;
    }
    Ok(())
}

pub(crate) fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(crate) fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub(crate) fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
        make_runtime_path_collaborative(parent);
    }
    let bytes = serde_json::to_vec_pretty(value)?;
    // Whole or not at all. fs::write truncates the file and then fills it, and
    // a reader in another process between the two sees an empty file.
    //
    // MEASURED ON cycle-a-20260919, 2026-10-01 09:59Z and 11:20Z: lane
    // runners rewrote their 700 KB result.json while run-plan read them,
    // run-plan died on "EOF while parsing a value at line 1 column 0", the
    // retries hit the same window, and run-research aborted twice. A rename
    // replaces the file in one step, and a writer killed midway leaves the old
    // file intact instead of an empty one.
    //
    // Where the rename cannot replace the file (Windows, while another process
    // holds it open without delete sharing) it is written in place as before.
    if replace_file_via_temp(path, &bytes).is_err() {
        fs::write(path, &bytes)?;
        make_runtime_path_collaborative(path);
    }
    Ok(())
}

static TEMP_WRITE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn replace_file_via_temp(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "runtime-json".to_string());
    // Unique per write: two threads of one process may write the same file.
    let seq = TEMP_WRITE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{file_name}.{}.{seq}.tmp", std::process::id()));
    // On disk before the rename, not only in the page cache. MEASURED ON
    // cycle-a-20260919, 2026-10-04 11:35Z: Windows ran out of virtual
    // memory, the WSL VM was restarted under the cycle, and every file written
    // in the seconds before -- renamed into place, never flushed -- came back
    // zero bytes (followup-lab-director-403's result and final status,
    // followup-analyst-347's run state). The planner then aborted on them five
    // times. The rename publishes the name; only sync_all publishes the bytes.
    let replaced = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        std::io::Write::write_all(&mut file, bytes)?;
        file.sync_all()?;
        drop(file);
        make_runtime_path_collaborative(&tmp_path);
        fs::rename(&tmp_path, path)
    })();
    if let Err(err) = replaced {
        let _ = fs::remove_file(&tmp_path);
        return Err(err.into());
    }
    make_runtime_path_collaborative(path);
    Ok(())
}

pub(crate) fn make_runtime_path_collaborative(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        let mode = if metadata.is_dir() { 0o777 } else { 0o666 };
        let mut permissions = metadata.permissions();
        if permissions.mode() & 0o777 == mode {
            return;
        }
        permissions.set_mode(mode);
        let _ = fs::set_permissions(path, permissions);
    }

    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// Read a lane's `result.json` without letting one bad file kill the cycle.
///
/// cycle-g-v85 lost 2h13m to a torn write: 64 invalid bytes inside the `stdout`
/// transcript of one lane out of 102. [`read_json`] uses `fs::read_to_string`,
/// which is strict UTF-8, and the lane-scanning call sites propagate with `?`,
/// so the whole run aborted -- 106 times, each one followed by a wrapper
/// restart, while the watchdog still reported `ok`.
///
/// Lossy decoding recovers the common case, where the JSON survived and only a
/// few bytes of transcript did not. When the file still will not parse, the lane
/// is RECORDED and skipped rather than fatal: a `.unreadable` marker lands beside
/// it and a greppable line goes to stderr. Returning Null silently would trade a
/// loud failure for the silent kind this repo has paid for again and again.
/// Who reads lane results, how often, and how many bytes it costs.
///
/// MEASURED on cycle-a-20260919, 2026-09-23: one `run-plan` pass read
/// 86 GB of character data in five minutes -- all of it out of the page cache,
/// because 645 lanes hold 404 MB of `result.json` + `role-plan.json` and the
/// pass sweeps them over and over. `rchar` says how much; it cannot say WHO, and
/// this counter answers that without a profiler in the container. Off unless
/// RESEARCHLAB_PROFILE_LANE_READS is set; the dump is rewritten every 2000 reads
/// so the answer is readable while the pass is still running.
static LANE_RESULT_READ_PROFILE: std::sync::OnceLock<
    std::sync::Mutex<(HashMap<String, (u64, u64)>, u64)>,
> = std::sync::OnceLock::new();

fn lane_read_profile_path() -> Option<&'static String> {
    static PATH: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PATH.get_or_init(|| env::var("RESEARCHLAB_PROFILE_LANE_READS").ok())
        .as_ref()
}

fn record_lane_result_read(caller: &std::panic::Location<'_>, byte_len: usize) {
    let Some(dump_path) = lane_read_profile_path() else {
        return;
    };
    let Ok(mut guard) = LANE_RESULT_READ_PROFILE
        .get_or_init(|| std::sync::Mutex::new((HashMap::new(), 0)))
        .lock()
    else {
        return;
    };
    let (counts, total) = &mut *guard;
    let site = format!("{}:{}", caller.file(), caller.line());
    let entry = counts.entry(site).or_insert((0, 0));
    entry.0 += 1;
    entry.1 += byte_len as u64;
    *total += 1;
    if *total % 2000 != 0 {
        return;
    }
    let mut rows: Vec<Value> = counts
        .iter()
        .map(|(site, (reads, bytes))| json!({ "site": site, "reads": reads, "bytes": bytes }))
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row["bytes"].as_u64().unwrap_or(0)));
    let payload = json!({ "total_reads": total, "by_call_site": rows });
    let _ = fs::write(
        dump_path,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    );
}

struct LaneResultFieldsEntry {
    len: u64,
    modified: Option<std::time::SystemTime>,
    fields: Value,
}

/// [`read_json`] for a file a pass reads far more often than anyone writes it.
///
/// MEASURED on cycle-a-20260919, 2026-09-23, in the same profile that
/// found the lane-result sweeps: one pass read the 9.5 MB literature summary 60
/// times (573 MB) to build a decision digest, and re-read analyst handoff plans
/// 3,792 times (170 MB). Nothing in a pass writes either one.
///
/// (len, modified) is the validity stamp, so a file that IS rewritten is re-read:
/// a rewrite that lands on the same byte length and the same nanosecond is not a
/// case this repo needs to defend against. Use this only where the caller is
/// reading state, never where it is confirming its own write.
pub(crate) fn read_json_cached(path: &Path) -> Result<Value> {
    let metadata = fs::metadata(path)?;
    let len = metadata.len();
    let modified = metadata.modified().ok();
    let cache_key = (path.to_path_buf(), String::new());
    if let Ok(cache) = lane_result_fields_cache().lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.len == len && entry.modified == modified {
                return Ok(entry.fields.clone());
            }
        }
    }
    let value = read_json(path)?;
    if let Ok(mut cache) = lane_result_fields_cache().lock() {
        cache.insert(
            cache_key,
            LaneResultFieldsEntry {
                len,
                modified,
                fields: value.clone(),
            },
        );
    }
    Ok(value)
}

fn lane_result_fields_cache(
) -> &'static std::sync::Mutex<HashMap<(PathBuf, String), LaneResultFieldsEntry>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<(PathBuf, String), LaneResultFieldsEntry>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// The few top-level keys a lane sweep actually consults, parsed once per lane.
///
/// MEASURED on cycle-a-20260919, 2026-09-23. One `run-plan` pass read
/// 86 GB in five minutes, none of it from the disk -- the same 645 lane results
/// re-read out of the page cache over and over. The profile named three call
/// sites for 87% of it, and every one of them parses a 0.5-1 MB `result.json` to
/// look at three to six shallow fields:
///
///   lane_counts.rs (completed_data_scout_count)      3232 reads  1471 MB
///   dependency_gates_01.rs (scout discovery summary) 1428 reads  1442 MB
///   requery_evidence_02.rs (lane produced evidence)  1416 reads   588 MB
///
/// A lane's result is written once, when the lane finishes, so (len, modified)
/// is a sound validity stamp -- the same one [`read_role_plan_index_fields`]
/// already relies on. The extracted subset is what is kept, not the parsed
/// document: caching whole results would hold the 294 MB of transcripts this is
/// trying to stop reading.
///
/// The caller names the keys it needs, and gets back an object carrying exactly
/// those, so a call site keeps reading the value the way it always did. A key
/// that is absent from the file is absent here too.
pub(crate) fn lane_result_fields(path: &Path, keys: &[&str]) -> Result<Value> {
    let metadata = fs::metadata(path)?;
    let len = metadata.len();
    let modified = metadata.modified().ok();
    let cache_key = (path.to_path_buf(), keys.join("\u{1}"));
    if let Ok(cache) = lane_result_fields_cache().lock() {
        if let Some(entry) = cache.get(&cache_key) {
            if entry.len == len && entry.modified == modified {
                return Ok(entry.fields.clone());
            }
        }
    }
    let result = read_lane_result_json(path)?;
    let mut fields = serde_json::Map::new();
    for key in keys {
        if let Some(value) = result.get(*key) {
            fields.insert((*key).to_string(), value.clone());
        }
    }
    let fields = Value::Object(fields);
    if let Ok(mut cache) = lane_result_fields_cache().lock() {
        cache.insert(
            cache_key,
            LaneResultFieldsEntry {
                len,
                modified,
                fields: fields.clone(),
            },
        );
    }
    Ok(fields)
}

#[track_caller]
pub(crate) fn read_lane_result_json(path: &Path) -> Result<Value> {
    let caller = std::panic::Location::caller();
    let bytes = fs::read(path).with_context(|| {
        format!(
            "failed to read {} at {}:{}",
            path.display(),
            caller.file(),
            caller.line()
        )
    })?;
    record_lane_result_read(caller, bytes.len());
    let text = String::from_utf8_lossy(&bytes);
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => Ok(value),
        Err(err) => {
            record_unreadable_lane_result(path, &err.to_string(), bytes.len());
            Ok(Value::Null)
        }
    }
}

fn record_unreadable_lane_result(path: &Path, error: &str, byte_len: usize) {
    eprintln!(
        "[harness] UNREADABLE_LANE_RESULT {} ({} bytes): {} -- lane skipped, cycle continues",
        path.display(),
        byte_len,
        error
    );
    let marker = path.with_extension("json.unreadable");
    let payload = serde_json::json!({
        "unreadable_lane_result": true,
        "path": path.display().to_string(),
        "bytes": byte_len,
        "error": error,
        "effect": "lane skipped by the harness; the cycle was not aborted",
    });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(&marker, text);
        make_runtime_path_collaborative(&marker);
    }
}

#[track_caller]
pub(crate) fn read_json(path: &Path) -> Result<Value> {
    let caller = std::panic::Location::caller();
    let raw = fs::read_to_string(path).with_context(|| {
        format!(
            "failed to read {} at {}:{}",
            path.display(),
            caller.file(),
            caller.line()
        )
    })?;
    record_lane_result_read(caller, raw.len());
    // Agents on Windows write lane artifacts through PowerShell, which prefixes a
    // UTF-8 byte-order mark that serde_json rejects.
    let parse = |text: &str| serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(text));
    // Named, so the next one is not an anonymous "EOF while parsing a value"
    // that neither the supervisor nor a person can trace to a file.
    let named = |err: serde_json::Error| {
        anyhow::Error::new(err).context(format!(
            "failed to parse {} at {}:{}",
            path.display(),
            caller.file(),
            caller.line()
        ))
    };
    match parse(&raw) {
        Ok(value) => Ok(value),
        // Writers outside this crate (agents, drivers) still truncate and then
        // write; a file caught in between is read once more.
        Err(err) if err.is_eof() => {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let again = fs::read_to_string(path).unwrap_or_default();
            parse(&again).map_err(named)
        }
        Err(err) => Err(named(err)),
    }
}

/// Read a lane's terminal marker without promoting an empty placeholder to a
/// cycle-wide failure. All other malformed JSON remains an error.
pub(crate) fn read_lane_final_status(path: &Path) -> Result<Option<Value>> {
    // MEASURED ON cycle-a-20260919, 2026-10-04:
    // followup-lab-director-403 left a zero-byte final-status.json. Strict lane
    // scans aborted every planning pass on that file, so completed analysis
    // could not advance to gate review. Empty proves no terminal state; skip
    // only that lane and let a later pass observe a completed rewrite.
    if fs::metadata(path)?.len() == 0 {
        return Ok(None);
    }
    match read_json(path) {
        Ok(value) => Ok(Some(value)),
        Err(_)
            if fs::metadata(path)
                .map(|metadata| metadata.len() == 0)
                .unwrap_or(false) =>
        {
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

pub(crate) fn cycle_lanes_root(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths.runtime_root.join("lanes").join(cycle_id)
}

pub(crate) fn lane_root(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    cycle_lanes_root(paths, cycle_id).join(lane_id)
}

pub(crate) fn lane_role_plan_path(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    lane_root(paths, cycle_id, lane_id).join("role-plan.json")
}

pub(crate) fn plans_root(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("plans")
}

pub(crate) fn events_root(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("events")
}

/// An append-only record of what the harness itself noticed or did to the
/// cycle (a revoked login, a stale director decision, files moved out of
/// state/). Not `<cycle>-cycle-events.jsonl`: that file is a projection the
/// aggregation rewrites from the lane events every pass, so a line appended to
/// it is gone by the next one (measured 2026-10-02: the quarantine's event was
/// lost within minutes).
pub(crate) fn harness_notices_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    events_root(paths).join(format!("{cycle_id}-harness-notices.jsonl"))
}

pub(crate) fn state_root(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("state")
}

pub(crate) fn viz_root(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("viz")
}

pub(crate) fn chronicle_briefs_root(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("chronicle")
        .join("briefs")
        .join(cycle_id)
}

pub(crate) fn chronicle_reports_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("chronicle")
        .join(format!("{cycle_id}-reports.jsonl"))
}

pub(crate) fn labdirector_inbox_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("runtime")
        .join(format!("{cycle_id}-labdirector-inbox.jsonl"))
}

pub(crate) fn labdirector_cursor_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("runtime")
        .join(format!("{cycle_id}-labdirector-cursor.json"))
}

// The lab director's decision ledger, one file per UTC hour:
//
//   runtime/<cycle>-labdirector-decisions/2026-10-12T03.jsonl
//
// MEASURED ON cycle-a-20260919, 2026-10-12: as one file it was
// 12.0 GB after 23 days -- 32,288 records, 11.9 GB of them the gate and
// approval reviews the orchestrator appended on every refresh. It follows the
// rule every append-only log of a cycle follows (segmented_log.rs).
pub(crate) fn labdirector_decisions_dir(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    segmented_log::labdirector_decision_log(paths, cycle_id).dir
}

// The single file the ledger used to be. Still read, as the oldest segment,
// for a cycle whose ledger has not been split.
pub(crate) fn labdirector_decisions_legacy_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    segmented_log::labdirector_decision_log(paths, cycle_id).legacy
}

pub(crate) fn labdirector_decision_segment_path(
    paths: &AppPaths,
    cycle_id: &str,
    now: chrono::DateTime<Utc>,
) -> PathBuf {
    segmented_log::labdirector_decision_log(paths, cycle_id).segment_path(now)
}

/// Oldest first; the unsplit single file, when present, before every segment.
pub(crate) fn labdirector_decision_segments(paths: &AppPaths, cycle_id: &str) -> Vec<PathBuf> {
    segmented_log::labdirector_decision_log(paths, cycle_id).segments()
}

pub(crate) fn append_labdirector_decision(paths: &AppPaths, cycle_id: &str, decision: &Value) -> Result<PathBuf> {
    segmented_log::labdirector_decision_log(paths, cycle_id).append(decision)
}

pub(crate) fn researchlab_auth_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("runtime").join("auth.json")
}

pub(crate) fn lane_process_path(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    lane_root(paths, cycle_id, lane_id).join("process.json")
}

pub(crate) fn lane_brief_marker_path(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    lane_root(paths, cycle_id, lane_id).join("brief-built.json")
}

pub(crate) fn stats_artifacts_root(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("artifacts").join("stats")
}

pub(crate) fn external_artifacts_root(paths: &AppPaths, cycle_id: &str, lane_id: &str) -> PathBuf {
    stats_artifacts_root(paths).join(cycle_id).join(lane_id)
}

mod datasets;
pub(crate) mod segmented_log;
pub(crate) use datasets::{
    choose_dataset_bundle_path, dataset_bundle_paths_visible_to_cycle, dataset_bundle_summary,
};
// Only referenced from support_tests.rs (compiled under cfg(test)).
#[cfg(test)]
pub(crate) use datasets::{canonical_or_self, DatasetBundleSource};

pub(crate) fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

pub(crate) fn dedup_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let key = slugify(&value);
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(value);
    }
    out
}

pub(crate) fn dedup_actions(values: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let key = slugify(
            value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("action"),
        );
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(value);
    }
    out
}

pub(crate) fn dedup_claims(values: Vec<Value>) -> Vec<Value> {
    fn merge_unique_array(target: &mut Value, field: &str, incoming: &Value) {
        let incoming_items = incoming
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if incoming_items.is_empty() {
            return;
        }
        let target_obj = match target.as_object_mut() {
            Some(obj) => obj,
            None => return,
        };
        let bucket = target_obj
            .entry(field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let bucket_array = match bucket.as_array_mut() {
            Some(items) => items,
            None => return,
        };
        for item in incoming_items {
            if !bucket_array.iter().any(|existing| existing == &item) {
                bucket_array.push(item);
            }
        }
    }

    let mut merged: HashMap<String, Value> = HashMap::new();
    let mut order = Vec::new();
    for value in values {
        let key = value
            .get("claim_id")
            .and_then(Value::as_str)
            .map(slugify)
            .unwrap_or_else(|| {
                slugify(
                    value
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("claim"),
                )
            });
        if key.is_empty() {
            continue;
        }
        if !merged.contains_key(&key) {
            order.push(key.clone());
            merged.insert(key.clone(), value);
            continue;
        }
        let existing = merged.get_mut(&key).unwrap();
        merge_unique_array(existing, "supporting_papers", &value);
        merge_unique_array(existing, "supporting_lanes", &value);
        merge_unique_array(existing, "supporting_hypotheses", &value);
        merge_unique_array(existing, "lane_summaries", &value);
        merge_unique_array(existing, "evidence_paths", &value);
        merge_unique_array(existing, "evidence_trace", &value);

        if existing
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            if let Some(obj) = existing.as_object_mut() {
                if let Some(reason) = value.get("reason") {
                    obj.insert("reason".to_string(), reason.clone());
                }
            }
        }
        let existing_current = existing
            .get("current")
            .and_then(Value::as_str)
            .unwrap_or("tentative");
        let incoming_current = value
            .get("current")
            .and_then(Value::as_str)
            .unwrap_or("tentative");
        let rank = |status: &str| match status {
            "robust" => 3,
            "exploratory" => 2,
            "tentative" => 1,
            _ => 0,
        };
        if rank(incoming_current) > rank(existing_current) {
            if let Some(obj) = existing.as_object_mut() {
                obj.insert(
                    "current".to_string(),
                    Value::String(incoming_current.to_string()),
                );
            }
        }
    }
    order
        .into_iter()
        .filter_map(|key| merged.remove(&key))
        .collect()
}

#[cfg(test)]
mod tests {
    // support_tests.rs stayed at core/ when support.rs became support/mod.rs.
    include!("../support_tests.rs");
}
