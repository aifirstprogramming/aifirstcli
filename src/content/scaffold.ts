import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Content, Step } from "./types";

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

/** Write missing scaffold files without replacing anything in the learner's workspace. */
export function writeScaffold(
  root: string,
  step: Step,
  content: Content,
  options: { binaryOnly?: boolean } = {},
): string[] {
  const written: string[] = [];
  for (const rawFile of step.scaffold?.files ?? []) {
    const file = rawFile as ScaffoldFile;
    if (isAbsolute(file.path) || file.path.split(/[\\/]+/).includes("..")) continue;
    const source = scaffoldFileData(file, content);
    if (!source || (options.binaryOnly && !source.binary)) continue;
    const target = resolve(root, file.path);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const data = !source.binary && typeof source.data === "string" && !source.data.endsWith("\n")
      ? `${source.data}\n`
      : source.data;
    writeFileSync(target, data);
    written.push(file.path);
  }
  return written;
}
