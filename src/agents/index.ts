/**
 * The agent registry.
 *
 * Order matters only for display: it's the order `init` and `doctor` report in.
 */

import { CliError } from "../output";
import { antigravityCliAgent, antigravityIdeAgent } from "./antigravity";
import { claudeAgent } from "./claude";
import { codexAgent } from "./codex";
import type { Agent, AgentKey, Detection } from "./types";
import { vscodeAgent } from "./vscode";

export const AGENTS: Agent[] = [
  claudeAgent,
  codexAgent,
  antigravityIdeAgent,
  antigravityCliAgent,
  vscodeAgent,
];

export function agentByKey(key: string): Agent {
  const agent = AGENTS.find((a) => a.key === key);
  if (!agent) {
    throw new CliError(
      `Unknown agent "${key}"`,
      "unknown_agent",
      `Known: ${AGENTS.map((a) => a.key).join(", ")}`,
    );
  }
  return agent;
}

export interface Detected {
  agent: Agent;
  detection: Detection;
}

/** Probe every agent concurrently; slow or broken binaries can't block the rest. */
export async function detectAll(): Promise<Detected[]> {
  return Promise.all(
    AGENTS.map(async (agent) => ({
      agent,
      // Belt and braces: adapters promise not to throw, but a single bad probe
      // must never abort `init` for every other tool.
      detection: await agent.detect().catch((): Detection => ({ installed: false })),
    })),
  );
}

/**
 * Which agents a command should act on.
 *
 * With no explicit selection, act on everything detected — that's the "just make
 * it work for a book reader" default. Explicit flags act even on undetected
 * agents, since a learner may be installing before the agent itself.
 */
export function selectAgents(explicitKeys: string[], detected: Detected[]): Agent[] {
  if (explicitKeys.length > 0) return explicitKeys.map(agentByKey);
  return detected.filter((d) => d.detection.installed).map((d) => d.agent);
}

/** Agent selector flags, e.g. `--claude --codex`. */
export function keysFromFlags(flags: Map<string, string | boolean>): string[] {
  return AGENTS.filter((a) => flags.get(a.key) === true).map((a) => a.key);
}

export type { Agent, AgentKey, Detection };
