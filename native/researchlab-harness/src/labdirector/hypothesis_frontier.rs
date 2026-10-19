use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub(crate) fn normalized_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
}

fn token_set(value: &str) -> HashSet<String> {
    normalized_text(value)
        .split_whitespace()
        .filter(|item| item.len() >= 4)
        .map(ToString::to_string)
        .collect::<HashSet<_>>()
}

fn overlap_count(left: &HashSet<String>, right: &HashSet<String>) -> usize {
    left.iter().filter(|item| right.contains(*item)).count()
}

pub(crate) fn statement_penalty(statement: &str, objections: &[String]) -> i64 {
    // Domain-agnostic scoring: penalize hypotheses that share substantial token
    // overlap with reviewer objections. Previously this function also applied a
    // fixed DTP3-specific penalty and several WHO-immunization keyword bonuses;
    // those are removed so the scoring works for any research domain.
    let tokens = token_set(statement);
    let mut penalty = 0i64;
    for objection in objections {
        let objection_tokens = token_set(objection);
        let overlap = overlap_count(&tokens, &objection_tokens) as i64;
        if overlap >= 3 {
            penalty += 10 + (overlap.min(6) * 3);
        }
    }
    penalty
}

pub(crate) fn alternative_bonus(statement: &str, alternatives: &[String]) -> i64 {
    // Domain-agnostic bonus: reward hypotheses that share substantial token
    // overlap with reviewer-proposed alternatives. Previously this function
    // boosted specific WHO-immunization phrases (`zero dose`, `equity`,
    // `fixed effects`, `within country`); those are removed so credit is
    // awarded purely on overlap with whatever alternatives the reviewer
    // actually proposed.
    let tokens = token_set(statement);
    let mut bonus = 0i64;
    for alternative in alternatives {
        let alt_tokens = token_set(alternative);
        let overlap = overlap_count(&tokens, &alt_tokens) as i64;
        if overlap >= 3 {
            bonus = bonus.max(12 + (overlap.min(6) * 3));
        }
    }
    bonus
}

pub(crate) fn root_variable_convergence_penalty(
    _statement: &str,
    _objections: &[String],
    _alternatives: &[String],
) -> i64 {
    // Removed: this previously fired only on DTP3-specific phrasing and punished
    // hypotheses whose alternatives were still framed around DTP3. A principled
    // replacement would detect "all candidates share the same primary variable"
    // in a domain-agnostic way, but that belongs to the planner's hypothesis
    // ledger (family diversity tracking), not a keyword heuristic here.
    0
}

pub(crate) fn infer_family_root(_statement: &str) -> String {
    // Family roots are authoritative when declared by the analyst in
    // candidate_primary_families[*].family_root. Callers that cannot find an
    // explicit family root fall back here — rather than re-deriving one from
    // WHO-specific keyword heuristics (which forced every cycle through an
    // immunization/zero-dose/maternal-care taxonomy), we return a sentinel so
    // the planner can flag the missing classification and regenerate it from
    // the objective and evidence bundle.
    "unclassified_family".to_string()
}

pub(crate) fn family_penalty_for_root(root: &str, objections: &[String]) -> i64 {
    // Domain-agnostic: penalize whenever the family root's tokens overlap
    // with a reviewer objection. The previous DTP3/mean-coverage branch hard-
    // coded the WHO immunization family — removed so this works for any
    // research domain.
    let root_tokens = token_set(root);
    let mut penalty = 0i64;
    for objection in objections {
        let objection_tokens = token_set(objection);
        let overlap = overlap_count(&root_tokens, &objection_tokens) as i64;
        if overlap >= 1 {
            penalty += 6 + overlap.min(3) * 4;
        }
    }
    penalty
}

pub(crate) fn build_frontier_catalog(hypotheses: &[Value]) -> Value {
    let mut support_counts: HashMap<String, i64> = HashMap::new();
    for item in hypotheses {
        let statement = item.get("statement").and_then(Value::as_str).unwrap_or("");
        if statement.is_empty() {
            continue;
        }
        let root = item
            .get("family_root")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| infer_family_root(statement));
        *support_counts.entry(root).or_insert(0) += 1;
    }
    let mut families = support_counts
        .into_iter()
        .map(|(family, support_count)| {
            json!({
                "family": family,
                "support_count": support_count,
                "rival_status": "candidate_primary",
            })
        })
        .collect::<Vec<_>>();
    families.sort_by(|a, b| {
        b.get("support_count")
            .and_then(Value::as_i64)
            .cmp(&a.get("support_count").and_then(Value::as_i64))
    });
    Value::Array(families)
}

pub(crate) fn is_nonfallback_hypothesis_candidate(item: &Value) -> bool {
    let statement = item
        .get("statement")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if statement.is_empty() {
        return false;
    }
    let lower_statement = statement.to_lowercase();
    if lower_statement.contains("unclassified_family")
        || lower_statement.contains("select family `unclassified")
        || lower_statement.contains("generic unclassified")
    {
        return false;
    }
    let family_root = item
        .get("family_root")
        .or_else(|| item.get("family"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if family_root.is_empty() || family_root == "unclassified_family" {
        return false;
    }
    true
}

pub(crate) fn forbidden_dataset_terms_from_text(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let lower = text.to_lowercase();
    for pattern in ["gse", "srp", "prjna", "ega"] {
        let mut start = 0usize;
        while let Some(pos) = lower[start..].find(pattern) {
            let absolute = start + pos;
            let suffix = &lower[absolute + pattern.len()..];
            let digits = suffix
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .collect::<String>();
            if digits.len() >= 3 {
                let term = format!("{pattern}{digits}");
                if !terms.contains(&term) {
                    terms.push(term);
                }
            }
            start = absolute + pattern.len();
        }
    }
    terms
}

pub(crate) fn value_contains_forbidden_dataset_term(value: &Value, terms: &[String]) -> bool {
    if terms.is_empty() {
        return false;
    }
    serde_json::to_string(value)
        .map(|blob| {
            let lower = blob.to_lowercase();
            terms.iter().any(|term| lower.contains(term))
        })
        .unwrap_or(false)
}

/// What a dataset record has to CONTAIN, without saying what field it comes from.
///
/// This used to name three biomedical repositories, three omics modalities and
/// three human-cohort context terms, and it reached every follow-up data scout
/// in every cycle. The JS base plan had already been fixed to derive its seeds
/// from the objective's domain -- and said so in a comment naming this exact
/// contract as what it was removing -- but a running cycle's scouts are all
/// FOLLOW-UPS, which come through here, so the removed contract was still the
/// one being delivered.
///
/// Measured on cycle-g-v89, a computer-graphics rendering cycle: seven scout
/// role plans carried this contract, four of them returned 101, 119, 137 and 155
/// gene-expression accessions, and all four dataset bundles the cycle
/// materialised -- 566 MB -- were GEO series.
///
/// So it names no repository, no modality and no context vocabulary. The shape
/// requirements below are what makes a dataset record usable in ANY field: an
/// identifier someone else can resolve, an artifact that actually downloads, a
/// schema, and provenance. Which repositories are this field's repositories is
/// for the lane to determine from the objective and to justify -- that is the
/// discovery, and answering it here is what pointed a renderer at GEO.
pub(crate) fn dataset_discovery_contract(objective: &str) -> Value {
    json!({
        // A CAP, not a quota. The previous field asked for three and the lane
        // read it as a floor: one cycle-g-v89 scout returned 70 candidates and
        // fetched four bundles, none of which named what it was for. Returning
        // fewer than this is a normal outcome; returning none is a normal
        // outcome. Returning more is padding.
        "maximum_admitted_candidates": 3,
        "admission_rule": "A candidate is ADMITTED only if you can say, in one sentence, which part of the design it supplies -- which variable, which comparison arm, which baseline, which quantity the hypothesis needs measured. Write that sentence in `needed_for` on the candidate. A dataset that is merely on-topic is not needed, and a dataset you cannot tie to a stated need does not enter the result, however good it looks. This is the whole difference between the data this cycle requires and everything the registries happen to hold.",
        "trust_rule": "A candidate is TRUSTWORTHY only with provenance another person could follow back: a resolvable identifier, the source that returned it, the URL it was retrieved from, and the date it was retrieved. Record all four in `provenance`. Familiarity is not provenance, and a registry hit with no retrieval date is not either -- it cannot be re-checked, so it cannot be relied on.",
        "must_have": [
            "needed_for: the part of the design this dataset supplies, in one sentence",
            "provenance: identifier, source, retrieval URL, retrieval date",
            "a directly downloadable artifact, not a landing page",
            "the schema or structure of what the artifact contains, and its access status",
            "the modality or format, in the vocabulary the field itself uses"
        ],
        // The outcome that has to be as easy to return as a list of hits.
        "absence_is_an_answer": {
            "rule": "If nothing clears the admission and trust rules, RETURN THAT. `status: no_admissible_dataset` with `searched` (the repositories and the queries you actually ran) and `why_none_qualified` (per near-miss, which rule it failed) is a COMPLETE result -- the cycle can act on it, by narrowing the design to what its own instruments can generate, or by asking for the data it lacks. It is not a failure and it is not something to search around.",
            "forbidden_alternatives": [
                "returning an off-field or off-design dataset because the search would otherwise be empty",
                "returning a landing page, a registry index, or a search-results URL as though it were data",
                "widening the query until something matches and admitting that instead",
                "reporting candidates you could not tie to a stated need, leaving the choice to a later lane"
            ],
            "status_values": ["admitted", "no_admissible_dataset", "query_synthesis_failure"]
        },
        // Nothing is fetched that was not admitted first. On cycle-g-v89 four
        // bundles were downloaded -- 566 MB -- and no record anywhere says what
        // any of them was for.
        "materialization_rule": "Fetch ONLY candidates you admitted, and only after `needed_for` and `provenance` are written. Record the bytes fetched against the candidate that justified them. An unadmitted download is unexplained data in the cycle, and a later lane will analyse it precisely because it is there.",
        "repository_selection": "Determine which repositories, registries, benchmark suites or standard collections THIS objective's field actually uses, and name them in the result together with why they are this field's sources. Do not carry over another field's repositories.",
        "off_field_policy": "A candidate from outside the objective's field is not a fallback. Report zero on-field candidates rather than returning off-field ones, and say which sources were searched.",
        "forbidden_accessions": forbidden_dataset_terms_from_text(objective),
        "query_strategy": "repository-native discovery in the field's own vocabulary; never use the full LabDirector prose as the only query",
        "zero_candidate_policy": "if repository-native queries return zero candidates, report query synthesis failure instead of repeating the same broad directive"
    })
}
