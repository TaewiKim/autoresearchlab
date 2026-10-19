use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::fs::{self, read_dir};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::core::model::AppPaths;
use crate::core::support::{cycle_lanes_root, now_iso, read_json, write_json};

pub(crate) fn contract_index_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("indexes")
        .join(format!("{cycle_id}-contracts.json"))
}

pub(crate) fn contract_queue_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    paths
        .runtime_root
        .join("queues")
        .join(format!("{cycle_id}-contract-queue.json"))
}

pub(crate) fn pipeline_queue_db_path(paths: &AppPaths) -> PathBuf {
    paths.runtime_root.join("queues").join("pipeline.sqlite")
}

pub(crate) fn open_pipeline_queue_db(paths: &AppPaths) -> Result<Connection> {
    let db_path = pipeline_queue_db_path(paths);
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(&db_path)
        .with_context(|| format!("failed to open pipeline queue db {}", db_path.display()))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS pipeline_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cycle_id TEXT NOT NULL,
            lane_id TEXT NOT NULL,
            role TEXT NOT NULL,
            runtime_class TEXT NOT NULL,
            mode TEXT NOT NULL,
            action_type TEXT,
            source_brief_id TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            priority INTEGER NOT NULL DEFAULT 100,
            sequence INTEGER NOT NULL,
            depends_on_lane_id TEXT,
            contract_path TEXT NOT NULL,
            role_plan_path TEXT,
            dedupe_key TEXT NOT NULL UNIQUE,
            claimed_by TEXT,
            claimed_at TEXT,
            lease_expires_at TEXT,
            completed_at TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(cycle_id, lane_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_queue_cycle_status_sequence
            ON pipeline_queue(cycle_id, status, sequence);
        CREATE INDEX IF NOT EXISTS idx_pipeline_queue_cycle_lane
            ON pipeline_queue(cycle_id, lane_id);
        CREATE INDEX IF NOT EXISTS idx_pipeline_queue_cycle_action
            ON pipeline_queue(cycle_id, action_type, source_brief_id);
        ",
    )?;
    Ok(conn)
}

pub(crate) fn upsert_sqlite_contract_queue(
    paths: &AppPaths,
    cycle_id: &str,
    contract_path: &Path,
    lane_id: &str,
    role: &str,
    runtime_class: &str,
    mode: &str,
) -> Result<()> {
    let conn = open_pipeline_queue_db(paths)?;
    let dedupe_key = format!("{cycle_id}::{lane_id}");
    let existing: Option<(i64, String)> = conn
        .query_row(
            "SELECT sequence, created_at FROM pipeline_queue WHERE dedupe_key = ?1",
            params![dedupe_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let next_sequence: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM pipeline_queue WHERE cycle_id = ?1",
        params![cycle_id],
        |row| row.get(0),
    )?;
    let now = now_iso();
    let (sequence, created_at) = existing.unwrap_or_else(|| (next_sequence, now.clone()));
    conn.execute(
        "
        INSERT INTO pipeline_queue (
            cycle_id, lane_id, role, runtime_class, mode, status, priority, sequence,
            contract_path, dedupe_key, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 100, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(dedupe_key) DO UPDATE SET
            role = excluded.role,
            runtime_class = excluded.runtime_class,
            mode = excluded.mode,
            contract_path = excluded.contract_path,
            status = CASE
                WHEN pipeline_queue.status IN ('running', 'completed', 'failed', 'dead')
                    THEN pipeline_queue.status
                ELSE excluded.status
            END,
            updated_at = excluded.updated_at
        ",
        params![
            cycle_id,
            lane_id,
            role,
            runtime_class,
            mode,
            sequence,
            contract_path.display().to_string(),
            dedupe_key,
            created_at,
            now,
        ],
    )?;
    Ok(())
}

pub(crate) fn read_contract_queue(paths: &AppPaths, cycle_id: &str) -> Result<Option<Vec<Value>>> {
    let queue_path = contract_queue_path(paths, cycle_id);
    if !queue_path.exists() {
        return Ok(None);
    }
    let value = read_json(&queue_path)?;
    Ok(value
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned()))
}

pub(crate) fn write_contract_queue(
    paths: &AppPaths,
    cycle_id: &str,
    items: &[Value],
) -> Result<()> {
    let queue_path = contract_queue_path(paths, cycle_id);
    write_json(
        &queue_path,
        &json!({
            "cycle_id": cycle_id,
            "queue_kind": "lane_contract_pipeline",
            "generated_at": now_iso(),
            "source_of_truth": "contract queue for core execution ordering; JSONL inbox remains observational/dialogue history",
            "items": items,
        }),
    )
}

pub(crate) fn upsert_contract_queue(
    paths: &AppPaths,
    cycle_id: &str,
    contract_path: &Path,
    lane_id: &str,
    role: &str,
    runtime_class: &str,
    mode: &str,
) -> Result<()> {
    upsert_sqlite_contract_queue(
        paths,
        cycle_id,
        contract_path,
        lane_id,
        role,
        runtime_class,
        mode,
    )?;
    let contract_path_text = contract_path.display().to_string();
    let mut items = read_contract_queue(paths, cycle_id)?.unwrap_or_default();
    let next_sequence = items
        .iter()
        .filter_map(|item| item.get("sequence").and_then(Value::as_u64))
        .max()
        .unwrap_or(0)
        + 1;
    let existing_index = items.iter().position(|item| {
        item.get("lane_id").and_then(Value::as_str) == Some(lane_id)
            || item.get("contract_path").and_then(Value::as_str)
                == Some(contract_path_text.as_str())
    });
    let (sequence, enqueued_at) = existing_index
        .and_then(|index| {
            let item = items.get(index)?;
            Some((
                item.get("sequence")
                    .and_then(Value::as_u64)
                    .unwrap_or(next_sequence),
                item.get("enqueued_at")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(now_iso),
            ))
        })
        .unwrap_or_else(|| (next_sequence, now_iso()));
    let entry = json!({
        "sequence": sequence,
        "queue_kind": "lane_contract_pipeline",
        "status": "queued",
        "cycle_id": cycle_id,
        "lane_id": lane_id,
        "role": role,
        "runtime_class": runtime_class,
        "mode": mode,
        "contract_path": contract_path_text,
        "dedupe_key": format!("{cycle_id}::{lane_id}"),
        "enqueued_at": enqueued_at,
        "updated_at": now_iso(),
    });
    if let Some(index) = existing_index {
        items[index] = entry;
    } else {
        items.push(entry);
    }
    items.sort_by(|a, b| {
        a.get("sequence")
            .and_then(Value::as_u64)
            .cmp(&b.get("sequence").and_then(Value::as_u64))
            .then_with(|| {
                a.get("lane_id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("lane_id").and_then(Value::as_str))
            })
    });
    write_contract_queue(paths, cycle_id, &items)
}

pub(crate) fn annotate_contract_queue_role_plan(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    role_plan_path: &Path,
    action_type: &str,
    source_brief_id: &str,
) -> Result<()> {
    let conn = open_pipeline_queue_db(paths)?;
    let updated = conn.execute(
        "
        UPDATE pipeline_queue
        SET role_plan_path = ?1,
            action_type = ?2,
            source_brief_id = ?3,
            status = CASE WHEN status = 'queued' THEN 'planned' ELSE status END,
            updated_at = ?4
        WHERE cycle_id = ?5 AND lane_id = ?6
        ",
        params![
            role_plan_path.display().to_string(),
            action_type,
            source_brief_id,
            now_iso(),
            cycle_id,
            lane_id,
        ],
    )?;
    if updated == 0 {
        // Legacy/manual lanes may have a role-plan without a queue row. Keep
        // that non-fatal so contract-index fallback can still recover them.
    }
    let mut items = read_contract_queue(paths, cycle_id)?.unwrap_or_default();
    let Some(index) = items
        .iter()
        .position(|item| item.get("lane_id").and_then(Value::as_str) == Some(lane_id))
    else {
        return Ok(());
    };
    items[index]["role_plan_path"] = json!(role_plan_path.display().to_string());
    items[index]["action_type"] = json!(action_type);
    items[index]["source_brief_id"] = json!(source_brief_id);
    items[index]["status"] = json!("planned");
    items[index]["updated_at"] = json!(now_iso());
    write_contract_queue(paths, cycle_id, &items)
}

pub(crate) fn update_sqlite_contract_queue_status(
    paths: &AppPaths,
    cycle_id: &str,
    lane_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let db_path = pipeline_queue_db_path(paths);
    if !db_path.exists() {
        return Ok(());
    }
    let conn = open_pipeline_queue_db(paths)?;
    let now = now_iso();
    conn.execute(
        "
        UPDATE pipeline_queue
        SET status = ?1,
            claimed_by = CASE
                WHEN ?1 IN ('spawned', 'running') THEN ?2
                ELSE claimed_by
            END,
            claimed_at = CASE
                WHEN ?1 IN ('spawned', 'running') AND claimed_at IS NULL THEN ?3
                ELSE claimed_at
            END,
            lease_expires_at = CASE
                WHEN ?1 IN ('spawned', 'running') THEN datetime('now', '+2 hours')
                ELSE lease_expires_at
            END,
            completed_at = CASE
                WHEN ?1 IN ('completed', 'prepared', 'failed', 'dead') THEN ?3
                ELSE completed_at
            END,
            error = ?4,
            updated_at = ?3
        WHERE cycle_id = ?5 AND lane_id = ?6
        ",
        params![
            status,
            format!("researchlab-harness:{}", std::process::id()),
            now,
            error,
            cycle_id,
            lane_id,
        ],
    )?;
    Ok(())
}

pub(crate) fn contract_paths_from_sqlite_queue(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Vec<PathBuf>> {
    let db_path = pipeline_queue_db_path(paths);
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_pipeline_queue_db(paths)?;
    let mut stmt = conn.prepare(
        "
        SELECT contract_path
        FROM pipeline_queue
        WHERE cycle_id = ?1
          AND status NOT IN ('dead')
        ORDER BY sequence ASC, id ASC
        ",
    )?;
    let paths_iter = stmt.query_map(params![cycle_id], |row| row.get::<_, String>(0))?;
    let mut paths_out = Vec::new();
    for item in paths_iter {
        let path = PathBuf::from(item?);
        if path.exists() {
            paths_out.push(path);
        }
    }
    Ok(paths_out)
}

pub(crate) fn contract_paths_from_queue(paths: &AppPaths, cycle_id: &str) -> Result<Vec<PathBuf>> {
    let mut entries = read_contract_queue(paths, cycle_id)?.unwrap_or_default();
    entries.sort_by(|a, b| {
        a.get("sequence")
            .and_then(Value::as_u64)
            .cmp(&b.get("sequence").and_then(Value::as_u64))
            .then_with(|| {
                a.get("lane_id")
                    .and_then(Value::as_str)
                    .cmp(&b.get("lane_id").and_then(Value::as_str))
            })
    });
    Ok(entries
        .into_iter()
        .filter_map(|item| {
            item.get("contract_path")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .filter(|path| path.exists())
        .collect())
}

pub(crate) fn sort_dedup_contract_paths(mut contracts: Vec<PathBuf>) -> Vec<PathBuf> {
    contracts.sort();
    contracts.dedup();
    contracts
}

pub(crate) fn normalize_existing_contract_paths(contracts: Vec<PathBuf>) -> Vec<PathBuf> {
    sort_dedup_contract_paths(contracts)
        .into_iter()
        .filter(|path| path.exists())
        .collect()
}

pub(crate) fn read_contract_index(
    paths: &AppPaths,
    cycle_id: &str,
) -> Result<Option<Vec<PathBuf>>> {
    let index_path = contract_index_path(paths, cycle_id);
    if !index_path.exists() {
        return Ok(None);
    }
    let value = read_json(&index_path)?;
    let entries = value
        .get("contracts")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| value.as_array().cloned())
        .unwrap_or_default();
    let contracts = entries
        .into_iter()
        .filter_map(|item| item.as_str().map(PathBuf::from))
        .collect::<Vec<_>>();
    Ok(Some(sort_dedup_contract_paths(contracts)))
}

pub(crate) fn write_contract_index(
    paths: &AppPaths,
    cycle_id: &str,
    contracts: &[PathBuf],
) -> Result<()> {
    let index_path = contract_index_path(paths, cycle_id);
    let contracts = sort_dedup_contract_paths(contracts.to_vec())
        .into_iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    write_json(
        &index_path,
        &json!({
            "cycle_id": cycle_id,
            "generated_at": now_iso(),
            "contracts": contracts,
        }),
    )
}

pub(crate) fn rebuild_contract_index(paths: &AppPaths, cycle_id: &str) -> Result<Vec<PathBuf>> {
    let lanes_dir = cycle_lanes_root(paths, cycle_id);
    let mut contracts = Vec::new();
    if !lanes_dir.exists() {
        write_contract_index(paths, cycle_id, &contracts)?;
        return Ok(contracts);
    }
    for entry in read_dir(lanes_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let contract_path = entry.path().join("lane-contract.json");
        if contract_path.exists() {
            contracts.push(contract_path);
        }
    }
    contracts = normalize_existing_contract_paths(contracts);
    write_contract_index(paths, cycle_id, &contracts)?;
    Ok(contracts)
}

pub(crate) fn upsert_contract_index(
    paths: &AppPaths,
    cycle_id: &str,
    contract_path: &Path,
) -> Result<()> {
    let index_path = contract_index_path(paths, cycle_id);
    let mut contracts = if index_path.exists() {
        read_contract_index(paths, cycle_id)?.unwrap_or_else(|| vec![contract_path.to_path_buf()])
    } else {
        rebuild_contract_index(paths, cycle_id)?
    };
    contracts.push(contract_path.to_path_buf());
    write_contract_index(paths, cycle_id, &contracts)
}

pub(crate) fn all_cycle_contract_paths(paths: &AppPaths, cycle_id: &str) -> Result<Vec<PathBuf>> {
    let lanes_dir = cycle_lanes_root(paths, cycle_id);
    if !lanes_dir.exists() {
        return Ok(Vec::new());
    }
    let index_path = contract_index_path(paths, cycle_id);
    // Contract creation/upsert is the authoritative write path for active
    // cycles. Do not invalidate a large cycle's index just because the lanes
    // directory mtime changed: that forces a full 9p directory scan on every
    // supervisor/run-plan pass and stalls long-running cycles with hundreds of
    // lanes. Legacy cycles without an index still get a one-time rebuild.
    let indexed_contracts = if index_path.exists() {
        read_contract_index(paths, cycle_id)?.unwrap_or_default()
    } else {
        rebuild_contract_index(paths, cycle_id)?
    };
    let mut queued_contracts = contract_paths_from_sqlite_queue(paths, cycle_id)?;
    if queued_contracts.is_empty() {
        queued_contracts = contract_paths_from_queue(paths, cycle_id)?;
    }
    let mut seen = queued_contracts
        .iter()
        .map(|path| path.display().to_string())
        .collect::<std::collections::HashSet<_>>();
    for contract in indexed_contracts {
        let key = contract.display().to_string();
        if seen.insert(key) && contract.exists() {
            queued_contracts.push(contract);
        }
    }
    Ok(queued_contracts)
}
