#!/usr/bin/env python3
"""Drive the real Claude Code TUI through one deterministic plan-mode scenario."""

import os
import pty
import json
import re
import select
import signal
import sys
import time


ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-_])")


def visible(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace").replace("\r", "\n")
    return ANSI.sub("", text)


def authored_files_ready(workspace: str) -> bool:
    implementation = False
    tests = False
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [name for name in dirs if name not in {".claude", ".showtail", "__pycache__"}]
        for name in files:
            if not name.endswith(".py"):
                continue
            relative = os.path.relpath(os.path.join(root, name), workspace)
            if name.startswith("test"):
                tests = True
            elif relative != "rocket_sim/__init__.py":
                implementation = True
    return implementation and tests


def assistant_completion_seen(config_dir: str) -> bool:
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
                        if event.get("type") != "assistant":
                            continue
                        for block in event.get("message", {}).get("content", []):
                            if block.get("type") == "text" and "Rocket simulation complete." in block.get("text", ""):
                                return True
            except OSError:
                continue
    return False


def main() -> int:
    claude, workspace, capture_path = sys.argv[1:4]
    prompt = os.environ["ROCKET_PROMPT"]
    argv = [
        claude,
        "--permission-mode",
        "plan",
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
    typed_prompt = False
    sent_prompt = False
    answered_question = False
    selected_manual_approval = False
    approved_plan = False
    completed = False
    last_input_at = 0.0
    deadline = time.monotonic() + 240
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

            text = visible(output)
            now = time.monotonic()
            if not typed_prompt and ("❯" in text or now > deadline - 235):
                os.write(fd, prompt.encode("utf-8"))
                typed_prompt = True
                last_input_at = now
                continue
            if typed_prompt and not sent_prompt and now - last_input_at > 0.75:
                os.write(fd, b"\r")
                sent_prompt = True
                last_input_at = now
                continue

            tail = text[-12000:]
            compact = re.sub(r"\s+", "", tail)
            if (
                sent_prompt
                and not answered_question
                and now - last_input_at > 1
                and "Entertosel" in compact
            ):
                os.write(fd, b"\r")
                answered_question = True
                last_input_at = now
                continue

            if (
                answered_question
                and not selected_manual_approval
                and now - last_input_at > 1
                and (
                    "Wouldyouliketoproceed?" in compact
                    or "Yes,clearcontext" in compact
                    or "Yes,andauto-acceptedits" in compact
                )
            ):
                os.write(fd, b"\x1b[B")
                selected_manual_approval = True
                last_input_at = now
                continue
            if selected_manual_approval and not approved_plan and now - last_input_at > 0.5:
                os.write(fd, b"\r")
                approved_plan = True
                last_input_at = now
                continue

            if (
                approved_plan
                and authored_files_ready(workspace)
                and assistant_completion_seen(os.environ["CLAUDE_CONFIG_DIR"])
            ):
                completed = True
                time.sleep(1)
                break
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
        sys.stderr.write(visible(output)[-12000:])
    return 0 if sent_prompt and answered_question and approved_plan and completed else 2


if __name__ == "__main__":
    raise SystemExit(main())
