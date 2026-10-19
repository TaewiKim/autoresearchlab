"""Tests for the analyst-handoff `pick_dataset_for_hypothesis` shim
in ``drivers.literature.search.build_analyst_handoff``.

External-driver analyst lanes compose the handoff deterministically
(the LLM response is not consulted), so the Phase 1 directive that
lives in the analyst task_markdown only takes effect when the driver
mirrors its intent here. These tests lock in the score-based bundle
selection (v25 lesson: pinning the first bundle pinned an irrelevant
governance dataset for a heart-failure prompt) and the structured
deferral signals.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature import search as lit_search  # noqa: E402


def _hypothesis_source_stats() -> dict:
    """Source stats with a hypothesis statement that gives the
    keyword extractor real content to match against bundle columns."""
    return {
        "selected_families": [{"family": "vf_natriuretic_peptides", "priority": "high"}],
        "primary_family": "vf_natriuretic_peptides",
        "statistical_review_memo": {
            "estimands": [
                "BNP and NT-proBNP rank against renal markers for 30-day readmission"
            ],
        },
        "analysis_lane_proposals": [],
    }


class DatasetPickFromCandidateDatasetsTest(unittest.TestCase):
    def test_picks_bundle_with_highest_column_match(self):
        role_plan = {
            "lane_id": "followup-analyst-01",
            "planner_metadata": {
                "candidate_datasets": [
                    {
                        # Off-topic governance bundle — zero overlap with
                        # the cardiology hypothesis. Must NOT be picked.
                        "bundle_path": "/tmp/bundles/dvn-governance",
                        "provider": "dataverse",
                        "csvs": [
                            {
                                "name": "approval-data",
                                "csv_path": "/tmp/bundles/dvn-governance/csv/approval.csv",
                                "row_count": 10000,
                                "columns": ["state", "month", "approval_pct"],
                            }
                        ],
                    },
                    {
                        # On-topic bundle — column names overlap the
                        # hypothesis vocabulary (ntprobnp / readmit).
                        "bundle_path": "/tmp/bundles/zenodo-hf",
                        "provider": "zenodo",
                        "csvs": [
                            {
                                "name": "patients",
                                "csv_path": "/tmp/bundles/zenodo-hf/csv/patients.csv",
                                "row_count": 1500,
                                "columns": ["patient_id", "ntprobnp", "readmit_30d"],
                            }
                        ],
                    },
                ]
            },
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertEqual(handoff.get("dataset_root"), "/tmp/bundles/zenodo-hf")
        self.assertEqual(handoff.get("column_mapping", {}).get("exposure"), "ntprobnp")
        self.assertEqual(handoff.get("column_mapping", {}).get("outcome"), "readmit_30d")
        self.assertEqual(handoff.get("candidate_dataset_count"), 2)
        self.assertGreater(handoff.get("bundle_match_score", 0), 0)
        self.assertEqual(handoff.get("status"), "ready_for_runner")
        self.assertEqual(handoff.get("reason"), "matched_cycle_scoped_bundle")
        self.assertTrue(handoff.get("pre_validation_master_table_gate", {}).get("required"))
        self.assertEqual(handoff.get("analysis_master_table", {}).get("artifact_name_pattern"), "master_table")
        self.assertEqual(handoff["handoff_checks"][0].get("check_id"), "analysis_master_table_created")
        self.assertEqual(handoff["validation_code_blueprints"][0].get("check_id"), "analysis_master_table_created")
        self.assertIn("analysis_master_table_created", handoff["validation_code_blueprints"][0].get("code", ""))

    def test_spatial_handoff_uses_schema_roles_not_annotation_table_names(self):
        role_plan = {
            "lane_id": "followup-analyst-geomx",
            "planner_metadata": {
                "candidate_datasets": [
                    {
                        "bundle_path": "/tmp/bundles/gse228779",
                        "provider": "geo",
                        "csvs": [
                            {
                                "name": "spatial-wide-expression",
                                "csv_path": "/tmp/bundles/gse228779/csv/spatial_expression.csv",
                                "columns": [
                                    "TargetName",
                                    "TMA2_20221116 | 001 | Full ROI",
                                    "TMA2_20221116 | 002 | Liver cells",
                                    "TMA2_20221116 | 003 | Full ROI",
                                    "TMA2_20221116 | 004 | Liver cells",
                                    "TMA1_20221116 | 001 | Full ROI",
                                ],
                            },
                            {
                                "name": "spatial-segment-metadata",
                                "csv_path": "/tmp/bundles/gse228779/csv/spatial_segment_metadata.csv",
                                "columns": [
                                    "SlideName",
                                    "ScanLabel",
                                    "SegmentDisplayName",
                                    "Cohort",
                                    "Patient_Code",
                                    "Region",
                                    "Liver cells",
                                    "TMA",
                                ],
                            },
                            {
                                "name": "probe-annotation-dictionary",
                                "csv_path": "/tmp/bundles/gse228779/csv/probe_annotation.csv",
                                "columns": ["ProbeName", "ProbeDisplayName", "TargetName", "HUGOSymbol", "Accessions", "GenomeBuild", "GenomicPosition"],
                            },
                        ],
                    }
                ]
            },
        }
        source = {
            "primary_family": "classified_spatial_liver_injury_compartment_decoupling",
            "statistical_review_memo": {
                "estimands": [
                    "GSE228779 GeoMx spatial compartment VILI versus AIH liver cells Full ROI Cohort Patient_Code Region"
                ]
            },
        }
        handoff = lit_search.build_analyst_handoff(source, role_plan)
        self.assertEqual(handoff.get("status"), "ready_for_runner")
        check = handoff["handoff_checks"][1]
        blueprint = handoff["validation_code_blueprints"][1]
        self.assertEqual(check["model_family"], "geomx-spatial-compartment-program-difference")
        self.assertEqual(check["dataset_schema_role"], "wide_expression_matrix")
        self.assertEqual(check["segment_metadata_schema_role"], "segment_metadata")
        self.assertIn("spatial_expression.csv", check["dataset_path"])
        self.assertIn("spatial_segment_metadata.csv", check["segment_metadata_path"])
        self.assertNotIn("probe_annotation", check["dataset_path"].lower())
        self.assertNotIn("probe_annotation", check["segment_metadata_path"].lower())
        self.assertNotIn("probe_annotation", blueprint["dataset_path"].lower())
        self.assertEqual(handoff["column_mapping"]["selected_input_roles"]["expression_matrix_path"], "wide_expression_matrix")
        self.assertEqual(handoff["column_mapping"]["selected_input_roles"]["segment_metadata_path"], "segment_metadata")
        self.assertEqual(handoff["column_mapping"]["forbidden_input_roles"][0], "feature_annotation")
        self.assertIn('"valid_falsification"', blueprint["code"])
        self.assertIn('"valid_falsification_result"', blueprint["code"])
        self.assertEqual(handoff.get("reason"), "matched_cycle_scoped_bundle")

    def test_defers_when_no_bundle_columns_match_hypothesis(self):
        # All bundles present but none have any column that overlaps the
        # hypothesis vocabulary — exact v25 failure mode (Dataverse
        # returned governance data for a HF prompt). Must defer with
        # ``no_matching_bundle`` rather than pinning the first bundle.
        role_plan = {
            "planner_metadata": {
                "candidate_datasets": [
                    {
                        "bundle_path": "/tmp/bundles/dvn-governance",
                        "provider": "dataverse",
                        "csvs": [
                            {
                                "name": "approval-data",
                                "csv_path": "/tmp/bundles/dvn-governance/csv/approval.csv",
                                "row_count": 10000,
                                "columns": ["state", "month", "approval_pct"],
                            }
                        ],
                    },
                ]
            },
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "no_matching_bundle")
        self.assertEqual(handoff.get("bundle_match_score"), 0)
        self.assertEqual(handoff.get("candidate_dataset_count"), 1)

    def test_defers_when_candidate_datasets_missing(self):
        role_plan = {
            "lane_id": "followup-analyst-01",
            "planner_metadata": {},  # no candidate_datasets key
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertEqual(handoff.get("status"), "deferred")
        # No bundles AND no bundles-index file present → awaiting
        # data acquisition (Issue-2 distinction added in this revision).
        self.assertEqual(handoff.get("reason"), "awaiting_data_acquisition")
        self.assertEqual(handoff.get("candidate_dataset_count"), 0)
        self.assertIsNone(handoff.get("dataset_root"))
        self.assertIsNone(handoff.get("column_mapping"))

    def test_defers_when_candidate_datasets_empty_list(self):
        role_plan = {
            "lane_id": "followup-analyst-01",
            "planner_metadata": {"candidate_datasets": []},
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "awaiting_data_acquisition")
        self.assertEqual(handoff.get("candidate_dataset_count"), 0)

    def test_defers_when_role_plan_is_none(self):
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), None)
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "awaiting_data_acquisition")

    def test_refuses_unclassified_family_even_when_geo_bundle_matches(self):
        role_plan = {
            "planner_metadata": {
                "candidate_datasets": [
                    {
                        "bundle_path": "/tmp/bundles/gse282742",
                        "provider": "geo",
                        "candidate_title": "Transcriptomic predictors of rapid progression",
                        "csvs": [
                            {
                                "name": "gse282742-tpm",
                                "csv_path": "/tmp/bundles/gse282742/csv/gse282742-tpm.csv",
                                "columns": ["ID_REF", "VGH0075", "VGH0089", "VGH0146"],
                            },
                            {
                                "name": "gse282742-series-matrix.geo-metadata",
                                "csv_path": "/tmp/bundles/gse282742/csv/gse282742-series-matrix.geo-metadata.txt",
                                "columns": ["Sample_geo_accession", "disease state", "age", "Sex"],
                                "format_hint": "geo_sample_metadata",
                            },
                        ],
                    }
                ]
            }
        }
        handoff = lit_search.build_analyst_handoff({}, role_plan)
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "no_nonfallback_hypothesis")
        self.assertEqual(handoff.get("handoff_checks"), [])
        self.assertNotEqual(handoff.get("status"), "ready_for_runner")

    def test_objective_forbidden_accession_is_not_selected(self):
        role_plan = {
            "objective": "Do not reuse GSE282742; require a new dataset family.",
            "planner_metadata": {
                "candidate_datasets": [
                    {
                        "bundle_path": "/tmp/bundles/gse282742",
                        "provider": "geo",
                        "candidate_title": "GSE282742 transcriptomics",
                        "csvs": [{"name": "gse282742-tpm", "csv_path": "/tmp/bundles/gse282742/tpm.csv", "columns": ["gene_id", "ntprobnp", "readmit_30d"]}],
                    },
                    {
                        "bundle_path": "/tmp/bundles/new-hf",
                        "provider": "zenodo",
                        "candidate_title": "independent heart failure transcriptomics",
                        "csvs": [{"name": "patients", "csv_path": "/tmp/bundles/new-hf/patients.csv", "columns": ["patient_id", "ntprobnp", "readmit_30d"]}],
                    },
                ]
            },
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertEqual(handoff.get("status"), "ready_for_runner")
        self.assertEqual(handoff.get("dataset_root"), "/tmp/bundles/new-hf")
        self.assertIn("gse282742", handoff.get("forbidden_dataset_terms", []))

    def test_skips_pin_when_bundle_has_no_csvs(self):
        # Defensive: a bundle that fetched zero CSVs (e.g. all entries
        # were skipped_unsupported) cannot be picked, score=0, defers.
        role_plan = {
            "planner_metadata": {
                "candidate_datasets": [
                    {"bundle_path": "/tmp/bundles/empty", "provider": "zenodo", "csvs": []},
                ]
            },
        }
        handoff = lit_search.build_analyst_handoff(_hypothesis_source_stats(), role_plan)
        self.assertIsNone(handoff.get("dataset_root"))
        self.assertEqual(handoff.get("status"), "deferred")
        self.assertEqual(handoff.get("reason"), "no_matching_bundle")

    def test_geo_expression_bundle_emits_sample_level_model_blueprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "geo-binary-example"
            csv_dir = root / "csv"
            csv_dir.mkdir(parents=True)
            tpm_path = csv_dir / "geo-binary-example-tpm.csv"
            meta_path = csv_dir / "geo-binary-example-series-matrix.geo-metadata.txt"
            tpm_path.write_text(
                "gene_id,LIB001,LIB002,LIB003,LIB004\n"
                "ENSG1,1,2,3,4\n"
                "ENSG2,4,3,2,1\n",
                encoding="utf-8",
            )
            meta_path.write_text(
                "!Sample_geo_accession\t\"GSM1\"\t\"GSM2\"\t\"GSM3\"\t\"GSM4\"\n"
                "!Sample_characteristics_ch1\t\"Sex: F\"\t\"Sex: M\"\t\"Sex: F\"\t\"Sex: M\"\n"
                "!Sample_characteristics_ch1\t\"outcome group: responder\"\t\"outcome group: nonresponder\"\t\"outcome group: responder\"\t\"outcome group: nonresponder\"\n"
                "!Sample_characteristics_ch1\t\"subject id: 1\"\t\"subject id: 2\"\t\"subject id: 3\"\t\"subject id: 4\"\n"
                "!Sample_characteristics_ch1\t\"age: 70y\"\t\"age: 72y\"\t\"age: 74y\"\t\"age: 76y\"\n"
                "!Sample_description\t\"Library name: LIB001\"\t\"Library name: LIB002\"\t\"Library name: LIB003\"\t\"Library name: LIB004\"\n",
                encoding="utf-8",
            )
            role_plan = {
                "planner_metadata": {
                    "candidate_datasets": [{
                        "bundle_path": str(root),
                        "provider": "geo",
                        "csvs": [
                            {"name": "geo-binary-example-tpm", "csv_path": str(tpm_path), "columns": ["gene_id", "LIB001", "LIB002", "LIB003", "LIB004"]},
                            {"name": "geo-binary-example-series-matrix.geo-metadata", "csv_path": str(meta_path), "columns": ["Sample_geo_accession", "Library name", "outcome group", "subject id", "age", "Sex"], "format_hint": "geo_sample_metadata"},
                        ],
                    }]
                }
            }
            source = {
                "primary_family": "expression_binary_outcome",
                "statistical_review_memo": {"estimands": ["binary outcome comparison using expression adjusted for available covariates"]},
            }
            handoff = lit_search.build_analyst_handoff(source, role_plan)
            self.assertEqual(handoff.get("status"), "ready_for_runner")
            check = handoff["handoff_checks"][1]
            blueprint = handoff["validation_code_blueprints"][1]
            self.assertEqual(check["model_family"], "sample-level-logistic-ridge-pca-covariate-adjusted")
            self.assertNotEqual(check["model_family"], "generic-pearson-association")
            self.assertNotIn("auto_numeric_exposure", blueprint.get("exposures", []))
            self.assertEqual(handoff.get("schema_graph_audit", {}).get("strategy_recommendation"), "sample_level_feature_matrix_with_metadata_join")
            self.assertEqual(handoff.get("schema_graph_audit", {}).get("audit_io_policy", {}).get("raw_data_rows_read"), False)
            self.assertTrue(check.get("pre_blueprint_audit_required"))
            self.assertEqual(blueprint.get("schema_graph_audit", {}).get("wide_feature_matrix_candidates", [])[0].get("kind"), "wide_feature_matrix")
            self.assertIn("parse_geo_metadata", blueprint.get("code", ""))
            self.assertIn("loocv_auc", blueprint.get("code", ""))

    def test_reproducibility_audit_emits_exact_published_8gene_blueprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / ".research-lab"
            cycle_id = "cycle-gse282742-audit"
            lane_dir = runtime / "lanes" / cycle_id / "followup-analyst-01"
            state_dir = runtime / "state"
            bundle_root = runtime / "datasets" / cycle_id / "gse282742"
            csv_dir = bundle_root / "csv"
            lane_dir.mkdir(parents=True)
            state_dir.mkdir(parents=True)
            csv_dir.mkdir(parents=True)
            tpm_path = csv_dir / "gse282742-tpm.csv"
            meta_path = csv_dir / "gse282742-series-matrix.geo-metadata.txt"
            manifest_path = bundle_root / "manifest.json"
            tpm_path.write_text(
                "gene_id,VGH001,VGH002,VGH003,VGH004,VGH005,VGH006\n"
                "ENSG00000140450,1,2,3,4,5,6\n"
                "ENSG00000204469,2,3,4,5,6,7\n"
                "ENSG00000143365,7,6,5,4,3,2\n"
                "ENSG00000177854,3,3,4,4,5,5\n",
                encoding="utf-8",
            )
            meta_path.write_text(
                "!Sample_geo_accession\t\"GSM1\"\t\"GSM2\"\t\"GSM3\"\t\"GSM4\"\t\"GSM5\"\t\"GSM6\"\n"
                "!Sample_characteristics_ch1\t\"Sex: F\"\t\"Sex: M\"\t\"Sex: F\"\t\"Sex: M\"\t\"Sex: F\"\t\"Sex: M\"\n"
                "!Sample_characteristics_ch1\t\"disease state: P-MCI\"\t\"disease state: S-MCI\"\t\"disease state: P-MCI\"\t\"disease state: S-MCI\"\t\"disease state: P-MCI\"\t\"disease state: S-MCI\"\n"
                "!Sample_characteristics_ch1\t\"subject id: 1\"\t\"subject id: 2\"\t\"subject id: 3\"\t\"subject id: 4\"\t\"subject id: 5\"\t\"subject id: 6\"\n"
                "!Sample_characteristics_ch1\t\"age: 70y\"\t\"age: 72y\"\t\"age: 74y\"\t\"age: 76y\"\t\"age: 78y\"\t\"age: 80y\"\n"
                "!Sample_description\t\"Library name: VGH001\"\t\"Library name: VGH002\"\t\"Library name: VGH003\"\t\"Library name: VGH004\"\t\"Library name: VGH005\"\t\"Library name: VGH006\"\n",
                encoding="utf-8",
            )
            manifest_path.write_text(json.dumps({"manifest": []}), encoding="utf-8")
            (state_dir / f"{cycle_id}-data-bundles.json").write_text(
                json.dumps({"bundles": [{
                    "status": "fetched",
                    "bundle_path": str(bundle_root),
                    "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
                    "candidate_title": "Transcriptomic predictors of rapid progression from mild cognitive impairment to Alzheimer's Disease",
                    "manifest_path": str(manifest_path),
                }]}),
                encoding="utf-8",
            )
            (state_dir / f"{cycle_id}-lab-director-hypothesis.json").write_text(
                json.dumps({
                    "hypothesis_id": "hyp-director-gse282742",
                    "statement": "Reframe GSE282742 as a same-dataset reproducibility and leakage audit of the published 8-gene P-MCI versus S-MCI result.",
                    "dataset_or_accession": "GSE282742",
                    "primary_family": "reproducibility_audit",
                    "reference_methods_baseline": "published 8-gene classifier reported AUC 0.93",
                }),
                encoding="utf-8",
            )
            role_plan = {
                "followup_description": "Run the exact published 8-gene P-MCI versus S-MCI benchmark.",
                "planner_metadata": {"candidate_datasets": []},
            }
            handoff = lit_search.build_analyst_handoff({}, role_plan, output_dir=lane_dir)
            self.assertEqual(handoff.get("dataset_root"), str(bundle_root))
            self.assertEqual(handoff.get("column_mapping", {}).get("handoff_generation_mode"), "published_8gene_reproducibility_audit")
            check = handoff["handoff_checks"][1]
            blueprint = handoff["validation_code_blueprints"][1]
            self.assertEqual(check["model_family"], "published-8gene-subject-grouped-reproducibility-audit")
            self.assertIn("ARRDC4", check["exposures"])
            self.assertIn("published-8gene-benchmark-summary.csv", blueprint["code"])
            self.assertIn("strobe-participant-flow.csv", blueprint["code"])
            self.assertIn('"method_appropriateness_score": method_score', blueprint["code"])
            self.assertIn('"analysis_accuracy_score": accuracy_score', blueprint["code"])

    def test_labdirector_primary_only_policy_demotes_secondary_geomx_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "gse228779"
            csv_dir = root / "csv"
            csv_dir.mkdir(parents=True)
            target_path = csv_dir / "targetcountmatrix.csv"
            segment_path = csv_dir / "segmentproperties.csv"
            role_plan = {
                "planner_metadata": {
                    "analysis_request": {
                        "lab_director_next_action": {
                            "description": (
                                "Analyst: rewrite the validation handoff so the primary estimand is only "
                                "liver-cell mitochondrial/oxidative-high plus interferon-low; move "
                                "CD8/CD4/B-plasma/generic inflammation, reference-code availability, "
                                "absent age/sex/repeated-subject/leukocyte fields, and ClawBio DE-contract "
                                "checks to secondary rivals or limitations."
                            )
                        }
                    },
                    "candidate_datasets": [{
                        "bundle_path": str(root),
                        "provider": "ncbi_geo",
                        "candidate_title": "GSE228779 GeoMx spatial transcriptomics liver injury",
                        "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE228779",
                        "csvs": [
                            {
                                "name": "gse228779-targetcountmatrix",
                                "csv_path": str(target_path),
                                "columns": [
                                    "TargetName",
                                    "TMA1 | 001 | Liver cells",
                                    "TMA1 | 002 | Full ROI",
                                    "TMA2 | 001 | Liver cells",
                                    "TMA2 | 002 | Full ROI",
                                ],
                            },
                            {
                                "name": "gse228779-segmentproperties",
                                "csv_path": str(segment_path),
                                "columns": [
                                    "SlideName",
                                    "ROILabel",
                                    "SegmentLabel",
                                    "SegmentDisplayName",
                                    "Cohort",
                                    "Patient_Code",
                                    "Region",
                                    "Liver cells",
                                    "TMA",
                                ],
                            },
                        ],
                    }],
                }
            }
            source = {
                "primary_family": "classified_spatial_liver_injury_interferon_decoupling",
                "statistical_review_memo": {
                    "estimands": [
                        "GSE228779 liver-cell mitochondrial oxidative high plus interferon low in VILI versus AIH"
                    ],
                },
            }
            handoff = lit_search.build_analyst_handoff(source, role_plan)
            self.assertEqual(handoff.get("status"), "ready_for_runner")
            self.assertEqual(len(handoff.get("handoff_checks", [])), 2)
            check = handoff["handoff_checks"][1]
            self.assertEqual(
                check.get("exposures"),
                ["mitochondrial_oxidative_program", "interferon_program"],
            )
            self.assertEqual(
                check.get("primary_directional_requirements"),
                [
                    {"program": "mitochondrial_oxidative", "compartment": "liver_cells", "direction": "positive"},
                    {"program": "interferon", "compartment": "liver_cells", "direction": "negative"},
                ],
            )
            self.assertIn("cd8_cytotoxic", check.get("secondary_rival_programs", []))
            self.assertIn("age_field_unavailable", handoff.get("secondary_limitations", []))
            self.assertNotIn("reference_methods_baseline", json.dumps(handoff.get("handoff_checks", [])))
            self.assertIn("primary_directional_requirements", handoff["validation_code_blueprints"][1]["code"])

    def test_stale_role_plan_is_enriched_from_cycle_state_materialized_csvs(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / ".research-lab"
            cycle_id = "cycle-c-20260510-123434"
            lane_dir = runtime / "lanes" / cycle_id / "followup-analyst-01"
            state_dir = runtime / "state"
            bundle_root = runtime / "datasets" / cycle_id / "geo-binary-example"
            csv_dir = bundle_root / "csv"
            lane_dir.mkdir(parents=True)
            state_dir.mkdir(parents=True)
            csv_dir.mkdir(parents=True)

            tpm_path = csv_dir / "geo-binary-example-tpm.csv"
            meta_path = csv_dir / "geo-binary-example-series-matrix.geo-metadata.txt"
            manifest_path = bundle_root / "manifest.json"
            tpm_path.write_text(
                "gene_id,LIB001,LIB002,LIB003,LIB004\nSECRET_DATA_ROW_SHOULD_NOT_APPEAR,1,2,3,4\n",
                encoding="utf-8",
            )
            meta_path.write_text(
                "!Sample_geo_accession\t\"GSM1\"\t\"GSM2\"\t\"GSM3\"\t\"GSM4\"\n"
                "!Sample_characteristics_ch1\t\"Sex: F\"\t\"Sex: M\"\t\"Sex: F\"\t\"Sex: M\"\n"
                "!Sample_characteristics_ch1\t\"outcome group: responder\"\t\"outcome group: nonresponder\"\t\"outcome group: responder\"\t\"outcome group: nonresponder\"\n"
                "!Sample_characteristics_ch1\t\"subject id: 1\"\t\"subject id: 2\"\t\"subject id: 3\"\t\"subject id: 4\"\n"
                "!Sample_characteristics_ch1\t\"age: 70y\"\t\"age: 72y\"\t\"age: 74y\"\t\"age: 76y\"\n"
                "!Sample_description\t\"Library name: LIB001\"\t\"Library name: LIB002\"\t\"Library name: LIB003\"\t\"Library name: LIB004\"\n",
                encoding="utf-8",
            )
            manifest_path.write_text(
                json.dumps({"manifest": [{"name": "geo-binary-example-tpm", "fetch_status": "skipped_unsupported", "csv_path": None, "columns": []}]}),
                encoding="utf-8",
            )
            (state_dir / f"{cycle_id}-data-bundles.json").write_text(
                json.dumps({"bundles": [{
                    "status": "fetched",
                    "bundle_path": str(bundle_root),
                    "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GEO_BINARY_EXAMPLE",
                    "candidate_title": "Transcriptomic predictors of a metadata-defined binary outcome",
                    "manifest_path": str(manifest_path),
                }]}),
                encoding="utf-8",
            )
            (state_dir / f"{cycle_id}-lab-director-hypothesis.json").write_text(
                json.dumps({
                    "hypothesis_id": "hyp-director-geo-binary-example-expression-binary-outcome",
                    "statement": "GEO_BINARY_EXAMPLE expression predicts a metadata-defined binary outcome after covariate adjustment.",
                    "dataset_or_accession": "GEO_BINARY_EXAMPLE",
                    "primary_family": "expression_binary_outcome",
                }),
                encoding="utf-8",
            )
            role_plan = {
                "planner_metadata": {"candidate_datasets": [{
                    "bundle_path": str(bundle_root),
                    "provider": "ncbi_geo",
                    "csvs": [],  # stale snapshot from before local csv/ scan
                }]}
            }
            handoff = lit_search.build_analyst_handoff({}, role_plan, output_dir=lane_dir)
            self.assertEqual(handoff.get("dataset_root"), str(bundle_root))
            self.assertEqual(handoff.get("column_mapping", {}).get("handoff_generation_mode"), "geo_sample_level_binary_outcome_validation")
            self.assertEqual(handoff.get("schema_graph_audit", {}).get("strategy_recommendation"), "sample_level_feature_matrix_with_metadata_join")
            handoff_text = json.dumps(handoff)
            self.assertNotIn("SECRET_DATA_ROW_SHOULD_NOT_APPEAR", handoff_text)
            self.assertEqual(handoff.get("schema_graph_audit", {}).get("audit_io_policy", {}).get("csv_access"), "header_only_first_line")
            self.assertTrue(handoff["validation_code_blueprints"][1].get("schema_graph_audit"))
            self.assertEqual(handoff["handoff_checks"][1]["model_family"], "sample-level-logistic-ridge-pca-covariate-adjusted")
            self.assertNotEqual(handoff["handoff_checks"][1]["model_family"], "generic-pearson-association")

    def test_geo_series_matrix_metadata_supports_design_memo_and_sample_level_handoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp) / ".research-lab"
            cycle_id = "cycle-gse322943-design-memo"
            lane_dir = runtime / "lanes" / cycle_id / "followup-analyst-01"
            state_dir = runtime / "state"
            bundle_root = runtime / "datasets" / cycle_id / "gse322943"
            csv_dir = bundle_root / "csv"
            raw_dir = bundle_root / "raw"
            lane_dir.mkdir(parents=True)
            state_dir.mkdir(parents=True)
            csv_dir.mkdir(parents=True)
            raw_dir.mkdir(parents=True)

            count_path = csv_dir / "gse322943-counts-sheet1.csv"
            matrix_path = raw_dir / "GSE322943_series_matrix.txt"
            manifest_path = bundle_root / "manifest.json"
            count_path.write_text(
                "rownames,Exp_NCH001,Exp_NCH002,Exp_NCH003,Exp_NCH004\n"
                "CD8A,10,12,1,2\n"
                "TRAC,9,11,1,3\n"
                "MS4A1,1,2,10,11\n",
                encoding="utf-8",
            )
            matrix_path.write_text(
                "!Sample_title\t\"NCH001\"\t\"NCH002\"\t\"NCH003\"\t\"NCH004\"\n"
                "!Sample_geo_accession\t\"GSM1\"\t\"GSM2\"\t\"GSM3\"\t\"GSM4\"\n"
                "!Sample_characteristics_ch1\t\"tissue: BCBM\"\t\"tissue: BCBM\"\t\"tissue: BCBM\"\t\"tissue: BCBM\"\n"
                "!Sample_characteristics_ch1\t\"age: 45\"\t\"age: 46\"\t\"age: 60\"\t\"age: 61\"\n"
                "!Sample_characteristics_ch1\t\"location: cerebrum\"\t\"location: cerebellum\"\t\"location: cerebrum\"\t\"location: cerebellum\"\n"
                "!Sample_characteristics_ch1\t\"batch: 37844\"\t\"batch: 37844\"\t\"batch: 37845\"\t\"batch: 37845\"\n"
                "!Sample_description\t\"Library name: Exp_NCH001\"\t\"Library name: Exp_NCH002\"\t\"Library name: Exp_NCH003\"\t\"Library name: Exp_NCH004\"\n",
                encoding="utf-8",
            )
            manifest_path.write_text(
                json.dumps({"manifest": [
                    {"name": "gse322943-series-matrix", "fetch_status": "skipped_unsupported", "gunzipped_to": str(matrix_path)},
                    {"name": "gse322943-counts", "fetch_status": "fetched", "csv_path": str(count_path), "columns": ["rownames", "Exp_NCH001", "Exp_NCH002", "Exp_NCH003", "Exp_NCH004"]},
                ]}),
                encoding="utf-8",
            )
            (state_dir / f"{cycle_id}-data-bundles.json").write_text(
                json.dumps({"bundles": [{
                    "status": "fetched",
                    "bundle_path": str(bundle_root),
                    "candidate_url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE322943",
                    "candidate_title": "BCBM immune landscapes RNA-Seq",
                    "manifest_path": str(manifest_path),
                }]}),
                encoding="utf-8",
            )
            (state_dir / f"{cycle_id}-lab-director-hypothesis.json").write_text(
                json.dumps({
                    "hypothesis_id": "hyp-gse322943-bcbm-immune-landscape",
                    "statement": "GSE322943 BCBM RNA-seq supports immune-landscape validation using real sample metadata and expression counts.",
                    "dataset_or_accession": "GSE322943",
                    "primary_family": "classified_tumor_microenvironment",
                }),
                encoding="utf-8",
            )
            handoff = lit_search.build_analyst_handoff({}, {"planner_metadata": {"candidate_datasets": []}}, output_dir=lane_dir)
            self.assertEqual(handoff.get("status"), "ready_for_runner")
            self.assertEqual(handoff["handoff_checks"][1]["model_family"], "sample-level-logistic-ridge-pca-covariate-adjusted")
            self.assertEqual(handoff["column_mapping"]["sample_metadata_path"], str(matrix_path))
            memo = handoff.get("analysis_design_memo", {})
            self.assertEqual(memo.get("phase"), "exploratory_scientific_design_before_runner_handoff")
            self.assertTrue(memo.get("final_handoff_readiness", {}).get("ready_for_runner"))
            memo_text = json.dumps(memo)
            self.assertIn("age", memo_text)
            self.assertIn("batch", memo_text)
            self.assertNotIn("openclaw_workspace", memo_text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
