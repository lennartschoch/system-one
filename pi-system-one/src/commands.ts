import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { registerAutoJudge } from "./auto-judge.ts";
import {
  applyConfigAnswers,
  type ConfigMode,
  createSessionConfig,
  describeConfig,
  isTypeSafeEndpoint,
  type SessionConfig,
  TYPESAFE_BASE_URL,
  TYPESAFE_MODEL,
} from "./config.ts";
import { DebugHistory, observedProvider } from "./debug.ts";
import { DebugOverlay, debugSummary } from "./debug-ui.ts";
import { saveStoredConfig } from "./persistence.ts";
import { buildSystemOneTool } from "./tool.ts";

export interface SessionStore {
  session?: SessionConfig;
}

export function registerSystemOneCommands(
  pi: ExtensionAPI,
  store: SessionStore,
  configPath?: string,
) {
  let registered = false;
  const history = new DebugHistory();
  pi.on("session_start", () => history.clear());
  function applyProvider() {
    if (registered) return;
    registered = true;
    pi.registerTool(
      buildSystemOneTool({
        resolveProvider: async (ctx) =>
          observedProvider(
            store.session ?? createSessionConfig(),
            ctx,
            history,
          ),
      }),
    );
    // Opt-in per-turn judge (disabled unless enabled via /so auto-judge or
    // SYSTEM_ONE_AUTO_JUDGE). Shares the tool's provider and debug history.
    registerAutoJudge(pi, {
      session: () => store.session,
      resolveProvider: (session, ctx) =>
        observedProvider(session, ctx, history),
    });
  }

  /** Persist the public settings (never credentials). */
  function persist(session: SessionConfig): void {
    if (!configPath) return;
    saveStoredConfig(configPath, {
      mode: session.mode,
      ...(session.mode === "custom"
        ? {
            baseUrl: session.current.baseUrl,
            ...(session.current.model ? { model: session.current.model } : {}),
          }
        : {}),
      timeoutMs: session.current.timeoutMs,
      autoJudge: {
        enabled: session.autoJudge.enabled,
        maxPromptChars: session.autoJudge.maxPromptChars,
        timeoutMs: session.autoJudge.timeoutMs,
      },
    });
  }

  async function cmdConfig(
    ctx: ExtensionCommandContext,
    requestedMode?: string,
  ): Promise<void> {
    const current = store.session ?? createSessionConfig();
    const modes: ConfigMode[] = [
      current.mode,
      ...(["typesafe", "custom", "native", "auto"] as ConfigMode[]).filter(
        (mode) => mode !== current.mode,
      ),
    ];
    const descriptions: Record<ConfigMode, string> = {
      typesafe: "TypeSafe Jev (HTTP, full Score)",
      custom: "Custom System One endpoint",
      native: "Pi classifier (Choice and Noul only)",
      auto: "Native when compatible, TypeSafe HTTP otherwise",
    };
    const options = modes.map(
      (mode) =>
        `${mode} — ${descriptions[mode]}${mode === current.mode ? " (current)" : ""}`,
    );
    const modeRaw =
      requestedMode ??
      (await ctx.ui.select("System One provider mode", options));
    if (modeRaw === undefined) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    const mode =
      requestedMode === undefined
        ? modes[options.indexOf(modeRaw)]
        : (modeRaw.trim().toLowerCase() as ConfigMode);
    if (!mode || !modes.includes(mode)) {
      ctx.ui.notify("Choose typesafe, custom, native, or auto.", "error");
      return;
    }
    const next: SessionConfig = {
      current: { ...current.current },
      mode,
      modeSource: "session",
      ignoredEnvironmentEndpoint: false,
      keyInMemory: current.keyInMemory,
      autoJudge: current.autoJudge,
    };
    if (mode === "typesafe" || mode === "auto") {
      next.current.baseUrl = TYPESAFE_BASE_URL;
      next.current.model = TYPESAFE_MODEL;
      // A key exported for a custom endpoint must not follow a mode switch.
      next.current.apiKey =
        !process.env.SYSTEM_ONE_BASE_URL ||
        isTypeSafeEndpoint(process.env.SYSTEM_ONE_BASE_URL)
          ? process.env.SYSTEM_ONE_API_KEY || undefined
          : undefined;
      next.keyInMemory = false;
    } else if (mode === "native") {
      next.current.baseUrl = "";
      next.current.model = TYPESAFE_MODEL;
      next.current.apiKey = undefined;
      next.keyInMemory = false;
    } else {
      const baseUrlRaw = await ctx.ui.input(
        `SYSTEM_ONE_BASE_URL (current: ${current.mode === "custom" ? current.current.baseUrl : "unset"}):`,
        current.mode === "custom" ? current.current.baseUrl : "",
      );
      if (baseUrlRaw === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      const baseUrl =
        baseUrlRaw.trim() ||
        (current.mode === "custom" ? current.current.baseUrl : "");
      if (!baseUrl) {
        ctx.ui.notify("Cancelled (base URL is required).", "info");
        return;
      }
      const sameEndpoint =
        current.mode === "custom" && baseUrl === current.current.baseUrl;
      const modelRaw = await ctx.ui.input(
        `SYSTEM_ONE_MODEL (current: ${sameEndpoint ? (current.current.model ?? "server default") : "server default"}):`,
        sameEndpoint ? (current.current.model ?? "") : "",
      );
      if (modelRaw === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      const apiKeyRaw = await ctx.ui.input(
        "SYSTEM_ONE_API_KEY (empty = keep, - = forget session key; never saved to JSON):",
        "",
      );
      if (apiKeyRaw === undefined) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }
      next.current.baseUrl = baseUrl;
      next.current.model =
        modelRaw.trim() || (sameEndpoint ? current.current.model : undefined);
      if (!sameEndpoint) {
        // Never carry a key entered for one endpoint to another endpoint.
        next.current.apiKey = undefined;
        next.keyInMemory = false;
      }
      if (apiKeyRaw.trim() === "-") {
        next.current.apiKey =
          sameEndpoint && process.env.SYSTEM_ONE_BASE_URL === baseUrl
            ? process.env.SYSTEM_ONE_API_KEY || undefined
            : undefined;
        next.keyInMemory = false;
      } else if (apiKeyRaw.trim()) {
        applyConfigAnswers(next, {
          baseUrl: "",
          model: "",
          apiKey: apiKeyRaw.trim(),
          timeoutMs: "",
        });
      }
    }
    next.ignoredEnvironmentEndpoint = Boolean(
      process.env.SYSTEM_ONE_BASE_URL &&
        process.env.SYSTEM_ONE_BASE_URL !== next.current.baseUrl,
    );
    if (configPath) {
      try {
        persist(next);
      } catch (error) {
        ctx.ui.notify(
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
    }
    store.session = next;
    ctx.ui.notify(
      next.keyInMemory
        ? "Updated. API key stays in memory only; other settings were saved."
        : configPath
          ? "Settings saved."
          : "Updated for this session.",
      "info",
    );
  }

  async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
    const session = store.session ?? createSessionConfig();
    let summary = describeConfig(session);
    if (
      session.mode !== "native" &&
      !session.current.apiKey &&
      isTypeSafeEndpoint(session.current.baseUrl)
    ) {
      const key = await ctx.modelRegistry?.getApiKeyForProvider?.("typesafe");
      summary = summary.replace(
        "api key: absent",
        key
          ? "api key: Pi TypeSafe credentials available"
          : "api key: absent (run /login typesafe)",
      );
    }
    ctx.ui.notify(summary, "info");
  }

  async function cmdDebug(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(debugSummary(history.entries), "info");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new DebugOverlay([...history.entries], theme, done, () =>
          tui.requestRender(),
        ),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: 70, maxHeight: 24 },
      },
    );
  }

  async function cmdAutoJudge(
    ctx: ExtensionCommandContext,
    arg?: string,
  ): Promise<void> {
    const current = store.session ?? createSessionConfig();
    const want = arg?.trim().toLowerCase();
    if (want !== "on" && want !== "off") {
      ctx.ui.notify(
        `Auto-judge is ${current.autoJudge.enabled ? "on" : "off"}. Use /so auto-judge on|off.`,
        "info",
      );
      return;
    }
    const next: SessionConfig = {
      ...current,
      autoJudge: { ...current.autoJudge, enabled: want === "on" },
    };
    if (configPath) {
      try {
        persist(next);
      } catch (error) {
        ctx.ui.notify(
          `Could not save settings: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
    }
    store.session = next;
    ctx.ui.notify(
      want === "on"
        ? "Auto-judge on: one judge call per user turn before the agent runs."
        : "Auto-judge off.",
      "info",
    );
  }

  pi.registerCommand("so", {
    description: "System One config (/so status for current)",
    getArgumentCompletions: (prefix: string) =>
      ["config", "status", "debug", "auto-judge"]
        .filter((c) => c.startsWith(prefix.trim().toLowerCase()))
        .map((c) => ({ value: c, label: c })),
    handler: async (args, ctx) => {
      const [cmd, arg] = args.trim().toLowerCase().split(/\s+/);
      if (cmd === "status") await cmdStatus(ctx);
      else if (cmd === "debug") await cmdDebug(ctx);
      else if (cmd === "auto-judge") await cmdAutoJudge(ctx, arg);
      else await cmdConfig(ctx, cmd === "config" ? arg : undefined);
    },
  });
  return { applyProvider, store };
}
