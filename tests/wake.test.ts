import { afterEach, describe, expect, it, vi } from "vitest";
import { looksCold, wakeModel } from "../src/providers/wake";
import { ProviderError } from "../src/providers/types";
import { manualModel, mergeModelLists } from "../src/providers/registry";
import type { ProviderConfig } from "../src/types";

afterEach(() => vi.unstubAllGlobals());
const provider: ProviderConfig = { id: "hf", kind: "openai-compatible", name: "HF", baseUrl: "https://router.example/v1", enabled: true, models: [] };

describe("waking cold models", () => {
  it("retries while the model loads, then reports success", async () => {
    let calls = 0;
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      if (++calls < 3) return new Response(JSON.stringify({ error: "Model my/cold-model is currently loading" }), { status: 503 });
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const notes: string[] = [];
    const r = await wakeModel(provider, "k", manualModel("my/cold-model"), { signal: new AbortController().signal, retryMs: 1, onStatus: (n) => notes.push(n) });
    expect(r).toMatchObject({ ok: true, attempts: 3 });
    expect(bodies[0]).toMatchObject({ model: "my/cold-model", max_tokens: 16 });
    expect(bodies[0].tools).toBeUndefined();
    expect(notes).toEqual(["sending a test message", "still loading, try 2", "still loading, try 3"]);
  });

  it("stops at once on errors that are not about loading", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 }));
    const r = await wakeModel(provider, "bad", manualModel("x"), { signal: new AbortController().signal, retryMs: 1 });
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r.message).toMatch(/Invalid API key/);
  });

  it("classifies cold-start errors", () => {
    expect(looksCold(new ProviderError("x", 503))).toBe(true);
    expect(looksCold(new Error("Worker is starting, try again in 30s"))).toBe(true);
    expect(looksCold(new ProviderError("Unauthorized", 401))).toBe(false);
  });

  it("keeps hand-added models when the list is refreshed", () => {
    const old = [manualModel("cold/one"), { ...manualModel("listed"), userEdited: false }];
    const merged = mergeModelLists(old, [{ id: "listed", name: "Listed", kind: "chat", caps: { vision: false, pdf: false, tools: true, thinking: false } }]);
    expect(merged.map((m) => m.id).sort()).toEqual(["cold/one", "listed"]);
  });
});
