/**
 * `aifirst init`.
 *
 * The one command a book reader is told to run. Detects every supported agent,
 * shows what it found, asks once, and installs the book skills into all of them.
 *
 * Explicit flags (`--claude`, `--codex`, ...) narrow the set and skip the prompt,
 * which is also how a learner installs for an agent they haven't set up yet.
 */

import type { Args } from "../cli";
import { boolFlag, formatFlag } from "../cli";
import { AGENTS, detectAll, keysFromFlags, selectAgents } from "../agents";
import type { Agent } from "../agents";
import { resolveContent } from "../content";
import { recordPack } from "../log/progress";
import { bold, cyan, dim, glyph, green, json, out, red, yellow } from "../output";
import { confirm, isInteractive } from "../prompt";
import { INSTALL_HOST } from "../version";

export async function init(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const explicit = keysFromFlags(args.flags);
  const assumeYes = boolFlag(args, "yes");

  const detected = await detectAll();
  const targets = selectAgents(explicit, detected);

  if (format === "json") {
    // Non-interactive by nature: JSON callers must opt in explicitly rather than
    // have us silently write to their agent configs.
    if (!assumeYes && explicit.length === 0) {
      json({
        detected: detected.map((d) => ({ key: d.agent.key, ...d.detection })),
        installed: [],
        note: "Pass --yes to install, or name agents explicitly (--claude, --codex, ...).",
      });
      return;
    }
    const results = await installAll(targets);
    recordPack(resolveContent().version);
    json({
      detected: detected.map((d) => ({ key: d.agent.key, ...d.detection })),
      installed: results,
    });
    return;
  }

  out();
  out(`  ${bold("AI First setup")}`);
  out();

  for (const { agent, detection } of detected) {
    if (detection.installed) {
      const version = detection.version ? dim(` ${detection.version}`) : "";
      out(`  ${green(glyph.done)} ${agent.label}${version}`);
    } else {
      out(`  ${dim(`${glyph.todo} ${agent.label} — not found`)}`);
    }
  }
  out();

  if (targets.length === 0) {
    out(`  ${yellow("No supported AI tools found.")}`);
    out();
    out(dim("  Install one of these, then run aifirst init again:"));
    out(dim("    Claude Code   https://claude.com/claude-code"));
    out(dim("    Codex         https://developers.openai.com/codex/cli"));
    out(dim("    Antigravity   https://antigravity.google"));
    out(dim("    VS Code       https://code.visualstudio.com"));
    out();
    out(dim(`  Or install for a specific tool anyway: aifirst init --claude`));
    out();
    process.exitCode = 1;
    return;
  }

  out(dim(`  This writes book skills into:`));
  for (const agent of targets) out(dim(`    ${agent.target}`));
  out();
  out(dim(`  Nothing else is modified — no settings, models, or credentials.`));
  out();

  if (!assumeYes && explicit.length === 0) {
    if (!isInteractive()) {
      out(dim(`  Non-interactive; re-run as: aifirst init --yes`));
      out();
      process.exitCode = 1;
      return;
    }
    const ok = await confirm(
      `Install AI First skills into ${targets.length} tool${targets.length === 1 ? "" : "s"}?`,
      "Re-run as: aifirst init --yes",
    );
    if (!ok) {
      out();
      out(dim("  Nothing installed."));
      out();
      return;
    }
    out();
  }

  const results = await installAll(targets);

  for (const r of results) {
    const agent = AGENTS.find((a) => a.key === r.key)!;
    if (r.error) {
      out(`  ${red(glyph.todo)} ${agent.label}: ${r.error}`);
      continue;
    }
    out(`  ${green(glyph.done)} ${agent.label}`);
    for (const path of r.written) out(dim(`      ${shorten(path)}`));
    for (const note of r.notes ?? []) out(dim(`      ${note}`));
  }

  const content = resolveContent();
  recordPack(content.version);

  out();
  out(`  ${bold("Ready.")} ${dim(`${content.content.examples.length} exercises, content pack ${content.version}`)}`);
  out();
  out(`  ${cyan(glyph.arrow)} ${bold("aifirst next")}      ${dim("your next exercise")}`);
  out(`  ${cyan(glyph.arrow)} ${bold("aifirst list")}      ${dim("browse the books")}`);
  out(`  ${cyan(glyph.arrow)} ${bold("aifirst doctor")}    ${dim("check the setup")}`);
  out();
  out(dim(`  Docs: ${INSTALL_HOST}`));
  out();
}

interface InstallReport {
  key: string;
  written: string[];
  notes?: string[];
  error?: string;
}

/**
 * Install into each target, isolating failures.
 *
 * One unwritable agent directory must not prevent the others from being set up —
 * a partially working install is far better than none for someone trying to
 * follow along with a book.
 */
async function installAll(targets: Agent[]): Promise<InstallReport[]> {
  const reports: InstallReport[] = [];
  for (const agent of targets) {
    try {
      const result = await agent.install();
      reports.push({ key: agent.key, written: result.written, notes: result.notes });
    } catch (e) {
      reports.push({ key: agent.key, written: [], error: (e as Error).message });
    }
  }
  return reports;
}

/** Collapse $HOME to ~ so output stays readable and doesn't leak a username. */
function shorten(path: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
