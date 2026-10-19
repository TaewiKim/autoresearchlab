# ResearchLab in a container: everything the CLI needs, built once.
#
#   docker build -t autoresearchlab -f docker/Dockerfile .
#
# Optional simulator stack (CPU torch + MuJoCo) for robotics cycles:
#   docker build -t autoresearchlab --build-arg WITH_SIM=1 -f docker/Dockerfile .
#
# See docs/INSTALL.md for how to run it.
FROM ubuntu:24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# Prefer IPv4: some container networks answer AAAA records for pypi/crates.io
# over an incomplete IPv6 path, and downloads crawl instead of failing.
RUN echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf

# bubblewrap is required: Codex builds its sandbox with it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git bubblewrap xz-utils procps jq ripgrep \
      build-essential pkg-config libssl-dev \
      python3 python3-venv python3-dev \
      libgl1 libglib2.0-0 libosmesa6 \
 && rm -rf /var/lib/apt/lists/*

# Node.js 22 (the CLI needs >= 22.13 for node:sqlite).
ARG NODE_MAJOR=22
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node -v

# The Codex CLI the harness drives.
ARG CODEX_VERSION=0.153.4
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && codex --version

# Rust, to build the native harness.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
ENV PATH=/usr/local/cargo/bin:$PATH \
    CARGO_HTTP_MULTIPLEXING=false CARGO_NET_RETRY=10 CARGO_HTTP_TIMEOUT=180
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable \
 && chmod -R a+rX $CARGO_HOME $RUSTUP_HOME \
 && cargo --version

# ubuntu:24.04 ships a user `ubuntu` with uid 1000; the image's user takes its place.
RUN if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
 && useradd --create-home --shell /bin/bash --uid 1000 researcher \
 && mkdir -p /home/researcher/.codex /home/researcher/.researchlab /opt/researchlab \
 && chown -R researcher:researcher /home/researcher /opt/researchlab

COPY --chown=researcher:researcher . /opt/researchlab
WORKDIR /opt/researchlab
USER researcher

ENV PIP_DEFAULT_TIMEOUT=300 PIP_RETRIES=10 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python3 -m venv .venv \
 && .venv/bin/pip install --no-cache-dir -r requirements.txt

ARG WITH_SIM=0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN if [ "$WITH_SIM" = "1" ]; then \
      .venv/bin/pip install --no-cache-dir --index-url "$TORCH_INDEX_URL" torch torchvision \
   && .venv/bin/pip install --no-cache-dir "mujoco==3.11.0" \
   && .venv/bin/python -c "import torch, mujoco; print('torch', torch.__version__, 'mujoco', mujoco.__version__)"; \
    fi

# The toolchain stays in /usr/local; the crate cache is the user's, so the
# harness can also rebuild itself at run time.
ENV CARGO_HOME=/home/researcher/.cargo

# Build the native harness now, so the first command does not compile.
RUN chmod +x bin/researchlab scripts/*.sh \
 && cargo build --release --manifest-path native/researchlab-harness/Cargo.toml \
 && mkdir -p .research-lab

# The recommended settings of researchlab.env.example. Without the network
# ones, the Codex sandbox gives scout lanes no network at all and every
# literature lookup fails with "Temporary failure in name resolution".
ENV RESEARCHLAB_PYTHON=/opt/researchlab/.venv/bin/python \
    RESEARCHLAB_MUJOCO_PYTHON=/opt/researchlab/.venv/bin/python \
    RESEARCHLAB_AGENT_RUNTIME=codex \
    RESEARCHLAB_CODEX_SANDBOX=workspace-write \
    RESEARCHLAB_CODEX_APPROVAL_POLICY=on-request \
    RESEARCHLAB_LITERATURE_NETWORK_POLICY=approved-scholarly-metadata-v1 \
    RESEARCHLAB_CODEX_NETWORK_DOMAINS=api.openalex.org,api.semanticscholar.org,api.crossref.org,export.arxiv.org,arxiv.org,api.opencitations.net,ar5iv.labs.arxiv.org,api.github.com,huggingface.co \
    RESEARCHLAB_OPEN_SOURCE_ASSETS=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    CODEX_HOME=/home/researcher/.codex \
    MUJOCO_GL=osmesa PYOPENGL_PLATFORM=osmesa \
    PYTHONUTF8=1 PYTHONIOENCODING=utf-8 \
    PATH=/opt/researchlab/bin:$PATH

# Cycle state lives in /opt/researchlab/.research-lab, the Codex login in
# /home/researcher/.codex and your API keys in /home/researcher/.researchlab:
# mount a volume on each to keep them.
VOLUME ["/opt/researchlab/.research-lab", "/home/researcher/.codex", "/home/researcher/.researchlab"]
CMD ["researchlab", "help"]
