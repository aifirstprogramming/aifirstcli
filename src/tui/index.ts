import type { Args } from "../cli";
import { boolFlag } from "../cli";
import { isInteractive } from "../prompt";
import { currentTuiSession, TuiStartupError, withTuiSession } from "./session";

export { currentTuiSession } from "./session";

export function shouldUseTui(args: Args): boolean {
  if (currentTuiSession()) return true;
  if (boolFlag(args, "plain")) return false;
  if (!isInteractive()) return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.TERM === "dumb" || process.env.AIFIRST_TUI === "0") return false;
  return true;
}

export async function runWithTui<T>(args: Args, operation: () => Promise<T>, title: string): Promise<T> {
  if (!shouldUseTui(args) || currentTuiSession()) return operation();
  try {
    return await withTuiSession(operation, title);
  } catch (error) {
    if (!(error instanceof TuiStartupError)) throw error;
    process.stderr.write(`AI First TUI unavailable; using plain mode: ${(error as Error).message}\n`);
    return operation();
  }
}
