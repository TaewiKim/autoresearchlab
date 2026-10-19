// An append-only log kept as one file per UTC hour:
//
//   <dir>/2026-10-12T03.jsonl
//
// The rule for every log a cycle only ever appends to; the orchestrator keeps
// the same layout and states the rule at length
// (src/observability/segmented_log.js).
//
// MEASURED ON cycle-a-20260919, 2026-10-12, after 23 days: the
// decision ledger was one 12.0 GB file, the dialogue 12.0 GB in 171 files cut
// wherever 64 MB happened to fall, the delivery receipts one 1.5 GB file, and
// the inbox and the chronicle reports 97 MB each -- both read whole into one
// string on every supervision pass.
//
// WRITE: a record goes in the segment of the hour it is appended in, so
// segments sort by name into the order they were written and a closed hour
// never changes. READ: nothing reads the log as one string; a reader walks
// the segments. The single file a log used to be is still read, as the oldest
// segment, for a cycle that has not been split.
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::core::model::AppPaths;

pub(crate) struct SegmentedLog {
    pub(crate) dir: PathBuf,
    pub(crate) legacy: PathBuf,
}

pub(crate) fn is_segment_name(name: &str) -> bool {
    // 2026-10-12T03.jsonl
    let bytes = name.as_bytes();
    bytes.len() == 19
        && name.ends_with(".jsonl")
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13..=18 => true,
            _ => byte.is_ascii_digit(),
        })
}

impl SegmentedLog {
    /// The log that replaces the single file at `legacy` (`<name>.jsonl`): its
    /// segments live in the directory `<name>` beside it.
    pub(crate) fn replacing(legacy: &Path) -> Self {
        Self {
            dir: legacy.with_extension(""),
            legacy: legacy.to_path_buf(),
        }
    }

    pub(crate) fn segment_path(&self, now: DateTime<Utc>) -> PathBuf {
        self.dir.join(format!("{}.jsonl", now.format("%Y-%m-%dT%H")))
    }

    /// Oldest first; the unsplit single file, when present, before every segment.
    pub(crate) fn segments(&self) -> Vec<PathBuf> {
        let mut segments = Vec::new();
        if self.legacy.is_file() {
            segments.push(self.legacy.clone());
        }
        let mut names = fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .filter(|name| is_segment_name(name))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        segments.extend(names.into_iter().map(|name| self.dir.join(name)));
        segments
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.segments().is_empty()
    }

    pub(crate) fn append_line(&self, line: &str) -> Result<PathBuf> {
        let path = self.segment_path(Utc::now());
        fs::create_dir_all(&self.dir)?;
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "{line}")?;
        Ok(path)
    }

    pub(crate) fn append(&self, record: &Value) -> Result<PathBuf> {
        self.append_line(&serde_json::to_string(record)?)
    }

    /// Every non-blank line, oldest first, one line in memory at a time.
    pub(crate) fn for_each_line(&self, mut visit: impl FnMut(&str)) -> Result<()> {
        for segment in self.segments() {
            let mut reader = BufReader::with_capacity(1 << 20, fs::File::open(&segment)?);
            let mut bytes = Vec::new();
            loop {
                bytes.clear();
                if reader.read_until(b'\n', &mut bytes)? == 0 {
                    break;
                }
                let line = String::from_utf8_lossy(&bytes);
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    visit(trimmed);
                }
            }
        }
        Ok(())
    }

    /// The newest segments, oldest first, that together fit in `max_bytes`
    /// (always at least the newest one).
    pub(crate) fn newest_within(&self, max_bytes: u64) -> Vec<PathBuf> {
        let mut kept = Vec::new();
        let mut total = 0u64;
        for segment in self.segments().into_iter().rev() {
            let size = fs::metadata(&segment).map(|meta| meta.len()).unwrap_or(0);
            if !kept.is_empty() && total + size > max_bytes {
                break;
            }
            total += size;
            kept.push(segment);
        }
        kept.reverse();
        kept
    }
}

pub(crate) fn labdirector_decision_log(paths: &AppPaths, cycle_id: &str) -> SegmentedLog {
    SegmentedLog::replacing(
        &paths
            .runtime_root
            .join("runtime")
            .join(format!("{cycle_id}-labdirector-decisions.jsonl")),
    )
}

pub(crate) fn labdirector_inbox_log(paths: &AppPaths, cycle_id: &str) -> SegmentedLog {
    SegmentedLog::replacing(&super::labdirector_inbox_path(paths, cycle_id))
}

pub(crate) fn chronicle_report_log(paths: &AppPaths, cycle_id: &str) -> SegmentedLog {
    SegmentedLog::replacing(&super::chronicle_reports_path(paths, cycle_id))
}

pub(crate) fn labdirector_dialogue_log(paths: &AppPaths, cycle_id: &str) -> SegmentedLog {
    SegmentedLog::replacing(
        &paths
            .runtime_root
            .join("events")
            .join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
    )
}

pub(crate) fn delivery_receipt_log(paths: &AppPaths, cycle_id: &str) -> SegmentedLog {
    SegmentedLog::replacing(
        &paths
            .runtime_root
            .join("messages")
            .join(cycle_id)
            .join("delivery-receipts.jsonl"),
    )
}
