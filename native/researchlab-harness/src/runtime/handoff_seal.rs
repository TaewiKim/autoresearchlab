//! An analyst handoff is sealed when it is recorded, not interpreted when it runs.
//!
//! Everything a runner read from a handoff used to be resolved at run time, and
//! on cycle-a-20260919 (2026-09-29) each gap between writing a handoff
//! and running it cost lanes:
//!
//! - a dataset named relatively, or by bare file name, was looked up against
//!   whichever bundle the harness offered, and runners read the retired lead's
//!   `episodes.csv` instead of the one their handoff meant;
//! - a bundle the analyst pinned by SHA-256 at 06:05 was regenerated in place at
//!   06:56, so the three runners that started after it stopped on the pin -- and
//!   would have even reading the right path;
//! - a handoff had no identity but its path and mtime, so "has this already run"
//!   was inferred, and sixteen runners ran six handoffs.
//!
//! Sealing settles those once, when the analyst lane finishes. Each check that
//! names a data file is resolved to exactly one file, hashed, and its bundle
//! copied to a read-only snapshot keyed by that hash; the check and the
//! handoff's `dataset_root` are rewritten to the snapshot, so a later
//! regeneration of the source cannot reach this handoff. A name that matches
//! several files and no pin, or a pin the file no longer has, is refused here --
//! the handoff is marked not ready and goes back to the analyst with the reason
//! -- instead of being discovered by a runner. The seal carries an id derived
//! from what was sealed.
//!
//! Left as it was: a dataset the blueprint materialises itself (`procedural://`,
//! or a file that does not exist yet -- the blueprint contract allows both), and
//! a `dataset` that names a panel rather than a path.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::model::AppPaths;
use crate::core::support::now_iso;
use crate::labdirector::sha256_hex;

/// Directories never walked for datasets; the bundle walk skips the same.
const WALK_SKIP: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "artifacts",
    "chronicle",
    "lanes",
    "reports",
    "papers",
    "viz",
    "runtime",
    "indexes",
    "__pycache__",
];

const DATA_EXTENSIONS: &[&str] = &[
    "csv", "tsv", "parquet", "feather", "json", "jsonl", "npz", "npy", "h5", "hdf5", "pkl",
    "pickle", "xlsx", "txt", "gz",
];

/// Largest bundle copied into a snapshot. Above it the seal still records the
/// hash -- the blueprint's own pin check keeps failing closed -- but does not copy.
fn snapshot_max_bytes() -> u64 {
    std::env::var("RESEARCHLAB_HANDOFF_SEAL_MAX_BYTES")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(2 * 1024 * 1024 * 1024)
}

/// Snapshots live beside the datasets, not under them, so no dataset walk --
/// the harness's bundle choice or a reference lookup -- ever finds one.
pub(crate) fn sealed_datasets_root(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths.runtime_root.join("sealed-datasets").join(cycle_id)
}

fn is_sha256(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn hashes_in(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| is_sha256(token))
        .map(str::to_string)
        .collect()
}

fn strings_in(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings_in(item, out)),
        Value::Object(map) => map.values().for_each(|item| strings_in(item, out)),
        _ => {}
    }
}

fn looks_like_a_file(reference: &str) -> bool {
    if reference.contains('/') || reference.contains('\\') {
        return true;
    }
    Path::new(reference)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| DATA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_bundle_dir(dir: &Path) -> bool {
    fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.is_file()
                    && path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ext.eq_ignore_ascii_case("csv"))
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Directories a relative dataset reference may be relative to. A directory
/// holding a CSV is a bundle and what is inside it is the bundle's own: an
/// engineer's set-aside `attempt47_schema_mismatch/` is not a dataset.
fn dataset_directories(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        found.push(dir.clone());
        if depth >= max_depth || (dir != root && is_bundle_dir(&dir)) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| !name.starts_with('.') && !WALK_SKIP.contains(&name))
                    .unwrap_or(false)
            })
            .collect();
        children.sort();
        for child in children {
            stack.push((child, depth + 1));
        }
    }
    found
}

fn file_sha256(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

fn blocked_materialization(file: &Path) -> Option<String> {
    let manifest_path = file.parent()?.join("manifest.json");
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).ok()?).ok()?;
    let status = manifest.get("status").and_then(Value::as_str).unwrap_or("");
    let rows = manifest.get("rows").and_then(Value::as_u64);
    if rows == Some(0) && status.starts_with("blocked") {
        Some(format!(
            "{} is not materialized: its manifest records status `{status}` and zero rows",
            file.display()
        ))
    } else {
        None
    }
}

fn is_primary_analysis_check(handoff: &Value, check: &Value) -> bool {
    if handoff.pointer("/analysis_contract/contract_id").is_none() {
        return false;
    }
    let mapping = check.get("column_mapping");
    let role = mapping
        .and_then(Value::as_object)
        .and_then(|map| map.get("analysis_evidence_role"))
        .and_then(Value::as_str)
        .or_else(|| {
            mapping.and_then(Value::as_array).and_then(|items| {
                items.iter().find_map(|item| {
                    (item.get("key").and_then(Value::as_str) == Some("analysis_evidence_role"))
                        .then(|| item.get("column").and_then(Value::as_str))
                        .flatten()
                })
            })
        });
    role != Some("supporting")
}

fn skipped_in_copy(name: &str) -> bool {
    name.starts_with('.') || name == "__pycache__"
}

/// Total size of what a snapshot would copy, or None once past `limit`.
fn bundle_size(dir: &Path, limit: u64) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current).ok()?.flatten() {
            if skipped_in_copy(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                total += entry.metadata().ok()?.len();
                if total > limit {
                    return None;
                }
            }
        }
    }
    Some(total)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        if skipped_in_copy(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let source = entry.path();
        let target = to.join(entry.file_name());
        if source.is_dir() {
            copy_tree(&source, &target)?;
        } else if source.is_file() {
            fs::copy(&source, &target)?;
            let mut permissions = fs::metadata(&target)?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&target, permissions)?;
        }
    }
    Ok(())
}

enum Snapshot {
    Copied(PathBuf),
    Reused(PathBuf),
    TooLarge,
    Failed(String),
}

/// Copy `bundle` to `<sealed-datasets>/<cycle>/<sha16>-<bundle name>/`, once per
/// content. The data file is re-hashed in the copy: a bundle rewritten while it
/// was being copied is not a snapshot of anything.
fn snapshot_bundle(sealed_root: &Path, bundle: &Path, data_file: &Path, sha: &str) -> Snapshot {
    let bundle_name = bundle
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "bundle".to_string());
    let target = sealed_root.join(format!("{}-{}", &sha[..16], bundle_name));
    let relative = data_file.strip_prefix(bundle).unwrap_or(data_file).to_path_buf();
    if target.join(".sealed.json").is_file()
        && file_sha256(&target.join(&relative)).as_deref() == Some(sha)
    {
        return Snapshot::Reused(target);
    }
    if bundle_size(bundle, snapshot_max_bytes()).is_none() {
        return Snapshot::TooLarge;
    }
    let staging = sealed_root.join(format!(".staging-{}-{}", &sha[..16], std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    if let Err(error) = copy_tree(bundle, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Snapshot::Failed(format!("copying {} failed: {error}", bundle.display()));
    }
    if file_sha256(&staging.join(&relative)).as_deref() != Some(sha) {
        let _ = fs::remove_dir_all(&staging);
        return Snapshot::Failed(format!(
            "{} changed while it was being sealed",
            data_file.display()
        ));
    }
    let marker = json!({
        "source_bundle": bundle.display().to_string(),
        "data_file": relative.display().to_string(),
        "sha256": sha,
        "sealed_at": now_iso(),
    });
    let _ = fs::write(
        staging.join(".sealed.json"),
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    );
    if target.join(".sealed.json").is_file() {
        // Another seal of the same content published first; theirs is as good.
        let _ = fs::remove_dir_all(&staging);
        return Snapshot::Reused(target);
    }
    let _ = fs::remove_dir_all(&target);
    match fs::rename(&staging, &target) {
        Ok(()) => Snapshot::Copied(target),
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            if target.join(".sealed.json").is_file() {
                Snapshot::Reused(target)
            } else {
                Snapshot::Failed(format!("publishing the snapshot failed: {error}"))
            }
        }
    }
}

fn dataset_hashes_in(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| dataset_hashes_in(item, out)),
        Value::Object(map) => {
            for (key, item) in map {
                if key == "dataset_sha256" {
                    let mut strings = Vec::new();
                    strings_in(item, &mut strings);
                    out.extend(strings.iter().flat_map(|text| hashes_in(text)));
                } else {
                    dataset_hashes_in(item, out);
                }
            }
        }
        _ => {}
    }
}

fn hashes_in_sentences_with(text: &str, needle: &str) -> Vec<String> {
    text.lines()
        .flat_map(|line| line.split(". "))
        .filter(|sentence| sentence.to_ascii_lowercase().contains(needle))
        .flat_map(hashes_in)
        .collect()
}

/// Hashes the handoff actually ties to this dataset file. Explicit dataset-pin
/// fields and prose naming the file are pins; other SHA-shaped scientific IDs
/// are not.
fn hashes_tied_to(
    check: &Value,
    handoff: &Value,
    handoff_strings: &[String],
    file_name: &str,
) -> HashSet<String> {
    let mut tied = HashSet::new();
    dataset_hashes_in(handoff, &mut tied);
    for key in ["expected_sha256", "sha256"] {
        let mut strings = Vec::new();
        if let Some(value) = check.get(key) {
            strings_in(value, &mut strings);
        }
        tied.extend(strings.iter().flat_map(|text| hashes_in(text)));
    }
    let needle = file_name.to_ascii_lowercase();
    for text in handoff_strings {
        let lowered = text.to_ascii_lowercase();
        if !needle.is_empty() && lowered.contains(&needle) {
            tied.extend(hashes_in_sentences_with(text, &needle));
        }
        for phrase in ["dataset sha-256", "dataset sha256"] {
            if lowered.contains(phrase) {
                tied.extend(hashes_in_sentences_with(text, phrase));
            }
        }
    }
    tied
}

fn resolve_reference(
    reference: &str,
    named_root: Option<&Path>,
    directories: &[PathBuf],
    pinned: &HashSet<String>,
) -> Result<Option<PathBuf>, String> {
    let as_path = Path::new(reference);
    if as_path.is_absolute() {
        return Ok(as_path.is_file().then(|| as_path.to_path_buf()));
    }
    if let Some(root) = named_root {
        let candidate = root.join(reference);
        if candidate.is_file() {
            return Ok(Some(candidate));
        }
    }
    let mut matches: Vec<PathBuf> = directories
        .iter()
        .map(|dir| dir.join(reference))
        .filter(|path| path.is_file())
        .collect();
    if matches.len() > 1 && !pinned.is_empty() {
        let pinned_matches: Vec<PathBuf> = matches
            .iter()
            .filter(|path| {
                file_sha256(path)
                    .map(|sha| pinned.contains(&sha))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if !pinned_matches.is_empty() {
            matches = pinned_matches;
        }
    }
    match matches.len() {
        0 => Ok(None),
        1 => Ok(matches.pop()),
        n => Err(format!(
            "names `{reference}`, which is {n} different files under this cycle's datasets ({}) and no SHA-256 in the handoff picks one; name the file by absolute path",
            matches
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn existing_root(value: Option<&Value>) -> Option<PathBuf> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty() && !text.starts_with("procedural://"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

const DATA_KEYS: &[&str] = &["dataset", "dataset_root", "dataset_declared", "dataset_sha256"];

/// A dependency entry the stats driver would actually install: a bare package
/// spec (`name`, `name>=1.2`), as its PIP_INSTALL_NAME_PATTERN accepts, minus
/// the interpreter itself. Prose entries ("Python 3.12", "no external analysis
/// agent selected") are skipped by the driver and must not split an execution.
fn installable_dependency(entry: &str) -> Option<String> {
    let entry = entry.trim();
    let split = entry.find(|c: char| matches!(c, '=' | '<' | '>' | '!' | '~')).unwrap_or(entry.len());
    let (name, version) = entry.split_at(split);
    let mut chars = name.chars();
    if !chars.next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false)
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return None;
    }
    if !version.is_empty() {
        let operator_len = ["==", ">=", "<=", "~=", "!=", ">", "<"]
            .iter()
            .find(|op| version.starts_with(**op))
            .map(|op| op.len())?;
        let rest = &version[operator_len..];
        if rest.is_empty()
            || !rest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '+'))
        {
            return None;
        }
    }
    let lowered = entry.to_ascii_lowercase();
    let package = name.to_ascii_lowercase();
    if package == "python" || package == "python3" {
        return None;
    }
    Some(lowered)
}

/// What decides what a run of this handoff computes, and nothing else.
///
/// MEASURED ON cycle-a-20260919, 2026-09-29: six analyst lanes, asked
/// by three director decisions, produced six handoffs with the same 20,159-byte
/// blueprint, the same check id and the same sealed data. They differed only in
/// prose -- the goal sentence, the wording of the falsification rule, which
/// covariates were listed, how the dependency list described the interpreter --
/// and the code reads nothing from its spec but `column_mapping` and `dataset`.
/// Three runners ran them and returned the same result three times. The seal id
/// changes with every word, so it could not see that.
///
/// Per blueprint the identity is its code, the packages the driver would
/// install for it, its timeout request, the data by content, and of the spec the
/// driver hands the code (the check merged with the blueprint, as
/// blueprint_model.py builds it) only the fields the code names; plus the
/// derived-indicator specs the driver passes alongside.
fn execution_identity(handoff: &Value) -> Value {
    let checks: Vec<Value> = handoff
        .get("handoff_checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let check_for = |check_id: &Value| -> Value {
        checks
            .iter()
            .find(|check| check.get("check_id") == Some(check_id))
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    let blueprints: Vec<Value> = handoff
        .get("validation_code_blueprints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let blueprint_identity: Vec<Value> = blueprints
        .iter()
        .map(|blueprint| {
            let code = blueprint.get("code").and_then(Value::as_str).unwrap_or("");
            let names = |key: &str| code.contains(&format!("\"{key}\"")) || code.contains(&format!("'{key}'"));
            let check_id = blueprint.get("check_id").cloned().unwrap_or(Value::Null);
            let check = check_for(&check_id);
            let mut spec = check.as_object().cloned().unwrap_or_default();
            if let Some(map) = blueprint.as_object() {
                for (key, value) in map {
                    spec.insert(key.clone(), value.clone());
                }
            }
            let mut read_fields = serde_json::Map::new();
            for (key, value) in &spec {
                if !DATA_KEYS.contains(&key.as_str())
                    && !matches!(key.as_str(), "code" | "code_file" | "check_id" | "dependencies")
                    && names(key)
                {
                    read_fields.insert(key.clone(), value.clone());
                }
            }
            let mut packages: Vec<String> = blueprint
                .get("dependencies")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).filter_map(installable_dependency).collect())
                .unwrap_or_default();
            packages.sort();
            packages.dedup();
            json!({
                "check_id": check_id,
                "code": code,
                "packages": packages,
                "requested_timeout_seconds": blueprint.get("requested_timeout_seconds").cloned().unwrap_or(Value::Null),
                "data": check
                    .get("dataset_sha256")
                    .or_else(|| check.get("dataset"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "spec_fields_read": Value::Object(read_fields),
            })
        })
        .collect();
    json!({
        "blueprints": blueprint_identity,
        "derived_indicators": handoff.get("derived_indicators").cloned().unwrap_or(Value::Null),
    })
}

fn looks_like_runner_lane(lane_id: &str) -> bool {
    let trimmed = lane_id.strip_prefix("followup-").unwrap_or(lane_id);
    trimmed == "lab-runner"
        || trimmed.starts_with("lab-runner-")
        || trimmed == "runner"
        || trimmed.starts_with("runner-")
}

fn role_plan_handoff_path(role_plan: &Value) -> Option<String> {
    [
        "/planner_metadata/analyst_handoff_path",
        "/analyst_handoff_path",
        "/planner_metadata/analysis_request/handoff_path",
        "/analysis_request/handoff_path",
    ]
    .iter()
    .filter_map(|pointer| role_plan.pointer(pointer).and_then(Value::as_str))
    .map(str::trim)
    .find(|path| !path.is_empty())
    .map(str::to_string)
}

fn execution_id_at(path: &Path) -> Option<String> {
    crate::core::support::read_json_cached(path)
        .ok()?
        .pointer("/handoff_seal/execution_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// A run that failed before measuring anything is not a run of this execution:
/// the same code on the same data may be retried, e.g. after an engineer fixed
/// the environment. Same rule as the evidence picker's
/// isFailedExecutionNotEvidence.
fn result_measured_something(result: &Value) -> bool {
    if result.get("status").and_then(Value::as_str) != Some("failed") {
        return true;
    }
    let summary = result.get("validation_summary").cloned().unwrap_or(Value::Null);
    if summary
        .get("blueprints_passed")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
    {
        return true;
    }
    summary
        .get("handoff_check_resolutions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .any(|item| item.get("valid_falsification_result") == Some(&json!(true)))
        })
        .unwrap_or(false)
}

/// The runner lane that already runs -- or ran, and measured something -- the
/// same execution as the handoff at `handoff_path`, through a different handoff.
/// None when the handoff carries no execution id (it predates sealing).
pub(crate) fn execution_served_by(
    paths: &AppPaths,
    cycle_id: &str,
    handoff_path: &str,
) -> anyhow::Result<Option<String>> {
    let Some(execution_id) = execution_id_at(Path::new(handoff_path)) else {
        return Ok(None);
    };
    let lanes_root = crate::core::support::cycle_lanes_root(paths, cycle_id);
    let Ok(entries) = fs::read_dir(&lanes_root) else {
        return Ok(None);
    };
    let own = fs::canonicalize(handoff_path).unwrap_or_else(|_| PathBuf::from(handoff_path));
    let mut lanes: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .map(|entry| (entry.file_name().to_string_lossy().to_string(), entry.path()))
        .filter(|(lane_id, _)| looks_like_runner_lane(lane_id))
        .collect();
    lanes.sort();
    for (lane_id, lane_dir) in lanes {
        let Ok(role_plan) = crate::core::support::read_json_cached(&lane_dir.join("role-plan.json")) else {
            continue;
        };
        let Some(bound) = role_plan_handoff_path(&role_plan) else {
            continue;
        };
        let bound_path = fs::canonicalize(&bound).unwrap_or_else(|_| PathBuf::from(&bound));
        if bound_path == own || execution_id_at(&bound_path).as_deref() != Some(execution_id.as_str()) {
            continue;
        }
        let final_status_path = lane_dir.join("final-status.json");
        if !final_status_path.exists() {
            return Ok(Some(lane_id));
        }
        let final_status = crate::core::support::read_json_cached(&final_status_path).unwrap_or(Value::Null);
        if final_status.get("status").and_then(Value::as_str) != Some("completed") {
            continue;
        }
        let result_path = final_status
            .get("result_path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .unwrap_or_else(|| lane_dir.join("result.json"));
        let Ok(result) = crate::core::support::read_json_cached(&result_path) else {
            continue;
        };
        if result_measured_something(&result) {
            return Ok(Some(lane_id));
        }
    }
    Ok(None)
}

/// Seal `handoff` in place and return the seal record written into it.
pub(crate) fn seal_analyst_handoff(paths: &AppPaths, cycle_id: &str, handoff: &mut Value) -> Value {
    let datasets_root = paths.runtime_root.join("datasets").join(cycle_id);
    let sealed_root = sealed_datasets_root(paths, cycle_id);
    let directories = if datasets_root.is_dir() {
        dataset_directories(&datasets_root, 6)
    } else {
        Vec::new()
    };
    let mut handoff_strings = Vec::new();
    strings_in(handoff, &mut handoff_strings);
    let handoff_root = existing_root(handoff.get("dataset_root"));

    let mut datasets = Vec::new();
    let mut rejections: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut sealed_bundles: Vec<(PathBuf, PathBuf)> = Vec::new();

    let checks = handoff
        .get("handoff_checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut rewritten_checks = checks.clone();
    for (index, check) in checks.iter().enumerate() {
        let check_id = check
            .get("check_id")
            .and_then(Value::as_str)
            .unwrap_or("check")
            .to_string();
        let reference = check
            .get("dataset")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let check_root = check.get("dataset_root").and_then(Value::as_str).unwrap_or("");
        if reference.starts_with("procedural://") || check_root.starts_with("procedural://") {
            datasets.push(json!({"check_id": check_id, "declared": reference, "outcome": "procedural"}));
            continue;
        }
        if reference.is_empty() || !looks_like_a_file(&reference) {
            datasets.push(json!({"check_id": check_id, "declared": reference, "outcome": "not_a_file_reference"}));
            continue;
        }
        let named_root = existing_root(check.get("dataset_root")).or_else(|| handoff_root.clone());
        let file_name = Path::new(&reference)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        // MEASURED ON cycle-a-20260919, 2026-10-14: abstract hashes,
        // objective hashes, and an analysis contract ID inside three checks were
        // mistaken for dataset pins, so valid handoffs were repeatedly refused.
        let tied = hashes_tied_to(check, handoff, &handoff_strings, &file_name);
        let resolved =
            match resolve_reference(&reference, named_root.as_deref(), &directories, &tied) {
                Ok(resolved) => resolved,
                Err(reason) => {
                    rejections.push(format!("check `{check_id}` {reason}"));
                    datasets.push(json!({"check_id": check_id, "declared": reference, "outcome": "ambiguous"}));
                    continue;
                }
            };
        let Some(file) = resolved else {
            datasets.push(json!({"check_id": check_id, "declared": reference, "outcome": "not_found_left_to_blueprint"}));
            continue;
        };
        let Some(sha) = file_sha256(&file) else {
            rejections.push(format!(
                "check `{check_id}` names {}, which cannot be read",
                file.display()
            ));
            continue;
        };
        // MEASURED ON cycle-a-20260919, 2026-10-16: analyst 876
        // marked a blocked_pre_pilot, zero-row simulation bundle runner-ready;
        // runner 359 then executed an immutable blueprint that could not estimate
        // any primary contrast. A content hash proves identity, not materialization.
        if is_primary_analysis_check(handoff, check) {
            if let Some(reason) = blocked_materialization(&file) {
                rejections.push(format!("check `{check_id}` {reason}"));
                datasets.push(json!({
                    "check_id": check_id,
                    "declared": reference,
                    "resolved": file.display().to_string(),
                    "sha256": sha,
                    "outcome": "not_materialized",
                }));
                continue;
            }
        }
        if !tied.is_empty() && !tied.contains(&sha) {
            let mut tied_list = tied.into_iter().collect::<Vec<_>>();
            tied_list.sort();
            rejections.push(format!(
                "check `{check_id}` pins {} for {}, but that file now has SHA-256 {sha}: it changed after the pin -- re-pin against the current file or name the version you meant",
                tied_list.join(" / "),
                file.display()
            ));
            datasets.push(json!({"check_id": check_id, "declared": reference, "resolved": file.display().to_string(), "sha256": sha, "outcome": "pin_mismatch"}));
            continue;
        }
        let bundle = file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| file.clone());
        let relative = file.strip_prefix(&bundle).unwrap_or(&file).to_path_buf();
        let (snapshot, sealed_file, sealed_bundle) =
            match snapshot_bundle(&sealed_root, &bundle, &file, &sha) {
                Snapshot::Copied(dir) => ("copied", dir.join(&relative), Some(dir)),
                Snapshot::Reused(dir) => ("reused", dir.join(&relative), Some(dir)),
                Snapshot::TooLarge => ("skipped_too_large", file.clone(), None),
                Snapshot::Failed(reason) => {
                    rejections.push(format!("check `{check_id}`: {reason}"));
                    datasets.push(json!({"check_id": check_id, "declared": reference, "resolved": file.display().to_string(), "sha256": sha, "outcome": "snapshot_failed"}));
                    continue;
                }
            };
        if let Some(dir) = &sealed_bundle {
            sealed_bundles.push((bundle.clone(), dir.clone()));
        }
        let rewritten = &mut rewritten_checks[index];
        rewritten["dataset_declared"] = json!(reference);
        rewritten["dataset"] = json!(sealed_file.display().to_string());
        rewritten["dataset_sha256"] = json!(sha);
        if let Some(dir) = &sealed_bundle {
            rewritten["dataset_root"] = json!(dir.display().to_string());
        }
        datasets.push(json!({
            "check_id": check_id,
            "declared": reference,
            "resolved": file.display().to_string(),
            "sha256": sha,
            "sealed_path": sealed_file.display().to_string(),
            "snapshot": snapshot,
            "outcome": "sealed",
        }));
    }

    if rejections.is_empty() {
        handoff["handoff_checks"] = Value::Array(rewritten_checks);
        if let Some((source_bundle, sealed_dir)) = sealed_bundles.first() {
            let declared_root = handoff
                .get("dataset_root")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            if declared_root.is_none() || declared_root.as_deref() == Some(source_bundle.as_path()) {
                if let Some(original) = handoff.get("dataset_root").cloned() {
                    handoff["dataset_root_declared"] = original;
                }
                handoff["dataset_root"] = json!(sealed_dir.display().to_string());
            }
        }
        // Blueprint code that opens the source bundle itself reads the live
        // files, not the snapshot; say so where the director and gate can see it.
        let codes: Vec<String> = handoff
            .get("validation_code_blueprints")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("code").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        for (source_bundle, _) in &sealed_bundles {
            let source = source_bundle.display().to_string();
            if codes.iter().any(|code| code.contains(&source)) {
                warnings.push(format!(
                    "blueprint code opens {source} directly, which reads the live bundle and not the sealed snapshot; read the dataset from the check spec"
                ));
            }
        }
    }

    let status = if !rejections.is_empty() {
        "rejected"
    } else if datasets.iter().any(|item| item["outcome"] == "sealed") {
        "sealed"
    } else {
        "nothing_to_seal"
    };
    let identity = json!({
        "handoff_checks": handoff.get("handoff_checks").cloned().unwrap_or(Value::Null),
        "validation_code_blueprints": handoff.get("validation_code_blueprints").cloned().unwrap_or(Value::Null),
        "dataset_root": handoff.get("dataset_root").cloned().unwrap_or(Value::Null),
    });
    let seal = json!({
        "status": status,
        "seal_id": sha256_hex(identity.to_string().as_bytes()),
        "execution_id": sha256_hex(execution_identity(handoff).to_string().as_bytes()),
        "sealed_at": now_iso(),
        "datasets": datasets,
        "rejections": rejections,
        "warnings": warnings,
    });
    if status == "rejected" {
        let reason = format!("handoff seal rejected: {}", rejections.join("; "));
        if !handoff
            .get("analysis_design_memo")
            .map(Value::is_object)
            .unwrap_or(false)
        {
            handoff["analysis_design_memo"] = json!({});
        }
        handoff["analysis_design_memo"]["final_handoff_readiness"] = json!({
            "ready_for_runner": false,
            "blocking_reason": reason,
            "fallback_topic_or_path_token_checks_allowed": false,
        });
    }
    handoff["handoff_seal"] = seal.clone();
    seal
}

/// The action that returns a refused handoff to the analyst, or None when the
/// handoff was not refused. Keyed on the handoff path and the reasons, so a
/// pass that sees the same refusal again adds nothing new.
pub(crate) fn seal_rejection_revision_action(handoff_path: &str, handoff: &Value) -> Option<Value> {
    let seal = handoff.get("handoff_seal")?;
    if seal.get("status").and_then(Value::as_str) != Some("rejected") {
        return None;
    }
    let reasons: Vec<String> = seal
        .get("rejections")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(json!({
        "brief_id": "analyst-handoff-revision",
        "description": format!(
            "Revise the analyst handoff {handoff_path}: the harness could not seal it, so no runner will execute it. {} Emit a revised handoff-validation-plan.json that names every dataset file by absolute path (or sets dataset_root), pins each file's current SHA-256, and reads the dataset from the check spec.",
            reasons.join(" ")
        ),
        "type": "methods_followup",
        "priority": "high",
        "priority_score": 284,
        "preferred_role": "analyst",
        "target_rubric": "reproducibility",
        "target_score": 95,
        "current_score": Value::Null,
        "blocker_reasons": reasons,
        "analysis_request": {
            "source": "handoff-seal-rejected",
            "handoff_path": handoff_path,
            "handoff_seal": seal,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    struct Fixture {
        _temp: TempDir,
        paths: AppPaths,
        sims: PathBuf,
    }

    fn fixture() -> Fixture {
        let temp = TempDir::new().unwrap();
        let runtime_root = temp.path().join(".research-lab");
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: runtime_root.clone(),
            data_root: runtime_root.join("datasets"),
            stats_driver_script: PathBuf::from("/dev/null"),
            literature_driver_script: PathBuf::from("/dev/null"),
        };
        let sims = runtime_root.join("datasets").join("cyc").join("simulations");
        write(&sims.join("replanning_v1").join("episodes.csv"), "policy,success\nA,1\n");
        write(&sims.join("replanning_v1").join("manifest.json"), "{}");
        write(&sims.join("topology_v1").join("episodes.csv"), "policy,topology\nA,left\n");
        write(&sims.join("topology_v1").join("manifest.json"), "{\"rows\": 1}");
        write(&sims.join("topology_v1").join("checkpoints").join("seed0.pt"), "weights");
        Fixture {
            _temp: temp,
            paths,
            sims,
        }
    }

    fn handoff(dataset: &str, extra: Value) -> Value {
        let mut check = json!({"check_id": "CHK1", "dataset": dataset});
        if let Value::Object(map) = extra {
            for (key, value) in map {
                check[key] = value;
            }
        }
        json!({
            "handoff_checks": [check],
            "validation_code_blueprints": [{"blueprint_id": "BP1", "check_id": "CHK1", "code": "import json\nprint(json.dumps({}))"}],
        })
    }

    #[test]
    fn a_relative_reference_is_sealed_to_a_snapshot_later_edits_cannot_reach() {
        let fx = fixture();
        let mut plan = handoff("topology_v1/episodes.csv", json!({}));
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "sealed", "{seal}");
        let sealed = PathBuf::from(plan["handoff_checks"][0]["dataset"].as_str().unwrap());
        assert!(sealed.starts_with(sealed_datasets_root(&fx.paths, "cyc")));
        assert_eq!(plan["handoff_checks"][0]["dataset_declared"], "topology_v1/episodes.csv");
        let root = PathBuf::from(plan["dataset_root"].as_str().unwrap());
        assert!(root.join("manifest.json").is_file(), "the manifest travels with the data");
        assert!(
            root.join("checkpoints").join("seed0.pt").is_file(),
            "so do the files the manifest names"
        );

        // The engineer regenerates the source bundle in place.
        write(&fx.sims.join("topology_v1").join("episodes.csv"), "policy,topology\nB,right\n");
        assert_eq!(fs::read_to_string(&sealed).unwrap(), "policy,topology\nA,left\n");
    }

    #[test]
    fn the_same_content_is_copied_once() {
        let fx = fixture();
        let mut first = handoff("topology_v1/episodes.csv", json!({}));
        let mut second = handoff("topology_v1/episodes.csv", json!({"goal": "another check"}));
        seal_analyst_handoff(&fx.paths, "cyc", &mut first);
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut second);
        assert_eq!(seal["datasets"][0]["snapshot"], "reused");
        assert_eq!(first["dataset_root"], second["dataset_root"]);
    }

    #[test]
    fn a_bare_name_matching_several_files_goes_back_to_the_analyst() {
        let fx = fixture();
        let mut plan = handoff("episodes.csv", json!({}));
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "rejected");
        assert!(seal["rejections"][0].as_str().unwrap().contains("2 different files"));
        assert!(!crate::labdirector::analyst_handoff_is_executable(&plan));
        assert_eq!(
            plan["handoff_checks"][0]["dataset"], "episodes.csv",
            "a refused handoff is not rewritten"
        );
        let action = seal_rejection_revision_action("/lanes/a/handoff-validation-plan.json", &plan)
            .expect("a refused handoff goes back to the analyst");
        assert_eq!(action["preferred_role"], "analyst");
        assert_eq!(action["brief_id"], "analyst-handoff-revision");
        assert!(action["description"].as_str().unwrap().contains("2 different files"));
    }

    #[test]
    fn a_pinned_hash_picks_between_several_files() {
        let fx = fixture();
        let topology_sha = sha256_hex(b"policy,topology\nA,left\n");
        let mut plan = handoff("episodes.csv", json!({"expected_sha256": topology_sha}));
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "sealed", "{seal}");
        assert!(seal["datasets"][0]["resolved"].as_str().unwrap().contains("topology_v1"));
    }

    #[test]
    fn a_pin_the_file_no_longer_has_is_refused_before_any_runner() {
        let fx = fixture();
        let stale = sha256_hex(b"what the file held when the analyst read it");
        let mut plan = handoff("topology_v1/episodes.csv", json!({}));
        plan["analyst_quality_standard"] = json!({
            "required_validation_checks": [format!("episodes.csv SHA-256 equals {stale}")]
        });
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "rejected");
        assert!(seal["rejections"][0].as_str().unwrap().contains("changed after the pin"));
    }

    #[test]
    fn a_blocked_zero_row_simulation_cannot_be_declared_runner_ready() {
        // MEASURED ON cycle-a-20260919, 2026-10-16: runner 359 was
        // dispatched on this exact manifest state and necessarily emitted no
        // primary contrast estimates.
        let fx = fixture();
        let bundle = fx.sims.join("blocked_v2");
        write(&bundle.join("episodes.csv"), "seed,policy,success\n");
        write(
            &bundle.join("manifest.json"),
            r#"{"request_id":"action_multimodality_coverage_interaction_v2","status":"blocked_pre_pilot","rows":0}"#,
        );
        let mut plan = handoff("blocked_v2/episodes.csv", json!({}));
        plan["analysis_contract"] = json!({"contract_id": "analysis:current"});
        plan["analysis_design_memo"] = json!({
            "final_handoff_readiness": {"ready_for_runner": true, "stated_by": "analyst"}
        });

        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);

        assert_eq!(seal["status"], "rejected", "{seal}");
        assert_eq!(seal["datasets"][0]["outcome"], "not_materialized");
        assert!(seal["rejections"][0]
            .as_str()
            .unwrap()
            .contains("blocked_pre_pilot"));
        assert!(!crate::labdirector::analyst_handoff_is_executable(&plan));
    }

    #[test]
    fn scientific_hashes_inside_a_check_are_not_dataset_pins() {
        // MEASURED ON cycle-a-20260919, 2026-10-14: analyst-741,
        // analyst-758, and analyst-818 were refused because the seal compared
        // abstract/objective hashes and an analysis contract ID to the file.
        let fx = fixture();
        let abstract_sha = sha256_hex(b"reviewed abstract");
        let objective_hash = sha256_hex(b"research objective");
        let contract_id = sha256_hex(b"analysis contract");
        let dataset_sha = sha256_hex(b"policy,topology\nA,left\n");
        let cases = [
            json!({
                "check_id": "aca-exact-hash-component-audit-v1",
                "column_mapping": [
                    {"key": "abstract_sha256", "column": abstract_sha},
                    {"key": "objective_hash", "column": objective_hash},
                ],
            }),
            json!({
                "check_id": "PROC-NOVELTY-AUDIT-01",
                "sample_filters": [format!("objective_hash={objective_hash}")],
            }),
            json!({
                "check_id": "contract_v3_construct_and_interaction_audit",
                "column_mapping": [{
                    "key": "analysis_contract_id",
                    "column": format!("analysis:{contract_id}"),
                }],
            }),
        ];
        for (index, extra) in cases.into_iter().enumerate() {
            let mut plan = handoff("topology_v1/episodes.csv", extra);
            if index == 0 {
                plan["summary"] = json!(format!(
                    "The exact reviewed abstract SHA-256 is {abstract_sha}, and the objective hash is {objective_hash}. The component audit keeps these scientific identities distinct from the artifact content identity. The durable mapping used by this audit is stored at /cycle/topology_v1/episodes.csv."
                ));
            }
            if index == 2 {
                plan["analysis_contract"] = json!({
                    "contract_id": format!("analysis:{contract_id}"),
                    "operational_spec": {"dataset_sha256": dataset_sha},
                });
            }
            let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
            assert_eq!(seal["status"], "sealed", "case {index}: {seal}");
        }
    }

    #[test]
    fn what_the_blueprint_builds_itself_is_left_to_it() {
        let fx = fixture();
        for dataset in [
            "procedural://sweep",
            "results_not_yet_written.csv",
            "GSE123 expression panel",
        ] {
            let mut plan = handoff(dataset, json!({}));
            let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
            assert_eq!(seal["status"], "nothing_to_seal", "{dataset}: {seal}");
            assert_eq!(plan["handoff_checks"][0]["dataset"], dataset);
            assert!(seal_rejection_revision_action("p", &plan).is_none());
        }
    }

    #[test]
    fn a_named_dataset_root_is_honoured() {
        let fx = fixture();
        let named = fx.sims.join("replanning_v1").display().to_string();
        let mut plan = handoff("episodes.csv", json!({}));
        plan["dataset_root"] = json!(named);
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "sealed", "{seal}");
        assert!(seal["datasets"][0]["resolved"].as_str().unwrap().contains("replanning_v1"));
        assert_eq!(plan["dataset_root_declared"], json!(named));
    }

    #[test]
    fn a_set_aside_copy_inside_a_bundle_is_not_a_dataset() {
        let fx = fixture();
        write(
            &fx.sims.join("topology_v1").join("attempt47").join("episodes.csv"),
            "superseded attempt",
        );
        // Its hash is pinned, as analyst-209's was after the bundle was redone.
        let mut plan = handoff(
            "episodes.csv",
            json!({"expected_sha256": sha256_hex(b"superseded attempt")}),
        );
        let seal = seal_analyst_handoff(&fx.paths, "cyc", &mut plan);
        assert_eq!(seal["status"], "rejected", "{seal}");
        assert!(!seal.to_string().contains("attempt47/episodes.csv\",\"sha256"));
        assert!(plan["handoff_checks"][0].get("dataset_declared").is_none());
    }

    const READS_MAPPING: &str =
        "import json, os\nspec = json.load(open(os.environ['RESEARCHLAB_CHECK_SPEC']))\ncols = spec['column_mapping']\nprint(json.dumps({}))";

    fn gap_fill_handoff(goal: &str, mapping: Value, code: &str, dataset: &str) -> Value {
        json!({
            "handoff_checks": [{
                "check_id": "gap_fill_auc_v2",
                "dataset": dataset,
                "goal": goal,
                "failure_criteria": [format!("{goal} fails")],
                "column_mapping": mapping,
            }],
            "validation_code_blueprints": [{"blueprint_id": "BP", "check_id": "gap_fill_auc_v2", "code": code}],
        })
    }

    #[test]
    fn prose_the_code_never_reads_does_not_make_a_new_execution() {
        // analyst-222..229: six handoffs, one blueprint, one dataset, six goals.
        let fx = fixture();
        let mapping = json!({"success": "success"});
        let mut a = gap_fill_handoff("Estimate four contrasts", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        let mut b = gap_fill_handoff("Estimate the four policy-by-axis thresholds", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        let a_seal = seal_analyst_handoff(&fx.paths, "cyc", &mut a);
        let b_seal = seal_analyst_handoff(&fx.paths, "cyc", &mut b);
        assert_ne!(a_seal["seal_id"], b_seal["seal_id"], "the record still tells the two apart");
        assert_eq!(a_seal["execution_id"], b_seal["execution_id"]);

        // analyst-226 and -229 described the interpreter differently.
        let mut c = gap_fill_handoff("Estimate four contrasts", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        c["validation_code_blueprints"][0]["dependencies"] = json!(["Python 3.12", "numpy", "pandas", "no external agent selected"]);
        let mut d = gap_fill_handoff("Estimate four contrasts", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        d["validation_code_blueprints"][0]["dependencies"] = json!(["python>=3.10", "pandas", "numpy"]);
        let mut e = gap_fill_handoff("Estimate four contrasts", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        e["validation_code_blueprints"][0]["dependencies"] = json!(["pandas", "numpy", "scikit-learn==1.5"]);
        let c_id = seal_analyst_handoff(&fx.paths, "cyc", &mut c)["execution_id"].clone();
        let d_id = seal_analyst_handoff(&fx.paths, "cyc", &mut d)["execution_id"].clone();
        let e_id = seal_analyst_handoff(&fx.paths, "cyc", &mut e)["execution_id"].clone();
        assert_eq!(c_id, d_id, "only what the driver would install counts");
        assert_ne!(c_id, e_id, "an extra package is a different run");

        // What the code does read, or the data, or the code, is a new execution.
        let mut mapped = gap_fill_handoff("Estimate four contrasts", json!({"success": "reached_goal"}), READS_MAPPING, "topology_v1/episodes.csv");
        let mut other_data = gap_fill_handoff("Estimate four contrasts", mapping.clone(), READS_MAPPING, "replanning_v1/episodes.csv");
        let mut other_code = gap_fill_handoff("Estimate four contrasts", mapping, "print(2)", "topology_v1/episodes.csv");
        for other in [&mut mapped, &mut other_data, &mut other_code] {
            let seal = seal_analyst_handoff(&fx.paths, "cyc", other);
            assert_ne!(seal["execution_id"], a_seal["execution_id"]);
        }
    }

    fn write_handoff(fx: &Fixture, lane: &str, handoff: &Value) -> String {
        let path = fx.paths.runtime_root.join("lanes").join("cyc").join(lane).join("handoff-validation-plan.json");
        write(&path, &handoff.to_string());
        path.display().to_string()
    }

    fn write_runner(fx: &Fixture, lane: &str, handoff_path: &str, result: Option<Value>) {
        let dir = fx.paths.runtime_root.join("lanes").join("cyc").join(lane);
        write(
            &dir.join("role-plan.json"),
            &json!({"planner_metadata": {"analyst_handoff_path": handoff_path}}).to_string(),
        );
        if let Some(result) = result {
            write(&dir.join("result.json"), &result.to_string());
            write(
                &dir.join("final-status.json"),
                &json!({"status": "completed", "result_path": dir.join("result.json").display().to_string()}).to_string(),
            );
        }
    }

    #[test]
    fn an_execution_already_run_or_queued_under_another_handoff_is_served() {
        let fx = fixture();
        let mapping = json!({"success": "success"});
        let mut first = gap_fill_handoff("one wording", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        let mut second = gap_fill_handoff("another wording", mapping, READS_MAPPING, "topology_v1/episodes.csv");
        seal_analyst_handoff(&fx.paths, "cyc", &mut first);
        seal_analyst_handoff(&fx.paths, "cyc", &mut second);
        let first_path = write_handoff(&fx, "followup-analyst-222", &first);
        let second_path = write_handoff(&fx, "followup-analyst-226", &second);

        assert_eq!(execution_served_by(&fx.paths, "cyc", &second_path).unwrap(), None);

        // Queued: an open runner bound to the first handoff.
        write_runner(&fx, "followup-runner-88", &first_path, None);
        assert_eq!(
            execution_served_by(&fx.paths, "cyc", &second_path).unwrap().as_deref(),
            Some("followup-runner-88")
        );
        // A handoff is not served by its own runner here; that is the exact-path rule's.
        assert_eq!(execution_served_by(&fx.paths, "cyc", &first_path).unwrap(), None);
    }

    #[test]
    fn a_run_that_measured_nothing_does_not_serve_the_execution() {
        let fx = fixture();
        let mapping = json!({"success": "success"});
        let mut first = gap_fill_handoff("one wording", mapping.clone(), READS_MAPPING, "topology_v1/episodes.csv");
        let mut second = gap_fill_handoff("another wording", mapping, READS_MAPPING, "topology_v1/episodes.csv");
        seal_analyst_handoff(&fx.paths, "cyc", &mut first);
        seal_analyst_handoff(&fx.paths, "cyc", &mut second);
        let first_path = write_handoff(&fx, "followup-analyst-222", &first);
        let second_path = write_handoff(&fx, "followup-analyst-226", &second);

        write_runner(
            &fx,
            "followup-runner-90",
            &first_path,
            Some(json!({"status": "failed", "validation_summary": {"blueprints_passed": 0}})),
        );
        assert_eq!(execution_served_by(&fx.paths, "cyc", &second_path).unwrap(), None, "a broken run may be retried");

        write_runner(
            &fx,
            "followup-runner-91",
            &first_path,
            Some(json!({"status": "completed", "validation_summary": {"blueprints_passed": 1}})),
        );
        assert_eq!(
            execution_served_by(&fx.paths, "cyc", &second_path).unwrap().as_deref(),
            Some("followup-runner-91")
        );
    }

    #[test]
    fn the_seal_id_follows_the_content() {
        let fx = fixture();
        let mut a = handoff("topology_v1/episodes.csv", json!({}));
        let mut b = handoff("topology_v1/episodes.csv", json!({}));
        let mut c = handoff("replanning_v1/episodes.csv", json!({}));
        let a_id = seal_analyst_handoff(&fx.paths, "cyc", &mut a)["seal_id"].clone();
        let b_id = seal_analyst_handoff(&fx.paths, "cyc", &mut b)["seal_id"].clone();
        let c_id = seal_analyst_handoff(&fx.paths, "cyc", &mut c)["seal_id"].clone();
        assert_eq!(a_id, b_id);
        assert_ne!(a_id, c_id);
    }
}
