#![allow(unused_imports)]
use super::*;
use std::collections::BTreeSet;
use super::problem_selection::expert_cards_status;

// --- reference code and checkpoints the cards name ---------------------------------
//
// MEASURED ON cycle-a-20260919, 2026-11-09. Every slate candidate failed
// feasibility on the reproduction anchor -- one number a SOTA card reports,
// reproduced here before the new experiment -- because the paper's official code
// and checkpoint had no local copy: the cards' `local_copy_path` named a Windows
// directory (`D:/projects/reference-repos/...`) that the cycle's container
// never mounted. Selection then looped for a day, a director declining each
// restart for want of a candidate and a candidate failing each audit for want of
// the source. Nobody was responsible for having the sources.
//
// The harness is. From the cards it plans what to fetch -- source repositories on
// the allowlisted hosts, and checkpoints whose stated size fits the caps -- and a
// detached driver (`drivers/reference/fetch_reference_assets.py`) fetches them
// into the cycle's reference root, recording the commit or the sha256 of each. The
// run loop never waits on it; feasibility waits only while a fetch is in flight, so
// the audit sees what arrived. Nothing downloaded is executed here.

const REFERENCE_DRIVER: &str = "drivers/reference/fetch_reference_assets.py";
/// A running fetch that has not refreshed its state for this long is dead.
const FETCH_HEARTBEAT_SECONDS: i64 = 20 * 60;
/// A partial fetch (a network failure) is retried after this long, not in a loop.
const FETCH_RETRY_SECONDS: i64 = 6 * 60 * 60;

pub(crate) fn reference_assets_enabled() -> bool {
    !matches!(
        env::var("RESEARCHLAB_REFERENCE_ASSETS").ok().map(|value| value.trim().to_ascii_lowercase()).as_deref(),
        Some("0") | Some("false") | Some("off") | Some("no")
    )
}

pub(crate) fn reference_root(paths: &AppPaths) -> PathBuf {
    env::var("RESEARCHLAB_REFERENCE_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.runtime_root.join("reference"))
}

fn reference_state_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-reference-assets.json"))
}

fn reference_plan_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-reference-assets-plan.json"))
}

fn cap_gb(name: &str, default: f64) -> f64 {
    env::var(name).ok().and_then(|value| value.trim().parse::<f64>().ok()).filter(|value| *value > 0.0).unwrap_or(default)
}

fn url_parts(url: &str) -> Option<(String, Vec<String>)> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/')?;
    let segments: Vec<String> = path
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect();
    (segments.len() >= 2).then(|| (host.to_ascii_lowercase(), segments))
}

/// What to fetch for these cards. Pure: the same cards give the same plan.
pub(crate) fn reference_assets_plan(cards: &[Value]) -> Vec<Value> {
    let max_asset = cap_gb("RESEARCHLAB_REFERENCE_MAX_ASSET_GB", 5.0);
    let max_total = cap_gb("RESEARCHLAB_REFERENCE_MAX_TOTAL_GB", 12.0);
    let mut seen = BTreeSet::new();
    let mut planned = Vec::new();
    let mut total_gb = 0.0_f64;
    for card in cards {
        let assets = card.get("assets").unwrap_or(&Value::Null);
        // A card whose local copy is really here needs nothing.
        let local_present = assets
            .get("local_copy_path")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.trim().is_empty() && Path::new(path).exists());
        for code in assets.get("code").and_then(Value::as_array).into_iter().flatten() {
            let Some(url) = code.get("url").and_then(Value::as_str) else { continue };
            let Some((host, segments)) = url_parts(url) else { continue };
            if host != "github.com" || local_present {
                continue;
            }
            let repo = segments[1].trim_end_matches(".git").to_string();
            let id = format!("git:{}/{}", segments[0].to_ascii_lowercase(), repo.to_ascii_lowercase());
            if seen.insert(id.clone()) {
                planned.push(json!({
                    "id": id, "kind": "git", "url": format!("https://github.com/{}/{}", segments[0], repo),
                    "name": repo, "card_paper_id": card.get("paper_id"), "card_title": card.get("title"),
                }));
            }
        }
        for checkpoint in assets.get("checkpoints").and_then(Value::as_array).into_iter().flatten() {
            let Some(url) = checkpoint.get("url").and_then(Value::as_str) else { continue };
            let Some((host, segments)) = url_parts(url) else { continue };
            if host != "huggingface.co" {
                continue;
            }
            let size_gb = checkpoint.get("size_gb").and_then(Value::as_f64);
            if size_gb.is_some_and(|size| size > max_asset || total_gb + size > max_total) {
                continue;
            }
            let id = format!("hf:{}/{}", segments[0].to_ascii_lowercase(), segments[1].to_ascii_lowercase());
            if seen.insert(id.clone()) {
                total_gb += size_gb.unwrap_or(0.0);
                planned.push(json!({
                    "id": id, "kind": "hf", "url": format!("https://huggingface.co/{}/{}", segments[0], segments[1]),
                    "name": format!("{}-{}", segments[0], segments[1]), "size_gb": size_gb,
                    "card_paper_id": card.get("paper_id"), "card_title": card.get("title"),
                }));
            }
        }
    }
    planned
}

fn plan_fingerprint(items: &[Value]) -> String {
    let ids: Vec<&str> = items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).collect();
    sha256_hex(ids.join("\n").as_bytes())
}

fn seconds_since(text: Option<&str>) -> Option<i64> {
    let at = chrono::DateTime::parse_from_rfc3339(text?).ok()?;
    Some((Utc::now() - at.with_timezone(&Utc)).num_seconds())
}

/// A fetch is in flight: it says running and has refreshed its state lately.
pub(crate) fn reference_assets_running(paths: &AppPaths, cycle_id: &str) -> bool {
    let Ok(state) = read_json(&reference_state_path(paths, cycle_id)) else {
        return false;
    };
    state.get("status").and_then(Value::as_str) == Some("running")
        && seconds_since(state.get("updated_at").and_then(Value::as_str)).is_some_and(|age| age < FETCH_HEARTBEAT_SECONDS)
}

/// Start the fetch for this cycle's cards when it has not been done for this plan.
/// Returns whether a fetch was started. Never waits on it.
pub(crate) fn ensure_reference_assets(paths: &AppPaths, cycle_id: &str) -> Result<bool> {
    if !reference_assets_enabled() {
        return Ok(false);
    }
    let cards = expert_cards_status(paths, cycle_id);
    if cards.state != "ready" {
        return Ok(false);
    }
    let items = reference_assets_plan(&cards.cards);
    if items.is_empty() {
        return Ok(false);
    }
    let fingerprint = plan_fingerprint(&items);
    let state = read_json(&reference_state_path(paths, cycle_id)).ok();
    let planned_before = read_json(&reference_plan_path(paths, cycle_id))
        .ok()
        .and_then(|plan| plan.get("fingerprint").and_then(Value::as_str).map(ToString::to_string));
    if planned_before.as_deref() == Some(fingerprint.as_str()) {
        match state.as_ref().and_then(|state| state.get("status").and_then(Value::as_str)) {
            Some("complete") => return Ok(false),
            Some("running") if reference_assets_running(paths, cycle_id) => return Ok(false),
            Some("partial") => {
                let age = seconds_since(state.as_ref().and_then(|state| state.get("finished_at")).and_then(Value::as_str));
                if age.is_some_and(|age| age < FETCH_RETRY_SECONDS) {
                    return Ok(false);
                }
            }
            _ => {}
        }
    }
    let driver = paths.project_root.join(REFERENCE_DRIVER);
    if !driver.is_file() {
        return Ok(false);
    }
    write_json(&reference_plan_path(paths, cycle_id), &json!({"fingerprint": fingerprint, "items": items}))?;
    let python = env::var("RESEARCHLAB_PYTHON").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "python3".to_string());
    // Detached: the run loop goes on, and the fetch outlives the pass that started it.
    std::process::Command::new(&python)
        .arg(&driver)
        .arg("--plan-file")
        .arg(reference_plan_path(paths, cycle_id))
        .arg("--root")
        .arg(reference_root(paths))
        .arg("--state-file")
        .arg(reference_state_path(paths, cycle_id))
        .arg("--max-asset-gb")
        .arg(cap_gb("RESEARCHLAB_REFERENCE_MAX_ASSET_GB", 5.0).to_string())
        .current_dir(&paths.project_root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    append_event(
        &events_root(paths).join(format!("{cycle_id}-labdirector-dialogue.jsonl")),
        "reference_assets_fetch_started",
        json!({"cycle_id": cycle_id, "items": items.len(), "fingerprint": fingerprint}),
    )?;
    Ok(true)
}

fn reference_announced_path(paths: &AppPaths, cycle_id: &str) -> PathBuf {
    state_root(paths).join(format!("{cycle_id}-reference-assets-announced.json"))
}

/// The one message a director is owed when the sources arrive: due when a fetch
/// COMPLETED, the cycle has no live lead, and this plan has not been announced.
///
/// MEASURED ON cycle-a-20260919, 2026-11-10. The sources arrived after
/// the last director had already declined for want of them and nothing is
/// scheduled to ask again: the supervisor's "decision stalled" requests collapse
/// onto ids answered long ago. A change in what the director can see is a reason
/// to ask it once, not a reason to loop it.
pub(crate) fn reference_assets_announcement_due(paths: &AppPaths, cycle_id: &str) -> Option<(String, String)> {
    let state = read_json(&reference_state_path(paths, cycle_id)).ok()?;
    if state.get("status").and_then(Value::as_str) != Some("complete") {
        return None;
    }
    let fingerprint = read_json(&reference_plan_path(paths, cycle_id))
        .ok()?
        .get("fingerprint")
        .and_then(Value::as_str)?
        .to_string();
    let announced = read_json(&reference_announced_path(paths, cycle_id)).ok();
    if announced.as_ref().and_then(|value| value.get("fingerprint").and_then(Value::as_str)) == Some(fingerprint.as_str()) {
        return None;
    }
    let lead = read_json(&state_root(paths).join(format!("{cycle_id}-lab-director-hypothesis.json"))).ok();
    let live_lead = lead.as_ref().is_some_and(|lead| lead.get("status").and_then(Value::as_str) != Some("withdrawn"));
    if live_lead {
        return None;
    }
    let fetched: Vec<String> = state
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| matches!(item.get("status").and_then(Value::as_str), Some("fetched") | Some("present")))
        .map(|item| {
            format!(
                "{} -> {}",
                item.get("id").and_then(Value::as_str).unwrap_or("?"),
                item.get("path").and_then(Value::as_str).unwrap_or("?")
            )
        })
        .collect();
    let message = format!(
        "Reference code and checkpoints the SOTA cards name are now on this host: {}. The selection round's feasibility audit struck its candidates for want of the official source and checkpoint for the reproduction anchor; those are present now (see reference_assets in your context, with commits and sizes). The owner has released the slate requirement, so you may select a successor lead yourself. Decide whether one can now be selected and, if so, plan the reproduction anchor first against these local sources; if none can, say precisely what is still missing. Do not restate the earlier refusals: they were reached without these sources.",
        fetched.join("; ")
    );
    Some((fingerprint, message))
}

/// Ask a director once about the arrived sources. Returns the lane it opened.
pub(crate) fn announce_reference_assets(paths: &AppPaths, cycle_id: &str) -> Result<Vec<Value>> {
    let Some((fingerprint, message)) = reference_assets_announcement_due(paths, cycle_id) else {
        return Ok(Vec::new());
    };
    let objective = dispatch_cycle_objective(paths, cycle_id)?;
    let item = json!({
        "type": "supervisor_instruction",
        "payload": {
            "issue_code": "reference_assets_available",
            "severity": "process_attention",
            "message": message,
        }
    });
    let lanes = spawn_supervisor_labdirector_followup(paths, cycle_id, &objective, &item)?;
    write_json(
        &reference_announced_path(paths, cycle_id),
        &json!({"fingerprint": fingerprint, "announced_at": now_iso(), "lanes": lanes.iter().filter_map(|lane| lane.get("lane_id").cloned()).collect::<Vec<_>>()}),
    )?;
    Ok(lanes)
}

/// What is on disk, for the audit and the directors.
pub(crate) fn reference_assets_summary(paths: &AppPaths, cycle_id: &str) -> Value {
    let root = reference_root(paths);
    let Ok(state) = read_json(&reference_state_path(paths, cycle_id)) else {
        return json!({"root": root, "status": "not_fetched"});
    };
    let items: Vec<Value> = state
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| {
            json!({
                "id": item.get("id"),
                "kind": item.get("kind"),
                "url": item.get("url"),
                "status": item.get("status"),
                "local_path": item.get("path"),
                "commit": item.get("commit"),
                "bytes": item.get("bytes"),
                "error": item.get("error"),
            })
        })
        .collect();
    json!({
        "root": root,
        "status": state.get("status"),
        "measured_by": "the harness fetched these from the allowlisted hosts into the reference root; nothing was executed",
        "items": items,
        "use": "A source or checkpoint listed here as fetched or present IS available locally at local_path: use it, and do not report it unavailable. A card's own local_copy_path that names another machine's directory is not this host's copy.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(title: &str, code: &[&str], checkpoints: &[(&str, Option<f64>)], local: Option<&str>) -> Value {
        json!({
            "paper_id": format!("p-{title}"), "title": title,
            "assets": {
                "code": code.iter().map(|url| json!({"url": url})).collect::<Vec<_>>(),
                "checkpoints": checkpoints.iter().map(|(url, size)| json!({"url": url, "size_gb": size})).collect::<Vec<_>>(),
                "local_copy_path": local,
            }
        })
    }

    #[test]
    fn the_plan_takes_only_allowlisted_hosts_within_the_caps_once_each() {
        let cards = vec![
            card(
                "dp",
                &["https://github.com/real-stanford/diffusion_policy", "https://gitlab.com/x/y", "http://github.com/a/b"],
                &[
                    ("https://huggingface.co/lerobot/diffusion_pusht", Some(4.2)),
                    ("https://drive.google.com/file/d/abc", Some(1.0)),
                    ("https://huggingface.co/big/model", Some(9.0)),
                ],
                None,
            ),
            // The same repository under another card is fetched once.
            card("dup", &["https://github.com/Real-Stanford/diffusion_policy.git"], &[], None),
            // A copy that really is here needs nothing.
            card("local", &["https://github.com/owner/present"], &[], Some(".")),
            // A checkpoint that would push the total past the cap is left out.
            card("c2", &[], &[("https://huggingface.co/a/one", Some(4.5)), ("https://huggingface.co/a/two", Some(4.5))], None),
        ];
        let ids: Vec<String> = reference_assets_plan(&cards)
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            ids,
            vec![
                "git:real-stanford/diffusion_policy",
                "hf:lerobot/diffusion_pusht",
                "hf:a/one",
            ],
            "{ids:?}"
        );
    }

    #[test]
    fn the_director_is_asked_once_when_the_sources_arrive_and_only_without_a_live_lead() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        fs::create_dir_all(state_root(&paths)).unwrap();
        let cycle = "ann";
        let lead = state_root(&paths).join(format!("{cycle}-lab-director-hypothesis.json"));
        assert!(reference_assets_announcement_due(&paths, cycle).is_none(), "nothing fetched");
        write_json(&reference_plan_path(&paths, cycle), &json!({"fingerprint": "fp1", "items": []})).unwrap();
        write_json(&reference_state_path(&paths, cycle), &json!({"status": "running", "items": []})).unwrap();
        assert!(reference_assets_announcement_due(&paths, cycle).is_none(), "not complete");
        write_json(&reference_state_path(&paths, cycle), &json!({"status": "complete", "items": [
            {"id": "git:real-stanford/diffusion_policy", "status": "fetched", "path": "/r/dp"}]})).unwrap();
        let (fingerprint, message) = reference_assets_announcement_due(&paths, cycle).expect("due once complete");
        assert_eq!(fingerprint, "fp1");
        assert!(message.contains("git:real-stanford/diffusion_policy -> /r/dp"), "{message}");
        // A live lead is working; it is not interrupted.
        write_json(&lead, &json!({"status": "active"})).unwrap();
        assert!(reference_assets_announcement_due(&paths, cycle).is_none());
        // A withdrawn lead is the case.
        write_json(&lead, &json!({"status": "withdrawn"})).unwrap();
        assert!(reference_assets_announcement_due(&paths, cycle).is_some());
        // Announced for this plan: never again. A new plan is announced afresh.
        write_json(&reference_announced_path(&paths, cycle), &json!({"fingerprint": "fp1"})).unwrap();
        assert!(reference_assets_announcement_due(&paths, cycle).is_none());
        write_json(&reference_plan_path(&paths, cycle), &json!({"fingerprint": "fp2", "items": []})).unwrap();
        assert!(reference_assets_announcement_due(&paths, cycle).is_some());
    }

    #[test]
    fn a_plan_is_the_same_plan_for_the_same_cards() {
        let cards = vec![card("dp", &["https://github.com/real-stanford/diffusion_policy"], &[], None)];
        let first = plan_fingerprint(&reference_assets_plan(&cards));
        assert_eq!(first, plan_fingerprint(&reference_assets_plan(&cards)));
        let more = vec![card("dp", &["https://github.com/real-stanford/diffusion_policy", "https://github.com/a/b"], &[], None)];
        assert_ne!(first, plan_fingerprint(&reference_assets_plan(&more)));
    }

    #[test]
    fn a_fetch_in_flight_is_recognised_by_its_heartbeat_and_a_dead_one_is_not() {
        let temp = tempfile::TempDir::new().unwrap();
        let paths = AppPaths {
            project_root: temp.path().to_path_buf(),
            runtime_root: temp.path().join(".research-lab"),
            data_root: temp.path().join("data"),
            stats_driver_script: PathBuf::new(),
            literature_driver_script: PathBuf::new(),
        };
        fs::create_dir_all(state_root(&paths)).unwrap();
        let cycle = "ref";
        assert!(!reference_assets_running(&paths, cycle));
        write_json(&reference_state_path(&paths, cycle), &json!({"status": "running", "updated_at": now_iso(), "items": []})).unwrap();
        assert!(reference_assets_running(&paths, cycle));
        write_json(
            &reference_state_path(&paths, cycle),
            &json!({"status": "running", "updated_at": (Utc::now() - chrono::Duration::hours(2)).to_rfc3339(), "items": []}),
        )
        .unwrap();
        assert!(!reference_assets_running(&paths, cycle), "a fetch that stopped refreshing is dead");
        write_json(&reference_state_path(&paths, cycle), &json!({"status": "complete", "updated_at": now_iso(), "items": [
            {"id": "git:a/b", "kind": "git", "status": "fetched", "path": "/r/a-b", "commit": "abc"}]})).unwrap();
        let summary = reference_assets_summary(&paths, cycle);
        assert_eq!(summary["items"][0]["local_path"], json!("/r/a-b"));
        assert!(summary["use"].as_str().unwrap().contains("IS available locally"));
    }
}
