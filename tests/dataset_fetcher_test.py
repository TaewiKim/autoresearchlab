#!/usr/bin/env python3
"""Tests for drivers/data/dataset_fetcher.py.

Two layers:
  - unit tests for the normaliser (offline; uses synthetic CSV / XLSX /
    Parquet / JSON / ZIP fixtures created in temp dirs)
  - integration smoke for adapter routing (offline; mocks
    ``urlopen`` so no network is required)

The optional live smoke (``--live``) hits a small public Zenodo CSV
to confirm end-to-end fetching works. Skip by default.

Run::
    python3 researchlab/tests/dataset_fetcher_test.py
    python3 researchlab/tests/dataset_fetcher_test.py --live
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock as mock
import zipfile
from pathlib import Path

# Add drivers/data to import path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "drivers" / "data"))

import dataset_fetcher as df  # noqa: E402


class NormalizerTests(unittest.TestCase):
    """Synthetic-input fixtures verifying every supported format
    yields a sensible manifest entry."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.target = Path(self.tmp.name)
        self.csv_dir = self.target / "csv"
        self.csv_dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_csv_round_trip(self):
        src = self.target / "data.csv"
        src.write_text("a,b,c\n1,2,3\n4,5,6\n", encoding="utf-8")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["fetch_status"], "fetched")
        self.assertEqual(e["row_count"], 2)
        self.assertEqual(e["columns"], ["a", "b", "c"])
        self.assertTrue(Path(e["csv_path"]).is_file())

    def test_tsv_round_trip(self):
        src = self.target / "data.tsv"
        src.write_text("a\tb\n1\t2\n3\t4\n", encoding="utf-8")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["fetch_status"], "fetched")
        self.assertEqual(e["row_count"], 2)
        self.assertEqual(e["columns"], ["a", "b"])

    def test_xlsx_two_sheets_yields_two_entries(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        import openpyxl  # noqa: F401 — required for xlsx writer
        src = self.target / "book.xlsx"
        with pd.ExcelWriter(src, engine="openpyxl") as writer:
            pd.DataFrame({"x": [1, 2], "y": [3, 4]}).to_csv  # noqa: B018
            pd.DataFrame({"x": [1, 2], "y": [3, 4]}).to_excel(writer, sheet_name="alpha", index=False)
            pd.DataFrame({"q": [9]}).to_excel(writer, sheet_name="beta", index=False)
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 2)
        for e in entries:
            self.assertEqual(e["fetch_status"], "fetched")
            self.assertEqual(e["format_hint"], "xlsx-sheet")

    def test_parquet_round_trip(self):
        try:
            import pandas as pd
        except ImportError:
            self.skipTest("pandas not installed")
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("pyarrow not installed")
        src = self.target / "data.parquet"
        pd.DataFrame({"alpha": [1, 2, 3], "beta": ["x", "y", "z"]}).to_parquet(src)
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["fetch_status"], "fetched")
        self.assertEqual(e["row_count"], 3)
        self.assertEqual(e["format_hint"], "parquet")

    def test_json_records_round_trip(self):
        src = self.target / "data.json"
        src.write_text(json.dumps([{"a": 1, "b": 2}, {"a": 3, "b": 4}]), encoding="utf-8")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["fetch_status"], "fetched")
        self.assertEqual(e["row_count"], 2)

    def test_json_nested_skips(self):
        src = self.target / "nested.json"
        src.write_text(json.dumps({"top": {"nested": "object"}}), encoding="utf-8")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["fetch_status"], "skipped_unsupported")

    def test_zip_with_csv_member(self):
        src = self.target / "bundle.zip"
        with zipfile.ZipFile(src, "w") as zf:
            zf.writestr("data.csv", "a,b\n1,2\n3,4\n")
            zf.writestr("readme.txt", "ignored")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["fetch_status"], "fetched")
        self.assertEqual(e["row_count"], 2)

    def test_unsupported_format(self):
        src = self.target / "doc.docx"
        src.write_bytes(b"PK\x03\x04 fake header")
        entries = df._normalize_file(src, self.csv_dir)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["fetch_status"], "skipped_unsupported")


class RoutingTests(unittest.TestCase):
    """Confirm the DOI / host classifier picks the right adapter."""

    def test_zenodo_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.5281/zenodo.123456"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "zenodo")

    def test_zenodo_cache_keys_keep_record_ids_distinct(self):
        self.assertFalse(
            df._doi_cache_keys("10.5281/zenodo.20107202")
            & df._doi_cache_keys("10.5281/zenodo.20071018")
        )

    def test_explicit_version_suffix_cache_key_collapses(self):
        self.assertIn("10.17632/abc123", df._doi_cache_keys("10.17632/abc123.v2"))

    def test_figshare_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.6084/m9.figshare.7891011"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "figshare")

    def test_dataverse_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.7910/DVN/X9L17C"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "dataverse")

    def test_mendeley_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.17632/abc123.2"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "mendeley")

    def test_envidat_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.16904/envidat.460"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "envidat")

    def test_osf_doi(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.17605/osf.io/abc12"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "osf")

    def test_unknown_doi_falls_through(self):
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.1234/example.5678"}]}
        provider, _ = df._classify_candidate(candidate)
        self.assertEqual(provider, "generic")

    def test_url_only_zenodo(self):
        candidate = {"url": "https://zenodo.org/records/9876543"}
        provider, hints = df._classify_candidate(candidate)
        self.assertEqual(provider, "zenodo")
        self.assertEqual(hints["host"], "zenodo.org")


class AdapterMockTests(unittest.TestCase):
    """Mock urlopen so the adapter layer is exercised without network.
    Each test verifies (1) the right API URL is requested and (2) the
    file list is parsed into download requests with the correct shape."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raw_dir = Path(self.tmp.name) / "raw"
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.captured_urls: list[str] = []

    def tearDown(self):
        self.tmp.cleanup()

    def _mock_urlopen(self, url_to_payload: dict[str, bytes]):
        """Build a mock urlopen that records URLs and returns canned
        bytes per URL prefix."""
        captured = self.captured_urls

        class FakeResp:
            def __init__(self, data):
                self._buf = io.BytesIO(data)
            def read(self, size=-1):
                return self._buf.read(size)
            def __enter__(self):
                return self
            def __exit__(self, *a):
                self._buf.close()

        def _fake(req, timeout=None):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            captured.append(url)
            for prefix, data in url_to_payload.items():
                if url.startswith(prefix):
                    return FakeResp(data)
            # Default: minimal CSV bytes for download steps
            return FakeResp(b"a,b\n1,2\n")

        return _fake

    def test_zenodo_adapter_parses_files(self):
        api_payload = json.dumps({
            "files": [
                {"key": "data.csv", "links": {"self": "https://zenodo.org/api/records/123/files/data.csv/content"}, "size": 100},
                {"key": "image.png", "links": {"self": "https://zenodo.org/api/records/123/files/image.png/content"}},  # filtered out
            ]
        }).encode()
        url_map = {"https://zenodo.org/api/records/123": api_payload}
        with mock.patch("urllib.request.urlopen", side_effect=self._mock_urlopen(url_map)):
            downloaded, errors = df._fetch_zenodo(
                {"doi": "10.5281/zenodo.123", "url": "", "host": "zenodo.org"},
                self.raw_dir,
                max_bytes_per_file=10_000,
                max_bytes_total=100_000,
                max_files=10,
            )
        self.assertEqual(len(downloaded), 1)
        self.assertEqual(downloaded[0].original_filename, "data.csv")
        self.assertEqual(errors, [])
        self.assertTrue(any("api/records/123" in u for u in self.captured_urls))

    def test_raw_sweep_recovers_unrouted_tabular_file(self):
        """Regression for the promotion bottleneck: real data (e.g. a GEO
        supplementary .xlsx/.csv) can land in raw/ outside the adapter's
        returned `downloaded` list. fetch_dataset must still normalise it into
        csv/ so the analysis stage sees the actual matrix, not only manifest /
        file-list CSVs. The adapter here reports NO downloads but seeds a
        tabular file in raw/."""
        target = Path(self.tmp.name) / "bundle"

        def _stub_adapter(hints, raw_dir, **caps):
            # data lands in raw/ but is NOT reported in `downloaded`
            (raw_dir / "real_matrix.csv").write_text("gene,s1,s2\nA,1,2\nB,3,4\n", encoding="utf-8")
            return [], []

        with mock.patch.dict(df._PROVIDERS, {"generic": _stub_adapter}, clear=False):
            summary = df.fetch_dataset({"url": "https://example.org/x", "title": "t"}, target)

        recovered = [e for e in summary["manifest"] if e.get("recovered_from_raw_sweep")]
        self.assertTrue(recovered, "unrouted raw tabular file should be recovered by the sweep")
        self.assertEqual(summary["status"], "fetched")
        self.assertTrue((target / "csv").glob("*.csv"))
        self.assertGreaterEqual(summary["csv_count"], 1)

    def test_figshare_adapter_parses_files(self):
        api_payload = json.dumps([
            {"name": "trial.csv", "download_url": "https://ndownloader.figshare.com/files/aaa", "size": 80},
            {"name": "trial.docx", "download_url": "https://ndownloader.figshare.com/files/bbb"},  # filtered
        ]).encode()
        url_map = {"https://api.figshare.com/v2/articles/789/files": api_payload}
        with mock.patch("urllib.request.urlopen", side_effect=self._mock_urlopen(url_map)):
            downloaded, _ = df._fetch_figshare(
                {"doi": "10.6084/m9.figshare.789", "url": "", "host": ""},
                self.raw_dir,
                max_bytes_per_file=10_000,
                max_bytes_total=100_000,
                max_files=10,
            )
        self.assertEqual(len(downloaded), 1)
        self.assertEqual(downloaded[0].original_filename, "trial.csv")

    def test_envidat_adapter_parses_resources(self):
        api_payload = json.dumps({
            "success": True,
            "result": {
                "resources": [
                    {"name": "concordia.csv", "url": "https://www.envidat.ch/files/concordia.csv",
                     "mimetype": "text/csv", "size": 1234},
                    {"name": "shape.geojson", "url": "https://www.envidat.ch/files/shape.geojson"},  # filtered
                ]
            }
        }).encode()
        url_map = {"https://www.envidat.ch/api/3/action/package_show": api_payload}
        with mock.patch("urllib.request.urlopen", side_effect=self._mock_urlopen(url_map)):
            downloaded, _ = df._fetch_envidat(
                {"doi": "10.16904/envidat.460", "url": "", "host": ""},
                self.raw_dir,
                max_bytes_per_file=10_000,
                max_bytes_total=100_000,
                max_files=10,
            )
        self.assertEqual(len(downloaded), 1)
        self.assertEqual(downloaded[0].original_filename, "concordia.csv")

    def test_ncbi_geo_url_only_candidate_routes_to_geo_adapter(self):
        provider, hints = df._classify_candidate({
            "url": "https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE282742",
        })
        self.assertEqual(provider, "ncbi_geo")
        self.assertEqual(hints["geo_accession"], "GSE282742")

    def test_ncbi_geo_adapter_fetches_supplementary_tabular_files(self):
        matrix_url = "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE282nnn/GSE282742/matrix/GSE282742_series_matrix.txt.gz"
        suppl_url = "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE282nnn/GSE282742/suppl/"
        suppl_html = b'''
            <html><body>
              <a href="GSE282742_expected_count.txt.gz">counts</a>
              <a href="GSE282742_TPM.txt.gz">tpm</a>
              <a href="README.pdf">readme</a>
            </body></html>
        '''
        url_map = {
            matrix_url: b"metadata-only",
            suppl_url: suppl_html,
            suppl_url + "GSE282742_expected_count.txt.gz": b"gene\ts1\nA\t1\n",
            suppl_url + "GSE282742_TPM.txt.gz": b"gene\ts1\nA\t2\n",
        }
        with mock.patch("urllib.request.urlopen", side_effect=self._mock_urlopen(url_map)):
            downloaded, errors = df._fetch_ncbi_geo(
                {"geo_accession": "GSE282742"},
                self.raw_dir,
                max_bytes_per_file=10_000,
                max_bytes_total=100_000,
                max_files=10,
            )
        names = {item.original_filename for item in downloaded}
        self.assertIn("GSE282742_series_matrix.txt.gz", names)
        self.assertIn("GSE282742_expected_count.txt.gz", names)
        self.assertIn("GSE282742_TPM.txt.gz", names)
        self.assertFalse(any(err.get("error") == "ncbi_geo_suppl_cap_reached" for err in errors))
        self.assertTrue(any(url == suppl_url for url in self.captured_urls))


class FetchDatasetEndToEndTests(unittest.TestCase):
    """End-to-end test of fetch_dataset() with a mocked Zenodo, exercising
    classifier → adapter → downloader → normalizer → manifest writer."""

    def test_zenodo_csv_end_to_end(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            target = Path(tmp.name) / "dataset_xyz"
            api_payload = json.dumps({
                "files": [{
                    "key": "study.csv",
                    "links": {"self": "https://zenodo.org/api/records/9876/files/study.csv/content"},
                    "size": 17,
                }]
            }).encode()
            csv_payload = b"city,temp\nphoenix,40\nsantiago,28\n"
            captured: list[str] = []

            class FakeResp:
                def __init__(self, data):
                    self._buf = io.BytesIO(data)
                def read(self, size=-1):
                    return self._buf.read(size)
                def __enter__(self):
                    return self
                def __exit__(self, *a):
                    self._buf.close()

            def _fake(req, timeout=None):
                url = req.full_url if hasattr(req, "full_url") else str(req)
                captured.append(url)
                if url.startswith("https://zenodo.org/api/records/9876"):
                    if "files/study.csv" in url:
                        return FakeResp(csv_payload)
                    return FakeResp(api_payload)
                return FakeResp(b"")

            with mock.patch("urllib.request.urlopen", side_effect=_fake):
                summary = df.fetch_dataset(
                    {"accessions": [{"repository": "DOI", "accession": "10.5281/zenodo.9876"}]},
                    target,
                )
            self.assertEqual(summary["status"], "fetched")
            self.assertEqual(summary["provider"], "zenodo")
            self.assertEqual(summary["downloaded_count"], 1)
            self.assertEqual(summary["csv_count"], 1)
            self.assertEqual(len(summary["manifest"]), 1)
            entry = summary["manifest"][0]
            self.assertEqual(entry["fetch_status"], "fetched")
            self.assertEqual(entry["row_count"], 2)
            self.assertEqual(entry["columns"], ["city", "temp"])
            # manifest.json on disk
            self.assertTrue((target / "manifest.json").is_file())
            # raw + csv files on disk
            self.assertTrue(any((target / "raw").iterdir()))
            self.assertTrue(any((target / "csv").iterdir()))
        finally:
            tmp.cleanup()

    def test_unsupported_format_yields_skipped(self):
        tmp = tempfile.TemporaryDirectory()
        try:
            target = Path(tmp.name) / "dataset_pdf"
            api_payload = json.dumps({
                "files": [{
                    "key": "paper.pdf",
                    "links": {"self": "https://zenodo.org/api/records/1111/files/paper.pdf/content"},
                }]
            }).encode()

            class FakeResp:
                def __init__(self, data):
                    self._buf = io.BytesIO(data)
                def read(self, size=-1):
                    return self._buf.read(size)
                def __enter__(self):
                    return self
                def __exit__(self, *a):
                    self._buf.close()

            def _fake(req, timeout=None):
                return FakeResp(api_payload)

            with mock.patch("urllib.request.urlopen", side_effect=_fake):
                summary = df.fetch_dataset(
                    {"accessions": [{"repository": "DOI", "accession": "10.5281/zenodo.1111"}]},
                    target,
                )
            self.assertIn(summary["status"], {"skipped_unsupported", "fetch_error"})
            self.assertEqual(summary["downloaded_count"], 0)
            self.assertEqual(summary["csv_count"], 0)
        finally:
            tmp.cleanup()


# ----------------------------------------------------------------------
# Optional live smoke (network-required) — gated behind --live

class LiveZenodoSmokeTest(unittest.TestCase):
    """Hit a small public Zenodo CSV record. Only runs with --live."""

    def test_live_fetch_small_zenodo_csv(self):
        if "--live" not in sys.argv:
            self.skipTest("live test gated by --live")
        # A small public Zenodo dataset (Iris CSV mirror, ~5KB)
        # Using a record id known to expose .csv files via the api.
        # If this record is removed, this test will fail and we can
        # update the id.
        candidate = {"accessions": [{"repository": "DOI", "accession": "10.5281/zenodo.5526382"}]}
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "live_smoke"
            summary = df.fetch_dataset(candidate, target, max_bytes_per_file=2_000_000)
            print("\n[live smoke] summary:", json.dumps({k: v for k, v in summary.items() if k != "manifest"}, indent=2))
            self.assertIn(summary["status"], {"fetched", "skipped_unsupported"})


if __name__ == "__main__":
    # Strip --live before unittest sees it
    if "--live" in sys.argv:
        # leave it — LiveZenodoSmokeTest checks for it
        pass
    unittest.main(verbosity=2, argv=[a for a in sys.argv if a != "--live"] if "--live" not in sys.argv else sys.argv)
