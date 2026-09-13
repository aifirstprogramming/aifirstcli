import { currentTuiSession, withTuiSession } from "../../src/tui/session";

await withTuiSession(async () => {
  const session = currentTuiSession();
  if (!session) throw new Error("TUI session did not start");

  await session.appendMarkdown([
    "## Proposed plan",
    "",
    `First plan paragraph starts here. ${"This should be skippable. ".repeat(20)}`,
    "",
    `Second plan paragraph ends with FINAL_PLAN_MARKER. ${"No more waiting. ".repeat(20)}`,
  ].join("\n"), {
    charsPerSecond: 40,
    chunkChars: 4,
  });
  const picked = await session.choose("Plan finished?", [
    { key: "yes", label: "Yes", description: "The whole plan is visible." },
    { key: "no", label: "No", description: "The plan is still typing." },
  ]);
  session.appendText(`PLAN_CHOICE:${picked?.kind === "choice" ? picked.key : "none"}`);
  await Bun.sleep(100);
}, "AI First Plan Test");
