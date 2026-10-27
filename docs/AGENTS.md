# Agents and roles

AutoResearchLab is a team of AI agents with separate jobs. This page lists
who is on the team, what each one decides, what it hands on, and what it is
not allowed to decide.

## How an agent runs

A cycle is a set of **lanes**. A lane is one role doing one task. It has its
own directory, `.research-lab/lanes/<cycle>/<lane-id>/`, holding its task,
prompt, output and result. Most lanes are Codex CLI sessions inside the Codex
sandbox. A few are Python drivers that the harness runs directly (literature
search, data acquisition, statistical validation).

No agent starts another agent. The **harness** (the Rust scheduler) reads the
state on disk, decides which lane is needed next, and dispatches it. Agents
hand work to each other through the files they write and the message bus
described below.

## The research team

| Role | Instances | Decides | Hands on | May not |
|---|---|---|---|---|
| **LabDirector** | one lane per decision | Which problem is the lead; refine, pivot or conclude; how to answer your messages; which findings are worth keeping (its clue register) | The lead hypothesis (claim, estimands, falsification conditions, rival mechanisms), its scope, the next lanes, the clues | Override a gatekeeper's scores |
| **Scout** | many | Which papers and datasets are relevant, after reading their abstracts | The admitted corpus, the field landscape, SOTA deep reads, fetched data | Admit a paper it has not read |
| **Chronicle** | recurring | How the evidence links together | Briefs, the knowledge graph, the decision digest the director works from | Choose the lead |
| **Analyst** | per design | What to measure: the question, estimand, comparator and validity gates, and what would falsify the claim | An executable handoff, the preregistered analysis contract, the capabilities it needs | Install or run the tools itself |
| **Engineer** | per capability | How to make the design runnable: which route, build and version, and what to try when one fails | A runtime, installed tools, a recorded smoke run | Change the science: it proposes a design change with its evidence, and never makes one silently |
| **Lab-runner** | per execution | How to write the code the contract asks for | Measurements with intervals, bound to the contract id | Run code that is not bound to the current contract |
| **Gatekeeper** | three per gate review | Whether the work clears each rubric bar | Scores, objections, missing validations | Move the bar (fixed at 80) |
| **Author** | two | The wording of the paper (one drafts methods and data, the other results and discussion) | Paper drafts | Claim more than the evidence supports |
| **Illustrator** | one | The figures | Figure specs and reviewed charts | — |

The **analyst / engineer / lab-runner** split is deliberate. A wrong estimand
is a thinking error, and a missing shared library is not. A lane holding both
spends its reasoning on whichever is louder. So the analyst decides *what*, the
engineer makes it *runnable*, and the runner *executes*. When the engineer
cannot get a tool to work, it returns a blocker instead of quietly swapping in
another tool, because swapping the tool changes the experiment, and that is the
analyst's call.

The three gatekeepers of a gate review split the rubric:

- one reviews **novelty and impact**, against the literature and the knowledge graph;
- one reviews **technical quality and reproducibility**;
- one reviews **clarity and reporting completeness**.

Each scores independently. The gate is conjunctive over the hard rubrics:
novelty, technical quality and reproducibility.

## Who works at each stage

Choosing the problem (before any lead exists):

| Stage | Role | What happens |
|---|---|---|
| Field landscape, frontier harvest | Scout | Map every subfield the request implies, its canonical works and its 2024–2026 frontier |
| SOTA deep read | Scout | Read the strongest recent papers in full and condense them into SOTA cards |
| Field beliefs | LabDirector | What the field takes for granted, how mature each subfield is, named bottlenecks, latent signals |
| Candidate slate | LabDirector | 8–10 candidate problems from four origin strategies, written without seeing this machine's tools |
| Expert panel | Gatekeeper role, one lane per reviewer | 4–5 reviewers drawn from the field map score every candidate; scores are sealed until all have submitted |
| Novelty refutation | Scout | Searches for the paper that already did each top candidate; a candidate it finds is struck |
| Feasibility | LabDirector | Names the open-source assets and a reproduction anchor; pass or fail |
| Owner checkpoint | **You** | Choose one survivor with `researchlab select` |

Running the research:

| Stage | Role |
|---|---|
| Lead hypothesis | LabDirector |
| Reproduction anchor: one published number, reproduced here first | Analyst designs it, Engineer builds the runtime, Lab-runner measures it |
| Experiment design and analysis contract | Analyst |
| Experiment runtime | Engineer |
| Sealed execution | Lab-runner |
| Evidence digest | Chronicle |
| Gate review | Gatekeepers (three) |
| Refine, pivot or conclude | LabDirector |
| Conclusion review, paper and figures | Gatekeepers, Author, Illustrator |

## Separation of powers

- **The director owns the research decisions.** The harness constrains it and
  informs it, for example by refusing a lead that skips the slate or by
  holding a measurement that already exists. It does not make scientific
  choices in code.
- **Reviewers are independent.** Panel scores and gate reviews are written in
  separate lanes and sealed until every reviewer has submitted. A fresh
  review's scores are never floored or overridden.
- **Novelty is tested adversarially.** The novelty scout's job is to *refute*
  the idea, not to support it.
- **The record is append-only.** Decisions, reviews and the hypothesis
  progress ledger are appended, never rewritten.

## How agents talk to each other

There is one message bus, with two kinds of message:

| Kind | Meaning |
|---|---|
| **Request** | Stays open until it is answered, escalates while it waits, and the answer carries a reason. Example: an author asks for a run, and the director owes adopt-or-decline with a reason. |
| **Standing** | Informs; nobody owes an answer. One per channel, refreshed in place. |

Your own messages (`researchlab tell`) go to the LabDirector's inbox, and it
answers them in its next decision lane.

## Agents that look after the harness, not the research

| Agent | What it does |
|---|---|
| **Supervisor** | Watches every cycle for stalls and waste: milestones that stop advancing, the same measurement repeated, work set aside again and again, mislabeled results, runaway logs. It raises notices and interrupts the director when decisions lag. |
| **Watchdog** (`researchlab watch-cycle`) | Restarts a stalled or dead cycle process. |
| **Maintainer** (optional, `RESEARCHLAB_MAINTAINER=1`) | A Codex agent that diagnoses harness defects during a cycle and commits fixes to your clone. It sees its own past fixes of the same kind, and it never changes the research. |

## Watching them

`researchlab follow` prints every lane as it starts and ends, with the role
and what it found. Each lane's full record is in
`.research-lab/lanes/<cycle>/<lane-id>/`. See [CLI.md](CLI.md).

## The clue register

The LabDirector's notebook is a summary of where the cycle stands now, and it is
rewritten at each decision. What a lead taught the cycle should outlive the
lead, so the director also keeps a **register of clues**: a measured result and
what it rules in or out, the prior art that closes a direction, the part of a
design that earned a high score, a path that is dead and why, a fact about the
data, a question still open, an idea not yet tried. The director decides what
is a clue and how important it is, records them with their evidence in each
decision, and updates or retires them (retiring needs a reason). Every later
director lane is handed the register, live and most important clues first.

```bash
researchlab clues --cycle-id my-cycle
```

shows it, and `researchlab status` counts it. The register is the file
`state/<cycle>-research-clues.json`, rebuilt from the director's own decisions.
