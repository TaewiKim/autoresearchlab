"use strict";

// API keys are the operator's: entered from the CLI, kept outside the
// repository, loaded into every command, never shown whole.

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const CLI = path.join(__dirname, "..", "src", "cli", "index.js");
const keys = require("../src/cli/keys");

function cleanEnv(home) {
  const env = { ...process.env, RESEARCHLAB_HOME: home };
  for (const key of keys.KEYS) for (const name of [key.env, ...key.aliases]) delete env[name];
  delete env.RESEARCHLAB_LITERATURE_NETWORK_POLICY;
  return env;
}

function cli(args, { home, input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: cleanEnv(home), input, encoding: "utf8" });
}

test("a key is set from standard input, stored outside the repository, and listed masked", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-keys-"));
  const secret = "s2-test-0123456789abcdefghij";
  const set = cli(["keys", "set", "semantic-scholar", "--stdin"], { home, input: `${secret}\n` });
  assert.equal(set.status, 0, set.stderr);
  assert.ok(!set.stdout.includes(secret), "the value is never printed");
  const file = path.join(home, ".env");
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(`RESEARCHLAB_S2_API_KEY="${secret}"`));
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const list = cli(["keys", "list"], { home });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /semantic-scholar\s+set\s+s2-t…\(28 chars\)/);
  assert.match(list.stdout, /openalex\s+not set/);
  assert.ok(!list.stdout.includes(secret));

  const unset = cli(["keys", "unset", "semantic-scholar"], { home });
  assert.equal(unset.status, 0, unset.stderr);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /RESEARCHLAB_S2_API_KEY/);
});

test("a key on the command line is refused, so it never reaches the shell history", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-keys-"));
  const run = cli(["keys", "set", "openalex", "abc123abc123abc123"], { home });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not taken as an argument/);
  assert.ok(!fs.existsSync(path.join(home, ".env")));
});

test("the keys file fills in what the shell did not set, and the shell wins", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-keys-"));
  const env = { RESEARCHLAB_HOME: home, RESEARCHLAB_S2_API_KEY: "from-shell-value" };
  keys.writeKeysFile({ RESEARCHLAB_S2_API_KEY: "from-file-value1", RESEARCHLAB_OPENALEX_API_KEY: "openalex-file-value" }, env);
  const loaded = keys.loadKeysIntoEnv(env);
  assert.deepEqual(loaded, ["RESEARCHLAB_OPENALEX_API_KEY"]);
  assert.equal(env.RESEARCHLAB_S2_API_KEY, "from-shell-value");
  assert.equal(env.RESEARCHLAB_OPENALEX_API_KEY, "openalex-file-value");
  // Every command loads it: doctor reports it, masked.
  const doctor = spawnSync(process.execPath, [CLI, "doctor"], { env: { ...cleanEnv(home) }, encoding: "utf8" });
  const report = JSON.parse(doctor.stdout);
  assert.match(report.api_keys.openalex, /^open…\(19 chars\) \[/);
  assert.match(report.api_keys["semantic-scholar"], /^from…\(16 chars\) \[/);
  assert.equal(report.api_keys.github, "not set");
  assert.ok(!doctor.stdout.includes("openalex-file-value"));
});

test("values with quotes and backslashes survive the file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rl-keys-"));
  const env = { RESEARCHLAB_HOME: home };
  keys.writeKeysFile({ SCOPUS_API_KEY: 'a"b\\c' }, env);
  assert.equal(keys.readKeysFile(env).SCOPUS_API_KEY, 'a"b\\c');
});

test("a source that needs a key is on only with it: lookups and the agents' network follow the key", () => {
  const gates = require("../src/policy/key_gates");
  const { fetchScholarlyMetadata } = require("../src/agents/chronicle/scholarly_metadata_lookup");
  const domains = "api.openalex.org,api.semanticscholar.org,api.crossref.org,export.arxiv.org";
  const keyless = { RESEARCHLAB_CODEX_NETWORK_DOMAINS: domains };
  assert.equal(gates.sourceEnabled("semanticscholar", keyless), false);
  assert.match(gates.disabledReason("semanticscholar"), /researchlab keys set semantic-scholar/);
  assert.deepEqual(gates.applyKeyGates(keyless), ["api.openalex.org", "api.semanticscholar.org"]);
  assert.equal(keyless.RESEARCHLAB_CODEX_NETWORK_DOMAINS, "api.crossref.org,export.arxiv.org");
  const keyed = { RESEARCHLAB_CODEX_NETWORK_DOMAINS: domains, RESEARCHLAB_S2_API_KEY: "k", OPENALEX_API_KEY: "o" };
  assert.deepEqual(gates.applyKeyGates(keyed), []);
  assert.equal(keyed.RESEARCHLAB_CODEX_NETWORK_DOMAINS, domains);

  // The OpenAlex metadata lookup: not asked without the key; with it, the key
  // goes as a header, not in the URL.
  const saved = { ...process.env };
  try {
    for (const name of ["RESEARCHLAB_OPENALEX_API_KEY", "OPENALEX_API_KEY", "RESEARCHLAB_KEY_GATES"]) delete process.env[name];
    const asked = [];
    const requestJson = (url, headers) => { asked.push({ url, headers }); return null; };
    fetchScholarlyMetadata({ paper: { title: "Diffusion Policy" }, requestJson });
    assert.deepEqual(asked.filter((item) => item.url.includes("openalex")), []);
    process.env.OPENALEX_API_KEY = "openalex-test-key";
    fetchScholarlyMetadata({ paper: { title: "Diffusion Policy" }, requestJson });
    const openalex = asked.find((item) => item.url.includes("openalex"));
    assert.ok(openalex && !openalex.url.includes("openalex-test-key"));
    assert.deepEqual(openalex.headers, ["Authorization: Bearer openalex-test-key"]);
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});

test("under the approved network policy, a key the policy never sends is listed as unused, not ON", () => {
  const env = { RESEARCHLAB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rl-keys-")), SCOPUS_API_KEY: "scopus-test-0123456789", RESEARCHLAB_S2_API_KEY: "s2-test-0123456789abcdef" };
  const open = Object.fromEntries(keys.keyStatus(env).map((item) => [item.name, item]));
  assert.equal(open.scopus.source_on, true);
  assert.equal(open.scopus.unused_under_policy, false);
  const policy = Object.fromEntries(keys.keyStatus({ ...env, RESEARCHLAB_LITERATURE_NETWORK_POLICY: "approved-scholarly-metadata-v1" }).map((item) => [item.name, item]));
  assert.equal(policy.scopus.source_on, false);
  assert.equal(policy.scopus.unused_under_policy, true);
  assert.equal(policy["contact-email"].unused_under_policy, true);
  assert.equal(policy.github.unused_under_policy, true);
  // The two keys the policy does send stay on.
  assert.equal(policy["semantic-scholar"].source_on, true);
  assert.equal(policy["semantic-scholar"].unused_under_policy, false);
});
