# External services

Every network service AutoResearchLab can call, what it is used for, and whether it
needs a key. Every key is your own: get it from the service and enter it with

```bash
researchlab setup
```

or one at a time with `researchlab keys set <name>` (typing is hidden). Keys
are kept in `~/.researchlab/.env` (mode 0600; in Docker the `rl-keys` volume),
never in the repository or in cycle state; a variable set in your shell takes
precedence. `researchlab keys list` shows which are set, masked.

**A source that needs a key is off until you set its key, and on from the next
command after.** Off means not called at all, by the literature driver or by
an agent: its host is also taken out of the agents' network allowlist.
`researchlab keys list` shows each one as `ON` or `OFF`.

**Two network modes.** The recommended settings (`researchlab.env.example`,
and the Docker image) set
`RESEARCHLAB_LITERATURE_NETWORK_POLICY=approved-scholarly-metadata-v1`: the
literature driver then calls only the scholarly metadata APIs marked
*policy* below, with GET requests and an allow-listed set of query parameters,
and the agents' sandbox reaches only those hosts. Under it, PubMed, Scopus and
the dataset registries are not called, no e-mail address is sent, and the only
credentials sent are the OpenAlex and Semantic Scholar keys, each to its own
host. Unset the variable to use everything listed here (*open* mode).

Without any key, a cycle under the policy searches Crossref and arXiv, with
OpenCitations for the citation graph (in open mode, PubMed too).
**Get at least the free OpenAlex key** (OpenAlex expects one on every request
since 2026-02-13): it adds the citation counts and venue metrics the
established-impact literature track needs. Add a Semantic Scholar key for its
search, title matching and citation graph.

## The agent model

| Service | Used for | Credential |
|---|---|---|
| **OpenAI Codex CLI** (`codex exec`) | Runs every agent lane: LabDirector, scouts, analysts, engineers, gatekeepers, runners, chronicle | `codex login` (ChatGPT account) or an OpenAI API key, stored by Codex in `~/.codex/auth.json` |
| OpenAI Responses API `api.openai.com/v1/responses` | Optional research-LLM helper in the analysis driver | `RESEARCHLAB_LUNA_API_KEY`, else `OPENAI_API_KEY` (optional) |
| Claude Code CLI (`claude -p`) | Alternative lane runtime, `--agent-runtime claude` | `claude` login or `ANTHROPIC_API_KEY` (optional) |

Models used by default: `gpt-5.6-sol` and `gpt-5.6-terra` through the Codex CLI
(Codex 0.144.1 or newer is required for them).

## Literature search (scout lanes)

| Service | Host | Mode | Used for | Key (`researchlab keys set …`) |
|---|---|---|---|---|
| OpenAlex | `api.openalex.org` | policy | Paper search, DOI and title lookup, citation metrics | `openalex` — **off without it**; free at <https://openalex.org/settings/api> |
| Crossref | `api.crossref.org` | policy | Search and DOI metadata | none; in open mode `contact-email` (your address) joins the polite pool |
| Semantic Scholar | `api.semanticscholar.org` | policy | Search, title match, citation graph | `semantic-scholar` — **off without it**; request at <https://www.semanticscholar.org/product/api> |
| OpenCitations | `api.opencitations.net` | policy | Citation graph (backward and forward) | none |
| arXiv | `export.arxiv.org`, `arxiv.org`, `ar5iv.labs.arxiv.org` | policy | Preprint search and full-text reading | none |
| GitHub | `api.github.com` | policy | Code repositories linked to papers | none under the policy (anonymous, 60 requests an hour); in open mode `github`, a fine-grained token with no permissions, raises the limit: <https://github.com/settings/personal-access-tokens> |
| Hugging Face | `huggingface.co/api` | policy | Model and dataset metadata | none |
| PubMed E-utilities | `eutils.ncbi.nlm.nih.gov` | open only | Biomedical search | none |
| Elsevier Scopus | `api.elsevier.com` | open only | Search | `scopus` — off without it; <https://dev.elsevier.com/apikey/manage> |

`researchlab keys list` marks the keys the policy never sends (`contact-email`,
`github`, `scopus`) as unused while the policy is on, and `researchlab setup`
skips them.

## Dataset discovery and download (data lanes, open mode only)

No key is needed for any of these. Under the approved scholarly policy the
external dataset scout does not run; a data lane is then planned from the
literature and from data the experiment generates itself (a simulation, a
public benchmark the engineer installs as an open-source asset).

- Registries searched: DataCite, Zenodo, Figshare, OpenAIRE, OSF, Dryad,
  Harvard Dataverse, re3data, Hugging Face datasets, NCBI GEO, EBI BioStudies,
  ENA, PapersWithCode, PANGAEA, Mendeley Data.
- Web search fallback: DuckDuckGo's HTML results, through a headless Chromium
  (Python Playwright; optional, see [INSTALL.md](INSTALL.md)).
- Downloads: Zenodo, Figshare, Mendeley Data, EnviDat, OSF, NCBI GEO (FTP),
  and DOI content negotiation via `doi.org`.

## Open-source assets (engineer lanes)

With `RESEARCHLAB_OPEN_SOURCE_ASSETS=1`, engineer lanes that build simulations
may install packages and download models from: PyPI, PyTorch and NVIDIA
package indexes, conda, npm, crates.io, Maven/Gradle, GitHub and GitLab,
Hugging Face, NVIDIA NGC, and a few project pages (Diffusion Policy, robomimic).
Every other lane stays on the literature hosts.

## Network sandbox

Codex runs each lane in its sandbox (bubblewrap on Linux). With
`RESEARCHLAB_CODEX_SANDBOX=workspace-write` a lane may write only inside the
workspace, and its network is limited to `RESEARCHLAB_CODEX_NETWORK_DOMAINS`
(scout lanes) or the open-source asset hosts (engineer lanes).
