// Image and video generation. These are separate endpoints from chat, so any
// tool-capable chat model can ask for a picture or a clip through the
// generate_image / generate_video tools and the configured media model makes it.
import { httpFetch, readError } from "../platform/http";
import type { ModelInfo, ProviderConfig } from "../types";
import { base64ToBytes } from "../util/bytes";
import { trimSlash } from "./common";
import { ProviderError } from "./types";

export interface MediaOutput {
  bytes: Uint8Array;
  mime: string;
}

export interface ImageRequest {
  provider: ProviderConfig;
  apiKey: string;
  model: ModelInfo;
  prompt: string;
  /** "square" | "landscape" | "portrait" */
  shape?: string;
  count?: number;
  signal?: AbortSignal;
}

const OPENAI_SIZES: Record<string, string> = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };
const ASPECT: Record<string, string> = { square: "1:1", landscape: "16:9", portrait: "9:16" };

export async function generateImages(req: ImageRequest): Promise<MediaOutput[]> {
  const shape = req.shape && OPENAI_SIZES[req.shape] ? req.shape : "square";
  const count = Math.min(Math.max(req.count ?? 1, 1), 4);
  const base = trimSlash(req.provider.baseUrl);

  if (req.provider.kind === "gemini") {
    const headers = { "Content-Type": "application/json", "x-goog-api-key": req.apiKey };
    if (/imagen/.test(req.model.id)) {
      const res = await httpFetch(`${base}/models/${encodeURIComponent(req.model.id)}:predict`, {
        method: "POST",
        headers,
        signal: req.signal,
        body: JSON.stringify({ instances: [{ prompt: req.prompt }], parameters: { sampleCount: count, aspectRatio: ASPECT[shape] } }),
      });
      if (!res.ok) throw new ProviderError(await readError(res), res.status);
      const json = (await res.json()) as { predictions?: { bytesBase64Encoded?: string; mimeType?: string }[] };
      const out = (json.predictions ?? [])
        .filter((p) => p.bytesBase64Encoded)
        .map((p) => ({ bytes: base64ToBytes(p.bytesBase64Encoded!), mime: p.mimeType ?? "image/png" }));
      if (!out.length) throw new ProviderError("The image model returned no image (the prompt may have been filtered).");
      return out;
    }
    // Gemini models that draw answer through generateContent
    const res = await httpFetch(`${base}/models/${encodeURIComponent(req.model.id)}:generateContent`, {
      method: "POST",
      headers,
      signal: req.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: req.prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });
    if (!res.ok) throw new ProviderError(await readError(res), res.status);
    const json = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[] };
    const out: MediaOutput[] = [];
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData) out.push({ bytes: base64ToBytes(part.inlineData.data), mime: part.inlineData.mimeType });
    }
    if (!out.length) throw new ProviderError("The model returned no image (the prompt may have been filtered).");
    return out;
  }

  if (req.provider.kind === "anthropic") throw new ProviderError("Claude does not generate images. Pick an OpenAI or Gemini image model in Settings → Models.");

  // OpenAI and compatible /images/generations
  const body: Record<string, unknown> = { model: req.model.id, prompt: req.prompt, n: count, size: OPENAI_SIZES[shape] };
  if (/dall-e/.test(req.model.id)) {
    body.response_format = "b64_json";
    body.size = shape === "square" ? "1024x1024" : shape === "landscape" ? "1792x1024" : "1024x1792";
    if (/dall-e-3/.test(req.model.id)) body.n = 1;
  }
  const res = await httpFetch(`${base}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${req.apiKey}` },
    signal: req.signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const out: MediaOutput[] = [];
  for (const d of json.data ?? []) {
    if (d.b64_json) out.push({ bytes: base64ToBytes(d.b64_json), mime: sniffImage(base64ToBytes(d.b64_json.slice(0, 16))) });
    else if (d.url) {
      const img = await httpFetch(d.url, { signal: req.signal });
      if (img.ok) out.push({ bytes: new Uint8Array(await img.arrayBuffer()), mime: img.headers.get("content-type") ?? "image/png" });
    }
  }
  if (!out.length) throw new ProviderError("The image model returned no image.");
  return out;
}

function sniffImage(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x52 && head[1] === 0x49) return "image/webp";
  return "image/png";
}

export interface VideoRequest {
  provider: ProviderConfig;
  apiKey: string;
  model: ModelInfo;
  prompt: string;
  shape?: string;
  seconds?: number;
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
  /** how often to poll the job (ms) */
  pollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

/** Video takes minutes: start a job, poll it, download the result. */
export async function generateVideo(req: VideoRequest): Promise<MediaOutput> {
  const base = trimSlash(req.provider.baseUrl);
  const shape = req.shape === "portrait" ? "portrait" : "landscape";
  const deadline = Date.now() + 20 * 60_000;

  if (req.provider.kind === "gemini") {
    const headers = { "Content-Type": "application/json", "x-goog-api-key": req.apiKey };
    const parameters: Record<string, unknown> = { aspectRatio: ASPECT[shape] };
    if (req.seconds) parameters.durationSeconds = req.seconds;
    const start = await httpFetch(`${base}/models/${encodeURIComponent(req.model.id)}:predictLongRunning`, {
      method: "POST",
      headers,
      signal: req.signal,
      body: JSON.stringify({ instances: [{ prompt: req.prompt }], parameters }),
    });
    if (!start.ok) throw new ProviderError(await readError(start), start.status);
    const op = (await start.json()) as { name: string };
    for (;;) {
      if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 20 minutes.");
      await sleep(req.pollMs ?? 8000, req.signal);
      const poll = await httpFetch(`${base}/${op.name}`, { headers, signal: req.signal });
      if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
      const st = (await poll.json()) as {
        done?: boolean;
        error?: { message?: string };
        response?: { generateVideoResponse?: { generatedSamples?: { video?: { uri?: string } }[]; raiMediaFilteredReasons?: string[] } };
      };
      req.onProgress?.("rendering");
      if (!st.done) continue;
      if (st.error) throw new ProviderError(st.error.message ?? "Video generation failed.");
      const uri = st.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) {
        const why = st.response?.generateVideoResponse?.raiMediaFilteredReasons?.join("; ");
        throw new ProviderError(why ? `Video was filtered: ${why}` : "The video model returned no video.");
      }
      const file = await httpFetch(uri, { headers: { "x-goog-api-key": req.apiKey }, signal: req.signal });
      if (!file.ok) throw new ProviderError(await readError(file), file.status);
      return { bytes: new Uint8Array(await file.arrayBuffer()), mime: "video/mp4" };
    }
  }

  if (req.provider.kind === "anthropic") throw new ProviderError("Claude does not generate video. Pick an OpenAI or Gemini video model in Settings → Models.");

  // OpenAI-style /videos job API
  const auth = { Authorization: `Bearer ${req.apiKey}` };
  const form = new FormData();
  form.set("model", req.model.id);
  form.set("prompt", req.prompt);
  form.set("size", shape === "portrait" ? "720x1280" : "1280x720");
  if (req.seconds) form.set("seconds", String(req.seconds));
  const start = await httpFetch(`${base}/videos`, { method: "POST", headers: auth, body: form, signal: req.signal });
  if (!start.ok) throw new ProviderError(await readError(start), start.status);
  let job = (await start.json()) as { id: string; status: string; progress?: number; error?: { message?: string } };
  while (job.status === "queued" || job.status === "in_progress") {
    if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 20 minutes.");
    await sleep(req.pollMs ?? 6000, req.signal);
    const poll = await httpFetch(`${base}/videos/${job.id}`, { headers: auth, signal: req.signal });
    if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
    job = await poll.json();
    req.onProgress?.(typeof job.progress === "number" ? `${job.progress}%` : job.status);
  }
  if (job.status !== "completed") throw new ProviderError(job.error?.message ?? `Video generation ${job.status}.`);
  const file = await httpFetch(`${base}/videos/${job.id}/content`, { headers: auth, signal: req.signal });
  if (!file.ok) throw new ProviderError(await readError(file), file.status);
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.headers.get("content-type") ?? "video/mp4" };
}
