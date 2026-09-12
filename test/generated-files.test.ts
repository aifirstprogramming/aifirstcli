import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeneratedFileStore } from "../src/generatedFiles";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("generated file ownership", () => {
  test("matches only the exact bytes last recorded", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-files-"));
    const file = join(root, "workspace", "main.py");
    const store = new GeneratedFileStore(join(root, "state"));
    mkdirSync(join(root, "workspace"));
    writeFileSync(file, "print('generated')\n", { flag: "w" });

    store.record(file);
    expect(store.matches(file)).toBe(true);

    writeFileSync(file, "print('learner change')\n");
    expect(store.matches(file)).toBe(false);
  });

  test("stores hashes and paths without retaining source contents", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-private-"));
    const file = join(root, "secret.py");
    const store = new GeneratedFileStore(join(root, "state"));
    writeFileSync(file, "student_secret = 'not in state'\n");

    store.record(file);
    const raw = readFileSync(store.recordPath(file), "utf8");
    const record = JSON.parse(raw);
    expect(record).toEqual({ version: 1, path: file, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(raw).not.toContain("student_secret");
  });

  test("treats malformed state as unowned", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-corrupt-"));
    const file = join(root, "main.py");
    const store = new GeneratedFileStore(join(root, "state"));
    writeFileSync(file, "print(1)\n");
    store.record(file);
    writeFileSync(store.recordPath(file), "not json\n");

    expect(store.matches(file)).toBe(false);
  });

  test("tracks binary files independently by absolute path", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-binary-"));
    const first = join(root, "one", "asset.png");
    const second = join(root, "two", "asset.png");
    const store = new GeneratedFileStore(join(root, "state"));
    mkdirSync(join(root, "one"));
    mkdirSync(join(root, "two"));
    writeFileSync(first, Buffer.from([0, 1, 2, 3]));
    writeFileSync(second, Buffer.from([0, 1, 2, 3]));

    store.record(first);
    store.record(second);
    expect(store.recordPath(first)).not.toBe(store.recordPath(second));
    expect(store.matches(first)).toBe(true);
    expect(store.matches(second)).toBe(true);
  });

  test("enumerates and forgets only valid records inside one managed project", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-project-"));
    const project = join(root, "project");
    const inside = join(project, "src", "Main.java");
    const outside = join(root, "other", "Other.java");
    const store = new GeneratedFileStore(join(root, "state"));
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(inside, "class Main {}\n");
    writeFileSync(outside, "class Other {}\n");
    store.record(inside);
    store.record(outside);

    expect(store.recordsUnder(project).map((record) => record.path)).toEqual([inside]);
    store.forget(inside);
    expect(store.recordsUnder(project)).toEqual([]);
    expect(store.matches(outside)).toBe(true);
  });

  test("reports ownership persistence failures with the generated file path", () => {
    root = mkdtempSync(join(tmpdir(), "aifirst-generated-error-"));
    const file = join(root, "main.py");
    const blockedState = join(root, "not-a-directory");
    writeFileSync(file, "print(1)\n");
    writeFileSync(blockedState, "blocked\n");

    expect(() => new GeneratedFileStore(blockedState).record(file)).toThrow(
      `Could not record generated-file ownership for ${file}`,
    );
    expect(readFileSync(file, "utf8")).toBe("print(1)\n");
  });
});
