"""The lane-side client of the harness's GPU job runner.

The client runs nothing: it writes a request and waits for the harness to answer.
These tests play the harness.
"""
import importlib.util
import json
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("gpu_job", ROOT / "drivers" / "gpu" / "gpu_job.py")
gpu_job = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gpu_job)


def answer(job_dir: Path, job_id: str, result: dict, accept: bool = True) -> threading.Thread:
    """Play the broker: take the request when it appears, then write the result."""

    def serve():
        request = job_dir / f"{job_id}.request.json"
        deadline = time.monotonic() + 20
        while not request.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        if accept:
            (job_dir / f"{job_id}.accepted.json").write_text("{}", encoding="utf-8")
        (job_dir / f"{job_id}.result.json").write_text(json.dumps(result), encoding="utf-8")

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return thread


def test_the_request_is_what_the_harness_validates(tmp_path):
    lane = tmp_path / "followup-engineer-9"
    answer(lane / "gpu-jobs", "probe", {"status": "completed", "exit_code": 0, "stdout_tail": "True RTX"})
    code = gpu_job.main(["--lane-dir", str(lane), "--id", "probe", "--timeout", "60", "--env", "CUDA_VISIBLE_DEVICES=0",
                         "--", "/usr/bin/python3", "eval.py", "--episodes", "5"])
    assert code == 0
    request = json.loads((lane / "gpu-jobs" / "probe.request.json").read_text(encoding="utf-8"))
    assert request["argv"][1:] == ["eval.py", "--episodes", "5"]
    assert Path(request["argv"][0]).is_absolute()
    assert request["timeout_seconds"] == 60
    assert request["env"] == {"CUDA_VISIBLE_DEVICES": "0"}


def test_the_exit_code_is_the_jobs(tmp_path, capsys):
    lane = tmp_path / "lane"
    answer(lane / "gpu-jobs", "fails", {"status": "failed", "exit_code": 7, "stderr_tail": "CUDA out of memory"})
    assert gpu_job.main(["--lane-dir", str(lane), "--id", "fails", "--", "/usr/bin/python3", "x.py"]) == 7
    out = capsys.readouterr().out
    assert "CUDA out of memory" in out
    assert "GPU_JOB_RESULT " in out and '"exit_code": 7' in out

    answer(lane / "gpu-jobs", "slow", {"status": "timeout", "exit_code": None})
    assert gpu_job.main(["--lane-dir", str(lane), "--id", "slow", "--", "/usr/bin/python3", "x.py"]) == 124
    # A rejected request is answered without ever being accepted.
    answer(lane / "gpu-jobs", "bad", {"status": "rejected", "error": "argv[0] does not exist"}, accept=False)
    assert gpu_job.main(["--lane-dir", str(lane), "--id", "bad", "--", "/no/such/python", "x.py"]) == 125


def test_no_broker_is_reported_as_no_broker_not_as_no_gpu(tmp_path, capsys):
    lane = tmp_path / "lane"
    code = gpu_job.main(["--lane-dir", str(lane), "--id", "orphan", "--accept-timeout", "1", "--", "/usr/bin/python3", "x.py"])
    assert code == 3
    assert "no GPU job broker is serving this lane" in capsys.readouterr().err
    # The unserved request is set aside so a later broker does not run a stale job.
    assert not (lane / "gpu-jobs" / "orphan.request.json").exists()
    assert (lane / "gpu-jobs" / "orphan.request.unserved.json").exists()

    # When the harness has said why it cannot serve, that is the message.
    (lane / "gpu-jobs" / "UNAVAILABLE.txt").write_text("bubblewrap (bwrap) is not installed\n", encoding="utf-8")
    assert gpu_job.main(["--lane-dir", str(lane), "--id", "orphan2", "--accept-timeout", "1", "--", "/usr/bin/python3", "x.py"]) == 3
    assert "bwrap" in capsys.readouterr().err


def test_a_job_name_is_used_once_and_malformed_input_is_refused(tmp_path):
    lane = tmp_path / "lane"
    answer(lane / "gpu-jobs", "once", {"status": "completed", "exit_code": 0})
    assert gpu_job.main(["--lane-dir", str(lane), "--id", "once", "--", "/usr/bin/python3", "x.py"]) == 0
    for argv in (
        ["--lane-dir", str(lane), "--id", "once", "--", "/usr/bin/python3", "x.py"],  # the name is taken
        ["--lane-dir", str(lane), "--id", "../escape", "--", "/usr/bin/python3", "x.py"],
        ["--lane-dir", str(lane), "--id", "empty", "--"],
        ["--lane-dir", str(lane), "--id", "env", "--env", "NOT A KEY=1", "--", "/usr/bin/python3", "x.py"],
        ["--lane-dir", str(lane), "--id", "t", "--timeout", "0", "--", "/usr/bin/python3", "x.py"],
    ):
        try:
            gpu_job.main(argv)
        except SystemExit as stop:
            assert stop.code not in (0, None), argv
        else:
            raise AssertionError(f"accepted: {argv}")
