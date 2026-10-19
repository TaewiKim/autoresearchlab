"use strict";

// Sources that need the operator's own key are on only when it is set.
//
// The same table as drivers/literature/search_lib/key_gates.py, which keeps
// the literature driver from calling them. Here it keeps the JS lookups off
// them, and the agents' sandbox: a disabled source's host is taken out of
// RESEARCHLAB_CODEX_NETWORK_DOMAINS, so a lane cannot reach it either.
//
// MEASURED ON a first public-image cycle, 2026-10-19: with no Semantic
// Scholar key every second lookup got HTTP 429 and the field-landscape scout
// was marked literature_retrieval_throttled. OpenAlex has required a key on
// every request since 2026-02-13.

const KEY_GATED_SOURCES = {
  semanticscholar: { hosts: ["api.semanticscholar.org"], keys: ["RESEARCHLAB_S2_API_KEY"], enable: "researchlab keys set semantic-scholar" },
  openalex: { hosts: ["api.openalex.org"], keys: ["RESEARCHLAB_OPENALEX_API_KEY", "OPENALEX_API_KEY"], enable: "researchlab keys set openalex" },
  scopus: { hosts: ["api.elsevier.com"], keys: ["SCOPUS_API_KEY", "ELSEVIER_API_KEY", "X_ELS_APIKEY"], enable: "researchlab keys set scopus" },
};

function gatesActive(env = process.env) {
  return !["0", "off", "false"].includes(String(env.RESEARCHLAB_KEY_GATES || "").trim().toLowerCase());
}

function sourceKey(source, env = process.env) {
  const gate = KEY_GATED_SOURCES[source];
  if (!gate) return "";
  for (const name of gate.keys) {
    const value = String(env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function sourceEnabled(source, env = process.env) {
  if (!KEY_GATED_SOURCES[source] || !gatesActive(env)) return true;
  return Boolean(sourceKey(source, env));
}

function disabledReason(source) {
  const gate = KEY_GATED_SOURCES[source];
  return gate ? `${source} is off: it needs an API key, and none is set (turn it on with \`${gate.enable}\`)` : "";
}

// The agents' network allowlist without the hosts of disabled sources.
function gateNetworkDomains(env = process.env) {
  const raw = String(env.RESEARCHLAB_CODEX_NETWORK_DOMAINS || "");
  if (!raw.trim() || !gatesActive(env)) return { domains: raw, removed: [] };
  const disabledHosts = new Set(Object.entries(KEY_GATED_SOURCES)
    .filter(([source]) => !sourceEnabled(source, env))
    .flatMap(([, gate]) => gate.hosts));
  const kept = [];
  const removed = [];
  for (const host of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    (disabledHosts.has(host.toLowerCase()) ? removed : kept).push(host);
  }
  return { domains: kept.join(","), removed };
}

function applyKeyGates(env = process.env) {
  const { domains, removed } = gateNetworkDomains(env);
  if (removed.length) env.RESEARCHLAB_CODEX_NETWORK_DOMAINS = domains;
  return removed;
}

module.exports = { KEY_GATED_SOURCES, applyKeyGates, disabledReason, gateNetworkDomains, gatesActive, sourceEnabled, sourceKey };
