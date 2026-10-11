// pi-system-one/tests/native-discovery.test.ts
//
// Native mode used to hardcode `typesafe/jev-latest`. It now honours an explicit
// `SYSTEM_ONE_NATIVE_MODEL=<provider>/<id>` and otherwise picks an available
// native decision classifier, so it is not exclusive to TypeSafe.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionConfig, type SessionConfig } from "../src/config.ts";
import { resolveSessionProvider } from "../src/provider.ts";

interface Fake {
  ctx: unknown;
  classified: () => { provider?: string; id?: string };
  findCalls: string[];
}

function fakeRegistry(options: {
  available?: { provider: string; id: string; api: string }[];
  jev?: { provider: string; id: string; api: string } | undefined;
}): Fake {
  let classified: { provider?: string; id?: string } = {};
  const findCalls: string[] = [];
  const ctx = {
    modelRegistry: {
      findOfType: (_type: string, provider: string, id: string) => {
        findCalls.push(`${provider}/${id}`);
        return options.jev;
      },
      getAvailableOfType: async () => options.available ?? [],
      classify: async (model: { provider: string; id: string }) => {
        classified = model;
        return {
          stopReason: "stop",
          model: model.id,
          answers: { q: { type: "bool", probability: 0.9 } },
        };
      },
    },
  };
  return { ctx, classified: () => classified, findCalls };
}

const NOUL_REQUEST = {
  state: { prompt: "roll back the deploy?" },
  questions: { q: { type: "noul", instructions: "Is a rollback warranted?" } },
} as never;

function nativeSession(env: Record<string, string> = {}): SessionConfig {
  const session = createSessionConfig(env as never, {});
  session.mode = "native";
  return session;
}

describe("native classifier discovery", () => {
  it("prefers an available TypeSafe Jev", async () => {
    const fake = fakeRegistry({
      jev: {
        provider: "typesafe",
        id: "jev-latest",
        api: "typesafe-system-one",
      },
      available: [
        { provider: "llama.cpp", id: "clef-flash", api: "typesafe-system-one" },
        { provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" },
      ],
    });
    const provider = await resolveSessionProvider(
      nativeSession(),
      fake.ctx as never,
    );
    await provider.evaluate(NOUL_REQUEST);
    assert.deepEqual(fake.classified(), {
      provider: "typesafe",
      id: "jev-latest",
      api: "typesafe-system-one",
    });
  });

  it("falls back to any available native decision classifier", async () => {
    const fake = fakeRegistry({
      available: [
        { provider: "llama.cpp", id: "clef-flash", api: "typesafe-system-one" },
      ],
    });
    const provider = await resolveSessionProvider(
      nativeSession(),
      fake.ctx as never,
    );
    await provider.evaluate(NOUL_REQUEST);
    assert.equal(fake.classified().id, "clef-flash");
    assert.equal(fake.classified().provider, "llama.cpp");
  });

  it("honours an explicit SYSTEM_ONE_NATIVE_MODEL", async () => {
    const fake = fakeRegistry({
      jev: {
        provider: "llama.cpp",
        id: "clef-flash",
        api: "typesafe-system-one",
      },
      available: [
        { provider: "typesafe", id: "jev-latest", api: "typesafe-system-one" },
      ],
    });
    const session = nativeSession({
      SYSTEM_ONE_NATIVE_MODEL: "llama.cpp/clef-flash",
    });
    const provider = await resolveSessionProvider(session, fake.ctx as never);
    await provider.evaluate(NOUL_REQUEST);
    assert.equal(fake.classified().id, "clef-flash");
    assert.ok(fake.findCalls.includes("llama.cpp/clef-flash"));
  });

  it("fails closed when nothing is available", async () => {
    const fake = fakeRegistry({ jev: undefined, available: [] });
    const provider = await resolveSessionProvider(
      nativeSession(),
      fake.ctx as never,
    );
    await assert.rejects(() => provider.evaluate(NOUL_REQUEST));
  });

  it("keeps the TypeSafe default when the registry does not expose listing", async () => {
    // Registries without getAvailableOfType (as in older embedding contexts)
    // fall back to the legacy findOfType lookup.
    const model = {
      provider: "typesafe",
      id: "jev-latest",
      api: "typesafe-system-one",
    };
    let classified: { id?: string } = {};
    const ctx = {
      modelRegistry: {
        findOfType: () => model,
        classify: async (m: { id: string }) => {
          classified = m;
          return {
            stopReason: "stop",
            model: m.id,
            answers: { q: { type: "bool", probability: 0.8 } },
          };
        },
      },
    };
    const provider = await resolveSessionProvider(
      nativeSession(),
      ctx as never,
    );
    await provider.evaluate(NOUL_REQUEST);
    assert.equal(classified.id, "jev-latest");
  });
});
