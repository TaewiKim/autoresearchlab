use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::Path;

use crate::core::support::{read_json, write_json};

/// Read a graph JSON file, derive ``vocabulary.node_types`` and
/// ``vocabulary.edge_relations`` from the strings already present in
/// ``nodes[].type`` and ``edges[].relation``, union with any existing
/// vocabulary entries (so previously-registered terms survive even if
/// no surviving node/edge currently uses them), and write back.
///
/// Pure-Rust implementation that intentionally mirrors the JS-side
/// ``vocabularyFromGraph`` in ``data_graph_contracts.js`` so the same
/// invariant holds whichever side touches the file.
pub(crate) fn normalize_graph_vocabulary(path: &Path) -> Result<()> {
    let mut graph: Value = read_json(path)?;
    if !graph.is_object() {
        return Ok(());
    }

    let mut node_types: std::collections::BTreeSet<String> = Default::default();
    let mut edge_relations: std::collections::BTreeSet<String> = Default::default();

    if let Some(existing) = graph.get("vocabulary").and_then(Value::as_object) {
        if let Some(arr) = existing.get("node_types").and_then(Value::as_array) {
            for entry in arr {
                if let Some(text) = entry.as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        node_types.insert(trimmed.to_string());
                    }
                }
            }
        }
        if let Some(arr) = existing.get("edge_relations").and_then(Value::as_array) {
            for entry in arr {
                if let Some(text) = entry.as_str() {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        edge_relations.insert(trimmed.to_string());
                    }
                }
            }
        }
    }

    if let Some(nodes) = graph.get("nodes").and_then(Value::as_array) {
        for node in nodes {
            if let Some(text) = node.get("type").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    node_types.insert(trimmed.to_string());
                }
            }
        }
    }
    if let Some(edges) = graph.get("edges").and_then(Value::as_array) {
        for edge in edges {
            if let Some(text) = edge.get("relation").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    edge_relations.insert(trimmed.to_string());
                }
            }
        }
    }

    let obj = graph
        .as_object_mut()
        .ok_or_else(|| anyhow!("graph payload is not a JSON object"))?;
    obj.insert(
        "vocabulary".to_string(),
        json!({
            "node_types": node_types.iter().collect::<Vec<_>>(),
            "edge_relations": edge_relations.iter().collect::<Vec<_>>(),
        }),
    );

    write_json(path, &graph)?;
    Ok(())
}
