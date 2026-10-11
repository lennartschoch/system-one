// pi-system-one/tests/auto-judge.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  QuestionMap,
  SystemOneProvider,
  SystemOneRequest,
  SystemOneResponse,
} from "system-one-core";
import {
  type AutoJudgeQuestions,
  buildAutoJudgeRequest,
  formatAutoJudgeGuideline,
  registerAutoJudge,
  runAutoJudge,
} from "../src/auto-judge.ts";
import type { SessionConfig } from "../src/config.ts";
import {
  type AutoJudgeConfig,
  createSessionConfig,
  resolveAutoJudge,
} from "../src/config.ts";
import { loadStoredConfig, saveStoredConfig } from "../src/persistence.ts";

const CONFIG: AutoJudgeConfig = {
  enabled: true,
  maxPromptChars: 4_000,
  timeoutMs: 5_000,
};

function probabilities(
  risk: "low" | "medium" | "high",
  top: number,
): Record<"low" | "medium" | "high", number> {
  const rest = (1 - top) / 2;
  const out = { low: rest, medium: rest, high: rest };
  out[risk] = top;
  return out;
}

function reading(
  risk: "low" | "medium" | "high",
  top: number,
  planning: number,
): SystemOneResponse<AutoJudgeQuestions> {
  return {
    answers: {
      risk: {
        type: "choice",
        choice: risk,
        probabilities: probabilities(risk, top),
        confidence: top,
      },
      needs_planning: { type: "noul", noul: planning },
    },
    metadata: { provider: "test" },
  };
}

function fixedProvider(response: SystemOneResponse<AutoJudgeQuestions>): {
  provider: SystemOneProvider;
  calls: { n: number };
} {
  const calls = { n: 0 };
  return {
    calls,
    provider: {
      id: "test",
      async evaluate<Q extends QuestionMap>(
        _request: SystemOneRequest<Q>,
      ): Promise<SystemOneResponse<Q>> {
        calls.n++;
        return response as unknown as SystemOneResponse<Q>;
      },
    },
  };
}

function throwingProvider(): SystemOneProvider {
  return {
    id: "test",
    async evaluate(): Promise<never> {
      throw new Error("unreachable");
    },
  };
}

describe("auto-judge config", () => {
  it("is off by default and opt-in via env or stored settings", () => {
    assert.equal(resolveAutoJudge({}).enabled, false);
    assert.equal(
      resolveAutoJudge({ SYSTEM_ONE_AUTO_JUDGE: "1" }).enabled,
      true,
    );
    assert.equal(
      resolveAutoJudge({ SYSTEM_ONE_AUTO_JUDGE: "true" }).enabled,
      true,
    );
    // a saved value wins over the environment
    assert.equal(
      resolveAutoJudge({ SYSTEM_ONE_AUTO_JUDGE: "1" }, { enabled: false })
        .enabled,
      false,
    );
    const session = createSessionConfig(
      {},
      { autoJudge: { enabled: true, maxPromptChars: 2_000, timeoutMs: 2_500 } },
    );
    assert.equal(session.autoJudge.enabled, true);
    assert.equal(session.autoJudge.maxPromptChars, 2_000);
    assert.equal(session.autoJudge.timeoutMs, 2_500);
  });
});

describe("auto-judge request", () => {
  it("truncates the prompt to maxPromptChars", () => {
    const request = buildAutoJudgeRequest("x".repeat(100), 10);
    assert.equal((request.state as { prompt: string }).prompt.length, 10);
  });
  it("leaves a short prompt intact", () => {
    const request = buildAutoJudgeRequest("hello", 10);
    assert.deepEqual(request.state, { prompt: "hello" });
  });
});

describe("auto-judge formatting", () => {
  it("returns undefined when nothing is decisive", () => {
    assert.equal(
      formatAutoJudgeGuideline(reading("medium", 0.34, 0.5)),
      undefined,
    );
  });
  it("marks a high-risk, planning reading as actionable", () => {
    const line = formatAutoJudgeGuideline(reading("high", 0.85, 0.9));
    assert.match(line ?? "", /risk=high/);
    assert.match(line ?? "", /needs_planning=yes/);
    assert.match(line ?? "", /confirm before destructive/);
  });
  it("reports a clear low/no-planning reading without the action line", () => {
    const line = formatAutoJudgeGuideline(reading("low", 0.9, 0.05));
    assert.match(line ?? "", /risk=low/);
    assert.match(line ?? "", /needs_planning=no/);
    assert.doesNotMatch(line ?? "", /Treat accordingly/);
  });
});

describe("auto-judge run", () => {
  it("returns a guideline from a decisive reading", async () => {
    const { provider } = fixedProvider(reading("high", 0.9, 0.8));
    const line = await runAutoJudge({
      provider,
      prompt: "deploy it",
      config: CONFIG,
    });
    assert.match(line ?? "", /risk=high/);
  });
  it("never throws and skips an empty prompt", async () => {
    const { provider, calls } = fixedProvider(reading("high", 0.9, 0.9));
    assert.equal(
      await runAutoJudge({ provider, prompt: "   ", config: CONFIG }),
      undefined,
    );
    assert.equal(calls.n, 0);
    assert.equal(
      await runAutoJudge({
        provider: throwingProvider(),
        prompt: "deploy it",
        config: CONFIG,
      }),
      undefined,
    );
  });
});

describe("auto-judge hook", () => {
  function harness() {
    const handlers: Record<string, ((event: never, ctx: never) => unknown)[]> =
      {};
    return {
      handlers,
      pi: {
        on: (name: string, handler: (event: never, ctx: never) => unknown) => {
          handlers[name] ??= [];
          handlers[name].push(handler);
        },
      },
    };
  }

  function event() {
    return {
      prompt: "deploy the change",
      systemPromptOptions: { promptGuidelines: [] as string[] },
    };
  }

  function register(session: SessionConfig, provider: SystemOneProvider) {
    const { handlers, pi } = harness();
    registerAutoJudge(pi as never, {
      session: () => session,
      resolveProvider: () => provider,
    });
    return handlers.before_agent_start[0];
  }

  it("injects nothing when disabled", async () => {
    const session = createSessionConfig({}, { autoJudge: { enabled: false } });
    const { provider } = fixedProvider(reading("high", 0.9, 0.9));
    const e = event();
    await register(session, provider)(
      e as never,
      { signal: undefined } as never,
    );
    assert.deepEqual(e.systemPromptOptions.promptGuidelines, []);
  });

  it("injects the reading when enabled", async () => {
    const session = createSessionConfig({}, { autoJudge: { enabled: true } });
    const { provider } = fixedProvider(reading("high", 0.9, 0.9));
    const e = event();
    await register(session, provider)(
      e as never,
      { signal: undefined } as never,
    );
    assert.equal(e.systemPromptOptions.promptGuidelines.length, 1);
    assert.match(e.systemPromptOptions.promptGuidelines[0], /auto-judge/);
  });

  it("injects nothing on a provider failure", async () => {
    const session = createSessionConfig({}, { autoJudge: { enabled: true } });
    const e = event();
    await register(session, throwingProvider())(
      e as never,
      { signal: undefined } as never,
    );
    assert.deepEqual(e.systemPromptOptions.promptGuidelines, []);
  });
});

describe("auto-judge persistence", () => {
  it("round-trips autoJudge and rejects malformed values", () => {
    const dir = mkdtempSync(join(tmpdir(), "so-autojudge-"));
    const path = join(dir, "pi-system-one.json");
    try {
      saveStoredConfig(path, {
        mode: "custom",
        baseUrl: "http://127.0.0.1:8008",
        autoJudge: { enabled: true, maxPromptChars: 1_000, timeoutMs: 1_500 },
      });
      const loaded = loadStoredConfig(path);
      assert.deepEqual(loaded.autoJudge, {
        enabled: true,
        maxPromptChars: 1_000,
        timeoutMs: 1_500,
      });
      for (const bad of [
        { autoJudge: { enabled: "yes" } },
        { autoJudge: { maxPromptChars: 0 } },
        { autoJudge: { maxPromptChars: 1.5 } },
        { autoJudge: { timeoutMs: -1 } },
        { autoJudge: { unknown: true } },
      ])
        assert.throws(() => saveStoredConfig(path, bad as never));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
