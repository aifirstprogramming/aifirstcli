#!/usr/bin/env python3
"""Drive the generated rocket replay through aifirst learn stream JSON."""

import json
import os
import select
import subprocess
import sys
import time


def user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"


def main() -> int:
    bun, entry, workspace, fixture = sys.argv[1:5]
    with open(os.path.join(fixture, "capture.json"), encoding="utf-8") as capture_file:
        prompt = json.load(capture_file)["prompt"]
    answers = [prompt, "Standard (Book Recommended)", "Approve and build"]
    triggers = [None, "How much detail should the per-tick telemetry output include", "Proposed plan"]

    proc = subprocess.Popen(
        [
            bun,
            "run",
            entry,
            "learn",
            "--",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "-p",
        ],
        cwd=workspace,
        env=os.environ.copy(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None
    assert proc.stdout is not None
    proc.stdin.write(user_message(answers[0]))
    proc.stdin.flush()
    answer_index = 1
    completed = False
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 0.25)
        if not ready:
            if proc.poll() is not None:
                break
            continue
        line = proc.stdout.readline()
        if not line:
            break
        sys.stdout.write(line)
        sys.stdout.flush()
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "result":
            continue
        result = str(event.get("result", ""))
        if "Rocket simulation complete." in result:
            completed = True
            break
        if answer_index < len(answers) and triggers[answer_index] in result:
            proc.stdin.write(user_message(answers[answer_index]))
            proc.stdin.flush()
            answer_index += 1

    proc.stdin.close()
    proc.stdin = None
    if not completed:
        proc.terminate()
    try:
        _, stderr = proc.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        _, stderr = proc.communicate()
    sys.stderr.write(stderr)
    return 0 if completed and answer_index == len(answers) else 2


if __name__ == "__main__":
    raise SystemExit(main())
