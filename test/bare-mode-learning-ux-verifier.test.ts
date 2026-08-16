/** Adversarial verifier coverage for the bare-mode contract. */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const enabled = process.env.AIFIRST_RUN_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;
const entry = join(import.meta.dir, "..", "src", "index.ts");

async function runCli(root: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
    cwd: root,
    env: { ...process.env, AIFIRST_STATE_DIR: join(root, "state"), AIFIRST_HOME_OVERRIDE: join(root, "home"), NO_COLOR: "1", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr, code: proc.exitCode ?? 1 };
}

suite("bare-mode adversarial verifier", () => {
  test("positive: next emits an executable action and records a clean run", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-positive-"));
    try {
      await runCli(root, ["book", "py"]);
      const result = await runCli(root, ["next", "--format", "json"]);
      const data = JSON.parse(result.stdout);
      expect(result.code).toBe(0);
      expect(data.completed).toBe(true);
      expect(data.ran.ok).toBe(true);
      expect(data.recorded).toBe(true);
      expect(existsSync(join(root, "hello_world.py"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("negative: a different learner file is never overwritten without force", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-verifier-negative-"));
    try {
      await runCli(root, ["book", "py"]);
      const path = join(root, "hello_world.py");
      writeFileSync(path, "print('learner version')\n");
      const result = await runCli(root, ["next", "--format", "json"]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).recorded).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("print('learner version')\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
