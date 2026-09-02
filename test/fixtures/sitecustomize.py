"""Auto-close pygame entrypoints only when the Docker TUI run test requests it."""

import os
import sys
import threading
import time


if (
    os.environ.get("AIFIRST_AUTOCLOSE_PYGAME") == "1"
    and os.environ.get("AIFIRST_LEARN_FINAL_RUN") == "1"
    and sys.argv[0].endswith("main.py")
):
    def close_window():
        time.sleep(0.8)
        import pygame
        pygame.event.post(pygame.event.Event(pygame.QUIT))

    threading.Thread(target=close_window, daemon=True).start()
