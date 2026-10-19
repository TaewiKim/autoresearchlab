import unittest

from drivers.data import data_scout_browser as scout


class DataScoutRelevanceTest(unittest.TestCase):
    def test_generic_research_words_do_not_pass_irrelevant_hit(self):
        query = (
            "LabDirector pivoted the cycle: surface named omics cohorts/accessions, "
            "dataset schema clues, and literature-backed variables."
        )
        hit = {
            "title": "Data of numerical analyses research: torsion warping transmission in frame joint",
            "datacite_description": "Engineering analysis dataset for inclined beam and haunch stiffener influence.",
        }
        self.assertFalse(scout._hit_passes_relevance(hit, query))

    def test_domain_terms_pass_relevant_hit(self):
        query = "transcriptomics single-cell bulk RNA-seq omics cohort"
        hit = {
            "title": "Single-cell RNA-seq atlas of tumor immune cohorts",
            "datacite_description": "Processed transcriptomics matrix and metadata.",
        }
        self.assertTrue(scout._hit_passes_relevance(hit, query))

    def test_accession_identifier_fields_pass_relevance_gate(self):
        query = "GSE282742"
        self.assertTrue(scout._hit_passes_relevance({
            "title": "Transcriptomic predictors of rapid progression from mild cognitive impairment to Alzheimer's disease",
            "url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
            "geo_accession": "GSE282742",
        }, query))
        self.assertTrue(scout._hit_passes_relevance({
            "title": "analysis code",
            "url": "https://github.com/example-lab/gse282742-analysis",
            "accessions": [{"repository": "GitHub", "accession": "example-lab/gse282742-analysis"}],
        }, query))

    def test_omics_terms_enable_specialized_archives(self):
        self.assertTrue(scout._needs_specialized_archives("bulk RNA-seq heart failure cohort"))
        self.assertTrue(scout._needs_specialized_archives("single-cell transcriptomics dataset"))

    def test_re3data_skipped_for_cohort_accession_requests(self):
        self.assertTrue(scout._should_skip_re3data_for_query("retrieve GEO accessions for RNA-seq cohorts"))
        self.assertFalse(scout._should_skip_re3data_for_query("find repositories and registry catalogs for biodiversity data"))

    def test_forbidden_accession_does_not_suppress_omics_seed_queries(self):
        role_plan = {
            "objective": "Do not reuse GSE282742. Find public omics cohorts/accessions for a new hypothesis.",
            "followup_description": "surface named omics cohorts/accessions",
            "planner_metadata": {
                "dataset_discovery_contract": {
                    "required_repositories": ["GEO", "ArrayExpress", "PRIDE"],
                    "omics_modalities": ["transcriptomics", "proteomics"],
                    "biological_context_terms": ["immune cohort"],
                }
            },
        }
        request = scout._data_request_from_role_plan(role_plan)
        queries = scout._build_queries(request, 8)
        self.assertTrue(any(q.startswith("GEO transcriptomics") for q in queries))
        self.assertTrue(any(q.startswith("PRIDE proteomics") for q in queries))
        self.assertFalse(any("GSE282742" in q for q in queries))

    def test_explicit_accessions_take_priority_over_generic_cohort_seed_queries(self):
        role_plan = {
            "objective": "Find public omics cohorts/accessions for a new hypothesis.",
            "followup_description": (
                "Recover or materialize GSE229459 and PRJNA951615 only as "
                "promotion-strengthening same-paper context."
            ),
            "planner_metadata": {
                "dataset_discovery_contract": {
                    "required_repositories": ["GEO", "ArrayExpress", "PRIDE"],
                    "omics_modalities": ["transcriptomics RNA-seq", "single-cell RNA-seq", "proteomics"],
                    "biological_context_terms": ["human disease cohort", "immune cohort"],
                }
            },
        }
        request = scout._data_request_from_role_plan(role_plan)
        queries = scout._build_queries(request, 4)
        self.assertEqual(queries[:2], ["GSE229459", "PRJNA951615"])
        self.assertTrue(any(q.startswith("GEO transcriptomics") for q in queries[2:]))

    def test_role_plan_without_contract_synthesizes_omics_kg_seed_queries(self):
        role_plan = {
            "objective": "Do not reuse GSE282742. Find public omics cohorts/accessions for KG before hypothesis generation.",
            "followup_description": "LabDirector pivoted the cycle; surface named omics cohorts/accessions using repository-native discovery.",
        }
        request = scout._data_request_from_role_plan(role_plan)
        self.assertIn("dataset_discovery_contract", request)
        queries = scout._build_queries(request, 10)
        self.assertTrue(any(q.startswith("GEO transcriptomics") for q in queries))
        self.assertTrue(any(q.startswith("ArrayExpress") for q in queries))
        self.assertFalse(any("LabDirector pivoted" in q for q in queries[:3]))
        self.assertFalse(any("GSE282742" in q for q in queries))

    def test_github_repository_accession_is_extracted(self):
        accessions = scout._extract_accessions("Code: https://github.com/example-lab/gse282742-analysis")
        self.assertIn(
            {"repository": "GitHub", "accession": "example-lab/gse282742-analysis"},
            accessions,
        )

    def test_reference_paper_resource_queries_include_doi_title_and_accession(self):
        hypothesis = {
            "selected_hypothesis": {
                "same_dataset_reference_papers": [
                    {
                        "title": "Transcriptomic predictors of rapid progression from mild cognitive impairment to Alzheimer's disease",
                        "doi": "10.1186/s13195-024-01651-0",
                        "accession_or_cohort": "GSE282742",
                    }
                ]
            }
        }
        queries = scout._reference_paper_resource_queries(hypothesis)
        query_text = "\n".join(item["query"] for item in queries)
        self.assertIn('"10.1186/s13195-024-01651-0" GitHub', query_text)
        self.assertIn('"GSE282742" GitHub code', query_text)
        self.assertTrue(all(item.get("reference_paper") for item in queries))

    def test_reference_resource_record_promotes_github_for_downstream_use(self):
        candidate = {
            "title": "analysis code",
            "url": "https://github.com/example-lab/gse282742-analysis",
            "access_status": "open",
            "accessions": [{"repository": "GitHub", "accession": "example-lab/gse282742-analysis"}],
            "discovery_source": "reference_paper_web",
            "reference_paper": {"title": "paper", "doi": "10.1234/example"},
        }
        record = scout._candidate_reference_resource_record(candidate)
        self.assertEqual(record["github_repos"], ["example-lab/gse282742-analysis"])
        self.assertIn("high-value reproducibility context", record["downstream_usage_hint"])


if __name__ == "__main__":
    unittest.main()
