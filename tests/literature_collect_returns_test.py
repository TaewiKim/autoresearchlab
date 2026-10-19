"""A helper inserted mid-function cut the search in half, and nothing noticed.

`3f5d3c8` added `_is_throttle_error` between `collect_query_papers`'s cache
block and its retrieval body. Python accepted it without complaint: the
retrieval body kept its indentation and became unreachable code after the
helper's `return`, while `collect_query_papers` fell off the end of its cache
block and returned None.

Every caller unpacks two values from it. On cycle-g-v91 both followup-scout
lanes died with

    TypeError: cannot unpack non-iterable NoneType object
      collect.py line 231, in collect_papers
        query_papers, query_stats = collect_query_papers(query, sources, objective)

and the cycle carried two more blocking failures for it. The existing tests
passed throughout, because they exercised the cache-HIT path -- which returns
inside the block that survived.

These tests pin the contract every caller depends on: the function returns a
pair, on the cache-miss path as well as the cache-hit one.
"""

import ast
import inspect
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "drivers" / "literature"))

from search_lib import collect  # noqa: E402


def _function_node(name):
    source = pathlib.Path(collect.__file__).read_text(encoding="utf-8")
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} is gone")


def test_collect_query_papers_owns_its_retrieval_body():
    node = _function_node("collect_query_papers")
    body = ast.get_source_segment(
        pathlib.Path(collect.__file__).read_text(encoding="utf-8"), node
    )
    # The retrieval body must be inside this function, not stranded in whatever
    # helper happens to be defined above it.
    assert "ThreadPoolExecutor" in body, "the retrieval body is not in collect_query_papers"
    assert 'return payload["papers"], payload["source_stats"]' in body


def test_every_path_out_of_collect_query_papers_returns_a_pair():
    """A path that returns nothing is the bug; a path that returns one value
    would be the same bug wearing a different message."""
    node = _function_node("collect_query_papers")
    returns = [n for n in ast.walk(node) if isinstance(n, ast.Return)]
    assert returns, "collect_query_papers has no return at all"
    for statement in returns:
        assert statement.value is not None, (
            f"a bare return at line {statement.lineno} sends None to a caller that unpacks two values"
        )
        assert isinstance(statement.value, ast.Tuple) and len(statement.value.elts) == 2, (
            f"the return at line {statement.lineno} is not a pair"
        )
    # And the function cannot simply run off its end.
    assert isinstance(node.body[-1], ast.Return), (
        "collect_query_papers can fall off its end, which returns None"
    )


def test_the_throttle_helper_is_its_own_function():
    node = _function_node("_is_throttle_error")
    # Nothing but the classification itself: a body that continues past the
    # helper's return is how the search went missing in the first place.
    assert isinstance(node.body[-1], ast.Return)
    source = ast.get_source_segment(
        pathlib.Path(collect.__file__).read_text(encoding="utf-8"), node
    )
    assert "ThreadPoolExecutor" not in source, "the retrieval body is inside the throttle helper again"


def test_the_helper_still_classifies_what_it_was_written_for():
    class Refused(Exception):
        code = 429

    assert collect._is_throttle_error(Refused("Too Many Requests")) is True
    assert collect._is_throttle_error(Exception("503 Service Unavailable")) is True
    assert collect._is_throttle_error(Exception("no results for this query")) is False


def test_callers_unpack_two_values():
    # If a caller ever stops unpacking a pair, the contract above is the wrong
    # one to be pinning and this test should fail first.
    source = pathlib.Path(collect.__file__).read_text(encoding="utf-8")
    assert "query_papers, query_stats = collect_query_papers(" in source
