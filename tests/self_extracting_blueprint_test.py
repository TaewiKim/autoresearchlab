"""A blueprint that decodes itself at runtime is refused before it runs.

cycle-g-v86 lost followup-runner-44, -45, -46 and -47 to
`zlib.error: Error -3 while decompressing data: invalid distance too far back`.
It looked like the data corruption that cost v85 two hours, and it was not. The
analyst had emitted the entire blueprint as one line:

    exec(compile(gzip.decompress(base64.b64decode('H4sIAAAAAAACA608...')), ...))

7,920 characters of base64 on -44/-45/-46 and 10,392 on -47. The base64 decoded
cleanly. The gzip magic was right. The trailer declared a plausible 21,037
uncompressed bytes. The DEFLATE payload produced ZERO bytes before erroring --
a correct opening, a correct-looking close, and a middle that was never a real
compressed stream, which is what a model reproducing a long base64 string
produces. -44, -45 and -46 carried a byte-identical blob, so the same unusable
blueprint was dispatched three times.

The guard is narrow on purpose. Embedding a long encoded constant is legitimate
-- a fixture, a reference image. Only decoding one and exec()ing it is refused.
"""

import base64
import gzip
import importlib.util
import os
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_selfextract", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_selfextract"] = _mod
_spec.loader.exec_module(_mod)

_reason = sys.modules["python_stats_lib.blueprint_run"]._self_extracting_blueprint_reason

# Incompressible, so the encoded form is the size a real blueprint blob reaches.
BLOB = base64.b64encode(gzip.compress(os.urandom(6000))).decode()


class TheV86Shape(unittest.TestCase):
    def test_exec_of_a_decoded_payload_is_refused(self):
        script = (
            "import gzip, base64\n"
            f"exec(compile(gzip.decompress(base64.b64decode('{BLOB}')), 'x', 'exec'))\n"
        )
        reason = _reason(script)
        self.assertIsNotNone(reason)
        self.assertIn("blueprint_self_extracting", reason)
        # It has to tell the analyst what to do instead.
        self.assertIn("Emit the Python source directly", reason)
        self.assertIn(str(len(BLOB)), reason)

    def test_every_decoder_is_covered(self):
        for decoder in ("gzip.decompress", "zlib.decompress", "bz2.decompress",
                        "lzma.decompress", "codecs.decode"):
            script = f"exec({decoder}(base64.b64decode('{BLOB}')))\n"
            self.assertIsNotNone(_reason(script), decoder)

    def test_eval_counts_too(self):
        script = f"eval(zlib.decompress(base64.b64decode('{BLOB}')))\n"
        self.assertIsNotNone(_reason(script))


class LegitimateScriptsAreLeftAlone(unittest.TestCase):
    def test_plain_source_passes(self):
        self.assertIsNone(_reason(
            "import pandas as pd\nimport mitsuba as mi\n"
            "df = pd.DataFrame({'seed': [1, 2]})\ndf.to_csv('out.csv', index=False)\n"
        ))

    def test_a_long_embedded_constant_is_not_the_problem(self):
        """Embedding encoded data is fine. Executing it is not."""
        self.assertIsNone(_reason(f"REFERENCE_IMAGE = '{BLOB}'\nprint(len(REFERENCE_IMAGE))\n"))

    def test_a_short_decode_without_exec_passes(self):
        self.assertIsNone(_reason("import base64\nkey = base64.b64decode('c2hvcnQ=')\n"))

    def test_exec_without_an_encoded_payload_passes(self):
        # Some blueprints legitimately exec a small generated snippet.
        self.assertIsNone(_reason("code = 'x = 1'\nexec(code)\nprint(x)\n"))

    def test_a_decoder_without_exec_passes(self):
        self.assertIsNone(_reason(
            f"import gzip, base64\nraw = gzip.decompress(base64.b64decode('{BLOB}'))\n"
            "open('fixture.bin','wb').write(raw)\n"
        ))


if __name__ == "__main__":
    unittest.main()
