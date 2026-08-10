#!/usr/bin/env python3
"""Drive a real SIGINT through a real pty at a running child, the same way a
person hitting Ctrl-C at an interactive terminal would. Sending the signal
this way (rather than `kill -INT` on the pid directly) is what actually
exercises the foreground-process-group semantics that make the installer's
backgrounded-downloader bug real in the first place.

Usage: pty_sigint_driver.py <shell-script> <output-log> <delay-seconds> [--double]
Prints one line: elapsed=<s> signaled=<bool> signal=<n> exit=<n>
"""
import os
import pty
import sys
import time


def main():
    script = sys.argv[1]
    log_path = sys.argv[2]
    delay = float(sys.argv[3])
    double = "--double" in sys.argv[4:]

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("sh", ["sh", "-c", script])
        os._exit(127)

    log = open(log_path, "wb")
    start = time.time()
    sent_first = False
    sent_second = False
    first_sent_at = None
    try:
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            log.write(chunk)
            log.flush()
            now = time.time()
            if not sent_first and now - start >= delay:
                os.write(fd, b"\x03")
                sent_first = True
                first_sent_at = now
            if double and sent_first and not sent_second and now - first_sent_at >= 0.2:
                os.write(fd, b"\x03")
                sent_second = True
    finally:
        log.close()

    _, status = os.waitpid(pid, 0)
    elapsed = time.time() - start
    signaled = os.WIFSIGNALED(status)
    sig = os.WTERMSIG(status) if signaled else 0
    exitcode = os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1
    print(f"elapsed={elapsed:.2f} signaled={signaled} signal={sig} exit={exitcode}")


if __name__ == "__main__":
    main()
