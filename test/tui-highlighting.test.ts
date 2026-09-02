import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syntaxHighlights } from "../src/tui/highlighting";

const suite = process.platform === "win32" ? describe.skip : describe;
const DRIVER = join(import.meta.dir, "fixtures", "native-tui-driver.py");
const HIGHLIGHT_DRIVER = join(import.meta.dir, "fixtures", "tui-highlight-driver.ts");

describe("OpenTUI syntax highlighting", () => {
  test("produces semantic Python highlights", () => {
    const source = 'from pathlib import Path\n# note\ncount = 3\nprint("duck")\n';
    const highlights = syntaxHighlights(source, "python");
    const groups = highlights.map((highlight) => highlight[2]);

    expect(groups).toContain("keyword");
    expect(groups).toContain("comment");
    expect(groups).toContain("number");
    expect(groups).toContain("string");
    expect(groups).toContain("function.builtin");
  });

  test("produces semantic Java highlights", () => {
    const source = 'public class Duck { String name = "Pip"; int age = 2; }';
    const highlights = syntaxHighlights(source, "java");
    const groups = highlights.map((highlight) => highlight[2]);

    expect(groups).toContain("keyword");
    expect(groups).toContain("type");
    expect(groups).toContain("variable");
    expect(groups).toContain("string");
    expect(groups).toContain("number");
  });

  test("uses the same semantic spans for diff source languages", () => {
    expect(syntaxHighlights('def greet():\n    return "hi"\n', "py").length).toBeGreaterThan(2);
    expect(syntaxHighlights('public int answer() { return 42; }', "java").length).toBeGreaterThan(2);
    expect(syntaxHighlights("plain text", "text")).toEqual([]);
  });

  test("adds XML and Maven-specific semantic scopes for pom.xml", () => {
    const pom = [
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      "  <groupId>com.example</groupId>",
      "  <artifactId>pocket-cfo</artifactId>",
      "  <version>${project.version}</version>",
      "</project>",
    ].join("\n");
    const mavenGroups = syntaxHighlights(pom, "maven").map((highlight) => highlight[2]);
    const xmlGroups = syntaxHighlights(pom, "xml").map((highlight) => highlight[2]);
    expect(mavenGroups).toContain("tag");
    expect(mavenGroups).toContain("tag.punctuation");
    expect(mavenGroups).toContain("property");
    expect(mavenGroups).toContain("string");
    expect(mavenGroups).toContain("maven.coordinate");
    expect(mavenGroups).toContain("maven.property");
    expect(xmlGroups).not.toContain("maven.coordinate");
    expect(xmlGroups).not.toContain("maven.property");
  });
});

suite("rendered OpenTUI syntax colors", () => {
  test("applies semantic colors to code and diff renderables", async () => {
    const root = mkdtempSync(join(tmpdir(), "aifirst-tui-highlight-"));
    const scenario = join(root, "scenario.json");
    writeFileSync(scenario, JSON.stringify({
      columns: 100,
      rows: 30,
      timeoutSeconds: 10,
      actions: [{ wait: "HIGHLIGHT_DONE" }],
    }));
    const proc = Bun.spawn(["python3", DRIVER, scenario, process.execPath, "run", HIGHLIGHT_DRIVER], {
      cwd: root,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "", AIFIRST_TUI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    try {
      expect(proc.exitCode, `${stderr}\n${stdout.slice(-12_000)}`).toBe(0);
      expect(stdout).toMatch(/\x1b\[(?:38;5;177|38;2;217;119;255)m/);
      expect(stdout).toMatch(/\x1b\[(?:38;5;78|38;2;99;210;151)m/);
      expect(stdout).toMatch(/\x1b\[(?:38;5;221|38;2;241;199;91)m/);
      expect(stdout).toMatch(/\x1b\[48;5;236m/);
      expect(stdout).toMatch(/\x1b\[48;5;235m/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
