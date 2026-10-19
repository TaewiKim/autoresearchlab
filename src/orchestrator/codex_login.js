"use strict";

// The owner-facing half of native/researchlab-harness/src/runtime/codex_login.rs.
//
// A revoked Codex login is not something the cycle can wait out or the
// supervisor can fix: on cycle-a-20260919, 2026-10-01, it stopped
// every lane for eleven hours while the lanes retried every five minutes and
// the maintainer spent four diagnoses on the same 401. The native lane runner
// writes state/<cycle>-codex-login-required.json when Codex says the login was
// revoked and removes it when a turn runs again. Here it is read for the owner
// (a line on stderr every pass) and for the maintainer (which waits instead of
// asking a logged-out Codex to diagnose its own login).

const fs = require("fs");
const os = require("os");
const path = require("path");

const LOGIN_REVOKED_PATTERNS = [
  "token_revoked",
  "refresh token was revoked",
  "please log out and sign in again",
  "refresh_token_reused",
  "refresh_token_invalidated",
];

function codexLoginMarkerPath({ cwd, cycleId }) {
  return path.join(cwd, ".research-lab", "state", `${cycleId}-codex-login-required.json`);
}

function codexLoginRevoked(text) {
  const haystack = String(text || "").toLowerCase();
  return LOGIN_REVOKED_PATTERNS.some((pattern) => haystack.includes(pattern));
}

function authIdentity(authJsonPath) {
  if (!authJsonPath) return null;
  let stat = null;
  try {
    stat = fs.statSync(authJsonPath);
  } catch {
    stat = null;
  }
  return {
    auth_json_path: authJsonPath,
    auth_json_mtime_ms: stat ? Math.floor(stat.mtimeMs) : null,
    auth_json_len: stat ? stat.size : null,
  };
}

// The marker, while it still describes the login on disk. A new sign-in
// rewrites auth.json, and from then on the login is the next lane's to judge:
// the maintainer need not wait for that lane to clear the marker.
function readCodexLoginRequired({ cwd, cycleId }) {
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(codexLoginMarkerPath({ cwd, cycleId }), "utf8"));
  } catch {
    return null;
  }
  if (!marker || marker.status !== "owner_action_required") return null;
  const recorded = marker.auth;
  if (recorded?.auth_json_path) {
    const now = authIdentity(recorded.auth_json_path);
    if (now.auth_json_mtime_ms !== recorded.auth_json_mtime_ms || now.auth_json_len !== recorded.auth_json_len) {
      return null;
    }
  }
  return marker;
}

function defaultAuthJsonPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
  return path.join(home, "auth.json");
}

// Written by the maintainer when its own Codex is refused, in the lanes'
// format, so the next pass waits whether or not a lane has run since.
function recordCodexLoginRequired({ cwd, cycleId, source, evidence, authJsonPath = null, env = process.env, now = new Date() }) {
  const markerPath = codexLoginMarkerPath({ cwd, cycleId });
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    existing = null;
  }
  const authPath = authJsonPath || defaultAuthJsonPath(env);
  const marker = {
    cycle_id: cycleId,
    status: "owner_action_required",
    detected_at: existing?.detected_at || now.toISOString(),
    updated_at: now.toISOString(),
    lane_id: source,
    reason: "The Codex login was revoked; no agent can run until the owner signs in again. Lanes keep retrying and resume on their own after the login.",
    owner_action: `Sign in again for CODEX_HOME=${path.dirname(authPath)}: \`codex login --device-auth\` (in Docker: docker exec -it <container> codex login --device-auth).`,
    auth: authIdentity(authPath),
    evidence: String(evidence || "").slice(0, 600),
  };
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

function codexLoginNotice(marker) {
  return `OWNER ACTION REQUIRED since ${marker.detected_at}: ${marker.reason} ${marker.owner_action}`;
}

module.exports = {
  codexLoginMarkerPath,
  codexLoginNotice,
  codexLoginRevoked,
  readCodexLoginRequired,
  recordCodexLoginRequired,
};
