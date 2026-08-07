import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clear, get, mark, markIfNew, read, recordPack, write } from "../src/log/progress";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifirst-log-"));
  path = join(dir, "progress.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("read", () => {
  it("returns an empty log when the file is absent", () => {
    expect(read(path)).toEqual({ version: 1, exercises: {} });
  });

  it("survives a corrupt file rather than crashing the CLI", () => {
    // A learner has no way to recover from a hard failure here; they don't know
    // the file exists.
    writeFileSync(path, "{ not json at all");
    expect(read(path)).toEqual({ version: 1, exercises: {} });
  });

  it("survives a file that is valid JSON but the wrong shape", () => {
    writeFileSync(path, JSON.stringify([1, 2, 3]));
    expect(read(path)).toEqual({ version: 1, exercises: {} });
  });

  it("drops uninterpretable entries but keeps good ones", () => {
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        exercises: {
          "py-1-01": { status: "done", at: "2026-01-01T00:00:00.000Z", via: "apply" },
          "py-1-02": { status: "nonsense" },
          "py-1-03": "not an object",
        },
      }),
    );
    expect(Object.keys(read(path).exercises)).toEqual(["py-1-01"]);
  });

  it("defaults an unrecognized via to self", () => {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, exercises: { "py-1-01": { status: "done", at: "x", via: "telepathy" } } }),
    );
    expect(read(path).exercises["py-1-01"].via).toBe("self");
  });
});

describe("mark", () => {
  it("records a completion", () => {
    const entry = mark("py-1-01", { via: "apply", path });
    expect(entry.status).toBe("done");
    expect(get("py-1-01", path)!.via).toBe("apply");
  });

  it("preserves the first completion date when redone", () => {
    const first = mark("py-1-01", { via: "apply", now: new Date("2026-01-01"), path });
    const second = mark("py-1-01", { via: "self", now: new Date("2026-06-01"), path });
    expect(second.firstAt).toBe(first.at);
    expect(second.at).not.toBe(first.at);
  });

  it("records a skip distinctly from a completion", () => {
    mark("py-1-01", { status: "skipped", path });
    expect(get("py-1-01", path)!.status).toBe("skipped");
  });
});

describe("markIfNew", () => {
  it("records when nothing is there", () => {
    expect(markIfNew("py-1-01", { via: "apply", path })).not.toBeNull();
  });

  it("does not touch an existing entry", () => {
    mark("py-1-01", { via: "self", now: new Date("2026-01-01"), path });
    expect(markIfNew("py-1-01", { via: "apply", path })).toBeNull();
    expect(get("py-1-01", path)!.via).toBe("self");
  });

  it("never silently upgrades a deliberate skip to done", () => {
    mark("py-1-01", { status: "skipped", path });
    markIfNew("py-1-01", { via: "apply", path });
    expect(get("py-1-01", path)!.status).toBe("skipped");
  });
});

describe("preserving unknown ids", () => {
  it("keeps entries the current content pack doesn't know about", () => {
    // Rolling a content pack back, or switching books, must not erase history.
    write({ version: 1, exercises: { "rust-9-99": { status: "done", at: "x", via: "self" } } }, path);
    mark("py-1-01", { path });
    expect(Object.keys(read(path).exercises).sort()).toEqual(["py-1-01", "rust-9-99"]);
  });
});

describe("clear", () => {
  it("forgets one exercise", () => {
    mark("py-1-01", { path });
    mark("py-1-02", { path });
    clear("py-1-01", path);
    expect(Object.keys(read(path).exercises)).toEqual(["py-1-02"]);
  });

  it("forgets everything", () => {
    mark("py-1-01", { path });
    clear(undefined, path);
    expect(read(path).exercises).toEqual({});
  });
});

describe("write", () => {
  it("writes valid, human-readable JSON ending in a newline", () => {
    mark("py-1-01", { path });
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).toContain("\n  ");
  });

  it("leaves no temp files behind", () => {
    mark("py-1-01", { path });
    recordPack("1.0.0", path);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("records the content pack alongside exercises", () => {
    mark("py-1-01", { path });
    recordPack("1.2.3", path);
    const log = read(path);
    expect(log.content?.pack).toBe("1.2.3");
    expect(log.exercises["py-1-01"]).toBeDefined();
  });
});

describe("concurrent writers", () => {
  it("does not lose entries when writes interleave", () => {
    // Simulates the CLI and an agent-invoked `aifirst done` racing: each mutation
    // re-reads before writing, so both survive.
    for (let i = 0; i < 25; i++) mark(`py-2-${String(i).padStart(2, "0")}`, { path });
    expect(Object.keys(read(path).exercises)).toHaveLength(25);
  });
});
