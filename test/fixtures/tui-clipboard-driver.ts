import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");
  const copied = await session.copyText("COPY_ME_TEXT");
  session.appendText(`CLIPBOARD:${copied}`);
  await Bun.sleep(100);
}, "AI First Clipboard Test");
