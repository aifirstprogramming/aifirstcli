import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workflow = (name: string) =>
  readFileSync(join(root, ".github", "workflows", name), "utf8");

describe("full book walk automation", () => {
  test("runs the compiled CLI with every required learner runtime and preserves its report", () => {
    const walk = workflow("book-walk.yml");
    expect(walk).toContain("workflow_call:");
    expect(walk).toContain('java-version: "21"');
    expect(walk).toContain("maven xauth xdotool xvfb");
    expect(walk).toContain("python -m pip install pygame-ce Pillow");
    expect(walk).toContain("bun scripts/build.ts --local");
    expect(walk).toContain("xvfb-run -a bun scripts/walk-books.ts --binary bin/aifirst-linux-x64");
    expect(walk).toContain("if: always()");
    expect(walk).toContain("test-results/book-walk/report.json");
  });

  test("gates pull requests, main, and releases", () => {
    expect(workflow("ci.yml")).toContain("uses: ./.github/workflows/book-walk.yml");
    const release = workflow("release.yml");
    expect(release).toContain("uses: ./.github/workflows/book-walk.yml");
    expect(release).toContain("needs: [book-walk, learn-compatibility, build-linux, build-windows, build-darwin]");
  });
});
