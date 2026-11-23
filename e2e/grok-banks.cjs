// Browser end-to-end checks for: favourites first and a wide model menu, the
// provider list layout and presets, approvals inside the chat, Grok with xAI's
// native web and X search, Sign in with X (code), the Grok section in the
// sidebar, and a bank connection through SimpleFIN. Every service is mocked.
//   npm run build && node e2e/grok-banks.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "screens");
const PORT = 4177;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const seen = { responses: [], gateway: [], claude: [], simplefin: [] };
const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
const LONG = "anthropic-claude-opus-with-a-very-long-model-name-for-width-2026";

function anthropicStream(model, blocks, stop) {
  const ev = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }, { type: "message_stop" });
  return ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

async function mocks(page) {
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
  await page.route("https://api.anthropic.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (new URL(req.url()).pathname === "/v1/models") {
      return json(route, { data: [{ type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000, capabilities: null }, { type: "model", id: LONG, display_name: LONG, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000, capabilities: null }], has_more: false });
    }
    const body = req.postDataJSON();
    const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join("\n") : body.system ?? "";
    const reply = (blocks, stop = "end_turn") => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: anthropicStream(body.model, blocks, stop) });
    if (/You name conversations/.test(sys)) return reply([{ type: "text", text: "Chat" }]);
    seen.claude.push(body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last.content) && last.content.find((b) => b.type === "tool_result");
    if (result) return reply([{ type: "text", text: `BANK<<${(Array.isArray(result.content) ? result.content.map((c) => c.text).join("") : result.content).slice(0, 200)}>>` }]);
    return reply([{ type: "tool_use", id: "t_bank", name: "bank_list_accounts", input: {} }], "tool_use");
  });
  await page.route("https://api.x.ai/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    if (p === "/v1/models") return json(route, { data: [{ id: "grok-4" }, { id: "grok-imagine-image" }] });
    if (p === "/v1/responses") {
      seen.responses.push(req.postDataJSON());
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "text/event-stream" },
        body: sse([
          { type: "response.output_item.added", output_index: 0, item: { id: "ws1", type: "web_search_call", status: "in_progress" } },
          { type: "response.output_item.done", output_index: 0, item: { id: "ws1", type: "web_search_call", status: "completed", action: { type: "search", query: "launch news", sources: [{ type: "url", url: "https://news.example/launch" }] } } },
          { type: "response.output_item.done", output_index: 1, item: { id: "xs1", type: "x_search_call", status: "completed", arguments: '{"query":"launch"}' } },
          { type: "response.output_text.delta", output_index: 2, delta: "The launch went well [[1]](https://x.com/i/1)." },
          { type: "response.output_text.annotation.added", output_index: 2, annotation: { type: "url_citation", url: "https://x.com/i/1" } },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 8 } } },
        ]),
      });
    }
    return json(route, {});
  });
  await page.route("https://auth.x.ai/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.url().endsWith("/device/code")) return json(route, { device_code: "dev", user_code: "GROK-1234", verification_uri: "https://accounts.x.ai/device", interval: 1, expires_in: 600 });
    return json(route, { access_token: "x-oauth", refresh_token: "x-rt", expires_in: 21600 });
  });
  await page.route("https://cli-chat-proxy.grok.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    seen.gateway.push({ path: p, auth: req.headers()["authorization"] });
    if (p === "/v1/models-v2") return json(route, { data: [{ id: "grok-4.6", name: "Grok 4.6", contextWindow: 256000 }] });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: sse([{ type: "response.output_text.delta", output_index: 0, delta: "Hello from your subscription." }, { type: "response.completed", response: { status: "completed" } }]) });
  });
  await page.route("https://bridge.test/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.simplefin.push({ url: req.url(), auth: req.headers()["authorization"] });
    if (req.url().endsWith("/claim/xyz")) return route.fulfill({ status: 200, headers: CORS, body: "https://me:secret@bridge.test/simplefin" });
    return json(route, { errors: [], accounts: [{ org: { name: "Capital One" }, id: "c1", name: "Venture Card", currency: "USD", balance: "-120.50" }, { org: { name: "Wells Fargo" }, id: "w1", name: "Everyday Checking", currency: "USD", balance: "2400.00" }] });
  });
}

const composer = (page) => page.locator('textarea[aria-label="Message"]');
async function send(page, text) {
  await composer(page).fill(text);
  await page.locator('button[title="Send"]').click();
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('button[title="Stop"]') && !document.querySelector(".perm-card"), null, { timeout: 30000 });
  await page.waitForTimeout(200);
}
async function settings(page, tab) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"]').first().click();
  await page.locator('button[title="Settings"]').click();
  await page.getByRole("tab", { name: tab }).click();
}
const closeSettings = (page) => page.locator('.modal [title="Close"]').first().click();
const card = (page, name) => page.locator(".card", { has: page.locator("h4", { hasText: new RegExp(`^${name.replace(/[()]/g, "\\$&")}$`) }) }).first();

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("preview did not start")), 20000);
    server.stdout.on("data", (d) => String(d).includes(String(PORT)) && (clearTimeout(t), res()));
    server.on("exit", (c) => rej(new Error(`preview exited ${c}`)));
  });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await mocks(page);
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".empty h1");

    console.log("providers: layout, presets, keys");
    await settings(page, "Providers & keys");
    const firstCard = (await page.locator(".settings-pane .card h4").first().textContent()) ?? "";
    check("Add another provider is the first card", /Add another provider/.test(firstCard), firstCard);
    const presets = await page.locator('select[aria-label="Provider preset"] option').allTextContents();
    check("Runpod and Hostinger are presets", presets.some((p) => /Runpod/.test(p)) && presets.some((p) => /Hostinger/.test(p)), presets.join(", "));
    for (const [name, key] of [["Anthropic", "sk-ant"], ["xAI (Grok)", "xai-key"]]) {
      await card(page, name).locator('input[type="password"]').first().fill(key);
      await card(page, name).getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction((n) => [...document.querySelectorAll(".toast.ok")].some((t) => t.textContent.startsWith(n)), name.split(" ")[0]);
    }
    check("xAI card says API key configured", /API key configured/.test(await card(page, "xAI (Grok)").textContent()));
    await closeSettings(page);

    console.log("model menu: full names, favourites first");
    await page.locator(".model-btn").click();
    const longItem = page.locator(".model-pop .menu-item", { hasText: LONG });
    const fits = await longItem.locator(".model-name").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    check("the menu is wide enough for a long model name", fits);
    await page.locator(".model-pop .menu-item", { hasText: "grok-4" }).first().locator(".star").click();
    await page.waitForFunction(() => /Favourites/.test(document.querySelector(".model-pop .menu-head")?.textContent ?? ""));
    const firstItem = await page.locator(".model-pop .menu-item").first().textContent();
    check("a starred model moves to the top", /grok-4/.test(firstItem) && /xAI/.test(firstItem), firstItem);
    await page.screenshot({ path: path.join(SHOTS, "50-model-menu.png") });

    console.log("Grok with native web and X search");
    await page.locator(".model-pop .menu-item", { hasText: "grok-4" }).first().click();
    await send(page, "what happened with the launch?");
    await page.waitForSelector(".msg.assistant .tool", { timeout: 20000 });
    await idle(page);
    const req = seen.responses[0];
    check("Grok used xAI's Responses API with web_search and x_search", !!req && req.tools.some((t) => t.type === "web_search") && req.tools.some((t) => t.type === "x_search"), JSON.stringify(req?.tools ?? []));
    check("Meridian's own search tool is not offered next to the native one", !req.tools.some((t) => t.name === "web_search"));
    const toolNames = await page.locator(".msg.assistant .tool-name").allTextContents();
    check("search calls shown in the chat", toolNames.includes("Web search") && toolNames.includes("X search"), toolNames.join(","));
    check("native badge on the searches", (await page.locator(".msg.assistant .tool .badge", { hasText: "native" }).count()) === 2);
    check("cited answer shown", /The launch went well/.test(await page.locator(".msg.assistant").last().textContent()));
    await page.locator(".msg.assistant .tool summary").first().click();
    check("search result lists its sources", /news\.example\/launch/.test(await page.locator(".msg.assistant .tool").first().textContent()));

    console.log("Grok section in the sidebar");
    await page.waitForSelector(".grok-section .conv");
    const sectionLast = await page.evaluate(() => {
      const list = document.querySelector(".conv-list");
      const sec = list.querySelector(".grok-section");
      const convs = [...list.querySelectorAll(".conv")];
      return convs.length > 0 && sec.contains(convs[convs.length - 1]);
    });
    check("Grok chats sit in their own section at the bottom", sectionLast);
    await page.locator(".grok-head").click();
    check("the section collapses", (await page.locator(".grok-section .conv").count()) === 0);
    await page.locator(".grok-head").click();
    await page.screenshot({ path: path.join(SHOTS, "51-grok-search.png") });

    console.log("Sign in with X");
    await settings(page, "Providers & keys");
    const x = card(page, "xAI (Grok)");
    // the browser build offers the code flow only (desktop also has browser sign-in)
    await x.getByRole("button", { name: /Use a code instead|Sign in with X \(code\)/ }).click();
    await page.waitForSelector('[data-testid="x-device-code"]');
    check("sign-in code shown", (await page.locator('[data-testid="x-device-code"]').textContent()) === "GROK-1234");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /Signed in with X/.test(t.textContent)), null, { timeout: 20000 });
    check("card shows both methods", /Signed in with X/.test(await x.textContent()) && /API key configured/.test(await x.textContent()));
    check("subscription models listed from xAI's gateway", seen.gateway.some((g) => g.path === "/v1/models-v2" && g.auth === "Bearer x-oauth"));
    await page.screenshot({ path: path.join(SHOTS, "52-sign-in-with-x.png") });
    await closeSettings(page);
    await page.locator(".model-btn").click();
    await page.locator(".model-pop .menu-item", { hasText: "Grok 4.6" }).first().click();
    const before = seen.responses.length;
    await send(page, "hello grok");
    await page.waitForFunction(() => /Hello from your subscription/.test(document.querySelector(".messages")?.textContent ?? ""), null, { timeout: 20000 });
    await idle(page);
    check("signed in: chat goes to the subscription gateway, not the API key", seen.gateway.some((g) => g.path === "/v1/responses" && g.auth === "Bearer x-oauth") && seen.responses.length === before);

    console.log("bank connection and approval inside the chat");
    await settings(page, "Connectors");
    await page.locator('input[placeholder="Search connectors"]').fill("capital");
    await page.locator(".tile", { hasText: "Capital One" }).getByRole("button", { name: "Add" }).click();
    const bank = page.locator(".card", { has: page.locator("h4", { hasText: /^Capital One$/ }) });
    await bank.locator('input[aria-label="SimpleFIN Setup Token"]').fill(Buffer.from("https://bridge.test/claim/xyz").toString("base64"));
    await bank.getByRole("button", { name: "Connect" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /SimpleFIN connected/.test(t.textContent)));
    await bank.getByRole("button", { name: "Show my accounts" }).click();
    await page.waitForSelector('[data-testid="bank-accounts"] .model-row');
    const shown = await page.locator('[data-testid="bank-accounts"]').textContent();
    check("only Capital One accounts are shown on the Capital One card", /Venture Card/.test(shown) && !/Wells Fargo/.test(shown), shown);
    check("SimpleFIN credentials go in a header, not the address", seen.simplefin.some((s) => /bridge\.test\/simplefin\/accounts/.test(s.url) && /^Basic /.test(s.auth ?? "") && !s.url.includes("secret@")));
    await page.screenshot({ path: path.join(SHOTS, "53-bank.png") });
    await closeSettings(page);
    await page.locator(".model-btn").click();
    await page.locator(".model-pop .menu-item", { hasText: "Claude Opus 5.5" }).first().click();
    await send(page, "what are my balances?");
    await page.waitForSelector(".perm-card", { timeout: 20000 });
    check("approval appears inside the chat, not as a popup", (await page.locator(".overlay").count()) === 0 && (await page.locator(".messages .perm-card").count()) === 1);
    check("approval shows every choice", (await page.locator(".perm-card button").allTextContents()).join("|").match(/Allow once\|Always allow.*\|Don't allow/) !== null);
    await page.screenshot({ path: path.join(SHOTS, "54-inline-approval.png") });
    await page.locator(".perm-card").getByRole("button", { name: "Allow once" }).click();
    await idle(page);
    check("bank tool read the accounts after approval", /BANK<<.*Capital One · Venture Card/.test(await page.locator(".msg.assistant").last().textContent()));
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e);
    await page.screenshot({ path: path.join(SHOTS, "grok-banks-failure.png") }).catch(() => {});
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall Grok, bank and UI checks passed");
  process.exit(failures ? 1 : 0);
}
main();
