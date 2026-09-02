import { describe, expect, it } from "bun:test";
import {
  checkDependencies,
  isImmutableLinux,
  pipInstallCommand,
  pythonCandidates,
  pythonRuntimeInstallPlan,
  systemDependencyInstallPlan,
  withPythonRuntime,
  type PythonRuntime,
} from "../src/dependencies";

const PYTHON: PythonRuntime = { command: ["python3"], display: "python3" };

describe("Python dependency runtime", () => {
  it("builds explicit first-time Python installation plans", () => {
    expect(pythonRuntimeInstallPlan("win32", (name) => name === "winget" ? "winget.exe" : undefined)?.commands[0])
      .toContain("Python.Python.3.13");
    expect(pythonRuntimeInstallPlan("darwin", (name) => name === "brew" ? "/opt/homebrew/bin/brew" : undefined))
      .toEqual({ label: "Homebrew", commands: [["brew", "install", "python"]] });
  });

  it("prefers the native launcher order on each platform", () => {
    expect(pythonCandidates("linux", undefined)).toEqual([["python3"], ["python"]]);
    expect(pythonCandidates("darwin", undefined)).toEqual([["python3"], ["python"]]);
    expect(pythonCandidates("win32", undefined)).toEqual([["py", "-3"], ["python3"], ["python"]]);
  });

  it("honors an explicit interpreter override", () => {
    expect(pythonCandidates("linux", "/opt/class python/bin/python")).toEqual([
      ["/opt/class python/bin/python"],
    ]);
  });

  it("rewrites authored Python commands without touching other commands", () => {
    const windows = { command: ["py", "-3"], display: "py -3" };
    expect(withPythonRuntime(["python3", "main.py"], windows)).toEqual(["py", "-3", "main.py"]);
    expect(withPythonRuntime(["java", "Main.java"], windows)).toEqual(["java", "Main.java"]);
  });

  it("installs into a venv normally and into the user site with --target", () => {
    expect(pipInstallCommand(PYTHON, { venv: true, enabled: false, userSite: "" }, ["pygame", "Pillow"]))
      .toEqual(["python3", "-m", "pip", "install", "--upgrade", "pygame", "Pillow"]);
    expect(pipInstallCommand(PYTHON, {
      venv: false,
      enabled: true,
      userSite: "/home/student/My Packages",
    }, ["pygame", "Pillow"])).toEqual([
      "python3", "-m", "pip", "install", "--upgrade", "--target",
      "/home/student/My Packages", "pygame", "Pillow",
    ]);
  });

  it("distinguishes distribution names from import module names", () => {
    const report = checkDependencies([
      { kind: "python-package", package: "PythonStdlib", module: "json" },
      { kind: "python-package", package: "DefinitelyMissing", module: "aifirst_module_that_does_not_exist" },
    ]);
    expect(report.dependencies[0]?.available).toBe(true);
    expect(report.dependencies[1]?.available).toBe(false);
    expect(report.missing.map((dependency) => dependency.package)).toEqual(["DefinitelyMissing"]);
  });
});

describe("system command dependencies", () => {
  const maven = [{ kind: "system-command" as const, package: "Maven", command: "mvn" }];

  it("detects both the ostree boot marker and rpm-ostree command", () => {
    expect(isImmutableLinux("linux", () => undefined, (path) => path === "/run/ostree-booted")).toBe(true);
    expect(isImmutableLinux("linux", (name) => name === "rpm-ostree" ? "/usr/bin/rpm-ostree" : undefined, () => false)).toBe(true);
    expect(isImmutableLinux("linux", () => undefined, () => false)).toBe(false);
    expect(isImmutableLinux("darwin", (name) => name === "rpm-ostree" ? "rpm-ostree" : undefined, () => true)).toBe(false);
  });

  it("builds native Maven installation plans", () => {
    expect(systemDependencyInstallPlan(maven, "darwin", (name) => name === "brew" ? "/opt/homebrew/bin/brew" : undefined))
      .toEqual({ label: "Homebrew", commands: [["brew", "install", "maven"]] });
    expect(systemDependencyInstallPlan(maven, "win32", (name) => name === "winget" ? "winget.exe" : undefined)?.commands[0])
      .toContain("Apache.Maven");
    const apt = systemDependencyInstallPlan(maven, "linux", (name) =>
      name === "apt-get" ? "/usr/bin/apt-get" : name === "sudo" ? "/usr/bin/sudo" : undefined);
    expect(apt?.label).toBe("APT");
    expect(apt?.commands.at(-1)?.slice(-3)).toEqual(["install", "-y", "maven"]);
  });

  it("uses Homebrew instead of dnf on rpm-ostree systems", () => {
    const which = (name: string) => ({
      brew: "/home/linuxbrew/.linuxbrew/bin/brew",
      dnf: "/usr/bin/dnf",
      sudo: "/usr/bin/sudo",
    })[name];
    expect(systemDependencyInstallPlan(
      maven,
      "linux",
      which,
      (path) => path === "/run/ostree-booted",
    )).toEqual({
      label: "Homebrew (immutable Linux)",
      commands: [["/home/linuxbrew/.linuxbrew/bin/brew", "install", "maven"]],
    });
  });

  it("does not fall through to dnf when immutable Linux lacks Homebrew", () => {
    expect(systemDependencyInstallPlan(
      maven,
      "linux",
      (name) => name === "dnf" ? "/usr/bin/dnf" : name === "sudo" ? "/usr/bin/sudo" : undefined,
      (path) => path === "/run/ostree-booted",
    )).toBeUndefined();
  });

  it("reports command availability independently of Python", () => {
    const available = checkDependencies([{ kind: "system-command", package: "Shell", command: "sh" }], undefined);
    const missing = checkDependencies([{ kind: "system-command", package: "Missing", command: "aifirst_missing_tool" }], undefined);
    expect(available.missing).toEqual([]);
    expect(missing.missing.map((dependency) => dependency.package)).toEqual(["Missing"]);
    expect(missing.error).toBeUndefined();
  });
});
