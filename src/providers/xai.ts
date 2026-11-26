// Grok (xAI): two ways in, and xAI's own search tools.
//
// Sign-in
//   API key          https://api.x.ai/v1 with the key from console.x.ai
//   Sign in with X   xAI's OAuth (auth.x.ai) with the public client of xAI's
//                    Grok CLI: browser sign-in on desktop (loopback port 56121,
//                    the only one that client allows) or a device code anywhere.
//                    Requests then go to xAI's CLI gateway and are billed to the
//                    user's SuperGrok / X Premium subscription. Tokens live in the
//                    keychain and refresh automatically. When both exist, the
//                    sign-in wins, as in xAI's own tools.
//
// Chat
//   Responses API (/v1/responses) with xAI's server-side tools web_search and
//   x_search, which xAI runs itself and cites. Used when native search is on or
//   the user signed in with X; otherwise the Chat Completions dialect (openai.ts).
import { accessToken, deviceSignIn, forgetTokens, loadTokens, redirectChannel, saveTokens, signIn, type DeviceCode, type OAuthTokens } from "../connectors/oauth";
import { httpFetch, readError } from "../platform/http";
import type { ModelInfo, Part, ProviderConfig } from "../types";
import { uid } from "../types";
import { clientToolCalls, resultOf, sseEvents, trimSlash, userItems } from "./common";
import { openaiAdapter } from "./openai";
import { NativeSearchUnavailable, ProviderError, type ChatRequest, type ChatResult, type ProviderAdapter, type StopKind } from "./types";

export const XAI_ISSUER = "https://auth.x.ai";
export const XAI_AUTHORIZE = `${XAI_ISSUER}/oauth2/authorize`;
export const XAI_TOKEN = `${XAI_ISSUER}/oauth2/token`;
export const XAI_DEVICE = `${XAI_ISSUER}/oauth2/device/code`;
/** the public OAuth client of xAI's Grok CLI (the consent page may say "Grok Build") */
export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPES = ["openid", "profile", "email", "offline_access", "grok-cli:access", "api:access"];
export const XAI_REDIRECT_PORT = 56121;
export const XAI_GATEWAY = "https://cli-chat-proxy.grok.com/v1";
/** keychain entry for the sign-in (oauth.<id>) */
export const XAI_TOKEN_ID = "provider.xai";
const CLIENT_NAME = "meridian";
/**
 * xAI's gateway refuses clients older than a minimum version (426 "Your Grok CLI
 * version (…) is outdated. Please update to version 1.0.13 or later"). Meridian
 * sends a version that meets it, and when xAI raises the minimum it adopts the
 * number from the refusal, remembers it and retries once.
 */
const MIN_CLIENT_VERSION = "1.0.13";
const VERSION_KEY = "meridian.xai.clientVersion";
let clientVersion = (() => {
  try {
    const saved = globalThis.localStorage?.getItem(VERSION_KEY);
    return saved && newerVersion(saved, MIN_CLIENT_VERSION) ? saved : MIN_CLIENT_VERSION;
  } catch {
    return MIN_CLIENT_VERSION;
  }
})();

function newerVersion(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** If xAI refused the client version and named the minimum, adopt it. True when a retry makes sense. */
export function adoptRequiredVersion(text: string): boolean {
  const m = /version\D{0,40}?(\d+\.\d+\.\d+)\s+or\s+later/i.exec(text) ?? /update to (?:version )?v?(\d+\.\d+\.\d+)/i.exec(text);
  if (!m || !newerVersion(m[1], clientVersion)) return false;
  clientVersion = m[1];
  try {
    globalThis.localStorage?.setItem(VERSION_KEY, clientVersion);
  } catch {
    /* remembered for this run only */
  }
  return true;
}

/** Retry a gateway request once when xAI asks for a newer client version. */
async function versionGate(res: Response, again: () => Promise<Response>): Promise<Response> {
  if (res.status !== 426 && res.status !== 400 && res.status !== 403) return res;
  const text = await res.clone().text().catch(() => "");
  return adoptRequiredVersion(text) ? again() : res;
}

type Json = Record<string, any>;

// ---------------------------------------------------------------- Grok Imagine

const imagine = (id: string, name: string, kind: "image" | "video"): ModelInfo => ({ id, name, kind, caps: { vision: true, pdf: false, tools: false, thinking: false } });
/** xAI's image and video models (Grok Imagine), best first. Listed even before the model list is loaded. */
export const IMAGINE_MODELS: ModelInfo[] = [
  imagine("grok-imagine-image-2.0", "Grok Imagine Image 2.0", "image"),
  imagine("grok-imagine-image-pro", "Grok Imagine Image Pro", "image"),
  imagine("grok-imagine-image", "Grok Imagine Image", "image"),
  imagine("grok-imagine-video-1.5", "Grok Imagine Video 1.5", "video"),
  imagine("grok-imagine-video", "Grok Imagine Video", "video"),
];
export const isImagine = (id: string) => /grok-imagine/.test(id);

/** The Imagine models added to a list that lacks them (kept in the order xAI listed the rest). */
export function withImagine(models: ModelInfo[]): ModelInfo[] {
  const missing = IMAGINE_MODELS.filter((m) => !models.some((x) => x.id === m.id));
  return missing.length ? [...models, ...missing.map((m) => ({ ...m, caps: { ...m.caps } }))] : models;
}

/**
 * Bearer tokens for xAI's media API, in the order to try them. Grok Imagine
 * goes to api.x.ai for both the sign-in and the API key, as in xAI's own tools.
 */
export async function xaiMediaTokens(provider: ProviderConfig, apiKey: string): Promise<string[]> {
  const out: string[] = [];
  const auth = await xaiAuth(provider, apiKey).catch(() => null);
  if (auth) out.push(auth.token);
  if (apiKey && !out.includes(apiKey)) out.push(apiKey);
  return out;
}

// ---------------------------------------------------------------- sign-in

export async function signInWithX(mode: "browser" | "device", onCode?: (c: DeviceCode) => void, signal?: AbortSignal, manual?: Promise<string>): Promise<OAuthTokens> {
  let tokens: OAuthTokens;
  if (mode === "device") {
    tokens = await deviceSignIn({ deviceEndpoint: XAI_DEVICE, tokenEndpoint: XAI_TOKEN, clientId: XAI_CLIENT_ID, scopes: XAI_SCOPES, onCode: onCode ?? (() => undefined), signal, extra: { referrer: CLIENT_NAME } });
  } else {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    tokens = await signIn({
      server: { authorization_endpoint: XAI_AUTHORIZE, token_endpoint: XAI_TOKEN },
      clientId: XAI_CLIENT_ID,
      scopes: XAI_SCOPES,
      extraAuthParams: { nonce },
      redirect: await redirectChannel(XAI_REDIRECT_PORT),
      // xAI's page may show the code instead of handing it back: the user pastes it
      manual,
    });
  }
  await saveTokens(XAI_TOKEN_ID, tokens);
  return tokens;
}

export const signOutOfX = () => forgetTokens(XAI_TOKEN_ID);
export const hasXSession = async () => !!(await loadTokens(XAI_TOKEN_ID));

/** The account name from the ID token, for "Signed in as …" (display only; not trusted for anything). */
export function accountFromTokens(t: OAuthTokens): string | undefined {
  const raw = t.id_token;
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(atob(raw.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.email ?? payload.name ?? payload.preferred_username;
  } catch {
    return undefined;
  }
}

export interface XaiAuth {
  mode: "oauth" | "key";
  token: string;
}

/** Sign-in first (as xAI's own tools do), then the API key. */
export async function xaiAuth(provider: ProviderConfig, apiKey: string, force = false): Promise<XaiAuth | null> {
  if (provider.signedIn) {
    const t = await accessToken(XAI_TOKEN_ID, force);
    if (t) return { mode: "oauth", token: t };
  }
  return apiKey ? { mode: "key", token: apiKey } : null;
}

function gatewayHeaders(auth: XaiAuth, model: string, conv: string, stream: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
    "x-authenticateresponse": "authenticate-response",
    "x-grok-client-identifier": CLIENT_NAME,
    "x-grok-client-version": clientVersion,
    "x-grok-client-mode": "interactive",
    "x-grok-conv-id": conv,
    "x-grok-session-id": conv,
    "x-grok-req-id": crypto.randomUUID(),
    "x-grok-model-override": model,
  };
}

// ---------------------------------------------------------------- models

const gatewayModel = (m: Json): ModelInfo | null => {
  const id = String(m.model ?? m.modelId ?? m.id ?? "");
  if (!id || m.hidden || /composer/.test(id)) return null;
  const lower = id.toLowerCase();
  return {
    id,
    name: String(m.name ?? id),
    kind: "chat",
    caps: { vision: !/code|mini-fast/.test(lower), pdf: false, tools: true, thinking: /reason|grok-[4-9]|mini/.test(lower) && !/non-reasoning/.test(lower), webSearch: true },
    contextWindow: Number(m.contextWindow ?? m.context_window) || undefined,
  };
};

async function listModels(provider: ProviderConfig, apiKey: string): Promise<ModelInfo[]> {
  const out = new Map<string, ModelInfo>();
  const auth = await xaiAuth(provider, apiKey);
  if (auth?.mode === "oauth") {
    const get = () => httpFetch(`${XAI_GATEWAY}/models-v2`, { headers: gatewayHeaders(auth, "", uid("c"), false) });
    const res = await versionGate(await get(), get);
    if (!res.ok) throw new ProviderError(xaiError(res.status, await readError(res)), res.status);
    for (const m of ((await res.json()).data ?? []) as Json[]) {
      const info = gatewayModel(m);
      if (info) out.set(info.id, info);
    }
  }
  // Grok Imagine is always offered: the sign-in or the key can use it
  for (const m of IMAGINE_MODELS) if (!out.has(m.id)) out.set(m.id, { ...m, caps: { ...m.caps } });
  // the API (with a key, or the sign-in where xAI accepts it) also lists image and video models
  const bearer = apiKey || (auth?.mode === "oauth" ? auth.token : "");
  if (bearer) {
    try {
      for (const m of await openaiAdapter.listModels(provider, bearer)) if (!out.has(m.id)) out.set(m.id, { ...m, caps: { ...m.caps, webSearch: m.kind === "chat" } });
    } catch (e) {
      if (!out.size) throw e;
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The subscription gateway turned the account away (rather than the request being wrong). */
function gatewayRefusal(e: ProviderError): boolean {
  const st = e.status ?? 0;
  return st === 402 || st === 426 || st === 429 || st >= 500 || (st === 403 && /credits|subscription|spending|plan|access/i.test(e.message)) || /outdated|update to version/i.test(e.message);
}

function xaiError(status: number, text: string): string {
  if (status === 403 && /spending-limit|subscription|credits/i.test(text)) return "xAI refused the request: the account has run out of credits or needs a SuperGrok / X Premium subscription. Check grok.com, or use an API key.";
  if (status === 426 || /outdated|update to version/i.test(text)) return `xAI's subscription gateway asked for a newer client version and Meridian could not adapt automatically (${text}). Use an API key for now, and report this so Meridian can be updated.`;
  if (status === 401) return "xAI did not accept the sign-in. Sign in with X again in Settings → Providers & keys.";
  return text;
}

// ---------------------------------------------------------------- Responses API

async function toInput(req: ChatRequest): Promise<Json[]> {
  const input: Json[] = [];
  if (req.system) input.push({ role: "system", content: req.system });
  // xAI Responses takes images inline but other files only by upload: documents go in as extracted text
  const caps = { ...req.model.caps, pdf: false };
  for (const m of req.messages) {
    if (m.role === "user") {
      const content: Json[] = [];
      for (const item of await userItems(m, caps, req.blobs)) {
        if (item.kind === "text") content.push({ type: "input_text", text: item.text });
        else if (item.kind === "image") content.push({ type: "input_image", image_url: `data:${item.mime};base64,${item.b64}` });
      }
      if (content.length) input.push({ role: "user", content });
      continue;
    }
    const text = m.parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text").map((p) => p.text).join("");
    if (text.trim()) input.push({ role: "assistant", content: text });
    for (const c of clientToolCalls(m)) {
      input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}), status: "completed" });
      const r = resultOf(c);
      const out: Json[] = [{ type: "input_text", text: (r.isError ? "Error: " : "") + (r.text || "(no output)") }];
      if (req.model.caps.vision) {
        for (const img of r.images ?? []) {
          const b64 = await req.blobs.base64(img.blobId);
          if (b64) out.push({ type: "input_image", image_url: `data:${img.mime};base64,${b64}` });
        }
      }
      input.push({ type: "function_call_output", call_id: c.id, output: out.length === 1 ? out[0].text : out });
    }
  }
  return input;
}

export function buildResponsesBody(req: ChatRequest, input: Json[], native: boolean): Json {
  const p = req.options.params;
  const body: Json = { model: req.model.id, input, stream: true, store: false };
  const tools: Json[] = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));
  if (native) {
    tools.push({ type: "web_search" }, { type: "x_search" });
    // return the pages each search used, so they can be shown under the search
    body.include = ["web_search_call.action.sources"];
  }
  if (tools.length) body.tools = tools;
  if (p.toolChoice && req.tools.length) body.tool_choice = p.toolChoice;
  if (p.parallelToolCalls !== undefined) body.parallel_tool_calls = p.parallelToolCalls;
  if (p.temperature !== undefined) body.temperature = p.temperature;
  if (p.topP !== undefined) body.top_p = p.topP;
  if (p.seed !== undefined) body.seed = p.seed;
  if (p.maxTokens !== undefined) body.max_output_tokens = p.maxTokens;
  if (p.responseFormat === "json") body.text = { format: { type: "json_object" } };
  if (p.effort && p.effort !== "auto" && req.model.caps.thinking && /mini/.test(req.model.id)) body.reasoning = { effort: p.effort === "xhigh" || p.effort === "max" ? "high" : p.effort };
  return { ...body, ...(p.extraBody ?? {}) };
}

interface Seg {
  kind: "text" | "thinking" | "call" | "server";
  text: string;
  id?: string;
  name?: string;
  args?: string;
  input?: unknown;
  status?: "running" | "done" | "error";
  result?: string;
}

const SERVER_NAMES: Record<string, string> = { web_search_call: "web_search", x_search_call: "x_search" };

/** What a search call looked for, from its action or arguments. */
function searchInput(item: Json): Record<string, unknown> {
  const a = item.action ?? {};
  if (a.query || a.queries) return { query: a.query ?? a.queries?.join(" | ") };
  if (a.url) return { url: a.url, ...(a.pattern ? { pattern: a.pattern } : {}) };
  try {
    return item.arguments ? JSON.parse(item.arguments) : {};
  } catch {
    return { query: String(item.arguments) };
  }
}

function sourcesOf(item: Json): string[] {
  const out: string[] = [];
  for (const s of (item.action?.sources ?? item.sources ?? []) as Json[]) {
    const url = typeof s === "string" ? s : s?.url;
    if (url && !out.includes(url)) out.push(s?.title ? `${s.title}\n${url}` : url);
  }
  return out;
}

/** The gateway's request policy, as in xAI's own client: nothing stored, encrypted reasoning returned. */
export function oauthPolicy(body: Json): Json {
  const include = Array.isArray(body.include) ? [...body.include] : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  return { ...body, store: false, include };
}

/** Errors that mean "this request's search tools were refused", not "the account or sign-in is wrong". */
const ACCOUNT_TROUBLE = /spending-limit|subscription|credits|outdated|update to version|unauthori[sz]ed|expired|invalid.*token|permission/i;
function nativeRefused(status: number, text: string): boolean {
  if (ACCOUNT_TROUBLE.test(text)) return false;
  if ([400, 404, 422, 501].includes(status)) return true;
  return status === 403 && /tool|search|x_search|web_search/i.test(text);
}

async function responsesChat(req: ChatRequest, auth: XaiAuth, native: boolean): Promise<ChatResult> {
  let body = buildResponsesBody(req, await toInput(req), native);
  const conv = req.messages[0]?.id ?? uid("c");
  const post = (a: XaiAuth) =>
    httpFetch(a.mode === "oauth" ? `${XAI_GATEWAY}/responses` : `${trimSlash(req.provider.baseUrl)}/responses`, {
      method: "POST",
      headers: a.mode === "oauth" ? gatewayHeaders(a, req.model.id, conv, true) : { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${a.token}`, ...(req.provider.headers ?? {}) },
      body: JSON.stringify(a.mode === "oauth" ? oauthPolicy(body) : body),
      signal: req.signal,
    });
  let res = await post(auth);
  if (auth.mode === "oauth") res = await versionGate(res, () => post(auth));
  // xAI answers an expired sign-in with 401 or 403: refresh once and retry
  if ((res.status === 401 || res.status === 403) && auth.mode === "oauth") {
    const text = await res.clone().text();
    if (!/spending-limit|subscription|credits/i.test(text)) {
      const fresh = await xaiAuth(req.provider, req.apiKey, true);
      if (fresh?.mode === "oauth") res = await post(fresh);
    }
  }
  if (!res.ok && native) {
    const text = await res.clone().text().catch(() => "");
    if (nativeRefused(res.status, text)) {
      // first without the extra source listing, which some routes do not accept
      if (body.include) {
        const { include: _drop, ...rest } = body;
        body = rest;
        res = await post(auth);
      }
      if (!res.ok) {
        const again = await readError(res);
        if (nativeRefused(res.status, again)) throw new NativeSearchUnavailable(again.slice(0, 160), res.status);
        throw new ProviderError(xaiError(res.status, again), res.status);
      }
    }
  }
  if (!res.ok) throw new ProviderError(xaiError(res.status, await readError(res)), res.status);

  const segs = new Map<number, Seg>();
  const byItem = new Map<string, Seg>();
  const citations: { url: string; title?: string }[] = [];
  let usage: ChatResult["usage"];
  let status = "";
  let incomplete = "";
  const seg = (i: number, make: () => Seg) => {
    let s = segs.get(i);
    if (!s) {
      s = make();
      segs.set(i, s);
    }
    return s;
  };

  const snapshot = (final: boolean): Part[] => {
    const parts: Part[] = [];
    for (const [, s] of [...segs.entries()].sort((a, b) => a[0] - b[0])) {
      if (s.kind === "text" && s.text) parts.push({ type: "text", text: s.text });
      else if (s.kind === "thinking" && s.text) parts.push({ type: "thinking", text: s.text });
      else if (s.kind === "call" && s.name) parts.push({ type: "tool_call", id: s.id!, name: s.name, input: parseArgs(s.args ?? "", final), status: "pending" });
      else if (s.kind === "server") {
        const fallback = final && !s.result && citations.length ? citations.map((c) => (c.title ? `${c.title}\n${c.url}` : c.url)).join("\n\n") : undefined;
        parts.push({
          type: "tool_call",
          id: s.id!,
          name: s.name!,
          input: s.input ?? {},
          server: true,
          status: final ? (s.status === "error" ? "error" : "done") : (s.status ?? "running"),
          ...(s.result || fallback ? { result: { text: s.result || fallback!, isError: s.status === "error" } } : final ? { result: { text: "Searched." } } : {}),
        });
      }
    }
    return parts;
  };

  const onItem = (ev: Json, done: boolean) => {
    const item = ev.item as Json;
    const i = Number(ev.output_index ?? segs.size);
    if (item.type === "function_call") {
      const s = seg(i, () => ({ kind: "call", text: "", id: item.call_id ?? item.id, name: item.name, args: "" }));
      byItem.set(item.id, s);
      if (done && typeof item.arguments === "string") s.args = item.arguments;
    } else if (SERVER_NAMES[item.type]) {
      const s = seg(i, () => ({ kind: "server", text: "", id: item.id ?? uid("srv"), name: SERVER_NAMES[item.type], status: "running" }));
      byItem.set(item.id, s);
      const inp = searchInput(item);
      if (Object.keys(inp).length) s.input = inp;
      if (done) {
        s.status = item.status === "failed" ? "error" : "done";
        const src = sourcesOf(item);
        if (src.length) s.result = src.join("\n\n");
        else if (item.status === "failed") s.result = "The search failed.";
      }
    } else if (item.type === "message" && done) {
      const s = seg(i, () => ({ kind: "text", text: "" }));
      const text = (item.content ?? []).map((c: Json) => c.text ?? "").join("");
      if (text && !s.text) s.text = text;
      for (const c of item.content ?? []) for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url && !citations.some((x) => x.url === a.url)) citations.push({ url: a.url, title: a.title });
    } else if (item.type === "reasoning" && done) {
      const s = seg(i, () => ({ kind: "thinking", text: "" }));
      const text = [...(item.summary ?? []), ...(item.content ?? [])].map((c: Json) => c.text ?? "").join("\n");
      if (text && !s.text) s.text = text;
    }
  };

  for await (const ev of sseEvents(res, req.signal)) {
    if (ev.data === "[DONE]") break;
    let e: Json;
    try {
      e = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (e.type) {
      case "response.output_text.delta":
        seg(Number(e.output_index ?? 0), () => ({ kind: "text", text: "" })).text += e.delta ?? "";
        break;
      case "response.output_text.annotation.added": {
        const a = e.annotation ?? {};
        if (a.type === "url_citation" && a.url && !citations.some((x) => x.url === a.url)) citations.push({ url: a.url, title: a.title });
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        seg(Number(e.output_index ?? 0), () => ({ kind: "thinking", text: "" })).text += e.delta ?? "";
        break;
      case "response.output_item.added":
        onItem(e, false);
        break;
      case "response.output_item.done":
        onItem(e, true);
        break;
      case "response.function_call_arguments.delta": {
        const s = byItem.get(e.item_id);
        if (s) s.args = (s.args ?? "") + (e.delta ?? "");
        break;
      }
      case "response.web_search_call.searching":
      case "response.x_search_call.searching": {
        const s = byItem.get(e.item_id);
        if (s) s.status = "running";
        break;
      }
      case "response.completed":
      case "response.done":
      case "response.incomplete": {
        const r = e.response ?? {};
        status = r.status ?? (e.type === "response.incomplete" ? "incomplete" : "completed");
        incomplete = r.incomplete_details?.reason ?? "";
        const u = r.usage;
        if (u) usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.input_tokens_details?.cached_tokens };
        break;
      }
      case "response.failed":
      case "error": {
        const err = e.response?.error ?? e.error ?? e;
        const msg = String(err.message ?? "xAI could not finish the reply.");
        if (native && /search|x_search|web_search|tool/i.test(msg) && !ACCOUNT_TROUBLE.test(msg)) throw new NativeSearchUnavailable(msg.slice(0, 160));
        throw new ProviderError(msg);
      }
    }
    req.onUpdate(snapshot(false));
  }

  for (const s of segs.values()) if (s.kind === "call" && !s.id) s.id = uid("call_");
  const parts = snapshot(true);
  let stop: StopKind = parts.some((p) => p.type === "tool_call" && !p.server) ? "tool_use" : "end";
  let stopDetail: string | undefined;
  if (status === "incomplete") {
    stop = "max_tokens";
    stopDetail = incomplete === "content_filter" ? "xAI's content filter stopped this reply." : "The reply hit the output limit and was cut off.";
  }
  return { parts, stop, stopDetail, usage };
}

function parseArgs(args: string, final: boolean): unknown {
  if (!args.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return final ? { __invalid_json: args } : { __partial: args };
  }
}

export const xaiAdapter: ProviderAdapter = {
  listModels,
  async chat(req) {
    const auth = await xaiAuth(req.provider, req.apiKey);
    if (!auth) throw new ProviderError("Grok needs an API key or Sign in with X (Settings → Providers & keys → xAI).");
    const withKey = (key: string) => (req.options.webSearch ? responsesChat(req, { mode: "key", token: key }, true) : openaiAdapter.chat({ ...req, apiKey: key }));
    if (auth.mode === "key") return withKey(auth.token);
    // the subscription gateway speaks the Responses API, with or without xAI's search
    try {
      return await responsesChat(req, auth, req.options.webSearch);
    } catch (e) {
      // the gateway refused the account (no credits, plan, version, outage): the API key still works
      if (!req.apiKey || !(e instanceof ProviderError) || e instanceof NativeSearchUnavailable || !gatewayRefusal(e)) throw e;
      const r = await withKey(req.apiKey);
      return { ...r, notice: `Grok's subscription gateway refused this request (${e.message.slice(0, 140)}), so it went through your xAI API key instead.` };
    }
  },
};
