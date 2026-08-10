#!/usr/bin/env python3
"""Drive a real SIGINT at a backgrounded runner with no controlling terminal
at all (plain subprocess.Popen, not pty.fork()), so the result can only come
from the script's own trap handling, not from a tty's own signal fan-out.

Usage: kill_int_no_pty_driver.py <shell-script-path> <delay-seconds>
Prints one line: signaled=<bool> signal=<n> exit=<n>
"""
import os
import signal
import subprocess
import sys
import time


def main():
    script = sys.argv[1]
    delay = float(sys.argv[2])

    proc = subprocess.Popen(["sh", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(delay)
    os.kill(proc.pid, signal.SIGINT)
    proc.wait(timeout=10)

    rc = proc.returncode
    signaled = rc is not None and rc < 0
    sig = -rc if signaled else 0
    exitcode = rc if not signaled else -1
    print(f"signaled={signaled} signal={sig} exit={exitcode}")


if __name__ == "__main__":
    main()
