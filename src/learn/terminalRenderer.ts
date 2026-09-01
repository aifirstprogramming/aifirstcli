import { emitKeypressEvents } from "node:readline";
import { marked, type Token, type Tokens } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("xml", xml);

type Style =
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "strike"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "brightBlue"
  | "brightCyan"
  | "brightMagenta";

interface Cell {
  char: string;
  styles: Style[];
}

export interface TerminalFragment {
  text: string;
  visible: number;
  delayMs?: number;
}

export interface TerminalBlock {
  kind: "immediate" | "prose" | "code";
  fragments: TerminalFragment[];
}

export interface TerminalRenderOptions {
  columns?: number;
  color?: boolean;
  ascii?: boolean;
  charsPerSecond?: number;
  chunkChars?: number;
  noAnimation?: boolean;
  dumb?: boolean;
  writer?: (text: string) => void;
  sleep?: (milliseconds: number) => Promise<unknown>;
  stdin?: NodeJS.ReadStream;
  onInterrupt?: () => void;
}

const STYLE_CODES: Record<Style, string> = {
  bold: "1",
  dim: "2",
  italic: "3",
  underline: "4",
  strike: "9",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  brightBlue: "94",
  brightMagenta: "95",
  brightCyan: "96",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  py: "python",
  python3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  html: "xml",
};

const CLASS_STYLES: Record<string, Style[]> = {
  "hljs-attr": ["blue"],
  "hljs-built_in": ["brightCyan"],
  "hljs-bullet": ["cyan"],
  "hljs-comment": ["dim"],
  "hljs-doctag": ["dim", "cyan"],
  "hljs-keyword": ["brightMagenta"],
  "hljs-literal": ["magenta"],
  "hljs-meta": ["dim", "cyan"],
  "hljs-number": ["cyan"],
  "hljs-params": ["yellow"],
  "hljs-property": ["blue"],
  "hljs-punctuation": ["dim"],
  "hljs-section": ["bold", "brightBlue"],
  "hljs-string": ["green"],
  "hljs-symbol": ["cyan"],
  "hljs-title": ["bold", "brightBlue"],
  "hljs-type": ["yellow"],
  "hljs-variable": ["red"],
};

function defaultColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.AIFIRST_FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
}

function addStyle(cells: Cell[], ...styles: Style[]): Cell[] {
  return cells.map((cell) => ({ ...cell, styles: [...cell.styles, ...styles] }));
}

function cells(text: string, styles: Style[] = []): Cell[] {
  return Array.from(text, (char) => ({ char, styles }));
}

function renderCells(value: Cell[], color: boolean): string {
  if (!color) return value.map((cell) => cell.char).join("");
  let rendered = "";
  let active = "";
  for (const cell of value) {
    const key = [...new Set(cell.styles)].join(";");
    if (key !== active) {
      if (active) rendered += "\x1b[0m";
      if (key) rendered += `\x1b[${key.split(";").map((style) => STYLE_CODES[style as Style]).join(";")}m`;
      active = key;
    }
    rendered += cell.char;
  }
  if (active) rendered += "\x1b[0m";
  return rendered;
}

function inlineCells(tokens: Token[] | undefined, inherited: Style[] = []): Cell[] {
  const output: Cell[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        output.push(...(text.tokens ? inlineCells(text.tokens, inherited) : cells(text.text, inherited)));
        break;
      }
      case "escape":
        output.push(...cells((token as Tokens.Escape).text, inherited));
        break;
      case "strong":
        output.push(...inlineCells((token as Tokens.Strong).tokens, [...inherited, "bold"]));
        break;
      case "em":
        output.push(...inlineCells((token as Tokens.Em).tokens, [...inherited, "italic"]));
        break;
      case "del":
        output.push(...inlineCells((token as Tokens.Del).tokens, [...inherited, "strike"]));
        break;
      case "codespan":
        output.push(...cells((token as Tokens.Codespan).text, [...inherited, "yellow"]));
        break;
      case "link": {
        const link = token as Tokens.Link;
        output.push(...inlineCells(link.tokens, [...inherited, "underline"]));
        output.push(...cells(` (${link.href})`, [...inherited, "dim"]));
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        output.push(...cells(`${image.text} (${image.href})`, [...inherited, "dim"]));
        break;
      }
      case "br":
        output.push(...cells("\n", inherited));
        break;
      default: {
        const generic = token as Token & { text?: string; tokens?: Token[] };
        if (generic.tokens) output.push(...inlineCells(generic.tokens, inherited));
        else if (generic.text) output.push(...cells(generic.text, inherited));
      }
    }
  }
  return output;
}

function splitLines(value: Cell[]): Cell[][] {
  const lines: Cell[][] = [[]];
  for (const cell of value) {
    if (cell.char === "\n") lines.push([]);
    else lines.at(-1)!.push(cell);
  }
  return lines;
}

function wrapCells(value: Cell[], width: number): Cell[][] {
  if (width <= 0) return [value];
  const output: Cell[][] = [];
  for (const sourceLine of splitLines(value)) {
    let remaining = sourceLine.slice();
    if (remaining.length === 0) {
      output.push([]);
      continue;
    }
    while (remaining.length > width) {
      let end = width;
      for (let index = width; index >= Math.floor(width / 2); index--) {
        if (/\s/.test(remaining[index - 1]?.char ?? "")) {
          end = index;
          break;
        }
      }
      const line = remaining.slice(0, end);
      while (line.at(-1)?.char === " ") line.pop();
      output.push(line);
      remaining = remaining.slice(end);
      while (remaining[0]?.char === " ") remaining.shift();
    }
    output.push(remaining);
  }
  return output;
}

function chunkLine(value: Cell[], limit: number, color: boolean): TerminalFragment[] {
  if (value.length === 0) return [{ text: "\n", visible: 0 }];
  const chunks: Cell[][] = [];
  let remaining = value.slice();
  while (remaining.length > limit) {
    let end = limit;
    for (let index = limit; index >= Math.floor(limit / 2); index--) {
      if (/\s/.test(remaining[index - 1]?.char ?? "")) {
        end = index;
        break;
      }
    }
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  chunks.push(remaining);
  return chunks.map((chunk, index) => ({
    text: renderCells(chunk, color) + (index === chunks.length - 1 ? "\n" : ""),
    visible: chunk.length,
  }));
}

function proseBlock(value: Cell[], width: number, color: boolean, chunkChars: number, prefix = "", restPrefix = prefix): TerminalBlock {
  const firstWidth = Math.max(10, width - Array.from(prefix).length);
  const restWidth = Math.max(10, width - Array.from(restPrefix).length);
  const wrapped: Cell[][] = [];
  for (const [index, line] of wrapCells(value, firstWidth).entries()) {
    if (index === 0) wrapped.push([...cells(prefix), ...line]);
    else {
      const rewrapped = wrapCells(line, restWidth);
      for (const continuation of rewrapped) wrapped.push([...cells(restPrefix), ...continuation]);
    }
  }
  const fragments = wrapped.flatMap((line) => chunkLine(line, chunkChars, color));
  fragments.push({ text: "\n", visible: 0 });
  return { kind: "prose", fragments };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function highlightedCells(source: string, language: string): Cell[][] {
  const normalized = LANGUAGE_ALIASES[language] ?? language;
  if (!normalized || !hljs.getLanguage(normalized)) return source.split("\n").map((line) => cells(line));
  const html = hljs.highlight(source, { language: normalized, ignoreIllegals: true }).value;
  const lines: Cell[][] = [[]];
  const stack: Style[][] = [[]];
  const parts = html.split(/(<span class="[^"]+">|<\/span>|\n)/g).filter(Boolean);
  for (const part of parts) {
    if (part === "\n") {
      lines.push([]);
      continue;
    }
    if (part === "</span>") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const opening = part.match(/^<span class="([^"]+)">$/);
    if (opening) {
      const styles = opening[1].split(/\s+/).flatMap((name) => CLASS_STYLES[name] ?? []);
      stack.push([...stack.at(-1)!, ...styles]);
      continue;
    }
    lines.at(-1)!.push(...cells(decodeHtml(part), stack.at(-1)!));
  }
  return lines;
}

function languageName(raw: string | undefined): string {
  const first = raw?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return (LANGUAGE_ALIASES[first] ?? first) || "text";
}

function codeBlock(token: Tokens.Code, columns: number, color: boolean, ascii: boolean, rate: number): TerminalBlock {
  const language = languageName(token.lang);
  const topLeft = ascii ? "+-" : "╭─";
  const bottomLeft = ascii ? "+-" : "╰─";
  const rule = ascii ? "-" : "─";
  const header = `${topLeft} ${language} ${rule.repeat(Math.max(1, columns - language.length - 5))}\n`;
  const footer = `${bottomLeft}${rule.repeat(Math.max(1, columns - 2))}\n\n`;
  const lines = highlightedCells(token.text, language);
  const fragments: TerminalFragment[] = [{ text: color ? `\x1b[2m${header}\x1b[0m` : header, visible: columns }];
  for (const line of lines) {
    const rendered = `  ${renderCells(line, color)}\n`;
    const visible = line.length + 2;
    fragments.push({
      text: rendered,
      visible,
      delayMs: Math.max(20, Math.min(120, Math.round((visible / Math.max(1, rate)) * 1000))),
    });
  }
  fragments.push({ text: color ? `\x1b[2m${footer}\x1b[0m` : footer, visible: columns });
  return { kind: "code", fragments };
}

function listItemCells(item: Tokens.ListItem): Cell[] {
  const paragraphs = item.tokens.filter((token) => token.type === "text" || token.type === "paragraph");
  if (paragraphs.length === 0) return cells(item.text);
  return paragraphs.flatMap((token, index) => [
    ...(index > 0 ? cells(" ") : []),
    ...inlineCells((token as Tokens.Text | Tokens.Paragraph).tokens),
  ]);
}

export function terminalBlocks(markdown: string, options: TerminalRenderOptions = {}): TerminalBlock[] {
  const columns = Math.max(30, options.columns ?? process.stdout.columns ?? 80);
  const contentWidth = Math.max(20, columns - 4);
  const color = options.color ?? defaultColor();
  const ascii = options.ascii ?? process.env.AIFIRST_ASCII === "1";
  const chunkChars = Math.max(4, options.chunkChars ?? 24);
  const rate = Math.max(1, options.charsPerSecond ?? 360);
  const blocks: TerminalBlock[] = [];

  for (const token of marked.lexer(markdown, { gfm: true })) {
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const value = addStyle(inlineCells(heading.tokens), "bold", heading.depth <= 2 ? "cyan" : "brightBlue");
        blocks.push({ kind: "immediate", fragments: [{ text: `${renderCells(value, color)}\n\n`, visible: value.length }] });
        break;
      }
      case "hr": {
        const rule = (ascii ? "-" : "─").repeat(contentWidth);
        blocks.push({ kind: "immediate", fragments: [{ text: `${color ? `\x1b[2m${rule}\x1b[0m` : rule}\n\n`, visible: contentWidth }] });
        break;
      }
      case "code":
        blocks.push(codeBlock(token as Tokens.Code, contentWidth, color, ascii, rate));
        break;
      case "paragraph": {
        const paragraph = token as Tokens.Paragraph;
        blocks.push(proseBlock(inlineCells(paragraph.tokens), contentWidth, color, chunkChars));
        break;
      }
      case "text": {
        const text = token as Tokens.Text;
        blocks.push(proseBlock(text.tokens ? inlineCells(text.tokens) : cells(text.text), contentWidth, color, chunkChars));
        break;
      }
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const quoteText = quote.tokens.flatMap((child, index) => [
          ...(index > 0 ? cells(" ") : []),
          ...inlineCells((child as Tokens.Paragraph | Tokens.Text).tokens),
        ]);
        blocks.push(proseBlock(quoteText, contentWidth, color, chunkChars, `${ascii ? ">" : "│"} `, `${ascii ? ">" : "│"} `));
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const start = typeof list.start === "number" ? list.start : 1;
        for (const [index, item] of list.items.entries()) {
          const marker = list.ordered ? `${start + index}. ` : `${ascii ? "*" : "•"} `;
          blocks.push(proseBlock(listItemCells(item), contentWidth, color, chunkChars, marker, " ".repeat(Array.from(marker).length)));
        }
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows]
          .map((row) => row.map((cell) => cell.text.trim()).join("  |  "))
          .join("\n");
        blocks.push(proseBlock(cells(rows), contentWidth, color, chunkChars));
        break;
      }
      default: {
        const generic = token as Token & { text?: string; tokens?: Token[] };
        if (generic.tokens || generic.text) {
          blocks.push(proseBlock(generic.tokens ? inlineCells(generic.tokens) : cells(generic.text ?? ""), contentWidth, color, chunkChars));
        }
      }
    }
  }
  return blocks;
}

class BlockSkipController {
  private skipped = false;
  private interrupted = false;
  private resolveSkip: (() => void) | undefined;
  private readonly previousRaw: boolean;
  private readonly enabled: boolean;

  constructor(
    private readonly stdin: NodeJS.ReadStream,
    private readonly onInterrupt: () => void,
  ) {
    this.previousRaw = Boolean(stdin.isRaw);
    this.enabled = Boolean(stdin.isTTY && typeof stdin.setRawMode === "function");
    if (!this.enabled) return;
    emitKeypressEvents(stdin);
    stdin.on("keypress", this.onKeypress);
    if (!this.previousRaw) stdin.setRawMode!(true);
    stdin.resume();
  }

  private onKeypress = (text: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl && key.name === "c") {
      this.interrupted = true;
      this.skipped = true;
      this.finish();
      this.onInterrupt();
      return;
    }
    if (text === " " || text === "\r" || text === "\n" || key.name === "space" || key.name === "return" || key.name === "enter") {
      this.skipped = true;
      this.resolveSkip?.();
    }
  };

  isSkipped(): boolean {
    return this.skipped;
  }

  async wait(milliseconds: number, sleep: (milliseconds: number) => Promise<unknown>): Promise<void> {
    if (this.skipped || this.interrupted || milliseconds <= 0) return;
    if (!this.enabled) {
      await sleep(milliseconds);
      return;
    }
    await Promise.race([
      sleep(milliseconds),
      new Promise<void>((resolve) => { this.resolveSkip = resolve; }),
    ]);
    this.resolveSkip = undefined;
  }

  finish(): void {
    if (!this.enabled) return;
    this.stdin.off("keypress", this.onKeypress);
    if (!this.previousRaw) this.stdin.setRawMode!(false);
    if (!this.previousRaw) this.stdin.pause();
    this.resolveSkip?.();
    this.resolveSkip = undefined;
  }
}

export async function renderTerminalMarkdown(markdown: string, options: TerminalRenderOptions = {}): Promise<void> {
  if (!markdown.trim()) return;
  const writer = options.writer ?? ((text: string) => process.stdout.write(text));
  const sleep = options.sleep ?? Bun.sleep;
  const rate = options.noAnimation ? undefined : options.charsPerSecond;
  const blocks = terminalBlocks(markdown, options);
  const dumb = options.dumb ?? process.env.TERM === "dumb";
  const canAnimate = rate !== undefined && rate > 0 && !dumb;

  for (const block of blocks) {
    if (!canAnimate || block.kind === "immediate") {
      writer(block.fragments.map((fragment) => fragment.text).join(""));
      continue;
    }
    const controller = new BlockSkipController(
      options.stdin ?? process.stdin,
      options.onInterrupt ?? (() => process.kill(process.pid, "SIGINT")),
    );
    try {
      for (const fragment of block.fragments) {
        writer(fragment.text);
        if (controller.isSkipped()) continue;
        const delay = fragment.delayMs ?? Math.round((fragment.visible / Math.max(1, rate)) * 1000);
        await controller.wait(delay, sleep);
      }
    } finally {
      controller.finish();
    }
  }
}
