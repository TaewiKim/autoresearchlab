use crate::core::model::AppPaths;
use crate::core::support::{read_json, state_root};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) fn geo_accessions_from_value(value: &Value) -> BTreeSet<String> {
    let Ok(text) = serde_json::to_string(value) else {
        return BTreeSet::new();
    };
    scan_simple_acc(&text, r"\b(GSE\d{3,7})\b")
        .into_iter()
        .collect()
}

pub(crate) fn current_hypothesis_geo_accessions(
    paths: &AppPaths,
    cycle_id: &str,
) -> BTreeSet<String> {
    let hypothesis_path =
        state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"));
    let Ok(hypothesis) = read_json(&hypothesis_path) else {
        return BTreeSet::new();
    };
    let mut scoped = serde_json::Map::new();
    for key in [
        "statement",
        "dataset_or_accession",
        "validation_dataset",
        "selected_dataset",
        "focus_hypotheses",
        "identification_strategy",
    ] {
        if let Some(value) = hypothesis.get(key) {
            scoped.insert(key.to_string(), value.clone());
        }
    }
    geo_accessions_from_value(&Value::Object(scoped))
}

pub(crate) fn value_mentions_current_geo(
    value: &Value,
    current_accessions: &BTreeSet<String>,
) -> bool {
    if current_accessions.is_empty() {
        return true;
    }
    geo_accessions_from_value(value)
        .iter()
        .any(|accession| current_accessions.contains(accession))
}

pub(crate) fn value_targets_current_geo(
    value: &Value,
    current_accessions: &BTreeSet<String>,
) -> bool {
    if current_accessions.is_empty() {
        return true;
    }
    let accessions = geo_accessions_from_value(value);
    accessions.is_empty()
        || accessions
            .iter()
            .any(|accession| current_accessions.contains(accession))
}

pub(crate) fn analyst_handoff_targets_current_hypothesis(
    payload: &Value,
    current_accessions: &BTreeSet<String>,
) -> bool {
    value_targets_current_geo(payload, current_accessions)
}

/// Hand-rolled accession scanner — finds every occurrence of a fixed
/// prefix followed by a constrained digit run (and an optional dotted
/// version suffix for dbGaP). The ``pat`` argument is a stylised key: we
/// match on the prefix and digit-count bounds, ignoring surrounding regex syntax.
pub(crate) fn scan_simple_acc(text: &str, pat: &str) -> Vec<String> {
    let (prefix, min_digits, max_digits, allow_version) = if pat.contains("GSE") {
        ("GSE", 3, 7, false)
    } else if pat.contains("SRP") {
        ("SRP", 5, 8, false)
    } else if pat.contains("PRJ") {
        ("PRJ", 4, 9, false)
    } else if pat.contains("E-") {
        ("E-", 1, 7, false)
    } else if pat.contains("phs") {
        ("phs", 6, 9, true)
    } else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let upper = text.to_uppercase();
    let bytes = upper.as_bytes();
    let prefix_upper = prefix.to_uppercase();
    let prefix_bytes = prefix_upper.as_bytes();
    let mut i = 0usize;
    while i + prefix_bytes.len() <= bytes.len() {
        if &bytes[i..i + prefix_bytes.len()] == prefix_bytes {
            let pre_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            if pre_ok {
                let mut cursor = i + prefix_bytes.len();
                if prefix == "PRJ" && cursor + 2 <= bytes.len() {
                    let c1 = bytes[cursor];
                    let c2 = bytes[cursor + 1];
                    if matches!(c1, b'E' | b'D' | b'N') && c2.is_ascii_alphabetic() {
                        cursor += 2;
                    } else {
                        i += 1;
                        continue;
                    }
                }
                if prefix == "E-" && cursor + 5 <= bytes.len() {
                    let mut all_alpha = true;
                    for k in 0..4 {
                        if !bytes[cursor + k].is_ascii_alphabetic() {
                            all_alpha = false;
                            break;
                        }
                    }
                    if all_alpha && bytes[cursor + 4] == b'-' {
                        cursor += 5;
                    } else {
                        i += 1;
                        continue;
                    }
                }
                let digit_start = cursor;
                while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                let digit_count = cursor - digit_start;
                if digit_count >= min_digits && digit_count <= max_digits {
                    if allow_version
                        && cursor + 2 < bytes.len()
                        && bytes[cursor] == b'.'
                        && bytes[cursor + 1] == b'V'
                    {
                        let mut vc = cursor + 2;
                        while vc < bytes.len() && bytes[vc].is_ascii_digit() {
                            vc += 1;
                        }
                        if vc > cursor + 2 {
                            cursor = vc;
                        }
                    }
                    let post_ok = cursor == bytes.len()
                        || !(bytes[cursor].is_ascii_alphanumeric() || bytes[cursor] == b'_');
                    if post_ok {
                        if let Ok(s) = std::str::from_utf8(&bytes[i..cursor]) {
                            out.push(s.to_string());
                        }
                    }
                }
                i = cursor.max(i + 1);
                continue;
            }
        }
        i += 1;
    }
    out
}
