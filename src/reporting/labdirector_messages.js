"use strict";

// A message from the researcher to the LabDirector of a running cycle.
//
// Used by `researchlab tell` (src/cli/tell.js) and by the live view's chat.
// The message goes on the message bus, which projects the inbox line the
// harness's LabDirector consumer reads, and into the director dialogue.

const path = require("path");
const { raiseOnBus, ensureMessageBus } = require("./message_bus");
const { appendDialogueRow } = require("../observability/cycle_logs");

function queueLabDirectorMessage({
  cwd,
  cycleId,
  message,
  author = "researcher",
  kind = "user_message",
  payload = null,
  skipDialogue = false,
  source = "cli",
}) {
  const root = path.join(cwd, ".research-lab");
  const trimmed = typeof message === "string" ? message.trim() : "";
  const effectiveKind = String(kind || "user_message");
  const hasPayload = payload && typeof payload === "object";

  if (effectiveKind === "user_message" && !trimmed) {
    throw new Error("message is required");
  }
  if (effectiveKind !== "user_message" && !hasPayload && !trimmed) {
    throw new Error("message is required");
  }

  const messageId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ts = new Date().toISOString();
  const basePayload = {
    cycle_id: cycleId,
    message_id: messageId,
    author,
    source,
    ...(hasPayload ? payload : { message: trimmed }),
  };
  const dialogueEventType = effectiveKind === "user_message"
    ? "researcher_message"
    : `researcher_${effectiveKind}`;
  const dialoguePayload = {
    ts,
    event_type: dialogueEventType,
    payload: basePayload,
  };
  // A person asking the director for something is a request like any other, so
  // it goes on the bus and the bus projects the inbox line the Rust consumer
  // reads. It used to be appended here directly, which made the inbox a sixth
  // place to look for "who has asked whom for what".
  //
  // ...and then the bus is rebuilt HERE, before this call returns. Raising alone
  // only appends to `raised.jsonl`; the projection that writes the line the
  // consumer reads happens in `ensureMessageBus`, and moving the write into the
  // bus without rebuilding it left a person's instruction sitting in a log until
  // some other pass happened to rebuild. The live view can be the only thing
  // running, in which case that is never. A researcher's message must be
  // deliverable the moment it is sent.
  raiseOnBus({
    root,
    cycleId,
    channel: "researcher->lab-director:instruction",
    from: "researcher",
    to: "lab-director",
    itemId: messageId,
    subject: String(basePayload?.message || effectiveKind),
    asksFor: "act on what the researcher asked for, or say why you are not",
    payload: basePayload,
    // `/pause` is a control_command and a typed question is a user_message, and
    // the consumer branches on which. The type belongs to the producer, so it
    // travels with the message rather than being decided per channel.
    legacyInboxType: effectiveKind,
  });
  try {
    ensureMessageBus({ root, cycleId });
  } catch {
    // The message is on the bus either way; a projection that failed is a
    // delivery this cycle can still make on its next pass, and must not turn a
    // person's message into a 500.
  }
  if (!skipDialogue) {
    appendDialogueRow(root, cycleId, dialoguePayload);
  }
  return {
    queued: true,
    cycle_id: cycleId,
    message_id: messageId,
    ts,
  };
}

module.exports = { queueLabDirectorMessage };
