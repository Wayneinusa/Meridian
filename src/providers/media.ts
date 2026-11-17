// Image and video generation for every provider that offers it.
//
//   OpenAI      /images/generations, /images/edits (multipart), /videos (Sora; optional start image)
//   xAI (Grok)  /images/generations, /images/edits (JSON, data-URI images), /videos/generations + /videos/{id}
//   Google      Imagen (:predict), Gemini image models (:generateContent, accept input images),
//               Veo (:predictLongRunning; optional start image)
//   OpenRouter  and other gateways: image-output chat models via /chat/completions with modalities
//   Others      OpenAI-style /images/generations and /videos when the server offers them
import { httpFetch, readError } from "../platform/http";
import type { MediaOptions, ModelInfo, ProviderConfig } from "../types";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { trimSlash } from "./common";
import { ProviderError } from "./types";

export interface MediaOutput {
  bytes: Uint8Array;
  mime: string;
}

export interface MediaInput {
  bytes: Uint8Array;
  mime: string;
  name: string;
}

interface Base {
  provider: ProviderConfig;
  apiKey: string;
  model: ModelInfo;
  prompt: string;
  options?: MediaOptions;
  /** images to edit, or to start a video from */
  inputs?: MediaInput[];
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
}

export type ImageRequest = Base;
export interface VideoRequest extends Base {
  /** how often to poll the job (ms) */
  pollMs?: number;
}

const dataUri = (i: MediaInput) => `data:${i.mime};base64,${bytesToBase64(i.bytes)}`;
const isImage = (i: MediaInput) => /^image\//.test(i.mime);

export function sniffImage(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x52 && head[1] === 0x49) return "image/webp";
  if (head[0] === 0x47 && head[1] === 0x49) return "image/gif";
  return "image/png";
}

function jsonHeaders(provider: ProviderConfig, apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(provider.headers ?? {}) };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await httpFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  return res.json();
}

async function download(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<MediaOutput> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new ProviderError("The provider returned an unreadable data URL.");
    const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return { bytes, mime: m[1] || sniffImage(bytes) };
  }
  const res = await httpFetch(url, { signal, headers });
  if (!res.ok) throw new ProviderError(`Could not download the result: ${await readError(res)}`, res.status);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  return { bytes, mime: type && !type.includes("octet-stream") ? type.split(";")[0] : sniffImage(bytes) };
}

/** Results in OpenAI's `{ data: [{ b64_json | url }] }` shape. */
async function readImageList(json: any, signal?: AbortSignal): Promise<MediaOutput[]> {
  const out: MediaOutput[] = [];
  for (const d of (json?.data ?? []) as { b64_json?: string; url?: string; respect_moderation?: boolean }[]) {
    if (d.respect_moderation === false) continue;
    if (d.b64_json) {
      const bytes = base64ToBytes(d.b64_json);
      out.push({ bytes, mime: sniffImage(bytes) });
    } else if (d.url) out.push(await download(d.url, signal));
  }
  return out;
}

const OPENAI_SIZE: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "4:3": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536", "3:4": "1024x1536" };
const DALLE3_SIZE: Record<string, string> = { "1:1": "1024x1024", "16:9": "1792x1024", "3:2": "1792x1024", "4:3": "1792x1024", "9:16": "1024x1792", "2:3": "1024x1792", "3:4": "1024x1792" };
const clampCount = (n?: number) => Math.min(Math.max(Math.round(n ?? 1), 1), 4);

// ---------------------------------------------------------------- images

export async function generateImages(req: ImageRequest): Promise<MediaOutput[]> {
  const { provider, model } = req;
  const inputs = (req.inputs ?? []).filter(isImage);
  let out: MediaOutput[];
  if (provider.kind === "anthropic") {
    throw new ProviderError("Claude models do not create images. Choose an image model from OpenAI, Google, xAI (Grok) or OpenRouter.");
  } else if (provider.kind === "gemini") {
    out = /imagen/i.test(model.id) ? await imagen(req, inputs) : await geminiImage(req, inputs);
  } else if (provider.kind === "xai") {
    out = await xaiImages(req, inputs);
  } else if (provider.kind === "openai") {
    out = await openaiImages(req, inputs);
  } else if (model.caps.imageOutput || model.kind === "chat") {
    out = await chatImages(req, inputs);
  } else {
    out = await compatibleImages(req, inputs);
  }
  if (!out.length) throw new ProviderError("The model returned no image. The prompt may have been blocked by the provider's content filter.");
  return out;
}

async function openaiImages(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const o = req.options ?? {};
  const dalle3 = /dall-e-3/.test(req.model.id);
  const dalle = /dall-e/.test(req.model.id);
  const n = dalle3 ? 1 : clampCount(o.count);
  const size = (dalle3 ? DALLE3_SIZE : OPENAI_SIZE)[o.aspect ?? "1:1"] ?? "1024x1024";
  if (inputs.length) {
    // edits are multipart; gpt-image models take several images as image[]
    const form = new FormData();
    form.set("model", req.model.id);
    form.set("prompt", req.prompt);
    form.set("n", String(n));
    if (!dalle) form.set("size", size);
    if (o.quality && !dalle) form.set("quality", o.quality);
    const field = dalle || inputs.length === 1 ? "image" : "image[]";
    for (const i of dalle ? inputs.slice(0, 1) : inputs.slice(0, 16)) form.append(field, new Blob([i.bytes as BlobPart], { type: i.mime }), i.name);
    const headers: Record<string, string> = { ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}), ...(req.provider.headers ?? {}) };
    if (dalle) form.set("response_format", "b64_json");
    const res = await httpFetch(`${base}/images/edits`, { method: "POST", headers, body: form, signal: req.signal });
    if (!res.ok) throw new ProviderError(await readError(res), res.status);
    return readImageList(await res.json(), req.signal);
  }
  const body: Record<string, unknown> = { model: req.model.id, prompt: req.prompt, n, size };
  if (dalle) body.response_format = "b64_json";
  if (o.quality && !dalle) body.quality = o.quality;
  if (dalle3 && o.quality === "high") body.quality = "hd";
  return readImageList(await postJson(`${base}/images/generations`, jsonHeaders(req.provider, req.apiKey), body, req.signal), req.signal);
}

async function xaiImages(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const o = req.options ?? {};
  const body: Record<string, unknown> = { model: req.model.id, prompt: req.prompt, n: clampCount(o.count), response_format: "b64_json" };
  if (o.aspect) body.aspect_ratio = o.aspect;
  if (o.resolution && /^\d(\.\d)?k$/.test(o.resolution)) body.resolution = o.resolution;
  if (inputs.length === 1) body.image = { url: dataUri(inputs[0]), type: "image_url" };
  else if (inputs.length > 1) body.images = inputs.slice(0, 5).map((i) => ({ url: dataUri(i), type: "image_url" }));
  const path = inputs.length ? "/images/edits" : "/images/generations";
  const json = await postJson(`${base}${path}`, jsonHeaders(req.provider, req.apiKey), body, req.signal);
  if ((json?.data ?? []).some((d: { respect_moderation?: boolean }) => d.respect_moderation === false)) {
    throw new ProviderError("xAI blocked this image under its content policy.");
  }
  return readImageList(json, req.signal);
}

async function imagen(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  if (inputs.length) req.onProgress?.("Imagen does not edit images; creating a new one from the prompt");
  const base = trimSlash(req.provider.baseUrl);
  const o = req.options ?? {};
  const parameters: Record<string, unknown> = { sampleCount: clampCount(o.count), aspectRatio: o.aspect === "3:2" || o.aspect === "2:3" ? "1:1" : (o.aspect ?? "1:1") };
  if (o.resolution === "2k" || o.resolution === "2K") parameters.sampleImageSize = "2K";
  const json = await postJson(
    `${base}/models/${encodeURIComponent(req.model.id)}:predict`,
    { "Content-Type": "application/json", "x-goog-api-key": req.apiKey },
    { instances: [{ prompt: req.prompt }], parameters },
    req.signal,
  );
  return ((json.predictions ?? []) as { bytesBase64Encoded?: string; mimeType?: string }[])
    .filter((p) => p.bytesBase64Encoded)
    .map((p) => ({ bytes: base64ToBytes(p.bytesBase64Encoded!), mime: p.mimeType ?? "image/png" }));
}

async function geminiImage(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const parts: Record<string, unknown>[] = inputs.map((i) => ({ inlineData: { mimeType: i.mime, data: bytesToBase64(i.bytes) } }));
  parts.push({ text: req.prompt });
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (req.options?.aspect) generationConfig.imageConfig = { aspectRatio: req.options.aspect };
  const out: MediaOutput[] = [];
  const runs = clampCount(req.options?.count);
  for (let i = 0; i < runs; i++) {
    const json = await postJson(
      `${base}/models/${encodeURIComponent(req.model.id)}:generateContent`,
      { "Content-Type": "application/json", "x-goog-api-key": req.apiKey },
      { contents: [{ role: "user", parts }], generationConfig },
      req.signal,
    );
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) out.push({ bytes: base64ToBytes(part.inlineData.data), mime: part.inlineData.mimeType ?? "image/png" });
    }
    const block = json.promptFeedback?.blockReason ?? (/SAFETY|PROHIBITED/.test(json.candidates?.[0]?.finishReason ?? "") ? json.candidates[0].finishReason : "");
    if (block && !out.length) throw new ProviderError(`Google blocked this image (${block}).`);
  }
  return out;
}

/** OpenRouter and similar gateways: image-output models answer through chat completions. */
async function chatImages(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const content: Record<string, unknown>[] = inputs.map((i) => ({ type: "image_url", image_url: { url: dataUri(i) } }));
  content.push({ type: "text", text: req.prompt });
  const body: Record<string, unknown> = {
    model: req.model.id,
    messages: [{ role: "user", content }],
    modalities: ["image", "text"],
    stream: false,
  };
  if (req.options?.aspect) body.image_config = { aspect_ratio: req.options.aspect };
  const out: MediaOutput[] = [];
  const runs = clampCount(req.options?.count);
  for (let i = 0; i < runs; i++) {
    const json = await postJson(`${base}/chat/completions`, jsonHeaders(req.provider, req.apiKey), body, req.signal);
    const msg = json.choices?.[0]?.message ?? {};
    for (const img of (msg.images ?? []) as { image_url?: { url?: string } }[]) {
      if (img.image_url?.url) out.push(await download(img.image_url.url, req.signal));
    }
    // some servers put the image in content parts instead
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) if (c?.type === "image_url" && c.image_url?.url) out.push(await download(c.image_url.url, req.signal));
    }
  }
  return out;
}

async function compatibleImages(req: ImageRequest, inputs: MediaInput[]): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const o = req.options ?? {};
  const headers = jsonHeaders(req.provider, req.apiKey);
  const full: Record<string, unknown> = { model: req.model.id, prompt: req.prompt, n: clampCount(o.count), response_format: "b64_json", size: OPENAI_SIZE[o.aspect ?? "1:1"] };
  if (inputs.length) full.image = dataUri(inputs[0]);
  try {
    return await readImageList(await postJson(`${base}/images/generations`, headers, full, req.signal), req.signal);
  } catch (e) {
    // many servers reject fields they do not know; retry with the bare minimum
    if (!(e instanceof ProviderError) || e.status !== 400) throw e;
    return readImageList(await postJson(`${base}/images/generations`, headers, { model: req.model.id, prompt: req.prompt }, req.signal), req.signal);
  }
}

// ---------------------------------------------------------------- video

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

const VIDEO_DEADLINE_MS = 30 * 60_000;

export async function generateVideo(req: VideoRequest): Promise<MediaOutput> {
  const inputs = (req.inputs ?? []).filter(isImage);
  switch (req.provider.kind) {
    case "anthropic":
      throw new ProviderError("Claude models do not create video. Choose a video model from OpenAI (Sora), Google (Veo) or xAI (Grok Imagine).");
    case "gemini":
      return veo(req, inputs[0]);
    case "xai":
      return xaiVideo(req, inputs[0]);
    default:
      return openaiVideo(req, inputs[0]);
  }
}

async function veo(req: VideoRequest, image?: MediaInput): Promise<MediaOutput> {
  const base = trimSlash(req.provider.baseUrl);
  const headers = { "Content-Type": "application/json", "x-goog-api-key": req.apiKey };
  const o = req.options ?? {};
  const instance: Record<string, unknown> = { prompt: req.prompt };
  if (image) instance.image = { bytesBase64Encoded: bytesToBase64(image.bytes), mimeType: image.mime };
  const parameters: Record<string, unknown> = { aspectRatio: o.aspect === "9:16" ? "9:16" : "16:9" };
  if (o.seconds) parameters.durationSeconds = o.seconds;
  if (o.resolution && /^(720p|1080p)$/.test(o.resolution)) parameters.resolution = o.resolution;
  const op = await postJson(`${base}/models/${encodeURIComponent(req.model.id)}:predictLongRunning`, headers, { instances: [instance], parameters }, req.signal);
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  req.onProgress?.("queued");
  for (;;) {
    if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 30 minutes.");
    await sleep(req.pollMs ?? 8000, req.signal);
    const poll = await httpFetch(`${base}/${op.name}`, { headers, signal: req.signal });
    if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
    const st = await poll.json();
    if (!st.done) {
      req.onProgress?.("rendering");
      continue;
    }
    if (st.error) throw new ProviderError(st.error.message ?? "Video generation failed.");
    const r = st.response?.generateVideoResponse;
    const uri = r?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      const why = r?.raiMediaFilteredReasons?.join("; ");
      throw new ProviderError(why ? `Google filtered this video: ${why}` : "The video model returned no video.");
    }
    req.onProgress?.("downloading");
    const file = await download(uri, req.signal, { "x-goog-api-key": req.apiKey });
    return { bytes: file.bytes, mime: file.mime.startsWith("video/") ? file.mime : "video/mp4" };
  }
}

async function xaiVideo(req: VideoRequest, image?: MediaInput): Promise<MediaOutput> {
  const base = trimSlash(req.provider.baseUrl);
  const headers = jsonHeaders(req.provider, req.apiKey);
  const o = req.options ?? {};
  const body: Record<string, unknown> = { model: req.model.id, prompt: req.prompt };
  if (o.seconds) body.duration = o.seconds;
  if (o.aspect) body.aspect_ratio = o.aspect;
  if (o.resolution && /^(480p|720p|1080p)$/.test(o.resolution)) body.resolution = o.resolution;
  if (image) body.image = { url: dataUri(image) };
  const start = await postJson(`${base}/videos/generations`, headers, body, req.signal);
  const id = start.request_id ?? start.id;
  if (!id) throw new ProviderError("xAI did not return a video request id.");
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  req.onProgress?.("queued");
  for (;;) {
    if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 30 minutes.");
    await sleep(req.pollMs ?? 5000, req.signal);
    const poll = await httpFetch(`${base}/videos/${encodeURIComponent(id)}`, { headers, signal: req.signal });
    if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
    const st = await poll.json();
    if (st.status === "expired") throw new ProviderError("The video request expired before it finished.");
    if (st.status === "failed") throw new ProviderError(`Video generation failed: ${st.error?.message ?? st.error?.code ?? "unknown error"}`);
    const url = st.video?.url ?? st.video?.file_output?.public_url;
    if (st.status === "done" || (!st.status && url)) {
      if (st.video?.respect_moderation === false) throw new ProviderError("xAI blocked this video under its content policy.");
      if (!url) throw new ProviderError("The video finished but xAI returned no address for it.");
      req.onProgress?.("downloading");
      const file = await download(url, req.signal);
      return { bytes: file.bytes, mime: file.mime.startsWith("video/") ? file.mime : "video/mp4" };
    }
    req.onProgress?.(typeof st.progress === "number" ? `${Math.round(st.progress)}%` : "rendering");
  }
}

/** Sora-style job API: POST /videos, GET /videos/{id}, GET /videos/{id}/content. */
async function openaiVideo(req: VideoRequest, image?: MediaInput): Promise<MediaOutput> {
  const base = trimSlash(req.provider.baseUrl);
  const auth: Record<string, string> = { ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {}), ...(req.provider.headers ?? {}) };
  const o = req.options ?? {};
  const portrait = o.aspect === "9:16" || o.aspect === "3:4" || o.aspect === "2:3";
  const hd = o.resolution === "1080p" && /pro/.test(req.model.id);
  const form = new FormData();
  form.set("model", req.model.id);
  form.set("prompt", req.prompt);
  form.set("size", portrait ? (hd ? "1024x1792" : "720x1280") : hd ? "1792x1024" : "1280x720");
  if (o.seconds) {
    // Sora takes 4, 8 or 12 seconds
    const allowed = [4, 8, 12];
    form.set("seconds", String(allowed.reduce((a, b) => (Math.abs(b - o.seconds!) < Math.abs(a - o.seconds!) ? b : a))));
  }
  if (image) form.set("input_reference", new Blob([image.bytes as BlobPart], { type: image.mime }), image.name);
  const start = await httpFetch(`${base}/videos`, { method: "POST", headers: auth, body: form, signal: req.signal });
  if (!start.ok) throw new ProviderError(await readError(start), start.status);
  let job = (await start.json()) as { id: string; status: string; progress?: number; error?: { message?: string } };
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  while (job.status === "queued" || job.status === "in_progress") {
    if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 30 minutes.");
    req.onProgress?.(typeof job.progress === "number" ? `${job.progress}%` : job.status.replace("_", " "));
    await sleep(req.pollMs ?? 6000, req.signal);
    const poll = await httpFetch(`${base}/videos/${job.id}`, { headers: auth, signal: req.signal });
    if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
    job = await poll.json();
  }
  if (job.status !== "completed") throw new ProviderError(job.error?.message ?? `Video generation ${job.status}.`);
  req.onProgress?.("downloading");
  const file = await httpFetch(`${base}/videos/${job.id}/content`, { headers: auth, signal: req.signal });
  if (!file.ok) throw new ProviderError(await readError(file), file.status);
  return { bytes: new Uint8Array(await file.arrayBuffer()), mime: (file.headers.get("content-type") ?? "video/mp4").split(";")[0] };
}

// ---------------------------------------------------------------- defaults

const IMAGE_PREFERENCE = [/grok-imagine-image/, /gpt-image-1\.5/, /gpt-image-1(?!-mini)/, /gpt-image/, /imagen-4/, /gemini-.*-image/, /imagen/, /dall-e-3/, /image/];
const VIDEO_PREFERENCE = [/veo-3/, /sora-2-pro/, /sora-2/, /grok-imagine-video/, /veo/, /sora/, /video/];

/** The best available model of a kind, for when the user has not chosen one. */
export function pickDefaultMedia(providers: ProviderConfig[], kind: "image" | "video"): { providerId: string; modelId: string } | undefined {
  const candidates: { providerId: string; model: ModelInfo }[] = [];
  for (const p of providers) {
    if (!p.enabled || (!p.hasKey && p.kind !== "openai-compatible")) continue;
    for (const m of p.models) {
      if (m.kind === kind || (kind === "image" && m.caps.imageOutput)) candidates.push({ providerId: p.id, model: m });
    }
  }
  for (const re of kind === "image" ? IMAGE_PREFERENCE : VIDEO_PREFERENCE) {
    const hit = candidates.find((c) => re.test(c.model.id));
    if (hit) return { providerId: hit.providerId, modelId: hit.model.id };
  }
  const first = candidates[0];
  return first ? { providerId: first.providerId, modelId: first.model.id } : undefined;
}
