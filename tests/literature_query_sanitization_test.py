#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from drivers.literature import search


class LiteratureQuerySanitizationTest(unittest.TestCase):
    def test_case_specific_search_terms_are_not_hardcoded(self):
        source = Path(search.__file__).read_text(encoding="utf-8").lower()
        self.assertNotIn("severe acute pancreatitis", source)
        self.assertNotIn("natural killer cells", source)
        self.assertNotIn("transendothelial migration", source)

    def test_task_blob_is_not_sent_as_literature_query(self):
        blob = """# Autonomous Follow-up Task
        - cycle_id: v56-omics-paper-complete-cache-fresh
        - role: scout
        - task: Restart lead-family selection unless LabDirector can freeze one
          authoritative ECM or TEM score.
        ## Assigned Hypotheses
        In peripheral-blood natural killer cells, severe acute pancreatitis is
        marked by an extracellular-matrix and leukocyte-trafficking program.
        | unresolved reasoning/data gaps: data_without_literature_alignment
        """
        queries = search.sanitize_queries([blob])

        self.assertTrue(queries)
        self.assertTrue(any("severe acute pancreatitis" in item for item in queries))
        self.assertTrue(all("Autonomous Follow-up Task" not in item for item in queries))
        self.assertTrue(all(len(item) <= 180 for item in queries))

    def test_role_plan_methods_followup_keeps_scientific_context(self):
        role_plan = {
            "action_type": "methods_followup",
            "followup_description": "execute the latest analyst handoff before gate promotion",
            "assigned_hypotheses": [
                "In peripheral-blood natural killer cells, severe acute pancreatitis is marked by an ECM/adhesion/transendothelial-migration gene-set score.",
                "rejection may affect injury differently under human. | unresolved reasoning/data gaps: literature_only_no_data_test",
            ],
            "planner_metadata": {
                "blocker_reasons": ["latest executable analyst handoff has not been converted into a validation pass"],
            },
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "role-plan.json"
            path.write_text(json.dumps(role_plan), encoding="utf-8")
            queries = search.queries_from_role_plan(path)

        joined = "\n".join(queries).lower()
        self.assertIn("severe acute pancreatitis", joined)
        self.assertNotIn("methodology review reproducibility", joined)
        self.assertNotIn("rejection injury", joined)

    def test_role_plan_paths_and_stale_hypotheses_do_not_become_queries(self):
        role_plan = {
            "action_type": "methods_followup",
            "followup_description": (
                "execute /workspace/autoresearch-lab/researchlab/.research-lab/artifacts/stats/"
                "followup-analyst-64/handoff-validation-plan.json; "
                "handoff_fingerprint=workspace-autoresearch-lab-researchlab-research-lab-artifacts-stats"
            ),
            "objective": "earn researcher approval by pursuing the strongest achievable result",
            "assigned_hypotheses": [
                "rejection may affect injury differently under human. | unresolved reasoning/data gaps: literature_only_no_data_test",
                "In peripheral-blood natural killer cells, severe acute pancreatitis is marked by an ECM/adhesion/transendothelial-migration gene-set score.",
            ],
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "role-plan.json"
            path.write_text(json.dumps(role_plan), encoding="utf-8")
            queries = search.queries_from_role_plan(path)

        joined = "\n".join(queries).lower()
        self.assertIn("severe acute pancreatitis", joined)
        self.assertNotIn("autoresearch", joined)
        self.assertNotIn("handoff", joined)
        self.assertNotIn("researcher approval", joined)
        self.assertNotIn("rejection injury", joined)

    def test_pubmed_non_open_article_keeps_abstract_for_kg_seed(self):
        esearch_payload = {"esearchresult": {"idlist": ["12345"]}}
        esummary_payload = {
            "result": {
                "12345": {
                    "uid": "12345",
                    "title": "Closed Article With Useful Abstract",
                    "fulljournalname": "Example Journal",
                    "pubdate": "2024 Jan",
                    "authors": [{"name": "Author A"}],
                    "articleids": [{"idtype": "doi", "value": "10.1000/closed"}],
                }
            }
        }
        efetch_xml = """
        <PubmedArticleSet>
          <PubmedArticle>
            <MedlineCitation>
              <PMID>12345</PMID>
              <Article>
                <Abstract>
                  <AbstractText Label="BACKGROUND">Mechanism terms support a KG concept.</AbstractText>
                  <AbstractText Label="RESULTS">Outcome terms support a KG edge.</AbstractText>
                </Abstract>
              </Article>
            </MedlineCitation>
          </PubmedArticle>
        </PubmedArticleSet>
        """

        def fake_fetch_json(url):
            if "esearch.fcgi" in url:
                return esearch_payload
            if "esummary.fcgi" in url:
                return esummary_payload
            raise AssertionError(url)

        # The provider owns these bindings after the search_lib module split.
        from search_lib import providers
        with mock.patch.object(providers, "fetch_json", side_effect=fake_fetch_json), \
             mock.patch.object(providers, "fetch_text", return_value=efetch_xml):
            papers = [search.normalize_pubmed_paper(item) for item in search.search_pubmed("mechanism outcome")]

        self.assertEqual(len(papers), 1)
        paper = papers[0]
        self.assertIn("Mechanism terms", paper["abstract"])
        self.assertFalse(paper["open_access"])
        self.assertEqual(paper["full_text_status"], "abstract_only")
        self.assertEqual(paper["kg_seed_basis"], "abstract")
        self.assertTrue(paper["kg_usable"])

    def test_analyst_handoff_records_workflow_compatibility_decision(self):
        role_plan = {
            "role": "analyst",
            "action_type": "methods_followup",
            "followup_description": (
                "Record a GeoMx-suitable ClawBio diff-visualizer waiver or require a "
                "compatible spatial program-score workflow before promotion."
            ),
            "assigned_hypotheses": [
                "In GSE228779 GeoMx spatial transcriptomics, VILI differs from AIH through liver-cell injury/interferon decoupling."
            ],
            "planner_metadata": {
                "blocker_reasons": [
                    "Record a GeoMx-suitable ClawBio diff-visualizer waiver from runner evidence.",
                ],
            },
        }
        source_stats = {
            "primary_family": "classified_spatial_liver_injury_interferon_decoupling",
            "queries": ["GeoMx spatial transcriptomics program score workflow"],
        }

        handoff = search.build_analyst_handoff(source_stats, role_plan)

        decision = handoff.get("workflow_compatibility_decision")
        self.assertIsInstance(decision, dict)
        self.assertEqual(decision["decision"], "waiver_or_replacement_required")
        self.assertIn("workflow_compatibility_decision", handoff["analysis_design_memo"])
        self.assertIn("does not pass scientific gates", decision["gate_interpretation"])


if __name__ == "__main__":
    unittest.main()
