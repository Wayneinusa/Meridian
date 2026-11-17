import { afterEach, describe, expect, it, vi } from "vitest";
import { geminiAdapter } from "../src/providers/gemini";
import { generateImages, generateVideo } from "../src/providers/media";
import { openaiAdapter } from "../src/providers/openai";
import type { ChatRequest } from "../src/providers/types";
import type { BlobRef, Message, ModelInfo, Part, ProviderConfig } from "../src/types";
import { bytesToBase64, utf8 } from "../src/util/bytes";

const sse = (objs: unknown[], done = false) =>
  new Response(objs.map((o) => `data: ${JSON.stringify(o)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({ id: "m", name: "m", kind: "chat", caps: { vision: true, pdf: true, tools: true, thinking: true }, ...over });
const provider = (kind: ProviderConfig["kind"], baseUrl: string): ProviderConfig => ({ id: "p", kind, name: "p", baseUrl, enabled: true, models: [] });

function request(kind: ProviderConfig["kind"], baseUrl: string, messages: Message[], over: Partial<ChatRequest> = {}): ChatRequest & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    provider: provider(kind, baseUrl),
    apiKey: "key",
    model: model(),
    system: "be brief",
    messages,
    tools: [{ name: "lookup", description: "look up", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
    options: { params: {}, webSearch: false, refusalFallback: false },
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    blobs: {
      base64: async (id) => (stored.has(id) ? bytesToBase64(stored.get(id)!) : null),
      put: async (bytes, mime, name): Promise<BlobRef> => {
        const blobId = `b${stored.size + 1}`;
        stored.set(blobId, bytes);
        return { blobId, mime, name, size: bytes.length };
      },
    },
    stored,
    ...over,
  };
}
const user = (text: string, extra: Part[] = []): Message => ({ id: "u" + text, role: "user", createdAt: 1, updatedAt: 1, parts: [...extra, { type: "text", text }] });

afterEach(() => vi.unstubAllGlobals());

describe("Gemini adapter", () => {
  it("parses thoughts, text, signatures and tool calls, then replays them", async () => {
    const calls: { url: string; body: any; headers: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers });
      return sse([
        { candidates: [{ content: { parts: [{ text: "Let me check.", thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: "Looking " }] } }] },
        { candidates: [{ content: { parts: [{ text: "it up." }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "SIG1" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } },
      ]);
    });
    const updates: Part[][] = [];
    const req = request("gemini", "https://g/v1beta", [user("find x")], { onUpdate: (p) => updates.push(p) });
    const res = await geminiAdapter.chat(req);

    expect(calls[0].url).toBe("https://g/v1beta/models/m:streamGenerateContent?alt=sse");
    expect(calls[0].headers["x-goog-api-key"]).toBe("key");
    expect(calls[0].body.systemInstruction.parts[0].text).toBe("be brief");
    expect(calls[0].body.tools[0].functionDeclarations[0]).toMatchObject({ name: "lookup", parameters: { type: "object", required: ["q"] } });
    expect(res.stop).toBe("tool_use");
    expect(res.usage).toMatchObject({ input: 11, output: 7 });
    expect(res.parts.map((p) => p.type)).toEqual(["thinking", "text", "tool_call"]);
    expect((res.parts[1] as any).text).toBe("Looking it up.");
    expect(res.parts[2]).toMatchObject({ name: "lookup", input: { q: "x" }, sig: "SIG1", status: "pending" });
    expect(updates.length).toBe(4);

    // second round: the tool result goes back, the signature is replayed
    const call = { ...(res.parts[2] as Extract<Part, { type: "tool_call" }>), status: "done" as const, result: { text: "x is 42" } };
    const assistant: Message = { id: "a1", role: "assistant", createdAt: 2, updatedAt: 2, parts: [res.parts[0], res.parts[1], call] };
    await geminiAdapter.chat(request("gemini", "https://g/v1beta", [user("find x"), assistant]));
    const contents = calls[1].body.contents;
    expect(contents.map((c: any) => c.role)).toEqual(["user", "model", "user"]);
    expect(contents[1].parts).toEqual([{ text: "Looking it up." }, { functionCall: { name: "lookup", args: { q: "x" } }, thoughtSignature: "SIG1" }]);
    expect(contents[2].parts[0]).toEqual({ functionResponse: { name: "lookup", response: { result: "x is 42" } } });
  });

  it("stores inline images from drawing models and sends attachments by capability", async () => {
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return sse([{ candidates: [{ content: { parts: [{ text: "Here:" }, { inlineData: { mimeType: "image/png", data: bytesToBase64(new Uint8Array([1, 2, 3])) } }] }, finishReason: "STOP" }] }]);
    });
    const req = request("gemini", "https://g/v1beta", [], { model: model({ caps: { vision: true, pdf: false, tools: false, thinking: false, imageOutput: true } }), tools: [] });
    const img = await req.blobs.put(new Uint8Array([9]), "image/jpeg", "photo.jpg");
    const pdf = await req.blobs.put(utf8.encode("%PDF"), "application/pdf", "doc.pdf");
    req.messages = [user("edit this", [{ type: "attachment", ...img }, { type: "attachment", ...pdf, extractedText: "PDF TEXT" }])];
    const res = await geminiAdapter.chat(req);
    expect(bodies[0].generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(bodies[0].tools).toBeUndefined();
    const parts = bodies[0].contents[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: "image/jpeg", data: bytesToBase64(new Uint8Array([9])) } });
    expect(parts[1].text).toContain('<document name="doc.pdf">\nPDF TEXT'); // no native PDF support -> extracted text
    expect(parts[2]).toEqual({ text: "edit this" });
    const art = res.parts[1] as Extract<Part, { type: "artifact" }>;
    expect(art).toMatchObject({ type: "artifact", origin: "model", mime: "image/png", size: 3 });
    expect(Array.from(req.stored.get(art.blobId)!)).toEqual([1, 2, 3]);
  });

  it("reports safety blocks and API errors", async () => {
    vi.stubGlobal("fetch", async () => sse([{ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }]));
    expect(await geminiAdapter.chat(request("gemini", "https://g", [user("x")]))).toMatchObject({ stop: "refusal" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }));
    await expect(geminiAdapter.chat(request("gemini", "https://g", [user("x")]))).rejects.toThrow("400: API key not valid");
  });
});

describe("OpenAI-compatible adapter", () => {
  it("assembles streamed tool calls and reasoning", async () => {
    let body: any;
    let headers: any;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("http://localhost:11434/v1/chat/completions");
      body = JSON.parse(init.body as string);
      headers = init.headers;
      const d = (delta: unknown, finish_reason?: string) => ({ choices: [{ index: 0, delta, finish_reason }] });
      return sse(
        [
          d({ reasoning_content: "hmm " }),
          d({ reasoning_content: "ok" }),
          d({ content: "Checking." }),
          d({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: '{"q":' } }] }),
          d({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
          d({ tool_calls: [{ index: 1, id: "call_2", function: { name: "lookup", arguments: "{oops" } }] }),
          d({}, "tool_calls"),
          { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
        ],
        true,
      );
    });
    const res = await openaiAdapter.chat(request("openai-compatible", "http://localhost:11434/v1/", [user("find x")], { apiKey: "" }));
    expect(headers.Authorization).toBeUndefined(); // local servers need no key
    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.tools[0].function.name).toBe("lookup");
    expect(res.stop).toBe("tool_use");
    expect(res.usage).toMatchObject({ input: 3, output: 4 });
    expect(res.parts).toEqual([
      { type: "thinking", text: "hmm ok" },
      { type: "text", text: "Checking." },
      { type: "tool_call", id: "call_1", name: "lookup", input: { q: "x" }, status: "pending" },
      { type: "tool_call", id: "call_2", name: "lookup", input: { __invalid_json: "{oops" }, status: "pending" },
    ]);
  });

  it("sends images, PDFs and tool-result screenshots in the shapes this dialect needs", async () => {
    let body: any;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }], true);
    });
    const req = request("openai", "https://api.openai.com/v1", []);
    const img = await req.blobs.put(new Uint8Array([7]), "image/png", "a.png");
    const pdf = await req.blobs.put(utf8.encode("%PDF"), "application/pdf", "a.pdf");
    const shot = await req.blobs.put(new Uint8Array([8]), "image/png", "shot.png");
    req.messages = [
      user("look", [{ type: "attachment", ...img }, { type: "attachment", ...pdf }]),
      { id: "a", role: "assistant", createdAt: 2, updatedAt: 2, parts: [{ type: "tool_call", id: "c1", name: "take_screenshot", input: {}, status: "done", result: { text: "captured", images: [shot] } }, { type: "tool_call", id: "c2", name: "lookup", input: { q: "y" }, status: "running" }] },
    ];
    const res = await openaiAdapter.chat(req);
    expect(res.stop).toBe("end");
    const [, u, a, t1, t2, follow] = body.messages;
    expect(u.content.map((c: any) => c.type)).toEqual(["image_url", "file", "text"]);
    expect(u.content[1].file).toEqual({ filename: "a.pdf", file_data: `data:application/pdf;base64,${bytesToBase64(utf8.encode("%PDF"))}` });
    expect(a.tool_calls.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    expect(t1).toEqual({ role: "tool", tool_call_id: "c1", content: "captured" });
    expect(t2.content).toMatch(/^Error: The tool call was interrupted/); // every call gets an answer
    expect(follow.role).toBe("user");
    expect(follow.content[1].image_url.url).toBe(`data:image/png;base64,${bytesToBase64(new Uint8Array([8]))}`);
  });
});

describe("media generation", () => {
  const png = bytesToBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]));

  it("generates images with Imagen and with drawing Gemini models", async () => {
    const seen: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string) });
      if (url.endsWith(":predict")) return Response.json({ predictions: [{ bytesBase64Encoded: png, mimeType: "image/png" }, { bytesBase64Encoded: png }] });
      return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }, { inlineData: { mimeType: "image/png", data: png } }] } }] });
    });
    const p = provider("gemini", "https://g/v1beta");
    const a = await generateImages({ provider: p, apiKey: "k", model: model({ id: "imagen-4.0-generate-001", kind: "image" }), prompt: "cat", shape: "portrait", count: 2 });
    expect(a).toHaveLength(2);
    expect(seen[0].body).toEqual({ instances: [{ prompt: "cat" }], parameters: { sampleCount: 2, aspectRatio: "9:16" } });
    const b = await generateImages({ provider: p, apiKey: "k", model: model({ id: "gemini-2.5-flash-image" }), prompt: "cat" });
    expect(b[0].bytes.length).toBe(12);
    expect(seen[1].url).toBe("https://g/v1beta/models/gemini-2.5-flash-image:generateContent");
  });

  it("runs an OpenAI-style video job to completion", async () => {
    const log: string[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      log.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") {
        const form = init.body as FormData;
        expect(form.get("model")).toBe("sora-2");
        expect(form.get("size")).toBe("720x1280");
        expect(form.get("seconds")).toBe("8");
        return Response.json({ id: "vid_1", status: "queued" });
      }
      if (url.endsWith("/content")) return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4" } });
      polls++;
      return Response.json({ id: "vid_1", status: polls < 3 ? "in_progress" : "completed", progress: polls * 30 });
    });
    const notes: string[] = [];
    const out = await generateVideo({ provider: provider("openai", "https://api.openai.com/v1"), apiKey: "k", model: model({ id: "sora-2", kind: "video" }), prompt: "waves", shape: "portrait", seconds: 8, pollMs: 1, onProgress: (n) => notes.push(n) });
    expect(out).toMatchObject({ mime: "video/mp4" });
    expect(out.bytes.length).toBe(4);
    expect(log).toEqual(["POST https://api.openai.com/v1/videos", "GET https://api.openai.com/v1/videos/vid_1", "GET https://api.openai.com/v1/videos/vid_1", "GET https://api.openai.com/v1/videos/vid_1", "GET https://api.openai.com/v1/videos/vid_1/content"]);
    expect(notes).toEqual(["30%", "60%", "90%"]);
  });

  it("runs a Veo long-running operation and surfaces failures", async () => {
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith(":predictLongRunning")) {
        expect(JSON.parse(init!.body as string)).toEqual({ instances: [{ prompt: "waves" }], parameters: { aspectRatio: "16:9" } });
        return Response.json({ name: "models/veo/operations/op1" });
      }
      if (url.endsWith("/operations/op1")) return Response.json(++polls < 2 ? { done: false } : { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://g/files/v1:download" } }] } } });
      expect((init!.headers as any)["x-goog-api-key"]).toBe("k");
      return new Response(new Uint8Array([1, 2]));
    });
    const p = provider("gemini", "https://g/v1beta");
    const out = await generateVideo({ provider: p, apiKey: "k", model: model({ id: "veo", kind: "video" }), prompt: "waves", pollMs: 1 });
    expect(Array.from(out.bytes)).toEqual([1, 2]);

    vi.stubGlobal("fetch", async (url: string) => (url.endsWith(":predictLongRunning") ? Response.json({ name: "op" }) : Response.json({ done: true, error: { message: "quota exceeded" } })));
    await expect(generateVideo({ provider: p, apiKey: "k", model: model({ id: "veo", kind: "video" }), prompt: "x", pollMs: 1 })).rejects.toThrow("quota exceeded");
    await expect(generateVideo({ provider: provider("anthropic", "x"), apiKey: "k", model: model(), prompt: "x" })).rejects.toThrow(/does not generate video/);
  });
});
