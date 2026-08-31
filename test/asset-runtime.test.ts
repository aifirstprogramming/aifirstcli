import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";
import { seedScaffold } from "./helpers/scaffold";

const enabled = process.env.AIFIRST_ASSET_RUNTIME === "1";
const suite = enabled ? describe : describe.skip;
const { content } = resolveContent();
const steps = content.steps.filter((step) =>
  step.scaffold?.files?.some((file) => file.path === "assets_gen.py"));

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

suite("tracked asset runtime contract", () => {
  test("ensure_assets is a no-op when the committed assets are scaffolded", () => {
    for (const step of steps) {
      const workspace = mkdtempSync(join(tmpdir(), `aifirst-assets-${step.id}-`));
      try {
        seedScaffold(workspace, step, content);
        const tracked = step.scaffold!.files
          .filter((file) => "contentBase64" in file && file.path.endsWith(".png"))
          .map((file) => file.path)
          .sort();
        const before = new Map(tracked.map((path) => {
          const absolute = join(workspace, path);
          return [path, { hash: hash(absolute), mtime: statSync(absolute).mtimeMs }];
        }));
        const probe = Bun.spawnSync({
          cmd: ["python3", "-c", [
            "import json",
            "import assets_gen",
            "print(json.dumps(sorted(assets_gen.EXPECTED_FILES)))",
            "assets_gen.ensure_assets()",
          ].join("; ")],
          cwd: workspace,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYGAME_HIDE_SUPPORT_PROMPT: "1" },
        });
        expect(probe.exitCode, `${step.id}: ${probe.stderr.toString()}`).toBe(0);
        const expected = JSON.parse(probe.stdout.toString().trim()) as string[];
        for (const path of expected.map((candidate) => `assets/${candidate}`)) {
          expect(tracked, `${step.id}: missing ${path}`).toContain(path);
        }
        for (const path of tracked) {
          const absolute = join(workspace, path);
          const snapshot = before.get(path)!;
          expect(hash(absolute), `${step.id}: ${path}`).toBe(snapshot.hash);
          expect(statSync(absolute).mtimeMs, `${step.id}: ${path}`).toBe(snapshot.mtime);
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }, 30_000);
});
