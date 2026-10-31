"""The research paid-model boundary must fail closed without network access."""

import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from urllib import error

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
sys.path.insert(0, str(PROJECT / "drivers" / "analysis"))
import research_llm as llm
from drivers.analysis.python_stats_lib import blueprint_run, external_agent
from drivers.analysis.python_stats_lib.blueprint_model import Blueprint


class FakeResponse(io.BytesIO):
    def __init__(self, body=b'{"id":"offline-result","output":[]}', status=200, url=llm.RESEARCH_API_ENDPOINT):
        super().__init__(body)
        self.status = status
        self.url = url

    def geturl(self):
        return self.url


class ResearchLLMPolicyTest(unittest.TestCase):
    def test_default_luna_is_forwarded_to_fixed_endpoint(self):
        transport = Mock(return_value=FakeResponse())
        result = llm.create_response(
            "Compare the falsifiable predictions.", instructions="Cite evidence.",
            max_output_tokens=256, environ={"OPENAI_API_KEY": "test-secret"}, transport=transport,
        )
        req = transport.call_args.args[0]
        self.assertEqual(req.full_url, "https://api.openai.com/v1/responses")
        self.assertEqual(req.method, "POST")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-secret")
        self.assertEqual(json.loads(req.data), {
            "model": "gpt-6-luna", "input": "Compare the falsifiable predictions.",
            "instructions": "Cite evidence.", "max_output_tokens": 256, "store": False,
        })
        self.assertEqual(result["id"], "offline-result")
        self.assertNotIn("test-secret", json.dumps(result))
        transport.assert_called_once()

    def test_other_models_are_rejected_before_transport_or_credentials(self):
        for model in ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-6-luna-2026-09-06",
                      " gpt-6-luna", "gpt-6-luna ", "GPT-6-LUNA", "other", None]:
            with self.subTest(model=model):
                transport = Mock()
                with self.assertRaisesRegex(ValueError, "exactly gpt-6-luna"):
                    llm.create_response("Test", model=model, environ={}, transport=transport)
                transport.assert_not_called()

    def test_request_override_surfaces_are_unavailable(self):
        for name, value in {
            "endpoint": "https://other.invalid", "base_url": "https://other.invalid",
            "headers": {"Authorization": "other"}, "provider": "other",
            "tools": [{"type": "image_generation"}], "extra_body": {"model": "gpt-6-astra"},
        }.items():
            with self.subTest(name=name), self.assertRaises(TypeError):
                llm.create_response("Test", **{name: value})

    def test_redirects_and_changed_final_urls_are_rejected(self):
        for status, url in [(302, llm.RESEARCH_API_ENDPOINT), (200, "https://other.invalid")]:
            with self.subTest(status=status, url=url):
                transport = Mock(return_value=FakeResponse(status=status, url=url))
                with self.assertRaisesRegex(llm.ResearchAPIError, "redirects are prohibited"):
                    llm.create_response("Test", environ={"OPENAI_API_KEY": "test-secret"}, transport=transport)
                transport.assert_called_once()

    def test_urllib_redirect_handler_does_not_follow_redirects(self):
        with self.assertRaisesRegex(llm.ResearchAPIError, "redirects are prohibited"):
            llm._RejectRedirect().redirect_request(None, None, 302, "Found", {}, "https://other.invalid")

    def test_transport_errors_never_expose_credentials_or_fallback(self):
        for failure in [
            OSError("Authorization: Bearer test-secret"),
            error.HTTPError(llm.RESEARCH_API_ENDPOINT, 401, "test-secret", {}, None),
            error.HTTPError(llm.RESEARCH_API_ENDPOINT, 307, "test-secret", {}, None),
        ]:
            with self.subTest(failure=type(failure).__name__):
                transport = Mock(side_effect=failure)
                with self.assertRaises(llm.ResearchAPIError) as caught:
                    llm.create_response("Test", environ={"OPENAI_API_KEY": "test-secret"}, transport=transport)
                self.assertNotIn("test-secret", str(caught.exception))
                transport.assert_called_once()

    def test_credentials_are_read_at_call_time_and_reserved_key_wins(self):
        transport = Mock(side_effect=lambda req, timeout: FakeResponse())
        with patch.dict(os.environ, {"RESEARCHLAB_LUNA_API_KEY": "first-key"}, clear=True):
            llm.create_response("Test", transport=transport)
        with patch.dict(os.environ, {"RESEARCHLAB_LUNA_API_KEY": "second-key", "OPENAI_API_KEY": "ignored-key"}, clear=True):
            llm.create_response("Test", transport=transport)
        self.assertEqual([call.args[0].get_header("Authorization") for call in transport.call_args_list],
                         ["Bearer first-key", "Bearer second-key"])

    def test_environment_cannot_override_model_or_endpoint(self):
        transport = Mock(return_value=FakeResponse())
        llm.create_response("Test", transport=transport, environ={
            "OPENAI_API_KEY": "test-secret", "RESEARCHLAB_API_MODEL": "gpt-6-astra",
            "OPENAI_BASE_URL": "https://other.invalid", "OPENAI_API_BASE": "https://other.invalid",
        })
        req = transport.call_args.args[0]
        self.assertEqual(req.full_url, llm.RESEARCH_API_ENDPOINT)
        self.assertEqual(json.loads(req.data)["model"], llm.RESEARCH_API_MODEL)

    def test_absent_or_malformed_credentials_fail_before_transport(self):
        for environ in [{}, {"OPENAI_API_KEY": "bad\ncredential"}]:
            with self.subTest(environ=environ):
                transport = Mock()
                with self.assertRaises(llm.ResearchAPIError):
                    llm.create_response("Test", environ=environ, transport=transport)
                transport.assert_not_called()

    def test_environment_preserves_nonmodel_settings_and_never_mutates_parent(self):
        original = {
            "OPENAI_API_KEY": "test-secret", "ANTHROPIC_API_KEY": "anthropic-secret",
            "gemini_api_key": "gemini-secret", "HF_TOKEN": "hf-secret",
            "OPENAI_BASE_URL": "https://other.invalid", "RESEARCHLAB_API_MODEL": "gpt-6-astra",
            "PATH": "original-path", "RESEARCHLAB_CYCLE_ID": "cycle", "SCOPUS_API_KEY": "literature-key",
        }
        before = original.copy()
        result = llm.research_api_environment(original)
        self.assertEqual(original, before)
        self.assertEqual(result, {
            "RESEARCHLAB_LUNA_API_KEY": "test-secret", "RESEARCHLAB_API_MODEL": "gpt-6-luna",
            "PATH": "original-path", "RESEARCHLAB_CYCLE_ID": "cycle", "SCOPUS_API_KEY": "literature-key",
        })
        self.assertIsNot(result, original)
        self.assertEqual(llm.research_api_environment(result), result)

    def test_environment_without_key_does_not_create_credentials(self):
        self.assertEqual(llm.research_api_environment({"PATH": "x"}),
                         {"PATH": "x", "RESEARCHLAB_API_MODEL": "gpt-6-luna"})

    def test_all_common_model_credentials_are_removed(self):
        original = {name: "credential" for name in llm.LLM_PROVIDER_CREDENTIAL_KEYS}
        result = llm.research_api_environment(original)
        self.assertEqual(set(result), {"RESEARCHLAB_LUNA_API_KEY", "RESEARCHLAB_API_MODEL"})


class ResearchChildEnvironmentTest(unittest.TestCase):
    def test_blueprint_child_uses_reserved_key_and_copied_helper(self):
        code = textwrap.dedent("""
            import json
            import os
            import research_llm
            assert "OPENAI_API_KEY" not in os.environ
            assert "ANTHROPIC_API_KEY" not in os.environ
            assert "OPENAI_BASE_URL" not in os.environ
            assert bool(os.environ.get("RESEARCHLAB_LUNA_API_KEY"))
            assert os.environ["RESEARCHLAB_API_MODEL"] == research_llm.RESEARCH_API_MODEL
            print(json.dumps({"child_policy_passed": True}))
        """)
        blueprint = Blueprint("api-environment", "api-environment", code, None, None, None)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            "OPENAI_API_KEY": "fake-research-key", "ANTHROPIC_API_KEY": "fake-other-key",
            "OPENAI_BASE_URL": "https://other.invalid",
        }):
            before = dict(os.environ)
            root = Path(tmp)
            execution = blueprint_run._run_blueprint(
                blueprint, csv_root=root, output_root=root, timeout_seconds=30,
                derived_indicators_for_blueprint=[],
            )
            self.assertEqual(execution.status, "completed", execution.error)
            self.assertEqual(dict(os.environ), before)
            self.assertTrue((Path(execution.output_dir) / "research_llm.py").is_file())
            self.assertNotIn("fake-research-key", Path(execution.stdout_path).read_text(encoding="utf-8"))
            self.assertNotIn("fake-research-key", Path(execution.stderr_path).read_text(encoding="utf-8"))

    def test_external_workflow_receives_sanitized_copy_and_helper_import_path(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
            "OPENAI_API_KEY": "fake-research-key", "GEMINI_API_KEY": "fake-other-key",
            "PYTHONPATH": "existing-import-path", "RESEARCHLAB_KEEP": "preserved",
        }):
            before = dict(os.environ)
            root = Path(tmp)
            completed = subprocess.CompletedProcess("offline fixture", 0, stdout="", stderr="")
            with patch.object(external_agent.subprocess, "run", return_value=completed) as run:
                execution = external_agent._run_external_agent_command(
                    agent_name="offline", stage="application", command_text="offline fixture",
                    cwd=root, csv_root=root, output_root=root, timeout_seconds=30, spec={},
                )
            child_env = run.call_args.kwargs["env"]
            self.assertEqual(execution.status, "completed")
            self.assertEqual(dict(os.environ), before)
            self.assertNotIn("OPENAI_API_KEY", child_env)
            self.assertNotIn("GEMINI_API_KEY", child_env)
            self.assertTrue(child_env.get("RESEARCHLAB_LUNA_API_KEY"))
            self.assertEqual(child_env["RESEARCHLAB_API_MODEL"], "gpt-6-luna")
            self.assertEqual(child_env["RESEARCHLAB_KEEP"], "preserved")
            helper_dir = str(PROJECT / "drivers" / "analysis")
            self.assertEqual(child_env["PYTHONPATH"], helper_dir + os.pathsep + "existing-import-path")
            # A real Python child in an unrelated repository can import the
            # helper through the exact environment passed to the shell workflow.
            probe = subprocess.run(
                [sys.executable, "-c", "import research_llm; print(research_llm.RESEARCH_API_MODEL)"],
                env=child_env, cwd=root, capture_output=True, text=True, check=True,
            )
            self.assertEqual(probe.stdout.strip(), "gpt-6-luna")

    def test_driver_modules_import_with_both_entrypoint_layouts(self):
        for path, package in [(PROJECT, "drivers.analysis.python_stats_lib"),
                              (PROJECT / "drivers" / "analysis", "python_stats_lib")]:
            with self.subTest(package=package), tempfile.TemporaryDirectory() as tmp:
                env = llm.research_api_environment(os.environ)
                env["PYTHONPATH"] = str(path)
                probe = subprocess.run(
                    [sys.executable, "-c", f"from {package} import blueprint_run, external_agent"],
                    env=env, cwd=tmp, capture_output=True, text=True,
                )
                self.assertEqual(probe.returncode, 0, probe.stderr)


if __name__ == "__main__":
    unittest.main()
