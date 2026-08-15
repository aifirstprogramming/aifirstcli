import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { Args } from "../cli";
import { boolFlag, stringFlag } from "../cli";
import { replayDir } from "../paths";
import { CliError, json, out, table } from "../output";
import { buildReplayPack } from "../replay/importer";
import { parseShowtailReport } from "../replay/showtailReport";
import type { ReplayPack } from "../replay/types";

function packPath(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new CliError("Replay name may contain only letters, numbers, dots, underscores, and hyphens", "bad_option");
  return join(replayDir(), `${name}.json`);
}
export function loadReplayPack(name: string): ReplayPack {
  try { return JSON.parse(readFileSync(packPath(name), "utf8")) as ReplayPack; }
  catch { throw new CliError(`Replay "${name}" was not found`, "not_found"); }
}
function format(args: Args): "text" | "json" { return stringFlag(args, "format") === "json" ? "json" : "text"; }

export function replay(args: Args): void {
  const action = (args.positionals[0] ?? "").toLowerCase();
  const output = format(args);
  if (action === "import") {
    const source = args.positionals[1];
    const name = stringFlag(args, "name") ?? args.positionals[2];
    if (!source || !name) throw new CliError("Usage: aifirst replay import <report.json> --name <name>", "bad_option");
    const target = packPath(name);
    if (existsSync(target) && !boolFlag(args, "force")) throw new CliError(`Replay "${name}" already exists`, "already_exists", "Pass --force to replace it.");
    const pack = buildReplayPack(name, parseShowtailReport(JSON.parse(readFileSync(source, "utf8"))));
    mkdirSync(replayDir(), { recursive: true });
    writeFileSync(target, JSON.stringify(pack, null, 2) + "\n", { mode: 0o600 });
    if (output === "json") json({ imported: name, steps: pack.steps.length });
    else { out("WARNING: this report may contain another person's real prompts, files, and tool output. Showtail redaction is best-effort, not guaranteed."); out(`Imported replay ${name} (${pack.steps.length} steps).`); }
    return;
  }
  if (action === "list") {
    const rows: [string, string][] = [];
    if (existsSync(replayDir())) for (const file of readdirSync(replayDir())) {
      if (!file.endsWith(".json") || file.endsWith(".state.json")) continue;
      const pack = loadReplayPack(basename(file, ".json"));
      rows.push([pack.name, `${pack.displayName} (${pack.steps.length} steps)`]);
    }
    if (output === "json") json(rows.map(([name, detail]) => ({ name, detail })));
    else out(rows.length ? table(rows) : "No replays imported.");
    return;
  }
  const name = args.positionals[1];
  if (!name) throw new CliError("Usage: aifirst replay show|reset <name>", "bad_option");
  if (action === "reset") {
    loadReplayPack(name);
    rmSync(join(replayDir(), `${name}.state.json`), { force: true });
    out(`Reset replay ${name}.`);
    return;
  }
  if (action === "show") {
    const pack = loadReplayPack(name);
    if (output === "json") json(pack);
    else out(pack.steps.map((step, index) => [`Step ${index + 1}: ${step.promptText}`, [...step.commentary, ...step.codeChanges.map((c) => c.diff ? `\n\`\`\`diff\n${c.diff}\n\`\`\`` : ""), ...step.toolCalls.map((c) => `🛠️ **${c.toolName}**\n${c.text}`)].filter(Boolean).join("\n\n")].join("\n" )).join("\n\n"));
    return;
  }
  throw new CliError(`Unknown replay action "${action}"`, "bad_option", "Use import, list, show, or reset.");
}