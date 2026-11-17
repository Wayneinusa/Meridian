import { afterEach, describe, expect, it, vi } from "vitest";
import { searchRegistry } from "../src/connectors/catalog";
import { accessToken, saveTokens, signIn } from "../src/connectors/oauth";
import { McpClient, NeedsSignIn } from "../src/tools/mcp";

afterEach(() => vi.unstubAllGlobals());

describe("connector sign-in (OAuth 2.1 + PKCE + dynamic registration)", () => {
  it("discovers, registers, signs in and exchanges the code", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["read", "write"] });
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register" });
      if (url === "https://auth.example.com/register") return Response.json({ client_id: "client-123" });
      if (url === "https://auth.example.com/token") return Response.json({ access_token: "AT1", refresh_token: "RT1", expires_in: 3600, token_type: "Bearer" });
      return new Response("not found", { status: 404 });
    });
    let opened = "";
    const tokens = await signIn({
      resource: "https://mcp.example.com/mcp",
      redirect: { uri: "http://127.0.0.1:5555/callback", wait: async () => { const u = new URL(opened); return `http://127.0.0.1:5555/callback?code=CODE9&state=${u.searchParams.get("state")}`; } },
      open: async (u) => void (opened = u),
    });
    const auth = new URL(opened);
    expect(auth.origin + auth.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({ response_type: "code", client_id: "client-123", redirect_uri: "http://127.0.0.1:5555/callback", code_challenge_method: "S256", scope: "read write", resource: "https://mcp.example.com/mcp" });
    const reg = JSON.parse(calls.find((c) => c.url.endsWith("/register"))!.init!.body as string);
    expect(reg).toMatchObject({ client_name: "Meridian", redirect_uris: ["http://127.0.0.1:5555/callback"], token_endpoint_auth_method: "none" });
    const tokenBody = new URLSearchParams(calls.find((c) => c.url.endsWith("/token"))!.init!.body as string);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("CODE9");
    expect(tokenBody.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens).toMatchObject({ access_token: "AT1", refresh_token: "RT1", client_id: "client-123", token_endpoint: "https://auth.example.com/token" });
    // the challenge is SHA-256 of the verifier
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenBody.get("code_verifier")!)));
    const b64 = Buffer.from(digest).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(auth.searchParams.get("code_challenge")).toBe(b64);
  });

  it("rejects a redirect with the wrong state", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}));
    await expect(
      signIn({ server: { authorization_endpoint: "https://a/authorize", token_endpoint: "https://a/token" }, clientId: "c", redirect: { uri: "x://cb", wait: async () => "x://cb?code=1&state=evil" }, open: async () => undefined }),
    ).rejects.toThrow(/state mismatch/);
  });

  it("refreshes an expired token", async () => {
    globalThis.localStorage?.clear?.();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    await saveTokens("srv", { access_token: "old", refresh_token: "R", expires_at: Date.now() - 1000, client_id: "c", token_endpoint: "https://a/token" });
    let body = "";
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return Response.json({ access_token: "new", expires_in: 60 });
    });
    expect(await accessToken("srv")).toBe("new");
    expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
    expect(JSON.parse(store.get("meridian.secret.oauth.srv")!).refresh_token).toBe("R");
  });

  it("reports a connector that needs sign-in", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal("fetch", async () => new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } }));
    const c = new McpClient({ id: "n", name: "Notion", transport: "http", url: "https://mcp.example.com/mcp", enabled: true });
    const err = await c.connect().catch((e) => e);
    expect(err).toBeInstanceOf(NeedsSignIn);
    expect(err.resourceMetadata).toBe("https://mcp.example.com/.well-known/oauth-protected-resource");
  });

  it("reads remote servers from the MCP registry", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ servers: [{ server: { name: "com.notion/mcp", title: "Notion", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }, { type: "sse", url: "https://mcp.notion.com/sse" }] } }, { server: { name: "x/templated", remotes: [{ type: "streamable-http", url: "https://x/{token}" }] } }] }),
    );
    expect(await searchRegistry("notion")).toEqual([{ name: "com.notion/mcp", title: "Notion", description: undefined, version: undefined, url: "https://mcp.notion.com/mcp", transport: "http", website: undefined }]);
  });
});
