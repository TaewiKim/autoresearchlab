#!/usr/bin/env bash
# Start (or resume) a research cycle from a request file, with the research
# process printed to the terminal.
#
#   scripts/run-cycle.sh <cycle-id> <request.md> [extra run-research options]
#
# Reads researchlab.env when present. Running it again with the same cycle id
# resumes that cycle where it stopped.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."

if [ $# -lt 2 ]; then
  echo "usage: scripts/run-cycle.sh <cycle-id> <request.md> [run-research options]" >&2
  exit 2
fi
cycle_id="$1"
request="$2"
shift 2
[ -f "$request" ] || { echo "request file not found: $request" >&2; exit 2; }
# Your settings; without them, the recommended ones. A cycle without the
# network settings gets no literature: the Codex sandbox blocks every lookup.
if [ -f researchlab.env ]; then
  # shellcheck disable=SC1091
  . ./researchlab.env
else
  echo "researchlab.env not found: using the recommended settings in researchlab.env.example"
  # shellcheck disable=SC1091
  . ./researchlab.env.example
fi

mkdir -p .research-lab/run-logs
log=".research-lab/run-logs/${cycle_id}.log"
echo "cycle ${cycle_id}: log ${log}"
# A Codex quota stop is waited out and resumed (--auto-resume-on-quota). Exit
# 75 means the harness source changed under the cycle (the maintainer committed
# a fix): start again on the new code. Any other exit ends the script.
while true; do
  set +e
  node src/cli/index.js run-research \
    --cycle-id "$cycle_id" \
    --prompt-file "$request" \
    --max-passes 8 \
    --max-supervisor-passes 0 \
    --max-concurrency 1 \
    --sleep-seconds 0 \
    --agent-runtime codex \
    --no-break-on-stagnation \
    --auto-resume-on-quota \
    "$@" 2>&1 | tee -a "$log"
  status=${PIPESTATUS[0]}
  set -e
  [ "$status" -eq 75 ] || exit "$status"
  echo "cycle ${cycle_id}: the harness changed; restarting on the new code" | tee -a "$log"
done
