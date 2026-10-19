"use strict";

// The channels that exist, declared in one place.
//
// Every one of these was ALREADY a communication between two roles before this
// file existed. None of them is new. What was missing is that each carried its
// own mechanism -- a state file here, a planner_metadata key there, a mailbox
// message somewhere else -- so there was no way to ask the obvious question:
// which roles owe each other an answer right now, and how long have they owed
// it. Registering them is what makes that answerable.
//
// Adding a channel is adding an entry here. It is not editing a function that
// hardcodes four of them, which is what `ensureAgentMailboxes` did and why the
// author-to-director relationship -- which has existed in
// experiment_requests.js the whole time, with better semantics than the mailbox
// ever had -- was invisible to anything that looked at "messages".

const fs = require("fs");
const path = require("path");

const { KINDS, defineChannel } = require("./contract");
const { readJsonIfExists } = require("../research_note_utils");
const { raisedOnChannel } = require("./store");
const {
  readExperimentRequests,
  unansweredExperimentRequests,
  experimentChannelExhausted,
  EXPERIMENT_CHANNEL_EXHAUSTED_DECLINES,
} = require("../experiment_requests");

function statePath(root, cycleId, stem) {
  return path.join(root, "state", `${cycleId}-${stem}.json`);
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function text(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------------------------------------------------------------- request channels

// The channel this contract was lifted from. It keeps its own store, because
// that store already holds the decisions and their reasons and has done since
// before the bus existed; the bus reads it rather than copying it. A copy is
// what the mailbox held, and a copy is not a channel.
const EXPERIMENT_REQUESTS = defineChannel({
  id: "author->lab-director:experiment-request",
  from: "author",
  to: "lab-director",
  kind: KINDS.REQUEST,
  reads: ["experiment-requests"],
  build({ root, cycleId }) {
    const ledger = readExperimentRequests({ root, cycleId });
    return asArray(ledger.requests).map((item) => ({
      item_id: text(item.claim_it_would_support, 200).toLowerCase(),
      subject: text(item.experiment, 200),
      asks_for: text(item.claim_it_would_support, 200),
      answered_by: text(item.result_that_licenses_the_claim, 200) || null,
      decision: item.decision || null,
      status: item.status || "pending",
      unanswered_by: asArray(item.unanswered_by).length,
      source_ref: statePath(root, cycleId, "experiment-requests"),
    }));
  },
  escalate({ root, cycleId, open }) {
    if (!open.length) return [];
    const ignored = unansweredExperimentRequests({ root, cycleId, minIgnored: 3 }).length;
    return open.map((item) => ({
      type: "experiment_request_decision_followup",
      preferred_role: "lab-director",
      priority: ignored > 0 ? "critical" : "high",
      description:
        `decide the experiment the author requested: ${item.subject}`
        + " -- adopt or decline, with a reason either way",
      blocker_reasons: [item.asks_for],
    }));
  },
  exhausted({ root, cycleId }) {
    const ledger = readExperimentRequests({ root, cycleId });
    const closed = experimentChannelExhausted(asArray(ledger.requests));
    if (!closed) return null;
    return {
      // Not a delay: an answer. Holding the manuscript for one more instance of
      // it is what pinned cycle-g-v89's paper at 65 against a raw score of 100.
      reason: `${closed.declined} declined and none adopted; the runs being asked for are not coming`,
      after_declines: EXPERIMENT_CHANNEL_EXHAUSTED_DECLINES,
      owed_by: "author",
      what_is_owed:
        "state the claim the CURRENT evidence defends and bound it in the limitations; do not keep"
        + " conditioning the manuscript on a run the programme has refused",
    };
  },
});

// The author is blocked on a manuscript review and cannot clear it alone. The
// reviews already exist as state; what did not exist is anyone owing an answer.
const MANUSCRIPT_BLOCKERS = defineChannel({
  id: "author->lab-director:manuscript-blocker",
  from: "author",
  to: "lab-director",
  kind: KINDS.REQUEST,
  reads: ["paper-review", "report-review"],
  build({ root, cycleId }) {
    const paper = readJsonIfExists(statePath(root, cycleId, "paper-review")) || {};
    const report = readJsonIfExists(statePath(root, cycleId, "report-review")) || {};
    const blockers = [
      ...asArray(paper.blockers || paper.paper_blockers),
      ...asArray(report.blockers || report.report_blockers),
    ].map((item) => (typeof item === "string" ? item : item?.blocker || item?.summary || ""));
    return blockers
      .map((blocker) => text(blocker, 240))
      .filter(Boolean)
      .map((blocker) => ({
        item_id: blocker.toLowerCase().slice(0, 120),
        subject: blocker,
        asks_for: "a decision the author cannot make alone: what the manuscript may claim against this",
        decision: null,
        status: "pending",
        source_ref: statePath(root, cycleId, "paper-review"),
      }));
  },
  escalate({ open }) {
    if (!open.length) return [];
    return [{
      type: "manuscript_blocker_decision_followup",
      preferred_role: "lab-director",
      priority: "high",
      description:
        `${open.length} manuscript blocker(s) need a scientific decision rather than a rewrite:`
        + ` ${open.slice(0, 2).map((item) => item.subject).join("; ")}`,
      blocker_reasons: open.map((item) => item.subject),
    }];
  },
});

// ---------------------------------------------------------------- standing channels

// Nobody owes an answer to any of these. They exist so a role opens its turn
// knowing what the cycle currently is, and there is exactly ONE per channel:
// its content refreshes in place rather than accumulating, which is the bug
// that filled the old ledger with 250 copies of a single status line.

const CYCLE_STATUS = defineChannel({
  id: "watchdog->supervisor:cycle-status",
  from: "watchdog",
  to: "supervisor",
  kind: KINDS.STANDING,
  reads: ["cycle-run-state"],
  build({ root, cycleId }) {
    const state = readJsonIfExists(statePath(root, cycleId, "cycle-run-state")) || {};
    const counts = state.lane_counts || null;
    return [{
      item_id: "cycle-status",
      subject: `Cycle status ${state.status || "unknown"}; completed ${counts?.completed ?? "unknown"} lanes.`,
      payload: { cycle_status: state.status || "unknown", lane_counts: counts },
      source_ref: statePath(root, cycleId, "cycle-run-state"),
    }];
  },
});

const DIRECTOR_FOCUS = defineChannel({
  id: "supervisor->lab-director:focus",
  from: "supervisor",
  to: "lab-director",
  kind: KINDS.STANDING,
  reads: ["agent-communication-digest", "lab-director-research-notes"],
  build({ root, cycleId }) {
    const digest = readJsonIfExists(statePath(root, cycleId, "agent-communication-digest")) || {};
    const notes = readJsonIfExists(statePath(root, cycleId, "lab-director-research-notes")) || {};
    const lead = text(
      digest.current_focus?.lead_hypothesis || notes.current_lead_hypothesis?.statement,
      260,
    );
    const blockers = asArray(digest.active_blockers || notes.open_blockers).map((item) => text(item));
    return [{
      item_id: "director-focus",
      subject: lead
        ? `Current lead: "${lead}". ${blockers.length} active blocker(s).`
        : "No lead is selected; decide the next scientific move before drafting a claim.",
      payload: {
        lead_hypothesis: lead || null,
        active_blockers: blockers.slice(0, 12),
        resolved_or_superseded_blockers: asArray(
          digest.resolved_or_superseded_blockers || notes.resolved_or_superseded_blockers,
        ).map((item) => text(item)).slice(0, 8),
        // A retired METHOD is not a retired QUESTION, so the reason travels.
        retired_methods: asArray(notes.rejected_or_demoted_hypotheses).slice(0, 8).map((item) => ({
          family: text(item?.family, 160),
          status: text(item?.status, 120),
          reason: text(item?.reason, 240),
        })),
      },
      source_ref: statePath(root, cycleId, "lab-director-research-notes"),
    }];
  },
});

const AUTHOR_MANDATE = defineChannel({
  id: "lab-director->author:write-against",
  from: "lab-director",
  to: "author",
  kind: KINDS.STANDING,
  reads: ["lab-director-research-notes", "document-authorization"],
  build({ root, cycleId }) {
    const notes = readJsonIfExists(statePath(root, cycleId, "lab-director-research-notes")) || {};
    const auth = readJsonIfExists(statePath(root, cycleId, "document-authorization")) || {};
    const lead = text(notes.current_lead_hypothesis?.statement, 260);
    if (!lead) return [];
    return [{
      item_id: "author-mandate",
      subject: `Write against the current lead: "${lead}". Claim only what the recorded evidence establishes.`,
      payload: {
        write_against_lead: lead,
        document_stage_authorized: auth.authorized === true,
        active_blockers: asArray(notes.open_blockers).map((item) => text(item)).slice(0, 12),
        retired_methods: asArray(notes.rejected_or_demoted_hypotheses).slice(0, 8).map((item) => ({
          family: text(item?.family, 160),
          reason: text(item?.reason, 240),
        })),
      },
      source_ref: statePath(root, cycleId, "lab-director-research-notes"),
    }];
  },
});

const TRACEABILITY = defineChannel({
  id: "lab-director->chronicle:traceability",
  from: "lab-director",
  to: "chronicle",
  kind: KINDS.STANDING,
  reads: ["chronicle-research-notes", "agent-communication-digest"],
  build({ root, cycleId }) {
    const chronicle = readJsonIfExists(statePath(root, cycleId, "chronicle-research-notes")) || {};
    const gaps = asArray(chronicle.communication_gaps).map((item) => text(item)).slice(0, 8);
    return [{
      item_id: "traceability",
      subject: gaps.length
        ? `Close ${gaps.length} traceability gap(s) between the claim and its evidence.`
        : "Keep the claim-to-evidence trace current from the latest decision.",
      payload: { communication_gaps: gaps, next_probe_targets: asArray(chronicle.next_probe_targets).slice(0, 8) },
      source_ref: statePath(root, cycleId, "chronicle-research-notes"),
    }];
  },
});

const GATE_BLOCKERS = defineChannel({
  id: "chronicle->gatekeeper:active-blockers",
  from: "chronicle",
  to: "gatekeeper",
  kind: KINDS.STANDING,
  reads: ["agent-communication-digest", "chronicle-research-notes"],
  build({ root, cycleId }) {
    const digest = readJsonIfExists(statePath(root, cycleId, "agent-communication-digest")) || {};
    const chronicle = readJsonIfExists(statePath(root, cycleId, "chronicle-research-notes")) || {};
    const active = asArray(digest.active_blockers).map((item) => text(item)).slice(0, 12);
    return [{
      item_id: "gate-blockers",
      subject: active.length
        ? `Evaluate ${active.length} active blocker(s); keep resolved history separate from them.`
        : "Evaluate only active blockers and keep resolved history separate.",
      payload: {
        active_blockers: active,
        latest_validation: chronicle.latest_validation || null,
      },
      source_ref: statePath(root, cycleId, "agent-communication-digest"),
    }];
  },
});

// ---------------------------------------------------- raised request channels

// A channel whose items come from a producer OUTSIDE this process rather than
// from a state file: the supervisor's own loop, and a person typing in the live
// view. Both raised by these exact names already. Neither was in this file.
//
// That mattered, and not only for tidiness. `defineChannel` refuses a request
// channel that cannot say what happens while it goes unanswered -- and the two
// requests in the system that a HUMAN or the supervisor raises were the two the
// rule never reached, because `raiseOnBus` writes a log and the generic reader
// of that log has no registry entry to consult. They were open requests that
// could sit open forever, which is the exact condition the bus was built to
// make visible.
function fromRaised(channelId) {
  return ({ root, cycleId }) =>
    raisedOnChannel(root, cycleId, channelId).map((entry) => ({
      item_id: entry.item_id,
      subject: text(entry.subject, 400),
      asks_for: entry.asks_for || null,
      legacy_inbox_type: entry.legacy_inbox_type || null,
      payload: entry.payload || null,
      decision: entry.decision || null,
      status: entry.status || "pending",
      source_ref: null,
      raised_at: entry.raised_at || null,
    }));
}

// The newest director lane that finished, by its final-status time.
function latestCompletedDirectorLane(root, cycleId) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  let names = [];
  try {
    names = fs.readdirSync(lanesRoot);
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    if (!/^(?:followup-)?lab-director-\d+/.test(name)) continue;
    const statusPath = path.join(lanesRoot, name, "final-status.json");
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(statusPath).mtimeMs;
    } catch {
      continue;
    }
    if (latest && mtimeMs <= latest.ms) continue;
    if (readJsonIfExists(statusPath)?.status !== "completed") continue;
    latest = { lane_id: name, ms: mtimeMs };
  }
  return latest;
}

const SUPERVISOR_INTERRUPT = defineChannel({
  id: "supervisor->lab-director:interrupt",
  from: "supervisor",
  to: "lab-director",
  kind: KINDS.REQUEST,
  reads: ["raised"],
  // Answered by the director acting at all. The interrupt asks for "the
  // decisive next move, or say what you are waiting on", and any director lane
  // that completes after it was raised has done one or the other; nothing reads
  // the bus to record a reply, so without this it stayed open forever.
  //
  // MEASURED ON cycle-a-20260919, 2026-10-02: six interrupts from
  // earlier in the cycle (one still citing gate_score=41) were open in every
  // director prompt -- "Decision-making appears stalled ... demote the current
  // lead, nominate a genuine rival ... NOW" -- through 18 decisions, nine of
  // which replaced the lead.
  build: ({ root, cycleId }) => {
    const latest = latestCompletedDirectorLane(root, cycleId);
    return fromRaised("supervisor->lab-director:interrupt")({ root, cycleId }).map((item) => {
      const raisedMs = Date.parse(item.raised_at || "");
      if (item.decision || !latest || !Number.isFinite(raisedMs) || latest.ms <= raisedMs) return item;
      return {
        ...item,
        status: "answered",
        decision: {
          decision: "accept",
          reason: `${latest.lane_id} completed a director decision after this interrupt was raised`,
          decided_by: latest.lane_id,
          decided_at: new Date(latest.ms).toISOString(),
        },
      };
    });
  },
  escalate({ open }) {
    if (!open.length) return [];
    return [{
      type: "supervisor_interrupt_followup",
      preferred_role: "lab-director",
      priority: "critical",
      description:
        "the supervisor interrupted this cycle and is still waiting:"
        + ` ${open.map((item) => item.subject).slice(0, 2).join("; ")}`,
      blocker_reasons: open.map((item) => item.asks_for || item.subject),
    }];
  },
});

const RESEARCHER_INSTRUCTION = defineChannel({
  id: "researcher->lab-director:instruction",
  from: "researcher",
  to: "lab-director",
  kind: KINDS.REQUEST,
  reads: ["raised"],
  build: fromRaised("researcher->lab-director:instruction"),
  escalate({ open }) {
    if (!open.length) return [];
    // A person asked. Nothing in this programme outranks that, and an
    // unanswered one must not look like a status line.
    return [{
      type: "researcher_instruction_followup",
      preferred_role: "lab-director",
      priority: "critical",
      description:
        "the researcher asked for something and has had no answer:"
        + ` ${open.map((item) => item.subject).slice(0, 2).join("; ")}`,
      blocker_reasons: open.map((item) => item.asks_for || item.subject),
    }];
  },
});

const CHANNELS = Object.freeze([
  EXPERIMENT_REQUESTS,
  MANUSCRIPT_BLOCKERS,
  SUPERVISOR_INTERRUPT,
  RESEARCHER_INSTRUCTION,
  CYCLE_STATUS,
  DIRECTOR_FOCUS,
  AUTHOR_MANDATE,
  TRACEABILITY,
  GATE_BLOCKERS,
]);

module.exports = { CHANNELS, statePath };
