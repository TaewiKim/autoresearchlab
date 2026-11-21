//! The owner's standing direction for a cycle.
//!
//! A researcher message (`researchlab tell`) reaches the director that is opened
//! for it and no other. A direction the owner gives a cycle has to outlive that
//! one decision.
//!
//! MEASURED ON cycle-a-20260919, 2026-11-16..21. The owner directed the
//! cycle back to its coverage hypothesis -- a new five-policy panel with shared
//! training support, no fresh proof of procedure-level novelty required. Director
//! 2009 restored the lead on it and the reproduction anchor was completed on
//! 11-18. The direction appeared seven times in director 2009's prompt, once in
//! 2030's and not at all in 2067's: the later directors returned to proposing new
//! designs and refusing each on unverified novelty, `common_support_pose_v1` still
//! held zero rows, and the lead was withdrawn again.
//!
//! The direction is written by `researchlab direct` (src/cli/direct.js) to
//! `state/<cycle>-owner-direction.json` and handed to every director lane until
//! the owner replaces or withdraws it.

use super::*;

pub(crate) fn owner_direction_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-owner-direction.json"))
}

/// The direction in force, if the owner has given one and not withdrawn it.
pub(crate) fn standing_owner_direction(paths: &AppPaths, cycle_id: &str) -> Option<Value> {
    let record = read_json(&owner_direction_path(paths, cycle_id)).ok()?;
    let direction = record.get("direction")?;
    let text = direction.get("text").and_then(Value::as_str)?.trim();
    if text.is_empty() {
        return None;
    }
    Some(direction.clone())
}

/// What every director lane is given about the owner's direction.
pub(crate) fn owner_direction_director_context(paths: &AppPaths, cycle_id: &str) -> Value {
    let Some(direction) = standing_owner_direction(paths, cycle_id) else {
        return Value::Null;
    };
    json!({
        "standing": true,
        "issued_at": direction.get("issued_at"),
        "message_id": direction.get("message_id"),
        "text": direction.get("text"),
        "rule": "This is the owner's standing direction for the cycle. It stays in force until the owner replaces or withdraws it, however many director lanes run in between, and it outranks your predecessors' notes and your own preference for another line of work. Decide within it: choose the means, the scope, the order of work and the scientific judgments it leaves to you. Where the evidence says it cannot be carried out here, say exactly what blocks it, what you tried, and the smallest change to the direction that would make it feasible -- and keep working on the part that can be done. You may not set it aside, replace it with a different research line, or reinstate a requirement it removes.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, AppPaths) {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        fs::create_dir_all(state_root(&paths)).unwrap();
        (temp, paths)
    }

    #[test]
    fn a_direction_stands_until_it_is_withdrawn() {
        let (_temp, paths) = fixture();
        let cycle = "c";
        assert!(owner_direction_director_context(&paths, cycle).is_null(), "no direction, no key");
        write_json(
            &owner_direction_path(&paths, cycle),
            &json!({"cycle_id": cycle, "direction": {"text": "return to the coverage hypothesis", "issued_at": "2026-11-16T00:39:51Z", "message_id": "msg-1"}}),
        )
        .unwrap();
        let context = owner_direction_director_context(&paths, cycle);
        assert_eq!(context["text"], json!("return to the coverage hypothesis"));
        assert!(context["rule"].as_str().unwrap().contains("You may not set it aside"));
        // Withdrawn: the record keeps its history and the director is told nothing.
        write_json(
            &owner_direction_path(&paths, cycle),
            &json!({"cycle_id": cycle, "direction": null, "history": [{"text": "return to the coverage hypothesis"}]}),
        )
        .unwrap();
        assert!(owner_direction_director_context(&paths, cycle).is_null());
    }
}
