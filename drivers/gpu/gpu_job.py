#!/usr/bin/env python3
"""Run a command on the GPU from inside a lane whose sandbox cannot see it.

    python drivers/gpu/gpu_job.py --lane-dir .research-lab/lanes/<cycle>/<lane> \
        [--timeout 3600] [--env KEY=VALUE ...] [--id NAME] -- <interpreter> <script> [args...]

A lane's sandbox has a synthetic /dev, so the GPU device is not there and
``torch.cuda.is_available()`` is False whatever the machine has. This client does
not run anything itself: it writes a request into the lane's ``gpu-jobs/``
directory and waits. The harness process supervising the lane -- outside the
lane's sandbox -- runs the request in a sandbox of its own and writes the result
back (native/researchlab-harness/src/runtime/gpu_jobs.rs).

What the job gets: the GPU; the whole filesystem read-only; write access to the
lane directory, the lane's artifact directory and the cycle's dataset directory;
NO network; a cleared environment plus what ``--env`` names. So install and
download first, in the lane, and hand the job an interpreter and files that are
already on disk.

The GPU is shared with the owner's other work, which goes first: a job does not
start while the GPU is in use by something else. It waits (the wait is not counted
against --timeout) and, if the GPU stays busy, is handed back as ``gpu_busy``
without having run.

Exit code: the job's own; 124 on timeout; 125 if the request was rejected; 75 if
the GPU stayed in use by other work and nothing ran; 3 if no broker is serving
this lane. The result JSON is printed last, on one line
starting with ``GPU_JOB_RESULT ``.

Standard library only: it has to run under any interpreter a lane has.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

JOB_ID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


def parse_env(pairs: list[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for pair in pairs:
        key, sep, value = pair.partition("=")
        if not sep or not ENV_KEY.match(key):
            raise SystemExit(f"--env takes KEY=VALUE with a variable name as KEY, got {pair!r}")
        env[key] = value
    return env


def build_request(argv: list[str], timeout: int, env: dict[str, str]) -> dict:
    if not argv:
        raise SystemExit("nothing to run: put the interpreter and script after `--`")
    program = argv[0]
    if not os.path.isabs(program):
        # The job starts in the project root; an absolute interpreter is what the
        # record should show and what the harness requires.
        program = os.path.abspath(program)
    if timeout <= 0:
        raise SystemExit("--timeout must be positive")
    return {"argv": [program, *argv[1:]], "timeout_seconds": int(timeout), "env": env}


def write_request(job_dir: Path, job_id: str, request: dict) -> Path:
    job_dir.mkdir(parents=True, exist_ok=True)
    path = job_dir / f"{job_id}.request.json"
    if path.exists() or (job_dir / f"{job_id}.result.json").exists():
        raise SystemExit(f"a job named {job_id!r} already exists in {job_dir}; pick another --id")
    tmp = job_dir / f".{job_id}.request.tmp"
    tmp.write_text(json.dumps(request, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    return path


def wait_for(path: Path, seconds: float, poll: float = 0.5) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(poll)
    return path.exists()


def read_json(path: Path) -> dict:
    for _ in range(20):  # the writer may be mid-rename
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            time.sleep(0.25)
    return {"status": "failed", "error": f"{path} could not be read"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lane-dir", required=True, help="this lane's directory, .research-lab/lanes/<cycle>/<lane>")
    parser.add_argument("--timeout", type=int, default=3600, help="seconds the job may run (the harness caps it)")
    parser.add_argument("--env", action="append", default=[], metavar="KEY=VALUE")
    parser.add_argument("--id", default=None, help="a name for the job's files; default: job-<time>")
    parser.add_argument("--accept-timeout", type=float, default=120.0, help="seconds to wait for the broker to take the job")
    parser.add_argument("command", nargs=argparse.REMAINDER, help="-- <interpreter> <script> [args...]")
    args = parser.parse_args(argv)

    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    job_id = args.id or f"job-{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
    if not JOB_ID.match(job_id):
        raise SystemExit("--id may use letters, digits, '.', '_' and '-' (at most 80, not starting with '.')")
    request = build_request(command, args.timeout, parse_env(args.env))
    job_dir = Path(args.lane_dir) / "gpu-jobs"
    write_request(job_dir, job_id, request)

    accepted = job_dir / f"{job_id}.accepted.json"
    result_path = job_dir / f"{job_id}.result.json"
    # A rejected request is answered without ever being accepted.
    deadline = time.monotonic() + args.accept_timeout
    while time.monotonic() < deadline and not accepted.exists() and not result_path.exists():
        time.sleep(0.5)
    if not accepted.exists() and not result_path.exists():
        unavailable = job_dir / "UNAVAILABLE.txt"
        why = unavailable.read_text(encoding="utf-8").strip() if unavailable.exists() else (
            "no GPU job broker is serving this lane (it serves lanes that provision environments, while they run)"
        )
        print(f"GPU job {job_id} was not taken within {args.accept_timeout:.0f}s: {why}", file=sys.stderr)
        try:
            (job_dir / f"{job_id}.request.json").rename(job_dir / f"{job_id}.request.unserved.json")
        except OSError:
            pass
        return 3

    # The harness may hold the job while other work uses the GPU; it says for how long.
    gpu_wait = 0
    if accepted.exists():
        try:
            gpu_wait = int(read_json(accepted).get("max_gpu_wait_seconds") or 0)
        except (TypeError, ValueError):
            gpu_wait = 0
    budget = args.timeout + gpu_wait + 120
    if not wait_for(result_path, budget):
        print(f"GPU job {job_id} produced no result within {budget}s", file=sys.stderr)
        return 124
    result = read_json(result_path)
    for stream in ("stdout_tail", "stderr_tail"):
        text = str(result.get(stream) or "").rstrip()
        if text:
            print(f"--- {stream.split('_')[0]} (tail) ---\n{text}")
    summary = {key: result.get(key) for key in ("job_id", "status", "exit_code", "elapsed_seconds", "error", "stdout_path", "stderr_path")}
    print("GPU_JOB_RESULT " + json.dumps(summary))
    status = result.get("status")
    if status == "completed":
        return 0
    if status == "timeout":
        return 124
    if status == "rejected":
        return 125
    if status == "gpu_busy":
        return 75
    code = result.get("exit_code")
    return code if isinstance(code, int) and code != 0 else 1


if __name__ == "__main__":
    sys.exit(main())
