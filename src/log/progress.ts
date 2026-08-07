/**
 * The learner log.
 *
 * This is a student's own record of what they've worked through — not an
 * assessment, and not something anyone needs to defend against tampering. It's
 * plain JSON in one file so a learner can read it, hand-edit it, copy it to
 * another machine, or delete it.
 *
 * Two properties matter and drive the design:
 *
 *  - **Never lose progress.** Entries for ids the current content pack doesn't
 *    know about are preserved rather than pruned, so switching books or rolling
 *    a pack back doesn't erase history.
 *  - **Survive concurrent writes.** The CLI and an agent shelling out to
 *    `aifirst done` can run at the same time. Every mutation re-reads, merges,
 *    and writes atomically via a temp file plus rename.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { progressFile } from "../paths";

export type Status = "done" | "skipped";
/**
 * How a completion was recorded. Purely informational, shown in reports.
 *
 * Note there is no value for merely viewing an exercise: `aifirst show` never
 * marks anything, since reading a prompt isn't doing the work and silently
 * inflating a learner's progress would make the log worthless to them.
 */
export type Via = "apply" | "agent" | "self";

const VIAS: readonly Via[] = ["apply", "agent", "self"];

export interface Entry {
  status: Status;
  /** ISO 8601 timestamp of the most recent update. */
  at: string;
  via: Via;
  /** Which agent reported it, when via is "agent". */
  agent?: string;
  /** Set on first completion and preserved across later updates. */
  firstAt?: string;
}

export interface ProgressLog {
  version: 1;
  content?: { pack?: string };
  exercises: Record<string, Entry>;
}

export function emptyLog(): ProgressLog {
  return { version: 1, exercises: {} };
}

/**
 * Read the log, tolerating absence and corruption.
 *
 * A malformed file must not brick the CLI — a learner would have no way to
 * recover beyond deleting a file they don't know exists. We fall back to an
 * empty log; the next write replaces the bad file.
 */
export function read(path = progressFile()): ProgressLog {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyLog();
  }

  try {
    const parsed = JSON.parse(text) as Partial<ProgressLog>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.exercises !== "object") {
      return emptyLog();
    }
    return {
      version: 1,
      content: parsed.content,
      exercises: sanitize(parsed.exercises as Record<string, unknown>),
    };
  } catch {
    return emptyLog();
  }
}

/** Drop entries we can't interpret rather than propagating junk into reports. */
function sanitize(raw: Record<string, unknown>): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    if (!value || typeof value !== "object") continue;
    const e = value as Partial<Entry>;
    if (e.status !== "done" && e.status !== "skipped") continue;
    out[id] = {
      status: e.status,
      at: typeof e.at === "string" ? e.at : new Date(0).toISOString(),
      via: VIAS.includes(e.via as Via) ? (e.via as Via) : "self",
      ...(typeof e.agent === "string" ? { agent: e.agent } : {}),
      ...(typeof e.firstAt === "string" ? { firstAt: e.firstAt } : {}),
    };
  }
  return out;
}

/** Write atomically so a crash or a concurrent reader never sees a partial file. */
export function write(log: ProgressLog, path = progressFile()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(log, null, 2) + "\n");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename failure is the one worth reporting */
    }
    throw e;
  }
}

/**
 * Apply a mutation against a fresh read, so a concurrent `aifirst done` from an
 * agent isn't clobbered by a slower in-flight command.
 */
export function update(mutate: (log: ProgressLog) => void, path = progressFile()): ProgressLog {
  const log = read(path);
  mutate(log);
  write(log, path);
  return log;
}

export interface MarkOptions {
  status?: Status;
  via?: Via;
  agent?: string;
  /** Injected in tests; defaults to now. */
  now?: Date;
  path?: string;
}

/** Record an exercise as done (or skipped). Idempotent. */
export function mark(id: string, options: MarkOptions = {}): Entry {
  const at = (options.now ?? new Date()).toISOString();
  let entry!: Entry;
  update((log) => {
    const existing = log.exercises[id];
    entry = {
      status: options.status ?? "done",
      at,
      via: options.via ?? "self",
      ...(options.agent ? { agent: options.agent } : {}),
      // Keep the date of the learner's first completion even as they redo it.
      firstAt: existing?.firstAt ?? existing?.at ?? at,
    };
    log.exercises[id] = entry;
  }, options.path);
  return entry;
}

/**
 * Record completion only when the exercise isn't already recorded.
 *
 * Used by the automatic paths (`apply`, agent reports) so redoing an exercise
 * never rewrites its original completion date, and a deliberate `skip` is not
 * silently upgraded to `done` by an incidental re-run.
 */
export function markIfNew(id: string, options: MarkOptions = {}): Entry | null {
  if (read(options.path).exercises[id]) return null;
  return mark(id, options);
}

/** Forget one exercise, or all of them. */
export function clear(id?: string, path?: string): void {
  update((log) => {
    if (id) delete log.exercises[id];
    else log.exercises = {};
  }, path);
}

export function get(id: string, path?: string): Entry | undefined {
  return read(path).exercises[id];
}

/** Note which content pack was last used, for `aifirst doctor`. */
export function recordPack(version: string, path?: string): void {
  update((log) => {
    log.content = { ...log.content, pack: version };
  }, path);
}
