// Free and free-credit image / video services, plus custom endpoints.
//
//   Pollinations   no key: one model, an image every 45 s (small logo)
//                  free key (enter.pollinations.ai): every model, video, quest credits
//   AI Horde       crowd-sourced Stable Diffusion / Flux; anonymous key 0000000000 works
//   Cloudflare     Workers AI, free daily allowance; account id + API token
//   fal.ai         queue API for hundreds of image and video models (paid; trial credits)
//   Runway         Gen-4 image and video (paid credits)
//   Custom         any server, described by request templates (see MediaHttpSpec)
import { httpFetch, readError } from "../platform/http";
import type { MediaHttpSpec, MediaOptions, ModelInfo, ProviderConfig, ProviderKind } from "../types";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
import { fillTemplate } from "../util/template";
import { trimSlash } from "./common";
import {
  clampCount,
  dataUri,
  download,
  getJson,
  mediaFromResult,
  pick,
  postJson,
  readBody,
  sizeFor,
  sleep,
  sniffMedia,
  type MediaInput,
  type MediaOutput,
} from "./mediaUtil";
import { ProviderError } from "./types";

export interface BackendRequest {
  provider: ProviderConfig;
  apiKey: string;
  model: ModelInfo;
  prompt: string;
  options?: MediaOptions;
  inputs?: MediaInput[];
  signal?: AbortSignal;
  onProgress?: (note: string) => void;
  pollMs?: number;
}

export type Pricing = "free" | "free-credits" | "trial" | "paid" | "custom";

export interface BackendInfo {
  kind: ProviderKind;
  name: string;
  defaultBaseUrl: string;
  pricing: Pricing;
  /** one line for pickers */
  tagline: string;
  /** what works without a key */
  keyless: "all" | "image" | "none";
  keyLabel: string;
  keyUrl?: string;
  needsAccountId?: boolean;
  makes: ("image" | "video")[];
  /** setup steps shown in Settings */
  help: string;
}

export const BACKENDS: Partial<Record<ProviderKind, BackendInfo>> = {
  pollinations: {
    kind: "pollinations",
    name: "Pollinations",
    defaultBaseUrl: "https://gen.pollinations.ai",
    pricing: "free",
    tagline: "Free images with no sign-up; a free key adds 50+ models and video",
    keyless: "image",
    keyLabel: "Pollinations key (sk_…, optional)",
    keyUrl: "https://enter.pollinations.ai",
    makes: ["image", "video"],
    help:
      "Works right away with no key: one image model, one image every 45 seconds, with a small logo. For every image model, video, no logo and no wait, sign in at enter.pollinations.ai, create a secret key (sk_…) and paste it here. New accounts earn free credits (“pollen”) from quests; models marked paid-only need a top-up.",
  },
  horde: {
    kind: "horde",
    name: "AI Horde",
    defaultBaseUrl: "https://aihorde.net/api/v2",
    pricing: "free",
    tagline: "Free community GPUs (Stable Diffusion, Flux); queues can take a few minutes",
    keyless: "all",
    keyLabel: "AI Horde key (optional)",
    keyUrl: "https://aihorde.net/register",
    makes: ["image"],
    help:
      "Free, run by volunteers. Without a key you are anonymous (key 0000000000) and wait behind registered users. Register at aihorde.net for a free key: you get priority, and kudos for sharing your own GPU.",
  },
  cloudflare: {
    kind: "cloudflare",
    name: "Cloudflare Workers AI",
    defaultBaseUrl: "https://api.cloudflare.com/client/v4",
    pricing: "free-credits",
    tagline: "Free daily allowance (FLUX, Stable Diffusion); needs a free account",
    keyless: "none",
    keyLabel: "API token",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    needsAccountId: true,
    makes: ["image"],
    help:
      "Create a free Cloudflare account. Copy your Account ID (Account home → the ⋯ next to the account name, or the right side of any Workers page). Then create an API token with the “Workers AI” template. The free allowance of 10,000 Neurons resets every day at 00:00 UTC, enough for dozens of FLUX schnell images.",
  },
  fal: {
    kind: "fal",
    name: "fal.ai",
    defaultBaseUrl: "https://queue.fal.run",
    pricing: "trial",
    tagline: "Hundreds of image and video models (Flux, Kling, Wan, MiniMax); pay per use",
    keyless: "none",
    keyLabel: "fal key",
    keyUrl: "https://fal.ai/dashboard/keys",
    makes: ["image", "video"],
    help: "Sign up at fal.ai and create a key. Pay as you go; promotions sometimes add trial credits. Add any model from fal.ai/models with its id (for example fal-ai/flux/dev) in the Model ID field.",
  },
  runway: {
    kind: "runway",
    name: "Runway",
    defaultBaseUrl: "https://api.dev.runwayml.com/v1",
    pricing: "paid",
    tagline: "Gen-4 images and video; buy API credits",
    keyless: "none",
    keyLabel: "Runway API key",
    keyUrl: "https://dev.runwayml.com",
    makes: ["image", "video"],
    help: "Create a key at dev.runwayml.com and buy credits there (the API does not use a Runway app subscription). Gen-4 Turbo animates a picture: attach one when you make a video.",
  },
  "custom-media": {
    kind: "custom-media",
    name: "Custom image/video endpoint",
    defaultBaseUrl: "",
    pricing: "custom",
    tagline: "Your own or any other server: OpenAI-style, xAI-style, fal-style or described by templates",
    keyless: "all",
    keyLabel: "Key (optional)",
    makes: ["image", "video"],
    help:
      "For self-hosted servers and free trials. By default images use POST {endpoint}/images/generations and video POST {endpoint}/videos (the OpenAI shapes most servers copy). Choose another video API, or describe the request with a template, below.",
  },
};

export const isMediaOnly = (kind: ProviderKind) => kind in BACKENDS || kind === "plugin";

/** "AI Horde · Auto" for image / video services, whose model names mean little alone; the model name otherwise. */
export function modelLabel(p: ProviderConfig, m: ModelInfo): string {
  return isMediaOnly(p.kind) ? `${p.name} · ${m.name}` : m.name;
}

/** Can this provider be used right now (key present where one is required)? */
export function providerReady(p: ProviderConfig, kind?: "image" | "video"): boolean {
  if (!p.enabled) return false;
  if (p.kind === "openai-compatible" || p.kind === "plugin") return true;
  const b = BACKENDS[p.kind];
  if (!b) return !!p.hasKey || !!p.signedIn;
  if (b.needsAccountId && !p.accountId) return false;
  if (p.hasKey || b.keyless === "all") return true;
  return b.keyless === "image" && kind !== "video";
}

const model = (id: string, name: string, kind: "image" | "video", vision = false): ModelInfo => ({
  id,
  name,
  kind,
  caps: { vision, pdf: false, tools: false, thinking: false },
});

// ---------------------------------------------------------------- Pollinations

export const POLLINATIONS_CLASSIC = "classic";
const CLASSIC_URL = "https://image.pollinations.ai/prompt/";
const POLLINATIONS_MEDIA = "https://media.pollinations.ai/upload";

const POLLINATIONS_KEYED: ModelInfo[] = [
  model("tongyi-mai/z-image-turbo", "Z-Image Turbo", "image"),
  model("black-forest-labs/flux.1-schnell", "FLUX.1 schnell", "image"),
  model("black-forest-labs/flux.2-klein-4b", "FLUX.2 klein 4B", "image", true),
  model("openai/gpt-image-1-mini", "GPT Image 1 mini", "image", true),
  model("bytedance/seedream-5.0-lite", "Seedream 5.0 lite", "image", true),
  model("qwen/qwen-image", "Qwen Image", "image", true),
  model("alibaba/wan-2.2-fast", "Wan 2.2 fast", "video", true),
  model("bytedance/seedance-2.0-mini", "Seedance 2.0 mini", "video", true),
  model("x-ai/grok-imagine-video-1.5-lite", "Grok Imagine Video 1.5 lite", "video", true),
  model("alibaba/wan-2.6", "Wan 2.6", "video", true),
  model("google/veo-3.1-fast", "Veo 3.1 fast", "video", true),
];

export const POLLINATIONS_DEFAULT_MODELS: ModelInfo[] = [model(POLLINATIONS_CLASSIC, "Classic (free, no key)", "image")];

async function pollinationsModels(p: ProviderConfig, key: string): Promise<ModelInfo[]> {
  const out = [...POLLINATIONS_DEFAULT_MODELS];
  if (!key) return out;
  try {
    const list = (await getJson(`${trimSlash(p.baseUrl)}/image/models`, { Authorization: `Bearer ${key}` })) as {
      name: string;
      title?: string;
      output_modalities?: string[];
      input_modalities?: string[];
      paid_only?: boolean;
      community?: boolean;
      pricing?: Record<string, unknown>;
    }[];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m?.name || m.paid_only || m.community) continue;
      const video = (m.output_modalities ?? []).includes("video");
      if (!video && !(m.output_modalities ?? ["image"]).includes("image")) continue;
      out.push(model(m.name, m.title || m.name, video ? "video" : "image", (m.input_modalities ?? []).includes("image")));
    }
    if (out.length > 1) return out;
  } catch {
    /* fall back to the known list */
  }
  return [...out, ...POLLINATIONS_KEYED];
}

/** Pollinations takes reference images by URL: upload ours to its media store first (needs a key). */
async function pollinationsUpload(inputs: MediaInput[], key: string, signal?: AbortSignal): Promise<string[]> {
  const urls: string[] = [];
  for (const i of inputs.slice(0, 4)) {
    const r = await postJson(POLLINATIONS_MEDIA, { Authorization: `Bearer ${key}` }, { data: bytesToBase64(i.bytes), contentType: i.mime, name: i.name }, signal);
    if (r?.url) urls.push(r.url);
  }
  return urls;
}

async function pollinationsClassic(req: BackendRequest): Promise<MediaOutput[]> {
  const { width, height } = sizeFor(req.options?.aspect, 768, 8);
  const n = clampCount(req.options?.count);
  const out: MediaOutput[] = [];
  if (req.inputs?.length) req.onProgress?.("the free model cannot edit pictures; making a new one");
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(Math.random() * 2_000_000_000);
    const url = `${CLASSIC_URL}${encodeURIComponent(req.prompt.slice(0, 1800))}?width=${width}&height=${height}&seed=${seed}`;
    for (let attempt = 0; ; attempt++) {
      if (n > 1) req.onProgress?.(`image ${i + 1} of ${n}`);
      const res = await httpFetch(url, { signal: req.signal });
      if (res.ok) {
        const file = await readBody(res);
        if (!file.mime.startsWith("image/")) throw new ProviderError("Pollinations answered without an image. Try again in a minute.");
        out.push(file);
        break;
      }
      // free requests are one at a time, 45 s apart: wait for the next slot
      if ((res.status === 402 || res.status === 429) && attempt < 3) {
        const wait = Math.min(Number(res.headers.get("retry-after")) || 45, 120);
        for (let left = wait; left > 0; left -= 5) {
          req.onProgress?.(`free slot in ${left} s`);
          await sleep(Math.min(5, left) * 1000, req.signal);
        }
        continue;
      }
      if (res.status === 402) throw new ProviderError("The free Pollinations limit is reached (one image every 45 seconds). Wait a minute, or add a free key in Settings → Providers & keys for no limit.", 402);
      throw new ProviderError(await readError(res), res.status);
    }
  }
  return out;
}

async function pollinationsImages(req: BackendRequest): Promise<MediaOutput[]> {
  if (req.model.id === POLLINATIONS_CLASSIC || !req.apiKey) {
    if (req.model.id !== POLLINATIONS_CLASSIC) req.onProgress?.("no Pollinations key: using the free model");
    return pollinationsClassic(req);
  }
  const base = trimSlash(req.provider.baseUrl);
  const headers = { Authorization: `Bearer ${req.apiKey}` };
  const { width, height } = sizeFor(req.options?.aspect, 1024, 16);
  const refs = req.inputs?.length ? await pollinationsUpload(req.inputs, req.apiKey, req.signal) : [];
  const out: MediaOutput[] = [];
  const n = clampCount(req.options?.count);
  for (let i = 0; i < n; i++) {
    const q = new URLSearchParams({ model: req.model.id, width: String(width), height: String(height), seed: String(Math.floor(Math.random() * 2_000_000_000)) });
    if (req.options?.quality && req.options.quality !== "auto") q.set("quality", req.options.quality);
    if (refs.length) q.set("image", refs.join("|"));
    const res = await httpFetch(`${base}/image/${encodeURIComponent(req.prompt.slice(0, 4000))}?${q}`, { headers, signal: req.signal });
    if (!res.ok) throw new ProviderError(pollinationsError(res.status, await readError(res)), res.status);
    out.push(await readBody(res));
  }
  return out;
}

function pollinationsError(status: number, text: string): string {
  if (status === 401) return "Pollinations did not accept the key. Paste a secret key (sk_…) from enter.pollinations.ai.";
  if (status === 402) return "Your Pollinations credits are used up. Earn more from quests on enter.pollinations.ai, or choose a cheaper model.";
  if (status === 403) return `This Pollinations model needs paid credits or a key with permission for it. ${text}`;
  return text;
}

async function pollinationsVideo(req: BackendRequest): Promise<MediaOutput> {
  if (!req.apiKey) {
    throw new ProviderError("Pollinations makes video with a free key. Get one at enter.pollinations.ai (free credits from quests) and paste it in Settings → Providers & keys → Pollinations.");
  }
  if (req.model.id === POLLINATIONS_CLASSIC) throw new ProviderError("Pollinations Classic makes images only. Choose a Pollinations video model.");
  const base = trimSlash(req.provider.baseUrl);
  const headers = { Authorization: `Bearer ${req.apiKey}` };
  const o = req.options ?? {};
  const q = new URLSearchParams({ model: req.model.id });
  if (o.seconds) q.set("duration", String(o.seconds));
  q.set("aspectRatio", o.aspect === "9:16" || o.aspect === "1:1" ? o.aspect : "16:9");
  if (o.resolution) q.set("resolution", o.resolution);
  const refs = req.inputs?.length ? await pollinationsUpload(req.inputs.slice(0, 1), req.apiKey, req.signal) : [];
  if (refs.length) q.set("image", refs[0]);
  const res = await httpFetch(`${base}/video/${encodeURIComponent(req.prompt.slice(0, 4000))}?${q}`, { headers: { ...headers, Prefer: "respond-async" }, signal: req.signal });
  if (!res.ok) throw new ProviderError(pollinationsError(res.status, await readError(res)), res.status);
  if (res.status !== 202) return asVideo(await readBody(res));
  const job = (await res.json()) as { id: string; status_url?: string };
  const statusUrl = job.status_url ?? `${base}/v1/jobs/${encodeURIComponent(job.id)}`;
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  req.onProgress?.("queued");
  for (;;) {
    if (Date.now() > deadline) throw new ProviderError("Video generation timed out after 30 minutes.");
    await sleep(req.pollMs ?? 5000, req.signal);
    const st = await getJson(statusUrl, headers, req.signal);
    if (st.status === "failed") throw new ProviderError(`Video generation failed: ${typeof st.error === "string" ? st.error : (st.error?.message ?? "unknown error")}`);
    if (st.status === "succeeded") {
      req.onProgress?.("downloading");
      return asVideo(await download(st.result_url ?? `${base}/v1/jobs/${encodeURIComponent(job.id)}/result`, req.signal, headers));
    }
    req.onProgress?.(st.status === "pending" ? "queued" : "rendering");
  }
}

// ---------------------------------------------------------------- AI Horde

export const HORDE_ANON_KEY = "0000000000";
export const HORDE_AUTO = "auto";
export const HORDE_DEFAULT_MODELS: ModelInfo[] = [model(HORDE_AUTO, "Auto (best available)", "image", true)];
const HORDE_PREFERENCE = [/^AlbedoBase XL/i, /^Flux\.?1.*schnell/i, /juggernaut.*xl/i, /SDXL/i, /\bXL\b/i];

const hordeHeaders = (key: string) => ({ apikey: key || HORDE_ANON_KEY, "Client-Agent": "Meridian:1:anonymous" });

interface HordeModel {
  name: string;
  count: number;
  queued?: number;
  eta?: number;
}

async function hordeStatus(base: string, key: string, signal?: AbortSignal): Promise<HordeModel[]> {
  const list = (await getJson(`${base}/status/models?type=image`, hordeHeaders(key), signal)) as HordeModel[];
  return (Array.isArray(list) ? list : []).filter((m) => m.count > 0).sort((a, b) => b.count - a.count);
}

async function hordeModels(p: ProviderConfig, key: string): Promise<ModelInfo[]> {
  const live = await hordeStatus(trimSlash(p.baseUrl), key);
  return [...HORDE_DEFAULT_MODELS, ...live.slice(0, 80).map((m) => model(m.name, `${m.name} · ${m.count} worker${m.count === 1 ? "" : "s"}`, "image", true))];
}

async function hordeImages(req: BackendRequest): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl);
  const headers = hordeHeaders(req.apiKey);
  let name = req.model.id;
  if (name === HORDE_AUTO) {
    const live = await hordeStatus(base, req.apiKey, req.signal).catch(() => [] as HordeModel[]);
    name = HORDE_PREFERENCE.map((re) => live.find((m) => re.test(m.name))?.name).find(Boolean) ?? live[0]?.name ?? "";
  }
  const big = /xl|flux|sd3|pony|illustrious|noob|qwen|chroma/i.test(name);
  const flux = /flux/i.test(name);
  const { width, height } = sizeFor(req.options?.aspect, big ? 1024 : 576, 64);
  const params: Record<string, unknown> = {
    width,
    height,
    n: clampCount(req.options?.count),
    steps: flux ? 4 : 25,
    cfg_scale: flux ? 1 : 6,
    sampler_name: flux ? "k_euler" : "k_euler_a",
    karras: !flux,
  };
  const body: Record<string, unknown> = { prompt: req.prompt, params, nsfw: false, censor_nsfw: true, r2: true, shared: false, trusted_workers: false, slow_workers: true };
  if (name) body.models = [name];
  const src = req.inputs?.[0];
  if (src) {
    body.source_image = bytesToBase64(src.bytes);
    body.source_processing = "img2img";
    params.denoising_strength = 0.65;
  }
  const start = await postJson(`${base}/generate/async`, headers, body, req.signal);
  const id = start.id as string;
  if (!id) throw new ProviderError(`AI Horde did not accept the request${start.message ? `: ${start.message}` : "."}`);
  const cancel = () => void httpFetch(`${base}/generate/status/${id}`, { method: "DELETE", headers }).catch(() => undefined);
  req.signal?.addEventListener("abort", cancel);
  const deadline = Date.now() + 20 * 60_000;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        cancel();
        throw new ProviderError("AI Horde did not finish within 20 minutes. Try a model with more workers, or add a free key for priority.");
      }
      await sleep(req.pollMs ?? 5000, req.signal);
      const st = await getJson(`${base}/generate/check/${id}`, headers, req.signal);
      if (st.faulted) throw new ProviderError("An AI Horde worker failed on this request. Try again or choose another model.");
      if (st.is_possible === false) {
        cancel();
        throw new ProviderError("No AI Horde worker can run this request right now. Choose another model (Settings → Providers & keys → AI Horde → Fetch model list) or try later.");
      }
      if (st.done) break;
      req.onProgress?.(st.processing > 0 ? "rendering" : st.queue_position ? `queue position ${st.queue_position}${st.wait_time ? ` · about ${st.wait_time} s` : ""}` : "waiting for a worker");
    }
  } finally {
    req.signal?.removeEventListener("abort", cancel);
  }
  req.onProgress?.("downloading");
  const done = await getJson(`${base}/generate/status/${id}`, headers, req.signal);
  const gens = ((done.generations ?? []) as { img?: string; censored?: boolean }[]).filter((g) => g.img && !g.censored);
  if (!gens.length) throw new ProviderError("The AI Horde safety filter blocked this image. Change the prompt and try again.");
  const out: MediaOutput[] = [];
  for (const g of gens) out.push(...(await mediaFromResult(g.img, "image", req.signal, 1)));
  return out;
}

// ---------------------------------------------------------------- Cloudflare Workers AI

const CF_MODELS: ModelInfo[] = [
  model("@cf/black-forest-labs/flux-1-schnell", "FLUX.1 schnell (fast, cheapest)", "image"),
  model("@cf/black-forest-labs/flux-2-klein-4b", "FLUX.2 klein 4B", "image", true),
  model("@cf/leonardo/lucid-origin", "Leonardo Lucid Origin", "image"),
  model("@cf/leonardo/phoenix-1.0", "Leonardo Phoenix 1.0", "image"),
  model("@cf/bytedance/stable-diffusion-xl-lightning", "SDXL Lightning", "image"),
  model("@cf/stabilityai/stable-diffusion-xl-base-1.0", "Stable Diffusion XL", "image"),
  model("@cf/lykon/dreamshaper-8-lcm", "DreamShaper 8 LCM", "image"),
];
export const CLOUDFLARE_DEFAULT_MODELS = CF_MODELS;

function cfBase(p: ProviderConfig): string {
  if (!p.accountId) throw new ProviderError("Enter your Cloudflare account ID in Settings → Providers & keys → Cloudflare Workers AI.");
  return `${trimSlash(p.baseUrl || BACKENDS.cloudflare!.defaultBaseUrl)}/accounts/${encodeURIComponent(p.accountId.trim())}/ai`;
}

async function cloudflareModels(p: ProviderConfig, key: string): Promise<ModelInfo[]> {
  if (!key || !p.accountId) return CF_MODELS;
  try {
    const j = await getJson(`${cfBase(p)}/models/search?task=Text-to-Image&per_page=100`, { Authorization: `Bearer ${key}` });
    const list = ((j.result ?? []) as { name: string; description?: string }[]).filter((m) => m.name?.startsWith("@cf/"));
    if (!list.length) return CF_MODELS;
    const known = new Map(CF_MODELS.map((m) => [m.id, m]));
    return list
      .map((m) => known.get(m.name) ?? model(m.name, m.name.split("/").pop()!, "image"))
      .sort((a, b) => CF_MODELS.findIndex((x) => x.id === a.id) - CF_MODELS.findIndex((x) => x.id === b.id) || 0);
  } catch {
    return CF_MODELS;
  }
}

async function cloudflareImages(req: BackendRequest): Promise<MediaOutput[]> {
  const url = `${cfBase(req.provider)}/run/${req.model.id}`;
  const auth = { Authorization: `Bearer ${req.apiKey}` };
  const id = req.model.id;
  const { width, height } = sizeFor(req.options?.aspect, 1024, 64);
  const out: MediaOutput[] = [];
  const n = clampCount(req.options?.count);
  for (let i = 0; i < n; i++) {
    if (n > 1) req.onProgress?.(`image ${i + 1} of ${n}`);
    let res: Response;
    if (/flux-2/.test(id)) {
      // FLUX.2 on Workers AI takes multipart form data (and reference images)
      const form = new FormData();
      form.set("prompt", req.prompt);
      form.set("width", String(width));
      form.set("height", String(height));
      (req.inputs ?? []).slice(0, 4).forEach((img, k) => form.set(`input_image_${k}`, new Blob([img.bytes as BlobPart], { type: img.mime }), img.name));
      res = await httpFetch(url, { method: "POST", headers: auth, body: form, signal: req.signal });
    } else {
      let body: Record<string, unknown>;
      if (/flux-1-schnell/.test(id)) body = { prompt: req.prompt, steps: 8 };
      else if (/stable-diffusion|dreamshaper/.test(id)) body = { prompt: req.prompt, width, height, num_steps: /lightning|lcm/.test(id) ? 8 : 20 };
      else body = { prompt: req.prompt, width, height };
      res = await httpFetch(url, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: req.signal });
    }
    if (!res.ok) {
      const text = await readError(res);
      if (res.status === 429 || /neuron|allocation|quota/i.test(text)) throw new ProviderError(`Today's free Cloudflare allowance is used up (it resets at 00:00 UTC). ${text}`, res.status);
      throw new ProviderError(text, res.status);
    }
    const type = res.headers.get("content-type") ?? "";
    if (/^image\//.test(type)) out.push(await readBody(res));
    else {
      const j = await res.json();
      const b64 = j?.result?.image;
      if (typeof b64 === "string" && b64 && !/^https?:/.test(b64)) {
        const bytes = base64ToBytes(b64.replace(/^data:[^,]+,/, ""));
        out.push({ bytes, mime: sniffMedia(bytes) });
      } else out.push(...(await mediaFromResult(j, "image", req.signal, 1)));
    }
  }
  return out;
}

// ---------------------------------------------------------------- fal.ai

export const FAL_DEFAULT_MODELS: ModelInfo[] = [
  model("fal-ai/flux/schnell", "FLUX.1 schnell", "image"),
  model("fal-ai/flux/dev", "FLUX.1 dev", "image"),
  model("fal-ai/flux-pro/v1.1", "FLUX1.1 pro", "image"),
  model("fal-ai/recraft-v3", "Recraft V3", "image"),
  model("fal-ai/ltx-video", "LTX Video", "video", true),
  model("fal-ai/kling-video/v1.6/standard/text-to-video", "Kling 1.6 (text to video)", "video"),
  model("fal-ai/kling-video/v1.6/standard/image-to-video", "Kling 1.6 (image to video)", "video", true),
  model("fal-ai/minimax/video-01", "MiniMax Video-01", "video"),
];

const FAL_SIZE: Record<string, string> = {
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
  "9:16": "portrait_16_9",
  "4:3": "landscape_4_3",
  "3:2": "landscape_4_3",
  "3:4": "portrait_4_3",
  "2:3": "portrait_4_3",
};

/** fal's queue: submit, poll status_url, read response_url. Also used by custom servers that copy it. */
export async function falQueue(base: string, modelId: string, auth: Record<string, string>, input: Record<string, unknown>, req: BackendRequest, kind: "image" | "video"): Promise<MediaOutput[]> {
  const first = await postJson(`${trimSlash(base)}/${modelId.replace(/^\//, "")}`, auth, input, req.signal);
  if (!first.request_id) {
    const direct = await mediaFromResult(first, kind, req.signal);
    if (direct.length) return direct;
    throw new ProviderError("The server returned neither a job nor a result.");
  }
  const statusUrl: string = first.status_url ?? `${trimSlash(base)}/${modelId}/requests/${first.request_id}/status`;
  const responseUrl: string = first.response_url ?? `${trimSlash(base)}/${modelId}/requests/${first.request_id}`;
  const deadline = Date.now() + (kind === "video" ? VIDEO_DEADLINE_MS : 10 * 60_000);
  for (;;) {
    if (Date.now() > deadline) throw new ProviderError(`Generation timed out after ${kind === "video" ? 30 : 10} minutes.`);
    await sleep(req.pollMs ?? (kind === "video" ? 5000 : 1500), req.signal);
    const st = await getJson(statusUrl, auth, req.signal);
    if (st.status === "COMPLETED") {
      if (st.error) throw new ProviderError(String(st.error));
      break;
    }
    if (st.status === "FAILED" || st.status === "ERROR") throw new ProviderError(String(st.error ?? "Generation failed."));
    req.onProgress?.(st.status === "IN_QUEUE" ? (st.queue_position != null ? `queue position ${st.queue_position}` : "queued") : "rendering");
  }
  req.onProgress?.("downloading");
  const res = await httpFetch(responseUrl, { headers: auth, signal: req.signal });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const result = await res.json();
  const out = await mediaFromResult(kind === "video" ? (result.video ?? result) : (result.images ?? result), kind, req.signal);
  if (!out.length) throw new ProviderError(`The job finished but returned no ${kind}${result.has_nsfw_concepts?.some?.(Boolean) ? " (blocked by the safety checker)" : ""}.`);
  return out;
}

async function falImages(req: BackendRequest): Promise<MediaOutput[]> {
  const o = req.options ?? {};
  const input: Record<string, unknown> = { prompt: req.prompt, image_size: FAL_SIZE[o.aspect ?? "1:1"] ?? "square_hd", aspect_ratio: o.aspect ?? "1:1", num_images: clampCount(o.count), enable_safety_checker: true };
  if (req.inputs?.length) {
    input.image_url = dataUri(req.inputs[0]);
    input.image_urls = req.inputs.slice(0, 4).map(dataUri);
  }
  return falQueue(req.provider.baseUrl || BACKENDS.fal!.defaultBaseUrl, req.model.id, { Authorization: `Key ${req.apiKey}` }, input, req, "image");
}

async function falVideo(req: BackendRequest, base?: string, auth?: Record<string, string>): Promise<MediaOutput> {
  const o = req.options ?? {};
  const input: Record<string, unknown> = { prompt: req.prompt, aspect_ratio: o.aspect === "9:16" || o.aspect === "1:1" ? o.aspect : "16:9" };
  if (o.seconds) input.duration = String(o.seconds);
  if (o.resolution) input.resolution = o.resolution;
  if (req.inputs?.length) input.image_url = dataUri(req.inputs[0]);
  else if (/image-to-video|i2v/.test(req.model.id)) throw new ProviderError("This model animates a picture: attach an image (or pick the text-to-video version).");
  const [file] = await falQueue(base ?? (req.provider.baseUrl || BACKENDS.fal!.defaultBaseUrl), req.model.id, auth ?? { Authorization: `Key ${req.apiKey}` }, input, req, "video");
  return asVideo(file);
}

// ---------------------------------------------------------------- Runway

export const RUNWAY_DEFAULT_MODELS: ModelInfo[] = [
  model("gen4_image", "Gen-4 Image", "image", true),
  model("gen4_turbo", "Gen-4 Turbo (animates a picture)", "video", true),
  model("gen4.5", "Gen-4.5", "video", true),
];
const RUNWAY_IMAGE_RATIO: Record<string, string> = { "1:1": "1024:1024", "16:9": "1920:1080", "9:16": "1080:1920", "4:3": "1440:1080", "3:4": "1080:1440", "3:2": "1440:1080", "2:3": "1080:1440" };
const RUNWAY_VIDEO_RATIO: Record<string, string> = { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960" };

async function runwayTask(req: BackendRequest, path: string, body: Record<string, unknown>, kind: "image" | "video"): Promise<MediaOutput[]> {
  const base = trimSlash(req.provider.baseUrl || BACKENDS.runway!.defaultBaseUrl);
  const headers = { Authorization: `Bearer ${req.apiKey}`, "X-Runway-Version": "2024-11-06" };
  const start = await postJson(`${base}${path}`, headers, body, req.signal);
  if (!start.id) throw new ProviderError("Runway did not return a task id.");
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  for (;;) {
    if (Date.now() > deadline) throw new ProviderError("Runway did not finish within 30 minutes.");
    await sleep(req.pollMs ?? 5000, req.signal);
    const t = await getJson(`${base}/tasks/${start.id}`, headers, req.signal);
    if (t.status === "SUCCEEDED") {
      req.onProgress?.("downloading");
      const out = await mediaFromResult(t.output ?? [], kind, req.signal);
      if (!out.length) throw new ProviderError(`Runway finished but returned no ${kind}.`);
      return out;
    }
    if (t.status === "FAILED" || t.status === "CANCELLED") throw new ProviderError(`Runway: ${t.failure ?? t.status.toLowerCase()}${t.failureCode ? ` (${t.failureCode})` : ""}`);
    req.onProgress?.(t.status === "RUNNING" ? (typeof t.progress === "number" ? `${Math.round(t.progress * 100)}%` : "rendering") : t.status === "THROTTLED" ? "waiting for capacity" : "queued");
  }
}

async function runwayImages(req: BackendRequest): Promise<MediaOutput[]> {
  const body: Record<string, unknown> = { model: req.model.id, promptText: req.prompt.slice(0, 1000), ratio: RUNWAY_IMAGE_RATIO[req.options?.aspect ?? "1:1"] };
  if (req.inputs?.length) body.referenceImages = req.inputs.slice(0, 3).map((i, n) => ({ uri: dataUri(i), tag: `ref${n + 1}` }));
  const out: MediaOutput[] = [];
  for (let i = 0; i < clampCount(req.options?.count); i++) out.push(...(await runwayTask(req, "/text_to_image", body, "image")));
  return out;
}

async function runwayVideo(req: BackendRequest): Promise<MediaOutput> {
  const o = req.options ?? {};
  const body: Record<string, unknown> = { model: req.model.id, promptText: req.prompt.slice(0, 1000), ratio: RUNWAY_VIDEO_RATIO[o.aspect ?? "16:9"] ?? "1280:720", duration: (o.seconds ?? 5) > 7 ? 10 : 5 };
  const image = req.inputs?.[0];
  if (image) body.promptImage = dataUri(image);
  else if (req.model.id === "gen4_turbo") throw new ProviderError("Gen-4 Turbo animates a picture: attach an image first (or choose Gen-4.5 for text-to-video).");
  const [file] = await runwayTask(req, image ? "/image_to_video" : "/text_to_video", body, "video");
  return asVideo(file);
}

// ---------------------------------------------------------------- custom templates

/** Run a request described by a MediaHttpSpec (custom endpoints and plugin engines). */
export async function runTemplate(
  spec: MediaHttpSpec,
  vars: Record<string, unknown>,
  settings: Record<string, string>,
  kind: "image" | "video",
  req: Pick<BackendRequest, "signal" | "onProgress" | "pollMs">,
): Promise<MediaOutput[]> {
  const url = fillTemplate(spec.url, vars, settings, "url");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = fillTemplate(v, vars, settings, "text");
  const body = spec.method === "POST" && spec.body ? fillTemplate(spec.body, vars, settings, "json") : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  const res = await httpFetch(url, { method: spec.method, headers, body, signal: req.signal });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  const type = res.headers.get("content-type") ?? "";
  if (/^(image|video)\//.test(type)) return [await readBody(res)];
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text: look for links in it */
  }
  const id = spec.jobIdPath ? pick(json, spec.jobIdPath) : undefined;
  if (id != null && spec.pollUrl) {
    const pollHeaders = { ...headers };
    delete pollHeaders["Content-Type"];
    const deadline = Date.now() + VIDEO_DEADLINE_MS;
    req.onProgress?.("queued");
    for (;;) {
      if (Date.now() > deadline) throw new ProviderError("The job did not finish within 30 minutes.");
      await sleep(req.pollMs ?? 4000, req.signal);
      const poll = await httpFetch(fillTemplate(spec.pollUrl, { ...vars, id }, settings, "url"), { headers: pollHeaders, signal: req.signal });
      if (!poll.ok) throw new ProviderError(await readError(poll), poll.status);
      const ptype = poll.headers.get("content-type") ?? "";
      if (/^(image|video)\//.test(ptype)) return [await readBody(poll)];
      const st = await poll.json();
      const status = spec.statusPath ? String(pick(st, spec.statusPath) ?? "") : "";
      if (spec.failedPattern && status && new RegExp(spec.failedPattern, "i").test(status)) throw new ProviderError(`The job failed (${status}).`);
      const found = await mediaFromResult(spec.resultPath ? pick(st, spec.resultPath) : st, kind, req.signal);
      if (found.length) return found;
      req.onProgress?.(status ? status.toLowerCase() : "rendering");
    }
  }
  const found = await mediaFromResult(spec.resultPath ? pick(json, spec.resultPath) : json, kind, req.signal);
  if (!found.length) throw new ProviderError(`The endpoint answered, but no ${kind} was found in its response: ${text.slice(0, 200)}`);
  return found;
}

export function templateVars(req: BackendRequest): Record<string, unknown> {
  const o = req.options ?? {};
  const { width, height } = sizeFor(o.aspect, 1024, 64);
  return {
    prompt: req.prompt,
    model: req.model.id,
    width,
    height,
    aspect_ratio: o.aspect ?? (req.model.kind === "video" ? "16:9" : "1:1"),
    seconds: o.seconds ?? 5,
    count: clampCount(o.count),
    seed: Math.floor(Math.random() * 2_000_000_000),
    image: req.inputs?.[0] ? dataUri(req.inputs[0]) : "",
    key: req.apiKey,
  };
}

// ---------------------------------------------------------------- dispatch

export const VIDEO_DEADLINE_MS = 30 * 60_000;

function asVideo(file: MediaOutput): MediaOutput {
  return { bytes: file.bytes, mime: file.mime.startsWith("video/") ? file.mime : "video/mp4" };
}

export async function backendModels(p: ProviderConfig, key: string): Promise<ModelInfo[]> {
  switch (p.kind) {
    case "pollinations":
      return pollinationsModels(p, key);
    case "horde":
      return hordeModels(p, key);
    case "cloudflare":
      return cloudflareModels(p, key);
    case "fal":
      return FAL_DEFAULT_MODELS;
    case "runway":
      return RUNWAY_DEFAULT_MODELS;
    default:
      return [];
  }
}

/** Images from a media-only backend; null when `kind` is not one. */
export async function backendImages(req: BackendRequest): Promise<MediaOutput[] | null> {
  switch (req.provider.kind) {
    case "pollinations":
      return pollinationsImages(req);
    case "horde":
      return hordeImages(req);
    case "cloudflare":
      return cloudflareImages(req);
    case "fal":
      return falImages(req);
    case "runway":
      return runwayImages(req);
    case "custom-media":
      if (req.provider.imageTemplate?.url) return runTemplate(req.provider.imageTemplate, templateVars(req), {}, "image", req);
      return null; // OpenAI-style /images/generations
    default:
      return null;
  }
}

export async function backendVideo(req: BackendRequest): Promise<MediaOutput | null> {
  const p = req.provider;
  switch (p.kind) {
    case "pollinations":
      return pollinationsVideo(req);
    case "horde":
    case "cloudflare":
      throw new ProviderError(`${BACKENDS[p.kind]!.name} makes images only. For free video use Pollinations with a free key.`);
    case "fal":
      return falVideo(req);
    case "runway":
      return runwayVideo(req);
  }
  if (p.kind === "custom-media" || p.kind === "openai-compatible") {
    if (p.videoApi === "template" && p.videoTemplate?.url) return asVideo((await runTemplate(p.videoTemplate, templateVars(req), {}, "video", req))[0]);
    if (p.videoApi === "fal") return falVideo(req, p.baseUrl, req.apiKey ? { Authorization: `Key ${req.apiKey}` } : {});
  }
  return null;
}
