#!/usr/bin/env python3
"""Deep reading: full text by arXiv ID, open-source assets, local copies.

The SOTA deep-read scout (labdirector::sota_cards) reads the landscape's best
papers in full and records what they ship. These tests pin the driver side:
the arXiv transport fix, the endpoints the approved policy admits for it, the
full-text extraction and cache the harness re-hashes, and the asset resolver's
choice of the paper's OWN code over what it merely cites. All offline.
"""
import base64
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import zlib
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature.search_lib import assets, fulltext, http_client, local_assets

POLICY = http_client.APPROVED_SCHOLARLY_METADATA_POLICY

LATEXML = """<html><body><article class="ltx_document">
<h1 class="ltx_title ltx_title_document">OctoNet: A Generalist Policy</h1>
<div class="ltx_abstract"><h6>Abstract</h6><p>We present OctoNet, code at
<a href="https://github.com/octonet-models/octonet">github.com/octonet-models/octonet</a>.</p></div>
<section id="S1"><h2><span class="ltx_tag">1 </span>Introduction</h2>
<p>OctoNet-Base (93M parameters) outperforms RT-2-X, a 55 billion parameter model, with loss <math alttext="\\mathcal{L}_{2}"><mi>L</mi></math> only.</p></section>
<section id="S4"><h2>4 Experiments</h2>
<section id="S4.SS2"><h3>4.2 Ablations</h3>
<figure class="ltx_table" id="S4.T3"><figcaption><span class="ltx_tag">Table 3: </span>Ablation of the action head.</figcaption>
<table><tr><td>Method</td><td>Success</td></tr>
<tr><td>OctoNet</td><td>0.91</td></tr></table></figure>
<p>Removing the diffusion head reduces success to 0.62 on the WidowX tasks.</p>
</section></section>
<section id="A2"><h2>Appendix B Training details</h2><p>We train on 8 A100 GPUs.</p></section>
<section id="S9"><h2>IV Discussion</h2><p>%s</p></section>
</article></body></html>""" % ("Long discussion text. " * 250)


class TransportTest(unittest.TestCase):
    def test_the_tls_client_hello_carries_no_post_handshake_auth(self):
        # arXiv's edge answers export.arxiv.org searches from urllib's default
        # context (post_handshake_auth on) with 406; see http_client._tls_context.
        context = http_client._tls_context()
        self.assertFalse(context.post_handshake_auth)
        self.assertIs(http_client._tls_context(), context)

    def test_policy_admits_deep_read_endpoints_and_nothing_wider(self):
        validate = http_client.validate_approved_scholarly_metadata_request
        allowed = [
            "https://arxiv.org/html/2303.04137",
            "https://arxiv.org/html/2303.04137v2",
            "https://arxiv.org/pdf/2303.04137",
            "https://ar5iv.labs.arxiv.org/html/2109.11978",
            "https://api.github.com/repos/real-stanford/diffusion_policy",
            "https://api.github.com/repos/real-stanford/diffusion_policy/readme",
            "https://api.github.com/repos/real-stanford/diffusion_policy/contents/",
            "https://api.github.com/repos/real-stanford/diffusion_policy/commits/main",
            "https://api.github.com/search/repositories?q=diffusion+policy+in%3Aname&sort=stars&order=desc&per_page=10",
            "https://huggingface.co/api/models/openvla/openvla-7b",
            "https://huggingface.co/api/datasets/lerobot/pusht",
            "https://huggingface.co/api/models?filter=arxiv%3A2406.09246&sort=downloads&direction=-1&limit=20",
        ]
        for url in allowed:
            with self.subTest(url=url):
                validate(url)
        refused = [
            "https://api.github.com/user",
            "https://api.github.com/repos/a/b/git/blobs/abc",
            "https://api.github.com/repos/a/b/zipball/main",
            "https://api.github.com/search/code?q=secret",
            "https://huggingface.co/api/whoami-v2",
            "https://huggingface.co/openvla/openvla-7b/resolve/main/model.safetensors",
            "https://arxiv.org/html/2303.04137?download=1",
            "https://github.com/real-stanford/diffusion_policy",
        ]
        for url in refused:
            with self.subTest(url=url):
                with self.assertRaises(http_client.LiteratureNetworkPolicyError):
                    validate(url)

    def test_bytes_fetch_goes_through_the_same_policy_path(self):
        with mock.patch.dict(os.environ, {"RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}), \
             mock.patch.object(http_client, "_open_request") as opened:
            with self.assertRaises(http_client.LiteratureNetworkPolicyError):
                http_client.fetch_bytes("https://example.org/paper.pdf")
        opened.assert_not_called()


class FulltextTest(unittest.TestCase):
    def test_latexml_text_keeps_sections_tables_math_and_links(self):
        result = fulltext.extract_latexml_html(LATEXML)
        numbers = [section["number"] for section in result["sections"] if section["number"]]
        self.assertEqual(numbers, ["1", "4", "4.2", "B", "IV"])
        self.assertEqual([label["label"] for label in result["labels"]], ["Table 3"])
        text = result["text"]
        self.assertIn("| OctoNet | 0.91", text)          # a results row stays one line
        self.assertIn("\\mathcal{L}_{2}", text)           # math keeps its LaTeX
        self.assertIn("## 4.2 Ablations", text)
        self.assertIn("https://github.com/octonet-models/octonet", result["links"])

    def test_fetch_falls_back_to_ar5iv_caches_with_its_hash_and_detects_tampering(self):
        calls = []

        def fetch(url):
            calls.append(url)
            if url.startswith("https://arxiv.org/html/"):
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            if url.startswith("https://ar5iv.labs.arxiv.org/"):
                return LATEXML.encode("utf-8")
            raise AssertionError(url)

        with tempfile.TemporaryDirectory() as root:
            manifest = fulltext.fetch_fulltext("arXiv:2109.11978v1", root=root, fetch=fetch)
            self.assertEqual(manifest["source_kind"], "ar5iv-html")
            self.assertEqual(manifest["source_url"], "https://ar5iv.labs.arxiv.org/html/2109.11978v1")
            text_path = Path(root) / "2109.11978" / "fulltext.txt"
            self.assertEqual(manifest["sha256"], fulltext._sha256(text_path.read_bytes()))
            self.assertEqual(manifest["attempts"][0]["status"], 404)
            again = fulltext.fetch_fulltext("2109.11978", root=root, fetch=fetch)
            self.assertTrue(again["cache_hit"])
            self.assertEqual(len(calls), 2)
            text_path.write_text("edited", encoding="utf-8")
            self.assertIsNone(fulltext.load_fulltext("2109.11978", root))

    def test_a_paper_no_source_renders_reports_every_attempt(self):
        def fetch(url):
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError) as raised:
                fulltext.fetch_fulltext("2401.00001", root=root, fetch=fetch)
        report = json.loads(str(raised.exception))
        self.assertEqual([attempt["kind"] for attempt in report["attempts"]], ["arxiv-html", "ar5iv-html", "arxiv-pdf"])

    def test_stdlib_pdf_fallback_reads_flate_text_streams(self):
        content = zlib.compress(b"BT /F1 10 Tf (Diffusion Policy outperforms) Tj T* [(base)-300(lines)] TJ ET")
        pdf = (b"%PDF-1.5\n4 0 obj\n<< /Length " + str(len(content)).encode() + b" /Filter /FlateDecode >>\nstream\n"
               + content + b"endstream\nendobj\n")
        self.assertEqual(fulltext._pdf_text_stdlib(pdf), "Diffusion Policy outperforms\nbase lines")

    def test_ids_normalise(self):
        self.assertEqual(fulltext.normalize_arxiv_id("https://arxiv.org/abs/2303.04137v3"), ("2303.04137", "v3"))
        self.assertEqual(fulltext.normalize_arxiv_id("arXiv:2406.09246"), ("2406.09246", None))
        # How a landscape cites an arXiv paper: its DataCite DOI.
        self.assertEqual(fulltext.normalize_arxiv_id("doi:10.48550/arxiv.2406.09246"), ("2406.09246", None))
        with self.assertRaises(ValueError):
            fulltext.normalize_arxiv_id("10.1145/123")


def _github_record(full_name, stars, fork=False, parent=None):
    record = {"full_name": full_name, "html_url": f"https://github.com/{full_name}", "stargazers_count": stars,
              "forks_count": 1, "pushed_at": "2025-01-01T00:00:00Z", "default_branch": "main", "archived": False,
              "license": {"spdx_id": "MIT", "name": "MIT License"}, "fork": fork, "description": "x", "name": full_name.split("/")[1]}
    if parent:
        record["parent"] = record["source"] = {"full_name": parent}
    return record


README = """# OctoNet
## Installation
```bash
pip install -e .
```
## Evaluation
```
(octo)[octonet]$ python eval.py --checkpoint hf://octonet-models/octonet-base
```
Pretrained weights: https://storage.example.org/octonet/ckpt.tar and a demo https://colab.research.google.com/x
We fine-tune with LoRA on a single RTX 4090.
"""


class AssetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        fulltext.fetch_fulltext("2405.99999", root=self.root, fetch=lambda url: LATEXML.encode("utf-8"))
        self.requests = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, responses):
        def fetch(url, headers):
            self.requests.append((url, headers))
            for prefix, payload in responses.items():
                if url.startswith(prefix):
                    if isinstance(payload, int):
                        raise urllib.error.HTTPError(url, payload, "err", {}, None)
                    return json.dumps(payload)
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return fetch

    def test_name_keys_come_from_the_title_head_and_coined_names(self):
        self.assertEqual(assets.name_keys("OpenVLA: An Open-Source Vision-Language-Action Model"), ["openvla"])
        self.assertEqual(assets.name_keys("Demonstrating GPU Parallelized Robot Simulation with ManiSkill3"), ["maniskill3", "maniskill"])
        self.assertEqual(assets.name_queries("Diffusion Policy: Visuomotor Policy Learning")["diffusionpolicy"], "Diffusion Policy")

    def test_a_cited_repository_or_a_paper_list_is_not_the_papers_code(self):
        text = ("Our code is at https://github.com/octonet-models/octonet . " + "x " * 3000
                + "We compare with https://github.com/google/brax and https://github.com/someone/awesome-octonet")
        ranked = assets.repo_candidates(text, [], ["octonet"], None)
        self.assertEqual(ranked[0]["repo"], "octonet-models/octonet")
        scores = {entry["repo"]: entry["score"] for entry in ranked}
        self.assertLess(scores["google/brax"], assets.OFFICIAL_SCORE)
        self.assertLess(scores["someone/awesome-octonet"], 0)

    def test_the_readme_entry_point_is_a_command_that_runs_the_method(self):
        entry = assets.reproduction_entry(README, "https://github.com/octonet-models/octonet")
        self.assertEqual(entry["readme_section"], "Evaluation")
        self.assertEqual(entry["commands"], ["python eval.py --checkpoint hf://octonet-models/octonet-base"])

    def test_a_parameter_count_counts_only_next_to_the_papers_own_name(self):
        text = "OctoNet-Base (93M parameters) beats RT-2-X, a 55 billion parameter model."
        vram = assets.estimate_vram(text, [], None, ["octonet"])
        self.assertEqual(vram["params"], 93_000_000)
        self.assertLess(vram["min_vram_gb_eval"], 2)

    def test_resolve_assets_offline_records_every_lookup(self):
        responses = {
            "https://api.github.com/repos/octonet-models/octonet/commits/": {"sha": "abc123"},
            "https://api.github.com/repos/octonet-models/octonet/readme": {"content": base64.b64encode(README.encode()).decode()},
            "https://api.github.com/repos/octonet-models/octonet/contents/": [{"name": "setup.py"}, {"name": "README.md"}],
            "https://api.github.com/repos/octonet-models/octonet": _github_record("octonet-models/octonet", 1500),
            "https://huggingface.co/api/models/octonet-models/octonet-base": {
                "id": "octonet-models/octonet-base", "usedStorage": 800_000_000, "cardData": {"license": "mit"},
                "safetensors": {"total": 93_000_000}, "downloads": 10},
            "https://huggingface.co/api/models?": [{"id": "stranger/octonet-test", "downloads": 3}, {"id": "unrelated/model", "downloads": 9999}],
            "https://huggingface.co/api/datasets?": [],
        }
        lookups = assets.AssetLookups(fetch=self.fake(responses), use_cache=False)
        inventory = {"repositories": [{"path": "D:/repos/octonet", "repo": "octonet-models/octonet", "methods": [], "benchmarks": []}]}
        with mock.patch.dict(os.environ, {"RESEARCHLAB_GITHUB_TOKEN": "t0ken", "RESEARCHLAB_LITERATURE_NETWORK_POLICY": POLICY}):
            result = assets.resolve_assets("2405.99999", lookups=lookups, fulltext_root=self.root, inventory=inventory)
        found = result["assets"]
        self.assertEqual(found["code"][0]["url"], "https://github.com/octonet-models/octonet")
        self.assertEqual((found["code"][0]["license"], found["code"][0]["head_sha"]), ("MIT", "abc123"))
        self.assertEqual(found["code"][0]["env_files"], ["setup.py"])
        urls = [item["url"] for item in found["checkpoints"]]
        self.assertEqual(urls[0], "https://huggingface.co/octonet-models/octonet-base")
        self.assertIn("https://storage.example.org/octonet/ckpt.tar", urls)
        self.assertNotIn("https://huggingface.co/unrelated/model", urls)          # tagged, but not this paper's
        self.assertFalse(any("colab" in url for url in urls))
        self.assertEqual(found["local_copy_path"], "D:/repos/octonet")
        self.assertEqual(found["min_vram_gb_train"], 24)                         # LoRA on a 4090, known to suffice
        self.assertEqual(found["none_found"], ["datasets"])
        self.assertIn("datasets", {search["kind"] for search in found["searches_tried"]})
        self.assertTrue(all(headers is None for _, headers in self.requests), "no header leaves under the policy")

    def test_a_rate_limited_github_is_recorded_not_read_as_no_code(self):
        responses = {"https://api.github.com/": 403}
        lookups = assets.AssetLookups(fetch=self.fake(responses), use_cache=False)
        result = assets.resolve_assets("2405.99999", lookups=lookups, fulltext_root=self.root, inventory={"repositories": []})
        searches = result["assets"]["searches_tried"]
        self.assertTrue(any(search.get("status") == 403 for search in searches))
        self.assertTrue(lookups.github_budget_exhausted)
        self.assertTrue(any(search.get("status") == "skipped" for search in searches) or len(
            [s for s in searches if s["source"] == "api.github.com"]) == 1)


class LocalInventoryTest(unittest.TestCase):
    def test_inventory_reads_git_metadata_and_names_methods(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repos" / "lerobot"
            (repo / ".git" / "refs" / "heads").mkdir(parents=True)
            (repo / ".git" / "config").write_text('[remote "origin"]\n\turl = https://github.com/huggingface/lerobot.git\n')
            (repo / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
            (repo / ".git" / "refs" / "heads" / "main").write_text("e40b58a\n")
            (repo / "src" / "policies" / "diffusion").mkdir(parents=True)
            (repo / "README.md").write_text("# LeRobot\nTrain on Push-T and LIBERO. Push-T again. LIBERO again.")
            inventory = local_assets.build_local_asset_inventory([str(Path(tmp) / "repos")])
        entry = inventory["repositories"][0]
        self.assertEqual((entry["repo"], entry["head_sha"]), ("huggingface/lerobot", "e40b58a"))
        self.assertIn("Diffusion Policy", [method["name"] for method in entry["methods"]])
        self.assertEqual({bench["name"] for bench in entry["benchmarks"]}, {"Push-T", "LIBERO"})
        matched = local_assets.match_local_assets(inventory, ["https://github.com/real-stanford/diffusion_policy"],
                                                  ["diffusionpolicy"], ["Push-T"])
        self.assertIsNone(matched["local_copy_path"])
        self.assertEqual(matched["local_related"][0]["repo"], "huggingface/lerobot")


if __name__ == "__main__":
    unittest.main()
