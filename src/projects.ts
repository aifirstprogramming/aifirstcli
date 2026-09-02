import type { Step } from "./content/types";

const JAVAFX_MAVEN_PLUGIN = "<artifactId>javafx-maven-plugin</artifactId>";

/** Return the authored launcher for Maven-based JavaFX projects. */
export function mavenJavaFxCommand(step: Step): string[] | undefined {
  if (step.language !== "java") return undefined;
  const pom = step.scaffold?.files.find((file) => file.path === "pom.xml");
  return typeof pom?.content === "string" && pom.content.includes(JAVAFX_MAVEN_PLUGIN)
    ? ["mvn", "javafx:run"]
    : undefined;
}
