/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled from npm: the CLI ships as a compiled binary a
 * learner downloads over a book's lifetime, so every dependency is a future
 * supply-chain and size cost for something this small.
 */

import { CliError, type Format } from "./output";

export interface Args {
  command: string;
  /** Positional arguments after the command. */
  positionals: string[];
  flags: Map<string, string | boolean>;
}

/** `--flag`, `--flag=value`, `--flag value`, `-f`, and `--` passthrough. */
export function parse(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command = "";
  let sawSeparator = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (sawSeparator) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      sawSeparator = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        // Consume the next token as this flag's value unless it's another flag.
        const next = argv[i + 1];
        if (next !== undefined && isValue(next) && VALUE_FLAGS.has(body)) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
        }
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const name = SHORT_FLAGS[arg.slice(1)];
      if (!name) throw new CliError(`Unknown option "${arg}"`, "unknown_option", "Run: aifirst help");
      const next = argv[i + 1];
      if (next !== undefined && isValue(next) && VALUE_FLAGS.has(name)) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }

    if (!command) command = arg;
    else positionals.push(arg);
  }

  return { command, positionals, flags };
}

/**
 * Can this token be a flag's value?
 *
 * A bare `-` is the conventional "use stdout" argument (`--into -`), so it must
 * be accepted as a value even though it starts with a dash.
 */
function isValue(token: string): boolean {
  return token === "-" || !token.startsWith("-");
}

/** Flags that take a value, so `--into file.py` doesn't swallow the wrong token. */
const VALUE_FLAGS = new Set([
  "format",
  "into",
  "language",
  "book",
  "chapter",
  "via",
  "agent",
  "step",
  "dir",
]);

const SHORT_FLAGS: Record<string, string> = {
  f: "format",
  h: "help",
  v: "version",
  y: "yes",
  o: "into",
};

export function flag(args: Args, name: string): string | boolean | undefined {
  return args.flags.get(name);
}

export function boolFlag(args: Args, name: string): boolean {
  const v = args.flags.get(name);
  return v === true || v === "true";
}

export function stringFlag(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function numberFlag(args: Args, name: string): number | undefined {
  const v = stringFlag(args, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new CliError(`--${name} expects a number, got "${v}"`, "bad_option");
  return n;
}

export function formatFlag(args: Args, allowed: Format[] = ["text", "json", "md"]): Format {
  const raw = stringFlag(args, "format") ?? "text";
  if (!allowed.includes(raw as Format)) {
    throw new CliError(
      `--format must be one of ${allowed.join(", ")}, got "${raw}"`,
      "bad_option",
    );
  }
  return raw as Format;
}
