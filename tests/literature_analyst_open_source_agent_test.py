#!/usr/bin/env python3
import json
import subprocess
import sys
import tempfile
import unittest
import os
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature import search


class LiteratureAnalystOpenSourceAgentTest(unittest.TestCase):
    def test_mandatory_omics_handoff_rejects_generic_adapter_as_selected_agent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            previous_discovery = os.environ.get("RESEARCHLAB_ENABLE_EXTERNAL_REPO_DISCOVERY")
            os.environ["RESEARCHLAB_ENABLE_EXTERNAL_REPO_DISCOVERY"] = "0"
            self.addCleanup(
                lambda: (
                    os.environ.pop("RESEARCHLAB_ENABLE_EXTERNAL_REPO_DISCOVERY", None)
                    if previous_discovery is None
                    else os.environ.__setitem__("RESEARCHLAB_ENABLE_EXTERNAL_REPO_DISCOVERY", previous_discovery)
                )
            )
            root = Path(tmpdir)
            output_dir = root / ".research-lab" / "artifacts" / "stats" / "cycle-1" / "analyst-01"
            output_dir.mkdir(parents=True)
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            csv_path = bundle_root / "gene-expression.csv"
            csv_path.write_text(
                "gene_symbol,S1,S2,H1,H2\n"
                "COL1A1,10,12,2,3\n"
                "MMP9,8,9,1,1\n"
                "ACTB,5,5,5,5\n",
                encoding="utf-8",
            )
            role_plan = {
                "cycle_id": "cycle-1",
                "lane_id": "analyst-01",
                "planner_metadata": {
                    "require_open_source_analysis_agent_discovery": True,
                    "candidate_datasets": [
                        {
                            "bundle_path": str(bundle_root),
                            "provider": "fixture",
                            "csvs": [
                                {
                                    "name": "gene-expression",
                                    "csv_path": str(csv_path),
                                    "columns": ["gene_symbol", "S1", "S2", "H1", "H2"],
                                }
                            ],
                        }
                    ],
                },
            }
            source_stats = {
                "frontier_catalog": {
                    "primary_variable_families": [
                        {
                            "family": "gene expression signature",
                            "why_competitive": "fixture",
                            "priority": "high",
                        }
                    ]
                },
                "statistical_review_memo": {
                    "estimands": ["gene expression signature contrast"]
                },
            }

            handoff = search.build_analyst_handoff(source_stats, role_plan, output_dir=output_dir)

            self.assertEqual(handoff["status"], "ready_for_runner")
            discovery = handoff["open_source_agent_discovery"]
            selected = handoff["selected_open_source_analysis_agent"]
            self.assertTrue(discovery["mandatory"])
            self.assertTrue(discovery["repository_agent_required"])
            self.assertIsNone(selected)
            self.assertEqual(discovery["candidates"][0]["reuse_decision"], "reject")
            self.assertEqual(discovery["candidates"][0]["source_kind"], "generic_package_adapter")
            self.assertIn("real external repository", discovery["rejection_summary"])
            self.assertFalse(handoff["open_source_agent_requirement"]["generic_adapter_satisfies_requirement"])
            self.assertTrue(handoff["self_review"]["assumption_checks"])
            self.assertEqual(handoff["self_review"]["review_status"], "needs_revision")

    def test_nonmandatory_handoff_can_use_runner_executable_generic_adapter(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / ".research-lab" / "artifacts" / "stats" / "cycle-2" / "analyst-01"
            output_dir.mkdir(parents=True)
            bundle_root = root / "bundle"
            bundle_root.mkdir()
            csv_path = bundle_root / "panel.csv"
            csv_path.write_text(
                "unit,year,exposure,outcome\n"
                "a,2020,1.0,2.0\n"
                "b,2020,2.0,3.0\n",
                encoding="utf-8",
            )
            role_plan = {
                "cycle_id": "cycle-2",
                "lane_id": "analyst-01",
                "planner_metadata": {
                    "candidate_datasets": [
                        {
                            "bundle_path": str(bundle_root),
                            "provider": "fixture",
                            "csvs": [
                                {
                                    "name": "panel",
                                    "csv_path": str(csv_path),
                                    "columns": ["unit", "year", "exposure", "outcome"],
                                }
                            ],
                        }
                    ],
                },
            }
            source_stats = {
                "frontier_catalog": {
                    "primary_variable_families": [
                        {
                            "family": "exposure outcome association",
                            "why_competitive": "fixture",
                            "priority": "high",
                        }
                    ]
                },
                "statistical_review_memo": {
                    "estimands": ["exposure outcome association"]
                },
            }

            handoff = search.build_analyst_handoff(source_stats, role_plan, output_dir=output_dir)

            selected = handoff["selected_open_source_analysis_agent"]
            self.assertIsNotNone(selected)
            self.assertIn("smoke_test_command", selected)
            self.assertIn("application_command", selected)
            script = Path(selected["local_path"]) / "open_source_workflow_adapter.py"
            self.assertTrue(script.is_file())
            smoke = subprocess.run(
                ["python3", str(script), "--smoke"],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertIn('"status": "ok"', smoke.stdout)

    def test_bioskills_repository_wrapper_runs_substantive_skill_workflow(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tool_dir = root / "external-repo-gptomics-bioskills"
            repo_dir = tool_dir / "repo"
            skill_dir = repo_dir / "differential-expression" / "de-visualization"
            result_skill_dir = repo_dir / "differential-expression" / "de-results"
            skill_dir.mkdir(parents=True)
            result_skill_dir.mkdir(parents=True)
            (repo_dir / "README.md").write_text("BioSkills fixture\n", encoding="utf-8")
            (skill_dir / "SKILL.md").write_text(
                "Use volcano plots to visualize differential-expression results.\n",
                encoding="utf-8",
            )
            (result_skill_dir / "SKILL.md").write_text(
                "Rank DE genes by FDR and log2 fold change.\n",
                encoding="utf-8",
            )
            wrapper = tool_dir / "researchlab_external_repo_agent.py"
            tool_dir.mkdir(exist_ok=True)
            wrapper.write_text(search._external_repo_agent_wrapper_code().lstrip(), encoding="utf-8")
            (tool_dir / "selected-agent.json").write_text(
                json.dumps(
                    {
                        "name": "GPTomics/bioSkills",
                        "url": "https://github.com/GPTomics/bioSkills",
                        "repository_local_path": str(repo_dir),
                        "analysis_terms": ["differential expression", "gene expression"],
                    }
                ),
                encoding="utf-8",
            )

            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "svsh-diff-expression.csv").write_text(
                "gene_name,log2(fc),pval,qval\n"
                "COL1A1,2.4,0.0001,0.001\n"
                "MMP9,1.7,0.002,0.01\n"
                "ACTB,0.1,0.5,0.7\n"
                "CXCL8,-1.8,0.0004,0.004\n",
                encoding="utf-8",
            )
            output_dir = root / "outputs"

            smoke = subprocess.run(
                ["python3", str(wrapper), "--smoke"],
                cwd=tool_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            smoke_payload = json.loads(smoke.stdout)
            self.assertTrue(smoke_payload["repository_native_workflow_available"])

            completed = subprocess.run(
                [
                    "python3",
                    str(wrapper),
                    "--csv-root",
                    str(csv_root),
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=tool_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            summary = json.loads(completed.stdout)
            self.assertTrue(summary["substantive_repository_workflow_applied"])
            workflow = summary["repo_workflow_runs"][0]
            self.assertEqual(workflow["workflow_name"], "BioSkills differential-expression skill-guided workflow")
            self.assertTrue(workflow["substantive"])
            workflow_root = output_dir / "repo_workflows" / "bioskills-de-skill"
            self.assertTrue((workflow_root / "result.json").is_file())
            self.assertTrue((workflow_root / "bioskills_de_results.csv").is_file())
            self.assertTrue((workflow_root / "bioskills_volcano.html").is_file())

    def test_clawbio_wrapper_derives_de_table_from_expression_matrix(self):
        try:
            import pandas  # noqa: F401
        except Exception:
            self.skipTest("expression-matrix DE derivation requires pandas")
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tool_dir = root / "external-repo-clawbio"
            repo_dir = tool_dir / "repo"
            skill_dir = repo_dir / "skills" / "diff-visualizer"
            skill_dir.mkdir(parents=True)
            (repo_dir / "README.md").write_text("ClawBio fixture\n", encoding="utf-8")
            (repo_dir / "clawbio.py").write_text("# fixture marker\n", encoding="utf-8")
            (skill_dir / "diff_visualizer.py").write_text(
                "import argparse, json, shutil\n"
                "from pathlib import Path\n"
                "parser = argparse.ArgumentParser()\n"
                "parser.add_argument('--input', required=True)\n"
                "parser.add_argument('--output', required=True)\n"
                "args = parser.parse_args()\n"
                "out = Path(args.output)\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "shutil.copyfile(args.input, out / 'clawbio_de_results.csv')\n"
                "(out / 'volcano.html').write_text('<html>volcano</html>', encoding='utf-8')\n"
                "(out / 'result.json').write_text(json.dumps({'status': 'ok', 'source': args.input}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            wrapper = tool_dir / "researchlab_external_repo_agent.py"
            tool_dir.mkdir(exist_ok=True)
            wrapper.write_text(search._external_repo_agent_wrapper_code().lstrip(), encoding="utf-8")
            (tool_dir / "selected-agent.json").write_text(
                json.dumps(
                    {
                        "name": "ClawBio/ClawBio",
                        "url": "https://github.com/ClawBio/ClawBio",
                        "repository_local_path": str(repo_dir),
                        "analysis_terms": ["differential expression", "gene expression"],
                    }
                ),
                encoding="utf-8",
            )

            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "gse-fixture.geo-metadata.txt").write_text(
                "!Sample_title\t\"VGH001: P-MCI\"\t\"VGH002: P-MCI\"\t\"VGH003: P-MCI\"\t\"VGH004: S-MCI\"\t\"VGH005: S-MCI\"\t\"VGH006: S-MCI\"\n"
                "!Sample_characteristics_ch1\t\"disease state: P-MCI\"\t\"disease state: P-MCI\"\t\"disease state: P-MCI\"\t\"disease state: S-MCI\"\t\"disease state: S-MCI\"\t\"disease state: S-MCI\"\n",
                encoding="utf-8",
            )
            (csv_root / "gse-fixture-expression.csv").write_text(
                "gene_id,VGH001,VGH002,VGH003,VGH004,VGH005,VGH006\n"
                "GENE_A,12,11,13,2,3,2\n"
                "GENE_B,2,3,2,13,12,11\n"
                "GENE_C,5,5,6,5,6,5\n"
                "GENE_D,20,18,19,7,8,7\n",
                encoding="utf-8",
            )
            output_dir = root / "outputs"

            completed = subprocess.run(
                [
                    "python3",
                    str(wrapper),
                    "--csv-root",
                    str(csv_root),
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=tool_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            summary = json.loads(completed.stdout)
            self.assertTrue(summary["substantive_repository_workflow_applied"])
            workflow = summary["repo_workflow_runs"][0]
            self.assertEqual(workflow["workflow_name"], "ClawBio diff-visualizer")
            self.assertTrue(workflow["substantive"])
            self.assertEqual(workflow["source_table"]["status"], "derived_from_expression_matrix")
            normalized = Path(workflow["source_table"]["normalized_input"])
            self.assertTrue(normalized.is_file())
            workflow_root = output_dir / "repo_workflows" / "clawbio-diffviz"
            self.assertTrue((workflow_root / "result.json").is_file())
            self.assertTrue((workflow_root / "clawbio_de_results.csv").is_file())
            self.assertTrue((workflow_root / "volcano.html").is_file())

    def test_clawbio_wrapper_accepts_modality_specific_differential_feature_table(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            tool_dir = root / "external-repo-clawbio"
            repo_dir = tool_dir / "repo"
            skill_dir = repo_dir / "skills" / "diff-visualizer"
            skill_dir.mkdir(parents=True)
            (repo_dir / "README.md").write_text("ClawBio fixture\n", encoding="utf-8")
            (repo_dir / "clawbio.py").write_text("# fixture marker\n", encoding="utf-8")
            (skill_dir / "diff_visualizer.py").write_text(
                "import argparse, json, shutil\n"
                "from pathlib import Path\n"
                "parser = argparse.ArgumentParser()\n"
                "parser.add_argument('--input', required=True)\n"
                "parser.add_argument('--output', required=True)\n"
                "args = parser.parse_args()\n"
                "out = Path(args.output)\n"
                "out.mkdir(parents=True, exist_ok=True)\n"
                "shutil.copyfile(args.input, out / 'clawbio_feature_results.csv')\n"
                "(out / 'feature_contrast.html').write_text('<html>features</html>', encoding='utf-8')\n"
                "(out / 'result.json').write_text(json.dumps({'status': 'ok', 'source': args.input}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            wrapper = tool_dir / "researchlab_external_repo_agent.py"
            tool_dir.mkdir(exist_ok=True)
            wrapper.write_text(search._external_repo_agent_wrapper_code().lstrip(), encoding="utf-8")
            (tool_dir / "selected-agent.json").write_text(
                json.dumps(
                    {
                        "name": "ClawBio/ClawBio",
                        "url": "https://github.com/ClawBio/ClawBio",
                        "repository_local_path": str(repo_dir),
                        "analysis_terms": ["GeoMx", "program score", "differential feature"],
                    }
                ),
                encoding="utf-8",
            )

            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "geomx-program-contrast.csv").write_text(
                "program,vili_minus_aih,permutation_p,mean_score\n"
                "mitochondrial_oxidative,0.1403,0.0020,0.57\n"
                "interferon,-0.1155,0.0259,0.42\n"
                "generic_inflammation,0.0180,0.4200,0.49\n",
                encoding="utf-8",
            )
            output_dir = root / "outputs"

            completed = subprocess.run(
                [
                    "python3",
                    str(wrapper),
                    "--csv-root",
                    str(csv_root),
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=tool_dir,
                capture_output=True,
                text=True,
                check=True,
            )
            summary = json.loads(completed.stdout)
            self.assertTrue(summary["substantive_repository_workflow_applied"])
            workflow = summary["repo_workflow_runs"][0]
            self.assertEqual(workflow["workflow_name"], "ClawBio diff-visualizer")
            self.assertTrue(workflow["substantive"])
            self.assertEqual(workflow["source_table"]["input_table_semantics"], "modality_specific_differential_feature_table")
            normalized = Path(workflow["source_table"]["normalized_input"])
            normalized_text = normalized.read_text(encoding="utf-8")
            self.assertIn("mitochondrial_oxidative", normalized_text)
            self.assertIn("interferon", normalized_text)
            self.assertIn("not asserted to be gene-level DE", workflow["source_table"]["derivation_note"])
            workflow_root = output_dir / "repo_workflows" / "clawbio-diffviz"
            self.assertTrue((workflow_root / "result.json").is_file())
            self.assertTrue((workflow_root / "clawbio_feature_results.csv").is_file())
            self.assertTrue((workflow_root / "feature_contrast.html").is_file())


if __name__ == "__main__":
    unittest.main()
