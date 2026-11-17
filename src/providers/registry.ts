import type { ModelInfo, ModelRef, ProviderConfig, ProviderKind, Settings } from "../types";
import { ANTHROPIC_DEFAULT_MODELS, anthropicAdapter } from "./anthropic";
import { geminiAdapter } from "./gemini";
import { openaiAdapter } from "./openai";
import type { ProviderAdapter } from "./types";

export function adapterFor(kind: ProviderKind): ProviderAdapter {
  if (kind === "anthropic") return anthropicAdapter;
  if (kind === "gemini") return geminiAdapter;
  return openaiAdapter;
}

export function defaultProviders(): ProviderConfig[] {
  return [
    { id: "anthropic", kind: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", enabled: true, models: ANTHROPIC_DEFAULT_MODELS },
    { id: "openai", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", enabled: true, models: [] },
    { id: "gemini", kind: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", enabled: true, models: [] },
  ];
}

/** One-click presets for services that speak the OpenAI dialect. */
export const COMPATIBLE_PRESETS: { name: string; baseUrl: string; needsKey: boolean }[] = [
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", needsKey: false },
  { name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", needsKey: false },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  { name: "xAI", baseUrl: "https://api.x.ai/v1", needsKey: true },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", needsKey: true },
  { name: "Together", baseUrl: "https://api.together.xyz/v1", needsKey: true },
  { name: "Custom endpoint", baseUrl: "", needsKey: false },
];

export function findModel(settings: Settings, ref: ModelRef | undefined): { provider: ProviderConfig; model: ModelInfo } | null {
  if (!ref) return null;
  const provider = settings.providers.find((p) => p.id === ref.providerId);
  const model = provider?.models.find((m) => m.id === ref.modelId);
  return provider && model ? { provider, model } : null;
}

/** Keep hand-edited capabilities when a model list is refreshed. */
export function mergeModelLists(old: ModelInfo[], fresh: ModelInfo[]): ModelInfo[] {
  const edited = new Map(old.filter((m) => m.userEdited).map((m) => [m.id, m]));
  const out = fresh.map((m) => {
    const e = edited.get(m.id);
    return e ? { ...m, caps: e.caps, kind: e.kind, userEdited: true } : m;
  });
  // models typed in by hand that the provider does not list stay
  for (const m of old) if (m.userEdited && !fresh.some((f) => f.id === m.id)) out.push(m);
  return out;
}

export function manualModel(id: string): ModelInfo {
  return { id, name: id, kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: false }, userEdited: true };
}
