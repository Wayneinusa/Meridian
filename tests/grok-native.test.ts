import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearNativeSearchDown, markNativeSearchDown, searchStatus } from "../src/agent/nativeSearch";
import { saveTokens } from "../src/connectors/oauth";
import { generateImages, generateVideo } from "../src/providers/media";
import { NativeSearchUnavailable, type ChatRequest } from "../src/providers/types";
import { IMAGINE_MODELS, XAI_CLIENT_ID, xaiAdapter } from "../src/providers/xai";
import { migrateSettings, defaultSettings } from "../src/state/defaults";
import { mediaChoice } from "../src/tools/media";
import type { Message, ModelInfo, ProviderConfig, Settings } from "../src/types";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  clearNativeSearchDown();
});
afterEach(() => vi.unstubAllGlobals());

const sse = (events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const grok: ModelInfo = { id: "grok-4", name: "Grok 4", kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: true } };
const xai = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "xai", kind: "xai", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", enabled: true, models: [grok, ...IMAGINE_MODELS], hasKey: true, ...over });
const user: Message = { id: "m1", role: "user", createdAt: 1, updatedAt: 1, parts: [{ type: "text", text: "news?" }] };
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  provider: xai(),
  apiKey: "xai-key",
  model: grok,
  system: "",
  messages: [user],
  tools: [],
  options: { params: {}, webSearch: true, refusalFallback: false },
  signal: new AbortController().signal,
  onUpdate: () => undefined,
  blobs: { base64: async () => null, put: async () => ({ blobId: "b", mime: "", name: "", size: 0 }) },
  ...over,
});
const done = () => sse([{ type: "response.output_text.delta", output_index: 0, delta: "hi" }, { type: "response.completed", response: { status: "completed" } }]);
const signIn = () => saveTokens("provider.xai", { access_token: "oauth", refresh_token: "rt", expires_at: Date.now() + 3_600_000, client_id: XAI_CLIENT_ID, token_endpoint: "https://auth.x.ai/oauth2/token" });

describe("Grok native search", () => {
  it("API key: goes to the Responses API with web_search and x_search", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(init.body as string) });
      return done();
    });
    await xaiAdapter.chat(request());
    expect(bodies[0].url).toBe("https://api.x.ai/v1/responses");
    expect(bodies[0].body.tools.map((t: any) => t.type)).toEqual(["web_search", "x_search"]);
  });

  it("Sign in with X: the gateway gets the search tools and xAI's own request policy", async () => {
    await signIn();
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(init.body as string) });
      return done();
    });
    await xaiAdapter.chat(request({ provider: xai({ signedIn: true }), apiKey: "" }));
    expect(bodies[0].url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(bodies[0].body.tools.map((t: any) => t.type)).toEqual(["web_search", "x_search"]);
    expect(bodies[0].body.store).toBe(false);
    expect(bodies[0].body.include).toContain("reasoning.encrypted_content");
  });

  it("a refused search is retried without the source list, then reported as unavailable", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ error: "Tool x_search is not supported for this model" }, { status: 400 });
    });
    await expect(xaiAdapter.chat(request())).rejects.toBeInstanceOf(NativeSearchUnavailable);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].include).toEqual(["web_search_call.action.sources"]);
    expect(bodies[1].include).toBeUndefined();
  });

  it("the retry without the source list can succeed", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => (JSON.parse(init.body as string).include ? Response.json({ error: "unknown include value" }, { status: 422 }) : done()));
    const r = await xaiAdapter.chat(request());
    expect(r.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("account problems are not mistaken for a search refusal", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ error: "Your team has run out of credits (spending-limit)" }, { status: 403 }));
    const e = await xaiAdapter.chat(request()).catch((x) => x);
    expect(e).not.toBeInstanceOf(NativeSearchUnavailable);
    expect(String(e.message)).toMatch(/credits/);
  });

  it("the subscription gateway refusing the account falls back to the API key, with a notice", async () => {
    await signIn();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      if (url.includes("cli-chat-proxy")) return Response.json({ error: "Your subscription does not include this model" }, { status: 403 });
      return done();
    });
    const r = await xaiAdapter.chat(request({ provider: xai({ signedIn: true }) }));
    expect(r.parts).toEqual([{ type: "text", text: "hi" }]);
    expect(urls.at(-1)).toBe("https://api.x.ai/v1/responses");
    expect(r.notice).toMatch(/API key/);
  });

  it("the composer status says which search is used, and why it fell back", () => {
    const s = defaultSettings();
    s.webSearch = true;
    expect(searchStatus(s, {}, undefined, xai()).using).toBe("grok");
    expect(searchStatus(s, {}, undefined, xai({ baseUrl: "https://openrouter.ai/api/v1", signedIn: false })).using).toBe("meridian");
    expect(searchStatus(s, {}, undefined, s.providers.find((p) => p.kind === "anthropic")).using).toBe("claude");
    markNativeSearchDown("xai", "refused");
    expect(searchStatus(s, {}, undefined, xai())).toEqual({ using: "meridian", fallbackReason: "refused" });
    // Claude is not affected by Grok's fallback
    expect(searchStatus(s, {}, undefined, s.providers.find((p) => p.kind === "anthropic")).using).toBe("claude");
    expect(searchStatus({ ...s, webSearch: false }, {}, undefined, xai()).using).toBe("meridian");
  });
});

describe("Grok Imagine", () => {
  const settings = (over: Partial<Settings> = {}): Settings => {
    const s = defaultSettings();
    s.providers = s.providers.map((p) => (p.kind === "xai" ? { ...p, signedIn: true, models: [grok, ...p.models] } : p.kind === "anthropic" ? { ...p, hasKey: true } : p));
    return { ...s, ...over };
  };
  const grokChat = { model: { providerId: "xai", modelId: "grok-4" } };
  const claudeChat = { model: { providerId: "anthropic", modelId: "claude-opus-5-5" } };

  it("is listed as an xAI backend from the start, and for older settings", () => {
    expect(defaultSettings().providers.find((p) => p.kind === "xai")!.models.map((m) => m.id)).toEqual(IMAGINE_MODELS.map((m) => m.id));
    const old = migrateSettings({ providers: [{ id: "xai", kind: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", enabled: true, models: [grok] }] });
    expect(old.providers.find((p) => p.kind === "xai")!.models.map((m) => m.id)).toContain("grok-imagine-video");
  });

  it("Grok chats use it; other chats keep the default; a chat's own pick always wins", () => {
    const pollinations = { providerId: "pollinations", modelId: "classic" };
    const s = settings({ imageModel: pollinations });
    expect(mediaChoice(s, "image", grokChat)).toEqual({ ref: { providerId: "xai", modelId: "grok-imagine-image-2.0" }, reason: "grok" });
    expect(mediaChoice(s, "video", grokChat)?.ref.modelId).toBe("grok-imagine-video-1.5");
    expect(mediaChoice(s, "image", claudeChat)).toEqual({ ref: pollinations, reason: "default" });
    // a Grok chat in image mode remembers it was a Grok chat
    expect(mediaChoice(s, "image", { model: { providerId: "pollinations", modelId: "classic" }, chatModel: grokChat.model })?.reason).toBe("grok");
    expect(mediaChoice(s, "image", { ...grokChat, mediaModels: { image: pollinations } })).toEqual({ ref: pollinations, reason: "chat" });
    expect(mediaChoice({ ...s, grokImagine: false }, "image", grokChat)?.ref).toEqual(pollinations);
  });

  it("any model can use it: it is a normal backend, and a choice like any other", () => {
    const s = settings({ imageModel: { providerId: "xai", modelId: "grok-imagine-image" } });
    expect(mediaChoice(s, "image", claudeChat)).toEqual({ ref: { providerId: "xai", modelId: "grok-imagine-image" }, reason: "default" });
  });

  it("text-to-image and edits go to api.x.ai with the sign-in, falling back to the key", async () => {
    await signIn();
    const calls: { url: string; auth: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      calls.push({ url, auth, body: JSON.parse(init.body as string) });
      if (auth === "Bearer oauth" && url.endsWith("/images/edits")) return Response.json({ error: "not allowed" }, { status: 403 });
      return Response.json({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }] });
    });
    const model = IMAGINE_MODELS[0];
    const made = await generateImages({ provider: xai({ signedIn: true }), apiKey: "xai-key", model, prompt: "a fox" });
    expect(made[0].mime).toBe("image/png");
    expect(calls[0]).toMatchObject({ url: "https://api.x.ai/v1/images/generations", auth: "Bearer oauth" });
    expect(calls[0].body).toMatchObject({ model: "grok-imagine-image-2.0", prompt: "a fox", response_format: "b64_json" });
    await generateImages({ provider: xai({ signedIn: true }), apiKey: "xai-key", model, prompt: "make it blue", inputs: [{ bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png", name: "in.png" }] });
    const edits = calls.filter((c) => c.url.endsWith("/images/edits"));
    expect(edits.map((c) => c.auth)).toEqual(["Bearer oauth", "Bearer xai-key"]);
    expect(edits[1].body.image.url).toMatch(/^data:image\/png;base64,/);
  });

  it("text-to-video and image-to-video poll the job and download the clip", async () => {
    await signIn();
    const calls: { url: string; body?: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/videos/generations")) return Response.json({ request_id: "job1" });
      if (url.endsWith("/videos/job1")) return Response.json({ status: "done", video: { url: "https://vidgen.x.ai/clip.mp4" } });
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { "content-type": "video/mp4" } });
    });
    const model = IMAGINE_MODELS.find((m) => m.kind === "video")!;
    const v = await generateVideo({ provider: xai({ signedIn: true, hasKey: false }), apiKey: "", model, prompt: "waves", pollMs: 1, inputs: [{ bytes: new Uint8Array([137, 80, 78, 71]), mime: "image/png", name: "in.png" }] });
    expect(v.mime).toBe("video/mp4");
    expect(calls[0].body).toMatchObject({ model: "grok-imagine-video-1.5", prompt: "waves" });
    expect(calls[0].body.image.url).toMatch(/^data:image\/png;base64,/);
  });

  it("without a sign-in or key it says how to set it up", async () => {
    await expect(generateImages({ provider: xai({ hasKey: false }), apiKey: "", model: IMAGINE_MODELS[0], prompt: "x" })).rejects.toThrow(/Sign in with X or an xAI API key/);
  });
});
