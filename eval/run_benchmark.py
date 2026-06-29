#!/usr/bin/env python3
"""Run a Harbor benchmark and append structured results to eval/results/benchmarks.jsonl."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RESULTS_PATH = REPO_ROOT / "eval" / "results" / "benchmarks.jsonl"
DEFAULT_TASK = REPO_ROOT / "eval" / "kv-store-grpc"


def parse_test_summary(stdout: str) -> tuple[int | None, int | None]:
    match = re.search(r"(\d+) failed, (\d+) passed", stdout)
    if match:
        failed = int(match.group(1))
        passed = int(match.group(2))
        return passed, passed + failed
    match = re.search(r"(\d+) passed", stdout)
    if match:
        passed = int(match.group(1))
        return passed, passed
    return None, None


def load_tool_call_count(job_dir: Path) -> int | None:
    trajectory_path = Path("/tmp/revcode-trajectory-host.jsonl")
    if not trajectory_path.exists():
        return None
    count = 0
    for line in trajectory_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "tool_call":
            count += 1
    return count


def find_trial_dir(job_dir: Path) -> Path | None:
    for child in sorted(job_dir.iterdir()):
        if child.is_dir() and child.name != "artifacts":
            return child
    return None


def collect_result(job_dir: Path, agent: str, benchmark: str) -> dict:
    job_result_path = job_dir / "result.json"
    job_result = json.loads(job_result_path.read_text(encoding="utf-8")) if job_result_path.exists() else {}

    trial_dir = find_trial_dir(job_dir)
    reward = None
    tests_passed = None
    tests_total = None
    failure_reason = None
    runtime_sec = job_result.get("stats", {}).get("duration_sec")
    if runtime_sec is None:
        started = job_result.get("started_at")
        finished = job_result.get("finished_at")
        if started and finished:
            from datetime import datetime

            start_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
            finish_dt = datetime.fromisoformat(finished.replace("Z", "+00:00"))
            runtime_sec = (finish_dt - start_dt).total_seconds()

    if trial_dir is not None:
        trial_result_path = trial_dir / "result.json"
        if trial_result_path.exists():
            trial_result = json.loads(trial_result_path.read_text(encoding="utf-8"))
            exception = trial_result.get("exception_info") or {}
            if exception:
                failure_reason = exception.get("exception_message") or exception.get("exception_type")

        reward_path = trial_dir / "verifier" / "reward.txt"
        if reward_path.exists():
            reward_text = reward_path.read_text(encoding="utf-8").strip()
            try:
                reward = float(reward_text)
            except ValueError:
                reward = None

        test_stdout_path = trial_dir / "verifier" / "test-stdout.txt"
        if test_stdout_path.exists():
            passed, total = parse_test_summary(test_stdout_path.read_text(encoding="utf-8"))
            tests_passed = passed
            tests_total = total

    if reward is None and failure_reason is None:
        rewards = job_result.get("stats", {}).get("reward_stats", {}).get("reward", {})
        if rewards:
            reward = max(float(k) for k in rewards)

    tool_calls = load_tool_call_count(job_dir)

    return {
        "benchmark": benchmark,
        "agent": agent,
        "solved": reward == 1.0 if reward is not None else False,
        "reward": reward,
        "runtime_sec": runtime_sec,
        "tests_passed": tests_passed,
        "tests_total": tests_total,
        "tool_calls": tool_calls,
        "model": "glm-4.7" if agent == "revcode" else None,
        "retries": 0,
        "failure_reason": failure_reason,
        "job_dir": str(job_dir.relative_to(REPO_ROOT)),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def append_result(record: dict) -> None:
    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with RESULTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def run_harbor(args: argparse.Namespace) -> Path:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(REPO_ROOT)

    harbor_bin = REPO_ROOT / "eval" / ".venv" / "bin" / "harbor"
    harbor_cmd = str(harbor_bin) if harbor_bin.exists() else "harbor"

    cmd = [
        harbor_cmd,
        "run",
        "-p",
        str(args.task),
        "-y",
        "--n-concurrent",
        "1",
        "--job-name",
        args.job_name,
    ]

    if args.agent == "oracle":
        cmd.extend(["-a", "oracle"])
    else:
        cmd.extend(
            [
                "--agent-import-path",
                "eval.revcode_agent:RevCodeAgent",
                "--env-file",
                str(REPO_ROOT / ".env"),
            ]
        )

    subprocess.run(cmd, cwd=REPO_ROOT, env=env, check=True)
    return REPO_ROOT / "jobs" / args.job_name


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--agent",
        choices=("oracle", "revcode"),
        default="revcode",
        help="Agent to benchmark (default: revcode)",
    )
    parser.add_argument(
        "--task",
        type=Path,
        default=DEFAULT_TASK,
        help="Path to a Harbor task directory",
    )
    parser.add_argument(
        "--job-name",
        default=None,
        help="Harbor job name (default: <agent>-<task>-<timestamp>)",
    )
    parser.add_argument(
        "--record-only",
        type=Path,
        default=None,
        help="Skip harbor run; parse an existing job directory",
    )
    args = parser.parse_args()

    benchmark = args.task.name
    if args.job_name is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        args.job_name = f"{args.agent}-{benchmark}-{stamp}"

    if args.record_only is not None:
        job_dir = args.record_only.resolve()
    else:
        job_dir = run_harbor(args)

    record = collect_result(job_dir, agent=args.agent, benchmark=benchmark)
    append_result(record)
    print(json.dumps(record, indent=2))
    print(f"Appended result to {RESULTS_PATH}")


if __name__ == "__main__":
    main()
