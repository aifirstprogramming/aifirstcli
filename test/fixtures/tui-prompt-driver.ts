import { LearnTuiSession } from "../../src/tui/session";

const session = await LearnTuiSession.create("Prompt gate test");
try {
  const holdStream = process.argv.includes("--hold-stream");
  const result = await session.presentPrompt(
    "Build a cheerful duckling game and keep this prompt read only.",
    {
      charsPerSecond: 40,
      // The click, not an animation timer, must reveal the prompt.
      sleep: holdStream ? () => new Promise<void>(() => {}) : undefined,
    },
  );
  session.appendText(`PROMPT_RESULT:${result}`);
  await Bun.sleep(250);
} finally {
  await session.destroy();
}
