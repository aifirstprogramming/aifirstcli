import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a learner *is* and what they have *finished* are different questions.
 *
 * `next` used to answer the second: it returned the earliest unfinished exercise,
 * so someone working through chapter 7 was handed a chapter 2 exercise every time
 * they asked what was next. Holding their place would have meant skipping the forty
 * exercises in between, which is a claim about those exercises and goes in the
 * ledger. A bookmark says nothing about them.
 */

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "aifirst-pos-"));
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

async function aifirst(args: string[]): Promise<{ stdout: string; code: number }> {
  const proc = Bun.spawn([process.execPath, "run", ENTRY, ...args], {
    cwd: sandbox,
    env: {
      ...process.env,
      AIFIRST_STATE_DIR: join(sandbox, "state"),
      AIFIRST_HOME_OVERRIDE: join(sandbox, "home"),
      NO_COLOR: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout, code: proc.exitCode ?? 0 };
}

const nextId = async (extra: string[] = []): Promise<string> =>
  JSON.parse((await aifirst(["next", "--format", "json", ...extra])).stdout).next.id;

describe("the bookmark", () => {
  beforeEach(async () => {
    await aifirst(["book", "py"]);
  });

  it("advances as exercises are recorded, so next continues the chapter", async () => {
    await aifirst(["done", "py-1-01"]);
    await aifirst(["done", "py-7-01"]);
    await aifirst(["done", "py-7-02"]);

    // The reported bug: this returned py-2-08.
    expect(await nextId()).toBe("py-7-03");
  });

  it("says how many earlier exercises it passed over", async () => {
    await aifirst(["done", "py-7-01"]);
    const out = JSON.parse((await aifirst(["next", "--format", "json"])).stdout);
    expect(out.earlierUnfinished).toBeGreaterThan(0);
    expect(out.resumedFrom).toBe("py-7-01");
  });

  it("still offers the gaps when asked", async () => {
    await aifirst(["done", "py-7-01"]);
    expect(await nextId(["--earliest"])).toBe("py-1-01");
  });

  it("only moves forward on its own", async () => {
    await aifirst(["done", "py-7-01"]);
    // Going back to fill in an earlier exercise must not drag the bookmark back.
    await aifirst(["done", "py-1-01"]);
    const at = JSON.parse((await aifirst(["at", "--format", "json"])).stdout);
    expect(at.position).toBe("py-7-01");
  });

  it("moves where told, in either direction", async () => {
    await aifirst(["done", "py-7-01"]);
    await aifirst(["at", "py-5-01"]);
    expect(await nextId()).toBe("py-5-01");
  });

  it("clears back to strict order", async () => {
    await aifirst(["done", "py-7-01"]);
    await aifirst(["at", "--clear"]);
    expect(await nextId()).toBe("py-1-01");
  });

  it("falls back rather than claiming the book is finished", async () => {
    // Bookmark at the very end, with everything before it unfinished.
    const last = JSON.parse((await aifirst(["list", "py", "--format", "json"])).stdout)
      .books[0].chapters.flatMap((c: { exercises: { id: string }[] }) => c.exercises)
      .pop().id;
    await aifirst(["at", last]);
    const out = JSON.parse((await aifirst(["next", "--format", "json"])).stdout);
    expect(out.complete).toBe(false);
    expect(out.next).not.toBeNull();
  });

  it("is not a completion — it records nothing", async () => {
    await aifirst(["at", "py-7-03"]);
    const progress = JSON.parse((await aifirst(["progress", "--format", "json"])).stdout);
    expect(progress.overall.done).toBe(0);
    expect(progress.overall.skipped).toBe(0);
  });

  it("survives being written and read back", async () => {
    await aifirst(["at", "py-6-01"]);
    const at = JSON.parse((await aifirst(["at", "--format", "json"])).stdout);
    expect(at.position).toBe("py-6-01");
  });
});
