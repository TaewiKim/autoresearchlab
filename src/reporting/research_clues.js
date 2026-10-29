"use strict";

// The research clues the LabDirector keeps.
//
// The director's notebook (<cycle>-lab-director-research-notes.json) is a
// summary of the current state, rewritten at each decision: on
// cycle-a-20260919 it held two decision-log entries and three
// rejected hypotheses after a month, so what a lead taught the cycle left with
// the lead. A clue is the other kind of record: a thing found that is worth
// keeping whatever the lead does next -- a measured result, the prior art that
// closes a direction, what earned a high score, a path that is dead and why, a
// fact about the data, a question still open, an idea not yet tried.
//
// The register is the director's. It decides what is a clue, how important,
// and when one is used up. The harness stores them, keeps their history,
// carries them from one director lane to the next, and shows them to the owner.
// The director writes them in `research_clue_updates` in its decision; they are
// read back from the lane results (like experiment_request_decisions), applied
// once per lane in the order the lanes finished, and kept in
// state/<cycle>-research-clues.json.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KINDS = ["measured_result", "prior_art", "design_strength", "dead_end", "data_fact", "open_question", "idea"];
const IMPORTANCE = ["high", "medium", "low"];
const STATUSES = ["open", "in_use", "resolved", "retired"];
const MIN_STATEMENT_CHARS = 20;
const MAX_STATEMENT_CHARS = 600;
const MAX_TEXT_CHARS = 400;
const MAX_REFS = 6;
const MAX_HISTORY = 12;
const DIRECTOR_VIEW_LIMIT = 30;
// Live clues that may be `high` at once. The owner's rule (2026-10-29): left to
// itself the director marked 30 of 32 clues high, and asked to re-rank it did
// not, so `high` is a budget, not a label.
const MAX_HIGH_LIVE = 6;
const FEEDBACK_KEPT = 12;

function cluesPath(root, cycleId) {
  return path.join(root, "state", `${cycleId}-research-clues.json`);
}

function emptyRegister(cycleId) {
  return { cycle_id: cycleId, updated_at: null, clues: [], applied_lanes: {}, director_view: [] };
}

function readRegister(root, cycleId) {
  try {
    const value = JSON.parse(fs.readFileSync(cluesPath(root, cycleId), "utf8"));
    if (value && typeof value === "object" && Array.isArray(value.clues)) {
      return { ...emptyRegister(cycleId), ...value, applied_lanes: value.applied_lanes || {} };
    }
  } catch { /* none yet, or torn: start from what the lanes say */ }
  return emptyRegister(cycleId);
}

function writeRegister(root, cycleId, register) {
  const target = cluesPath(root, cycleId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(register, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function clip(value, limit) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clueId(statement) {
  const normal = String(statement).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `c-${crypto.createHash("sha1").update(normal).digest("hex").slice(0, 8)}`;
}

function refsOf(value) {
  return (Array.isArray(value) ? value : []).map((item) => clip(item, 200)).filter(Boolean).slice(0, MAX_REFS);
}

function note(clue, by, at, change) {
  clue.history = [...(clue.history || []), { by, at, change: clip(change, 300) }].slice(-MAX_HISTORY);
  clue.last_updated_by = by;
  clue.last_updated_at = at;
}

function isLive(clue) {
  return clue.status === "open" || clue.status === "in_use";
}

function liveHigh(register) {
  return register.clues.filter((clue) => isLive(clue) && clue.importance === "high");
}

function holders(register) {
  return liveHigh(register).map((clue) => `${clue.clue_id} (${clip(clue.statement, 70)})`).join("; ");
}

function clean(value) {
  return String(value ?? "").trim();
}

// Keep the live `high` clues within the budget. The ones to keep are those in
// use, then the most recently touched; the rest become `medium`, with the reason
// in their history and in what the director is told. Not a judgement about the
// science: a rule the owner set, applied the same way every time.
function enforceHighBudget(register, at, feedback) {
  let demoted = 0;
  while (liveHigh(register).length > MAX_HIGH_LIVE) {
    const victim = liveHigh(register).sort((a, b) =>
      (a.status === "in_use") - (b.status === "in_use")
      || Date.parse(a.last_updated_at || 0) - Date.parse(b.last_updated_at || 0))[0];
    victim.importance = "medium";
    note(victim, "harness", at, `importance high -> medium: more than ${MAX_HIGH_LIVE} live clues were high; the ones in use and the most recently touched kept it`);
    feedback.push({ kind: "demoted", clue_id: victim.clue_id, text: `Clue ${victim.clue_id} was set to medium: at most ${MAX_HIGH_LIVE} live clues can be high. To make it high again, update another from high to medium or low first.` });
    demoted += 1;
  }
  return demoted;
}

// One director's operations on the register. Returns what it did and what it
// refused (and why), so a malformed entry is visible, never silently lost.
// `feedback` collects what the director is told about it on its next lane.
function applyOperations(register, operations, by, at, feedback = []) {
  const done = [];
  const refused = [];
  const deferred = [];
  for (const raw of Array.isArray(operations) ? operations : []) {
    const op = String(raw?.op || "").trim().toLowerCase();
    if (op === "add") {
      const statement = clip(raw.statement, MAX_STATEMENT_CHARS);
      const kind = String(raw.kind || "").trim();
      if (statement.length < MIN_STATEMENT_CHARS) {
        refused.push({ op, why: `statement under ${MIN_STATEMENT_CHARS} characters` });
        continue;
      }
      if (!KINDS.includes(kind)) {
        refused.push({ op, why: `kind must be one of ${KINDS.join(", ")}`, statement: statement.slice(0, 60) });
        continue;
      }
      let importance = IMPORTANCE.includes(raw.importance) ? raw.importance : "medium";
      const id = clueId(statement);
      const existing = register.clues.find((clue) => clue.clue_id === id);
      if (existing) {
        existing.evidence_refs = [...new Set([...(existing.evidence_refs || []), ...refsOf(raw.evidence_refs)])].slice(0, MAX_REFS * 3);
        if (IMPORTANCE.indexOf(importance) < IMPORTANCE.indexOf(existing.importance)) existing.importance = importance;
        const reopened = existing.status === "retired" || existing.status === "resolved";
        if (reopened) existing.status = "open";
        note(existing, by, at, reopened ? "recorded again; reopened" : "recorded again");
        done.push({ op, clue_id: id, merged: true });
        continue;
      }
      if (importance === "high" && liveHigh(register).length >= MAX_HIGH_LIVE) {
        importance = "medium";
        feedback.push({ kind: "capped", clue_id: id, text: `Clue ${id} was recorded as medium: ${MAX_HIGH_LIVE} live clues are already high (${holders(register)}). To make it high, update one of those to medium or low first.` });
      }
      register.clues.push({
        clue_id: id,
        kind,
        statement,
        why_it_matters: clip(raw.why_it_matters, MAX_TEXT_CHARS),
        evidence_refs: refsOf(raw.evidence_refs),
        lead_key: raw.lead_key ? clip(raw.lead_key, 80) : null,
        importance,
        status: "open",
        first_recorded_by: by,
        first_recorded_at: at,
        last_updated_by: by,
        last_updated_at: at,
        history: [{ by, at, change: "recorded" }],
      });
      done.push({ op, clue_id: id, merged: false });
    } else if (op === "update") {
      const id = String(raw.clue_id || "").trim();
      const clue = register.clues.find((item) => item.clue_id === id);
      if (!clue) {
        refused.push({ op, why: "no such clue_id", clue_id: id });
        continue;
      }
      const status = raw.status == null ? null : String(raw.status).trim();
      const importance = raw.importance == null ? null : String(raw.importance).trim();
      const text = clip(raw.note, 300);
      if (status && !STATUSES.includes(status)) {
        refused.push({ op, why: `status must be one of ${STATUSES.join(", ")}`, clue_id: id });
        continue;
      }
      if (importance && !IMPORTANCE.includes(importance)) {
        refused.push({ op, why: `importance must be one of ${IMPORTANCE.join(", ")}`, clue_id: id });
        continue;
      }
      if ((status === "retired" || status === "resolved") && !text) {
        refused.push({ op, why: `a clue is ${status} with a note saying why`, clue_id: id });
        continue;
      }
      const changes = [];
      let queued = false;
      if (status && status !== clue.status) { clue.status = status; changes.push(`status ${status}`); }
      if (importance === "high" && clue.importance !== "high" && isLive(clue)) {
        // A lane may free a slot and fill it in the same breath: decide after the rest.
        deferred.push({ clue, text });
        queued = true;
      } else if (importance && importance !== clue.importance) {
        clue.importance = importance;
        changes.push(`importance ${importance}`);
      }
      if (raw.evidence_refs) {
        clue.evidence_refs = [...new Set([...(clue.evidence_refs || []), ...refsOf(raw.evidence_refs)])].slice(0, MAX_REFS * 3);
        changes.push("evidence added");
      }
      if (text) changes.push(text);
      if (queued && !changes.length) continue; // the promotion is decided with the rest, below
      if (!changes.length) {
        refused.push({ op, why: "nothing to change", clue_id: id });
        continue;
      }
      note(clue, by, at, changes.join("; "));
      done.push({ op, clue_id: id });
    } else {
      refused.push({ op: op || "(missing)", why: "op must be add or update" });
    }
  }
  for (const item of deferred) {
    const { clue } = item;
    if (!isLive(clue) || clue.importance === "high") continue;
    if (liveHigh(register).length >= MAX_HIGH_LIVE) {
      refused.push({ op: "update", why: `${MAX_HIGH_LIVE} live clues are already high`, clue_id: clue.clue_id });
      feedback.push({ kind: "refused", clue_id: clue.clue_id, text: `Clue ${clue.clue_id} could not be made high: ${MAX_HIGH_LIVE} live clues already are (${holders(register)}). Update one of those to medium or low first.` });
      continue;
    }
    clue.importance = "high";
    note(clue, by, at, ["importance high", clean(item.text)].filter(Boolean).join("; "));
    done.push({ op: "update", clue_id: clue.clue_id });
  }
  for (const entry of refused) {
    if (entry.clue_id && feedback.some((item) => item.clue_id === entry.clue_id && item.kind === "refused")) continue;
    feedback.push({ kind: "refused", clue_id: entry.clue_id || null, text: `Your ${entry.op} ${entry.clue_id ? `of ${entry.clue_id} ` : ""}was not applied: ${entry.why}.` });
  }
  return { done, refused };
}

function rankKey(clue) {
  const live = clue.status === "open" || clue.status === "in_use" ? 0 : 1;
  return [live, IMPORTANCE.indexOf(clue.importance), -Date.parse(clue.last_updated_at || 0)];
}

function byRank(left, right) {
  const a = rankKey(left);
  const b = rankKey(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

// What the next director is shown: the live clues first, the most important
// first, compact. The full register stays on disk.
function directorView(register, limit = DIRECTOR_VIEW_LIMIT) {
  return [...register.clues].sort(byRank).slice(0, limit).map((clue) => ({
    clue_id: clue.clue_id,
    kind: clue.kind,
    importance: clue.importance,
    status: clue.status,
    statement: clip(clue.statement, 280),
    why_it_matters: clip(clue.why_it_matters, 200),
    lead_key: clue.lead_key || null,
    evidence_refs: (clue.evidence_refs || []).slice(0, 3),
  }));
}

// Read the director lanes' decisions and fold in the ones not yet applied, in
// the order the lanes finished. Idempotent: a lane is applied once (by its
// result's modification time), the same statement merges instead of
// duplicating, and a register that is lost is rebuilt from the lanes.
function applyDirectorClueUpdates({ root, cycleId, now = new Date() }) {
  const lanesDir = path.join(root, "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir).filter((name) => name.includes("lab-director"));
  } catch {
    entries = []; // no lanes yet; the register may still be over its budget
  }
  const register = readRegister(root, cycleId);
  const pending = [];
  for (const laneId of entries) {
    const resultPath = path.join(lanesDir, laneId, "result.json");
    let stat;
    try {
      stat = fs.statSync(resultPath);
    } catch {
      continue;
    }
    if (register.applied_lanes[laneId] === stat.mtimeMs) continue;
    let operations = null;
    try {
      operations = JSON.parse(fs.readFileSync(resultPath, "utf8"))?.extracted_json?.research_clue_updates;
    } catch {
      continue;
    }
    pending.push({ laneId, mtimeMs: stat.mtimeMs, operations });
  }
  pending.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const applied = [];
  const refused = [];
  const told = [];
  for (const item of pending) {
    const at = new Date(item.mtimeMs).toISOString();
    const feedback = [];
    const result = applyOperations(register, item.operations, item.laneId, at, feedback);
    applied.push(...result.done.map((entry) => ({ ...entry, lane_id: item.laneId })));
    refused.push(...result.refused.map((entry) => ({ ...entry, lane_id: item.laneId })));
    told.push(...feedback.map((entry) => ({ ...entry, lane_id: item.laneId, at })));
    register.applied_lanes[item.laneId] = item.mtimeMs;
  }
  // The budget holds whatever the lanes did, and for a register that predates it.
  const budgetFeedback = [];
  const demoted = enforceHighBudget(register, new Date(now).toISOString(), budgetFeedback);
  told.push(...budgetFeedback.map((entry) => ({ ...entry, lane_id: "harness", at: new Date(now).toISOString() })));
  if (!pending.length && !demoted) {
    if (!register.updated_at && !register.clues.length) return { applied: [], refused: [], changed: false };
    return { applied: [], refused: [], changed: false, register };
  }
  register.updated_at = new Date(now).toISOString();
  register.director_view = directorView(register);
  register.refused_recent = refused.slice(-10);
  register.feedback = [...(register.feedback || []), ...told].slice(-FEEDBACK_KEPT);
  register.max_high_live = MAX_HIGH_LIVE;
  try {
    writeRegister(root, cycleId, register);
  } catch { /* observing must never stop a cycle */ }
  return { applied, refused, changed: applied.length > 0 || demoted > 0, register };
}

function summarize(register) {
  const live = register.clues.filter((clue) => clue.status === "open" || clue.status === "in_use");
  const count = (list, key, value) => list.filter((clue) => clue[key] === value).length;
  return {
    total: register.clues.length,
    live: live.length,
    high: count(live, "importance", "high"),
    by_kind: Object.fromEntries(KINDS.map((kind) => [kind, count(register.clues, "kind", kind)]).filter(([, n]) => n > 0)),
    updated_at: register.updated_at,
  };
}

// For `researchlab clues`.
function renderClues(register, { all = false } = {}) {
  const clues = [...register.clues].sort(byRank).filter((clue) => all || clue.status === "open" || clue.status === "in_use");
  if (!clues.length) {
    return register.clues.length
      ? "No live clues (use --all to list resolved and retired ones).\n"
      : "No research clues recorded yet: the LabDirector records them in its decisions.\n";
  }
  const lines = [];
  for (const clue of clues) {
    lines.push(`[${clue.importance}] ${clue.clue_id}  ${clue.kind}  ${clue.status}${clue.lead_key ? `  lead ${clue.lead_key}` : ""}`);
    lines.push(`    ${clue.statement}`);
    if (clue.why_it_matters) lines.push(`    why: ${clue.why_it_matters}`);
    if ((clue.evidence_refs || []).length) lines.push(`    evidence: ${clue.evidence_refs.join("; ")}`);
    lines.push(`    recorded by ${clue.first_recorded_by} ${String(clue.first_recorded_at).slice(0, 16)}; last ${String(clue.last_updated_at).slice(0, 16)}`);
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  KINDS,
  IMPORTANCE,
  STATUSES,
  applyDirectorClueUpdates,
  applyOperations,
  clueId,
  cluesPath,
  directorView,
  enforceHighBudget,
  MAX_HIGH_LIVE,
  readRegister,
  renderClues,
  summarize,
};
