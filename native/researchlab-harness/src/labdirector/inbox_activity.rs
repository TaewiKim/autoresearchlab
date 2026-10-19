use anyhow::Result;
use chrono::Utc;
use serde_json::Value;
use std::fs::{self, read_dir};
use std::collections::HashMap;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use super::cycle_control::read_termination_code;
use super::lane_state::lane_dirs_from_contract_index;
use crate::core::model::AppPaths;
use crate::core::support::{
    chronicle_briefs_root, labdirector_cursor_path, read_json, state_root,
};

fn latest_mtime_utc(path: &Path) -> Option<chrono::DateTime<Utc>> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<Utc>::from(modified))
}

fn update_latest_timestamp(
    latest: &mut Option<chrono::DateTime<Utc>>,
    candidate: Option<chrono::DateTime<Utc>>,
) {
    if let Some(candidate_ts) = candidate {
        if latest.map(|current| candidate_ts > current).unwrap_or(true) {
            *latest = Some(candidate_ts);
        }
    }
}

fn parse_utc_timestamp(value: &Value) -> Option<chrono::DateTime<Utc>> {
    value
        .as_str()
        .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
        .map(|parsed| parsed.with_timezone(&Utc))
}

fn latest_subagent_response_from_cycle_state(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<chrono::DateTime<Utc>>> {
    let state_path = state_root(paths).join(format!("{cycle_id}-cycle-run-state.json"));
    if !state_path.exists() {
        return Ok(None);
    }
    let state = read_json(&state_path)?;
    let lane_statuses = state
        .get("lane_statuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if lane_statuses.len() < 32 {
        return Ok(None);
    }
    let mut latest = parse_utc_timestamp(state.get("updated_at").unwrap_or(&Value::Null));
    for lane in lane_statuses {
        for key in ["updated_at", "completed_at", "started_at"] {
            update_latest_timestamp(
                &mut latest,
                parse_utc_timestamp(lane.get(key).unwrap_or(&Value::Null)),
            );
        }
    }
    for event in state
        .get("recent_events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        update_latest_timestamp(
            &mut latest,
            parse_utc_timestamp(event.get("ts").unwrap_or(&Value::Null)),
        );
    }
    Ok(latest)
}

pub(crate) fn latest_subagent_response_at(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<chrono::DateTime<Utc>>> {
    if let Some(cached_latest) = latest_subagent_response_from_cycle_state(paths, cycle_id)? {
        return Ok(Some(cached_latest));
    }
    let mut latest = None;
    for (_, lane_dir) in lane_dirs_from_contract_index(paths, cycle_id)? {
        for name in ["events.jsonl", "result.json", "final-status.json"] {
            update_latest_timestamp(&mut latest, latest_mtime_utc(&lane_dir.join(name)));
        }
    }
    let briefs_dir = chronicle_briefs_root(paths, cycle_id);
    if briefs_dir.exists() {
        for entry in read_dir(&briefs_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            update_latest_timestamp(&mut latest, latest_mtime_utc(&entry.path()));
        }
    }
    Ok(latest)
}

/// How many lines the inbox holds, counted without holding the inbox.
///
/// MEASURED on cycle-a-20260919, 2026-09-23. The director's inbox is
/// 14 MB and [`sleep_until_intervention_or_timeout`] asks this question once a
/// second while it waits -- so a waiting pass read 14 MB/s, forever, to learn a
/// number that only changes when someone writes to the inbox. That alone is
/// ~100 GB across the two-hour silences this cycle kept falling into.
///
/// The inbox is append-only, so (len, modified) settles it: an unchanged file
/// costs one stat, and a changed one is streamed through a fixed buffer rather
/// than materialized as a 14 MB String.
fn inbox_line_count(inbox_path: &std::path::Path) -> Result<usize> {
    use std::io::Read;

    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<HashMap<std::path::PathBuf, (u64, Option<std::time::SystemTime>, usize)>>,
    > = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    let metadata = fs::metadata(inbox_path)?;
    let len = metadata.len();
    let modified = metadata.modified().ok();
    if let Ok(guard) = cache.lock() {
        if let Some((cached_len, cached_modified, count)) = guard.get(inbox_path) {
            if *cached_len == len && *cached_modified == modified {
                return Ok(*count);
            }
        }
    }

    // Blank lines do not count, because the cursor this is compared against is
    // written from a blank-filtered count (labdirector::supervision::inbox).
    let mut file = fs::File::open(inbox_path)?;
    let mut buffer = vec![0u8; 256 * 1024];
    let mut count = 0usize;
    let mut line_has_content = false;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            if *byte == b'\n' {
                if line_has_content {
                    count += 1;
                }
                line_has_content = false;
            } else if !byte.is_ascii_whitespace() {
                line_has_content = true;
            }
        }
    }
    // A final line with no trailing newline still counts.
    if line_has_content {
        count += 1;
    }

    if let Ok(mut guard) = cache.lock() {
        guard.insert(inbox_path.to_path_buf(), (len, modified, count));
    }
    Ok(count)
}

fn unread_labdirector_inbox_item_count(paths: &AppPaths, cycle_id: &str) -> Result<usize> {
    // Counted per segment: an hour that has closed is counted once, and only
    // the current hour's file is read again when it grows.
    let mut line_count = 0usize;
    for segment in crate::core::support::segmented_log::labdirector_inbox_log(paths, cycle_id).segments() {
        line_count += inbox_line_count(&segment)?;
    }
    if line_count == 0 {
        return Ok(0);
    }
    let cursor_path = labdirector_cursor_path(paths, cycle_id);
    let cursor = if cursor_path.exists() {
        read_json(&cursor_path)?
            .get("offset")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize
    } else {
        0
    };
    Ok(line_count.saturating_sub(cursor))
}

pub(crate) fn sleep_until_intervention_or_timeout(
    paths: &AppPaths,
    cycle_id: &str,
    total_seconds: u64,
) -> Result<()> {
    let mut remaining = total_seconds;
    while remaining > 0 {
        if unread_labdirector_inbox_item_count(paths, cycle_id)? > 0 {
            break;
        }
        if read_termination_code(paths, cycle_id)?
            .as_ref()
            .and_then(|value| value.get("should_stop"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            break;
        }
        let slice = remaining.min(1);
        sleep(Duration::from_secs(slice));
        remaining = remaining.saturating_sub(slice);
    }
    Ok(())
}

#[cfg(test)]
mod inbox_line_count_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn it_counts_what_the_cursor_counts_and_notices_an_append() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path().join("inbox.jsonl");
        fs::write(&path, "{\"a\":1}\n\n   \n{\"b\":2}\n").expect("write");
        assert_eq!(inbox_line_count(&path).expect("count"), 2);
        // The same answer, now from the cache.
        assert_eq!(inbox_line_count(&path).expect("count"), 2);

        // A last line with no trailing newline is still an item.
        fs::write(&path, "{\"a\":1}\n\n   \n{\"b\":2}\n{\"c\":3}").expect("append");
        assert_eq!(inbox_line_count(&path).expect("count"), 3);
    }
}
