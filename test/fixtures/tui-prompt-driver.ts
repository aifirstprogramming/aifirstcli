import { LearnTuiSession } from "../../src/tui/session";

const session = await LearnTuiSession.create("Prompt gate test");
try {
  const result = await session.presentPrompt(
    "Build a cheerful duckling game and keep this prompt read only.",
    { charsPerSecond: 40 },
  );
  session.appendText(`PROMPT_RESULT:${result}`);
  await Bun.sleep(250);
} finally {
  await session.destroy();
}
