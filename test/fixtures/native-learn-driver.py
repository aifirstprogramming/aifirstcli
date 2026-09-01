#!/usr/bin/env python3
"""Drive the built-in learner through its numbered terminal menus."""

import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    command = sys.argv[1:]
    if not command:
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)

    pending = b""
    deadline = time.time() + 30
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if data:
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
                pending += data
                if b"  > " in pending:
                    answer = b"3\n" if b"Lesson complete" in pending or b"Lesson paused" in pending else b"1\n"
                    os.write(fd, answer)
                    pending = b""

        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            return os.waitstatus_to_exitcode(status)

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print("native learner timed out", file=sys.stderr)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
