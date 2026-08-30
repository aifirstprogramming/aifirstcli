#!/usr/bin/env python3
"""Drive a real Claude Code TUI through a data-defined multi-turn scenario."""

import json
import os
import pty
import re
import select
import shutil
import signal
import sys
import time


ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])")


def visible(raw: bytes) -> str:
    return ANSI.sub("", raw.decode("utf-8", errors="replace").replace("\r", "\n"))


def transcript_state(config_dir: str):
    tool_names = {}
    results = set()
    assistant_text = []
    projects = os.path.join(config_dir, "projects")
    for root, _, files in os.walk(projects):
        for name in files:
            if not name.endswith(".jsonl"):
                continue
            try:
                with open(os.path.join(root, name), encoding="utf-8") as transcript:
                    for line in transcript:
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        content = event.get("message", {}).get("content", [])
                        if not isinstance(content, list):
                            continue
                        for block in content:
                            if not isinstance(block, dict):
                                continue
                            if block.get("type") == "tool_use" and block.get("id"):
                                tool_names[block["id"]] = block.get("name", "")
                            elif block.get("type") == "tool_result" and block.get("tool_use_id"):
                                results.add(block["tool_use_id"])
                            elif block.get("type") == "text" and block.get("text"):
                                assistant_text.append(block["text"])
            except OSError:
                continue
    pending_asks = [
        tool_id
        for tool_id, name in tool_names.items()
        if name == "AskUserQuestion" and tool_id not in results
    ]
    pending_plans = [
        tool_id
        for tool_id, name in tool_names.items()
        if name == "ExitPlanMode" and tool_id not in results
    ]
    answered_asks = sum(
        1 for tool_id, name in tool_names.items() if name == "AskUserQuestion" and tool_id in results
    )
    return pending_asks, pending_plans, answered_asks, "\n".join(assistant_text)


def submit(fd: int, text: str):
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.75)
    os.write(fd, b"\r")


def snapshot(workspace: str, checkpoint: str, expected_files):
    os.makedirs(checkpoint, exist_ok=True)
    for relative in expected_files:
        source = os.path.join(workspace, relative)
        if not os.path.isfile(source):
            raise RuntimeError(f"Expected authored file is missing: {relative}")
        target = os.path.join(checkpoint, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)


def main() -> int:
    claude, workspace, capture_path, config_path = sys.argv[1:5]
    with open(config_path, encoding="utf-8") as source:
        scenario = json.load(source)
    permission = "plan" if scenario["initialMode"] == "plan" else "acceptEdits"
    argv = [
        claude,
        "--permission-mode",
        permission,
        "--tools",
        "Bash,Edit,Read,Write,AskUserQuestion,EnterPlanMode,ExitPlanMode",
        "--setting-sources",
        "user,project",
        "--model",
        "sonnet",
    ]

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(claude, argv, os.environ.copy())

    output = bytearray()
    capture = open(capture_path, "wb")
    turn_index = 0
    turn_started = False
    answer_index = 0
    answered_tool_ids = set()
    approved_turns = set()
    plan_seen_at = {}
    group_submit_sent = set()
    group_submit_seen_at = {}
    completed = False
    deadline = time.monotonic() + 900
    try:
        while time.monotonic() < deadline:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                capture.write(chunk)
                capture.flush()

            if turn_index >= len(scenario["turns"]):
                completed = True
                break

            screen = visible(output)
            tail = screen[-16000:]
            compact = re.sub(r"\s+", "", tail)
            turn = scenario["turns"][turn_index]
            answers = turn.get("answers", [])
            if not turn_started and ("❯" in screen or len(output) > 0):
                if turn.get("enterPlan"):
                    submit(fd, "/plan")
                    time.sleep(1.25)
                submit(fd, turn["prompt"])
                sys.stderr.write(f"started turn {turn_index + 1}\n")
                sys.stderr.flush()
                turn_started = True
                answer_index = 0
                continue

            plan_ready = answer_index == len(answers) and (
                "Wouldyouliketoproceed?" in compact
                or "Yes,clearcontext" in compact
                or "Yes,andauto-acceptedits" in compact
                or "Yes,anduseautomode" in compact
            )
            if turn_index not in approved_turns and plan_ready:
                first_seen = plan_seen_at.setdefault(turn_index, time.monotonic())
                if time.monotonic() - first_seen < 1.5:
                    continue
                os.write(fd, b"\r")
                approved_turns.add(turn_index)
                sys.stderr.write(f"approved plan for turn {turn_index + 1}\n")
                sys.stderr.flush()
                output.clear()
                time.sleep(0.75)
                continue

            group_submit_ready = (
                len(answers) > 1
                and answer_index == len(answers)
                and turn_index not in group_submit_sent
                and ("✔Submit" in compact or "Submit→" in compact)
            )
            if group_submit_ready:
                first_seen = group_submit_seen_at.setdefault(
                    turn_index, time.monotonic()
                )
                if time.monotonic() - first_seen < 1.0:
                    continue
                os.write(fd, b"\r")
                group_submit_sent.add(turn_index)
                sys.stderr.write(f"submitted question group for turn {turn_index + 1}\n")
                sys.stderr.flush()
                output.clear()
                time.sleep(0.75)
                continue

            pending_asks, pending_plans, answered_asks, assistant_text = transcript_state(
                os.environ["CLAUDE_CONFIG_DIR"]
            )
            unsent_asks = [tool_id for tool_id in pending_asks if tool_id not in answered_tool_ids]
            if answer_index < len(answers) and "Entertosel" in compact:
                tool_id = unsent_asks[0] if unsent_asks else f"screen-{turn_index}-{answer_index}"
                answer = answers[answer_index]
                if answer["kind"] == "first":
                    os.write(fd, b"\r")
                else:
                    os.write(fd, b"\x1b[B\x1b[B\x1b[B\r")
                    time.sleep(0.75)
                    submit(fd, answer["text"])
                answered_tool_ids.add(tool_id)
                answer_index += 1
                sys.stderr.write(f"answered question {answer_index} for turn {turn_index + 1}\n")
                sys.stderr.flush()
                output.clear()
                time.sleep(0.75)
                continue

            if turn["completionMarker"] in assistant_text:
                snapshot(workspace, turn["checkpoint"], turn["expectedFiles"])
                sys.stderr.write(f"captured turn {turn_index + 1}\n")
                sys.stderr.flush()
                turn_index += 1
                turn_started = False
                time.sleep(1)
    finally:
        capture.close()
        try:
            os.write(fd, b"\x03\x03")
        except OSError:
            pass
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

    if not completed:
        sys.stderr.write(visible(output)[-16000:])
    return 0 if completed else 2


if __name__ == "__main__":
    raise SystemExit(main())
