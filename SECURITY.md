# Security

## Keys and logins

- Enter keys with `researchlab setup` or `researchlab keys set <name>`: they
  are kept in `~/.researchlab/.env` (mode 0600), outside the repository, and
  are never accepted as a command-line argument (which would leave them in your
  shell history). This repository contains none.
- `codex login` stores its credentials in `~/.codex/auth.json` (in Docker: the
  `rl-codex` volume). `researchlab import-codex-auth` copies the token into
  `.research-lab/runtime/auth.json`, which is git-ignored. Treat both as
  passwords.
- Cycle state under `.research-lab/` can contain retrieved papers, datasets and
  agent transcripts. It is git-ignored; share it deliberately, not by accident.
- `docker build` leaves cycle state, `researchlab.env`, keys files, the Codex
  login and `requests/` out of the image (`.dockerignore`), so a native install
  in the same clone never ends up inside it.

## What agents can do

Agent lanes run the Codex CLI, which executes commands on your machine.

- Run cycles in the Docker image when you can: a lane then reaches only the
  container and its volumes.
- On a host install keep `RESEARCHLAB_CODEX_SANDBOX=workspace-write` and
  `RESEARCHLAB_CODEX_APPROVAL_POLICY=on-request` (as in
  `researchlab.env.example`). **Without them the harness starts Codex with its
  sandbox disabled.**
- Lane network access is limited to the hosts in `RESEARCHLAB_CODEX_NETWORK_DOMAINS`
  and, for engineer lanes with `RESEARCHLAB_OPEN_SOURCE_ASSETS=1`, the
  open-source package and model hosts listed in [docs/APIS.md](docs/APIS.md).
- The optional maintainer (`RESEARCHLAB_MAINTAINER=1`) edits and commits to
  your clone of this repository. It pushes only with
  `RESEARCHLAB_MAINTAINER_PUSH=1`.

## Reporting a vulnerability

Please open a private security advisory on GitHub
(Security → Report a vulnerability) rather than a public issue.
