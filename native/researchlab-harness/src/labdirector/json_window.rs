use anyhow::Result;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(crate) fn json_file_window_text(path: &Path, max_window_bytes: u64) -> Result<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata = fs::metadata(path)?;
    // A file that two windows would cover is read once. Reading a head and a
    // tail of one that is shorter than both repeats its middle: on
    // one long cycle the 9.3 KB memory summary went into every
    // director, analyst, author and gatekeeper prompt as 16 KB, 6.7 KB of it
    // twice. Every caller searches the text or shows it, so the whole file is
    // never less than the two windows were.
    if metadata.len() <= max_window_bytes.saturating_mul(2) {
        return Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned());
    }
    let mut file = fs::File::open(path)?;
    let mut windows = vec![0u64];
    if metadata.len() > max_window_bytes {
        windows.push(metadata.len().saturating_sub(max_window_bytes));
    }
    windows.sort_unstable();
    windows.dedup();
    let mut text = String::new();
    for start in windows {
        file.seek(SeekFrom::Start(start))?;
        let to_read = std::cmp::min(max_window_bytes, metadata.len().saturating_sub(start));
        let mut buffer = vec![0u8; to_read as usize];
        let bytes_read = file.read(&mut buffer)?;
        text.push_str(&String::from_utf8_lossy(&buffer[..bytes_read]));
    }
    Ok(text)
}

pub(crate) fn json_top_level_bool_window(path: &Path, key: &str) -> Result<Option<bool>> {
    let window = json_file_window_text(path, 64_000)?;
    let compact: String = window.chars().filter(|c| !c.is_whitespace()).collect();
    let true_token = format!("\"{key}\":true");
    if compact.contains(&true_token) {
        return Ok(Some(true));
    }
    let false_token = format!("\"{key}\":false");
    if compact.contains(&false_token) {
        return Ok(Some(false));
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::json_file_window_text;
    use std::fs;

    #[test]
    fn a_file_two_windows_would_cover_is_read_once_not_with_its_middle_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory_summary.md");
        let text = format!("{}MIDDLE{}", "a".repeat(5_000), "b".repeat(4_000));
        fs::write(&path, &text).unwrap();
        let window = json_file_window_text(&path, 8_000).unwrap();
        assert_eq!(window, text);
        assert_eq!(window.matches("MIDDLE").count(), 1);
    }

    #[test]
    fn a_long_file_still_gives_its_head_and_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.json");
        let text = format!("HEAD{}TAIL", "x".repeat(30_000));
        fs::write(&path, &text).unwrap();
        let window = json_file_window_text(&path, 1_000).unwrap();
        assert_eq!(window.len(), 2_000);
        assert!(window.starts_with("HEAD") && window.ends_with("TAIL"));
    }
}
