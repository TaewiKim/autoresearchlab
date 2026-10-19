#!/usr/bin/env python3
"""Tests for drivers/analysis/omics_helpers.py — the vetted omics loader the
analyst's blueprints import instead of re-deriving data loading.

Synthetic fixtures (offline). Run::
    python3 researchlab/tests/omics_helpers_test.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "drivers" / "analysis"))

import omics_helpers as oh  # noqa: E402


class OmicsHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        os.environ["RESEARCHLAB_CSV_ROOT"] = str(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_matrix(self, name="expr-matrix.csv", sep=","):
        cols = ["ID_REF", "HD_CTRL_A001", "HD_CTRL_A002", "SLE_Sev_B001", "SLE_Sev_B002"]
        rows = [["GENE1", "1", "2", "3", "4"], ["GENE2", "5", "6", "7", "8"], ["GENE3", "9", "10", "11", "12"]]
        lines = [sep.join(cols)] + [sep.join(r) for r in rows]
        (self.root / name).write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_skips_filelist_picks_matrix(self):
        # decoy manifest + the real matrix
        (self.root / "filelist-1.csv").write_text("#Archive,Name,Size\nFile,a.cel,10\nFile,b.cel,20\n", encoding="utf-8")
        self._write_matrix()
        m, info = oh.load_expression_matrix()
        self.assertNotIn("filelist", info["matrix_path"])
        self.assertEqual(info["n_samples"], 4)
        self.assertEqual(info["feature_column"], "ID_REF")

    def test_tsv_matrix_loads(self):
        self._write_matrix(name="expr.tsv", sep="\t")
        m, info = oh.load_expression_matrix()
        self.assertEqual(info["n_samples"], 4)

    def test_geo_banner_lines_skipped(self):
        body = "ID_REF\tGSM1\tGSM2\nGENE1\t1\t2\nGENE2\t3\t4\n"
        (self.root / "series.txt").write_text("!Series_title\tx\n!Sample_geo\ty\n" + body, encoding="utf-8")
        df = oh.load_table(self.root / "series.txt")
        self.assertIn("ID_REF", [str(c) for c in df.columns])
        self.assertGreaterEqual(df.shape[1], 3)

    def test_binary_outcome_by_prefix(self):
        cols = ["HD_CTRL_A001", "HD_CTRL_A002", "SLE_Sev_B001"]
        bo = oh.binary_outcome(cols, control_prefixes=["HD", "CTRL"])
        self.assertEqual(bo["HD_CTRL_A001"], 0)
        self.assertEqual(bo["SLE_Sev_B001"], 1)

    def test_build_master_table(self):
        self._write_matrix()
        m, info = oh.load_expression_matrix()
        master = oh.build_master_table(m, control_prefixes=["HD", "CTRL"])
        self.assertEqual(set(master.columns), {"sample_id", "binary_outcome"})
        self.assertEqual(len(master), 4)
        self.assertEqual(master["binary_outcome"].tolist(), [0, 0, 1, 1])

    def test_wide_matrix_for_de_feature_first(self):
        self._write_matrix()
        m, info = oh.load_expression_matrix()
        de = oh.wide_matrix_for_de(m)
        self.assertEqual(de.columns[0], "ID_REF")
        self.assertEqual(de.shape[1], 5)  # feature + 4 samples

    def test_no_matrix_raises_not_crashes(self):
        (self.root / "filelist-1.csv").write_text("#Archive,Name\nFile,a.cel\n", encoding="utf-8")
        with self.assertRaises(FileNotFoundError):
            oh.load_expression_matrix()


if __name__ == "__main__":
    unittest.main(verbosity=2)
