from __future__ import annotations

import datetime as dt
import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.analysis import python_stats  # noqa: E402
from drivers.literature import search as literature_search  # noqa: E402


class PythonStatsExternalAgentTest(unittest.TestCase):
    def _run_mandatory_omics_repo_fixture(self, summary_payload):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "input.csv").write_text(
                "gene_symbol,S1,S2,H1,H2\n"
                "COL1A1,10,12,2,3\n"
                "MMP9,8,9,1,1\n"
                "ACTB,5,5,5,5\n",
                encoding="utf-8",
            )

            tool_dir = root / "real-omics-repo"
            tool_dir.mkdir()
            summary_json = json.dumps(summary_payload)
            (tool_dir / "agent.py").write_text(
                textwrap.dedent(
                    f"""
                    import json
                    import os
                    import sys
                    from pathlib import Path

                    if "--smoke" in sys.argv:
                        print(json.dumps({{"status": "ok", "repo_native_workflows": ["fixture-workflow"]}}))
                        raise SystemExit(0)

                    out = Path(os.environ["RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR"])
                    out.mkdir(parents=True, exist_ok=True)
                    workflow = out / "repo_workflows" / "fixture-workflow"
                    workflow.mkdir(parents=True, exist_ok=True)
                    (workflow / "result.json").write_text(json.dumps({{"effect": 2.5}}), encoding="utf-8")
                    (workflow / "table.csv").write_text("metric,value\\neffect,2.5\\n", encoding="utf-8")
                    (workflow / "figure.png").write_bytes(b"png")
                    summary = json.loads({summary_json!r})
                    (out / "external_repository_agent_summary.json").write_text(json.dumps(summary), encoding="utf-8")
                    (out / "external_repository_workflow_result.json").write_text(json.dumps(summary), encoding="utf-8")
                    print(json.dumps(summary))
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            blueprint_code = textwrap.dedent(
                """
                import json
                import os

                print(json.dumps({
                    "check_id": os.environ["RESEARCHLAB_CHECK_ID"],
                    "pass_fail": "pass",
                    "method_appropriateness_score": 95,
                    "analysis_accuracy_score": 95,
                    "checks": {"blueprint_completed": True},
                }))
                """
            ).strip()

            selected_agent = {
                "name": "fixture/omics-repo",
                "url": "https://example.invalid/fixture-omics-repo",
                "license": "MIT",
                "domain": "omics_or_high_dimensional_expression",
                "fit_score": 95,
                "reuse_decision": "reuse",
                "source_kind": "external_repository",
                "download_command": "git clone https://example.invalid/fixture-omics-repo",
                "download_verified": True,
                "local_path": str(tool_dir),
                "repository_local_path": str(tool_dir),
                "smoke_test_command": "python3 agent.py --smoke",
                "application_command": "python3 agent.py --apply",
                "expected_outputs": [
                    "external_repository_agent_summary.json",
                    "external_repository_workflow_result.json",
                ],
                "debug_attempts": [],
                "evidence": "fixture external omics repository",
                "reason": "fixture real repository",
            }
            role_plan = {
                "cycle_id": "cycle-real-omics-agent",
                "role": "lab-runner",
                "planner_metadata": {
                    "open_source_analysis_agent_mandate": {
                        "mandatory": True,
                        "large_scale_omics_rule": "omics/high-dimensional data require a real external repository workflow",
                    },
                    "analyst_handoff": {
                        "summary": "omics gene expression validation",
                        "primary_hypothesis_id": "hyp-omics-real-repo",
                        "dataset_root": str(csv_root),
                        "candidate_primary_families": [
                            {
                                "family": "gene expression signature",
                                "why_competitive": "omics fixture",
                                "priority": "high",
                            }
                        ],
                        "dataset_profile": {
                            "modality_hints": ["omics_or_high_dimensional_expression"]
                        },
                        "open_source_agent_discovery": {
                            "mandatory": True,
                            "repository_agent_required": True,
                            "query_log": ["fixture external repo"],
                            "candidates": [selected_agent],
                            "selected_agent": selected_agent,
                            "rejection_summary": "",
                        },
                        "selected_open_source_analysis_agent": selected_agent,
                        "handoff_checks": [
                            {
                                "check_id": "real_repo_agent_check",
                                "goal": "fixture",
                                "dataset": "input.csv",
                                "outcome": "S1",
                                "exposures": ["S2"],
                                "adjustment_set": [],
                                "fixed_effects": [],
                                "sample_filters": [],
                                "model_family": "external-agent",
                                "success_criteria": {},
                                "failure_criteria": [],
                            }
                        ],
                        "validation_code_blueprints": [
                            {
                                "blueprint_id": "bp_real_repo_agent",
                                "check_id": "real_repo_agent_check",
                                "language": "python",
                                "entrypoint": "script.py",
                                "code": blueprint_code,
                                "dependencies": [],
                                "execution_notes": [],
                                "review_focus": [],
                                "review_status": "ready_for_runner",
                            }
                        ],
                    },
                },
            }
            role_plan_path = root / "role-plan.json"
            role_plan_path.write_text(json.dumps(role_plan), encoding="utf-8")
            task_path = root / "task.md"
            task_path.write_text("run real omics repository agent", encoding="utf-8")
            return python_stats.run_driver(csv_root, root / "outputs", task_path, role_plan_path)

    def test_runs_selected_open_source_agent_after_blueprints_can_see_artifacts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "input.csv").write_text(
                "sample,condition,value\n"
                "a,control,1.0\n"
                "b,control,2.0\n"
                "c,treatment,4.0\n"
                "d,treatment,5.0\n",
                encoding="utf-8",
            )

            tool_dir = root / "tool"
            tool_dir.mkdir()
            (tool_dir / "agent.py").write_text(
                textwrap.dedent(
                    """
                    import csv
                    import json
                    import os
                    import sys
                    from pathlib import Path

                    if "--smoke" in sys.argv:
                        print("fixture analysis agent ready")
                        raise SystemExit(0)

                    rows = list(csv.DictReader((Path(os.environ["RESEARCHLAB_CSV_ROOT"]) / "input.csv").open()))
                    by_group = {}
                    for row in rows:
                        by_group.setdefault(row["condition"], []).append(float(row["value"]))
                    means = {k: sum(v) / len(v) for k, v in by_group.items()}
                    effect = means["treatment"] - means["control"]
                    output_root = Path(os.environ["RESEARCHLAB_OUTPUT_DIR"])
                    artifact = next(output_root.rglob("blueprint-effect.csv"))
                    out = Path(os.environ["RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR"]) / "agent-output.json"
                    out.write_text(json.dumps({"means": means, "effect": effect, "artifact": str(artifact)}), encoding="utf-8")
                    print(json.dumps({"effect": effect}))
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            blueprint_code = textwrap.dedent(
                """
                import json
                import os
                from pathlib import Path

                output_dir = Path(os.environ["RESEARCHLAB_OUTPUT_DIR"])
                (output_dir / "blueprint-effect.csv").write_text(
                    "metric,value\\nblueprint_effect,1.000\\n",
                    encoding="utf-8",
                )
                print(json.dumps({
                    "check_id": os.environ["RESEARCHLAB_CHECK_ID"],
                    "pass_fail": "pass",
                    "method_appropriateness_score": 90,
                    "analysis_accuracy_score": 90,
                    "correlations": {"blueprint_effect": 1.0},
                    "checks": {"blueprint_completed_before_external_agent": True},
                }))
                """
            ).strip()

            role_plan = {
                "cycle_id": "cycle-external-agent",
                "role": "lab-runner",
                "planner_metadata": {
                    "analyst_handoff": {
                        "summary": "apply selected external analysis agent",
                        "primary_hypothesis_id": "hyp-fixture-agent",
                        "dataset_root": str(csv_root),
                        "candidate_primary_families": [
                            {
                                "family": "fixture_external_agent",
                                "why_competitive": "external agent computes the effect",
                                "priority": "high",
                            }
                        ],
                        "candidate_estimands": ["treatment mean difference"],
                        "open_source_agent_discovery": {
                            "query_log": ["fixture local repo"],
                            "candidates": [
                                {
                                    "name": "fixture analysis agent",
                                    "url": "https://example.invalid/fixture-agent",
                                    "license": "MIT",
                                    "domain": "tabular analysis",
                                    "fit_score": 95,
                                    "reuse_decision": "adapt",
                                    "local_path": str(tool_dir),
                                    "smoke_test_command": "python3 agent.py --smoke",
                                    "application_command": "python3 agent.py --apply",
                                    "expected_outputs": ["agent-output.json"],
                                    "debug_attempts": [],
                                    "evidence": "fixture agent reads the selected dataset and writes an effect estimate",
                                }
                            ],
                            "selected_agent": {
                                "name": "fixture analysis agent",
                                "url": "https://example.invalid/fixture-agent",
                                "reuse_decision": "adapt",
                                "local_path": str(tool_dir),
                                "reason": "best fixture match",
                            },
                            "rejection_summary": "",
                        },
                        "selected_open_source_analysis_agent": {
                            "name": "fixture analysis agent",
                            "url": "https://example.invalid/fixture-agent",
                            "reuse_decision": "adapt",
                            "local_path": str(tool_dir),
                            "reason": "best fixture match",
                        },
                        "handoff_checks": [
                            {
                                "check_id": "agent_effect_check",
                                "goal": "verify external agent produced an effect",
                                "dataset": "input.csv",
                                "outcome": "value",
                                "exposures": ["condition"],
                                "adjustment_set": [],
                                "fixed_effects": [],
                                "sample_filters": [],
                                "model_family": "external-agent",
                                "success_criteria": {
                                    "expected_sign": "positive",
                                    "p_value_max": 1,
                                    "minimum_effect_description": "effect > 0",
                                },
                                "failure_criteria": ["missing external agent output"],
                            }
                        ],
                        "validation_code_blueprints": [
                            {
                                "blueprint_id": "bp_agent_effect",
                                "check_id": "agent_effect_check",
                                "language": "python",
                                "entrypoint": "script.py",
                                "code": blueprint_code,
                                "dependencies": [],
                                "execution_notes": ["reads external agent output"],
                                "review_focus": ["external agent application"],
                                "review_status": "ready_for_runner",
                            }
                        ],
                    }
                },
            }
            role_plan_path = root / "role-plan.json"
            role_plan_path.write_text(json.dumps(role_plan), encoding="utf-8")
            task_path = root / "task.md"
            task_path.write_text("run selected external analysis agent", encoding="utf-8")
            output_dir = root / "outputs"

            result = python_stats.run_driver(csv_root, output_dir, task_path, role_plan_path)

            runs = result["external_agent_runs"]
            self.assertEqual([run["stage"] for run in runs], ["smoke_test", "application"])
            self.assertTrue(all(run["status"] == "completed" for run in runs))
            self.assertEqual(result["validation_summary"]["external_agent_runs_passed"], 2)
            self.assertEqual(result["validation_summary"]["overall_status"], "passed")
            trace_started_at = dt.datetime.strptime(
                result["analysis_trace"]["started_at"], "%Y-%m-%dT%H:%M:%SZ"
            )
            self.assertGreaterEqual(trace_started_at.year, 2024)
            self.assertEqual(
                result["blueprint_executions"][0]["metrics"]["checks"]["blueprint_completed_before_external_agent"],
                True,
            )
            self.assertTrue(
                (output_dir / "external-agents" / "fixture-analysis-agent" / "agent-output.json").is_file()
            )
            agent_payload = json.loads(
                (output_dir / "external-agents" / "fixture-analysis-agent" / "agent-output.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertTrue(agent_payload["artifact"].endswith("blueprint-effect.csv"))

    def test_mandatory_omics_generic_adapter_does_not_satisfy_repository_agent_gate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            csv_root = root / "dataset"
            csv_root.mkdir()
            (csv_root / "input.csv").write_text(
                "gene_symbol,S1,S2,H1,H2\n"
                "COL1A1,10,12,2,3\n"
                "MMP9,8,9,1,1\n",
                encoding="utf-8",
            )

            tool_dir = root / "generic-adapter"
            tool_dir.mkdir()
            (tool_dir / "open_source_workflow_adapter.py").write_text(
                textwrap.dedent(
                    """
                    import json
                    import os
                    import sys
                    from pathlib import Path

                    if "--smoke" in sys.argv:
                        print(json.dumps({"status": "ok"}))
                    else:
                        out = Path(os.environ["RESEARCHLAB_EXTERNAL_AGENT_OUTPUT_DIR"])
                        out.mkdir(parents=True, exist_ok=True)
                        summary = {"status": "completed", "files_profiled": 1}
                        (out / "open_source_workflow_summary.json").write_text(
                            json.dumps(summary), encoding="utf-8"
                        )
                        print(json.dumps(summary))
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            blueprint_code = textwrap.dedent(
                """
                import json
                import os

                print(json.dumps({
                    "check_id": os.environ["RESEARCHLAB_CHECK_ID"],
                    "pass_fail": "pass",
                    "method_appropriateness_score": 95,
                    "analysis_accuracy_score": 95,
                    "checks": {"blueprint_completed": True},
                }))
                """
            ).strip()

            role_plan = {
                "cycle_id": "cycle-generic-omics-agent",
                "role": "lab-runner",
                "planner_metadata": {
                    "open_source_analysis_agent_mandate": {
                        "mandatory": True,
                        "large_scale_omics_rule": "omics/high-dimensional data require a real external repository workflow",
                    },
                    "analyst_handoff": {
                        "summary": "omics gene expression validation",
                        "primary_hypothesis_id": "hyp-omics-generic",
                        "dataset_root": str(csv_root),
                        "candidate_primary_families": [
                            {
                                "family": "gene expression signature",
                                "why_competitive": "omics fixture",
                                "priority": "high",
                            }
                        ],
                        "dataset_profile": {
                            "modality_hints": ["omics_or_high_dimensional_expression"]
                        },
                        "open_source_agent_discovery": {
                            "mandatory": True,
                            "repository_agent_required": True,
                            "query_log": ["fixture generic adapter"],
                            "candidates": [
                                {
                                    "name": "python-open-source-workflow-adapter",
                                    "url": "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
                                    "license": "BSD",
                                    "domain": "omics_or_high_dimensional_expression",
                                    "fit_score": 78,
                                    "reuse_decision": "adapt",
                                    "source_kind": "generic_package_adapter",
                                    "download_command": "No git clone required",
                                    "local_path": str(tool_dir),
                                    "smoke_test_command": "python3 open_source_workflow_adapter.py --smoke",
                                    "application_command": "python3 open_source_workflow_adapter.py --apply",
                                    "expected_outputs": [],
                                    "debug_attempts": [],
                                    "evidence": "generic adapter fixture",
                                }
                            ],
                            "selected_agent": {
                                "name": "python-open-source-workflow-adapter",
                                "url": "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
                                "reuse_decision": "adapt",
                                "local_path": str(tool_dir),
                                "smoke_test_command": "python3 open_source_workflow_adapter.py --smoke",
                                "application_command": "python3 open_source_workflow_adapter.py --apply",
                                "reason": "generic fixture",
                            },
                            "rejection_summary": "",
                        },
                        "selected_open_source_analysis_agent": {
                            "name": "python-open-source-workflow-adapter",
                            "url": "https://pandas.pydata.org/; https://numpy.org/; https://scikit-learn.org/",
                            "reuse_decision": "adapt",
                            "local_path": str(tool_dir),
                            "smoke_test_command": "python3 open_source_workflow_adapter.py --smoke",
                            "application_command": "python3 open_source_workflow_adapter.py --apply",
                            "reason": "generic fixture",
                        },
                        "handoff_checks": [
                            {
                                "check_id": "generic_agent_check",
                                "goal": "fixture",
                                "dataset": "input.csv",
                                "outcome": "S1",
                                "exposures": ["S2"],
                                "adjustment_set": [],
                                "fixed_effects": [],
                                "sample_filters": [],
                                "model_family": "external-agent",
                                "success_criteria": {},
                                "failure_criteria": [],
                            }
                        ],
                        "validation_code_blueprints": [
                            {
                                "blueprint_id": "bp_generic_agent",
                                "check_id": "generic_agent_check",
                                "language": "python",
                                "entrypoint": "script.py",
                                "code": blueprint_code,
                                "dependencies": [],
                                "execution_notes": [],
                                "review_focus": [],
                                "review_status": "ready_for_runner",
                            }
                        ],
                    },
                },
            }
            role_plan_path = root / "role-plan.json"
            role_plan_path.write_text(json.dumps(role_plan), encoding="utf-8")
            task_path = root / "task.md"
            task_path.write_text("run generic omics selected agent", encoding="utf-8")
            output_dir = root / "outputs"

            result = python_stats.run_driver(csv_root, output_dir, task_path, role_plan_path)

            self.assertEqual(result["validation_summary"]["overall_status"], "degraded")
            self.assertFalse(
                result["validation_summary"]["checks"]["open_source_repository_agent_applied"]
            )
            self.assertTrue(
                result["validation_summary"]["open_source_agent_requirements"]["repository_agent_required"]
            )
            self.assertFalse(
                result["validation_summary"]["open_source_agent_requirements"]["repository_agent_applied"]
            )
            workflow_summary = result["validation_summary"]["open_source_agent_requirements"][
                "external_agent_workflow_summaries"
            ][0]
            self.assertTrue(workflow_summary["summary_path"].endswith("open_source_workflow_summary.json"))
            self.assertTrue(Path(workflow_summary["summary_path"]).is_file())

    def test_mandatory_omics_real_repo_profile_only_does_not_satisfy_gate(self):
        result = self._run_mandatory_omics_repo_fixture(
            {
                "status": "completed",
                "agent_name": "fixture/omics-repo",
                "substantive_repository_workflow_applied": False,
                "repo_workflow_runs": [
                    {
                        "workflow_name": "fixture inventory/profile only",
                        "status": "completed",
                        "substantive": False,
                        "reason": "profiled CSV columns but did not run a repository-native workflow",
                    }
                ],
                "substantive_workflow_blockers": [
                    "CSV profiling alone is insufficient for mandatory omics validation"
                ],
            }
        )

        summary = result["validation_summary"]
        self.assertEqual(summary["overall_status"], "inconclusive")
        self.assertTrue(summary["open_source_agent_requirements"]["repository_agent_application_completed"])
        self.assertFalse(summary["open_source_agent_requirements"]["substantive_repository_workflow_applied"])
        self.assertFalse(summary["checks"]["open_source_repository_workflow_applied"])
        self.assertIn("open_source_repository_workflow_applied", summary["failed_checks"])

    def test_mandatory_omics_blocked_repo_workflow_does_not_satisfy_gate(self):
        result = self._run_mandatory_omics_repo_fixture(
            {
                "status": "completed",
                "agent_name": "fixture/omics-repo",
                "substantive_repository_workflow_applied": False,
                "repo_workflow_runs": [
                    {
                        "workflow_name": "fixture repository-native workflow",
                        "status": "blocked",
                        "substantive": False,
                        "reason": "selected dataset lacks the columns required by the native workflow",
                    }
                ],
                "substantive_workflow_blockers": [
                    "selected dataset lacks the columns required by the native workflow"
                ],
            }
        )

        summary = result["validation_summary"]
        self.assertEqual(summary["overall_status"], "inconclusive")
        self.assertTrue(summary["open_source_agent_requirements"]["repository_agent_applied"])
        self.assertTrue(summary["open_source_agent_requirements"]["repository_workflow_blocked_resolved"])
        self.assertFalse(summary["open_source_agent_requirements"]["substantive_repository_workflow_applied"])
        self.assertFalse(summary["checks"]["open_source_repository_workflow_applied"])
        self.assertIn("open_source_repository_workflow_applied", summary["failed_checks"])

    def test_mandatory_omics_real_repo_substantive_workflow_satisfies_gate(self):
        result = self._run_mandatory_omics_repo_fixture(
            {
                "status": "completed",
                "agent_name": "fixture/omics-repo",
                "substantive_repository_workflow_applied": True,
                "repo_workflow_runs": [
                    {
                        "workflow_name": "fixture repository-native workflow",
                        "status": "completed",
                        "substantive": True,
                        "figures": ["repo_workflows/fixture-workflow/figure.png"],
                        "tables": ["repo_workflows/fixture-workflow/table.csv"],
                        "result_json": "repo_workflows/fixture-workflow/result.json",
                    }
                ],
                "substantive_workflow_outputs": [
                    {
                        "workflow_name": "fixture repository-native workflow",
                        "figures": ["repo_workflows/fixture-workflow/figure.png"],
                        "tables": ["repo_workflows/fixture-workflow/table.csv"],
                        "result_json": "repo_workflows/fixture-workflow/result.json",
                    }
                ],
                "substantive_workflow_blockers": [],
            }
        )

        summary = result["validation_summary"]
        self.assertEqual(summary["overall_status"], "passed")
        self.assertTrue(summary["open_source_agent_requirements"]["repository_agent_applied"])
        self.assertTrue(summary["open_source_agent_requirements"]["substantive_repository_workflow_applied"])
        self.assertTrue(summary["checks"]["open_source_repository_workflow_applied"])

    def test_valid_falsification_result_preserves_method_scores(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:audit",
            check_id="audit-check",
            status="completed",
            script_path=None,
            output_dir="audit-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "method_appropriateness_score": 96,
                "analysis_accuracy_score": 94,
                "valid_falsification_result": True,
                "checks": {
                    "model_executed": True,
                    "scientific_claim_supported": False,
                },
            },
            figures=[],
            tables=[],
            error=None,
        )

        summary = python_stats._validation_summary([execution], {"primary_hypothesis_id": "hyp-audit"})

        self.assertEqual(summary["overall_status"], "inconclusive")
        self.assertEqual(summary["failed_checks"], ["scientific_claim_supported"])
        self.assertEqual(summary["method_appropriateness_score"], 96)
        self.assertEqual(summary["analysis_accuracy_score"], 94)

    def test_analyst_quality_standard_blocks_promotion_until_satisfied(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:quality",
            check_id="quality-check",
            status="completed",
            script_path=None,
            output_dir="quality-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "pass_fail": "inconclusive",
                "method_appropriateness_score": 72,
                "analysis_accuracy_score": 91,
                "checks": {"model_executed": True},
            },
            figures=[],
            tables=[],
            error=None,
        )

        summary = python_stats._validation_summary(
            [execution],
            {
                "primary_hypothesis_id": "hyp-quality",
                "analyst_quality_standard": {
                    "minimum_blueprints_passed": 1,
                    "require_no_blueprint_failures": True,
                    "require_all_handoff_checks_pass": False,
                    "require_all_handoff_checks_resolved": True,
                    "required_validation_checks": ["model_executed", "sensitivity_passed"],
                    "minimum_method_appropriateness_score": 80,
                    "minimum_analysis_accuracy_score": 80,
                    "allow_inconclusive_for_gate_review": False,
                    "rationale": "Analyst requires method quality and sensitivity before gate review.",
                },
            },
        )

        self.assertEqual(summary["overall_status"], "degraded")
        self.assertFalse(summary["analyst_quality_standard"]["satisfied"])
        self.assertIn("required_validation_check:sensitivity_passed", summary["analyst_quality_standard"]["failed_requirements"])
        self.assertIn("minimum_method_appropriateness_score", summary["analyst_quality_standard"]["failed_requirements"])
        self.assertIn("handoff_check_unresolved:quality-check", summary["analyst_quality_standard"]["failed_requirements"])
        self.assertIn("analyst_quality_standard_satisfied", summary["failed_checks"])

    def test_master_table_gate_blocks_validation_until_artifact_exists(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:validate",
            check_id="hypothesis-check",
            status="completed",
            script_path=None,
            output_dir="validation-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "method_appropriateness_score": 91,
                "analysis_accuracy_score": 90,
                "checks": {"scientific_claim_supported": True},
            },
            figures=[],
            tables=[],
            error=None,
        )

        summary = python_stats._validation_summary(
            [execution],
            {
                "primary_hypothesis_id": "hyp-master-table",
                "analysis_master_table": {
                    "row_grain": "one sample segment",
                    "required_columns": ["cohort", "patient_id", "program_score"],
                    "output_path": "blueprints/master-table/analysis_master_table.csv",
                },
            },
        )

        self.assertEqual(summary["overall_status"], "inconclusive")
        self.assertFalse(summary["analysis_master_table_gate"]["satisfied"])
        self.assertIn("analysis_master_table_gate_satisfied", summary["failed_checks"])
        self.assertEqual(python_stats._quality_gates(summary)["analysis_master_table_gate"]["status"], "blocked")

    def test_master_table_gate_passes_with_metric_and_table_artifact(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:master-table",
            check_id="analysis_master_table_created",
            status="completed",
            script_path=None,
            output_dir="master-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "method_appropriateness_score": 91,
                "analysis_accuracy_score": 90,
                "checks": {"analysis_master_table_created": True},
            },
            figures=[],
            tables=[
                {
                    "blueprint_id": "blueprint:master-table",
                    "check_id": "analysis_master_table_created",
                    "path": "master-output/analysis_master_table.csv",
                    "name": "analysis_master_table.csv",
                    "kind": "table",
                    "suffix": ".csv",
                    "size_bytes": 128,
                }
            ],
            error=None,
        )

        summary = python_stats._validation_summary(
            [execution],
            {
                "primary_hypothesis_id": "hyp-master-table",
                "analysis_master_table": {
                    "row_grain": "one sample segment",
                    "required_columns": ["cohort", "patient_id", "program_score"],
                },
            },
        )

        self.assertTrue(summary["analysis_master_table_gate"]["satisfied"])
        self.assertTrue(summary["checks"]["analysis_master_table_gate_satisfied"])
        self.assertNotIn("analysis_master_table_gate_satisfied", summary["failed_checks"])
        self.assertEqual(python_stats._quality_gates(summary)["analysis_master_table_gate"]["status"], "passed")

    def test_generated_master_table_blueprint_parses_geo_series_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            dataset = root / "expression.csv"
            metadata = root / "GSE_fixture_series_matrix.txt"
            output_dir = root / "blueprint-output"
            check_file = root / "check.json"
            dataset.write_text(
                "TargetName,SLE_Control HD A,SLE Mild B\n"
                "IFIT1,10,25\n"
                "CXCL10,7,18\n",
                encoding="utf-8",
            )
            metadata.write_text(
                '!Sample_title\t"SLE_Control HD A"\t"SLE Mild B"\n'
                '!Sample_geo_accession\t"GSM000001"\t"GSM000002"\n'
                '!Sample_characteristics_ch1\t"cohort: SLE_Control"\t"cohort: SLE"\n'
                '!Sample_characteristics_ch1\t"disease_activity: HD"\t"disease_activity: Mild"\n',
                encoding="utf-8",
            )
            check_file.write_text(
                json.dumps(
                    {
                        "check_id": "analysis_master_table_created",
                        "dataset_path": str(dataset),
                        "expression_matrix_path": str(dataset),
                        "sample_metadata_path": str(metadata),
                    }
                ),
                encoding="utf-8",
            )
            script = root / "master_table_blueprint.py"
            script.write_text(literature_search._analysis_master_table_blueprint_code(), encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--csv-root",
                    str(root),
                    "--output-dir",
                    str(output_dir),
                    "--check-file",
                    str(check_file),
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            metrics = json.loads(completed.stdout.strip().splitlines()[-1])
            self.assertTrue(metrics["checks"]["analysis_master_table_created"])
            table = output_dir / "analysis_master_table.csv"
            self.assertTrue(table.is_file())
            text = table.read_text(encoding="utf-8")
            self.assertIn("cohort", text)
            self.assertIn("expression_feature_count", text)

    def test_analyst_quality_standard_accepts_valid_falsification_as_resolved(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:falsify",
            check_id="falsification-check",
            status="completed",
            script_path=None,
            output_dir="falsify-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "pass_fail": "fail",
                "valid_falsification_result": True,
                "method_score_independent_of_pass_fail": True,
                "method_appropriateness_score": 92,
                "analysis_accuracy_score": 90,
                "checks": {},
            },
            figures=[],
            tables=[],
            error=None,
        )

        summary = python_stats._validation_summary(
            [execution],
            {
                "primary_hypothesis_id": "hyp-falsify",
                "analyst_quality_standard": {
                    "minimum_blueprints_passed": 1,
                    "require_no_blueprint_failures": True,
                    "require_all_handoff_checks_pass": False,
                    "require_all_handoff_checks_resolved": True,
                    "required_validation_checks": [],
                    "minimum_method_appropriateness_score": 80,
                    "minimum_analysis_accuracy_score": 80,
                    "allow_inconclusive_for_gate_review": True,
                    "rationale": "Valid falsification resolves the check even though it does not support the hypothesis.",
                },
            },
        )

        self.assertTrue(summary["handoff_check_resolutions"][0]["resolved"])
        self.assertTrue(summary["analyst_quality_standard"]["satisfied"])
        self.assertNotIn("analyst_quality_standard_satisfied", summary["failed_checks"])

    def test_analyst_quality_standard_accepts_explicit_data_blocker_as_resolved(self):
        execution = python_stats.BlueprintExecution(
            blueprint_id="blueprint:blocker",
            check_id="schema-blocked-check",
            status="completed",
            script_path=None,
            output_dir="blocker-output",
            stdout_path="stdout.log",
            stderr_path="stderr.log",
            timeout_seconds=60,
            duration_seconds=0.1,
            return_code=0,
            metrics={
                "pass_fail": "inconclusive",
                "resolution_status": "schema_blocked",
                "method_appropriateness_score": 88,
                "analysis_accuracy_score": 87,
                "notes": "Required subject-level outcome is absent from available metadata; escalate rather than rerun.",
                "checks": {"binary_outcome_inferred": False},
            },
            figures=[],
            tables=[],
            error=None,
        )

        summary = python_stats._validation_summary(
            [execution],
            {
                "primary_hypothesis_id": "hyp-blocked",
                "analyst_quality_standard": {
                    "minimum_blueprints_passed": 1,
                    "require_no_blueprint_failures": True,
                    "require_all_handoff_checks_pass": False,
                    "require_all_handoff_checks_resolved": True,
                    "required_validation_checks": [],
                    "minimum_method_appropriateness_score": None,
                    "minimum_analysis_accuracy_score": None,
                    "allow_inconclusive_for_gate_review": False,
                    "rationale": "A documented schema blocker resolves the handoff for LabDirector escalation.",
                },
            },
        )

        self.assertEqual(summary["handoff_check_resolutions"][0]["resolution_status"], "schema_blocked")
        self.assertTrue(summary["handoff_check_resolutions"][0]["resolved"])
        self.assertTrue(summary["analyst_quality_standard"]["satisfied"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
