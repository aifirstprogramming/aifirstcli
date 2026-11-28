/**
 * Learn -> compact replay verification that opens a program window.
 *
 * PocketCFO (java-11-01, java-11-02) verifies by running the tests and then
 * opening the finished JavaFX app once. `mvn javafx:run` only returns when the
 * reader closes that window, so the "Running verification" panel must say so —
 * otherwise it looks hung while the app sits open in another window.
 *
 * These drive the real `aifirst learn` TUI through a PTY at 80x24 with a fake
 * Maven on PATH, so no JDK, Maven or display server is needed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContent } from "../src/content";

const suite = process.platform === "win32" ? describe.skip : describe;
const linuxOnly = process.platform === "linux" ? test : test.skip;
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const GUIDANCE = "When the program window opens, close it to return to Learn.";
const SCENARIO_TIMEOUT_SECONDS = 45;

// Polls for the close file at most 600 times (~60s), so even an orphaned fake
// gives up on its own. It does not trap signals.
const FAKE_MVN = `#!/bin/sh
dir="$(cd "$(dirname "$0")/.." && pwd)"
case " $* " in
  *" javafx:run "*)
    echo $$ > "$dir/mvn.pid.tmp" && mv "$dir/mvn.pid.tmp" "$dir/mvn.pid"
    echo $PPID > "$dir/replay.pid.tmp" && mv "$dir/replay.pid.tmp" "$dir/replay.pid"
    i=0
    while [ ! -f "$dir/close" ]; do
      i=$((i + 1))
      if [ "$i" -gt 600 ]; then exit 3; fi
      sleep 0.1
    done
    : > "$dir/closed"
    exit 0
    ;;
  *) exit 0 ;;
esac
`;

interface Fixture {
  root: string;
  state: string;
  workspace: string;
}

let fixture: Fixture | undefined;

function makeFixture(): Fixture {
  // realpath: macOS reports /private/var/... for /var/... temp paths in ps.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aifirst-learn-verify-")));
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  for (const dir of [state, workspace, bin, join(root, "home")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "mvn"), FAKE_MVN);
  chmodSync(join(bin, "mvn"), 0o755);
  const book = resolveContent().content.books.find((candidate) => candidate.tag === "java")!;
  writeFileSync(join(state, "config.json"), JSON.stringify({
    version: 1,
    book: book.id,
    workspaces: { java: workspace },
  }));
  return { root, state, workspace };
}

function readPid(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessInfo {
  ppid: number;
  pgid: number;
  command: string;
}

function processInfo(pid: number): ProcessInfo | undefined {
  if (!alive(pid)) return undefined;
  const listed = Bun.spawnSync(["ps", "-o", "ppid=,pgid=,command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString().trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
  return listed ? { ppid: Number(listed[1]), pgid: Number(listed[2]), command: listed[3] } : undefined;
}

/** This fixture's fake Maven, proven by the fixture's unique path in its command. */
function ownedMaven(root: string): { pid: number; info: ProcessInfo } | undefined {
  const pid = readPid(join(root, "mvn.pid"));
  const info = pid === undefined ? undefined : processInfo(pid);
  return pid !== undefined && info?.command.includes(join(root, "bin", "mvn")) ? { pid, info } : undefined;
}

/**
 * The detached `aifirst replay execute` process group, proven only through this
 * fixture's live fake Maven: the recorded replay PID must be that Maven's parent
 * and the leader of the group it runs in. Generic argv is never enough to
 * signal a whole group.
 */
function ownedReplayGroup(root: string): number | undefined {
  const maven = ownedMaven(root);
  const replay = readPid(join(root, "replay.pid"));
  if (!maven || replay === undefined) return undefined;
  if (maven.info.ppid !== replay || maven.info.pgid !== replay) return undefined;
  return processInfo(replay)?.pgid === replay ? replay : undefined;
}

function stopOwnedProcesses(root: string): void {
  const group = ownedReplayGroup(root);
  if (group !== undefined) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone between the ownership check and the signal.
    }
  }
  const maven = ownedMaven(root);
  if (maven) {
    try {
      process.kill(maven.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

interface PidSnapshot {
  pid: number | null;
  alive: boolean;
  ppid?: number;
  pgid?: number;
  command?: string;
}

/** Gone, or the PID now belongs to some other process than the one snapshotted. */
function goneSince(snapshot: PidSnapshot): boolean {
  if (snapshot.pid === null) return true;
  const now = processInfo(snapshot.pid);
  return now === undefined || now.command !== snapshot.command;
}

async function allGoneWithin(snapshots: PidSnapshot[], withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (snapshots.every(goneSince)) return true;
    await Bun.sleep(100);
  }
  return snapshots.every(goneSince);
}

afterEach(() => {
  if (!fixture) return;
  stopOwnedProcesses(fixture.root);
  rmSync(fixture.root, { recursive: true, force: true });
  fixture = undefined;
});

interface DriverRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runLearn(
  current: Fixture,
  actions: Array<Record<string, unknown>>,
  display: "available" | "headless",
): Promise<DriverRun> {
  const scenario = join(current.root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({
    columns: 80,
    rows: 24,
    timeoutSeconds: SCENARIO_TIMEOUT_SECONDS,
    actions,
  }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${join(current.root, "bin")}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    NO_COLOR: "",
    AIFIRST_TUI: "1",
    AIFIRST_STATE_DIR: current.state,
    AIFIRST_HOME_OVERRIDE: join(current.root, "home"),
    AIFIRST_LEARN_CHARS_PER_SECOND: "0",
  };
  if (display === "headless") {
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
  } else if (process.platform === "linux") {
    // No X server is needed: the fake Maven never opens a real window.
    env.DISPLAY = ":99";
  }
  const proc = Bun.spawn(
    ["python3", DRIVER, scenario, process.execPath, "run", ENTRY, "learn", "--no-animation"],
    { cwd: current.root, env, stdout: "pipe", stderr: "pipe" },
  );
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    proc.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), (SCENARIO_TIMEOUT_SECONDS + 10) * 1000);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!finished) {
    proc.kill("SIGKILL");
    await proc.exited;
  }
  const [stdout, stderr] = await output;
  return { stdout, stderr, exitCode: proc.exitCode };
}

/** Start java-11-02 and wait until the replay has reached the fake program window. */
function openJava1102(current: Fixture, atWindow: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return [
    { wait: "What would you like to do?", paste: "java-11-02", enter: true },
    { wait: "Running verification" },
    // The fake writes replay.pid after mvn.pid, so both are recorded once it exists.
    { wait: "", waitFile: join(current.root, "replay.pid"), ...atWindow },
  ];
}

// OSC sequences end at the first BEL *or* ESC-backslash. Stopping only at a BEL
// would swallow screen text up to some much later BEL in a complete capture.
const visible = (stdout: string) =>
  stdout.replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\|_[^\x1b]*\x1b\\|\[[0-?]*[ -/]*[@-~])/g, "").replace(/\s+/g, "");
const squash = (text: string) => text.replace(/\s+/g, "");

suite("Learn verification that opens a program window", () => {
  test("tells the reader to close the window, then finishes once it closes", async () => {
    const current = (fixture = makeFixture());
    const run = await runLearn(current, [
      ...openJava1102(current),
      { wait: GUIDANCE, touch: join(current.root, "close") },
      { wait: "Lesson complete", down: 3, enter: true },
    ], "available");
    const diagnostics = `${run.stderr}\n${visible(run.stdout).slice(-4_000)}`;

    // The replay reached the graphical stage…
    expect(existsSync(join(current.root, "mvn.pid")), diagnostics).toBe(true);
    // …and told the reader what to do while it waited there.
    const shown = visible(run.stdout);
    expect(shown.indexOf(squash(GUIDANCE)), diagnostics).toBeGreaterThanOrEqual(0);
    expect(shown.indexOf(squash(GUIDANCE))).toBeLessThan(shown.indexOf(squash("Lesson complete")));
    // Verification finished only because the "window" was closed.
    expect(existsSync(join(current.root, "closed")), diagnostics).toBe(true);
    expect(run.exitCode, diagnostics).toBe(0);
    expect(run.stdout.match(/\x1b\[\?1049h/g)?.length).toBe(1);
    expect(run.stdout.match(/\x1b\[\?1049l/g)?.length).toBe(1);
    const progress = JSON.parse(readFileSync(join(current.state, "progress.json"), "utf8"));
    expect(progress.exercises["java-11-02"].status).toBe("done");
  }, 90_000);

  for (const [name, key] of [["Esc", { escape: true }], ["Ctrl+C", { ctrlC: true }]] as const) {
    test(`${name} stops the verification and the program it opened`, async () => {
      const current = (fixture = makeFixture());
      const report = join(current.root, "before-key.json");
      const run = await runLearn(current, [
        ...openJava1102(current, {
          settleSeconds: 0.5,
          snapshotPids: { maven: join(current.root, "mvn.pid"), replay: join(current.root, "replay.pid") },
          snapshotReport: report,
          ...key,
        }),
        { wait: "Lesson paused", down: 3, enter: true },
      ], "available");
      const diagnostics = `${run.stderr}\n${visible(run.stdout).slice(-4_000)}`;

      // Immediately before the key was sent, both processes were recorded and
      // alive, and the replay was provably this fixture's: the parent and group
      // leader of the fake Maven running from this fixture's own bin directory.
      expect(existsSync(report), diagnostics).toBe(true);
      const before = JSON.parse(readFileSync(report, "utf8")) as { maven: PidSnapshot; replay: PidSnapshot };
      expect(before.maven.alive, JSON.stringify(before)).toBe(true);
      expect(before.replay.alive, JSON.stringify(before)).toBe(true);
      expect(before.maven.command).toContain(join(current.root, "bin", "mvn"));
      expect(before.maven.ppid).toBe(before.replay.pid!);
      expect(before.maven.pgid).toBe(before.replay.pid!);
      expect(before.replay.pgid).toBe(before.replay.pid!);

      expect(run.exitCode, diagnostics).toBe(0);
      expect(await allGoneWithin([before.maven, before.replay], 3_000)).toBe(true);
      expect(existsSync(join(current.root, "close"))).toBe(false);
      expect(existsSync(join(current.root, "closed"))).toBe(false);
      expect(run.stdout.match(/\x1b\[\?1049l/g)?.length).toBe(1);
    }, 90_000);
  }

  linuxOnly("headless Linux skips the window and shows no close guidance", async () => {
    const current = (fixture = makeFixture());
    const run = await runLearn(current, [
      { wait: "What would you like to do?", paste: "java-11-02", enter: true },
      { wait: "Lesson complete", down: 3, enter: true },
    ], "headless");
    const diagnostics = `${run.stderr}\n${visible(run.stdout).slice(-4_000)}`;

    expect(run.exitCode, diagnostics).toBe(0);
    expect(existsSync(join(current.root, "mvn.pid"))).toBe(false);
    expect(visible(run.stdout)).not.toContain(squash(GUIDANCE));
  }, 90_000);
});
