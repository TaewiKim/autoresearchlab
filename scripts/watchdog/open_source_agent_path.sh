# shellcheck shell=bash
# Sourced by watch_cycle_long_run.sh after generic watchdog helpers are defined.

selected_agent_name() {
  local handoff="$1"
  jq -r '
    .selected_open_source_analysis_agent.name //
    .open_source_agent_discovery.selected_agent.name //
    empty
  ' "${handoff}" 2>/dev/null || true
}

runner_handoff_path() {
  local result="$1"
  jq -r '
    .role_plan.planner_metadata.analyst_handoff_path //
    .planner_metadata.analyst_handoff_path //
    empty
  ' "${result}" 2>/dev/null || true
}

runner_external_total() {
  local result="$1"
  jq -r '
    .validation_summary.external_agent_runs_total //
    (.external_agent_runs | length?) //
    0
  ' "${result}" 2>/dev/null || printf '0'
}

runner_repository_agent_required() {
  local result="$1"
  jq -r '
    .validation_summary.open_source_agent_requirements.repository_agent_required //
    .open_source_agent_requirements.repository_agent_required //
    false
  ' "${result}" 2>/dev/null || printf 'false'
}

runner_repository_agent_applied() {
  local result="$1"
  jq -r '
    .validation_summary.open_source_agent_requirements.repository_agent_applied //
    .open_source_agent_requirements.repository_agent_applied //
    false
  ' "${result}" 2>/dev/null || printf 'false'
}

runner_repository_workflow_applied() {
  local result="$1"
  jq -r '
    .validation_summary.open_source_agent_requirements.substantive_repository_workflow_applied //
    .open_source_agent_requirements.substantive_repository_workflow_applied //
    false
  ' "${result}" 2>/dev/null || printf 'false'
}

deleted_harness_hits() {
  if ! command -v rg >/dev/null 2>&1; then
    return 0
  fi
  if [ -f "${restart_stamp}" ]; then
    find "${runtime_root}/lanes/${cycle_id}" -type f -name launcher.stderr.log -mmin -30 -newer "${restart_stamp}" -print0 2>/dev/null
  else
    find "${runtime_root}/lanes/${cycle_id}" -type f -name launcher.stderr.log -mmin -30 -print0 2>/dev/null
  fi |
    while IFS= read -r -d '' path; do
      if rg -q '\(deleted\): No such file|failed to execute .*researchlab-harness' "${path}" 2>/dev/null; then
        printf '%s\n' "${path}"
      fi
    done |
    head -5
}

completed_progress_age() {
  local completed="$1"
  local now="$2"
  local previous_completed=""
  local previous_epoch=""
  if [ -f "${completed_progress_stamp}" ]; then
    IFS=$'\t' read -r previous_completed previous_epoch < "${completed_progress_stamp}" || true
  fi
  if [ "${previous_completed}" != "${completed}" ] || [ -z "${previous_epoch}" ]; then
    printf '%s\t%s\n' "${completed}" "${now}" > "${completed_progress_stamp}"
    printf '0'
    return 0
  fi
  printf '%s' "$((now - previous_epoch))"
}

restart_allowed() {
  local now
  local last
  now="$(date +%s)"
  last="0"
  if [ -f "${restart_stamp}" ]; then
    last="$(cat "${restart_stamp}" 2>/dev/null || printf '0')"
  fi
  [ $((now - last)) -ge "${restart_cooldown_seconds}" ]
}

stop_resume_cycle() {
  local pids
  pids="$( (resume_pids; run_plan_pids) | sort -u | sed '/^$/d' )"
  if [ -z "${pids}" ]; then
    return 0
  fi
  log "action=stop_resume_cycle pids=$(printf '%s' "${pids}" | tr '\n' ',')"
  while IFS= read -r pid; do
    [ -n "${pid}" ] && kill -TERM "${pid}" 2>/dev/null || true
  done <<< "${pids}"
  sleep 3
  pids="$( (resume_pids; run_plan_pids) | sort -u | sed '/^$/d' )"
  while IFS= read -r pid; do
    [ -n "${pid}" ] && kill -KILL "${pid}" 2>/dev/null || true
  done <<< "${pids}"
}

start_resume_cycle() {
  local active_resume
  local active_run_plan
  local ts
  local log_path
  active_resume="$(live_resume_count)"
  active_run_plan="$(live_run_plan_count)"
  if [ "${active_resume}" != "0" ] || [ "${active_run_plan}" != "0" ]; then
    log "action=start_resume_cycle_skipped reason=supervisor_already_running resume_processes=${active_resume} run_plan_processes=${active_run_plan}"
    return 0
  fi
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  log_path="${run_logs}/${cycle_id}-resume-continuous-watchdog-${ts}.log"
  if command -v setsid >/dev/null 2>&1; then
    setsid env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js resume-cycle \
      --cycle-id "${cycle_id}" \
      --max-passes "${max_passes}" \
      --sleep-seconds "${sleep_seconds}" \
      --max-concurrency "${max_concurrency}" \
      --stale-seconds "${stale_seconds}" \
      --continuous > "${log_path}" 2>&1 &
  elif command -v nohup >/dev/null 2>&1; then
    nohup env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js resume-cycle \
      --cycle-id "${cycle_id}" \
      --max-passes "${max_passes}" \
      --sleep-seconds "${sleep_seconds}" \
      --max-concurrency "${max_concurrency}" \
      --stale-seconds "${stale_seconds}" \
      --continuous > "${log_path}" 2>&1 &
  else
    env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js resume-cycle \
      --cycle-id "${cycle_id}" \
      --max-passes "${max_passes}" \
      --sleep-seconds "${sleep_seconds}" \
      --max-concurrency "${max_concurrency}" \
      --stale-seconds "${stale_seconds}" \
      --continuous > "${log_path}" 2>&1 &
  fi
  local pid="$!"
  echo "${pid}" > "${log_path}.pid"
  date +%s > "${restart_stamp}"
  log "action=start_resume_cycle pid=${pid} log=${log_path}"
}

restart_resume_cycle() {
  local reason="$1"
  local force="${2:-0}"
  if [ "${force}" != "1" ] && ! restart_allowed; then
    log "action=restart_skipped reason=${reason} cooldown_seconds=${restart_cooldown_seconds}"
    return 0
  fi
  log "action=restart_resume_cycle reason=${reason}"
  stop_resume_cycle
  start_resume_cycle
}

refresh_cycle() {
  local ts
  local tmp
  local refresh_mode
  local -a refresh_cmd
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="${run_logs}/${cycle_id}-watchdog-refresh-${ts}.json"
  refresh_mode="context_only"
  if [ "${watchdog_full_refresh:-0}" = "1" ]; then
    refresh_mode="full"
  fi
  log "action=refresh_cycle cycle_id=${cycle_id} mode=${refresh_mode}"
  if command -v timeout >/dev/null 2>&1; then
    refresh_cmd=(timeout "${refresh_cycle_timeout_seconds}" env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-cycle --cycle-id "${cycle_id}")
  else
    refresh_cmd=(env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-cycle --cycle-id "${cycle_id}")
  fi
  if [ "${refresh_mode}" = "context_only" ]; then
    refresh_cmd+=(--context-only)
  fi
  if "${refresh_cmd[@]}" > "${tmp}" 2>&1; then
    jq -c '{
      cycle_id,
      refresh_deferred,
      refresh_deferred_reason,
      gate_refresh_applied,
      gate_refresh_error,
      termination_code,
      lane_counts: (.cycle_state.lane_counts // null),
      approval_readiness_score: (.approval_review.review.approval_readiness_score // null),
      approval_score_policy: (.approval_review.review.approval_score_policy // null),
      score_limiting_stage: (.approval_review.review.approval_stage_summary.score_limiting_stage // null),
      created_followups: (.created_followups // null)
    }' "${tmp}" 2>/dev/null | sed 's/^/refresh-cycle-summary: /' || true
    rm -f "${tmp}"
  else
    record_issue "refresh_cycle_failed" "warning" "supervisor" "log=${tmp}"
    tail -20 "${tmp}" | sed 's/^/refresh-cycle-error: /' || true
  fi
}

context_refresh_allowed() {
  local now
  local last
  now="$(date +%s)"
  last="0"
  if [ -f "${context_refresh_stamp}" ]; then
    last="$(cat "${context_refresh_stamp}" 2>/dev/null || printf '0')"
  fi
  [ $((now - last)) -ge "${context_refresh_interval_seconds}" ]
}

context_refresh_running() {
  local pid
  local started
  local now
  if [ ! -f "${context_refresh_pidfile}" ]; then
    return 1
  fi
  pid="$(cat "${context_refresh_pidfile}" 2>/dev/null || true)"
  if ! pid_is_live "${pid}"; then
    rm -f "${context_refresh_pidfile}"
    return 1
  fi
  started="$(stat_mtime_epoch "${context_refresh_pidfile}")"
  now="$(date +%s)"
  if [ $((now - started)) -ge "${context_refresh_timeout_seconds}" ]; then
    record_issue "context_refresh_stalled" "warning" "supervisor" "pid=${pid} age_seconds=$((now - started))"
  fi
  log "action=refresh_context_artifacts_skipped reason=already_running pid=${pid}"
  return 0
}

run_context_refresh_artifacts() {
  local ts
  local tmp
  local -a refresh_cmd
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="${run_logs}/${cycle_id}-watchdog-context-refresh-${ts}.json"
  log "action=refresh_context_artifacts cycle_id=${cycle_id}"
  if command -v timeout >/dev/null 2>&1; then
    refresh_cmd=(timeout "${context_refresh_timeout_seconds}s" env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-cycle --cycle-id "${cycle_id}" --context-only)
  else
    refresh_cmd=(env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-cycle --cycle-id "${cycle_id}" --context-only)
  fi
  if "${refresh_cmd[@]}" > "${tmp}" 2>&1; then
    date +%s > "${context_refresh_stamp}"
    jq -c '{
      cycle_id,
      lane_counts: (.cycle_state.lane_counts // null),
      context_health,
      cycle_memory,
      agent_mailboxes
    }' "${tmp}" 2>/dev/null | sed 's/^/context-refresh-summary: /' || true
    rm -f "${tmp}"
  else
    record_issue "context_refresh_failed" "warning" "supervisor" "log=${tmp}"
    tail -20 "${tmp}" | sed 's/^/context-refresh-error: /' || true
  fi
}

refresh_context_artifacts() {
  if context_refresh_running; then
    return 0
  fi
  if [ "${context_refresh_background}" = "0" ]; then
    run_context_refresh_artifacts
    return $?
  fi
  (
    trap 'rm -f "${context_refresh_pidfile}"' EXIT
    run_context_refresh_artifacts
  ) &
  echo "$!" > "${context_refresh_pidfile}"
}

# Correction harvesting — periodically distil gate-review + eval-telemetry
# correction signals into proposed canonical reference-notes patches. Opt-in
# (RESEARCHLAB_WATCH_CORRECTION_HARVEST=1) and advisory: it never auto-applies,
# only writes reference/analyst/*.proposed.json + PATCH_SUMMARY.md for review.
correction_harvest_allowed() {
  [ "${correction_harvest_enabled}" = "1" ] || return 1
  local now last
  now="$(date +%s)"
  last="0"
  if [ -f "${correction_harvest_stamp}" ]; then
    last="$(cat "${correction_harvest_stamp}" 2>/dev/null || printf '0')"
  fi
  [ $((now - last)) -ge "${correction_harvest_interval_seconds}" ]
}

run_correction_harvest() {
  local ts tmp rc
  local -a cmd
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="${run_logs}/${cycle_id}-watchdog-correction-harvest-${ts}.log"
  log "action=harvest_corrections cycle_id=${cycle_id}"
  if command -v timeout >/dev/null 2>&1; then
    cmd=(timeout "${correction_harvest_timeout_seconds}s" node ./scripts/harvest_corrections.js --cycle "${cycle_id}")
  else
    cmd=(node ./scripts/harvest_corrections.js --cycle "${cycle_id}")
  fi
  # harvest_corrections.js exits 3 when it proposes patches, 0 when none.
  "${cmd[@]}" > "${tmp}" 2>&1
  rc=$?
  date +%s > "${correction_harvest_stamp}"
  if [ "${rc}" = "3" ]; then
    log "action=harvest_corrections_proposed cycle_id=${cycle_id} summary=reference/analyst/PATCH_SUMMARY.md log=${tmp}"
  elif [ "${rc}" = "0" ]; then
    rm -f "${tmp}"
  else
    record_issue "correction_harvest_failed" "warning" "supervisor" "rc=${rc} log=${tmp}"
    tail -20 "${tmp}" | sed 's/^/correction-harvest-error: /' || true
  fi
}

verify_open_source_agent_path() {
  local handoff
  local runner
  local selected
  local handoff_mtime
  local runner_mtime
  local expected_handoff
  local actual_handoff
  local external_total
  local repository_required
  local repository_applied
  local workflow_applied
  local pending_analysts
  local running_analysts
  local pending_runners
  local running_runners
  local pending_lab_directors
  local running_lab_directors
  local core_recovery_active
  local pending_runners
  local running_runners
  local total_running

  handoff="$(latest_analyst_handoff_strict)"
  if [ -z "${handoff}" ]; then
    log "verification=waiting reason=no_analyst_handoff"
    return 0
  fi

  selected="$(selected_agent_name "${handoff}")"
  if [ -z "${selected}" ]; then
    record_issue "latest_analyst_handoff_missing_selected_open_source_agent" "research_blocker" "lab-director" "handoff=${handoff}"
    queue_lab_director_instruction \
      "latest_analyst_handoff_missing_selected_open_source_agent" \
      "research_blocker" \
      "Process blocker: the latest analyst handoff is missing the selected open-source analysis agent required by the gate. LabDirector must author the scientific corrective decision and next research instruction; supervisor is not selecting the agent or rewriting the analysis plan." \
      "handoff=${handoff}"
    return 0
  fi

  runner="$(latest_runner_result_strict)"
  handoff_mtime="$(mtime_epoch "${handoff}")"
  runner_mtime="$(mtime_epoch "${runner}")"
  expected_handoff="$(real_path "${handoff}")"

  if [ -z "${runner}" ] || [ "${runner_mtime}" -lt "${handoff_mtime}" ]; then
    pending_runners="$(lane_count_for pending lab-runner)"
    running_runners="$(lane_count_for running lab-runner)"
    total_running="$(state_count running)"
    core_recovery_active="$(core_recovery_lane_count)"
    log "verification=waiting reason=runner_has_not_consumed_latest_analyst selected_agent=${selected} handoff=${handoff} latest_runner=${runner:-none} pending_runners=${pending_runners} running_runners=${running_runners} total_running=${total_running} core_recovery_active=${core_recovery_active}"
    if [ "${pending_runners}" = "0" ] && [ "${running_runners}" = "0" ] && [ "${total_running}" = "0" ] && [ "${core_recovery_active}" = "0" ]; then
      refresh_cycle
      if [ "$(live_resume_count)" = "0" ]; then
        start_resume_cycle
      fi
    elif [ "${pending_runners}" = "0" ] && [ "${running_runners}" = "0" ] && [ "${total_running}" = "0" ]; then
      refresh_context_artifacts
    fi
    return 0
  fi

  actual_handoff="$(real_path "$(runner_handoff_path "${runner}")")"
  external_total="$(runner_external_total "${runner}")"
  repository_required="$(runner_repository_agent_required "${runner}")"
  repository_applied="$(runner_repository_agent_applied "${runner}")"
  workflow_applied="$(runner_repository_workflow_applied "${runner}")"
  pending_analysts="$(lane_count_for pending analyst)"
  running_analysts="$(lane_count_for running analyst)"
  pending_runners="$(lane_count_for pending lab-runner)"
  running_runners="$(lane_count_for running lab-runner)"
  pending_lab_directors="$(lane_count_for pending lab-director)"
  running_lab_directors="$(lane_count_for running lab-director)"
  core_recovery_active="$((pending_analysts + running_analysts + pending_runners + running_runners + pending_lab_directors + running_lab_directors))"
  if [ "${actual_handoff}" != "${expected_handoff}" ]; then
    total_running="$(state_count running)"
    if [ "${core_recovery_active}" = "0" ] && [ "${external_total}" != "0" ] && { [ "${repository_required}" != "true" ] || { [ "${repository_applied}" = "true" ] && [ "${workflow_applied}" = "true" ]; }; }; then
      log "verification=passed reason=runner_validates_equivalent_selected_agent_despite_newer_handoff selected_agent=${selected} expected_handoff=${expected_handoff} actual_handoff=${actual_handoff:-none} runner=${runner} external_agent_runs_total=${external_total} repository_agent_required=${repository_required} repository_agent_applied=${repository_applied} substantive_repository_workflow_applied=${workflow_applied}"
      return 0
    fi
    log "verification=waiting reason=latest_runner_used_older_handoff selected_agent=${selected} expected_handoff=${expected_handoff} actual_handoff=${actual_handoff:-none} runner=${runner} pending_runners=${pending_runners} running_runners=${running_runners} total_running=${total_running} core_recovery_active=${core_recovery_active}"
    if [ "${pending_runners}" = "0" ] && [ "${running_runners}" = "0" ] && [ "${total_running}" = "0" ] && [ "${core_recovery_active}" = "0" ]; then
      refresh_cycle
      if [ "$(live_resume_count)" = "0" ]; then
        start_resume_cycle
      fi
    elif [ "${pending_runners}" = "0" ] && [ "${running_runners}" = "0" ] && [ "${total_running}" = "0" ]; then
      refresh_context_artifacts
    fi
    return 0
  fi

  if [ "${core_recovery_active}" -gt 0 ]; then
    log "verification=waiting reason=core_recovery_lanes_active selected_agent=${selected} runner=${runner} handoff=${handoff} pending_analysts=${pending_analysts} running_analysts=${running_analysts} pending_runners=${pending_runners} running_runners=${running_runners} pending_lab_directors=${pending_lab_directors} running_lab_directors=${running_lab_directors}"
    return 0
  fi

  if [ "${external_total}" = "0" ]; then
    record_issue "runner_consumed_latest_handoff_but_external_agent_runs_missing" "research_blocker" "lab-director" "selected_agent=${selected} runner=${runner} handoff=${handoff}"
    queue_lab_director_instruction \
      "runner_consumed_latest_handoff_but_external_agent_runs_missing" \
      "research_blocker" \
      "Process blocker: the runner consumed the latest handoff but no external-agent run evidence was recorded. LabDirector must author the corrective research instruction and decide the next role; supervisor is not prescribing the runner plan." \
      "selected_agent=${selected} runner=${runner} handoff=${handoff}"
    refresh_cycle
    if [ "$(live_resume_count)" = "0" ]; then
      start_resume_cycle
    fi
    return 0
  fi

  if [ "${repository_required}" = "true" ] && { [ "${repository_applied}" != "true" ] || [ "${workflow_applied}" != "true" ]; }; then
    record_issue "runner_external_agent_runs_lack_substantive_repository_workflow" "research_blocker" "lab-director" "selected_agent=${selected} runner=${runner} handoff=${handoff} repository_agent_required=${repository_required} repository_agent_applied=${repository_applied} substantive_repository_workflow_applied=${workflow_applied} external_agent_runs_total=${external_total}"
    queue_lab_director_instruction \
      "runner_external_agent_runs_lack_substantive_repository_workflow" \
      "research_blocker" \
      "Process blocker: the selected repository agent was not applied through a substantive repository-native workflow. LabDirector must author the scientific corrective decision and next research instruction; supervisor is not choosing the workflow or analysis plan." \
      "selected_agent=${selected} runner=${runner} handoff=${handoff} repository_agent_required=${repository_required} repository_agent_applied=${repository_applied} substantive_repository_workflow_applied=${workflow_applied} external_agent_runs_total=${external_total}"
    refresh_cycle
    if [ "$(live_resume_count)" = "0" ]; then
      start_resume_cycle
    fi
    return 0
  fi

  log "verification=passed selected_agent=${selected} runner=${runner} external_agent_runs_total=${external_total} repository_agent_required=${repository_required} repository_agent_applied=${repository_applied} substantive_repository_workflow_applied=${workflow_applied}"
}
