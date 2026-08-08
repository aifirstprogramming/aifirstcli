/**
 * Learner preferences — currently just which book they're reading.
 *
 * Kept in its own file rather than in `progress.json` so that
 * `aifirst reset --all`, which clears a learner's exercise history, doesn't also
 * forget which book they own and send them back to a setup question.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "./paths";

/** Sentinel for "show me every book", as opposed to unset. */
export const ALL_BOOKS = "all";

export interface Config {
  version: 1;
  /** A book id, the string "all", or absent when the learner hasn't chosen. */
  book?: string;
  /**
   * Set when the learner passed `--no-permissions`.
   *
   * Recorded so `doctor` can tell "you chose not to pre-approve" apart from
   * "pre-approval silently never happened" — and stop nagging about the former.
   */
  permissionsOptOut?: boolean;
}

export function configFile(): string {
  return join(stateDir(), "config.json");
}

export function read(path = configFile()): Config {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    if (!parsed || typeof parsed !== "object") return { version: 1 };
    return {
      version: 1,
      ...(typeof parsed.book === "string" ? { book: parsed.book } : {}),
      ...(parsed.permissionsOptOut === true ? { permissionsOptOut: true } : {}),
    };
  } catch {
    // Absent or unreadable is simply "not chosen yet"; never fatal.
    return { version: 1 };
  }
}

export function write(config: Config, path = configFile()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
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

/** Record the learner's book. Pass ALL_BOOKS to unscope. */
export function setBook(book: string, path?: string): void {
  const current = read(path);
  write({ ...current, book }, path);
}

export function clearBook(path?: string): void {
  const current = read(path);
  delete current.book;
  write(current, path);
}

/** Remember that the learner declined pre-approval, so `doctor` stops nagging. */
export function setPermissionsOptOut(optOut: boolean, path?: string): void {
  const current = read(path);
  if (optOut) current.permissionsOptOut = true;
  else delete current.permissionsOptOut;
  write(current, path);
}
