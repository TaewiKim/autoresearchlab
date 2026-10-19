# AutoResearchLab

**An autonomous research lab that finds a problem worth solving, then carries it all the way to a reviewed result.**

> **Status: early preview (v0.1).** The pipeline runs end to end, but interfaces, prompts and defaults still change between versions, and no result produced with it has been published yet. Expect rough edges, and please report them.

Give AutoResearchLab a research direction in plain Markdown. A team of AI agents surveys the field, picks the open problem whose answer would change what the field believes, states a falsifiable hypothesis, builds the experiment, preregisters the analysis, runs it, and submits the result to independent reviewers. The reviewers can reject it, and they often do. You watch the whole process in your terminal and step in only where you choose to.

---

## What is different

Many automated-science pipelines are handed a topic and have an LLM brainstorm ideas for it. AutoResearchLab starts one step earlier and asks **what is worth researching**. It treats novelty as something to be tested against the literature, not something the model asserts.

- **The problem comes from the field, not from the tools.** Candidates are written from a map of the field: what it believes, where it is stuck, and what its papers leave unmeasured. The machine's installed tools are hidden while the candidates are written, so nothing is proposed just because it is easy to run here.
- **Novelty is attacked, not self-rated.** A scout tries to find the paper that already did each of the panel's top ideas. An idea that is found is struck from the slate, with the citation.
- **Independent experts rank the slate.** Four or five reviewer agents, drawn from the field's own subfields, score every candidate in separate lanes. Their scores stay sealed until all of them have submitted.
- **You choose, and the end is a review.** You pick from the survivors. A cycle is finished when independent gatekeepers pass it, not when an experiment has run.

| | A common pattern | AutoResearchLab |
|---|---|---|
| Where the question comes from | A topic is given; an LLM brainstorms ideas | The field is mapped first; candidates come from its beliefs, bottlenecks and blind spots |
| What the idea generator sees | Often the tools that are available | The field only ("instrument-blind") |
| How novelty is judged | The model rates its own idea, or embedding similarity | A literature search tries to refute it; ideas that are found are struck |
| Who ranks the ideas | One model | 4–5 independent reviewers from the field map, scores sealed until all submit |
| What "feasible" means | The code runs | Named open-source assets, and one published number to reproduce here before the new experiment |
| Who picks the problem | The system | You, from the survivors |
| When a result counts | The experiment finished | Independent gatekeepers pass novelty, technical quality and reproducibility |

## Novelty is built in, not hoped for

A result is interesting when it denies or sharply qualifies an assumption its audience holds (Davis, *That's Interesting!*, 1971). Confirming what is already known is dull, and denying what nobody believes is irrelevant. AutoResearchLab turns that idea into stages a cycle must pass before it commits to a hypothesis.

1. **Field landscape first.** Before any lead exists, scout agents map every subfield the request implies, with its canonical works and its 2024–2026 frontier.
   - Sources: scholarly APIs, forward-citation graphs of the canonical works, and full-text deep reads of the state of the art.
2. **SOTA cards.** The strongest recent papers are read in depth and condensed into cards: what was claimed, what was measured, and which code, checkpoints and benchmarks they released.
3. **Field beliefs.** The LabDirector writes down what the field takes for granted, with citations. It also records how mature each subfield is, the bottlenecks everybody names, and the latent signals: what papers work around, assume away or leave unmeasured.
4. **A candidate slate, blind to the instruments.** Eight to ten candidate problems, spread over at least three subfields and at least three of four origin strategies:
   - **belief denial:** deny a belief the field holds;
   - **method leap:** in an immature subfield, a mechanism the field has not tried;
   - **bottleneck transfer:** a concept from another discipline, or from a natural system, against a bottleneck everybody names;
   - **latent bottleneck:** a demand nobody has named yet, read off what the papers leave out.
5. **An expert panel.** Four or five independent reviewer agents rank the slate, one for each subfield of the field map (topped up with a methodologist when the map names fewer).
6. **Novelty refutation.** A scout tries to prove that each of the panel's top candidates has already been published. Ideas that fall are struck, and the next-ranked candidate takes their place.
7. **Feasibility, pass or fail.** A candidate must name the open-source assets it builds on. It must also have a *reproduction anchor*: one number from a SOTA paper, reproduced on this machine first.
8. **Your choice.** The cycle pauses and shows you the survivors. You pick one with `researchlab select`, or you set a timeout and let it proceed on its own.

The panel's score is Davis's criterion written as arithmetic:

```text
value               = impact × outcome uncertainty × soundness
outcome uncertainty = 1 − |2p − 1|        p = the reviewer's probability that the hypothesis holds
```

A reviewer who can call the outcome (p near 0 or 1) is saying the result would not be news. A reviewer whose own research would not change is saying it is not interesting. Either way the value drops. Candidates the panel can predict are flagged `PREDICTABLE`. Strong disagreement is flagged `CONTESTED` and reported, never averaged away.

Novelty is checked again at the end. Independent gatekeepers score novelty, technical quality, reproducibility, clarity and impact. Novelty, technical quality and reproducibility must each clear the bar (one may sit up to ten points below it only when the other two clear it), so a flawless experiment on an incremental idea does not pass.

## What you choose from

At the owner checkpoint, `researchlab candidates` shows each survivor like this. This is an illustrative card: the format is the program's, but the values are invented.

```text
## 1. `cand_3` -- With equal tuning budgets, gradient-boosted trees match transformer tabular models on medium-sized datasets

- Origin strategy: `belief_denial` -- denies "deep tabular models now outperform tree ensembles" (held by 3 SOTA cards)
- Prediction that differs: the reported margin falls below 0.5 accuracy points once every model family gets the same number of tuning trials
- Informative either way: if confirmed -- the published gains are partly a tuning-budget effect; if refuted -- the gain survives a fair protocol
- Panel: value 0.41 (rank 1); mean P(holds) 0.55, outcome uncertainty 0.88, impact 0.71, soundness 0.66; probability spread 0.30
  - *subfield_deep_tabular_models*: P(holds) 0.40, impact 0.80, soundness 0.70. The budget gap is real, but recent models tune cheaply. Closest prior work: ...
  - *methodology*: P(holds) 0.65, impact 0.60, soundness 0.75. Needs a preregistered trial count per family. Closest prior work: ...
- Novelty audit: partially_anticipated. Closest: Why do tree-based models still outperform deep learning on tabular data? (2022)
- Open-source assets: code https://github.com/...; dataset https://huggingface.co/datasets/...
- Reproduction anchor (first, on this host): <paper> -- accuracy = <reported value> (<setup>)
- Cost: ...
```

Candidates struck on the way are listed below the survivors, each with its reason: the paper that anticipated it, or the feasibility check it failed.

## End-to-end research automation

One command starts a cycle, and the cycle runs until the gate passes or the evidence shows why it cannot.

```text
research request (Markdown)
  → field landscape → frontier harvest → SOTA deep read → field beliefs
  → candidate slate → expert panel → novelty refutation → feasibility → your choice
  → lead hypothesis: claim, estimands, falsification conditions, rival mechanisms
  → reproduction anchor
  → experiment: engineers build and prove the runtime
  → preregistered analysis contract → sealed execution by runners
  → interpretation → independent gate review
       ├─ refine the lead and test again
       ├─ pivot to a better candidate
       └─ conclude → conclusion review → paper and figures
```

The experiment step covers whatever the design needs, for example a MuJoCo simulation, a public benchmark dataset, or an open-source model installed inside the sandbox.

Each step is done by an agent with one role and one task:

| Role | What it does |
|---|---|
| **LabDirector** | Chooses and refines the lead, decides whether to refine, pivot or conclude, and answers your messages |
| **Scout** | Searches the literature and datasets, maps the field, and tries to refute novelty |
| **Chronicle** | Maintains the corpus, the knowledge graph and the decision digest the director works from |
| **Analyst** | Designs the experiment: the question, the estimand, the comparator, and what would falsify the claim |
| **Engineer** | Makes the design runnable: installs and proves the tools, simulators and assets it needs |
| **Runner** | Writes and executes the analysis code inside that runtime |
| **Gatekeeper** | Reviews the work independently against per-rubric bars, with scores, objections and missing validations |
| **Author / Illustrator** | Writes the paper and draws its figures |

## Rigor you can audit

- **Preregistered analysis contracts.** A contract fixes the estimands, comparators, margins and validity gates, and hashes them into a contract id. A runner refuses code that is not bound to the current contract.
- **Sealed data and sealed executions.** Datasets are pinned by SHA-256 and handoffs are sealed. A measurement that already exists is not run again.
- **Honest outcomes.** Results carry simultaneous intervals. Falsification is a first-class outcome. A design that fails its own validity gates is recorded as inconclusive, never relabeled as support.
- **Everything on disk.** Under `.research-lab/` you will find:
  - every lane's task, prompt, output and result;
  - every review;
  - the decision ledger;
  - the datasets and figures.

  A cycle can be stopped at any moment and resumed from there.

## It keeps itself running

Long cycles break in boring ways, so the harness watches itself.

- **A supervisor tracks stalls and waste:** milestones that stop advancing, lanes repeating the same measurement, work set aside for one reason again and again, results labeled wrongly, and logs growing too fast.
- **An optional maintainer fixes the harness.** It is a Codex agent that diagnoses harness defects during a cycle and commits fixes to your clone (a native install; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)). It sees its own history of fixes for the same kind of defect, and it does not change the research.
- **Cycles resume on their own.** `scripts/run-cycle.sh` waits out a Codex quota stop and resumes, and restarts the cycle when the maintainer changes the harness under it. A stopped cycle resumes from where it was when started again, and a cycle can never create more follow-up lanes than the budget you set.

## Watch it work

The research process prints to the terminal as it happens:

```text
09:43:02 [done ] lab-director followup-lab-director-02
                 decision replace: select the budget-matched comparison as the lead
                   why: the landscape shows no benchmark that matches tuning budgets across model families...
09:43:02 [lead ] lead changed (budget_matched_comparison)
11:20:15 [done ] lab-runner followup-runner-03
                 1/1 blueprints passed · contract verified
                   gbdt_minus_transformer_accuracy = 0.018 [0.004, 0.031]
11:52:40 [gate ] gate review
                 score 64 · novelty=72 technical_quality=61 reproducibility=58 clarity=70 impact=55 · 3 blocker(s)
```

Everything else is a command too:
- `researchlab status` shows the cycle stage by stage.
- `researchlab tell` sends the LabDirector a message.
- `researchlab candidates` and `researchlab select` answer the owner checkpoint.
- `researchlab keys` manages your API keys.

## Getting started

Installation is described step by step in **[docs/INSTALL.md](docs/INSTALL.md)**. There are two paths:
- **Docker**, on Windows, macOS or Linux;
- **native**, on Ubuntu 24.04 or WSL2.

Then **[docs/CLI.md](docs/CLI.md)** walks from `codex login` to a finished cycle.

You need an OpenAI account for the Codex CLI, which runs every agent. API keys for the scholarly services are your own and optional. A source that needs a key is turned on when you enter it (see [docs/APIS.md](docs/APIS.md)).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Installation (Docker and native) and troubleshooting |
| [docs/CLI.md](docs/CLI.md) | Running a cycle from the command line, step by step |
| [docs/APIS.md](docs/APIS.md) | Every external service it calls, and which ones need a key |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables |
| [docs/architecture.md](docs/architecture.md) | How the harness is built: runtimes, roles, lanes, gates, state on disk |
| [SECURITY.md](SECURITY.md) | Keys, sandboxing and what agents may do |

## How it is built

A Node.js CLI orchestrates the cycle. A Rust harness schedules and supervises the agent lanes, which run through the [Codex CLI](https://github.com/openai/codex) inside its sandbox. Python drivers do the literature search, data discovery and statistical validation.

This repository contains the code needed to reproduce cycles. It ships no literature, datasets or results.

## License

[MIT](LICENSE)
