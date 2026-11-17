// Plugins that ship with the app. None of them needs an account or key.
import type { PluginAgentDef } from "../types";
import type { PluginDraft } from "./import";

const base = (name: string, emoji: string, description: string): PluginDraft => ({
  name,
  emoji,
  description,
  author: "Meridian",
  source: "gallery",
  enabled: true,
  tools: [],
  skills: [],
  commands: [],
  agents: [],
  mcpServers: [],
  settings: [],
  values: {},
});

export const GALLERY: PluginDraft[] = [
  {
    ...base("Weather", "🌦️", "Current weather and a 7-day forecast for any place (Open-Meteo, no key)."),
    tools: [
      {
        name: "weather_forecast",
        description: "Current conditions and daily forecast for a place name. Temperatures in °C, wind in km/h.",
        inputSchema: { type: "object", properties: { place: { type: "string", description: "City or place, e.g. 'Lisbon'" }, days: { type: "integer", description: "1-14, default 7" } }, required: ["place"] },
        kind: "js",
        code: `const geo = await fetchJson("https://geocoding-api.open-meteo.com/v1/search?count=1&name=" + encodeURIComponent(args.place));
if (!geo.results || !geo.results.length) return "No place called " + args.place + " was found.";
const g = geo.results[0];
const days = Math.min(Math.max(args.days || 7, 1), 14);
const w = await fetchJson("https://api.open-meteo.com/v1/forecast?latitude=" + g.latitude + "&longitude=" + g.longitude + "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&forecast_days=" + days);
return { place: g.name + (g.admin1 ? ", " + g.admin1 : "") + ", " + g.country, timezone: w.timezone, current: w.current, daily: w.daily, weather_codes: "WMO codes: 0 clear, 1-3 partly cloudy, 45/48 fog, 51-57 drizzle, 61-67 rain, 71-77 snow, 80-82 showers, 95-99 thunderstorm" };`,
      },
    ],
  },
  {
    ...base("Wikipedia", "📚", "Search Wikipedia and read article summaries in any language."),
    tools: [
      {
        name: "wikipedia_search",
        description: "Search Wikipedia. Returns titles and snippets.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, lang: { type: "string", description: "Language code, default en" } }, required: ["query"] },
        kind: "js",
        code: `const lang = args.lang || "en";
const r = await fetchJson("https://" + lang + ".wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=8&srsearch=" + encodeURIComponent(args.query));
return r.query.search.map(s => ({ title: s.title, snippet: s.snippet.replace(/<[^>]+>/g, "") }));`,
      },
      {
        name: "wikipedia_article",
        description: "Read the introduction of a Wikipedia article (or the whole article with full=true).",
        inputSchema: { type: "object", properties: { title: { type: "string" }, lang: { type: "string" }, full: { type: "boolean" } }, required: ["title"] },
        kind: "js",
        code: `const lang = args.lang || "en";
const r = await fetchJson("https://" + lang + ".wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*" + (args.full ? "" : "&exintro=1") + "&titles=" + encodeURIComponent(args.title));
const page = Object.values(r.query.pages)[0];
if (!page || page.missing !== undefined) return "No article titled " + args.title;
return "# " + page.title + "\\nhttps://" + lang + ".wikipedia.org/wiki/" + encodeURIComponent(page.title.replace(/ /g, "_")) + "\\n\\n" + (page.extract || "").slice(0, 60000);`,
      },
    ],
  },
  {
    ...base("Currency rates", "💱", "Exchange rates from the European Central Bank (Frankfurter, no key)."),
    tools: [
      {
        name: "convert_currency",
        description: "Convert an amount between currencies at the latest (or a given date's) ECB rate.",
        inputSchema: { type: "object", properties: { amount: { type: "number" }, from: { type: "string", description: "ISO code, e.g. USD" }, to: { type: "string", description: "ISO code, or several separated by commas" }, date: { type: "string", description: "YYYY-MM-DD, optional" } }, required: ["amount", "from", "to"] },
        kind: "http",
        http: { method: "GET", url: "https://api.frankfurter.app/{{date}}?amount={{amount}}&from={{from}}&to={{to}}" },
      },
    ],
  },
  {
    ...base("Hacker News", "🟧", "Top, new and best stories from Hacker News, and story search."),
    tools: [
      {
        name: "hacker_news",
        description: "Search Hacker News stories (query), or list front-page stories when the query is empty.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" } } },
        kind: "js",
        code: `const n = Math.min(args.count || 15, 40);
const url = args.query ? "https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=" + n + "&query=" + encodeURIComponent(args.query) : "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=" + n;
const r = await fetchJson(url);
return r.hits.map(h => ({ title: h.title, url: h.url || ("https://news.ycombinator.com/item?id=" + h.objectID), points: h.points, comments: h.num_comments, date: h.created_at }));`,
      },
    ],
  },
  {
    ...base("arXiv", "📄", "Search scientific papers on arXiv."),
    tools: [
      {
        name: "arxiv_search",
        description: "Search arXiv papers. Returns titles, authors, dates, abstracts and links.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" } }, required: ["query"] },
        kind: "js",
        code: `const r = await fetchText("https://export.arxiv.org/api/query?sortBy=relevance&max_results=" + Math.min(args.count || 8, 25) + "&search_query=all:" + encodeURIComponent(args.query));
const entries = r.body.split("<entry>").slice(1);
const tag = (s, t) => { const m = new RegExp("<" + t + "[^>]*>([\\\\s\\\\S]*?)</" + t + ">").exec(s); return m ? m[1].replace(/\\s+/g, " ").trim() : ""; };
return entries.map(e => ({ title: tag(e, "title"), published: tag(e, "published").slice(0, 10), authors: (e.match(/<name>([^<]+)<\\/name>/g) || []).map(x => x.replace(/<\\/?name>/g, "")).slice(0, 6), link: tag(e, "id"), abstract: tag(e, "summary").slice(0, 1200) }));`,
      },
    ],
  },
  {
    ...base("Calculator", "🧮", "Exact arithmetic, unit conversions and date maths."),
    tools: [
      {
        name: "calculate",
        description: "Evaluate a JavaScript math expression exactly, e.g. '(1.07 ** 10) * 2500' or 'Math.sqrt(2)'. Also accepts date maths with new Date().",
        inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
        kind: "js",
        code: `if (/[;{}]|import|fetch|while|for\\s*\\(/.test(args.expression)) return "Only a single expression is allowed.";
const v = Function("return (" + args.expression + ")")();
return String(v);`,
      },
    ],
  },
  {
    ...base("Writing commands", "✍️", "Slash commands for everyday writing: /summarize, /rewrite, /translate, /email, /tldr, /explain, /proofread, /brainstorm, /meeting-notes."),
    commands: [
      { name: "summarize", description: "Summarize text or the chat so far", argumentHint: "[text]", body: "Summarize the following in a few tight bullet points, then one line with the main takeaway:\n\n$ARGUMENTS" },
      { name: "tldr", description: "One-paragraph TL;DR", argumentHint: "[text]", body: "Give me a TL;DR of this in at most three sentences:\n\n$ARGUMENTS" },
      { name: "rewrite", description: "Rewrite for clarity", argumentHint: "[text]", body: "Rewrite this to be clearer and more concise while keeping my voice and meaning. Return only the rewrite:\n\n$ARGUMENTS" },
      { name: "proofread", description: "Fix spelling and grammar", argumentHint: "[text]", body: "Proofread this. Fix spelling, grammar and punctuation only, then list the changes you made:\n\n$ARGUMENTS" },
      { name: "translate", description: "Translate (first word = language)", argumentHint: "[language] [text]", body: "Translate the following into $1. Keep formatting. Return only the translation:\n\n$ARGUMENTS" },
      { name: "email", description: "Draft an email", argumentHint: "[what it should say]", body: "Draft a short, friendly, professional email that does the following. Include a subject line:\n\n$ARGUMENTS" },
      { name: "explain", description: "Explain simply", argumentHint: "[topic]", body: "Explain this simply, as to a smart 12-year-old, with one everyday analogy:\n\n$ARGUMENTS" },
      { name: "brainstorm", description: "Ten varied ideas", argumentHint: "[topic]", body: "Brainstorm 10 varied, specific ideas for: $ARGUMENTS\n\nMix safe and bold ones and add one line on why each could work." },
      { name: "meeting-notes", description: "Turn raw notes into minutes", argumentHint: "[notes]", body: "Turn these raw notes into clean meeting minutes with sections: Summary, Decisions, Action items (owner, due date), Open questions.\n\n$ARGUMENTS" },
    ],
  },
  {
    ...base("Research skills", "🔬", "Skills for source-checked research reports and comparison tables."),
    skills: [
      {
        name: "research-report",
        description: "Use when the user asks for a researched report, briefing or literature review on a topic.",
        body: "# Research report\n1. Restate the question and list 3-6 sub-questions.\n2. For each sub-question, search the web (several queries, different angles) and read the best primary sources with fetch_url. Prefer official, academic and original sources over aggregators.\n3. Keep notes of claims with their source URL and date.\n4. Cross-check important numbers in at least two sources; say so when sources disagree.\n5. Write the report: executive summary (5 bullets), findings by sub-question, a table of key figures, open questions, and a numbered source list. Cite as [n] inline.\n6. If the user wants a file, create it with create_document or create_pdf.",
      },
      {
        name: "comparison-table",
        description: "Use when the user wants options, products or tools compared.",
        body: "# Comparison table\n- Agree the criteria first (ask_user if unclear), 5-8 criteria max.\n- Research each option's facts; mark unknowns as 'n/a' rather than guessing.\n- Output a Markdown table (options as rows), then a short 'best for' line per option and a recommendation with the reasoning.\n- Offer the table as a spreadsheet with create_spreadsheet.",
      },
    ],
  },
];

export const AGENT_TEMPLATES: PluginAgentDef[] = [
  { name: "Research analyst", emoji: "🔎", description: "Digs into a topic on the web and writes a cited brief.", instructions: "You are a meticulous research analyst. Search widely, read primary sources, cross-check numbers, and write concise, well-structured briefs with inline citations [n] and a source list. Say clearly what is uncertain." },
  { name: "Writing coach", emoji: "✍️", description: "Improves drafts while keeping your voice.", instructions: "You are a writing coach. Improve clarity, structure and rhythm while keeping the author's voice. Explain the most important changes briefly. Ask what the piece is for if it is not obvious." },
  { name: "Code reviewer", emoji: "🧑‍💻", description: "Reviews code for bugs, security and clarity.", instructions: "You are a senior engineer reviewing code. Look first for correctness bugs, then security issues, then clarity and performance. Be specific: quote the line, explain the problem, show the fix. Do not nitpick style unless asked." },
  { name: "Tutor", emoji: "🎓", description: "Teaches step by step and checks understanding.", instructions: "You are a patient tutor. Find out what the learner already knows, explain step by step with examples, and check understanding with a short question after each idea. Never just hand over homework answers; guide the learner to them." },
  { name: "Product manager", emoji: "🧭", description: "Turns ideas into specs, priorities and plans.", instructions: "You are an experienced product manager. Clarify the user problem, success metrics and constraints. Produce crisp specs, user stories with acceptance criteria, and prioritised roadmaps. Push back on scope creep." },
  { name: "Data analyst", emoji: "📊", description: "Analyses spreadsheets and data files.", instructions: "You are a data analyst. Inspect the data first (columns, types, gaps), state assumptions, compute with run_javascript for exact numbers, and present findings with small tables. Offer a spreadsheet or chart-ready table as a file." },
  { name: "Witty companion", emoji: "😎", description: "Casual, funny, straight-talking chat partner.", instructions: "You are a witty, irreverent but kind conversation partner. Be funny and direct, skip corporate politeness, keep answers short unless asked for depth, and still get facts right." },
  { name: "Translator", emoji: "🌍", description: "Natural translations that keep tone and format.", instructions: "You are a professional translator. Translate naturally, keeping tone, formatting and meaning. If the target language is not given, ask. Point out idioms or terms that have no direct equivalent." },
];
