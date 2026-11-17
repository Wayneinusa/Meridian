// Google Workspace and Microsoft 365 connectors, calling their APIs directly.
// Each user registers their own OAuth app (Google Cloud / Microsoft Entra),
// because these providers do not let apps register themselves.
import { httpFetch, readError } from "../platform/http";
import { extractText } from "../tools/extract";
import type { Tool } from "../tools/types";
import { htmlToText } from "../tools/web";
import type { McpServerConfig } from "../types";
import { base64ToBytes, bytesToBase64, utf8 } from "../util/bytes";
import { accessToken, signIn, type AuthServer, type OAuthTokens } from "./oauth";

export const GOOGLE: AuthServer = { authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: "https://oauth2.googleapis.com/token" };
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive.readonly", "openid", "email"];
export const microsoftServer = (tenant = "common"): AuthServer => ({
  authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
});
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "Files.Read.All"];

export async function signInNative(cfg: McpServerConfig, app: { clientId: string; clientSecret?: string; tenant?: string }): Promise<OAuthTokens> {
  if (cfg.catalogId === "google") {
    return signIn({ server: GOOGLE, clientId: app.clientId, clientSecret: app.clientSecret, scopes: GOOGLE_SCOPES, extraAuthParams: { access_type: "offline", prompt: "consent" } });
  }
  return signIn({ server: microsoftServer(app.tenant), clientId: app.clientId, scopes: MICROSOFT_SCOPES });
}

type Call = (path: string, init?: RequestInit) => Promise<any>;

function api(id: string, base: string): Call {
  return async (path, init = {}) => {
    const token = await accessToken(id);
    if (!token) throw new Error("Not signed in. Sign in under Settings → Connectors.");
    const res = await httpFetch(path.startsWith("http") ? path : base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) } });
    if (!res.ok) throw new Error(await readError(res));
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) return res.json();
    return new Uint8Array(await res.arrayBuffer());
  };
}

const b64url = (s: string) => bytesToBase64(utf8.encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => utf8.decode(base64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/")));

function rfc822(to: string, subject: string, body: string, cc?: string, inReplyTo?: string): string {
  const enc = `=?UTF-8?B?${bytesToBase64(utf8.encode(subject))}?=`;
  return [`To: ${to}`, cc ? `Cc: ${cc}` : "", `Subject: ${enc}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : "", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", body].filter((l, i) => l !== "" || i > 4).join("\r\n");
}

function gmailBody(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return fromB64url(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html ? htmlToText(fromB64url(html.body.data)) : "";
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });

function tool(prefix: string, label: string, name: string, description: string, schema: Record<string, unknown>, confirm: boolean, run: (i: Record<string, any>) => Promise<string>): Tool {
  return {
    group: "connectors",
    title: `${label}: ${name.replace(/_/g, " ")}`,
    spec: { name: `${prefix}_${name}`, description: `[${label}] ${description}`, inputSchema: schema },
    needsApproval: () => confirm,
    summarize: (i) => `${label} → ${name}(${JSON.stringify(i).slice(0, 160)})`,
    run: async (i) => ({ text: (await run(i)).slice(0, 60_000) }),
  };
}

export function googleTools(cfg: McpServerConfig): Tool[] {
  const g = api(cfg.id, "");
  const L = "Google";
  return [
    tool("gmail", L, "search", "Search Gmail with Gmail search syntax (from:, subject:, newer_than:7d, is:unread...). Returns id, from, subject, date and snippet.", obj({ query: str("Gmail search query"), max: { type: "integer" } }, ["query"]), false, async (i) => {
      const list = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${Math.min(i.max ?? 10, 30)}&q=${encodeURIComponent(i.query)}`);
      const out = [];
      for (const m of list.messages ?? []) {
        const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const h = Object.fromEntries((d.payload?.headers ?? []).map((x: any) => [x.name, x.value]));
        out.push({ id: m.id, threadId: m.threadId, from: h.From, subject: h.Subject, date: h.Date, snippet: d.snippet, unread: (d.labelIds ?? []).includes("UNREAD") });
      }
      return JSON.stringify(out, null, 1) || "No messages.";
    }),
    tool("gmail", L, "read", "Read a Gmail message (full text) by id.", obj({ id: str("message id") }, ["id"]), false, async (i) => {
      const d = await g(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(i.id)}?format=full`);
      const h = Object.fromEntries((d.payload?.headers ?? []).map((x: any) => [x.name, x.value]));
      return `From: ${h.From}\nTo: ${h.To}\nDate: ${h.Date}\nSubject: ${h.Subject}\nMessage-ID: ${h["Message-ID"] ?? ""}\n\n${gmailBody(d.payload)}`;
    }),
    tool("gmail", L, "create_draft", "Create a Gmail draft (not sent).", obj({ to: str("recipients, comma separated"), subject: str("subject"), body: str("plain text body"), cc: str("optional cc") }, ["to", "subject", "body"]), false, async (i) => {
      const d = await g("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", body: JSON.stringify({ message: { raw: b64url(rfc822(i.to, i.subject, i.body, i.cc)) } }) });
      return `Draft created (id ${d.id}). The user can review and send it from Gmail.`;
    }),
    tool("gmail", L, "send", "Send an email from the user's Gmail. Always confirm the exact text with the user first.", obj({ to: str("recipients"), subject: str("subject"), body: str("plain text body"), cc: str("optional cc"), thread_id: str("optional thread to reply in") }, ["to", "subject", "body"]), true, async (i) => {
      const d = await g("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(rfc822(i.to, i.subject, i.body, i.cc)), ...(i.thread_id ? { threadId: i.thread_id } : {}) }) });
      return `Sent (id ${d.id}).`;
    }),
    tool("calendar", L, "list_events", "List Google Calendar events between two times (ISO 8601). Defaults to the next 7 days.", obj({ time_min: str("start, ISO 8601"), time_max: str("end, ISO 8601"), query: str("optional text filter"), calendar_id: str("default primary") }), false, async (i) => {
      const min = i.time_min ?? new Date().toISOString();
      const max = i.time_max ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
      const d = await g(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(i.calendar_id ?? "primary")}/events?singleEvents=true&orderBy=startTime&maxResults=100&timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}${i.query ? `&q=${encodeURIComponent(i.query)}` : ""}`);
      return JSON.stringify((d.items ?? []).map((e: any) => ({ id: e.id, title: e.summary, start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, location: e.location, attendees: (e.attendees ?? []).map((a: any) => a.email), link: e.htmlLink })), null, 1);
    }),
    tool("calendar", L, "create_event", "Create a Google Calendar event (invites attendees if given).", obj({ title: str("title"), start: str("ISO 8601 start"), end: str("ISO 8601 end"), description: str("optional"), location: str("optional"), attendees: { type: "array", items: { type: "string" } }, time_zone: str("IANA zone, optional") }, ["title", "start", "end"]), true, async (i) => {
      const tz = i.time_zone ? { timeZone: i.time_zone } : {};
      const e = await g("https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", { method: "POST", body: JSON.stringify({ summary: i.title, description: i.description, location: i.location, start: { dateTime: i.start, ...tz }, end: { dateTime: i.end, ...tz }, attendees: (i.attendees ?? []).map((email: string) => ({ email })) }) });
      return `Created: ${e.htmlLink}`;
    }),
    tool("drive", L, "search", "Search Google Drive by text. Returns file ids, names, types and links.", obj({ query: str("words to find"), max: { type: "integer" } }, ["query"]), false, async (i) => {
      const q = `fullText contains '${String(i.query).replace(/'/g, "\\'")}' and trashed = false`;
      const d = await g(`https://www.googleapis.com/drive/v3/files?pageSize=${Math.min(i.max ?? 15, 50)}&q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))`);
      return JSON.stringify(d.files ?? [], null, 1);
    }),
    tool("drive", L, "read", "Read a Google Drive file's text (Docs, Sheets as CSV, Slides, PDF, Word, text).", obj({ id: str("file id") }, ["id"]), false, async (i) => {
      const meta = await g(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(i.id)}?fields=id,name,mimeType`);
      const exportAs: Record<string, string> = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv", "application/vnd.google-apps.presentation": "text/plain" };
      const bytes: Uint8Array = exportAs[meta.mimeType]
        ? await g(`https://www.googleapis.com/drive/v3/files/${meta.id}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType])}`)
        : await g(`https://www.googleapis.com/drive/v3/files/${meta.id}?alt=media`);
      if (exportAs[meta.mimeType]) return `# ${meta.name}\n\n${utf8.decode(bytes)}`;
      const ex = await extractText(bytes, meta.name, meta.mimeType);
      return ex.text ? `# ${meta.name}\n\n${ex.text}` : `${meta.name} has no readable text (${meta.mimeType}).`;
    }),
  ];
}

export function microsoftTools(cfg: McpServerConfig): Tool[] {
  const g = api(cfg.id, "https://graph.microsoft.com/v1.0");
  const L = "Microsoft 365";
  const recips = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }));
  return [
    tool("outlook", L, "search", "Search Outlook mail. Returns id, from, subject, date and preview.", obj({ query: str("words to find"), max: { type: "integer" } }, ["query"]), false, async (i) => {
      const d = await g(`/me/messages?$search=${encodeURIComponent(`"${i.query}"`)}&$top=${Math.min(i.max ?? 10, 30)}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`, { headers: { ConsistencyLevel: "eventual" } });
      return JSON.stringify((d.value ?? []).map((m: any) => ({ id: m.id, from: m.from?.emailAddress?.address, subject: m.subject, date: m.receivedDateTime, preview: m.bodyPreview, unread: !m.isRead })), null, 1);
    }),
    tool("outlook", L, "read", "Read an Outlook message by id.", obj({ id: str("message id") }, ["id"]), false, async (i) => {
      const m = await g(`/me/messages/${encodeURIComponent(i.id)}?$select=subject,from,toRecipients,receivedDateTime,body`);
      const body = m.body?.contentType === "html" ? htmlToText(m.body.content) : (m.body?.content ?? "");
      return `From: ${m.from?.emailAddress?.address}\nTo: ${(m.toRecipients ?? []).map((r: any) => r.emailAddress.address).join(", ")}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${body}`;
    }),
    tool("outlook", L, "create_draft", "Create an Outlook draft (not sent).", obj({ to: str("recipients"), subject: str("subject"), body: str("plain text body") }, ["to", "subject", "body"]), false, async (i) => {
      const m = await g("/me/messages", { method: "POST", body: JSON.stringify({ subject: i.subject, body: { contentType: "Text", content: i.body }, toRecipients: recips(i.to) }) });
      return `Draft created (id ${m.id}).`;
    }),
    tool("outlook", L, "send", "Send an email from the user's Outlook. Always confirm the exact text with the user first.", obj({ to: str("recipients"), subject: str("subject"), body: str("plain text body"), cc: str("optional") }, ["to", "subject", "body"]), true, async (i) => {
      await g("/me/sendMail", { method: "POST", body: JSON.stringify({ message: { subject: i.subject, body: { contentType: "Text", content: i.body }, toRecipients: recips(i.to), ccRecipients: i.cc ? recips(i.cc) : [] } }) });
      return "Sent.";
    }),
    tool("outlook_calendar", L, "list_events", "List calendar events between two times (ISO 8601). Defaults to the next 7 days.", obj({ start: str("ISO 8601"), end: str("ISO 8601") }), false, async (i) => {
      const s = i.start ?? new Date().toISOString();
      const e = i.end ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
      const d = await g(`/me/calendarView?startDateTime=${encodeURIComponent(s)}&endDateTime=${encodeURIComponent(e)}&$top=100&$select=id,subject,start,end,location,attendees,webLink`);
      return JSON.stringify((d.value ?? []).map((v: any) => ({ id: v.id, title: v.subject, start: v.start?.dateTime, end: v.end?.dateTime, zone: v.start?.timeZone, location: v.location?.displayName, attendees: (v.attendees ?? []).map((a: any) => a.emailAddress?.address), link: v.webLink })), null, 1);
    }),
    tool("outlook_calendar", L, "create_event", "Create a calendar event (invites attendees if given).", obj({ title: str("title"), start: str("ISO 8601 local date-time"), end: str("ISO 8601 local date-time"), time_zone: str("e.g. Europe/Berlin or UTC"), location: str("optional"), body: str("optional"), attendees: { type: "array", items: { type: "string" } } }, ["title", "start", "end"]), true, async (i) => {
      const tz = i.time_zone ?? "UTC";
      const v = await g("/me/events", { method: "POST", body: JSON.stringify({ subject: i.title, body: { contentType: "Text", content: i.body ?? "" }, start: { dateTime: i.start, timeZone: tz }, end: { dateTime: i.end, timeZone: tz }, location: { displayName: i.location ?? "" }, attendees: (i.attendees ?? []).map((a: string) => ({ emailAddress: { address: a }, type: "required" })) }) });
      return `Created: ${v.webLink}`;
    }),
    tool("onedrive", L, "search", "Search OneDrive / SharePoint files the user can access.", obj({ query: str("words to find") }, ["query"]), false, async (i) => {
      const d = await g(`/me/drive/root/search(q='${encodeURIComponent(String(i.query).replace(/'/g, "''"))}')?$top=20&$select=id,name,webUrl,lastModifiedDateTime,size,file`);
      return JSON.stringify((d.value ?? []).map((f: any) => ({ id: f.id, name: f.name, link: f.webUrl, modified: f.lastModifiedDateTime, type: f.file?.mimeType })), null, 1);
    }),
    tool("onedrive", L, "read", "Read a OneDrive file's text (Word, Excel, PowerPoint, PDF, text).", obj({ id: str("item id") }, ["id"]), false, async (i) => {
      const meta = await g(`/me/drive/items/${encodeURIComponent(i.id)}?$select=id,name,file`);
      const bytes: Uint8Array = await g(`/me/drive/items/${encodeURIComponent(i.id)}/content`);
      const ex = await extractText(bytes, meta.name, meta.file?.mimeType ?? "");
      return ex.text ? `# ${meta.name}\n\n${ex.text}` : `${meta.name} has no readable text.`;
    }),
  ];
}

export async function nativeTools(servers: McpServerConfig[]): Promise<Tool[]> {
  const out: Tool[] = [];
  for (const s of servers) {
    if (!s.enabled || s.transport !== "native") continue;
    if (!(await accessToken(s.id))) continue;
    const tools = s.catalogId === "google" ? googleTools(s) : s.catalogId === "microsoft" ? microsoftTools(s) : [];
    out.push(...tools.map((t) => (s.trusted ? { ...t, needsApproval: () => false } : t)));
  }
  return out;
}
