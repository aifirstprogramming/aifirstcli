#!/usr/bin/env python3
"""Drive one real interactive Claude TUI fuzzy-choice flow through a PTY."""

import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    claude, settings, workspace = sys.argv[1:4]
    prompt = sys.argv[4] if len(sys.argv) > 4 else "write hello world"
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
    expected_id = "py-9-02" if prompt == "fox" else "py-1-01"
    progress_path = os.path.join(os.environ["AIFIRST_STATE_DIR"], "progress.json")
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
            text = output.decode("utf-8", errors="replace")
            if not sent_prompt and ("❯" in text or time.monotonic() > deadline - 18):
                os.write(fd, prompt.encode() + b"\r")
                sent_prompt = True
            if sent_prompt and not answered and "Run this replay" in text:
                os.write(fd, b"\r")
                answered = True
            if "Replay completed" in text or ("Explanation" in text and "done" in text):
                completed = True
                break
            if os.path.exists(progress_path):
                with open(progress_path, encoding="utf-8") as progress:
                    if expected_id in progress.read():
                        completed = True
                        break
            if "isn't a prompt from the book" in text:
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
