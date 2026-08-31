/** Real-Claude Showtail captures replayed through `aifirst learn`. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalAuthorEvents,
  canonicalLearnEvents,
  firstEventDifference,
} from "../scripts/lib/claude-e2e-oracle";
import { CLAUDE_E2E_SCENARIOS } from "../scripts/lib/claude-e2e-scenarios";

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const contentRepo =
  process.env.AIFIRST_CONTENT_REPO ??
  join(import.meta.dir, "..", "..", "aifirstcontent");
const fixtureRoot = join(
  contentRepo,
  "test",
  "fixtures",
  "claude-showtail-e2e",
);
const claude = Bun.which("claude");
const fixturesAvailable = CLAUDE_E2E_SCENARIOS.every((scenario) =>
  existsSync(join(fixtureRoot, scenario.id, "capture.json")),
);
const liveAvailable =
  fixturesAvailable && Boolean(claude && process.env.AIFIRST_CLAUDE_E2E === "1");

if (!liveAvailable)
  console.warn(
    "claude-showtail-scenarios-e2e: set AIFIRST_CLAUDE_E2E=1 with Claude and the sibling fixtures to run live replay.",
  );

const describeFixtures = fixturesAvailable ? describe : describe.skip;
const describeLive = liveAvailable ? describe : describe.skip;

function paths(scenario: (typeof CLAUDE_E2E_SCENARIOS)[number]): string[] {
  return [...new Set(scenario.turns.flatMap((turn) => turn.expectedFiles))];
}

describeFixtures("committed Claude Showtail scenario oracles", () => {
  for (const scenario of CLAUDE_E2E_SCENARIOS) {
    test(`${scenario.id} keeps author and learning events identical`, () => {
      const fixture = join(fixtureRoot, scenario.id);
      const report = JSON.parse(
        readFileSync(join(fixture, "bundle", "report.json"), "utf8"),
      );
      const book = JSON.parse(
        readFileSync(
          join(fixture, "generated", "books", `${scenario.id}.json`),
          "utf8",
        ),
      );
      const derived = canonicalAuthorEvents(report, book, paths(scenario));
      const author = JSON.parse(
        readFileSync(join(fixture, "oracle", "author-events.json"), "utf8"),
      );
      const learn = JSON.parse(
        readFileSync(join(fixture, "oracle", "learn-events.json"), "utf8"),
      );
      expect(derived).toEqual(author);
      expect(learn, firstEventDifference(author, learn)).toEqual(author);
    });
  }
});

describeLive("live Claude Showtail scenarios through aifirst learn", () => {
  let root = "";
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  for (const scenario of CLAUDE_E2E_SCENARIOS) {
    test(`${scenario.id} reproduces canonical events and every source checkpoint`, async () => {
      root = mkdtempSync(join(tmpdir(), `aifirst-${scenario.id}-replay-`));
      const workspace = join(root, "workspace");
      const checkpoints = join(root, "checkpoints");
      const state = join(root, "state");
      mkdirSync(workspace, { recursive: true });
      const fixture = join(fixtureRoot, scenario.id);
      const capturePath = join(fixture, "capture.json");
      const capture = JSON.parse(readFileSync(capturePath, "utf8"));
      expect((await Bun.$`${claude!} --version`.text()).trim()).toBe(
        capture.claudeVersion,
      );
      const bookPath = join(
        fixture,
        "generated",
        "books",
        `${scenario.id}.json`,
      );
      const driver = join(
        import.meta.dir,
        "fixtures",
        "claude-e2e-replay-driver.py",
      );
      const proc = Bun.spawn(
        [
          "python3",
          driver,
          process.execPath,
          ENTRY,
          workspace,
          capturePath,
          bookPath,
          checkpoints,
        ],
        {
          cwd: workspace,
          env: {
            ...process.env,
            AIFIRST_CONTENT_DIR: dirname(bookPath),
            AIFIRST_STATE_DIR: state,
            AIFIRST_LEARN_CHARS_PER_SECOND: "100000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-16000)}`).toBe(0);

      const book = JSON.parse(readFileSync(bookPath, "utf8"));
      const expected = JSON.parse(
        readFileSync(join(fixture, "oracle", "author-events.json"), "utf8"),
      );
      const actual = canonicalLearnEvents(stdout, book, paths(scenario));
      expect(actual, firstEventDifference(expected, actual)).toEqual(expected);

      capture.turns.forEach((turn: any, index: number) => {
        const number = String(index + 1).padStart(2, "0");
        for (const path of turn.expectedFiles) {
          expect(
            readFileSync(
              join(checkpoints, "oracle", "learn-turns", number, "source", path),
            ),
            `${number}/${path}`,
          ).toEqual(
            readFileSync(
              join(fixture, "bundle", "turns", number, "source", path),
            ),
          );
        }
      });

      for (const command of scenario.verification) {
        const result = Bun.spawnSync(command, {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
      }
    }, 360_000);
  }
});
