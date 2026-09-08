import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Content, Step } from "./types";
import type { GeneratedFileStore } from "../generatedFiles";

type ScaffoldFile = NonNullable<Step["scaffold"]>["files"][number] & {
  contentBase64?: string;
};

export function scaffoldFileData(
  file: ScaffoldFile,
  content: Content,
): { data: string | Uint8Array; binary: boolean } | undefined {
  if (file.contentBase64 !== undefined) {
    return { data: Buffer.from(file.contentBase64, "base64"), binary: true };
  }
  const text = file.fromExercise
    ? content.steps.find((step) => step.id === file.fromExercise)?.response
    : file.content;
  if (text === undefined) return undefined;
  return { data: text, binary: false };
}

/** Write scaffolds, refreshing only files that still match AI First's last output. */
export function writeScaffold(
  root: string,
  step: Step,
  content: Content,
  options: { binaryOnly?: boolean; generatedFiles?: GeneratedFileStore } = {},
): string[] {
  const written: string[] = [];
  for (const rawFile of step.scaffold?.files ?? []) {
    const file = rawFile as ScaffoldFile;
    if (isAbsolute(file.path) || file.path.split(/[\\/]+/).includes("..")) continue;
    const source = scaffoldFileData(file, content);
    if (!source || (options.binaryOnly && !source.binary)) continue;
    const target = resolve(root, file.path);
    const data = !source.binary && typeof source.data === "string" && !source.data.endsWith("\n")
      ? `${source.data}\n`
      : source.data;
    const expected = Buffer.from(data);
    if (existsSync(target)) {
      if (readFileSync(target).equals(expected)) {
        options.generatedFiles?.record(target);
        continue;
      }
      if (!options.generatedFiles?.matches(target)) continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    options.generatedFiles?.record(target);
    written.push(file.path);
  }
  return written;
}
