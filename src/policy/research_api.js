"use strict";

const RESEARCH_API_MODEL = "gpt-5.6-luna";
const RESEARCH_API_POLICY = Object.freeze({
  policy_version: "research-api-luna-only-v1",
  allowed_models: Object.freeze([RESEARCH_API_MODEL]),
  fallback_models: Object.freeze([]),
  provider: "openai",
  endpoint: "https://api.openai.com/v1/responses",
  helper: "drivers/analysis/research_llm.py",
  codex_authentication: "chatgpt",
});

// Keep aligned with drivers/analysis/research_llm.py and the native policy.
const MODEL_ENV_KEYS = new Set([
  "RESEARCHLAB_LUNA_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENAI_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY", "AZURE_API_KEY", "AZURE_OPENAI_AD_TOKEN", "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN", "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "CO_API_KEY", "XAI_API_KEY",
  "DEEPSEEK_API_KEY", "TOGETHER_API_KEY", "TOGETHERAI_API_KEY", "FIREWORKS_API_KEY",
  "PERPLEXITY_API_KEY", "OPENROUTER_API_KEY", "REPLICATE_API_TOKEN", "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACEHUB_API_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  "CEREBRAS_API_KEY", "SAMBANOVA_API_KEY", "AI21_API_KEY", "NVIDIA_API_KEY",
  "DATABRICKS_TOKEN", "LITELLM_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "OPENAI_API_TYPE", "OPENAI_API_VERSION", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT_ID", "OPENAI_PROJECT", "AZURE_OPENAI_ENDPOINT", "ANTHROPIC_BASE_URL",
  "LITELLM_PROXY_API_BASE", "RESEARCHLAB_API_MODEL",
]);

function assertResearchApiModel(model) {
  if (model !== RESEARCH_API_MODEL) throw new Error("Research model API calls require exactly gpt-5.6-luna.");
  return model;
}

function codexSubscriptionEnvironment(environ = process.env) {
  const output = Object.fromEntries(Object.entries(environ).filter(([key]) => !MODEL_ENV_KEYS.has(key.toUpperCase())));
  output.RESEARCHLAB_API_MODEL = RESEARCH_API_MODEL;
  return output;
}

function usesDirectModelApi(input = {}) {
  return [input.billingMode, input.billing_mode, input.authentication, input.runtime, input.runtimeClass, input.runtime_class]
    .some((value) => ["api", "direct-api", "model-api", "api-key", "api_key"].includes(String(value || "").toLowerCase()));
}

const RESEARCH_API_INSTRUCTION = "Research model API policy: direct paid model calls must use drivers/analysis/research_llm.py with exactly gpt-5.6-luna. Other models/providers and automatic model fallback are prohibited. Codex CLI uses ChatGPT authentication and retains its subscription model routing. Literature metadata APIs are outside this model restriction.";

module.exports = { RESEARCH_API_MODEL, RESEARCH_API_POLICY, RESEARCH_API_INSTRUCTION, MODEL_ENV_KEYS, assertResearchApiModel, codexSubscriptionEnvironment, usesDirectModelApi };
