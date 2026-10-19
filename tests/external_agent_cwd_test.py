"""A file is not a directory, and `exists()` cannot tell you which you have."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "drivers" / "analysis"))

from python_stats_lib.external_agent import _external_agent_cwd


class ExternalAgentCwdTest(unittest.TestCase):
    def test_a_file_resolves_to_the_directory_it_lives_in(self):
        # cycle-g-v91: followup-analyst-16 named its own blueprint script as
        # local_path. The file existed, so it was returned as the working
        # directory and subprocess raised NotADirectoryError -- killing the first
        # runner lane to attempt a real execution after the instrument inventory
        # finally reported a renderer.
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "phase-sham-blueprint.py"
            script.write_text("print('hi')\n", encoding="utf-8")
            out = Path(directory) / "out"
            out.mkdir()
            self.assertEqual(
                _external_agent_cwd({"local_path": str(script)}, out),
                script.resolve().parent,
            )

    def test_a_directory_is_used_as_given(self):
        with tempfile.TemporaryDirectory() as directory:
            tool = Path(directory) / "tool"
            tool.mkdir()
            out = Path(directory) / "out"
            out.mkdir()
            self.assertEqual(_external_agent_cwd({"local_path": str(tool)}, out), tool.resolve())

    def test_a_path_that_is_not_there_falls_back_to_the_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "out"
            out.mkdir()
            self.assertEqual(
                _external_agent_cwd({"local_path": str(Path(directory) / "absent")}, out),
                out.resolve(),
            )
            self.assertEqual(_external_agent_cwd({}, out), out.resolve())


if __name__ == "__main__":
    unittest.main()
