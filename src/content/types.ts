/**
 * Re-exports of the shared content types, so the rest of the CLI imports from
 * one place and the dependency on @aifirst/content stays visible at the seam.
 */

export type {
  Book,
  Chapter,
  Content,
  Example,
  Explanation,
  Language,
  RawBook,
  Scaffold,
  Section,
  Step,
} from "@aifirst/content";

/** Kept at the CLI seam so older installed content loaders can read newer packs. */
export interface PythonPackageDependency {
  kind: "python-package";
  package: string;
  module: string;
}

export interface SystemCommandDependency {
  kind: "system-command";
  package: string;
  command: string;
}

export type Dependency = PythonPackageDependency | SystemCommandDependency;

export interface ReplayToolDisplay {
  toolName: string;
  description?: string;
  command?: string;
}

interface ReplayOperationBase {
  display?: ReplayToolDisplay;
}

export type ReplayOperation =
  | (ReplayOperationBase & { type: "write"; path: string; content: string })
  | (ReplayOperationBase & { type: "edit"; path: string; oldText: string; newText: string; replaceAll?: boolean })
  | (ReplayOperationBase & { type: "read"; path: string })
  | {
      type: "command";
      display?: ReplayToolDisplay;
      portableCommand?: string[];
      command: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdin?: string;
      timeoutMs?: number;
      expectedTimeout?: boolean;
      readOnly?: boolean;
      expectedExitCode?: number;
      expectedStdout?: string;
      expectedStderr?: string;
    };

export type ReplayEvent =
  | { type: "text"; text: string }
  | { type: "status"; text: string; display?: ReplayToolDisplay }
  | { type: "operation"; operation: ReplayOperation };

export interface PlanOption {
  id: string;
  label: string;
  description: string;
}

export interface PlanQuestion {
  id: string;
  question: string;
  header: string;
  options: PlanOption[];
  group?: string;
  when?: Record<string, string>;
}

export interface PlanVariant {
  id: string;
  answers: Record<string, string>;
  plan: string;
  operations: ReplayOperation[];
  commentary?: string[];
  events?: ReplayEvent[];
}

export interface PlanInterlude {
  afterQuestion: string;
  events: ReplayEvent[];
}

export interface PlanWorkflow {
  questions: PlanQuestion[];
  canonicalAnswers: Record<string, string>;
  canonicalPlan: string;
  interludes?: PlanInterlude[];
  variants?: PlanVariant[];
}

export interface Replay {
  prompt?: string;
  initialState?: { fromExercise: string };
  operations: ReplayOperation[];
  commentary?: string[];
  prePlanEvents?: ReplayEvent[];
  events?: ReplayEvent[];
  completionText?: string;
  workflow?: PlanWorkflow;
  source?: {
    kind: "showtail";
    reportSha256: string;
    generatedAt: string;
    turnIndex: number;
    sessionId?: string;
  };
}

export type ReplayStep = import("@aifirst/content").Step & { replay?: Replay };

/** Runtime packs may contain dependency kinds newer than the installed type package. */
export function declaredDependencies(step: { dependencies?: unknown }): Dependency[] {
  return Array.isArray(step.dependencies) ? step.dependencies as Dependency[] : [];
}

export interface RawEntry {
  filename: string;
  book: import("@aifirst/content").RawBook;
}
