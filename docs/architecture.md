# researchlab architecture

Current as of 2026-09-11. Supersedes `refactor-architecture-design-2026-05-19.md`
and the architecture sections of `researchlab-architecture-paper-draft-2026-06-05.md`,
both of which describe a layout that no longer exists, and
`communication-architecture-shift-2026-04-04.md`, which describes a message
model replaced by the bus below.

researchlab runs autonomous research cycles. A cycle takes a research objective in
natural language and drives it through literature search, hypothesis selection,
experiment design, execution, review and writing — with independent reviewers that
can and do reject the work. It is not a pipeline: roles argue, a gate refuses to
pass claims their evidence does not support, and the cycle loops until it converges
or exhausts its budget.

## The three runtimes

The system is one codebase in three languages, split by what each is good at.

| | | |
|---|---|---|
| **JavaScript** (`src/`, ~53k lines) | agent prompts, contracts, reporting, gate scoring | everything that decides *what to ask and how to judge the answer* |
| **Rust** (`native/researchlab-harness/`, 118 files) | lane lifecycle, dispatch, supervision, recovery | everything that must not lose state or leak processes |
| **Python** (`drivers/`, 2 packages) | literature/data search, statistical validation | everything that touches the scientific tooling |

They meet at two seams:

- **JS → Rust**: `src/runtime/native_runtime.js` execs the `researchlab-harness`
  binary. Every lane, every dispatch decision and every supervision pass runs
  through it.
- **Rust → Python**: the harness spawns `drivers/literature/search.py` and
  `drivers/analysis/python_stats.py` as subprocesses, one per lane, and reads
  their JSON results.

Nothing crosses those seams except process boundaries and files on disk. That is
deliberate: a cycle can be killed at any moment and resumed from `.research-lab/`.

## Roles

A cycle is a set of **lanes**. Each lane is one role doing one task, with its own
directory under `.research-lab/lanes/<cycle>/<lane-id>/` holding its contract,
role plan, task markdown, run state and result.

| role | does | produces |
|---|---|---|
| **scout** | literature and dataset search | papers, fetched data bundles |
| **chronicle** | corpus review, knowledge graph, decision digest | the digest the director decides from |
| **lab-director** | selects and refines the lead hypothesis | the lead, its family, its claim scope |
| **analyst** | designs the experiment | an executable handoff + validation blueprints |
| **engineer** | builds and proves the capability the design needs | a runtime, installed tools, a recorded smoke run |
| **lab-runner** | writes and runs the code inside that runtime | measurements |
| **gatekeeper** | independent review against per-rubric bars | scores, objections, missing validations |
| **author** / **illustrator** | writing and figures | the paper |

The gate is conjunctive across hard rubrics (novelty, technical quality,
reproducibility), which is why a cycle can produce a clean experiment and still
fail: an incremental idea that validates perfectly does not pass.

**analyst / engineer / lab-runner is one job split three ways**, and the split is
recent. The analyst used to design the identification strategy AND clone the
repository, read its dependencies, generate its config, smoke-test it and repair
whatever had failed for the runner. Those are different jobs with different
failure modes — a wrong estimand is a thinking error and a missing shared library
is not — and a lane holding both spends its reasoning on whichever is louder.
So: the analyst decides WHAT (question, estimand, comparator, which workflow, what
would falsify it) and declares `capability_requirements`; the engineer makes it
RUNNABLE and proves it with a recorded run, returning a blocker rather than
substituting a tool it could install — swapping the tool changes the experiment,
and that decision is the analyst's; the lab-runner writes and executes the code.

## How roles talk to each other

One bus, and the distinction it rests on: **a role speaking to a role** is a
message; **the harness configuring a lane** is not, and nobody answers a
directive.

```
src/reporting/message_bus/
  contract.js   two kinds, and defineChannel refuses a request with no escalation
  channels.js   the channels that exist, registered rather than hardcoded
  index.js      capacity, identity, delivery receipts, projections
```

Two kinds, kept apart on purpose:

| | |
|---|---|
| **REQUEST** | open until answered, escalates while it waits, and the answer carries a REASON in both directions |
| **STANDING** | informs; nobody owes an answer, exactly one per channel, content refreshes in place |

The contract is not new — it was lifted out of `experiment_requests.js`, which
had it right for one channel (the author asks for a run, the director owes an
adopt-or-decline with a reason, an unanswered request escalates into a dispatched
lane, and a channel answered the same way enough times is *exhausted* rather than
retried). Everything else communicated some other way.

**What it replaced.** Six mechanisms, counted on cycle-g-v89:

| mechanism | size |
|---|---|
| the old mailbox | 4 **hardcoded** channels; its ledger held only one of them |
| state files read cross-role | 8 |
| `planner_metadata.*` | 134 keys, 96 MB across the cycle |
| task directives | prose appended to a lane's task |
| output contracts | the JSON a role must return |
| `runtime/<cycle>-labdirector-inbox.jsonl` | an append-only feed with a read cursor |

The thing NAMED "messages" was the weakest of the six, and it failed silently for
eight days: one channel's status line embedded a lane count, so every refresh
minted a new message; no message carried a timestamp, so the capacity sort fell
through to the sequence number; and the cap was global, so the highest-sequence
author evicted everyone. The director's mailbox file stopped being written on
09-03 while the cycle ran to 09-11, and because nothing ever set
`acknowledged_at` — a field with a reader and no writer — the message frozen in
it was delivered as current the whole time.

So the bus caps **per channel**, identifies a message by `channel#subject` rather
than by its wording, and **records delivery**: an undelivered message is now
visible as one.

**Producers raise; only the bus projects.** A monitor or an orchestrator outside
this process calls `raiseOnBus`, and the bus writes the per-role mailbox and —
for consumers that predate it — the file they already read. The long-run watchdog
used to write a role's mailbox directly, which the bus rebuilds every pass; the
supervisor's decision-latency interrupt used to append to the inbox, which a Rust
consumer reads to spawn a lab-director lane. Both raise now, and the projection
that feeds the legacy consumer is written once per message, because that file is
append-only behind a cursor and a replay would spawn a lane every pass.

**A channel raised by name is a channel that exists.** `raiseOnBus` lets a
producer outside this process open a conversation the registry did not
anticipate, which the long-run watchdog needs — it composes its channel id at
runtime. But two channels were raised by fixed name from JS and were in no
registry: the supervisor's decision-latency interrupt and the researcher's own
instruction from the live view. Both are REQUESTS, and `defineChannel`'s one hard
rule — a request must say what happens while it goes unanswered — reached neither,
because the generic reader of the raised log has no registry entry to consult. The
two requests a PERSON or the supervisor raises were the two that could sit open
forever. They are registered now, and build from the raised log like any other
channel builds from its source.

**The inbox stayed a feed.** Its 1,464 lines were 1,268 chronicle reports, 189
lane-failure notices and 7 supervisor instructions. Only the last are requests.
Pushing the other 1,457 through a decision bus would repeat exactly the
status-as-request conflation the bus exists to remove.

## Which layer a rule has to live in

**The Rust follow-up builder is the authority for a dispatched lane.** It
composes the role plan itself and never calls into JS. Measured on cycle-g-v89:
of 1,397 role plans, 1,392 came from it and **not one carried a key authored by
`src/agents/**`**.

That makes a rule written only in a JS plan builder inert — and it is the most
expensive shape of bug in this repository, because the rule LOOKS present in the
obvious place. The data-scout protocol contained the sentence "do NOT default to
one field's repositories" and reached 0 of 65 scout lanes, while the Rust path
handed every one of them a contract naming that field's repositories. Seven
analyst design rules — sources of truth, canonical concept resolution, provenance
footers, the master-table gate, the quality standard, freshness checks — reached
0 of 225 analyst lanes.

`src/policy/dispatch_authority.js` is the registry that keeps the two sides
honest: each governed rule names its JS expression AND the Rust symbol that
delivers it AND how it arrives (`bus`, `directive`, `role_plan_key`,
`output_contract`). `tests/dispatch_authority.test.js` fails when either side is
missing, when a rule-bearing plan key is neither governed nor excused in writing,
or when an excuse names a key nothing emits.

The JS plan builders still build base lanes and are what the tests exercise. They
are not the dispatch path, and an edit to one does not reach a running cycle by
itself.

## JS layers

`src/` is a strict DAG — verified, not assumed. Each layer may only require from
layers below it.

```
cli                 entry points, argument routing
  orchestrator      the research cycle: passes, policies, termination
    reporting       gate scoring, reviews, researcher view, documents
      agents        role prompts, query plans, per-role contracts
        models  observability  storage  graph  bootstrap
          execution  policy  provenance  runtime  shared   (depend on nothing)
```

Two rules keep it honest:

1. **A layer never requires upward.** If something in `agents/` needs `reporting/`,
   it is not agent code — it is reporting code that landed in the wrong place.
2. **The cycle driver is orchestration, not an agent.** `run_research.js` decides
   passes, budgets and termination; it lives in `orchestrator/`.

Both rules exist because they were broken. Until 2026-08-06 the 882-line cycle
driver sat in `agents/lab_director/`, the researcher-view builder (10 files) sat
in `agents/visualizer/` behind a `reporting/` shim, and lab bootstrap sat in
`cli/`. That produced three cycles — `agents ↔ orchestrator`, `agents ↔ cli`,
`agents ↔ reporting` — and made `agents` depend on ten layers. It now depends on
four, and lost a third of its size without a line being deleted.

## Rust harness

The harness owns anything whose failure would corrupt the cycle: lane creation,
process supervision, stale-lane recovery, follow-up dispatch and the stage gates.

```
labdirector/          the big one: dispatch, supervision, gates, plans, policy
  followups/          which lanes to create next, and their role plans
  gates/              dependency and stage gates
  plan/               the run loop and task graph
  recovery/           supervisor recovery, requery evidence
  supervision/        cycle and inbox supervision
  research_context/   role-plan refresh, dataset context
  context/            director context: digest, memory, budget, contracts
chronicle/            lane index, briefs, aggregation, projections, reports
runtime/              lane execution (codex agent lanes, external drivers)
core/                 paths, models, shared support
```

Until 2026-08-06 most of this was not modules at all. `labdirector/mod.rs` ended
with 23 `include!("path/file.rs")` lines and `chronicle/mod.rs` with 6 — textual
splicing into one flat scope. The spliced files carried no `use` statements and
every item was private-to-the-parent, so there was no boundary anywhere to push
back on growth; that is how `dispatch.rs` reached 1,170 lines and `run_loop.rs`
1,389. They are real modules now.

## Python drivers

Both drivers are packages behind a thin entry point. The entry point exists
because the harness loads them by file path and reaches for internals, so the
module surface has to stay flat even though the code behind it is not.

### `drivers/analysis/python_stats_lib/` — validation

```
constants  io_utils  handoff_selection  pip_install  column_mapping
blueprint_model  execution_model  external_agent  blueprint_run
evidence  validation_status  entrypoint
```

The interesting ones:

- **`column_mapping`** recovers the column mapping a blueprint self-blocks on.
  LLM-authored render blueprints habitually open with a preflight demanding an
  external `column_mapping` and then generate those very columns themselves; for a
  `procedural://` dataset nobody supplies it, so the script dies before rendering.
  This module reads the analyst's own declaration first, and only falls back to
  inference — including decompressing blueprints shipped as a base64 payload,
  which had blinded every source-reading heuristic at once.
- **`evidence`** carries the numbers a blueprint measured up into the validation
  summary. Without it the summary that reaches the gate is workflow bookkeeping
  ("checks 13/13") and reviewers score a claim against nothing.
- **`validation_status`** is fail-closed: a lane whose blueprints all died reports
  `failed`, not `completed`.

### `drivers/literature/search_lib/` — search and handoff authoring

```
constants  http_client  queries  providers  normalize  ranking
objective  collect  synthesis  dataset_inspect  data_graph
director_context  external_repo  handoff_checks  dataset_checks
handoff_builder  entrypoint
templates/          the source of the blueprints this driver generates
  data/             the two that are pure text, as actual programs
```

`templates/` is 46% of the driver by line count. It is not orchestration — it is
the code the driver *emits*, which used to live as string literals inside the
functions returning it (one was 1,335 lines). Keeping it separate is what makes
the rest of the driver readable, and the two templates that are plain literals
are now real `.py` files that can be linted and diffed.

## State on disk

Everything a cycle knows lives under `.research-lab/`:

```
lanes/<cycle>/<lane>/     contract, role-plan.json, task.md, run-state.json, result.json
state/<cycle>-*.json      hypothesis, research notes, decision digest, ledger,
                          termination code, watchdog halt/policy
messages/<cycle>/         the bus: bus-ledger.json, <role>.jsonl per-role
                          projections, raised.jsonl in, delivery-receipts.jsonl
artifacts/stats/<cycle>/  blueprint scripts, stdout/stderr, figures, tables
datasets/<cycle>/         fetched data bundles
events/                   append-only supervisor and lane event logs
runtime/<cycle>-labdirector-inbox.jsonl
                          an append-only event feed with a read cursor; the bus
                          writes the request lines in it, nobody else writes it
```

Two of these are load-bearing beyond storage:

- **the hypothesis progress ledger** is append-only. It is what stops the director
  abandoning an improving lead — a decision the gate cannot make for itself,
  because each gate round only sees the current round.
- **the watchdog halt file** stops the relaunch wrapper. It is written when a cycle
  shows a known death signature (budget wall without convergence, activity without
  progress) and may only be removed together with an actual fix.

## Cycle control

A cycle runs under a launcher wrapper (`.research-lab/launch-vNN.sh`) rather than
directly, because the supervisor is heap-bounded and expected to exit:

```
wrapper loop:  run supervisor (finite --max-supervisor-passes)
               -> exited?  halt file present -> stop
                           termination code says stop -> stop
                           otherwise -> relaunch and resume the same cycle
watchdog:      every 5 minutes, check for death signatures; on a match write the
               halt file and kill the cycle
```

Deriving a new launcher by substituting digits in an old one is how four cycles
(v65–v68) once ran with no LLVM backend at all: an unanchored `s/67/68/g` also
rewrote `x86_64-linux-gnu`. Write launchers explicitly and grep the arch path,
heap size, cycle id and kill-script name before launching.

## Where the design pressure is

Four tensions shape most of the code, and knowing them explains decisions that
otherwise look arbitrary.

**Nothing infers what an agent can declare, and nothing classifies a field.**
Keyword lists that guessed a lead's method family, a paper's domain or a venue's
impact are gone. They fail silently for any field nobody enumerated — a Mitsuba
rendering lead was once labelled `tumor_immune_resistance` because the marker
`tan` matched inside "s-tan-dard control variates".

The last and largest of them were three copies of a DOMAIN CLASSIFIER, in each
language, matching an objective's words to pick bio / cs / generic. The "generic"
profile was byte-identical to the observational one, so a robotics, compiler or
economics cycle was handed a statistician's identity and difference-in-differences
design shifts. Stripping the vocabulary off the two real profiles left ONE list of
obligations: they were the same fourteen requirements written in two vocabularies.

What replaced them is not a better list. The only axis that was ever real is not a
field — **can this cycle SET its independent variable** — and the capability probe
already measures it. `src/agents/shared/derived_profile.js` resolves a lane's
profile in three tiers: what the cycle MEASURED, then the methodology that follows
from its mode, then a field-independent default whose identity says the probe has
not run. That last state is one a lane can act on by asking for the probe; a wrong
field label is one nothing can tell is wrong.

The same move settled the smaller branches. Discovery is mandatory when the DATA
is large-scale, not when the objective sounds biomedical. A cycle generates its own
inputs when a verified instrument says it constructs them, not when the objective
says "rendering". And a prohibition that names a field is still a field in the
instruction: "do NOT default to GEO/omics/cohort terms unless the objective is
actually biomedical" fixes one domain as the reference every other is defined
against, and says nothing at all for the field nobody enumerated.

**Claims must be scoped to the evidence the cycle can produce.** The director
states what evidence would establish its claim and narrows the claim until that
evidence is producible; the analyst reports which claim elements its blueprint
actually covers. A claim whose evidence cannot be produced scores as unsupported
however good the experiment beneath it.

**Evidence production is the scarce resource.** Reviews re-score evidence that
already exists; only runners create it. Dispatch priority, the supersession grace
that lets a running renderer finish, and the compute budget that a blueprint may
request all exist to stop the one role that manufactures evidence from being
starved by the roles that consume it.

**Context is a budget, and a cap only counts where it is applied.** One cycle sent
136.5 MB of prompts across 1,100 lanes; the median lab-director prompt is 193 KB
(n=207) and the median author prompt 128 KB (n=194). The discipline is to send a
DIGEST and keep the PATH, so a role can read the original when it needs a specific
detail —
`compact_runner_context_for_prompt` and `compact_deliberation_for_prompt` exist for
exactly that, and each leaves the path in place.

Four ways a cap can be there and not bite, all four found here, all four looking
from the source like the cap is working:

- **It runs before the value is written.** `validation_results` was on an 8 KB
  compaction list and arrived at 44.5 KB, because the function holding the list
  ran before the function that writes the key. 36.2 KB of it was an
  `analyst_handoff` inlined beside the path to it.
- **It runs for one role.** The cap table sat inside
  `attach_lab_director_context_controls`, behind `if role != "lab-director" {
  return }`. Six of the eight roles were never capped: the gatekeeper exceeded
  the table's own limit for `review_action` on 373 of its 374 plans.
- **It caps one of two placements.** The table capped `planner_metadata`, while
  `document_review_context` sat at the top level on 1,099 plans and
  `cycle_memory_context` only ever sat there. Worse, trimming one copy makes the
  two differ, which stops the dedupe below from collapsing them and renders both.
- **It throws the value away instead of shortening it.** Over its limit,
  `compact_json_context` left `{truncated, approx_bytes, reason}`, and the reason
  said to use "cycle state artifacts" without naming one.

`runtime/prompt_budget.rs` is the one budget now, applied at the boundary every
plan crosses exactly once — the prompt — for every role, to both placements
together. Over budget, a block keeps the fields that fit (cheapest first, so a
verdict is never lost to a comment blob that sorted before it), shortens its
oversized fields into what is left rather than dropping them, names what it left
out, and carries the `role-plan.json` path that still holds all of it. The plan
on disk is never rewritten, so that path always resolves.

It also removes the duplication a depth-1 comparison cannot see. A block written
at the top level AND under `planner_metadata` is caught by
`drop_duplicated_planner_metadata`, which compares VALUES rather than a
maintained list. A block nested one level INSIDE another block and identical to a
block beside it is not: `review_action` re-carries `analysis_request`,
`validation_results`, `previous_review_summary`, `reference_literature_summary`
and two policy blocks; `gate_reviewer_context` re-carries
`chronicle_research_context` and `previous_review_context` on 746 plans each.
That copy becomes a pointer to the one already in the prompt, which costs no
information at all.

Replayed over cycle-g-v89's 1,397 role plans: **121.7 MB → 82.2 MB, a third of
it gone**, 21.2 MB of that from the lossless elision. The gain lands where the
cap had never run — analyst −50%, illustrator −45%, gatekeeper −36%, author −36%,
against the lab-director's −11%.

## Conventions

- **No source file over 1000 lines.** The exception is `search_lib/templates/data/`,
  which holds generated programs, not driver source.
- **No `include!` splicing or `exec` concatenation.** Both were used to satisfy the
  line limit while producing boundaries that meant nothing, and both hid real
  defects: a function defined twice with one copy silently dead, and three import
  cycles that only appeared once the code was made into modules.
- **Layer direction is checked, not assumed.** The JS layer graph and the Python
  packages are DAGs, verified by cycle detection.
- **Tests name the failure they guard.** A regression test whose name does not say
  what broke is a test nobody will understand when it fails.
- **A rule lives where the traffic is.** Before writing a governance rule into a
  JS plan builder, check whether a dispatched lane would receive it — read a real
  `role-plan.json` under `.research-lab/lanes/`, not the source. Register it in
  `dispatch_authority.js` so the two sides cannot drift apart silently.
- **Before building a channel, find the one that already exists.** The
  author-to-director relationship lived in `experiment_requests.js` with better
  semantics than any mailbox had, and was invisible to anything looking at
  "messages". A copy of an existing channel is not a channel.
- **Run `cargo test`, and run it from the real layout.** The harness test target
  is excluded from a normal `cargo check`, so the 332 Rust tests can stop
  compiling while the build stays green — they did, for two days, and two
  deliberate behaviour changes landed with their tests unupdated. Several modules
  resolve the project root as `CARGO_MANIFEST_DIR/../..`, so a harness copied
  somewhere on its own reports failures that are artifacts of the copy.
