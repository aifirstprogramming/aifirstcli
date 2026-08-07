/**
 * `aifirst skill install | check | remove`.
 *
 * The explicit form of what `init` does implicitly, for learners who want to
 * manage one tool at a time, and for `aifirst update` to refresh bundles after an
 * upgrade.
 */

import type { Args } from "../cli";
import { formatFlag } from "../cli";
import { AGENTS, agentByKey, detectAll, keysFromFlags, selectAgents } from "../agents";
import type { Agent } from "../agents";
import { CliError, bold, dim, glyph, green, json, out, red, yellow } from "../output";
import { VERSION } from "../version";

async function targets(args: Args): Promise<Agent[]> {
  const explicit = keysFromFlags(args.flags);
  if (explicit.length > 0) return explicit.map(agentByKey);

  // A bare positional also selects an agent, so `aifirst skill install claude`
  // reads naturally.
  const positional = args.positionals.filter((p) => AGENTS.some((a) => a.key === p));
  if (positional.length > 0) return positional.map(agentByKey);

  const detected = await detectAll();
  const selected = selectAgents([], detected);
  if (selected.length === 0) {
    throw new CliError(
      "No supported AI tools detected",
      "no_agents",
      "Name one explicitly, e.g. aifirst skill install --claude",
    );
  }
  return selected;
}

export async function skill(args: Args): Promise<void> {
  const sub = args.positionals[0] ?? "check";
  const rest: Args = { ...args, positionals: args.positionals.slice(1) };

  switch (sub) {
    case "install":
      return skillInstall(rest);
    case "check":
      return skillCheck(rest);
    case "remove":
    case "uninstall":
      return skillRemove(rest);
    default:
      throw new CliError(
        `Unknown skill subcommand "${sub}"`,
        "unknown_command",
        "Use: aifirst skill install | check | remove",
      );
  }
}

async function skillInstall(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const agents = await targets(args);
  const results: { key: string; written: string[]; notes?: string[]; error?: string }[] = [];

  for (const agent of agents) {
    try {
      const r = await agent.install();
      results.push({ key: agent.key, written: r.written, notes: r.notes });
    } catch (e) {
      results.push({ key: agent.key, written: [], error: (e as Error).message });
    }
  }

  if (format === "json") {
    json({ version: VERSION, results });
    return;
  }
  out();
  for (const r of results) {
    const agent = agentByKey(r.key);
    if (r.error) out(`  ${red(glyph.todo)} ${agent.label}: ${r.error}`);
    else out(`  ${green(glyph.done)} ${agent.label} ${dim(`(${r.written.length} file(s))`)}`);
    for (const note of r.notes ?? []) out(dim(`      ${note}`));
  }
  out();
}

async function skillCheck(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const agents = await targets(args);
  const results = await Promise.all(
    agents.map(async (agent) => ({
      key: agent.key,
      label: agent.label,
      skill: await agent.check().catch(() => ({ state: "missing" as const })),
    })),
  );

  const bad = results.filter((r) => r.skill.state !== "current");

  if (format === "json") {
    json({ expected: VERSION, results, ok: bad.length === 0 });
    if (bad.length > 0) process.exitCode = 1;
    return;
  }

  out();
  for (const r of results) {
    if (r.skill.state === "current") {
      out(`  ${green(glyph.done)} ${r.label} ${dim(r.skill.version)}`);
    } else if (r.skill.state === "drift") {
      out(`  ${yellow(glyph.todo)} ${r.label} ${dim(`${r.skill.version ?? "unknown"} → ${r.skill.expected}`)}`);
    } else {
      out(`  ${dim(`${glyph.todo} ${r.label} — not installed`)}`);
    }
  }
  out();
  if (bad.length > 0) {
    out(dim(`  ${glyph.arrow} aifirst skill install`));
    out();
    process.exitCode = 1;
  }
}

async function skillRemove(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  // Removal acts only on what was explicitly named or is actually installed, so
  // it can't wander into an agent the learner never set up.
  const agents = await targets(args);
  const results: { key: string; removed: string[] }[] = [];

  for (const agent of agents) {
    results.push({ key: agent.key, removed: await agent.remove().catch(() => []) });
  }

  if (format === "json") {
    json({ results });
    return;
  }
  out();
  for (const r of results) {
    const agent = agentByKey(r.key);
    out(`  ${green(glyph.done)} ${agent.label} ${dim(r.removed.length ? `removed ${r.removed.length} path(s)` : "nothing to remove")}`);
  }
  out();
  out(dim(`  Your learner log was not touched. ${bold("aifirst reset --all")} clears that.`));
  out();
}
