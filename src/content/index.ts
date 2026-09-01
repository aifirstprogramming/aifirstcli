/**
 * Content resolution: which copy of the books this process should serve.
 *
 * Precedence, highest first:
 *   1. $AIFIRST_CONTENT_DIR          explicit override (tests, content authoring)
 *   2. ~/.aifirst/content/<version>  a pack fetched by `aifirst update --content`,
 *                                    but only when strictly newer than the embedded one
 *   3. the pack embedded in this binary
 *
 * The embedded pack is a floor, not a fallback that can fail: a learner on a dead
 * classroom network still gets every exercise. A downloaded pack only ever moves
 * content forward, so `update` can ship a book fix without a CLI release and can
 * never silently downgrade a reader to older code.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadFromDirectory, loadFromRaw } from "@aifirst/content";
import { contentDir } from "../paths";
import { EMBEDDED_BOOKS, EMBEDDED_PACK_VERSION } from "./embedded.generated";
import type { Content, RawEntry, Replay, ReplayStep } from "./types";

export type ContentSource = "embedded" | "pack" | "override";

export interface ResolvedContent {
  content: Content;
  source: ContentSource;
  version: string;
  /** Directory the content was read from; undefined when embedded. */
  dir?: string;
}

/** Compare dotted numeric versions. Returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest downloaded pack, or null when none is installed. */
export function findLatestPack(): { version: string; dir: string } | null {
  const root = contentDir();
  if (!existsSync(root)) return null;

  const packs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ version: e.name, dir: join(root, e.name) }))
    .filter((p) => existsSync(join(p.dir, "books")))
    .sort((a, b) => compareVersions(b.version, a.version));

  return packs[0] ?? null;
}

let cached: ResolvedContent | undefined;

export function resolveContent(): ResolvedContent {
  if (cached) return cached;

  const override = process.env.AIFIRST_CONTENT_DIR;
  if (override) {
    const dir = existsSync(join(override, "books")) ? join(override, "books") : override;
    cached = {
      content: withReplays(loadFromDirectory(dir, { version: "override" }), readEntries(dir)),
      source: "override",
      version: "override",
      dir,
    };
    return cached;
  }

  const pack = findLatestPack();
  if (pack && compareVersions(pack.version, EMBEDDED_PACK_VERSION) > 0) {
    try {
      const dir = join(pack.dir, "books");
      cached = {
        content: withReplays(loadFromDirectory(dir, { version: pack.version }), readEntries(dir)),
        source: "pack",
        version: pack.version,
        dir,
      };
      return cached;
    } catch {
      // A corrupt or half-downloaded pack must never take the CLI down; fall
      // through to the embedded copy, which is always valid.
    }
  }

  cached = {
    content: withReplays(loadFromRaw(EMBEDDED_BOOKS, { version: EMBEDDED_PACK_VERSION }), EMBEDDED_BOOKS),
    source: "embedded",
    version: EMBEDDED_PACK_VERSION,
  };
  return cached;
}

/** Test seam: forget the memoized content. */
export function resetContentCache(): void {
  cached = undefined;
}

export { EMBEDDED_PACK_VERSION };

function readEntries(dir: string): RawEntry[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((filename) => ({ filename, book: JSON.parse(readFileSync(join(dir, filename), "utf8")) }));
}

function withReplays(content: Content, entries: RawEntry[]): Content {
  const steps = new Map(content.steps.map((step) => [step.id, step as ReplayStep]));
  for (const entry of entries) {
    for (const section of entry.book.sections ?? []) {
      for (const chapter of section.chapters ?? []) {
        for (const example of chapter.examples ?? []) {
          if (example.status) continue;
          const replayExample = example as typeof example & {
            replay?: Replay;
            dependencies?: import("./types").Dependency[];
            prompts?: Array<{ id: string; replay?: Replay }>;
          };
          const normalizedExample = content.examples.find((candidate) => candidate.id === example.id);
          if (replayExample.dependencies) {
            if (normalizedExample) normalizedExample.dependencies = replayExample.dependencies;
            for (const normalizedStep of normalizedExample?.steps ?? []) {
              normalizedStep.dependencies = replayExample.dependencies;
            }
          }
          if (replayExample.prompts) {
            for (const rawStep of replayExample.prompts) {
              const step = steps.get(rawStep.id);
              if (step && rawStep.replay) step.replay = rawStep.replay as Replay;
            }
          } else if (replayExample.replay) {
            const step = steps.get(replayExample.id);
            if (step) step.replay = replayExample.replay as Replay;
          }
        }
      }
    }
  }
  return content;
}
