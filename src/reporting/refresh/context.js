"use strict";

const path = require("path");
const { runtimeRoot } = require("../../runtime/native_client");
const { ensureAgentCommunicationDigest } = require("../agent_communication_digest");
const { ensureAgentMailboxes } = require("../agent_mailbox");
const { ensureAgentProtocolSnapshot } = require("../agent_protocol");
const { ensureAnalystResearchNotes } = require("../analyst_research_notes");
const { ensureChronicleResearchNotes } = require("../chronicle_research_notes");
const { ensureCycleMemory } = require("../cycle_memory");
const { ensureLabDirectorResearchNotes } = require("../lab_director_research_notes");
const { readTerminationCode } = require("../termination_code");
const { readJsonIfExists, summarizeCycleState } = require("./state");

function contextHealthSnapshot({ root, cycleId }) {
  const memoryIndex = readJsonIfExists(path.join(root, "memory", cycleId, "memory-index.json")) || {};
  const ledger = readJsonIfExists(path.join(root, "messages", cycleId, "bus-ledger.json")) || {};
  const messages = Array.isArray(ledger.messages) ? ledger.messages : [];
  // A no-lead line while a lead exists used to leak in from a digest-supplied
  // summary the mailbox copied verbatim. The bus builds every subject from the
  // source itself, so the leak has no path in -- this stays as the measurement
  // that says so.
  const staleNoLeadMessages = messages.filter((message) => {
    return /No executable lead|No lead hypothesis|nothing scientifically falsifiable/i.test(String(message?.subject || ""));
  });
  return {
    memory_updated_at: memoryIndex.updated_at || null,
    lead_hypothesis_present: Boolean(memoryIndex.current_focus?.lead_hypothesis),
    latest_rollout_count: Array.isArray(memoryIndex.latest_rollouts) ? memoryIndex.latest_rollouts.length : 0,
    mailbox_updated_at: ledger.updated_at || null,
    mailbox_message_count: messages.length,
    // What somebody actually owes an answer on, and what was handed to a lane.
    // `trigger_turn` counted neither: it was set by the producer and read by
    // nobody who could clear it.
    open_request_count: ledger.open_request_count ?? messages.filter((message) => message?.open).length,
    undelivered_count: ledger.undelivered_count
      ?? messages.filter((message) => !message?.delivered_count).length,
    stale_no_lead_message_count: staleNoLeadMessages.length,
    read_path_policy: memoryIndex.read_path_policy || null,
  };
}

function preservedJsonMarkdown({ jsonPath, markdownPath }) {
  if (!jsonPath || !markdownPath) return null;
  if (!require("fs").existsSync(jsonPath) || !require("fs").existsSync(markdownPath)) return null;
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    updated: false,
    reason: "preserved_existing_context_artifact",
  };
}

function preservedCycleMemory({ root, cycleId }) {
  const fs = require("fs");
  const memoryRoot = path.join(root, "memory", cycleId);
  const summary = path.join(memoryRoot, "memory_summary.md");
  const memory = path.join(memoryRoot, "MEMORY.md");
  const raw = path.join(memoryRoot, "raw_memories.md");
  const index = path.join(memoryRoot, "memory-index.json");
  if (![summary, memory, raw, index].every((filePath) => fs.existsSync(filePath))) return null;
  return {
    memory_root: memoryRoot,
    memory_summary_path: summary,
    memory_path: memory,
    raw_memories_path: raw,
    rollout_summaries_dir: path.join(memoryRoot, "rollout_summaries"),
    index_path: index,
    updated: false,
    reason: "preserved_existing_context_artifact",
  };
}

function preservedAgentMailboxes({ root, cycleId }) {
  const fs = require("fs");
  const messagesRoot = path.join(root, "messages", cycleId);
  const ledgerPath = path.join(messagesRoot, "bus-ledger.json");
  if (!fs.existsSync(ledgerPath) || !fs.existsSync(path.join(messagesRoot, "lab-director.jsonl"))) return null;
  return {
    messages_root: messagesRoot,
    mailbox_dir: messagesRoot,
    ledger_path: ledgerPath,
    updated: false,
    reason: "preserved_existing_context_artifact",
  };
}

function preservedAgentProtocol({ root, cycleId }) {
  const fs = require("fs");
  const protocolRoot = path.join(root, "protocol", cycleId);
  const snapshotPath = path.join(protocolRoot, "agent-protocol-snapshot.json");
  const markdownPath = path.join(protocolRoot, "agent-protocol-snapshot.md");
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(markdownPath)) return null;
  return {
    snapshot_path: snapshotPath,
    markdown_path: markdownPath,
    updated: false,
    reason: "preserved_existing_context_artifact",
  };
}

function refreshCycleContextOutputs({ cwd = process.cwd(), cycleId, force = false }) {
  const root = runtimeRoot(cwd);
  const cycleSummary = summarizeCycleState({ cwd, cycleId });
  const preserveExisting = !force && process.env.RESEARCHLAB_CONTEXT_REFRESH_UPDATE !== "1";
  const stateRoot = path.join(root, "state");
  const labDirectorResearchNotes = (preserveExisting && preservedJsonMarkdown({
    jsonPath: path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`),
    markdownPath: path.join(stateRoot, `${cycleId}-lab-director-research-notes.md`),
  })) || ensureLabDirectorResearchNotes({
    root,
    cycleId,
    force,
  });
  const chronicleResearchNotes = (preserveExisting && preservedJsonMarkdown({
    jsonPath: path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`),
    markdownPath: path.join(stateRoot, `${cycleId}-chronicle-research-notes.md`),
  })) || ensureChronicleResearchNotes({
    root,
    cycleId,
    force,
  });
  const analystResearchNotes = (preserveExisting && preservedJsonMarkdown({
    jsonPath: path.join(stateRoot, `${cycleId}-analyst-research-notes.json`),
    markdownPath: path.join(stateRoot, `${cycleId}-analyst-research-notes.md`),
  })) || ensureAnalystResearchNotes({
    root,
    cycleId,
    force,
  });
  const agentCommunicationDigest = (preserveExisting && preservedJsonMarkdown({
    jsonPath: path.join(stateRoot, `${cycleId}-agent-communication-digest.json`),
    markdownPath: path.join(stateRoot, `${cycleId}-agent-communication-digest.md`),
  })) || ensureAgentCommunicationDigest({
    root,
    cycleId,
    force,
  });
  const cycleMemory = (preserveExisting && preservedCycleMemory({ root, cycleId })) || ensureCycleMemory({
    root,
    cycleId,
    force,
  });
  const agentMailboxes = (preserveExisting && preservedAgentMailboxes({ root, cycleId })) || ensureAgentMailboxes({
    root,
    cycleId,
    force,
  });
  const agentProtocol = (preserveExisting && preservedAgentProtocol({ root, cycleId })) || ensureAgentProtocolSnapshot({
    root,
    cycleId,
    force,
  });
  return {
    cycle_id: cycleId,
    refresh_context_only: true,
    termination_code: readTerminationCode({ cwd, cycleId }),
    cycle_state: cycleSummary.cycleState,
    lab_director_research_notes: labDirectorResearchNotes,
    chronicle_research_notes: chronicleResearchNotes,
    analyst_research_notes: analystResearchNotes,
    agent_communication_digest: agentCommunicationDigest,
    cycle_memory: cycleMemory,
    agent_mailboxes: agentMailboxes,
    agent_protocol: agentProtocol,
    context_health: contextHealthSnapshot({ root, cycleId }),
  };
}

module.exports = {
  contextHealthSnapshot,
  refreshCycleContextOutputs,
};
