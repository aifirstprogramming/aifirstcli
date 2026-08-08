/**
 * `aifirst doctor`.
 *
 * One screen answering "is this set up, and where is my stuff". Exits non-zero
 * only when something is actually wrong (no agent configured at all, or a skill
 * that drifted from this binary), so it's usable as a smoke test.
 */

import { existsSync } from "node:fs";
import type { Args } from "../cli";
import { formatFlag } from "../cli";
import { detectAll } from "../agents";
import { findLatestPack, resolveContent } from "../content";
import { report } from "../exercises";
import { read } from "../log/progress";
import { progressFile, stateDir } from "../paths";
import { bold, dim, glyph, green, json, out, red, table, yellow } from "../output";
import { VERSION } from "../version";

export async function doctor(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const content = resolveContent();
  const log = read();
  const counts = report(content.content, log).overall;
  const detected = await detectAll();

  const skills = await Promise.all(
    detected.map(async (d) => ({
      key: d.agent.key,
      label: d.agent.label,
      detection: d.detection,
      skill: await d.agent.check().catch(() => ({ state: "missing" as const })),
      permissions: await d.agent.permissionState().catch(() => "missing" as const),
    })),
  );

  const configured = skills.filter((s) => s.skill.state === "current");
  const drifted = skills.filter((s) => s.skill.state === "drift");
  const pack = findLatestPack();

  if (format === "json") {
    json({
      cli: { version: VERSION, executable: process.execPath },
      content: {
        source: content.source,
        version: content.version,
        dir: content.dir ?? null,
        books: content.content.books.length,
        exercises: content.content.examples.length,
        downloadedPack: pack,
      },
      log: { path: progressFile(), exists: existsSync(progressFile()), counts },
      agents: skills,
      ok: configured.length > 0 && drifted.length === 0,
    });
    if (configured.length === 0 || drifted.length > 0) process.exitCode = 1;
    return;
  }

  out();
  out(`  ${bold("aifirst")} ${dim(VERSION)}`);
  out();

  out(`  ${bold("Content")}`);
  out(
    table(
      [
        ["pack", `${content.version} ${dim(`(${content.source})`)}`],
        ["books", String(content.content.books.length)],
        ["exercises", String(content.content.examples.length)],
        ...(content.dir ? ([["from", dim(content.dir)]] as [string, string][]) : []),
      ],
      "    ",
    ),
  );
  out();

  out(`  ${bold("Learner log")}`);
  out(
    table(
      [
        ["file", dim(progressFile())],
        ["state dir", dim(stateDir())],
        ["recorded", `${counts.done} done, ${counts.skipped} skipped, of ${counts.total}`],
      ],
      "    ",
    ),
  );
  out();

  out(`  ${bold("Tools")}`);
  for (const s of skills) {
    let status: string;
    if (!s.detection.installed && s.skill.state === "missing") {
      status = dim("not installed");
    } else if (s.skill.state === "current") {
      status = green(`${glyph.done} skill ${s.skill.version}`);
    } else if (s.skill.state === "drift") {
      status = yellow(`${glyph.todo} skill ${s.skill.version ?? "unknown"}, expected ${s.skill.expected}`);
    } else {
      status = yellow("detected, skill not installed");
    }
    const version = s.detection.version ? dim(` ${s.detection.version}`) : "";
    out(`    ${s.label}${version}`);
    out(`      ${status}`);

    // Whether the reader will be interrupted by approval prompts.
    if (s.skill.state !== "missing" || s.detection.installed) {
      if (s.permissions === "allowlisted") {
        out(`      ${green(`${glyph.done} aifirst commands pre-approved`)}`);
      } else if (s.permissions === "manual") {
        out(`      ${dim("add command(aifirst) to its Allow list to skip approval prompts")}`);
      } else if (s.permissions === "missing") {
        out(`      ${yellow(`${glyph.todo} not pre-approved — you'll be asked to approve each command`)}`);
      }
    }
  }
  out();

  if (configured.length === 0) {
    out(`  ${red("No tool has the AI First skill installed.")}`);
    out(dim(`  ${glyph.arrow} aifirst init`));
    out();
    process.exitCode = 1;
    return;
  }

  if (drifted.length > 0) {
    out(`  ${yellow("Some skills were written by a different aifirst version.")}`);
    out(dim(`  ${glyph.arrow} aifirst skill install    refresh them`));
    out();
    process.exitCode = 1;
    return;
  }

  out(`  ${green("All good.")} ${dim(`${glyph.arrow} aifirst next`)}`);
  out();
}
