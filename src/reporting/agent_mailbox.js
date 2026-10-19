"use strict";

// Kept as the entry point everyone already calls; the work is the bus.
//
// This file used to BE the mechanism: four hardcoded channels, a global message
// cap, and a delivery state nothing ever wrote. It is now a thin adapter onto
// src/reporting/message_bus, where a channel is registered rather than
// hardcoded, a request is distinguished from a status, and a delivery is
// recorded. See message_bus/contract.js for why, and for the channel this
// contract was lifted out of -- experiment_requests.js had it right, for one
// channel, the whole time.

const path = require("path");

const { ensureMessageBus, recordDelivery, openRequestsFor, raiseOnBus } = require("./message_bus");

/**
 * Rebuild every channel for this cycle and project it per role.
 *
 * `force` is accepted and ignored: the bus rebuilds each channel from its own
 * source every pass, so there is no stale-vs-fresh decision to make. The old
 * mtime short-circuit here is what let the director's mailbox go eight days
 * without being rewritten.
 */
function ensureAgentMailboxes({ root, cycleId }) {
  const bus = ensureMessageBus({ root, cycleId });
  return {
    messages_root: bus.bus_root,
    mailbox_dir: bus.bus_root,
    ledger_path: bus.ledger_path,
    mailbox_paths: bus.mailboxes,
    message_count: bus.message_count,
    updated: true,
    reason: "bus_rebuilt",
  };
}

module.exports = {
  ensureAgentMailboxes,
  raiseOnBus,
  recordDelivery,
  openRequestsFor,
};
