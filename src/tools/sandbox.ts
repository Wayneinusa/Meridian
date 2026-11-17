// Runs untrusted JavaScript (plugin tools, the run_javascript tool) in a
// sandboxed iframe: no access to the app, its storage, keys or the native
// layer. Network access goes through a fetch bridge the host controls.
import { httpFetch } from "../platform/http";

const RUNNER = `<!doctype html><meta charset="utf-8"><script>
const pending = new Map(); let seq = 0;
function bridge(kind, payload) { return new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); parent.postMessage({ __mer: 1, type: kind, id, payload }, "*"); }); }
async function fetchText(url, init) { return bridge("fetch", { url: String(url), init: init || {} }); }
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
    const fn = new AsyncFunction("args", "settings", "fetchJson", "fetchText", "console", m.code);
    const result = await fn(m.args || {}, m.settings || {}, fetchJson, fetchText, console);
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
      const m = e.data as { __mer?: number; type: string; id?: number; runId?: string; payload?: { url: string; init: RequestInit }; result?: string | null; logs?: string[]; error?: string };
      if (!m || m.__mer !== 1) return;
      if (m.type === "ready") frame.contentWindow?.postMessage({ __mer: 1, type: "run", runId, code, args, settings }, "*");
      else if (m.type === "fetch") {
        const reply = (payload: Record<string, unknown>) => frame.contentWindow?.postMessage({ __mer: 1, type: "fetch-result", id: m.id, ...payload }, "*");
        if (!opts.allowNetwork) return reply({ error: "Network access is not allowed here." });
        try {
          const init = m.payload!.init ?? {};
          const res = await httpFetch(m.payload!.url, { method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string | undefined, signal: opts.signal });
          reply({ result: { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), body: await res.text() } });
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
