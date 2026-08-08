/**
 * `aifirst init`.
 *
 * The one command a book reader is told to run. It detects the AI tools they
 * have, asks which book they're reading, and — with one confirmation — installs
 * the book skills and pre-approves the `aifirst` commands so the reader isn't
 * approving a prompt for every step of every exercise.
 *
 * Pre-approval is the only thing this CLI writes outside its own directories, so
 * the files it will touch are listed before the question, and `--no-permissions`
 * skips it entirely.
 */

import type { Args } from "../cli";
import { boolFlag, formatFlag } from "../cli";
import { AGENTS, detectAll, keysFromFlags, selectAgents } from "../agents";
import type { Agent, PermissionResult } from "../agents";
import { bookChoices, resolveScope } from "../books";
import { ALL_BOOKS, setBook } from "../config";
import { resolveContent } from "../content";
import { recordPack } from "../log/progress";
import { WITHHELD_COMMANDS } from "../permissions";
import { bold, cyan, dim, glyph, green, json, out, red, yellow } from "../output";
import { choose, confirm, isInteractive } from "../prompt";
import { INSTALL_HOST } from "../version";

export async function init(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const explicit = keysFromFlags(args.flags);
  const assumeYes = boolFlag(args, "yes");
  const skipPermissions = boolFlag(args, "no-permissions");

  const detected = await detectAll();
  const targets = selectAgents(explicit, detected);
  const content = resolveContent();

  if (format === "json") {
    if (!assumeYes && explicit.length === 0) {
      json({
        detected: detected.map((d) => ({ key: d.agent.key, ...d.detection })),
        installed: [],
        books: bookChoices(content.content),
        note: "Pass --yes to install, or name agents explicitly (--claude, --codex, ...). Set the book with: aifirst book <tag>",
      });
      return;
    }
    const results = await installAll(targets, skipPermissions);
    recordPack(content.version);
    json({
      detected: detected.map((d) => ({ key: d.agent.key, ...d.detection })),
      installed: results,
      book: resolveScope(content.content).kind === "unset" ? null : undefined,
      books: bookChoices(content.content),
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

  // --- What we are about to change ----------------------------------------

  out(dim(`  This will:`));
  out(dim(`    install book skills into`));
  for (const agent of targets) out(dim(`      ${agent.target}`));

  const permissionTargets = skipPermissions
    ? []
    : targets.filter((a) => a.permissionTarget).map((a) => a.permissionTarget!);
  if (permissionTargets.length > 0) {
    out();
    out(dim(`    pre-approve the everyday aifirst commands in`));
    for (const t of permissionTargets) out(dim(`      ${t}`));
    out(
      dim(
        `      so you aren't asked to approve every step. ` +
          `${Object.keys(WITHHELD_COMMANDS).join(", ")} still ask.`,
      ),
    );
  }
  out();

  if (!assumeYes && explicit.length === 0) {
    if (!isInteractive()) {
      out(dim(`  Non-interactive; re-run as: aifirst init --yes`));
      out();
      process.exitCode = 1;
      return;
    }
    const ok = await confirm(
      `Set up ${targets.length} tool${targets.length === 1 ? "" : "s"}?`,
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

  const results = await installAll(targets, skipPermissions);

  for (const r of results) {
    const agent = AGENTS.find((a) => a.key === r.key)!;
    if (r.error) {
      out(`  ${red(glyph.todo)} ${agent.label}: ${r.error}`);
      continue;
    }
    out(`  ${green(glyph.done)} ${agent.label}`);
    for (const path of r.written) out(dim(`      ${shorten(path)}`));
    for (const note of r.notes ?? []) out(dim(`      ${note}`));

    if (r.permissions?.state === "allowlisted" && r.permissions.changed.length > 0) {
      out(dim(`      pre-approved aifirst commands in ${shorten(r.permissions.changed[0])}`));
    }
    if (r.permissions?.manual) {
      out(`      ${yellow(r.permissions.manual)}`);
    }
    for (const note of r.permissions?.notes ?? []) out(dim(`      ${note}`));
  }

  recordPack(content.version);

  // --- Which book? ---------------------------------------------------------

  if (resolveScope(content.content).kind === "unset") {
    const choices = bookChoices(content.content);
    const picked = await choose("Which book are you reading?", [
      ...choices.map((c) => ({ key: c.tag, label: `${c.title} ${dim(`(${c.exercises} exercises)`)}` })),
      { key: ALL_BOOKS, label: "All of them" },
    ]);

    if (picked) {
      const book = choices.find((c) => c.tag === picked);
      setBook(picked === ALL_BOOKS ? ALL_BOOKS : book!.id);
      out();
      out(`  ${green(glyph.done)} ${picked === ALL_BOOKS ? "showing all books" : `reading ${bold(book!.title)}`}`);
    } else {
      out();
      out(dim(`  No book chosen — set it any time with: aifirst book <tag>`));
    }
  }

  out();
  out(`  ${bold("Ready.")}`);
  out();
  out(`  ${cyan(glyph.arrow)} ${bold("aifirst next")}      ${dim("your next exercise")}`);
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
  permissions?: PermissionResult;
}

/**
 * Install into each target, isolating failures.
 *
 * One unwritable agent directory must not prevent the others from being set up —
 * a partially working install is far better than none for someone trying to
 * follow along with a book. A failure to pre-approve is likewise non-fatal: the
 * skills still work, the learner just sees approval prompts.
 */
async function installAll(targets: Agent[], skipPermissions: boolean): Promise<InstallReport[]> {
  const reports: InstallReport[] = [];
  for (const agent of targets) {
    try {
      const result = await agent.install();
      const report: InstallReport = { key: agent.key, written: result.written, notes: result.notes };
      if (!skipPermissions) {
        report.permissions = await agent
          .grantPermissions()
          .catch((e): PermissionResult => ({ state: "missing", changed: [], notes: [(e as Error).message] }));
      }
      reports.push(report);
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
