#!/usr/bin/env bash
# Wrapper so the Rust harness's ``Command::new(string)`` codex_command
# resolver, which only accepts a single executable path, can launch
# the multi-arg ``node claude_codex_shim.js`` call.
#
# Usage:
#   export RESEARCHLAB_CODEX_CMD="$(cd "$(dirname "$0")" && pwd)/claude_codex_shim.sh"
#   researchlab run-research --prompt "..." --auto-resume-on-quota
#
# The shim translates codex-style invocations into Claude Code calls.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "${SCRIPT_DIR}/claude_codex_shim.js" "$@"
