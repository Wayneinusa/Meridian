// Helpers shared by every image / video backend: downloading results, sizing,
// waiting, and finding the media in whatever a service (or plugin) returns.
import { httpFetch, readError } from "../platform/http";
import type { MediaOptions } from "../types";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";
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

export const dataUri = (i: MediaInput) => `data:${i.mime};base64,${bytesToBase64(i.bytes)}`;
export const isImage = (i: MediaInput) => /^image\//.test(i.mime);

export function sniffImage(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x52 && head[1] === 0x49) return "image/webp";
  if (head[0] === 0x47 && head[1] === 0x49) return "image/gif";
  return "image/png";
}

/** Image or video type from the first bytes. */
export function sniffMedia(b: Uint8Array): string {
  if (b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(avif|avis)/.test(brand)) return "image/avif";
    if (/^qt/.test(brand)) return "video/quicktime";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x3c) return "image/svg+xml";
  return sniffImage(b);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });

export async function download(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<MediaOutput> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new ProviderError("The service returned an unreadable data URL.");
    const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
    return { bytes, mime: m[1] || sniffMedia(bytes) };
  }
  const res = await httpFetch(url, { signal, headers });
  if (!res.ok) throw new ProviderError(`Could not download the result: ${await readError(res)}`, res.status);
  return readBody(res);
}

/** Bytes and type of a media response; the type is sniffed when the server does not say. */
export async function readBody(res: Response): Promise<MediaOutput> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  return { bytes, mime: /^(image|video)\//.test(type) ? type : sniffMedia(bytes) };
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await httpFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  return res.json();
}

export async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const res = await httpFetch(url, { headers, signal });
  if (!res.ok) throw new ProviderError(await readError(res), res.status);
  return res.json();
}

export const clampCount = (n?: number) => Math.min(Math.max(Math.round(n ?? 1), 1), 4);

const RATIOS: Record<string, [number, number]> = { "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3] };

/** Width and height for an aspect ratio, about `base`² pixels, sides a multiple of `step`. */
export function sizeFor(aspect: MediaOptions["aspect"] | undefined, base = 1024, step = 64): { width: number; height: number } {
  const [w, h] = RATIOS[aspect ?? "1:1"] ?? [1, 1];
  const scale = Math.sqrt((base * base) / (w * h));
  const round = (v: number) => Math.max(step, Math.round(v / step) * step);
  let width = round(w * scale);
  let height = round(h * scale);
  // stay within the pixel budget (services reject larger requests)
  while (width * height > base * base * 1.02) {
    if (width >= height) width -= step;
    else height -= step;
  }
  return { width, height };
}

/** Dot path into a JSON value ("data.0.url"). */
export function pick(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|avif|svg|mp4|webm|mov|m4v)(\?|#|$)/i;
const MEDIA_KEY = /^(url|uri|src|href|image|images|img|video|videos|output|outputs|result|results|file|files|data|b64_json|base64|image_url|video_url|imageUrl|videoUrl|public_url|download_url|link)$/i;
const B64 = /^[A-Za-z0-9+/=\s]{200,}$/;

/**
 * Everything in a response that looks like generated media: data URIs, base64
 * blobs and URLs (markdown images, plain links, JSON fields). Most likely first.
 */
export function findMediaRefs(value: unknown): string[] {
  const strong: string[] = [];
  const weak: string[] = [];
  const add = (list: string[], s: string) => {
    if (!list.includes(s)) list.push(s);
  };
  const fromText = (text: string, key?: string) => {
    const t = text.trim();
    if (t.startsWith("data:image/") || t.startsWith("data:video/")) return add(strong, t);
    if (B64.test(t) && (!key || MEDIA_KEY.test(key))) return add(strong, `base64:${t.replace(/\s+/g, "")}`);
    for (const m of t.matchAll(/data:(?:image|video)\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g)) add(strong, m[0]);
    for (const m of t.matchAll(/!\[[^\]]*\]\((\S+?)\)/g)) add(strong, m[1]);
    for (const m of t.matchAll(/<(?:img|video|source)[^>]+src=["']([^"']+)["']/gi)) add(strong, m[1]);
    for (const m of t.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
      const url = m[0].replace(/[.,;]+$/, "");
      if (MEDIA_EXT.test(url) || (key && MEDIA_KEY.test(key))) add(strong, url);
      else add(weak, url);
    }
  };
  const walk = (v: unknown, key?: string, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") return fromText(v, key);
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key, depth + 1));
    if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
  };
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        walk(JSON.parse(t));
        return [...strong, ...weak];
      } catch {
        /* not JSON */
      }
    }
  }
  walk(value);
  return [...strong, ...weak];
}

/** Download / decode the media a response points to. Weak candidates (plain links) are checked by type. */
export async function mediaFromResult(value: unknown, kind: "image" | "video", signal?: AbortSignal, max = 4): Promise<MediaOutput[]> {
  const out: MediaOutput[] = [];
  for (const ref of findMediaRefs(value)) {
    if (out.length >= max) break;
    try {
      let file: MediaOutput;
      if (ref.startsWith("base64:")) {
        const bytes = base64ToBytes(ref.slice(7));
        file = { bytes, mime: sniffMedia(bytes) };
      } else file = await download(ref, signal);
      if (file.mime.startsWith(`${kind}/`) || (kind === "image" && file.mime === "image/svg+xml")) out.push(file);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      /* not media; try the next candidate */
    }
  }
  return out;
}
