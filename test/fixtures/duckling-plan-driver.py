#!/usr/bin/env python3
"""Select the canonical duckling plan through Claude Code's native TUI."""

import os
import pty
import re
import select
import signal
import sys
import time


PROMPT = "Make a game about a baby duckling who is trying to find its mother using pygame."
ANSI = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])")
PHASES = [
    ("☐ Gameplay", 0),
    ("☐ Challenge", 1),
    ("☐ Visuals", 1),
    ("✔ Submit", 0),
    ("☐ Assets", 0),
    ("☐ Plan", 0),
]


def main() -> int:
    bun, entry, workspace = sys.argv[1:4]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workspace)
        os.execve(bun, [bun, "run", entry, "learn"], os.environ.copy())

    output = bytearray()
    sent_prompt = False
    phase = 0
    completed = False
    progress_path = os.path.join(os.environ["AIFIRST_STATE_DIR"], "progress.json")
    deadline = time.monotonic() + 30
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
            visible = ANSI.sub("", output.decode("utf-8", errors="replace")).replace("\r", "")
            if not sent_prompt and "❯" in visible:
                os.write(fd, PROMPT.encode())
                time.sleep(0.2)
                os.write(fd, b"\r")
                sent_prompt = True
                continue
            if sent_prompt and phase < len(PHASES) and PHASES[phase][0] in visible:
                time.sleep(0.3)
                if PHASES[phase][1]:
                    os.write(fd, b"\x1b[B" * PHASES[phase][1])
                    time.sleep(0.1)
                os.write(fd, b"\r")
                phase += 1
                continue
            if "? for shortcuts" in visible and os.path.exists(progress_path):
                with open(progress_path, encoding="utf-8") as progress:
                    if "py-9-01" in progress.read():
                        completed = True
                        break
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
    return 0 if completed else 2


if __name__ == "__main__":
    raise SystemExit(main())
