import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generatedFilesDir } from "./paths";

interface GeneratedFileRecord {
  version: 1;
  path: string;
  sha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;

function targetPath(path: string): string {
  return resolve(path);
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class GeneratedFileStore {
  constructor(private readonly directory = generatedFilesDir()) {}

  recordPath(path: string): string {
    const target = targetPath(path);
    return join(this.directory, `${digest(target)}.json`);
  }

  /** True only when the file still has the exact bytes AI First last recorded. */
  matches(path: string): boolean {
    const target = targetPath(path);
    try {
      const parsed = JSON.parse(readFileSync(this.recordPath(target), "utf8")) as Partial<GeneratedFileRecord>;
      if (
        parsed.version !== 1 ||
        parsed.path !== target ||
        typeof parsed.sha256 !== "string" ||
        !SHA256.test(parsed.sha256)
      ) {
        return false;
      }
      return digest(readFileSync(target)) === parsed.sha256;
    } catch {
      return false;
    }
  }

  /** Record the actual post-write bytes without retaining any learner source text. */
  record(path: string): void {
    const target = targetPath(path);
    const destination = this.recordPath(target);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const record: GeneratedFileRecord = {
        version: 1,
        path: target,
        sha256: digest(readFileSync(target)),
      };
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
      renameSync(temporary, destination);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // The ownership error is more useful than a failed temp-file cleanup.
      }
      throw new Error(`Could not record generated-file ownership for ${target}: ${(error as Error).message}`);
    }
  }
}
