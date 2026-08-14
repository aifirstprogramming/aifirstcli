import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "aifirst-learn-release-"));
const state = join(root, "state");
const home = join(root, "home");
const report = join(root, "report.json");
const bin = join(root, "bin");
const capture = join(root, "capture.txt");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nexit 0\n`);
chmodSync(join(bin, "claude"), 0o755);

try {
  const proc = Bun.spawn([process.execPath, "run", "src/index.ts", "learn", "--", "--help"], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      AIFIRST_STATE_DIR: state,
      AIFIRST_HOME_OVERRIDE: home,
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  writeFileSync(report, JSON.stringify({
    exitCode: proc.exitCode,
    stdout: stdout.replaceAll(/synthetic-[^\s"']+/g, "[redacted]"),
    stderr: stderr.replaceAll(/synthetic-[^\s"']+/g, "[redacted]"),
    sessionStateExists: existsSync(join(state, "learn", "session.json")),
  }));
  console.log(JSON.stringify({ exitCode: proc.exitCode, report }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
