// Waking a cold model: serverless hosts (Hugging Face, Featherless, RunPod,
// Together dedicated endpoints...) answer the first request with "loading" /
// 503 until the model is on a GPU. We send the smallest possible request and
// retry until it answers or the time runs out.
import type { ModelInfo, ProviderConfig } from "../types";
import { adapterFor } from "./registry";
import { ProviderError } from "./types";

export interface WakeResult {
  ok: boolean;
  seconds: number;
  attempts: number;
  message: string;
}

const COLD = /loading|cold|warm|starting|not ready|currently unavailable|scal(ing|ed) (up|from zero)|no (available )?(workers|instances|replicas)|overloaded|initializ|queue|capacity|try again/i;

export function looksCold(err: unknown): boolean {
  const status = err instanceof ProviderError ? err.status : undefined;
  if (status && [408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(status)) return true;
  return COLD.test(err instanceof Error ? err.message : String(err));
}

export async function wakeModel(
  provider: ProviderConfig,
  apiKey: string,
  model: ModelInfo,
  opts: { signal: AbortSignal; maxMinutes?: number; onStatus?: (note: string) => void; retryMs?: number },
): Promise<WakeResult> {
  const started = Date.now();
  const deadline = started + (opts.maxMinutes ?? 10) * 60_000;
  let attempts = 0;
  for (;;) {
    attempts++;
    opts.onStatus?.(attempts === 1 ? "sending a test message" : `still loading, try ${attempts}`);
    try {
      await adapterFor(provider.kind).chat({
        provider,
        apiKey,
        model: { ...model, caps: { ...model.caps, tools: false } },
        system: "",
        messages: [{ id: "wake", role: "user", createdAt: 0, updatedAt: 0, parts: [{ type: "text", text: "Reply with the single word: ready" }] }],
        tools: [],
        options: { params: { maxTokens: 16 }, webSearch: false, refusalFallback: false },
        signal: opts.signal,
        onUpdate: () => undefined,
        blobs: { base64: async () => null, put: async () => ({ blobId: "", name: "", mime: "", size: 0 }) },
      });
      const seconds = Math.round((Date.now() - started) / 1000);
      return { ok: true, seconds, attempts, message: `${model.name} is awake and answered after ${seconds} s.` };
    } catch (e) {
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const seconds = Math.round((Date.now() - started) / 1000);
      if (!looksCold(e) || Date.now() > deadline) {
        return { ok: false, seconds, attempts, message: e instanceof Error ? e.message : String(e) };
      }
      await new Promise((r) => setTimeout(r, opts.retryMs ?? 10_000));
    }
  }
}
