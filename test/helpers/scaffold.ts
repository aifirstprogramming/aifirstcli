import { expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scaffoldFileData } from "../../src/content/scaffold";
import type { Content, Step } from "../../src/content/types";

export function seedScaffold(workspace: string, step: Step, content: Content): void {
  for (const file of step.scaffold?.files ?? []) {
    const source = scaffoldFileData(file, content);
    if (!source) continue;
    const path = join(workspace, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source.data);
  }
}

export function expectScaffold(workspace: string, step: Step, content: Content): void {
  for (const file of step.scaffold?.files ?? []) {
    const source = scaffoldFileData(file, content);
    expect(source, `${file.path} has no authored content`).toBeDefined();
    const path = join(workspace, file.path);
    const actual = source!.binary ? readFileSync(path) : readFileSync(path, "utf8");
    const expected = source!.binary
      ? Buffer.from(source!.data as Uint8Array)
      : source!.data as string;
    expect(actual, file.path).toEqual(expected);
  }
}
