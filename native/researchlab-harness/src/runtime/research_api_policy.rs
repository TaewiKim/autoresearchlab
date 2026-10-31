//! Process-boundary policy for paid research API credentials and CLI auth.

use std::ffi::{OsStr, OsString};
use std::process::Command;

pub(crate) const RESEARCH_API_MODEL: &str = "gpt-6-luna";
const PROVIDER_KEYS: &[&str] = &[
    "RESEARCHLAB_LUNA_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ADMIN_KEY",
    "OPENAI_ACCESS_TOKEN",
    "AZURE_OPENAI_API_KEY",
    "AZURE_API_KEY",
    "AZURE_OPENAI_AD_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "COHERE_API_KEY",
    "CO_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "TOGETHER_API_KEY",
    "TOGETHERAI_API_KEY",
    "FIREWORKS_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENROUTER_API_KEY",
    "REPLICATE_API_TOKEN",
    "HF_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CEREBRAS_API_KEY",
    "SAMBANOVA_API_KEY",
    "AI21_API_KEY",
    "NVIDIA_API_KEY",
    "DATABRICKS_TOKEN",
    "LITELLM_API_KEY",
];
const PROVIDER_CONFIG: &[&str] = &[
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_API_TYPE",
    "OPENAI_API_VERSION",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT_ID",
    "OPENAI_PROJECT",
    "AZURE_OPENAI_ENDPOINT",
    "ANTHROPIC_BASE_URL",
    "LITELLM_PROXY_API_BASE",
    "RESEARCHLAB_API_MODEL",
];

fn is_provider_name(name: &OsStr) -> bool {
    let upper = name.to_string_lossy().to_ascii_uppercase();
    PROVIDER_KEYS
        .iter()
        .chain(PROVIDER_CONFIG)
        .any(|item| *item == upper)
}

fn luna_key(vars: &[(OsString, OsString)]) -> Option<OsString> {
    let mut openai = None;
    for (name, value) in vars {
        match name.to_string_lossy().to_ascii_uppercase().as_str() {
            "RESEARCHLAB_LUNA_API_KEY" if !value.is_empty() => return Some(value.clone()),
            "OPENAI_API_KEY" => openai = Some(value.clone()),
            _ => {}
        }
    }
    openai
}

fn apply_environment(command: &mut Command, expose_luna: bool) {
    let parent: Vec<_> = std::env::vars_os().collect();
    let key = expose_luna.then(|| luna_key(&parent));
    command.env_clear();
    for (name, value) in parent {
        if !is_provider_name(&name) {
            command.env(name, value);
        }
    }
    if let Some(Some(value)) = key {
        command.env("RESEARCHLAB_LUNA_API_KEY", value);
    }
    // The model marker is deterministic even when no credential is available;
    // drivers can fail clearly without inheriting an accidental provider.
    if expose_luna {
        command.env("RESEARCHLAB_API_MODEL", RESEARCH_API_MODEL);
    }
}

pub(crate) fn apply_research_driver_environment(command: &mut Command) {
    apply_environment(command, true);
}

pub(crate) fn apply_cli_environment(command: &mut Command) {
    apply_environment(command, false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_names_are_case_insensitive_and_parent_values_are_available_for_remap() {
        let vars = vec![
            (OsString::from("PATH"), OsString::from("keep")),
            (OsString::from("openai_api_key"), OsString::from("secret")),
            (
                OsString::from("Anthropic_Api_Key"),
                OsString::from("secret2"),
            ),
        ];
        assert_eq!(luna_key(&vars), Some(OsString::from("secret")));
        assert!(is_provider_name(OsStr::new("OPENAI_API_KEY")));
        assert!(!is_provider_name(OsStr::new("PATH")));
    }

    #[test]
    fn research_driver_always_declares_luna_model() {
        let mut command = Command::new("research-driver-test");
        apply_research_driver_environment(&mut command);
        let envs: Vec<_> = command.get_envs().collect();
        assert!(envs.iter().any(|(name, value)| {
            name == &OsStr::new("RESEARCHLAB_API_MODEL")
                && value.and_then(|v| v.to_str()) == Some(RESEARCH_API_MODEL)
        }));
    }
}
