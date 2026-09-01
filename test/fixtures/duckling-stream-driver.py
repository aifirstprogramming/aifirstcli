#!/usr/bin/env python3
"""Drive multiple local-learning turns through Claude Code stream JSON."""

import json
import os
import select
import subprocess
import sys
import time


DUCKLING_PROMPT = "Make a game about a baby duckling who is trying to find its mother using pygame."
FOX_PROMPT = "The game currently has no enemies. Add a fox to the game."
LEVELS_PROMPT = "Make two more levels for the game. Each level should get harder with more obstacles and enemies."
COMPLETION_MARKERS = (
    "Replay completed",
    "The game is complete and working",
    "Added two foxes",
    "The game now has three levels of increasing difficulty",
)


def answer_is_requested(answer: str, result: str) -> bool:
    if answer.startswith("{"):
        parsed = json.loads(answer).get("answers", {})
        if "game_style" in parsed:
            return "What style of gameplay" in result
        if "transition" in parsed:
            return "How should the game transition between levels" in result
    triggers = {
        "py-9-03": "Several AI First exercises may match this prompt",
        "yes": "A replay may match this prompt",
        "Top-down maze/exploration (Book Recommended)": "What style of gameplay",
        "Side-scrolling platformer": "What style of gameplay",
        "Collect siblings (Book Recommended)": "What should make the search challenging",
        "Simple sprite images (Book Recommended)": "What visual style",
        "Generate simple PNG sprites programmatically (Book Recommended)": "How should the duckling/mother/sibling/background sprites be sourced",
        "Brief 'Level Complete' screen, then auto-advance (Book Recommended)": "How should the game transition between levels",
        "Add patrol variety (Book Recommended)": "How should difficulty ramp up",
        "Increase siblings per level (e.g. 6, 8, 10) (Book Recommended)": "Should the number of siblings to collect also increase",
        "Use book-recommended answer": "This choice needs an LLM",
        "Approve and build": "Proposed plan",
    }
    return triggers.get(answer, answer) in result


def user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"


def main() -> int:
    bun, entry, workspace, mode = sys.argv[1:5]
    game_answers = json.dumps({"answers": {
        "game_style": "Top-down maze/exploration (Book Recommended)",
        "challenge": "Collect siblings (Book Recommended)",
        "art_style": "Simple sprite images (Book Recommended)",
    }})
    level_answers = json.dumps({"answers": {
        "transition": "Brief 'Level Complete' screen, then auto-advance (Book Recommended)",
        "difficulty_style": "Add patrol variety (Book Recommended)",
        "sibling_count": "Increase siblings per level (e.g. 6, 8, 10) (Book Recommended)",
    }})
    if mode == "fox":
        answers = [FOX_PROMPT]
    elif mode == "levels":
        answers = [LEVELS_PROMPT, level_answers, "Approve and build"]
    elif mode == "fuzzy":
        answers = ["baby duckling who is trying to find its mother", "yes", game_answers, "Generate simple PNG sprites programmatically (Book Recommended)", "Approve and build"]
    elif mode == "fallback":
        answers = [DUCKLING_PROMPT, "Side-scrolling platformer", "Use book-recommended answer"]
        answers.extend([
            "Collect siblings (Book Recommended)",
            "Simple sprite images (Book Recommended)",
            "Generate simple PNG sprites programmatically (Book Recommended)",
            "Approve and build",
        ])
    else:
        answers = [DUCKLING_PROMPT, game_answers, "Generate simple PNG sprites programmatically (Book Recommended)", "Approve and build"]

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
    deadline = time.monotonic() + 30
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
        if answer_index < len(answers) and answer_is_requested(answers[answer_index], result):
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
