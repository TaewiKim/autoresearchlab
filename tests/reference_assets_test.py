import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "fetch_reference_assets", Path(__file__).resolve().parents[1] / "drivers" / "reference" / "fetch_reference_assets.py"
)
fetch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fetch)


class ValidateItem(unittest.TestCase):
    def test_only_https_on_the_allowlisted_host_for_the_kind(self):
        ok = {"kind": "git", "url": "https://github.com/real-stanford/diffusion_policy"}
        self.assertIsNone(fetch.validate_item(ok))
        self.assertIsNone(fetch.validate_item({"kind": "hf", "url": "https://huggingface.co/lerobot/diffusion_pusht"}))
        for bad in (
            {"kind": "git", "url": "http://github.com/a/b"},
            {"kind": "git", "url": "https://evil.example/a/b"},
            {"kind": "git", "url": "https://github.com.evil.example/a/b"},
            {"kind": "git", "url": "https://github.com/onlyowner"},
            {"kind": "hf", "url": "https://github.com/a/b"},
            {"kind": "curl", "url": "https://github.com/a/b"},
            {"kind": "git", "url": "file:///etc/passwd"},
        ):
            self.assertIsNotNone(fetch.validate_item(bad), bad)

    def test_names_cannot_climb_out_of_the_root(self):
        self.assertEqual(fetch.safe_name("../../etc/passwd"), "etc-passwd")
        self.assertEqual(fetch.safe_name(".."), "asset")


class Main(unittest.TestCase):
    def test_a_rejected_item_is_recorded_and_the_run_still_finishes(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            plan = tmp / "plan.json"
            plan.write_text(json.dumps({"items": [{"id": "git:x/y", "kind": "git", "url": "https://evil.example/x/y", "name": "y"}]}))
            state = tmp / "state.json"
            code = fetch.main(["--plan-file", str(plan), "--root", str(tmp / "ref"), "--state-file", str(state)])
            self.assertEqual(code, 0)
            data = json.loads(state.read_text())
            self.assertEqual(data["status"], "partial")
            self.assertEqual(data["items"][0]["status"], "rejected")
            self.assertIn("allowlist", data["items"][0]["error"])
            self.assertFalse((tmp / "ref" / "repos").exists())

    def test_an_item_already_cloned_is_present_not_fetched_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            repo = tmp / "ref" / "repos" / "y"
            (repo / ".git").mkdir(parents=True)
            state = fetch.State(tmp / "state.json", [{"id": "git:x/y", "kind": "git", "url": "https://github.com/x/y"}])
            result = fetch.fetch_git({"name": "y", "url": "https://github.com/x/y"}, tmp / "ref", state)
            self.assertEqual(result["status"], "present")


if __name__ == "__main__":
    unittest.main()
