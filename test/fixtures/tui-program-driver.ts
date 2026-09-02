import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");
  await session.withProgramRunning("Running Duckling Test", () => Bun.sleep(650));
  session.appendText("PROGRAM_DONE");
  await Bun.sleep(100);
}, "AI First Program Test");
