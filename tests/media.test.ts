import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImages, generateVideo, pickDefaultMedia } from "../src/providers/media";
import { guessOpenAIModel } from "../src/providers/openai";
import { manualModel } from "../src/providers/registry";
import type { ModelInfo, ProviderConfig } from "../src/types";
import { base64ToBytes, bytesToBase64 } from "../src/util/bytes";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const b64 = bytesToBase64(PNG);
const prov = (kind: ProviderConfig["kind"], baseUrl: string, models: ModelInfo[] = [], hasKey = true): ProviderConfig => ({ id: kind + baseUrl, kind, name: kind, baseUrl, enabled: true, models, hasKey });
const model = (id: string, kind: ModelInfo["kind"], extra: Partial<ModelInfo["caps"]> = {}): ModelInfo => ({ id, name: id, kind, caps: { vision: true, pdf: false, tools: false, thinking: false, ...extra } });
const input = { bytes: new Uint8Array([9, 9]), mime: "image/jpeg", name: "cat.jpg" };

afterEach(() => vi.unstubAllGlobals());

describe("model classification", () => {
  it("recognises Grok Imagine and other media models", () => {
    const xai = prov("xai", "https://api.x.ai/v1");
    expect(guessOpenAIModel(xai, { id: "grok-imagine-image" })?.kind).toBe("image");
    expect(guessOpenAIModel(xai, { id: "grok-imagine-image-pro" })?.kind).toBe("image");
    expect(guessOpenAIModel(xai, { id: "grok-2-image-1212" })?.kind).toBe("image");
    expect(guessOpenAIModel(xai, { id: "grok-imagine-video" })?.kind).toBe("video");
    expect(guessOpenAIModel(xai, { id: "grok-2-vision-1212" })?.kind).toBe("chat");
    expect(guessOpenAIModel(xai, { id: "grok-4" })?.caps.tools).toBe(true);
    const together = prov("openai-compatible", "https://api.together.xyz/v1");
    expect(guessOpenAIModel(together, { id: "black-forest-labs/FLUX.1-schnell" })?.kind).toBe("image");
    expect(guessOpenAIModel(together, { id: "meta-llama/Llama-3.3-70B" })?.kind).toBe("chat");
    expect(manualModel("grok-imagine-video").kind).toBe("video");
    expect(manualModel("my-cold-llm").kind).toBe("chat");
  });

  it("picks sensible defaults only from providers with keys", () => {
    const providers = [
      prov("anthropic", "https://api.anthropic.com", [model("claude-opus-5-5", "chat")]),
      prov("openai", "https://api.openai.com/v1", [model("gpt-image-1", "image"), model("sora-2", "video")], false),
      prov("xai", "https://api.x.ai/v1", [model("grok-imagine-image", "image"), model("grok-imagine-video", "video")]),
    ];
    expect(pickDefaultMedia(providers, "image")).toEqual({ providerId: providers[2].id, modelId: "grok-imagine-image" });
    expect(pickDefaultMedia(providers, "video")).toEqual({ providerId: providers[2].id, modelId: "grok-imagine-video" });
    expect(pickDefaultMedia(providers.slice(0, 2), "image")).toBeUndefined();
  });
});

describe("xAI (Grok Imagine)", () => {
  it("generates and edits images", async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ data: [{ b64_json: b64 }, { b64_json: b64 }] });
    });
    const p = prov("xai", "https://api.x.ai/v1");
    const out = await generateImages({ provider: p, apiKey: "k", model: model("grok-imagine-image", "image"), prompt: "a fox", options: { aspect: "16:9", count: 2 } });
    expect(out).toHaveLength(2);
    expect(out[0].mime).toBe("image/png");
    expect(calls[0].url).toBe("https://api.x.ai/v1/images/generations");
    expect(calls[0].body).toEqual({ model: "grok-imagine-image", prompt: "a fox", n: 2, response_format: "b64_json", aspect_ratio: "16:9" });
    await generateImages({ provider: p, apiKey: "k", model: model("grok-imagine-image", "image"), prompt: "make it night", inputs: [input] });
    expect(calls[1].url).toBe("https://api.x.ai/v1/images/edits");
    expect(calls[1].body.image).toEqual({ url: `data:image/jpeg;base64,${bytesToBase64(input.bytes)}`, type: "image_url" });
  });

  it("runs a video job from an image", async () => {
    const log: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      log.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/videos/generations")) {
        expect(JSON.parse(init!.body as string)).toEqual({ model: "grok-imagine-video", prompt: "waves", duration: 6, aspect_ratio: "9:16", image: { url: `data:image/jpeg;base64,${bytesToBase64(input.bytes)}` } });
        return Response.json({ request_id: "r1" });
      }
      if (url.endsWith("/videos/r1")) return Response.json(++polls < 2 ? { status: "pending", progress: 40 } : { status: "done", video: { url: "https://vidgen.x.ai/out.mp4", duration: 6 } });
      return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4" } });
    });
    const notes: string[] = [];
    const out = await generateVideo({ provider: prov("xai", "https://api.x.ai/v1"), apiKey: "k", model: model("grok-imagine-video", "video"), prompt: "waves", options: { seconds: 6, aspect: "9:16" }, inputs: [input], pollMs: 1, onProgress: (n) => notes.push(n) });
    expect(out.mime).toBe("video/mp4");
    expect(log).toEqual(["POST https://api.x.ai/v1/videos/generations", "GET https://api.x.ai/v1/videos/r1", "GET https://api.x.ai/v1/videos/r1", "GET https://vidgen.x.ai/out.mp4"]);
    expect(notes).toEqual(["queued", "40%", "downloading"]);
  });

  it("reports moderation and failures", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ data: [{ b64_json: b64, respect_moderation: false }] }));
    await expect(generateImages({ provider: prov("xai", "https://x/v1"), apiKey: "k", model: model("grok-imagine-image", "image"), prompt: "x" })).rejects.toThrow(/content policy/);
    vi.stubGlobal("fetch", async (url: string) => (url.endsWith("/generations") ? Response.json({ request_id: "r" }) : Response.json({ status: "failed", error: { message: "nope" } })));
    await expect(generateVideo({ provider: prov("xai", "https://x/v1"), apiKey: "k", model: model("v", "video"), prompt: "x", pollMs: 1 })).rejects.toThrow("Video generation failed: nope");
  });
});

describe("OpenAI images", () => {
  it("uses sizes for generation and multipart for edits", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Response.json({ data: [{ b64_json: b64 }] });
    });
    const p = prov("openai", "https://api.openai.com/v1");
    await generateImages({ provider: p, apiKey: "k", model: model("gpt-image-1", "image"), prompt: "a", options: { aspect: "9:16", quality: "high" } });
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ model: "gpt-image-1", prompt: "a", n: 1, size: "1024x1536", quality: "high" });
    await generateImages({ provider: p, apiKey: "k", model: model("gpt-image-1", "image"), prompt: "edit", inputs: [input, { ...input, name: "b.jpg" }] });
    expect(seen[1].url).toBe("https://api.openai.com/v1/images/edits");
    const form = seen[1].init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.getAll("image[]")).toHaveLength(2);
    expect((seen[1].init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("starts Sora from an image with a snapped duration", async () => {
    let form: FormData | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        form = init.body as FormData;
        return Response.json({ id: "v", status: "completed" });
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
    });
    await generateVideo({ provider: prov("openai", "https://api.openai.com/v1"), apiKey: "k", model: model("sora-2", "video"), prompt: "p", options: { seconds: 10 }, inputs: [input], pollMs: 1 });
    expect(form!.get("seconds")).toBe("8");
    expect(form!.get("size")).toBe("1280x720");
    expect((form!.get("input_reference") as File).name).toBe("cat.jpg");
  });
});

describe("Google and gateways", () => {
  it("sends input images to Gemini image models and a start image to Veo", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(init.body as string));
      if (url.endsWith(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] } }] });
      if (url.endsWith(":predictLongRunning")) return Response.json({ name: "op1" });
      if (url.endsWith("/op1")) return Response.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://g/file" } }] } } });
      return new Response(new Uint8Array([5]), { headers: { "content-type": "video/mp4" } });
    });
    const g = prov("gemini", "https://g/v1beta");
    const img = await generateImages({ provider: g, apiKey: "k", model: model("gemini-2.5-flash-image", "chat", { imageOutput: true }), prompt: "add a hat", inputs: [input], options: { aspect: "4:3" } });
    expect(Array.from(img[0].bytes)).toEqual(Array.from(PNG));
    expect(bodies[0].contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/jpeg", data: bytesToBase64(input.bytes) } });
    expect(bodies[0].generationConfig).toEqual({ responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "4:3" } });
    await generateVideo({ provider: g, apiKey: "k", model: model("veo-3.0-generate-001", "video"), prompt: "go", inputs: [input], options: { seconds: 8 }, pollMs: 1 });
    expect(bodies[1]).toEqual({ instances: [{ prompt: "go", image: { bytesBase64Encoded: bytesToBase64(input.bytes), mimeType: "image/jpeg" } }], parameters: { aspectRatio: "16:9", durationSeconds: 8 } });
  });

  it("asks OpenRouter image models for images through chat", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return Response.json({ choices: [{ message: { content: "here", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] } }] });
    });
    const out = await generateImages({ provider: prov("openai-compatible", "https://openrouter.ai/api/v1"), apiKey: "k", model: model("google/gemini-2.5-flash-image", "chat", { imageOutput: true }), prompt: "cat" });
    expect(body.modalities).toEqual(["image", "text"]);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "cat" }]);
    expect(Array.from(out[0].bytes)).toEqual(Array.from(base64ToBytes(b64)));
  });

  it("retries a plain images endpoint with fewer fields, and refuses Claude", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string);
      bodies.push(b);
      return b.size ? new Response(JSON.stringify({ error: { message: "unknown field size" } }), { status: 400 }) : Response.json({ data: [{ b64_json: b64 }] });
    });
    const out = await generateImages({ provider: prov("openai-compatible", "https://api.together.xyz/v1"), apiKey: "k", model: model("black-forest-labs/FLUX.1-schnell", "image"), prompt: "x" });
    expect(out).toHaveLength(1);
    expect(bodies[1]).toEqual({ model: "black-forest-labs/FLUX.1-schnell", prompt: "x" });
    await expect(generateImages({ provider: prov("anthropic", "x"), apiKey: "k", model: model("claude-opus-5-5", "chat"), prompt: "x" })).rejects.toThrow(/do not create images/);
  });
});
