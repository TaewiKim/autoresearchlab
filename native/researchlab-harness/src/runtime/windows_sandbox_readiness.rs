//! Read-only admission checks. Never run the elevated setup helper as a probe.
#[cfg(windows)]
use anyhow::anyhow;
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

pub(crate) const SCHOLARLY_PROXY_PORTS: [u16; 2] = [3128, 8081];

/// Exclusive ownership of the fixed ports used by a host scholarly Codex.
pub(crate) struct ScholarlyProxyLease {
    #[cfg(windows)]
    handle: *mut std::ffi::c_void,
}

#[cfg(windows)]
impl Drop for ScholarlyProxyLease {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn ReleaseMutex(handle: *mut std::ffi::c_void) -> i32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

/// Wait until no other ResearchLab host lane owns the scholarly proxy ports.
///
/// The Windows named mutex is released by the OS if its owner exits, including
/// after a crash. An abandoned mutex is therefore safe for the next lane to use.
pub(crate) fn acquire_scholarly_proxy_lease() -> Result<ScholarlyProxyLease> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateMutexW(
                attributes: *mut std::ffi::c_void,
                initial_owner: i32,
                name: *const u16,
            ) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
            fn GetLastError() -> u32;
        }

        let name: Vec<u16> = "Local\\ResearchLabScholarlyProxyPorts-3128-8081\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(anyhow!(
                "cannot create scholarly proxy port mutex (Windows error {})",
                unsafe { GetLastError() }
            ));
        }
        // MEASURED ON cycle-a-20260919, 2026-09-19. gatekeeper-02
        // treated ports held by the still-running gatekeeper-01 as a manual
        // setup conflict after 30 seconds. Host scholarly lanes share fixed
        // proxy ports, so queue them here before probing those ports.
        let wait = unsafe { WaitForSingleObject(handle, u32::MAX) };
        if !matches!(wait, 0 | 0x80) {
            unsafe { CloseHandle(handle) };
            return Err(anyhow!(
                "cannot acquire scholarly proxy port mutex (wait result {wait:#x})"
            ));
        }
        return Ok(ScholarlyProxyLease { handle });
    }
    #[cfg(not(windows))]
    {
        Ok(ScholarlyProxyLease {})
    }
}

fn marker_problem(marker: Option<&Value>, busy_ports: &[u16]) -> Option<String> {
    let Some(marker) = marker else {
        return Some(
            "Windows sandbox setup state is missing or unreadable; unattended setup is blocked"
                .into(),
        );
    };
    // Version 5 is the state schema shipped by the supported Windows CLI.
    // An unknown schema needs inspection; it is not proof setup can be skipped.
    if marker.get("version").and_then(Value::as_u64) != Some(5) {
        return Some("Windows sandbox setup state has an unsupported version; inspect CLI setup before resuming".into());
    }
    let stored = marker
        .get("proxy_ports")
        .and_then(Value::as_array)
        .and_then(|ports| {
            ports
                .iter()
                .map(|port| port.as_u64().and_then(|port| u16::try_from(port).ok()))
                .collect::<Option<Vec<_>>>()
        });
    // A different proxy port list is NOT a conflict to stop for. The firewall
    // rules carry fixed global names (codex_sandbox_offline_block_loopback_tcp),
    // so every Codex on the host rewrites their proxy exception to its own ports
    // and the next launch rewrites it back; neither owns them.
    //
    // MEASURED ON cycle-b-20260918, 2026-09-18. The Codex bundled with the
    // desktop app ran a command with no proxy ports, re-provisioned the rules in
    // three seconds with no elevation prompt, and this check then paused the whole
    // cycle for a manual resume. A separate CODEX_HOME would not help: same rules.
    // Letting the CLI re-provision is what that other Codex just did. If a
    // re-provision ever does need an elevation prompt and is cancelled, the
    // runtime watchdog (record_windows_setup_block) still stops the cycle.
    if stored.is_none() {
        return Some("Windows sandbox setup state has no valid proxy port list".into());
    }
    if marker.get("allow_local_binding").and_then(Value::as_bool) != Some(false) {
        return Some("Windows sandbox local-binding state conflicts with the scholarly profile; refusing to trigger setup".into());
    }
    if !busy_ports.is_empty() {
        return Some(format!("Scholarly proxy ports {busy_ports:?} are occupied or unavailable; refusing CLI port fallback and repeated firewall setup"));
    }
    None
}

/// How long a busy proxy port may take to be released before it counts as held.
///
/// MEASURED ON cycle-b-20260917d, 2026-09-17. followup-scout-03 finished and
/// the next two lanes were admitted in the same second, while its proxy still
/// held 3128; the check called that a setup conflict and paused the whole cycle
/// for a manual resume. The port was free moments later.
const PORT_RELEASE_WAIT_SECONDS: u64 = 30;

/// Ports still busy after waiting up to `wait` for them to be released.
fn wait_for_free_ports(
    ports: &[u16],
    wait: std::time::Duration,
    mut is_busy: impl FnMut(u16) -> bool,
) -> Vec<u16> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        let busy: Vec<u16> = ports.iter().copied().filter(|port| is_busy(*port)).collect();
        if busy.is_empty() || std::time::Instant::now() >= deadline {
            return busy;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

/// How long an unreadable setup marker may take to reappear before it counts.
const MARKER_REWRITE_WAIT_SECONDS: u64 = 15;

fn read_setup_marker(codex_home: &Path) -> Option<Value> {
    let bytes = std::fs::read(codex_home.join(".sandbox").join("setup_marker.json")).ok()?;
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    serde_json::from_slice::<Value>(bytes).ok()
}

/// The marker, retried while another Codex may be rewriting it.
///
/// MEASURED ON cycle-b-20260918, 2026-09-18. The desktop app's Codex
/// re-provisioned the shared sandbox from 16:36:44 to 16:36:48; a scout checked
/// at 16:36:48, read the marker mid-rewrite as missing, and the cycle paused for
/// a manual resume. The marker was complete a moment later.
fn read_setup_marker_settled(codex_home: &Path, wait: std::time::Duration) -> Option<Value> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(marker) = read_setup_marker(codex_home) {
            return Some(marker);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn inspect_setup_state(codex_home: &Path, busy_ports: &[u16]) -> Option<String> {
    let marker = read_setup_marker_settled(
        codex_home,
        std::time::Duration::from_secs(MARKER_REWRITE_WAIT_SECONDS),
    );
    marker_problem(marker.as_ref(), busy_ports)
}

pub(crate) fn scholarly_windows_setup_problem() -> Option<String> {
    #[cfg(windows)]
    {
        // Match the launcher's effective home without creating or changing it.
        let codex_home = super::agent_command::researchlab_codex_home()
            .or_else(|| {
                std::env::var_os("CODEX_HOME")
                    .filter(|v| !v.is_empty())
                    .map(std::path::PathBuf::from)
            })
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .filter(|v| !v.is_empty())
                    .map(|home| std::path::PathBuf::from(home).join(".codex"))
            });
        let Some(codex_home) = codex_home else {
            return Some(
                "Cannot locate Windows sandbox setup state; unattended setup is blocked".into(),
            );
        };
        // Short-lived local binds only test availability. No service is started
        // and no network data is sent. This is an admission check, not a lock
        // against a separate application changing shared state after launch.
        let busy_ports = wait_for_free_ports(
            &SCHOLARLY_PROXY_PORTS,
            std::time::Duration::from_secs(PORT_RELEASE_WAIT_SECONDS),
            |port| std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_err(),
        );
        inspect_setup_state(&codex_home, &busy_ports)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker() -> Value {
        json!({"version":5,"proxy_ports":[3128,8081],"allow_local_binding":false})
    }

    #[test]
    fn rejects_setup_transitions_and_port_fallback_without_launching_anything() {
        assert!(marker_problem(None, &[]).is_some());
        // A malformed port list is still a state to inspect.
        let mut malformed = marker();
        malformed["proxy_ports"] = json!([3128, "8081"]);
        assert!(marker_problem(Some(&malformed), &[]).is_some());
        assert!(marker_problem(Some(&marker()), &[3128]).is_some());
        let mut state = marker();
        state["version"] = json!(6);
        assert!(marker_problem(Some(&state), &[]).is_some());
        state = marker();
        state["allow_local_binding"] = json!(true);
        assert!(marker_problem(Some(&state), &[]).is_some());
        assert!(marker_problem(Some(&marker()), &[]).is_none());
    }

    #[test]
    fn another_codex_rewriting_the_proxy_ports_does_not_pause_the_cycle() {
        // cycle-b-20260918: the desktop app's Codex re-provisioned the shared
        // firewall rules with no proxy ports, and the cycle was paused for it.
        for ports in [json!([]), json!([3129, 8082])] {
            let mut state = marker();
            state["proxy_ports"] = ports.clone();
            assert!(
                marker_problem(Some(&state), &[]).is_none(),
                "a proxy port list {ports} set by another Codex paused the cycle",
            );
        }
    }

    #[test]
    fn a_port_released_while_waiting_is_not_reported_busy() {
        let mut checks = 0;
        let busy = wait_for_free_ports(&[3128, 8081], std::time::Duration::from_secs(5), |port| {
            checks += 1;
            // 3128 is still held by the previous lane's proxy on the first look.
            port == 3128 && checks <= 1
        });
        assert!(busy.is_empty(), "a transiently held port paused the cycle: {busy:?}");

        let held = wait_for_free_ports(&[3128], std::time::Duration::ZERO, |_| true);
        assert_eq!(held, vec![3128], "a port that stays held must still be reported");
    }

    #[test]
    fn missing_or_corrupt_marker_never_creates_or_repairs_setup_state() {
        let dir = tempfile::tempdir().unwrap();
        assert!(inspect_setup_state(dir.path(), &[]).is_some());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let sandbox = dir.path().join(".sandbox");
        std::fs::create_dir(&sandbox).unwrap();
        let marker_path = sandbox.join("setup_marker.json");
        std::fs::write(&marker_path, b"invalid-state").unwrap();
        assert!(inspect_setup_state(dir.path(), &[]).is_some());
        assert_eq!(std::fs::read(marker_path).unwrap(), b"invalid-state");
    }

    #[test]
    fn a_marker_being_rewritten_by_another_codex_is_waited_for() {
        let dir = tempfile::tempdir().unwrap();
        let sandbox = dir.path().join(".sandbox");
        std::fs::create_dir(&sandbox).unwrap();
        let marker_path = sandbox.join("setup_marker.json");
        // Absent now, complete a second later -- the 16:36:44-48 rewrite.
        let writer_path = marker_path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            std::fs::write(&writer_path, serde_json::to_vec(&marker()).unwrap()).unwrap();
        });
        let settled = read_setup_marker_settled(dir.path(), std::time::Duration::from_secs(5));
        writer.join().unwrap();
        assert!(settled.is_some(), "a marker mid-rewrite paused the cycle");
        assert!(marker_problem(settled.as_ref(), &[]).is_none());

        // A byte-order mark is not a corrupt marker.
        let mut with_bom = b"\xef\xbb\xbf".to_vec();
        with_bom.extend(serde_json::to_vec(&marker()).unwrap());
        std::fs::write(&marker_path, with_bom).unwrap();
        assert!(read_setup_marker(dir.path()).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn a_running_scholarly_lane_queues_the_next_lane_instead_of_causing_a_setup_pause() {
        // MEASURED ON cycle-a-20260919, 2026-09-19. gatekeeper-01
        // legitimately held 3128/8081 for minutes; gatekeeper-02 waited only
        // 30 seconds and converted ordinary lane contention into a cycle pause.
        let first = acquire_scholarly_proxy_lease().unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (acquired_tx, acquired_rx) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _second = acquire_scholarly_proxy_lease().unwrap();
            acquired_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(
            acquired_rx
                .recv_timeout(std::time::Duration::from_millis(100))
                .is_err(),
            "a concurrent scholarly lane bypassed the shared-port queue"
        );
        drop(first);
        acquired_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the queued lane did not acquire the released proxy ports");
        waiter.join().unwrap();
    }
}
