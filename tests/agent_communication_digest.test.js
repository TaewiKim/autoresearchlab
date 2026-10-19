"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { ensureAgentCommunicationDigest } = require("../src/reporting/agent_communication_digest");
const { ensureDir, writeJson } = require("../src/reporting/research_note_utils");

test("agent communication digest suppresses stale no-lead handoffs when a current lead exists", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-agent-digest-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-digest-current-lead";
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  writeJson(path.join(stateRoot, `${cycleId}-cycle-run-state.json`), {
    status: "running",
    lane_counts: { completed: 4, pending: 1, running: 0, failed: 0 },
    lane_statuses: [],
  });
  writeJson(path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`), {
    current_lead_hypothesis: {
      statement: "Lead claim should stay active.",
    },
    next_actions: ["Run the validation."],
  });
  writeJson(path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`), {
    handoff_for_lab_director: "No executable lead claim was found in Chronicle DCI artifacts.",
    handoff_for_gatekeeper: "Use the latest validation evidence.",
  });
  writeJson(path.join(stateRoot, `${cycleId}-gate-review.json`), {
    decision_reason: "No lead hypothesis is present, so there is nothing scientifically falsifiable to approve.",
    blockers: [
      "No lead hypothesis is present, so there is nothing scientifically falsifiable to approve.",
      "Validation has not reached the stated claim.",
    ],
  });

  const result = ensureAgentCommunicationDigest({ root, cycleId, force: true });
  assert.equal(result.reason, "refreshed");
  const digest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, `${cycleId}-agent-communication-digest.json`), "utf8"),
  );

  assert.match(digest.handoffs.chronicle.summary, /Trace the current lead/);
  assert.match(digest.handoffs.gatekeeper.summary, /Evaluate active blockers/);
  assert.doesNotMatch(
    `${digest.handoffs.chronicle.summary}\n${digest.handoffs.gatekeeper.summary}`,
    /No executable lead|No lead hypothesis|nothing scientifically falsifiable/i,
  );

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("agent communication digest falls back to gate latest validation", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-agent-digest-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-digest-gate-validation";
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  writeJson(path.join(stateRoot, `${cycleId}-cycle-run-state.json`), {
    status: "running",
    lane_counts: { completed: 8, pending: 1, running: 0, failed: 0 },
    lane_statuses: [],
  });
  writeJson(path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`), {
    current_lead_hypothesis: {
      statement: "Lead claim remains active.",
      dataset_or_accession: "GSE228779",
    },
  });
  writeJson(path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`), {});
  writeJson(path.join(stateRoot, `${cycleId}-gate-review.json`), {
    latest_validation_lane_id: "followup-runner-363",
    latest_validation_summary: {
      overall_status: "degraded",
      checks_passed: 11,
      checks_total: 13,
    },
  });

  ensureAgentCommunicationDigest({ root, cycleId, force: true });
  const digest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, `${cycleId}-agent-communication-digest.json`), "utf8"),
  );
  const markdown = fs.readFileSync(
    path.join(stateRoot, `${cycleId}-agent-communication-digest.md`),
    "utf8",
  );

  assert.equal(digest.current_focus.latest_validation, "followup-runner-363 (degraded), 11/13 checks");
  assert.equal(digest.handoffs.runner.summary, "followup-runner-363 (degraded), 11/13 checks");
  assert.match(markdown, /latest_validation: followup-runner-363 \(degraded\), 11\/13 checks/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("agent communication digest resolves master-table repair blocker after satisfied gate evidence", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "researchlab-agent-digest-"));
  const root = path.join(cwd, ".research-lab");
  const cycleId = "cycle-digest-master-table-resolved";
  const stateRoot = path.join(root, "state");
  ensureDir(stateRoot);
  writeJson(path.join(stateRoot, `${cycleId}-cycle-run-state.json`), {
    status: "running",
    lane_counts: { completed: 12, pending: 1, running: 0, failed: 0 },
    lane_statuses: [],
  });
  writeJson(path.join(stateRoot, `${cycleId}-lab-director-research-notes.json`), {
    current_lead_hypothesis: {
      statement: "GSE228779 current lead remains active.",
      dataset_or_accession: "GSE228779",
    },
    open_blockers: [
      "Analyst/Lab-runner must repair the analysis_master_table_created blueprint interface so it accepts the runner --csv-root argument.",
      "A GeoMx-suitable methods waiver or alternative domain workflow is required.",
    ],
  });
  writeJson(path.join(stateRoot, `${cycleId}-chronicle-research-notes.json`), {});
  writeJson(path.join(stateRoot, `${cycleId}-gate-review.json`), {
    latest_validation_lane_id: "followup-runner-369",
    scientific_value_gate: {
      latest_validation_summary: {
        overall_status: "degraded",
        checks_passed: 15,
        checks_total: 17,
        checks: {
          analysis_master_table_gate_satisfied: true,
        },
        analysis_master_table_gate: {
          required: true,
          satisfied: true,
        },
      },
    },
  });

  ensureAgentCommunicationDigest({ root, cycleId, force: true });
  const digest = JSON.parse(
    fs.readFileSync(path.join(stateRoot, `${cycleId}-agent-communication-digest.json`), "utf8"),
  );

  assert.doesNotMatch(digest.active_blockers.join("\n"), /master_table_created blueprint interface/i);
  assert.match(digest.resolved_or_superseded_blockers.join("\n"), /master_table_created blueprint interface/i);
  assert.match(digest.active_blockers.join("\n"), /GeoMx-suitable methods waiver/i);

  fs.rmSync(cwd, { recursive: true, force: true });
});
