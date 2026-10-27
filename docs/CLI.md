# Using AutoResearchLab from the command line

Everything is done with the `researchlab` command (or `node src/cli/index.js`
from the repository root). In Docker, prefix each command with `rl` as set up
in [INSTALL.md](INSTALL.md#a3-define-how-to-run-it).

The steps below are in the order you run them the first time.

## 1. Log Codex in

```bash
codex login --device-auth
```

Open the printed URL, sign in with your OpenAI account and enter the code.
Every agent lane runs through this login. Check it:

```bash
codex login status
```

## 2. Check the installation

```bash
researchlab bootstrap
```

```bash
researchlab doctor
```

```bash
researchlab setup
```

`setup` asks for each API key (typing is hidden; Enter skips one) and keeps
them in `~/.researchlab/.env`, outside the repository. A source that needs a
key (OpenAlex, Semantic Scholar, Scopus) is off until its key is set, and on
from the next command. To see which are on, or set one later:

```bash
researchlab keys list
```

```bash
researchlab keys set semantic-scholar
```

`bootstrap` is safe to run again at any time: it rebuilds the harness if the
source changed, imports the current Codex login into `.research-lab/runtime/`,
and re-checks the Python packages. `doctor` only reports. Both print JSON;
`"ready_for_run_plan": true` means a cycle can start.

## 3. Write a research request

A request is a Markdown file that says what to investigate, what to deliver,
and the constraints. Start from the example:

```bash
mkdir -p requests && cp examples/request.md requests/my-request.md
```

Edit `requests/my-request.md`. The LabDirector reads it as the owner's
direction: the field question, what each role should deliver, and any limits
(simulation only, which instruments exist on this machine, budget).

## 4. Start the cycle

```bash
scripts/run-cycle.sh my-cycle requests/my-request.md
```

This reads `researchlab.env`, starts cycle `my-cycle`, prints the research
process as it happens, and appends everything it prints to
`.research-lab/run-logs/my-cycle.log`. A cycle runs for hours to days.

The script also passes `--max-passes 8 --sleep-seconds 0 --agent-runtime codex
--no-break-on-stagnation --auto-resume-on-quota`, restarts the cycle when the
maintainer changes the harness under it, and keeps the log. The bare command
(load the settings first: outside Docker the agents get no network without
them):

```bash
. ./researchlab.env
```

```bash
researchlab run-research --cycle-id my-cycle --prompt-file requests/my-request.md --max-supervisor-passes 0 --max-concurrency 1
```

What the terminal shows (one line per event, details indented):

```text
09:12:04 [cycle] my-cycle: running
                 lanes 3 · completed 0 · running 1 · pending 2 · failed 0
09:12:06 [start] scout followup-scout-01
                 field_landscape: build the field landscape from recent literature
09:41:30 [done ] scout followup-scout-01
                 Admitted 42 papers across 5 subfields; 3 open problems attributed
09:43:02 [done ] lab-director followup-lab-director-02
                 decision replace: Select the budget-matched comparison as the lead
                   why: The landscape shows no benchmark that matches tuning budgets across model families...
                   lead: On a public tabular benchmark, with equal tuning budgets, ... at most 0.01 ...
                   next (engineer): Build the sealed benchmark panel ...
09:43:02 [lead ] lead changed (budget_matched_comparison)
                 On a public tabular benchmark, with equal tuning budgets, ...
11:20:15 [done ] lab-runner followup-runner-03
                 1/1 blueprints passed · contract verified
                   gbdt_minus_transformer_accuracy = 0.018 [0.004, 0.031]
11:52:40 [gate ] gate review
                 score 64 · novelty=72 technical_quality=61 reproducibility=58 clarity=70 impact=55 · 3 blocker(s)
12:03:11 [note ] contract_already_measured
                 no lab-runner is created for another primary execution of this contract ...
```

Tags: `start`/`done`/`fail`/`abort` are agent lanes (with what they found:
a runner's estimates and intervals, a director's decision and why, a
gatekeeper's verdict and rubric scores); `lead` is the hypothesis under test;
`gate` is the independent review score; `note` is a harness notice; `maint` is
a maintainer fix (when enabled); `wait` means the cycle is waiting for you;
`cycle` is the cycle starting or ending.

`--quiet` (or `RESEARCHLAB_FOLLOW=0`) prints only the final JSON summary.

### The owner checkpoint: choose the problem

Before a lead hypothesis is set, the cycle builds a slate of candidate
problems, has an expert panel rank them, tries to refute each one's novelty
and checks feasibility. Then it **pauses for you**, and the terminal says so:

```text
12:40:07 [wait ] the cycle is waiting for you to choose the problem it pursues
                 researchlab candidates --cycle-id my-cycle
                 researchlab select --cycle-id my-cycle --candidate <candidate-id> --note "why"
```

See the survivors, each with its hypothesis, the field belief it targets, the
panel's scores, the novelty search and the feasibility check:

```bash
researchlab candidates --cycle-id my-cycle
```

Choose one (the id is in the list; the note is passed to the LabDirector):

```bash
researchlab select --cycle-id my-cycle --candidate <candidate-id> --note "closest to the question I care about"
```

The cycle resumes on its own. You can choose again later, for example after
the first lead is falsified; `--candidate release` lifts the slate requirement
instead. To let a cycle proceed without you, set
`RESEARCHLAB_OWNER_SELECTION_TIMEOUT_MINUTES` before starting it.

## 5. Watch from another terminal

```bash
researchlab follow --cycle-id my-cycle --history 20
```

`follow` only reads: start or stop it at any time, during or after a cycle.
`--history N` first replays the last N finished lanes; `--once` prints the
current state and exits.

```bash
researchlab status --cycle-id my-cycle
```

One line per stage (runs, literature, corpus, survey, knowledge graphs, lead,
experiments, gate, capability, delivery), marked `ok`, `ATTENTION` or `not yet`. Exits 1 when a
stage needs attention; `--json` for the full detail.

## 6. Talk to the LabDirector

```bash
researchlab tell --cycle-id my-cycle --message "Report each model's tuning budget next to its score before claiming a model-family effect."
```

The message goes into the director's inbox; it answers in its next decision
(visible in `follow` as a `lab-director` lane). For a long message:

```bash
researchlab tell --cycle-id my-cycle --message-file requests/to-director.md
```

A relative `--message-file` or `--prompt-file` path is read from the
repository root (`researchlab` runs there from any directory); in Docker, keep
such files in `requests/`, the one directory the container sees.

To make the director abandon the current lead and choose again:

```bash
researchlab force-pivot --cycle-id my-cycle --reason "The lead's baseline is under-tuned."
```

## 7. Stop and resume

Press `Ctrl-C` to stop. Running the same start command again with the same
cycle id resumes the cycle where it stopped:

```bash
scripts/run-cycle.sh my-cycle requests/my-request.md
```

If the Codex plan hits its usage limit, `scripts/run-cycle.sh` waits for the
reset and resumes on its own (`--auto-resume-on-quota`); a bare `run-research`
stops with a quota message unless given that flag.

In Docker, a background cycle (INSTALL.md, `docker run -d --name rl-cycle`)
is resumed with `docker start -a rl-cycle`; running the same `docker run -d`
again fails because the name is taken (`docker rm rl-cycle` first).

## 8. Where the results are

All under `.research-lab/` (in Docker: the `rl-state` volume).

| What | Where |
|---|---|
| The director's running research notes | `state/my-cycle-lab-director-research-notes.md` |
| Current lead hypothesis | `state/my-cycle-lab-director-hypothesis.json` |
| Gate review (scores, blockers) and its history | `state/my-cycle-gate-review.json`, `state/my-cycle-gate-review-history.jsonl` |
| Every agent lane: task, prompt, output, result | `lanes/my-cycle/<lane-id>/` (`task.md`, `result.json`, `final-status.json`) |
| Runner tables and figures | `artifacts/stats/my-cycle/<runner-lane>/blueprints/*/` |
| Simulated datasets | `datasets/my-cycle/` |
| Reports and paper drafts | `reports/`, `papers/` |
| Harness notices | `events/my-cycle-harness-notices.jsonl` |
| Everything the terminal showed | `run-logs/my-cycle.log` (from `scripts/run-cycle.sh`) |

In Docker, copy them out with:

```bash
docker run --rm -v rl-state:/state -v "$PWD:/out" ubuntu:24.04 cp -r /state /out/research-lab-state
```

## Other commands

| Command | Purpose |
|---|---|
| `researchlab help` | Every command and option |
| `researchlab refresh-gate --cycle-id <id>` | Rebuild the gate review from the current evidence |
| `researchlab refresh-cycle --cycle-id <id>` | Rebuild all derived reviews and notes |
| `researchlab resume-cycle --cycle-id <id> --continuous` | Resume the scheduler loop without the supervisor |
| `researchlab watch-cycle --cycle-id <id> --daemon` | A watchdog that restarts a stalled cycle (needs `bash`, `jq`) |
| `researchlab import-codex-auth` | Re-import the Codex login after `codex login` |
| `researchlab keys list` / `keys set <name>` / `keys unset <name>` | Your API keys (masked when listed; never taken as an argument) |
| `researchlab candidates --cycle-id <id>` / `select --cycle-id <id> --candidate <id>` | The owner checkpoint: see the candidate problems, choose one |
| `researchlab clues --cycle-id <id> [--all] [--json]` | The research clues the LabDirector keeps: measured results, prior art, what earned a high score, dead ends, open questions (`--all` adds resolved and retired ones) |
| `researchlab native-build` | Rebuild the native harness |
