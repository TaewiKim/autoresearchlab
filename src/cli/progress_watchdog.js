"use strict";

// Progress watchdog (Level-1 self-healing: detect -> halt -> diagnose).
//
// The harness self-heals PROCESS faults (heap-bounded relaunch) but is blind to
// OUTCOME stalls: it measures activity (lanes completing, decisions appending),
// never progress (gate rounds advancing, soundness compounding, budget being
// spent toward convergence). Every dead cycle in the 2026-07 run burned hours of
// budget in a state this watchdog would have caught within minutes:
//   * cycle-g-v58: 427 requery lanes, 0 gate rounds, 27 relaunches (requery storm)
//   * cycle-g-v59: 57 stall-pivots, gatekeeper budget to its 192 ceiling with no
//     lead accumulating soundness
//   * v55/v56/v57: the same budget wall without convergence.
//
// This is an OBSERVER: it never touches dispatch logic. It samples outcome
// metrics on an interval, appends them to an append-only history, evaluates
// stall signatures over a time window, and on a confirmed signature performs a
// FAIL-SAFE HALT: write a structured diagnosis artifact, then stop the cycle via
// the provided kill script. It deliberately does NOT restart anything — a halted
// cycle needs a diagnosis-driven fix (agent or human), not a blind retry; blind
// retry IS the failure mode it exists to stop.
//
// Usage (invoked by the launch wrapper on an interval):
//   node src/cli/progress_watchdog.js --cycle-id <id> --root <.research-lab dir> \
//     --kill-script <path to kill-vNN.sh> [--dry-run]

const fs = require("fs");
const path = require("path");
const { recordStateWrite } = require("../provenance/state_provenance");
const {
  archiveAuthoritativeState,
  restoreMissingAuthoritativeState,
} = require("../provenance/state_archive");
const { questionChurnSummary } = require("../reporting/question_persistence");
const { writeFileAtomic } = require("../shared/json");
const { execFileSync } = require("child_process");

// --- thresholds (all derived from measured death signatures, see header) ------
const WARMUP_MINUTES = 45; // no verdicts while a fresh cycle is still booting
const FLATLINE_WINDOW_MINUTES = 90; // R2 lookback
const FLATLINE_MIN_NEW_LANES = 20; // R2: this much activity with zero gate rounds
// R5: three aborts inside one window is a loop, not a blip. A single abort
// can be transient; cycle-g-v85 logged 106.
const CRASH_LOOP_MIN_NEW_ABORTS = 3;
const REQUERY_STORM_MIN_DIRECTOR_LANES = 100; // R1 (v58 hit 537; healthy v60 stayed <50)
const REQUERY_STORM_DIRECTOR_TO_SCOUT_RATIO = 2; // R1
// R1: how many director lanes per gate round still counts as work rather than a
// loop. A storm re-dispatches the director without the gate ever moving; healthy
// operation spends roughly one director on each round. cycle-g-v89 sat at 0.92
// (113 directors, 123 rounds) and was halted by the ratio test anyway.
const REQUERY_STORM_DIRECTORS_PER_GATE_ROUND = 3; // R1
const BUDGET_WALL_FRACTION = 0.9; // R3: >=90% of the follow-up budget
const SOUNDNESS_BURN_GATEKEEPER_MIN = 150; // R4
const SOUNDNESS_BURN_MAX_BEST = 30; // R4: best tech/repro still below this
// The cycle's one follow-up budget, shared by every role. It mirrors
// total_followup_cap() in the Rust harness (dispatch_support/budget_caps.rs),
// which stops creating follow-ups for every role once it is spent; the walls
// below are fractions of the same number, so the watchdog and the dispatcher
// cannot disagree about how much is left.
//
// Until 2026-10-03 there was a cap per role, mirrored here as DEFAULT_CAPS x an
// exempt multiplier. On cycle-a-20260919, a nine-day cycle, those
// role caps were the cause of one stall after another (engineer 240 of 240,
// director 321 of 320, chronicle 167 of 160), and the owner made it one budget.
const FOLLOWUP_BUDGET = Number.parseInt(process.env.RESEARCHLAB_FOLLOWUP_BUDGET || "", 10) >= 1
  ? Number.parseInt(process.env.RESEARCHLAB_FOLLOWUP_BUDGET, 10)
  : 4096;

const DOCUMENT_STAGE_ROLES = new Set(["author", "illustrator"]);

// The roles a follow-up lane id can name, for counting.
const FOLLOWUP_ROLES = [
  "lab-runner", "analyst", "scout", "chronicle", "gatekeeper", "lab-director", "author", "illustrator", "engineer",
];

/** Follow-up lanes spent against the budget; the paper's lanes do not count under a document authorisation. */
function spentFollowups(roles, documentAuthorization) {
  return Object.entries(roles || {}).reduce(
    (sum, [role, count]) =>
      documentAuthorization && DOCUMENT_STAGE_ROLES.has(role) ? sum : sum + (Number(count) || 0),
    0,
  );
}

// Owner decision: when the programme moves to writing the paper, the budget goes
// up again.
//
// R3 halts when a role nears its exempt ceiling AND the hypothesis gate has not
// passed. Once the owner authorises the document stage, that second condition is
// no longer a symptom -- it is the premise. cycle-g-v89 was authorised precisely
// because its gate would not pass and the science was worth writing up anyway,
// so leaving R3 as it stands halts the cycle for the reason it was told to
// proceed under.
//
// On a valid authorisation the roles that do the document work are not counted
// against the wall, because their spend IS the authorised goal. Everything else
// still is, so a cycle that keeps churning research lanes under a document
// authorisation still hits the wall.

// Read the pivot path directly: the director's replacement_hypotheses are where
// leads actually change, and until this cycle they carried no question at all.
function questionChurnFromDirectorLanes(root, cycleId) {
  try {
    const lanesDir = path.join(root, "lanes", cycleId);
    const outputs = [];
    for (const name of fs.readdirSync(lanesDir)) {
      if (!name.includes("lab-director")) continue;
      const resultPath = path.join(lanesDir, name, "result.json");
      if (!fs.existsSync(resultPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
        const extracted = parsed?.extracted_json;
        if (extracted) outputs.push(extracted);
      } catch (error) {
        // A torn result file must not blind the whole check.
      }
    }
    return outputs.length ? questionChurnSummary(outputs) : null;
  } catch (error) {
    return null;
  }
}

function documentStageAuthorization(root, cycleId) {
  try {
    const filePath = path.join(root, "state", `${cycleId}-document-authorization.json`);
    if (!fs.existsSync(filePath)) return null;
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Same fail-closed shape the Rust gate and the document builder use: an
    // authorisation nobody can account for later is a silently raised ceiling.
    if (record?.authorized !== true) return null;
    if (!String(record?.reason || "").trim()) return null;
    return record;
  } catch (error) {
    return null;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--dry-run") {
      args.dryRun = true;
    } else if (key.startsWith("--")) {
      args[key.slice(2).replace(/-/g, "_")] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // tolerate a torn concurrent append
    }
  }
  return rows;
}

function roleOfLane(laneId) {
  const id = String(laneId).replace(/^followup-/, "");
  for (const role of FOLLOWUP_ROLES) {
    if (id.startsWith(role)) return role;
  }
  // "runner-NN" shorthand belongs to lab-runner
  if (id.startsWith("runner")) return "lab-runner";
  return "other";
}

// How many times the supervisor has aborted for this cycle, and why the last one
// went. Read from the launcher log rather than any state file, because a run
// that dies before writing state leaves no other trace -- which is exactly the
// case this exists to catch.
const CRASH_LOOP_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const ABORT_LINE_RE = /run-research aborted:.*/g;
// A cycle id as the launchers write them: a name, then a date.
const OTHER_CYCLE_RE = /\b[a-z0-9][a-z0-9-]*-v\d+-\d{8}\b/;

/** When this cycle's lane directory first appeared, or 0 if it has not. */
function cycleStartedAtMs(root, cycleId) {
  try {
    return fs.statSync(path.join(root, "lanes", cycleId)).birthtimeMs
      || fs.statSync(path.join(root, "lanes", cycleId)).ctimeMs
      || 0;
  } catch {
    return 0;
  }
}

function abortsForCycle(root, cycleId) {
  const cycleStartedAt = cycleStartedAtMs(root, cycleId);
  let total = 0;
  let latest = null;
  let logs = [];
  try {
    logs = fs
      .readdirSync(root)
      .filter((name) => name.endsWith(".log"))
      .map((name) => path.join(root, name));
  } catch {
    return { abort_count: 0, latest_abort: null };
  }
  for (const file of logs) {
    let text = "";
    try {
      const size = fs.statSync(file).size;
      const start = Math.max(0, size - CRASH_LOOP_LOG_TAIL_BYTES);
      const fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const hits = text.match(ABORT_LINE_RE);
    if (!hits) continue;
    // Whose log is this?
    //
    // Matching on the cycle id appearing in the text was the obvious rule and it
    // starved R5 completely. MEASURED ON cycle-g-v90: the supervisor aborted 1,650
    // times over three hours and the watchdog never evaluated the rule, because a
    // supervisor that dies inside `runResearch` writes a wrapper line, an error and
    // a stack trace -- and NONE of those contain the cycle id. A 1.43 MB log of
    // pure crash loop mentioned `cycle-g-v90-20260911` exactly zero times.
    //
    // That is the shape of the thing R5 exists to catch: a run that dies before it
    // can say what it was working on. Requiring it to say so first is requiring the
    // evidence the failure destroys.
    //
    // So a log counts when it names THIS cycle, or when it names no cycle at all
    // and was written during this one. A log naming a DIFFERENT cycle is still
    // skipped -- that is what the guard was actually for.
    const namesThisCycle = text.includes(cycleId);
    const namesAnotherCycle = OTHER_CYCLE_RE.test(text) && !namesThisCycle;
    if (!namesThisCycle) {
      if (namesAnotherCycle) continue;
      let writtenDuringThisCycle = false;
      try {
        writtenDuringThisCycle = fs.statSync(file).mtimeMs >= cycleStartedAt;
      } catch {
        writtenDuringThisCycle = false;
      }
      if (!writtenDuringThisCycle) continue;
    }
    total += hits.length;
    latest = hits[hits.length - 1].slice(0, 300);
  }
  return { abort_count: total, latest_abort: latest };
}

// When each runner lane that measured something finished, oldest first.
//
// A gate round can only move a rubric if it had something new to read: a
// different lead, or evidence that did not exist at the previous round.
// MEASURED ON cycle-g-v91, 2026-09-14: eight gatekeeper lanes queued at 08:59 ran
// at 10:11-10:24 against a lead chosen at 09:43, whose newest runner evidence was
// from 09:37. Round 48 re-read exactly what round 47 had read, scored no rubric
// higher -- it could not -- and was the fifth flat round that halted the cycle.
function runnerEvidenceTimes(lanesDir) {
  const times = [];
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir);
  } catch {
    return times;
  }
  for (const entry of entries) {
    if (roleOfLane(entry) !== "lab-runner") continue;
    const laneDir = path.join(lanesDir, entry);
    const finalStatusPath = path.join(laneDir, "final-status.json");
    try {
      const finalStatus = JSON.parse(fs.readFileSync(finalStatusPath, "utf8"));
      if (finalStatus?.status !== "completed") continue;
      const resultPath = path.join(laneDir, "result.json");
      if (fs.statSync(resultPath).size > 16 * 1024 * 1024) continue;
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      const measured = (Array.isArray(result?.blueprint_executions) ? result.blueprint_executions : []).some((run) =>
        typeof run?.produced_evidence === "boolean"
          ? run.produced_evidence
          // Results written before the driver recorded the flag.
          : run?.status === "completed" && run?.metrics && Object.keys(run.metrics).length > 0,
      );
      if (measured) times.push(fs.statSync(finalStatusPath).mtimeMs);
    } catch {
      // An unreadable lane is not evidence.
    }
  }
  return times.sort((a, b) => a - b);
}

// --- one outcome snapshot -----------------------------------------------------
function takeSnapshot({ root, cycleId, haltClearedAt = 0 }) {
  const lanesDir = path.join(root, "lanes", cycleId);
  const roleCounts = {};
  let lanesTotal = 0;
  let lanesCompleted = 0;
  if (fs.existsSync(lanesDir)) {
    for (const entry of fs.readdirSync(lanesDir)) {
      const laneDir = path.join(lanesDir, entry);
      let isDir = false;
      try {
        isDir = fs.statSync(laneDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      lanesTotal += 1;
      const role = roleOfLane(entry);
      roleCounts[role] = (roleCounts[role] || 0) + 1;
      if (fs.existsSync(path.join(laneDir, "final-status.json"))) lanesCompleted += 1;
    }
  }

  const progress = readJsonl(path.join(root, "state", `${cycleId}-hypothesis-progress.jsonl`));
  let gateRounds = 0;
  let bestTech = 0;
  let bestRepro = 0;
  let gatePassed = false;
  // Churn and improvement, per round, in order.
  //
  // Owner rule 2026-08-20: judge each rubric on its own, and treat a rise in ANY
  // of them as progress. Not the composite, which a strong novelty score can
  // hold up while reproducibility sits at 4 - and not the minimum either, which
  // would call a cycle dead while novelty climbs 22 -> 48 because reproducibility
  // has not moved yet. A rubric only has to beat its OWN best to count.
  //
  // Measured reason for the permissiveness: on v81 the weakest rubric sat at 4
  // for five straight rounds and then jumped to 35. A three-round rule on the
  // minimum would have killed the cycle two rounds before its best result.
  const leadOrder = [];
  const bestByRubric = new Map();
  let roundsSinceImprovement = 0;
  // A flat round that re-read the same lead with no evidence newer than the
  // previous round is not a round that failed to improve; it had nothing it
  // could improve on. It is counted here instead, so it stays visible.
  const evidenceTimes = runnerEvidenceTimes(lanesDir);
  let previousRound = null;
  let roundsWithoutNewInput = 0;
  for (const row of progress) {
    if (row?.memory_type !== "decision" || !row?.content?.rubric) continue;
    const rowTimeMs = Date.parse(row?.ts || row?.content?.ts || "") || 0;
    gateRounds += 1;
    const roundLead = row.memory_id ? String(row.memory_id) : null;
    const nothingNewToReview = Boolean(
      previousRound &&
        roundLead &&
        previousRound.lead === roundLead &&
        previousRound.timeMs &&
        rowTimeMs &&
        !evidenceTimes.some((finishedAt) => finishedAt > previousRound.timeMs && finishedAt <= rowTimeMs),
    );
    previousRound = { lead: roundLead, timeMs: rowTimeMs };
    gatePassed = gatePassed || row.content.gate_passed === true;
    if (row.memory_id) leadOrder.push(String(row.memory_id));
    let improvedAnyRubric = false;
    let scoredAnyRubric = false;
    for (const item of row.content.rubric || []) {
      const name = String(item?.name || "").trim();
      const score = Number(item?.score);
      // A placeholder 100 is not evidence, and a rubric nobody scored yet is
      // not a zero - both are excluded rather than counted as progress.
      if (!name || item?.applicable === false || !Number.isFinite(score) || score >= 100) continue;
      scoredAnyRubric = true;
      const previousBest = bestByRubric.get(name);
      if (previousBest === undefined || score > previousBest) {
        bestByRubric.set(name, score);
        // The first time a rubric is scored at all is not an improvement to
        // count against a later stall; it is just the baseline appearing.
        if (previousBest !== undefined) improvedAnyRubric = true;
      }
    }
    if (scoredAnyRubric) {
      if (improvedAnyRubric) {
        roundsSinceImprovement = 0;
      } else if (nothingNewToReview) {
        roundsWithoutNewInput += 1;
      } else {
        roundsSinceImprovement += 1;
      }
    }
    // A deliberate halt clear restarts the STALL, never the bar.
    //
    // The stagnation counter is computed by replaying this append-only ledger, so
    // the five flat rounds that caused a halt are still the tail of the file after
    // the halt is cleared -- and the next pass re-halts before the cycle can do
    // anything about it. That is the same defect the flatline window had (see
    // historySinceHaltCleared): a halt that cannot be cleared by addressing its
    // cause can only be cleared by destroying evidence.
    //
    // MEASURED on cycle-g-v84, halted at rounds_since_improvement=5/5 with
    // novelty 38, technical_quality 35, reproducibility 76 -- all of which had
    // climbed from 20/18/5 within the preceding hour.
    //
    // bestByRubric is deliberately NOT reset. The high-water marks are real
    // measurements and they stay the bar to beat; resetting them would make the
    // next mediocre round read as an improvement, which is the one outcome that
    // would make this rule worthless.
    if (haltClearedAt && rowTimeMs && rowTimeMs < haltClearedAt) {
      roundsSinceImprovement = 0;
    }
    for (const item of row.content.rubric) {
      // Only independently reviewed scores count as soundness evidence; a
      // reasonless aggregation placeholder (e.g. a transient 100) must not
      // convince the watchdog that soundness is fine.
      const score = Number(item?.score);
      if (!Number.isFinite(score) || score >= 100) continue;
      if (item?.name === "technical_quality") bestTech = Math.max(bestTech, score);
      if (item?.name === "reproducibility") bestRepro = Math.max(bestRepro, score);
    }
  }

  const aborts = abortsForCycle(root, cycleId);
  // Read here rather than in evaluate(), which has no cycle paths: the
  // snapshot is where cycle facts enter the watchdog.
  const documentStageAuthorization_ = documentStageAuthorization(root, cycleId);
  // What the document stage is doing. Read here rather than in evaluate(),
  // which has neither `root` nor `cycleId` -- the mistake that would have made
  // this throw on the first pass instead of reporting anything.
  const paperReview = (() => {
    try {
      const filePath = path.join(root, "state", `${cycleId}-paper-review.json`);
      if (!fs.existsSync(filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed?.review || parsed || null;
    } catch (error) {
      return null;
    }
  })();

  return {
    document_stage_authorization: documentStageAuthorization_,
    question_churn: questionChurnFromDirectorLanes(root, cycleId),
    ts: new Date().toISOString(),
    epoch_ms: Date.now(),
    lanes_total: lanesTotal,
    lanes_completed: lanesCompleted,
    abort_count: aborts.abort_count,
    latest_abort: aborts.latest_abort,
    gate_rounds: gateRounds,
    gate_passed: gatePassed,
    best_technical_quality: bestTech,
    best_reproducibility: bestRepro,
    best_by_rubric: Object.fromEntries([...bestByRubric.entries()].sort()),
    rounds_since_improvement: roundsSinceImprovement,
    rounds_without_new_input: roundsWithoutNewInput,
    distinct_leads: new Set(leadOrder).size,
    lead_changes: leadOrder.filter((id, i) => i > 0 && id !== leadOrder[i - 1]).length,
    rounds_per_lead:
      leadOrder.length > 0
        ? Number((leadOrder.length / new Set(leadOrder).size).toFixed(2))
        : null,
    role_counts: roleCounts,
    // What the document stage is doing, so a stagnation verdict under an
    // authorised document stage can ask whether the paper is moving.
    paper_score: paperReview ? Number(paperReview.paper_score || 0) : null,
    paper_blocker_count: paperReview && Array.isArray(paperReview.paper_blockers)
      ? paperReview.paper_blockers.length
      : null,
    // The review re-scores at gate-round cadence; the author rewrites far more
    // often. Reading only the review's numbers makes an actively rewritten
    // manuscript look frozen between rounds -- which is exactly how the 12:01
    // halt landed on cycle-g-v89 six minutes after the paper was rewritten.
    paper_artifact_mtime: manuscriptMtime(paperReview, fs),
  };
}

// When the manuscript itself was last written. Null when there is no paper yet,
// which is not evidence of a stalled document either way.
function manuscriptMtime(paperReview, fsImpl) {
  const paperPath = String(paperReview?.paper_path || "").trim();
  if (!paperPath) return null;
  try {
    return Math.round(fsImpl.statSync(paperPath).mtimeMs);
  } catch {
    return null;
  }
}

// Whether the authorised document stage is actually producing a document.
//
// Shared by every rule that would otherwise read an authorised write-up as a
// stalled cycle. The authorisation does not disarm a signature, it moves what
// the signature measures: gate rounds stop being the unit of progress and the
// manuscript becomes it. A paper whose score, blocker count and text are ALL
// unchanged across a full window is genuinely stuck, and still halts.
function documentStageIsMoving(documentAuthorization, history, snapshot) {
  if (!documentAuthorization) return false;
  const baseline = stagnationBaseline(history, snapshot);
  // No comparable row yet is not evidence of a stalled document.
  if (!baseline) return true;
  return (
    Number(baseline.paper_score || 0) !== Number(snapshot.paper_score || 0) ||
    Number(baseline.paper_blocker_count || 0) !== Number(snapshot.paper_blocker_count || 0) ||
    // The manuscript being rewritten IS the document moving, and it is the
    // signal that arrives first. cycle-g-v89 wrote three revisions inside the
    // window that halted it.
    Number(baseline.paper_artifact_mtime || 0) !== Number(snapshot.paper_artifact_mtime || 0)
  );
}

// The newest row that is already a full window old. Anchoring on AGE rather than
// on window membership is what made the flatline rule mean the same thing at any
// sampling cadence; the same anchor is used wherever a "has this moved" question
// is asked.
function stagnationBaseline(history, snapshot) {
  let baseline = null;
  for (const row of history) {
    if (snapshot.epoch_ms - row.epoch_ms >= FLATLINE_WINDOW_MINUTES * 60000) baseline = row;
    else break;
  }
  return baseline;
}

// --- signature evaluation ------------------------------------------------------
function evaluate({ snapshot, history }) {
  if (process.env.RESEARCHLAB_WATCHDOG_DEBUG) {
    console.error("[debug] rounds=" + snapshot.gate_rounds
      + " since_improvement=" + snapshot.rounds_since_improvement
      + " gate_passed=" + snapshot.gate_passed
      + " rounds_per_lead=" + snapshot.rounds_per_lead
      + " best_by_rubric=" + JSON.stringify(snapshot.best_by_rubric));
  }
  const findings = [];
  const roles = snapshot.role_counts || {};
  const director = roles["lab-director"] || 0;
  const scout = roles.scout || 0;
  const gatekeeper = roles.gatekeeper || 0;

  const oldest = history.length ? history[0] : null;
  const cycleAgeMin = oldest ? (snapshot.epoch_ms - oldest.epoch_ms) / 60000 : 0;
  const warmedUp = cycleAgeMin >= WARMUP_MINUTES;

  // R1 requery storm (v58): director lanes exploding past every other role.
  //
  // The director-to-scout ratio alone measures cycle AGE, not a storm. Scouts run
  // at the opening and then stop; directors are spent one per gate round for as
  // long as the cycle lives. So any cycle that runs long enough trips it, and
  // cycle-g-v89 did: 113 directors against 5 scouts and 123 gate rounds -- 0.92
  // directors per round, which is the cycle working, not looping. It halted on
  // resume, twice, with nothing wrong.
  //
  // What separates v58 is that its directors climbed while the gate never moved.
  // Dividing by gate rounds says that directly and needs no history, so a FRESH
  // cycle in a storm is still caught on the first pass rather than a window later.
  const gateRounds = snapshot.gate_rounds || 0;
  const directorsPerGateRound = director / Math.max(1, gateRounds);
  if (
    director >= REQUERY_STORM_MIN_DIRECTOR_LANES &&
    director > REQUERY_STORM_DIRECTOR_TO_SCOUT_RATIO * Math.max(1, scout) &&
    directorsPerGateRound > REQUERY_STORM_DIRECTORS_PER_GATE_ROUND
  ) {
    findings.push({
      signature: "requery_storm",
      severity: "halt",
      evidence: {
        lab_director_lanes: director,
        scout_lanes: scout,
        gate_rounds: gateRounds,
        directors_per_gate_round: Number(directorsPerGateRound.toFixed(2)),
        directors_per_gate_round_ceiling: REQUERY_STORM_DIRECTORS_PER_GATE_ROUND,
      },
      recommended_action:
        "The director is being re-dispatched in a loop instead of promoting/refining a lead (cycle-g-v58 genus). Inspect why no lead is bound (current_lead_hypothesis null? promotion refused?) BEFORE restarting; restarting without a fix reproduces the storm.",
    });
  }

  // R2 activity-without-gate-progress flatline: plenty of lanes completing, zero
  // gate rounds across the window.
  //
  // The baseline is the NEWEST row that is already a full window old. Taking the
  // oldest row INSIDE the window instead ties the baseline's age to the sampling
  // cadence: it was written for the 120s loop, where rows sit ~2min apart and the
  // oldest-in-window row is reliably 88-90min old. The 2026-08-20 split moved this
  // loop to 600s, rows landed 9.3min apart, the baseline aged 81-90min, and
  // `windowMin >= FLATLINE_WINDOW_MINUTES - 1` stopped holding. cycle-g-v82 then
  // spent 5.5 hours and 22.4MB of prompt at ZERO gate rounds while every pass
  // printed `ok` - baseline age 83.9min against a >=89 test, 88 new lanes, 0 new
  // rounds. Anchoring on age instead of window membership makes the rule mean the
  // same thing at any interval.
  const documentAuthorization = snapshot.document_stage_authorization || null;
  if (warmedUp) {
    let baseline = null;
    for (const row of history) {
      if (snapshot.epoch_ms - row.epoch_ms >= FLATLINE_WINDOW_MINUTES * 60000) baseline = row;
      else break;
    }
    if (baseline) {
      const newLanes = snapshot.lanes_completed - (baseline.lanes_completed || 0);
      const newRounds = snapshot.gate_rounds - (baseline.gate_rounds || 0);
      const windowMin = (snapshot.epoch_ms - baseline.epoch_ms) / 60000;
      // Zero gate rounds is the PREMISE under an owner document authorisation,
      // not the symptom: the cycle was told to write up a gate that would not
      // pass. cycle-g-v89 was halted here at 14:23 having written three paper
      // revisions and run its owner-adopted experiment inside the same window.
      // The rule keeps its teeth -- a document stage whose paper is frozen too
      // still halts, with the reason stated in document terms.
      const documentMoving = documentStageIsMoving(documentAuthorization, history, snapshot);
      if (newLanes >= FLATLINE_MIN_NEW_LANES && newRounds === 0 && !documentMoving) {
        findings.push({
          signature: "activity_without_gate_progress",
          severity: "halt",
          evidence: {
            window_minutes: Math.round(windowMin),
            lanes_completed_delta: newLanes,
            gate_rounds_delta: newRounds,
            gate_rounds_total: snapshot.gate_rounds,
            document_stage_authorized: Boolean(documentAuthorization),
            paper_score: snapshot.paper_score,
            paper_blocker_count: snapshot.paper_blocker_count,
          },
          recommended_action: documentAuthorization
            ? "The document stage is authorised, so gate rounds are not the unit of progress here -- but the paper is not moving either: its score, its blocker count and the manuscript text are all unchanged across the whole window. Find what is blocking the author (unanswerable review blockers? a figure or piece of evidence the write-up is waiting on?) before restarting."
            : "Lanes are completing but no gate round has been produced for the whole window: the pipeline is spinning without scoring (pre-gate deadlock or review starvation). Find which stage never fires (promotion? gatekeeper dispatch? aggregation) before restarting.",
        });
      }
    }
  }

  // R3 budget wall: the cycle is about to spend its follow-up budget without the
  // gate having passed. Halting EARLY preserves the remaining budget for a
  // post-diagnosis resume instead of grinding into the hard stop.
  {
    const spent = spentFollowups(roles, documentAuthorization);
    if (!snapshot.gate_passed && spent >= Math.floor(FOLLOWUP_BUDGET * BUDGET_WALL_FRACTION)) {
      findings.push({
        signature: "budget_wall_without_convergence",
        severity: "halt",
        evidence: {
          followup_lanes: spent,
          followup_budget: FOLLOWUP_BUDGET,
          role_counts: roles,
          document_stage_authorized: Boolean(documentAuthorization),
        },
        recommended_action: documentAuthorization
          ? `${spent} of ${FOLLOWUP_BUDGET} follow-ups are spent on research lanes under an owner document authorisation (the paper's own lanes are not counted). Research-lane spend at this level is churn beside the write-up rather than work toward it: find what is still dispatching it before raising anything.`
          : `${spent} of ${FOLLOWUP_BUDGET} follow-ups are spent without a gate pass. Every previous cycle that hit this wall died on it (v55/v56/v57/v59). Diagnose WHY review budget is being consumed without convergence (churn? unvalidatable leads?) and fix that before starting a fresh cycle.`,
      });
    }
  }

  // R4 budget burn without soundness (v59): heavy gatekeeper spend while the
  // best independently-reviewed soundness scores never left the floor.
  if (
    warmedUp &&
    gatekeeper >= SOUNDNESS_BURN_GATEKEEPER_MIN &&
    Math.max(snapshot.best_technical_quality, snapshot.best_reproducibility) < SOUNDNESS_BURN_MAX_BEST
  ) {
    findings.push({
      signature: "budget_burn_without_soundness",
      severity: "halt",
      evidence: {
        gatekeeper_lanes: gatekeeper,
        best_technical_quality: snapshot.best_technical_quality,
        best_reproducibility: snapshot.best_reproducibility,
      },
      recommended_action:
        "Most of the review budget is spent but no lead ever accumulated soundness evidence (cycle-g-v59 genus: leads abandoned before their validation lands, or validation never reaches the gate). Check lead churn tallies and runner->gate evidence flow before restarting.",
    });
  }

  // Owner rule 2026-08-20: stop paying for reviews that no longer move the gate.
  //
  // A round counts as progress when ANY rubric beats its own best so far. Five
  // consecutive rounds that improve none of them means more reviews are not the
  // answer - the lead, the experiment, or the claim has to change, and that is
  // the owner's call rather than something to burn budget discovering.
  //
  // Churn is reported alongside it, not halted on: a cycle that changes lead
  // every other round cannot accumulate improvement, so rounds_per_lead is
  // usually the explanation for the stagnation rather than a separate fault.
  //
  // KEEP THIS AT THE TOP LEVEL OF evaluate(). It was first inserted inside the
  // R4 budget-burn `if`, so it only ran when R4's conditions held - which they
  // never did on cycle-g-v81 (bestTech 68, bestRepro 78, far above the
  // soundness-floor threshold). The snapshot said since_improvement=9 for hours
  // and the watchdog kept printing `ok`.
  //
  // A round counts as progress when ANY rubric beats its own best so far. Five
  // consecutive rounds that improve none of them means more reviews are not the
  // answer - the lead, the
  // experiment, or the claim has to change, and that is the owner's call rather
  // than something to burn budget discovering.
  //
  // Churn is reported alongside it, not halted on: a cycle that changes lead
  // every other round cannot accumulate improvement, so rounds_per_lead is
  const STAGNATION_ROUNDS = Number(process.env.RESEARCHLAB_STAGNATION_ROUNDS || 5);
  // A plateau needs something to plateau FROM.
  //
  // MEASURED ON cycle-g-v88: halted at gate_rounds=5 with
  // rounds_since_improvement=5/5. Round 1 sets every rubric's bar, rounds 2-5 do
  // not beat it, and the counter hits the threshold on a cycle that has only
  // started. v88 had the cleanest execution layer this project has produced (8
  // runner results, 0 degraded, 0 seed deaths, 0 aborts) and had spent 3.7% of
  // its budget with ~103 rounds of headroom. v87, for scale, climbed novelty 42
  // at round 1 to 64 at round 21 -- a window unreachable from round 5.
  //
  // The two earlier corrections above (v81's 4 -> 35 jump, v84's halt right after
  // 20/18/5 -> 38/35/76) both made the RULE more permissive and neither noticed
  // that it also needs a floor on how young a cycle it may judge.
  //
  // Two windows, so a genuinely stuck cycle still dies cheaply: ten rounds is
  // about an hour and ~1MB at v88's measured 0.56MB per round.
  const STAGNATION_MIN_ROUNDS = 2 * STAGNATION_ROUNDS;
  // Under an authorised document stage, flat research rubrics are the PREMISE,
  // not the symptom. cycle-g-v89 was authorised precisely because its gate would
  // not pass and the science was worth writing up anyway; halting it for "no
  // rubric improved" then stops the cycle for the reason it was told to proceed
  // under, and it did -- twice, at rounds 128 and 133, while the manuscript was
  // being rewritten round after round.
  //
  // The authorisation does not disarm the signature, it moves what it measures.
  // The document has to be moving too: a cycle whose paper score and blocker
  // count are also frozen is stuck in the document stage and still dies here.
  const documentIsMoving = documentStageIsMoving(documentAuthorization, history, snapshot);
  if (
    !snapshot.gate_passed &&
    !documentIsMoving &&
    Number(snapshot.gate_rounds || 0) >= STAGNATION_MIN_ROUNDS &&
    Number(snapshot.rounds_since_improvement || 0) >= STAGNATION_ROUNDS
  ) {
    findings.push({
      signature: "score_stagnation_without_improvement",
      severity: "halt",
      evidence: {
        rounds_since_improvement: snapshot.rounds_since_improvement,
        stagnation_threshold: STAGNATION_ROUNDS,
        stagnation_min_rounds: STAGNATION_MIN_ROUNDS,
        best_by_rubric: snapshot.best_by_rubric,
        best_technical_quality: snapshot.best_technical_quality,
        best_reproducibility: snapshot.best_reproducibility,
        gate_rounds: snapshot.gate_rounds,
        distinct_leads: snapshot.distinct_leads,
        lead_changes: snapshot.lead_changes,
        rounds_per_lead: snapshot.rounds_per_lead,
        // Whether any of that churn could be judged at all. cycle-g-v89 changed
        // lead 33 times at 2.12 rounds per lead while 118 of 118 replacement
        // hypotheses named no question, so the three-method floor had nothing to
        // count and every pivot passed unexamined.
        question_churn: snapshot.question_churn || null,
      },
      recommended_action:
        "No rubric improved on its own best for " +
        snapshot.rounds_since_improvement +
        " consecutive gate rounds (bests: " +
        JSON.stringify(snapshot.best_by_rubric) +
        "). More gate reviews will not raise them. Check rounds_per_lead first: below ~3 the director is changing lead faster than any lead can accumulate evidence, and the fix is to hold one lead, not to review harder. Otherwise the blocked rubric needs a different experiment (reproducibility) or a different claim (novelty), which is an owner decision." +
        (snapshot.question_churn && snapshot.question_churn.accountable === false
          ? ` Question churn is UNJUDGEABLE here: ${snapshot.question_churn.replacements_stating_a_question} of ${snapshot.question_churn.replacements_proposed} replacement hypotheses named a research question, so the three-methods-per-question floor was never evaluated and the lead-level churn guard was the only thing looking. Fix that before reading rounds_per_lead as a director judgement.`
          : ""),
    });
  }

  // R5 supervisor crash-restart loop (v85): the run aborts, the wrapper restarts
  // it, it aborts again. Nothing completes, so none of R1-R4 fire -- v85 spent
  // 2h13m here with the watchdog reporting `ok`, because a cycle that cannot
  // START looks identical to a quiet one from the outside. The tell is aborts
  // climbing while completed lanes stand still.
  if (warmedUp && Number.isFinite(snapshot.abort_count)) {
    // Its own baseline: R2 declares one inside its block, and reaching for that
    // here would throw at runtime while still passing `node --check`.
    let crashBaseline = null;
    for (const row of history) {
      if (snapshot.epoch_ms - row.epoch_ms >= FLATLINE_WINDOW_MINUTES * 60000) crashBaseline = row;
      else break;
    }
    const newAborts = crashBaseline
      ? snapshot.abort_count - (crashBaseline.abort_count || 0)
      : 0;
    const newLanes = crashBaseline
      ? snapshot.lanes_completed - (crashBaseline.lanes_completed || 0)
      : -1;
    if (newAborts >= CRASH_LOOP_MIN_NEW_ABORTS && newLanes === 0) {
      findings.push({
        signature: "crash_restart_loop",
        severity: "halt",
        evidence: {
          new_aborts: newAborts,
          abort_count_total: snapshot.abort_count,
          lanes_completed: snapshot.lanes_completed,
          window_minutes: Number(((snapshot.epoch_ms - crashBaseline.epoch_ms) / 60000).toFixed(1)),
          latest_abort: snapshot.latest_abort,
        },
        recommended_action:
          "The supervisor is aborting on start and the wrapper keeps relaunching it, so no work can happen. Read `latest_abort` -- it names the file and source line. On cycle-g-v85 this was ONE torn-write lane result.json (64 bad bytes in 2.1MB) that strict-UTF-8 read_json turned into a cycle-wide abort. Repair or quarantine the named file BEFORE clearing the halt; restarting without that reproduces the loop immediately.",
      });
    }
  }

  return findings;
}

// --- Level-2/3 policy computation ----------------------------------------------
const EXPLOIT_BUDGET_FRACTION = 0.7; // switch to exploit before the 0.9 halt wall
const STALL_ROUNDS_MIN = 4;
const STALL_ROUNDS_MAX = 10;

// Level 3: derive the stall window from this cycle's MEASURED evidence latency —
// per hypothesis, how many ledger rounds passed before its soundness
// (technical_quality / reproducibility) first improved over its own entry value.
// p75 + 1 buffer, clamped [4..10]. Fewer than 2 measured latencies => null (the
// consumer keeps its default); this only ever REPLACES the hand-tuned constant
// with the same quantity it was approximating.
function computeAdaptiveStallRounds(progressRows) {
  const byHyp = new Map();
  for (const row of progressRows) {
    if (row?.memory_type !== "decision" || !row?.content?.rubric) continue;
    const key = String(row.memory_id || "");
    if (!key) continue;
    if (!byHyp.has(key)) byHyp.set(key, []);
    const scores = {};
    for (const item of row.content.rubric) {
      const score = Number(item?.score);
      if (!Number.isFinite(score) || score >= 100) continue; // placeholder guard
      if (item?.name === "technical_quality" || item?.name === "reproducibility") {
        scores[item.name] = score;
      }
    }
    byHyp.get(key).push(scores);
  }
  const latencies = [];
  for (const rounds of byHyp.values()) {
    if (rounds.length < 2) continue;
    const first = rounds[0];
    for (let i = 1; i < rounds.length; i += 1) {
      const improved = ["technical_quality", "reproducibility"].some(
        (name) => rounds[i][name] != null && first[name] != null && rounds[i][name] > first[name],
      );
      if (improved) {
        latencies.push(i + 1); // rounds taken until evidence first moved
        break;
      }
    }
  }
  if (latencies.length < 2) return null;
  latencies.sort((a, b) => a - b);
  const p75 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.75))];
  return Math.max(STALL_ROUNDS_MIN, Math.min(STALL_ROUNDS_MAX, p75 + 1));
}

// Level 2: pick the strategy mode. "exploit" = review budget is running out
// without a gate pass — stop exploring, consolidate the best lead (enforced by
// evaluateLeadSupersession reading this policy; its denies propagate through the
// supersession ledger to the Rust dispatchers too).
function computePolicy({ snapshot, progressRows }) {
  const roles = snapshot.role_counts || {};
  let exploitReason = null;
  if (!snapshot.gate_passed) {
    const spent = spentFollowups(roles, false);
    if (spent >= Math.floor(FOLLOWUP_BUDGET * EXPLOIT_BUDGET_FRACTION)) {
      exploitReason = `followups_${spent}_of_${FOLLOWUP_BUDGET}`;
    }
  }
  const stallRounds = computeAdaptiveStallRounds(progressRows);
  return {
    updated_at: new Date().toISOString(),
    mode: exploitReason ? "exploit" : "explore",
    exploit_reason: exploitReason,
    stall_rounds: stallRounds, // null => consumer default
    evidence: {
      gate_rounds: snapshot.gate_rounds,
      gate_passed: snapshot.gate_passed,
      role_counts: roles,
    },
  };
}

// History from before a halt was cleared describes a system that no longer exists.
//
// A halt is terminal until someone removes the file deliberately, and the rule in
// this repo is that it may only be removed TOGETHER WITH A REAL FIX. But the
// history that triggered it survives the clear, so on the next pass the same
// window is still there and the same signature fires again, immediately. The halt
// then cannot be cleared by fixing its cause -- only by deleting evidence, which
// is exactly what nobody should ever do to make a watchdog quiet.
//
// MEASURED on cycle-g-v84: halted at 99 minutes / 20 lanes / 0 gate rounds, the
// cause was found and fixed, the halt was archived, and the relaunch re-halted
// before dispatching anything, because the flat 99-minute stretch was still the
// newest thing in the file.
//
// Clearing a halt is a deliberate act with a timestamp: the archived file. Rows
// older than the newest archive are pre-fix, so the window starts from the clear.
// Nothing is deleted -- the file keeps every row; this only bounds what the
// signatures reason over.
function lastHaltClearedAt(root, cycleId) {
  let clearedAt = 0;
  try {
    const stateDir = path.join(root, "state");
    const prefix = `${cycleId}-watchdog-halt.json.`;
    for (const name of fs.readdirSync(stateDir)) {
      if (!name.startsWith(prefix)) continue;
      const mtime = fs.statSync(path.join(stateDir, name)).mtimeMs;
      if (mtime > clearedAt) clearedAt = mtime;
    }
  } catch {
    return 0;
  }
  return clearedAt;
}

function historySinceHaltCleared(rows, root, cycleId) {
  const clearedAt = lastHaltClearedAt(root, cycleId);
  if (!clearedAt) return rows;
  const kept = rows.filter((row) => Number(row?.epoch_ms || 0) >= clearedAt);
  if (kept.length !== rows.length) {
    console.error(
      `[watchdog] ${rows.length - kept.length} history rows predate the last halt clear; judging from the clear onward`,
    );
  }
  return kept;
}

// Which lanes were in flight when something vanished. Not proof of who removed
// it -- an agent's apply_patch delete leaves no name in the state tree -- but
// the set it must have come from, which is better than "unknown" and is what
// made followup-lab-director-44 findable at all.
function runningLaneIds(root, cycleId) {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(root, "state", ), "utf8"),
    );
    return (state.lane_statuses || [])
      .filter((lane) => String(lane && lane.status) === "running")
      .map((lane) => String(lane.lane_id))
      .sort();
  } catch {
    return [];
  }
}

function main() {
  const args = parseArgs(process.argv);
  const root = args.root;
  const cycleId = args.cycle_id;
  if (!root || !cycleId) {
    console.error("usage: progress_watchdog --cycle-id <id> --root <dir> --kill-script <path> [--dry-run]");
    process.exit(2);
  }

  const historyPath = path.join(root, "state", `${cycleId}-watchdog-history.jsonl`);
  const haltPath = path.join(root, "state", `${cycleId}-watchdog-halt.json`);

  // Keep a copy of every authoritative artifact, and put back any that has
  // copies and no live file. Deliberately BEFORE the halt early-return: a
  // halted cycle is exactly where a vanished record sits longest, and
  // cycle-g-v91 spent two hours halted with its lead gone.
  //
  // The watchdog is the right place because it is the only thing that runs on
  // a cadence and is not the agent doing the writing. It cannot prevent an
  // agent's apply_patch delete -- nothing can, the lane runs unsandboxed and
  // `allowed_outputs` has no reader -- but a delete it cannot prevent is now a
  // delete it can survive and name.
  const archiveRoot = path.dirname(root);
  try {
    const kept = archiveAuthoritativeState({ root: archiveRoot, cycleId });
    if (kept.archived.length) {
      console.log(`[watchdog] archived ${kept.archived.length} authoritative artifact(s)`);
    }
    const back = restoreMissingAuthoritativeState({
      root: archiveRoot,
      cycleId,
      actor: runningLaneIds(root, cycleId).join(",") || "unknown",
      reason: "an authoritative artifact had archived copies and no live file",
    });
    for (const item of back.restored) {
      console.error(`[watchdog] RESTORED ${item.kind} from ${item.from}`);
    }
  } catch (error) {
    // Observing must never become the outage.
    console.error(`[watchdog] state archive pass failed: ${error && error.message}`);
  }

  // A halt is terminal until a human/agent removes the halt file deliberately.
  if (fs.existsSync(haltPath)) {
    console.log(`[watchdog] halt already recorded at ${haltPath}; nothing to do`);
    return;
  }

  const haltClearedAt = lastHaltClearedAt(root, cycleId);
  const snapshot = takeSnapshot({ root, cycleId, haltClearedAt });
  const history = historySinceHaltCleared(readJsonl(historyPath), root, cycleId);
  fs.appendFileSync(historyPath, `${JSON.stringify(snapshot)}\n`, "utf8");

  // Level-2/3: publish the strategy policy every sample (atomic rename so the
  // supersession evaluator never reads a torn file).
  const progressRows = readJsonl(path.join(root, "state", `${cycleId}-hypothesis-progress.jsonl`));
  const policy = computePolicy({ snapshot, progressRows });
  const policyPath = path.join(root, "state", `${cycleId}-watchdog-policy.json`);
  writeFileAtomic(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

  const findings = evaluate({ snapshot, history });
  const halts = findings.filter((f) => f.severity === "halt");
  if (halts.length === 0) {
    console.log(
      `[watchdog] ok cycle=${cycleId} rounds=${snapshot.gate_rounds} lanes=${snapshot.lanes_completed}/${snapshot.lanes_total} bestTech=${snapshot.best_technical_quality} bestRepro=${snapshot.best_reproducibility} mode=${policy.mode} stallRounds=${policy.stall_rounds ?? "default"}`,
    );
    return;
  }

  const diagnosis = {
    cycle_id: cycleId,
    halted_at: snapshot.ts,
    signatures: halts,
    snapshot,
    history_tail: history.slice(-5),
    note:
      "Fail-safe halt by progress_watchdog. Do NOT blindly restart: the recommended_action of each signature explains what to diagnose first. Delete this file only together with an actual fix.",
  };
  const haltExisted = fs.existsSync(haltPath);
  let replacedCopy = null;
  if (haltExisted) {
    // A halt that overwrites a halt destroys the earlier verdict, and the
    // earlier verdict is why the cycle was stopped the first time. Keep it.
    replacedCopy = `${haltPath}.superseded-${snapshot.ts.replace(/[:.]/g, "-")}`;
    try {
      fs.copyFileSync(haltPath, replacedCopy);
    } catch {
      replacedCopy = null;
    }
  }
  fs.writeFileSync(haltPath, `${JSON.stringify(diagnosis, null, 2)}\n`, "utf8");
  // An authoritative write: nothing re-derives a verdict that stops the cycle,
  // so the only trace of who stopped it and why is the one made here. See
  // src/provenance/state_provenance.js for why this artifact is in scope and
  // most are not.
  recordStateWrite({
    root: path.dirname(root),
    cycleId,
    kind: "watchdog-halt",
    operation: haltExisted ? "replace" : "create",
    actor: "progress_watchdog",
    reason: halts.map((h) => h.signature).join(","),
    previous: replacedCopy,
  });
  console.error(`[watchdog] HALT ${halts.map((h) => h.signature).join(",")} -> ${haltPath}`);

  if (args.dry_run || args.dryRun) {
    console.error("[watchdog] dry-run: kill script NOT invoked");
    return;
  }
  if (args.kill_script && fs.existsSync(args.kill_script)) {
    try {
      // File-based kill script in its own process: immune to the pkill
      // self-match trap (this node cmdline matches none of its patterns).
      execFileSync("bash", [args.kill_script], { stdio: "inherit", timeout: 60000 });
    } catch (error) {
      console.error(`[watchdog] kill script failed: ${error.message}`);
    }
  }

  // Tier-2: hand the diagnosis to the on-halt reasoning responder (detached —
  // this watchdog's parent subshell dies with the cycle it just killed). The
  // responder makes ONE bounded fix attempt and either resumes the cycle behind
  // an independent test gate or leaves a structured escalation.
  if (args.responder && args.launch_script && fs.existsSync(args.responder)) {
    try {
      const { spawn } = require("child_process");
      const child = spawn(
        "bash",
        [args.responder, cycleId, root, haltPath, args.launch_script],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      console.error(`[watchdog] responder spawned (pid ${child.pid})`);
    } catch (error) {
      console.error(`[watchdog] responder spawn failed: ${error.message}`);
    }
  }
}

// Run as a script; importable so the signature rules can be regression-tested
// against real recorded history without launching a cycle.
if (require.main === module) main();

module.exports = { abortsForCycle, evaluate, documentStageIsMoving, computePolicy, computeAdaptiveStallRounds, takeSnapshot, lastHaltClearedAt, documentStageAuthorization, DOCUMENT_STAGE_ROLES, FLATLINE_WINDOW_MINUTES, FLATLINE_MIN_NEW_LANES, WARMUP_MINUTES };
