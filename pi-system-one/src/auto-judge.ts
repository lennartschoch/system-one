// pi-system-one/src/auto-judge.ts
//
// Opt-in auto-judge: before a user turn, ask the configured System One endpoint
// a small fixed set of questions about the prompt and turn the reading into one
// prompt-guideline line. This is OFF by default -- it adds a provider call of
// latency per turn -- and every failure is swallowed so it can never break the
// turn.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type ChoiceAnswer,
  choice,
  noul,
  type QuestionMap,
  type SystemOneCallOptions,
  type SystemOneProvider,
  type SystemOneRequest,
  type SystemOneResponse,
} from "system-one-core";
import type { AutoJudgeConfig, SessionConfig } from "./config.ts";

/** A reading below this probability is treated as "no signal" and not injected. */
export const AUTO_JUDGE_MIN_PROBABILITY = 0.6;

export const AUTO_JUDGE_QUESTIONS = {
  risk: choice("How risky is acting on this request without care?", {
    low: "Read-only or trivial; safe to proceed",
    medium: "Ordinary change; verify before finishing",
    high: "Auth, payments, unprotected data, production, or destructive",
  }),
  needs_planning: noul(
    "Does this request need deliberate planning or several dependent steps?",
    { true: "Plan or reason before acting", false: "Act directly" },
  ),
} satisfies QuestionMap;

export type AutoJudgeQuestions = typeof AUTO_JUDGE_QUESTIONS;

export function buildAutoJudgeRequest(
  prompt: string,
  maxPromptChars: number,
): SystemOneRequest<AutoJudgeQuestions> {
  const state =
    prompt.length > maxPromptChars ? prompt.slice(0, maxPromptChars) : prompt;
  return { state: { prompt: state }, questions: AUTO_JUDGE_QUESTIONS };
}

function topChoice(
  answer: ChoiceAnswer,
): { label: string; probability: number } | undefined {
  const entries = Object.entries(answer.probabilities ?? {});
  if (entries.length === 0) return undefined;
  const [label, probability] = entries.reduce((best, current) =>
    current[1] > best[1] ? current : best,
  );
  return { label, probability };
}

/**
 * Render one prompt-guideline line from a reading, or undefined when nothing is
 * decisive enough to be worth injecting.
 */
export function formatAutoJudgeGuideline(
  response: SystemOneResponse<AutoJudgeQuestions>,
): string | undefined {
  const parts: string[] = [];
  let actionable = false;

  const top = topChoice(response.answers.risk);
  if (top && top.probability >= AUTO_JUDGE_MIN_PROBABILITY) {
    parts.push(`risk=${top.label} (p=${top.probability.toFixed(2)})`);
    actionable = top.label === "high";
  }

  const planning = response.answers.needs_planning;
  if (planning.noul >= AUTO_JUDGE_MIN_PROBABILITY) {
    parts.push(`needs_planning=yes (p=${planning.noul.toFixed(2)})`);
    actionable = true;
  } else if (planning.noul <= 1 - AUTO_JUDGE_MIN_PROBABILITY) {
    parts.push(`needs_planning=no (p=${(1 - planning.noul).toFixed(2)})`);
  }

  if (parts.length === 0) return undefined;
  const action = actionable
    ? " Treat accordingly: plan first, and confirm before destructive steps."
    : "";
  return `System One auto-judge (opt-in): ${parts.join(", ")}.${action}`;
}

/**
 * Run the judge against an already-resolved provider. Never throws: any failure
 * (unreachable endpoint, timeout, malformed response) yields undefined so the
 * turn proceeds unmodified.
 */
export async function runAutoJudge(options: {
  provider: SystemOneProvider;
  prompt: string;
  config: AutoJudgeConfig;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  if (!options.prompt.trim()) return undefined;
  const request = buildAutoJudgeRequest(
    options.prompt,
    options.config.maxPromptChars,
  );
  try {
    const call: SystemOneCallOptions = { signal: options.signal };
    const response = await options.provider.evaluate(request, call);
    return formatAutoJudgeGuideline(response);
  } catch {
    return undefined;
  }
}

/**
 * Register the opt-in `before_agent_start` handler. It classifies the user
 * prompt with the same provider the tool uses and appends one guideline line.
 * It runs nothing when the feature is disabled.
 */
export function registerAutoJudge(
  pi: ExtensionAPI,
  deps: {
    session: () => SessionConfig | undefined;
    resolveProvider: (
      session: SessionConfig,
      ctx: ExtensionContext,
    ) => SystemOneProvider;
  },
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const session = deps.session();
    if (!session?.autoJudge.enabled) return;
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    if (!prompt.trim()) return;

    // Judge with the configured (usually shorter) timeout, not the tool's.
    const judgeSession: SessionConfig = {
      ...session,
      current: { ...session.current, timeoutMs: session.autoJudge.timeoutMs },
    };
    const guideline = await runAutoJudge({
      prompt,
      config: session.autoJudge,
      provider: deps.resolveProvider(judgeSession, ctx),
      signal: ctx.signal ?? undefined,
    });
    if (guideline) event.systemPromptOptions.promptGuidelines.push(guideline);
  });
}
