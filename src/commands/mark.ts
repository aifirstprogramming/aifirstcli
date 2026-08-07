/**
 * `aifirst done <id>`, `aifirst skip <id>`, `aifirst reset [id]`.
 *
 * The self-reported and agent-reported paths into the learner log. `done`
 * deliberately accepts `--via agent --agent <name>` so a skill can record
 * completion after walking a learner through an exercise in chat, where no file
 * was ever written.
 */

import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag, stringFlag } from "../cli";
import { resolveContent } from "../content";
import { clear, mark, read } from "../log/progress";
import type { Via } from "../log/progress";
import { CliError, bold, dim, glyph, green, json, out, yellow } from "../output";

function resolveExerciseId(args: Args, command: string): string {
  const input = args.positionals[0];
  if (!input) {
    throw new CliError(`${command} needs an exercise id`, "missing_argument", `Try: aifirst ${command} py-1-01`);
  }
  const { content } = resolveContent();
  // Resolve through the content so a typo is caught immediately rather than
  // silently recorded against an id that doesn't exist.
  return resolve(input, content).example.id;
}

function parseVia(raw: string | undefined): Via {
  if (raw === undefined) return "self";
  if (raw === "self" || raw === "agent" || raw === "apply") return raw;
  throw new CliError(`--via must be self, agent or apply`, "bad_option");
}

export function done(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = resolveExerciseId(args, "done");
  const entry = mark(id, {
    status: "done",
    via: parseVia(stringFlag(args, "via")),
    agent: stringFlag(args, "agent"),
  });

  if (format === "json") {
    json({ exerciseId: id, entry });
    return;
  }
  out(`  ${green(glyph.done)} ${bold(id)} marked done`);
}

export function skip(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const id = resolveExerciseId(args, "skip");
  const entry = mark(id, { status: "skipped", via: parseVia(stringFlag(args, "via")) });

  if (format === "json") {
    json({ exerciseId: id, entry });
    return;
  }
  out(`  ${yellow(glyph.skipped)} ${bold(id)} skipped`);
}

export function reset(args: Args): void {
  const format = formatFlag(args, ["text", "json"]);
  const input = args.positionals[0];

  if (!input) {
    // Clearing an entire learner log is the one destructive thing this CLI does,
    // so it needs an explicit confirmation flag rather than a prompt that a pipe
    // would auto-answer.
    if (!boolFlag(args, "all")) {
      const count = Object.keys(read().exercises).length;
      throw new CliError(
        `reset with no id clears all ${count} recorded exercise(s)`,
        "confirmation_required",
        "Re-run as: aifirst reset --all   (or: aifirst reset <id>)",
      );
    }
    clear();
    if (format === "json") json({ cleared: "all" });
    else out(`  ${green(glyph.done)} learner log cleared`);
    return;
  }

  const id = resolveExerciseId(args, "reset");
  clear(id);
  if (format === "json") json({ cleared: id });
  else out(`  ${green(glyph.done)} ${bold(id)} reset`);
}
