/**
 * Where book mode listens.
 *
 * Shared by `serve` and `book-mode`, so the URL written into a client's settings
 * cannot drift from the port the server actually binds.
 */

import { readClaudeSettings } from "../agents/claude";

export const DEFAULT_PORT = 8137;

export function baseUrl(port: number = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * The base URL book mode has configured for Claude Code, if any.
 *
 * Lives here rather than in the command so `doctor` can report it without
 * importing the whole book-mode command.
 */
export function bookModeBaseUrl(): string | undefined {
  const data = readClaudeSettings();
  const env = data?.env;
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>).ANTHROPIC_BASE_URL;
  return typeof value === "string" ? value : undefined;
}
