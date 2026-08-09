/**
 * Terminal output.
 *
 * Colour is opt-out via NO_COLOR and automatically disabled when stdout isn't a
 * TTY, so piping into an agent or a file yields clean text. Every command that
 * prints data supports `--format json`, which is the contract agents rely on;
 * human formatting is never mixed into that stream.
 */

export type Format = "text" | "json" | "md";

const useColor = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.AIFIRST_FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
})();

const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const cyan = wrap("36");

/** Status glyphs, with ASCII fallbacks for terminals that mangle box drawing. */
const unicode = process.env.AIFIRST_ASCII !== "1";
export const glyph = {
  done: unicode ? "✔" : "x",
  skipped: unicode ? "–" : "-",
  todo: unicode ? "·" : ".",
  // Distinct from `todo` on purpose: colour is off whenever output is piped or
  // NO_COLOR is set, so started-but-unfinished has to be legible in shape alone.
  partial: unicode ? "◐" : "o",
  arrow: unicode ? "→" : "->",
  bullet: unicode ? "•" : "*",
};

export function out(line = ""): void {
  process.stdout.write(line + "\n");
}

export function errLine(line = ""): void {
  process.stderr.write(line + "\n");
}

/** Print a JSON payload for machine consumers. */
export function json(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/**
 * Fatal error, structured so an agent can react.
 *
 * Human text goes to stderr; with `--format json` a machine-readable object goes
 * to stderr too, keeping stdout clean for real output.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code = "error",
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function reportError(e: unknown, format: Format): void {
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof CliError ? e.code : "error";
  const hint = e instanceof CliError ? e.hint : undefined;

  if (format === "json") {
    process.stderr.write(JSON.stringify({ error: { code, message, hint } }, null, 2) + "\n");
    return;
  }
  errLine(`${red("error")} ${message}`);
  if (hint) errLine(dim(`  ${glyph.arrow} ${hint}`));
}

/** Render a fenced code block for terminal display. */
export function codeBlock(code: string, language?: string): string {
  const lines = code.split("\n");
  const gutter = String(lines.length).length;
  return lines
    .map((l, i) => `  ${dim(String(i + 1).padStart(gutter))}  ${l}`)
    .join("\n")
    .concat(language ? "" : "");
}

/** A simple two-column table, left-aligned, for listings and doctor output. */
export function table(rows: [string, string][], indent = "  "): string {
  const width = rows.reduce((w, [k]) => Math.max(w, stripAnsi(k).length), 0);
  return rows.map(([k, v]) => `${indent}${k}${" ".repeat(width - stripAnsi(k).length)}  ${v}`).join("\n");
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

/** Horizontal progress bar, e.g. ████░░░░░░ 40%. */
export function bar(fraction: number, width = 20): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  const full = unicode ? "█" : "#";
  const empty = unicode ? "░" : ".";
  return green(full.repeat(filled)) + dim(empty.repeat(width - filled));
}

/**
 * Render the book's stored walkthrough.
 *
 * Printed from the content pack rather than written on the fly: an explanation
 * that changed wording every time would undercut the promise that the tool agrees
 * with the printed page, and the VS Code extension has no model to write one.
 */
export function explanationBlock(explanation: {
  summary: string;
  lines: { code: string; text: string }[];
  run?: string;
}): string[] {
  const rows: string[] = [];
  rows.push(`  ${cyan("Explanation")}`);
  rows.push(`  ${explanation.summary}`);
  if (explanation.lines.length > 0) {
    rows.push("");
    // "Worth noticing" rather than a numbered walkthrough: these are the few points
    // the chapter is making, not a line-by-line transcript.
    rows.push(`  ${dim("Worth noticing")}`);
    for (const line of explanation.lines) {
      rows.push("");
      rows.push(`  ${dim(line.code.trim())}`);
      rows.push(`      ${line.text}`);
    }
  }
  if (explanation.run) {
    rows.push("");
    rows.push(`  ${dim(`run with: ${explanation.run}`)}`);
  }
  return rows;
}
