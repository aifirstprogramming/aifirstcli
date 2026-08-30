#!/usr/bin/env python3
"""Drive the real Claude TUI ambiguous replay picker through a PTY."""

import os
import pty
import re
import select
import signal
import sys
import time


ANSI = re.compile(r"\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])")


def main() -> int:
    claude, settings, workspace, mode = sys.argv[1:5]
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
    sent_prompt = False
    answered = False
    completed = False
    deadline = time.monotonic() + 20
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
            text = ANSI.sub("", output.decode("utf-8", errors="replace")).replace("\r", "")
            compact = re.sub(r"\s+", "", text)
            if not sent_prompt and ("❯" in text or time.monotonic() > deadline - 18):
                os.write(fd, b"levels\r")
                sent_prompt = True
            if sent_prompt and not answered and "WhichAIFirstexercisedidyoumean?" in compact:
                if mode == "none":
                    os.write(fd, b"\x1b[B\x1b[B")
                    time.sleep(0.1)
                os.write(fd, b"\r")
                answered = True
            if mode == "select" and "Howshouldthegametransitionbetweenlevels?" in compact:
                completed = True
                break
            if mode == "none" and "Nothingwaschangedorrecorded" in compact:
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
    return 0 if answered and completed else 2


if __name__ == "__main__":
    raise SystemExit(main())
