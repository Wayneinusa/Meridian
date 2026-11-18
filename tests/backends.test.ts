import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKENDS, providerReady } from "../src/providers/backends";
import { generateImages, generateVideo, pickDefaultMedia } from "../src/providers/media";
import { findMediaRefs, sizeFor } from "../src/providers/mediaUtil";
import { backendProvider } from "../src/providers/registry";
import type { ModelInfo, ProviderConfig } from "../src/types";
import { bytesToBase64 } from "../src/util/bytes";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0]);
const model = (id: string, kind: ModelInfo["kind"]): ModelInfo => ({ id, name: id, kind, caps: { vision: true, pdf: false, tools: false, thinking: false } });
const img = (bytes = PNG, type = "image/png") => new Response(bytes as BodyInit, { headers: { "content-type": type } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}
function stub(route: (c: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: any = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const c = { url: String(url), method: init.method ?? "GET", headers, body };
    calls.push(c);
    return route(c);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("readiness and defaults", () => {
  it("knows which free services work without a key", () => {
    const poll = backendProvider("pollinations");
    const horde = backendProvider("horde");
    const cf = backendProvider("cloudflare");
    expect(providerReady(poll, "image")).toBe(true);
    expect(providerReady(poll, "video")).toBe(false);
    expect(providerReady({ ...poll, hasKey: true }, "video")).toBe(true);
    expect(providerReady(horde, "image")).toBe(true);
    expect(providerReady({ ...cf, hasKey: true }, "image")).toBe(false); // no account id yet
    expect(providerReady({ ...cf, hasKey: true, accountId: "abc" }, "image")).toBe(true);
    expect(providerReady({ ...poll, enabled: false }, "image")).toBe(false);
    expect(BACKENDS.pollinations?.makes).toEqual(["image", "video"]);
  });

  it("defaults to Pollinations, and prefers a real model once there is a key", () => {
    const poll = { ...backendProvider("pollinations"), models: [model("classic", "image"), model("tongyi-mai/z-image-turbo", "image"), model("alibaba/wan-2.2-fast", "video")] };
    const xai: ProviderConfig = { id: "xai", kind: "xai", name: "xAI", baseUrl: "", enabled: true, hasKey: true, models: [model("grok-imagine-image", "image"), model("grok-imagine-video", "video")] };
    expect(pickDefaultMedia([xai, poll, backendProvider("horde")], "image")).toEqual({ providerId: "pollinations", modelId: "classic" });
    expect(pickDefaultMedia([xai, { ...poll, hasKey: true }], "image")).toEqual({ providerId: "pollinations", modelId: "tongyi-mai/z-image-turbo" });
    // no Pollinations key: video falls through to a provider with a key
    expect(pickDefaultMedia([poll, xai], "video")).toEqual({ providerId: "xai", modelId: "grok-imagine-video" });
    expect(pickDefaultMedia([{ ...poll, hasKey: true }, xai], "video")).toEqual({ providerId: "pollinations", modelId: "alibaba/wan-2.2-fast" });
    expect(pickDefaultMedia([backendProvider("horde")], "image")).toEqual({ providerId: "horde", modelId: "auto" });
  });

  it("sizes images by aspect ratio within a pixel budget", () => {
    expect(sizeFor("1:1", 1024, 64)).toEqual({ width: 1024, height: 1024 });
    const wide = sizeFor("16:9", 1024, 64);
    expect(wide.width % 64).toBe(0);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 0);
    expect(wide.width * wide.height).toBeLessThanOrEqual(1024 * 1024 * 1.02);
  });

  it("finds media in any response shape", () => {
    expect(findMediaRefs("Here you go: ![cat](https://x.test/cat.png)")).toEqual(["https://x.test/cat.png"]);
    expect(findMediaRefs({ data: { output: ["https://x.test/a"] } })).toEqual(["https://x.test/a"]);
    expect(findMediaRefs('{"images":[{"url":"https://x.test/1.jpg"}]}')).toEqual(["https://x.test/1.jpg"]);
    const b64 = "A".repeat(300);
    expect(findMediaRefs({ b64_json: b64 })).toEqual([`base64:${b64}`]);
    expect(findMediaRefs("see https://example.com/page")).toEqual(["https://example.com/page"]);
  });
});

describe("Pollinations", () => {
  it("makes images with no key through the free classic endpoint", async () => {
    const calls = stub(() => img(JPG, "image/jpeg"));
    const out = await generateImages({ provider: backendProvider("pollinations"), apiKey: "", model: model("classic", "image"), prompt: "a red fox", options: { aspect: "16:9" } });
    expect(out[0].mime).toBe("image/jpeg");
    expect(calls[0].url).toMatch(/^https:\/\/image\.pollinations\.ai\/prompt\/a%20red%20fox\?width=\d+&height=\d+&seed=\d+$/);
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("waits for the next free slot when the free limit answers 402", async () => {
    let n = 0;
    stub(() => (n++ === 0 ? new Response("{}", { status: 402, headers: { "retry-after": "1" } }) : img()));
    const notes: string[] = [];
    const out = await generateImages({ provider: backendProvider("pollinations"), apiKey: "", model: model("classic", "image"), prompt: "x", onProgress: (s) => notes.push(s) });
    expect(out).toHaveLength(1);
    expect(notes).toContain("free slot in 1 s");
  });

  it("uses the chosen model with a key", async () => {
    const calls = stub(() => img());
    await generateImages({ provider: { ...backendProvider("pollinations"), hasKey: true }, apiKey: "sk_test", model: model("tongyi-mai/z-image-turbo", "image"), prompt: "a boat", options: { count: 2 } });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toMatch(/^https:\/\/gen\.pollinations\.ai\/image\/a%20boat\?model=tongyi-mai%2Fz-image-turbo&width=1024&height=1024&seed=\d+$/);
    expect(calls[0].headers.authorization).toBe("Bearer sk_test");
  });

  it("runs video as an async job", async () => {
    const calls = stub((c) => {
      if (c.url.includes("/video/")) return Response.json({ id: "j1", status: "pending" }, { status: 202 });
      if (c.url.endsWith("/v1/jobs/j1")) return Response.json(calls.filter((x) => x.url.endsWith("/v1/jobs/j1")).length < 2 ? { status: "pending" } : { status: "succeeded", result_url: "https://media.test/v.mp4" });
      return new Response(MP4 as BodyInit, { headers: { "content-type": "video/mp4" } });
    });
    const out = await generateVideo({ provider: { ...backendProvider("pollinations"), hasKey: true }, apiKey: "sk_test", model: model("alibaba/wan-2.2-fast", "video"), prompt: "waves", options: { seconds: 5, aspect: "9:16" }, pollMs: 1 });
    expect(out.mime).toBe("video/mp4");
    expect(calls[0].headers.prefer).toBe("respond-async");
    expect(calls[0].url).toContain("duration=5");
    expect(calls[0].url).toContain("aspectRatio=9%3A16");
  });

  it("explains that video needs a free key", async () => {
    await expect(generateVideo({ provider: backendProvider("pollinations"), apiKey: "", model: model("alibaba/wan-2.2-fast", "video"), prompt: "x" })).rejects.toThrow(/free key/);
  });
});

describe("AI Horde", () => {
  it("queues anonymously, waits and downloads", async () => {
    let checks = 0;
    const calls = stub((c) => {
      if (c.url.includes("/status/models")) return Response.json([{ name: "Deliberate", count: 9 }, { name: "AlbedoBase XL (SDXL)", count: 4 }]);
      if (c.url.endsWith("/generate/async")) return Response.json({ id: "h1" }, { status: 202 });
      if (c.url.includes("/generate/check/")) return Response.json(++checks < 2 ? { done: false, queue_position: 3, wait_time: 20, is_possible: true } : { done: true });
      if (c.url.includes("/generate/status/")) return Response.json({ generations: [{ img: "https://r2.test/out.webp", censored: false }] });
      return img();
    });
    const notes: string[] = [];
    const out = await generateImages({ provider: backendProvider("horde"), apiKey: "", model: model("auto", "image"), prompt: "castle", options: { aspect: "16:9" }, onProgress: (s) => notes.push(s), ...({ pollMs: 1 } as object) });
    expect(out).toHaveLength(1);
    const post = calls.find((c) => c.url.endsWith("/generate/async"))!;
    expect(post.headers.apikey).toBe("0000000000");
    expect(post.body.models).toEqual(["AlbedoBase XL (SDXL)"]);
    expect(post.body.params.width % 64).toBe(0);
    expect(notes.some((n) => n.startsWith("queue position 3"))).toBe(true);
  });
});

describe("Cloudflare Workers AI", () => {
  const cf = (accountId?: string): ProviderConfig => ({ ...backendProvider("cloudflare"), hasKey: true, accountId });
  it("needs the account id", async () => {
    await expect(generateImages({ provider: cf(), apiKey: "t", model: model("@cf/black-forest-labs/flux-1-schnell", "image"), prompt: "x" })).rejects.toThrow(/account ID/);
  });
  it("reads JSON (FLUX) and binary (SDXL) answers", async () => {
    const calls = stub((c) => (c.url.includes("flux") ? Response.json({ result: { image: bytesToBase64(JPG) }, success: true }) : img()));
    const a = await generateImages({ provider: cf("acc1"), apiKey: "t", model: model("@cf/black-forest-labs/flux-1-schnell", "image"), prompt: "x" });
    expect(a[0].mime).toBe("image/jpeg");
    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/black-forest-labs/flux-1-schnell");
    expect(calls[0].body).toEqual({ prompt: "x", steps: 8 });
    const b = await generateImages({ provider: cf("acc1"), apiKey: "t", model: model("@cf/stabilityai/stable-diffusion-xl-base-1.0", "image"), prompt: "y" });
    expect(b[0].mime).toBe("image/png");
    expect(calls[1].body.num_steps).toBe(20);
  });
  it("says when the free allowance is used up", async () => {
    stub(() => Response.json({ errors: [{ message: "you have used up your daily free allocation of 10,000 neurons" }] }, { status: 429 }));
    await expect(generateImages({ provider: cf("acc1"), apiKey: "t", model: model("@cf/black-forest-labs/flux-1-schnell", "image"), prompt: "x" })).rejects.toThrow(/resets at 00:00 UTC/);
  });
});

describe("fal.ai, Runway and custom endpoints", () => {
  it("fal: submits to the queue and reads the result", async () => {
    let polls = 0;
    const calls = stub((c) => {
      if (c.method === "POST") return Response.json({ request_id: "r1", status_url: "https://queue.fal.run/fal-ai/flux/requests/r1/status", response_url: "https://queue.fal.run/fal-ai/flux/requests/r1" });
      if (c.url.endsWith("/status")) return Response.json(++polls < 2 ? { status: "IN_QUEUE", queue_position: 1 } : { status: "COMPLETED" });
      if (c.url.endsWith("/r1")) return Response.json({ images: [{ url: "https://fal.media/x.png" }] });
      return img();
    });
    const out = await generateImages({ provider: { ...backendProvider("fal"), hasKey: true }, apiKey: "fk", model: model("fal-ai/flux/schnell", "image"), prompt: "x", options: { aspect: "9:16" }, ...({ pollMs: 1 } as object) });
    expect(out).toHaveLength(1);
    expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(calls[0].headers.authorization).toBe("Key fk");
    expect(calls[0].body.image_size).toBe("portrait_16_9");
  });

  it("Runway: animates a picture and polls the task", async () => {
    let polls = 0;
    const calls = stub((c) => {
      if (c.url.endsWith("/image_to_video")) return Response.json({ id: "t1" });
      if (c.url.endsWith("/tasks/t1")) return Response.json(++polls < 2 ? { status: "RUNNING", progress: 0.5 } : { status: "SUCCEEDED", output: ["https://runway.test/v.mp4"] });
      return new Response(MP4 as BodyInit, { headers: { "content-type": "video/mp4" } });
    });
    const out = await generateVideo({ provider: { ...backendProvider("runway"), hasKey: true }, apiKey: "rk", model: model("gen4_turbo", "video"), prompt: "move", inputs: [{ bytes: PNG, mime: "image/png", name: "a.png" }], pollMs: 1 });
    expect(out.mime).toBe("video/mp4");
    expect(calls[0].headers["x-runway-version"]).toBe("2024-11-06");
    expect(calls[0].body.promptImage).toMatch(/^data:image\/png;base64,/);
    await expect(generateVideo({ provider: { ...backendProvider("runway"), hasKey: true }, apiKey: "rk", model: model("gen4_turbo", "video"), prompt: "move" })).rejects.toThrow(/attach an image/);
  });

  it("custom: runs a job template and finds the video", async () => {
    let polls = 0;
    const calls = stub((c) => {
      if (c.url === "https://my.test/gen") return Response.json({ job: { id: "77" } });
      if (c.url === "https://my.test/jobs/77") return Response.json(++polls < 2 ? { state: "running" } : { state: "done", output: { video: "https://my.test/files/77.mp4" } });
      return new Response(MP4 as BodyInit, { headers: { "content-type": "video/mp4" } });
    });
    const provider: ProviderConfig = {
      ...backendProvider("custom-media", "m1"),
      baseUrl: "https://my.test",
      videoApi: "template",
      videoTemplate: { method: "POST", url: "https://my.test/gen", headers: { "X-Key": "{{key}}" }, body: '{"prompt":"{{prompt}}","secs":"{{seconds}}"}', jobIdPath: "job.id", pollUrl: "https://my.test/jobs/{{id}}", statusPath: "state", failedPattern: "error|failed" },
    };
    const out = await generateVideo({ provider, apiKey: "abc", model: model("any", "video"), prompt: "rain", options: { seconds: 6 }, pollMs: 1 });
    expect(out.mime).toBe("video/mp4");
    expect(calls[0].headers["x-key"]).toBe("abc");
    expect(calls[0].body).toEqual({ prompt: "rain", secs: 6 });
  });

  it("custom: falls back to the OpenAI image shape without a template", async () => {
    const calls = stub(() => Response.json({ data: [{ b64_json: bytesToBase64(PNG) }] }));
    const out = await generateImages({ provider: { ...backendProvider("custom-media", "m2"), baseUrl: "http://localhost:7860/v1" }, apiKey: "", model: model("sdxl", "image"), prompt: "x" });
    expect(out).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:7860/v1/images/generations");
  });
});
