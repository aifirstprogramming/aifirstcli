export const DEFAULT_LEARN_CHARS_PER_SECOND = 540;

export function learnTextRate(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const configured = env.AIFIRST_LEARN_CHARS_PER_SECOND;
  if (configured === undefined) return DEFAULT_LEARN_CHARS_PER_SECOND;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(100_000, Math.max(30, parsed));
}
