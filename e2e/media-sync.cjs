// Browser end-to-end checks for the free image / video backends (Pollinations,
// AI Horde), the Image / Video backend picker and its defaults, a TypingMind
// multi-function plugin used as an image backend, and OneDrive chat sync.
// Every outside service is mocked.
//   npm run build && node e2e/media-sync.cjs
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "screens");
const PORT = 4176;
const URL_ = `http://localhost:${PORT}/`;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "*" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const MP4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 2, 0]);
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failures++;
};
const seen = { classic: [], gen: [], jobs: 0, horde: [], paint: [], graph: [], token: 0 };

async function mocks(page) {
  const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  await page.route("https://image.pollinations.ai/**", (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    seen.classic.push(route.request().url());
    // the first free request finds the slot taken: the app waits and retries
    if (seen.classic.length === 1) return json(route, { error: "slow down" }, 402, { "retry-after": "1" });
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "image/jpeg" }, body: PNG });
  });
  await page.route("https://gen.pollinations.ai/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    seen.gen.push({ path: url.pathname, query: url.search, auth: req.headers()["authorization"], prefer: req.headers()["prefer"] });
    if (url.pathname === "/image/models")
      return json(route, [
        { name: "tongyi-mai/z-image-turbo", title: "Z-Image Turbo", output_modalities: ["image"], input_modalities: ["text"], paid_only: false },
        { name: "alibaba/wan-2.2-fast", title: "Wan 2.2 fast", output_modalities: ["video"], input_modalities: ["text", "image"], paid_only: false },
        { name: "google/veo-3.1", title: "Veo 3.1", output_modalities: ["video"], paid_only: true },
      ]);
    if (url.pathname.startsWith("/video/")) return json(route, { id: "job1", status: "pending" }, 202);
    if (url.pathname === "/v1/jobs/job1") return json(route, ++seen.jobs < 2 ? { status: "pending" } : { status: "succeeded", result_url: "https://media.pollinations.ai/vid1" });
    if (url.pathname.startsWith("/image/")) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "image/png" }, body: PNG });
    return json(route, {});
  });
  await page.route("https://media.pollinations.ai/**", (route) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "video/mp4" }, body: MP4 }));
  await page.route("https://aihorde.net/api/v2/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    if (p.endsWith("/status/models")) return json(route, [{ name: "AlbedoBase XL (SDXL)", count: 5 }, { name: "Deliberate", count: 3 }]);
    if (p.endsWith("/generate/async")) {
      seen.horde.push({ apikey: req.headers()["apikey"], body: req.postDataJSON() });
      return json(route, { id: "h1" }, 202);
    }
    if (p.includes("/generate/check/")) return json(route, { done: true, is_possible: true });
    if (p.includes("/generate/status/")) return json(route, { generations: [{ img: "https://r2.horde.test/h1.webp", censored: false }] });
    return json(route, {});
  });
  await page.route("https://r2.horde.test/**", (route) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "image/webp" }, body: PNG }));
  await page.route("https://paint.example/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (url.pathname === "/api") {
      seen.paint.push({ q: url.searchParams.get("q"), auth: req.headers()["authorization"] });
      return json(route, { result: { image_url: "https://paint.example/out/1" } });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "image/png" }, body: PNG });
  });
  // Microsoft sign-in (device code) and OneDrive's app folder
  await page.route("https://login.microsoftonline.com/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    if (req.url().endsWith("/devicecode")) return json(route, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://microsoft.com/devicelogin", interval: 1, expires_in: 600 });
    seen.token++;
    if (seen.token < 2) return json(route, { error: "authorization_pending" }, 400);
    return json(route, { access_token: "graph-token", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" });
  });
  const files = new Map();
  await page.route("https://graph.microsoft.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = req.url();
    if (url.includes("/v1.0/me?")) return json(route, { mail: "me@example.com" });
    const base = "https://graph.microsoft.com/v1.0/me/drive/special/approot";
    const rest = decodeURIComponent(url.slice(base.length).split("?")[0]);
    const m = /^:\/(.*?):(\/content|\/children)?$/.exec(rest) ?? (rest === "/children" ? [rest, "", "/children"] : null);
    seen.graph.push(`${req.method()} ${rest}`);
    if (!m) return json(route, { error: { message: "bad path" } }, 400);
    const [, p, op] = m;
    if (op === "/content" && req.method() === "PUT") {
      files.set(p, req.postDataBuffer() ?? Buffer.alloc(0));
      return json(route, { name: p });
    }
    if (op === "/content") return files.has(p) ? route.fulfill({ status: 200, headers: CORS, body: files.get(p) }) : route.fulfill({ status: 404, headers: CORS, body: "" });
    if (req.method() === "DELETE") return route.fulfill({ status: files.delete(p) ? 204 : 404, headers: CORS, body: "" });
    const prefix = p ? `${p}/` : "";
    const value = [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => ({ name: k.slice(prefix.length), size: files.get(k).length, lastModifiedDateTime: new Date().toISOString(), file: {} }));
    if (!value.length && p) return route.fulfill({ status: 404, headers: CORS, body: "" });
    return json(route, { value });
  });
  return files;
}

const composer = (page) => page.locator('textarea[aria-label="Message"]');
async function send(page, text) {
  await composer(page).fill(text);
  await page.locator('button[title="Send"]').click();
}
async function idle(page) {
  await page.waitForFunction(() => !document.querySelector('button[title="Stop"]'), null, { timeout: 30000 });
  await page.waitForTimeout(200);
}
async function settings(page, tab) {
  if (!(await page.locator(".sidebar:not(.closed)").count())) await page.locator('button[title="Show chats"], button[title="Show sidebar"]').first().click();
  await page.locator('button[title="Settings"]').click();
  await page.getByRole("tab", { name: tab }).click();
}
const closeSettings = (page) => page.locator('.modal [title="Close"]').first().click();
const mode = (page, name) => page.locator(".mode-seg button", { hasText: name }).click();
const backendBtn = (page) => page.locator(".backend-btn");

const TYPINGMIND = {
  title: "Paint studio",
  emoji: "🎨",
  userSettings: [{ name: "paintKey", label: "Paint key", type: "password" }],
  pluginFunctions: [
    {
      implementationType: "http",
      openaiSpec: { name: "paint_picture", description: "Generate an image from a text prompt", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
      httpAction: { url: "https://paint.example/api?q={prompt}", method: "GET", hasHeaders: true, requestHeaders: '{"Authorization":"Bearer {paintKey}"}' },
    },
    { openaiSpec: { name: "word_count", description: "Count words", parameters: { type: "object", properties: { text: { type: "string" } } } }, code: "async function word_count(p){ return String(p.text.split(/\\s+/).length) }" },
  ],
};

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "pipe" });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("preview did not start")), 20000);
    server.stdout.on("data", (d) => new RegExp(String(PORT)).test(String(d)) && (clearTimeout(t), res()));
    server.on("exit", (c) => rej(new Error(`preview exited ${c}`)));
  });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const files = await mocks(page);
  try {
    await page.goto(URL_);
    await page.waitForSelector(".empty h1");

    console.log("free images with no keys at all");
    await mode(page, "Image");
    await page.waitForFunction(() => document.querySelector('.mode-seg [aria-checked="true"]')?.textContent === "Image");
    check("Image mode works with no API keys", true);
    check("backend button shows Pollinations, marked free", /Pollinations/.test(await backendBtn(page).textContent()) && (await backendBtn(page).locator(".tag-free").count()) === 1, await backendBtn(page).textContent());
    await send(page, "a lighthouse at dawn");
    await page.waitForFunction(() => /free slot/.test(document.body.textContent), null, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector(".msg.assistant img.media", { timeout: 30000 });
    await idle(page);
    check("Pollinations Classic waited for the free slot and made the image", seen.classic.length === 2 && /prompt\/a%20lighthouse%20at%20dawn\?width=/.test(seen.classic[1]), seen.classic.join(" "));

    console.log("backend picker: choose for this chat, set the default");
    await backendBtn(page).click();
    const pop = page.locator(".backend-pop");
    check("picker lists the free backends", (await pop.locator(".backend-group", { hasText: "Pollinations" }).count()) === 1 && (await pop.locator(".backend-group", { hasText: "AI Horde" }).count()) === 1);
    check("Pollinations is the default", (await pop.locator(".backend-group", { hasText: "Pollinations" }).locator(".badge", { hasText: "Default" }).count()) === 1);
    const horde = pop.locator(".backend-group", { hasText: "AI Horde" });
    await horde.getByRole("button", { name: "Make default" }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll(".backend-group")].some((g) => /AI Horde/.test(g.textContent) && /Default/.test(g.textContent)));
    check("Make default moved the default to AI Horde", (await pop.locator(".backend-group", { hasText: "Pollinations" }).locator(".badge", { hasText: "Default" }).count()) === 0);
    check("this chat still uses Pollinations", /Pollinations/.test(await backendBtn(page).textContent()));
    await page.screenshot({ path: path.join(SHOTS, "40-backends.png") });
    await horde.locator(".backend-item .link-btn").first().click();
    await page.waitForFunction(() => /AI Horde/.test(document.querySelector(".backend-btn")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
    check("chose AI Horde for this chat", /AI Horde/.test(await backendBtn(page).textContent()));
    await send(page, "a castle on a hill");
    await page.waitForFunction(() => document.querySelectorAll(".msg.assistant img.media").length === 2, null, { timeout: 30000 });
    await idle(page);
    check("AI Horde queued anonymously with the best SDXL model", seen.horde[0]?.apikey === "0000000000" && seen.horde[0].body.models[0] === "AlbedoBase XL (SDXL)", JSON.stringify(seen.horde[0] ?? {}).slice(0, 200));

    console.log("video needs a free Pollinations key");
    await mode(page, "Video");
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /No video backend is ready/.test(t.textContent)));
    check("without a key, Video mode explains how to get free video", true);
    await settings(page, "Providers & keys");
    const pollCard = page.locator(".card", { has: page.locator("h4", { hasText: /^Pollinations$/ }) });
    await page.locator("h3", { hasText: "Free image & video" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, "42-free-providers.png") });
    check("Pollinations card says ready with no key", /ready · no key needed/.test(await pollCard.textContent()));
    await pollCard.locator('input[type="password"]').fill("sk_free");
    await pollCard.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast.ok")].some((t) => /^Pollinations: \d+ models/.test(t.textContent)));
    check("paid-only Pollinations models are hidden", !/Veo 3\.1"/.test(await pollCard.textContent()) && /3 models/.test(await pollCard.textContent()), await pollCard.locator(".badge").allTextContents().then((b) => b.join(",")));
    await closeSettings(page);
    await mode(page, "Video");
    await page.waitForFunction(() => document.querySelector('.mode-seg [aria-checked="true"]')?.textContent === "Video");
    check("video backend is Pollinations Wan", /Pollinations · Wan 2\.2 fast/.test(await backendBtn(page).textContent()), await backendBtn(page).textContent());
    await send(page, "waves on a beach");
    await page.waitForSelector(".msg.assistant video.media", { timeout: 30000 });
    await idle(page);
    const vid = seen.gen.find((g) => g.path.startsWith("/video/"));
    check("video ran as an async Pollinations job with the key", !!vid && vid.prefer === "respond-async" && vid.auth === "Bearer sk_free" && /model=alibaba%2Fwan-2\.2-fast/.test(vid.query), JSON.stringify(vid ?? {}));
    await mode(page, "Image");
    await page.waitForFunction(() => document.querySelector('.mode-seg [aria-checked="true"]')?.textContent === "Image");
    check("back in Image mode the chat keeps AI Horde", /AI Horde/.test(await backendBtn(page).textContent()), await backendBtn(page).textContent());

    console.log("TypingMind multi-function plugin as an image backend");
    await settings(page, "Plugins");
    await page.locator("summary", { hasText: "Paste plugin JSON" }).click();
    await page.locator("details textarea").fill(JSON.stringify(TYPINGMIND));
    await page.getByRole("button", { name: "Read" }).click();
    await page.waitForSelector(".modal >> text=Paint studio");
    check("import review shows both functions and the image backend", /2 tools · 1 image\/video backend/.test(await page.locator(".modal .switch", { hasText: "Paint studio" }).textContent()));
    await page.locator(".modal-foot").getByRole("button", { name: "Install" }).click();
    const card = page.locator(".card", { hasText: "Paint studio" });
    await card.getByRole("button", { name: "Details" }).click();
    await card.locator('input[type="password"]').fill("pk-123");
    await card.getByRole("button", { name: "Save" }).click();
    await closeSettings(page);
    await backendBtn(page).click();
    const plug = page.locator(".backend-pop .backend-group", { hasText: "Paint studio" });
    check("the plugin is listed as an image backend", (await plug.count()) === 1);
    await plug.locator(".backend-item .link-btn").first().click();
    await send(page, "a purple cat");
    await page.waitForFunction(() => document.querySelectorAll(".msg.assistant img.media").length === 3, null, { timeout: 30000 });
    await idle(page);
    check("plugin engine called the TypingMind HTTP action with prompt and key", seen.paint[0]?.q === "a purple cat" && seen.paint[0].auth === "Bearer pk-123", JSON.stringify(seen.paint));

    console.log("OneDrive sync with a sign-in code");
    await settings(page, "Sync & backup");
    const cloud = page.locator(".card", { hasText: "Keep chats in your own Google Drive or OneDrive" });
    await cloud.locator('input[aria-label="Client ID"]').fill("11111111-2222-3333-4444-555555555555");
    await cloud.getByRole("button", { name: "Sign in to OneDrive" }).click();
    await page.waitForSelector('[data-testid="device-code"]');
    check("sign-in code shown", (await page.locator('[data-testid="device-code"]').textContent()) === "ABCD-1234");
    await page.waitForSelector("text=Syncing with", { timeout: 20000 });
    check("signed in to OneDrive", /Syncing with OneDrive as me@example\.com/.test(await page.locator(".card", { hasText: "Syncing with" }).textContent()));
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Synced: \d+ received, [1-9]\d* sent|Everything is up to date/.test(t.textContent)), null, { timeout: 20000 });
    const convFiles = [...files.keys()].filter((k) => k.startsWith("conversations/"));
    check("chats were written to OneDrive's app folder", convFiles.length >= 1, [...files.keys()].join(", "));
    await page.screenshot({ path: path.join(SHOTS, "41-onedrive-sync.png") });
    // a chat that another device put in OneDrive arrives here
    const other = { id: "c_remote", title: "From the iPhone", createdAt: 5, updatedAt: Date.now(), messages: [{ id: "m_r", role: "user", createdAt: 5, updatedAt: 5, parts: [{ type: "text", text: "hello from iPhone" }] }], removed: {} };
    files.set("conversations/c_remote.json", Buffer.from(JSON.stringify(other)));
    await page.getByRole("button", { name: "Sync now" }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => /Synced: 1 received/.test(t.textContent)), null, { timeout: 20000 });
    await closeSettings(page);
    check("a chat from another device arrived through OneDrive", (await page.locator(".conv", { hasText: "From the iPhone" }).count()) === 1);
    check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    failures++;
    console.error("  FAIL (exception)", e);
    await page.screenshot({ path: path.join(SHOTS, "media-sync-failure.png") }).catch(() => {});
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall media and sync checks passed");
  process.exit(failures ? 1 : 0);
}
main();
