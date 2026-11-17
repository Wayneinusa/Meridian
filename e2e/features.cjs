// Browser end-to-end checks for agents, projects, prompts, memory, plugins,
// connectors, automations, compare, versions, research mode, private chats,
// questions, plans, sub-agents, cold models, search, export and import.
//   npm run build && node e2e/features.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "screens");
const URL_ = "http://localhost:4175/";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};

const sseOut = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
function anthropicStream(model, blocks, stop) {
  const ev = [{ type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev.push({ type: "message_stop" });
  return sseOut(ev);
}

const seen = { claude: [], openai: [], frankfurter: [], meteo: [], deepwiki: [], cold: 0 };
const textOf = (content) => (typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const sysOf = (body) => (Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : (body.system ?? ""));

async function mocks(page) {
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname === "/v1/models") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: null }], has_more: false, first_id: "a", last_id: "a" }) });
    const body = req.postDataJSON();
    const sys = sysOf(body);
    const reply = (blocks, stop = "end_turn") => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: anthropicStream(body.model, blocks, stop) });
    if (/You name conversations/.test(sys)) return reply([{ type: "text", text: (/User: ([^\n]{1,40})/.exec(textOf(body.messages.at(-1).content)) ?? [])[1] ?? "Chat" }]);
    seen.claude.push(body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last.content) && last.content.find((b) => b.type === "tool_result");
    if (result) {
      const t = Array.isArray(result.content) ? result.content.map((c) => c.text ?? "").join("") : String(result.content);
      return reply([{ type: "text", text: `RESULT<<${t.slice(0, 300)}>>` }]);
    }
    const u = textOf(last.content);
    if (/^SUBTASK/.test(u)) return reply([{ type: "text", text: "sub-result 42" }]);
    if (/currency/.test(u)) return reply([{ type: "tool_use", id: "t_cur", name: "convert_currency", input: { amount: 100, from: "EUR", to: "USD" } }], "tool_use");
    if (/weather/.test(u)) return reply([{ type: "tool_use", id: "t_w", name: "weather_forecast", input: { place: "Lisbon", days: 2 } }], "tool_use");
    if (/remember that/.test(u)) return reply([{ type: "tool_use", id: "t_m", name: "remember", input: { text: "Owns a cat named Miso" } }], "tool_use");
    if (/ask me/.test(u)) return reply([{ type: "tool_use", id: "t_q", name: "ask_user", input: { question: "Which format?", options: ["Table", "List"] } }], "tool_use");
    if (/make a plan/.test(u)) return reply([{ type: "tool_use", id: "t_p", name: "update_plan", input: { steps: [{ text: "Gather facts", status: "done" }, { text: "Write it up", status: "in_progress" }] } }], "tool_use");
    if (/use helpers/.test(u)) return reply([{ type: "tool_use", id: "t_d1", name: "delegate", input: { task: "SUBTASK one", label: "one" } }, { type: "tool_use", id: "t_d2", name: "delegate", input: { task: "SUBTASK two", label: "two" } }], "tool_use");
    if (/deepwiki/.test(u)) return reply([{ type: "tool_use", id: "t_dw", name: (body.tools ?? []).find((t) => t.name?.includes("ask_question"))?.name ?? "none", input: { repoName: "facebook/react", question: "what?" } }], "tool_use");
    return reply([{ type: "text", text: `Claude says: ${u.slice(0, 60)} (#${seen.claude.length})` }]);
  });
  await page.route("https://api.openai.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname === "/v1/models") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "gpt-4o" }] }) });
    const body = req.postDataJSON();
    seen.openai.push(body);
    const text = "GPT answer for comparison";
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.route("https://cold.example/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname.endsWith("/models")) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [] }) });
    if (++seen.cold < 2) return route.fulfill({ status: 503, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "Model is currently loading" }) });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ready" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
  await page.route("https://api.frankfurter.app/**", (route) => {
    seen.frankfurter.push(route.request().url());
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ amount: 100, base: "EUR", rates: { USD: 108.5 } }) });
  });
  await page.route("https://geocoding-api.open-meteo.com/**", (route) => {
    seen.meteo.push(route.request().url());
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ results: [{ name: "Lisbon", country: "Portugal", latitude: 38.7, longitude: -9.1 }] }) });
  });
  await page.route("https://api.open-meteo.com/**", (route) => {
    seen.meteo.push(route.request().url());
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ timezone: "Europe/Lisbon", current: { temperature_2m: 21.5 }, daily: { temperature_2m_max: [24, 25] } }) });
  });
  await page.route("https://mcp.deepwiki.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const msg = req.postDataJSON();
    seen.deepwiki.push(msg?.method);
    const json = (result) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) });
    if (msg.method === "initialize") return json({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "deepwiki" } });
    if (msg.method === "notifications/initialized") return route.fulfill({ status: 202, headers: CORS, body: "" });
    if (msg.method === "tools/list") return json({ tools: [{ name: "ask_question", description: "Ask about a repo", inputSchema: { type: "object", properties: { repoName: { type: "string" }, question: { type: "string" } }, required: ["repoName", "question"] } }] });
    if (msg.method === "tools/call") return json({ content: [{ type: "text", text: `React answer for ${msg.params.arguments.repoName}` }] });
    return json({});
  });
}

const composer = (page) => page.locator('textarea[aria-label="Message"]');
async function send(page, text) {
  await composer(page).fill(text);
  await page.locator('button[title="Send"]').click();
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('button[title="Stop"]') && !document.querySelector('[role="alertdialog"]') && !document.querySelector('.overlay [aria-labelledby="q-title"]'), null, { timeout: 30000 });
  await page.waitForTimeout(200);
}
async function settings(page, tab) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"], button[title="Show sidebar"]').first().click();
  await page.locator('button[title="Settings"]').click();
  await page.getByRole("tab", { name: tab }).click();
}
const closeSettings = (page) => page.locator('.modal [title="Close"]').first().click();
const nav = async (page, name) => {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"], button[title="Show sidebar"]').first().click();
  await page.locator(".nav-item", { hasText: name }).first().click();
};
const lastAssistant = (page) => page.locator(".msg.assistant").last();

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", "4175", "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("preview did not start")), 20000);
    server.stdout.on("data", (d) => /4175/.test(String(d)) && (clearTimeout(t), res()));
  });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mocks(page);
  try {
    await page.goto(URL_);
    await page.waitForSelector(".empty h1");
    await settings(page, "Providers & keys");
    for (const [name, key] of [["Anthropic", "sk-ant"], ["OpenAI", "sk-oa"]]) {
      const card = page.locator(".card", { hasText: name }).first();
      await card.locator('input[type="password"]').fill(key);
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction((n) => [...document.querySelectorAll(".toast.ok")].some((t) => t.textContent.startsWith(n)), name);
    }

    console.log("cold model: Model ID + wake up");
    const addCard = page.locator(".card", { hasText: "Add another provider" });
    await addCard.locator("select").selectOption("Custom endpoint");
    await addCard.getByRole("button", { name: "Add", exact: true }).click();
    const custom = page.locator(".card", { has: page.locator('input[value="Custom endpoint"]') }).last();
    await custom.locator('input[type="url"]').fill("https://cold.example/v1");
    await custom.locator('input[type="url"]').blur();
    await custom.locator('input[aria-label^="Model ID"]').fill("org/cold-llm-70b");
    await custom.getByRole("button", { name: "Add & wake up" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /is awake/.test(t.textContent)), null, { timeout: 30000 });
    check("cold model woke up after a loading reply", seen.cold === 2);
    check("hand-added model listed on the card", (await custom.locator(".model-row", { hasText: "org/cold-llm-70b" }).count()) === 1);
    await closeSettings(page);

    console.log("agents");
    await nav(page, "Agents");
    await page.locator(".tile", { hasText: "Writing coach" }).getByRole("button", { name: "Add" }).click();
    await page.locator(".tile", { hasText: "Writing coach" }).getByRole("button", { name: "Chat" }).click();
    check("agent chat shows the agent", (await page.locator(".empty h1").textContent()) === "Writing coach");
    await send(page, "improve my intro");
    await idle(page);
    check("agent instructions sent as system prompt", /You are a writing coach/.test(sysOf(seen.claude.at(-1))), sysOf(seen.claude.at(-1)).slice(0, 200));
    check("tools include plan, question and sub-agents", ["update_plan", "ask_user", "delegate", "run_javascript"].every((n) => seen.claude.at(-1).tools.some((t) => t.name === n)));

    console.log("projects + knowledge");
    await nav(page, "Projects");
    await page.locator('input[placeholder="New project name"]').fill("Launch plan");
    await page.getByRole("button", { name: "Create" }).click();
    await page.locator("textarea").first().fill("We launch on March 3. Keep answers brief.");
    await page.locator("textarea").first().blur();
    await page.locator('input[type="file"][multiple]').first().setInputFiles({ name: "facts.txt", mimeType: "text/plain", buffer: Buffer.from("The launch budget is 42000 euros. The mascot is a heron.") });
    await page.waitForSelector('.list-row:has-text("facts.txt")');
    await page.getByRole("button", { name: "New chat in project" }).click();
    await send(page, "what is the budget?");
    await idle(page);
    const psys = sysOf(seen.claude.at(-1));
    check("project instructions and knowledge reach the model", /We launch on March 3/.test(psys) && /42000 euros/.test(psys) && /project "Launch plan"/.test(psys), psys.slice(0, 300));
    check("project chat filed under the project", (await page.locator(".chat-title").textContent()).includes("Launch plan"));

    console.log("memory");
    await settings(page, "Memory");
    await page.locator('input[placeholder^="Add something to remember"]').fill("Lives in Porto");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await closeSettings(page);
    await send(page, "remember that I have a cat");
    await idle(page);
    check("memories included in the system prompt", /Lives in Porto/.test(sysOf(seen.claude.filter((b) => !b.messages.at(-1).content.find?.((x) => x.type === "tool_result")).at(-1))));
    await settings(page, "Memory");
    check("remember tool saved a memory", (await page.locator('input[aria-label="Memory"]').evaluateAll((els) => els.map((e) => e.value))).includes("Owns a cat named Miso"));
    await closeSettings(page);

    console.log("prompts + slash commands");
    await nav(page, "Prompts");
    await page.getByRole("button", { name: "New prompt" }).click();
    await page.locator(".modal label.field", { hasText: "Title" }).locator("input").fill("Tweet");
    await page.locator(".modal label.field", { hasText: "Slash command" }).locator("input").fill("tweet");
    await page.locator(".modal textarea").fill("Write a tweet about {{topic}} in a {{tone}} tone.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.locator(".nav-item", { hasText: "Agents" }).click();
    await page.getByRole("button", { name: "New chat" }).click();
    await composer(page).fill("/tw");
    await page.waitForSelector('.slash-menu [role="option"]');
    await composer(page).press("Enter");
    await page.locator(".modal label.field", { hasText: "topic" }).locator("textarea").fill("herons");
    await page.locator(".modal label.field", { hasText: "tone" }).locator("textarea").fill("playful");
    await page.getByRole("button", { name: "Use prompt" }).click();
    check("slash prompt filled into the composer", (await composer(page).inputValue()) === "Write a tweet about herons in a playful tone.");
    await page.locator('button[title="Send"]').click();
    await idle(page);

    console.log("plugins (gallery, HTTP and sandboxed JS tools)");
    await settings(page, "Plugins");
    for (const name of ["Currency rates", "Weather"]) await page.locator(".tile", { hasText: name }).getByRole("button", { name: "Install" }).click();
    await closeSettings(page);
    await send(page, "convert currency please");
    await idle(page);
    check("HTTP plugin tool called the service", seen.frankfurter[0] === "https://api.frankfurter.app/?amount=100&from=EUR&to=USD", seen.frankfurter[0]);
    check("HTTP plugin result returned", /108\.5/.test(await lastAssistant(page).textContent()));
    await send(page, "weather in Lisbon");
    await idle(page);
    check("JS plugin ran in the sandbox and used the fetch bridge", seen.meteo.length === 2 && /21\.5/.test(await lastAssistant(page).textContent()), (await lastAssistant(page).textContent()).slice(0, 200));

    console.log("connectors directory");
    await settings(page, "Connectors");
    await page.locator('input[placeholder="Search connectors"]').fill("deepwiki");
    await page.locator(".tile", { hasText: "DeepWiki" }).getByRole("button", { name: "Add" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".card")].some((c) => /DeepWiki/.test(c.textContent) && /1 tool(?!s)/.test(c.textContent)), null, { timeout: 15000 });
    check("no-sign-in connector connected from the directory", seen.deepwiki.includes("tools/list"));
    await page.locator(".card", { hasText: "DeepWiki" }).first().getByRole("button", { name: "Details" }).click();
    await page.locator(".card", { hasText: "DeepWiki" }).first().getByText("Run this connector's tools without asking").click();
    await page.screenshot({ path: path.join(SHOTS, "30-connectors.png") });
    await closeSettings(page);
    await send(page, "ask deepwiki about react");
    await idle(page);
    check("connector tool used in chat", /React answer for facebook\/react/.test(await lastAssistant(page).textContent()));

    console.log("question, plan, sub-agents");
    await send(page, "ask me something");
    await page.waitForSelector('[aria-labelledby="q-title"]');
    await page.getByRole("button", { name: "Table" }).click();
    await idle(page);
    check("answer to the question returned to the model", /The user answered: Table/.test(await lastAssistant(page).textContent()));
    await send(page, "make a plan");
    await idle(page);
    check("plan checklist shown", (await page.locator(".plan li").count()) === 2 && /1\/2 done/.test(await page.locator(".plan").textContent()));
    const before = seen.claude.length;
    await send(page, "use helpers");
    await idle(page);
    const subs = seen.claude.slice(before).filter((b) => /^SUBTASK/.test(textOf(b.messages[0].content)));
    check("two sub-agents ran with their own context", subs.length === 2 && subs.every((b) => b.messages.length === 1 && /sub-agent/.test(sysOf(b)) && !b.tools.some((t) => t.name === "delegate")));
    check("sub-agent results returned", /sub-result 42/.test(await lastAssistant(page).textContent()));

    console.log("research mode, versions, compare");
    await page.locator(".chat-header .chip-btn", { hasText: "Research" }).click();
    await send(page, "solid state batteries");
    await idle(page);
    check("research mode instructions sent", /Research mode is on/.test(sysOf(seen.claude.at(-1))));
    await page.locator(".chat-header .chip-btn", { hasText: "Research" }).click();
    await lastAssistant(page).hover();
    await page.locator('button[title="Try again"]').last().click();
    await idle(page);
    check("regenerate keeps the earlier answer as a version", /2 versions/.test(await page.locator(".versions").last().textContent()));
    await page.locator(".versions button", { hasText: "versions" }).last().click();
    await page.locator(".popover .menu-item").first().click();
    await idle(page);
    check("switched back to the earlier answer", (await page.locator(".versions").last().textContent()).includes("2 versions"));
    await page.locator('button[title="Compare models side by side"]').click();
    await page.locator(".popover label", { hasText: "gpt-4o" }).click();
    await page.mouse.move(5, 5);
    await send(page, "compare this");
    await page.waitForSelector(".compare-col");
    await idle(page);
    await page.waitForFunction(() => [...document.querySelectorAll(".compare-col")].some((c) => /GPT answer for comparison/.test(c.textContent)), null, { timeout: 15000 });
    check("compare shows both models side by side", (await page.locator(".compare-col").count()) === 2);
    await page.screenshot({ path: path.join(SHOTS, "31-compare.png") });
    await page.locator(".compare-col", { hasText: "GPT answer" }).getByRole("button", { name: "Use this" }).click();
    await page.getByRole("button", { name: "Close" }).first().click();
    check("chosen answer became the main one", /GPT answer for comparison/.test(await lastAssistant(page).textContent()));
    await page.getByRole("button", { name: "turn off" }).click();

    console.log("automations");
    await nav(page, "Automations");
    await page.locator(".tile", { hasText: "Weekly review" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Run now" }).click();
    await page.waitForFunction(() => /Last run/.test(document.querySelector(".page .card")?.textContent ?? ""), null, { timeout: 30000 });
    check("automation run recorded with its chat", /done/.test(await page.locator(".page .card .note").first().textContent()));
    await page.screenshot({ path: path.join(SHOTS, "32-automations.png") });
    await page.locator(".page .card .note").getByRole("button", { name: "Open" }).click();
    check("automation chat opens", /Weekly review/.test(await page.locator(".chat-title").textContent()));

    console.log("private chat, search, export, import");
    await page.locator('button[title="Private chat (not saved)"]').click();
    await send(page, "secret question zebra");
    await idle(page);
    check("private banner shown", (await page.locator(".private-banner").count()) === 1);
    check("private chat not in the sidebar", (await page.locator(".conv", { hasText: "secret question zebra" }).count()) === 0);
    await nav(page, "Search");
    await page.locator('input[placeholder="Search all chats"]').fill("herons");
    await page.waitForSelector(".search-hit");
    check("full-text search finds message text", (await page.locator(".search-hit").count()) >= 1);
    await page.locator('input[placeholder="Search all chats"]').fill("zebra");
    await page.waitForTimeout(600);
    check("private chat is not searchable", (await page.locator(".search-hit").count()) === 0);
    await page.locator(".search-hit").first().click().catch(() => {});
    await page.locator('input[placeholder="Search all chats"]').fill("herons");
    await page.locator(".search-hit").first().click();
    await page.locator('.chat-header button[title="More"]').click();
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".popover .menu-item", { hasText: "Markdown" }).click()]);
    const md = fs.readFileSync(await dl.path(), "utf8");
    check("chat exported as Markdown", md.includes("## You") && md.includes("herons"));
    await page.locator('button[title="Usage"]').click();
    await page.waitForSelector(".page table");
    check("usage page lists models", (await page.locator(".page tbody tr").count()) >= 1);
    const gpt = [{ title: "From ChatGPT", create_time: 1700000000, current_node: "b", mapping: { a: { parent: null, message: { author: { role: "user" }, content: { parts: ["hello gpt"] } } }, b: { parent: "a", message: { author: { role: "assistant" }, content: { parts: ["hi!"] } } } } }];
    await page.locator('input[type="file"][accept*="json"]').setInputFiles({ name: "conversations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(gpt)) });
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /Imported 1 chat/.test(t.textContent)));
    check("ChatGPT export imported", (await page.locator(".conv", { hasText: "From ChatGPT" }).count()) === 1);

    console.log("reload keeps the library");
    await page.reload();
    await page.waitForSelector(".conv");
    await nav(page, "Agents");
    check("agents survive a reload", (await page.locator(".tile", { hasText: "Writing coach" }).getByRole("button", { name: "Chat" }).count()) === 1);
    await page.screenshot({ path: path.join(SHOTS, "33-agents.png") });
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e);
    await page.screenshot({ path: path.join(SHOTS, "features-failure.png") }).catch(() => {});
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall feature checks passed");
  process.exit(failures ? 1 : 0);
}
main();
