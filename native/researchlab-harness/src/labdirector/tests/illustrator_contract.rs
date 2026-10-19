// The figures have to carry the claim on their own.
//
// illustrator-01 ran on cycle-g-v89 with a 632-byte prompt, `Role Plan: null` and
// no output contract, and returned an empty extracted_json. Owner requirement:
// the illustrator must produce the graphs a table cannot express, such that a
// reader who sees only the figures still reads the paper's central claim.
//
// cycle-g-v89 is the concrete case. An image-space residual signal correlates
// with stale error at r=0.927 and still misses a preregistered false-safe bound of
// 0.10, across 27 methods. Twenty-seven table rows hide that; a scatter of
// correlation against realised risk with the bound drawn as a line does not.

fn illustrator_contract() -> &'static str {
    crate::runtime::codex_prompt::ILLUSTRATOR_OUTPUT_CONTRACT
}

#[test]
fn the_claim_is_stated_before_any_figure_is_designed() {
    let c = illustrator_contract();
    assert!(c.contains("DESIGN FROM THE CLAIM, NOT FROM THE DATA (MANDATORY)"));
    assert!(c.contains("central_claim"));
    assert!(
        c.contains("claim_carried"),
        "each figure must say which part of the claim it carries"
    );
    assert!(
        c.contains("rejected_figures"),
        "a figure carrying no part of the claim is recorded as rejected, not printed"
    );
}

#[test]
fn the_figure_only_read_is_an_output_not_an_aspiration() {
    // The owner's actual requirement, and the only way to check it is to make the
    // illustrator state what the figures alone say and compare it to the claim.
    let c = illustrator_contract();
    assert!(c.contains("figure_only_read"));
    assert!(c.contains("if that is less than central_claim, the figure set is not finished"));
    assert!(
        c.contains("coverage_check"),
        "claim components must be mapped to figures, with the gaps named"
    );
}

#[test]
fn it_asks_for_the_shapes_a_table_cannot_hold() {
    let c = illustrator_contract();
    assert!(c.contains("SHOW WHAT A TABLE CANNOT (MANDATORY)"));
    for shape in ["distribution", "curve", "crossover", "boundary", "frontier",
                  "per_seed_scatter", "calibration"] {
        assert!(c.contains(shape), "figure-kind vocabulary is missing {shape}");
    }
    assert!(
        c.contains("why_not_a_table"),
        "each figure must justify itself against the table of the same numbers"
    );
    // A threshold named only in the caption is a number the reader has to hold in
    // their head while looking elsewhere.
    assert!(c.contains("reference_marks"));
    assert!(c.contains("drawn ON the figure"));
}

#[test]
fn a_figure_is_traceable_to_a_committed_result() {
    // Same rule as the author's numbers_manifest: an untraceable figure is an
    // untraceable number with a nicer surface.
    let c = illustrator_contract();
    assert!(c.contains("EVERY FIGURE COMES FROM A COMMITTED RESULT FILE (MANDATORY)"));
    assert!(c.contains("source_artifact"));
    assert!(c.contains("generator"));
    assert!(c.contains("to change what a figure shows, change the result it is drawn from"));
}

#[test]
fn captions_describe_the_subject_and_axes_carry_units() {
    let c = illustrator_contract();
    assert!(c.contains("CAPTIONS DESCRIBE THE SUBJECT (MANDATORY)"));
    // The author contract bans writing-process narration; captions are where it
    // reappears if nobody says otherwise.
    assert!(c.contains("this figure demonstrates"));
    assert!(c.contains("will be updated"));
    assert!(c.contains("LEGIBILITY (MANDATORY)"));
    assert!(c.contains("quantity AND unit"));
    assert!(
        c.contains("Do not rescale an axis to make a difference look larger than it is"),
        "the figure must not overstate what the number says"
    );
}

#[test]
fn the_illustrator_role_actually_receives_it() {
    // A contract that exists and a contract that is dispatched are different
    // facts; illustrator-01 had a 632-byte prompt precisely because of that gap.
    let source = include_str!("../../runtime/codex_prompt.rs").replace("\r\n", "\n");
    assert!(source.contains("} else if contract.role == \"illustrator\" {"));
    assert!(source.contains("ILLUSTRATOR_OUTPUT_CONTRACT\n"));
}

// The three clauses below were bought with a manuscript that shipped two
// unreadable figures past a coverage_check that said `ok`.
//
// The v89 illustrator named a runner blueprint's script.py as the `generator` of
// all three figures, and every PNG predated the lane's own run by 14 hours to two
// days. It had selected existing diagnostic plots and captioned them. The old
// contract permitted that: it enumerated `kinds` and demanded reference marks
// drawn ON the figure, and a plot that already has both satisfies every word.

#[test]
fn a_selected_diagnostic_plot_is_not_a_figure() {
    let c = illustrator_contract();
    assert!(c.contains("DRAW THE FIGURE, DO NOT ADOPT A DIAGNOSTIC PLOT (MANDATORY)"));
    assert!(
        c.contains("The generator you name must be a script THIS lane wrote"),
        "the generator field is what distinguishes drawing from selecting"
    );
    assert!(
        c.contains("a path under a runner's blueprint directory is a selection, not a figure"),
        "the exact shape of the v89 defect has to be named or the rule is abstract"
    );
    // Reuse is not banned outright -- one of the three v89 figures was genuinely
    // publication-legible -- but it costs an explicit statement.
    assert!(c.contains("Reuse a runner's image only if you have opened it"));
}

#[test]
fn every_panel_of_a_multi_panel_figure_is_labelled() {
    // active_boundary_comparator_panel.png: four panels, no titles, no axis
    // labels. The old clause said "axis labels carry quantity AND unit" and was
    // silent on which axes, so a figure could satisfy it by having one labelled
    // panel -- or, as here, by nobody checking.
    let c = illustrator_contract();
    assert!(c.contains("on EVERY panel of a multi-panel figure"));
    assert!(c.contains("every panel carries its own title"));
    assert!(c.contains("a panel a reader cannot name is a panel they cannot use"));
}

#[test]
fn a_zero_valued_series_still_has_to_appear() {
    // active_boundary_postrun_sham_audit.png: the left panel was empty, because
    // active and sham both scored zero crossing error and a zero-height bar draws
    // nothing. That zero IS the finding -- it is what withdraws the mechanism
    // claim -- and it rendered as an empty box, which reads as missing data.
    let c = illustrator_contract();
    assert!(c.contains("A SERIES WHOSE VALUE IS ZERO MUST STILL BE VISIBLE"));
    assert!(c.contains("a zero-height bar draws nothing"));
    assert!(
        c.contains("an empty panel reads as missing data"),
        "the failure mode is misreading, not absence"
    );
    assert!(c.contains("when the zero IS the result, say so on the figure"));
}

#[test]
fn coverage_is_claimed_about_the_image_not_about_the_data() {
    // coverage_check returned `ok` for all four components while two of the three
    // images could not be read. The check was answered from the dataframe.
    let c = illustrator_contract();
    assert!(c.contains("OPEN WHAT YOU EMITTED (MANDATORY)"));
    assert!(c.contains("read back each image you wrote"));
    assert!(c.contains("visible in the pixels rather than only in the caption"));
    assert!(
        c.contains("a question about the rendered image and not about the data you passed"),
        "this is the sentence that makes coverage_check falsifiable"
    );
}
