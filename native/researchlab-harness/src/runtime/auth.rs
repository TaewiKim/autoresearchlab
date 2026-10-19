use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::env;
use std::path::PathBuf;

use crate::core::model::{AppPaths, AuthState};
use crate::core::support::{now_iso, read_json, researchlab_auth_path, write_json};

pub fn import_codex_auth(paths: &AppPaths) -> Result<PathBuf> {
    let home = env::var("HOME").context("HOME is not set")?;
    let source = PathBuf::from(home).join(".codex").join("auth.json");
    if !source.exists() {
        bail!("missing Codex auth file: {}", source.display());
    }
    let payload = read_json(&source)?;
    let tokens = payload.get("tokens").cloned().unwrap_or_else(|| json!({}));
    let exported = json!({
        "provider": "codex-compatible",
        "imported_at": now_iso(),
        "source_path": source,
        "auth_mode": payload.get("auth_mode").cloned().unwrap_or(Value::Null),
        "last_refresh": payload.get("last_refresh").cloned().unwrap_or(Value::Null),
        "OPENAI_API_KEY": payload.get("OPENAI_API_KEY").cloned().unwrap_or(Value::Null),
        "tokens": {
            "access_token": tokens.get("access_token").cloned().unwrap_or(Value::Null),
            "refresh_token": tokens.get("refresh_token").cloned().unwrap_or(Value::Null),
            "id_token": tokens.get("id_token").cloned().unwrap_or(Value::Null),
            "account_id": tokens.get("account_id").cloned().unwrap_or(Value::Null)
        }
    });
    let target = researchlab_auth_path(paths);
    write_json(&target, &exported)?;
    Ok(target)
}

pub fn auth_status(paths: &AppPaths) -> Result<AuthState> {
    let path = researchlab_auth_path(paths);
    if !path.exists() {
        return Ok(AuthState {
            source: "researchlab".to_string(),
            imported_at: String::new(),
            auth_mode: None,
            has_api_key: false,
            has_access_token: false,
            has_refresh_token: false,
            account_id: None,
        });
    }
    let payload = read_json(&path)?;
    let tokens = payload.get("tokens").cloned().unwrap_or_else(|| json!({}));
    Ok(AuthState {
        source: payload
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("researchlab")
            .to_string(),
        imported_at: payload
            .get("imported_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        auth_mode: payload
            .get("auth_mode")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        has_api_key: payload
            .get("OPENAI_API_KEY")
            .map(|item| !item.is_null())
            .unwrap_or(false),
        has_access_token: tokens
            .get("access_token")
            .map(|item| !item.is_null())
            .unwrap_or(false),
        has_refresh_token: tokens
            .get("refresh_token")
            .map(|item| !item.is_null())
            .unwrap_or(false),
        account_id: tokens
            .get("account_id")
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}
