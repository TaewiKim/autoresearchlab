#!/usr/bin/env bash
set -u
umask "${RESEARCHLAB_RUNTIME_UMASK:-0000}"

cycle_id="${1:-v56-omics-paper-complete-cache-fresh}"
interval_seconds="${2:-600}"
mode="${3:-}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cd "${repo_root}" || exit 1

runtime_root=".research-lab"
run_logs="${runtime_root}/run-logs"
events_dir="${runtime_root}/events"
runtime_dir="${runtime_root}/runtime"
state_path="${runtime_root}/state/${cycle_id}-cycle-run-state.json"
events_path="${runtime_root}/events/${cycle_id}-cycle-events.jsonl"
restart_stamp="${run_logs}/${cycle_id}-watchdog-last-restart.epoch"
completed_progress_stamp="${run_logs}/${cycle_id}-watchdog-completed-progress.tsv"
context_refresh_stamp="${run_logs}/${cycle_id}-watchdog-last-context-refresh.epoch"
context_refresh_pidfile="${run_logs}/${cycle_id}-watchdog-context-refresh.pid"
correction_harvest_stamp="${run_logs}/${cycle_id}-watchdog-last-correction-harvest.epoch"
pidfile="${run_logs}/${cycle_id}-watchdog-10min.pid"
supervisor_watchdog_reports_path="${events_dir}/${cycle_id}-supervisor-watchdog-reports.jsonl"
supervisor_actions_path="${events_dir}/${cycle_id}-supervisor-actions.jsonl"
supervisor_watchdog_state_path="${runtime_dir}/${cycle_id}-supervisor-watchdog-report.json"
researcher_watchdog_reports_path="${events_dir}/${cycle_id}-researcher-watchdog-reports.jsonl"
researcher_watchdog_state_path="${runtime_dir}/${cycle_id}-researcher-watchdog-report.json"
labdirector_inbox_path="${runtime_dir}/${cycle_id}-labdirector-inbox.jsonl"
labdirector_dialogue_path="${events_dir}/${cycle_id}-labdirector-dialogue.jsonl"
labdirector_instruction_dir="${run_logs}/labdirector-instructions"
messages_root="${runtime_root}/messages/${cycle_id}"
agent_raised_path="${messages_root}/raised.jsonl"
agent_ledger_path="${messages_root}/bus-ledger.json"

max_passes="${RESEARCHLAB_WATCH_MAX_PASSES:-24}"
max_concurrency="${RESEARCHLAB_WATCH_MAX_CONCURRENCY:-4}"
stale_seconds="${RESEARCHLAB_WATCH_STALE_SECONDS:-1800}"
sleep_seconds="${RESEARCHLAB_WATCH_SLEEP_SECONDS:-0}"
no_progress_seconds="${RESEARCHLAB_WATCH_NO_PROGRESS_SECONDS:-1800}"
restart_cooldown_seconds="${RESEARCHLAB_WATCH_RESTART_COOLDOWN_SECONDS:-600}"
lab_director_instruction_cooldown_seconds="${RESEARCHLAB_WATCH_LAB_DIRECTOR_COOLDOWN_SECONDS:-600}"
context_refresh_interval_seconds="${RESEARCHLAB_WATCH_CONTEXT_REFRESH_SECONDS:-${interval_seconds}}"
context_refresh_timeout_seconds="${RESEARCHLAB_WATCH_CONTEXT_REFRESH_TIMEOUT_SECONDS:-300}"
refresh_cycle_timeout_seconds="${RESEARCHLAB_WATCH_REFRESH_TIMEOUT_SECONDS:-600}"
context_refresh_background="${RESEARCHLAB_WATCH_CONTEXT_REFRESH_BACKGROUND:-1}"
# Correction harvesting (opt-in): periodically distil gate-review/eval signals
# into proposed canonical reference-notes patches. Advisory only — never
# auto-applies; it writes reference/analyst/*.proposed.json + PATCH_SUMMARY.md.
correction_harvest_enabled="${RESEARCHLAB_WATCH_CORRECTION_HARVEST:-0}"
correction_harvest_interval_seconds="${RESEARCHLAB_WATCH_CORRECTION_HARVEST_SECONDS:-1800}"
correction_harvest_timeout_seconds="${RESEARCHLAB_WATCH_CORRECTION_HARVEST_TIMEOUT_SECONDS:-120}"
scout_materialization_stagnation_limit="${RESEARCHLAB_WATCH_SCOUT_MATERIALIZATION_STAGNATION_LIMIT:-4}"
scout_materialization_stagnation_timeout_seconds="${RESEARCHLAB_WATCH_SCOUT_MATERIALIZATION_STAGNATION_TIMEOUT_SECONDS:-30}"
quality_anomaly_timeout_seconds="${RESEARCHLAB_WATCH_QUALITY_ANOMALY_TIMEOUT_SECONDS:-30}"
quality_gate_lag_seconds="${RESEARCHLAB_WATCH_GATE_LAG_SECONDS:-600}"
quality_scout_no_family_limit="${RESEARCHLAB_WATCH_SCOUT_NO_FAMILY_LIMIT:-3}"
quality_stale_failed_ordinal_gap="${RESEARCHLAB_WATCH_STALE_FAILED_ORDINAL_GAP:-50}"
gate_score_stagnation_window="${RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_WINDOW:-3}"
gate_score_stagnation_history_limit="${RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_HISTORY_LIMIT:-24}"
gate_score_stagnation_timeout_seconds="${RESEARCHLAB_WATCH_GATE_SCORE_STAGNATION_TIMEOUT_SECONDS:-30}"
gate_score_fast_interval_seconds="${RESEARCHLAB_WATCH_GATE_SCORE_FAST_INTERVAL_SECONDS:-60}"
node_max_old_space_size="${RESEARCHLAB_NODE_MAX_OLD_SPACE_SIZE:-4096}"
mirror_watchdog_reports_to_dialogue="${RESEARCHLAB_WATCH_DIALOGUE_REPORTS:-0}"
watchdog_full_refresh="${RESEARCHLAB_WATCH_FULL_REFRESH:-0}"

mkdir -p "${run_logs}" "${events_dir}" "${runtime_dir}" "${labdirector_instruction_dir}" "${messages_root}"
echo "$$" > "${pidfile}"

WATCHDOG_ISSUES=()
WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS=()
WATCHDOG_PENDING="0"
WATCHDOG_RUNNING="0"
WATCHDOG_COMPLETED="0"
WATCHDOG_FAILED="0"
WATCHDOG_RESUME_COUNT="0"
WATCHDOG_RUN_PLAN_COUNT="0"
WATCHDOG_EVENT_AGE="0"
WATCHDOG_CYCLE_STATUS="unknown"

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

log() {
  printf '%s %s\n' "$(now_iso)" "$*"
}

jsonl_append() {
  local file_path="$1"
  local payload="$2"
  printf '%s\n' "${payload}" >> "${file_path}"
}

run_with_optional_timeout() {
  local timeout_seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${timeout_seconds}s" "$@"
  else
    "$@"
  fi
}

# RAISE onto the bus; never write a role's mailbox.
#
# This used to append straight into mailbox/<role>.jsonl -- the projection --
# and read inter-agent-ledger.json to dedupe. The bus rebuilds every role file
# from its registry on each refresh, so anything written there is overwritten;
# and it is the bus that decides identity, capacity and delivery. A producer
# outside the process raises, and the bus projects. See
# src/reporting/message_bus/index.js raiseOnBus.
#
# Deduping is no longer this script's job either: identity is the channel plus
# the subject, so raising the same thing twice updates one message rather than
# queueing a second.
queue_agent_message() {
  local author_role="$1"
  local target_role="$2"
  local needs_answer="$3"
  local kind="$4"
  local summary="$5"
  local payload="$6"
  local ts
  local entry

  ts="$(now_iso)"
  mkdir -p "${messages_root}"
  entry="$(jq -nc     --arg channel "${author_role}->${target_role}:${kind}"     --arg from "${author_role}"     --arg to "${target_role}"     --arg subject "${summary}"     --arg kind "${kind}"     --arg ts "${ts}"     --argjson payload "${payload:-null}"     --arg asks "${needs_answer}"     '{
      channel: $channel,
      from_role: $from,
      to_roles: [$to],
      item_id: ($kind + ":" + ($subject | ascii_downcase | .[0:100])),
      subject: $subject,
      payload: $payload,
      asks_for: (if $asks == "true" then "decide what to do about this and say what you decided" else null end),
      raised_at: $ts
    }' 2>/dev/null || true)"
  if [ -z "${entry}" ]; then
    log "action=raise_on_bus_skipped reason=jq_failed target_role=${target_role} kind=${kind}"
    return 0
  fi
  printf '%s
' "${entry}" >> "${agent_raised_path}"
  log "action=raise_on_bus target_role=${target_role} kind=${kind} needs_answer=${needs_answer}"
}

safe_stamp_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

record_issue() {
  local code="$1"
  local severity="$2"
  local owner_role="$3"
  shift 3
  local detail="$*"
  WATCHDOG_ISSUES+=("${code}	${severity}	${owner_role}	${detail}")
  log "issue=${code} ${detail}"
}

issues_json() {
  if [ "${#WATCHDOG_ISSUES[@]}" -eq 0 ]; then
    printf '[]'
    return
  fi
  printf '%s\n' "${WATCHDOG_ISSUES[@]}" | jq -R -s '
    split("\n")
    | map(select(length > 0)
      | split("\t")
      | {
          code: .[0],
          severity: .[1],
          owner_role: .[2],
          detail: (.[3:] | join("\t"))
        })
  '
}

director_instructions_json() {
  if [ "${#WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS[@]}" -eq 0 ]; then
    printf '[]'
    return
  fi
  printf '%s\n' "${WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS[@]}" | jq -R -s '
    split("\n")
    | map(select(length > 0)
      | split("\t")
      | {
          issue_code: .[0],
          message_id: .[1],
          detail: (.[2:] | join("\t"))
        })
  '
}

lab_director_instruction_allowed() {
  local issue_code="$1"
  local stamp_path
  local now
  local last
  stamp_path="${labdirector_instruction_dir}/${cycle_id}-$(safe_stamp_name "${issue_code}").epoch"
  now="$(date +%s)"
  last="0"
  if [ -f "${stamp_path}" ]; then
    last="$(cat "${stamp_path}" 2>/dev/null || printf '0')"
  fi
  [ $((now - last)) -ge "${lab_director_instruction_cooldown_seconds}" ]
}

mark_lab_director_instruction() {
  local issue_code="$1"
  local stamp_path
  stamp_path="${labdirector_instruction_dir}/${cycle_id}-$(safe_stamp_name "${issue_code}").epoch"
  date +%s > "${stamp_path}"
}

queue_lab_director_instruction() {
  local issue_code="$1"
  local severity="$2"
  local message="$3"
  local detail="$4"
  local ts
  local message_id
  local payload
  local inbox_payload
  local dialogue_payload
  local action_payload

  if [ "${issue_code}" != "gate_score_stagnation" ] && ! lab_director_instruction_allowed "${issue_code}"; then
    return 0
  fi

  ts="$(now_iso)"
  message_id="msg-watchdog-${cycle_id}-$(date +%s)-$$"
  payload="$(jq -nc \
    --arg cycle_id "${cycle_id}" \
    --arg message_id "${message_id}" \
    --arg issue_code "${issue_code}" \
    --arg severity "${severity}" \
    --arg message "${message}" \
    --arg detail "${detail}" \
    '{
      cycle_id: $cycle_id,
      message_id: $message_id,
      author: "supervisor",
      source: "watch-cycle",
      kind: "supervisor_instruction",
      issue_code: $issue_code,
      severity: $severity,
      message: $message,
      requested_action: {
        kind: "lab_director_scientific_decision_required",
        supervisor_scope: "process_escalation_only",
        supervisor_must_not_author_analysis_plan: true,
        lab_director_must_author_research_instruction: true,
        prompt: $message
      },
      detail: $detail,
      role_boundary: {
        supervisor: "Own process health, completion pressure, and evidence-flow anomaly detection: detect stalls, stale or lagging gate refresh, off-target or unproductive scout loops, stale failed blockers, enforce role handoffs, restart or refresh operationally, and require LabDirector adjudication when execution patterns stop advancing evidence. The supervisor does not invent scientific hypotheses and must not author concrete research, dataset, or analysis instructions.",
        lab_director: "Own research strategy, hypothesis selection, evidence interpretation, and scientific corrective direction. LabDirector must author the concrete research decision, research-note update, and next-role assignment after supervisor escalation."
      }
    }')"
  inbox_payload="$(jq -nc --arg ts "${ts}" --argjson payload "${payload}" '{
    ts: $ts,
    type: "supervisor_instruction",
    payload: $payload
  }')"
  dialogue_payload="$(jq -nc --arg ts "${ts}" --argjson payload "${payload}" '{
    ts: $ts,
    event_type: "supervisor_to_labdirector_instruction",
    payload: $payload
  }')"
  action_payload="$(jq -nc --arg ts "${ts}" --argjson payload "${payload}" '{
    ts: $ts,
    event_type: "supervisor-directed-lab-director",
    payload: $payload
  }')"
  jsonl_append "${labdirector_inbox_path}" "${inbox_payload}"
  jsonl_append "${labdirector_dialogue_path}" "${dialogue_payload}"
  jsonl_append "${supervisor_actions_path}" "${action_payload}"
  queue_agent_message \
    "supervisor" \
    "lab-director" \
    "true" \
    "supervisor_instruction" \
    "${message}" \
    "${payload}"
  mark_lab_director_instruction "${issue_code}"
  WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS+=("${issue_code}	${message_id}	${detail}")
  log "action=lab_director_instruction issue=${issue_code} message_id=${message_id}"
}

append_supervisor_report() {
  local pending="$1"
  local running="$2"
  local completed="$3"
  local failed="$4"
  local resume_count="$5"
  local run_plan_count="$6"
  local event_age="$7"
  local issues
  local instructions
  local payload
  local action_payload
  local researcher_payload
  local researcher_dialogue_payload
  issues="$(issues_json)"
  instructions="$(director_instructions_json)"
  payload="$(jq -nc \
    --arg ts "$(now_iso)" \
    --arg cycle_id "${cycle_id}" \
    --arg status "watchdog_supervisor_report" \
    --arg pending "${pending}" \
    --arg running "${running}" \
    --arg completed "${completed}" \
    --arg failed "${failed}" \
    --arg cycle_status "${WATCHDOG_CYCLE_STATUS}" \
    --arg resume_count "${resume_count}" \
    --arg run_plan_count "${run_plan_count}" \
    --arg event_age "${event_age}" \
    --arg interval_seconds "${interval_seconds}" \
    --argjson issues "${issues}" \
    --argjson lab_director_instructions "${instructions}" \
    '{
      ts: $ts,
      cycle_id: $cycle_id,
      status: $status,
      report_scope: "process_progress_only",
      report_interval_seconds: ($interval_seconds | tonumber),
      to_role: "supervisor",
      from_role: "watch-cycle",
      cycle_status: $cycle_status,
      lane_counts: {
        pending: ($pending | tonumber),
        running: ($running | tonumber),
        completed: ($completed | tonumber),
        failed: ($failed | tonumber)
      },
      process_health: {
        resume_processes: ($resume_count | tonumber),
        run_plan_processes: ($run_plan_count | tonumber),
        event_age_seconds: ($event_age | tonumber)
      },
      issue_count: ($issues | length),
      issue_severity_counts: (
        reduce $issues[]? as $issue ({}; .[$issue.severity] = ((.[$issue.severity] // 0) + 1))
      ),
      issue_owner_counts: (
        reduce $issues[]? as $issue ({}; .[$issue.owner_role] = ((.[$issue.owner_role] // 0) + 1))
      ),
      lab_director_instruction_count: ($lab_director_instructions | length),
      communication_policy: {
        reports: "minimal process progress only",
        research_details: "excluded_from_watchdog_reports",
        agent_delivery: ["jsonl", "queue"]
      }
    }')"
  action_payload="$(jq -nc --argjson payload "${payload}" '{
    ts: $payload.ts,
    event_type: "watchdog-supervisor-report",
    payload: $payload
  }')"
  researcher_payload="$(jq -nc --argjson payload "${payload}" '{
    ts: $payload.ts,
    cycle_id: $payload.cycle_id,
    status: "watchdog_researcher_report",
    report_scope: "process_progress_only",
    to_role: "researcher",
    from_role: "watch-cycle",
    report_interval_seconds: $payload.report_interval_seconds,
    message: (
      "Watchdog process: status=\($payload.cycle_status), pending=\($payload.lane_counts.pending), running=\($payload.lane_counts.running), completed=\($payload.lane_counts.completed), failed=\($payload.lane_counts.failed); resume=\($payload.process_health.resume_processes), run_plan=\($payload.process_health.run_plan_processes), event_age_seconds=\($payload.process_health.event_age_seconds); issues=\($payload.issue_count); lab_director_instructions=\($payload.lab_director_instruction_count)"
    ),
    cycle_status: $payload.cycle_status,
    lane_counts: $payload.lane_counts,
    process_health: $payload.process_health,
    issue_count: $payload.issue_count,
    issue_severity_counts: $payload.issue_severity_counts,
    issue_owner_counts: $payload.issue_owner_counts,
    lab_director_instruction_count: $payload.lab_director_instruction_count,
    communication_policy: $payload.communication_policy
  }')"
  researcher_dialogue_payload="$(jq -nc --argjson payload "${researcher_payload}" '{
    ts: $payload.ts,
    event_type: "watchdog_researcher_report",
    payload: $payload
  }')"
  jsonl_append "${supervisor_watchdog_reports_path}" "${payload}"
  jsonl_append "${researcher_watchdog_reports_path}" "${researcher_payload}"
  jsonl_append "${supervisor_actions_path}" "${action_payload}"
  queue_agent_message \
    "watchdog" \
    "supervisor" \
    "false" \
    "watchdog_process_report" \
    "Process status: status=${WATCHDOG_CYCLE_STATUS}, pending=${pending}, running=${running}, completed=${completed}, failed=${failed}; issues=$(printf '%s' "${issues}" | jq -r 'length')" \
    "${payload}"
  if [ "${mirror_watchdog_reports_to_dialogue}" = "1" ]; then
    jsonl_append "${labdirector_dialogue_path}" "${researcher_dialogue_payload}"
  fi
  printf '%s\n' "${payload}" > "${supervisor_watchdog_state_path}"
  printf '%s\n' "${researcher_payload}" > "${researcher_watchdog_state_path}"
}

append_current_supervisor_report() {
  append_supervisor_report \
    "${WATCHDOG_PENDING}" \
    "${WATCHDOG_RUNNING}" \
    "${WATCHDOG_COMPLETED}" \
    "${WATCHDOG_FAILED}" \
    "${WATCHDOG_RESUME_COUNT}" \
    "${WATCHDOG_RUN_PLAN_COUNT}" \
    "${WATCHDOG_EVENT_AGE}"
}

require_tools() {
  local missing=()
  for tool in node jq stat find sort tail cut pgrep kill ps; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      missing+=("${tool}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    record_issue "missing_required_tools" "critical" "supervisor" "tools=${missing[*]}"
    return 1
  fi
  return 0
}

# shellcheck source=scripts/watchdog/lane_discovery.sh
source "${script_dir}/watchdog/lane_discovery.sh"

# shellcheck source=scripts/watchdog/open_source_agent_path.sh
source "${script_dir}/watchdog/open_source_agent_path.sh"

refresh_gate_outputs() {
  local ts
  local tmp
  local summary
  local -a refresh_cmd
  WATCHDOG_REFRESH_PENDING=""
  WATCHDOG_REFRESH_RUNNING=""
  WATCHDOG_REFRESH_COMPLETED=""
  WATCHDOG_REFRESH_FAILED=""
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="${run_logs}/${cycle_id}-watchdog-gate-refresh-${ts}.json"
  log "action=refresh_gate_outputs cycle_id=${cycle_id} mode=gate_fast"
  if [ -n "${RESEARCHLAB_WATCH_REFRESH_GATE_STUB:-}" ]; then
    refresh_cmd=(cat "${RESEARCHLAB_WATCH_REFRESH_GATE_STUB}")
  elif command -v timeout >/dev/null 2>&1; then
    refresh_cmd=(timeout "${refresh_cycle_timeout_seconds}" env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-gate --cycle-id "${cycle_id}")
  else
    refresh_cmd=(env NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${node_max_old_space_size}" node ./src/cli/index.js refresh-gate --cycle-id "${cycle_id}")
  fi
  if "${refresh_cmd[@]}" > "${tmp}" 2>&1; then
    summary="$(jq -c '{
      cycle_id,
      refresh_gate_fast,
      lane_counts: (.cycle_state.lane_counts // null),
      approval_readiness_score: (.approval_review.review.approval_readiness_score // .approval_review.approval_readiness_score // null),
      score_limiting_stage: (.approval_review.review.approval_stage_summary.score_limiting_stage // .approval_review.score_limiting_stage // null),
      gate_score: (.gate_review.review.score // .gate_review.score // null),
      gatekeeper_review_status: (.gate_review.review.gatekeeper_review_status // .gate_review.gatekeeper_review_status // null),
      pending_rubrics: (.gate_review.review.gatekeeper_pending_rubrics // .gate_review.pending_rubrics // null),
      recommended_actions: ([((.gate_review.review.recommended_followup_actions // .gate_review.recommended_followup_actions // [])[]) | {type, preferred_role, target_rubric, priority, priority_score}] | .[:8])
    }' "${tmp}" 2>/dev/null || true)"
    if [ -n "${summary}" ]; then
      WATCHDOG_REFRESH_PENDING="$(printf '%s' "${summary}" | jq -r '.lane_counts.pending // empty' 2>/dev/null || true)"
      WATCHDOG_REFRESH_RUNNING="$(printf '%s' "${summary}" | jq -r '.lane_counts.running // empty' 2>/dev/null || true)"
      WATCHDOG_REFRESH_COMPLETED="$(printf '%s' "${summary}" | jq -r '.lane_counts.completed // empty' 2>/dev/null || true)"
      WATCHDOG_REFRESH_FAILED="$(printf '%s' "${summary}" | jq -r '.lane_counts.failed // empty' 2>/dev/null || true)"
      printf '%s\n' "${summary}" | sed 's/^/gate-refresh-summary: /'
    fi
    rm -f "${tmp}"
  else
    record_issue "gate_refresh_failed" "warning" "supervisor" "log=${tmp}"
    tail -20 "${tmp}" | sed 's/^/gate-refresh-error: /' || true
  fi
}

watchdog_has_issue() {
  local issue_code="$1"
  if [ "${#WATCHDOG_ISSUES[@]}" -eq 0 ]; then
    return 1
  fi
  printf '%s\n' "${WATCHDOG_ISSUES[@]}" | awk -F '\t' -v code="${issue_code}" '$1 == code { found=1 } END { exit found ? 0 : 1 }'
}

check_once() {
  WATCHDOG_ISSUES=()
  WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS=()

  if ! require_tools; then
    return 1
  fi

  local pending
  local running
  local completed
  local failed
  local cycle_status
  local resume_count
  local run_plan_count
  local event_age
  local completion_age
  local now
  local deleted_hits
  local scout_stagnation
  local scout_stagnation_lanes
  local scout_stagnation_total_candidates
  local quality_anomalies
  local gate_score_stagnation
  local running_lane_health
  local running_lane_health_lanes
  local running_lane_health_reasons

  pending="$(state_count pending)"
  running="$(state_count running)"
  completed="$(state_count completed)"
  failed="$(state_count failed)"
  cycle_status="$(state_status)"
  resume_count="$(live_resume_count)"
  run_plan_count="$(live_run_plan_count)"
  now="$(date +%s)"
  if [ -f "${events_path}" ]; then
    event_age="$((now - $(stat_mtime_epoch "${events_path}")))"
  else
    event_age="${no_progress_seconds}"
  fi
  completion_age="$(completed_progress_age "${completed}" "${now}")"

  WATCHDOG_PENDING="${pending}"
  WATCHDOG_RUNNING="${running}"
  WATCHDOG_COMPLETED="${completed}"
  WATCHDOG_FAILED="${failed}"
  WATCHDOG_CYCLE_STATUS="${cycle_status}"
  WATCHDOG_RESUME_COUNT="${resume_count}"
  WATCHDOG_RUN_PLAN_COUNT="${run_plan_count}"
  WATCHDOG_EVENT_AGE="${event_age}"

  log "status cycle=${cycle_id} cycle_status=${cycle_status} pending=${pending} running=${running} completed=${completed} failed=${failed} resume_processes=${resume_count} run_plan_processes=${run_plan_count} event_age_seconds=${event_age} completion_age_seconds=${completion_age}"

  if [ "${cycle_status}" = "blocked_no_active_lanes" ]; then
    record_issue "cycle_blocked_no_active_lanes" "warning" "supervisor" "status=${cycle_status} pending=${pending} running=${running} completed=${completed} failed=${failed}"
    queue_lab_director_instruction \
      "cycle_blocked_no_active_lanes" \
      "process_attention" \
      "Process stall: the cycle has no active lanes. LabDirector must inspect the current evidence state, author the next research instruction or closure decision, update research notes, and assign the next role if more evidence is warranted. Supervisor is not prescribing the analysis plan." \
      "status=${cycle_status} pending=${pending} running=${running} completed=${completed} failed=${failed}"
  fi

  if [ "${failed}" != "0" ]; then
    record_issue "failed_lanes_present" "research_attention" "lab-director" "failed=${failed}"
    queue_lab_director_instruction \
      "failed_lanes_present" \
      "research_attention" \
      "Process anomaly: failed lanes are present. LabDirector must inspect the failure evidence, author the scientific corrective decision, update research notes, and assign the next role if more evidence is warranted. Supervisor is not prescribing the analysis plan." \
      "failed=${failed}"
  fi

  scout_stagnation="$(scout_materialization_stagnation_summary 2>/dev/null || true)"
  if [ -n "${scout_stagnation}" ]; then
    scout_stagnation_lanes="$(printf '%s' "${scout_stagnation}" | jq -r '.lane_ids | join(",")' 2>/dev/null || printf 'unknown')"
    scout_stagnation_total_candidates="$(printf '%s' "${scout_stagnation}" | jq -r '.totals.candidates_with_accession // .totals.candidate_count // 0' 2>/dev/null || printf '0')"
    record_issue \
      "scout_discovery_without_materialization_stagnation" \
      "research_blocker" \
      "lab-director" \
      "latest_scout_lanes=${scout_stagnation_lanes} candidates_with_accession=${scout_stagnation_total_candidates} fetched_bundle_count=0"
    queue_lab_director_instruction \
      "scout_discovery_without_materialization_stagnation" \
      "research_blocker" \
      "Process stall: repeated scout discovery produced accession-bearing candidates but no fetched or materialized bundles. LabDirector must author the scientific acquisition, pivot, validation, or closure decision in research notes and assign the next role if more evidence is warranted. Supervisor is not choosing the accession, dataset, or analysis plan." \
      "latest_scout_lanes=${scout_stagnation_lanes} candidates_with_accession=${scout_stagnation_total_candidates} fetched_bundle_count=0"
  fi

  quality_anomalies="$(supervisor_quality_anomalies 2>/dev/null || true)"
  if [ -n "${quality_anomalies}" ]; then
    while IFS=$'\t' read -r anomaly_code anomaly_severity anomaly_owner anomaly_detail anomaly_message; do
      [ -n "${anomaly_code}" ] || continue
      record_issue \
        "${anomaly_code}" \
        "${anomaly_severity}" \
        "${anomaly_owner}" \
        "${anomaly_detail}"
      queue_lab_director_instruction \
        "${anomaly_code}" \
        "${anomaly_severity}" \
        "${anomaly_message}" \
        "${anomaly_detail}"
    done < <(printf '%s' "${quality_anomalies}" | jq -r '
      .anomalies[]?
      | [
          (.code // "supervisor_quality_anomaly"),
          (.severity // "research_attention"),
          (.owner_role // "lab-director"),
          (.detail // ""),
          (.message // "Process anomaly: evidence-flow quality needs LabDirector adjudication. Supervisor is not prescribing the analysis plan.")
        ]
      | @tsv
    ' 2>/dev/null || true)
  fi

  gate_score_stagnation="$(gate_score_stagnation_summary 2>/dev/null || true)"
  if [ -n "${gate_score_stagnation}" ]; then
    while IFS=$'\t' read -r anomaly_code anomaly_severity anomaly_owner anomaly_detail anomaly_message; do
      [ -n "${anomaly_code}" ] || continue
      record_issue \
        "${anomaly_code}" \
        "${anomaly_severity}" \
        "${anomaly_owner}" \
        "${anomaly_detail}"
      queue_lab_director_instruction \
        "${anomaly_code}" \
        "${anomaly_severity}" \
        "${anomaly_message}" \
        "${anomaly_detail}"
    done < <(printf '%s' "${gate_score_stagnation}" | jq -r '
      .anomalies[]?
      | [
          (.code // "gate_score_stagnation"),
          (.severity // "research_blocker"),
          (.owner_role // "lab-director"),
          (.detail // ""),
          (.message // "Process anomaly: gate score stagnation needs LabDirector adjudication. Supervisor is not prescribing the analysis plan.")
        ]
      | @tsv
    ' 2>/dev/null || true)
    refresh_gate_outputs
    pending="${WATCHDOG_REFRESH_PENDING:-$(state_count pending)}"
    running="${WATCHDOG_REFRESH_RUNNING:-$(state_count running)}"
    completed="${WATCHDOG_REFRESH_COMPLETED:-$(state_count completed)}"
    failed="${WATCHDOG_REFRESH_FAILED:-$(state_count failed)}"
    cycle_status="$(state_status)"
    resume_count="$(live_resume_count)"
    run_plan_count="$(live_run_plan_count)"
    now="$(date +%s)"
    if [ -f "${events_path}" ]; then
      event_age="$((now - $(stat_mtime_epoch "${events_path}")))"
    else
      event_age="${no_progress_seconds}"
    fi
    completion_age="$(completed_progress_age "${completed}" "${now}")"
    WATCHDOG_PENDING="${pending}"
    WATCHDOG_RUNNING="${running}"
    WATCHDOG_COMPLETED="${completed}"
    WATCHDOG_FAILED="${failed}"
    WATCHDOG_CYCLE_STATUS="${cycle_status}"
    WATCHDOG_RESUME_COUNT="${resume_count}"
    WATCHDOG_RUN_PLAN_COUNT="${run_plan_count}"
    WATCHDOG_EVENT_AGE="${event_age}"
    if [ "${pending}" != "0" ] && [ "${running}" = "0" ] &&
       { [ "${event_age}" -ge "${no_progress_seconds}" ] || [ "${completion_age}" -ge "${no_progress_seconds}" ]; }; then
      record_issue "pending_lanes_without_progress_under_gate_stagnation" "warning" "supervisor" "pending=${pending} running=${running} event_age_seconds=${event_age} completion_age_seconds=${completion_age} completed=${completed}"
      restart_resume_cycle "pending_lanes_without_progress_under_gate_stagnation" "1"
    else
      start_resume_cycle
    fi
    append_current_supervisor_report
    return 0
  fi

  running_lane_health="$(running_lane_health_summary 2>/dev/null || true)"
  if [ -n "${running_lane_health}" ]; then
    running_lane_health_lanes="$(printf '%s' "${running_lane_health}" | jq -r '.lane_ids | join(",")' 2>/dev/null || printf 'unknown')"
    running_lane_health_reasons="$(printf '%s' "${running_lane_health}" | jq -r '[.problems[]? | "\(.lane_id):\(.reasons | join("+")) pid=\(.pid // "none")"] | join(",")' 2>/dev/null || printf 'unknown')"
    record_issue \
      "stale_or_zombie_running_lanes" \
      "warning" \
      "supervisor" \
      "lanes=${running_lane_health_lanes} reasons=${running_lane_health_reasons}"
    append_current_supervisor_report
    recover_stale_running_lanes "${running_lane_health}"
    append_current_supervisor_report
    return 0
  fi

  deleted_hits="$(deleted_harness_hits)"
  if [ -n "${deleted_hits}" ]; then
    record_issue "deleted_harness_launcher_errors" "warning" "supervisor" "files=$(printf '%s' "${deleted_hits}" | tr '\n' ',')"
    restart_resume_cycle "deleted_harness_binary"
    append_current_supervisor_report
    return 0
  fi

  if [ "${resume_count}" = "0" ] && [ "${run_plan_count}" = "0" ] && { [ "${pending}" != "0" ] || [ "${running}" = "0" ]; }; then
    record_issue "resume_cycle_not_running" "warning" "supervisor" "pending=${pending} running=${running}"
    start_resume_cycle
    append_current_supervisor_report
    return 0
  fi

  if [ "${pending}" != "0" ] && [ "${running}" = "0" ] && [ "${event_age}" -ge "${no_progress_seconds}" ]; then
    record_issue "pending_lanes_without_progress" "warning" "supervisor" "pending=${pending} running=${running} event_age_seconds=${event_age}"
    restart_resume_cycle "pending_lanes_without_progress"
  fi

  if [ "${pending}" != "0" ] && [ "${running}" = "0" ] && [ "${completion_age}" -ge "${no_progress_seconds}" ]; then
    record_issue "pending_lanes_without_completion_progress" "warning" "supervisor" "pending=${pending} running=${running} completion_age_seconds=${completion_age} completed=${completed}"
    restart_resume_cycle "pending_lanes_without_completion_progress"
  fi

  if context_refresh_allowed; then
    refresh_context_artifacts
  fi

  if correction_harvest_allowed; then
    run_correction_harvest
  fi

  local pre_verify_issue_count
  local pre_verify_instruction_count
  pre_verify_issue_count="${#WATCHDOG_ISSUES[@]}"
  pre_verify_instruction_count="${#WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS[@]}"
  append_current_supervisor_report

  verify_open_source_agent_path
  if [ "${#WATCHDOG_ISSUES[@]}" -ne "${pre_verify_issue_count}" ] ||
     [ "${#WATCHDOG_LAB_DIRECTOR_INSTRUCTIONS[@]}" -ne "${pre_verify_instruction_count}" ]; then
    append_current_supervisor_report
  fi
}

trap 'log "status=watchdog_exit"; rm -f "${pidfile}"' EXIT

if [ "${mode}" = "--once" ]; then
  check_once
  exit $?
fi

log "status=watchdog_start cycle=${cycle_id} interval_seconds=${interval_seconds} max_passes=${max_passes} max_concurrency=${max_concurrency} stale_seconds=${stale_seconds}"
while true; do
  check_once || true
  if watchdog_has_issue "gate_score_stagnation"; then
    sleep "${gate_score_fast_interval_seconds}"
  else
    sleep "${interval_seconds}"
  fi
done
