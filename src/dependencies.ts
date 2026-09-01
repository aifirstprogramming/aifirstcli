import type { Dependency } from "./content/types";

const PYTHON_CHECK = "import sys; raise SystemExit(0 if sys.version_info.major == 3 else 1)";
const IMPORT_CHECK = "import importlib,sys; importlib.import_module(sys.argv[1])";
const TARGET_CHECK =
  "import json,site,sys; print(json.dumps({" +
  "'venv': sys.prefix != sys.base_prefix," +
  "'enabled': site.ENABLE_USER_SITE," +
  "'userSite': site.getusersitepackages()}))";

export interface PythonRuntime {
  command: string[];
  display: string;
}

export interface DependencyStatus {
  dependency: Dependency;
  available: boolean;
}

export interface DependencyReport {
  dependencies: DependencyStatus[];
  missing: Dependency[];
  runtime?: PythonRuntime;
  installTarget?: string;
  error?: string;
}

export interface DependencyInstallResult {
  ok: boolean;
  report: DependencyReport;
  output: string;
  command?: string[];
}

export interface PythonInstallLocation {
  venv: boolean;
  enabled: boolean;
  userSite: string;
}

export interface RuntimeInstallPlan {
  label: string;
  commands: string[][];
}

function decode(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value) : "";
}

function spawnSync(argv: string[], env: Record<string, string | undefined> = process.env): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  try {
    const result = Bun.spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe", env });
    return { ok: result.exitCode === 0, stdout: decode(result.stdout), stderr: decode(result.stderr) };
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message };
  }
}

async function spawn(argv: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { ok: proc.exitCode === 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    return { ok: false, output: (error as Error).message };
  }
}

export function pythonCandidates(
  platform = process.platform,
  override = process.env.AIFIRST_PYTHON,
): string[][] {
  if (override) return [[override]];
  return platform === "win32"
    ? [["py", "-3"], ["python3"], ["python"]]
    : [["python3"], ["python"]];
}

export function resolvePythonRuntime(): PythonRuntime | undefined {
  for (const command of pythonCandidates()) {
    if (spawnSync([...command, "-c", PYTHON_CHECK]).ok) {
      return { command, display: command.join(" ") };
    }
  }
  return undefined;
}

/** A conservative OS package-manager plan for first-time Python installation. */
export function pythonRuntimeInstallPlan(
  platform = process.platform,
  which: (name: string) => string | undefined = (name) => Bun.which(name) ?? undefined,
): RuntimeInstallPlan | undefined {
  if (platform === "win32" && which("winget")) {
    return {
      label: "Windows Package Manager (winget)",
      commands: [["winget", "install", "--exact", "--id", "Python.Python.3.13", "--accept-package-agreements", "--accept-source-agreements"]],
    };
  }
  if (platform === "darwin" && which("brew")) {
    return { label: "Homebrew", commands: [["brew", "install", "python"]] };
  }
  if (platform === "linux" && which("apt-get")) {
    const prefix = elevatedPrefix(which, "sudo");
    if (!prefix) return undefined;
    return {
      label: "APT",
      commands: [
        [...prefix, "apt-get", "update"],
        [...prefix, "apt-get", "install", "-y", "python3", "python3-pip", "python3-venv"],
      ],
    };
  }
  if (platform === "linux" && which("dnf")) {
    const prefix = elevatedPrefix(which, "sudo");
    if (!prefix) return undefined;
    return { label: "DNF", commands: [[...prefix, "dnf", "install", "-y", "python3", "python3-pip"]] };
  }
  if (platform === "linux" && which("apk")) {
    const prefix = elevatedPrefix(which, "doas");
    if (!prefix) return undefined;
    return { label: "Alpine apk", commands: [[...prefix, "apk", "add", "python3", "py3-pip"]] };
  }
  return undefined;
}

function elevatedPrefix(
  which: (name: string) => string | undefined,
  helper: "sudo" | "doas",
): string[] | undefined {
  if (typeof process.getuid !== "function" || process.getuid() === 0) return [];
  return which(helper) ? [helper] : undefined;
}

export async function installPythonRuntime(
  plan: RuntimeInstallPlan,
): Promise<{ ok: boolean; output: string; runtime?: PythonRuntime }> {
  const output: string[] = [];
  for (const command of plan.commands) {
    const result = await spawn(command);
    if (result.output) output.push(result.output);
    if (!result.ok) return { ok: false, output: output.join("\n") };
  }
  const runtime = resolvePythonRuntime();
  return { ok: Boolean(runtime), output: output.join("\n"), ...(runtime ? { runtime } : {}) };
}

export function pythonArgv(runtime: PythonRuntime, ...args: string[]): string[] {
  return [...runtime.command, ...args];
}

/** Replace authored Python launchers with the interpreter selected on this machine. */
export function withPythonRuntime(argv: string[], runtime: PythonRuntime): string[] {
  return argv[0] === "python3" || argv[0] === "python"
    ? [...runtime.command, ...argv.slice(1)]
    : argv;
}

function pythonEnvironment(): Record<string, string | undefined> {
  return { ...process.env, PYGAME_HIDE_SUPPORT_PROMPT: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

function importAvailable(runtime: PythonRuntime, module: string): boolean {
  return spawnSync(pythonArgv(runtime, "-c", IMPORT_CHECK, module), pythonEnvironment()).ok;
}

function installLocation(runtime: PythonRuntime): PythonInstallLocation | undefined {
  const result = spawnSync(pythonArgv(runtime, "-c", TARGET_CHECK));
  if (!result.ok) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as PythonInstallLocation;
  } catch {
    return undefined;
  }
}

export function checkDependencies(
  dependencies: Dependency[] | undefined,
  runtime = resolvePythonRuntime(),
): DependencyReport {
  const declared = dependencies ?? [];
  if (declared.length === 0) return { dependencies: [], missing: [] };
  if (!runtime) {
    return {
      dependencies: declared.map((dependency) => ({ dependency, available: false })),
      missing: declared,
      error: "Python 3 is not installed or not on PATH.",
    };
  }

  const statuses = declared.map((dependency) => ({
    dependency,
    available: dependency.kind === "python-package" && importAvailable(runtime, dependency.module),
  }));
  const location = installLocation(runtime);
  return {
    dependencies: statuses,
    missing: statuses.filter((status) => !status.available).map((status) => status.dependency),
    runtime,
    ...(location ? { installTarget: location.venv ? runtime.display : location.userSite } : {}),
  };
}

function uniquePackages(dependencies: Dependency[]): string[] {
  return [...new Set(dependencies.map((dependency) => dependency.package))];
}

export function pipInstallCommand(
  runtime: PythonRuntime,
  location: PythonInstallLocation,
  packages: string[],
): string[] {
  return location.venv
    ? pythonArgv(runtime, "-m", "pip", "install", "--upgrade", ...packages)
    : pythonArgv(runtime, "-m", "pip", "install", "--upgrade", "--target", location.userSite, ...packages);
}

export async function installDependencies(
  dependencies: Dependency[] | undefined,
  runtime = resolvePythonRuntime(),
): Promise<DependencyInstallResult> {
  const before = checkDependencies(dependencies, runtime);
  if (before.missing.length === 0) return { ok: true, report: before, output: "" };
  if (!runtime) return { ok: false, report: before, output: before.error ?? "Python 3 is unavailable." };

  const location = installLocation(runtime);
  if (!location) {
    return { ok: false, report: before, output: `Could not determine the install target for ${runtime.display}.` };
  }
  if (!location.venv && (!location.enabled || !location.userSite)) {
    return {
      ok: false,
      report: before,
      output: `${runtime.display} has no enabled user package site. Activate a virtual environment and retry.`,
    };
  }

  const output: string[] = [];
  const pipCheck = spawnSync(pythonArgv(runtime, "-m", "pip", "--version"));
  if (!pipCheck.ok) {
    const ensureArgs = pythonArgv(runtime, "-m", "ensurepip", "--upgrade", ...(location.venv ? [] : ["--user"]));
    const ensured = await spawn(ensureArgs);
    if (ensured.output) output.push(ensured.output);
    if (!ensured.ok) {
      return { ok: false, report: before, output: output.join("\n") || "pip is unavailable." };
    }
  }

  const packages = uniquePackages(before.missing);
  const command = pipInstallCommand(runtime, location, packages);
  const installed = await spawn(command);
  if (installed.output) output.push(installed.output);
  const after = checkDependencies(dependencies, runtime);
  return {
    ok: installed.ok && after.missing.length === 0,
    report: after,
    output: output.join("\n"),
    command,
  };
}

export function dependencyNames(dependencies: Dependency[] | undefined): string {
  return (dependencies ?? []).map((dependency) => dependency.package).join(", ");
}
