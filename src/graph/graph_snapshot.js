"use strict";

const fs = require("fs");
const path = require("path");
const { writeJson } = require("../shared/json");
const { runtimeRoot } = require("../runtime/native_client");
const { collectLaneRecords } = require("../storage/metadata_store");

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

// The ids an array already holds, kept beside it instead of searched for.
//
// MEASURED ON cycle-a-20260919, 2026-10-12: with 3,506 lanes the
// snapshot is 69,052 nodes and 108,929 edges, and "is this id already here"
// was a scan of the whole array for every one of them. buildGraphSnapshot took
// 80.4 s, 4.3 s of it reading the lanes; the controller runs it on every
// control-state transition, with the cycle idle behind it. Nothing else adds
// to these arrays, so the index cannot fall behind them.
const NODE_IDS = new WeakMap();
const EDGE_IDS = new WeakMap();

function idsOf(indexes, items, key) {
  let ids = indexes.get(items);
  if (!ids) {
    ids = new Set(items.map((item) => item[key]));
    indexes.set(items, ids);
  }
  return ids;
}

function addNode(nodes, node) {
  if (!node?.node_id) return;
  const ids = idsOf(NODE_IDS, nodes, "node_id");
  if (ids.has(node.node_id)) return;
  ids.add(node.node_id);
  nodes.push(node);
}

function addEdge(edges, edge) {
  if (!edge?.source_node_id || !edge?.target_node_id || !edge?.relation) return;
  const edgeId = edge.edge_id || `${edge.source_node_id}|${edge.relation}|${edge.target_node_id}`;
  const ids = idsOf(EDGE_IDS, edges, "edge_id");
  if (ids.has(edgeId)) return;
  ids.add(edgeId);
  edges.push({
    edge_id: edgeId,
    ...edge,
  });
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function slugify(value, fallback = "item") {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function claimNodeId(claimId, statement) {
  return `claim:${claimId || slugify(statement)}`;
}

function evidenceNodeId(kind, value) {
  return `evidence:${kind}:${slugify(value)}`;
}

function artifactNodeId(filePath) {
  return `artifact:${slugify(filePath)}`;
}

function relationForClaimStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (/(refut|reject|falsif|challeng|contradict)/.test(normalized)) {
    return "REFUTES";
  }
  if (/(inconclusive|uncertain|mixed|pending|open|unresolved)/.test(normalized)) {
    return "INCONCLUSIVE_FOR";
  }
  return "SUPPORTS";
}

function normalizeClaimLink(claim) {
  return {
    claim_node_id: claimNodeId(claim.claim_id, claim.statement),
    relation: relationForClaimStatus(claim.status),
    claim_id: claim.claim_id || null,
    statement: claim.statement || null,
  };
}

function readReportClaims(summary) {
  const reportPath = summary?.researcher_view?.summary?.source_paths?.report || null;
  const reportJson = readJsonIfExists(reportPath) || {};
  const primary = Array.isArray(reportJson.primary_claims) ? reportJson.primary_claims : [];
  const supporting = Array.isArray(reportJson.supporting_claims) ? reportJson.supporting_claims : [];
  return {
    reportPath,
    reportJson,
    claims: [...primary, ...supporting],
  };
}

function reviewScore(review, legacyKey) {
  return review?.score ?? review?.[legacyKey] ?? null;
}

function reviewPass(review, legacyKey) {
  return review?.pass === true || review?.[legacyKey] === true;
}

function reviewBlockers(review, legacyKey) {
  if (Array.isArray(review?.blockers)) return review.blockers;
  if (Array.isArray(review?.[legacyKey])) return review[legacyKey];
  return [];
}

function registerClaimLink(targetMap, key, claim) {
  if (!key) return;
  const bucket = targetMap.get(key) || [];
  const link = normalizeClaimLink(claim);
  if (!bucket.some((item) => item.claim_node_id === link.claim_node_id && item.relation === link.relation)) {
    bucket.push(link);
  }
  targetMap.set(key, bucket);
}

function buildClaimAndEvidenceGraph({ summary, nodes, edges, cycleNodeId }) {
  const cycleId = String(cycleNodeId || "").replace(/^cycle:/, "");
  const reportDecisionNodeId = `decision:${cycleId}:report`;
  const paperDecisionNodeId = `decision:${cycleId}:paper`;
  const { reportPath, reportJson, claims } = readReportClaims(summary);
  const ledgerSummary = summary?.hypothesis_ledger?.summary || {};
  const focusHypotheses = toArray(ledgerSummary.focus_hypotheses);
  const claimLinksByLane = new Map();
  const claimLinksByArtifactPath = new Map();

  for (const claim of claims) {
    const nodeId = claimNodeId(claim.claim_id, claim.statement);
    const claimRelation = relationForClaimStatus(claim.status);
    addNode(nodes, {
      node_id: nodeId,
      node_type: "Claim",
      label: claim.statement || claim.claim_id || "claim",
      state_json: {
        status: claim.status || null,
        evidence_quality_score: Number(claim.evidence_quality_score || 0) || null,
      },
      metadata_json: {
        supporting_hypotheses: toArray(claim.supporting_hypotheses),
        supporting_lanes: toArray(claim.supporting_lanes),
      },
      provenance_json: {
        sources: [reportPath].filter(Boolean),
      },
    });
    addEdge(edges, {
      source_node_id: cycleNodeId,
      target_node_id: nodeId,
      relation: "INCLUDES",
      status: "active",
      metadata_json: {},
      provenance_json: {
        sources: [reportPath].filter(Boolean),
      },
    });

    for (const hypothesisId of toArray(claim.supporting_hypotheses)) {
      const matched = focusHypotheses.find((item) => item.hypothesis_id === hypothesisId);
      if (!matched) continue;
      const hypothesisNodeId = `hypothesis:${hypothesisId}`;
      addEdge(edges, {
        source_node_id: nodeId,
        target_node_id: hypothesisNodeId,
        relation: "BELONGS_TO",
        status: "linked",
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
    }

    for (const paper of toArray(claim.supporting_papers)) {
      const evidenceId = evidenceNodeId("paper", paper);
      addNode(nodes, {
        node_id: evidenceId,
        node_type: "Evidence",
        label: paper,
        state_json: {
          kind: "paper-citation",
        },
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
      addEdge(edges, {
        source_node_id: evidenceId,
        target_node_id: nodeId,
        relation: claimRelation,
        status: "reported",
        metadata_json: {
          source_kind: "paper-citation",
        },
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
      addEdge(edges, {
        source_node_id: reportDecisionNodeId,
        target_node_id: evidenceId,
        relation: "TRIGGERED_BY",
        status: "recorded",
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
      addEdge(edges, {
        source_node_id: paperDecisionNodeId,
        target_node_id: evidenceId,
        relation: "TRIGGERED_BY",
        status: "recorded",
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
    }

    for (const laneId of toArray(claim.supporting_lanes)) {
      const evidenceId = evidenceNodeId("lane", laneId);
      registerClaimLink(claimLinksByLane, laneId, claim);
      addNode(nodes, {
        node_id: evidenceId,
        node_type: "Evidence",
        label: laneId,
        state_json: {
          kind: "lane-support",
        },
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
      addEdge(edges, {
        source_node_id: evidenceId,
        target_node_id: nodeId,
        relation: claimRelation,
        status: "reported",
        metadata_json: {
          source_kind: "lane-support",
        },
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
      addEdge(edges, {
        source_node_id: reportDecisionNodeId,
        target_node_id: evidenceId,
        relation: "TRIGGERED_BY",
        status: "recorded",
        metadata_json: {},
        provenance_json: {
          sources: [reportPath].filter(Boolean),
        },
      });
    }
  }

  if (reportPath) {
    const reportArtifactId = artifactNodeId(reportPath);
    claimLinksByArtifactPath.set(reportPath, claims.map((claim) => normalizeClaimLink(claim)));
    addNode(nodes, {
      node_id: reportArtifactId,
      node_type: "Artifact",
      label: path.basename(reportPath),
      state_json: {
        artifact_type: "report-json",
      },
      metadata_json: {
        path: reportPath,
      },
      provenance_json: {
        sources: [reportPath],
      },
    });
    addEdge(edges, {
      source_node_id: reportArtifactId,
      target_node_id: cycleNodeId,
      relation: "EMITTED_IN",
      status: "recorded",
      metadata_json: {},
      provenance_json: {
        sources: [reportPath],
      },
    });
    for (const claim of claims) {
      addEdge(edges, {
        source_node_id: reportArtifactId,
        target_node_id: claimNodeId(claim.claim_id, claim.statement),
        relation: relationForClaimStatus(claim.status),
        status: "reported",
        metadata_json: {
          source_kind: "document-artifact",
        },
        provenance_json: {
          sources: [reportPath],
        },
      });
    }
    if (Array.isArray(reportJson.top_papers)) {
      for (const paper of reportJson.top_papers.slice(0, 8)) {
        const evidenceId = evidenceNodeId("paper", paper.title || paper.doi || JSON.stringify(paper));
        addEdge(edges, {
          source_node_id: reportArtifactId,
          target_node_id: evidenceId,
          relation: "MATERIALIZES",
          status: "recorded",
          metadata_json: {
            source_kind: "reference-list",
          },
          provenance_json: {
            sources: [reportPath],
          },
        });
      }
    }
  }

  return {
    claimLinksByLane,
    claimLinksByArtifactPath,
  };
}

function appendClaimImpactEdges({ edges, sourceNodeId, claimLinks, provenance = {}, status = "recorded", sourceKind = null }) {
  for (const claimLink of claimLinks || []) {
    addEdge(edges, {
      source_node_id: sourceNodeId,
      target_node_id: claimLink.claim_node_id,
      relation: claimLink.relation,
      status,
      metadata_json: sourceKind ? { source_kind: sourceKind } : {},
      provenance_json: provenance,
    });
  }
}

function isBlockingEvent(eventType, severity) {
  const normalizedType = String(eventType || "").toLowerCase();
  const normalizedSeverity = String(severity || "").toLowerCase();
  if (normalizedSeverity === "error" || normalizedSeverity === "critical") return true;
  return /(fail|error|timeout|reject|blocked|stall)/.test(normalizedType);
}

function eventClaimLinks({ event, taskClaimLinks }) {
  const payload = event?.payload_json ? JSON.parse(event.payload_json) : {};
  const explicitClaims = toArray(payload.claim_ids).map((claimId) => ({
    claim_node_id: `claim:${claimId}`,
    relation: "AFFECTS",
  }));
  const explicitNodeClaims = toArray(payload.claim_node_ids).map((claimNodeId) => ({
    claim_node_id: claimNodeId,
    relation: "AFFECTS",
  }));
  const inheritedClaims = taskClaimLinks.get(event.task_id) || [];
  const normalizedInherited = inheritedClaims.map((claimLink) => ({
    claim_node_id: claimLink.claim_node_id,
    relation: "AFFECTS",
  }));
  const combined = [...explicitClaims, ...explicitNodeClaims, ...normalizedInherited];
  return combined.filter((claimLink, index) =>
    combined.findIndex((item) => item.claim_node_id === claimLink.claim_node_id && item.relation === claimLink.relation) === index,
  );
}

function buildLaneExecutionGraph({
  cwd,
  cycleId,
  researchStage,
  controlState,
  nodes,
  edges,
  cycleNodeId,
  claimLinksByLane,
  claimLinksByArtifactPath,
}) {
  const laneRecords = collectLaneRecords({
    cwd,
    cycleId,
    researchStage,
    controlState,
  });
  const taskClaimLinks = new Map();

  for (const task of laneRecords.tasks) {
    const taskNodeId = `task:${task.task_id}`;
    addNode(nodes, {
      node_id: taskNodeId,
      node_type: "Task",
      label: task.task_type,
      state_json: {
        role: task.role,
        status: task.status,
        control_state: task.control_state,
        research_stage: task.research_stage,
      },
      metadata_json: {
        lane_id: task.lane_id || null,
        decision_id: task.decision_id || null,
        parent_task_id: task.parent_task_id || null,
        expected_output_schema_ref: task.expected_output_schema_ref || null,
      },
      provenance_json: task.provenance_json ? JSON.parse(task.provenance_json) : {},
    });
    addEdge(edges, {
      source_node_id: cycleNodeId,
      target_node_id: taskNodeId,
      relation: "INCLUDES",
      status: "active",
      metadata_json: {},
      provenance_json: {},
    });

    const subagentNodeId = `subagent:${task.owner_subagent_id}`;
    addNode(nodes, {
      node_id: subagentNodeId,
      node_type: "SubAgent",
      label: task.owner_subagent_id,
      state_json: {
        role: task.role,
      },
      metadata_json: {},
      provenance_json: {},
    });
    addEdge(edges, {
      source_node_id: subagentNodeId,
      target_node_id: taskNodeId,
      relation: "OWNS",
      status: "active",
      metadata_json: {},
      provenance_json: {},
    });

    const matchingWorker = laneRecords.workers.find((worker) => worker.worker_id === task.worker_id);
    if (matchingWorker) {
      const workerNodeId = `worker:${matchingWorker.worker_id}`;
      addNode(nodes, {
        node_id: workerNodeId,
        node_type: "Worker",
        label: matchingWorker.worker_id,
        state_json: {
          status: matchingWorker.status,
          runtime_class: matchingWorker.runtime_class,
        },
        metadata_json: {
          environment: matchingWorker.environment || null,
          trust_level: matchingWorker.trust_level || null,
        },
        provenance_json: {},
      });
      addEdge(edges, {
        source_node_id: taskNodeId,
        target_node_id: workerNodeId,
        relation: "RUNS_ON",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }

    if (task.team_id) {
      const teamNodeId = `team:${task.team_id}`;
      const matchingTeam = laneRecords.teams.find((team) => team.team_id === task.team_id);
      addNode(nodes, {
        node_id: teamNodeId,
        node_type: "Team",
        label: task.team_id,
        state_json: {
          status: matchingTeam?.status || task.status,
        },
        metadata_json: {
          goal: matchingTeam?.goal || null,
          owned_subgraph_ref: matchingTeam?.owned_subgraph_ref || null,
        },
        provenance_json: {},
      });
      addEdge(edges, {
        source_node_id: teamNodeId,
        target_node_id: subagentNodeId,
        relation: "CONTAINS",
        status: "active",
        metadata_json: {},
        provenance_json: {},
      });
    }

    if (task.decision_id) {
      const decisionNodeId = task.decision_id;
      addNode(nodes, {
        node_id: decisionNodeId,
        node_type: "Decision",
        label: task.task_type,
        state_json: {
          research_stage: task.research_stage,
        },
        metadata_json: {
          role: task.role,
        },
        provenance_json: task.provenance_json ? JSON.parse(task.provenance_json) : {},
      });
      addEdge(edges, {
        source_node_id: decisionNodeId,
        target_node_id: taskNodeId,
        relation: "AFFECTS",
        status: "recorded",
        metadata_json: {},
        provenance_json: task.provenance_json ? JSON.parse(task.provenance_json) : {},
      });
    }
  }

  for (const artifact of laneRecords.artifacts) {
    const artifactNodeId = `artifact:${artifact.artifact_id}`;
    const linkedClaims = [
      ...(claimLinksByArtifactPath.get(artifact.path) || []),
      ...(claimLinksByLane.get(artifact.lane_id) || []),
    ].filter((claimLink, index, array) =>
      array.findIndex((item) => item.claim_node_id === claimLink.claim_node_id && item.relation === claimLink.relation) === index,
    );
    addNode(nodes, {
      node_id: artifactNodeId,
      node_type: "Artifact",
      label: path.basename(artifact.path),
      state_json: {
        artifact_type: artifact.artifact_type,
      },
      metadata_json: {
        path: artifact.path,
        lane_id: artifact.lane_id || null,
      },
      provenance_json: {},
    });
    addEdge(edges, {
      source_node_id: artifactNodeId,
      target_node_id: cycleNodeId,
      relation: "EMITTED_IN",
      status: "recorded",
      metadata_json: {},
      provenance_json: {},
    });
    if (artifact.task_id) {
      addEdge(edges, {
        source_node_id: `task:${artifact.task_id}`,
        target_node_id: artifactNodeId,
        relation: "PRODUCES",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }
    const evidenceId = evidenceNodeId("artifact", artifact.path);
    addNode(nodes, {
      node_id: evidenceId,
      node_type: "Evidence",
      label: artifact.path,
      state_json: {
        kind: "artifact",
      },
      metadata_json: {
        artifact_type: artifact.artifact_type,
      },
      provenance_json: {},
    });
    addEdge(edges, {
      source_node_id: artifactNodeId,
      target_node_id: evidenceId,
      relation: "MATERIALIZES",
      status: "recorded",
      metadata_json: {},
      provenance_json: {},
    });
    appendClaimImpactEdges({
      edges,
      sourceNodeId: artifactNodeId,
      claimLinks: linkedClaims,
      sourceKind: "artifact",
    });
    appendClaimImpactEdges({
      edges,
      sourceNodeId: evidenceId,
      claimLinks: linkedClaims,
      sourceKind: "artifact-evidence",
    });
    if (artifact.task_id && linkedClaims.length > 0) {
      taskClaimLinks.set(artifact.task_id, [
        ...(taskClaimLinks.get(artifact.task_id) || []),
        ...linkedClaims,
      ].filter((claimLink, index, array) =>
        array.findIndex((item) => item.claim_node_id === claimLink.claim_node_id && item.relation === claimLink.relation) === index,
      ));
    }
  }

  for (const event of laneRecords.events) {
    const eventNodeId = `event:${event.event_id}`;
    const payload = event.payload_json ? JSON.parse(event.payload_json) : {};
    addNode(nodes, {
      node_id: eventNodeId,
      node_type: "Event",
      label: event.event_type,
      state_json: {
        severity: event.severity,
      },
      metadata_json: payload,
      provenance_json: {},
    });
    if (event.task_id) {
      addEdge(edges, {
        source_node_id: eventNodeId,
        target_node_id: `task:${event.task_id}`,
        relation: "AFFECTS",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }
    if (event.worker_id) {
      addEdge(edges, {
        source_node_id: eventNodeId,
        target_node_id: `worker:${event.worker_id}`,
        relation: "AFFECTS",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }
    for (const claimLink of eventClaimLinks({ event, taskClaimLinks })) {
      addEdge(edges, {
        source_node_id: eventNodeId,
        target_node_id: claimLink.claim_node_id,
        relation: "AFFECTS",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }
    if (event.task_id && isBlockingEvent(event.event_type, event.severity)) {
      const blockerNodeId = `blocker:${slugify(`${event.task_id}:${event.event_id}`)}`;
      addNode(nodes, {
        node_id: blockerNodeId,
        node_type: "Blocker",
        label: payload.reason || payload.message || event.event_type,
        state_json: {
          severity: event.severity,
          event_type: event.event_type,
        },
        metadata_json: payload,
        provenance_json: {},
      });
      addEdge(edges, {
        source_node_id: `task:${event.task_id}`,
        target_node_id: blockerNodeId,
        relation: "BLOCKED_BY",
        status: "recorded",
        metadata_json: {},
        provenance_json: {},
      });
    }
  }
}

function buildGraphSnapshot({
  cwd = process.cwd(),
  cycleId,
  prompt,
  summary,
  supervisorHistory = [],
  researchStage = "evidence",
  controlState = "REVIEW",
}) {
  const researcherSummary = summary?.researcher_view?.summary || {};
  const ledgerSummary = summary?.hypothesis_ledger?.summary || {};
  const approvalReview = summary?.approval_review?.review || {};
  const gateReview = summary?.gate_review?.review || {};
  const reportReview = summary?.report_review?.review || {};
  const paperReview = summary?.paper_review?.review || {};
  const nodes = [];
  const edges = [];

  const cycleNodeId = `cycle:${cycleId}`;
  addNode(nodes, {
    node_id: cycleNodeId,
    node_type: "Cycle",
    label: cycleId,
    state_json: {
      cycle_status: researcherSummary.cycle_status || null,
      execution_completion: researcherSummary.execution_completion || null,
      research_outcome: summary?.research_outcome || researcherSummary.research_outcome || null,
      decision_mode: summary?.decision_mode || researcherSummary.decision_mode || null,
      claim_count: Number(researcherSummary.claim_count || 0),
      hypothesis_count: Number(ledgerSummary.hypothesis_count || 0),
      approval_readiness_score: researcherSummary.approval_readiness_score ?? null,
      evidence_readiness: researcherSummary.evidence_readiness || null,
      control_state: controlState,
      research_stage: researchStage,
    },
    metadata_json: {
      prompt,
      supervisor_passes: Number(summary?.supervisor_passes || 0),
    },
    provenance_json: {
      sources: [
        summary?.researcher_view?.outputPath || null,
        summary?.hypothesis_ledger?.outputPath || null,
        researcherSummary.final_claim_package_path || null,
      ].filter(Boolean),
    },
  });

  for (const hypothesis of toArray(ledgerSummary.focus_hypotheses)) {
    const hypothesisId = String(hypothesis.hypothesis_id || "").trim();
    if (!hypothesisId) continue;
    addNode(nodes, {
      node_id: `hypothesis:${hypothesisId}`,
      node_type: "Hypothesis",
      label: hypothesis.statement || hypothesisId,
      state_json: {
        latest_status: hypothesis.latest_status || null,
        hypothesis_score: hypothesis.hypothesis_score ?? null,
        promotion_readiness_score: hypothesis.promotion_readiness_score ?? null,
      },
      metadata_json: {
        family_root: hypothesis.family_root || null,
        unresolved_gaps: toArray(hypothesis.unresolved_gaps),
      },
      provenance_json: {
        sources: [summary?.hypothesis_ledger?.outputPath || null].filter(Boolean),
      },
    });
    addEdge(edges, {
      source_node_id: cycleNodeId,
      target_node_id: `hypothesis:${hypothesisId}`,
      relation: "INCLUDES",
      status: "active",
      metadata_json: {},
      provenance_json: {
        sources: [summary?.hypothesis_ledger?.outputPath || null].filter(Boolean),
      },
    });
  }

  for (const blocker of toArray(reviewBlockers(approvalReview, "approval_blockers")).concat(toArray(researcherSummary.approval_blockers))) {
    const blockerId = `blocker:${String(blocker).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    addNode(nodes, {
      node_id: blockerId,
      node_type: "Blocker",
      label: String(blocker),
      state_json: {},
      metadata_json: {},
      provenance_json: {
        sources: [summary?.approval_review?.reviewPath || null].filter(Boolean),
      },
    });
    addEdge(edges, {
      source_node_id: blockerId,
      target_node_id: cycleNodeId,
      relation: "AFFECTS",
      status: "open",
      metadata_json: {},
      provenance_json: {
        sources: [summary?.approval_review?.reviewPath || null].filter(Boolean),
      },
    });
  }

  const decisionNodes = [
    {
      node_id: `decision:${cycleId}:approval`,
      label: "approval",
      state_json: {
        mode: approvalReview.mode || null,
        decision_mode: approvalReview.decision_mode || null,
        score: reviewScore(approvalReview, "approval_readiness_score"),
        pass: reviewPass(approvalReview, "approval_gate_passed"),
      },
      metadata: {
        blockers: reviewBlockers(approvalReview, "approval_blockers"),
        decision_reason: approvalReview.decision_reason || null,
      },
      source: summary?.approval_review?.reviewPath || null,
    },
    {
      node_id: `decision:${cycleId}:gate`,
      label: "gate",
      state_json: {
        mode: gateReview.mode || null,
        decision_mode: gateReview.decision_mode || null,
        score: reviewScore(gateReview, "gate_score"),
        pass: reviewPass(gateReview, "gate_passed"),
      },
      metadata: {
        blockers: reviewBlockers(gateReview, "major_objections"),
        decision_reason: gateReview.decision_reason || null,
      },
      source: summary?.gate_review?.reviewPath || null,
    },
    {
      node_id: `decision:${cycleId}:report`,
      label: "report",
      state_json: {
        decision_mode: reportReview.decision_mode || null,
        score: reviewScore(reportReview, "report_score"),
        gate_passed: reviewPass(reportReview, "communication_gate_passed"),
      },
      metadata: {
        blockers: reviewBlockers(reportReview, "report_blockers"),
        decision_reason: reportReview.decision_reason || null,
      },
      source: summary?.report_review?.reviewPath || null,
    },
    {
      node_id: `decision:${cycleId}:paper`,
      label: "paper",
      state_json: {
        decision_mode: paperReview.decision_mode || null,
        score: reviewScore(paperReview, "paper_score"),
        gate_passed: reviewPass(paperReview, "submission_gate_passed"),
      },
      metadata: {
        blockers: reviewBlockers(paperReview, "paper_blockers"),
        decision_reason: paperReview.decision_reason || null,
      },
      source: summary?.paper_review?.reviewPath || null,
    },
  ];

  for (const decision of decisionNodes) {
    addNode(nodes, {
      node_id: decision.node_id,
      node_type: "Decision",
      label: decision.label,
      state_json: decision.state_json,
      metadata_json: decision.metadata || {},
      provenance_json: {
        sources: [decision.source].filter(Boolean),
      },
    });
    addEdge(edges, {
      source_node_id: decision.node_id,
      target_node_id: cycleNodeId,
      relation: "AFFECTS",
      status: "recorded",
      metadata_json: {},
      provenance_json: {
        sources: [decision.source].filter(Boolean),
      },
    });
  }

  const claimContext = buildClaimAndEvidenceGraph({
    summary,
    nodes,
    edges,
    cycleNodeId,
  });
  buildLaneExecutionGraph({
    cwd,
    cycleId,
    researchStage,
    controlState,
    nodes,
    edges,
    cycleNodeId,
    ...claimContext,
  });

  return {
    cycle_id: cycleId,
    generated_at: new Date().toISOString(),
    prompt,
    supervisor_history: supervisorHistory,
    nodes,
    edges,
    unresolved_questions: toArray(researcherSummary.open_questions || researcherSummary.unresolved_questions),
  };
}

function writeGraphSnapshot({ cwd = process.cwd(), cycleId, snapshot }) {
  const filePath = path.join(runtimeRoot(cwd), "state", `${cycleId}-graph-snapshot.json`);
  writeJson(filePath, snapshot);
  return filePath;
}

module.exports = {
  buildGraphSnapshot,
  writeGraphSnapshot,
};
