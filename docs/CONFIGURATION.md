# Configuration

AutoResearchLab is configured with environment variables. The recommended set is
in [`researchlab.env.example`](../researchlab.env.example); copy it to
`researchlab.env` (git-ignored) and `scripts/run-cycle.sh` reads it.

## Python

| Variable | Meaning | Default |
|---|---|---|
| `RESEARCHLAB_PYTHON` | Python interpreter for the analysis and literature drivers | `.venv/bin/python3` in the repository, then `python3` |

`researchlab bootstrap` creates `.venv` and installs `requirements.txt` into it.
The Docker image sets `RESEARCHLAB_PYTHON` already.

## Agent runtime

| Variable | Meaning | Recommended |
|---|---|---|
| `RESEARCHLAB_HOME` | Where your keys file lives | `~/.researchlab` |
| `RESEARCHLAB_AGENT_RUNTIME` | `codex` or `claude` | `codex` |
| `RESEARCHLAB_CODEX_SANDBOX` | Codex sandbox for every lane | `workspace-write` |
| `RESEARCHLAB_CODEX_APPROVAL_POLICY` | Codex approval policy | `on-request` |
| `RESEARCHLAB_CODEX_CMD` | Path to the `codex` binary, if it is not on `PATH` | — |
| `RESEARCHLAB_CLAUDE_CMD` | Path to the `claude` binary, for `--agent-runtime claude` | — |

**If none of `RESEARCHLAB_CODEX_SANDBOX`, `RESEARCHLAB_CODEX_APPROVAL_POLICY`
and `RESEARCHLAB_CODEX_NETWORK_DOMAINS` is set, Codex is started with its
sandbox disabled.** Keep them set (as `researchlab.env.example` does), above
all outside a container.

## Network

| Variable | Meaning |
|---|---|
| `RESEARCHLAB_LITERATURE_NETWORK_POLICY` | `approved-scholarly-metadata-v1`: GET-only requests to the scholarly APIs marked *policy* in [APIS.md](APIS.md); unset for open mode |
| `RESEARCHLAB_CODEX_NETWORK_DOMAINS` | Comma-separated hosts every Codex lane may reach (a subset of the scholarly hosts); engineer lanes also get the asset hosts |
| `RESEARCHLAB_OPEN_SOURCE_ASSETS` | `1`: engineer lanes may also reach package registries, code hosts and model stores |
| `RESEARCHLAB_KEY_GATES` | `0`: do not switch key-needing sources off when their key is missing (on by default) |

## Keys

Keys are entered with `researchlab setup` or `researchlab keys set <name>` and
kept in `~/.researchlab/.env` (`$RESEARCHLAB_HOME/.env`), outside the
repository; every `researchlab` command loads that file, and a variable already
set in the shell wins. The variables they set:

| `keys` name | Variable | Service | Used under the approved policy |
|---|---|---|---|
| `openalex` | `RESEARCHLAB_OPENALEX_API_KEY` (or `OPENALEX_API_KEY`) | OpenAlex | yes |
| `semantic-scholar` | `RESEARCHLAB_S2_API_KEY` | Semantic Scholar | yes |
| `contact-email` | `RESEARCHLAB_CONTACT_MAILTO` | OpenAlex/Crossref polite pool | no (open mode only) |
| `github` | `RESEARCHLAB_GITHUB_TOKEN` | GitHub repository metadata | no (open mode only) |
| `scopus` | `SCOPUS_API_KEY` (or `ELSEVIER_API_KEY`) | Elsevier Scopus | no (open mode only) |

Not handled by `keys`; set them in your shell, or add them to
`~/.researchlab/.env` by hand:

| Variable | Service |
|---|---|
| `RESEARCHLAB_LUNA_API_KEY` (or `OPENAI_API_KEY`) | Optional OpenAI Responses API helper in the analysis driver |
| `ANTHROPIC_API_KEY` | Claude runtime, instead of a `claude` login |

## Simulators and local assets

| Variable | Meaning |
|---|---|
| `RESEARCHLAB_MUJOCO_PYTHON` | Interpreter with `mujoco` installed, for MuJoCo experiments |
| `RESEARCHLAB_ISAACSIM_PYTHON` | Interpreter with Isaac Sim installed |
| `RESEARCHLAB_INSTRUMENT_PROBE_BACKEND` | Restrict instrument probing to one backend |
| `RESEARCHLAB_LOCAL_ASSET_ROOTS` | `os.pathsep`-separated directories of local reference repositories |
| `RESEARCHLAB_LOCAL_REFERENCE_ROOTS` | Semicolon-separated local reference roots for problem selection |
| `RESEARCHLAB_DATA_ROOT` | An absolute path for instrument-probe datasets (default `.research-lab/datasets`; the harness keeps its own datasets there regardless) |
| `RESEARCHLAB_HOST_VRAM_GB` | GPU memory the feasibility check assumes this machine has (default `8`) |

## Cycle behaviour

| Variable | Meaning | Default |
|---|---|---|
| `RESEARCHLAB_FOLLOWUP_BUDGET` | Follow-up lanes one cycle may create in total | `4096` |
| `RESEARCHLAB_OWNER_SELECTION_TIMEOUT_MINUTES` | Minutes the owner checkpoint waits for `researchlab select` before proceeding on its own | waits for you |
| `RESEARCHLAB_EXPERT_PANEL_SIZE` | Reviewers on the expert panel, at most 5 (one per field-map subfield, topped up to 4 with cross-cutting reviewers) | `5` |
| `RESEARCHLAB_EXPERT_SELECTION` | `0`: skip the expert candidate selection (beliefs, slate, panel, novelty refutation, feasibility, owner checkpoint) | on |
| `RESEARCHLAB_FIELD_LANDSCAPE_GATE` | `0`: let a lead be chosen without a valid field landscape | on |
| `RESEARCHLAB_FOLLOW` | `0`: `run-research` prints only its final summary | on |
| `RESEARCHLAB_MAINTAINER` | `1`: a Codex maintainer diagnoses harness defects during a cycle and commits fixes to your clone. Use it on a native install with a git identity set (`git config user.name`, `user.email`) and `pytest` in the interpreter below; in the Docker image the clone lives in the container, so its commits would not outlive it | off |
| `RESEARCHLAB_MAINTAINER_PUSH` | `1`: the maintainer also pushes its commits | off |
| `RESEARCHLAB_MAINTAINER_PYTHON` | Interpreter for the maintainer's pytest gate; it needs `pytest` (`.venv/bin/pip install pytest`) | `python` |
| `RESEARCHLAB_NATIVE_BIN` | Use a prebuilt harness binary instead of `native/researchlab-harness/target/release` | — |
| `NODE_OPTIONS` | `--max-old-space-size=4096` for long cycles | — |
