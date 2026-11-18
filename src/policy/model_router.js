"use strict";

const { RESEARCH_API_MODEL, usesDirectModelApi } = require("./research_api");

// The route is persisted with a role plan so that callers can audit why a
// particular model was selected.  Runtime-created follow-ups may later use the
// same contract without making the legacy `assigned_model` field ambiguous.
const ROUTE_VERSION = "codex-tier-router-v2";

// The routing ladder, cheapest first. OWNER DECISION 2026-11-18: GPT-6.2 Sol and
// GPT-6.2 Astra replace 6.1 Sol and 6 Astra (both measured answering through the
// container's Codex login that day); Terra and Luna are unchanged.
const CODEX_LADDER = Object.freeze([
  "gpt-6-luna",
  "gpt-6.1-terra",
  "gpt-6.2-sol",
  "gpt-6.2-astra",
]);

// Still accepted as pins so a role plan written before a model change stays
// routable: 6.1 Sol and 6 Astra until 2026-11-18, the 5.6 ids until 2026-10-31.
// Each sits on the ladder rung of its successor. Kept off the ladder itself:
// promotion from the top used to step into this tail (Astra -> 5.6 Luna).
const LEGACY_CODEX_MODELS = Object.freeze({
  "gpt-6.1-sol": "gpt-6.2-sol",
  "gpt-6-astra": "gpt-6.2-astra",
  "gpt-5.6-luna": "gpt-6-luna",
  "gpt-5.6-terra": "gpt-6.1-terra",
  "gpt-5.6-sol": "gpt-6.2-sol",
});

const CODEX_MODELS = Object.freeze([...CODEX_LADDER, ...Object.keys(LEGACY_CODEX_MODELS)]);

const ASTRA_MODELS = Object.freeze(["gpt-6.2-astra", "gpt-6-astra"]);

function rung(model) {
  return CODEX_LADDER.indexOf(LEGACY_CODEX_MODELS[model] || model);
}

const NON_CODEX_RUNTIME_MODELS = Object.freeze({
  "external-driver": "python-external-driver",
  "native-readonly": "native-readonly-runtime",
});

function text(value) {
  return String(value || "").trim().toLowerCase();
}

function boundedNumber(value, fallback = 0) {
  if (value == null || (typeof value === "string" && !value.trim())) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function promptComplexity(prompt) {
  const value = text(prompt);
  let score = 1;
  if (value.length > 40) score += 1;
  if (value.length > 120) score += 1;
  if (/novel|innovation|hypoth|adjudicat/.test(value)) score += 1;
  if (/paper|citation|literature|prior art/.test(value)) score += 1;
  if (/data|analy|experiment|falsif/.test(value)) score += 1;
  return Math.min(score, 6);
}

function promptLengthBand({ prompt, estimatedPromptBytes }) {
  const bytes = boundedNumber(estimatedPromptBytes, Buffer.byteLength(String(prompt || ""), "utf8"));
  if (bytes > 160_000) return "long";
  if (bytes > 32_000) return "medium";
  return "short";
}

function isCodexRuntime(runtime) {
  return !runtime || text(runtime) === "codex";
}

function normalizedPin(input) {
  return input.modelPin || input.pinnedModel || input.pinned_model || null;
}

function route({ model, reasoningEffort, reasons, fallbackChain }) {
  return {
    model,
    reasoning_effort: reasoningEffort,
    route_reason: reasons.join("; "),
    route_version: ROUTE_VERSION,
    fallback_chain: fallbackChain,
  };
}

function effortFor(model) {
  const effort = { 3: "xhigh", 2: "high", 1: "medium" }[rung(model)];
  return effort || "low";
}

function promote(model) {
  const index = rung(model);
  return index < 0 ? model : CODEX_LADDER[Math.min(index + 1, CODEX_LADDER.length - 1)];
}

function demote(model) {
  const index = rung(model);
  return index < 0 ? model : CODEX_LADDER[Math.max(index - 1, 0)];
}

function isCandidateSynthesis({ role, actionType, prompt, candidateCount, scientificStakes }) {
  if (role !== "lab-director") return false;
  const action = text(actionType);
  const value = text(prompt);
  const candidates = boundedNumber(candidateCount);
  const explicitSynthesis = /hypothesis.*(generation|strategy|tournament|adjudication)|novelty.*(tournament|adjudication)|decisive.*adjudication/.test(action);
  const promptSynthesis = /(?:three|3).*candidate|candidate.*(?:three|3)|hypothesis tournament|novelty.*adjudicat/.test(value);
  return explicitSynthesis && (candidates >= 3 || promptSynthesis || scientificStakes === "decisive");
}

function isDecisiveAdjudication({ role, actionType, scientificStakes, adjudicationRequired }) {
  const action = text(actionType);
  return (role === "lab-director" || role === "gatekeeper")
    && (scientificStakes === "decisive" || adjudicationRequired === true)
    && /adjudicat|novelty|hypothesis|gate_restart|conflict/.test(action);
}

function baseModelFor({ role, complexity, actionType }) {
  const action = text(actionType);
  if (role === "lab-director") {
    return complexity >= 4 || /hypothesis|pivot|novelty|gate/.test(action)
      ? "gpt-6.2-sol"
      : "gpt-6.1-terra";
  }
  if (role === "analyst") {
    return complexity >= 4 || /falsif|confound|recovery|comparison/.test(action)
      ? "gpt-6.2-sol"
      : "gpt-6.1-terra";
  }
  if (role === "gatekeeper") {
    return complexity >= 4 || /technical|reproduc|novelty|falsif/.test(action)
      ? "gpt-6.2-sol"
      : "gpt-6.1-terra";
  }
  if (role === "lab-runner") return "gpt-6.1-terra";
  if (role === "scout") return complexity >= 4 ? "gpt-6.1-terra" : "gpt-6-luna";
  if (role === "chronicle" || role === "author" || role === "illustrator") {
    return complexity >= 4 || /review|synthesis|revision/.test(action)
      ? "gpt-6.1-terra"
      : "gpt-6-luna";
  }
  return "gpt-6.1-terra";
}

/**
 * Select a Codex model from durable lane facts.  `modelPin` is the only input
 * that can override the subscription tier policy; direct API is always Luna. A model generated by a prior route is not a
 * pin and should be supplied as `existingRoute` instead.
 */
function chooseModelRoute(input = {}) {
  const role = text(input.role);
  const runtimeClass = text(input.runtimeClass || input.runtime_class);
  const laneMode = text(input.laneMode || input.lane_mode);
  const pin = normalizedPin(input);
  const reasons = [];

  if (usesDirectModelApi(input)) {
    return route({ model: RESEARCH_API_MODEL, reasoningEffort: "low",
      reasons: ["research direct API permits Luna only; pins and retries cannot change provider/model"], fallbackChain: [] });
  }

  if (NON_CODEX_RUNTIME_MODELS[runtimeClass] || laneMode === "driver-exec") {
    const model = NON_CODEX_RUNTIME_MODELS[runtimeClass] || "python-external-driver";
    return route({
      model,
      reasoningEffort: "none",
      reasons: ["non-Codex driver bypasses language-model routing"],
      fallbackChain: [],
    });
  }

  // Keep the Claude path untouched. The router is intentionally a Codex-only
  // policy and must not replace a user-selected non-OpenAI runtime model.
  if (!isCodexRuntime(input.runtime)) {
    return route({
      model: pin || input.existingModel || null,
      reasoningEffort: input.reasoningEffort || "none",
      reasons: ["non-Codex runtime preserves its provider-specific model selection"],
      fallbackChain: [],
    });
  }

  if (pin) {
    if (!CODEX_MODELS.includes(pin)) {
      throw new Error(`unsupported Codex model pin: ${pin}`);
    }
    return route({
      model: pin,
      reasoningEffort: input.reasoningEffort || effortFor(pin),
      reasons: ["explicit model pin"],
      fallbackChain: [],
    });
  }

  // An explicit task assessment wins over keywords in a long evidence payload.
  // Length is tracked independently and never establishes scientific difficulty.
  const complexity = Math.min(6, boundedNumber(input.complexityScore,
    promptComplexity(input.instructionPrompt ?? input.prompt)));
  const lengthBand = promptLengthBand(input);
  const retryCount = boundedNumber(input.retryCount || input.retry_count);
  const failureCategory = text(input.failureCategory || input.failure_category);
  const scientificStakes = text(input.scientificStakes || input.scientific_stakes);
  let model = baseModelFor({ role, complexity, actionType: input.actionType || input.action_type });
  reasons.push(`${role || "unspecified"} base route`, `${lengthBand} prompt`, `complexity ${complexity}`);

  if (lengthBand === "long" && model === "gpt-6-luna") {
    model = "gpt-6.1-terra";
    reasons.push("long prompt avoids the lightweight route");
  }
  if (lengthBand === "long" && model === "gpt-6.1-terra" && complexity >= 4) {
    model = "gpt-6.2-sol";
    reasons.push("long complex prompt needs deeper synthesis");
  }

  const astraEligible = isCandidateSynthesis({
    role,
    actionType: input.actionType || input.action_type,
    prompt: input.prompt,
    candidateCount: input.candidateCount || input.candidate_count,
    scientificStakes,
  }) || isDecisiveAdjudication({
    role,
    actionType: input.actionType || input.action_type,
    scientificStakes,
    adjudicationRequired: input.adjudicationRequired || input.adjudication_required,
  });
  if (astraEligible && complexity >= 4) {
    model = "gpt-6.2-astra";
    reasons.push("reserved Astra route for candidate synthesis or decisive adjudication");
  }

  // Transport, context limits and invalid schema configuration do not establish
  // a model-quality failure. Repair/compact those without buying a higher tier.
  if (retryCount >= 2 && /invalid_structured_output|schema_response_invalid|schema_validation_failed/.test(failureCategory)) {
    const upgraded = promote(model);
    if (upgraded !== "gpt-6.2-astra" || astraEligible) {
      model = upgraded;
      reasons.push(`retry ${retryCount} after ${failureCategory || "structured failure"}`);
    }
  }
  if (/timeout|context_window|context_length/.test(failureCategory)) {
    reasons.push("preserve model; repair runtime or compact context before retry");
  }
  if (/quota|rate_limit|rate limit/.test(failureCategory)) {
    model = demote(model);
    reasons.push(`availability fallback after ${failureCategory}`);
  }

  const fallbackChain = CODEX_LADDER
    .filter((candidate) => candidate !== model)
    .filter((candidate) => !ASTRA_MODELS.includes(candidate) || astraEligible)
    .filter((candidate) => CODEX_LADDER.indexOf(candidate) < rung(model))
    .reverse();
  return route({
    model,
    reasoningEffort: input.reasoningEffort || effortFor(model),
    reasons,
    fallbackChain,
  });
}

module.exports = {
  ROUTE_VERSION,
  CODEX_LADDER,
  CODEX_MODELS,
  NON_CODEX_RUNTIME_MODELS,
  chooseModelRoute,
  promptComplexity,
  promptLengthBand,
};
