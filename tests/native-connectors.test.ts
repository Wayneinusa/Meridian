import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleTools, microsoftTools, nativeTools } from "../src/connectors/native";
import { saveTokens } from "../src/connectors/oauth";
import type { McpServerConfig } from "../src/types";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
});
afterEach(() => vi.unstubAllGlobals());

const google: McpServerConfig = { id: "g1", name: "Google Workspace", transport: "native", enabled: true, catalogId: "google" };
const ms: McpServerConfig = { id: "m1", name: "Microsoft 365", transport: "native", enabled: true, catalogId: "microsoft" };
const ctx = {} as never;

describe("native connectors", () => {
  it("offers tools only once signed in", async () => {
    expect(await nativeTools([google, ms])).toHaveLength(0);
    await saveTokens("g1", { access_token: "G", client_id: "c", token_endpoint: "t" });
    const tools = await nativeTools([google, ms]);
    expect(tools.map((t) => t.spec.name)).toEqual(["gmail_search", "gmail_read", "gmail_create_draft", "gmail_send", "calendar_list_events", "calendar_create_event", "drive_search", "drive_read"]);
    expect(tools.find((t) => t.spec.name === "gmail_send")!.needsApproval({}, ctx)).toBe(true);
    expect(tools.find((t) => t.spec.name === "gmail_search")!.needsApproval({}, ctx)).toBe(false);
  });

  it("searches Gmail and drafts mail with the stored token", async () => {
    await saveTokens("g1", { access_token: "G", client_id: "c", token_endpoint: "t" });
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/messages?")) return Response.json({ messages: [{ id: "a1", threadId: "t1" }] });
      if (url.includes("/messages/a1")) return Response.json({ snippet: "Lunch?", labelIds: ["UNREAD"], payload: { headers: [{ name: "From", value: "ann@x.com" }, { name: "Subject", value: "Hi" }] } });
      if (url.endsWith("/drafts")) return Response.json({ id: "d1" });
      return new Response("?", { status: 404 });
    });
    const [search, , draft] = googleTools(google);
    const out = JSON.parse((await search.run({ query: "is:unread" }, ctx)).text);
    expect(out).toEqual([{ id: "a1", threadId: "t1", from: "ann@x.com", subject: "Hi", snippet: "Lunch?", unread: true }]);
    expect((calls[0].init!.headers as Record<string, string>).Authorization).toBe("Bearer G");
    expect(calls[0].url).toContain("q=is%3Aunread");
    expect((await draft.run({ to: "bob@x.com", subject: "Grüße", body: "See you" }, ctx)).text).toMatch(/Draft created/);
    const raw = JSON.parse(calls.at(-1)!.init!.body as string).message.raw as string;
    const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(mime).toContain("To: bob@x.com");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).toContain("See you");
  });

  it("sends Outlook mail through Microsoft Graph", async () => {
    await saveTokens("m1", { access_token: "M", client_id: "c", token_endpoint: "t" });
    let body: any;
    let url = "";
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(init.body as string);
      return new Response(null, { status: 202 });
    });
    const send = microsoftTools(ms).find((t) => t.spec.name === "outlook_send")!;
    expect((await send.run({ to: "a@x.com; b@x.com", subject: "S", body: "B" }, ctx)).text).toBe("Sent.");
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@x.com" } }]);
  });
});
