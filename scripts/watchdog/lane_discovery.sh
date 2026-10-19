#!/usr/bin/env bash
# Lane/file/pid discovery and running-lane health helpers, sourced by
# watch_cycle_long_run.sh. Split out to keep that file under the line budget.
# These are pure helpers over shared watchdog globals (paths, cycle_id, ...),
# sourced before check_once runs so behaviour is unchanged.

stat_mtime_epoch() {
  local path="$1"
  if [ -n "${path}" ] && [ -e "${path}" ]; then
    stat -c %Y "${path}" 2>/dev/null && return 0
    stat -f %m "${path}" 2>/dev/null && return 0
  fi
  printf '0'
}

pid_is_live() {
  local pid="$1"
  local stat
  if [ -z "${pid}" ] || ! kill -0 "${pid}" 2>/dev/null; then
    return 1
  fi
  stat="$(ps -p "${pid}" -o stat= 2>/dev/null | awk '{print $1}')"
  if [ -z "${stat}" ]; then
    return 1
  fi
  case "${stat}" in
    Z*) return 1 ;;
  esac
  return 0
}

resume_pids() {
  pgrep -f "node .*resume-cycle --cycle-id ${cycle_id}" 2>/dev/null || true
  pgrep -f "node ./src/cli resume-cycle --cycle-id ${cycle_id}" 2>/dev/null || true
}

run_plan_pids() {
  pgrep -f "researchlab-harness run-plan --cycle-id ${cycle_id}" 2>/dev/null || true
}

live_resume_count() {
  resume_pids | sort -u | sed '/^$/d' | wc -l | tr -d ' '
}

live_run_plan_count() {
  run_plan_pids | sort -u | sed '/^$/d' | wc -l | tr -d ' '
}

state_count() {
  local key="$1"
  if [ ! -f "${state_path}" ]; then
    printf '0'
    return
  fi
  jq -r --arg key "${key}" '.lane_counts[$key] // 0' "${state_path}" 2>/dev/null || printf '0'
}

state_status() {
  if [ ! -f "${state_path}" ]; then
    printf 'missing'
    return
  fi
  jq -r '.status // "unknown"' "${state_path}" 2>/dev/null || printf 'unknown'
}

lane_count_for() {
  local status="$1"
  local role="$2"
  if [ ! -f "${state_path}" ]; then
    printf '0'
    return
  fi
  jq -r --arg status "${status}" --arg role "${role}" '
    [.lane_statuses[]? | select(.status == $status and .role == $role)] | length
  ' "${state_path}" 2>/dev/null || printf '0'
}

core_recovery_lane_count() {
  local pending_analysts
  local running_analysts
  local pending_runners
  local running_runners
  local pending_lab_directors
  local running_lab_directors
  pending_analysts="$(lane_count_for pending analyst)"
  running_analysts="$(lane_count_for running analyst)"
  pending_runners="$(lane_count_for pending lab-runner)"
  running_runners="$(lane_count_for running lab-runner)"
  pending_lab_directors="$(lane_count_for pending lab-director)"
  running_lab_directors="$(lane_count_for running lab-director)"
  printf '%s' "$((pending_analysts + running_analysts + pending_runners + running_runners + pending_lab_directors + running_lab_directors))"
}

latest_by_mtime() {
  find "$@" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
    done |
    sort -n | tail -1 | cut -f2-
}

latest_analyst_handoff() {
  latest_by_mtime \
    "${runtime_root}/lanes/${cycle_id}" \
    "${runtime_root}/artifacts/stats/${cycle_id}" |
    while IFS= read -r path; do
      case "${path}" in
        *analyst*/handoff-validation-plan.json) printf '%s\n' "${path}" ;;
      esac
    done
}

latest_runner_result() {
  latest_by_mtime \
    "${runtime_root}/lanes/${cycle_id}" \
    "${runtime_root}/artifacts/stats/${cycle_id}" |
    while IFS= read -r path; do
      case "${path}" in
        *runner*/result.json) printf '%s\n' "${path}" ;;
      esac
    done
}

latest_matching_file() {
  local pattern="$1"
  find "${runtime_root}/lanes/${cycle_id}" "${runtime_root}/artifacts/stats/${cycle_id}" \
    -type f -path "${pattern}" -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
    done |
    sort -n | tail -1 | cut -f2-
}

latest_matching_file_regex() {
  local regex="$1"
  find "${runtime_root}/lanes/${cycle_id}" "${runtime_root}/artifacts/stats/${cycle_id}" \
    -type f -print0 2>/dev/null |
    while IFS= read -r -d '' path; do
      if printf '%s\n' "${path}" | grep -Eq "${regex}"; then
        printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
      fi
    done |
    sort -n | tail -1 | cut -f2-
}

latest_lane_file_by_glob() {
  local lane_glob="$1"
  local relative_path="$2"
  local root
  local path
  for root in "${runtime_root}/lanes/${cycle_id}" "${runtime_root}/artifacts/stats/${cycle_id}"; do
    for path in "${root}"/${lane_glob}/"${relative_path}"; do
      [ -f "${path}" ] || continue
      printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
    done
  done | sort -n | tail -1 | cut -f2-
}

resolved_runner_interpretation_handoff() {
  local handoff="$1"
  local lane_id
  local role_plan
  local action_type
  local resolved

  lane_id="$(basename "$(dirname "${handoff}")")"
  role_plan="${runtime_root}/lanes/${cycle_id}/${lane_id}/role-plan.json"
  [ -f "${role_plan}" ] || return 1
  action_type="$(jq -r '.action_type // .action.action_type // empty' "${role_plan}" 2>/dev/null || true)"
  [ "${action_type}" = "runner_result_interpretation_followup" ] || return 1
  resolved="$(jq -r '
    (.planner_metadata.validation_results // .planner_metadata.analysis_request.runner_context // {}) as $v
    | ($v.validation_summary // {}) as $s
    | (($v.blueprints_failed // $s.blueprints_failed // 0) == 0)
      and (($v.checks_failed // $s.checks_failed // 0) == 0)
      and (($s.analyst_quality_standard.satisfied // false) == true)
      and ((($s.handoff_check_resolutions // []) | length) > 0)
      and ((($s.handoff_check_resolutions // []) | all(.resolved == true)) == true)
  ' "${role_plan}" 2>/dev/null || printf 'false')"
  [ "${resolved}" = "true" ]
}

latest_analyst_handoff_strict() {
  local root
  local path
  local latest
  latest="$(for root in "${runtime_root}/lanes/${cycle_id}" "${runtime_root}/artifacts/stats/${cycle_id}"; do
    for path in "${root}"/followup-analyst-*/handoff-validation-plan.json; do
      [ -f "${path}" ] || continue
      if resolved_runner_interpretation_handoff "${path}"; then
        continue
      fi
      printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
    done
  done | sort -n | tail -1 | cut -f2-)"
  if [ -n "${latest}" ]; then
    printf '%s\n' "${latest}"
    return
  fi
  latest="$(for root in "${runtime_root}/lanes/${cycle_id}" "${runtime_root}/artifacts/stats/${cycle_id}"; do
    for path in "${root}"/*analyst*/handoff-validation-plan.json; do
      [ -f "${path}" ] || continue
      if resolved_runner_interpretation_handoff "${path}"; then
        continue
      fi
      printf '%s\t%s\n' "$(stat_mtime_epoch "${path}")" "${path}"
    done
  done | sort -n | tail -1 | cut -f2-)"
  [ -n "${latest}" ] && printf '%s\n' "${latest}"
}

latest_runner_result_strict() {
  local followup
  followup="$(latest_lane_file_by_glob 'followup-runner-*' 'result.json')"
  if [ -n "${followup}" ]; then
    printf '%s\n' "${followup}"
    return
  fi
  latest_lane_file_by_glob '*runner*' 'result.json'
}

scout_materialization_stagnation_summary() {
  run_with_optional_timeout "${scout_materialization_stagnation_timeout_seconds}" \
    node "${script_dir}/watchdog/scout_materialization_stagnation.js" \
    "${runtime_root}" \
    "${cycle_id}" \
    "${scout_materialization_stagnation_limit}"
}

supervisor_quality_anomalies() {
  run_with_optional_timeout "${quality_anomaly_timeout_seconds}" \
    node "${script_dir}/watchdog/supervisor_quality_anomalies.js" \
    "${runtime_root}" \
    "${cycle_id}" \
    "${quality_gate_lag_seconds}" \
    "${quality_scout_no_family_limit}" \
    "${quality_stale_failed_ordinal_gap}"
}

gate_score_stagnation_summary() {
  run_with_optional_timeout "${gate_score_stagnation_timeout_seconds}" \
    node "${script_dir}/watchdog/gate_score_stagnation.js" \
    "${runtime_root}" \
    "${cycle_id}" \
    "${gate_score_stagnation_window}" \
    "${gate_score_stagnation_history_limit}"
}

running_lane_health_summary() {
  node "${script_dir}/watchdog/running_lane_health_summary.js" \
    "${runtime_root}" \
    "${cycle_id}" \
    "${stale_seconds}"
}

heal_stale_running_lanes() {
  node - "${cycle_id}" "${stale_seconds}" <<'NODE'
const { healCycleOnce } = require("./src/orchestrator/self_healing_cycle");
const [cycleId, rawStaleSeconds] = process.argv.slice(2);
const actions = healCycleOnce({
  cwd: process.cwd(),
  cycleId,
  staleSeconds: Number(rawStaleSeconds || 1800) || 1800,
});
process.stdout.write(JSON.stringify({ actions }));
NODE
}

recover_stale_running_lanes() {
  local health_summary="$1"
  local heal_output
  if ! restart_allowed; then
    log "action=stale_running_lane_recovery_skipped reason=restart_cooldown summary=${health_summary}"
    return 0
  fi
  log "action=stale_running_lane_recovery_start"
  stop_resume_cycle
  heal_output="$(heal_stale_running_lanes 2>&1 || true)"
  log "action=stale_running_lane_self_heal result=${heal_output}"
  refresh_cycle
  start_resume_cycle
}

mtime_epoch() {
  local path="$1"
  stat_mtime_epoch "${path}"
}

real_path() {
  local path="$1"
  if [ -n "${path}" ]; then
    python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${path}" 2>/dev/null || realpath "${path}" 2>/dev/null || printf '%s' "${path}"
  fi
}
