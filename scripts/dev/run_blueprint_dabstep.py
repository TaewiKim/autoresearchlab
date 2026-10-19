#!/usr/bin/env python3
"""Execute one benchmark blueprint with the researchlab blueprint executor.

This reuses _run_blueprint() from drivers/analysis/python_stats.py — the same
write->run->observe runner the analyst->lab-runner loop uses inside a cycle —
so benchmark answers are produced by actually executed code, never by an LLM
answering from memory. Prints a JSON result (status/stdout/stderr) to stdout.

  python3 scripts/dev/run_blueprint_dabstep.py --code-file <script.py> \
      --csv-root <context_dir> --out-root <dir> --check-id <id> [--timeout 240]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def load_stats_module(repo_root: Path):
    # python_stats.py exec()-loads its part files into module globals, so a
    # spec-based import gives us Blueprint + _run_blueprint directly.
    sys.path.insert(0, str(repo_root))
    path = repo_root / "drivers" / "analysis" / "python_stats.py"
    spec = importlib.util.spec_from_file_location("python_stats", path)
    mod = importlib.util.module_from_spec(spec)
    # Register before exec: @dataclass resolves cls.__module__ via sys.modules.
    sys.modules["python_stats"] = mod
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--code-file", required=True)
    ap.add_argument("--csv-root", required=True)
    ap.add_argument("--out-root", required=True)
    ap.add_argument("--check-id", required=True)
    ap.add_argument("--timeout", type=int, default=240)
    a = ap.parse_args()

    repo_root = Path(__file__).resolve().parents[2]
    stats = load_stats_module(repo_root)
    blueprint = stats.Blueprint(
        blueprint_id=a.check_id,
        check_id=a.check_id,
        code=Path(a.code_file).read_text(encoding="utf-8"),
        entrypoint=None,
        dataset=None,
        outcome=None,
    )
    ex = stats._run_blueprint(
        blueprint,
        csv_root=Path(a.csv_root),
        output_root=Path(a.out_root),
        timeout_seconds=a.timeout,
        derived_indicators_for_blueprint=[],
    )

    def tail(path: str, n: int) -> str:
        p = Path(path)
        if not p.exists():
            return ""
        return p.read_text(encoding="utf-8", errors="replace")[-n:]

    print(
        json.dumps(
            {
                "status": ex.status,
                "return_code": ex.return_code,
                "duration_seconds": round(ex.duration_seconds, 1),
                "error": ex.error,
                "stdout": tail(ex.stdout_path, 6000),
                "stderr": tail(ex.stderr_path, 3000),
                "script_path": ex.script_path,
            }
        )
    )


if __name__ == "__main__":
    main()
