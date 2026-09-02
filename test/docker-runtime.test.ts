import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("manual learning Docker image", () => {
  test("installs a Java compiler in both test and standalone runtime stages", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(dockerfile.match(/default-jdk-headless/g)?.length).toBe(2);
    expect(dockerfile).not.toContain("default-jre-headless python3");
    expect(dockerfile.match(/\bmaven\b/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("starts manual Docker sessions in the learner home", () => {
    const runner = readFileSync(join(root, "scripts", "docker-test.sh"), "utf8");
    expect(runner).not.toContain("--workdir /workspace");
    expect(runner.match(/--workdir \/home\/aifirst/g)?.length).toBe(2);
  });

  test("native exploration drives the compiled binary through Java and Duckling", () => {
    const exploration = readFileSync(join(root, "scripts", "explore-native-learn.ts"), "utf8");
    expect(exploration).toContain("aifirst-linux-${arch}");
    expect(exploration).toContain('name: "java-hello"');
    expect(exploration).toContain('name: "duckling-full-replay"');
    expect(exploration).toContain('name: "level-editor-full-replay"');
    expect(exploration).toContain('name: "python-chapters-9-10-continuous"');
    expect(exploration).toContain('name: "duckling-protects-existing-main"');
  });
});
