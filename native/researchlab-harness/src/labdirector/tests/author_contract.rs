// The author lane had no output contract at all.
//
// The chain in codex_prompt.rs covered gatekeeper, lab-director, chronicle and
// analyst; author fell through to an empty string. The one lane that writes the
// paper was the only one working without a specification.
//
// These assertions exist because a prompt-contract clause has no compiler behind
// it. The rules are owner-supplied and several are mechanically checkable, so
// they are written to be checked rather than admired.

fn author_contract() -> &'static str {
    crate::runtime::codex_prompt::AUTHOR_OUTPUT_CONTRACT
}

#[test]
fn the_venue_is_settled_before_any_prose() {
    // A venue decides anonymity, length and section structure, so the manuscript
    // cannot be shaped before it is known. Owner-directed as a hard precondition.
    let c = author_contract();
    assert!(c.contains("STAGE 0 - TARGET VENUE, BEFORE ANY PROSE (MANDATORY)"));
    assert!(c.contains("target_venue"));
    assert!(c.contains("guidelines_url"), "the venue's own guidelines must be READ and cited");
    assert!(c.contains("checked_on"), "a policy read has a date; a remembered one does not");
    assert!(
        c.contains("nearest_paper_in_venue"),
        "the closest paper in that venue is a required input, not an optional one"
    );
    assert!(
        c.contains("read from THAT paper, not inferred from its title"),
        "what another paper claims comes from that paper"
    );
}

#[test]
fn the_contract_carries_the_reason_venue_policy_is_never_recalled() {
    // T-RO was described as single-blind when it has been double-anonymous since
    // 2025. Submitting on that recollection would have broken the policy, and the
    // measured cost is what keeps the rule from being softened later.
    let c = author_contract();
    assert!(c.contains("T-RO"));
    assert!(c.contains("double-anonymous"));
    assert!(c.contains("Do not answer from memory"));
}

#[test]
fn novelty_leads_and_the_limitation_does_not_swallow_it() {
    // 'Not X but Y' leaves the reader holding X. cycle-g-v89 ran 27 methods that
    // all missed a preregistered bound; written backwards, the reader keeps the
    // failure instead of the finding.
    let c = author_contract();
    assert!(c.contains("LEAD WITH WHAT IS NEW"));
    assert!(c.contains("'Not X but Y' leaves the reader holding X"));
    assert!(c.contains("ONCE, in the Discussion"), "a limitation appears once, and after the contribution");
    assert!(
        c.contains("Do not invent novelty that is not there"),
        "the rule cuts both ways or it is an instruction to overclaim"
    );
}

#[test]
fn the_mechanically_checkable_rules_are_written_to_be_checked() {
    let c = author_contract();
    // Identity leak: the text is not enough, pdfTeX stamps paths into the bytes.
    assert!(c.contains("RAW BYTES"));
    assert!(c.contains("/PTEX.FileName"));
    assert!(c.contains("pdfsuppressptexinfo=-1"));
    // Process narration and LLM register are given as explicit lists.
    for phrase in ["will be finalized", "before submission", "this draft", "we now added"] {
        assert!(c.contains(phrase), "process-narration list is missing {phrase}");
    }
    for word in ["additionally", "moreover", "leverage", "comprehensive", "seamless", "delve"] {
        assert!(c.contains(word), "LLM-register list is missing {word}");
    }
    assert!(
        c.contains("Keep the field's own terms of art"),
        "a banned-word list with no exemption strips the vocabulary the paper needs"
    );
    // Numbers come from artifacts, and the manifest is what makes that auditable.
    assert!(c.contains("numbers_manifest"));
    assert!(c.contains("Do not type a figure into prose"));
    assert!(c.contains("change the result, not the sentence"));
    // The v89 draft obeyed the sourcing half and printed 0.4444444444444445 --
    // the rule said where a number comes FROM and nothing about how it is written.
    assert!(c.contains("ROUND FOR THE PROSE"));
    assert!(c.contains("five seeds do not justify sixteen digits"));
    assert!(
        c.contains("Quote a ratio of small integer counts AS the counts"),
        "4 of 9 queries is the measurement; 0.444... is an artefact of dividing it"
    );
    assert!(
        c.contains("Keep the exact value in numbers_manifest"),
        "rounding has to stay auditable"
    );
    // Statistics and disclosure.
    assert!(c.contains("Clopper-Pearson"));
    assert!(c.contains("exact McNemar"));
    assert!(c.contains("limited to writing and code"));
}

#[test]
fn reading_the_whole_thing_is_a_recorded_step() {
    // Pattern search misses a citation to a theorem that does not exist. If the
    // read is not an output, it did not happen.
    let c = author_contract();
    assert!(c.contains("READ THE WHOLE THING ONCE, END TO END"));
    assert!(c.contains("read_end_to_end"));
    assert!(c.contains("forbidden_phrases_found"));
    assert!(c.contains("identity_leak_check"));
}

#[test]
fn the_author_role_actually_receives_it() {
    // The contract existing and the contract being dispatched are different
    // facts, and this project has spent whole cycles on the gap between them.
    let source = include_str!("../../runtime/codex_prompt.rs").replace("\r\n", "\n");
    assert!(source.contains("} else if contract.role == \"author\" {"));
    assert!(source.contains("AUTHOR_OUTPUT_CONTRACT\n"));
}

// Four times in one cycle a value existed and the consumer could not see it:
// the contract undeployed, the file rewritten to CRLF, the citations written to
// `authored_references` while the rubric read `references`, and this one -- the
// author writing bibliography strings while reference_policy.js reads doi,
// title, type, venue and cited_by_count as fields.
//
// cycle-g-v89 cited seven real graphics papers, every one with a DOI inside its
// citation text, and the gate reported "unverified references remain: untitled
// reference; untitled reference; untitled reference".

#[test]
fn a_reference_is_structured_data_the_policy_can_read() {
    let c = author_contract();
    // The const's runtime value carries real quote characters, so the probe is
    // written with them rather than with the escapes the source file shows.
    for field in ["\"doi\"", "\"title\"", "\"venue\"", "\"cited_by_count\"", "\"type\""] {
        assert!(c.contains(field), "reference schema is missing {field}");
    }
    assert!(
        c.contains("bare DOI, no URL prefix"),
        "hasPersistentIdentifier reads the doi field, not a URL inside prose"
    );
    assert!(c.contains("A REFERENCE IS STRUCTURED DATA, not a formatted string"));
    assert!(
        c.contains("a DOI that appears only inside the citation text is a reference nobody can verify"),
        "the measured failure has to be named or the rule reads as style advice"
    );
    // The bibliography string is still required; it is just not the only form.
    assert!(c.contains("the formatted reference as it appears in the bibliography"));
}

#[test]
fn a_citation_count_is_read_or_omitted_never_estimated() {
    // The rubric rewards well-cited references, which is exactly the pressure
    // that produces an invented number about someone else's paper.
    let c = author_contract();
    assert!(c.contains("citation_count_source"));
    assert!(c.contains("omit the count entirely rather than estimating it"));
    assert!(c.contains("an invented citation count is a fabricated fact about someone else's work"));
    assert!(
        c.contains("a missing one costs a rubric point"),
        "the honest answer has to be named as the cheaper one to take"
    );
}

#[test]
fn the_abstract_carries_its_components_whatever_the_venue_prints() {
    // The contract said `"abstract": "..."` while review checked four keys, so
    // obeying the contract failed the rubric and satisfying the rubric broke the
    // contract. One abstract, two renderings.
    let c = author_contract();
    for field in ["background", "methods", "results", "interpretation", "summary"] {
        assert!(c.contains(field), "abstract schema is missing {field}");
    }
    assert!(c.contains("the same abstract as ONE paragraph, for a venue that prints it that way"));
    assert!(c.contains("Write the abstract as all five fields whatever the venue's format"));
    assert!(c.contains("obeying a venue's layout never costs a component"));
}
