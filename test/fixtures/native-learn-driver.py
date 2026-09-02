#!/usr/bin/env python3
"""Drive the built-in learner through its numbered terminal menus."""

import json
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

    answers = json.loads(os.environ.get("AIFIRST_LEARN_TEST_ANSWERS", '["1", "run", "exit"]'))
    pending = b""
    timeout_seconds = float(os.environ.get("AIFIRST_LEARN_TEST_TIMEOUT_SECONDS", "30"))
    deadline = time.time() + timeout_seconds
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
                    if not answers:
                        os.kill(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
                        print("native learner requested an unexpected answer", file=sys.stderr)
                        return 125
                    answer = answers.pop(0)
                    os.write(fd, b"\x03" if answer == "__CTRL_C__" else f"{answer}\n".encode())
                    pending = b""

        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished:
            code = os.waitstatus_to_exitcode(status)
            return 128 - code if code < 0 else code

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    print("native learner timed out", file=sys.stderr)
    return 124


if __name__ == "__main__":
    raise SystemExit(main())
