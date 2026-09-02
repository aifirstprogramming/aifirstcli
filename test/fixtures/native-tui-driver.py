#!/usr/bin/env python3
"""Drive declarative key sequences through the compiled/source AI First TUI."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


ANSI = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|_[^\x1b]*\x1b\\|\[[0-?]*[ -/]*[@-~])")


def compact(data: bytearray) -> str:
    visible = ANSI.sub("", data.decode("utf-8", errors="replace")).replace("\r", "")
    return re.sub(r"\s+", "", visible)


def main() -> int:
    scenario_path = sys.argv[1]
    command = sys.argv[2:]
    scenario = json.loads(open(scenario_path, encoding="utf-8").read())
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)

    rows = int(scenario.get("rows", 30))
    columns = int(scenario.get("columns", 100))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    output = bytearray()
    action_index = 0
    search_offset = 0
    child_done = False
    deadline = time.monotonic() + float(scenario.get("timeoutSeconds", 45))
    try:
        while time.monotonic() < deadline and action_index < len(scenario["actions"]):
            readable, _, _ = select.select([fd], [], [], 0.1)
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
            time.sleep(float(action.get("settleSeconds", 0.1)))
            if "text" in action:
                os.write(fd, str(action["text"]).encode("utf-8"))
                time.sleep(0.1)
            if "paste" in action:
                payload = str(action["paste"]).encode("utf-8")
                os.write(fd, b"\x1b[200~" + payload + b"\x1b[201~")
                time.sleep(0.1)
            if action.get("up"):
                os.write(fd, b"\x1b[A" * int(action["up"]))
                time.sleep(0.1)
            if action.get("down"):
                os.write(fd, b"\x1b[B" * int(action["down"]))
                time.sleep(0.1)
            if action.get("enter"):
                os.write(fd, b"\r")
            if action.get("escape"):
                os.write(fd, b"\x1b")
            if action.get("ctrlC"):
                os.write(fd, b"\x03")
            search_offset = max(search_offset, found + len(marker))
            action_index += 1
        if action_index == len(scenario["actions"]):
            grace = time.monotonic() + 2.0
            while time.monotonic() < grace:
                readable, _, _ = select.select([fd], [], [], 0.1)
                if readable:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        chunk = b""
                    if chunk:
                        output.extend(chunk)
                finished, _ = os.waitpid(pid, os.WNOHANG)
                if finished:
                    child_done = True
                    break
    finally:
        if not child_done:
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
