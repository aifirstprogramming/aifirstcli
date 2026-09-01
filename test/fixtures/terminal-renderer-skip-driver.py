#!/usr/bin/env python3
"""Skip an animated renderer block, then answer the following readline prompt."""

import os
import pty
import select
import signal
import sys
import time


def main() -> int:
    command = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(command[0], command, os.environ)

    pending = b""
    skipped = False
    answered = False
    deadline = time.time() + 10
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
                if not skipped and b"This animated" in pending:
                    os.write(fd, b" ")
                    skipped = True
                    pending = b""
                elif skipped and not answered and b"CHOICE> " in pending:
                    os.write(fd, b"2\n")
                    answered = True
                    pending = b""

        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            return os.waitstatus_to_exitcode(status)

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print("renderer skip driver timed out", file=sys.stderr)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
