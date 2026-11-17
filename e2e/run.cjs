// End-to-end check of the web UI in Chromium. Provider APIs, an MCP server and
// a web page are mocked at the network layer, so the real adapters, agent
// loop, tools, storage and backup code all run - only the far end is fake.
//
//   npm run build && npm run e2e
const { chromium, devices } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { unzipSync } = require("fflate");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "screens");
const URL_ = "http://localhost:4173/";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
}

// ---------- mock builders ----------
function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
function chunks(s, n = 7) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
function anthropicStream(model, blocks, stop_reason) {
  const ev = [
    { type: "message_start", message: { id: "msg_" + Math.random().toString(36).slice(2), type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0 } } },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const c of chunks(b.text)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: c } });
    } else if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const c of chunks(b.thinking)) ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: c } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (const c of chunks(JSON.stringify(b.input), 11)) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 64 } });
  ev.push({ type: "message_stop" });
  return sse(ev);
}
function openaiStream(text) {
  const lines = chunks(text).map((c) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: c } }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 5 } })}\n\n`);
  lines.push("data: [DONE]\n\n");
  return lines.join("");
}

const seen = { anthropic: [], openai: [], images: [], mcp: [], xai: [], sora: [], titles: [] };

function lastUserText(body) {
  const last = body.messages[body.messages.length - 1];
  if (typeof last.content === "string") return last.content;
  return last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
function hasToolResult(body) {
  const last = body.messages[body.messages.length - 1];
  return Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
}

async function installMocks(page) {
  await page.route("https://api.anthropic.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (url.pathname === "/v1/models") {
      const cap = { supported: true };
      const mk = (id, display_name) => ({
        type: "model", id, display_name, created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000,
        capabilities: { image_input: cap, pdf_input: cap, thinking: { supported: true, types: { adaptive: cap, enabled: { supported: false } } }, effort: { supported: true, low: cap, medium: cap, high: cap, xhigh: cap, max: cap }, batch: cap, citations: cap, code_execution: cap, structured_outputs: cap, context_management: { supported: false }, server_tools: { supported: true } },
      });
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [mk("claude-opus-5-5", "Claude Opus 5.5"), mk("claude-fable-5-2", "Claude Fable 5.2"), mk("claude-haiku-5-5", "Claude Haiku 5.5")], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-haiku-5-5" }) });
    }
    const body = req.postDataJSON();
    const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join(" ") : (body.system ?? "");
    if (/You name conversations/.test(sys)) {
      // auto-title request: answer with the user's first line so titles stay predictable
      seen.titles.push(body);
      const first = /User: ([^\n]*)/.exec(lastUserText(body))?.[1] ?? "Chat";
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: anthropicStream(body.model, [{ type: "text", text: first.slice(0, 40) }], "end_turn") });
    }
    seen.anthropic.push({ body, headers: req.headers() });
    const text = lastUserText(body);
    let blocks, stop = "end_turn";
    if (hasToolResult(body)) {
      const last = body.messages[body.messages.length - 1].content.find((b) => b.type === "tool_result");
      const resultText = Array.isArray(last.content) ? last.content.map((c) => c.text ?? "").join("") : String(last.content);
      blocks = [{ type: "text", text: last.is_error ? `That did not work: ${resultText.slice(0, 80)}` : "All done. The result is shown above." }];
    } else if (/spreadsheet/i.test(text)) {
      blocks = [
        { type: "thinking", thinking: "The user wants a budget. I will build a workbook with a total formula.", signature: "sig-abc123" },
        { type: "text", text: "I'll put that together as a workbook." },
        { type: "tool_use", id: "toolu_sheet1", name: "create_spreadsheet", input: { filename: "budget.xlsx", sheets: [{ name: "Budget", rows: [["Category", "Monthly"], ["Rent", 1200], ["Food", 450.5], ["Total", "=SUM(B2:B3)"]] }] } },
      ];
      stop = "tool_use";
    } else if (/pdf/i.test(text)) {
      blocks = [{ type: "tool_use", id: "toolu_pdf1", name: "create_pdf", input: { filename: "proposal.pdf", markdown: "# Proposal\n\nA **community garden**.\n\n- soil\n- seeds\n\n| Item | Cost |\n|---|---|\n| Soil | 40 |" } }];
      stop = "tool_use";
    } else if (/look up the news/i.test(text)) {
      blocks = [{ type: "tool_use", id: "toolu_fetch1", name: "fetch_url", input: { url: "https://news.example.org/today" } }];
      stop = "tool_use";
    } else if (/draw/i.test(text)) {
      blocks = [{ type: "tool_use", id: "toolu_img1", name: "generate_image", input: { prompt: "A lighthouse at dawn, watercolor", aspect_ratio: "16:9" } }];
      stop = "tool_use";
    } else if (/connector/i.test(text)) {
      const tool = (body.tools ?? []).find((t) => t.name && t.name.startsWith("mcp__"));
      blocks = [{ type: "tool_use", id: "toolu_mcp1", name: tool ? tool.name : "mcp__missing", input: { query: "invoice 42" } }];
      stop = "tool_use";
    } else if (/bad tool/i.test(text)) {
      blocks = [{ type: "tool_use", id: "toolu_bad1", name: "create_file", input: { filename: 12 } }];
      stop = "tool_use";
    } else {
      blocks = [{ type: "text", text: "Hello! Here is a **bold** point and a list:\n\n1. First\n2. Second\n\n```js\nconsole.log(42);\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |" }];
    }
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: anthropicStream(body.model, blocks, stop) });
  });

  await page.route("https://api.openai.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (url.pathname === "/v1/models") {
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-image-1" }, { id: "sora-2" }, { id: "text-embedding-3-small" }] }) });
    }
    if (url.pathname === "/v1/images/generations") {
      seen.images.push(req.postDataJSON());
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ data: [{ b64_json: PNG_1PX }] }) });
    }
    if (url.pathname === "/v1/videos" && req.method() === "POST") {
      seen.sora.push(req.postData() ?? "");
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ id: "vid_1", status: "in_progress", progress: 50 }) });
    }
    if (url.pathname === "/v1/videos/vid_1") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ id: "vid_1", status: "completed" }) });
    if (url.pathname === "/v1/videos/vid_1/content") return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "video/mp4" }, body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) });
    seen.openai.push(req.postDataJSON());
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: openaiStream("Reply from the OpenAI mock.") });
  });

  await page.route("https://api.x.ai/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const json = (o) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(o) });
    if (url.pathname === "/v1/models") return json({ data: [{ id: "grok-4" }, { id: "grok-imagine-image" }, { id: "grok-imagine-video" }] });
    if (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") {
      seen.xai.push({ path: url.pathname, body: req.postDataJSON() });
      return json({ data: [{ b64_json: PNG_1PX }] });
    }
    if (url.pathname === "/v1/videos/generations") {
      seen.xai.push({ path: url.pathname, body: req.postDataJSON() });
      return json({ request_id: "req_9" });
    }
    if (url.pathname === "/v1/videos/req_9") return json({ status: "done", video: { url: "https://vidgen.x.ai/clip.mp4", duration: 6 } });
    return json({});
  });
  await page.route("https://vidgen.x.ai/**", (route) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "video/mp4" }, body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]) }));

  await page.route("https://news.example.org/**", (route) =>
    route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/html" }, body: "<html><body><h1>Today</h1><script>x()</script><p>Sunny &amp; calm.</p></body></html>" }),
  );

  await page.route("https://mcp.example.test/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.method() !== "POST") return route.fulfill({ status: 200, headers: CORS, body: "" });
    const msg = req.postDataJSON();
    seen.mcp.push({ msg, headers: req.headers() });
    const json = (result) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/json", "mcp-session-id": "sess-1" }, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) });
    if (msg.method === "initialize") return json({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } });
    if (msg.method === "notifications/initialized") return route.fulfill({ status: 202, headers: CORS, body: "" });
    if (msg.method === "tools/list") return json({ tools: [{ name: "lookup", description: "Look up a record", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] });
    if (msg.method === "tools/call") {
      // answer as an SSE stream to exercise that path too
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/event-stream" }, body: `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `Record for ${msg.params.arguments.query}: paid` }] } })}\n\n` });
    }
    return json({});
  });
}

// ---------- UI helpers ----------
const composer = (page) => page.locator('textarea[aria-label="Message"]');
async function sendMessage(page, text) {
  await composer(page).fill(text);
  await page.locator('button[title="Send"]').click();
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('button[title="Stop"]') && !document.querySelector('[role="alertdialog"]'), null, { timeout: 30000 });
  await page.waitForTimeout(150);
}
async function openSettings(page, tab) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"]').click();
  await page.locator('button[title="Settings"]').click();
  await page.getByRole("tab", { name: tab }).click();
}
const closeSettings = (page) => page.locator('.modal [title="Close"]').first().click();
async function shot(page, name, scale2 = false) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function main() {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("preview server did not start")), 20000);
    server.stdout.on("data", (d) => /4173/.test(String(d)) && (clearTimeout(t), resolve()));
    server.on("exit", (c) => reject(new Error(`preview exited ${c}`)));
  });

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await installMocks(page);

  try {
    console.log("first run");
    await page.goto(URL_);
    await page.waitForSelector(".empty h1");
    check("empty state renders", (await page.locator(".empty h1").textContent()) === "What are we working on?");
    await shot(page, "01-empty");

    console.log("provider key + model list");
    await openSettings(page, "Providers & keys");
    const anthropicCard = page.locator(".card", { hasText: "Anthropic" }).first();
    await anthropicCard.locator('input[type="password"]').fill("sk-ant-test-key");
    await anthropicCard.getByRole("button", { name: "Save" }).click();
    await page.waitForSelector(".toast.ok");
    check("model list fetched after saving key", /3 models available/.test(await page.locator(".toast.ok").first().textContent()));
    check("key is not kept in settings JSON", !JSON.stringify(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("meridian"); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("settings.json"); g.onsuccess = () => res(g.result); }; }))).includes("sk-ant-test-key"));
    await shot(page, "02-settings-providers");
    await closeSettings(page);

    console.log("plain chat");
    await sendMessage(page, "Hello there");
    await idle(page);
    check("user bubble shown", (await page.locator(".msg.user .bubble").first().textContent()) === "Hello there");
    check("markdown rendered (bold, list, code, table)", (await page.locator(".msg.assistant strong").count()) > 0 && (await page.locator(".msg.assistant ol li").count()) === 2 && (await page.locator(".msg.assistant .codeblock").count()) === 1 && (await page.locator(".msg.assistant table").count()) === 1);
    const first = seen.anthropic[0];
    check("request: model, streaming, adaptive thinking, caching", first.body.model === "claude-opus-5-5" && first.body.stream === true && first.body.thinking?.type === "adaptive" && first.body.thinking?.display === "summarized" && first.body.cache_control?.type === "ephemeral", JSON.stringify({ m: first.body.model, t: first.body.thinking }));
    check("request: no sampling params sent to Claude", !("temperature" in first.body) && !("top_p" in first.body));
    check("request: refusal fallback opted in", first.body.fallbacks === "default" && /server-side-fallback-2026-07-01/.test(first.headers["anthropic-beta"] ?? ""), first.headers["anthropic-beta"]);
    check("request: file tools offered with eager streaming", first.body.tools.some((t) => t.name === "create_spreadsheet" && t.eager_input_streaming === true) && first.body.tools.some((t) => t.type === "web_search_20260209"));
    check("request: computer tools NOT offered in a browser", !first.body.tools.some((t) => t.name === "run_command"));
    await page.waitForFunction(() => document.querySelector(".chat-title")?.textContent === "Hello there", null, { timeout: 5000 }).catch(() => {});
    check("chat titled by the model after the first answer", seen.titles.length === 1 && (await page.locator(".chat-title").textContent()) === "Hello there", `${seen.titles.length} ${await page.locator(".chat-title").textContent()}`);

    console.log("spreadsheet tool round trip");
    const before = seen.anthropic.length;
    await sendMessage(page, "Make me a budget spreadsheet");
    await page.waitForSelector(".file-card");
    await idle(page);
    check("artifact card for budget.xlsx", (await page.locator(".file-card .file-name").first().textContent()) === "budget.xlsx");
    check("thinking shown collapsed", (await page.locator("details.thinking").count()) === 1);
    check("tool call marked done", (await page.locator(".tool .badge.ok").count()) >= 1);
    check("follow-up answer rendered", /All done/.test(await page.locator(".msg.assistant").last().textContent()));
    const follow = seen.anthropic[before + 1];
    const replay = follow.body.messages[follow.body.messages.length - 2];
    check("thinking block replayed unchanged with signature", replay.role === "assistant" && replay.content[0].type === "thinking" && replay.content[0].signature === "sig-abc123" && replay.content[0].thinking.startsWith("The user wants a budget"));
    const tr = follow.body.messages[follow.body.messages.length - 1].content[0];
    check("tool_result sent back for the tool_use id", tr.type === "tool_result" && tr.tool_use_id === "toolu_sheet1" && !tr.is_error);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('.file-card button[title="Save"]').first().click()]);
    const xlsxPath = path.join(SHOTS, "budget.xlsx");
    await dl.saveAs(xlsxPath);
    const sheetXml = Buffer.from(unzipSync(new Uint8Array(fs.readFileSync(xlsxPath)))["xl/worksheets/sheet1.xml"]).toString();
    check("downloaded file is a real workbook with a live formula", sheetXml.includes("<f>SUM(B2:B3)</f>") && sheetXml.includes("1200"));
    await shot(page, "03-chat-spreadsheet");

    console.log("PDF generation + preview");
    await sendMessage(page, "Now a PDF proposal");
    await page.waitForSelector('.file-card:has-text("proposal.pdf")');
    await idle(page);
    const [pdfDl] = await Promise.all([page.waitForEvent("download"), page.locator('.file-card:has-text("proposal.pdf") button[title="Save"]').click()]);
    const pdfPath = path.join(SHOTS, "proposal.pdf");
    await pdfDl.saveAs(pdfPath);
    check("downloaded PDF is valid", fs.readFileSync(pdfPath).subarray(0, 5).toString() === "%PDF-" && fs.statSync(pdfPath).size > 3000);

    console.log("attachments");
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Quarterly notes: revenue up 12%.") },
      { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(PNG_1PX, "base64") },
      { name: "data.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: fs.readFileSync(xlsxPath) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll(".composer .chip").length === 3 && !document.querySelector(".composer .chip .spinner"));
    await sendMessage(page, "Summarize these");
    await idle(page);
    const att = seen.anthropic[seen.anthropic.length - 1].body;
    const content = att.messages[att.messages.length - 1].content;
    check("image sent as an image block", content.some((b) => b.type === "image" && b.source.media_type === "image/png" && b.source.data === PNG_1PX));
    check("text file sent as document text", content.some((b) => b.type === "text" && b.text.includes('<document name="notes.txt">') && b.text.includes("revenue up 12%")));
    check("xlsx contents extracted to text", content.some((b) => b.type === "text" && b.text.includes('[sheet "Budget"]') && b.text.includes("Rent,1200")));
    check("question comes after the files", content[content.length - 1].text === "Summarize these");

    console.log("permission prompt (URL the user did not type)");
    await sendMessage(page, "Please look up the news");
    await page.waitForSelector('[role="alertdialog"]');
    check("approval dialog names the URL", /news\.example\.org\/today/.test(await page.locator('[role="alertdialog"] .perm-cmd').first().textContent()));
    await shot(page, "04-permission");
    await page.getByRole("button", { name: "Don't allow" }).click();
    await idle(page);
    check("declined call is reported to the model as an error", seen.anthropic[seen.anthropic.length - 1].body.messages.at(-1).content[0].is_error === true);
    check("declined badge shown", (await page.locator(".tool .badge.err", { hasText: "declined" }).count()) === 1);
    await sendMessage(page, "Please look up the news again");
    await page.waitForSelector('[role="alertdialog"]');
    await page.getByRole("button", { name: "Allow once" }).click();
    await idle(page);
    const fetched = seen.anthropic[seen.anthropic.length - 1].body.messages.at(-1).content[0];
    check("allowed call fetched and cleaned the page", !fetched.is_error && fetched.content[0].text === "Today\nSunny & calm.", JSON.stringify(fetched.content));

    console.log("invalid tool input is rejected before running");
    await sendMessage(page, "try a bad tool call");
    await idle(page);
    const bad = seen.anthropic[seen.anthropic.length - 1].body.messages.at(-1).content[0];
    check("schema violation returned as error result", bad.is_error === true && /^Invalid input: input\.(content is required|filename should be string)/.test(bad.content[0].text), JSON.stringify(bad.content));

    console.log("second provider, image model, parameters");
    await openSettings(page, "Providers & keys");
    const openaiCard = page.locator(".card", { hasText: "OpenAI" }).first();
    await openaiCard.locator('input[type="password"]').fill("sk-openai-test");
    await openaiCard.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /OpenAI: 3 models/.test(t.textContent)));
    check("embedding model filtered out, 3 kept", true);
    await page.getByRole("tab", { name: "Models" }).click();
    await page.locator("label.field", { hasText: "Image generation" }).locator("select").selectOption({ label: "gpt-image-1" });
    check("video model listed as selectable", (await page.locator("label.field", { hasText: "Video generation" }).locator("option", { hasText: "sora-2" }).count()) === 1);
    await shot(page, "05-settings-models");
    await closeSettings(page);

    await sendMessage(page, "draw a lighthouse");
    await page.waitForSelector("img.media");
    await idle(page);
    check("image generated through the OpenAI images endpoint", seen.images.length === 1 && seen.images[0].model === "gpt-image-1" && seen.images[0].size === "1536x1024" && /lighthouse/.test(seen.images[0].prompt));
    check("generated image displayed inline", (await page.locator("img.media").count()) === 1);


    await page.locator('button[title="Model parameters"]').click();
    await page.getByRole("tab", { name: "All chats" }).click();
    const tempRow = page.locator(".param", { hasText: "Temperature" });
    await tempRow.locator('input[type="number"]').fill("0.3");
    await page.locator(".param", { hasText: "Top P" }).locator('input[type="number"]').fill("0.9");
    await page.locator(".param", { hasText: "Frequency penalty" }).locator('input[type="number"]').fill("0.5");
    await page.locator(".param", { hasText: "Presence penalty" }).locator('input[type="number"]').fill("-0.25");
    await page.locator(".param", { hasText: "Max output tokens" }).locator('input[type="number"]').fill("900");
    await page.locator(".param", { hasText: "Seed" }).locator('input[type="number"]').fill("7");
    await page.locator(".param", { hasText: "Stop sequences" }).locator("textarea").fill("END");
    await page.getByRole("tab", { name: "This chat" }).click();
    check("Claude chat: temperature marked as not accepted", /no longer accepts sampling/.test(await page.locator(".param.off", { hasText: "Temperature" }).textContent()));
    await page.locator(".param", { hasText: "Reasoning effort" }).locator("select").selectOption("high");
    await shot(page, "06-parameters");
    await page.locator('.sheet [title="Close"]').click();
    await sendMessage(page, "Hello again with parameters");
    await idle(page);
    const pb = seen.anthropic[seen.anthropic.length - 1].body;
    check("Claude gets effort, max tokens, stop sequences - still no temperature", pb.output_config?.effort === "high" && pb.max_tokens === 900 && pb.stop_sequences?.[0] === "END" && !("temperature" in pb) && !("top_p" in pb), JSON.stringify({ oc: pb.output_config, mt: pb.max_tokens }));

    console.log("switch to OpenAI mid-conversation");
    await page.locator(".model-btn").click();
    await page.getByRole("option", { name: /gpt-4o/ }).click();
    await sendMessage(page, "Same question for GPT");
    await idle(page);
    const ob = seen.openai[0];
    check("OpenAI request carries the sampling parameters", ob.model === "gpt-4o" && ob.temperature === 0.3 && ob.top_p === 0.9 && ob.frequency_penalty === 0.5 && ob.presence_penalty === -0.25 && ob.max_completion_tokens === 900 && ob.seed === 7 && ob.stop?.[0] === "END", JSON.stringify(ob).slice(0, 300));
    check("history converted for OpenAI (tool calls + tool results)", ob.messages[0].role === "system" && ob.messages.some((m) => m.role === "assistant" && m.tool_calls?.[0]?.function?.name === "create_spreadsheet") && ob.messages.some((m) => m.role === "tool" && m.tool_call_id === "toolu_sheet1"));
    check("OpenAI reply rendered", /Reply from the OpenAI mock/.test(await page.locator(".msg.assistant").last().textContent()));

    console.log("connector (MCP over HTTP)");
    await openSettings(page, "Connectors");
    await page.locator('input[placeholder^="Name"]').fill("Demo");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const conn = page.locator(".card", { hasText: "Demo" }).first();
    await conn.locator('input[type="url"]').fill("https://mcp.example.test/mcp");
    await conn.locator('input[type="url"]').blur();
    await conn.locator('input[type="password"]').fill("secret-token");
    await conn.getByRole("button", { name: "Save" }).click();
    await conn.getByRole("button", { name: "Connect and list tools" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /Demo: connected, 1 tools/.test(t.textContent)));
    check("connector handshake: initialize → initialized → tools/list with bearer token", ["initialize", "notifications/initialized", "tools/list"].every((m) => seen.mcp.some((x) => x.msg.method === m)) && seen.mcp.at(-1).headers.authorization === "Bearer secret-token" && seen.mcp.at(-1).headers["mcp-session-id"] === "sess-1");
    await shot(page, "07-settings-connectors");
    await closeSettings(page);
    await page.locator(".model-btn").click();
    await page.getByRole("option", { name: /Opus 5\.5/ }).click();
    await sendMessage(page, "use the connector to check invoice 42");
    await page.waitForSelector('[role="alertdialog"]');
    check("connector call asks first", /Demo → lookup/.test(await page.locator('[role="alertdialog"] .perm-cmd').first().textContent()));
    await page.getByRole("button", { name: "Allow once" }).click();
    await idle(page);
    const mr = seen.anthropic[seen.anthropic.length - 1].body.messages.at(-1).content[0];
    check("connector result returned to the model", mr.content[0].text === "Record for invoice 42: paid", JSON.stringify(mr.content));
    check("connector tool advertised as mcp__demo__lookup", seen.anthropic.at(-1).body.tools.some((t) => t.name === "mcp__demo__lookup"));

    console.log("backup: export, delete, import, re-import");
    await page.locator('button[title="Show chats"]').count();
    await sendAndNew(page);
    await openSettings(page, "Sync & backup");
    await shot(page, "08-settings-sync");
    const [bdl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
    const backupPath = path.join(SHOTS, "test.meridianbackup");
    await bdl.saveAs(backupPath);
    const zip = unzipSync(new Uint8Array(fs.readFileSync(backupPath)));
    const manifest = JSON.parse(Buffer.from(zip["manifest.json"]).toString());
    check("backup has both chats and their files", manifest.conversations === 2 && manifest.blobs >= 5, JSON.stringify(manifest));
    check("backup contains no API key or token", !Buffer.from(fs.readFileSync(backupPath)).includes("sk-ant-test-key") && !Object.values(zip).some((b) => Buffer.from(b).includes("secret-token")));
    await closeSettings(page);

    page.once("dialog", (d) => d.accept());
    await page.locator(".conv", { hasText: "Hello there" }).hover();
    await page.locator(".conv", { hasText: "Hello there" }).locator('button[title="More"]').click();
    await page.locator(".conv", { hasText: "Hello there" }).getByRole("button", { name: "Delete" }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".conv")].some((c) => /Hello there/.test(c.textContent)));
    check("chat deleted", (await page.locator(".conv").count()) === 1);
    // edit the surviving chat so the import has something to preserve
    await page.locator(".conv", { hasText: "Second chat" }).locator(".conv-open").click();
    await sendMessage(page, "A message written after the backup");
    await idle(page);

    await openSettings(page, "Sync & backup");
    await page.locator('input[type="file"][accept*="meridianbackup"]').setInputFiles(backupPath);
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /Import finished/.test(t.textContent)));
    const importToast = await page.locator(".toast.ok", { hasText: "Import finished" }).last().textContent();
    check("import restores the deleted chat and leaves the other alone", /1 new chat\(s\) added, 0 merged.*1 already up to date/.test(importToast), importToast);
    await closeSettings(page);
    check("both chats listed again", (await page.locator(".conv").count()) === 2);
    await page.locator(".conv", { hasText: "Second chat" }).locator(".conv-open").click();
    check("message written after the backup is still there", (await page.locator(".msg.user .bubble", { hasText: "A message written after the backup" }).count()) === 1);
    await page.locator(".conv", { hasText: "Hello there" }).locator(".conv-open").click();
    await page.waitForSelector('.file-card:has-text("budget.xlsx")');
    check("restored chat has its messages and files", (await page.locator(".msg.user").count()) >= 8 && (await page.locator("img.media").count()) === 1);

    console.log("persistence across reload");
    await page.reload();
    await page.waitForSelector(".conv");
    check("chats survive a reload", (await page.locator(".conv").count()) === 2);
    await page.locator(".conv", { hasText: "Hello there" }).locator(".conv-open").click();
    await page.waitForSelector(".msg.assistant table");
    await shot(page, "09-desktop-final");

    console.log("regenerate and edit");
    const nBefore = await page.locator(".msg").count();
    await page.locator(".msg.assistant").last().hover();
    await page.locator('button[title="Try again"]').click();
    // the last question triggers the connector again, so the app must ask again (after reconnecting to it)
    await page.waitForSelector('[role="alertdialog"]');
    await page.getByRole("button", { name: "Allow once" }).click();
    await idle(page);
    check("regenerate keeps message count stable", (await page.locator(".msg").count()) === nBefore, `${await page.locator(".msg").count()} vs ${nBefore}`);

    console.log("Grok Imagine: image mode, edit, animate");
    await openSettings(page, "Providers & keys");
    const xaiCard = page.locator(".card", { hasText: "xAI (Grok)" }).first();
    await xaiCard.locator('input[type="password"]').fill("xai-test");
    await xaiCard.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /xAI \(Grok\): 3 models/.test(t.textContent)));
    await closeSettings(page);
    await page.getByRole("button", { name: "New chat" }).click().catch(async () => {
      await page.locator('button[title="Show chats"]').click();
      await page.getByRole("button", { name: "New chat" }).click();
    });
    await page.locator(".model-btn").click();
    await page.getByRole("tab", { name: "Image" }).click();
    check("picker lists Grok Imagine as an image model", (await page.getByRole("option", { name: /grok-imagine-image/ }).count()) === 1);
    await page.getByRole("option", { name: /grok-imagine-image/ }).click();
    check("composer switched to Image mode", (await page.locator('.mode-seg [aria-checked="true"]').textContent()) === "Image");
    await page.locator('select[aria-label="Aspect ratio"]').selectOption("16:9");
    await page.locator('select[aria-label="Number of images"]').selectOption("2");
    await sendMessage(page, "a red fox in snow");
    await page.waitForSelector(".msg.assistant img.media");
    await idle(page);
    check("Grok image request carried prompt, count and aspect", seen.xai[0]?.path === "/v1/images/generations" && seen.xai[0].body.model === "grok-imagine-image" && seen.xai[0].body.n === 2 && seen.xai[0].body.aspect_ratio === "16:9" && seen.xai[0].body.prompt === "a red fox in snow", JSON.stringify(seen.xai[0]));
    check("generated pictures shown in the chat", (await page.locator(".msg.assistant img.media").count()) === 1);
    await page.locator(".msg.assistant").last().getByRole("button", { name: "Edit" }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".composer .chip").length === 1);
    await sendMessage(page, "make it night");
    await page.waitForFunction(() => document.querySelectorAll(".msg.assistant").length === 2);
    await idle(page);
    check("edit sent the picture to Grok's edits endpoint", seen.xai[1]?.path === "/v1/images/edits" && /^data:image\/png;base64,/.test(seen.xai[1].body.image?.url ?? ""), JSON.stringify(seen.xai[1]?.path));
    await page.locator(".model-btn").click();
    await page.getByRole("tab", { name: "Video" }).click();
    await page.getByRole("option", { name: /grok-imagine-video/ }).click();
    await page.locator(".msg.assistant").last().getByRole("button", { name: "Animate" }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".composer .chip").length === 1);
    check("Animate switched to Video mode", (await page.locator('.mode-seg [aria-checked="true"]').textContent()) === "Video");
    await sendMessage(page, "the fox runs away");
    await page.waitForSelector(".msg.assistant video.media", { timeout: 30000 });
    await idle(page);
    const vid = seen.xai.find((x) => x.path === "/v1/videos/generations");
    check("image-to-video request sent to Grok with the start image", !!vid && vid.body.model === "grok-imagine-video" && /^data:image\/png;base64,/.test(vid.body.image?.url ?? ""), JSON.stringify(vid?.body ?? {}).slice(0, 200));
    await page.locator('.mode-seg button', { hasText: "Chat" }).click();
    await page.waitForFunction(() => document.querySelector('.mode-seg [aria-checked="true"]')?.textContent === "Chat").catch(() => {});
    check("Chat button returns to a chat model", /Claude|gpt|grok-4/i.test(await page.locator(".model-btn").textContent()), await page.locator(".model-btn").textContent());
    await shot(page, "05b-grok-media");
    console.log("dark theme + phone and tablet layouts");
    await openSettings(page, "General");
    await page.locator("label.field", { hasText: "Appearance" }).locator("select").selectOption("dark");
    await closeSettings(page);
    await shot(page, "10-dark");

    const phone = await browser.newContext({ ...devices["iPhone 14"], storageState: await context.storageState() });
    const pp = await phone.newPage();
    pp.on("pageerror", (e) => errors.push("phone: " + String(e)));
    await installMocks(pp);
    await pp.goto(URL_);
    await pp.waitForSelector(".empty h1, .messages");
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("phone: no horizontal overflow", overflow <= 0, String(overflow));
    check("phone: sidebar starts closed", (await pp.locator(".sidebar.closed").count()) === 1);
    await pp.screenshot({ path: path.join(SHOTS, "11-phone-chat.png") });
    await pp.locator('button[title="Show chats"]').click();
    await pp.waitForTimeout(300);
    await pp.screenshot({ path: path.join(SHOTS, "12-phone-sidebar.png") });
    await pp.locator('button[title="Settings"]').click();
    await pp.getByRole("tab", { name: "Tools & computer" }).click();
    await pp.waitForTimeout(200);
    const overflow2 = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check("phone: settings fit the screen", overflow2 <= 0, String(overflow2));
    await pp.screenshot({ path: path.join(SHOTS, "13-phone-settings.png") });
    await phone.close();

    const tablet = await browser.newContext({ ...devices["iPad Pro 11"], storageState: await context.storageState() });
    const tp = await tablet.newPage();
    await installMocks(tp);
    await tp.goto(URL_);
    await tp.waitForSelector(".empty h1, .messages");
    await tp.screenshot({ path: path.join(SHOTS, "14-tablet.png") });
    await tablet.close();

    check("no uncaught page errors", errors.length === 0, errors.slice(0, 5).join(" | "));
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e);
    await page.screenshot({ path: path.join(SHOTS, "failure.png") }).catch(() => {});
    if (errors.length) console.error("page errors:", errors.slice(0, 5));
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

// start a second conversation so the backup has more than one
async function sendAndNew(page) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"]').click();
  await page.getByRole("button", { name: "New chat" }).click();
  await sendMessage(page, "Second chat");
  await idle(page);
}

main();
