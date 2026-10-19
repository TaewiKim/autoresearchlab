// The owner's instructions were living in my messages.
//
// "Target a journal rather than a conference", "secure novelty before the axes
// you can buy", "three methods before you retire a question" - each reached a
// lane because I pasted it into a role plan by hand. That applies it once, to
// one lane, with no record of who asked or why, and the next dispatch does not
// have it.
//
// The directive file is the same shape as the document-stage authorization it is
// modelled on, and these tests pin the parts that make it auditable rather than
// convenient: both halves required, retirement honoured, and a rendered clause
// that cannot be read as permission to assert something unverified.

use crate::runtime::owner_directives::{owner_directive_clause, owner_directives_for_role};
use std::fs;
use std::path::PathBuf;

/// A scratch tree nobody else can already own.
///
/// This used to build a FIXED path per test name, wipe it, and recreate it --
/// and the wipe was `let _ =`, so a failure to remove was silent. All five
/// tests in this file then died on `PermissionDenied` for weeks: the
/// directories had been created by a root-run on 2026-09-02, the non-root wipe
/// failed quietly, `create_dir_all` succeeded because the tree already existed,
/// and the first write into it was refused.
///
/// A fixed temp name is shared mutable state between runs, between users, and
/// between concurrent test threads. `TempDir` gives each run its own, and the
/// guard is returned so the directory lives exactly as long as the test.
fn scratch(_name: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join(".research-lab").join("state")).unwrap();
    dir
}

fn write_directives(cwd: &PathBuf, cycle_id: &str, body: &str) {
    let path = cwd
        .join(".research-lab")
        .join("state")
        .join(format!("{cycle_id}-owner-directives.json"));
    fs::write(path, body).unwrap();
}

#[test]
fn an_instruction_without_a_reason_is_ignored() {
    // Same rule as document_stage_authorized. An instruction nobody can account
    // for later is indistinguishable from a preference that leaked in.
    let scratch_dir = scratch("halves");
    let cwd = scratch_dir.path().to_path_buf();
    write_directives(
        &cwd,
        "c1",
        r#"{"directives":[
            {"id":"no-reason","directive":"target a journal","reason":"   "},
            {"id":"no-directive","directive":"","reason":"the owner asked"},
            {"id":"complete","directive":"target a journal","reason":"journals archive the method"}
        ]}"#,
    );
    let found = owner_directives_for_role(&cwd, "c1", "author");
    assert_eq!(found.len(), 1, "only the complete entry applies");
    assert_eq!(found[0].id, "complete");
}

#[test]
fn a_directive_reaches_the_roles_it_names_and_no_others() {
    let scratch_dir = scratch("roles");
    let cwd = scratch_dir.path().to_path_buf();
    write_directives(
        &cwd,
        "c1",
        r#"{"directives":[
            {"id":"venue","roles":["author"],"directive":"journal not conference","reason":"r"},
            {"id":"cycle-wide","directive":"three methods per question","reason":"r"}
        ]}"#,
    );
    let author: Vec<String> = owner_directives_for_role(&cwd, "c1", "author")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(author, vec!["venue", "cycle-wide"]);

    let illustrator: Vec<String> = owner_directives_for_role(&cwd, "c1", "illustrator")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(
        illustrator,
        vec!["cycle-wide"],
        "an entry with no roles is cycle-wide; one that names author is not"
    );
}

#[test]
fn a_retired_directive_stops_applying_without_being_deleted() {
    // The record of what was asked, and when it stopped applying, is the point.
    let scratch_dir = scratch("retire");
    let cwd = scratch_dir.path().to_path_buf();
    write_directives(
        &cwd,
        "c1",
        r#"{"directives":[
            {"id":"old","directive":"target a conference","reason":"r","retired":true},
            {"id":"new","directive":"target a journal","reason":"r"}
        ]}"#,
    );
    let found: Vec<String> = owner_directives_for_role(&cwd, "c1", "author")
        .into_iter()
        .map(|d| d.id)
        .collect();
    assert_eq!(found, vec!["new"]);
}

#[test]
fn a_missing_or_broken_file_leaves_the_lane_running() {
    // A lane that cannot read directives must run without them, not fail to run.
    let scratch_dir = scratch("broken");
    let cwd = scratch_dir.path().to_path_buf();
    assert!(owner_directives_for_role(&cwd, "absent", "author").is_empty());
    write_directives(&cwd, "c1", "{ not json");
    assert!(owner_directives_for_role(&cwd, "c1", "author").is_empty());
    write_directives(&cwd, "c2", r#"{"directives":"not an array"}"#);
    assert!(owner_directives_for_role(&cwd, "c2", "author").is_empty());
}

#[test]
fn the_rendered_clause_carries_the_reason_and_refuses_to_be_read_as_a_finding() {
    let scratch_dir = scratch("render");
    let cwd = scratch_dir.path().to_path_buf();
    write_directives(
        &cwd,
        "c1",
        r#"{"directives":[{"id":"venue-journal","roles":["author"],
            "directive":"Target a journal rather than a conference track.",
            "reason":"A journal version is the archival record."}]}"#,
    );
    let clause = owner_directive_clause(&cwd, "c1", "author");
    assert!(clause.contains("OWNER DIRECTIVE (BINDING)"));
    assert!(clause.contains("[venue-journal]"));
    assert!(clause.contains("Target a journal rather than a conference track."));
    assert!(
        clause.contains("Owner's reason: A journal version is the archival record."),
        "the reason travels with the instruction so the lane knows what it is serving"
    );
    // The line that keeps a directive from becoming a fabricated fact.
    assert!(clause.contains("does NOT license asserting anything you have not verified"));
    assert!(clause.contains("follow what you found and say so in your output"));

    assert!(
        owner_directive_clause(&cwd, "c1", "gatekeeper").is_empty(),
        "a role with no directives gets no block at all"
    );
}

#[test]
fn every_role_prompt_carries_the_clause() {
    let temp = TempDir::new().unwrap();
    let cwd = temp.path().to_path_buf();
    fs::create_dir_all(cwd.join(".research-lab/state")).unwrap();
    write_directives(
        &cwd,
        "c1",
        r#"{"directives":[{"id":"cycle-wide","directive":"Preserve the original objective.","reason":"The owner requires continuity."}]}"#,
    );
    for role in ["lab-director", "scout", "chronicle", "analyst", "lab-runner", "gatekeeper", "illustrator", "author"] {
        let contract: LaneContract = serde_json::from_value(json!({
            "cycle_id": "c1", "lane_id": format!("{role}-01"), "role": role,
            "runtime_class": "codex-agent", "mode": "read-write-scoped",
            "cwd": cwd, "task_file": cwd.join("task.md")
        })).unwrap();
        let prompt = crate::runtime::codex_prompt::build_codex_prompt(&contract, None).unwrap();
        assert!(prompt.contains("[cycle-wide]"), "missing directive for {role}");
        assert!(prompt.contains("Preserve the original objective."));
        assert!(prompt.contains("The owner requires continuity."));
    }
}
