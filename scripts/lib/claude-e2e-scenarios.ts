export interface ClaudeE2ETurnDefinition {
  prompt: string;
  completionMarker: string;
  responsePath: string;
  expectedFiles: string[];
  enterPlan?: boolean;
  answers?: Array<{ kind: "first" } | { kind: "custom"; text: string }>;
}

export interface ClaudeE2EScenario {
  id: string;
  exerciseId: string;
  title: string;
  initialMode: "auto" | "plan";
  turns: ClaudeE2ETurnDefinition[];
  verification: string[][];
}

const TRAIN_BASE = [
  "Build a deterministic standard-library Python train simulator in this empty workspace.",
  "Work directly in auto mode: do not enter plan mode and do not ask clarification questions.",
  "Create train_sim.py and test_train_sim.py.",
  "Model stations, scheduled departures, travel times, delays, and deterministic arrival events.",
  "Provide a CLI that prints a readable schedule and simulation result.",
  "Run python3 -m unittest -v and do not finish until it passes.",
  "Finish with the exact sentence: Train simulator base complete.",
].join(" ");

const TRAIN_EXPORT = [
  "Enhance the existing train simulator with CSV and JSON schedule export.",
  "Stay in auto mode: do not enter plan mode and do not ask clarification questions.",
  "Add deterministic CLI flags for both formats and extend the unittest coverage.",
  "Run python3 -m unittest -v and verify both export formats before finishing.",
  "Finish with the exact sentence: Train schedule export complete.",
].join(" ");

const TRAIN_DASHBOARD = [
  "Enhance the existing train simulator with a dependency-free static HTML train dashboard export.",
  "Stay in auto mode: do not enter plan mode and do not ask clarification questions.",
  "The dashboard must summarize stations, scheduled and actual times, delays, and status using deterministic HTML.",
  "Add a CLI flag and unittest coverage, run python3 -m unittest -v, and verify two dashboard exports are byte-identical.",
  "Finish with the exact sentence: Train dashboard complete.",
].join(" ");

const SANDWICH = [
  "Create a standard-library Python command-line app for building sandwiches in this empty workspace.",
  "Remain in plan mode before writing files or running mutating commands.",
  "Ask exactly three separate clarification questions, one at a time, and give exactly three offered options for each question.",
  "The questions must cover the inventory and allergen model, the command output, and persistence.",
  "After all three answers, present a detailed implementation plan and wait for approval.",
  "After approval create sandwich_cli.py and test_sandwich_cli.py, implement the selected design, and use only the Python standard library.",
  "Run python3 -m unittest -v and exercise the CLI before finishing.",
  "Finish with the exact sentence: Sandwich builder complete.",
].join(" ");

const HABIT_BASE = [
  "Build a deterministic standard-library Python habit tracker CLI in this empty workspace.",
  "Work directly in auto mode: do not enter plan mode and do not ask clarification questions.",
  "Create habit_tracker.py and test_habit_tracker.py with add, list, and complete commands backed by a JSON data file.",
  "Run python3 -m unittest -v and exercise the CLI before finishing.",
  "Finish with the exact sentence: Habit tracker base complete.",
].join(" ");

const HABIT_PLAN = [
  "Plan and then implement an enhancement to the existing habit tracker for weekly goals, streak calculation, and a deterministic Markdown progress report.",
  "Before presenting the plan, ask exactly one clarification question with exactly three options about the weekly report format and recommend the first option.",
  "Do not edit files until I approve the plan.",
  "After approval update the implementation and tests, run python3 -m unittest -v, and verify two reports are byte-identical.",
  "Finish with the exact sentence: Habit tracker planning enhancement complete.",
].join(" ");

export const CLAUDE_E2E_SCENARIOS: ClaudeE2EScenario[] = [
  {
    id: "train-multiprompt",
    exerciseId: "py-98-01",
    title: "Multi-Prompt Train Simulator",
    initialMode: "auto",
    turns: [
      {
        prompt: TRAIN_BASE,
        completionMarker: "Train simulator base complete.",
        responsePath: "train_sim.py",
        expectedFiles: ["train_sim.py", "test_train_sim.py"],
      },
      {
        prompt: TRAIN_EXPORT,
        completionMarker: "Train schedule export complete.",
        responsePath: "train_sim.py",
        expectedFiles: ["train_sim.py", "test_train_sim.py"],
      },
      {
        prompt: TRAIN_DASHBOARD,
        completionMarker: "Train dashboard complete.",
        responsePath: "train_sim.py",
        expectedFiles: ["train_sim.py", "test_train_sim.py"],
      },
    ],
    verification: [
      ["python3", "-m", "unittest", "-v"],
      ["python3", "train_sim.py"],
    ],
  },
  {
    id: "sandwich-custom-plan",
    exerciseId: "py-98-02",
    title: "Custom-Choice Sandwich Builder",
    initialMode: "plan",
    turns: [
      {
        prompt: SANDWICH,
        completionMarker: "Sandwich builder complete.",
        responsePath: "sandwich_cli.py",
        expectedFiles: ["sandwich_cli.py", "test_sandwich_cli.py"],
        answers: [
          {
            kind: "custom",
            text: "Layered pantry inventory with substitutions and allergen exclusions",
          },
          {
            kind: "custom",
            text: "Assembly timeline plus a consolidated grocery list",
          },
          {
            kind: "custom",
            text: "Named sandwich profiles stored in a single JSON file",
          },
        ],
      },
    ],
    verification: [
      ["python3", "-m", "unittest", "-v"],
      ["python3", "sandwich_cli.py", "--help"],
    ],
  },
  {
    id: "habit-auto-plan",
    exerciseId: "py-98-03",
    title: "Auto Then Plan Habit Tracker",
    initialMode: "auto",
    turns: [
      {
        prompt: HABIT_BASE,
        completionMarker: "Habit tracker base complete.",
        responsePath: "habit_tracker.py",
        expectedFiles: ["habit_tracker.py", "test_habit_tracker.py"],
      },
      {
        prompt: HABIT_PLAN,
        completionMarker: "Habit tracker planning enhancement complete.",
        responsePath: "habit_tracker.py",
        expectedFiles: ["habit_tracker.py", "test_habit_tracker.py"],
        enterPlan: true,
        answers: [{ kind: "first" }],
      },
    ],
    verification: [
      ["python3", "-m", "unittest", "-v"],
      ["python3", "habit_tracker.py", "--help"],
    ],
  },
];

export function claudeE2EScenario(id: string): ClaudeE2EScenario {
  const scenario = CLAUDE_E2E_SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) throw new Error(`Unknown Claude E2E scenario: ${id}`);
  return scenario;
}
