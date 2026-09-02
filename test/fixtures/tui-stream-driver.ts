import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");

  const first = `First paragraph starts here. ${"Skip this block when Enter is pressed. ".repeat(8)}`;
  const second = `Second paragraph remains animated. ${"Steady incremental output continues. ".repeat(8)}`;
  await session.appendMarkdown(`## Streaming check\n\n${first}\n\n${second}\n`, {
    charsPerSecond: 180,
    chunkChars: 12,
  });

  const picked = await session.choose("Streaming finished?", [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
  ]);
  session.appendText(`CHOICE:${picked?.kind === "choice" ? picked.key : "none"}`);
  await Bun.sleep(100);
}, "AI First Stream Test");
