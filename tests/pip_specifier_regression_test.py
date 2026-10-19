"""A malformed dependency must not take the lane down with it.

Allowing PEP 440 operators through the pip sanitizer (so `numpy>=1.26` stops
being dropped) let a blueprint's literal `python>=3` reach
`_import_name_for_package`, which only ever split on `==`. The import name came
out as the entire requirement string, and `importlib.util.find_spec("python>=3")`
RAISES ModuleNotFoundError rather than returning None. It escaped the caller and
killed the lane before any blueprint ran: cycle-g-v85 lost followup-runner-43
through -47, five consecutive lanes with no result.json at all.

`python>=3` is not installable and never will be -- it is a common artifact of
generated dependency lists. The point is not to make it work. The point is that
the driver reports it and keeps going.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_DRIVER = _REPO / "drivers" / "analysis" / "python_stats.py"

_spec = importlib.util.spec_from_file_location("python_stats_pip", _DRIVER)
_mod = importlib.util.module_from_spec(_spec)
sys.modules["python_stats_pip"] = _mod
_spec.loader.exec_module(_mod)

_split = _mod._split_already_importable_packages
_import_name = _mod._import_name_for_package
_importable = _mod._module_is_importable
_filter = _mod._filter_pip_install_request


class TheV85Crash(unittest.TestCase):
    def test_python_ge_3_does_not_raise(self):
        missing, already = _split(["python>=3"])
        self.assertEqual(missing, ["python>=3"])
        self.assertEqual(already, [])

    def test_it_reaches_pip_rather_than_find_spec(self):
        # Anything carrying a constraint is pip's problem: the constraint has to
        # be honoured, and the string is not a module name.
        missing, already = _split(["numpy>=1.26", "mitsuba==3.8.0", "torch~=2.1"])
        self.assertEqual(already, [])
        self.assertEqual(missing, ["numpy>=1.26", "mitsuba==3.8.0", "torch~=2.1"])

    def test_find_spec_guard_answers_no_instead_of_raising(self):
        for garbage in ("python>=3", "not/a/module", "", "1234", "a b"):
            self.assertFalse(_importable(garbage), garbage)


class TheNameIsStillDerivedCorrectly(unittest.TestCase):
    def test_every_operator_is_stripped(self):
        cases = {
            "numpy>=1.26": "numpy",
            "mitsuba==3.8.0": "mitsuba",
            "torch~=2.1": "torch",
            "matplotlib!=3.9": "matplotlib",
            "scipy<2": "scipy",
            "pandas<=2.2": "pandas",
            "pandas": "pandas",
        }
        for requirement, expected in cases.items():
            self.assertEqual(_import_name(requirement), expected, requirement)

    def test_ge_is_not_cut_as_gt(self):
        # ">=" must be matched before ">", or the name keeps a trailing "=".
        self.assertEqual(_import_name("numpy>=1.26"), "numpy")

    def test_overrides_still_apply(self):
        self.assertEqual(_import_name("scikit-learn>=1.4"), "sklearn")
        self.assertEqual(_import_name("opencv-python"), "cv2")

    def test_a_present_unpinned_module_is_still_skipped(self):
        missing, already = _split(["json"])
        self.assertEqual(already, ["json"])
        self.assertEqual(missing, [])


class TheDualUseGuardIsUnchanged(unittest.TestCase):
    def test_real_pins_survive_the_sanitizer(self):
        allowed, rejected = _filter(["numpy>=1.26", "pandas>=2.0", "mitsuba==3.8.0"])
        self.assertEqual(allowed, ["numpy>=1.26", "pandas>=2.0", "mitsuba==3.8.0"])
        self.assertEqual(rejected, [])

    def test_urls_and_git_refs_are_still_refused(self):
        allowed, rejected = _filter(["git+https://example/x", "http://example/y", "a b", "x --index-url z"])
        self.assertEqual(allowed, [])
        self.assertEqual(len(rejected), 4)


if __name__ == "__main__":
    unittest.main()


class ADescribedRuntimeIsReadAsNames(unittest.TestCase):
    # MEASURED ON cycle-a-20260919, 2026-10-19: handoffs list their
    # runtime as "pandas 3.0.6"; 804 lane results rejected every entry for its
    # space, so nothing was ever recognised as present or installed.
    def test_name_and_version_becomes_the_bare_name(self):
        allowed, rejected = _filter(["pandas 3.0.6", "scipy v1.17.0", "Python 3.12", "numpy>=1.26"])
        self.assertEqual(allowed, ["pandas", "scipy", "numpy>=1.26"])
        self.assertEqual(rejected, [{"input": "Python 3.12", "reason": "interpreter_not_a_package"}])

    def test_a_space_is_still_refused_everywhere_else(self):
        for hostile in ("numpy --index-url x", "pkg @ https://x", "a b c", "git+https://x y"):
            allowed, rejected = _filter([hostile])
            self.assertEqual(allowed, [], hostile)
            self.assertEqual(len(rejected), 1, hostile)
