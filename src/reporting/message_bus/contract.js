"use strict";

// One way for a role to say something to another role.
//
// Before this there were five, and the one NAMED "messages" was the weakest of
// them. Counted on cycle-g-v89:
//
//   messages/<cycle>/     4 hardcoded channels, and the ledger held only one
//   state files           8 of them, each read directly by another role
//   planner_metadata      48 keys, 225 KB on a single analyst role plan
//   task directives       appended prose
//   output contracts      the JSON a role must return
//
// The cost was measured: the mailbox's own delivery machinery had a reader and
// no writer, so every message stayed `pending` forever, and when one channel
// flooded the ledger the director's mailbox file simply stopped being written --
// on 09-03, while the cycle ran to 09-11. Nobody noticed, because the real
// communication was happening in the other four mechanisms.
//
// THE PATTERN IS NOT NEW. `src/reporting/experiment_requests.js` already got
// this right, as a state file, for one channel: the author raises a request, the
// director owes a decision, a decision REQUIRES a reason in both directions, an
// unanswered request escalates into a dispatched lane, and a channel that has
// been answered the same way enough times is exhausted rather than retried.
// This module is that contract, lifted out so every channel has it instead of
// exactly one.
//
// Two kinds, kept apart on purpose. Conflating them is half of why the mailbox
// never worked: it marked status digests `trigger_turn` and `pending` as though
// somebody owed an answer, and then nobody did.
//
//   REQUEST   one role asks another for a decision. It is open until answered,
//             it escalates while it waits, and the answer carries a reason.
//   STANDING  one role keeps another informed. Nobody owes an answer; there is
//             exactly one per channel and its content refreshes in place.

const KINDS = Object.freeze({ REQUEST: "request", STANDING: "standing" });

const DECISIONS = Object.freeze({ ACCEPT: "accept", DECLINE: "decline" });

/**
 * Declare a channel.
 *
 * `from` and `to` are ROLES, not lanes: a channel outlives the lanes that use
 * it. `to` may be a list when the same thing must reach several roles, which is
 * what the lead-protection directive needs and what it previously achieved by
 * being copied into a state file, a planner_metadata key and a mailbox message.
 */
function defineChannel({ id, from, to, kind, reads = [], build, escalate = null, exhausted = null }) {
  if (!id || !from || !to) throw new Error("a channel needs an id, a from and a to");
  if (!Object.values(KINDS).includes(kind)) {
    throw new Error(`channel ${id}: kind must be one of ${Object.values(KINDS).join(", ")}`);
  }
  if (typeof build !== "function") throw new Error(`channel ${id}: build must be a function`);
  // A request that cannot escalate is a request nobody has to answer, which is
  // the state the whole mailbox was in.
  if (kind === KINDS.REQUEST && typeof escalate !== "function") {
    throw new Error(`channel ${id}: a request channel must say what happens while it goes unanswered`);
  }
  return Object.freeze({
    id,
    from,
    to: Object.freeze(Array.isArray(to) ? [...to] : [to]),
    kind,
    reads: Object.freeze([...reads]),
    build,
    escalate,
    exhausted,
  });
}

/**
 * The answer to a request, which is not optional and not wordless.
 *
 * A decision nobody can account for later is a silently expanded scope when it
 * accepts, and a question that quietly disappeared when it declines. That
 * sentence is from experiment_requests.js, where this rule already held.
 */
function decide({ decision, reason, decidedBy }) {
  if (!Object.values(DECISIONS).includes(decision)) {
    return { ok: false, error: `decision must be ${Object.values(DECISIONS).join(" or ")}` };
  }
  const text = String(reason || "").trim();
  if (!text) return { ok: false, error: "a decision requires a reason" };
  return {
    ok: true,
    decision: {
      decision,
      reason: text,
      decided_by: String(decidedBy || "").trim() || null,
      decided_at: new Date().toISOString(),
    },
  };
}

function isOpen(item) {
  return !item?.decision;
}

module.exports = {
  KINDS,
  DECISIONS,
  defineChannel,
  decide,
  isOpen,
};
