"use strict";

// The bus: build every channel, project it per role, and record what was read.
//
// The three things the old mailbox got wrong, and why each is here:
//
//   capacity   it kept one global slice of 250 across all channels, sorted by a
//              key every message left empty -- so the order fell through to the
//              sequence number and the survivors were whichever author had the
//              highest one. A channel is capped against ITSELF here.
//   identity   a standing status line embedded a lane count, so every refresh
//              minted a new message. One channel became 250 of them.
//   delivery   `delivery_state` had a reader and no writer. Nothing anywhere
//              set `acknowledged_at`, so every message was `pending` forever and
//              "was this delivered?" had no answer. Deliveries are recorded.

const fs = require("fs");
const path = require("path");

const { KINDS } = require("./contract");
const { deliveryReceiptLog, inboxLog } = require("../../observability/cycle_logs");
const { forEachLine } = require("../../observability/segmented_log");
const { CHANNELS } = require("./channels");
const { busRoot, readJsonl, readRaised } = require("./store");
const { ensureDir, writeJson, readJsonIfExists } = require("../research_note_utils");

// Per channel. Enough history to see a change, and no channel grows at another's
// expense.
const KEPT_PER_CHANNEL = 40;


/**
 * Record that a message was put in front of a role.
 *
 * Append-only and never throws: a receipt is evidence about a delivery that has
 * already happened, and losing one must not cost a lane its context. It is a
 * separate file from the ledger because lanes refresh concurrently and this
 * runtime has already lost a cycle to a single torn write.
 */
function recordDelivery({ root, cycleId, role, messageIds, laneId = null, now = new Date() }) {
  const ids = (Array.isArray(messageIds) ? messageIds : [messageIds]).filter(Boolean);
  if (!ids.length) return 0;
  try {
    const stamp = now.toISOString();
    deliveryReceiptLog(root, cycleId).append(
      ids.map((id) => ({ message_id: id, delivered_to: role, lane_id: laneId, delivered_at: stamp })),
      { now },
    );
    return ids.length;
  } catch {
    return 0;
  }
}

// Who was shown which message, folded from the receipts.
//
// The receipts are never read whole. MEASURED ON cycle-a-20260919,
// 2026-10-12: the single receipts file was 1.5 GB and this function read it
// into one string on every bus build -- more than a string can hold, so the
// read threw, the throw was swallowed, and every message was reported as never
// delivered. The fold is kept beside the receipts with the position it has
// reached, and each build reads only what was appended since. Losing the fold
// costs one pass over the segments, a line at a time.
const DELIVERY_SUMMARY_VERSION = 1;

function deliveriesByMessage(root, cycleId) {
  const receipts = deliveryReceiptLog(root, cycleId);
  const summaryPath = path.join(busRoot(root, cycleId), "delivery-summary.json");
  let summary = readJsonIfExists(summaryPath);
  if (!summary || summary.version !== DELIVERY_SUMMARY_VERSION || typeof summary.by_id !== "object") {
    summary = { version: DELIVERY_SUMMARY_VERSION, position: null, by_id: {} };
  }
  let folded = 0;
  const position = receipts.follow(summary.position, (segmentPath, offset) =>
    forEachLine(segmentPath, offset, (text) => {
      let receipt;
      try {
        receipt = JSON.parse(text);
      } catch {
        return;
      }
      const id = receipt?.message_id;
      if (!id) return;
      const seen = summary.by_id[id] || { count: 0, first_at: null, last_at: null, roles: [] };
      seen.count += 1;
      seen.first_at = seen.first_at || receipt.delivered_at || null;
      seen.last_at = receipt.delivered_at || seen.last_at;
      if (receipt.delivered_to && !seen.roles.includes(receipt.delivered_to)) seen.roles.push(receipt.delivered_to);
      summary.by_id[id] = seen;
      folded += 1;
    }));
  if (folded > 0 || position.segment !== summary.position?.segment || position.offset !== summary.position?.offset) {
    summary.position = position;
    summary.updated_at = new Date().toISOString();
    try {
      ensureDir(path.dirname(summaryPath));
      const tmp = `${summaryPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(summary), "utf8");
      fs.renameSync(tmp, summaryPath);
    } catch {
      // The fold is rebuilt from the receipts when it cannot be kept.
    }
  }
  const byId = new Map();
  for (const [id, seen] of Object.entries(summary.by_id)) {
    byId.set(id, { ...seen, roles: new Set(seen.roles) });
  }
  return byId;
}

/**
 * Raise something onto the bus from outside this process.
 *
 * The long-run watchdog is a shell script: it notices operational problems and
 * has to reach a role with them. It used to write straight into
 * `mailbox/<role>.jsonl` -- the projection -- which the bus rebuilds from its
 * registry every pass, so anything written there is overwritten. A producer
 * RAISES; only the bus projects.
 *
 * Append-only and ignored on failure, for the same reason as a receipt: a
 * monitor that cannot write a note must not take the run down with it.
 */
function raiseOnBus({ root, cycleId, channel, from, to, subject, payload = null, asksFor = null, itemId = null, legacyInboxType = null, now = new Date() }) {
  if (!channel || !from || !to || !subject) return null;
  const entry = {
    channel,
    from_role: from,
    to_roles: Array.isArray(to) ? to : [to],
    item_id: itemId || String(subject).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120),
    subject: String(subject),
    payload,
    asks_for: asksFor,
    legacy_inbox_type: legacyInboxType,
    raised_at: now.toISOString(),
  };
  try {
    const dir = busRoot(root, cycleId);
    ensureDir(dir);
    fs.appendFileSync(path.join(dir, "raised.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  } catch {
    return null;
  }
}

function messageIdFor(channel, item) {
  // Identity is the CHANNEL plus the thing being discussed -- never the wording,
  // which changes whenever a count in it changes.
  return `${channel.id}#${String(item.item_id || "item").slice(0, 160)}`;
}

function buildMessages({ root, cycleId, now }) {
  const built = [];
  // What a producer outside this process raised. Its channel is whatever it
  // named, so a monitor can open a conversation the registry did not anticipate
  // -- and it still lands in exactly one place, with one identity and one
  // capacity rule.
  const registered = new Set(CHANNELS.map((channel) => channel.id));
  for (const entry of readRaised(root, cycleId)) {
    if (!entry?.channel || !entry?.subject) continue;
    // A raised channel that IS registered goes through the registry below, so
    // it gets the escalation its contract promises. Only an unanticipated one
    // -- the long-run watchdog composes its channel id at runtime -- lands here.
    if (registered.has(entry.channel)) continue;
    built.push({
      message_id: `${entry.channel}#${String(entry.item_id || "raised").slice(0, 160)}`,
      channel: entry.channel,
      kind: entry.asks_for ? KINDS.REQUEST : KINDS.STANDING,
      from_role: entry.from_role || "unknown",
      to_roles: Array.isArray(entry.to_roles) ? entry.to_roles : [],
      subject: entry.subject,
      payload: entry.payload || null,
      asks_for: entry.asks_for || null,
      legacy_inbox_type: entry.legacy_inbox_type || null,
      decision: null,
      open: Boolean(entry.asks_for),
      source_ref: null,
      queued_at: entry.raised_at || now.toISOString(),
    });
  }
  for (const channel of CHANNELS) {
    let items = [];
    try {
      items = channel.build({ root, cycleId }) || [];
    } catch {
      // A channel that cannot read its source says nothing this pass. It must
      // not take the rest of the bus down with it.
      items = [];
    }
    const open = items.filter((item) => !item.decision && (item.status || "pending") === "pending");
    const escalations = channel.kind === KINDS.REQUEST && channel.escalate
      ? (() => {
        try {
          return channel.escalate({ root, cycleId, open }) || [];
        } catch {
          return [];
        }
      })()
      : [];
    const exhausted = channel.exhausted
      ? (() => {
        try {
          return channel.exhausted({ root, cycleId, open }) || null;
        } catch {
          return null;
        }
      })()
      : null;

    for (const item of items) {
      built.push({
        message_id: messageIdFor(channel, item),
        channel: channel.id,
        kind: channel.kind,
        from_role: channel.from,
        to_roles: [...channel.to],
        subject: item.subject || "",
        payload: item.payload || null,
        asks_for: item.asks_for || null,
        legacy_inbox_type: item.legacy_inbox_type || null,
        // A request is answered or it is open. A standing message is neither.
        decision: channel.kind === KINDS.REQUEST ? item.decision || null : null,
        open: channel.kind === KINDS.REQUEST ? !item.decision : false,
        source_ref: item.source_ref || null,
        queued_at: now.toISOString(),
      });
    }
    if (escalations.length || exhausted) {
      built.push({
        message_id: `${channel.id}#channel-state`,
        channel: channel.id,
        kind: KINDS.STANDING,
        from_role: channel.from,
        to_roles: [...channel.to],
        subject: exhausted
          ? `This channel is exhausted: ${exhausted.reason}`
          : `${escalations.length} item(s) on this channel are waiting for a decision.`,
        payload: { escalations, exhausted },
        decision: null,
        open: false,
        source_ref: null,
        queued_at: now.toISOString(),
      });
    }
  }
  return built;
}

function mergeIntoLedger({ existing, built }) {
  const byId = new Map();
  for (const message of existing) {
    if (message?.message_id) byId.set(message.message_id, message);
  }
  for (const message of built) {
    const previous = byId.get(message.message_id);
    byId.set(message.message_id, {
      ...previous,
      ...message,
      // When it FIRST entered the bus, not when it was last rebuilt.
      queued_at: previous?.queued_at || message.queued_at,
      updated_at: message.queued_at,
    });
  }
  const byChannel = new Map();
  for (const message of byId.values()) {
    if (!byChannel.has(message.channel)) byChannel.set(message.channel, []);
    byChannel.get(message.channel).push(message);
  }
  const kept = [];
  for (const messages of byChannel.values()) {
    messages.sort((a, b) => String(a.queued_at || "").localeCompare(String(b.queued_at || "")));
    kept.push(...messages.slice(-KEPT_PER_CHANNEL));
  }
  return kept.sort((a, b) => String(a.queued_at || "").localeCompare(String(b.queued_at || "")));
}

function projectPerRole({ dir, messages }) {
  ensureDir(dir);
  const roles = new Set();
  for (const message of messages) for (const role of message.to_roles) roles.add(role);
  const written = {};
  for (const role of [...roles].sort()) {
    const mine = messages.filter((message) => message.to_roles.includes(role));
    const file = path.join(dir, `${role}.jsonl`);
    fs.writeFileSync(file, `${mine.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf8");
    written[role] = {
      jsonl: file,
      message_count: mine.length,
      open_request_count: mine.filter((m) => m.open).length,
    };
  }
  return written;
}

// Some channels have a consumer that predates the bus and reads its own file.
//
// The inbox (`runtime/<cycle>-labdirector-inbox/<hour>.jsonl`) is append-only with a read cursor,
// and a Rust consumer spawns a lab-director lane from a `supervisor_instruction`
// line in it. That consumer is load-bearing, so the bus does not replace the
// file -- it becomes the only thing that WRITES it, which is the same move the
// watchdog made: a producer raises, only the bus projects.
//
// Projected exactly once per message. The bus rebuilds every pass and the file
// is append-only behind a cursor, so appending on each rebuild would replay
// every instruction forever.
const LEGACY_INBOX_CHANNELS = Object.freeze({
  "supervisor->lab-director:interrupt": "supervisor_instruction",
  "researcher->lab-director:instruction": "user_message",
});

function projectLegacyInbox({ root, cycleId, messages }) {
  const projected = new Set(
    readJsonl(path.join(busRoot(root, cycleId), "projected-to-inbox.jsonl")).map((row) => row?.message_id),
  );
  const pending = messages.filter(
    (message) =>
      LEGACY_INBOX_CHANNELS[message.channel]
      // The REQUEST itself, never the channel's own escalation summary: the
      // Rust consumer spawns a lab-director lane per line it reads, so a
      // summary saying "1 item is waiting" would spawn a second lane for the
      // one item.
      && Boolean(message.asks_for)
      && !projected.has(message.message_id),
  );
  if (!pending.length) return 0;
  try {
    const rows = pending.map((message) => ({
      ts: message.queued_at,
      // The producer's own type when it named one -- `/pause` is a
      // control_command and a typed question is a user_message, and the
      // consumer branches on which -- otherwise the channel's default.
      type: message.legacy_inbox_type || LEGACY_INBOX_CHANNELS[message.channel],
      payload: {
        ...(message.payload || {}),
        cycle_id: cycleId,
        message_id: message.message_id,
        author: message.from_role,
        message: message.subject,
      },
    }));
    inboxLog(root, cycleId).append(rows);
    fs.appendFileSync(
      path.join(busRoot(root, cycleId), "projected-to-inbox.jsonl"),
      `${pending.map((m) => JSON.stringify({ message_id: m.message_id })).join("\n")}\n`,
      "utf8",
    );
    return pending.length;
  } catch {
    return 0;
  }
}

/**
 * Rebuild the bus for a cycle.
 *
 * Every channel is rebuilt from its own source of truth on each pass, so the
 * bus never becomes a second copy of anything: it is a projection with delivery
 * semantics on top. `experiment_requests.js` keeps its own store, because that
 * store holds the decisions and their reasons and predates this module.
 */
function ensureMessageBus({ root, cycleId, now = new Date() }) {
  const dir = busRoot(root, cycleId);
  const ledgerPath = path.join(dir, "bus-ledger.json");
  const existing = readJsonIfExists(ledgerPath)?.messages || [];
  const built = buildMessages({ root, cycleId, now });
  const messages = mergeIntoLedger({ existing, built });

  const delivered = deliveriesByMessage(root, cycleId);
  for (const message of messages) {
    const record = delivered.get(message.message_id);
    message.delivered_count = record ? record.count : 0;
    message.first_delivered_at = record ? record.first_at : null;
    message.last_delivered_at = record ? record.last_at : null;
    message.delivered_to = record ? [...record.roles].sort() : [];
  }

  const mailboxes = projectPerRole({ dir, messages });
  const projectedToInbox = projectLegacyInbox({ root, cycleId, messages });
  ensureDir(dir);
  writeJson(ledgerPath, {
    schema_version: 1,
    cycle_id: cycleId,
    updated_at: now.toISOString(),
    channel_count: CHANNELS.length,
    message_count: messages.length,
    open_request_count: messages.filter((m) => m.open).length,
    undelivered_count: messages.filter((m) => m.delivered_count === 0).length,
    messages,
    mailboxes,
    projected_to_legacy_inbox: projectedToInbox,
  });
  return { bus_root: dir, ledger_path: ledgerPath, mailboxes, message_count: messages.length };
}

/** What this role is owed an answer on, and what it owes one on. */
function openRequestsFor({ root, cycleId, role }) {
  const messages = readJsonIfExists(path.join(busRoot(root, cycleId), "bus-ledger.json"))?.messages || [];
  return {
    owes_an_answer: messages.filter((m) => m.open && m.to_roles.includes(role)),
    waiting_on_an_answer: messages.filter((m) => m.open && m.from_role === role),
  };
}

module.exports = {
  ensureMessageBus,
  raiseOnBus,
  recordDelivery,
  openRequestsFor,
  busRoot,
  KEPT_PER_CHANNEL,
};
