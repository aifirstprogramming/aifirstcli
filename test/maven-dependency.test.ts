import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("Maven exercise preflight", () => {
  test("reports missing Maven before writing PocketCFO files", async () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-maven-preflight-"));
    const home = join(root, "home");
    const proc = Bun.spawn([process.execPath, "run", ENTRY, "run", "java-11-01", "--format", "json"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: join(root, "empty-path"),
        AIFIRST_HOME_OVERRIDE: home,
        AIFIRST_STATE_DIR: join(root, "state"),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    expect(proc.exitCode).toBe(1);
    expect(stdout).toBe("");
    const error = JSON.parse(stderr);
    expect(error.error.code).toBe("missing_dependencies");
    expect(error.error.message).toContain("Maven");
    const workspace = join(home, "aifirst", "java");
    expect(existsSync(workspace) ? readdirSync(workspace) : []).toEqual([]);
  });
});
