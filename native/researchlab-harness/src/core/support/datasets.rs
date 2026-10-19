// CSV / dataset-bundle discovery and profiling helpers, split out of
// support.rs to keep modules under the line budget. Whole items were moved
// verbatim — behaviour is unchanged.
use super::*;
use anyhow::Result;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

fn candidate_search_roots(paths: &AppPaths) -> Vec<PathBuf> {
    dedup_paths(vec![
        paths.data_root.clone(),
        paths.runtime_root.join("datasets"),
        paths.project_root.clone(),
    ])
}

fn dedup_paths(values: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values {
        let key = value.to_string_lossy().to_string();
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(value);
    }
    out
}

fn should_skip_dataset_walk(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|item| item.to_str()),
        Some(".git")
            | Some("node_modules")
            | Some("target")
            | Some("artifacts")
            | Some("chronicle")
            | Some("lanes")
            | Some("reports")
            | Some("papers")
            | Some("viz")
            | Some("runtime")
            | Some("indexes")
    )
}

fn csv_files_in_dir(path: &Path) -> Vec<PathBuf> {
    if !path.is_dir() {
        return Vec::new();
    }
    let mut files = fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok()))
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .filter(|candidate| {
            candidate
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("csv"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn csv_header_tokens(path: &Path) -> Vec<String> {
    let first_line = fs::read_to_string(path)
        .ok()
        .and_then(|content| content.lines().next().map(ToString::to_string))
        .unwrap_or_default();
    first_line
        .split(',')
        .map(|item| item.trim().trim_matches('"').to_ascii_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

// Parse a CSV row respecting double-quoted fields (no escapes beyond "").
// The analyst profile builder only needs it to keep commas inside quotes
// from splitting a field, so it does NOT implement full RFC-4180 escaping.
fn split_csv_row(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if let Some(&next) = chars.peek() {
                    if next == '"' {
                        current.push('"');
                        chars.next();
                        continue;
                    }
                }
                in_quotes = false;
            } else {
                current.push(ch);
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == ',' {
            fields.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

// Profile a single CSV file by reading the first ``sample_row_cap`` data rows
// (after the header) and computing light-weight per-column statistics. The
// analyst uses this to decide which columns are numeric, their rough scale,
// and which string columns are low-cardinality categoricals that can power
// stratification — all without having to open the file itself from inside a
// prompt.
struct ColumnProfile {
    name: String,
    dtype_hint: String,
    non_null_count: usize,
    numeric: Option<NumericSummary>,
    categorical: Option<CategoricalSummary>,
}

struct NumericSummary {
    min: f64,
    max: f64,
    mean: f64,
    std_dev: f64,
    sample_size: usize,
}

struct CategoricalSummary {
    unique_count: usize,
    top_values: Vec<(String, usize)>,
}

const PROFILE_SAMPLE_CAP: usize = 2_000;
const CATEGORICAL_UNIQUE_CAP: usize = 40;
const CATEGORICAL_TOP_N: usize = 6;

fn profile_csv_file(path: &Path) -> (usize, Vec<ColumnProfile>) {
    let Ok(content) = fs::read_to_string(path) else {
        return (0, Vec::new());
    };
    let mut lines = content.lines();
    let header_line = match lines.next() {
        Some(line) => line,
        None => return (0, Vec::new()),
    };
    let headers: Vec<String> = split_csv_row(header_line)
        .into_iter()
        .map(|token| token.trim().trim_matches('"').to_string())
        .collect();
    if headers.is_empty() {
        return (0, Vec::new());
    }

    let mut non_null_counts = vec![0usize; headers.len()];
    let mut numeric_values: Vec<Vec<f64>> = (0..headers.len()).map(|_| Vec::new()).collect();
    let mut string_values: Vec<Vec<String>> = (0..headers.len()).map(|_| Vec::new()).collect();
    let mut numeric_attempts = vec![0usize; headers.len()];
    let mut numeric_successes = vec![0usize; headers.len()];
    let mut total_rows = 0usize;

    for (row_idx, line) in lines.enumerate() {
        total_rows += 1;
        if row_idx >= PROFILE_SAMPLE_CAP {
            continue;
        }
        let row = split_csv_row(line);
        for (col_idx, raw) in row.iter().enumerate().take(headers.len()) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            non_null_counts[col_idx] += 1;
            numeric_attempts[col_idx] += 1;
            if let Ok(number) = trimmed.replace(',', "").parse::<f64>() {
                numeric_values[col_idx].push(number);
                numeric_successes[col_idx] += 1;
            } else {
                string_values[col_idx].push(trimmed.to_string());
            }
        }
    }

    let profiles = headers
        .iter()
        .enumerate()
        .map(|(idx, name)| {
            let attempts = numeric_attempts[idx];
            let successes = numeric_successes[idx];
            let numeric_ratio = if attempts == 0 {
                0.0
            } else {
                successes as f64 / attempts as f64
            };
            let dtype_hint = if attempts == 0 {
                "empty".to_string()
            } else if numeric_ratio >= 0.9 {
                "numeric".to_string()
            } else if numeric_ratio <= 0.1 {
                "string".to_string()
            } else {
                "mixed".to_string()
            };
            let numeric = if numeric_ratio >= 0.6 && !numeric_values[idx].is_empty() {
                let values = &numeric_values[idx];
                let n = values.len();
                let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
                let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let mean = values.iter().sum::<f64>() / n as f64;
                let variance = if n > 1 {
                    values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1) as f64
                } else {
                    0.0
                };
                Some(NumericSummary {
                    min,
                    max,
                    mean,
                    std_dev: variance.sqrt(),
                    sample_size: n,
                })
            } else {
                None
            };
            let categorical = if numeric.is_none() && !string_values[idx].is_empty() {
                let mut counts: HashMap<String, usize> = HashMap::new();
                for value in &string_values[idx] {
                    *counts.entry(value.clone()).or_insert(0) += 1;
                }
                let unique_count = counts.len();
                if unique_count <= CATEGORICAL_UNIQUE_CAP {
                    let mut top: Vec<(String, usize)> = counts.into_iter().collect();
                    top.sort_by(|a, b| b.1.cmp(&a.1));
                    top.truncate(CATEGORICAL_TOP_N);
                    Some(CategoricalSummary {
                        unique_count,
                        top_values: top,
                    })
                } else {
                    Some(CategoricalSummary {
                        unique_count,
                        top_values: Vec::new(),
                    })
                }
            } else {
                None
            };
            ColumnProfile {
                name: name.clone(),
                dtype_hint,
                non_null_count: non_null_counts[idx],
                numeric,
                categorical,
            }
        })
        .collect();

    (total_rows, profiles)
}

fn column_profile_to_value(profile: &ColumnProfile) -> Value {
    let mut record = serde_json::Map::new();
    record.insert("name".to_string(), json!(profile.name));
    record.insert("dtype".to_string(), json!(profile.dtype_hint));
    record.insert(
        "non_null_count_sampled".to_string(),
        json!(profile.non_null_count),
    );
    if let Some(num) = &profile.numeric {
        record.insert(
            "numeric".to_string(),
            json!({
                "min": num.min,
                "max": num.max,
                "mean": num.mean,
                "std_dev": num.std_dev,
                "sample_size": num.sample_size,
            }),
        );
    }
    if let Some(cat) = &profile.categorical {
        record.insert(
            "categorical".to_string(),
            json!({
                "unique_count": cat.unique_count,
                "top_values": cat.top_values
                    .iter()
                    .map(|(value, count)| json!({"value": value, "count": count}))
                    .collect::<Vec<_>>(),
            }),
        );
    }
    Value::Object(record)
}

// Domain-agnostic dataset discovery: the harness does not know what semantic
// targets a cycle needs, so we no longer try to auto-tag CSV files against a
// hardcoded WHO indicator taxonomy. Any directory that contains at least one
// CSV file is treated as a candidate dataset bundle; the blueprint executor
// and the analyst-provided code are responsible for deciding which files
// matter.
fn infer_dataset_mapping(path: &Path) -> HashMap<String, String> {
    let mut mapping = HashMap::new();
    for candidate in csv_files_in_dir(path) {
        let Some(file_name) = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .map(ToString::to_string)
        else {
            continue;
        };
        let key = file_name
            .trim_end_matches(".csv")
            .trim_end_matches(".CSV")
            .to_ascii_lowercase();
        if !key.is_empty() {
            mapping.insert(key, file_name);
        }
    }

    mapping
}

// Domain-agnostic column surfacing: we simply report the CSV header row for
// each file in the bundle. Consumers (blueprints, the analyst prompt) decide
// which columns to use — there is no longer a fixed WHO column taxonomy
// (SpatialDim / TimeDim / NumericValue / ParentCode) inferred here.
fn infer_column_mapping(path: &Path, dataset_mapping: &HashMap<String, String>) -> Value {
    let mut out = serde_json::Map::new();
    for (semantic_key, file_name) in dataset_mapping {
        let headers = csv_header_tokens(&path.join(file_name));
        out.insert(
            semantic_key.clone(),
            json!({
                "headers": headers,
            }),
        );
    }
    Value::Object(out)
}

fn is_dataset_bundle_dir(path: &Path) -> bool {
    // A directory qualifies as a dataset bundle if it contains at least one
    // CSV file. Formerly this required five specific WHO indicator CSVs.
    !csv_files_in_dir(path).is_empty()
}

fn walk_dataset_bundles(
    path: &Path,
    depth: usize,
    results: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) -> Result<()> {
    if !path.exists() || should_skip_dataset_walk(path) {
        return Ok(());
    }
    if is_dataset_bundle_dir(path) {
        let key = fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();
        if !seen.contains(&key) {
            seen.insert(key);
            results.push(path.to_path_buf());
        }
        return Ok(());
    }
    if depth == 0 || !path.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        walk_dataset_bundles(&entry.path(), depth.saturating_sub(1), results, seen)?;
    }
    Ok(())
}

pub(crate) fn discover_dataset_bundle_paths(paths: &AppPaths) -> Result<Vec<PathBuf>> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for root in candidate_search_roots(paths) {
        walk_dataset_bundles(&root, 6, &mut results, &mut seen)?;
    }
    results.sort_by(|a, b| {
        dataset_bundle_priority(paths, a)
            .cmp(&dataset_bundle_priority(paths, b))
            .reverse()
    });
    Ok(results)
}

pub(crate) fn canonical_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn path_contains_or_equals(path: &Path, root: &Path) -> bool {
    let path = canonical_or_self(path);
    let root = canonical_or_self(root);
    path == root || path.starts_with(root)
}

pub(crate) fn dataset_bundle_paths_visible_to_cycle(
    paths: &AppPaths,
    cycle_id: Option<&str>,
) -> Result<Vec<PathBuf>> {
    let candidates = discover_dataset_bundle_paths(paths)?;
    let Some(cid) = cycle_id else {
        return Ok(candidates);
    };
    let managed_root = paths.runtime_root.join("datasets");
    let cycle_root = managed_root.join(cid);
    Ok(candidates
        .into_iter()
        .filter(|path| {
            if path_contains_or_equals(path, &cycle_root) {
                return true;
            }
            if path_contains_or_equals(path, &managed_root) {
                return false;
            }
            true
        })
        .collect())
}

fn dataset_bundle_priority(_paths: &AppPaths, path: &Path) -> i32 {
    let text = path.to_string_lossy();
    let mut score = 0i32;
    // Prefer bundles placed inside the managed datasets root so newly
    // fetched open-data bundles outrank stray CSVs sitting in the project
    // tree. No longer biases toward a WHO subtree specifically.
    if text.contains(".research-lab/datasets") {
        score += 180;
    }
    score -= text.matches('/').count() as i32;
    score
}

fn open_data_bootstrap_script(paths: &AppPaths) -> PathBuf {
    paths
        .project_root
        .join("drivers")
        .join("data")
        .join("open_data_bootstrap.py")
}

// The open-data bootstrap is now driven entirely by a role plan's
// ``data_acquisition.sources`` list, so the fallback that used to auto-fetch
// the WHO bundle whenever no existing data was found has been removed: the
// Rust harness no longer knows which URLs to request. The scout lane
// continues to invoke the bootstrap explicitly with a role plan when the
// planner marks the cycle as needing open data.
#[allow(dead_code)]
fn open_data_bootstrap_script_available(paths: &AppPaths) -> bool {
    open_data_bootstrap_script(paths).is_file()
}

/// Provenance of the dataset bundle path returned by
/// [`choose_dataset_bundle_path`]. Callers use this to surface a
/// ``dataset_fallback_to_legacy`` warning on the lane payload when the
/// cycle-scoped fetched bundle was not available
/// (docs/data-fetcher-2026-04-28.md §E).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DatasetBundleSource {
    /// Caller-supplied dataset_root override (e.g. analyst handoff).
    Override,
    /// Bundle materialised by the Phase 1 data fetcher under
    /// ``<runtime>/datasets/<cycle_id>/...``.
    CycleScoped,
    /// Legacy global registry hit (e.g. ``<runtime>/datasets/who/csv``).
    LegacyFallback,
    /// No bundle found anywhere — falls back to ``paths.data_root``.
    DataRoot,
}

impl DatasetBundleSource {
    pub(crate) fn fell_back_to_legacy(self) -> bool {
        matches!(self, Self::LegacyFallback | Self::DataRoot)
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Override => "override",
            Self::CycleScoped => "cycle_scoped",
            Self::LegacyFallback => "legacy_fallback",
            Self::DataRoot => "data_root",
        }
    }
}

pub(crate) fn choose_dataset_bundle_path(
    paths: &AppPaths,
    preferred: Option<&Path>,
    cycle_id: Option<&str>,
) -> Result<(PathBuf, DatasetBundleSource)> {
    if let Some(path) = preferred {
        if is_dataset_bundle_dir(path) {
            return Ok((path.to_path_buf(), DatasetBundleSource::Override));
        }
        if path.is_dir() {
            let mut bundles: Vec<(PathBuf, usize)> = Vec::new();
            let mut seen = HashSet::new();
            let mut paths_under_preferred = Vec::new();
            walk_dataset_bundles(path, 6, &mut paths_under_preferred, &mut seen)?;
            for entry_path in paths_under_preferred {
                let csv_count = csv_files_in_dir(&entry_path).len();
                bundles.push((entry_path, csv_count));
            }
            bundles.sort_by(|a, b| b.1.cmp(&a.1));
            if let Some((path, _)) = bundles.into_iter().next() {
                return Ok((path, DatasetBundleSource::Override));
            }
        }
    }
    // Cycle-scoped bundles win over the global registry. The
    // dataset_fetcher writes its output into
    // ``<runtime>/datasets/<cycle_id>/<slug>/``; without this branch
    // the global ``discover_dataset_bundle_paths`` priority leaves the
    // cycle-scoped path deeper-than the legacy ``<runtime>/datasets/
    // who/`` bundle, so the legacy bundle wins by depth and lab-runner
    // ends up analysing health-domain data against a domain-mismatched
    // hypothesis (the v22 promotion=0 root cause — see
    // docs/data-fetcher-2026-04-28.md).
    if let Some(cid) = cycle_id {
        let cycle_root = paths.runtime_root.join("datasets").join(cid);
        if cycle_root.exists() {
            let mut bundles: Vec<(PathBuf, usize)> = Vec::new();
            let mut seen = HashSet::new();
            let mut paths_in_cycle = Vec::new();
            walk_dataset_bundles(&cycle_root, 6, &mut paths_in_cycle, &mut seen)?;
            for entry_path in paths_in_cycle {
                // Rank by CSV count so the bundle with the most analysable
                // files is picked first when several were fetched in the
                // same cycle. Dataset fetcher bundles usually keep CSVs in a
                // nested `csv/` directory, so walking is required.
                let csv_count = csv_files_in_dir(&entry_path).len();
                bundles.push((entry_path, csv_count));
            }
            bundles.sort_by(|a, b| b.1.cmp(&a.1));
            if let Some((path, _)) = bundles.into_iter().next() {
                return Ok((path, DatasetBundleSource::CycleScoped));
            }
        }
    }
    let candidates = dataset_bundle_paths_visible_to_cycle(paths, cycle_id)?;
    if let Some(path) = candidates.into_iter().next() {
        return Ok((path, DatasetBundleSource::LegacyFallback));
    }
    // No dataset bundle found and the harness is not allowed to assume a
    // default provider. Returning the managed ``data_root`` lets the stats
    // driver surface a "no data present" result rather than bailing before
    // the lane even starts — the analyst blueprint is free to fetch or load
    // data from any path it chooses.
    Ok((paths.data_root.clone(), DatasetBundleSource::DataRoot))
}

pub(crate) fn dataset_bundle_summary(_paths: &AppPaths, path: &Path) -> Value {
    let mapping = infer_dataset_mapping(path);
    let column_mapping = infer_column_mapping(path, &mapping);
    // Profile every CSV in the bundle so the analyst sees dtypes, numeric
    // scales, and small-cardinality categoricals at prompt time. Without this
    // the analyst has only the header row and cannot ground derived-indicator
    // proposals in actual value distributions.
    let files = csv_files_in_dir(path)
        .into_iter()
        .map(|candidate| {
            let name = candidate
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string();
            let (row_count_sampled, profiles) = profile_csv_file(&candidate);
            let headers: Vec<String> = profiles
                .iter()
                .map(|profile| profile.name.clone())
                .collect();
            let column_profiles: Vec<Value> =
                profiles.iter().map(column_profile_to_value).collect();
            json!({
                "name": name,
                "path": candidate,
                // ``headers`` kept as-is for existing consumers. The richer
                // ``column_profiles`` is the new channel the analyst should
                // consult before proposing derived indicators.
                "headers": headers,
                "row_count_sampled": row_count_sampled,
                "column_profiles": column_profiles,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "dataset_root": path,
        "file_count": files.len(),
        "files": files.clone(),
        "dataset_mapping": mapping,
        "column_mapping": column_mapping,
        // Kept for backward compatibility with consumers that read
        // ``required_files`` — now points at the same file list.
        "required_files": files,
    })
}
