import { createInterface } from "node:readline/promises";
import { renderTerminalMarkdown } from "../../src/learn/terminalRenderer";

const paragraph = "This animated paragraph is intentionally long enough to prove that the skip key reveals the current block immediately without leaking into the next readline prompt. ".repeat(8);

await renderTerminalMarkdown(paragraph, {
  color: false,
  columns: 72,
  charsPerSecond: 30,
  chunkChars: 12,
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  const answer = await rl.question("CHOICE> ");
  process.stdout.write(`answer=${answer.trim()}\n`);
} finally {
  rl.close();
}
