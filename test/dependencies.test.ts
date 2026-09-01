import { describe, expect, it } from "bun:test";
import {
  checkDependencies,
  pipInstallCommand,
  pythonCandidates,
  withPythonRuntime,
  type PythonRuntime,
} from "../src/dependencies";

const PYTHON: PythonRuntime = { command: ["python3"], display: "python3" };

describe("Python dependency runtime", () => {
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
