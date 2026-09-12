import type { Step } from "./content/types";

/** Return an explicitly authored Maven JavaFX launcher. */
export function mavenJavaFxCommand(step: Step): string[] | undefined {
  if (step.execution.launch?.surface !== "external") return undefined;
  return step.execution.commands?.find(
    (command) => command[0] === "mvn" && command.includes("javafx:run"),
  );
}
