import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { replayDir } from "../paths";

const MAX_AGE_MS = 30 * 60 * 1000;

export interface PendingReplay {
  version: 2;
  stepIds: string[];
  createdAt: string;
}

function pendingPath(root = process.cwd()): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 20);
  return `${replayDir()}/pending-${key}.json`;
}

export function confirmationAnswer(prompt: string): "yes" | "no" | undefined {
  const answer = prompt.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["yes", "y", "confirm", "run it", "do it"].includes(answer)) return "yes";
  if (["no", "n", "cancel", "never mind", "nevermind"].includes(answer)) return "no";
  return undefined;
}

export function replaySelection(prompt: string, stepIds: string[]): string | "cancel" | undefined {
  const answer = prompt.trim().toLowerCase().replace(/[.!]+$/, "");
  if (["none", "none of these", "no exercise", "cancel", "never mind", "nevermind", "no", "n"].includes(answer)) {
    return "cancel";
  }
  if (stepIds.length === 1 && confirmationAnswer(answer) === "yes") return stepIds[0];
  const numbered = answer.match(/^(?:option\s*)?([1-9])$/)?.[1];
  if (numbered) return stepIds[Number(numbered) - 1];
  return stepIds.find((stepId) => answer === stepId.toLowerCase() || answer.includes(stepId.toLowerCase()));
}

export function savePendingReplay(stepIds: string | string[], root = process.cwd()): void {
  mkdirSync(replayDir(), { recursive: true });
  const state: PendingReplay = {
    version: 2,
    stepIds: Array.isArray(stepIds) ? stepIds.slice(0, 3) : [stepIds],
    createdAt: new Date().toISOString(),
  };
  writeFileSync(pendingPath(root), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function readPendingReplay(root = process.cwd()): PendingReplay | undefined {
  const path = pendingPath(root);
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      version?: number;
      stepId?: string;
      stepIds?: unknown;
      createdAt?: string;
    };
    const created = typeof state.createdAt === "string" ? Date.parse(state.createdAt) : Number.NaN;
    const stepIds = state.version === 1 && typeof state.stepId === "string"
      ? [state.stepId]
      : state.version === 2 && Array.isArray(state.stepIds) && state.stepIds.every((id) => typeof id === "string")
        ? state.stepIds
        : undefined;
    if (!stepIds?.length || !Number.isFinite(created) || Date.now() - created > MAX_AGE_MS) {
      rmSync(path, { force: true });
      return undefined;
    }
    return { version: 2, stepIds: stepIds.slice(0, 3), createdAt: state.createdAt! };
  } catch {
    return undefined;
  }
}

export function clearPendingReplay(root = process.cwd()): void {
  rmSync(pendingPath(root), { force: true });
}
