# Agent Protocol Adapter

ResearchLab uses a filesystem-backed orchestration model rather than an HTTP
agent server. The Agent Protocol adapter keeps that runtime model intact while
projecting each cycle into Agent Protocol concepts.

Source reference:

- User-owned `agent-protocol` repository is the intended reference.
- The current runtime GitHub token cannot view or clone that repository by name,
  so ResearchLab applies the protocol principles directly and avoids pinning the
  adapter to the previously used public `langchain-ai` reference.

## Mapping

- Agent Protocol `Agent` -> ResearchLab role (`lab-director`, `chronicle`,
  `scout`, `analyst`, `lab-runner`, `gatekeeper`, `author`, `illustrator`,
  `supervisor`)
- Agent Protocol `Thread` -> ResearchLab cycle
- Agent Protocol `Run` -> ResearchLab lane
- Agent Protocol `Message` -> ResearchLab inter-agent ledger message
- Agent Protocol `Store` -> ResearchLab memory, message, and state namespaces
- Agent Protocol delivery discipline -> append-only ledger plus targeted mailbox
  projection; refreshes must not erase watchdog or supervisor messages.

The adapter writes:

```text
.research-lab/protocol/<cycle-id>/agent-protocol-snapshot.json
.research-lab/protocol/<cycle-id>/agent-protocol-snapshot.md
```

## Status Mapping

- `completed` -> `success`
- `failed` / `failed_blocking` -> `error`
- `aborted` / `failed_non_blocking` -> `interrupted`
- `pending` / `running` -> `pending`

Thread status is derived from lane counts:

- any pending or running lane -> `busy`
- blocking failure and no active lane -> `error`
- otherwise -> `idle`

## Why This Shape

ResearchLab already has durable contracts, lane state, inter-agent mailboxes,
and memory indexes. Replacing those with a network API would add operational
surface without improving cycle behavior. The adapter instead makes the
existing runtime protocol-readable and fixes the critical runtime property:
messages are durable append-only records, mailboxes are projections, and
LabDirector receives pending targeted messages in its role-plan context.
