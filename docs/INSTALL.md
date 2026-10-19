# Installing AutoResearchLab

Two supported ways, both tested on a clean Ubuntu 24.04:

- **A. Docker** — Windows, macOS or Linux. Everything is in the image; the
  agents can reach only the container. Recommended.
- **B. Native** — Ubuntu 24.04, or Windows through WSL2 (Ubuntu 24.04).

Native Windows (PowerShell) is not supported: parts of the harness assume a
POSIX shell, `bash` and `.venv/bin`.

What you need either way: an OpenAI account to log Codex in with (ChatGPT
Plus/Pro/Team, or an API key), about 10 GB of disk, and 8 GB of RAM or more.
A GPU is not needed.

---

## A. Docker

### A1. Install Docker

- Windows / macOS: install [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  and start it. On Windows, use the WSL2 backend (the default).
- Linux: install Docker Engine (`https://docs.docker.com/engine/install/ubuntu/`)
  and add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then
  log out and back in).

Check:

```bash
docker run --rm hello-world
```

### A2. Get the code and build the image

```bash
git clone https://github.com/TaewiKim/autoresearchlab.git
```

```bash
cd autoresearchlab
```

```bash
docker build -t autoresearchlab -f docker/Dockerfile .
```

The build copies the clone into the image, minus what `.dockerignore` keeps
out: cycle state, `researchlab.env`, keys, `.venv`, build output and
`requests/`. Nothing of a native install in the same clone (its Codex login
included) ends up in the image.

The build takes 10–20 minutes the first time (system packages, Node.js 22,
Rust, the Codex CLI, Python packages, and compiling the harness). For robotics
cycles that simulate with MuJoCo, build with the simulator stack instead:

```bash
docker build -t autoresearchlab --build-arg WITH_SIM=1 -f docker/Dockerfile .
```

### A3. Define how to run it

Every command below runs in a fresh container that keeps its state in three
named volumes: `rl-state` (cycles, datasets, results), `rl-codex` (the Codex
login) and `rl-keys` (your API keys). The two `--security-opt` flags let Codex create its bubblewrap sandbox
inside the container.

First create the requests directory yourself (otherwise Docker creates it,
owned by root, and you cannot write into it):

```bash
mkdir -p requests
```

On Linux, macOS or WSL, put this in your shell:

```bash
rl() { docker run --rm -it --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v rl-state:/opt/researchlab/.research-lab -v rl-codex:/home/researcher/.codex -v rl-keys:/home/researcher/.researchlab -v "$PWD/requests:/opt/researchlab/requests" autoresearchlab "$@"; }
```

On Windows PowerShell:

```powershell
function rl { docker run --rm -it --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v rl-state:/opt/researchlab/.research-lab -v rl-codex:/home/researcher/.codex -v rl-keys:/home/researcher/.researchlab -v "${PWD}/requests:/opt/researchlab/requests" autoresearchlab @args }
```

`requests/` (in the directory you run `rl` from) is where you put research
request files; it appears in the container as `/opt/researchlab/requests`.

### A4. Log Codex in, once

```bash
rl codex login --device-auth
```

Open the URL it prints, sign in, and enter the code. The login is kept in the
`rl-codex` volume. Then check that everything is ready:

```bash
rl researchlab bootstrap
```

```bash
rl researchlab setup
```

`setup` asks for each API key in turn (typing is hidden; Enter skips one) and
saves them in the `rl-keys` volume. A source that needs a key stays off until
its key is set. Get at least the free OpenAlex
key — OpenAlex expects one on every request since February 2026 — and a
Semantic Scholar key if you can (see [APIS.md](APIS.md)).

```bash
rl researchlab doctor
```

`doctor` prints JSON; `"ready_for_run_plan": true` means you can run a cycle,
and `api_keys` shows which keys are set (masked).
Continue with [CLI.md](CLI.md); prefix each command there with `rl` (for
example `rl researchlab status --cycle-id my-cycle`).

To run a long cycle in the background and follow it from another terminal:

```bash
docker run -d --name rl-cycle --restart on-failure:3 --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v rl-state:/opt/researchlab/.research-lab -v rl-codex:/home/researcher/.codex -v rl-keys:/home/researcher/.researchlab -v "$PWD/requests:/opt/researchlab/requests" autoresearchlab scripts/run-cycle.sh my-cycle requests/my-request.md
```

```bash
docker logs -f rl-cycle
```

`--restart on-failure:3` starts the cycle again (it resumes) if the process
dies. To resume a stopped one, `docker start -a rl-cycle`.

---

## B. Native (Ubuntu 24.04 or WSL2)

On Windows, first install WSL2 with Ubuntu 24.04 (in PowerShell as
administrator: `wsl --install -d Ubuntu-24.04`), open the Ubuntu terminal, and
run everything below there — in your Linux home directory, not under `/mnt/c`.

### B1. System packages

```bash
sudo apt-get update
```

```bash
sudo apt-get install -y --no-install-recommends ca-certificates curl git bubblewrap build-essential pkg-config libssl-dev python3 python3-venv python3-dev jq
```

`bubblewrap` is required: Codex builds its sandbox with it. `build-essential`
is needed to compile the harness (it bundles SQLite).

**Ubuntu 24.04 outside WSL** restricts unprivileged user namespaces with
AppArmor, which bubblewrap needs. Check:

```bash
bwrap --unshare-user --ro-bind / / true && echo ok
```

If it prints an error instead of `ok`, give `bwrap` an AppArmor profile that
allows them (this changes nothing for other programs):

```bash
printf 'abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n' | sudo tee /etc/apparmor.d/bwrap
```

```bash
sudo systemctl reload apparmor
```

and run the check again. WSL2 does not need this.

### B2. Node.js 22

The CLI needs Node.js **22.13 or newer** (it uses `node:sqlite`).

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt-get install -y nodejs
```

```bash
node --version
```

### B3. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
```

```bash
. "$HOME/.cargo/env"
```

```bash
cargo --version
```

(New terminals get `cargo` automatically after this.)

### B4. Codex CLI

```bash
sudo npm install -g @openai/codex@0.153.4
```

```bash
codex --version
```

Codex 0.144.1 or newer is required for the models the agents use.

### B5. Get the code

```bash
git clone https://github.com/TaewiKim/autoresearchlab.git
```

```bash
cd autoresearchlab
```

### B6. Log Codex in

```bash
codex login --device-auth
```

Open the URL it prints, sign in, and enter the code. (On a desktop with a
browser, `codex login` works too.)

### B7. Bootstrap

```bash
node src/cli/index.js bootstrap
```

This builds the native harness (`cargo build --release`, a few minutes the
first time), creates `.research-lab/`, imports the Codex login, creates `.venv`
and installs `requirements.txt` into it, and ends with the same report as
`doctor`. Look for `"ready_for_run_plan": true`.

### B8. Settings

```bash
cp researchlab.env.example researchlab.env
```

`researchlab.env` holds settings, not keys. Keep `RESEARCHLAB_CODEX_SANDBOX=workspace-write` and
`RESEARCHLAB_CODEX_APPROVAL_POLICY=on-request`: without them the harness starts
Codex with its sandbox disabled.

### B9. The `researchlab` command

```bash
mkdir -p "$HOME/.local/bin" && ln -sf "$PWD/bin/researchlab" "$HOME/.local/bin/researchlab"
```

```bash
researchlab help
```

(Ubuntu puts `~/.local/bin` on `PATH` for new terminals; if `researchlab` is
not found, open a new terminal or run `export PATH="$HOME/.local/bin:$PATH"`.)
`researchlab` always works on the repository it lives in, from any directory.

### B10. API keys

```bash
researchlab setup
```

`setup` asks for each API key in turn (typing is hidden; Enter skips one) and
saves them in `~/.researchlab/.env` (mode 0600), outside the repository. A
source that needs a key stays off until its key is set. Get at least the free OpenAlex key — OpenAlex expects one on every
request since February 2026 — and a Semantic Scholar key if you can (see
[APIS.md](APIS.md)). Change one later with `researchlab keys set <name>`.

Continue with [CLI.md](CLI.md).

---

## Optional extras

- **Simulation (MuJoCo, CPU torch)** for robotics cycles:

  ```bash
  .venv/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision
  ```

  ```bash
  .venv/bin/pip install "mujoco==3.11.0"
  ```

  and set `RESEARCHLAB_MUJOCO_PYTHON="$PWD/.venv/bin/python"` in
  `researchlab.env`. Headless rendering uses OSMesa:
  `sudo apt-get install -y libosmesa6 libgl1` and `MUJOCO_GL=osmesa`.

- **Dataset web search** (the data scout's DuckDuckGo fallback; open network
  mode only, see [APIS.md](APIS.md)):

  ```bash
  .venv/bin/pip install playwright && .venv/bin/python -m playwright install --with-deps chromium
  ```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No such built-in module: node:sqlite` | Node.js older than 22.13. Install Node.js 22 (B2). |
| `spawnSync cargo ENOENT` during bootstrap | Rust is not installed (B3). |
| `error: linker 'cc' not found` | `build-essential` is missing (B1). |
| Codex lanes fail with `No permissions to create a new namespace` / bubblewrap errors | Docker: add both `--security-opt ... unconfined` flags (A3). Ubuntu 24.04 host: unprivileged user namespaces are restricted by AppArmor; give `bwrap` the profile in B1, or run in Docker. |
| `doctor` shows `ready_for_run_plan: false` with a Codex problem | Log in again (`codex login --device-auth`), then `researchlab import-codex-auth`. |
| `doctor` shows a Python import failure | Run `node src/cli/index.js bootstrap` again, or `.venv/bin/pip install -r requirements.txt`. |
| Scout lanes find no papers; their `search-retrieval-events.jsonl` says `Temporary failure in name resolution` | The lane sandbox has no network: the network settings are missing. Use `scripts/run-cycle.sh` (it reads `researchlab.env`, or the example when there is none), or run `. ./researchlab.env` before `researchlab run-research`. The Docker image sets them. |
| Scouts never use OpenAlex or Semantic Scholar | They are off until their keys are set: `researchlab keys set openalex`, `researchlab keys set semantic-scholar` (see [APIS.md](APIS.md)); `researchlab keys list` shows `ON`/`OFF`. |
| Literature lookups fail with `HTTP Error 429: Too Many Requests` | A public API's rate limit. The driver waits and retries; with your own OpenAlex and Semantic Scholar keys (`researchlab keys set …`) those two stop sharing the anonymous pool. |
| Docker in Git Bash on Windows: `request file not found` although the file exists | Git Bash turns `$PWD` into `/c/Users/...`, which Docker Desktop cannot mount. Use PowerShell (A3), or `$(pwd -W)` instead of `$PWD`. |
| A cycle stops with a quota message | The Codex plan's usage limit was reached. `scripts/run-cycle.sh` waits and resumes on its own; after a bare `run-research`, run it again after the reset (the cycle resumes), or pass `--auto-resume-on-quota`. |
