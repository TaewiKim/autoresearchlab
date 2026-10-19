import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ConfounderSensitivityBlueprintTest(unittest.TestCase):
    def test_confounder_handoff_propagates_sample_metadata_path(self):
        spec = importlib.util.spec_from_file_location(
            "literature_search", ROOT / "drivers" / "literature" / "search.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        checks = []
        blueprints = []

        mod._append_confounder_sensitivity(
            checks=checks,
            blueprints=blueprints,
            primary_hypothesis_id="hyp-director-gse282742",
            dataset_path="/tmp/gse282742-tpm.csv",
            sample_metadata_path="/tmp/gse282742-series-matrix.geo-metadata.txt",
        )

        self.assertEqual(checks[0]["sample_metadata_path"], "/tmp/gse282742-series-matrix.geo-metadata.txt")
        self.assertEqual(blueprints[0]["sample_metadata_path"], "/tmp/gse282742-series-matrix.geo-metadata.txt")

    def test_geo_sample_metadata_is_joined_to_expression_samples(self):
        spec = importlib.util.spec_from_file_location(
            "literature_search", ROOT / "drivers" / "literature" / "search.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        code = mod._confounder_sensitivity_blueprint_code()

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            expression = tmp_path / "expr.csv"
            expression.write_text(
                "gene,S1,S2,S3,S4,S5,S6,S7,S8\n"
                "g1,1,2,3,4,5,6,7,8\n"
                "g2,2,3,4,5,6,7,8,9\n",
                encoding="utf-8",
            )
            metadata = tmp_path / "GSE_family.soft"
            metadata.write_text(
                "!Sample_title\tS1: sample\tS2: sample\tS3: sample\tS4: sample\tS5: sample\tS6: sample\tS7: sample\tS8: sample\n"
                "!Sample_characteristics_ch1\tdisease status: S-MCI\tdisease status: P-MCI\tdisease status: S-MCI\tdisease status: P-MCI\tdisease status: S-MCI\tdisease status: P-MCI\tdisease status: S-MCI\tdisease status: P-MCI\n"
                "!Sample_characteristics_ch1\tage: 70\tage: 71\tage: 72\tage: 73\tage: 74\tage: 75\tage: 76\tage: 77\n"
                "!Sample_characteristics_ch1\tsex: M\tsex: F\tsex: M\tsex: F\tsex: M\tsex: F\tsex: M\tsex: F\n",
                encoding="utf-8",
            )
            check_file = tmp_path / "check.json"
            check_file.write_text(
                json.dumps({"dataset_path": str(expression), "sample_metadata_path": str(metadata)}),
                encoding="utf-8",
            )
            script = tmp_path / "confounder_sensitivity.py"
            script.write_text(code, encoding="utf-8")
            out_dir = tmp_path / "out"
            out_dir.mkdir()

            run = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--csv-root",
                    str(tmp_path),
                    "--output-dir",
                    str(out_dir),
                    "--check-file",
                    str(check_file),
                ],
                text=True,
                capture_output=True,
                timeout=30,
                check=True,
            )
            payload = json.loads(run.stdout)
            summary = (out_dir / "confounder-sensitivity.csv").read_text(encoding="utf-8")

        self.assertEqual(payload["effect_estimates"]["unadjusted_corr"], payload["effect_estimates"]["unadjusted_corr"])
        self.assertIn("expression_signal", summary)
        self.assertIn("binary_outcome", summary)
        self.assertIn("age;sex", summary)


if __name__ == "__main__":
    unittest.main()
