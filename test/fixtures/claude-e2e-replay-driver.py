#!/usr/bin/env python3
"""Drive generated progressive content through `aifirst learn` stream JSON."""

import json
import os
import select
import shutil
import subprocess
import sys
import time


def user_message(text: str) -> str:
    return json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n"


def snapshot(workspace: str, checkpoint: str, expected_files):
    os.makedirs(checkpoint, exist_ok=True)
    for relative in expected_files:
        source = os.path.join(workspace, relative)
        if not os.path.isfile(source):
            raise RuntimeError(f"Expected replay file is missing: {relative}")
        target = os.path.join(checkpoint, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)


def main() -> int:
    bun, entry, workspace, capture_path, book_path = sys.argv[1:6]
    with open(capture_path, encoding="utf-8") as source:
        capture = json.load(source)
    fixture = os.path.dirname(capture_path)
    checkpoint_root = sys.argv[6] if len(sys.argv) > 6 else fixture
    with open(book_path, encoding="utf-8") as source:
        book = json.load(source)
    steps = book["sections"][0]["chapters"][0]["examples"][0]["prompts"]

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
    sent_tools = set()
    sent_questions = set()
    approved_turns = set()
    turn_index = 0
    completed = False
    deadline = time.monotonic() + 300

    def send(text: str):
        proc.stdin.write(user_message(text))
        proc.stdin.flush()

    send(capture["turns"][0]["prompt"])
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

        text_parts = []
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    text_parts.append(block["text"])
                if block.get("type") != "tool_use" or block.get("name") != "AskUserQuestion":
                    continue
                tool_id = block.get("id")
                if not tool_id or tool_id in sent_tools:
                    continue
                question = (block.get("input", {}).get("questions") or [{}])[0]
                if question.get("header") == "Plan" or question.get("question") == "Approve this plan?":
                    send("Approve and build")
                    sent_tools.add(tool_id)
                    continue
                workflow = steps[turn_index].get("replay", {}).get("workflow", {})
                matched = next(
                    (
                        candidate
                        for candidate in workflow.get("questions", [])
                        if candidate.get("question") == question.get("question")
                    ),
                    None,
                )
                if matched is None:
                    raise RuntimeError(f"Unexpected planning question: {question.get('question')}")
                selected_id = workflow["canonicalAnswers"][matched["id"]]
                selected = next(option for option in matched["options"] if option["id"] == selected_id)
                send(f"{selected['label']} (Book Recommended)")
                sent_tools.add(tool_id)
        elif event.get("type") == "result":
            text_parts.append(str(event.get("result", "")))

        combined = "\n".join(text_parts)
        workflow = steps[turn_index].get("replay", {}).get("workflow", {})
        answered = False
        for question in workflow.get("questions", []):
            if question["id"] in sent_questions or question["question"] not in combined:
                continue
            selected_id = workflow["canonicalAnswers"][question["id"]]
            selected = next(
                option for option in question["options"] if option["id"] == selected_id
            )
            send(f"{selected['label']} (Book Recommended)")
            sent_questions.add(question["id"])
            answered = True
            break
        if answered:
            continue
        if "## Proposed plan" in combined:
            if turn_index not in approved_turns:
                send("Approve and build")
                approved_turns.add(turn_index)
            continue
        marker = capture["turns"][turn_index]["completionMarker"]
        if marker not in combined:
            continue
        snapshot(
            workspace,
            os.path.join(checkpoint_root, capture["turns"][turn_index]["replayCheckpoint"]),
            capture["turns"][turn_index]["expectedFiles"],
        )
        turn_index += 1
        if turn_index >= len(capture["turns"]):
            completed = True
            break
        send(capture["turns"][turn_index]["prompt"])

    proc.stdin.close()
    proc.stdin = None
    if not completed:
        proc.terminate()
    try:
        _, stderr = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        _, stderr = proc.communicate()
    sys.stderr.write(stderr)
    return 0 if completed else 2


if __name__ == "__main__":
    raise SystemExit(main())
