"""Explicit, Luna-only access to a paid model API for research drivers.

Ordinary child processes receive ``research_api_environment(os.environ)``.
The retained OpenAI credential is reserved for deliberate calls to this helper.
The transport argument exists for offline tests and must be trusted code.
"""

import json
import math
import os
from urllib import error, request


RESEARCH_API_MODEL = "gpt-5.6-luna"
RESEARCH_API_ENDPOINT = "https://api.openai.com/v1/responses"
MAX_RESPONSE_BYTES = 16 * 1024 * 1024

# Keep the native research-process environment policy in sync with these names.
LLM_PROVIDER_CREDENTIAL_KEYS = frozenset({
    "RESEARCHLAB_LUNA_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY",
    "OPENAI_ACCESS_TOKEN", "AZURE_OPENAI_API_KEY", "AZURE_API_KEY",
    "AZURE_OPENAI_AD_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "GOOGLE_API_KEY", "GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY", "MISTRAL_API_KEY", "COHERE_API_KEY", "CO_API_KEY",
    "XAI_API_KEY", "DEEPSEEK_API_KEY", "TOGETHER_API_KEY", "TOGETHERAI_API_KEY",
    "FIREWORKS_API_KEY", "PERPLEXITY_API_KEY", "OPENROUTER_API_KEY",
    "REPLICATE_API_TOKEN", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
    "HUGGINGFACEHUB_API_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
    "CEREBRAS_API_KEY", "SAMBANOVA_API_KEY", "AI21_API_KEY",
    "NVIDIA_API_KEY", "DATABRICKS_TOKEN", "LITELLM_API_KEY",
})
LLM_PROVIDER_CONFIGURATION_KEYS = frozenset({
    "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_TYPE", "OPENAI_API_VERSION",
    "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT_ID", "OPENAI_PROJECT",
    "AZURE_OPENAI_ENDPOINT", "ANTHROPIC_BASE_URL", "LITELLM_PROXY_API_BASE",
    "RESEARCHLAB_API_MODEL",
})


class ResearchAPIError(RuntimeError):
    """A sanitized research API failure; transport details are never surfaced."""


def _api_key(environ):
    upper = {key.upper(): value for key, value in environ.items()}
    return upper.get("RESEARCHLAB_LUNA_API_KEY") or upper.get("OPENAI_API_KEY")


def research_api_environment(environ):
    """Copy an environment, reserving its OpenAI key for this helper only.

    This is a subprocess hygiene policy, not a sandbox against code that
    intentionally reads credentials and implements its own network client.
    The caller's mapping and process-global environment are never modified.
    """
    key = _api_key(environ)
    removed = LLM_PROVIDER_CREDENTIAL_KEYS | LLM_PROVIDER_CONFIGURATION_KEYS
    copied = {name: value for name, value in environ.items() if name.upper() not in removed}
    if key:
        copied["RESEARCHLAB_LUNA_API_KEY"] = key
    copied["RESEARCHLAB_API_MODEL"] = RESEARCH_API_MODEL
    return copied


class _RejectRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ResearchAPIError("Research API redirects are prohibited.")


def _default_transport(req, timeout):
    # Never forward an Authorization header through a redirect.
    return request.build_opener(_RejectRedirect()).open(req, timeout=timeout)


def create_response(
    input_text,
    *,
    model=RESEARCH_API_MODEL,
    instructions=None,
    max_output_tokens=2048,
    timeout=60,
    transport=None,
    environ=None,
):
    """POST text to Responses using the exact permitted model.

    Endpoints, providers, headers, tools, and arbitrary payload overrides are
    intentionally absent. No model fallback or transport retry is performed.
    Credentials are read at call time and never included in returned errors.
    """
    if not isinstance(model, str) or model != RESEARCH_API_MODEL:
        raise ValueError("Research model API calls require exactly gpt-5.6-luna.")
    if not isinstance(input_text, str) or not input_text.strip():
        raise ValueError("Research API input must be nonempty text.")
    if instructions is not None and not isinstance(instructions, str):
        raise ValueError("Research API instructions must be text.")
    if type(max_output_tokens) is not int or max_output_tokens < 1:
        raise ValueError("max_output_tokens must be a positive integer.")
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise ValueError("timeout must be a positive finite number.")

    key = _api_key(os.environ if environ is None else environ)
    if not isinstance(key, str) or not key or any(character.isspace() for character in key):
        raise ResearchAPIError("A valid research OpenAI credential is required.")

    payload = {
        "model": RESEARCH_API_MODEL,
        "input": input_text,
        "max_output_tokens": max_output_tokens,
        "store": False,
    }
    if instructions is not None:
        payload["instructions"] = instructions
    req = request.Request(
        RESEARCH_API_ENDPOINT,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
        method="POST",
    )
    response = None
    try:
        response = (transport or _default_transport)(req, timeout=timeout)
        if response.geturl() != RESEARCH_API_ENDPOINT or 300 <= response.status < 400:
            raise ResearchAPIError("Research API redirects are prohibited.")
        if not 200 <= response.status < 300:
            raise ResearchAPIError("Research API request failed.")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ResearchAPIError("Research API response exceeded the size limit.")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ResearchAPIError("Research API returned an invalid response.")
        return result
    except error.HTTPError as exc:
        if 300 <= exc.code < 400:
            raise ResearchAPIError("Research API redirects are prohibited.") from None
        raise ResearchAPIError("Research API request failed.") from None
    except ResearchAPIError:
        raise
    except Exception:
        # Providers can echo request bodies, headers, or credentials in errors.
        raise ResearchAPIError("Research API request failed.") from None
    finally:
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
