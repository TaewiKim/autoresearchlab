#![allow(unused_imports)]
use super::*;

/// Read the per-cycle data bundles index emitted by the data-scout
/// (`<state>/<cycle_id>-data-bundles.json`) and enrich each entry with
/// its bundle-level manifest so the analyst can match `hypothesis.x_variable`
/// / `hypothesis.y_variable` against `csvs[].columns` when picking a
/// `dataset_root` (docs/data-fetcher-2026-04-28.md §E).
///
/// Returns an empty vec — never `None` — when the file does not exist or is
/// unparsable: missing bundles are an expected state for cycles that did
/// not invoke the fetcher (or invoked it and got zero hits), and the
/// analyst's prompt handles the empty list explicitly.
pub(crate) fn cycle_fetched_data_bundles(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    let bundle_index_path = state_root(paths).join(format!("{cycle_id}-data-bundles.json"));
    if !bundle_index_path.is_file() {
        return Vec::new();
    }
    let index = match read_json(&bundle_index_path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let bundles = match index.get("bundles").and_then(Value::as_array) {
        Some(items) => items,
        None => return Vec::new(),
    };
    let mut enriched: Vec<Value> = Vec::with_capacity(bundles.len());
    for bundle in bundles {
        let bundle_path = bundle
            .get("bundle_path")
            .and_then(Value::as_str)
            .unwrap_or("");
        let status = bundle.get("status").and_then(Value::as_str).unwrap_or("");
        // Only fetched bundles are pickable — skip bundles that errored
        // or returned no files. They are kept in the index for chronicle
        // visibility but cannot satisfy hypothesis-variable matching.
        if status != "fetched" {
            continue;
        }
        let manifest_path = bundle
            .get("manifest_path")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let manifest_entries: Vec<Value> = manifest_path
            .as_ref()
            .filter(|path| path.is_file())
            .and_then(|path| read_json(path).ok())
            .and_then(|value| match value {
                Value::Array(items) => Some(items),
                Value::Object(map) => map.get("manifest").and_then(Value::as_array).cloned(),
                _ => None,
            })
            .unwrap_or_default();
        let csvs: Vec<Value> = manifest_entries
            .into_iter()
            .filter(|entry| {
                entry
                    .get("fetch_status")
                    .and_then(Value::as_str)
                    .map(|status| status == "fetched")
                    .unwrap_or(false)
            })
            .map(|entry| {
                json!({
                    "name": entry.get("name").cloned().unwrap_or(Value::Null),
                    "csv_path": entry.get("csv_path").cloned().unwrap_or(Value::Null),
                    "row_count": entry.get("row_count").cloned().unwrap_or(Value::Null),
                    "columns": entry.get("columns").cloned().unwrap_or_else(|| json!([])),
                    "format_hint": entry.get("format_hint").cloned().unwrap_or(Value::Null),
                    "source_url": entry.get("source_url").cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        enriched.push(json!({
            "bundle_path": bundle_path,
            "provider": bundle.get("provider").cloned().unwrap_or(Value::Null),
            "candidate_doi": bundle.get("candidate_doi").cloned().unwrap_or(Value::Null),
            "candidate_url": bundle.get("candidate_url").cloned().unwrap_or(Value::Null),
            "candidate_title": bundle.get("candidate_title").cloned().unwrap_or(Value::Null),
            "csv_count": bundle.get("csv_count").cloned().unwrap_or(Value::Null),
            "downloaded_count": bundle.get("downloaded_count").cloned().unwrap_or(Value::Null),
            "csvs": csvs,
        }));
    }
    enriched
}

pub(crate) fn cycle_reference_resources(paths: &AppPaths, cycle_id: &str) -> Vec<Value> {
    let resource_index_path =
        state_root(paths).join(format!("{cycle_id}-reference-resources.json"));
    let mut seen_urls: HashSet<String> = HashSet::new();
    let mut resources: Vec<Value> = if resource_index_path.is_file() {
        read_json(&resource_index_path)
            .ok()
            .and_then(|index| index.get("resources").and_then(Value::as_array).cloned())
            .unwrap_or_default()
    } else {
        Vec::new()
    }
    .into_iter()
    .filter(|resource| {
        let is_open = resource
            .get("access_status")
            .and_then(Value::as_str)
            .map(|status| status == "open")
            .unwrap_or(true);
        let has_url = resource
            .get("url")
            .and_then(Value::as_str)
            .map(|url| !url.trim().is_empty())
            .unwrap_or(false);
        let has_accession = resource
            .get("accessions")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        is_open && (has_url || has_accession)
    })
    .filter(|resource| {
        if let Some(url) = resource.get("url").and_then(Value::as_str) {
            seen_urls.insert(url.trim().to_string())
        } else {
            true
        }
    })
    .collect();

    // Some cycles do not have a dedicated reference-resource index, but the
    // fetched bundle manifest itself carries high-value data-availability and
    // supplementary URLs. Surface those links through the same
    // `reference_resources` path so LabDirector/Analyst prompts can actively
    // inspect provenance, preprocessing scripts, and reusable data files rather
    // than seeing only the summarized candidate bundle metadata.
    for bundle in cycle_fetched_data_bundles(paths, cycle_id) {
        let dataset_label = bundle
            .get("candidate_title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("fetched dataset bundle");
        let provider = bundle.get("provider").cloned().unwrap_or(Value::Null);
        let bundle_path = bundle.get("bundle_path").cloned().unwrap_or(Value::Null);
        if let Some(url) = bundle.get("candidate_url").and_then(Value::as_str) {
            let url = url.trim();
            if !url.is_empty() && seen_urls.insert(url.to_string()) {
                resources.push(json!({
                    "title": dataset_label,
                    "url": url,
                    "access_status": "open",
                    "resource_type": "dataset_landing_page",
                    "provider": provider.clone(),
                    "bundle_path": bundle_path.clone(),
                    "downstream_usage_hint": "Inspect this fetched dataset landing page for data availability, accessions, sample metadata, supplementary files, and same-dataset method baselines."
                }));
            }
        }
        if let Some(csvs) = bundle.get("csvs").and_then(Value::as_array) {
            for csv in csvs {
                let Some(url) = csv.get("source_url").and_then(Value::as_str) else {
                    continue;
                };
                let url = url.trim();
                if url.is_empty() || !seen_urls.insert(url.to_string()) {
                    continue;
                }
                resources.push(json!({
                    "title": csv.get("name").cloned().unwrap_or_else(|| json!(dataset_label)),
                    "url": url,
                    "access_status": "open",
                    "resource_type": "fetched_bundle_source_file",
                    "provider": provider.clone(),
                    "bundle_path": bundle_path.clone(),
                    "format_hint": csv.get("format_hint").cloned().unwrap_or(Value::Null),
                    "downstream_usage_hint": "Use this fetched source/supplementary file as provenance for executable dataset selection, preprocessing constraints, column availability, and validation reproducibility."
                }));
            }
        }
    }

    resources.into_iter().take(40).collect()
}

// Words that say the DATA is large. Fifteen of the twenty this replaces named
// one field's assays and archives, so a question about scale was being answered
// by a question about field -- and the answer for every other field was no,
// however large its data. The measured signals below (column counts, array
// sizes) are the stronger half of this and were always field-independent.
pub(crate) const LARGE_SCALE_TERMS: &[&str] = &[
    "high-throughput",
    "high throughput",
    "high-dimensional",
    "high dimensional",
    "large-scale",
    "large scale",
    "at scale",
];

pub(crate) fn text_contains_any_term(text: &str, terms: &[&str]) -> bool {
    let lowered = text.to_ascii_lowercase();
    terms.iter().any(|term| lowered.contains(term))
}

pub(crate) fn value_contains_any_term(value: &Value, terms: &[&str]) -> bool {
    match value {
        Value::String(text) => text_contains_any_term(text, terms),
        Value::Array(items) => items
            .iter()
            .any(|item| value_contains_any_term(item, terms)),
        Value::Object(map) => map.iter().any(|(key, item)| {
            text_contains_any_term(key, terms) || value_contains_any_term(item, terms)
        }),
        _ => false,
    }
}

pub(crate) fn value_as_nonnegative_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))
        .or_else(|| {
            value
                .as_f64()
                .filter(|item| item.is_finite() && *item >= 0.0)
                .map(|item| item as u64)
        })
}

pub(crate) fn collect_large_scale_dataset_reasons(value: &Value, reasons: &mut HashSet<String>) {
    match value {
        Value::Array(items) => {
            if items.len() >= 500 {
                reasons.insert(format!("array_field_count_ge_{}", items.len()));
            }
            for item in items {
                collect_large_scale_dataset_reasons(item, reasons);
            }
        }
        Value::Object(map) => {
            if let Some(columns) = map.get("columns").and_then(Value::as_array) {
                if columns.len() >= 500 {
                    reasons.insert(format!("column_count_ge_{}", columns.len()));
                }
            }
            for (key, item) in map {
                let key_lower = key.to_ascii_lowercase();
                if matches!(
                    key_lower.as_str(),
                    "row_count" | "rows" | "n_rows" | "sample_count" | "cell_count"
                ) {
                    if let Some(count) = value_as_nonnegative_u64(item) {
                        if count >= 50_000 {
                            reasons.insert(format!("{}_ge_{}", key_lower, count));
                        }
                    }
                }
                collect_large_scale_dataset_reasons(item, reasons);
            }
        }
        _ => {}
    }
}

pub(crate) fn open_source_analysis_agent_mandate_for_context(
    objective: &str,
    candidate_datasets: &[Value],
    reference_resources: &[Value],
) -> Value {
    let mut reasons: HashSet<String> = HashSet::new();
    if text_contains_any_term(objective, LARGE_SCALE_TERMS) {
        reasons.insert("objective_indicates_large_scale_data".to_string());
    }
    if candidate_datasets
        .iter()
        .any(|item| value_contains_any_term(item, LARGE_SCALE_TERMS))
    {
        reasons.insert("candidate_dataset_indicates_large_scale_data".to_string());
    }
    if reference_resources
        .iter()
        .any(|item| value_contains_any_term(item, LARGE_SCALE_TERMS))
    {
        reasons.insert("reference_resource_indicates_large_scale_data".to_string());
    }
    for dataset in candidate_datasets {
        collect_large_scale_dataset_reasons(dataset, &mut reasons);
    }
    let large_scale_signals = !reasons.is_empty();
    let mut ordered_reasons: Vec<String> = reasons.into_iter().collect();
    ordered_reasons.sort();
    crate::labdirector::policy::open_source_analysis_agent_policy(
        large_scale_signals,
        &ordered_reasons,
    )
}

pub(crate) fn ensure_object_field<'a>(value: &'a mut Value, key: &str) -> &'a mut Value {
    if !value.is_object() {
        *value = json!({});
    }
    if value.get(key).map_or(true, |item| !item.is_object()) {
        value[key] = json!({});
    }
    value.get_mut(key).expect("object field just inserted")
}
