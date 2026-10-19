#!/usr/bin/env node
// Codex input-token meter and hard stop.
//
// The lab records no token usage: the only usage signal it has is counting
// lanes that ALREADY failed with rate_limited (live_view/snapshot/cycle_state.js).
// That is after the fact and cannot hold a ceiling.
//
// What is measurable is what actually consumes the quota: the bytes we hand to
// codex. Every codex lane writes its exact prompt to `<lane>/prompt.txt`, so the
// cycle's cumulative input is the sum of those files. Driver lanes (scout,
// lab-runner) run python, not codex, and correctly have no prompt.txt.
//
// Estimate is chars/4 — the usual English+JSON rule of thumb. It is an estimate,
// not billing truth, and it UNDERCOUNTS in two known ways: a relaunched lane
// overwrites its prompt.txt (only the last attempt is counted), and multi-turn
// tool output inside a codex session is billed on later turns but never lands in
// prompt.txt. Treat the number as a floor.
"use strict";
const fs = require("fs");
const path = require("path");
const {
  DOCUMENT_STAGE_ROLES,
  documentStageAuthorization,
} = require("./progress_watchdog");
const { measureCodexUsage } = require("./codex_usage");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cycleId = flag("--cycle-id", "");
const root = flag("--root", "/opt/researchlab/.research-lab");
const killScript = flag("--kill-script", "");
const ceilingMb = Number(flag("--ceiling-mb", "52"));
// The write-up's own pot. 0 (the default) means no separation: one ceiling for
// the whole cycle, exactly as before. It opens only against a valid document
// authorisation, so it can never be a silently raised ceiling.
const documentCeilingMb = Number(flag("--document-ceiling-mb", "0")) || 0;
// How recently a lane must have failed on quota for the provider to count as
// unavailable NOW. Without a window the count is cumulative and a single
// transient outage halts the cycle for good.
const quotaWindowMinutes = Number(flag("--quota-window-minutes", "30")) || 30;
if (!cycleId) {
  console.error("token_budget_guard: --cycle-id is required");
  process.exit(2);
}

const laneRoot = path.join(root, "lanes", cycleId);
let promptBytes = 0;
let documentBytes = 0;
let lanes = 0;
const byRole = {};
try {
  for (const lane of fs.readdirSync(laneRoot)) {
    const p = path.join(laneRoot, lane, "prompt.txt");
    let size;
    try {
      size = fs.statSync(p).size;
    } catch {
      continue;
    }
    lanes += 1;
    promptBytes += size;
    const role = lane.replace(/^followup-/, "").replace(/-[0-9]+$/, "").replace(/-recovery$/, "");
    byRole[role] = (byRole[role] || 0) + size;
    if (DOCUMENT_STAGE_ROLES.has(role)) documentBytes += size;
  }
} catch {
  // cycle has not opened any lane yet
}

// Spend is not health. On cycle-g-v80 this meter read 0.1% of the ceiling while
// EVERY codex lane was failing with `quota_exceeded` and returning a degraded
// fallback payload - a quota-dead cycle spends almost nothing, so a low number
// here looked reassuring and was the opposite. Count the failures too.
let quotaExceeded = 0;
let quotaExceededTotal = 0;
let degraded = 0;
const quotaCutoff = Date.now() - quotaWindowMinutes * 60 * 1000;
try {
  for (const lane of fs.readdirSync(laneRoot)) {
    let result;
    try {
      result = JSON.parse(fs.readFileSync(path.join(laneRoot, lane, "result.json"), "utf8"));
    } catch {
      continue;
    }
    if (result.failure_category === "quota_exceeded") {
      quotaExceededTotal += 1;
      // Judge the provider by whether it is still refusing, not by whether it
      // ever refused. A live outage keeps producing fresh failures.
      let failedAt = 0;
      try {
        failedAt = fs.statSync(path.join(laneRoot, lane, "result.json")).mtimeMs;
      } catch {
        failedAt = 0;
      }
      if (failedAt >= quotaCutoff) quotaExceeded += 1;
    } else if (result.degraded === true) degraded += 1;
  }
} catch {}

// Megabytes are not what anyone is deciding with. The two units that mean
// something here are gate ROUNDS (the cycle's actual output — a scored hypothesis)
// and completed RUNNERS (the evidence those rounds score). Reporting spend against
// them turns the ceiling into "about N more rounds" instead of a number nobody can
// act on, and the MB-per-round ratio is the honest productivity signal: cycle-g-v79
// spent 100.43MB for 29 rounds, ~3.5MB each.
let gateRounds = 0;
try {
  gateRounds = fs
    .readFileSync(path.join(root, "state", `${cycleId}-hypothesis-progress.jsonl`), "utf8")
    .split(String.fromCharCode(10))
    .filter((line) => line.includes('"acmcp.hypothesis_progress/1"')).length;
} catch {}
let runnersCompleted = 0;
let runnersLaunched = 0;
try {
  for (const lane of fs.readdirSync(laneRoot)) {
    if (!/runner/.test(lane)) continue;
    if (fs.existsSync(path.join(laneRoot, lane, "events.jsonl"))) runnersLaunched += 1;
    if (fs.existsSync(path.join(laneRoot, lane, "result.json"))) runnersCompleted += 1;
  }
} catch {}

const mb = promptBytes / 1048576;
const estTokens = Math.round(promptBytes / 4);
// Separation is real only when the owner has set a document ceiling AND the
// document stage is authorised. Otherwise every byte stays in the one pot and
// the ceiling means what it has always meant.
const documentAuthorization = documentStageAuthorization(root, cycleId);
const budgetIsSplit = documentCeilingMb > 0 && Boolean(documentAuthorization);
const documentMb = documentBytes / 1048576;
const researchMb = budgetIsSplit ? mb - documentMb : mb;
const spentMb = budgetIsSplit ? researchMb : mb;
const pct = ceilingMb > 0 ? (100 * spentMb) / ceilingMb : 0;
const documentPct = documentCeilingMb > 0 ? (100 * documentMb) / documentCeilingMb : 0;
// The runtime's own accounting, read from the turn.completed events every lane
// already writes. Costs about three seconds over a thousand lanes, and it is
// the only number here that is not a guess.
let reportedUsage = null;
try {
  const usage = measureCodexUsage({ root, cycleId });
  reportedUsage = {
    source: usage.source,
    lanes: usage.lanes,
    turns: usage.turns,
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    billed_input_tokens: usage.billed_input_tokens,
    cache_hit_ratio: usage.cache_hit_ratio,
    output_tokens: usage.output_tokens,
    reasoning_output_tokens: usage.reasoning_output_tokens,
    billed_input_tokens_by_role: Object.fromEntries(
      Object.entries(usage.by_role)
        .sort((a, b) => b[1].billed_input_tokens - a[1].billed_input_tokens)
        .map(([role, value]) => [role, value.billed_input_tokens]),
    ),
    // The lanes worth looking at when the bill is a surprise.
    costliest_lanes: usage.lanes_measured.slice(0, 10).map((lane) => ({
      lane_id: lane.lane_id,
      role: lane.role,
      billed_input_tokens: lane.billed_input_tokens,
      turns: lane.turns,
    })),
  };
} catch {
  // A cycle with no codex lane yet reports nothing, which is not an error.
}

const status = {
  cycle_id: cycleId,
  measured_at: new Date().toISOString(),
  codex_lanes: lanes,
  prompt_bytes: promptBytes,
  prompt_mb: Number(mb.toFixed(2)),
  estimated_input_tokens: estTokens,
  ceiling_mb: ceilingMb,
  percent_of_ceiling: Number(pct.toFixed(1)),
  budget_is_split: budgetIsSplit,
  document_only: fs.existsSync(path.join(root, "state", `${cycleId}-document-only.json`)),
  research_mb: Number(researchMb.toFixed(2)),
  document_mb: Number(documentMb.toFixed(2)),
  document_ceiling_mb: documentCeilingMb || null,
  document_percent_of_ceiling: documentCeilingMb > 0 ? Number(documentPct.toFixed(1)) : null,
  document_stage_roles: [...DOCUMENT_STAGE_ROLES],
  by_role_mb: Object.fromEntries(
    Object.entries(byRole)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, Number((v / 1048576).toFixed(2))]),
  ),
  gate_rounds: gateRounds,
  runners_completed: runnersCompleted,
  runners_launched: runnersLaunched,
  mb_per_gate_round: gateRounds > 0 ? Number((mb / gateRounds).toFixed(2)) : null,
  gate_rounds_left_at_this_rate:
    gateRounds > 0 ? Math.max(0, Math.floor((ceilingMb - spentMb) / (spentMb / gateRounds))) : null,
  quota_exceeded_lanes: quotaExceeded,
  quota_exceeded_lanes_total: quotaExceededTotal,
  quota_window_minutes: quotaWindowMinutes,
  degraded_lanes: degraded,
  estimate_basis: "sum of per-lane prompt.txt / 4 chars-per-token; a floor, not billing truth",
  // What the provider itself reported, per turn. The estimate above is what the
  // ceiling is calibrated in and stays the number thresholds compare against;
  // this is what was actually spent, and the two differ by more than a factor
  // of two because tool output inside a session is billed and never reaches
  // prompt.txt.
  reported_usage: reportedUsage,
};
const statusPath = path.join(root, "state", `${cycleId}-token-budget.json`);
fs.mkdirSync(path.dirname(statusPath), { recursive: true });
fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
const left = gateRounds > 0 ? Math.max(0, Math.floor((ceilingMb - spentMb) / (spentMb / gateRounds))) : null;
console.log(
  "[token-budget] " + status.measured_at +
    " " + spentMb.toFixed(2) + "MB/" + ceilingMb + "MB (" + pct.toFixed(1) + "%)" +
    (budgetIsSplit
      ? "  doc " + documentMb.toFixed(2) + "MB/" + documentCeilingMb + "MB (" + documentPct.toFixed(1) + "%)"
      : "") +
    "  rounds=" + gateRounds +
    "  runners=" + runnersCompleted + "/" + runnersLaunched +
    (gateRounds > 0
      ? "  " + (mb / gateRounds).toFixed(2) + "MB per round, ~" + left + " rounds left"
      : "  (no gate round yet)") +
    "  lanes=" + lanes + "  quota_exceeded=" + quotaExceeded + "  degraded=" + degraded +
    (reportedUsage
      ? "  | reported billed_input=" + reportedUsage.billed_input_tokens.toLocaleString() +
        " (" + (reportedUsage.cache_hit_ratio * 100).toFixed(1) + "% cached)" +
        " output=" + reportedUsage.output_tokens.toLocaleString()
      : ""),
);

if (quotaExceeded > 0) {
  const qHalt = path.join(root, "state", `${cycleId}-watchdog-halt.json`);
  fs.writeFileSync(qHalt, JSON.stringify({
    cycle_id: cycleId,
    halted_at: new Date().toISOString(),
    signatures: [{
      signature: "codex_quota_exhausted",
      severity: "halt",
      evidence: status,
      recommended_action: `Codex returned quota_exceeded on ${quotaExceeded} lane(s) within the last ${quotaWindowMinutes} minutes (${quotaExceededTotal} in the cycle's whole history). This is a provider limit, NOT a scientific verdict and NOT this cycle's ceiling - prompt spend reads LOW precisely because the lanes never ran. Wait for the quota window to reset; once no lane has failed this way inside the window, this signature stops firing and the cycle can resume where it stopped rather than starting over.`,
    }],
    snapshot: status,
    note: "Fail-safe halt by token_budget_guard.",
  }, null, 2));
  console.log(`[token-budget] QUOTA EXCEEDED on ${quotaExceeded} lane(s) - halt written to ${qHalt}`);
  if (killScript && fs.existsSync(killScript)) {
    require("child_process").spawnSync("bash", [killScript], { stdio: "inherit" });
  }
  process.exit(1);
}

// Each pot is judged against its own ceiling. The write-up running out is a
// different fact from the research lanes running out, and conflating them is what
// let 90% research churn decide how much budget was left to finish a paper.
const documentExhausted = budgetIsSplit && documentMb >= documentCeilingMb;
const researchExhausted = spentMb >= ceilingMb;

// Research is spent and the write-up is not: the cycle does not die, it stops
// being a research cycle. A halt here would leave the document pot unspent,
// which is the exact outcome separating the pots was meant to prevent.
const documentOnlyPath = path.join(root, "state", `${cycleId}-document-only.json`);
const documentOnly = budgetIsSplit && researchExhausted && !documentExhausted;
if (documentOnly) {
  if (!fs.existsSync(documentOnlyPath)) {
    fs.writeFileSync(
      documentOnlyPath,
      JSON.stringify(
        {
          cycle_id: cycleId,
          document_only: true,
          entered_at: new Date().toISOString(),
          reason: `research lanes reached ${researchMb.toFixed(2)}MB of their ${ceilingMb}MB ceiling while the write-up had ${(documentCeilingMb - documentMb).toFixed(2)}MB of its own left; finishing the paper is the authorised goal`,
          research_mb: Number(researchMb.toFixed(2)),
          research_ceiling_mb: ceilingMb,
          document_mb: Number(documentMb.toFixed(2)),
          document_ceiling_mb: documentCeilingMb,
          snapshot: status,
        },
        null,
        2,
      ),
    );
    console.log(`[token-budget] RESEARCH CEILING REACHED — document-only mode written to ${documentOnlyPath}`);
  }
  process.exit(0);
}

if (!documentExhausted && !researchExhausted) process.exit(0);

// Over the ceiling: stop the cycle the same way the progress watchdog does, so
// the launcher wrapper refuses to relaunch.
const haltPath = path.join(root, "state", `${cycleId}-watchdog-halt.json`);
fs.writeFileSync(
  haltPath,
  JSON.stringify(
    {
      cycle_id: cycleId,
      halted_at: new Date().toISOString(),
      signatures: [
        {
          signature: documentExhausted
            ? "document_input_budget_ceiling"
            : "codex_input_budget_ceiling",
          severity: "halt",
          evidence: status,
          recommended_action: documentExhausted
            ? `The write-up reached its OWN ceiling: ${documentMb.toFixed(2)}MB of ${documentCeilingMb}MB across ${[...DOCUMENT_STAGE_ROLES].join(", ")}. Research spend did not cause this and raising the research ceiling will not help. Either raise --document-ceiling-mb deliberately or cut what the document lanes are being handed.`
            : budgetIsSplit
              ? `Research lanes reached their ceiling: ${researchMb.toFixed(2)}MB of ${ceilingMb}MB, with the write-up's ${documentMb.toFixed(2)}MB counted separately and untouched. This is a spend limit, NOT a scientific verdict. Review state/<cycle>-token-budget.json for which role spent it, then either raise --ceiling-mb deliberately or cut that role's context.`
              : "The cycle reached its codex input ceiling. This is a spend limit, NOT a scientific verdict: nothing is wrong with the run. Review state/<cycle>-token-budget.json to see which role spent it, then either raise --ceiling-mb deliberately or cut that role's context before resuming.",
        },
      ],
      snapshot: status,
      note: "Fail-safe halt by token_budget_guard. Clearing this file without raising the ceiling will just re-halt.",
    },
    null,
    2,
  ),
);
console.log(`[token-budget] ${documentExhausted ? "DOCUMENT" : "RESEARCH"} CEILING REACHED — halt written to ${haltPath}`);
if (killScript && fs.existsSync(killScript)) {
  require("child_process").spawnSync("bash", [killScript], { stdio: "inherit" });
}
process.exit(1);
