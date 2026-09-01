import { resolve } from "@aifirst/content";
import type { Args } from "../cli";
import { boolFlag, formatFlag } from "../cli";
import type { DependencyReport } from "../dependencies";
import { checkDependencies, dependencyNames, installDependencies, resolvePythonRuntime } from "../dependencies";
import { resolveContent } from "../content";
import type { Example, Step } from "../content/types";
import { finalResponse } from "../exercises";
import { CliError, bold, dim, glyph, green, json, out, yellow } from "../output";
import type { Format } from "../output";
import { confirm, isInteractive } from "../prompt";

function dependencyDetails(example: Example, step: Step, report: DependencyReport, installCommand: string) {
  return {
    exerciseId: example.id,
    stepId: step.id,
    dependencies: report.dependencies,
    missing: report.missing,
    runtime: report.runtime ?? null,
    installTarget: report.installTarget ?? null,
    installCommand,
  };
}

export async function preflightDependencies(
  args: Args,
  example: Example,
  step: Step,
  format: Format,
  retryCommand: string,
): Promise<DependencyReport> {
  let report = checkDependencies(step.dependencies);
  if (example.language === "python" && !report.runtime) {
    const runtime = resolvePythonRuntime();
    if (runtime) report = { ...report, runtime };
  }
  if (example.language === "python" && !report.runtime) {
    throw new CliError(
      report.error ?? "Python 3 is not installed or not on PATH.",
      "missing_runtime",
      "Install Python 3, then retry the exercise.",
      dependencyDetails(example, step, report, retryCommand),
    );
  }
  if (report.missing.length === 0) return report;
  if (!report.runtime) {
    throw new CliError(
      report.error ?? `No supported runtime is available for ${step.id}.`,
      "missing_runtime",
      "Install the exercise runtime, then retry.",
      dependencyDetails(example, step, report, retryCommand),
    );
  }

  const names = dependencyNames(report.missing);
  const manual = `aifirst dependencies install ${step.id} --yes`;
  if (!boolFlag(args, "yes")) {
    if (format === "json" || !isInteractive()) {
      throw new CliError(
        `${step.id} needs ${names}`,
        "missing_dependencies",
        `Approve installation, then run: ${retryCommand}`,
        dependencyDetails(example, step, report, retryCommand),
      );
    }

    out();
    out(`  ${yellow(glyph.todo)} ${bold(step.id)} needs ${names}`);
    out(dim(`  install target: ${report.installTarget ?? report.runtime.display}`));
    out();
    const accepted = await confirm(`Install ${names} now?`, `Run: ${manual}`);
    if (!accepted) {
      throw new CliError(
        "Dependency installation was cancelled; no exercise files were changed.",
        "dependency_install_cancelled",
        `Install later with: ${manual}`,
        dependencyDetails(example, step, report, retryCommand),
      );
    }
  }

  const installed = await installDependencies(step.dependencies, report.runtime);
  if (!installed.ok) {
    throw new CliError(
      `Could not install all dependencies for ${step.id}`,
      "dependency_install_failed",
      installed.output || `Install manually, then retry: ${retryCommand.replace(/ --yes\b/, "")}`,
      dependencyDetails(example, step, installed.report, retryCommand),
    );
  }
  if (format === "text") {
    out(`  ${green(glyph.done)} installed ${names}`);
    out();
  }
  return installed.report;
}

export async function dependencies(args: Args): Promise<void> {
  const format = formatFlag(args, ["text", "json"]);
  const install = args.positionals[0] === "install";
  const id = args.positionals[install ? 1 : 0];
  if (!id) {
    throw new CliError(
      "dependencies needs an exercise id",
      "missing_argument",
      "Try: aifirst dependencies py-10-01",
    );
  }

  const { content } = resolveContent();
  const hit = resolve(id, content);
  const example = hit.example;
  const step = hit.kind === "step" ? hit.step : finalResponse(example);
  const installCommand = `aifirst dependencies install ${step.id} --yes${format === "json" ? " --format json" : ""}`;
  const report = install
    ? await preflightDependencies(args, example, step, format, installCommand)
    : checkDependencies(step.dependencies);

  if (format === "json") {
    json({ ...dependencyDetails(example, step, report, installCommand), ok: report.missing.length === 0 });
    if (report.missing.length > 0) process.exitCode = 1;
    return;
  }

  out();
  out(`  ${bold(example.title)}  ${dim(step.id)}`);
  if (report.dependencies.length === 0) {
    out(dim("  no external dependencies"));
  } else {
    for (const status of report.dependencies) {
      out(`  ${status.available ? green(glyph.done) : yellow(glyph.todo)} ${status.dependency.package} ${dim(`(import ${status.dependency.module})`)}`);
    }
    if (report.runtime) out(dim(`  Python: ${report.runtime.display}`));
    if (report.installTarget) out(dim(`  install target: ${report.installTarget}`));
  }
  out();
  if (!install && report.missing.length > 0) out(dim(`  ${glyph.arrow} ${installCommand}`));
  if (!install && report.missing.length > 0) out();
}
