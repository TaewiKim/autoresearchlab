"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ensureNativeBuilt } = require("../runtime/native_runtime");

function loadInitResearchLab() {
  return require("../bootstrap/init").initResearchLab;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error ? result.error.message : null,
  };
}

function projectPaths(cwd = process.cwd()) {
  return {
    cwd,
    venvBin: path.join(cwd, ".venv", "bin"),
    authPath: path.join(cwd, ".research-lab", "runtime", "auth.json"),
  };
}

function pathWithVenv(cwd = process.cwd()) {
  const { venvBin } = projectPaths(cwd);
  return fs.existsSync(venvBin)
    ? `${venvBin}:${process.env.PATH || ""}`
    : (process.env.PATH || "");
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function researchlabCodexHome() {
  const home = process.env.HOME || "";
  const codexHome = path.join(home, ".codex");
  return fs.existsSync(codexHome) ? codexHome : null;
}

function researchlabCodexEnv() {
  const codexHome = researchlabCodexHome();
  return codexHome ? { CODEX_HOME: codexHome } : {};
}

function codexCommand() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.RESEARCHLAB_CODEX_CMD,
    path.join(home, ".nvm", "versions", "node", "v25.8.1", "bin", "codex"),
    path.join(home, ".nvm", "versions", "node", "v22.22.0", "bin", "codex"),
    path.join(home, ".openclaw", "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
    "codex",
  ];
  for (const candidate of candidates) {
    if (candidate && commandLooksHealthy(candidate)) {
      return candidate;
    }
  }
  return "codex";
}

function commandLooksHealthy(command) {
  if (command !== "codex" && !fs.existsSync(command)) {
    return false;
  }
  return runChecked(command, ["--version"]).status === 0;
}

function codexLoginStatus(cwd = process.cwd()) {
  const command = codexCommand();
  const status = runChecked(command, ["login", "status"], {
    cwd,
    env: researchlabCodexEnv(),
  });
  return {
    ...status,
    command,
    command_healthy: commandLooksHealthy(command),
  };
}

// Claude Code CLI exposes its session via ``~/.claude/.credentials.json``;
// the CLI itself does not provide a structured ``status`` subcommand
// in older versions, so we probe ``claude --version`` and surface the
// credentials file's existence as the proxy for "logged in".
function claudeCliStatus(cwd = process.cwd()) {
  const probe = runChecked("claude", ["--version"], { cwd });
  if (probe.status !== 0) {
    return {
      installed: false,
      logged_in: false,
      status_text: (probe.stderr || probe.stdout || "claude not found").trim(),
    };
  }
  const credsPath = path.join(
    process.env.HOME || "",
    ".claude",
    ".credentials.json",
  );
  const hasCreds = fs.existsSync(credsPath);
  return {
    installed: true,
    logged_in: hasCreds,
    status_text: hasCreds
      ? `Logged in via Claude Code (${(probe.stdout || "").trim()})`
      : "claude installed but no credentials file",
    credentials_path: credsPath,
  };
}

function researchlabAuthStatus(cwd = process.cwd()) {
  const result = runChecked("node", ["src/cli/index.js", "auth-status"], { cwd });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "null");
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

function importCodexAuth(cwd = process.cwd()) {
  return runChecked("node", ["src/cli/index.js", "import-codex-auth"], { cwd });
}

// Inline JS importer for Claude Code (Anthropic) credentials. Mirrors
// the Rust harness's ``import_codex_auth`` shape so the same
// ``auth.json`` consumers (doctor probe, executor) can read either
// provider's tokens. Source priority:
//   1. ``$ANTHROPIC_API_KEY`` env var (preferred — direct API access,
//      no session expiry)
//   2. ``~/.claude/.credentials.json`` (Claude Code session, if Pro/
//      Max user logged into the desktop CLI)
function importClaudeAuthInline(cwd = process.cwd()) {
  const authPath = path.join(cwd, ".research-lab", "runtime", "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  const credsPath = path.join(
    process.env.HOME || "",
    ".claude",
    ".credentials.json",
  );
  let creds = null;
  if (fs.existsSync(credsPath)) {
    try {
      creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    } catch {
      creds = null;
    }
  }
  if (!apiKey && !creds) {
    return {
      status: 1,
      stderr:
        "no Claude credentials found — set $ANTHROPIC_API_KEY or log into Claude Code (~/.claude/.credentials.json)",
    };
  }
  // Preserve any existing OpenAI/Codex credentials so a user who runs
  // ``import-codex-auth`` AND ``import-claude-auth`` ends up with both
  // providers stored side by side; the executor picks whichever
  // matches the assigned model.
  let existing = {};
  if (fs.existsSync(authPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(authPath, "utf8")) || {};
    } catch {
      existing = {};
    }
  }
  const payload = {
    ...existing,
    provider: "multi",
    imported_at: new Date().toISOString(),
    anthropic: {
      // Direct API usage path:
      ANTHROPIC_API_KEY: apiKey || null,
      // Claude Code session path (used when calling ``claude`` CLI as
      // a subprocess; the CLI re-reads .credentials.json itself):
      session_present: !!creds,
      session_path: creds ? credsPath : null,
      session_expires_at: (creds && creds.expiresAt) || null,
    },
  };
  fs.writeFileSync(authPath, JSON.stringify(payload, null, 2), "utf8");
  return {
    status: 0,
    stdout: JSON.stringify({
      auth_path: authPath,
      anthropic_api_key: !!apiKey,
      claude_code_session: !!creds,
    }, null, 2),
  };
}

// pip's progress, shown on stderr: bootstrap's stdout is the JSON report, and
// pip writing there made it unparseable.
const SETUP_STDIO = ["ignore", 2, 2];

function ensureProjectVenv(cwd = process.cwd()) {
  const { venvBin } = projectPaths(cwd);
  const pythonBin = path.join(venvBin, "python");
  if (!fs.existsSync(pythonBin)) {
    // Progress goes to stderr: stdout is the JSON report.
    const created = runChecked("python3", ["-m", "venv", ".venv"], { cwd, stdio: SETUP_STDIO });
    if (created.status !== 0) {
      throw new Error("failed to create .venv");
    }
  }
  return pythonBin;
}

function ensurePythonDeps(cwd = process.cwd()) {
  ensureProjectVenv(cwd);
  const env = { PATH: pathWithVenv(cwd) };
  const probe = runChecked(
    "python3",
    ["-c", "import pandas, scipy, statsmodels, matplotlib, seaborn, pyarrow, openpyxl, PIL, pptx; print('ok')"],
    { cwd, env },
  );
  if (probe.status === 0) {
    return { installed: false, ok: true, probe: probe.stdout.trim() };
  }

  const pipUpgrade = runChecked("python3", ["-m", "pip", "install", "--upgrade", "pip"], {
    cwd,
    env,
    stdio: SETUP_STDIO,
  });
  if (pipUpgrade.status !== 0) {
    throw new Error("failed to upgrade pip in project venv");
  }

  const install = runChecked(
    "python3",
    [
      "-m", "pip", "install",
      "-r", "requirements.txt",
    ],
    { cwd, env, stdio: SETUP_STDIO },
  );
  if (install.status !== 0) {
    throw new Error("failed to install python analysis dependencies");
  }

  const verify = runChecked(
    "python3",
    ["-c", "import pandas, scipy, statsmodels, matplotlib, seaborn, pyarrow, openpyxl, PIL, pptx; print('ok')"],
    { cwd, env },
  );
  if (verify.status !== 0) {
    throw new Error("python dependencies still unavailable after install");
  }

  return { installed: true, ok: true, probe: verify.stdout.trim() };
}

function fastPythonDepsStatus(cwd = process.cwd()) {
  const { venvBin } = projectPaths(cwd);
  const pythonBin = path.join(venvBin, "python");
  if (!fs.existsSync(pythonBin)) return null;
  return {
    installed: false,
    ok: true,
    assumed: true,
    probe: "assumed-ok-from-existing-project-venv; run `researchlab doctor` or `researchlab bootstrap` for a full import probe",
  };
}

function doctor(cwd = process.cwd(), options = {}) {
  const paths = projectPaths(cwd);
  const codex = codexLoginStatus(cwd);
  const claude = claudeCliStatus(cwd);
  const auth = researchlabAuthStatus(cwd);
  const venvExists = fs.existsSync(paths.venvBin);
  const fastPython = options.skipPythonProbe ? fastPythonDepsStatus(cwd) : null;
  const pythonProbe = fastPython?.ok
    ? { status: 0, stdout: fastPython.probe, stderr: "" }
    : runChecked(
        "python3",
        ["-c", "import pandas, scipy, statsmodels, matplotlib, seaborn, pyarrow, openpyxl, PIL, pptx; print('ok')"],
        { cwd, env: { PATH: pathWithVenv(cwd) } },
      );
  const authJson = readJsonSafe(paths.authPath);

  // Either provider unlocks ``ready_for_run_plan``: if the user
  // logged into Codex (ChatGPT plan or API key) the OpenAI executor
  // path works; if the user has Claude Code logged in or set
  // ``ANTHROPIC_API_KEY`` the Anthropic path is usable. v40 lesson:
  // ChatGPT-plan throttling kept blocking cycles, so a Claude Pro
  // user needed an alternate path.
  const researchlabCodexAuthReady =
    !!(auth.parsed && (auth.parsed.has_access_token || auth.parsed.has_api_key));
  const codexReady = codex.command_healthy && researchlabCodexAuthReady;
  const anthropicReady =
    !!(authJson && authJson.anthropic && (
      authJson.anthropic.ANTHROPIC_API_KEY || authJson.anthropic.session_present
    )) || !!process.env.ANTHROPIC_API_KEY;

  return {
    cwd,
    codex_cli: {
      logged_in: codex.status === 0,
      command: codex.command,
      command_healthy: codex.command_healthy,
      status_text: (codex.stdout || codex.stderr).trim(),
    },
    claude_cli: claude,
    researchlab_auth: auth.parsed || authJson,
    // Optional API keys: where each comes from, masked (src/cli/keys.js).
    api_keys: Object.fromEntries(require("./keys").keyStatus().map((item) => [item.name, item.set ? `${item.shown} [${item.source}]` : "not set"])),
    python: {
      venv_exists: venvExists,
      deps_ready: pythonProbe.status === 0,
      probe_skipped: Boolean(fastPython?.assumed),
      probe: (pythonProbe.stdout || pythonProbe.stderr).trim(),
    },
    ready_for_run_plan: pythonProbe.status === 0 && (codexReady || anthropicReady),
    available_providers: {
      openai_codex: codexReady,
      anthropic_claude: anthropicReady,
    },
  };
}

function bootstrap(cwd = process.cwd(), options = {}) {
  const result = {
    cwd,
    steps: [],
  };

  ensureNativeBuilt();
  result.steps.push({ step: "native-build", status: "ok" });

  loadInitResearchLab()({ cwd });
  result.steps.push({ step: "init", status: "ok" });

  // Either OpenAI/Codex or Anthropic/Claude unlocks the cycle. Try
  // both — whichever succeeds is enough for run-plan to dispatch.
  const codex = codexLoginStatus(cwd);
  const claude = claudeCliStatus(cwd);
  const hasAnthropicEnv = !!(process.env.ANTHROPIC_API_KEY || "").trim();
  if (codex.status === 0) {
    importCodexAuth(cwd);
    result.steps.push({ step: "import-codex-auth", status: "ok" });
  } else {
    result.steps.push({
      step: "codex-login",
      status: "skipped",
      message: "codex CLI not logged in; relying on Anthropic auth instead.",
    });
  }
  if (claude.logged_in || hasAnthropicEnv) {
    const claudeImport = importClaudeAuthInline(cwd);
    result.steps.push({
      step: "import-claude-auth",
      status: claudeImport.status === 0 ? "ok" : "failed",
      message: claudeImport.status === 0 ? null : (claudeImport.stderr || "").slice(0, 200),
    });
  } else {
    result.steps.push({
      step: "import-claude-auth",
      status: "skipped",
      message: "no Claude Code session and no ANTHROPIC_API_KEY env var.",
    });
  }
  // A missing login is reported, and the rest of the setup still runs: a
  // fresh install bootstrapped before `codex login` used to stop here with no
  // .venv and no Python packages, so its doctor reported two problems where
  // there was one.
  if (codex.status !== 0 && !claude.logged_in && !hasAnthropicEnv) {
    result.steps.push({
      step: "auth",
      status: "needs-user-action",
      message:
        "Need either: (a) `codex login --device-auth`, or (b) Claude Code logged in (~/.claude/.credentials.json), or (c) ANTHROPIC_API_KEY env var.",
    });
  }

  let deps = null;
  if (options.skipPythonProbe) {
    deps = fastPythonDepsStatus(cwd);
  }
  if (!deps) {
    deps = ensurePythonDeps(cwd);
  }
  result.steps.push({
    step: "python-deps",
    status: deps.assumed ? "assumed-ok" : (deps.installed ? "installed" : "already-ok"),
    message: deps.assumed ? deps.probe : null,
  });

  result.doctor = doctor(cwd, { skipPythonProbe: options.skipPythonProbe && deps.ok });
  return result;
}


module.exports = {
  bootstrap,
  doctor,
  importClaudeAuthInline,
  pathWithVenv,
};
