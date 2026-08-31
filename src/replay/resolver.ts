import { findMatchingStep } from "@aifirst/content";
import type { Content } from "../content/types";
import type { ReplayStep } from "../content/types";

export type ReplayMatch =
  | { kind: "exact"; step: ReplayStep }
  | { kind: "fuzzy"; step: ReplayStep; score: number }
  | { kind: "ambiguous"; candidates: ReplayCandidate[] }
  | { kind: "none" };

export interface ReplayCandidate {
  step: ReplayStep;
  score: number;
}

function normalized(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().toLowerCase();
}

function fuzzyWords(value: string): string[] {
  return normalized(value)
    .split(" ")
    .filter((word) => word.length > 2 && !["write", "create", "make", "build", "program", "app"].includes(word));
}

function matcherWords(value: string): string[] {
  return normalized(value).split(/\s+/).filter((word) => word.length > 2);
}

function replaySteps(content: Content, language?: string): ReplayStep[] {
  return content.steps.filter((step) => {
    const candidate = step as ReplayStep;
    return Boolean(candidate.replay) && (!language || step.language === language);
  }) as ReplayStep[];
}

function languageRank(step: ReplayStep, language?: string): number {
  if (language) return step.language === language ? 0 : 1;
  if (step.language === "python") return 0;
  if (step.language === "java") return 1;
  return 2;
}

function topCandidates(
  candidates: Array<ReplayCandidate & { index: number }>,
  language?: string,
): ReplayCandidate[] {
  return candidates
    .sort((a, b) => b.score - a.score || languageRank(a.step, language) - languageRank(b.step, language) || a.index - b.index)
    .slice(0, 3)
    .map(({ step, score }) => ({ step, score }));
}

export function resolveReplay(prompt: string, content: Content, language?: string): ReplayMatch {
  const wanted = normalized(prompt);
  if (!wanted) return { kind: "none" };
  const steps = replaySteps(content, language);
  const exact = steps.filter((step) => {
    const prompts = [step.prompt, step.replay?.prompt].filter((value): value is string => Boolean(value));
    return prompts.some((candidate) => normalized(candidate) === wanted);
  });
  if (exact.length === 1) return { kind: "exact", step: exact[0] };
  if (exact.length > 1) {
    return {
      kind: "ambiguous",
      candidates: topCandidates(exact.map((step) => ({ step, score: 1, index: steps.indexOf(step) })), language),
    };
  }

  // A short but distinctive phrase such as "duckling" is a partial match, not
  // permission to run an exercise. Keep it in the replay matcher so it follows
  // the normal confirmation transaction instead of falling through to the
  // generic content matcher, which would present/run the exercise immediately.
  const partial = steps.flatMap((step, index) => {
    const prompts = [step.prompt, step.replay?.prompt].filter((value): value is string => Boolean(value));
    const scores = prompts.map((candidate) => {
      const stored = normalized(candidate);
      if (stored.includes(wanted)) return wanted.length / Math.max(stored.length, 1);
      if (wanted.includes(stored)) return stored.length / Math.max(wanted.length, 1);
      return 0;
    });
    const score = Math.max(...scores);
    return score > 0 ? [{ step, score: 0.5 + score / 2, index }] : [];
  });
  if (partial.length === 1) return { kind: "fuzzy", step: partial[0].step, score: partial[0].score };
  if (partial.length > 1) return { kind: "ambiguous", candidates: topCandidates(partial, language) };

  const fuzzy = steps
    .map((step, index) => {
      const candidate = fuzzyWords(step.replay?.prompt ?? step.prompt);
      const input = fuzzyWords(wanted);
      const common = input.filter((word) => candidate.includes(word)).length;
      return { step, common, score: common / Math.max(candidate.length, input.length, 1), index };
    })
    .filter((item) => item.common >= 2 && item.score > 0.5)
    .sort((a, b) => b.score - a.score || languageRank(a.step, language) - languageRank(b.step, language) || a.index - b.index);
  if (fuzzy.length === 1 || (fuzzy[0] && fuzzy[0].score > (fuzzy[1]?.score ?? 0) + 0.1)) {
    return { kind: "fuzzy", step: fuzzy[0].step, score: fuzzy[0].score };
  }
  if (fuzzy.length > 1) return { kind: "ambiguous", candidates: topCandidates(fuzzy, language) };

  // Mirror the shared content matcher's fuzzy tier as well. Its first-match
  // API hides ties, but replay mode must surface those ties instead of silently
  // executing whichever entry happens to come first.
  const matcherInput = matcherWords(wanted);
  const matcherFuzzy = steps
    .map((step, index) => {
      const stored = matcherWords(step.prompt);
      const common = matcherInput.filter((word) => stored.includes(word)).length;
      return { step, score: common / Math.max(matcherInput.length, stored.length, 1), index };
    })
    .filter((candidate) => candidate.score > 0.5);
  if (matcherFuzzy.length === 1) {
    return { kind: "fuzzy", step: matcherFuzzy[0].step, score: matcherFuzzy[0].score };
  }
  if (matcherFuzzy.length > 1) {
    return { kind: "ambiguous", candidates: topCandidates(matcherFuzzy, language) };
  }

  // The ordinary content matcher is the final fallback used by book mode. If it
  // can identify a replay-backed step, intercept that result here so a short or
  // ambiguous prompt is confirmed instead of falling through and running the
  // exercise as ordinary canonical content.
  const fallback = findMatchingStep(prompt, steps, language) as ReplayStep | null;
  if (fallback) return { kind: "fuzzy", step: fallback, score: 0 };
  return { kind: "none" };
}
