import { httpFetch } from "../platform/http";
import type { Settings } from "../types";
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
  needsApproval: (input, ctx) => !ctx.userText().includes(String(input.url)) && !ctx.trustedUrls().has(String(input.url)),
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

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return htmlToText(s).replace(/\s+/g, " ").trim();
}

/** DuckDuckGo's plain HTML page: free, no key. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result[ _][^"]*"/).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const redirect = /[?&]uddg=([^&]+)/.exec(url);
    if (redirect) url = decodeURIComponent(redirect[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/.exec(b);
    out.push({ title: decodeEntities(a[2]), url, snippet: sn ? decodeEntities(sn[1]) : "" });
  }
  return out;
}

export async function webSearch(query: string, settings: Settings, getSecretValue: (name: string) => Promise<string | null>, signal?: AbortSignal, count = 8): Promise<SearchHit[]> {
  const cfg = settings.search;
  const key = async (name: string) => {
    const k = await getSecretValue(`search.${name}`);
    if (!k) throw new Error(`No ${name} key saved. Add it in Settings → Tools & computer → Web search, or switch the search service to DuckDuckGo.`);
    return k;
  };
  let provider = cfg.provider;
  if (provider === "auto") {
    provider = "duckduckgo";
    for (const p of ["brave", "tavily", "exa"] as const) {
      if (await getSecretValue(`search.${p}`)) {
        provider = p;
        break;
      }
    }
    if (provider === "duckduckgo" && cfg.searxngUrl) provider = "searxng";
  }
  const json = async (res: Response) => {
    if (!res.ok) throw new Error(`Search failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  switch (provider) {
    case "brave": {
      const res = await httpFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { headers: { Accept: "application/json", "X-Subscription-Token": await key("brave") }, signal });
      const j = await json(res);
      return ((j.web?.results ?? []) as { title: string; url: string; description?: string }[]).map((r) => ({ title: decodeEntities(r.title), url: r.url, snippet: decodeEntities(r.description ?? "") }));
    }
    case "tavily": {
      const res = await httpFetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await key("tavily")}` }, body: JSON.stringify({ query, max_results: count }), signal });
      const j = await json(res);
      return ((j.results ?? []) as { title: string; url: string; content?: string }[]).map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? "").slice(0, 500) }));
    }
    case "exa": {
      const res = await httpFetch("https://api.exa.ai/search", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": await key("exa") }, body: JSON.stringify({ query, numResults: count, contents: { text: { maxCharacters: 600 } } }), signal });
      const j = await json(res);
      return ((j.results ?? []) as { title?: string; url: string; text?: string }[]).map((r) => ({ title: r.title ?? r.url, url: r.url, snippet: (r.text ?? "").slice(0, 500) }));
    }
    case "searxng": {
      if (!cfg.searxngUrl) throw new Error("No SearXNG address set in Settings → Tools & computer → Web search.");
      const res = await httpFetch(`${cfg.searxngUrl.replace(/\/+$/, "")}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { Accept: "application/json" }, signal });
      const j = await json(res);
      return ((j.results ?? []) as { title: string; url: string; content?: string }[]).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
    }
    default: {
      const res = await httpFetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
        body: `q=${encodeURIComponent(query)}`,
        signal,
      });
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      return parseDuckDuckGo(await res.text()).slice(0, count);
    }
  }
}

export function searchTool(getSecretValue: (name: string) => Promise<string | null>): Tool {
  return {
    group: "web",
    title: "Web search",
    spec: {
      name: "web_search",
      description:
        "Search the web. Returns titles, addresses and snippets; read the most relevant pages with fetch_url before relying on them, and cite the addresses you used. " +
        "Use it for anything recent, niche or that needs checking.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer", description: "1-15, default 8" } }, required: ["query"] },
    },
    needsApproval: () => false,
    summarize: (i) => `Search: ${String(i.query)}`,
    async run(input, ctx) {
      const hits = await webSearch(String(input.query), ctx.settings, getSecretValue, ctx.signal, Math.min(Math.max(Number(input.count) || 8, 1), 15));
      if (!hits.length) return { text: "No results." };
      return { text: hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n") };
    },
  };
}

export const webTools: Tool[] = [fetchUrl];
