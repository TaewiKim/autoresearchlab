use anyhow::Result;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub(crate) fn json_file_window_text(path: &Path, max_window_bytes: u64) -> Result<String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let metadata = fs::metadata(path)?;
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
