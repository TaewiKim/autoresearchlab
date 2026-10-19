"use strict";

// The operator's own API keys, entered from the CLI and kept outside the
// repository.
//
//   researchlab setup                       walk through every optional key
//   researchlab keys list                   which keys are set (masked)
//   researchlab keys set <name>             enter one key (typing is hidden)
//   researchlab keys set <name> --stdin     read it from standard input
//   researchlab keys unset <name>
//
// Keys live in $RESEARCHLAB_HOME/.env (default ~/.researchlab/.env), mode
// 0600 -- never in the repository, never in cycle state. Every researchlab
// command loads that file into its environment at start; a variable already
// set in the shell wins. The same layout Hermes Agent uses (~/.hermes/.env
// for secrets, apart from settings) and OpenClaw's onboarding follows (keys
// prompted for, or taken from the environment when already there).
//
// A key is never accepted as a command-line argument: that would leave it in
// the shell history and in the process list.

const fs = require("fs");
const os = require("os");
const path = require("path");

const KEYS = [
  {
    name: "openalex",
    env: "RESEARCHLAB_OPENALEX_API_KEY",
    aliases: ["OPENALEX_API_KEY"],
    service: "OpenAlex (paper search, citation metrics)",
    turnsOn: "openalex",
    url: "https://openalex.org/settings/api (free account; the key is on that page)",
    why: "turns on OpenAlex search and citation metrics; recommended (OpenAlex expects a key on every request since 2026-02-13)",
  },
  {
    name: "semantic-scholar",
    env: "RESEARCHLAB_S2_API_KEY",
    aliases: [],
    service: "Semantic Scholar (search, citations)",
    turnsOn: "semanticscholar",
    url: "https://www.semanticscholar.org/product/api (\"Request an API key\"; it arrives by e-mail)",
    why: "turns on Semantic Scholar search, title matching and the citation graph",
  },
  {
    name: "contact-email",
    env: "RESEARCHLAB_CONTACT_MAILTO",
    aliases: [],
    service: "Your e-mail address, sent to OpenAlex and Crossref as `mailto`",
    url: "no sign-up: your own address",
    why: "joins their polite pool: faster, more reliable responses",
    secret: false,
    outsidePolicyOnly: true,
  },
  {
    name: "github",
    env: "RESEARCHLAB_GITHUB_TOKEN",
    aliases: [],
    service: "GitHub (code repositories linked to papers)",
    url: "https://github.com/settings/personal-access-tokens (a fine-grained token with no permissions is enough)",
    why: "higher rate limits for repository metadata",
    outsidePolicyOnly: true,
  },
  {
    name: "scopus",
    env: "SCOPUS_API_KEY",
    aliases: ["ELSEVIER_API_KEY", "X_ELS_APIKEY"],
    service: "Elsevier Scopus (search)",
    turnsOn: "scopus",
    url: "https://dev.elsevier.com/apikey/manage",
    why: "turns on Scopus search (institutional access)",
    outsidePolicyOnly: true,
  },
];

// Under the approved scholarly network policy (the recommended setting, and the
// Docker image's) the literature driver sends no address, no header but the
// Semantic Scholar key, and calls no Scopus: these keys are kept, and unused.
function approvedPolicyOn(env = process.env) {
  return String(env.RESEARCHLAB_LITERATURE_NETWORK_POLICY || "").trim() === "approved-scholarly-metadata-v1";
}

function keysHome(env = process.env) {
  return env.RESEARCHLAB_HOME ? path.resolve(env.RESEARCHLAB_HOME) : path.join(os.homedir(), ".researchlab");
}

function keysFile(env = process.env) {
  return path.join(keysHome(env), ".env");
}

function findKey(name) {
  const wanted = String(name || "").trim().toLowerCase();
  return KEYS.find((key) => key.name === wanted || key.env.toLowerCase() === wanted || key.aliases.some((alias) => alias.toLowerCase() === wanted)) || null;
}

function parseEnvFile(text) {
  const values = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    values[match[1]] = value;
  }
  return values;
}

function readKeysFile(env = process.env) {
  try {
    return parseEnvFile(fs.readFileSync(keysFile(env), "utf8"));
  } catch {
    return {};
  }
}

function writeKeysFile(values, env = process.env) {
  const file = keysFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = [
    "# ResearchLab API keys. Written by `researchlab keys` / `researchlab setup`.",
    "# Keep this file private (mode 0600). Never copy it into a repository.",
    ...Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
      .map(([name, value]) => `${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`),
    "",
  ];
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.join("\n"), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not every filesystem keeps POSIX modes.
  }
  return file;
}

// Every researchlab command starts here: the keys file fills in what the
// shell did not set, so drivers and the native harness inherit them.
function loadKeysIntoEnv(env = process.env) {
  const values = readKeysFile(env);
  const loaded = [];
  for (const [name, value] of Object.entries(values)) {
    if (env[name] === undefined || env[name] === "") {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
}

function mask(value, key) {
  const text = String(value || "");
  if (!text) return "";
  if (key && key.secret === false) return text;
  return text.length <= 8 ? "****" : `${text.slice(0, 4)}…(${text.length} chars)`;
}

// Where each key comes from right now, without revealing it.
function keyStatus(env = process.env) {
  const file = readKeysFile(env);
  return KEYS.map((key) => {
    const fromFile = file[key.env];
    const shellName = [key.env, ...key.aliases].find((name) => env[name] && env[name] !== fromFile);
    const value = shellName ? env[shellName] : fromFile;
    return {
      name: key.name,
      env: key.env,
      service: key.service,
      set: Boolean(value),
      source: shellName ? `environment (${shellName})` : fromFile ? keysFile(env) : null,
      shown: mask(value, key),
      // A key that turns a source on: is that source on now?
      source_on: key.turnsOn ? require("../policy/key_gates").sourceEnabled(key.turnsOn, env) && !(key.outsidePolicyOnly && approvedPolicyOn(env)) : null,
      unused_under_policy: Boolean(key.outsidePolicyOnly && approvedPolicyOn(env)),
    };
  });
}

// Hidden input on a terminal; the whole of standard input otherwise.
function readSecret(prompt, { input = process.stdin, output = process.stderr, hidden = true } = {}) {
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let data = "";
      input.setEncoding("utf8");
      input.on("data", (chunk) => { data += chunk; });
      input.on("end", () => resolve(data.trim()));
      input.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    output.write(prompt);
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (result) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done(value.trim());
        if (char === "\u0003") { output.write("\n"); process.exit(130); }
        if (char === "\u0004") return done(value.trim());
        if (char === "\u007f" || char === "\b") {
          if (value.length) { value = value.slice(0, -1); if (!hidden) output.write("\b \b"); }
          continue;
        }
        value += char;
        if (!hidden) output.write(char);
      }
      return undefined;
    };
    input.on("data", onData);
  });
}

function printKeyList(out = process.stdout, env = process.env) {
  out.write(`API keys — stored in ${keysFile(env)}\n`);
  out.write("A source that needs a key is ON only when its key is set.\n\n");
  for (const item of keyStatus(env)) {
    const key = findKey(item.name);
    const state = item.unused_under_policy
      ? "   -> unused under the approved network policy"
      : item.source_on === null ? "" : item.source_on ? "   -> ON" : "   -> OFF";
    out.write(`  ${item.name.padEnd(17)} ${item.set ? `set    ${item.shown}  [${item.source}]` : "not set"}${state}\n`);
    out.write(`  ${"".padEnd(17)} ${key.service}; ${key.why}\n`);
    if (!item.set) out.write(`  ${"".padEnd(17)} get one: ${key.url}\n`);
  }
  out.write("\nSet one:  researchlab keys set <name>      (typing is hidden)\n");
}

async function setKey(name, { fromStdin = false, env = process.env, out = process.stdout } = {}) {
  const key = findKey(name);
  if (!key) throw new Error(`unknown key "${name}"; one of: ${KEYS.map((item) => item.name).join(", ")}`);
  const value = await readSecret(`${key.service}\n  get it at: ${key.url}\n  ${key.env}: `, { hidden: key.secret !== false && !fromStdin });
  if (!value) {
    out.write(`${key.name}: nothing entered, unchanged\n`);
    return false;
  }
  if (/\s/.test(value)) throw new Error(`${key.name}: the value contains whitespace; nothing was saved`);
  const values = readKeysFile(env);
  values[key.env] = value;
  const file = writeKeysFile(values, env);
  out.write(`${key.name}: saved to ${file} (${mask(value, key)})\n`);
  return true;
}

function unsetKey(name, { env = process.env, out = process.stdout } = {}) {
  const key = findKey(name);
  if (!key) throw new Error(`unknown key "${name}"; one of: ${KEYS.map((item) => item.name).join(", ")}`);
  const values = readKeysFile(env);
  if (!(key.env in values)) {
    out.write(`${key.name}: not in ${keysFile(env)}\n`);
    return false;
  }
  delete values[key.env];
  writeKeysFile(values, env);
  out.write(`${key.name}: removed from ${keysFile(env)}\n`);
  return true;
}

async function runSetup({ env = process.env, out = process.stdout } = {}) {
  if (!process.stdin.isTTY) throw new Error("setup asks questions; run it in a terminal (or use `researchlab keys set <name> --stdin`)");
  out.write([
    "AutoResearchLab setup",
    "",
    "1. The agents run on the Codex CLI. If you have not yet, log in first:",
    "     codex login --device-auth",
    "",
    "2. API keys. A source that needs a key is OFF until you enter it; none is",
    "   required to run a cycle. Press Enter to skip one; set or change it",
    `   later with \`researchlab keys set <name>\`. They are saved in ${keysFile(env)}.`,
    "",
  ].join("\n"));
  for (const item of keyStatus(env)) {
    const key = findKey(item.name);
    if (item.unused_under_policy) {
      out.write(`\n${key.service}\n  skipped: not used while RESEARCHLAB_LITERATURE_NETWORK_POLICY=approved-scholarly-metadata-v1\n`);
      continue;
    }
    out.write(`\n${key.service}\n  ${key.why}\n`);
    if (item.set) {
      out.write(`  already set (${item.shown}, ${item.source}); Enter keeps it\n`);
    }
    out.write(`  get it at: ${key.url}\n`);
    const value = await readSecret(`  ${key.env}: `, { hidden: key.secret !== false });
    if (!value) continue;
    if (/\s/.test(value)) {
      out.write("  contains whitespace; skipped\n");
      continue;
    }
    const values = readKeysFile(env);
    values[key.env] = value;
    writeKeysFile(values, env);
    out.write(`  saved (${mask(value, key)})\n`);
  }
  out.write("\nDone. Check everything with:  researchlab doctor\n");
}

async function runKeysCommand(argv, { env = process.env, out = process.stdout } = {}) {
  const [subcommand = "list", name, ...rest] = argv;
  if (subcommand === "list") return printKeyList(out, env);
  if (subcommand === "path") return out.write(`${keysFile(env)}\n`);
  if (subcommand === "set") {
    if (!name) throw new Error("usage: researchlab keys set <name> [--stdin]");
    const inline = rest.filter((token) => token !== "--stdin");
    if (inline.length) throw new Error("a key is not taken as an argument (it would stay in your shell history); run `researchlab keys set <name>` and type it, or pipe it with --stdin");
    return setKey(name, { fromStdin: rest.includes("--stdin") || !process.stdin.isTTY, env, out });
  }
  if (subcommand === "unset") {
    if (!name) throw new Error("usage: researchlab keys unset <name>");
    return unsetKey(name, { env, out });
  }
  throw new Error(`unknown keys command "${subcommand}" (list, set, unset, path)`);
}

module.exports = {
  KEYS,
  findKey,
  keyStatus,
  keysFile,
  loadKeysIntoEnv,
  mask,
  parseEnvFile,
  readKeysFile,
  runKeysCommand,
  runSetup,
  setKey,
  unsetKey,
  writeKeysFile,
};
