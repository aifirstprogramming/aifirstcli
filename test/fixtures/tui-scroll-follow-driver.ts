import type { ScrollBoxRenderable } from "@opentui/core";
import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");
  for (let index = 1; index <= 80; index++) session.appendText(`History line ${index}`);

  await session.choose("Choose after scrolling", [
    { key: "continue", label: "Continue" },
    { key: "stop", label: "Stop" },
  ]);
  await Bun.sleep(30);

  const transcript = (session as unknown as { transcript: ScrollBoxRenderable }).transcript;
  const maximum = Math.max(0, transcript.scrollHeight - transcript.viewport.height);
  session.appendText(`FOLLOWED_BOTTOM:${transcript.scrollTop >= maximum - 1}`);
  await Bun.sleep(100);
}, "AI First Scroll Follow Test");
