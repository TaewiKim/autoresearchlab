#![allow(unused_imports)]
use super::*;

// The SOTA cards this pipeline reads. They are published by the `sota_deep_read`
// scout (labdirector::sota_cards, built separately) to
// `<cycle>-sota-cards.json`; this file only reads them, against the contract:
//
//   cards[{paper_id, title, year, venue, fulltext_source,
//          core_claims[{claim, evidence_ref, numbers}], method_core,
//          setup{benchmarks, data_scale, compute}, ablations_present[],
//          ablations_missing[{what, why_it_matters}],
//          stated_limitations[{text, evidence_ref}],
//          unstated_assumptions[{text, evidence_ref}],
//          load_bearing_beliefs[{belief, evidence_ref}], falsifier,
//          assets{code[{url, license, stars, pushed_at, head_sha}],
//                 checkpoints[{url, size_gb, license}], datasets[...], envs[],
//                 min_vram_gb_eval, min_vram_gb_train, reproduction_entry,
//                 local_copy_path}}]
//
// Names here carry an `expert_` prefix so they never collide with the
// sota_cards module's own.

pub(crate) fn expert_sota_cards_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-sota-cards.json"))
}

#[derive(Clone, Debug)]
pub(crate) struct ExpertCards {
    /// `missing`, `invalid` or `ready`.
    pub(crate) state: &'static str,
    pub(crate) path: PathBuf,
    pub(crate) cards: Vec<Value>,
}

impl ExpertCards {
    #[cfg(test)]
    pub(crate) fn from_cards(cards: Vec<Value>) -> Self {
        Self {
            state: if cards.is_empty() { "invalid" } else { "ready" },
            path: PathBuf::new(),
            cards,
        }
    }

    pub(crate) fn card(&self, paper_id: &str) -> Option<&Value> {
        let key = selection_key(paper_id);
        self.cards.iter().find(|card| {
            selection_text(card.get("paper_id")).is_some_and(|id| selection_key(id) == key)
        })
    }
}

/// Ready when the file carries at least one card with a paper_id and its own
/// verdict, if it records one, is not `valid: false`.
pub(crate) fn expert_cards_status(paths: &AppPaths, cycle_id: &str) -> ExpertCards {
    let path = expert_sota_cards_path(paths, cycle_id);
    let Ok(value) = read_json(&path) else {
        return ExpertCards { state: "missing", path, cards: Vec::new() };
    };
    let cards: Vec<Value> = selection_array(&value, "cards")
        .iter()
        .filter(|card| selection_text(card.get("paper_id")).is_some())
        .cloned()
        .collect();
    let declared_invalid = value.pointer("/validation/valid") == Some(&Value::Bool(false));
    ExpertCards {
        state: if cards.is_empty() || declared_invalid { "invalid" } else { "ready" },
        path,
        cards,
    }
}

/// Every `evidence_ref` a card carries, anywhere in it.
pub(crate) fn expert_card_evidence_refs(card: &Value) -> BTreeSet<String> {
    fn walk(value: &Value, refs: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for (key, item) in map {
                    if key == "evidence_ref" {
                        if let Some(text) = selection_text(Some(item)) {
                            refs.insert(text.to_string());
                        }
                    } else {
                        walk(item, refs);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, refs)),
            _ => {}
        }
    }
    let mut refs = BTreeSet::new();
    walk(card, &mut refs);
    refs
}

/// Numeric tokens in a text, thousands separators removed and "85.0" read as
/// "85".
pub(crate) fn expert_numeric_tokens(text: &str) -> BTreeSet<String> {
    fn flush(current: &mut String, tokens: &mut BTreeSet<String>) {
        let trimmed = current.trim_matches('.').to_string();
        if trimmed.chars().any(|c| c.is_ascii_digit()) {
            let normalised = if trimmed.contains('.') {
                trimmed.trim_end_matches('0').trim_end_matches('.').to_string()
            } else {
                trimmed
            };
            tokens.insert(normalised);
        }
        current.clear();
    }
    let mut tokens = BTreeSet::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            current.push(ch);
        } else if ch == ',' && !current.is_empty() {
            continue;
        } else {
            flush(&mut current, &mut tokens);
        }
    }
    flush(&mut current, &mut tokens);
    tokens
}

/// The numbers a card reports as its results: its core claims and their
/// `numbers`, whatever shape those take.
pub(crate) fn expert_card_reported_numbers(card: &Value) -> BTreeSet<String> {
    let mut tokens = BTreeSet::new();
    for claim in selection_array(card, "core_claims") {
        let text = match claim {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        tokens.extend(expert_numeric_tokens(&text));
    }
    tokens
}

fn expert_normalised_url(url: &str) -> String {
    url.trim()
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.")
        .to_ascii_lowercase()
}

/// One open-source asset a card names, flattened.
#[derive(Clone, Debug)]
pub(crate) struct ExpertCardAsset {
    pub(crate) url: String,
    pub(crate) name: String,
}

pub(crate) fn expert_card_assets(card: &Value) -> Vec<ExpertCardAsset> {
    let mut out = Vec::new();
    let Some(assets) = card.get("assets") else {
        return out;
    };
    for key in ["code", "checkpoints", "datasets", "envs"] {
        for entry in selection_array(assets, key) {
            let (url, name) = match entry {
                Value::String(text) => (text.clone(), text.clone()),
                other => (
                    selection_text(other.get("url")).unwrap_or("").to_string(),
                    selection_text(other.get("name"))
                        .or_else(|| selection_text(other.get("url")))
                        .unwrap_or("")
                        .to_string(),
                ),
            };
            if url.is_empty() && name.is_empty() {
                continue;
            }
            out.push(ExpertCardAsset { url, name });
        }
    }
    out
}

/// Whether an asset a stage names is one of the cards' assets, by URL or name.
pub(crate) fn expert_find_card_asset<'a>(assets: &'a [ExpertCardAsset], url: &str, name: &str) -> Option<&'a ExpertCardAsset> {
    let url_key = expert_normalised_url(url);
    let name_key = name.trim().to_ascii_lowercase();
    assets.iter().find(|asset| {
        (!url_key.is_empty() && !asset.url.is_empty() && expert_normalised_url(&asset.url) == url_key)
            || (!name_key.is_empty() && asset.name.trim().to_ascii_lowercase() == name_key)
            || (!url_key.is_empty() && expert_normalised_url(&asset.name) == url_key)
    })
}

pub(crate) fn expert_all_card_assets(cards: &ExpertCards) -> Vec<ExpertCardAsset> {
    cards.cards.iter().flat_map(expert_card_assets).collect()
}

/// A card for a reasoning stage, bounded. `host_view` keeps what only matters
/// for running the asset here -- local copies and VRAM floors -- and is off for
/// every stage before feasibility, which must not see this host at all.
pub(crate) fn expert_compact_card(card: &Value, host_view: bool) -> Value {
    let list = |key: &str, limit: usize| -> Value {
        Value::Array(selection_array(card, key).iter().take(limit).cloned().collect())
    };
    let mut assets = card.get("assets").cloned().unwrap_or(Value::Null);
    if !host_view {
        if let Some(object) = assets.as_object_mut() {
            for key in ["local_copy_path", "min_vram_gb_eval", "min_vram_gb_train"] {
                object.remove(key);
            }
        }
    }
    json!({
        "paper_id": card.get("paper_id").cloned().unwrap_or(Value::Null),
        "title": clip_text(card.get("title"), 200),
        "year": card.get("year").cloned().unwrap_or(Value::Null),
        "venue": card.get("venue").cloned().unwrap_or(Value::Null),
        "core_claims": list("core_claims", 8),
        "method_core": clip_text(card.get("method_core"), 600),
        "setup": card.get("setup").cloned().unwrap_or(Value::Null),
        "ablations_present": list("ablations_present", 10),
        "ablations_missing": list("ablations_missing", 10),
        "stated_limitations": list("stated_limitations", 8),
        "unstated_assumptions": list("unstated_assumptions", 8),
        "load_bearing_beliefs": list("load_bearing_beliefs", 8),
        "falsifier": clip_text(card.get("falsifier"), 600),
        "assets": assets,
    })
}
