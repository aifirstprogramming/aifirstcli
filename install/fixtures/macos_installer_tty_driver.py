#!/usr/bin/env python3
"""Run the installer smoke-test script in a PTY and answer direct init."""

import os
import pty
import select
import signal
import sys
import time


PROMPT = b"Set up 1 tool? [Y/n]"


def main() -> int:
    runner, log_path = sys.argv[1:3]
    pid, fd = pty.fork()
    if pid == 0:
        os.execv("/bin/sh", ["sh", runner])
        os._exit(127)

    output = bytearray()
    answered = False
    deadline = time.monotonic() + 45
    timed_out = False
    status = None

    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.25)
            if not ready:
                done, child_status = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = child_status
                    break
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output.extend(chunk)
            if not answered and PROMPT in output:
                os.write(fd, b"n\n")
                answered = True
        else:
            timed_out = True
            os.killpg(pid, signal.SIGKILL)

        if status is None:
            _, status = os.waitpid(pid, 0)
    finally:
        os.close(fd)
        with open(log_path, "wb") as log:
            log.write(output)

    if timed_out:
        print("installer smoke test timed out", file=sys.stderr)
        return 1
    if not answered:
        print("direct aifirst init never displayed its confirmation prompt", file=sys.stderr)
        return 1
    if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
        print(f"smoke-test runner failed with wait status {status}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
