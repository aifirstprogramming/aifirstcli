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


def wait_end(visible: str, wait, offset: int) -> int:
    """Find every marker after the last action, without imposing paint order."""
    markers = wait if isinstance(wait, list) else [wait]
    if not markers:
        raise ValueError("wait needs at least one marker")
    end = offset
    for value in markers:
        marker = re.sub(r"\s+", "", str(value))
        found = visible.find(marker, offset)
        if found < 0:
            return -1
        end = max(end, found + len(marker))
    return end


def may_send_input(fd: int, output: bytearray, absent, deadline: float) -> bool:
    # The child may have written more output during the action's settle delay.
    while time.monotonic() < deadline:
        readable, _, _ = select.select([fd], [], [], 0)
        if not readable:
            return wait_end(compact(output), absent, 0) < 0
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        output.extend(chunk)
    return False


def main() -> int:
    scenario_path = sys.argv[1]
    command = sys.argv[2:]
    scenario = json.loads(open(scenario_path, encoding="utf-8").read())
    rows = int(scenario.get("rows", 30))
    columns = int(scenario.get("columns", 100))
    window_size = struct.pack("HHHH", rows, columns, 0, 0)
    pid, fd = pty.fork()
    if pid == 0:
        # Set the requested geometry before the TUI can observe the new PTY.
        fcntl.ioctl(sys.stdout.fileno(), termios.TIOCSWINSZ, window_size)
        os.execvpe(command[0], command, os.environ)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, window_size)
    output = bytearray()
    action_index = 0
    search_offset = 0
    prompt_acknowledged = False
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
            if scenario.get("autoRunPrompts", True) and not prompt_acknowledged:
                prompt_marker = "PRESSENTERTORUNTHISPROMPT"
                found_prompt = visible.find(prompt_marker)
                if found_prompt >= 0:
                    os.write(fd, b"\r")
                    prompt_acknowledged = True
                    time.sleep(0.1)
            action = scenario["actions"][action_index]
            end = wait_end(visible, action["wait"], search_offset)
            if end < 0:
                continue
            time.sleep(float(action.get("settleSeconds", 0.1)))
            if "absentBeforeInput" in action and not may_send_input(
                fd, output, action["absentBeforeInput"], deadline,
            ):
                sys.stderr.write(f"input withheld: could not verify {action['absentBeforeInput']!r} was absent\n")
                break
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
            if action.get("pageUp"):
                os.write(fd, b"\x1b[5~" * int(action["pageUp"]))
                time.sleep(0.1)
            if action.get("pageDown"):
                os.write(fd, b"\x1b[6~" * int(action["pageDown"]))
                time.sleep(0.1)
            if "click" in action:
                click = action["click"]
                x = int(click.get("x", 10))
                y = int(click.get("y", 8))
                os.write(fd, f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m".encode("ascii"))
                time.sleep(0.1)
            if action.get("scrollUp"):
                x = int(action.get("scrollX", 10))
                y = int(action.get("scrollY", 10))
                for _ in range(int(action["scrollUp"])):
                    os.write(fd, f"\x1b[<64;{x};{y}M".encode("ascii"))
                time.sleep(0.1)
            if action.get("scrollDown"):
                x = int(action.get("scrollX", 10))
                y = int(action.get("scrollY", 10))
                for _ in range(int(action["scrollDown"])):
                    os.write(fd, f"\x1b[<65;{x};{y}M".encode("ascii"))
                time.sleep(0.1)
            if action.get("enter"):
                os.write(fd, b"\r")
            if action.get("escape"):
                os.write(fd, b"\x1b")
            if action.get("ctrlC"):
                os.write(fd, b"\x03")
            search_offset = end
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
            stop_deadline = time.monotonic() + 2.0
            while time.monotonic() < stop_deadline:
                try:
                    finished, _ = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    finished = pid
                if finished:
                    child_done = True
                    break
                time.sleep(0.05)
            if not child_done:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    pass

    sys.stdout.buffer.write(output)
    pending = scenario["actions"][action_index].get("wait") if action_index < len(scenario["actions"]) else None
    sys.stderr.write(json.dumps({
        "completedActions": action_index,
        "totalActions": len(scenario["actions"]),
        "pendingWait": pending,
    }) + "\n")
    return 0 if action_index == len(scenario["actions"]) else 2


if __name__ == "__main__":
    raise SystemExit(main())
