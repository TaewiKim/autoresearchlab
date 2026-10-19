"use strict";

// The author asked for two experiments and nobody was listening.
//
// Clause 1e gives the author a third option between overclaiming and hedging:
// name the run that would license the sentence it cannot yet write. On the first
// draft to read it, the author used the option well -- it asked for a paired
// preregistered packet with and without the sham arm, and for external
// validation on new scene families, each with the result that would license the
// claim and the result that would refute it.
//
// Those requests then sat in the lane's result.json, because I added the field
// to the contract and wired no consumer. Sixth time in this cycle that a value
// was produced and nothing read it.
//
// Owner decision on routing: the DIRECTOR adopts, the ANALYST designs. Both
// halves matter. Letting the analyst pick requests up directly would let the
// manuscript set the research agenda, and this project's recorded governance is
// that the director owns pivot and continue while the harness supplies
// constraints and information. Leaving it to the director alone with no record
// would lose the requests whenever the director is busy or halted, which is
// exactly the state cycle-g-v89 is in.
//
// So the requests become a durable, append-only ledger with an adoption status.
// The director sees every pending one and records adopt or decline WITH A
// REASON, the same shape as the other owner-facing decisions here; an adopted
// request becomes an analyst follow-up; a declined one stays in the file with
// why, so the next cycle can see that the question was asked and answered rather
// than never raised.

const fs = require("fs");
const path = require("path");
const { ensureDir, writeJson } = require("../shared/json");

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value) {
  return String(value == null ? "" : value).trim();
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function requestsPath(root, cycleId) {
  return path.join(root, "state", `${cycleId}-experiment-requests.json`);
}

// A request is identified by the claim it would support: the author may reword
// its experiment between rounds, but if it is still trying to license the same
// sentence it is the same request, and a decision already recorded against it
// must not be silently reopened.
function requestKey(request) {
  return text(request?.claim_it_would_support).slice(0, 200).toLowerCase();
}

// Both halves required, as everywhere else in this runtime: a request with no
// claim directs nothing, and one with no experiment cannot be designed.
function usableRequest(request) {
  return Boolean(text(request?.claim_it_would_support) && text(request?.experiment));
}

/**
 * Merge the author's current requests into the cycle ledger without disturbing
 * decisions already recorded against them.
 */
function recordExperimentRequests({ root, cycleId, requests, source = null }) {
  const filePath = requestsPath(root, cycleId);
  const existing = readJsonIfExists(filePath) || { cycle_id: cycleId, requests: [] };
  const byKey = new Map(asArray(existing.requests).map((item) => [requestKey(item), item]));

  for (const request of asArray(requests).filter(usableRequest)) {
    const key = requestKey(request);
    const prior = byKey.get(key);
    if (prior) {
      // Keep the decision and its reason; refresh what the author now says.
      byKey.set(key, {
        ...prior,
        ...request,
        status: prior.status || "pending",
        decision: prior.decision || null,
        raised_by: prior.raised_by || source,
      });
      continue;
    }
    byKey.set(key, {
      ...request,
      status: "pending",
      decision: null,
      raised_by: source,
    });
  }

  const merged = { cycle_id: cycleId, requests: [...byKey.values()] };
  ensureDir(path.dirname(filePath));
  writeJson(filePath, merged);
  return merged;
}

function readExperimentRequests({ root, cycleId }) {
  return readJsonIfExists(requestsPath(root, cycleId)) || { cycle_id: cycleId, requests: [] };
}

function pendingExperimentRequests({ root, cycleId }) {
  return asArray(readExperimentRequests({ root, cycleId }).requests).filter(
    (item) => (item.status || "pending") === "pending",
  );
}

/**
 * The director's decision. A reason is required in both directions: an adoption
 * nobody can account for later is a silently expanded scope, and a decline
 * nobody can account for is the question quietly disappearing.
 */
function decideExperimentRequest({ root, cycleId, claim, adopt, reason, decided_by = "lab-director" }) {
  if (!text(reason)) {
    return { ok: false, error: "a decision on an experiment request requires a reason" };
  }
  const ledger = readExperimentRequests({ root, cycleId });
  const key = text(claim).slice(0, 200).toLowerCase();
  const target = asArray(ledger.requests).find((item) => requestKey(item) === key);
  if (!target) return { ok: false, error: "no request matches that claim" };
  target.status = adopt ? "adopted" : "declined";
  target.decision = { adopt: Boolean(adopt), reason: text(reason), decided_by };
  ensureDir(path.dirname(requestsPath(root, cycleId)));
  writeJson(requestsPath(root, cycleId), ledger);
  return { ok: true, request: target };
}

/**
 * Apply the director's decisions from its own lane results.
 *
 * The requests reached the director's role plan and its prompt, the lane
 * completed, and every request stayed pending -- because nothing read the
 * decision back. `decideExperimentRequest` had no caller anywhere in the
 * runtime, so the ledger had no way out of `pending` however the director
 * answered.
 *
 * Lanes are scanned oldest-first so a later reversal wins, and a request that
 * already carries a decision is left alone: the ledger is the record of what was
 * decided, not a cache of the newest lane's opinion.
 */
function applyDirectorExperimentDecisions({ root, cycleId }) {
  const lanesDir = path.join(root, "lanes", cycleId);
  let entries = [];
  try {
    entries = fs.readdirSync(lanesDir);
  } catch (error) {
    return { applied: [], skipped: [] };
  }
  const results = entries
    .filter((name) => name.includes("lab-director"))
    .map((name) => path.join(lanesDir, name, "result.json"))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => ({ filePath, mtime: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ filePath }) => ({
      laneId: path.basename(path.dirname(filePath)),
      extracted: readJsonIfExists(filePath)?.extracted_json,
      // What this lane was shown, so silence can be told apart from never having
      // been asked.
      pendingKeys: asArray(
        readJsonIfExists(path.join(path.dirname(filePath), "role-plan.json"))?.pending_experiment_requests,
      ).map(requestKey),
    }))
    .filter((item) => item.extracted);

  const laneRecords = [];
  const applied = [];
  const skipped = [];
  for (const lane of results) {
    const result = lane.extracted;
    const answeredKeys = asArray(result.experiment_request_decisions)
      .map((item) => requestKey({ claim_it_would_support: item?.claim_it_would_support || item?.claim }))
      .filter(Boolean);
    // A lane that discussed the requests in prose ANSWERED, in the wrong shape.
    // followup-lab-director-152 wrote "All three experiment requests are
    // declined" into `summary` and left the structured field empty, and the
    // ledger counted that as silence -- then the pivot guard denied its
    // supersession for not answering. Punishing a role for the shape of an
    // answer it gave is not what the guard is for.
    const prose = ["summary", "rationale", "decision_status"]
      .map((key) => String(result?.[key] || ""))
      .join(" ");
    const mentionedRequests = /experiment request/i.test(prose);
    laneRecords.push({
      laneId: lane.laneId,
      pendingKeys: lane.pendingKeys,
      answeredKeys,
      mentionedRequests,
    });
    for (const decision of asArray(result.experiment_request_decisions)) {
      const claim = text(decision?.claim_it_would_support || decision?.claim);
      const reason = text(decision?.reason);
      const verdict = text(decision?.decision).toLowerCase();
      const adopt = decision?.adopt === true || verdict === "adopt" || verdict === "adopted";
      const declined = decision?.adopt === false || verdict === "decline" || verdict === "declined";
      if (!claim || (!adopt && !declined)) {
        skipped.push({ claim: claim || null, why: "no claim, or no adopt/decline verdict" });
        continue;
      }
      const outcome = decideExperimentRequest({ root, cycleId, claim, adopt, reason });
      if (outcome.ok) applied.push({ claim, adopt, reason });
      else skipped.push({ claim, why: outcome.error });
    }
  }
  recordUnansweredRequests({ root, cycleId, lanes: laneRecords });
  return { applied, skipped };
}

/**
 * Count the times a director saw a request and said nothing about it.
 *
 * Delivery was proven at every layer -- ledger, role plan, prompt, contract field
 * and rule -- and three lanes in a row still returned no decision, because
 * omitting one cost nothing. The count is what a guard can act on: silence once
 * is a lane being busy, silence repeatedly is a refusal to answer.
 */
function recordUnansweredRequests({ root, cycleId, lanes }) {
  const ledger = readExperimentRequests({ root, cycleId });
  const open = asArray(ledger.requests).filter((item) => !item.decision);
  if (!open.length || !asArray(lanes).length) return;
  let changed = false;
  for (const request of open) {
    const key = requestKey(request);
    const seen = new Set(asArray(request.unanswered_by));
    const prose = new Set(asArray(request.answered_in_prose_by));
    for (const lane of lanes) {
      // Only a lane that was actually shown this request can be said to have
      // ignored it.
      if (!lane.pendingKeys.includes(key)) continue;
      if (lane.answeredKeys.includes(key)) continue;
      if (lane.mentionedRequests) {
        // Recorded so the next role plan can tell the director WHERE the answer
        // has to go, which is the half that was missing.
        if (!prose.has(lane.laneId)) {
          prose.add(lane.laneId);
          changed = true;
        }
        continue;
      }
      if (seen.has(lane.laneId)) continue;
      seen.add(lane.laneId);
      changed = true;
    }
    request.unanswered_by = [...seen];
    request.answered_in_prose_by = [...prose];
  }
  if (changed) {
    ensureDir(path.dirname(requestsPath(root, cycleId)));
    writeJson(requestsPath(root, cycleId), ledger);
  }
}

/**
 * Requests a director has been shown at least `minIgnored` times and never
 * answered. Fail-open by construction: an empty list denies nothing.
 */
function unansweredExperimentRequests({ root, cycleId, minIgnored = 3 }) {
  return asArray(readExperimentRequests({ root, cycleId }).requests).filter(
    (item) => !item.decision && asArray(item.unanswered_by).length >= minIgnored,
  );
}

/**
 * The paper cannot pass while a run it depends on is still undecided.
 *
 * This is pressure without deadlock: it blocks the DOCUMENT, never the research
 * loop, and the action it carries is aimed at the director, because the author
 * has already done its part by asking.
 */
// How many refusals in a row make the answer a policy rather than a pending
// question. cycle-g-v89 reached sixteen, every one of them for three experiments
// asked over and over in new words.
const EXPERIMENT_CHANNEL_EXHAUSTED_DECLINES = 5;

// Has the programme effectively closed this channel? Declines with no adoption
// are an answer the author can act on; a mix means requests are still being
// weighed one at a time and a pending one genuinely awaits a decision.
function experimentChannelExhausted(requests) {
  const decided = asArray(requests).filter((item) => item.decision);
  const declined = decided.filter((item) => item.decision?.adopt !== true);
  const adopted = decided.length - declined.length;
  return adopted === 0 && declined.length >= EXPERIMENT_CHANNEL_EXHAUSTED_DECLINES
    ? { declined: declined.length }
    : null;
}

function undecidedExperimentFindings({ root, cycleId }) {
  const requests = asArray(readExperimentRequests({ root, cycleId }).requests);
  const open = requests.filter((item) => !item.decision);
  if (!open.length) return { blockers: [], actions: [] };

  // The programme has answered, repeatedly, and the answer is no. Holding the
  // manuscript for one more instance of that answer is what pinned cycle-g-v89's
  // paper at 65 against a raw score of 100.
  const exhausted = experimentChannelExhausted(requests);
  if (exhausted) {
    return {
      blockers: [],
      actions: [
        {
          type: "manuscript_standard_followup",
          priority: "critical",
          preferred_role: "author",
          target_rubric: "claim_strength",
          required_for_gate: true,
          description:
            `the programme has declined ${exhausted.declined} experiment request(s) and adopted none, so the`
            + " runs you are asking for are not coming. That is an answer, not a delay: state the claim your"
            + " CURRENT evidence defends, name in the limitations exactly what the refused experiment would"
            + " have settled and which way it could still go, and stop conditioning the manuscript on a run"
            + " the programme has refused. Do not withdraw the finding -- bound it.",
          blocker_reasons: open.map((item) => text(item.claim_it_would_support)),
        },
        // The director still owes an answer on the open request; it just no
        // longer holds the paper.
        ...open.map((item) => ({
          type: "experiment_request_decision_followup",
          priority: "medium",
          preferred_role: "lab-director",
          target_rubric: "experiment_request_decision",
          required_for_gate: false,
          description:
            `decide the experiment the author requested: ${text(item.experiment).slice(0, 200)}`
            + " -- adopt or decline, with a reason either way",
          blocker_reasons: [text(item.claim_it_would_support)],
          experiment_request: item,
        })),
      ],
    };
  }

  const blockers = open.map(
    (item) =>
      `an experiment this manuscript depends on has not been decided: "${text(item.experiment).slice(0, 160)}"`
      + ` (it would settle: ${text(item.claim_it_would_support).slice(0, 120)}).`
      + " The author asked; the director owns the decision and has not made it",
  );
  const actions = open.map((item) => ({
    type: "experiment_request_decision_followup",
    priority: "critical",
    preferred_role: "lab-director",
    target_rubric: "experiment_request_decision",
    required_for_gate: true,
    description:
      `decide the experiment the author requested: ${text(item.experiment).slice(0, 200)}`
      + " -- adopt or decline, with a reason either way",
    blocker_reasons: [text(item.claim_it_would_support)],
    experiment_request: item,
  }));
  return { blockers, actions };
}

/**
 * Adopted requests become analyst work. The follow-up carries the licensing and
 * refuting results, because an experiment whose interpretation is decided
 * afterwards is the thing the preregistration discipline here exists to prevent.
 */
// Where a runner records the analyst handoff it executed. Both keys appear in a
// runner role plan; either one names the lane whose design was run.
const HANDOFF_PATH_IN_ROLE_PLAN = /"(?:analyst_handoff_path|handoff_path)"\s*:\s*"([^"]+)"/g;
const LANE_IN_PATH = /\/lanes\/[^/]+\/([^/]+)\//;

// The stored path is whatever separator wrote it, and JSON doubles a backslash.
// Reading it must not depend on which platform produced the lane.
function laneFromHandoffPath(stored) {
  const found = LANE_IN_PATH.exec(String(stored || "").replace(/\\+/g, "/"));
  return found ? found[1] : null;
}

function laneDir(root, cycleId, laneId) {
  return path.join(root, "lanes", cycleId, laneId);
}

function laneIds(root, cycleId) {
  try {
    return fs.readdirSync(path.join(root, "lanes", cycleId));
  } catch {
    return [];
  }
}

// Read a lane file as text. These are hundreds of kilobytes and all that is
// ever asked of them here is whether a sentence appears, so they are never
// parsed.
function laneText(root, cycleId, laneId, fileName) {
  try {
    return fs.readFileSync(path.join(laneDir(root, cycleId, laneId), fileName), "utf8");
  } catch {
    return "";
  }
}

// An execution answers a request only when it reached a VERDICT. On cycle-g-v89
// two runners both reported completed with degraded false: one ran a one-second
// schema stub and emitted an empty metrics object, the other ran the real
// blueprint for 21 minutes and emitted pass_fail. Completion is not evidence,
// and duration is not the test -- the verdict is.
function executionVerdicts(result) {
  return asArray(result?.blueprint_executions)
    .map((execution) => {
      const metrics = execution?.metrics || {};
      const verdict = text(metrics.pass_fail);
      if (!verdict) return null;
      return {
        check_id: text(execution.check_id) || null,
        blueprint_id: text(execution.blueprint_id) || null,
        pass_fail: verdict,
        resolution_status: text(metrics.resolution_status) || null,
      };
    })
    .filter(Boolean);
}

/**
 * Which lab-runner lanes executed the experiment an adopted request asked for.
 *
 * The link is not stored anywhere as an id, but it is fully recorded: the
 * analyst lane holds the claim the request is keyed by, and the runner names
 * the analyst handoff it ran.
 */
function executionsForRequest({ root, cycleId, request, alreadyExamined }) {
  const key = requestKey(request);
  if (!key) return { executions: [], examined: [] };

  // Which analyst lane did each runner execute? One pass over the runner role
  // plans, by text, so a 15MB corpus costs a third of a second.
  const examined = [];
  const runnersByAnalyst = new Map();
  for (const laneId of laneIds(root, cycleId)) {
    if (alreadyExamined.has(laneId)) continue;
    // Only an execution lane can have executed anything, and its role plan is
    // a fifth of a megabyte. Deciding that from the small run-state file keeps
    // this off the 1,200-lane corpus: reading every role plan is how a refresh
    // in this runtime once spent 125 seconds and livelocked the dispatcher.
    const runState = readJsonIfExists(
      path.join(laneDir(root, cycleId, laneId), "run-state.json"),
    );
    if (text(runState?.role) !== "lab-runner") continue;
    const plan = laneText(root, cycleId, laneId, "role-plan.json");
    if (!plan) continue;
    let matched = false;
    HANDOFF_PATH_IN_ROLE_PLAN.lastIndex = 0;
    let hit = HANDOFF_PATH_IN_ROLE_PLAN.exec(plan);
    while (hit) {
      const owner = laneFromHandoffPath(hit[1]);
      if (owner) {
        matched = true;
        const list = runnersByAnalyst.get(owner) || [];
        if (!list.includes(laneId)) list.push(laneId);
        runnersByAnalyst.set(owner, list);
      }
      hit = HANDOFF_PATH_IN_ROLE_PLAN.exec(plan);
    }
    // A lane that names no handoff can never answer a request; never look at
    // it again.
    if (!matched) examined.push(laneId);
  }

  const executions = [];
  for (const [analystLane, runnerLanes] of runnersByAnalyst) {
    const designed =
      laneText(root, cycleId, analystLane, "result.json").toLowerCase().includes(key) ||
      laneText(root, cycleId, analystLane, "role-plan.json").toLowerCase().includes(key);
    if (!designed) {
      // This design was for some other request; the runners that ran it are
      // settled for this one.
      for (const laneId of runnerLanes) examined.push(laneId);
      continue;
    }
    for (const laneId of runnerLanes) {
      // A lane writes its result when it finishes, so a lane with no result is
      // still in flight and may yet answer this; one with a result will not
      // change its mind, whether or not it reached a verdict.
      const result = readJsonIfExists(path.join(laneDir(root, cycleId, laneId), "result.json"));
      if (!result) continue;
      examined.push(laneId);
      const verdicts = executionVerdicts(result);
      if (!verdicts.length) continue;
      for (const verdict of verdicts) {
        executions.push({ ...verdict, lane_id: laneId, designed_by: analystLane });
      }
    }
  }
  return { executions, examined };
}

/**
 * Record, against each adopted request, the runs that answered it.
 *
 * Cheap by construction: it does nothing at all unless a request has been
 * adopted and has no execution recorded yet, and every lane it rules out is
 * remembered so the next pass skips it.
 */
function recordExecutedExperiments({ root, cycleId }) {
  const ledger = readExperimentRequests({ root, cycleId });
  const open = asArray(ledger.requests).filter(
    (item) => item.status === "adopted" && !asArray(item.executed_by).length,
  );
  if (!open.length) return ledger;

  let changed = false;
  for (const request of open) {
    const alreadyExamined = new Set(asArray(request.execution_lanes_examined));
    const { executions, examined } = executionsForRequest({
      root,
      cycleId,
      request,
      alreadyExamined,
    });
    for (const laneId of examined) alreadyExamined.add(laneId);
    if (executions.length) {
      request.executed_by = executions;
      changed = true;
    }
    if (alreadyExamined.size !== asArray(request.execution_lanes_examined).length) {
      request.execution_lanes_examined = [...alreadyExamined];
      changed = true;
    }
  }
  if (changed) {
    ensureDir(path.dirname(requestsPath(root, cycleId)));
    writeJson(requestsPath(root, cycleId), ledger);
  }
  return ledger;
}

function adoptedExperimentFollowupActions({ root, cycleId }) {
  const requests = asArray(recordExecutedExperiments({ root, cycleId }).requests).filter(
    (item) => item.status === "adopted",
  );
  // The run has happened. Asking for its design again is what put five analyst
  // lanes on one experiment; what the manuscript needs now is the answer
  // applied, and only the author can decide which of its own two preregistered
  // outcomes it just saw.
  const answered = requests
    .filter((item) => asArray(item.executed_by).length)
    .map((item) => {
      const runs = asArray(item.executed_by);
      const verdicts = runs
        .map((run) => `${run.check_id || run.lane_id}: ${run.pass_fail}${run.resolution_status ? ` (${run.resolution_status})` : ""}`)
        .join("; ");
      return {
        type: "author_requested_experiment_answered",
        priority: "critical",
        preferred_role: "author",
        target_rubric: "claim_strength",
        required_for_gate: true,
        description: `the experiment you requested has run -- apply its answer to the manuscript: ${verdicts}`,
        blocker_reasons: [
          `The run you asked for is finished (${runs.map((run) => run.lane_id).join(", ")}) and measured ${verdicts}. Decide against the two outcomes you preregistered: license the claim "${text(item.claim_it_would_support)}" and say so on this evidence, or withdraw it and record it in withdrawn_claims. Asking for the experiment again is not a resolution.`,
        ].filter(Boolean),
        experiment_request: {
          claim_it_would_support: item.claim_it_would_support,
          experiment: item.experiment,
          result_that_licenses_the_claim: item.result_that_licenses_the_claim,
          result_that_refutes_it: item.result_that_refutes_it,
          executed_by: runs,
        },
      };
    });

  return requests
    .filter((item) => !asArray(item.executed_by).length)
    .map((item) => ({
      type: "author_requested_experiment",
      priority: "critical",
      preferred_role: "analyst",
      target_rubric: "experiment_design",
      // An adopted request is a run the programme has COMMITTED to, and the
      // manuscript is waiting on its number. Without the flag it competed at
      // ordinary priority against two hundred analyst lanes; gate-required
      // document work scores 9,900 in the task graph and everything else in the
      // low hundreds.
      required_for_gate: true,
      description: `design the experiment the author requested: ${text(item.experiment).slice(0, 200)}`,
      // What the manuscript cannot say until this runs, so the lane can see why
      // it is urgent rather than inferring it from a priority label.
      blocker_reasons: [text(item.claim_it_would_support)].filter(Boolean),
      experiment_request: {
        claim_it_would_support: item.claim_it_would_support,
        why_current_evidence_is_short: item.why_current_evidence_is_short,
        experiment: item.experiment,
        what_it_would_measure: item.what_it_would_measure,
        result_that_licenses_the_claim: item.result_that_licenses_the_claim,
        result_that_refutes_it: item.result_that_refutes_it,
        adopted_because: item.decision?.reason || null,
      },
    }))
    .concat(answered);
}

module.exports = {
  experimentChannelExhausted,
  recordExecutedExperiments,
  EXPERIMENT_CHANNEL_EXHAUSTED_DECLINES,
  requestsPath,
  recordExperimentRequests,
  readExperimentRequests,
  pendingExperimentRequests,
  decideExperimentRequest,
  applyDirectorExperimentDecisions,
  unansweredExperimentRequests,
  undecidedExperimentFindings,
  adoptedExperimentFollowupActions,
  requestKey,
};
