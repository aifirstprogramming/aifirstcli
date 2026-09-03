import {
  BoxRenderable,
  CliRenderEvents,
  CodeRenderable,
  DiffRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  SyntaxStyle,
  TextRenderable,
  createHostClipboard,
  createCliRenderer,
  pathToFiletype,
  type CliRenderer,
  type HostClipboardService,
  type KeyEvent,
  type PasteEvent,
  type Selection,
} from "@opentui/core";
import { setOutputSink } from "../output";
import { unifiedPatch } from "../textdiff";
import { markdownStreamBlocks, streamChunks, streamDelayMs } from "./streaming";
import { tuiHighlightClient } from "./highlighting";

export interface TuiChoice {
  key: string;
  label: string;
}

export type TuiChoiceResult =
  | { kind: "choice"; key: string }
  | { kind: "input"; value: string };

export interface TuiMarkdownOptions {
  charsPerSecond?: number;
  chunkChars?: number;
  noAnimation?: boolean;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

export function osc52Sequence(value: string): string {
  return `\x1b]52;c;${Buffer.from(value).toString("base64")}\x07`;
}

export function needsDirectOsc52(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:tmux|screen)/.test(env.TERM ?? "") || env.TERM_PROGRAM === "tmux" || Boolean(env.TMUX);
}

const ANSI = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

function lineCount(value: string): number {
  return Math.max(1, value.split("\n").length);
}

export class LearnTuiSession {
  private renderer!: CliRenderer;
  private root!: BoxRenderable;
  private transcript!: ScrollBoxRenderable;
  private bottom!: BoxRenderable;
  private footer!: TextRenderable;
  private context!: TextRenderable;
  private syntaxStyle!: SyntaxStyle;
  private lastText: TextRenderable | undefined;
  private lastTextValue = "";
  private destroyed = false;
  private palette: Record<string, string> = {};
  private interrupted = false;
  private hostClipboard!: HostClipboardService;
  private footerHint = "";
  private clipboardNotice = 0;
  private postExitMessage = "";
  private interactionActive = false;
  private expandLatest: (() => void) | undefined;

  static async create(title = "AI First"): Promise<LearnTuiSession> {
    const session = new LearnTuiSession();
    await session.initialize(title);
    return session;
  }

  private async initialize(title: string): Promise<void> {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      clearOnShutdown: true,
      screenMode: "alternate-screen",
      useMouse: true,
      enableMouseMovement: true,
      targetFps: 30,
      maxFps: 60,
      backgroundColor: "transparent",
    });
    const mode = await this.renderer.waitForThemeMode(150).catch(() => null);
    const light = mode === "light";
    const colors = light
      ? {
          text: "#202123",
          muted: "#667085",
          accent: "#005f87",
          border: "#aab2bd",
          selected: "#dceefa",
          selectedText: "#003b57",
          panel: "#f3f4f6",
          plan: "#f5f5f5",
          footer: "#eef0f2",
          add: "#d9f2df",
          remove: "#f8dddd",
          selection: "#b8dff3",
          selectionText: "#102a3a",
        }
      : {
          text: "#e5e7eb",
          muted: "#9ca3af",
          accent: "#67d8ef",
          border: "#4b5563",
          selected: "#173b4b",
          selectedText: "#dff8ff",
          panel: "#151a21",
          plan: "#20252c",
          footer: "#11161c",
          add: "#173d25",
          remove: "#4a2023",
          selection: "#28566b",
          selectionText: "#f0fbff",
        };

    this.syntaxStyle = SyntaxStyle.fromStyles({
      default: { fg: colors.text },
      keyword: { fg: "#d977ff", bold: true },
      string: { fg: "#63d297" },
      comment: { fg: colors.muted, italic: true },
      number: { fg: "#57c7ff" },
      function: { fg: "#7db7ff" },
      "function.builtin": { fg: "#67d8ef" },
      type: { fg: "#f1c75b" },
      "type.builtin": { fg: "#f1c75b", bold: true },
      variable: { fg: colors.text },
      "variable.builtin": { fg: "#67d8ef" },
      property: { fg: "#7db7ff" },
      constant: { fg: "#57c7ff" },
      "constant.builtin": { fg: "#57c7ff", bold: true },
      operator: { fg: colors.muted },
      "punctuation.special": { fg: colors.accent },
      tag: { fg: colors.accent, bold: true },
      "tag.punctuation": { fg: colors.muted },
      "maven.coordinate": { fg: "#f1c75b" },
      "maven.property": { fg: "#d977ff", bold: true },
      "markup.heading": { fg: colors.accent, bold: true },
      "markup.bold": { bold: true },
      "markup.italic": { italic: true },
      "markup.link": { fg: colors.accent, underline: true },
      "markup.raw": { fg: "#f1c75b" },
    });

    this.root = new BoxRenderable(this.renderer, {
      id: "aifirst-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "transparent",
    });
    const header = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 4,
      paddingX: 1,
      border: ["bottom"],
      borderColor: colors.border,
      backgroundColor: colors.panel,
      flexShrink: 0,
    });
    header.add(new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      content: title,
      fg: colors.accent,
      attributes: 1,
    }));
    this.context = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      content: "",
      fg: colors.text,
    });
    header.add(this.context);
    header.add(new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      content: "↑/↓ navigate • enter select • drag to copy • esc back • ctrl+c exit",
      fg: colors.muted,
    }));

    this.transcript = new ScrollBoxRenderable(this.renderer, {
      id: "aifirst-transcript",
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      paddingX: 1,
      viewportCulling: true,
    });
    this.bottom = new BoxRenderable(this.renderer, {
      id: "aifirst-bottom",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: colors.panel,
    });
    this.footer = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      content: "",
      fg: colors.muted,
      bg: colors.footer,
    });
    this.root.add(header);
    this.root.add(this.transcript);
    this.root.add(this.bottom);
    this.root.add(this.footer);
    this.renderer.root.add(this.root);
    this.renderer.on(CliRenderEvents.RESIZE, () => this.renderer.requestRender());
    this.hostClipboard = createHostClipboard();
    this.renderer.on(CliRenderEvents.SELECTION, this.onSelection);
    this.renderer.keyInput.on("keypress", this.onGlobalKey);
    this.renderer.start();

    this.palette = colors;
  }

  appendText(line: string): void {
    const clean = stripAnsi(line);
    if (this.lastText && this.lastTextValue.length < 8_000) {
      this.lastTextValue += `${this.lastTextValue ? "\n" : ""}${clean}`;
      this.lastText.content = this.lastTextValue;
      this.lastText.height = Math.min(200, lineCount(this.lastTextValue));
    } else {
      this.lastTextValue = clean;
      this.lastText = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: clean,
        fg: this.palette.text,
      });
      this.transcript.add(this.lastText);
    }
    this.renderer.requestRender();
  }

  clearTranscript(): void {
    for (const child of this.transcript.getChildren()) child.destroyRecursively();
    this.lastText = undefined;
    this.lastTextValue = "";
    this.expandLatest = undefined;
    this.transcript.scrollTo(0);
    this.renderer.requestRender();
  }

  async waitForDocumentReturn(): Promise<void> {
    this.clearBottom();
    this.interactionActive = true;
    this.setFooter("↑/↓ or Page Up/Page Down scroll  •  Enter/Esc return to Home");
    this.renderer.requestRender();
    await new Promise<void>((resolve) => {
      const onKey = (key: KeyEvent) => {
        if (key.name === "up" || key.name === "k") {
          key.preventDefault();
          key.stopPropagation();
          this.transcript.scrollBy(-1);
          return;
        }
        if (key.name === "down" || key.name === "j") {
          key.preventDefault();
          key.stopPropagation();
          this.transcript.scrollBy(1);
          return;
        }
        if (key.name === "pageup") {
          key.preventDefault();
          key.stopPropagation();
          this.transcript.scrollBy(-Math.max(1, this.renderer.height - 8));
          return;
        }
        if (key.name === "pagedown") {
          key.preventDefault();
          key.stopPropagation();
          this.transcript.scrollBy(Math.max(1, this.renderer.height - 8));
          return;
        }
        if (key.name !== "escape" && key.name !== "return" && key.name !== "enter" && key.name !== "linefeed") return;
        key.preventDefault();
        key.stopPropagation();
        this.renderer.keyInput.off("keypress", onKey);
        this.interactionActive = false;
        this.clearBottom();
        resolve();
      };
      this.renderer.keyInput.on("keypress", onKey);
    });
  }

  async presentPrompt(prompt: string, options: TuiMarkdownOptions = {}): Promise<"run" | "back" | "exit"> {
    this.lastText = undefined;
    this.lastTextValue = "";
    this.clearBottom();
    this.interactionActive = true;
    const panel = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      minHeight: 5,
      flexShrink: 0,
      padding: 1,
      marginY: 1,
      border: true,
      borderColor: this.palette.accent,
      backgroundColor: this.palette.panel,
      title: " Exercise Prompt • read only ",
      titleColor: this.palette.accent,
    });
    const field = new TextRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      minHeight: 2,
      flexShrink: 0,
      content: "▌",
      fg: this.palette.text,
    });
    panel.add(field);
    this.transcript.add(panel);
    this.renderer.requestRender();

    let cancelled: "back" | "exit" | undefined;
    let releaseSleep: (() => void) | undefined;
    const blockEditing = (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") cancelled = "exit";
      else if (key.name === "escape") cancelled = "back";
      key.preventDefault();
      key.stopPropagation();
      if (cancelled) releaseSleep?.();
    };
    this.renderer.keyInput.on("keypress", blockEditing);
    const sleep = options.sleep ?? Bun.sleep;
    const rate = options.noAnimation ? undefined : (options.charsPerSecond ?? 40);
    let rendered = "";
    try {
      for (const char of Array.from(prompt)) {
        if (cancelled) break;
        rendered += char;
        field.content = `${rendered}▌`;
        this.renderer.requestRender();
        if (rate) {
          await Promise.race([
            sleep(Math.max(1, Math.round(1000 / rate))),
            new Promise<void>((resolve) => { releaseSleep = resolve; }),
          ]);
          releaseSleep = undefined;
        }
      }
    } finally {
      this.renderer.keyInput.off("keypress", blockEditing);
      releaseSleep?.();
    }
    if (cancelled) {
      this.interactionActive = false;
      this.clearBottom();
      return cancelled;
    }
    field.content = prompt;

    this.bottom.height = 3;
    this.bottom.border = true;
    this.bottom.borderColor = this.palette.accent;
    this.bottom.paddingX = 1;
    const cta = new TextRenderable(this.renderer, {
      width: "100%",
      height: 1,
      content: "▶  PRESS ENTER TO RUN THIS PROMPT  ◀",
      fg: this.palette.selectedText,
      bg: this.palette.selected,
      attributes: 1,
    });
    this.bottom.add(cta);
    this.setFooter("Enter run prompt  •  Esc back  •  Ctrl+C exit");
    let bright = true;
    const timer = setInterval(() => {
      bright = !bright;
      cta.content = bright ? "▶  PRESS ENTER TO RUN THIS PROMPT  ◀" : "   PRESS ENTER TO RUN THIS PROMPT   ";
      this.renderer.requestRender();
    }, 260);
    this.renderer.requestRender();
    return await new Promise<"run" | "back" | "exit">((resolve) => {
      const onKey = (key: KeyEvent) => {
        let result: "run" | "back" | "exit" | undefined;
        if (key.ctrl && key.name === "c") result = "exit";
        else if (key.name === "escape") result = "back";
        else if (key.name === "return" || key.name === "enter" || key.name === "linefeed") result = "run";
        if (!result) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        key.preventDefault();
        key.stopPropagation();
        clearInterval(timer);
        this.renderer.keyInput.off("keypress", onKey);
        this.interactionActive = false;
        this.clearBottom();
        resolve(result);
      };
      this.renderer.keyInput.on("keypress", onKey);
    });
  }

  appendCode(path: string | undefined, language: string, source: string, previewLines = 40): void {
    this.lastText = undefined;
    this.lastTextValue = "";
    const lines = source.replace(/\n+$/, "").split("\n");
    const collapsed = lines.length > previewLines;
    const panel = new BoxRenderable(this.renderer, {
      width: "100%",
      height: Math.min(lines.length, previewLines) + (collapsed ? 4 : 3),
      flexShrink: 0,
      border: true,
      borderColor: this.palette.border,
      title: ` Code${path ? ` • ${path}` : ""} `,
      titleColor: this.palette.accent,
      marginY: 1,
      flexDirection: "column",
    });
    const visible = collapsed ? lines.slice(0, previewLines) : lines;
    const numbered = (values: string[]) => values.map((line, index) => `${String(index + 1).padStart(4)}  ${line}`).join("\n");
    const code = new CodeRenderable(this.renderer, {
      width: "100%",
      height: visible.length,
      flexShrink: 0,
      content: numbered(visible),
      filetype: language,
      syntaxStyle: this.syntaxStyle,
      treeSitterClient: tuiHighlightClient,
      wrapMode: "none",
      fg: this.palette.text,
      selectionBg: this.palette.selection,
      selectionFg: this.palette.selectionText,
    });
    panel.add(code);
    if (collapsed) {
      const remaining = lines.length - previewLines;
      const footer = new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: `… ${remaining} more lines — press e or click to expand`,
        fg: this.palette.accent,
        attributes: 1,
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          expand();
        },
      });
      const expand = () => {
        if (code.content === numbered(lines)) return;
        code.content = numbered(lines);
        code.height = lines.length;
        panel.height = lines.length + 4;
        footer.content = `Showing all ${lines.length} lines`;
        footer.fg = this.palette.muted;
        if (this.expandLatest === expand) this.expandLatest = undefined;
        this.renderer.requestRender();
      };
      panel.add(footer);
      this.expandLatest = expand;
    }
    this.transcript.add(panel);
    this.renderer.requestRender();
  }

  appendToolCard(title: string, detail: string, ok?: boolean): void {
    this.lastText = undefined;
    this.lastTextValue = "";
    const lines = detail.trim().split("\n");
    const shown = lines.slice(0, 12);
    const panel = new BoxRenderable(this.renderer, {
      width: "100%",
      height: shown.length + (lines.length > shown.length ? 3 : 2),
      flexShrink: 0,
      paddingX: 1,
      border: true,
      borderColor: ok === false ? "#ef4444" : ok === true ? "#22c55e" : this.palette.border,
      title: ` ${title} `,
      titleColor: ok === false ? "#ef4444" : ok === true ? "#22c55e" : this.palette.accent,
      marginY: 1,
    });
    panel.add(new TextRenderable(this.renderer, {
      width: "100%",
      height: shown.length + (lines.length > shown.length ? 1 : 0),
      content: `${shown.join("\n")}${lines.length > shown.length ? `\n… ${lines.length - shown.length} more lines` : ""}`,
      fg: this.palette.text,
    }));
    this.transcript.add(panel);
    this.renderer.requestRender();
  }

  async appendMarkdown(markdown: string, options: TuiMarkdownOptions = {}): Promise<void> {
    this.lastText = undefined;
    this.lastTextValue = "";
    const isPlan = /^## Proposed plan\b/m.test(markdown);
    const source = isPlan ? markdown.replace(/^## Proposed plan\s*/m, "") : markdown;
    const rate = options.noAnimation ? undefined : options.charsPerSecond;
    const animate = rate !== undefined && rate > 0;
    const panel = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      flexShrink: 0,
      padding: isPlan ? 1 : 0,
      marginY: 1,
      border: isPlan,
      borderColor: isPlan ? this.palette.accent : "transparent",
      backgroundColor: isPlan ? this.palette.plan : "transparent",
      flexDirection: "column",
      title: isPlan ? " Proposed Plan " : undefined,
      titleColor: isPlan ? this.palette.accent : undefined,
      bottomTitle: isPlan ? " Proposed Plan • review before approving " : undefined,
      bottomTitleAlignment: "right",
    });
    if (isPlan) {
      panel.add(new TextRenderable(this.renderer, {
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: "PROPOSED PLAN",
        fg: this.palette.accent,
        attributes: 1,
      }));
    }
    const content = new MarkdownRenderable(this.renderer, {
      width: "100%",
      height: "auto",
      flexShrink: 0,
      content: animate ? "" : source,
      syntaxStyle: this.syntaxStyle,
      fg: this.palette.text,
      bg: isPlan ? this.palette.plan : "transparent",
      conceal: true,
      concealCode: true,
      streaming: animate,
      treeSitterClient: tuiHighlightClient,
      internalBlockMode: "top-level",
    });
    panel.add(content);
    this.transcript.add(panel);
    this.renderer.requestRender();
    if (!animate) return;

    const sleep = options.sleep ?? Bun.sleep;
    const chunkChars = options.chunkChars ?? Math.max(1, Math.round(rate / 30));
    let rendered = "";
    const update = () => {
      content.content = rendered;
      this.renderer.requestRender();
    };

    try {
      for (const block of markdownStreamBlocks(source)) {
        if (block.immediate) {
          rendered += block.raw;
          update();
          continue;
        }

        let skipped = false;
        let releaseWait: (() => void) | undefined;
        const onKey = (key: KeyEvent) => {
          const reveal = key.sequence === " " || key.name === "space" || key.name === "return" || key.name === "enter" || key.name === "linefeed";
          if (!reveal) return;
          key.preventDefault();
          key.stopPropagation();
          skipped = true;
          releaseWait?.();
        };
        this.renderer.keyInput.on("keypress", onKey);
        try {
          const chunks = streamChunks(block.raw, chunkChars);
          for (let index = 0; index < chunks.length; index++) {
            const chunk = chunks[index]!;
            rendered += chunk;
            update();
            if (skipped) {
              rendered += chunks.slice(index + 1).join("");
              update();
              break;
            }
            await Promise.race([
              sleep(streamDelayMs(chunk, rate)),
              new Promise<void>((resolve) => { releaseWait = resolve; }),
            ]);
            releaseWait = undefined;
            if (skipped) {
              rendered += chunks.slice(index + 1).join("");
              update();
              break;
            }
          }
        } finally {
          this.renderer.keyInput.off("keypress", onKey);
          releaseWait?.();
        }
      }
    } finally {
      content.content = source;
      content.streaming = false;
      this.renderer.requestRender();
    }
  }

  appendDiff(path: string, oldText: string, newText: string): void {
    this.lastText = undefined;
    this.lastTextValue = "";
    const patch = unifiedPatch(path, oldText, newText);
    const height = Math.min(Math.max(8, lineCount(patch) + 2), Math.max(8, this.renderer.height - 8));
    const panel = new BoxRenderable(this.renderer, {
      width: "100%",
      height,
      flexShrink: 0,
      border: true,
      borderColor: this.palette.border,
      title: ` Edit • ${path} `,
      titleColor: this.palette.accent,
      marginY: 1,
    });
    panel.add(new DiffRenderable(this.renderer, {
      width: "100%",
      height: height - 2,
      diff: patch,
      view: "unified",
      filetype: path.split(/[\\/]/).at(-1)?.toLowerCase() === "pom.xml"
        ? "maven"
        : pathToFiletype(path) ?? path.split(".").at(-1),
      syntaxStyle: this.syntaxStyle,
      treeSitterClient: tuiHighlightClient,
      showLineNumbers: true,
      wrapMode: "word",
      addedBg: this.palette.add,
      removedBg: this.palette.remove,
      addedContentBg: this.palette.add,
      removedContentBg: this.palette.remove,
      addedSignColor: "#22c55e",
      removedSignColor: "#ef4444",
      selectionBg: this.palette.selection,
      selectionFg: this.palette.selectionText,
    }));
    this.transcript.add(panel);
    this.renderer.requestRender();
  }

  async choose(question: string, choices: TuiChoice[], inputHint?: string): Promise<TuiChoiceResult | undefined> {
    this.clearBottom();
    this.interactionActive = true;
    const height = Math.min(Math.max(7, choices.length * 2 + (inputHint ? 5 : 4)), Math.max(7, this.renderer.height - 5));
    this.bottom.height = height;
    this.bottom.border = true;
    this.bottom.borderColor = this.palette.border;
    this.bottom.title = ` ${stripAnsi(question)} `;
    this.bottom.titleColor = this.palette.accent;
    this.bottom.paddingX = 1;
    this.bottom.flexDirection = "column";

    let query = "";
    const cleanInputHint = inputHint ? stripAnsi(inputHint) : "";
    const queryLine = new TextRenderable(this.renderer, {
      width: "100%",
      height: inputHint ? 2 : 1,
      flexShrink: 0,
      content: inputHint ? `${cleanInputHint}\n› ` : "",
      fg: this.palette.muted,
    });
    if (inputHint) this.bottom.add(queryLine);

    const select = new SelectRenderable(this.renderer, {
      width: "100%",
      flexGrow: 1,
      options: choices.map((choice, index) => ({ name: `${index + 1}. ${stripAnsi(choice.label)}`, description: choice.key, value: choice.key })),
      showDescription: false,
      showSelectionIndicator: true,
      showScrollIndicator: true,
      wrapSelection: true,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      textColor: this.palette.text,
      focusedTextColor: this.palette.text,
      selectedBackgroundColor: this.palette.selected,
      selectedTextColor: this.palette.selectedText,
      descriptionColor: this.palette.muted,
      selectedDescriptionColor: this.palette.selectedText,
    });
    this.bottom.add(select);
    this.setFooter(inputHint
      ? "↑/↓ move  enter select or submit text  esc back  type to search/enter"
      : "↑/↓ or j/k move  enter select  1-9 shortcut  esc back");
    select.focus();
    this.renderer.requestRender();

    return await new Promise<TuiChoiceResult | undefined>((resolve) => {
      let done = false;
      const finish = (value: TuiChoiceResult | undefined) => {
        if (done) return;
        done = true;
        this.renderer.keyInput.off("keypress", onKey);
        this.renderer.keyInput.off("paste", onPaste);
        select.off(SelectRenderableEvents.ITEM_SELECTED, onSelect);
        select.blur();
        this.interactionActive = false;
        this.clearBottom();
        resolve(value);
      };
      const onSelect = (_index: number, option: { value?: string }) => {
        finish({ kind: "choice", key: option.value ?? choices[select.getSelectedIndex()]!.key });
      };
      const updateQuery = () => {
        queryLine.content = `${cleanInputHint}\n› ${query}`;
        this.renderer.requestRender();
      };
      const onPaste = (event: PasteEvent) => {
        if (!inputHint) return;
        const pasted = new TextDecoder().decode(event.bytes)
          .replaceAll("\0", "")
          .replace(/\s+/g, " ")
          .trim();
        if (!pasted) return;
        event.preventDefault();
        event.stopPropagation();
        query += `${query && !query.endsWith(" ") ? " " : ""}${pasted}`;
        updateQuery();
      };
      const onKey = (key: KeyEvent) => {
        if (key.defaultPrevented) return;
        if (key.ctrl && key.name === "c") {
          key.preventDefault();
          key.stopPropagation();
          this.interrupted = true;
          finish(undefined);
          return;
        }
        if (key.name === "escape") {
          key.preventDefault();
          key.stopPropagation();
          finish(undefined);
          return;
        }
        if (!inputHint && /^[1-9]$/.test(key.sequence) && !query) {
          const index = Number(key.sequence) - 1;
          if (choices[index]) {
            key.preventDefault();
            key.stopPropagation();
            finish({ kind: "choice", key: choices[index].key });
          }
          return;
        }
        if (!inputHint) return;
        if (key.name === "backspace") {
          query = query.slice(0, -1);
        } else if ((key.name === "return" || key.name === "enter" || key.name === "linefeed") && query.trim()) {
          key.preventDefault();
          key.stopPropagation();
          const trimmed = query.trim();
          const menuIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
          if (menuIndex >= 0 && choices[menuIndex]) finish({ kind: "choice", key: choices[menuIndex].key });
          else finish({ kind: "input", value: trimmed });
          return;
        } else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") {
          key.preventDefault();
          key.stopPropagation();
          query += key.sequence;
        } else {
          return;
        }
        updateQuery();
      };
      select.on(SelectRenderableEvents.ITEM_SELECTED, onSelect);
      this.renderer.keyInput.on("keypress", onKey);
      this.renderer.keyInput.on("paste", onPaste);
    });
  }

  async suspendDuring<T>(operation: () => Promise<T>): Promise<T> {
    this.renderer.suspend();
    try {
      return await operation();
    } finally {
      this.renderer.resume();
      this.renderer.requestRender();
    }
  }

  async withProgramRunning<T>(title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.clearBottom();
    this.bottom.height = 4;
    this.bottom.border = true;
    this.bottom.borderColor = this.palette.accent;
    this.bottom.title = ` ${stripAnsi(title)} `;
    this.bottom.titleColor = this.palette.accent;
    this.bottom.paddingX = 1;
    this.bottom.flexDirection = "column";
    const frames = ["◐", "◓", "◑", "◒"];
    let frame = 0;
    const status = new TextRenderable(this.renderer, {
      width: "100%",
      height: 2,
      content: `${frames[0]} Program running in another window\n  Close that window or press Esc there to return to Learn.`,
      fg: this.palette.text,
    });
    this.bottom.add(status);
    this.setFooter("Close the program window, or press Esc / Ctrl+C here to stop it");
    const controller = new AbortController();
    const onKey = (key: KeyEvent) => {
      const cancel = key.name === "escape" || (key.ctrl && key.name === "c");
      if (!cancel || controller.signal.aborted) return;
      key.preventDefault();
      key.stopPropagation();
      controller.abort();
      status.content = "◌ Stopping the program…";
      this.setFooter("Waiting for the program process to exit");
      this.renderer.requestRender();
    };
    this.renderer.keyInput.on("keypress", onKey);
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      frame = (frame + 1) % frames.length;
      status.content = `${frames[frame]} Program running in another window\n  Close that window or press Esc there to return to Learn.`;
      this.renderer.requestRender();
    }, 120);
    this.renderer.requestRender();
    try {
      return await operation(controller.signal);
    } finally {
      clearInterval(timer);
      this.renderer.keyInput.off("keypress", onKey);
      this.clearBottom();
    }
  }

  consumeInterrupt(): boolean {
    const interrupted = this.interrupted;
    this.interrupted = false;
    return interrupted;
  }

  setContext(content: string): void {
    this.context.content = stripAnsi(content);
    this.renderer.requestRender();
  }

  setPostExitMessage(content: string): void {
    this.postExitMessage = stripAnsi(content);
  }

  getPostExitMessage(): string {
    return this.postExitMessage;
  }

  private onSelection = (selection: Selection): void => {
    void this.copySelection(selection);
  };

  private onGlobalKey = (key: KeyEvent): void => {
    if (!this.interactionActive && !this.renderer.getSelection() && key.sequence.toLowerCase() === "e" && this.expandLatest) {
      key.preventDefault();
      key.stopPropagation();
      this.expandLatest();
      return;
    }
    const selection = this.renderer.getSelection();
    if (!selection) return;
    const copy = key.name === "c" && ((key.ctrl && key.shift) || key.ctrl || key.super === true);
    if (!copy) return;
    key.preventDefault();
    key.stopPropagation();
    void this.copySelection(selection);
  };

  private async copySelection(selection: Selection): Promise<void> {
    const value = selection.getSelectedText();
    if (!value) return;
    await this.copyText(value);
  }

  async copyText(value: string): Promise<boolean> {
    let terminal: boolean;
    if (needsDirectOsc52()) {
      process.stdout.write(osc52Sequence(value));
      terminal = true;
    } else {
      terminal = this.renderer.copyToClipboardOSC52(value);
    }
    const host = await this.hostClipboard.writeText(value).catch(() => ({ status: "failed" as const }));
    const copied = terminal || host.status === "written";
    this.showClipboardNotice(copied ? `Copied ${value.length} characters` : "Selection ready; clipboard unavailable");
    return copied;
  }

  private setFooter(content: string): void {
    this.footerHint = content;
    this.footer.content = content;
  }

  private showClipboardNotice(content: string): void {
    const notice = ++this.clipboardNotice;
    this.footer.content = content;
    this.renderer.requestRender();
    setTimeout(() => {
      if (notice !== this.clipboardNotice || this.destroyed) return;
      this.footer.content = this.footerHint;
      this.renderer.requestRender();
    }, 1_500);
  }

  private clearBottom(): void {
    for (const child of this.bottom.getChildren()) child.destroyRecursively();
    this.bottom.height = 1;
    this.bottom.border = false;
    this.bottom.paddingX = 0;
    this.setFooter("");
    this.renderer.requestRender();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderer.off(CliRenderEvents.SELECTION, this.onSelection);
    this.renderer.keyInput.off("keypress", this.onGlobalKey);
    await this.hostClipboard.dispose();
    this.renderer.destroy();
    this.syntaxStyle.destroy();
  }
}

let activeSession: LearnTuiSession | undefined;

export class TuiStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TuiStartupError";
  }
}

export function currentTuiSession(): LearnTuiSession | undefined {
  return activeSession;
}

export async function withTuiSession<T>(operation: () => Promise<T>, title?: string): Promise<T> {
  if (activeSession) return operation();
  let session: LearnTuiSession;
  try {
    session = await LearnTuiSession.create(title);
  } catch (error) {
    throw new TuiStartupError((error as Error).message, { cause: error });
  }
  activeSession = session;
  setOutputSink((line) => session.appendText(line));
  let result: T;
  try {
    result = await operation();
  } finally {
    setOutputSink(undefined);
    activeSession = undefined;
    await session.destroy();
  }
  const postExitMessage = session.getPostExitMessage();
  if (postExitMessage) process.stdout.write(`\n${postExitMessage}\n`);
  return result;
}
