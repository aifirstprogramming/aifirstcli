import { join } from "node:path";
import { runAsyncProcess } from "../../src/process";
import { currentTuiSession, withTuiSession } from "../../src/tui/session";

if (process.argv.includes("--child")) {
  process.stdout.write("What is your name? ");
  process.stdin.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      process.stdout.write(`Hello, ${input.slice(0, newline)}!\n`);
      resolve();
    });
    process.stdin.on("end", resolve);
  });
  process.stdin.pause();
} else {
  await withTuiSession(async () => {
    const session = currentTuiSession();
    if (!session) throw new Error("TUI session did not start");
    const fixture = join(import.meta.dir, "tui-interactive-program-driver.ts");
    const result = await session.withTerminalProgram("Interactive program", true, (context) =>
      runAsyncProcess([process.execPath, "run", fixture, "--child"], {
        cwd: process.cwd(),
        stdin: "interactive",
        signal: context.signal,
        onStdout: context.onStdout,
        onStderr: context.onStderr,
        onInputReady: context.onInputReady,
      }));
    session.appendText(`PROGRAM_EXIT:${result.exitCode}`);
    await Bun.sleep(100);
  }, "AI First Interactive Program Test");
}
