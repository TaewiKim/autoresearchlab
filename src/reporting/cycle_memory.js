"use strict";

const fs = require("fs");
const path = require("path");
const {
  compactText,
  ensureDir,
  fileMtimeMs,
  markdownList,
  readJsonIfExists,
  uniqueStrings,
  writeJson,
} = require("./research_note_utils");

const MEMORY_SCHEMA_VERSION = 1;

function statePath(root, cycleId, stem) {
  return path.join(root, "state", `${cycleId}-${stem}.json`);
}

function writeText(filePath, text) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${text.replace(/\s+$/g, "")}\n`, "utf8");
}

function reviewSnapshot(review, scoreKey, bandKey, blockerKey) {
  if (!review || typeof review !== "object") return null;
  return {
    score: review[scoreKey] ?? review.score ?? null,
    band: review[bandKey] || review.band || null,
    passed:
      review.gate_passed === true ||
      review.conclusion_gate_passed === true ||
      review.approval_gate_passed === true,
    blocker_count: Array.isArray(review[blockerKey]) ? review[blockerKey].length : 0,
  };
}

function readTextPrefixIfExists(filePath, maxBytes = 1600) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const toRead = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(toRead);
    const bytesRead = fs.readSync(fd, buffer, 0, toRead, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return stat.size > maxBytes ? `${text}\n[truncated]` : text;
  } catch {
    return "";
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function sourcePaths(root, cycleId) {
  return {
    agent_communication_digest: statePath(root, cycleId, "agent-communication-digest"),
    lab_director_hypothesis: statePath(root, cycleId, "lab-director-hypothesis"),
    lab_director_research_notes: statePath(root, cycleId, "lab-director-research-notes"),
    chronicle_research_notes: statePath(root, cycleId, "chronicle-research-notes"),
    cycle_state: statePath(root, cycleId, "cycle-run-state"),
    gate_review: statePath(root, cycleId, "gate-review"),
    approval_review: statePath(root, cycleId, "approval-review"),
    conclusion_review: statePath(root, cycleId, "conclusion-review"),
  };
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function compactField(value, maxChars = 1200) {
  const text = compactText(value || "", maxChars);
  return text || null;
}

function hypothesisStatement(value) {
  const item = objectOrNull(value) || {};
  return compactField(
    item.statement ||
      item.hypothesis ||
      item.claim ||
      item.core_claim ||
      item.description,
    1600,
  );
}

function selectedHypothesis(hypothesis) {
  const item = objectOrNull(hypothesis) || {};
  return objectOrNull(item.selected_hypothesis) ||
    objectOrNull(item.lead_hypothesis) ||
    objectOrNull(item.current_lead_hypothesis) ||
    null;
}

function accessionText(value) {
  return String(value || "").trim().toLowerCase();
}

function valueMatchesAccession(value, accession) {
  const wanted = accessionText(accession);
  if (!wanted) return true;
  if (value == null) return false;
  return accessionText(typeof value === "string" ? value : JSON.stringify(value)).includes(wanted);
}

function hypothesisDataset(hypothesis, selected) {
  const item = objectOrNull(hypothesis) || {};
  const lead = objectOrNull(selected) || {};
  const datasetOrAccession =
    item.dataset_or_accession ||
    item.identification_strategy?.dataset_or_accession ||
    lead.dataset_or_accession ||
    lead.accession ||
    null;
  const materializedDataset =
    lead.materialized_dataset ||
    item.identification_strategy?.materialized_dataset ||
    item.materialized_dataset ||
    null;
  if (materializedDataset && valueMatchesAccession(materializedDataset, datasetOrAccession)) {
    return materializedDataset;
  }
  return datasetOrAccession;
}

function buildCurrentFocus({ digest, labNotes, chronicleNotes, hypothesis }) {
  const digestFocus = objectOrNull(digest.current_focus) || {};
  const notesLead = objectOrNull(labNotes.current_lead_hypothesis) || {};
  const selected = selectedHypothesis(hypothesis);
  const canonicalStatement =
    hypothesisStatement(hypothesis) ||
    hypothesisStatement(selected);
  const notesStatement = hypothesisStatement(notesLead);
  const leadHypothesis =
    canonicalStatement ||
    notesStatement ||
    compactField(digestFocus.lead_hypothesis, 1600);

  return {
    ...(digestFocus || {}),
    lead_hypothesis: leadHypothesis,
    hypothesis_id:
      hypothesis?.hypothesis_id ||
      selected?.hypothesis_id ||
      notesLead.hypothesis_id ||
      digestFocus.hypothesis_id ||
      null,
    primary_family:
      hypothesis?.primary_family ||
      hypothesis?.family_root ||
      selected?.primary_family ||
      selected?.family_root ||
      notesLead.primary_family ||
      notesLead.family_root ||
      digestFocus.primary_family ||
      null,
    dataset:
      hypothesisDataset(hypothesis, selected) ||
      notesLead.materialized_dataset ||
      notesLead.dataset_or_accession ||
      digestFocus.dataset ||
      null,
    latest_validation:
      chronicleNotes.latest_validation?.summary ||
      digestFocus.latest_validation ||
      null,
    focus_source: canonicalStatement
      ? "lab_director_hypothesis"
      : notesStatement
        ? "lab_director_research_notes"
        : digestFocus.lead_hypothesis
          ? "agent_communication_digest"
          : null,
  };
}

function latestLaneRollouts({ root, cycleId, limit = 12 }) {
  const lanesRoot = path.join(root, "lanes", cycleId);
  if (!fs.existsSync(lanesRoot)) return [];
  const cycleState = readJsonIfExists(statePath(root, cycleId, "cycle-run-state")) || {};
  const laneRefs = Array.isArray(cycleState.lane_statuses) && cycleState.lane_statuses.length > 0
    ? cycleState.lane_statuses.map((lane) => ({
        lane_id: lane.lane_id || lane.id,
        role: lane.role || null,
        status: lane.status || null,
        summary: lane.summary || lane.last_error || null,
      }))
    : fs.readdirSync(lanesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(-limit * 3)
      .map((entry) => ({
        lane_id: entry.name,
        role: inferRoleFromLaneId(entry.name),
        status: null,
        summary: null,
      }));
  const rollouts = laneRefs
    .filter((lane) => lane.lane_id)
    .map((lane) => {
      const laneDir = path.join(lanesRoot, lane.lane_id);
      const resultPath = path.join(laneDir, "result.json");
      const contractPath = path.join(laneDir, "lane-contract.json");
      const lastMessagePath = path.join(laneDir, "output-last-message.txt");
      const lastMessage = readTextPrefixIfExists(lastMessagePath, 1200);
      return {
        lane_id: lane.lane_id,
        role: lane.role || inferRoleFromLaneId(lane.lane_id),
        status: lane.status || null,
        mtime: Math.max(fileMtimeMs(resultPath), fileMtimeMs(lastMessagePath), fileMtimeMs(contractPath)),
        result_path: fs.existsSync(resultPath) ? resultPath : null,
        last_message_path: fs.existsSync(lastMessagePath) ? lastMessagePath : null,
        summary: compactText(
          lane.summary || lastMessage || "",
          1200,
        ),
      };
    })
    .filter((lane) => lane.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime);
  const selected = [];
  const perRoleCounts = new Map();
  for (const lane of rollouts) {
    const role = lane.role || "unknown";
    const count = perRoleCounts.get(role) || 0;
    if (count >= 3) continue;
    selected.push(lane);
    perRoleCounts.set(role, count + 1);
    if (selected.length >= limit) break;
  }
  for (const lane of rollouts) {
    if (selected.length >= limit) break;
    if (selected.some((item) => item.lane_id === lane.lane_id)) continue;
    selected.push(lane);
  }
  return selected.sort((a, b) => b.mtime - a.mtime);
}

function inferRoleFromLaneId(laneId) {
  const id = String(laneId || "");
  for (const role of ["lab-director", "chronicle", "gatekeeper", "lab-runner", "analyst", "scout", "author", "supervisor", "watchdog"]) {
    if (id.includes(role)) return role;
  }
  return null;
}

function safeFileSegment(value) {
  return String(value || "lane")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "lane";
}

function buildMemoryIndex({ root, cycleId, documents }) {
  const sources = sourcePaths(root, cycleId);
  const digest = readJsonIfExists(sources.agent_communication_digest) || {};
  const hypothesis = readJsonIfExists(sources.lab_director_hypothesis) || {};
  const labNotes = readJsonIfExists(sources.lab_director_research_notes) || {};
  const chronicleNotes = readJsonIfExists(sources.chronicle_research_notes) || {};
  const cycleState = readJsonIfExists(sources.cycle_state) || {};
  const gate = readJsonIfExists(sources.gate_review) || {};
  const approval = readJsonIfExists(sources.approval_review) || {};
  const conclusion = readJsonIfExists(sources.conclusion_review) || {};
  const latestRollouts = latestLaneRollouts({ root, cycleId });
  const sourceRefs = Object.fromEntries(
    Object.entries(sources).map(([key, value]) => [key, fs.existsSync(value) ? value : null]),
  );

  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    cycle_id: cycleId,
    updated_at: new Date().toISOString(),
    generated_by: "refresh-cycle-memory",
    read_path_policy: {
      default_order: ["memory_summary.md", "MEMORY.md", "rollout_summaries only by lane id", "raw_memories.md only for audit"],
      max_initial_reads: 3,
      do_not_inline_full_notes: true,
      use_source_paths_for_targeted_evidence: true,
    },
    current_focus: buildCurrentFocus({ digest, labNotes, chronicleNotes, hypothesis }),
    scores: {
      gate: reviewSnapshot(gate, "score", "band", "blockers"),
      approval: reviewSnapshot(approval, "approval_readiness_score", "approval_readiness_band", "approval_blockers"),
      conclusion: reviewSnapshot(conclusion, "conclusion_score", "conclusion_band", "conclusion_blockers"),
    },
    cycle_status: cycleState.status || "unknown",
    active_blockers: uniqueStrings(digest.active_blockers || labNotes.open_blockers || [], 16),
    resolved_or_superseded_blockers: uniqueStrings(
      digest.resolved_or_superseded_blockers || labNotes.resolved_or_superseded_blockers || [],
      16,
    ),
    next_actions: (digest.handoffs?.lab_director?.next_actions || labNotes.next_actions || []).slice(0, 10),
    communication_diagnosis: uniqueStrings(digest.communication_diagnosis || chronicleNotes.communication_gaps || [], 12),
    role_boundaries: uniqueStrings(digest.role_boundaries || [], 8),
    timeline: uniqueStrings(digest.timeline || [], 12),
    latest_rollouts: latestRollouts,
    source_paths: {
      ...sourceRefs,
      memory_summary: documents.summary,
      memory: documents.memory,
      raw_memories: documents.raw,
      rollout_summaries_dir: documents.rollouts,
    },
  };
}

function memorySummaryMarkdown(index) {
  const focus = index.current_focus || {};
  const scores = index.scores || {};
  return [
    `# ResearchLab Memory Summary: ${index.cycle_id}`,
    "",
    `- updated_at: ${index.updated_at}`,
    `- generated_by: ${index.generated_by}`,
    `- cycle_status: ${index.cycle_status}`,
    "- read_policy: read this summary first, then MEMORY.md, then targeted source_paths only when needed",
    "",
    "## Current Focus",
    `- lead_hypothesis: ${focus.lead_hypothesis || "none"}`,
    `- hypothesis_id: ${focus.hypothesis_id || "none"}`,
    `- dataset: ${JSON.stringify(focus.dataset || null)}`,
    `- latest_validation: ${focus.latest_validation || "unknown"}`,
    "",
    "## Scores",
    `- gate: ${JSON.stringify(scores.gate || null)}`,
    `- approval: ${JSON.stringify(scores.approval || null)}`,
    `- conclusion: ${JSON.stringify(scores.conclusion || null)}`,
    "",
    "## Active Blockers",
    markdownList(index.active_blockers),
    "",
    "## Resolved Or Superseded Blockers",
    markdownList(index.resolved_or_superseded_blockers.slice(0, 8)),
    "",
    "## Communication Diagnosis",
    markdownList(index.communication_diagnosis),
    "",
    "## Next Actions",
    markdownList(index.next_actions),
    "",
    "## Recent Timeline",
    markdownList(index.timeline),
    "",
    "## Source Refs",
    ...Object.entries(index.source_paths || {}).map(([key, value]) => `- ${key}: ${value || "missing"}`),
    "",
  ].join("\n");
}

function memoryMarkdown(index) {
  return [
    `# ResearchLab Memory: ${index.cycle_id}`,
    "",
    "## Durable Role Boundaries",
    markdownList(index.role_boundaries.length ? index.role_boundaries : [
      "LabDirector owns research direction, hypothesis selection, pivots, validation priorities, and research-note updates.",
      "Chronicle owns traceability, evidence ledger maintenance, stale context detection, and concise change handoff.",
      "Supervisor/watchdog own process completion and anomaly escalation; they do not invent scientific claims.",
      "Gatekeeper evaluates the active blocker set and keeps resolved history separate.",
    ]),
    "",
    "## Read Discipline",
    "- Start with memory_summary.md and this MEMORY.md.",
    "- Avoid reading full lab-director or chronicle notebooks unless a specific decision requires one exact section.",
    "- Use rollout_summaries by lane id when reconstructing the time-ordered development of a claim.",
    "- Treat raw_memories.md as an audit artifact, not default context.",
    "",
    "## Stable Scientific State",
    `- lead_hypothesis: ${index.current_focus?.lead_hypothesis || "none"}`,
    `- dataset: ${JSON.stringify(index.current_focus?.dataset || null)}`,
    `- latest_validation: ${index.current_focus?.latest_validation || "unknown"}`,
    "",
    "## Current Working Set",
    "### Active Blockers",
    markdownList(index.active_blockers),
    "",
    "### Next Actions",
    markdownList(index.next_actions),
    "",
  ].join("\n");
}

function rawMemoriesMarkdown(index) {
  return [
    `# Raw Memory Inputs: ${index.cycle_id}`,
    "",
    "This file is a compact generated audit trail. It is not the first-read context.",
    "",
    "## Current Focus",
    "```json",
    JSON.stringify(index.current_focus || null, null, 2),
    "```",
    "",
    "## Communication Diagnosis",
    markdownList(index.communication_diagnosis),
    "",
    "## Rollout Summaries",
    markdownList(index.latest_rollouts.map((lane) => `${lane.lane_id} (${lane.role || "unknown"}): ${lane.summary || lane.status || "no summary"}`)),
    "",
  ].join("\n");
}

function writeRolloutSummaries(memoryRoot, rollouts) {
  const rolloutsDir = path.join(memoryRoot, "rollout_summaries");
  ensureDir(rolloutsDir);
  const written = [];
  for (const lane of rollouts) {
    const filePath = path.join(rolloutsDir, `${safeFileSegment(lane.lane_id)}.md`);
    writeText(filePath, [
      `# Rollout Summary: ${lane.lane_id}`,
      "",
      `- role: ${lane.role || "unknown"}`,
      `- status: ${lane.status || "unknown"}`,
      `- result_path: ${lane.result_path || "missing"}`,
      `- last_message_path: ${lane.last_message_path || "missing"}`,
      "",
      "## Summary",
      compactText(lane.summary || "No lane summary was available.", 1800),
      "",
    ].join("\n"));
    written.push(filePath);
  }
  const writtenSet = new Set(written.map((filePath) => path.resolve(filePath)));
  for (const entry of fs.readdirSync(rolloutsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(rolloutsDir, entry.name);
    if (!writtenSet.has(path.resolve(filePath))) {
      // force:true tolerates the file vanishing between readdir and delete —
      // a concurrent pass (wrapper relaunch overlap) pruning the same stale
      // rollout summary made unlinkSync throw ENOENT and abort the whole
      // run-research supervisor.
      fs.rmSync(filePath, { force: true });
    }
  }
  return written;
}

function ensureCycleMemory({ root, cycleId, force = false }) {
  const memoryRoot = path.join(root, "memory", cycleId);
  const documents = {
    root: memoryRoot,
    summary: path.join(memoryRoot, "memory_summary.md"),
    memory: path.join(memoryRoot, "MEMORY.md"),
    raw: path.join(memoryRoot, "raw_memories.md"),
    rollouts: path.join(memoryRoot, "rollout_summaries"),
    index: path.join(memoryRoot, "memory-index.json"),
  };
  const sources = Object.values(sourcePaths(root, cycleId));
  const sourceMtime = Math.max(...sources.map(fileMtimeMs), ...latestLaneRollouts({ root, cycleId }).map((lane) => lane.mtime), 0);
  const targetMtime = Math.min(
    fileMtimeMs(documents.summary),
    fileMtimeMs(documents.memory),
    fileMtimeMs(documents.raw),
    fileMtimeMs(documents.index),
  );
  if (
    !force &&
    sourceMtime > 0 &&
    targetMtime >= sourceMtime &&
    fs.existsSync(documents.summary) &&
    fs.existsSync(documents.memory) &&
    fs.existsSync(documents.raw) &&
    fs.existsSync(documents.index)
  ) {
    return {
      memory_root: documents.root,
      memory_summary_path: documents.summary,
      memory_path: documents.memory,
      raw_memories_path: documents.raw,
      rollout_summaries_dir: documents.rollouts,
      index_path: documents.index,
      updated: false,
      reason: "up_to_date",
    };
  }

  ensureDir(memoryRoot);
  const index = buildMemoryIndex({ root, cycleId, documents });
  const rolloutSummaryPaths = writeRolloutSummaries(memoryRoot, index.latest_rollouts);
  index.source_paths.rollout_summaries = rolloutSummaryPaths;
  writeJson(documents.index, index);
  writeText(documents.summary, memorySummaryMarkdown(index));
  writeText(documents.memory, memoryMarkdown(index));
  writeText(documents.raw, rawMemoriesMarkdown(index));
  return {
    memory_root: documents.root,
    memory_summary_path: documents.summary,
    memory_path: documents.memory,
    raw_memories_path: documents.raw,
    rollout_summaries_dir: documents.rollouts,
    index_path: documents.index,
    updated: true,
    reason: "refreshed",
  };
}

module.exports = {
  ensureCycleMemory,
};
