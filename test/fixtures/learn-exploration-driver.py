#!/usr/bin/env python3
"""Drive a declarative interaction sequence through the real Claude TUI."""

import json
import os
import pty
import re
import select
import signal
import sys
import time


ANSI = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])")


def compact(data: bytearray) -> str:
    visible = ANSI.sub("", data.decode("utf-8", errors="replace")).replace("\r", "")
    return re.sub(r"\s+", "", visible)


def main() -> int:
    claude, settings, workspace, scenario_path = sys.argv[1:5]
    scenario = json.loads(open(scenario_path, encoding="utf-8").read())
    argv = [
        claude,
        "--setting-sources", "user",
        "--settings", settings,
        "--tools", "Bash,Edit,Read,Write,AskUserQuestion",
    ]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(claude, argv, os.environ.copy())

    output = bytearray()
    action_index = 0
    search_offset = 0
    deadline = time.monotonic() + float(scenario.get("timeoutSeconds", 25))
    try:
        while time.monotonic() < deadline and action_index < len(scenario["actions"]):
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)

            visible = compact(output)
            action = scenario["actions"][action_index]
            marker = re.sub(r"\s+", "", str(action["wait"]))
            found = visible.find(marker, search_offset)
            if found < 0:
                continue
            time.sleep(float(action.get("settleSeconds", 0.15)))
            if "send" in action:
                os.write(fd, str(action["send"]).encode("utf-8"))
                os.write(fd, b"\r")
            if action.get("escape"):
                os.write(fd, b"\x1b")
            down = int(action.get("down", 0))
            if down:
                os.write(fd, b"\x1b[B" * down)
                time.sleep(0.1)
            if action.get("enter"):
                os.write(fd, b"\r")
            # Only match output produced after this action. TUI redraws often repeat old markers.
            search_offset = len(visible)
            action_index += 1
    finally:
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

    sys.stdout.buffer.write(output)
    sys.stderr.write(json.dumps({"completedActions": action_index, "totalActions": len(scenario["actions"])}) + "\n")
    return 0 if action_index == len(scenario["actions"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
