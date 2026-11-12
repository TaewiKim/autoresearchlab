"use strict";

// The Codex service tier, for the Codex processes Node starts itself.
//
// The lanes get theirs from the harness (runtime/codex_policy.rs,
// codex_service_tier_override); the maintainer and the live-view chat agent are
// spawned from here and would otherwise stay on the container's default tier.
// Same setting, same accepted names, for the same measured reasons: `flex` is
// refused by the API and fails the turn, an unknown name is dropped with an error
// in the stream.

const ACCEPTED = new Set(["fast", "priority", "default"]);

function codexServiceTier(env = process.env) {
  const tier = String(env.RESEARCHLAB_CODEX_SERVICE_TIER || "").trim().toLowerCase();
  return ACCEPTED.has(tier) ? tier : null;
}

// The `codex exec` arguments that select the tier, or none.
function codexServiceTierArgs(env = process.env) {
  const tier = codexServiceTier(env);
  return tier ? ["--config", `service_tier="${tier}"`] : [];
}

module.exports = { codexServiceTier, codexServiceTierArgs };
