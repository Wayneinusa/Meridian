// Which search a chat uses: the provider's own (Claude on Anthropic's API,
// Grok on xAI's API or subscription) or Meridian's shared web search tool.
//
// When a provider refuses its own search for a request, the engine retries with
// Meridian's search and remembers that here for a while, so the next turns do
// not fail the same way and the composer can say what is happening.
import type { Agent, Conversation, ProviderConfig, Settings } from "../types";

export type NativeKind = "grok" | "claude";

/** the provider's own search may be used for this chat (before any refusal) */
export function hostedSearch(settings: Settings, c: Pick<Conversation, "mode">, agent: Pick<Agent, "tools"> | undefined, provider: Pick<ProviderConfig, "kind" | "baseUrl" | "signedIn">): boolean {
  const web = (agent?.tools?.web ?? settings.tools.web) || c.mode === "research";
  if (!web || !settings.webSearch) return false;
  return nativeKind(provider) !== null;
}

export function nativeKind(provider: Pick<ProviderConfig, "kind" | "baseUrl" | "signedIn">): NativeKind | null {
  if (provider.kind === "anthropic") return /api\.anthropic\.com/.test(provider.baseUrl || "https://api.anthropic.com") ? "claude" : null;
  if (provider.kind === "xai") return provider.signedIn || /api\.x\.ai/.test(provider.baseUrl || "https://api.x.ai/v1") ? "grok" : null;
  return null;
}

const DOWN_MS = 30 * 60_000;
const down = new Map<string, { reason: string; until: number }>();
const listeners = new Set<() => void>();

export function markNativeSearchDown(providerId: string, reason: string, now = Date.now()) {
  down.set(providerId, { reason, until: now + DOWN_MS });
  for (const l of listeners) l();
}

export function clearNativeSearchDown(providerId?: string) {
  if (providerId) down.delete(providerId);
  else down.clear();
  for (const l of listeners) l();
}

export function nativeSearchDown(providerId: string, now = Date.now()): string | null {
  const d = down.get(providerId);
  if (!d) return null;
  if (d.until < now) {
    down.delete(providerId);
    return null;
  }
  return d.reason;
}

export function onNativeSearchChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export interface SearchStatus {
  /** what the chat will search with */
  using: "grok" | "claude" | "meridian" | "none";
  /** the provider's search was refused recently: why */
  fallbackReason?: string;
}

/** For the composer: which search the next message will use. */
export function searchStatus(settings: Settings, c: Pick<Conversation, "mode">, agent: Pick<Agent, "tools"> | undefined, provider: ProviderConfig | undefined): SearchStatus {
  const web = (agent?.tools?.web ?? settings.tools.web) || c.mode === "research";
  if (!web) return { using: "none" };
  if (!provider) return { using: "meridian" };
  const kind = nativeKind(provider);
  if (!kind || !settings.webSearch) return { using: "meridian" };
  const reason = nativeSearchDown(provider.id);
  return reason ? { using: "meridian", fallbackReason: reason } : { using: kind };
}
