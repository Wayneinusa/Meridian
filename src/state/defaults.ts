import { defaultProviders } from "../providers/registry";
import type { Settings } from "../types";
import { uid } from "../types";

export function defaultSettings(): Settings {
  return {
    theme: "system",
    providers: defaultProviders(),
    defaultModel: { providerId: "anthropic", modelId: "claude-opus-5-5" },
    systemPrompt: "",
    params: {},
    modelParams: {},
    showThinking: true,
    webSearch: true,
    refusalFallback: true,
    tools: { files: true, media: true, web: true, computer: false, browser: true, connectors: true },
    browser: { engine: "chromium", showWindow: true, approval: "rules", allowSites: [] },
    autoApproveComputer: false,
    computerUse: { approval: "each", actionsPerMinute: 30, maxSteps: 80, keepScreenshots: 3 },
    alwaysAllow: [],
    mcpServers: [],
    sync: { icloud: true, auto: true },
    maxAgentSteps: 40,
    memory: true,
    subagents: true,
    search: { provider: "auto" },
    autoTitle: true,
    appearance: { fontSize: 15, width: "normal", sendOnEnter: true },
    voice: { autoSpeak: false },
    notifications: true,
    runInBackground: false,
    deviceId: uid("dev"),
    deviceName: "",
    prices: {},
    favorites: [],
    compareModels: [],
    oauthApps: {},
  };
}

/** Fill in anything a settings file from an older version is missing. */
export function migrateSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!raw || typeof raw !== "object") return d;
  const s = raw as Partial<Settings>;
  const providers = Array.isArray(s.providers) && s.providers.length ? s.providers : d.providers;
  for (const dp of d.providers) if (!providers.some((p) => p.id === dp.id)) providers.push(dp);
  return {
    ...d,
    ...s,
    providers,
    params: s.params ?? {},
    modelParams: s.modelParams ?? {},
    tools: { ...d.tools, ...(s.tools ?? {}) },
    computerUse: { ...d.computerUse, ...(s.computerUse ?? {}) },
    browser: { ...d.browser, ...(s.browser ?? {}) },
    sync: { ...d.sync, ...(s.sync ?? {}) },
    alwaysAllow: Array.isArray(s.alwaysAllow) ? s.alwaysAllow : [],
    mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers : [],
    search: { ...d.search, ...(s.search ?? {}) },
    appearance: { ...d.appearance, ...(s.appearance ?? {}) },
    voice: { ...d.voice, ...(s.voice ?? {}) },
    prices: s.prices ?? {},
    favorites: Array.isArray(s.favorites) ? s.favorites : [],
    compareModels: Array.isArray(s.compareModels) ? s.compareModels : [],
    oauthApps: s.oauthApps ?? {},
    deviceId: typeof s.deviceId === "string" && s.deviceId ? s.deviceId : d.deviceId,
  };
}
