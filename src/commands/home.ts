import { spawn } from "node:child_process";
import type { Args } from "../cli";
import { detectAll } from "../agents";
import { resolveScope } from "../books";
import { ALL_BOOKS, setBook } from "../config";
import { resolveContent } from "../content";
import { report } from "../exercises";
import { read as readLog } from "../log/progress";
import { bold, cyan, dim, glyph, green, out } from "../output";
import { choose, isInteractive, pauseForEnter } from "../prompt";
import { help } from "./help";
import { nativeLearn } from "../learn/native";
import { progress } from "./progress";
import { currentTuiSession } from "../tui/session";
import { runWithTui, shouldUseTui } from "../tui";
import { ensureWorkspace } from "../workspace";

interface Destination {
  key: string;
  label: string;
  command: string;
  args: string[];
}

export async function home(args: Args): Promise<void> {
  if (shouldUseTui(args) && !currentTuiSession()) {
    return runWithTui(args, () => home(args), "AI First Home");
  }
  if (!isInteractive()) {
    help();
    return;
  }

  while (true) {
    const { content } = resolveContent();
    let scope = resolveScope(content);
    if (scope.kind === "unset") {
      const picked = await choose("Which book are you reading?", [
        ...content.books.map((book) => ({ key: book.tag, label: book.title })),
        { key: ALL_BOOKS, label: "All books" },
      ]);
      if (!picked) return;
      if (picked === ALL_BOOKS) setBook(ALL_BOOKS);
      else setBook(content.books.find((book) => book.tag === picked)!.id);
      scope = resolveScope(content);
    }

    const workspaceKey = scope.kind === "book" ? scope.book.tag : ALL_BOOKS;
    const workspace = ensureWorkspace(content, workspaceKey).path;

    const log = readLog();
    const counts = report(content, log, scope).overall;
    const detected = await detectAll();
    const destinations = launchDestinations(detected.map((item) => item.agent.key));

    out();
    out(`  ${bold("AI First home")}`);
    out();
    out(`  ${green(glyph.done)} book       ${scope.kind === "book" ? scope.book.title : "All books"}`);
    out(`  ${green(glyph.done)} workspace  ${dim(workspace)}`);
    out(`  ${green(glyph.done)} learner    built in; no AI account or model required`);
    out(`  ${counts.done > 0 ? green(glyph.done) : dim(glyph.todo)} first lesson  ${counts.done > 0 ? `${counts.done} completed` : "ready to start"}`);
    out(`  ${destinations.length > 0 ? green(glyph.done) : dim(glyph.todo)} AI assistant ${destinations.length > 0 ? `${destinations.length} available` : "optional"}`);

    const choices = [
      { key: "learn", label: "Start or continue built-in learning (recommended)" },
      ...destinations.map((destination) => ({ key: destination.key, label: `Open ${destination.label}` })),
      { key: "progress", label: "View progress" },
      { key: "book", label: "Change book" },
      { key: "help", label: "Command reference" },
      { key: "exit", label: "Exit" },
    ];
    const picked = await choose("What would you like to do?", choices);
    if (!picked || picked === "exit") return;
    if (picked === "learn") {
      await nativeLearn(args);
      return;
    }
    if (picked === "book") {
      const selected = await choose("Choose a book", [
        ...content.books.map((book) => ({ key: book.tag, label: book.title })),
        { key: ALL_BOOKS, label: "All books" },
      ]);
      if (selected === ALL_BOOKS) setBook(ALL_BOOKS);
      else if (selected) setBook(content.books.find((book) => book.tag === selected)!.id);
      continue;
    }
    if (picked === "progress") {
      currentTuiSession()?.clearTranscript();
      progress({ command: "progress", positionals: [], flags: new Map() });
      await pauseForEnter("Press Enter to return Home");
      currentTuiSession()?.clearTranscript();
      continue;
    }
    if (picked === "help") {
      currentTuiSession()?.clearTranscript();
      help();
      await pauseForEnter("Press Enter to return Home");
      currentTuiSession()?.clearTranscript();
      continue;
    }
    const destination = destinations.find((candidate) => candidate.key === picked);
    if (destination) {
      const tui = currentTuiSession();
      if (tui) await tui.suspendDuring(() => launch(destination, workspace));
      else await launch(destination, workspace);
      return;
    }
  }
}

function launchDestinations(keys: string[]): Destination[] {
  const destinations: Destination[] = [];
  if (keys.includes("claude")) {
    const command = Bun.which("claude");
    if (command) destinations.push({
      key: "launch-claude",
      label: "Claude Code",
      command,
      args: ["Start my next AI First exercise."],
    });
  }
  if (keys.includes("codex")) {
    const command = Bun.which("codex");
    if (command) destinations.push({
      key: "launch-codex",
      label: "Codex",
      command,
      args: ["Start my next AI First exercise."],
    });
  }
  if (keys.includes("antigravity-cli")) {
    const command = Bun.which("agy");
    if (command) destinations.push({
      key: "launch-agy",
      label: "Antigravity CLI",
      command,
      args: ["--prompt-interactive", "Start my next AI First exercise."],
    });
  }
  if (keys.includes("vscode")) {
    for (const name of ["code", "code-insiders", "codium", "cursor"]) {
      const command = Bun.which(name);
      if (command) {
        destinations.push({ key: "launch-vscode", label: "VS Code", command, args: ["."] });
        break;
      }
    }
  }
  return destinations;
}

async function launch(destination: Destination, workspace: string): Promise<void> {
  out();
  out(`  ${cyan(glyph.arrow)} opening ${bold(destination.label)} in ${dim(workspace)}`);
  if (destination.key === "launch-vscode") {
    out(dim("  Open the AI First Books panel or its Getting Started walkthrough."));
  }
  out();
  const child = spawn(destination.command, destination.args, {
    cwd: workspace,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  process.exitCode = await new Promise<number>((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => done(code ?? 0));
  });
}
