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

import { compareIds } from "@aifirst/content";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { progressFile } from "../paths";

export type Status = "done" | "skipped";
/**
 * How a completion was recorded. Purely informational, shown in reports.
 *
 * There is no value for merely viewing or writing an exercise: `aifirst show`
 * and `aifirst apply` never mark anything. Reading a prompt or dropping a file on
 * disk isn't doing the work, and silently inflating a learner's progress would
 * make the log worthless to them. `run` is recorded because the program ran.
 *
 * `apply` is retained only so logs written by 0.1.x still parse.
 */
export type Via = "run" | "agent" | "self" | "apply";

const VIAS: readonly Via[] = ["run", "agent", "self", "apply"];

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
  /**
   * Where the learner is in the book, as an exercise id.
   *
   * Separate from what they have completed, because those are different
   * questions. Someone reading chapter 7 is in chapter 7 whether or not they did
   * every exercise in chapter 2, and `next` walking strict id order pulled them
   * back to the earliest gap every time.
   *
   * Advances on its own as exercises are recorded, and only ever forward: going
   * back to fill in an earlier exercise should not lose your place.
   */
  position?: string;
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
      // Rebuilt field by field, so anything not named here is dropped on load.
      ...(typeof parsed.position === "string" ? { position: parsed.position } : {}),
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
    // Working on an exercise is what moves the bookmark, so a learner never has
    // to maintain it by hand. Forward only: filling in an earlier gap should not
    // drag their place back to chapter 2.
    if (!log.position || compareIds(id, log.position) > 0) log.position = id;

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
    else {
      log.exercises = {};
      // Wiping progress wipes the bookmark too; leaving it would point into a
      // book the learner has, as far as the log knows, not started.
      log.position = undefined;
    }
  }, path);
}

/** Move the bookmark by hand. Unlike the automatic advance, this can go back. */
export function setPosition(id: string | undefined, path?: string): void {
  update((log) => {
    log.position = id;
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
