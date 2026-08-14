import { parse } from "../cli";
import { ALLOWED_COMMANDS, WITHHELD_COMMANDS } from "../permissions";

export interface ChatCommand {
  command: string;
  positionals: string[];
}

const PREFIX = /^(?:\/aifirst|aifirst) ([^\n]+)$/;
const LOCAL_COMMANDS = new Set([...ALLOWED_COMMANDS, "help"]);

/** Parse only a complete chat command, never prose containing one. */
export function parseChatCommand(text: string): ChatCommand | undefined {
  const match = PREFIX.exec(text);
  if (!match) return undefined;

  const tail = match[1];
  if (tail !== tail.trim() || /\s{2,}/.test(tail)) return undefined;
  const args = parse(shellWords(tail));
  if (!args.command || args.flags.size > 0) return undefined;
  return { command: args.command, positionals: args.positionals };
}

/** Quoted search terms are the only shell-like syntax chat commands need. */
function shellWords(input: string): string[] {
  const words: string[] = [];
  const matcher = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(input))) {
    if (match.index !== cursor && input.slice(cursor, match.index).trim()) return [];
    words.push(match[1] ?? match[2] ?? match[3]);
    cursor = match.index + match[0].length;
  }
  return cursor === input.length ? words : [];
}

export function localHelp(): string {
  return "local learning accepts `aifirst next`, `aifirst show py-1-01`, and the other safe learner commands.";
}

export function chatCommandError(command: string): string {
  if (Object.prototype.hasOwnProperty.call(WITHHELD_COMMANDS, command)) {
    return `local learning does not run \`${command}\` in chat. Run it in your terminal instead.`;
  }
  return "local learning accepts only a complete safe `aifirst` command. It does not run general prompts.";
}

export function isLocalCommand(command: string): boolean {
  return LOCAL_COMMANDS.has(command);
}
