// The gate can demand a reading; the reviewer has to know what reading means.
//
// The figure gate raises a verification request per figure and stays closed until
// a verdict clears it. Those requests are routed to the gatekeeper, whose
// contract covers novelty, technical quality, reproducibility, clarity and
// impact, and says nothing about images. A reviewer handed that request and no
// clause would score the manuscript and report that the figures exist.

fn clause() -> &'static str {
    crate::runtime::codex_prompt::GATEKEEPER_FIGURE_VERIFICATION_CLAUSE
}

#[test]
fn the_reviewer_is_told_to_open_the_image_not_read_the_caption() {
    let c = clause();
    assert!(c.contains("FIGURE VERIFICATION (MANDATORY FOR THIS REVIEW)"));
    assert!(c.contains("You are not scoring the manuscript here"));
    assert!(c.contains("OPEN the image"));
    assert!(
        c.contains("panel titles, annotations, reference lines, axis ranges, and the relative position of marks"),
        "a figure asserts in several channels and the caption is not one of them"
    );
    assert!(c.contains("check each assertion against the numbers"));
}

#[test]
fn both_measured_defects_are_named_so_the_review_has_a_target() {
    // A reviewer told to "check the figure" confirms that a figure exists. These
    // two shapes both reached a cycle-g-v89 manuscript through a coverage_check
    // that reported no gaps.
    let c = clause();
    assert!(c.contains("a panel title that the panel's own marks refute"));
    assert!(c.contains("naming two arms as clearing a threshold the same chart draws four bars past"));
    assert!(c.contains("an offset that separates values the artifact records as EQUAL"));
    assert!(c.contains("two measurements of zero on an axis zoomed to a tenth of a unit"));
}

#[test]
fn a_correct_caption_does_not_excuse_an_incorrect_drawing() {
    let c = clause();
    assert!(
        c.contains("is a discrepancy even when the caption is correct"),
        "the round-2 sham panel had an accurate caption over an empty chart"
    );
    assert!(c.contains("a reader takes the drawing as the finding"));
    assert!(c.contains("A figure you could not open is not verified"));
}

#[test]
fn the_verdict_shape_is_the_one_the_gate_reads() {
    let c = clause();
    for field in ["figure_id", "verified", "checked_against", "on_image_assertions", "discrepancies"] {
        assert!(c.contains(field), "verdict shape is missing {field}");
    }
    assert!(c.contains("`verified` is true only when every on-image assertion is supported"));
    assert!(
        c.contains("Leaving `checked_against` empty makes the verdict an opinion"),
        "the gate rejects a verdict that names no evidence, so the contract has to say so"
    );
}

#[test]
fn only_the_figure_reviewer_carries_it() {
    let temp = TempDir::new().unwrap();
    for (role, rubric, expected) in [
        ("gatekeeper", "figure_evidence", true),
        ("gatekeeper", "novelty", false),
        ("gatekeeper", "", false),
        ("author", "figure_evidence", false),
    ] {
        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "figure-review", "lane_id": format!("{role}-01"), "role": role,
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": temp.path(), "task_file": temp.path().join("task.md")
        })).unwrap();
        let role_plan = json!({"planner_metadata": {"target_rubric": rubric}});
        let prompt = crate::runtime::codex_prompt::build_codex_prompt(
            &contract, Some(&role_plan),
        ).unwrap();
        assert_eq!(prompt.contains(clause()), expected, "role={role}, rubric={rubric}");
    }
}
