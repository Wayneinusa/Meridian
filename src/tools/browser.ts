// The assistant's own browser: open pages, read them as numbered text, click,
// type, fill forms, extract data, take screenshots. It runs in a separate
// browser profile, never the user's.
//
// Approval (default rules): reading never asks; going to a site the user did
// not mention, submitting a form, typing into a password or payment field,
// downloading and answering a login prompt ask first. "Ask for every action"
// is available in Settings.
import { closeSession, dropSession, emitView, getSession, sessionOf, type BrowserSession } from "../browser/session";
import { extractCall, focusCall, locateCall, selectCall, snapshotCall, type RefInfo, type Snapshot } from "../browser/page";
import { base64ToBytes } from "../util/bytes";
import type { Tool, ToolContext, ToolOutput } from "./types";

export const BROWSER_ACTIONS = ["open", "snapshot", "click", "type", "select", "fill_form", "press", "scroll", "back", "screenshot", "extract", "tabs", "new_tab", "switch_tab", "wait", "auth", "close"] as const;
type Action = (typeof BROWSER_ACTIONS)[number];
const READ_ONLY: Action[] = ["snapshot", "screenshot", "extract", "tabs", "wait", "scroll", "back", "switch_tab", "close", "select"];
const SNAPSHOT_CHARS = 9000;

const hostOf = (u: string) => {
  try {
    return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

/** Domains the user named in this chat (typed addresses and bare domains such as "amazon.com"). */
export function mentionedHosts(text: string): Set<string> {
  const out = new Set<string>();
  // full addresses (any host, IPs and localhost included) and bare domains
  for (const m of text.matchAll(/https?:\/\/[^\s/?#"'<>)]+/gi)) {
    const h = hostOf(m[0]);
    if (h) out.add(h);
  }
  for (const m of text.matchAll(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi)) out.add(m[1].replace(/^www\./, "").toLowerCase());
  return out;
}

const sameSite = (host: string, trusted: string) => host === trusted || host.endsWith(`.${trusted}`) || trusted.endsWith(`.${host}`);

function trustedUrl(url: string, ctx: ToolContext, session?: BrowserSession): boolean {
  const host = hostOf(url);
  if (!host || /^(about|data):/i.test(url)) return true;
  if (host === "localhost" || host === "127.0.0.1") return mentionedHosts(ctx.userText()).has(host);
  const trusted = new Set<string>([...mentionedHosts(ctx.userText()), ...(ctx.settings.browser?.allowSites ?? []).map((s) => hostOf(s)).filter(Boolean)]);
  for (const u of ctx.trustedUrls()) trusted.add(hostOf(u));
  if (session?.url) trusted.add(hostOf(session.url));
  return [...trusted].some((t) => t && sameSite(host, t));
}

/** the chat whose call is being checked: the approval text names the element from its page */
let lastConv = "";

export function browserNeedsApproval(i: Record<string, unknown>, ctx: ToolContext): boolean {
  const action = String(i.action) as Action;
  lastConv = ctx.conversationId;
  const session = sessionOf(ctx.conversationId);
  const each = (ctx.settings.browser?.approval ?? "rules") === "each";
  if (READ_ONLY.includes(action)) return each && !["snapshot", "screenshot", "extract", "tabs", "wait", "close"].includes(action);
  if (each) return true;
  const ref = (n: unknown): RefInfo | undefined => session?.refs[String(n)];
  switch (action) {
    case "open":
    case "new_tab":
      return !trustedUrl(String(i.url ?? ""), ctx, session);
    case "click": {
      const r = ref(i.ref);
      return !!(r?.submit || r?.download);
    }
    case "type": {
      const r = ref(i.ref);
      return !!(r?.password || r?.payment || i.submit);
    }
    case "fill_form":
      return !!i.submit || ((i.fields as { ref: unknown }[] | undefined) ?? []).some((f) => ref(f.ref)?.password || ref(f.ref)?.payment);
    case "press":
      return /enter/i.test(String(i.keys ?? "")) && !!(session?.lastTyped !== undefined && session.refs[String(session.lastTyped)]?.inForm);
    case "auth":
      return true;
    default:
      return false;
  }
}

function describe(i: Record<string, unknown>, session?: BrowserSession): string {
  const a = String(i.action) as Action;
  const el = (n: unknown) => {
    const r = session?.refs[String(n)];
    return r ? `${r.role} "${r.name.slice(0, 60)}"` : `element [${String(n)}]`;
  };
  switch (a) {
    case "open":
      return `Open ${String(i.url)}`;
    case "new_tab":
      return `Open ${String(i.url ?? "a new tab")} in a new tab`;
    case "click":
      return `Click ${el(i.ref)}${session?.refs[String(i.ref)]?.submit ? " (submits a form)" : ""}`;
    case "type": {
      const r = session?.refs[String(i.ref)];
      const shown = r?.password ? "••••••" : `"${String(i.text ?? "").slice(0, 60)}"`;
      return `Type ${shown} into ${el(i.ref)}${i.submit ? " and submit" : ""}`;
    }
    case "select":
      return `Choose "${String(i.value)}" in ${el(i.ref)}`;
    case "fill_form":
      return `Fill ${((i.fields as unknown[]) ?? []).length} fields${i.submit ? " and submit the form" : ""}`;
    case "press":
      return `Press ${String(i.keys)}`;
    case "auth":
      return `Sign in to the site's login prompt as ${String(i.username)}`;
    case "scroll":
      return `Scroll ${String(i.direction ?? "down")}`;
    default:
      return a === "snapshot" ? "Read the page" : a.replace("_", " ");
  }
}

function header(s: Snapshot): string {
  return `Page: ${s.title || "(untitled)"} — ${s.url}${s.scrolled > 0 ? ` (scrolled ${s.scrolled}%)` : ""}`;
}

async function look(session: BrowserSession, convId: string, ctx: ToolContext): Promise<Snapshot> {
  const snap = await session.driver.evaluate<Snapshot>(snapshotCall(SNAPSHOT_CHARS));
  session.refs = snap.refs;
  session.url = snap.url;
  session.title = snap.title;
  // a small picture for the browser panel (not sent to the model)
  try {
    const shot = await session.driver.screenshot();
    emitView(convId, { url: snap.url, title: snap.title, image: `data:${shot.mime};base64,${shot.data}`, engine: session.driver.kind });
  } catch {
    emitView(convId, { url: snap.url, title: snap.title, engine: session.driver.kind });
  }
  void ctx;
  return snap;
}

async function locate(session: BrowserSession, ref: unknown): Promise<{ x: number; y: number }> {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) throw new Error("ref must be the number of an element from the latest page view.");
  const at = await session.driver.evaluate<{ x: number; y: number } | null>(locateCall(n));
  if (!at) throw new Error(`Element [${n}] is no longer on the page. Read the page again (snapshot) and use the new numbers.`);
  return at;
}

async function typeInto(session: BrowserSession, ref: unknown, text: string) {
  const at = await locate(session, ref);
  await session.driver.click(at.x, at.y);
  await session.driver.evaluate(focusCall(Number(ref)));
  await session.driver.insertText(text);
  session.lastTyped = Number(ref);
}

function normaliseUrl(u: string): string {
  const t = u.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return `https://${t}`;
}

async function act(action: Action, i: Record<string, unknown>, session: BrowserSession, ctx: ToolContext): Promise<string> {
  const d = session.driver;
  switch (action) {
    case "open":
      await d.navigate(normaliseUrl(String(i.url ?? "")));
      return "Opened.";
    case "new_tab":
      await d.newTab(i.url ? normaliseUrl(String(i.url)) : undefined);
      return "Opened a new tab.";
    case "click": {
      const at = await locate(session, i.ref);
      await d.click(at.x, at.y, { button: i.button === "right" ? "right" : "left", count: i.double ? 2 : 1 });
      return `Clicked [${i.ref}].`;
    }
    case "type":
      await typeInto(session, i.ref, String(i.text ?? ""));
      if (i.submit) await d.press("Enter");
      return `Typed into [${i.ref}]${i.submit ? " and pressed Enter" : ""}.`;
    case "select":
      return String(await d.evaluate<string>(selectCall(Number(i.ref), String(i.value ?? ""))));
    case "fill_form": {
      const notes: string[] = [];
      for (const f of (i.fields as { ref: number; value: string }[] | undefined) ?? []) {
        const r = session.refs[String(f.ref)];
        if (r?.tag === "select") notes.push(String(await d.evaluate<string>(selectCall(Number(f.ref), String(f.value)))));
        else if (r?.type === "checkbox" || r?.type === "radio") {
          const want = /^(true|yes|on|1|checked)$/i.test(String(f.value));
          const checked = await d.evaluate<boolean>(`JSON.stringify(!!document.querySelector('[data-mer-ref="${Number(f.ref)}"]')?.checked)`);
          if (checked !== want) {
            const at = await locate(session, f.ref);
            await d.click(at.x, at.y);
          }
          notes.push(`[${f.ref}] ${want ? "checked" : "unchecked"}`);
        } else {
          await typeInto(session, f.ref, String(f.value ?? ""));
          notes.push(`[${f.ref}] filled`);
        }
      }
      if (i.submit) {
        await d.press("Enter");
        notes.push("submitted");
      }
      return notes.join("; ") || "Nothing to fill.";
    }
    case "press":
      await d.press(String(i.keys ?? "Enter"));
      return `Pressed ${String(i.keys)}.`;
    case "scroll": {
      const dir = String(i.direction ?? "down");
      const amount = Number(i.amount) || 600;
      await d.scroll(dir === "left" ? -amount : dir === "right" ? amount : 0, dir === "up" ? -amount : dir === "down" ? amount : 0);
      return `Scrolled ${dir}.`;
    }
    case "back":
      await d.back();
      return "Went back.";
    case "wait": {
      const ms = Math.min(Math.max(Number(i.ms) || 1500, 100), 15_000);
      if (typeof i.text === "string" && i.text) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (await d.evaluate<boolean>(`JSON.stringify((document.body?.innerText || "").includes(${JSON.stringify(i.text)}))`)) return `"${i.text}" is on the page.`;
          await new Promise((r) => setTimeout(r, 400));
        }
        return `"${i.text}" did not appear within ${ms} ms.`;
      }
      await new Promise((r) => setTimeout(r, ms));
      return `Waited ${ms} ms.`;
    }
    case "auth":
      await d.setAuth({ username: String(i.username ?? ""), password: String(i.password ?? "") });
      if (session.url && session.url !== "about:blank") await d.navigate(session.url);
      return "Credentials given to the site's login prompt.";
    case "switch_tab": {
      const tabs = await d.tabs();
      const want = String(i.tab ?? "");
      const tab = tabs.find((t) => t.id === want) ?? tabs[Number(want) - 1];
      if (!tab) throw new Error(`No tab ${want}. Tabs: ${tabs.map((t, n) => `${n + 1}. ${t.title || t.url}`).join("; ")}`);
      await d.switchTab(tab.id);
      return `Switched to tab ${tabs.indexOf(tab) + 1}.`;
    }
    default:
      return "";
  }
}

export const browserTool: Tool = {
  group: "browser",
  title: "Browser",
  allowForTask: true,
  spec: {
    name: "browser",
    description:
      "Use your own web browser (separate from the user's) to open pages, read them, click, type, fill forms and extract data. Every action returns the page as text in which " +
      "everything you can click or fill has a number like [12]; use those numbers as ref. Actions: open (url), snapshot (read the page again), click (ref; double, button: right), " +
      "type (ref, text, submit: press Enter after), select (ref, value), fill_form (fields: [{ref, value}], submit), press (keys, e.g. Enter, Tab, ctrl+a), scroll (direction up/down/left/right, amount px), " +
      "back, screenshot (see the page as an image), extract (the page's main text, tables and links), tabs, new_tab (url), switch_tab (tab: number or id), wait (ms, or text to wait for), " +
      "auth (username, password for a site's login prompt), close. Prefer reading the text over screenshots. Ask the user before buying, sending or deleting anything unless they asked for it.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...BROWSER_ACTIONS] },
        url: { type: "string" },
        ref: { type: "integer", description: "element number from the page view" },
        text: { type: "string" },
        value: { type: "string" },
        submit: { type: "boolean" },
        double: { type: "boolean" },
        button: { type: "string", enum: ["left", "right"] },
        fields: { type: "array", items: { type: "object", properties: { ref: { type: "integer" }, value: { type: "string" } }, required: ["ref", "value"] } },
        keys: { type: "string" },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer" },
        tab: { type: "string" },
        ms: { type: "integer" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["action"],
    },
  },
  needsApproval: browserNeedsApproval,
  summarize: (i) => describe(i, sessionOf(lastConv)),
  async run(i, ctx): Promise<ToolOutput> {
    const action = String(i.action) as Action;
    if (action === "close") {
      await closeSession(ctx.conversationId);
      return { text: "Closed the browser." };
    }
    const session = await getSession(ctx.conversationId, ctx.settings, { ask: (q, o) => ctx.ask(q, o, false), progress: ctx.progress });
    try {
      ctx.progress(describe(i, session));
      if (action === "tabs") {
        const tabs = await session.driver.tabs();
        return { text: tabs.map((t, n) => `${n + 1}. ${t.active ? "(current) " : ""}${t.title || "(untitled)"} — ${t.url}`).join("\n") || "No tabs." };
      }
      if (action === "extract") {
        const x = await session.driver.evaluate<{ url: string; title: string; text: string; tables: string[][][]; links: { text: string; href: string }[] }>(extractCall(30_000));
        const tables = x.tables.map((t, n) => `Table ${n + 1}:\n${t.map((r) => r.join(" | ")).join("\n")}`).join("\n\n");
        const links = x.links.slice(0, 80).map((l) => `- ${l.text || "(no text)"}: ${l.href}`).join("\n");
        return { text: [`Page: ${x.title} — ${x.url}`, x.text, tables, links ? `Links:\n${links}` : ""].filter(Boolean).join("\n\n").slice(0, 60_000) };
      }
      if (action === "screenshot") {
        const shot = await session.driver.screenshot();
        const ref = await ctx.saveBlob(base64ToBytes(shot.data), shot.mime, `page-${Date.now().toString(36)}.jpg`);
        const snap = await look(session, ctx.conversationId, ctx);
        return { text: `${header(snap)}\nScreenshot attached.`, images: [ref] };
      }
      const note = action === "snapshot" ? "" : await act(action, i, session, ctx);
      const snap = await look(session, ctx.conversationId, ctx);
      return { text: `${note ? `${note}\n` : ""}${header(snap)}\n\n${snap.text}` };
    } catch (e) {
      // the user closed the browser window: start fresh next time
      if (/closed|not connected|disconnected/i.test(String(e))) dropSession(ctx.conversationId);
      throw e;
    }
  },
};
