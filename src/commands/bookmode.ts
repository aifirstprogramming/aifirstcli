/**
 * `aifirst book-mode on | off | status`.
 *
 * Points Claude Code at the local book-mode server by writing
 * `env.ANTHROPIC_BASE_URL` into its settings, and puts it back again.
 *
 * The write goes through the same guarded path as the permission entries — one
 * backup, and a refusal rather than a clobber if the file cannot be parsed. That
 * file holds someone's whole Claude Code configuration; adding one key is not worth
 * risking it.
 *
 * Deliberately not pre-approved. It rewrites agent configuration, which is a thing
 * a reader should decide to do, not something an assistant does mid-exercise.
 */

import { baseUrl, DEFAULT_PORT } from "../bookmode/port";
import { claudeSettingsPath, readClaudeSettings, updateClaudeSettings } from "../agents/claude";
import type { Args } from "../cli";
import { formatFlag, numberFlag, stringFlag } from "../cli";
import { claudeEntries } from "../permissions";
import { CliError, bold, cyan, dim, glyph, green, json, out, red } from "../output";
import { loadReplayPack } from "./replay";

/** The key we set, and the only one we will ever remove. */
const KEY = "ANTHROPIC_BASE_URL";

function env(data: Record<string, unknown>): Record<string, unknown> {
  const existing = data.env;
  return existing && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : {};
}

function currentBaseUrl(): string | undefined {
  const data = readClaudeSettings();
  if (!data) return undefined;
  const value = env(data)[KEY];
  return typeof value === "string" ? value : undefined;
}

/** Is something actually listening? Claude Code's failure otherwise is opaque. */
async function listening(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/hello`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Are the aifirst commands pre-approved? Book mode's tool calls need them. */
function preApproved(): boolean {
  const data = readClaudeSettings();
  if (!data) return false;
  const perms = data.permissions as { allow?: unknown } | undefined;
  const allow = Array.isArray(perms?.allow) ? (perms!.allow as unknown[]) : [];
  return claudeEntries().every((entry) => allow.includes(entry));
}

function unparseable(): never {
  throw new CliError(
    `Could not read ${claudeSettingsPath()}`,
    "bad_settings",
    "It exists but is not valid JSON. Fix or move it, then try again — it was left untouched.",
  );
}

export async function bookMode(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const action = (args.positionals[0] ?? "status").toLowerCase();
  const port = numberFlag(args, "port") ?? DEFAULT_PORT;
  const url = baseUrl(port);
  const replay = stringFlag(args, "replay");

  if (!["on", "off", "status"].includes(action)) {
    throw new CliError(`Unknown book-mode action "${action}"`, "bad_option", "Use: on, off, or status");
  }

  // --- status -------------------------------------------------------------
  if (action === "status") {
    const current = currentBaseUrl();
    const live = current ? await listening(current) : false;
    if (format === "json") {
      json({ on: Boolean(current), baseUrl: current ?? null, serving: live, preApproved: preApproved() });
      return;
    }
    out();
    if (!current) {
      out(`  Book mode is ${bold("off")} — Claude Code talks to Anthropic as usual.`);
      out();
      out(dim(`  ${glyph.arrow} aifirst serve        in one terminal`));
      out(dim(`     aifirst book-mode on  in another`));
    } else {
      out(`  Book mode is ${bold("on")}, pointing Claude Code at ${bold(current)}`);
      out(
        live
          ? dim("  the server is up")
          : red("  nothing is listening there — start it with: aifirst serve"),
      );
      out();
      out(dim(`  ${glyph.arrow} aifirst book-mode off   put Claude Code back`));
    }
    out();
    return;
  }

  // --- off ----------------------------------------------------------------
  if (action === "off") {
    const ok = updateClaudeSettings((data) => {
      const current = env(data);
      delete current[KEY];
      // Leave no empty `env` behind that we invented.
      if (Object.keys(current).length === 0) delete data.env;
      else data.env = current;
    });
    if (!ok) unparseable();

    if (format === "json") {
      json({ on: false, baseUrl: null });
      return;
    }
    out();
    out(`  ${green(glyph.done)} book mode off — Claude Code talks to Anthropic again, at the usual cost`);
    out();
    return;
  }

  // --- on -----------------------------------------------------------------
  if (replay) loadReplayPack(replay);
  const live = await listening(url);
  const approved = preApproved();

  const ok = updateClaudeSettings((data) => {
    data.env = { ...env(data), [KEY]: url };
  });
  if (!ok) unparseable();

  if (format === "json") {
    json({ on: true, baseUrl: url, serving: live, preApproved: approved });
    return;
  }

  out();
  out(`  ${green(glyph.done)} book mode on — Claude Code now asks ${bold(url)}${replay ? ` for replay ${bold(replay)}` : ""}`);
  out(dim("  answers come from the content pack; no model runs and nothing leaves this machine"));
  out();

  if (!live) {
    // Worth saying loudly: without the server, Claude Code just fails to connect
    // and the reason is not obvious from its error.
    out(red(`  Nothing is listening on ${url} yet.`));
    out(dim(`  ${cyan(glyph.arrow)} start it in another terminal:  aifirst serve`));
    out();
  }

  if (!approved) {
    // Book mode's replies ask Claude Code to run `aifirst run <id>`. Without the
    // permission entries it refuses, and the reader sees an approval prompt for
    // every exercise.
    out(red("  The aifirst commands are not pre-approved for Claude Code."));
    out(dim(`  ${cyan(glyph.arrow)} run once:  aifirst init`));
    out();
  }

  out(dim(`  ${glyph.arrow} aifirst book-mode off   to put it back`));
  out();
}
