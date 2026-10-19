"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  compactText,
  ensureDir,
  fileMtimeMs,
  readJsonIfExists,
  writeJson,
} = require("./research_note_utils");

const PROTOCOL_SOURCE = {
  name: "Agent Protocol",
  repository: "user-owned agent-protocol repository; exact URL required when available to this runtime",
  local_reference_path: null,
  concepts_applied: ["agents", "threads", "runs", "append_only_messages", "mailbox_projection", "store"],
};

const ROLE_DESCRIPTIONS = {
  supervisor: "Monitors process health, queue progress, and recovery policy.",
  "lab-director": "Owns scientific strategy, hypothesis selection, and recovery decisions.",
  chronicle: "Maintains literature, claim, and evidence traceability.",
  scout: "Searches datasets, literature, and rival hypothesis families.",
  analyst: "Turns hypotheses and data into executable analysis handoffs.",
  "lab-runner": "Executes validation plans and records analysis results.",
  gatekeeper: "Reviews gate rubrics and rejects or approves scientific readiness.",
  author: "Writes report and manuscript drafts after gates are ready.",
  illustrator: "Produces figures and visual execution packets.",
};

function protocolRoot(root, cycleId) {
  return path.join(root, "protocol", cycleId);
}

function deterministicUuid(value) {
  const hash = crypto.createHash("sha256").update(String(value)).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${(parseInt(hash.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join("-");
}

function protocolStatusForLane(status) {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "failed_blocking":
      return "error";
    case "aborted":
    case "failed_non_blocking":
      return "interrupted";
    case "timeout":
      return "timeout";
    default:
      return "pending";
  }
}

function threadStatusFromCounts(laneCounts = {}) {
  if (Number(laneCounts.running || 0) > 0 || Number(laneCounts.pending || 0) > 0) {
    return "busy";
  }
  if (Number(laneCounts.failed_blocking || 0) > 0 || Number(laneCounts.failed || 0) > 0) {
    return "error";
  }
  return "idle";
}

function agentForRole(role) {
  return {
    agent_id: `researchlab.${role}`,
    name: `ResearchLab ${role}`,
    description: ROLE_DESCRIPTIONS[role] || `ResearchLab ${role} lane agent.`,
    metadata: {
      researchlab_role: role,
      runtime_scope: "cycle-lane",
    },
    capabilities: {
      "ap.io.messages": true,
      "ap.io.streaming": false,
      "researchlab.fs.contracts": true,
      "researchlab.fs.artifacts": true,
    },
  };
}

function collectAgents(laneStatuses = []) {
  const roles = new Set(Object.keys(ROLE_DESCRIPTIONS));
  for (const lane of laneStatuses) {
    if (lane?.role) roles.add(lane.role);
  }
  return Array.from(roles).sort().map(agentForRole);
}

// The bus shape, with the old field names still read so a ledger written before
// the refactor still renders.
function compactMessage(message) {
  const targets = Array.isArray(message.to_roles)
    ? message.to_roles
    : [message.target_role].filter(Boolean);
  return {
    id: message.message_id || null,
    role: message.from_role || message.author_role || message.author || "system",
    target_role: targets[0] || null,
    target_roles: targets,
    content: compactText(message.subject || message.summary || message.message || "", 1200),
    metadata: {
      channel: message.channel || null,
      kind: message.kind || null,
      // Whether somebody owes an answer, and whether it has reached a lane --
      // which is what `trigger_turn` pretended to mean and never measured.
      open_request: message.open === true,
      delivered_count: message.delivered_count ?? null,
      source_ref: message.source_ref || message.source_paths || null,
    },
  };
}

function runForLane({ cycleId, threadId, lane }) {
  const laneId = lane.lane_id || lane.id || "lane";
  const role = lane.role || "unknown";
  return {
    run_id: deterministicUuid(`${cycleId}:run:${laneId}`),
    thread_id: threadId,
    agent_id: `researchlab.${role}`,
    status: protocolStatusForLane(lane.status),
    metadata: {
      researchlab_cycle_id: cycleId,
      researchlab_lane_id: laneId,
      role,
      runtime_class: lane.runtime_class || null,
      action_type: lane.action_type || lane.task_type || null,
      source_brief_id: lane.source_brief_id || null,
      degraded: lane.degraded === true,
      original_status: lane.status || null,
    },
  };
}

function storeNamespaces({ root, cycleId }) {
  return [
    {
      namespace: ["researchlab", cycleId, "memory"],
      path: path.join(root, "memory", cycleId, "memory-index.json"),
      description: "Cycle-scoped long-term memory and compact context index.",
    },
    {
      namespace: ["researchlab", cycleId, "messages"],
      path: path.join(root, "messages", cycleId, "bus-ledger.json"),
      description: "Inter-agent message ledger and targeted role mailboxes.",
    },
    {
      namespace: ["researchlab", cycleId, "state"],
      path: path.join(root, "state", `${cycleId}-cycle-run-state.json`),
      description: "Cycle thread state, lane counts, and run statuses.",
    },
  ].filter((item) => fs.existsSync(item.path));
}

function sourcePaths(root, cycleId) {
  return {
    cycle_state: path.join(root, "state", `${cycleId}-cycle-run-state.json`),
    agent_communication_digest: path.join(root, "state", `${cycleId}-agent-communication-digest.json`),
    inter_agent_ledger: path.join(root, "messages", cycleId, "bus-ledger.json"),
    memory_index: path.join(root, "memory", cycleId, "memory-index.json"),
  };
}

function writeMarkdownSummary(filePath, snapshot) {
  const lines = [
    `# Agent Protocol Snapshot: ${snapshot.cycle_id}`,
    "",
    `- generated_at: ${snapshot.generated_at}`,
    `- thread_id: ${snapshot.thread.thread_id}`,
    `- thread_status: ${snapshot.thread.status}`,
    `- agent_count: ${snapshot.agents.length}`,
    `- run_count: ${snapshot.runs.length}`,
    "",
    "## Mapping",
    "- Agent Protocol agent -> ResearchLab role",
    "- Agent Protocol thread -> ResearchLab cycle",
    "- Agent Protocol run -> ResearchLab lane",
    "- Agent Protocol store -> ResearchLab memory/messages/state namespaces",
    "- Agent Protocol messages -> ResearchLab inter-agent ledger summaries",
    "",
    "## Active Runs",
  ];
  const activeRuns = snapshot.runs.filter((run) => run.status === "pending").slice(0, 12);
  if (activeRuns.length === 0) {
    lines.push("- none");
  } else {
    for (const run of activeRuns) {
      lines.push(`- ${run.metadata.researchlab_lane_id}: ${run.agent_id} (${run.metadata.original_status || run.status})`);
    }
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function ensureAgentProtocolSnapshot({ root, cycleId, force = false }) {
  const paths = sourcePaths(root, cycleId);
  const outputRoot = protocolRoot(root, cycleId);
  const snapshotPath = path.join(outputRoot, "agent-protocol-snapshot.json");
  const markdownPath = path.join(outputRoot, "agent-protocol-snapshot.md");
  const sourceMtime = Math.max(...Object.values(paths).map(fileMtimeMs), 0);
  const outputMtime = Math.max(fileMtimeMs(snapshotPath), fileMtimeMs(markdownPath), 0);
  if (!force && outputMtime >= sourceMtime && fs.existsSync(snapshotPath) && fs.existsSync(markdownPath)) {
    return {
      snapshot_path: snapshotPath,
      markdown_path: markdownPath,
      updated: false,
      reason: "up_to_date",
    };
  }

  const cycleState = readJsonIfExists(paths.cycle_state) || {};
  const ledger = readJsonIfExists(paths.inter_agent_ledger) || {};
  const digest = readJsonIfExists(paths.agent_communication_digest) || {};
  const memoryIndex = readJsonIfExists(paths.memory_index) || {};
  const laneStatuses = Array.isArray(cycleState.lane_statuses) ? cycleState.lane_statuses : [];
  const threadId = deterministicUuid(`${cycleId}:thread`);
  const messages = Array.isArray(ledger.messages) ? ledger.messages.map(compactMessage) : [];
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schema_version: "researchlab.agent_protocol.snapshot.v1",
    generated_at: generatedAt,
    generated_by: "refresh-cycle-agent-protocol-adapter",
    cycle_id: cycleId,
    protocol_source: PROTOCOL_SOURCE,
    agents: collectAgents(laneStatuses),
    thread: {
      thread_id: threadId,
      status: threadStatusFromCounts(cycleState.lane_counts || {}),
      metadata: {
        researchlab_cycle_id: cycleId,
        objective: memoryIndex.objective || memoryIndex.prompt || null,
        current_focus: digest.current_focus || memoryIndex.current_focus || null,
      },
      values: {
        lane_counts: cycleState.lane_counts || null,
        messages,
      },
      checkpoint: {
        checkpoint_id: deterministicUuid(`${cycleId}:checkpoint:${cycleState.updated_at || generatedAt}`),
        updated_at: cycleState.updated_at || generatedAt,
      },
    },
    runs: laneStatuses.map((lane) => runForLane({ cycleId, threadId, lane })),
    store: {
      namespaces: storeNamespaces({ root, cycleId }),
    },
    source_paths: Object.fromEntries(
      Object.entries(paths).map(([key, value]) => [key, fs.existsSync(value) ? value : null]),
    ),
  };
  ensureDir(outputRoot);
  writeJson(snapshotPath, snapshot);
  writeMarkdownSummary(markdownPath, snapshot);
  return {
    snapshot_path: snapshotPath,
    markdown_path: markdownPath,
    updated: true,
    reason: "refreshed",
    thread_id: threadId,
    thread_status: snapshot.thread.status,
    run_count: snapshot.runs.length,
    active_run_count: snapshot.runs.filter((run) => run.status === "pending").length,
    agent_count: snapshot.agents.length,
  };
}

module.exports = {
  ensureAgentProtocolSnapshot,
  deterministicUuid,
  protocolStatusForLane,
  threadStatusFromCounts,
};
