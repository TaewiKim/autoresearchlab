// A contract can demand a field the schema forbids, and nobody finds out.
//
// `hypothesis_contract` in policy.rs listed twelve fields the hypothesis JSON
// "must carry". The `selected_hypothesis` object in codex_schema.rs closes
// `additionalProperties`, and nine of the twelve were not in it -- so a director
// that tried to obey would have had its ENTIRE result rejected for emitting an
// unexpected key. It obeyed what the schema allowed, and nine requirements
// disappeared without a word.
//
// The three that mattered most were among them: `falsification_conditions`,
// `rival_mechanisms` and `candidate_hypothesis_ranking`. A hypothesis with no
// stated way to be wrong, no rival mechanism and no record of what was passed
// over is exactly what the gate is supposed to refuse, and the gate could not
// see that they were missing because nothing had ever asked for them where it
// counted.
//
// MEASURED ON cycle-g-v91, 2026-09-13. The artifact carried three of twelve.
// Reading it I reported that the director had cited no literature at all; it
// had, under `supporting_literature_edges`, which is the name the schema
// enforces -- and the contract was asking for a second name for the same thing.
//
// This is the contract-mismatch failure in its quiet form. It does not halt the
// harness; it deletes requirements. That is worse, because a halt is noticed.

/// The fields the prose contract says the hypothesis artifact must carry.
///
/// Read out of the directive itself rather than restated here, so the check
/// cannot drift from the sentence it is checking.
fn fields_demanded_by_the_contract(policy_source: &str) -> Vec<String> {
    let anchor = "- hypothesis_contract: the hypothesis JSON must carry";
    let Some(start) = policy_source.find(anchor) else {
        panic!("the hypothesis contract sentence is gone; this check has nothing to read");
    };
    let sentence_end = policy_source[start..]
        .find("\\n-")
        .map(|offset| start + offset)
        .unwrap_or(policy_source.len());
    let sentence = &policy_source[start..sentence_end];
    let mut fields = Vec::new();
    let mut rest = sentence;
    // Every `backticked_name` in the sentence that looks like a JSON field.
    while let Some(open) = rest.find('`') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('`') else { break };
        let name = &after[..close];
        if !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            if !fields.contains(&name.to_string()) {
                fields.push(name.to_string());
            }
        }
        rest = &after[close + 1..];
    }
    fields
}

/// The `selected_hypothesis` object's own source, by brace depth.
///
/// Finding it by searching for the next `"required"` picks up a NESTED one --
/// `candidate_hypothesis_ranking` has its own -- so the block is delimited by
/// matching braces and the outer list is the last one inside it.
fn selected_hypothesis_block(schema_source: &str) -> &str {
    let start = schema_source
        .find("\"selected_hypothesis\": {")
        .expect("selected_hypothesis is gone from the schema");
    let open = start + schema_source[start..].find('{').unwrap();
    let mut depth = 0usize;
    for (offset, ch) in schema_source[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &schema_source[start..open + offset + 1];
                }
            }
            _ => {}
        }
    }
    panic!("selected_hypothesis block is unbalanced");
}

/// Names declared one level inside the block's own `properties` object.
fn keys_the_schema_accepts(schema_source: &str) -> Vec<String> {
    let block = selected_hypothesis_block(schema_source);
    let props_at = block.find("\"properties\": {").expect("no properties");
    let open = props_at + block[props_at..].find('{').unwrap();
    let mut keys = Vec::new();
    let mut depth = 0usize;
    let bytes: Vec<char> = block[open..].chars().collect();
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            '"' if depth == 1 => {
                let mut end = index + 1;
                while end < bytes.len() && bytes[end] != '"' {
                    end += 1;
                }
                let name: String = bytes[index + 1..end].iter().collect();
                if !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                {
                    keys.push(name);
                }
                index = end;
            }
            _ => {}
        }
        index += 1;
    }
    keys
}

/// The block's OWN required list -- the last one inside it.
fn keys_the_schema_requires(schema_source: &str) -> Vec<String> {
    let block = selected_hypothesis_block(schema_source);
    let at = block.rfind("\"required\": [").expect("no required list");
    let close = at + block[at..].find(']').unwrap();
    block[at..close]
        .split('"')
        .filter(|piece| {
            !piece.is_empty()
                && *piece != "required"
                && piece
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
        .map(ToString::to_string)
        .collect()
}

#[test]
fn the_contract_cannot_demand_what_the_schema_forbids() {
    let policy = include_str!("../policy.rs");
    let schema = include_str!("../../runtime/codex_schema.rs");
    let demanded = fields_demanded_by_the_contract(policy);
    assert!(
        demanded.len() >= 8,
        "only {} fields parsed out of the contract sentence; the parse broke",
        demanded.len()
    );
    let accepted = keys_the_schema_accepts(schema);
    let impossible: Vec<&String> = demanded
        .iter()
        .filter(|field| !accepted.contains(field))
        .collect();
    assert!(
        impossible.is_empty(),
        "the contract demands fields the closed schema will reject, so a director that obeyed \
         would have its whole result refused: {impossible:?}",
    );
}

#[test]
fn the_prompt_shows_every_key_the_schema_requires() {
    // A required key the model is never shown is worse than a missing one: the
    // schema refuses the result, the lane fails, and the cause is a key nobody
    // mentioned. The contract text in the prompt is where the model reads it.
    let schema = include_str!("../../runtime/codex_schema.rs");
    let prompt = include_str!("../../runtime/codex_prompt.rs");
    let required = keys_the_schema_requires(schema);
    assert!(required.len() >= 9, "required list parse broke: {required:?}");
    let missing: Vec<&String> = required
        .iter()
        .filter(|key| !prompt.contains(&format!("\\\"{key}\\\"")))
        .collect();
    assert!(
        missing.is_empty(),
        "the schema requires these and the prompt never shows them, so every director lane \
         would fail parsing: {missing:?}",
    );
}

#[test]
fn the_three_that_keep_the_science_honest_are_required() {
    // Not a style preference. A hypothesis with no stated way to be wrong, no
    // rival mechanism, and no record of what it passed over is what the gate
    // exists to refuse -- and for the whole of cycle-g-v91 the gate could not
    // see they were absent, because the schema had no place for them.
    let schema = include_str!("../../runtime/codex_schema.rs");
    let start = schema.find("\"selected_hypothesis\": {").unwrap();
    let block_end = schema[start..].find("\"chronicle_requests\"").unwrap() + start;
    let block = &schema[start..block_end];
    for key in [
        "falsification_conditions",
        "rival_mechanisms",
        "candidate_hypothesis_ranking",
    ] {
        assert!(block.contains(key), "{key} is not in the hypothesis schema");
    }
}
