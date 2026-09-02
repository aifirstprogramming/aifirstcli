#!/usr/bin/env python3
"""Drive chapter 10 local-learning turns through Claude Code stream JSON."""

import json
import os
import select
import subprocess
import sys
import time


PROMPTS = {
    "editor": "Design a level editor for the savetheduckling game.",
    "undo": "Implement undo/redo for the level editor.",
    "pathfinder": "Create a path finding algorithm for the level editor to test if a level is beatable. Make it animated.",
}
COMPLETION_MARKERS = (
    "Replay completed",
    "Everything compiles and behaves correctly",
    "Everything checks out",
    "Everything passes cleanly",
)


def answer_is_requested(answer: str, result: str) -> bool:
    if answer.startswith("{"):
        parsed = json.loads(answer).get("answers", {})
        if "level_format" in parsed:
            return "How should levels be stored/loaded" in result
        if "fox_handling" in parsed:
            return "Should the beatability check treat fox patrol lines" in result
    return "Proposed plan" in result if answer == "Approve and build" else answer in result


def user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"


def main() -> int:
    bun, entry, workspace, mode = sys.argv[1:5]
    editor_answers = json.dumps({"answers": {
        "level_format": "JSON files (Book Recommended)",
        "editor_ui": "Standalone script (Book Recommended)",
        "feature_scope": "Core grid placement (Book Recommended)",
    }})
    pathfinder_answers = json.dumps({"answers": {
        "fox_handling": "Ignore foxes, check static connectivity (Book Recommended)",
        "animation_style": "Frontier expansion + final path (Book Recommended)",
    }})
    if mode == "editor":
        answers = [PROMPTS[mode], editor_answers, "Approve and build"]
    elif mode == "pathfinder":
        answers = [PROMPTS[mode], pathfinder_answers, "Approve and build"]
    elif mode == "undo":
        answers = [PROMPTS[mode], "Approve and build"]
    else:
        raise ValueError(f"unsupported chapter 10 mode: {mode}")

    proc = subprocess.Popen(
        [
            bun, "run", entry, "learn", "--claude", "--",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose", "-p",
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
    deadline = time.monotonic() + 90
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
        if any(marker in result for marker in COMPLETION_MARKERS):
            completed = True
            break
        if "replay stopped" in result.lower():
            break
        if answer_index < len(answers) and answer_is_requested(answers[answer_index], result):
            proc.stdin.write(user_message(answers[answer_index]))
            proc.stdin.flush()
            answer_index += 1

    proc.stdin.close()
    proc.stdin = None
    if not completed:
        proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    stderr = proc.stderr.read() if proc.stderr is not None else ""
    if stderr:
        sys.stderr.write(stderr)
    return 0 if completed and proc.returncode == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
