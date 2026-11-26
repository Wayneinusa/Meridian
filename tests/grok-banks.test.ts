import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bankTools, listAccounts, listTransactions, plaidLinkFinish, simplefinClaim } from "../src/connectors/banks";
import { saveTokens } from "../src/connectors/oauth";
import { setSecret } from "../src/platform/secrets";
import { adoptRequiredVersion, buildResponsesBody, signInWithX, XAI_CLIENT_ID, xaiAdapter } from "../src/providers/xai";
import type { ChatRequest } from "../src/providers/types";
import type { McpServerConfig, Message, ModelInfo, Part, ProviderConfig } from "../src/types";
import { bytesToBase64, utf8 } from "../src/util/bytes";

// the keychain stand-in outside the app is localStorage
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

const sse = (events: object[]) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const grok: ModelInfo = { id: "grok-4", name: "Grok 4", kind: "chat", caps: { vision: true, pdf: false, tools: true, thinking: true } };
const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "xai", kind: "xai", name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", enabled: true, models: [grok], hasKey: true, ...over });
const user = (text: string): Message => ({ id: "m1", role: "user", createdAt: 1, updatedAt: 1, parts: [{ type: "text", text }] });
function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    provider: provider(),
    apiKey: "xai-key",
    model: grok,
    system: "Be brief.",
    messages: [user("What happened today?")],
    tools: [{ name: "calculator", description: "Math", inputSchema: { type: "object", properties: { expr: { type: "string" } } } }],
    options: { params: {}, webSearch: true, refusalFallback: false },
    signal: new AbortController().signal,
    onUpdate: () => undefined,
    blobs: { base64: async () => null, put: async () => ({ blobId: "b", mime: "", name: "", size: 0 }) },
    ...over,
  };
}

const SEARCH_STREAM = [
  { type: "response.created", response: { id: "r1" } },
  { type: "response.output_item.added", output_index: 0, item: { id: "ws1", type: "web_search_call", status: "in_progress" } },
  { type: "response.web_search_call.searching", item_id: "ws1" },
  { type: "response.output_item.done", output_index: 0, item: { id: "ws1", type: "web_search_call", status: "completed", action: { type: "search", query: "news today", sources: [{ type: "url", url: "https://news.example/a" }] } } },
  { type: "response.output_item.added", output_index: 1, item: { id: "xs1", type: "x_search_call", status: "in_progress", arguments: '{"query":"#launch"}' } },
  { type: "response.output_item.done", output_index: 1, item: { id: "xs1", type: "x_search_call", status: "completed", arguments: '{"query":"#launch"}' } },
  { type: "response.output_text.delta", output_index: 2, delta: "A rocket launched " },
  { type: "response.output_text.delta", output_index: 2, delta: "[[1]](https://x.com/s/1)." },
  { type: "response.output_text.annotation.added", output_index: 2, annotation: { type: "url_citation", url: "https://x.com/s/1", title: "Post" } },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 12 } } },
];

describe("Grok native search (xAI Responses API)", () => {
  it("adds web_search and x_search next to the app's own tools", () => {
    const body = buildResponsesBody(request(), [], true);
    expect(body.tools).toEqual([
      { type: "function", name: "calculator", description: "Math", parameters: { type: "object", properties: { expr: { type: "string" } } } },
      { type: "web_search" },
      { type: "x_search" },
    ]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(buildResponsesBody(request(), [], false).tools).toHaveLength(1);
  });

  it("streams search calls as cited server tool calls and the answer as text", async () => {
    const calls: { url: string; body: any; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), headers: new Headers(init.headers) });
      return sse(SEARCH_STREAM);
    });
    const updates: Part[][] = [];
    const r = await xaiAdapter.chat(request({ onUpdate: (p) => updates.push(p) }));
    expect(calls[0].url).toBe("https://api.x.ai/v1/responses");
    expect(calls[0].headers.get("authorization")).toBe("Bearer xai-key");
    expect(calls[0].body.input[0]).toEqual({ role: "system", content: "Be brief." });
    expect(calls[0].body.input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "What happened today?" }] });
    const [web, x, text] = r.parts as any[];
    expect(web).toMatchObject({ type: "tool_call", name: "web_search", server: true, status: "done", input: { query: "news today" }, result: { text: "https://news.example/a" } });
    expect(x).toMatchObject({ type: "tool_call", name: "x_search", server: true, status: "done", input: { query: "#launch" } });
    expect(x.result.text).toContain("https://x.com/s/1"); // cited sources fill in when the call itself lists none
    expect(text).toEqual({ type: "text", text: "A rocket launched [[1]](https://x.com/s/1)." });
    expect(r.stop).toBe("end");
    expect(r.usage).toEqual({ input: 40, output: 12, cacheRead: undefined });
    expect(updates.some((u) => u.some((p: any) => p.type === "tool_call" && p.status === "running"))).toBe(true);
  });

  it("returns function calls for the app to run, and sends their results back", async () => {
    let n = 0;
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      if (n++ === 0)
        return sse([
          { type: "response.output_item.added", output_index: 0, item: { id: "fc1", type: "function_call", call_id: "call_9", name: "calculator", arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, delta: '{"expr":' },
          { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 0, delta: '"2+2"}' },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      return sse([{ type: "response.output_text.delta", output_index: 0, delta: "4" }, { type: "response.completed", response: { status: "completed" } }]);
    });
    const first = await xaiAdapter.chat(request());
    expect(first.stop).toBe("tool_use");
    expect(first.parts[0]).toMatchObject({ type: "tool_call", id: "call_9", name: "calculator", input: { expr: "2+2" } });
    const assistant: Message = { id: "a1", role: "assistant", createdAt: 2, updatedAt: 2, parts: [{ ...(first.parts[0] as any), status: "done", result: { text: "4" } }] };
    await xaiAdapter.chat(request({ messages: [user("2+2?"), assistant] }));
    expect(bodies[1].input.slice(2)).toEqual([
      { type: "function_call", call_id: "call_9", name: "calculator", arguments: '{"expr":"2+2"}', status: "completed" },
      { type: "function_call_output", call_id: "call_9", output: "4" },
    ]);
  });

  it("uses Chat Completions when native search is off and there is only a key", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const r = await xaiAdapter.chat(request({ options: { params: {}, webSearch: false, refusalFallback: false } }));
    expect(urls[0]).toBe("https://api.x.ai/v1/chat/completions");
    expect(r.parts).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("Sign in with X", () => {
  it("signs in with a device code against auth.x.ai", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, body: new URLSearchParams(init.body as string) });
      if (url.endsWith("/oauth2/device/code")) return Response.json({ device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/device", interval: 1, expires_in: 600 });
      return Response.json({ access_token: "oauth-at", refresh_token: "oauth-rt", expires_in: 21600 });
    });
    let shown = "";
    const t = await signInWithX("device", (c) => void (shown = c.user_code));
    expect(shown).toBe("ABCD-EFGH");
    expect(calls[0].url).toBe("https://auth.x.ai/oauth2/device/code");
    expect(calls[0].body.get("client_id")).toBe(XAI_CLIENT_ID);
    expect(calls[0].body.get("scope")).toContain("api:access");
    expect(calls[1].url).toBe("https://auth.x.ai/oauth2/token");
    expect(t.access_token).toBe("oauth-at");
  }, 10_000);

  it("prefers the sign-in over the key: Grok's gateway, its headers, and a refresh after 401", async () => {
    await saveTokens("provider.xai", { access_token: "old", refresh_token: "rt", expires_at: Date.now() + 3_600_000, client_id: XAI_CLIENT_ID, token_endpoint: "https://auth.x.ai/oauth2/token" });
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, headers: new Headers(init.headers) });
      if (url === "https://auth.x.ai/oauth2/token") return Response.json({ access_token: "new", refresh_token: "rt2", expires_in: 21600 });
      if (new Headers(init.headers).get("authorization") === "Bearer old") return new Response("expired", { status: 401 });
      return sse([{ type: "response.output_text.delta", output_index: 0, delta: "hello" }, { type: "response.completed", response: { status: "completed" } }]);
    });
    const r = await xaiAdapter.chat(request({ provider: provider({ signedIn: true }), options: { params: {}, webSearch: false, refusalFallback: false } }));
    expect(r.parts).toEqual([{ type: "text", text: "hello" }]);
    const gateway = calls.filter((c) => c.url === "https://cli-chat-proxy.grok.com/v1/responses");
    expect(gateway).toHaveLength(2);
    expect(gateway[1].headers.get("authorization")).toBe("Bearer new");
    expect(gateway[1].headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(gateway[1].headers.get("x-grok-model-override")).toBe("grok-4");
    expect(calls.some((c) => c.url.includes("api.x.ai"))).toBe(false);
  });

  it("sends a client version xAI accepts, and adopts a newer minimum from a 426", async () => {
    await saveTokens("provider.xai", { access_token: "tok", expires_at: Date.now() + 3_600_000, client_id: XAI_CLIENT_ID, token_endpoint: "https://auth.x.ai/oauth2/token" });
    const versions: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const v = new Headers(init.headers).get("x-grok-client-version") ?? "";
      versions.push(v);
      if (v !== "1.2.0") return Response.json({ error: `Your Grok CLI version (${v}) is outdated. Please update to version 1.2.0 or later via \`grok update\` or the installation documentation.` }, { status: 426 });
      return sse([{ type: "response.output_text.delta", output_index: 0, delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
    });
    const r = await xaiAdapter.chat(request({ provider: provider({ signedIn: true }), options: { params: {}, webSearch: false, refusalFallback: false } }));
    expect(r.parts).toEqual([{ type: "text", text: "ok" }]);
    expect(versions[0]).toMatch(/^1\.\d+\.\d+$/);
    expect(versions.at(-1)).toBe("1.2.0");
    // never goes backwards, and nonsense is ignored
    expect(adoptRequiredVersion("Please update to version 1.0.13 or later")).toBe(false);
    expect(adoptRequiredVersion("server error")).toBe(false);
  });

  it("lists the subscription's models from the gateway", async () => {
    await saveTokens("provider.xai", { access_token: "tok", expires_at: Date.now() + 3_600_000, client_id: XAI_CLIENT_ID, token_endpoint: "https://auth.x.ai/oauth2/token" });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "https://cli-chat-proxy.grok.com/v1/models-v2") return Response.json({ data: [{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 256000 }, { id: "grok-composer-2", name: "Composer" }, { id: "hidden-x", hidden: true }] });
      return Response.json({ data: [{ id: "grok-imagine-image" }] });
    });
    const models = await xaiAdapter.listModels(provider({ signedIn: true, hasKey: false }), "");
    expect(models.map((m) => `${m.id}:${m.kind}`)).toEqual(["grok-4.6:chat", "grok-imagine-image:image"]);
  });
});

describe("banks", () => {
  it("SimpleFIN: claims a setup token, reads balances and transactions with basic auth", async () => {
    const access = "https://user1:pa%24s@bridge.test/simplefin";
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      if (url === "https://bridge.test/claim/abc") return new Response(access);
      const u = new URL(url);
      const acct = (txs: boolean) => ({
        org: { name: "Capital One" },
        id: "a1",
        name: "Venture Card",
        currency: "USD",
        balance: "-120.50",
        "available-balance": "4879.50",
        "balance-date": 1763000000,
        ...(txs ? { transactions: [{ id: "t1", posted: 1762900000, amount: "-42.10", description: "COFFEE SHOP", payee: "Blue Bottle" }] } : {}),
      });
      return Response.json({ errors: [], accounts: [acct(!u.searchParams.get("balances-only")), { org: { name: "Wells Fargo" }, id: "w1", name: "Checking", balance: "900.00" }] });
    });
    const got = await simplefinClaim(bytesToBase64(utf8.encode("https://bridge.test/claim/abc")));
    expect(got).toBe(access);
    const { accounts } = await listAccounts({ simplefin: access });
    expect(seen[1].url).toBe("https://bridge.test/simplefin/accounts?balances-only=1");
    expect(seen[1].auth).toBe(`Basic ${bytesToBase64(utf8.encode("user1:pa$s"))}`);
    expect(accounts[0]).toMatchObject({ id: "sf:a1", institution: "Capital One", balance: -120.5, available: 4879.5 });
    const txs = await listTransactions({ simplefin: access }, accounts[0], 30);
    expect(txs[0]).toMatchObject({ amount: -42.1, description: "Blue Bottle · COFFEE SHOP" });
  });

  it("the Capital One connector only shows Capital One, and asks before reading", async () => {
    await setSecret("bank.simplefin.access", "https://u:p@bridge.test/simplefin");
    vi.stubGlobal("fetch", async () => Response.json({ accounts: [{ org: { name: "Capital One" }, id: "a1", name: "Venture", balance: "1.00" }, { org: { name: "Wells Fargo" }, id: "w1", name: "Checking", balance: "2.00" }] }));
    const server: McpServerConfig = { id: "c1", name: "Capital One", transport: "native", enabled: true, catalogId: "capitalone" };
    const [list] = bankTools([server], async (n) => (n === "bank.simplefin.access" ? "https://u:p@bridge.test/simplefin" : null));
    expect(list.needsApproval({}, {} as never)).toBe(true);
    const out = await list.run({}, { signal: undefined } as never);
    expect(out.text).toContain("Capital One · Venture");
    expect(out.text).not.toContain("Wells Fargo");
    expect(bankTools([{ ...server, trusted: true }], async () => null)[0].needsApproval({}, {} as never)).toBe(false);
  });

  it("Plaid: waits for the hosted sign-in and exchanges the token", async () => {
    let polls = 0;
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const p = new URL(url).pathname;
      paths.push(p);
      if (p === "/link/token/get") return Response.json({ link_sessions: ++polls < 2 ? [] : [{ results: { item_add_results: [{ public_token: "public-1", institution: { name: "Wells Fargo" } }] } }] });
      if (p === "/item/public_token/exchange") return Response.json({ access_token: "access-1", item_id: "item-1" });
      return Response.json({});
    });
    const items = await plaidLinkFinish({ clientId: "c", secret: "s", env: "sandbox" }, "link-1", { pollMs: 1 });
    expect(items).toEqual([{ itemId: "item-1", accessToken: "access-1", institution: "Wells Fargo" }]);
    expect(paths).toEqual(["/link/token/get", "/link/token/get", "/item/public_token/exchange"]);
  });
});

import { manualRedirect, signIn } from "../src/connectors/oauth";

describe("pasting the code when the sign-in page shows it", () => {
  it("turns a bare code, a query or a full address into the redirect", () => {
    expect(manualRedirect("ot26g20rf3A-juMFb_Jhr", "http://127.0.0.1:56121/callback", "st1")).toBe("http://127.0.0.1:56121/callback?code=ot26g20rf3A-juMFb_Jhr&state=st1");
    expect(manualRedirect("http://127.0.0.1:56121/callback?code=a&state=b", "x", "y")).toBe("http://127.0.0.1:56121/callback?code=a&state=b");
    expect(manualRedirect("code=a&state=b", "http://h/cb", "y")).toBe("http://h/cb?code=a&state=b");
    expect(() => manualRedirect("hello there!", "http://h/cb", "y")).toThrow(/sign-in code/);
  });

  it("finishes the browser sign-in with a pasted code (PKCE verifier from this attempt)", async () => {
    const bodies: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(new URLSearchParams(init.body as string));
      return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: "x.eyJlbWFpbCI6ImFAYi5jIn0.y" });
    });
    let cancelled = false;
    let opened = "";
    const t = await signIn({
      server: { authorization_endpoint: "https://auth.x.ai/oauth2/authorize", token_endpoint: "https://auth.x.ai/oauth2/token" },
      clientId: XAI_CLIENT_ID,
      scopes: ["openid"],
      open: async (u) => void (opened = u),
      // the loopback never hears back (the page showed the code instead)
      redirect: { uri: "http://127.0.0.1:56121/callback", wait: () => new Promise<string>(() => undefined), cancel: () => void (cancelled = true) },
      manual: Promise.resolve("PASTEDCODE123"),
    });
    expect(t.access_token).toBe("AT");
    expect(cancelled).toBe(true);
    const challenge = new URL(opened).searchParams.get("code_challenge");
    expect(challenge).toBeTruthy();
    expect(bodies[0].get("code")).toBe("PASTEDCODE123");
    expect(bodies[0].get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(bodies[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("cancelling frees the loopback port", async () => {
    let cancelled = false;
    await expect(
      signIn({
        server: { authorization_endpoint: "https://a/authorize", token_endpoint: "https://a/token" },
        clientId: "c",
        open: async () => undefined,
        redirect: { uri: "http://127.0.0.1:56121/callback", wait: () => new Promise<string>(() => undefined), cancel: () => void (cancelled = true) },
        manual: Promise.reject(new Error("cancelled by the user")),
      }),
    ).rejects.toThrow(/cancelled/);
    expect(cancelled).toBe(true);
  });
});
