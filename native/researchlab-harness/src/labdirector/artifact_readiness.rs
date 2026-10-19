use serde_json::Value;
use std::fs;
use std::path::Path;

use crate::core::model::AppPaths;
use crate::core::support::{read_json, state_root};

pub(crate) fn lab_director_hypothesis_is_usable(
    paths: &AppPaths,
    cycle_id: &str,
    path: &Path,
) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(value) = read_json(path) else {
        return false;
    };
    if value
        .get("degraded")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    if value.get("requery_decision").and_then(Value::as_str) == Some("restart") {
        let selected_statement = value
            .get("selected_hypothesis")
            .and_then(|item| item.get("statement"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let replacements = value
            .get("replacement_hypotheses")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
        if selected_statement.is_empty() && !replacements {
            return false;
        }
    }
    // FIX-AF: deterministic data-availability fail-closed enforcement.
    // Prompt-level (FIX-AD role_plan directive) and digest-level (FIX-AE digest
    // injection) signals were both reasoned around by the lab-director, which
    // keeps upholding a lead whose dataset is confirmed unobtainable (the
    // director reads the on-disk chronicle digest, trusts its
    // `data_availability_failclosed=null`, and overrides the injected fact).
    // A lead whose own dataset has repeatedly failed materialization while
    // runner lanes validate on a mismatched override substitute is NOT a usable
    // authoritative lead: refuse it here, at the consumption point the director
    // cannot reason around, so the harness stops treating the substitute as the
    // validated lead and the FIX-AD pivot path takes over. The signal already
    // bails when a fetched bundle materializes the lead's accession, so this
    // never fires on a legitimately-pending fresh lead. This never forces the
    // gate verdict or lowers any threshold; it only declines to treat a
    // confirmed-unobtainable lead as ready.
    let override_threshold = std::env::var("RESEARCHLAB_LEAD_OVERRIDE_MISMATCH_THRESHOLD")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .unwrap_or(2);
    if super::active_lead_dataset_override_mismatch(paths, cycle_id, override_threshold).is_some() {
        return false;
    }
    true
}

pub(crate) fn chronicle_graph_artifacts_ready(paths: &AppPaths, cycle_id: &str) -> bool {
    let state = state_root(paths);
    let literature_path = state.join(format!("{cycle_id}-literature-graph.json"));
    let data_path = state.join(format!("{cycle_id}-data-graph.json"));
    let trend_path = state.join(format!("{cycle_id}-trend-summary.json"));
    if !literature_path.is_file() || !data_path.is_file() || !trend_path.is_file() {
        return false;
    }
    let literature = read_json(&literature_path).unwrap_or(Value::Null);
    let data = read_json(&data_path).unwrap_or(Value::Null);
    let literature_nodes = literature
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let literature_edges = literature
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let data_has_candidate = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| {
            items.iter().any(|node| {
                node.get("type")
                    .and_then(Value::as_str)
                    .map(|node_type| node_type == "dataset" || node_type.starts_with("dataset:"))
                    .unwrap_or(false)
                    && !node
                        .get("metadata")
                        .and_then(|metadata| metadata.get("forbidden_reuse"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    let data_has_graph_content = data
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
        || data
            .get("edges")
            .and_then(Value::as_array)
            .map(|items| !items.is_empty())
            .unwrap_or(false);
    let has_cycle_dataset_bundle = fs::read_dir(paths.runtime_root.join("datasets").join(cycle_id))
        .ok()
        .map(|mut entries| {
            entries.any(|entry| entry.map(|item| item.path().is_dir()).unwrap_or(false))
        })
        .unwrap_or(false);
    (literature_nodes || literature_edges)
        && (data_has_candidate || (data_has_graph_content && has_cycle_dataset_bundle))
}

pub(crate) fn chronicle_requery_context_ready(paths: &AppPaths, cycle_id: &str) -> bool {
    let state = state_root(paths);
    let literature_path = state.join(format!("{cycle_id}-literature-graph.json"));
    let trend_path = state.join(format!("{cycle_id}-trend-summary.json"));
    if !literature_path.is_file() || !trend_path.is_file() {
        return false;
    }
    let literature = read_json(&literature_path).unwrap_or(Value::Null);
    let literature_nodes = literature
        .get("nodes")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    let literature_edges = literature
        .get("edges")
        .and_then(Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    literature_nodes || literature_edges
}
