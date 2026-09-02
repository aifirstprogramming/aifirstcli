import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function aifirst(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: root,
    env: {
      ...process.env,
      AIFIRST_HOME_OVERRIDE: join(root, "home"),
      AIFIRST_STATE_DIR: join(root, "state"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { stdout, stderr, code: proc.exitCode ?? 0 };
}

describe("shared exercise workspaces", () => {
  test("resolves book tags and exercise ids to stable per-book paths", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-workspace-"));
    const python = JSON.parse((await aifirst(["workspace", "py", "--format", "json"])).stdout);
    const java = JSON.parse((await aifirst(["workspace", "java-11-01", "--format", "json"])).stdout);
    expect(python.path).toBe(join(root, "home", "aifirst", "py"));
    expect(java.path).toBe(join(root, "home", "aifirst", "java"));
    expect(existsSync(python.path)).toBe(true);
    expect(existsSync(java.path)).toBe(true);
  });

  test("run defaults to the same workspace returned to agent skills", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-workspace-run-"));
    const workspace = JSON.parse((await aifirst(["workspace", "py-1-01", "--format", "json"])).stdout).path;
    const result = JSON.parse((await aifirst(["run", "py-1-01", "--format", "json"])).stdout);
    expect(result.path.startsWith(`${workspace}/`) || result.path.startsWith(`${workspace}\\`)).toBe(true);
    expect(readFileSync(result.path, "utf8")).toContain("Hello, World!");
  });
});
