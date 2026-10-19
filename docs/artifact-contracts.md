# Artifact Contracts

ResearchLab uses a small set of recurring lane artifacts.

## Lane Inputs

```text
.research-lab/lanes/<cycle-id>/<lane-id>/
  lane-contract.json   # runtime ownership, execution mode, allowed outputs
  role-plan.json       # role-specific plan produced by LabDirector
  queries.json         # optional query bundle for scout/analyst lanes
  task.md              # human-readable lane task
```

For data-graph-validation cycles, the lane input contract may also include:

```text
.research-lab/lanes/<cycle-id>/<lane-id>/
  frontier_catalog.json   # Stage B frontier extraction input or carry-forward state
  data_graph.json         # Stage C graph snapshot consumed by hypothesis/validation steps
  validation_plan.json    # Stage E structured validation plan for the lane
```

## Lane Execution State

```text
.research-lab/lanes/<cycle-id>/<lane-id>/
  execution-context.json  # resolved task + role-plan passed into the runtime
  run-state.json          # current lane state
  process.json            # background pid metadata when applicable
  final-status.json       # terminal status
  events.jsonl            # lane-local event log
```

## Lane Outputs

```text
.research-lab/lanes/<cycle-id>/<lane-id>/
  result.json          # normalized lane result payload
  artifacts.json       # list of durable artifact paths
  stdout.log
  stderr.log
```

When the cycle is running in data-graph-validation mode, the normalized outputs expand to:

```text
.research-lab/lanes/<cycle-id>/<lane-id>/
  frontier_catalog.json   # Stage B candidate families, mechanisms, rival structures
  data_graph.json         # Stage C lane-local graph snapshot with provenance
  validation_plan.json    # Stage E executable validation objects derived from hypotheses
  evidence_packet.json    # Stage G structured validation result for graph updates
  graph_update_log.json   # Stage H node/edge/family updates emitted from evidence packets
```

External-driver lanes may also write into:

```text
.research-lab/artifacts/<family>/<cycle-id>/<lane-id>/
```

## Cycle Outputs

```text
.research-lab/plans/              # manifests, schedules, run summaries
.research-lab/state/              # aggregate state, strategy decisions, approval review
.research-lab/reports/            # versioned report JSON/Markdown
.research-lab/papers/             # versioned paper drafts
.research-lab/researcher-views/   # HTML/JSON researcher-facing summaries
.research-lab/viz/                # projections used for visual inspection
```

The cycle-level aggregation for the data-graph-validation pipeline should preserve:

```text
.research-lab/plans/<cycle-id>-lab-director-literature.json   # retrieval + frontier synthesis
.research-lab/state/<cycle-id>-hypothesis-ledger.json         # family-rooted hypothesis package state
.research-lab/state/<cycle-id>-data-graph.json                # current aggregate graph state
.research-lab/state/<cycle-id>-graph-update-log.json          # ordered graph mutations across lanes
.research-lab/state/<cycle-id>-evidence-packets.json          # validation evidence packets used for updates
```

## Stage Mapping

The intended pipeline-stage ownership is:

1. Stage A Retrieval
   `result.json`, `queries.json`, `retrieval_trace` fields
2. Stage B Frontier Extraction
   `frontier_catalog.json`
3. Stage C Data Graph Construction
   `data_graph.json`
4. Stage D Family-rooted Hypothesis Generation
   `result.json` hypothesis payloads and cycle hypothesis ledger
5. Stage E Validation Planning
   `validation_plan.json`
6. Stage F Validation Execution
   lane `result.json` analysis outputs
7. Stage G Evidence Packet Emission
   `evidence_packet.json`
8. Stage H Graph Update
   `graph_update_log.json` and aggregate cycle `data_graph.json`

The contract is:

- `lane-contract.json` defines runtime ownership
- `role-plan.json` defines LabDirector intent
- `execution-context.json` is what the runtime actually consumed
- `result.json` is the lane's normalized output for Chronicle
- `frontier_catalog.json` is the normalized family/mechanism/rival frontier artifact
- `data_graph.json` is the graph snapshot that downstream ranking and review should consume
- `validation_plan.json` defines structured validation work, not only prose checks
- `evidence_packet.json` is the structured validation result used for graph mutation
- `graph_update_log.json` is the append-only trace of node/edge/family updates
