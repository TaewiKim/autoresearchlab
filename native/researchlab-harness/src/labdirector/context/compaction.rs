#![allow(unused_imports)]
use super::*;

pub(crate) fn compact_json_context(value: &Value, max_bytes: usize) -> Value {
    if value.is_null() {
        return Value::Null;
    }
    let approx = serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(0);
    if approx <= max_bytes {
        return value.clone();
    }
    json!({
        "truncated": true,
        "approx_bytes": approx,
        "reason": "context too large for follow-up role plan; use cycle state artifacts for full detail",
    })
}

pub(crate) fn json_approx_bytes(value: &Value) -> usize {
    serde_json::to_vec(value)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

pub(crate) fn truncate_string(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let keep = max_chars.saturating_sub(20);
    let mut output = value.chars().take(keep).collect::<String>();
    output.push_str(" [truncated]");
    output
}

pub(crate) fn array_prefix(value: Option<&Value>, limit: usize) -> Value {
    value
        .and_then(Value::as_array)
        .map(|items| Value::Array(items.iter().take(limit).cloned().collect()))
        .unwrap_or_else(|| json!([]))
}

pub(crate) fn array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

pub(crate) fn compact_node_or_edge_for_director(item: &Value) -> Value {
    json!({
        "id": item
            .get("id")
            .or_else(|| item.get("node_id"))
            .or_else(|| item.get("edge_id"))
            .cloned()
            .unwrap_or(Value::Null),
        "type": item.get("type").cloned().unwrap_or(Value::Null),
        "label": item
            .get("label")
            .or_else(|| item.get("name"))
            .or_else(|| item.get("statement"))
            .and_then(Value::as_str)
            .map(|text| truncate_string(text, 220))
            .unwrap_or_default(),
        "summary": item
            .get("summary")
            .or_else(|| item.get("rationale"))
            .or_else(|| item.get("description"))
            .and_then(Value::as_str)
            .map(|text| truncate_string(text, 320))
            .unwrap_or_default(),
        "accession": item
            .get("accession")
            .or_else(|| item.get("dataset_or_accession"))
            .or_else(|| item.get("metadata").and_then(|metadata| metadata.get("accession")))
            .cloned()
            .unwrap_or(Value::Null),
        "score": item
            .get("score")
            .or_else(|| item.get("weight"))
            .or_else(|| item.get("confidence"))
            .cloned()
            .unwrap_or(Value::Null),
        "source_refs": array_prefix(item.get("source_refs").or_else(|| item.get("sources")), 3),
    })
}

pub(crate) fn graph_count(value: &Value, key: &str) -> usize {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}
