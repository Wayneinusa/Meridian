import { httpFetch } from "../platform/http";
import type { Tool } from "./types";

export function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\s*\/?>/gi, "\n")
    .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `${text.replace(/<[^>]+>/g, "")} (${href})`)
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f]+/g, " ").trim())
    .filter((l, i, a) => l || a[i - 1])
    .join("\n")
    .trim();
}

const MAX_CHARS = 80_000;

const fetchUrl: Tool = {
  group: "web",
  title: "Fetch web page",
  spec: {
    name: "fetch_url",
    description:
      "Download a web page or text resource and return its readable text. Use it for URLs the user gave you or pages you need to read. " +
      "Returns at most the first 80,000 characters and says so when the page was longer.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL" } },
      required: ["url"],
    },
  },
  // A URL the user typed is fine. Anything else is confirmed first, because a
  // web page or document could try to make the model send data to another site.
  needsApproval: (input, ctx) => !ctx.userText().includes(String(input.url)),
  summarize: (i) => `Fetch ${String(i.url)}`,
  async run(input, ctx) {
    let url: URL;
    try {
      url = new URL(String(input.url));
    } catch {
      return { isError: true, text: "That is not a valid URL." };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { isError: true, text: "Only http and https URLs can be fetched." };
    const res = await httpFetch(url.toString(), {
      signal: ctx.signal,
      headers: { Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
    });
    if (!res.ok) return { isError: true, text: `The server answered ${res.status} ${res.statusText}.` };
    const type = res.headers.get("content-type") ?? "";
    if (/^(image|video|audio)\//.test(type) || /octet-stream|zip|pdf/.test(type)) {
      return { isError: true, text: `That URL is a ${type} file, not a readable page.` };
    }
    const raw = await res.text();
    const text = /html/.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
    if (text.length > MAX_CHARS) {
      return { text: `${text.slice(0, MAX_CHARS)}\n\n[Only the first ${MAX_CHARS} of ${text.length} characters are shown.]` };
    }
    return { text: text || "(the page has no readable text)" };
  },
};

export const webTools: Tool[] = [fetchUrl];
