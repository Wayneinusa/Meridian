// Runs untrusted JavaScript (plugin tools, the run_javascript tool) in a
// sandboxed iframe: no access to the app, its storage, keys or the native
// layer. Network access goes through a fetch bridge the host controls.
import { httpFetch } from "../platform/http";
import { base64ToBytes, bytesToBase64 } from "../util/bytes";

const TEXTUAL = /^text\/|json|xml|javascript|x-www-form-urlencoded|event-stream/i;

type BridgeBody = string | { __b64: string } | { __form: ({ name: string; value: string } | { name: string; b64: string; type?: string; filename?: string })[] } | null | undefined;
interface BridgeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: BridgeBody;
}

/** Rebuild a request body the sandbox serialised (text, bytes or form data). */
function bridgeBody(b: BridgeBody): BodyInit | undefined {
  if (b == null) return undefined;
  if (typeof b === "string") return b;
  if ("__b64" in b) return base64ToBytes(b.__b64) as BodyInit;
  const form = new FormData();
  for (const f of b.__form) {
    if ("value" in f) form.append(f.name, f.value);
    else form.append(f.name, new Blob([base64ToBytes(f.b64) as BlobPart], { type: f.type || "application/octet-stream" }), f.filename);
  }
  return form;
}

const RUNNER = `<!doctype html><meta charset="utf-8"><script>
const pending = new Map(); let seq = 0;
function bridge(kind, payload) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); parent.postMessage({ __mer: 1, type: kind, id, payload }, "*"); }); }
async function fetchText(url, init) { return bridge("fetch", { url: String(url), init: init || {} }); }
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function toBytes(v) { if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer()); if (v instanceof ArrayBuffer) return new Uint8Array(v); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }
// Standard fetch for plugin code (TypingMind plugins call it directly); requests go through the app.
async function bridgedFetch(input, init) {
  init = init || {};
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  const headers = {};
  new Headers(init.headers || (input && input.headers) || {}).forEach((v, k) => { headers[k] = v; });
  let body = init.body;
  if (body instanceof URLSearchParams) { body = body.toString(); if (!headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded"; }
  else if (body instanceof FormData) {
    const form = [];
    for (const [name, value] of body.entries()) form.push(typeof value === "string" ? { name, value } : { name, b64: b64(await toBytes(value)), type: value.type, filename: value.name || "file" });
    body = { __form: form };
  } else if (body != null && typeof body !== "string") {
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = { __b64: b64(await toBytes(body)) };
    else body = JSON.stringify(body);
  }
  const r = await bridge("fetch", { url, init: { method: init.method || "GET", headers, body }, raw: true });
  const data = r.bodyB64 != null ? unb64(r.bodyB64) : r.body;
  return new Response(r.status === 204 || r.status === 304 ? null : data, { status: r.status, headers: r.headers });
}
window.fetch = bridgedFetch;
async function fetchJson(url, init) { const r = await fetchText(url, init); try { return JSON.parse(r.body); } catch { throw new Error("Response was not JSON: " + String(r.body).slice(0, 200)); } }
window.addEventListener("message", async (e) => {
  const m = e.data; if (!m || m.__mer !== 1) return;
  if (m.type === "fetch-result") { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); return; }
  if (m.type !== "run") return;
  const logs = [];
  const fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } })();
  const console = { log: (...a) => logs.push(a.map(fmt).join(" ")), error: (...a) => logs.push("[error] " + a.map(fmt).join(" ")), warn: (...a) => logs.push("[warn] " + a.map(fmt).join(" ")), info: (...a) => logs.push(a.map(fmt).join(" ")) };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction("args", "settings", "fetchJson", "fetchText", "console", "fetch", "userSettings", "params", m.code);
    const result = await fn(m.args || {}, m.settings || {}, fetchJson, fetchText, console, bridgedFetch, m.settings || {}, m.args || {});
    parent.postMessage({ __mer: 1, type: "done", runId: m.runId, result: result === undefined ? null : (typeof result === "string" ? result : fmt(result)), logs }, "*");
  } catch (err) {
    parent.postMessage({ __mer: 1, type: "done", runId: m.runId, error: String(err && err.stack || err), logs }, "*");
  }
});
parent.postMessage({ __mer: 1, type: "ready" }, "*");
</script>`;

export interface SandboxResult {
  result: string | null;
  logs: string[];
  error?: string;
}

/** Each call gets a fresh iframe so runs cannot see each other. */
export function runInSandbox(code: string, args: unknown, settings: Record<string, string>, opts: { timeoutMs?: number; signal?: AbortSignal; allowNetwork?: boolean } = {}): Promise<SandboxResult> {
  if (typeof document === "undefined") return Promise.reject(new Error("JavaScript tools need the app window."));
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.display = "none";
    frame.srcdoc = RUNNER;
    const runId = Math.random().toString(36).slice(2);
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`The code ran longer than ${Math.round((opts.timeoutMs ?? 30_000) / 1000)} seconds and was stopped.`))), opts.timeoutMs ?? 30_000);
    opts.signal?.addEventListener("abort", () => finish(() => reject(new DOMException("Aborted", "AbortError"))));
    const onMessage = async (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const m = e.data as { __mer?: number; type: string; id?: number; runId?: string; payload?: { url: string; init: BridgeInit; raw?: boolean }; result?: string | null; logs?: string[]; error?: string };
      if (!m || m.__mer !== 1) return;
      if (m.type === "ready") frame.contentWindow?.postMessage({ __mer: 1, type: "run", runId, code, args, settings }, "*");
      else if (m.type === "fetch") {
        const reply = (payload: Record<string, unknown>) => frame.contentWindow?.postMessage({ __mer: 1, type: "fetch-result", id: m.id, ...payload }, "*");
        if (!opts.allowNetwork) return reply({ error: "Network access is not allowed here." });
        try {
          const init = m.payload!.init ?? {};
          const res = await httpFetch(m.payload!.url, { method: init.method ?? "GET", headers: init.headers, body: bridgeBody(init.body), signal: opts.signal });
          const headers = Object.fromEntries(res.headers.entries());
          const type = res.headers.get("content-type") ?? "";
          if (m.payload!.raw && type && !TEXTUAL.test(type)) {
            reply({ result: { status: res.status, ok: res.ok, headers, bodyB64: bytesToBase64(new Uint8Array(await res.arrayBuffer())) } });
          } else reply({ result: { status: res.status, ok: res.ok, headers, body: await res.text() } });
        } catch (err) {
          reply({ error: String(err) });
        }
      } else if (m.type === "done" && m.runId === runId) {
        finish(() => resolve({ result: m.result ?? null, logs: m.logs ?? [], error: m.error }));
      }
    };
    window.addEventListener("message", onMessage);
    document.body.appendChild(frame);
  });
}
