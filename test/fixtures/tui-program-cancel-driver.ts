import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");
  await session.withProgramRunning("Running Cancel Test", (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  }));
  session.appendText("PROGRAM_CANCELLED");
  await Bun.sleep(100);
}, "AI First Program Cancel Test");
