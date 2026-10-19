#![allow(unused_imports)]
use super::*;
use std::collections::{BTreeMap, BTreeSet};

// --- SOTA deep read -----------------------------------------------------------------
//
// The problem is chosen from what the field's best papers actually show, read in
// full -- not from their abstracts.
//
// Problem definition and hypothesis are most of a research programme's outcome,
// and a problem that looks new to experts starts from a precise account of the
// state of the art: which component of a SOTA method actually carries its gain,
// which ablation nobody ran, what every paper takes for granted. Screening reads
// abstracts, and an abstract states the claim, never the missing control. And
// almost all SOTA robot-learning work ships its code, checkpoints, datasets and
// benchmark environments; which of them exist, under what licence, on how much
// GPU memory, and whether a copy is already on this host decides whether a
// question costs a day or a year.
//
// So, after the field landscape is valid and before any lead:
//   * a `sota_deep_read` scout picks ~10 of the landscape's most influential
//     works across subfields, fetches each one's full text
//     (`search.py --fulltext`, cached under `.research-lab/literature/fulltext/`
//     with its sha256) and its open-source assets (`search.py --resolve-assets`),
//     and writes one card per paper;
//   * every card is validated here: its paper is a verified landscape paper, its
//     full text is the cached one (the sha256 is recomputed), every claim about
//     the paper carries an `evidence_ref` whose quote is found in that text and
//     whose section / table / figure exists in it, and its assets are resolved
//     or their absence is backed by the searches tried;
//   * valid cards are published, merged across attempts, to
//     `<cycle>-sota-cards.json` -- the contract labdirector::problem_selection
//     reads.
//
// Card contract (keys fixed; the downstream pipeline depends on them):
//   {paper_id, title, year, venue, fulltext_source{url, sha256},
//    core_claims[{claim, evidence_ref, numbers}], method_core,
//    setup{benchmarks[], data_scale, compute},
//    ablations_present[{what, evidence_ref}], ablations_missing[{what, why_it_matters}],
//    stated_limitations[{text, evidence_ref}], unstated_assumptions[{text, evidence_ref}],
//    load_bearing_beliefs[{belief, evidence_ref}], falsifier,
//    assets{code[{url, license, stars, pushed_at, head_sha}], checkpoints[{url, size_gb, license}],
//           datasets[{url, size_gb, license}], envs[], min_vram_gb_eval, min_vram_gb_train,
//           reproduction_entry, local_copy_path|null, searches_tried[]}}
// `evidence_ref` is ONE string, so a downstream stage can copy it verbatim:
// `§4.2; Table 3; "an exact quote from the cached full text"`.

pub(crate) const SOTA_DEEP_READ_ACTION: &str = "sota_deep_read";
pub(crate) const SOTA_CARDS_DIR: &str = "sota-cards";
pub(crate) const SOTA_CARDS_FILE: &str = "sota-cards.json";
const SOTA_ATTEMPTS_KEPT: usize = 10;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SotaCardThresholds {
    /// Papers the scout is asked to read.
    pub(crate) target_cards: usize,
    /// Valid cards for the published set to be valid.
    pub(crate) min_valid_cards: usize,
    /// Landscape subfields the valid cards must span (capped at the landscape's own count).
    pub(crate) min_subfields: usize,
    /// Valid cards on papers dated at or after the landscape's frontier year.
    pub(crate) min_frontier_cards: usize,
    pub(crate) min_core_claims: usize,
    pub(crate) min_load_bearing_beliefs: usize,
    pub(crate) min_ablations_missing: usize,
    pub(crate) require_quotes: bool,
    pub(crate) min_quote_chars: usize,
    pub(crate) max_attempts: usize,
}

impl Default for SotaCardThresholds {
    fn default() -> Self {
        Self {
            target_cards: 10,
            min_valid_cards: 8,
            min_subfields: 3,
            min_frontier_cards: 4,
            min_core_claims: 3,
            min_load_bearing_beliefs: 1,
            min_ablations_missing: 1,
            require_quotes: true,
            min_quote_chars: 20,
            max_attempts: 3,
        }
    }
}

impl SotaCardThresholds {
    pub(crate) fn as_value(&self) -> Value {
        json!({
            "target_cards": self.target_cards,
            "min_valid_cards": self.min_valid_cards,
            "min_subfields": self.min_subfields,
            "min_frontier_cards": self.min_frontier_cards,
            "min_core_claims": self.min_core_claims,
            "min_load_bearing_beliefs": self.min_load_bearing_beliefs,
            "min_ablations_missing": self.min_ablations_missing,
            "require_quotes": self.require_quotes,
            "min_quote_chars": self.min_quote_chars,
            "max_attempts": self.max_attempts,
        })
    }
}

fn sota_env<T: std::str::FromStr>(name: &str) -> Option<T> {
    env::var(name).ok().and_then(|raw| raw.trim().parse::<T>().ok())
}

/// The thresholds in force, each overridable from the environment. The valid-card
/// floor defaults to 80% of the target and never exceeds it.
pub(crate) fn sota_card_thresholds() -> SotaCardThresholds {
    let defaults = SotaCardThresholds::default();
    let target = sota_env::<usize>("RESEARCHLAB_SOTA_DEEP_READ_COUNT")
        .filter(|value| *value > 0)
        .unwrap_or(defaults.target_cards);
    let min_valid = sota_env::<usize>("RESEARCHLAB_SOTA_CARDS_MIN_VALID")
        .filter(|value| *value > 0)
        .unwrap_or_else(|| ((target * 4) + 4) / 5)
        .min(target);
    let require_quotes = !matches!(
        env::var("RESEARCHLAB_SOTA_CARD_REQUIRE_QUOTES")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    );
    SotaCardThresholds {
        target_cards: target,
        min_valid_cards: min_valid,
        min_subfields: sota_env("RESEARCHLAB_SOTA_CARDS_MIN_SUBFIELDS").unwrap_or(defaults.min_subfields),
        min_frontier_cards: sota_env::<usize>("RESEARCHLAB_SOTA_CARDS_MIN_FRONTIER")
            .unwrap_or(min_valid / 2)
            .min(min_valid),
        min_core_claims: sota_env("RESEARCHLAB_SOTA_CARD_MIN_CORE_CLAIMS").unwrap_or(defaults.min_core_claims),
        min_load_bearing_beliefs: sota_env("RESEARCHLAB_SOTA_CARD_MIN_LOAD_BEARING_BELIEFS")
            .unwrap_or(defaults.min_load_bearing_beliefs),
        min_ablations_missing: sota_env("RESEARCHLAB_SOTA_CARD_MIN_ABLATIONS_MISSING")
            .unwrap_or(defaults.min_ablations_missing),
        require_quotes,
        min_quote_chars: sota_env("RESEARCHLAB_SOTA_CARD_MIN_QUOTE_CHARS").unwrap_or(defaults.min_quote_chars),
        max_attempts: sota_env::<usize>("RESEARCHLAB_SOTA_DEEP_READ_MAX_ATTEMPTS")
            .filter(|value| *value > 0)
            .unwrap_or(defaults.max_attempts),
    }
}

/// On unless the owner turns it off (`RESEARCHLAB_SOTA_DEEP_READ=0|false|off|no`).
pub(crate) fn sota_deep_read_enabled() -> bool {
    !matches!(
        env::var("RESEARCHLAB_SOTA_DEEP_READ")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

pub(crate) fn sota_cards_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-sota-cards.json"))
}

fn sota_cards_attempts_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-sota-cards-attempts.json"))
}

/// Where `search.py --fulltext` caches papers: `RESEARCHLAB_FULLTEXT_ROOT`, else
/// `<runtime root>/literature/fulltext` (the driver's own default).
pub(crate) fn fulltext_cache_root(paths: &AppPaths) -> PathBuf {
    env::var("RESEARCHLAB_FULLTEXT_ROOT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.runtime_root.join("literature").join("fulltext"))
}

pub(crate) fn local_asset_inventory_path(paths: &AppPaths) -> PathBuf {
    env::var("RESEARCHLAB_LOCAL_ASSET_INVENTORY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.runtime_root.join("literature").join("local-asset-inventory.json"))
}

fn card_key(id: &str) -> String {
    id.trim().to_ascii_lowercase()
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty())
}

// --- SHA-256 (FIPS 180-4) -------------------------------------------------------------
//
// The card names the text it was read from by hash; the harness recomputes it
// rather than trusting the cache's own manifest. No crypto crate is a dependency.

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    let mut w = [0u32; 64];
    for chunk in message.chunks(64) {
        for (index, word) in chunk.chunks(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7) ^ w[index - 15].rotate_right(18) ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17) ^ w[index - 2].rotate_right(19) ^ (w[index - 2] >> 10);
            w[index] = w[index - 16].wrapping_add(s0).wrapping_add(w[index - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[index]).wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }
    h.iter().map(|word| format!("{word:08x}")).collect()
}

// --- the cached full text ------------------------------------------------------------------

/// One cached paper, as the evidence references are checked against it.
#[derive(Clone, Debug, Default)]
pub(crate) struct FulltextIndex {
    pub(crate) arxiv_id: String,
    pub(crate) source_url: String,
    pub(crate) sha256: String,
    /// The text, normalised by `normalise_for_match`.
    pub(crate) normalised: String,
    /// Section numbers, lower case ("3.2", "a", "b.1").
    pub(crate) sections: BTreeSet<String>,
    /// Caption labels, lower case ("table 3", "figure 2").
    pub(crate) labels: BTreeSet<String>,
    pub(crate) assets: Option<Value>,
}

/// Lower-case alphanumeric words separated by single spaces, so a quote matches
/// the text whatever the extraction did to punctuation, table rules and line breaks.
pub(crate) fn normalise_for_match(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.extend(ch.to_lowercase());
        } else {
            pending_space = true;
        }
    }
    out
}

fn load_fulltext_dir(directory: &Path) -> Option<FulltextIndex> {
    let manifest = read_json(&directory.join("manifest.json")).ok()?;
    let text_file = text_of(manifest.get("text_file")).unwrap_or("fulltext.txt");
    let bytes = fs::read(directory.join(text_file)).ok()?;
    let sha256 = sha256_hex(&bytes);
    let index = read_json(&directory.join(text_of(manifest.get("index_file")).unwrap_or("sections.json")))
        .unwrap_or(Value::Null);
    let sections = index
        .get("sections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|section| text_of(section.get("number")))
        .map(|number| number.trim_end_matches('.').to_ascii_lowercase())
        .collect();
    let labels = index
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|label| text_of(label.get("label")))
        .map(|label| normalise_for_match(label))
        .collect();
    Some(FulltextIndex {
        arxiv_id: text_of(manifest.get("arxiv_id")).unwrap_or("").to_string(),
        source_url: text_of(manifest.get("source_url")).unwrap_or("").to_string(),
        sha256,
        normalised: normalise_for_match(&String::from_utf8_lossy(&bytes)),
        sections,
        labels,
        assets: read_json(&directory.join("assets.json")).ok(),
    })
}

/// The cached full text whose recomputed hash is `sha256`, if any.
pub(crate) fn find_fulltext_by_sha(root: &Path, sha256: &str) -> Option<FulltextIndex> {
    let wanted = sha256.trim().to_ascii_lowercase();
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let directory = entry.path();
        let Ok(manifest) = read_json(&directory.join("manifest.json")) else {
            continue;
        };
        // The manifest's own hash only picks the candidate; the text is re-hashed.
        if text_of(manifest.get("sha256")).map(str::to_ascii_lowercase).as_deref() != Some(wanted.as_str()) {
            continue;
        }
        if let Some(index) = load_fulltext_dir(&directory) {
            if index.sha256 == wanted {
                return Some(index);
            }
        }
    }
    None
}

// --- evidence references --------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct EvidenceLocators {
    pub(crate) quotes: Vec<String>,
    pub(crate) sections: Vec<String>,
    pub(crate) labels: Vec<String>,
}

fn locator_token(rest: &str, section: bool) -> Option<String> {
    let token: String = rest
        .trim_start_matches(|c: char| c.is_whitespace() || c == ':' || c == '~')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.')
        .collect();
    let token = token.trim_end_matches('.').to_ascii_lowercase();
    if token.is_empty() {
        return None;
    }
    if !section {
        // "3", "S1", "A.2": any label number the paper prints.
        return token.chars().any(|c| c.is_ascii_digit()).then_some(token);
    }
    // A section is a number ("3.2"), an appendix letter path ("a", "b.1") or an
    // IEEE Roman numeral ("iv").
    let head = token.split('.').next().unwrap_or("");
    let valid = token.chars().next().is_some_and(|c| c.is_ascii_digit())
        || (token.len() == 1 && token.chars().all(|c| c.is_ascii_alphabetic()))
        || (!head.is_empty() && head.len() <= 5 && head.chars().all(|c| matches!(c, 'i' | 'v' | 'x')))
        || (token.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && token.chars().nth(1) == Some('.'));
    valid.then_some(token)
}

/// Quotes, section numbers and caption labels named by one evidence_ref string.
pub(crate) fn parse_evidence_ref(reference: &str) -> EvidenceLocators {
    let mut out = EvidenceLocators::default();
    // Quotes first; locators are read only from what lies outside them.
    let mut outside = String::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;
    for ch in reference.chars() {
        match in_quote {
            None if ch == '"' || ch == '\u{201c}' => in_quote = Some(if ch == '"' { '"' } else { '\u{201d}' }),
            None => outside.push(ch),
            Some(close) if ch == close || (close == '\u{201d}' && ch == '"') => {
                if !current.trim().is_empty() {
                    out.quotes.push(current.trim().to_string());
                }
                current.clear();
                in_quote = None;
                outside.push(' ');
            }
            Some(_) => current.push(ch),
        }
    }
    if in_quote.is_some() && !current.trim().is_empty() {
        out.quotes.push(current.trim().to_string());
    }
    let lower = outside.to_lowercase();
    let mut index = 0;
    while index < lower.len() {
        let rest = &lower[index..];
        let mut advanced = false;
        for (prefix, kind) in [
            ("§", "section"),
            ("sections ", "section"),
            ("section ", "section"),
            ("sec. ", "section"),
            ("sec ", "section"),
            ("appendix ", "section"),
            ("app. ", "section"),
            ("table ", "table"),
            ("tab. ", "table"),
            ("figure ", "figure"),
            ("fig. ", "figure"),
            ("fig ", "figure"),
            ("algorithm ", "algorithm"),
            ("alg. ", "algorithm"),
        ] {
            let boundary = index == 0
                || !lower[..index].chars().next_back().is_some_and(|c| c.is_alphanumeric());
            if boundary && rest.starts_with(prefix) {
                let after = &rest[prefix.len()..];
                if let Some(token) = locator_token(after, kind == "section") {
                    if kind == "section" {
                        out.sections.push(token);
                    } else {
                        out.labels.push(format!("{kind} {token}"));
                    }
                }
                index += prefix.len();
                advanced = true;
                break;
            }
        }
        if !advanced {
            index += rest.chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
    out
}

/// Whether one evidence_ref points at something in the cached full text.
pub(crate) fn check_evidence_ref(
    reference: Option<&Value>,
    fulltext: Option<&FulltextIndex>,
    thresholds: &SotaCardThresholds,
) -> std::result::Result<(), String> {
    let Some(value) = reference else {
        return Err("has no evidence_ref".to_string());
    };
    let Some(text) = value.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
        return Err(if value.is_null() {
            "has no evidence_ref".to_string()
        } else {
            "evidence_ref must be one string -- '§<section>; Table <n>; \"<exact quote>\"' -- so it can be cited verbatim".to_string()
        });
    };
    let locators = parse_evidence_ref(text);
    if locators.quotes.is_empty() && locators.sections.is_empty() && locators.labels.is_empty() {
        return Err(format!("evidence_ref '{}' names no section, table, figure or quote", clip(text, 80)));
    }
    if thresholds.require_quotes && locators.quotes.is_empty() {
        return Err(format!(
            "evidence_ref '{}' carries no quote; quote the passage (\"...\") the item rests on",
            clip(text, 80)
        ));
    }
    let Some(fulltext) = fulltext else {
        return Err("evidence_ref cannot be checked: the card's full text is not in the cache".to_string());
    };
    for quote in &locators.quotes {
        let needle = normalise_for_match(quote);
        if needle.chars().count() < thresholds.min_quote_chars {
            return Err(format!(
                "quote \"{}\" is too short to locate (at least {} characters of words)",
                clip(quote, 60),
                thresholds.min_quote_chars
            ));
        }
        if !fulltext.normalised.contains(&needle) {
            return Err(format!("quote \"{}\" is not in the cached full text", clip(quote, 80)));
        }
    }
    for section in &locators.sections {
        let known = fulltext.sections.contains(section)
            || fulltext.sections.iter().any(|number| number.starts_with(&format!("{section}.")));
        if !known {
            return Err(format!("section §{section} is not a section of the cached full text"));
        }
    }
    for label in &locators.labels {
        let needle = normalise_for_match(label);
        if !fulltext.labels.contains(&needle) && !fulltext.normalised.contains(&format!("{needle} ")) {
            return Err(format!("'{label}' is not a table, figure or algorithm of the cached full text"));
        }
    }
    Ok(())
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        format!("{}...", text.chars().take(max).collect::<String>())
    } else {
        text.to_string()
    }
}

// --- one card ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub(crate) struct CardValidation {
    pub(crate) paper_id: String,
    pub(crate) valid: bool,
    pub(crate) reasons: Vec<String>,
    pub(crate) warnings: Vec<String>,
}

impl CardValidation {
    fn as_value(&self) -> Value {
        json!({
            "paper_id": self.paper_id,
            "valid": self.valid,
            "reasons": self.reasons.iter().take(20).collect::<Vec<_>>(),
            "warnings": self.warnings.iter().take(10).collect::<Vec<_>>(),
        })
    }
}

fn items<'a>(card: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    card.get(key).and_then(Value::as_array)
}

/// Validate one card against the landscape's verified papers and the cached text.
pub(crate) fn validate_sota_card(
    card: &Value,
    landscape_papers: &serde_json::Map<String, Value>,
    fulltext_root: &Path,
    thresholds: &SotaCardThresholds,
) -> CardValidation {
    let mut out = CardValidation::default();
    let Some(paper_id) = text_of(card.get("paper_id")) else {
        out.reasons.push("paper_id is missing".to_string());
        return out;
    };
    out.paper_id = paper_id.to_string();
    if !landscape_papers.contains_key(&card_key(paper_id)) {
        out.reasons.push(format!(
            "paper_id '{paper_id}' is not a verified paper of the field landscape; cite it exactly as field_landscape.verified_papers names it"
        ));
    }
    if text_of(card.get("title")).is_none() {
        out.reasons.push("title is missing".to_string());
    }
    for key in ["year", "venue"] {
        if card.get(key).is_none() {
            out.reasons.push(format!("{key} is missing (null if unknown)"));
        }
    }
    let url = text_of(card.pointer("/fulltext_source/url"));
    let sha = text_of(card.pointer("/fulltext_source/sha256"));
    let fulltext = match (url, sha) {
        (Some(_), Some(sha)) => {
            let found = find_fulltext_by_sha(fulltext_root, sha);
            if found.is_none() {
                out.reasons.push(format!(
                    "fulltext_source.sha256 {} is not a cached full text whose content still hashes to it; fetch the paper with search.py --fulltext and copy fulltext_source from its output",
                    clip(sha, 16)
                ));
            }
            found
        }
        _ => {
            out.reasons.push("fulltext_source{url, sha256} is missing: a card is read from the full text, not the abstract".to_string());
            None
        }
    };
    // A card must cite the text of ITS paper, not another cached one.
    if let (Some(index), Some(expected)) = (fulltext.as_ref(), arxiv_id_of(paper_id).as_str()) {
        if !index.arxiv_id.is_empty() && index.arxiv_id != expected {
            out.reasons.push(format!(
                "fulltext_source is the cached text of arXiv {}, not of this paper (arXiv {expected})",
                index.arxiv_id
            ));
        }
    }
    if let (Some(index), Some(url)) = (fulltext.as_ref(), url) {
        if !index.source_url.is_empty() && index.source_url != url {
            out.warnings.push(format!("fulltext_source.url differs from the cached source {}", index.source_url));
        }
    }
    let fulltext = fulltext.as_ref();

    // Every item that states something about the paper carries a checked reference.
    let referenced = |key: &str, text_key: &str, out: &mut CardValidation| -> usize {
        let mut good = 0;
        for (index, item) in items(card, key).into_iter().flatten().enumerate() {
            let label = format!("{key}[{index}]");
            if text_of(item.get(text_key)).is_none() {
                out.reasons.push(format!("{label}.{text_key} is empty"));
                continue;
            }
            match check_evidence_ref(item.get("evidence_ref"), fulltext, thresholds) {
                Ok(()) => good += 1,
                Err(reason) => out.reasons.push(format!("{label}: {reason}")),
            }
        }
        good
    };
    let claims = referenced("core_claims", "claim", &mut out);
    if claims < thresholds.min_core_claims {
        out.reasons.push(format!(
            "{claims} core claim(s) with a checked evidence_ref, at least {} required",
            thresholds.min_core_claims
        ));
    }
    for (index, claim) in items(card, "core_claims").into_iter().flatten().enumerate() {
        if claim.get("numbers").is_none() {
            out.warnings.push(format!("core_claims[{index}].numbers is missing (use [] when the claim has none)"));
        }
    }
    referenced("ablations_present", "what", &mut out);
    referenced("stated_limitations", "text", &mut out);
    referenced("unstated_assumptions", "text", &mut out);
    let beliefs = referenced("load_bearing_beliefs", "belief", &mut out);
    if beliefs < thresholds.min_load_bearing_beliefs {
        out.reasons.push(format!(
            "{beliefs} load-bearing belief(s) with a checked evidence_ref, at least {} required",
            thresholds.min_load_bearing_beliefs
        ));
    }
    for key in ["ablations_present", "stated_limitations", "unstated_assumptions"] {
        if items(card, key).is_none() {
            out.reasons.push(format!("{key}[] is missing ([] when there are none)"));
        }
    }
    let missing = items(card, "ablations_missing")
        .into_iter()
        .flatten()
        .filter(|item| text_of(item.get("what")).is_some() && text_of(item.get("why_it_matters")).is_some())
        .count();
    if missing < thresholds.min_ablations_missing {
        out.reasons.push(format!(
            "{missing} missing ablation(s) with what and why_it_matters, at least {} required",
            thresholds.min_ablations_missing
        ));
    }
    for key in ["method_core", "falsifier"] {
        if text_of(card.get(key)).is_none() {
            out.reasons.push(format!("{key} is empty"));
        }
    }
    match card.get("setup") {
        Some(setup) if setup.is_object() => {
            match setup.get("benchmarks").and_then(Value::as_array) {
                Some(list) if list.is_empty() => out.warnings.push("setup.benchmarks is empty".to_string()),
                Some(_) => {}
                None => out.reasons.push("setup.benchmarks[] is missing".to_string()),
            }
            for key in ["data_scale", "compute"] {
                if setup.get(key).is_none() {
                    out.reasons.push(format!("setup.{key} is missing (null if the paper does not say)"));
                }
            }
        }
        _ => out.reasons.push("setup{benchmarks, data_scale, compute} is missing".to_string()),
    }
    validate_card_assets(card.get("assets"), fulltext, &mut out);
    out.valid = out.reasons.is_empty();
    out
}

fn validate_card_assets(assets: Option<&Value>, fulltext: Option<&FulltextIndex>, out: &mut CardValidation) {
    let Some(assets) = assets.filter(|value| value.is_object()) else {
        out.reasons.push("assets{} is missing".to_string());
        return;
    };
    let searched: BTreeSet<String> = assets
        .get("searches_tried")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|search| text_of(search.get("kind")).map(str::to_ascii_lowercase))
        .collect();
    let required_keys: [(&str, &[&str]); 3] = [
        ("code", &["license", "stars", "pushed_at", "head_sha"]),
        ("checkpoints", &["size_gb", "license"]),
        ("datasets", &["size_gb", "license"]),
    ];
    for (kind, keys) in required_keys {
        let Some(list) = assets.get(kind).and_then(Value::as_array) else {
            out.reasons.push(format!("assets.{kind}[] is missing"));
            continue;
        };
        if list.is_empty() && !searched.contains(kind) {
            out.reasons.push(format!(
                "assets.{kind} is empty and assets.searches_tried records no {kind} search: resolved, or 'none found' with the searches tried"
            ));
        }
        for (index, entry) in list.iter().enumerate() {
            if text_of(entry.get("url")).is_none() {
                out.reasons.push(format!("assets.{kind}[{index}].url is missing"));
                continue;
            }
            for key in keys {
                if entry.get(*key).is_none() {
                    out.reasons.push(format!("assets.{kind}[{index}].{key} is missing (null if unknown)"));
                }
            }
        }
    }
    if !assets.get("envs").is_some_and(Value::is_array) {
        out.reasons.push("assets.envs[] is missing".to_string());
    }
    for key in ["min_vram_gb_eval", "min_vram_gb_train"] {
        match assets.get(key) {
            Some(Value::Number(_)) => {}
            Some(Value::Null) => out.warnings.push(format!("assets.{key} is null: no estimate")),
            Some(_) => out.reasons.push(format!("assets.{key} must be a number of GB or null")),
            None => out.reasons.push(format!("assets.{key} is missing (a number of GB, or null)")),
        }
    }
    for key in ["reproduction_entry", "local_copy_path"] {
        if assets.get(key).is_none() {
            out.reasons.push(format!("assets.{key} is missing (null if none)"));
        }
    }
    // The resolver's own record, when the scout ran it: a repository the card
    // names that the resolver never saw is worth a look, not a rejection.
    if let Some(resolved) = fulltext.and_then(|index| index.assets.as_ref()) {
        let known: BTreeSet<String> = resolved
            .pointer("/assets/code")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| text_of(entry.get("url")).map(|url| url.trim_end_matches('/').to_ascii_lowercase()))
            .collect();
        for entry in assets.get("code").and_then(Value::as_array).into_iter().flatten() {
            if let Some(url) = text_of(entry.get("url")) {
                let key = url.trim_end_matches('/').to_ascii_lowercase();
                if !known.is_empty() && !known.contains(&key) {
                    out.warnings.push(format!("assets.code url {url} is not the repository search.py --resolve-assets found"));
                }
            }
        }
    }
}

// --- the published set --------------------------------------------------------------------

/// Which landscape subfields each verified paper belongs to.
fn landscape_paper_subfields(landscape: &Value) -> BTreeMap<String, BTreeSet<String>> {
    let mut map: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for subfield in landscape.get("subfields").and_then(Value::as_array).into_iter().flatten() {
        let Some(subfield_id) = text_of(subfield.get("subfield_id")).or_else(|| text_of(subfield.get("name"))) else {
            continue;
        };
        for key in [
            "canonical_works",
            "frontier_works",
            "dominant_approaches",
            "benchmarks",
            "open_problems",
            FRONTIER_HARVEST_WORKS_KEY,
        ] {
            for entry in subfield.get(key).and_then(Value::as_array).into_iter().flatten() {
                let mut ids: Vec<&str> = text_of(entry.get("paper_id")).into_iter().collect();
                ids.extend(
                    entry
                        .get("paper_ids")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|item| text_of(Some(item))),
                );
                for id in ids {
                    map.entry(card_key(id)).or_default().insert(subfield_id.to_string());
                }
            }
        }
    }
    map
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SotaCardsValidation {
    pub(crate) valid: bool,
    pub(crate) reasons: Vec<String>,
    pub(crate) card_results: Vec<CardValidation>,
    pub(crate) valid_cards: Vec<Value>,
    pub(crate) subfields_covered: BTreeSet<String>,
    pub(crate) frontier_cards: usize,
}

/// Validate a set of cards against the published landscape. Earlier valid cards
/// (`carried`) keep counting: a later attempt only has to fill the gaps.
pub(crate) fn validate_sota_cards(
    cards: &[Value],
    carried: &[Value],
    landscape: &Value,
    fulltext_root: &Path,
    thresholds: &SotaCardThresholds,
) -> SotaCardsValidation {
    let mut out = SotaCardsValidation::default();
    let verified = landscape
        .get("verified_papers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let frontier_year = landscape
        .pointer("/thresholds/frontier_year")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| field_landscape_thresholds().frontier_year);
    let subfields_of = landscape_paper_subfields(landscape);
    let landscape_subfields = landscape.get("subfields").and_then(Value::as_array).map(Vec::len).unwrap_or(0);

    let mut accepted: BTreeMap<String, Value> = BTreeMap::new();
    for card in carried {
        if let Some(id) = text_of(card.get("paper_id")) {
            accepted.insert(card_key(id), card.clone());
        }
    }
    let mut seen = BTreeSet::new();
    for card in cards {
        let result = validate_sota_card(card, &verified, fulltext_root, thresholds);
        let key = card_key(&result.paper_id);
        if !result.paper_id.is_empty() && !seen.insert(key.clone()) {
            continue; // one card per paper; the first file wins
        }
        if result.valid {
            accepted.insert(key, card.clone());
        }
        out.card_results.push(result);
    }
    for (key, card) in &accepted {
        if let Some(subfields) = subfields_of.get(key) {
            out.subfields_covered.extend(subfields.iter().cloned());
        }
        let year = verified.get(key).and_then(|paper| paper.get("year")).and_then(Value::as_i64);
        if year.is_some_and(|year| year >= frontier_year) {
            out.frontier_cards += 1;
        }
        out.valid_cards.push(card.clone());
    }
    let needed_subfields = thresholds.min_subfields.min(landscape_subfields.max(1));
    if out.valid_cards.len() < thresholds.min_valid_cards {
        out.reasons.push(format!(
            "{} valid card(s), at least {} required",
            out.valid_cards.len(),
            thresholds.min_valid_cards
        ));
    }
    if out.subfields_covered.len() < needed_subfields {
        out.reasons.push(format!(
            "valid cards span {} landscape subfield(s), at least {} required -- read across subfields, not within one",
            out.subfields_covered.len(),
            needed_subfields
        ));
    }
    if out.frontier_cards < thresholds.min_frontier_cards {
        out.reasons.push(format!(
            "{} valid card(s) on frontier work dated {frontier_year}+, at least {} required",
            out.frontier_cards, thresholds.min_frontier_cards
        ));
    }
    out.valid = out.reasons.is_empty();
    out
}

fn card_files(dir: &Path) -> Vec<Value> {
    let mut cards = Vec::new();
    let mut push = |value: Value| match value {
        Value::Array(list) => cards.extend(list.into_iter().filter(Value::is_object)),
        Value::Object(ref map) if map.get("cards").is_some_and(Value::is_array) => {
            cards.extend(map["cards"].as_array().cloned().unwrap_or_default().into_iter().filter(Value::is_object))
        }
        Value::Object(ref map) if map.contains_key("paper_id") => cards.push(value),
        _ => {}
    };
    let card_dir = dir.join(SOTA_CARDS_DIR);
    if let Ok(entries) = fs::read_dir(&card_dir) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        files.sort();
        for file in files {
            if let Ok(value) = read_json(&file) {
                push(value);
            }
        }
    }
    if let Ok(value) = read_json(&dir.join(SOTA_CARDS_FILE)) {
        push(value);
    }
    cards
}

#[derive(Clone, Debug)]
pub(crate) struct SotaCardsStatus {
    /// `missing`, `invalid` or `valid`.
    pub(crate) state: &'static str,
    pub(crate) path: PathBuf,
    pub(crate) published: Value,
}

pub(crate) fn sota_cards_status(paths: &AppPaths, cycle_id: &str) -> SotaCardsStatus {
    let path = sota_cards_state_path(paths, cycle_id);
    let Ok(published) = read_json(&path) else {
        return SotaCardsStatus { state: "missing", path, published: Value::Null };
    };
    // No silent drop: while a harvested frontier candidate is owed a review, the
    // published deep-read stage is not usable (labdirector::frontier_harvest).
    let valid = published.pointer("/validation/valid") == Some(&Value::Bool(true))
        && frontier_harvest_block_reasons(paths, cycle_id).is_empty();
    SotaCardsStatus { state: if valid { "valid" } else { "invalid" }, path, published }
}

fn role_plan_action(role_plan: Option<&Value>) -> &str {
    role_plan
        .and_then(|plan| plan.get("action_type"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub(crate) fn is_sota_deep_read_lane(contract: &LaneContract, role_plan: Option<&Value>) -> bool {
    contract.role == "scout" && role_plan_action(role_plan) == SOTA_DEEP_READ_ACTION
}

/// Validate the cards a finished deep-read scout wrote and publish the merged set.
///
/// Published: `cards` (every valid card, this attempt's and earlier ones'),
/// `rejected_cards` with their reasons, the thresholds and the verdict. The
/// file is written whatever the verdict so the next attempt and the owner can
/// see what failed; `validation.valid` says whether it may be used.
pub(crate) fn project_sota_cards(
    paths: &AppPaths,
    contract: &LaneContract,
    role_plan: Option<&Value>,
) -> Result<Option<PathBuf>> {
    if !is_sota_deep_read_lane(contract, role_plan) {
        return Ok(None);
    }
    let lane_dir = lane_root(paths, &contract.cycle_id, &contract.lane_id);
    let output_dir = contract
        .output_artifact
        .as_ref()
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| lane_dir.clone());
    let mut cards = card_files(&output_dir);
    if output_dir != lane_dir {
        cards.extend(card_files(&lane_dir));
    }
    let thresholds = sota_card_thresholds();
    let landscape = field_landscape_status(paths, &contract.cycle_id);
    let previous = sota_cards_status(paths, &contract.cycle_id);
    let carried: Vec<Value> = previous
        .published
        .get("cards")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut validation = if landscape.state == "valid" {
        validate_sota_cards(&cards, &carried, &landscape.landscape, &fulltext_cache_root(paths), &thresholds)
    } else {
        SotaCardsValidation {
            reasons: vec![format!(
                "no valid field landscape at {}: cards are checked against its verified papers",
                landscape.path.display()
            )],
            ..Default::default()
        }
    };
    if cards.is_empty() {
        validation.reasons.insert(
            0,
            format!("the deep-read scout wrote no card under {}", output_dir.join(SOTA_CARDS_DIR).display()),
        );
        validation.valid = false;
    }
    record_sota_cards_attempt(paths, &contract.cycle_id, &contract.lane_id, &validation)?;
    let mut generated_by: Vec<Value> = previous
        .published
        .get("generated_by")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !generated_by.contains(&json!(contract.lane_id)) {
        generated_by.push(json!(contract.lane_id));
    }
    let rejected: Vec<Value> = validation
        .card_results
        .iter()
        .filter(|result| !result.valid)
        .map(CardValidation::as_value)
        .collect();
    let subfields_of = if landscape.state == "valid" {
        landscape_paper_subfields(&landscape.landscape)
    } else {
        BTreeMap::new()
    };
    let card_subfields: serde_json::Map<String, Value> = validation
        .valid_cards
        .iter()
        .filter_map(|card| text_of(card.get("paper_id")))
        .map(|id| {
            (
                id.to_string(),
                json!(subfields_of.get(&card_key(id)).cloned().unwrap_or_default()),
            )
        })
        .collect();
    let path = sota_cards_state_path(paths, &contract.cycle_id);
    write_json(
        &path,
        &json!({
            "cycle_id": contract.cycle_id,
            "generated_by": generated_by,
            "projected_at": now_iso(),
            "fulltext_root": fulltext_cache_root(paths),
            "thresholds": thresholds.as_value(),
            "validation": {
                "valid": validation.valid,
                "reasons": validation.reasons,
                "valid_card_count": validation.valid_cards.len(),
                "subfields_covered": validation.subfields_covered,
                "frontier_cards": validation.frontier_cards,
                "card_results": validation.card_results.iter().map(CardValidation::as_value).collect::<Vec<_>>(),
            },
            "card_subfields": card_subfields,
            "cards": validation.valid_cards,
            "rejected_cards": rejected,
        }),
    )?;
    Ok(Some(path))
}

fn record_sota_cards_attempt(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    validation: &SotaCardsValidation,
) -> Result<()> {
    let path = sota_cards_attempts_path(paths, cycle_id);
    let mut attempts = read_json(&path)
        .ok()
        .and_then(|value| value.get("attempts").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    attempts.push(json!({
        "lane_id": lane_id,
        "checked_at": now_iso(),
        "valid": validation.valid,
        "reasons": validation.reasons,
        "valid_card_count": validation.valid_cards.len(),
        "rejected_cards": validation
            .card_results
            .iter()
            .filter(|result| !result.valid)
            .take(12)
            .map(|result| json!({"paper_id": result.paper_id, "reasons": result.reasons.iter().take(6).collect::<Vec<_>>()}))
            .collect::<Vec<_>>(),
    }));
    let skip = attempts.len().saturating_sub(SOTA_ATTEMPTS_KEPT);
    write_json(
        &path,
        &json!({ "cycle_id": cycle_id, "attempts": attempts.into_iter().skip(skip).collect::<Vec<_>>() }),
    )
}

fn latest_sota_cards_attempt(paths: &AppPaths, cycle_id: &str) -> Value {
    read_json(&sota_cards_attempts_path(paths, cycle_id))
        .ok()
        .and_then(|value| value.get("attempts").and_then(Value::as_array).and_then(|items| items.last().cloned()))
        .unwrap_or(Value::Null)
}

// --- dispatch ----------------------------------------------------------------------------

fn deep_read_counts(paths: &AppPaths, cycle_id: &str) -> Result<(usize, usize)> {
    let key = format!("scout::{SOTA_DEEP_READ_ACTION}");
    let total = count_followup_lanes_by_role_and_action(paths, cycle_id)?.get(&key).copied().unwrap_or(0);
    let open = count_open_followup_lanes_by_role_and_action(paths, cycle_id)?.get(&key).copied().unwrap_or(0);
    Ok((total, open))
}

/// The landscape papers a deep read chooses from: frontier first, then those
/// the landscape names in more roles and subfields.
fn deep_read_candidates(landscape: &Value) -> Vec<Value> {
    let verified = landscape
        .get("verified_papers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let frontier_year = landscape
        .pointer("/thresholds/frontier_year")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| field_landscape_thresholds().frontier_year);
    let mut roles: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for subfield in landscape.get("subfields").and_then(Value::as_array).into_iter().flatten() {
        for (key, role) in [
            ("canonical_works", "canonical"),
            ("frontier_works", "frontier"),
            ("dominant_approaches", "dominant_approach"),
            ("benchmarks", "benchmark"),
            ("open_problems", "states_open_problem"),
            (FRONTIER_HARVEST_WORKS_KEY, "frontier_harvest"),
        ] {
            for entry in subfield.get(key).and_then(Value::as_array).into_iter().flatten() {
                let mut ids: Vec<&str> = text_of(entry.get("paper_id")).into_iter().collect();
                ids.extend(entry.get("paper_ids").and_then(Value::as_array).into_iter().flatten().filter_map(|item| text_of(Some(item))));
                for id in ids {
                    roles.entry(card_key(id)).or_default().insert(role.to_string());
                }
            }
        }
    }
    let subfields_of = landscape_paper_subfields(landscape);
    // Post-horizon papers the frontier harvest found (and review admitted) sort
    // first among frontier work: they are the ones no reader can name from memory,
    // so the cap must never cut them.
    let mut out: Vec<(bool, bool, usize, Value)> = verified
        .iter()
        .map(|(key, paper)| {
            let year = paper.get("year").and_then(Value::as_i64);
            let frontier = year.is_some_and(|year| year >= frontier_year);
            let post_horizon = paper.get("post_horizon").and_then(Value::as_bool) == Some(true);
            let paper_roles = roles.get(key).cloned().unwrap_or_default();
            let subfields = subfields_of.get(key).cloned().unwrap_or_default();
            let weight = paper_roles.len() + subfields.len();
            (
                frontier,
                post_horizon,
                weight,
                json!({
                    "arxiv_id": arxiv_id_of(key),
                    "paper_id": paper.get("paper_id").cloned().unwrap_or_else(|| json!(key)),
                    "title": paper.get("title").cloned().unwrap_or(Value::Null),
                    "year": year,
                    "frontier": frontier,
                    "post_horizon": post_horizon,
                    "subfield_ids": subfields,
                    "landscape_roles": paper_roles,
                }),
            )
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)).then(b.2.cmp(&a.2)));
    out.into_iter().take(80).map(|(_, _, _, value)| value).collect()
}

/// The arXiv id a landscape paper id carries, when it carries one:
/// `arxiv:2406.09246` or the DataCite DOI `doi:10.48550/arxiv.2406.09246`.
/// Other DOIs need a lookup (`search.py --doi`), which the scout does.
fn arxiv_id_of(paper_key: &str) -> Value {
    let key = paper_key.trim().to_ascii_lowercase();
    for prefix in ["doi:10.48550/arxiv.", "10.48550/arxiv.", "arxiv:"] {
        if let Some(rest) = key.strip_prefix(prefix) {
            let (id, _) = rest.split_once('v').filter(|(head, _)| head.contains('.')).unwrap_or((rest, ""));
            let valid = id.len() >= 9
                && id.split_once('.').is_some_and(|(yymm, number)| {
                    yymm.len() == 4 && yymm.chars().all(|c| c.is_ascii_digit()) && number.chars().all(|c| c.is_ascii_digit())
                });
            if valid {
                return json!(id);
            }
        }
    }
    Value::Null
}

fn sota_deep_read_description(target: usize, attempt: usize) -> String {
    format!(
        "SOTA DEEP READ, after the field landscape and before any lead: choose the {target} most influential works of the landscape across its subfields (citation velocity, top venue, the paper a dominant approach is built on); for each, fetch the FULL TEXT with search.py --fulltext and read the paper, not the abstract; resolve its open-source code, checkpoints, datasets, benchmark environments and GPU-memory floor with search.py --resolve-assets; and write one card per paper to {SOTA_CARDS_DIR}/<arXiv id>.json -- core claims with the numbers, what the method is, which ablations exist and which are missing, what the paper and the field take for granted, the observation that would falsify it, and its assets. Every claim about a paper carries an evidence_ref the harness finds in the cached text. [attempt {attempt}]"
    )
}

/// Dispatch the deep-read scout once the landscape is valid, while the published
/// cards are missing or invalid and none is open. Bounded by
/// `RESEARCHLAB_SOTA_DEEP_READ_MAX_ATTEMPTS`.
pub(crate) fn dispatch_sota_deep_read_scout(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    if !sota_deep_read_enabled() {
        return Ok(Vec::new());
    }
    let landscape = field_landscape_status(paths, cycle_id);
    if landscape.state != "valid" {
        return Ok(Vec::new());
    }
    // The deep read chooses from the landscape AND the post-horizon papers the
    // frontier harvest found, so it waits until every harvested top-K candidate
    // has been reviewed or excluded with a reason (labdirector::frontier_harvest).
    if !frontier_harvest_status(paths, cycle_id).settled {
        return Ok(Vec::new());
    }
    let cards = sota_cards_status(paths, cycle_id);
    if cards.state == "valid" {
        return Ok(Vec::new());
    }
    let thresholds = sota_card_thresholds();
    let (total, open) = deep_read_counts(paths, cycle_id)?;
    if open > 0 || total >= thresholds.max_attempts {
        return Ok(Vec::new());
    }
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let attempt = total + 1;
    let description = sota_deep_read_description(thresholds.target_cards, attempt);
    let brief_id = "sota-deep-read";
    let task_body = followup_task_markdown(cycle_id, &objective, "scout", brief_id, &description, &[]);
    let lane_id = next_followup_lane_id(paths, cycle_id, "followup-scout-")?;
    let contract_path = create_lane_contract(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        "codex-agent",
        "read-write-scoped",
        &task_body,
    )?;
    let lane_dir = lane_root(paths, cycle_id, &lane_id);
    let already: Vec<Value> = cards
        .published
        .get("cards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|card| json!({"paper_id": card.get("paper_id"), "title": card.get("title")}))
        .collect();
    let inventory = local_asset_inventory_path(paths);
    let role_plan_path = write_followup_role_plan(
        paths,
        cycle_id,
        &lane_id,
        "scout",
        assigned_model_for_role("scout", "codex-agent"),
        &objective,
        brief_id,
        &description,
        SOTA_DEEP_READ_ACTION,
        &[],
        &[],
        None,
        None,
        None,
        &[],
        json!({
            "priority_source": "sota_deep_read_gate",
            "preferred_role": "scout",
            "novelty_mode": "sota-deep-read",
            "selection_scope": "open",
            "sota_deep_read_contract": {
                "cards_dir": lane_dir.join(SOTA_CARDS_DIR),
                "published_state_path": cards.path,
                "field_landscape_path": landscape.path,
                "fulltext_root": fulltext_cache_root(paths),
                "local_asset_inventory_path": inventory,
                "local_asset_inventory_present": inventory.is_file(),
                "thresholds": thresholds.as_value(),
                "attempt": attempt,
                "current_cards_status": cards.state,
                "already_carded": already,
                "previous_attempt": latest_sota_cards_attempt(paths, cycle_id),
                "candidates": deep_read_candidates(&landscape.landscape),
            },
        }),
    )?;
    Ok(vec![json!({
        "lane_id": lane_id,
        "role": "scout",
        "contract_path": contract_path,
        "source_brief_id": brief_id,
        "role_plan_path": role_plan_path,
        "action_type": SOTA_DEEP_READ_ACTION,
    })])
}

// --- the scout's protocol ---------------------------------------------------------------

/// The deep-read scout's instructions, in place of the abstract-screening protocol.
pub(crate) fn sota_deep_read_scout_protocol(output_dir: &Path, role_plan_path: &Path) -> String {
    let thresholds = sota_card_thresholds();
    let fulltext_args = json!(["drivers/literature/search.py", "--fulltext", "<arXiv id>", "--fulltext", "<another arXiv id>"]);
    let asset_args = json!(["drivers/literature/search.py", "--resolve-assets", "<arXiv id>"]);
    let lookup_args = json!(["drivers/literature/search.py", "--arxiv-id", "<arXiv id>", "--doi", "<DOI>", "--title", "<exact title>"]);
    let cards_dir = output_dir.join(SOTA_CARDS_DIR);
    format!(
        "\n\nSOTA DEEP READ SCOUT (this lane reads the field's best papers IN FULL before any lead exists; its cards are what the problem and hypothesis are chosen from). There is no abstract screening, search journal or review queue in this lane: do not run a corpus search.\n\
A. CHOOSE. From role_plan.planner_metadata.sota_deep_read_contract.candidates (the field landscape's verified papers, cite paper_id EXACTLY as given there) choose {target} papers: the most influential work across at least {subfields} subfields -- high citation velocity (citations per year since publication), top venue (CoRL, RSS, ICRA, IROS, NeurIPS, ICLR, ICML, CVPR, Science Robotics, T-RO), and representativeness (the paper a subfield's dominant approach is built on), at least {frontier} of them frontier work (frontier=true). Look citation counts and venues up with argv shaped like {lookup_args} (it reports Semantic Scholar citationCount, influentialCitationCount and venue). Skip already_carded papers. Fetch by candidates[].arxiv_id; when it is null, look the DOI up (--doi) and use the arXiv id it reports, and a paper with no arXiv version cannot be fetched: choose another. Write your choice and the reason for each to {cards_dir}/selection.json. Candidates with post_horizon=true reached the landscape through the frontier harvest: choose among them and the landscape's own papers on the same criteria, and mark them post_horizon in selection.json. {recall_clause}\n\
B. READ THE PAPER, NOT THE ABSTRACT. Fetch full texts with argv shaped like {fulltext_args}. Each result gives text_path (the text, with '## <number> <title>' section headings), its sections and table/figure labels, and fulltext_source {{url, sha256}} -- copy fulltext_source into the card verbatim; the harness recomputes the hash of the cached text. Read the method, experiments, ablations, limitations and appendix sections, and the tables themselves.\n\
C. RESOLVE ASSETS with argv shaped like {asset_args}: official code repository (license, stars, pushed_at, head_sha), checkpoints and datasets (url, size_gb, license), benchmark environments, min_vram_gb_eval / min_vram_gb_train with their basis, the reproduction entry point, and local_copy_path (an exact clone on this host, from the local asset inventory at {inventory}). CHECK what it returns against the paper: correct a wrong repository, drop a checkpoint that is not this paper's, and keep assets.searches_tried from its output -- a kind (code, checkpoints, datasets) left empty is accepted only as 'none found' with the searches tried. Metadata only: do not clone, download or run anything.\n\
D. BE ADVERSARIAL ABOUT WHAT CAUSES THE GAIN. For each headline number ask which component actually produces it: is there an ablation that removes exactly that component, at matched data, compute and tuning budget? Are baselines re-implemented and tuned as carefully? Is the evaluation on the paper's own tasks, seeds, success criterion or robot? A gain that no ablation isolates is an ablation_missing, with why it matters. unstated_assumptions are what the method silently needs (demonstration quality, a fixed camera, a simulator's contact model, the success metric, reset conditions) -- point at the passage where the assumption is made. load_bearing_beliefs are what the paper takes for granted that the FIELD also believes (e.g. that more diverse data beats more data, that action chunking is needed for smooth control) -- each is a candidate for the question nobody has asked. falsifier: the one observation that would show the central claim wrong.\n\
E. WRITE ONE CARD PER PAPER to {cards_dir}/<arXiv id>.json, exactly this shape: {{\"paper_id\": \"landscape paper_id\", \"title\": \"...\", \"year\": 0, \"venue\": \"...|null\", \"fulltext_source\": {{\"url\": \"...\", \"sha256\": \"...\"}}, \"core_claims\": [{{\"claim\": \"...\", \"evidence_ref\": \"...\", \"numbers\": [\"0.91 success on Push-T\"]}}], \"method_core\": \"what the method is, in two sentences\", \"setup\": {{\"benchmarks\": [\"...\"], \"data_scale\": \"...|null\", \"compute\": \"...|null\"}}, \"ablations_present\": [{{\"what\": \"...\", \"evidence_ref\": \"...\"}}], \"ablations_missing\": [{{\"what\": \"...\", \"why_it_matters\": \"...\"}}], \"stated_limitations\": [{{\"text\": \"...\", \"evidence_ref\": \"...\"}}], \"unstated_assumptions\": [{{\"text\": \"...\", \"evidence_ref\": \"...\"}}], \"load_bearing_beliefs\": [{{\"belief\": \"...\", \"evidence_ref\": \"...\"}}], \"falsifier\": \"...\", \"assets\": {{\"code\": [{{\"url\": \"...\", \"license\": \"...\", \"stars\": 0, \"pushed_at\": \"...\", \"head_sha\": \"...\"}}], \"checkpoints\": [{{\"url\": \"...\", \"size_gb\": 0, \"license\": \"...\"}}], \"datasets\": [{{\"url\": \"...\", \"size_gb\": 0, \"license\": \"...\"}}], \"envs\": [\"...\"], \"min_vram_gb_eval\": 0, \"min_vram_gb_train\": 0, \"reproduction_entry\": {{\"repo\": \"...\", \"readme_section\": \"...\", \"commands\": [\"...\"]}}, \"local_copy_path\": null, \"searches_tried\": [{{\"kind\": \"code|checkpoints|datasets\", \"source\": \"...\", \"request\": \"...\", \"status\": \"...\"}}]}}}}. Unknown values are null, never invented. Write each card as soon as it is done, so a timeout keeps the finished ones.\n\
F. EVIDENCE REFERENCES. evidence_ref is ONE string naming where in the cached text the item rests: section numbers (§4.2), labels (Table 3, Figure 5) and at least one exact quote in double quotes, e.g. `§4.2; Table 3; \"we observe a 46.9% average improvement\"`. A quote must be copied from text_path word for word ({quote_chars}+ characters of words; punctuation and line breaks are ignored when matching, words are not) and every section or label named must exist in that paper. Items that state something about the paper -- core_claims, ablations_present, stated_limitations, unstated_assumptions, load_bearing_beliefs -- all carry one.\n\
G. The harness validates every card deterministically and publishes the valid ones, merged across attempts, to the cycle state: paper_id a verified landscape paper; the cached full text re-hashing to fulltext_source.sha256; at least {claims} core claims, {beliefs} load-bearing belief(s) and {missing} missing ablation(s); every evidence_ref found in the text; assets resolved or 'none found' with searches tried. A card that fails is rejected with its reasons, which the next attempt receives in sota_deep_read_contract.previous_attempt. The set is valid at {min_valid} valid cards spanning {subfields} subfields with {frontier} frontier works. The role plan for this lane is at {role_plan}.\n",
        target = thresholds.target_cards,
        subfields = thresholds.min_subfields,
        frontier = thresholds.min_frontier_cards,
        lookup_args = lookup_args,
        cards_dir = cards_dir.display(),
        fulltext_args = fulltext_args,
        asset_args = asset_args,
        inventory = "the path in sota_deep_read_contract.local_asset_inventory_path",
        quote_chars = thresholds.min_quote_chars,
        claims = thresholds.min_core_claims,
        beliefs = thresholds.min_load_bearing_beliefs,
        missing = thresholds.min_ablations_missing,
        min_valid = thresholds.min_valid_cards,
        role_plan = role_plan_path.display(),
        recall_clause = frontier_recall_clause(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            project_root: root.join("project"),
            runtime_root: root.join(".research-lab"),
            data_root: root.join("data"),
            stats_driver_script: root.join("stats.py"),
            literature_driver_script: root.join("literature.py"),
        }
    }

    const PAPER_TEXT: &str = "# Diffusion Policy\n\n## Abstract\n\nWe represent a visuomotor policy as a conditional denoising diffusion process.\n\n## 4 Evaluation\n\nDiffusion Policy outperforms existing methods with an average improvement of 46.9%.\n\n## 4.2 Ablations\n\nTable 3: Ablation of the action horizon. Removing receding horizon control reduces success to 0.42.\n\n## 5 Limitations\n\nOur method inherits the limitations of behavior cloning, such as suboptimal performance with inadequate demonstration data.\n";

    /// A cached full text in the layout `search.py --fulltext` writes.
    fn cache_paper(root: &Path, arxiv_id: &str) -> String {
        let dir = root.join(arxiv_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("fulltext.txt"), PAPER_TEXT).unwrap();
        let sha = sha256_hex(PAPER_TEXT.as_bytes());
        write_json(
            &dir.join("sections.json"),
            &json!({"sections": [{"number": "4", "title": "Evaluation"}, {"number": "4.2", "title": "Ablations"}, {"number": "5", "title": "Limitations"}],
                    "labels": [{"label": "Table 3"}], "links": []}),
        )
        .unwrap();
        write_json(
            &dir.join("manifest.json"),
            &json!({"arxiv_id": arxiv_id, "source_url": format!("https://arxiv.org/html/{arxiv_id}"), "sha256": sha,
                    "text_file": "fulltext.txt", "index_file": "sections.json"}),
        )
        .unwrap();
        sha
    }

    fn card(paper_id: &str, sha: &str) -> Value {
        json!({
            "paper_id": paper_id, "title": "Diffusion Policy", "year": 2023, "venue": "RSS",
            "fulltext_source": {"url": "https://arxiv.org/html/2303.04137", "sha256": sha},
            "core_claims": [
                {"claim": "46.9% average improvement", "numbers": ["46.9%"], "evidence_ref": "§4; \"outperforms existing methods with an average improvement of 46.9%\""},
                {"claim": "receding horizon matters", "numbers": ["0.42"], "evidence_ref": "§4.2; Table 3; \"Removing receding horizon control reduces success to 0.42\""},
                {"claim": "policy is a denoising diffusion process", "numbers": [], "evidence_ref": "\"visuomotor policy as a conditional denoising diffusion process\""},
            ],
            "method_core": "A diffusion model over action sequences.",
            "setup": {"benchmarks": ["Push-T"], "data_scale": null, "compute": null},
            "ablations_present": [{"what": "action horizon", "evidence_ref": "Table 3; \"Ablation of the action horizon\""}],
            "ablations_missing": [{"what": "matched-compute baseline", "why_it_matters": "the gain may be compute"}],
            "stated_limitations": [{"text": "behavior cloning limits", "evidence_ref": "§5; \"inherits the limitations of behavior cloning\""}],
            "unstated_assumptions": [],
            "load_bearing_beliefs": [{"belief": "demonstrations are adequate", "evidence_ref": "§5; \"suboptimal performance with inadequate demonstration data\""}],
            "falsifier": "A tuned unimodal policy matching it on Push-T.",
            "assets": {
                "code": [{"url": "https://github.com/real-stanford/diffusion_policy", "license": "MIT", "stars": 4568, "pushed_at": "2024-12-24T19:48:03Z", "head_sha": "5ba07ac"}],
                "checkpoints": [], "datasets": [], "envs": ["Push-T"],
                "min_vram_gb_eval": 1.6, "min_vram_gb_train": 10, "reproduction_entry": null, "local_copy_path": null,
                "searches_tried": [{"kind": "checkpoints", "source": "huggingface.co", "status": 200}, {"kind": "datasets", "source": "huggingface.co", "status": 200}],
            },
        })
    }

    fn landscape_papers(ids: &[&str]) -> serde_json::Map<String, Value> {
        ids.iter().map(|id| (id.to_ascii_lowercase(), json!({"paper_id": id, "year": 2025}))).collect()
    }

    #[test]
    fn a_landscape_paper_id_yields_its_arxiv_id_when_it_carries_one() {
        assert_eq!(arxiv_id_of("doi:10.48550/arxiv.2406.09246"), json!("2406.09246"));
        assert_eq!(arxiv_id_of("arxiv:2303.04137v2"), json!("2303.04137"));
        assert_eq!(arxiv_id_of("doi:10.1109/icra.2018.8460528"), Value::Null);
        assert_eq!(arxiv_id_of("arxiv:sf0-f0"), Value::Null);
    }

    #[test]
    fn sha256_matches_the_standard_vectors() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let long = vec![b'a'; 1000];
        assert_eq!(sha256_hex(&long), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    }

    #[test]
    fn an_evidence_ref_names_quotes_sections_and_labels() {
        let parsed = parse_evidence_ref("§4.2; Table 3, Fig. 5 and Appendix B; \"a quote naming Table 9\"");
        assert_eq!(parsed.quotes, vec!["a quote naming Table 9".to_string()]);
        assert_eq!(parsed.sections, vec!["4.2".to_string(), "b".to_string()]);
        assert_eq!(parsed.labels, vec!["table 3".to_string(), "figure 5".to_string()]);
        let curly = parse_evidence_ref("Section 3 \u{201c}curly quoted text\u{201d}");
        assert_eq!(curly.quotes, vec!["curly quoted text".to_string()]);
        assert_eq!(curly.sections, vec!["3".to_string()]);
    }

    #[test]
    fn a_card_read_from_the_cached_text_is_valid() {
        let temp = TempDir::new().unwrap();
        let sha = cache_paper(temp.path(), "2303.04137");
        let result = validate_sota_card(
            &card("arxiv:2303.04137", &sha),
            &landscape_papers(&["arXiv:2303.04137"]),
            temp.path(),
            &SotaCardThresholds::default(),
        );
        assert!(result.valid, "{:?}", result.reasons);
    }

    #[test]
    fn a_quote_that_is_not_in_the_paper_rejects_the_card() {
        let temp = TempDir::new().unwrap();
        let sha = cache_paper(temp.path(), "2303.04137");
        let mut bad = card("arxiv:2303.04137", &sha);
        bad["core_claims"][0]["evidence_ref"] = json!("§4; \"outperforms existing methods with an average improvement of 64.9%\"");
        bad["load_bearing_beliefs"][0]["evidence_ref"] = json!("§9; \"suboptimal performance with inadequate demonstration data\"");
        bad["ablations_present"][0]["evidence_ref"] = json!({"section": "4.2"});
        bad["stated_limitations"][0]["evidence_ref"] = json!("§5 only");
        let result = validate_sota_card(&bad, &landscape_papers(&["arxiv:2303.04137"]), temp.path(), &SotaCardThresholds::default());
        assert!(!result.valid);
        let joined = result.reasons.join(" | ");
        assert!(joined.contains("core_claims[0]: quote \"outperforms existing methods with an average improvement of 64.9%\" is not in the cached full text"), "{joined}");
        assert!(joined.contains("load_bearing_beliefs[0]: section §9 is not a section"), "{joined}");
        assert!(joined.contains("ablations_present[0]: evidence_ref must be one string"), "{joined}");
        assert!(joined.contains("stated_limitations[0]: evidence_ref '§5 only' carries no quote"), "{joined}");
        assert!(joined.contains("2 core claim(s) with a checked evidence_ref, at least 3 required"), "{joined}");
        assert!(joined.contains("0 load-bearing belief(s)"), "{joined}");
    }

    #[test]
    fn a_card_must_be_read_from_an_unaltered_cached_text_of_a_landscape_paper() {
        let temp = TempDir::new().unwrap();
        let sha = cache_paper(temp.path(), "2303.04137");
        // Not in the landscape.
        let result = validate_sota_card(&card("arxiv:2303.04137", &sha), &landscape_papers(&["arxiv:9999.00001"]), temp.path(), &SotaCardThresholds::default());
        assert!(result.reasons.iter().any(|reason| reason.contains("is not a verified paper of the field landscape")), "{:?}", result.reasons);
        // The cached text was edited after it was hashed.
        fs::write(temp.path().join("2303.04137").join("fulltext.txt"), format!("{PAPER_TEXT}\nan inserted sentence")).unwrap();
        let result = validate_sota_card(&card("arxiv:2303.04137", &sha), &landscape_papers(&["arxiv:2303.04137"]), temp.path(), &SotaCardThresholds::default());
        assert!(result.reasons.iter().any(|reason| reason.contains("is not a cached full text whose content still hashes to it")), "{:?}", result.reasons);
        // No full text at all: an abstract-only card.
        let mut abstract_only = card("arxiv:2303.04137", &sha);
        abstract_only.as_object_mut().unwrap().remove("fulltext_source");
        let result = validate_sota_card(&abstract_only, &landscape_papers(&["arxiv:2303.04137"]), temp.path(), &SotaCardThresholds::default());
        assert!(result.reasons.iter().any(|reason| reason.contains("not the abstract")), "{:?}", result.reasons);
    }

    #[test]
    fn empty_assets_need_the_searches_that_found_nothing() {
        let temp = TempDir::new().unwrap();
        let sha = cache_paper(temp.path(), "2303.04137");
        let mut unsearched = card("arxiv:2303.04137", &sha);
        unsearched["assets"]["code"] = json!([]);
        unsearched["assets"]["searches_tried"] = json!([{"kind": "checkpoints"}]);
        unsearched["assets"].as_object_mut().unwrap().remove("min_vram_gb_train");
        unsearched["ablations_missing"] = json!([]);
        let result = validate_sota_card(&unsearched, &landscape_papers(&["arxiv:2303.04137"]), temp.path(), &SotaCardThresholds::default());
        let joined = result.reasons.join(" | ");
        assert!(joined.contains("assets.code is empty and assets.searches_tried records no code search"), "{joined}");
        assert!(joined.contains("assets.datasets is empty and assets.searches_tried records no datasets search"), "{joined}");
        assert!(joined.contains("assets.min_vram_gb_train is missing"), "{joined}");
        assert!(joined.contains("0 missing ablation(s)"), "{joined}");
    }

    fn deep_read_contract(paths: &AppPaths, cycle: &str, lane_id: &str) -> LaneContract {
        let lane_dir = lane_root(paths, cycle, lane_id);
        fs::create_dir_all(&lane_dir).unwrap();
        LaneContract {
            cycle_id: cycle.to_string(),
            lane_id: lane_id.to_string(),
            role: "scout".to_string(),
            runtime_class: "codex-agent".to_string(),
            mode: "read-write-scoped".to_string(),
            cwd: paths.project_root.clone(),
            task_file: lane_dir.join("task.md"),
            allowed_inputs: vec![],
            allowed_outputs: vec![lane_dir.clone()],
            output_artifact: Some(lane_dir.join("result.json")),
            fallback_strategy: None,
        }
    }

    #[test]
    fn cards_are_published_merged_across_attempts_and_the_set_needs_breadth() {
        // The publish path resolves the cache through RESEARCHLAB_FULLTEXT_ROOT;
        // with it set (the real-cache smoke below), this fixture would be
        // written into that real cache. Run the two separately.
        if env::var_os("RESEARCHLAB_FULLTEXT_ROOT").is_some() {
            eprintln!("skipped: RESEARCHLAB_FULLTEXT_ROOT is set");
            return;
        }
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "deep-read-publish";
        let landscape = valid_field_landscape_fixture(cycle);
        write_json(&field_landscape_state_path(&paths, cycle), &landscape).unwrap();
        assert_eq!(field_landscape_status(&paths, cycle).state, "valid");
        let fulltext_root = fulltext_cache_root(&paths);
        let sha = cache_paper(&fulltext_root, "2303.04137");
        let role_plan = json!({"action_type": SOTA_DEEP_READ_ACTION});

        // Attempt one: two good cards in two subfields, one broken card.
        let first = deep_read_contract(&paths, cycle, "followup-scout-01");
        let cards_dir = lane_root(&paths, cycle, "followup-scout-01").join(SOTA_CARDS_DIR);
        fs::create_dir_all(&cards_dir).unwrap();
        write_json(&cards_dir.join("a.json"), &card("arxiv:sf0-f0", &sha)).unwrap();
        write_json(&cards_dir.join("b.json"), &card("arxiv:sf1-f0", &sha)).unwrap();
        let mut broken = card("arxiv:sf2-f0", &sha);
        broken["core_claims"] = json!([]);
        write_json(&cards_dir.join("c.json"), &broken).unwrap();
        let path = project_sota_cards(&paths, &first, Some(&role_plan)).unwrap().unwrap();
        let published = read_json(&path).unwrap();
        assert_eq!(published["cards"].as_array().unwrap().len(), 2);
        assert_eq!(published["validation"]["valid"], json!(false));
        assert_eq!(published["rejected_cards"][0]["paper_id"], json!("arxiv:sf2-f0"));
        assert!(published["validation"]["reasons"][0].as_str().unwrap().starts_with("2 valid card(s), at least 8 required"));
        assert_eq!(sota_cards_status(&paths, cycle).state, "invalid");

        // Attempt two fills the gaps; the first attempt's cards still count.
        let second = deep_read_contract(&paths, cycle, "followup-scout-02");
        let cards_dir = lane_root(&paths, cycle, "followup-scout-02").join(SOTA_CARDS_DIR);
        fs::create_dir_all(&cards_dir).unwrap();
        for id in ["arxiv:sf2-f0", "arxiv:sf2-f1", "arxiv:sf0-f1", "arxiv:sf1-f1", "arxiv:sf0-f2", "arxiv:sf1-f2"] {
            write_json(&cards_dir.join(format!("{}.json", id.replace(':', "_"))), &card(id, &sha)).unwrap();
        }
        project_sota_cards(&paths, &second, Some(&role_plan)).unwrap();
        let status = sota_cards_status(&paths, cycle);
        assert_eq!(status.state, "valid", "{}", status.published["validation"]);
        assert_eq!(status.published["cards"].as_array().unwrap().len(), 8);
        assert_eq!(status.published["validation"]["subfields_covered"], json!(["sf0", "sf1", "sf2"]));
        assert_eq!(status.published["generated_by"], json!(["followup-scout-01", "followup-scout-02"]));
        let attempts = read_json(&state_root(&paths).join(format!("{cycle}-sota-cards-attempts.json"))).unwrap();
        assert_eq!(attempts["attempts"].as_array().unwrap().len(), 2);

        // Another scout is not a deep-read scout.
        assert!(project_sota_cards(&paths, &second, Some(&json!({"action_type": "field_landscape_scout"}))).unwrap().is_none());
    }

    #[test]
    fn cards_of_one_subfield_do_not_make_a_valid_set() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("ft");
        let sha = cache_paper(&root, "2303.04137");
        let landscape = valid_field_landscape_fixture("c");
        let cards: Vec<Value> = (0..5).map(|index| card(&format!("arxiv:sf0-f{index}"), &sha)).collect();
        let thresholds = SotaCardThresholds { min_valid_cards: 5, ..SotaCardThresholds::default() };
        let validation = validate_sota_cards(&cards, &[], &landscape, &root, &thresholds);
        assert_eq!(validation.valid_cards.len(), 5);
        assert!(!validation.valid);
        assert!(validation.reasons.iter().any(|reason| reason.starts_with("valid cards span 1 landscape subfield(s), at least 3 required")), "{:?}", validation.reasons);
    }

    #[test]
    fn the_deep_read_scout_waits_for_a_valid_landscape_and_is_routed_as_reasoning() {
        let temp = TempDir::new().unwrap();
        let paths = test_paths(temp.path());
        let cycle = "deep-read-dispatch";
        fs::create_dir_all(state_root(&paths)).unwrap();
        fs::create_dir_all(cycle_lanes_root(&paths, cycle)).unwrap();
        fs::create_dir_all(plans_root(&paths)).unwrap();
        write_json(
            &plans_root(&paths).join(format!("{cycle}-cycle-plan.json")),
            &json!({"objective": "Pick ONE falsifiable question across manipulation, legged locomotion and sim-to-real."}),
        )
        .unwrap();
        // No landscape yet: nothing to choose papers from.
        assert!(dispatch_sota_deep_read_scout(&paths, cycle).unwrap().is_empty());
        write_json(&field_landscape_state_path(&paths, cycle), &valid_field_landscape_fixture(cycle)).unwrap();
        // The frontier harvest has not run: the deep read waits for its
        // post-horizon papers (labdirector::frontier_harvest).
        if frontier_harvest_status(&paths, cycle).state != "disabled" {
            assert!(dispatch_sota_deep_read_scout(&paths, cycle).unwrap().is_empty());
        }
        // A harvest whose one top-K candidate is still unreviewed holds it too.
        let harvest_path = state_root(&paths).join(format!("{cycle}-frontier-harvest.json"));
        write_json(&harvest_path, &json!({"since": "2025-11-01", "top_k": [
            {"paper_id": "arxiv_id:2602.16863", "aliases": ["arxiv:2602.16863"], "review_status": "pending"}]})).unwrap();
        if frontier_harvest_status(&paths, cycle).state != "disabled" {
            assert!(dispatch_sota_deep_read_scout(&paths, cycle).unwrap().is_empty());
        }
        write_json(&harvest_path, &json!({"since": "2025-11-01", "top_k": [
            {"paper_id": "arxiv_id:2602.16863", "aliases": ["arxiv:2602.16863"], "review_status": "excluded",
             "review_reason": "abstract_review_irrelevant"}]})).unwrap();

        let created = dispatch_sota_deep_read_scout(&paths, cycle).unwrap();
        assert_eq!(created.len(), 1);
        let lane_id = created[0]["lane_id"].as_str().unwrap().to_string();
        let role_plan = read_json(&lane_role_plan_path(&paths, cycle, &lane_id)).unwrap();
        assert_eq!(role_plan["action_type"], json!(SOTA_DEEP_READ_ACTION));
        assert_eq!(role_plan["model_route"]["model"], json!(crate::labdirector::policy::CODEX_DEFAULT_AGENT_MODEL));
        assert_eq!(role_plan["model_route"]["reasoning_effort"], json!("high"));
        // No abstract-screening contract rides along: this lane reads, it does not search.
        assert!(role_plan.get("search_agent_contract").is_none(), "{}", role_plan["search_agent_contract"]);
        let contract = &role_plan["planner_metadata"]["sota_deep_read_contract"];
        assert_eq!(contract["thresholds"]["target_cards"], json!(10));
        let candidates = contract["candidates"].as_array().unwrap();
        assert_eq!(candidates.len(), 24);
        assert_eq!(candidates[0]["frontier"], json!(true));
        // One at a time.
        assert!(dispatch_sota_deep_read_scout(&paths, cycle).unwrap().is_empty());
    }

    /// A post-horizon paper the frontier harvest found and review admitted is a
    /// deep-read candidate, listed first and flagged, and a card on it is valid.
    #[test]
    fn harvested_post_horizon_papers_are_deep_read_candidates() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("ft");
        let sha = cache_paper(&root, "2602.16863");
        let admitted = vec![json!({
            "paper_id": "doi:10.48550/arxiv.2602.16863", "title": "SimToolReal", "year": 2026,
            "post_horizon": true, "subfield_ids": ["sf1"],
        })];
        let landscape = landscape_with_frontier(&valid_field_landscape_fixture("c"), &admitted);
        let candidates = deep_read_candidates(&landscape);
        assert_eq!(candidates.len(), 25);
        assert_eq!(candidates[0]["paper_id"], json!("doi:10.48550/arxiv.2602.16863"));
        assert_eq!(candidates[0]["post_horizon"], json!(true));
        assert_eq!(candidates[0]["arxiv_id"], json!("2602.16863"));
        assert_eq!(candidates[0]["subfield_ids"], json!(["sf1"]));
        assert!(candidates[0]["landscape_roles"].as_array().unwrap().contains(&json!("frontier_harvest")));
        assert_eq!(candidates[1]["post_horizon"], json!(false));
        let verified = landscape["verified_papers"].as_object().cloned().unwrap();
        let mut harvested = card("doi:10.48550/arxiv.2602.16863", &sha);
        harvested["fulltext_source"]["url"] = json!("https://arxiv.org/html/2602.16863");
        let result = validate_sota_card(&harvested, &verified, &root, &SotaCardThresholds::default());
        assert!(result.valid, "{:?}", result.reasons);
    }

    /// A real card against the real cache:
    /// `RESEARCHLAB_SOTA_CARD_SMOKE=<card.json> RESEARCHLAB_FULLTEXT_ROOT=<cache> cargo test -- --ignored card_smoke`.
    /// Also checks that a one-digit change to a quoted number is caught.
    #[test]
    #[ignore]
    fn card_smoke_against_the_real_fulltext_cache() {
        let path = PathBuf::from(env::var("RESEARCHLAB_SOTA_CARD_SMOKE").expect("RESEARCHLAB_SOTA_CARD_SMOKE"));
        let root = PathBuf::from(env::var("RESEARCHLAB_FULLTEXT_ROOT").expect("RESEARCHLAB_FULLTEXT_ROOT"));
        let card = read_json(&path).unwrap();
        let id = card["paper_id"].as_str().unwrap().to_string();
        let papers = landscape_papers(&[id.as_str()]);
        let thresholds = SotaCardThresholds::default();
        let result = validate_sota_card(&card, &papers, &root, &thresholds);
        println!("{}: valid={} reasons={:?} warnings={:?}", id, result.valid, result.reasons, result.warnings);
        assert!(result.valid);
        let mut altered = card.clone();
        let reference = altered["core_claims"][0]["evidence_ref"].as_str().unwrap().replace("46.9", "49.6");
        altered["core_claims"][0]["evidence_ref"] = json!(reference);
        let result = validate_sota_card(&altered, &papers, &root, &thresholds);
        println!("altered: valid={} reasons={:?}", result.valid, result.reasons);
        assert!(!result.valid);
    }

    #[test]
    fn the_protocol_names_the_tools_and_the_evidence_rule() {
        let protocol = sota_deep_read_scout_protocol(Path::new("/lane"), Path::new("/lane/role-plan.json"));
        for needle in ["--fulltext", "--resolve-assets", "READ THE PAPER, NOT THE ABSTRACT", "load_bearing_beliefs", "evidence_ref is ONE string", "searches_tried"] {
            assert!(protocol.contains(needle), "{needle}");
        }
    }
}
